"""Focused backend tests for the staff reviewer document signed-URL endpoint.

Scope: HTTP-level tests of GET /api/v1/admin/verifications/{id}/document-url
— staff-only authorization, server-side storage_path resolution, short-lived
service-role signed URL generation, storage_path non-disclosure, and failure
handling.

Supabase is replaced at the `get_supabase_service_client` dependency boundary
with a small in-memory double implementing only the client surface this
endpoint uses (staff membership lookup, submission lookup, Storage signing).
These are NOT Supabase integration tests and never touch a network.
"""

from types import SimpleNamespace
from uuid import UUID, uuid4

import pytest
from fastapi.testclient import TestClient

from app.main import create_app
from app.services.supabase import get_supabase_service_client

API = "/api/v1/admin/verifications"

STAFF_AUTH_ID = UUID("aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa")
STUDENT_AUTH_ID = UUID("11111111-1111-1111-1111-111111111111")
STAFF_TOKEN = "staff-access-token"
STUDENT_TOKEN = "student-access-token"

STAFF_AUTH_HEADERS = {"Authorization": f"Bearer {STAFF_TOKEN}"}
STUDENT_AUTH_HEADERS = {"Authorization": f"Bearer {STUDENT_TOKEN}"}

SIGNED_URL_TTL = 300


# ---------------------------------------------------------------------------
# In-memory Supabase double (staff + document URL surface).
# ---------------------------------------------------------------------------


class FakeResponse:
    def __init__(self, data):
        self.data = data


class FakeTable:
    def __init__(self, tables, table_name, fail_tables):
        self._tables = tables
        self._table_name = table_name
        self._fail = table_name in fail_tables
        self._filters: dict = {}
        self._single = False

    def select(self, _columns):
        return self

    def eq(self, column, value):
        self._filters[column] = value
        return self

    def maybe_single(self):
        self._single = True
        return self

    def execute(self):
        if self._fail:
            raise RuntimeError("database unavailable")
        matched = [
            dict(row)
            for row in self._tables[self._table_name]
            if all(row.get(column) == value for column, value in self._filters.items())
        ]
        if self._single:
            return FakeResponse(matched[0] if matched else None)
        return FakeResponse(matched)


class FakeSignedUrlBucket:
    def __init__(self, state, bucket):
        self._state = state
        self._bucket = bucket

    def create_signed_url(self, path, expires_in):
        self._state["signed"].append(
            {"bucket": self._bucket, "path": path, "expires_in": expires_in}
        )
        if self._state.get("fail_signing"):
            raise RuntimeError("storage signing unavailable")
        return {
            "signedUrl": f"https://signed.example/{self._bucket}/{path}?token=sig",
            "signedURL": f"https://signed.example/{self._bucket}/{path}?token=sig",
        }


class FakeStorage:
    def __init__(self, state, bucket):
        self._state = state
        self._bucket = bucket

    def from_(self, bucket):
        return FakeSignedUrlBucket(self._state, bucket)


class FakeSupabase:
    def __init__(self, tables, fail_tables, *, bucket="verification-documents"):
        self.tables = tables
        self._fail_tables = set(fail_tables)
        self._bucket = bucket
        self.state = {"signed": [], "fail_signing": False}
        self.auth = self

    def get_user(self, jwt=None):
        user_id = self.tables["__users_by_token__"].get(jwt)
        if user_id is None:
            raise RuntimeError("invalid JWT")
        return SimpleNamespace(user=SimpleNamespace(id=user_id))

    def table(self, name):
        return FakeTable(self.tables, name, self._fail_tables)

    @property
    def storage(self):
        return FakeStorage(self.state, self._bucket)


# ---------------------------------------------------------------------------
# Helpers / fixtures.
# ---------------------------------------------------------------------------


def submission_row(**overrides):
    row = {
        "id": str(uuid4()),
        "profile_id": str(uuid4()),
        "status": "PENDING",
        "storage_path": f"{uuid4().hex}/doc-{uuid4().hex}.png",
        "submitted_at": "2026-08-28T10:00:00+00:00",
    }
    row.update(overrides)
    return row


def make_fake(*, submissions=None, staff_ids=None, fail_tables=(), bucket=None):
    tables = {
        "__users_by_token__": {
            STAFF_TOKEN: str(STAFF_AUTH_ID),
            STUDENT_TOKEN: str(STUDENT_AUTH_ID),
        },
        "staff_admins": [
            {"auth_user_id": str(auth_id), "created_at": "2026-01-01T00:00:00+00:00"}
            for auth_id in (staff_ids if staff_ids is not None else [STAFF_AUTH_ID])
        ],
        "verification_submissions": list(submissions or []),
    }
    return FakeSupabase(tables, set(fail_tables), bucket=bucket or "verification-documents")


def make_client(fake):
    app = create_app()
    app.dependency_overrides[get_supabase_service_client] = lambda: fake
    return TestClient(app)


@pytest.fixture()
def fake():
    return make_fake()


@pytest.fixture()
def client(fake):
    return make_client(fake)


# ---------------------------------------------------------------------------
# 1. Unauthenticated requests rejected.
# ---------------------------------------------------------------------------


def test_unauthenticated_document_url_is_rejected(client, fake):
    resp = client.get(f"{API}/{uuid4()}/document-url")

    assert resp.status_code == 401
    assert resp.json()["error"]["code"] == "unauthorized"
    assert fake.state["signed"] == []


def test_invalid_token_is_rejected(client, fake):
    resp = client.get(
        f"{API}/{uuid4()}/document-url",
        headers={"Authorization": "Bearer wrong-token"},
    )

    assert resp.status_code == 401
    assert resp.json()["error"]["code"] == "unauthorized"
    assert fake.state["signed"] == []


def test_malformed_authorization_header_is_rejected(client, fake):
    resp = client.get(
        f"{API}/{uuid4()}/document-url",
        headers={"Authorization": f"Token {STAFF_TOKEN}"},
    )

    assert resp.status_code == 401
    assert resp.json()["error"]["code"] == "unauthorized"
    assert fake.state["signed"] == []


# ---------------------------------------------------------------------------
# 2. Authenticated non-staff rejected (403).
# ---------------------------------------------------------------------------


def test_non_staff_cannot_get_document_url(client, fake):
    sub = submission_row()
    fake.tables["verification_submissions"] = [sub]

    resp = client.get(
        f"{API}/{sub['id']}/document-url", headers=STUDENT_AUTH_HEADERS
    )

    assert resp.status_code == 403
    assert resp.json()["error"]["code"] == "permission_denied"
    assert fake.state["signed"] == []


def test_staff_removed_loses_document_access(client, fake):
    fake = make_fake(staff_ids=[])
    client = make_client(fake)

    resp = client.get(f"{API}/{uuid4()}/document-url", headers=STAFF_AUTH_HEADERS)

    assert resp.status_code == 403
    assert resp.json()["error"]["code"] == "permission_denied"
    assert fake.state["signed"] == []


# ---------------------------------------------------------------------------
# 3. Nonexistent verification.
# ---------------------------------------------------------------------------


def test_nonexistent_verification_returns_404(client, fake):
    resp = client.get(
        f"{API}/{uuid4()}/document-url", headers=STAFF_AUTH_HEADERS
    )

    assert resp.status_code == 404
    assert resp.json()["error"]["code"] == "verification_not_found"
    assert fake.state["signed"] == []


# ---------------------------------------------------------------------------
# 4. Staff gets signed URL for existing verification.
# ---------------------------------------------------------------------------


def test_staff_gets_signed_url_for_existing_verification(client, fake):
    sub = submission_row()
    fake.tables["verification_submissions"] = [sub]

    resp = client.get(
        f"{API}/{sub['id']}/document-url", headers=STAFF_AUTH_HEADERS
    )

    assert resp.status_code == 200
    body = resp.json()
    assert body["url"].startswith("https://signed.example/")
    assert body["expires_in"] == SIGNED_URL_TTL
    assert len(fake.state["signed"]) == 1
    assert fake.state["signed"][0]["path"] == sub["storage_path"]


# ---------------------------------------------------------------------------
# 5. Signed URL uses the server-side storage_path.
# ---------------------------------------------------------------------------


def test_signed_url_uses_server_side_storage_path(client, fake):
    sub = submission_row(
        storage_path=f"{uuid4().hex}/actual-document.png"
    )
    fake.tables["verification_submissions"] = [sub]

    resp = client.get(
        f"{API}/{sub['id']}/document-url", headers=STAFF_AUTH_HEADERS
    )

    assert resp.status_code == 200
    assert fake.state["signed"][0]["path"] == sub["storage_path"]
    assert sub["storage_path"] in resp.json()["url"]


# ---------------------------------------------------------------------------
# 6. Client cannot override storage_path, reviewer_id, or profile_id.
# ---------------------------------------------------------------------------


def test_client_cannot_override_storage_path(client, fake):
    sub = submission_row(
        storage_path=f"{uuid4().hex}/actual-document.png"
    )
    fake.tables["verification_submissions"] = [sub]

    fake_path = "fake/path/to/bypass.png"
    resp = client.get(
        f"{API}/{sub['id']}/document-url",
        headers=STAFF_AUTH_HEADERS,
        params={
            "storage_path": fake_path,
            "reviewer_id": str(uuid4()),
            "profile_id": str(uuid4()),
        },
    )

    assert resp.status_code == 200
    assert fake.state["signed"][0]["path"] == sub["storage_path"]
    assert fake_path not in resp.json()["url"]
    assert sub["storage_path"] in resp.json()["url"]


# ---------------------------------------------------------------------------
# 7. Storage signing failure mapped to 503.
# ---------------------------------------------------------------------------


def test_signing_failure_returns_503(client, fake):
    sub = submission_row()
    fake.tables["verification_submissions"] = [sub]
    fake.state["fail_signing"] = True

    resp = client.get(
        f"{API}/{sub['id']}/document-url", headers=STAFF_AUTH_HEADERS
    )

    assert resp.status_code == 503
    assert resp.json()["error"]["code"] == "storage_signing_failed"
    assert len(fake.state["signed"]) == 1


# ---------------------------------------------------------------------------
# 8. Service-role client used for signing (correct bucket).
# ---------------------------------------------------------------------------


def test_service_role_client_used_for_signing(client, fake):
    sub = submission_row()
    fake.tables["verification_submissions"] = [sub]

    resp = client.get(
        f"{API}/{sub['id']}/document-url", headers=STAFF_AUTH_HEADERS
    )

    assert resp.status_code == 200
    assert len(fake.state["signed"]) == 1
    assert fake.state["signed"][0]["bucket"] == "verification-documents"


# ---------------------------------------------------------------------------
# 9. storage_path is never exposed in the response.
# ---------------------------------------------------------------------------


def test_response_never_discloses_storage_path(client, fake):
    sub = submission_row()
    fake.tables["verification_submissions"] = [sub]

    resp = client.get(
        f"{API}/{sub['id']}/document-url", headers=STAFF_AUTH_HEADERS
    )

    assert resp.status_code == 200
    assert "storage_path" not in resp.text
    assert set(resp.json().keys()) == {"url", "expires_in"}


# ---------------------------------------------------------------------------
# 10. Missing storage_path in the database is handled.
# ---------------------------------------------------------------------------


def test_missing_storage_path_returns_503(client, fake):
    sub = submission_row(storage_path=None)
    # Remove storage_path entirely so the row has no document reference
    del sub["storage_path"]
    fake.tables["verification_submissions"] = [sub]

    resp = client.get(
        f"{API}/{sub['id']}/document-url", headers=STAFF_AUTH_HEADERS
    )

    assert resp.status_code == 503
    assert resp.json()["error"]["code"] == "document_unavailable"
    assert fake.state["signed"] == []


# ---------------------------------------------------------------------------
# 11. Database failures surface as 503.
# ---------------------------------------------------------------------------


def test_submission_lookup_failure_returns_503(client, fake):
    fake = make_fake(fail_tables={"verification_submissions"})
    client = make_client(fake)

    resp = client.get(
        f"{API}/{uuid4()}/document-url", headers=STAFF_AUTH_HEADERS
    )

    assert resp.status_code == 503
    assert resp.json()["error"]["code"] == "database_unavailable"
    assert fake.state["signed"] == []


def test_staff_lookup_failure_returns_503(client, fake):
    fake = make_fake(fail_tables={"staff_admins"})
    client = make_client(fake)

    resp = client.get(
        f"{API}/{uuid4()}/document-url", headers=STAFF_AUTH_HEADERS
    )

    assert resp.status_code == 503
    assert resp.json()["error"]["code"] == "database_unavailable"
    assert fake.state["signed"] == []


# ---------------------------------------------------------------------------
# 12. Invalid verification_id UUID rejected.
# ---------------------------------------------------------------------------


def test_invalid_verification_id_is_rejected(client, fake):
    resp = client.get(
        f"{API}/not-a-uuid/document-url", headers=STAFF_AUTH_HEADERS
    )

    assert resp.status_code == 422
    assert resp.json()["error"]["code"] == "validation_error"
    assert fake.state["signed"] == []


# ---------------------------------------------------------------------------
# 13. Method not allowed for non-GET on document-url.
# ---------------------------------------------------------------------------


@pytest.mark.parametrize("method", ["post", "put", "delete", "patch"])
def test_document_url_rejects_non_get_methods(client, fake, method):
    resp = getattr(client, method)(
        f"{API}/{uuid4()}/document-url", headers=STAFF_AUTH_HEADERS
    )

    assert resp.status_code == 405