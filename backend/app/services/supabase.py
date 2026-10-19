"""Supabase client factory (server-side, service role only).

The service-role client performs privileged operations: verification document
storage, submission inserts, and auth-token validation. The service-role key
exists only in the backend environment and must never reach any client.

Transport notes (the intermittent `httpx.ReadError: [Errno 11] Resource
temporarily unavailable` seen in production): supabase-py builds its PostgREST,
Auth and Storage clients around ONE `httpx.Client` that is cached here and
therefore shared by every request. Each FastAPI endpoint is a synchronous
function, so requests run concurrently on AnyIO's worker threads. The default
client enables HTTP/2, which multiplexes many concurrent requests over a single
connection; httpcore's HTTP/2 connector shares that one connection's state
machine and closes it without holding its state lock, so concurrent threads can
race a read against a close. The fix is to hand supabase-py an explicit client:
HTTP/1.1 (one connection per in-flight request, checked out under the pool lock)
with a bounded connection pool and a real timeout. Bounded retries are applied
only to idempotent methods (GET/HEAD/OPTIONS) so a transient connection error is
retried once; writes are never replayed and can never duplicate a message.
"""

from functools import lru_cache

import httpx
from supabase import Client, ClientOptions, create_client

from app.core.config import Settings, get_settings

# Methods safe to replay: they cannot create or mutate state, so retrying one
# after a transport error cannot produce a duplicate side effect. POST/PUT/
# PATCH/DELETE are deliberately excluded (a replayed send must never double a
# message or a counter).
_IDEMPOTENT_METHODS = frozenset({"GET", "HEAD", "OPTIONS"})

# Only these failures are considered transient. This is deliberately narrower
# than `httpx.TransportError`: `UnsupportedProtocol`, `LocalProtocolError`,
# `ProxyError`, protocol violations, pool timeouts and write failures are
# configuration or programming errors (or saturation), so they must surface
# immediately and never be retried.
_RETRYABLE_TRANSPORT_ERRORS = (
    httpx.ConnectError,
    httpx.ConnectTimeout,
    httpx.ReadError,
    httpx.ReadTimeout,
)

# Long enough that a briefly idle keepalive connection is reused instead of
# being closed and re-opened on every burst, which is the window that makes the
# connection state machine races reachable.
_KEEPALIVE_EXPIRY_SECONDS = 30.0


class SupabaseNotConfiguredError(RuntimeError):
    """Raised when privileged Supabase access is required but not configured."""


class _TransientRetryTransport(httpx.HTTPTransport):
    """HTTP/1.1 transport that retries only transient connect/read errors.

    `ConnectError`, `ConnectTimeout`, `ReadError` and `ReadTimeout` on an
    idempotent request are retried up to `max_attempts`. Every other transport
    error propagates on the first attempt (configuration, protocol, pool
    saturation), and writes are never replayed. httpcore's own retries are
    disabled, so this layer is the only retry layer and `max_attempts` is the
    exact upper bound.
    """

    def __init__(self, *args, max_attempts: int = 2, **kwargs) -> None:
        super().__init__(*args, **kwargs)
        self._max_attempts = max(1, max_attempts)

    def handle_request(self, request: httpx.Request) -> httpx.Response:
        last_exc: httpx.TransportError | None = None
        for _ in range(self._max_attempts):
            try:
                response = super().handle_request(request)
                # A transport error can surface while the response body is being
                # read, not only while headers are received. Read it here so the
                # whole idempotent request is covered by the retry (PostgREST,
                # Auth and Storage never stream their responses).
                response.read()
                return response
            except _RETRYABLE_TRANSPORT_ERRORS as exc:
                last_exc = exc
                # Writes are never replayed. Non-transient transport errors are
                # not caught here at all, so they propagate immediately.
                if request.method not in _IDEMPOTENT_METHODS:
                    raise
        assert last_exc is not None
        raise last_exc


def _build_httpx_client(settings: Settings) -> httpx.Client:
    """Build the shared Supabase HTTP client (HTTP/1.1, bounded, retried)."""
    transport = _TransientRetryTransport(
        http2=False,
        retries=0,
        max_attempts=settings.supabase_http_max_attempts,
        limits=httpx.Limits(
            max_connections=settings.supabase_http_max_connections,
            max_keepalive_connections=settings.supabase_http_max_keepalive_connections,
            keepalive_expiry=_KEEPALIVE_EXPIRY_SECONDS,
        ),
    )
    return httpx.Client(
        transport=transport,
        timeout=httpx.Timeout(settings.supabase_http_timeout_seconds),
        follow_redirects=True,
    )


@lru_cache
def get_supabase_service_client() -> Client:
    """Build the cached service-role Supabase client from environment config.

    The client owns one process-wide HTTP connection pool; do not close it per
    request. Auth, PostgREST and Storage all share it (the supabase-py design),
    so the transport configuration above applies to every Supabase call.
    """
    settings = get_settings()
    if not settings.supabase_url or not settings.supabase_service_role_key:
        raise SupabaseNotConfiguredError(
            "SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY must be configured "
            "in the backend environment."
        )
    return create_client(
        settings.supabase_url,
        settings.supabase_service_role_key,
        ClientOptions(httpx_client=_build_httpx_client(settings)),
    )
