"""Focused backend tests for the student-ID verification API.

Scope: HTTP-level tests of THIS backend's logic — auth handling, server-side
file validation, submission rules, ownership derivation, partial-failure
cleanup, and self-only status disclosure.

Supabase is replaced at the `get_supabase_service_client` dependency boundary
with a small in-memory double implementing only the client surface the backend
uses. These are NOT Supabase integration tests and never touch a network.

The one test marked `requires_real_supabase` at the bottom needs a live
Supabase project (SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY environment
variables) and is skipped unless those are set.
"""

import os
import re
import uuid as uuid_module
from types import SimpleNamespace
from uuid import UUID, uuid4

import pytest
from fastapi.testclient import TestClient

from app.main import create_app
from app.services.supabase import get_supabase_service_client

API = "/api/v1/verification"

STUDENT_AUTH_ID = UUID("11111111-1111-1111-1111-111111111111")
OTHER_AUTH_ID = UUID("22222222-2222-2222-2222-222222222222")
STUDENT_PROFILE_ID = UUID("33333333-3333-3333-3333-333333333333")
OTHER_PROFILE_ID = UUID("44444444-4444-4444-4444-444444444444")
VALID_TOKEN = "valid-access-token"
OTHER_TOKEN = "other-access-token"

AUTH_HEADERS = {"Authorization": f"Bearer {VALID_TOKEN}"}
MAX_BYTES = 10 * 1024 * 1024


# ---------------------------------------------------------------------------
# In-memory Supabase double (only the surface the backend uses).
# ---------------------------------------------------------------------------


class FakeResponse:
    def __init__(self, data):
        self.data = data


class FakeTable:
    def __init__(self, tables, table_name, fail_insert_with):
        self._tables = tables
        self._table_name = table_name
        self._fail_insert_with = fail_insert_with
        self._filters: dict = {}
        self._single = False
        self._order = None
        self._limit = None
        self._insert_payload = None

    def select(self, _columns):
        return self

    def eq(self, column, value):
        self._filters[column] = value
        return self

    def order(self, column, desc=False):
        self._order = (column, desc)
        return self

    def limit(self, count):
        self._limit = count
        return self

    def maybe_single(self):
        self._single = True
        return self

    def insert(self, payload):
        self._insert_payload = payload
        return self

    def execute(self):
        if self._insert_payload is not None:
            if self._fail_insert_with is not None:
                raise self._fail_insert_with
            row = dict(self._insert_payload)
            row.setdefault("id", str(uuid4()))
            row.setdefault("submitted_at", "2026-08-28T12:00:00+00:00")
            row.setdefault("reviewed_at", None)
            row.setdefault("reviewer_id", None)
            row.setdefault("rejection_reason", None)
            self._tables[self._table_name].append(row)
            return FakeResponse([row])
        matched = [
            dict(row)
            for row in self._tables[self._table_name]
            if all(row.get(column) == value for column, value in self._filters.items())
        ]
        if self._order is not None:
            column, desc = self._order
            matched.sort(key=lambda row: row.get(column) or "", reverse=desc)
        if self._limit is not None:
            matched = matched[: self._limit]
        if self._single:
            return FakeResponse(matched[0] if matched else None)
        return FakeResponse(matched)


class FakeStorageBucket:
    def __init__(self, state, fail_upload_with):
        self._state = state
        self._fail_upload_with = fail_upload_with

    def upload(self, path, file, file_options=None):
        if self._fail_upload_with is not None:
            raise self._fail_upload_with
        assert path not in self._state["objects"], "object path must be unique"
        self._state["objects"][path] = {
            "data": bytes(file),
            "options": file_options,
        }
        return FakeResponse({"path": path})

    def remove(self, paths):
        for path in paths:
            self._state["objects"].pop(path, None)
            self._state["removed"].append(path)
        return FakeResponse(list(paths))


class FakeStorage:
    def __init__(self, state, fail_upload_with):
        self._state = state
        self._fail_upload_with = fail_upload_with

    def from_(self, _bucket):
        return FakeStorageBucket(self._state, self._fail_upload_with)


class FakeSupabase:
    def __init__(self, users_by_token, *, fail_upload_with=None, fail_insert_with=None):
        self.tables = {"profiles": [], "verification_submissions": []}
        self.state = {"objects": {}, "removed": []}
        self._fail_upload_with = fail_upload_with
        self._fail_insert_with = fail_insert_with
        self._users_by_token = users_by_token
        self.auth = self

    def get_user(self, jwt=None):
        user_id = self._users_by_token.get(jwt)
        if user_id is None:
            raise RuntimeError("invalid JWT")
        return SimpleNamespace(user=SimpleNamespace(id=user_id))

    def table(self, name):
        return FakeTable(self.tables, name, self._fail_insert_with)

    @property
    def storage(self):
        return FakeStorage(self.state, self._fail_upload_with)


# ---------------------------------------------------------------------------
# Helpers / fixtures.
# ---------------------------------------------------------------------------


def make_fake(
    *,
    submissions=None,
    profiles=None,
    fail_upload_with=None,
    fail_insert_with=None,
):
    fake = FakeSupabase(
        {VALID_TOKEN: str(STUDENT_AUTH_ID), OTHER_TOKEN: str(OTHER_AUTH_ID)},
        fail_upload_with=fail_upload_with,
        fail_insert_with=fail_insert_with,
    )
    fake.tables["profiles"] = (
        profiles
        if profiles is not None
        else [
            {"id": str(STUDENT_PROFILE_ID), "auth_user_id": str(STUDENT_AUTH_ID)},
            {"id": str(OTHER_PROFILE_ID), "auth_user_id": str(OTHER_AUTH_ID)},
        ]
    )
    fake.tables["verification_submissions"] = list(submissions or [])
    return fake


def make_client(fake):
    app = create_app()
    app.dependency_overrides[get_supabase_service_client] = lambda: fake
    return TestClient(app)


def png_bytes(size=64):
    return b"\x89PNG\r\n\x1a\n" + b"\x00" * size


def jpeg_bytes(size=64):
    return b"\xff\xd8\xff\xe0" + b"\x00" * size


def pdf_bytes(size=64):
    return b"%PDF-1.7\n" + b"\x00" * size


def webp_bytes(size=64):
    return b"RIFF\x24\x00\x00\x00WEBPVP8 " + b"\x00" * size


def gif_bytes(size=64):
    return b"GIF89a" + b"\x00" * size


def submission_row(status, submitted_at, profile_id=STUDENT_PROFILE_ID, **overrides):
    row = {
        "id": str(uuid4()),
        "profile_id": str(profile_id),
        "status": status,
        "storage_path": f"{uuid_module.uuid4().hex}.png",
        "submitted_at": submitted_at,
        "reviewed_at": None if status == "PENDING" else submitted_at,
        "rejection_reason": None,
    }
    row.update(overrides)
    return row


@pytest.fixture()
def fake():
    return make_fake()


@pytest.fixture()
def client(fake):
    return make_client(fake)


# ---------------------------------------------------------------------------
# 1. Unauthenticated requests rejected.
# ---------------------------------------------------------------------------


def test_unauthenticated_submit_is_rejected(client, fake):
    resp = client.post(
        f"{API}/submit", files={"file": ("id.png", png_bytes(), "image/png")}
    )

    assert resp.status_code == 401
    assert resp.json()["error"]["code"] == "unauthorized"
    assert not fake.state["objects"]
    assert fake.tables["verification_submissions"] == []


def test_invalid_token_is_rejected(client, fake):
    resp = client.post(
        f"{API}/submit",
        headers={"Authorization": "Bearer wrong-token"},
        files={"file": ("id.png", png_bytes(), "image/png")},
    )

    assert resp.status_code == 401
    assert resp.json()["error"]["code"] == "unauthorized"
    assert not fake.state["objects"]


def test_malformed_authorization_header_is_rejected(client):
    resp = client.post(
        f"{API}/submit",
        headers={"Authorization": f"Token {VALID_TOKEN}"},
        files={"file": ("id.png", png_bytes(), "image/png")},
    )

    assert resp.status_code == 401
    assert resp.json()["error"]["code"] == "unauthorized"


# ---------------------------------------------------------------------------
# 2. Valid authenticated submission succeeds.
# ---------------------------------------------------------------------------


def test_valid_authenticated_submission_succeeds(client, fake):
    resp = client.post(
        f"{API}/submit",
        headers=AUTH_HEADERS,
        files={"file": ("student-id.png", png_bytes(), "image/png")},
    )

    assert resp.status_code == 201
    body = resp.json()
    assert body["status"] == "PENDING"
    assert body["id"]
    assert body["submitted_at"]

    assert len(fake.state["objects"]) == 1
    assert len(fake.tables["verification_submissions"]) == 1
    row = fake.tables["verification_submissions"][0]
    assert row["status"] == "PENDING"
    stored_path = next(iter(fake.state["objects"]))
    assert row["storage_path"] == stored_path
    stored = fake.state["objects"][stored_path]
    assert stored["data"] == png_bytes()
    assert stored["options"]["content-type"] == "image/png"


@pytest.mark.parametrize(
    "builder,content_type",
    [
        (jpeg_bytes, "image/jpeg"),
        (pdf_bytes, "application/pdf"),
        (webp_bytes, "image/webp"),
    ],
)
def test_all_allowed_file_types_succeed(client, fake, builder, content_type):
    resp = client.post(
        f"{API}/submit",
        headers=AUTH_HEADERS,
        files={"file": (f"id{uuid4().hex}", builder(), content_type)},
    )

    assert resp.status_code == 201
    assert resp.json()["status"] == "PENDING"
    assert len(fake.state["objects"]) == 1


# ---------------------------------------------------------------------------
# 3. Ownership comes from the auth identity (never client input).
# ---------------------------------------------------------------------------


def test_ownership_comes_from_auth_identity(client, fake):
    resp = client.post(
        f"{API}/submit",
        headers=AUTH_HEADERS,
        files={"file": ("student-id.png", png_bytes(), "image/png")},
    )

    assert resp.status_code == 201
    path = next(iter(fake.state["objects"]))
    assert re.fullmatch(rf"{STUDENT_AUTH_ID}/[0-9a-f]{{32}}\.png", path)
    assert str(STUDENT_PROFILE_ID) not in path
    row = fake.tables["verification_submissions"][0]
    assert row["profile_id"] == str(STUDENT_PROFILE_ID)


def test_object_path_is_random_per_submission(client, fake):
    resp = client.post(
        f"{API}/submit",
        headers=AUTH_HEADERS,
        files={"file": ("id.png", png_bytes(), "image/png")},
    )
    assert resp.status_code == 201

    other = client.post(
        f"{API}/submit",
        headers={"Authorization": f"Bearer {OTHER_TOKEN}"},
        files={"file": ("id.png", png_bytes(), "image/png")},
    )
    assert other.status_code == 201

    paths = list(fake.state["objects"])
    assert len(paths) == 2
    assert len(set(paths)) == 2
    assert any(path.startswith(f"{STUDENT_AUTH_ID}/") for path in paths)
    assert any(path.startswith(f"{OTHER_AUTH_ID}/") for path in paths)


# ---------------------------------------------------------------------------
# 4. Client cannot select profile_id.
# ---------------------------------------------------------------------------


def test_client_cannot_select_profile_id(client, fake):
    resp = client.post(
        f"{API}/submit",
        headers=AUTH_HEADERS,
        data={"profile_id": str(OTHER_PROFILE_ID)},
        files={"file": ("id.png", png_bytes(), "image/png")},
    )

    assert resp.status_code == 201
    inserted = fake.tables["verification_submissions"]
    assert len(inserted) == 1
    assert inserted[0]["profile_id"] == str(STUDENT_PROFILE_ID)


# ---------------------------------------------------------------------------
# 5. Client cannot select status (or reviewer/timestamp fields).
# ---------------------------------------------------------------------------


def test_client_cannot_select_status(client, fake):
    resp = client.post(
        f"{API}/submit",
        headers=AUTH_HEADERS,
        data={
            "status": "VERIFIED",
            "reviewer_id": str(OTHER_AUTH_ID),
            "rejection_reason": "self-approved",
            "submitted_at": "1999-01-01T00:00:00+00:00",
            "reviewed_at": "1999-01-01T00:00:00+00:00",
        },
        files={"file": ("id.png", png_bytes(), "image/png")},
    )

    assert resp.status_code == 201
    assert resp.json()["status"] == "PENDING"
    row = fake.tables["verification_submissions"][0]
    assert row["status"] == "PENDING"
    assert row["reviewer_id"] is None
    assert row["reviewed_at"] is None
    assert row["rejection_reason"] is None
    assert row["submitted_at"] != "1999-01-01T00:00:00+00:00"


# ---------------------------------------------------------------------------
# 6. Invalid file types rejected (declared MIME is never trusted alone).
# ---------------------------------------------------------------------------


@pytest.mark.parametrize(
    "filename,content_type,payload",
    [
        ("id.html", "text/html", png_bytes()),
        ("id.exe", "application/octet-stream-exe", png_bytes()),
        ("mismatch.png", "image/png", jpeg_bytes()),
        ("mismatch.pdf", "application/pdf", png_bytes()),
        ("fake.png", "image/png", b"definitely not an image"),
        ("photo.gif", "image/gif", gif_bytes()),
        ("empty.png", "image/png", b""),
    ],
)
def test_invalid_files_are_rejected(client, fake, filename, content_type, payload):
    resp = client.post(
        f"{API}/submit",
        headers=AUTH_HEADERS,
        files={"file": (filename, payload, content_type)},
    )

    assert resp.status_code == 400
    assert resp.json()["error"]["code"] == "invalid_file_type"
    assert not fake.state["objects"]
    assert fake.tables["verification_submissions"] == []


# ---------------------------------------------------------------------------
# 7. Oversized files rejected.
# ---------------------------------------------------------------------------


def test_oversized_file_is_rejected(client, fake):
    oversized = png_bytes(MAX_BYTES)

    resp = client.post(
        f"{API}/submit",
        headers=AUTH_HEADERS,
        files={"file": ("id.png", oversized, "image/png")},
    )

    assert resp.status_code == 413
    assert resp.json()["error"]["code"] == "file_too_large"
    assert not fake.state["objects"]
    assert fake.tables["verification_submissions"] == []


def test_exactly_max_size_passes_validation(client, fake):
    exact = png_bytes(MAX_BYTES - len(png_bytes()))

    resp = client.post(
        f"{API}/submit",
        headers=AUTH_HEADERS,
        files={"file": ("id.png", exact, "image/png")},
    )

    assert resp.status_code == 201
    assert fake.state["objects"]
    assert fake.tables["verification_submissions"]


# ---------------------------------------------------------------------------
# 8. Duplicate PENDING submission rejected.
# ---------------------------------------------------------------------------


def test_duplicate_pending_submission_is_rejected(client, fake):
    fake.tables["verification_submissions"] = [
        submission_row("PENDING", "2026-08-28T10:00:00+00:00")
    ]

    resp = client.post(
        f"{API}/submit",
        headers=AUTH_HEADERS,
        files={"file": ("id.png", png_bytes(), "image/png")},
    )

    assert resp.status_code == 409
    assert resp.json()["error"]["code"] == "pending_submission_exists"
    assert len(fake.tables["verification_submissions"]) == 1
    assert not fake.state["objects"]
    assert not fake.state["removed"]


# ---------------------------------------------------------------------------
# 9. REJECTED user can submit again (new row + new Storage object).
# ---------------------------------------------------------------------------


def test_rejected_user_can_submit_again(client, fake):
    previous = submission_row(
        "REJECTED",
        "2026-08-20T10:00:00+00:00",
        rejection_reason="Document unreadable",
    )
    fake.tables["verification_submissions"] = [previous]

    resp = client.post(
        f"{API}/submit",
        headers=AUTH_HEADERS,
        files={"file": ("id.png", png_bytes(), "image/png")},
    )

    assert resp.status_code == 201
    assert resp.json()["status"] == "PENDING"
    rows = fake.tables["verification_submissions"]
    assert len(rows) == 2
    assert rows[-1]["id"] != previous["id"]
    assert rows[-1]["status"] == "PENDING"
    new_path = next(iter(fake.state["objects"]))
    assert new_path != previous["storage_path"]
    assert not fake.state["removed"]


# ---------------------------------------------------------------------------
# 10. VERIFIED user cannot submit again.
# ---------------------------------------------------------------------------


def test_verified_user_cannot_submit_again(client, fake):
    fake.tables["verification_submissions"] = [
        submission_row("VERIFIED", "2026-08-20T10:00:00+00:00")
    ]

    resp = client.post(
        f"{API}/submit",
        headers=AUTH_HEADERS,
        files={"file": ("id.png", png_bytes(), "image/png")},
    )

    assert resp.status_code == 409
    assert resp.json()["error"]["code"] == "already_verified"
    assert len(fake.tables["verification_submissions"]) == 1
    assert not fake.state["objects"]


# ---------------------------------------------------------------------------
# Profile existence.
# ---------------------------------------------------------------------------


def test_profile_not_found_is_rejected(client, fake):
    fake.tables["profiles"] = []

    resp = client.post(
        f"{API}/submit",
        headers=AUTH_HEADERS,
        files={"file": ("id.png", png_bytes(), "image/png")},
    )

    assert resp.status_code == 404
    assert resp.json()["error"]["code"] == "profile_not_found"
    assert not fake.state["objects"]
    assert fake.tables["verification_submissions"] == []


def test_status_without_profile_is_rejected(client, fake):
    fake.tables["profiles"] = []

    resp = client.get(f"{API}/status", headers=AUTH_HEADERS)

    assert resp.status_code == 404
    assert resp.json()["error"]["code"] == "profile_not_found"


# ---------------------------------------------------------------------------
# 11. Status endpoint returns only the current user's own state.
# ---------------------------------------------------------------------------


def test_status_returns_own_pending_state(client, fake):
    fake.tables["verification_submissions"] = [
        submission_row("PENDING", "2026-08-28T10:00:00+00:00"),
        submission_row(
            "REJECTED",
            "2026-08-19T10:00:00+00:00",
            profile_id=OTHER_PROFILE_ID,
            rejection_reason="Other user's rejection",
        ),
    ]

    resp = client.get(f"{API}/status", headers=AUTH_HEADERS)

    assert resp.status_code == 200
    body = resp.json()
    assert body["verification_status"] == "PENDING"
    assert body["submission"]["status"] == "PENDING"
    assert "VERIFIED" not in str(body)
    assert "Other user's rejection" not in str(body)


def test_status_returns_latest_submission_with_rejection_reason(client, fake):
    fake.tables["verification_submissions"] = [
        submission_row("PENDING", "2026-08-20T10:00:00+00:00"),
        submission_row(
            "REJECTED",
            "2026-08-28T10:00:00+00:00",
            rejection_reason="Document unreadable",
        ),
    ]

    resp = client.get(f"{API}/status", headers=AUTH_HEADERS)

    assert resp.status_code == 200
    body = resp.json()
    assert body["verification_status"] == "REJECTED"
    assert body["submission"]["rejection_reason"] == "Document unreadable"


def test_status_with_no_submissions_returns_null(client, fake):
    resp = client.get(f"{API}/status", headers=AUTH_HEADERS)

    assert resp.status_code == 200
    assert resp.json() == {"verification_status": None, "submission": None}


def test_status_unauthenticated_is_rejected(client, fake):
    fake.tables["verification_submissions"] = [
        submission_row("PENDING", "2026-08-28T10:00:00+00:00")
    ]

    resp = client.get(f"{API}/status")

    assert resp.status_code == 401
    assert resp.json()["error"]["code"] == "unauthorized"


# ---------------------------------------------------------------------------
# 12. No arbitrary-profile status access; no storage path disclosure.
# ---------------------------------------------------------------------------


def test_status_query_param_cannot_target_other_profiles(client, fake):
    fake.tables["verification_submissions"] = [
        submission_row(
            "VERIFIED",
            "2026-08-28T10:00:00+00:00",
            profile_id=OTHER_PROFILE_ID,
        ),
        submission_row("PENDING", "2026-08-27T10:00:00+00:00"),
    ]

    resp = client.get(
        f"{API}/status",
        headers=AUTH_HEADERS,
        params={"profile_id": str(OTHER_PROFILE_ID)},
    )

    assert resp.status_code == 200
    body = resp.json()
    assert body["verification_status"] == "PENDING"
    assert "VERIFIED" not in str(body)


def test_status_never_discloses_storage_path(client, fake):
    fake.tables["verification_submissions"] = [
        submission_row("PENDING", "2026-08-28T10:00:00+00:00")
    ]

    resp = client.get(f"{API}/status", headers=AUTH_HEADERS)

    assert resp.status_code == 200
    body = resp.json()
    assert "storage_path" not in body["submission"]
    assert "storage_path" not in body


def test_other_user_sees_only_their_own_state(client, fake):
    fake.tables["verification_submissions"] = [
        submission_row("PENDING", "2026-08-28T10:00:00+00:00")
    ]

    resp = client.get(f"{API}/status", headers={"Authorization": f"Bearer {OTHER_TOKEN}"})

    assert resp.status_code == 200
    assert resp.json() == {"verification_status": None, "submission": None}


# ---------------------------------------------------------------------------
# 13. Storage upload failure handled (no row, clear error).
# ---------------------------------------------------------------------------


def test_storage_failure_is_handled(client):
    fake = make_fake(fail_upload_with=RuntimeError("storage unavailable"))
    client = make_client(fake)

    resp = client.post(
        f"{API}/submit",
        headers=AUTH_HEADERS,
        files={"file": ("id.png", png_bytes(), "image/png")},
    )

    assert resp.status_code == 503
    assert resp.json()["error"]["code"] == "storage_upload_failed"
    assert fake.tables["verification_submissions"] == []
    assert not fake.state["objects"]


# ---------------------------------------------------------------------------
# 14. Database failure after Storage upload triggers cleanup.
# ---------------------------------------------------------------------------


def test_database_failure_after_upload_cleans_up_document():
    fake = make_fake(fail_insert_with=RuntimeError("database unavailable"))
    client = make_client(fake)

    resp = client.post(
        f"{API}/submit",
        headers=AUTH_HEADERS,
        files={"file": ("id.png", png_bytes(), "image/png")},
    )

    assert resp.status_code == 503
    assert resp.json()["error"]["code"] == "database_insert_failed"
    assert fake.tables["verification_submissions"] == []
    assert not fake.state["objects"]
    assert len(fake.state["removed"]) == 1


def test_duplicate_race_after_upload_cleans_up_and_returns_conflict():
    class DuplicateKeyError(RuntimeError):
        pass

    fake = make_fake(
        fail_insert_with=DuplicateKeyError(
            'duplicate key value violates unique constraint '
            '"verification_submissions_one_pending_per_profile_idx"'
        )
    )
    client = make_client(fake)

    resp = client.post(
        f"{API}/submit",
        headers=AUTH_HEADERS,
        files={"file": ("id.png", png_bytes(), "image/png")},
    )

    assert resp.status_code == 409
    assert resp.json()["error"]["code"] == "pending_submission_exists"
    assert not fake.state["objects"]
    assert len(fake.state["removed"]) == 1


def test_cleanup_never_touches_other_submissions_documents():
    existing_path = f"{STUDENT_AUTH_ID}/existing-document.png"

    class DuplicateKeyError(RuntimeError):
        pass

    fake = make_fake(
        fail_insert_with=DuplicateKeyError("duplicate key value violates unique constraint")
    )
    fake.state["objects"][existing_path] = {"data": b"previous evidence"}
    client = make_client(fake)

    resp = client.post(
        f"{API}/submit",
        headers=AUTH_HEADERS,
        files={"file": ("id.png", png_bytes(), "image/png")},
    )

    assert resp.status_code == 409
    assert resp.json()["error"]["code"] == "pending_submission_exists"
    assert existing_path in fake.state["objects"]
    assert existing_path not in fake.state["removed"]


# ---------------------------------------------------------------------------
# REAL Supabase integration test — REQUIRES a live Supabase environment.
# Skipped unless SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are set. It
# verifies the private `verification-documents` bucket exists and accepts a
# service-role upload/remove roundtrip; it never runs in CI by default.
# ---------------------------------------------------------------------------


@pytest.mark.requires_real_supabase
@pytest.mark.skipif(
    not (
        os.environ.get("SUPABASE_URL")
        and os.environ.get("SUPABASE_SERVICE_ROLE_KEY")
    ),
    reason=(
        "requires a real Supabase environment: set SUPABASE_URL and "
        "SUPABASE_SERVICE_ROLE_KEY to run this integration test"
    ),
)
def test_real_supabase_verification_bucket_roundtrip():
    from supabase import create_client

    client = create_client(
        os.environ["SUPABASE_URL"], os.environ["SUPABASE_SERVICE_ROLE_KEY"]
    )
    bucket = client.storage.from_("verification-documents")
    folder = "_integration-probe"
    path = f"{folder}/{uuid_module.uuid4().hex}.png"
    try:
        bucket.upload(
            path=path,
            file=png_bytes(),
            file_options={"content-type": "image/png", "upsert": False},
        )
        listing = bucket.list(folder)
        assert any(obj.get("name") == path.split("/")[-1] for obj in listing)
    finally:
        bucket.remove([path])
    assert not bucket.list(folder)
