"""Regression tests for the Supabase HTTP transport fix.

Production raised `httpx.ReadError: [Errno 11] Resource temporarily
unavailable` intermittently on account-status, verification and message-history
reads. The Supabase client is one process-wide `httpx.Client` shared by
FastAPI's worker threads; with HTTP/2 enabled, many concurrent requests share a
single multiplexed connection whose state machine can race a read against a
close. `app.services.supabase` now hands supabase-py an explicit HTTP/1.1
client with a bounded pool, a real timeout, and bounded retries that apply ONLY
to idempotent methods.

These tests pin that behavior: transient errors on GET/HEAD are retried (so a
blip does not surface as a 503), writes are never replayed (so a send cannot
duplicate), the client is HTTP/1.1 with the pool/timeout configured, and a
persistent transport error on a read still fails closed as the controlled 503
rather than an unhandled 500. No network is touched.
"""

from uuid import UUID

import httpx
import pytest

from app.core.config import Settings
from app.core.exceptions import ServiceUnavailableError
from app.services import supabase as supabase_service
from app.services.supabase import (
    SupabaseNotConfiguredError,
    _build_httpx_client,
    _TransientRetryTransport,
    get_supabase_service_client,
)

PROFILE_ID = UUID("33333333-3333-3333-3333-333333333333")


# ---------------------------------------------------------------------------
# Transport: bounded, idempotent-only retries.
# ---------------------------------------------------------------------------


@pytest.mark.parametrize(
    "error_type",
    [
        httpx.ConnectError,
        httpx.ConnectTimeout,
        httpx.ReadError,
        httpx.ReadTimeout,
    ],
)
def test_idempotent_request_retries_transient_error(monkeypatch, error_type):
    calls = {"count": 0}

    def flaky(self, request):
        calls["count"] += 1
        if calls["count"] < 3:
            raise error_type("transient", request=request)
        return httpx.Response(200, request=request)

    monkeypatch.setattr(httpx.HTTPTransport, "handle_request", flaky)
    transport = _TransientRetryTransport(http2=False, max_attempts=3)

    response = transport.handle_request(httpx.Request("GET", "https://db.test/rest/v1/x"))

    assert response.status_code == 200
    assert calls["count"] == 3


@pytest.mark.parametrize(
    "error_type",
    [
        httpx.UnsupportedProtocol,
        httpx.LocalProtocolError,
        httpx.ProxyError,
        httpx.RemoteProtocolError,
        httpx.CloseError,
        httpx.WriteError,
        httpx.WriteTimeout,
    ],
)
def test_non_transient_transport_error_is_not_retried(monkeypatch, error_type):
    """Only explicitly transient connect/read failures may be replayed."""
    calls = {"count": 0}

    def always_fails(self, request):
        calls["count"] += 1
        raise error_type("not transient", request=request)

    monkeypatch.setattr(httpx.HTTPTransport, "handle_request", always_fails)
    transport = _TransientRetryTransport(http2=False, max_attempts=5)

    with pytest.raises(error_type):
        transport.handle_request(httpx.Request("GET", "https://db.test/rest/v1/x"))

    assert calls["count"] == 1


def test_idempotent_request_reraises_after_attempts_exhausted(monkeypatch):
    calls = {"count": 0}

    def always_fails(self, request):
        calls["count"] += 1
        raise httpx.ReadError("Resource temporarily unavailable", request=request)

    monkeypatch.setattr(httpx.HTTPTransport, "handle_request", always_fails)
    transport = _TransientRetryTransport(http2=False, max_attempts=2)

    with pytest.raises(httpx.ReadError):
        transport.handle_request(httpx.Request("GET", "https://db.test/rest/v1/x"))

    assert calls["count"] == 2


def test_pool_timeout_is_not_retried(monkeypatch):
    """A saturated pool is not a transient blip; retrying doubles the wait."""
    calls = {"count": 0}

    def always_pool_timeout(self, request):
        calls["count"] += 1
        raise httpx.PoolTimeout("pool exhausted", request=request)

    monkeypatch.setattr(httpx.HTTPTransport, "handle_request", always_pool_timeout)
    transport = _TransientRetryTransport(http2=False, max_attempts=5)

    with pytest.raises(httpx.PoolTimeout):
        transport.handle_request(httpx.Request("GET", "https://db.test/rest/v1/x"))

    assert calls["count"] == 1


@pytest.mark.parametrize("method", ["POST", "PUT", "PATCH", "DELETE"])
def test_writes_are_never_retried(monkeypatch, method):
    """A replayed write could duplicate a message or an unread counter."""
    calls = {"count": 0}

    def always_fails(self, request):
        calls["count"] += 1
        raise httpx.ReadError("Resource temporarily unavailable", request=request)

    monkeypatch.setattr(httpx.HTTPTransport, "handle_request", always_fails)
    transport = _TransientRetryTransport(http2=False, max_attempts=5)

    with pytest.raises(httpx.ReadError):
        transport.handle_request(httpx.Request(method, "https://db.test/rest/v1/x"))

    assert calls["count"] == 1


# ---------------------------------------------------------------------------
# Client configuration.
# ---------------------------------------------------------------------------


def test_built_client_is_http1_with_bounded_pool_and_timeout():
    settings = Settings(
        supabase_http_timeout_seconds=17.0,
        supabase_http_max_connections=7,
        supabase_http_max_keepalive_connections=3,
        supabase_http_max_attempts=4,
    )

    client = _build_httpx_client(settings)
    try:
        transport = client._transport
        assert isinstance(transport, _TransientRetryTransport)
        # HTTP/2 off: connections are pooled and checked out, never multiplexed
        # across threads on one shared state machine.
        assert transport._pool._http2 is False
        assert transport._pool._max_connections == 7
        assert transport._pool._max_keepalive_connections == 3
        # httpcore's own retries are off: only the custom layer retries, and it
        # only retries idempotent methods.
        assert transport._pool._retries == 0
        assert client.timeout.read == 17.0
        assert transport._max_attempts == 4
    finally:
        client.close()


def test_service_client_is_cached_and_uses_the_configured_transport(monkeypatch):
    settings = Settings(
        supabase_url="https://example.supabase.co",
        supabase_service_role_key="service-role-key",
    )
    monkeypatch.setattr(supabase_service, "get_settings", lambda: settings)
    get_supabase_service_client.cache_clear()
    try:
        first = get_supabase_service_client()
        second = get_supabase_service_client()

        assert first is second
        # One stable HTTP client for the process lifetime, never closed per
        # request. Auth, PostgREST, Storage and Functions all share it.
        http_client = first.postgrest.session
        assert http_client.is_closed is False
        assert first.postgrest.session is http_client
        assert first.auth._http_client is http_client
        assert first.storage.session is http_client
        assert first.functions._client is http_client
        # HTTP/2 is off on the real PostgREST transport, not just on a helper.
        assert http_client._transport._pool._http2 is False
    finally:
        get_supabase_service_client.cache_clear()


def test_service_client_requires_credentials(monkeypatch):
    monkeypatch.setattr(
        supabase_service,
        "get_settings",
        lambda: Settings(supabase_url="", supabase_service_role_key=""),
    )
    get_supabase_service_client.cache_clear()
    try:
        with pytest.raises(SupabaseNotConfiguredError):
            get_supabase_service_client()
    finally:
        get_supabase_service_client.cache_clear()


# ---------------------------------------------------------------------------
# A persistent transport error on a read fails closed as the controlled 503.
# ---------------------------------------------------------------------------


class _ExplodingTable:
    """Builder whose terminal `execute()` raises a transport error."""

    def __init__(self, error):
        self._error = error

    def select(self, *_args, **_kwargs):
        return self

    def eq(self, *_args, **_kwargs):
        return self

    def order(self, *_args, **_kwargs):
        return self

    def limit(self, *_args, **_kwargs):
        return self

    def maybe_single(self):
        return self

    def execute(self):
        raise self._error


class _ExplodingSupabase:
    def __init__(self, error):
        self._error = error

    def table(self, _name):
        return _ExplodingTable(self._error)


def test_verification_lookup_transport_error_fails_closed():
    from app.services.discovery import _is_verified

    error = httpx.ReadError("Resource temporarily unavailable")
    with pytest.raises(ServiceUnavailableError) as excinfo:
        _is_verified(_ExplodingSupabase(error), str(PROFILE_ID))

    assert excinfo.value.code == "database_unavailable"
