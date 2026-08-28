"""Focused backend tests for the staff reviewer queue API.

Scope: HTTP-level tests of THIS backend's staff authorization and the
GET /api/v1/admin/verifications queue endpoint — token-derived identity,
staff membership enforcement, client-supplied identifier resistance, safe
metadata projection (no storage_path), and failure handling.

Supabase is replaced at the `get_supabase_service_client` dependency boundary
with a small in-memory double implementing only the client surface the staff
service uses, mirroring tests/test_verification.py. These are NOT Supabase
integration tests and never touch a network.
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


# ---------------------------------------------------------------------------
# In-memory Supabase double (only the surface the staff service uses).
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
        self._order = None
        self._limit = None

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

    def execute(self):
        if self._fail:
            raise RuntimeError("database unavailable")
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


class FakeSupabase:
    def __init__(self, tables, fail_tables):
        self.tables = tables
        self._fail_tables = fail_tables
        self.auth = self

    def get_user(self, jwt=None):
        users = self.tables["__users_by_token__"]
        user_id = users.get(jwt)
        if user_id is None:
            raise RuntimeError("invalid JWT")
        return SimpleNamespace(user=SimpleNamespace(id=user_id))

    def table(self, name):
        return FakeTable(self.tables, name, self._fail_tables)


# ---------------------------------------------------------------------------
# Helpers / fixtures.
# ---------------------------------------------------------------------------


def university_row(**overrides):
    row = {
        "id": str(uuid4()),
        "name": "State University",
        "city": "College Town",
        "state": "CA",
        "country": "USA",
    }
    row.update(overrides)
    return row


def profile_row(profile_id, **overrides):
    row = {
        "id": str(profile_id),
        "auth_user_id": str(uuid4()),
        "first_name": "Jamie",
        "date_of_birth": "2003-04-12",
        "course": "Computer Science",
        "academic_year": 3,
        "bio": "private profile bio",
        "social_links": {"instagram": "@jamie"},
        "universities": university_row(),
    }
    row.update(overrides)
    return row


def queue_row(status, submitted_at, profile, **overrides):
    # Shaped like a PostgREST response to the staff queue select: the joined
    # profiles/universities embed carries MORE columns than the backend asks
    # for, so the tests prove the projection layer drops sensitive fields.
    row = {
        "id": str(uuid4()),
        "profile_id": profile["id"],
        "status": status,
        "storage_path": f"{uuid4().hex}.png",
        "submitted_at": submitted_at,
        "reviewed_at": None,
        "reviewer_id": None,
        "rejection_reason": None,
        "profiles": {
            "auth_user_id": profile["auth_user_id"],
            "first_name": profile["first_name"],
            "date_of_birth": profile["date_of_birth"],
            "course": profile["course"],
            "academic_year": profile["academic_year"],
            "bio": profile["bio"],
            "social_links": profile["social_links"],
            "universities": profile["universities"],
        },
    }
    row.update(overrides)
    return row


def make_fake(*, submissions=None, staff_ids=None, fail_tables=()):
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
    return FakeSupabase(tables, set(fail_tables))


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
# 1. Unauthenticated / invalid tokens rejected.
# ---------------------------------------------------------------------------


def test_unauthenticated_queue_is_rejected(client, fake):
    resp = client.get(API)

    assert resp.status_code == 401
    assert resp.json()["error"]["code"] == "unauthorized"


def test_invalid_token_is_rejected(client, fake):
    resp = client.get(API, headers={"Authorization": "Bearer wrong-token"})

    assert resp.status_code == 401
    assert resp.json()["error"]["code"] == "unauthorized"


def test_malformed_authorization_header_is_rejected(client, fake):
    resp = client.get(API, headers={"Authorization": f"Token {STAFF_TOKEN}"})

    assert resp.status_code == 401
    assert resp.json()["error"]["code"] == "unauthorized"


# ---------------------------------------------------------------------------
# 2. Authenticated non-staff rejected (403), even with client-supplied IDs.
# ---------------------------------------------------------------------------


def test_non_staff_is_forbidden(client, fake):
    fake.tables["verification_submissions"] = [
        queue_row("PENDING", "2026-08-28T10:00:00+00:00", profile_row(uuid4()))
    ]

    resp = client.get(API, headers=STUDENT_AUTH_HEADERS)

    assert resp.status_code == 403
    assert resp.json()["error"]["code"] == "permission_denied"
    assert str(fake.tables["verification_submissions"][0]["id"]) not in resp.text


def test_client_supplied_reviewer_id_cannot_bypass_authorization(client, fake):
    fake.tables["verification_submissions"] = [
        queue_row("PENDING", "2026-08-28T10:00:00+00:00", profile_row(uuid4()))
    ]

    resp = client.get(
        API,
        headers=STUDENT_AUTH_HEADERS,
        params={
            "reviewer_id": str(STAFF_AUTH_ID),
            "user_id": str(STAFF_AUTH_ID),
            "auth_user_id": str(STAFF_AUTH_ID),
            "staff": "true",
        },
    )

    assert resp.status_code == 403
    assert resp.json()["error"]["code"] == "permission_denied"


def test_client_supplied_ids_cannot_authenticate_an_invalid_token(client, fake):
    resp = client.get(
        API,
        headers={"Authorization": "Bearer not-a-real-token"},
        params={"reviewer_id": str(STAFF_AUTH_ID), "user_id": str(STAFF_AUTH_ID)},
    )

    assert resp.status_code == 401
    assert resp.json()["error"]["code"] == "unauthorized"


def test_staff_header_spoofing_is_ignored(client, fake):
    headers = {
        **STUDENT_AUTH_HEADERS,
        "X-Staff-User-Id": str(STAFF_AUTH_ID),
        "X-Reviewer-Id": str(STAFF_AUTH_ID),
    }

    resp = client.get(API, headers=headers)

    assert resp.status_code == 403
    assert resp.json()["error"]["code"] == "permission_denied"


# ---------------------------------------------------------------------------
# 3. Authenticated staff retrieves the queue.
# ---------------------------------------------------------------------------


def test_staff_retrieves_pending_queue_oldest_first(client, fake):
    profile_a = profile_row(uuid4(), first_name="Older")
    profile_b = profile_row(uuid4(), first_name="Newer")
    fake.tables["verification_submissions"] = [
        queue_row("PENDING", "2026-08-28T10:00:00+00:00", profile_b),
        queue_row("PENDING", "2026-08-20T10:00:00+00:00", profile_a),
        queue_row("REJECTED", "2026-08-19T10:00:00+00:00", profile_row(uuid4())),
    ]

    resp = client.get(API, headers=STAFF_AUTH_HEADERS)

    assert resp.status_code == 200
    items = resp.json()
    assert len(items) == 2
    assert [item["status"] for item in items] == ["PENDING", "PENDING"]
    assert [item["student"]["first_name"] for item in items] == ["Older", "Newer"]
    first = items[0]
    assert UUID(first["id"])
    assert UUID(first["profile_id"])
    assert first["submitted_at"] == "2026-08-20T10:00:00+00:00"
    assert first["student"]["date_of_birth"] == "2003-04-12"
    assert first["student"]["course"] == "Computer Science"
    assert first["student"]["academic_year"] == 3
    assert first["student"]["university"]["name"] == "State University"
    assert first["student"]["university"]["country"] == "USA"


def test_default_status_is_pending(client, fake):
    profile = profile_row(uuid4())
    fake.tables["verification_submissions"] = [
        queue_row("PENDING", "2026-08-28T10:00:00+00:00", profile),
        queue_row("VERIFIED", "2026-08-27T10:00:00+00:00", profile_row(uuid4())),
    ]

    explicit = client.get(
        API, headers=STAFF_AUTH_HEADERS, params={"status": "PENDING"}
    )
    default = client.get(API, headers=STAFF_AUTH_HEADERS)

    assert explicit.status_code == default.status_code == 200
    assert explicit.json() == default.json()
    assert [item["status"] for item in default.json()] == ["PENDING"]


def test_staff_can_filter_by_decided_statuses(client, fake):
    profile = profile_row(uuid4())
    fake.tables["verification_submissions"] = [
        queue_row("PENDING", "2026-08-28T10:00:00+00:00", profile),
        queue_row(
            "REJECTED",
            "2026-08-27T10:00:00+00:00",
            profile_row(uuid4()),
            reviewed_at="2026-08-27T12:00:00+00:00",
            rejection_reason="Document unreadable",
        ),
    ]

    resp = client.get(API, headers=STAFF_AUTH_HEADERS, params={"status": "REJECTED"})

    assert resp.status_code == 200
    items = resp.json()
    assert len(items) == 1
    assert items[0]["status"] == "REJECTED"


def test_invalid_status_is_rejected(client, fake):
    resp = client.get(API, headers=STAFF_AUTH_HEADERS, params={"status": "BOGUS"})

    assert resp.status_code == 422
    assert resp.json()["error"]["code"] == "validation_error"


def test_empty_queue_returns_empty_list(client, fake):
    resp = client.get(API, headers=STAFF_AUTH_HEADERS)

    assert resp.status_code == 200
    assert resp.json() == []


# ---------------------------------------------------------------------------
# 4. No storage path, no sensitive fields in the queue response.
# ---------------------------------------------------------------------------


def test_queue_never_discloses_storage_path_or_sensitive_fields(client, fake):
    fake.tables["verification_submissions"] = [
        queue_row("PENDING", "2026-08-28T10:00:00+00:00", profile_row(uuid4()))
    ]

    resp = client.get(API, headers=STAFF_AUTH_HEADERS)

    assert resp.status_code == 200
    body = resp.text
    item = resp.json()[0]
    assert "storage_path" not in body
    assert "auth_user_id" not in body
    assert "bio" not in body
    assert "social_links" not in body
    assert "reviewer_id" not in body
    assert set(item.keys()) == {"id", "profile_id", "status", "submitted_at", "student"}
    assert set(item["student"].keys()) == {
        "first_name",
        "date_of_birth",
        "course",
        "academic_year",
        "university",
    }
    assert set(item["student"]["university"].keys()) == {
        "name",
        "city",
        "state",
        "country",
    }


# ---------------------------------------------------------------------------
# 5. Database failures surface as 503 with the shared error envelope.
# ---------------------------------------------------------------------------


def test_staff_lookup_failure_returns_503(client, fake):
    fake = make_fake(fail_tables={"staff_admins"})
    client = make_client(fake)

    resp = client.get(API, headers=STAFF_AUTH_HEADERS)

    assert resp.status_code == 503
    assert resp.json()["error"]["code"] == "database_unavailable"


def test_queue_lookup_failure_returns_503(client, fake):
    fake = make_fake(fail_tables={"verification_submissions"})
    client = make_client(fake)

    resp = client.get(API, headers=STAFF_AUTH_HEADERS)

    assert resp.status_code == 503
    assert resp.json()["error"]["code"] == "database_unavailable"


# ---------------------------------------------------------------------------
# 6. Staff authorization derives only from the token identity.
# ---------------------------------------------------------------------------


def test_staff_membership_checked_for_the_token_identity_only(client, fake):
    # The student's token must never match a staff row even if someone plants
    # a staff row keyed by a query-supplied identifier: the fake only ever
    # receives eq("auth_user_id", <token identity>) — the service builds the
    # filter itself from the resolved token user.
    fake.tables["staff_admins"].append({"auth_user_id": "not-a-real-id"})

    resp = client.get(API, headers=STUDENT_AUTH_HEADERS)

    assert resp.status_code == 403
    assert resp.json()["error"]["code"] == "permission_denied"


def test_removed_staff_loses_queue_access(client, fake):
    fake = make_fake(staff_ids=[])
    client = make_client(fake)

    resp = client.get(API, headers=STAFF_AUTH_HEADERS)

    assert resp.status_code == 403
    assert resp.json()["error"]["code"] == "permission_denied"


@pytest.mark.parametrize(
    "method,path", [("post", API), ("put", API), ("delete", API), ("patch", API)]
)
def test_queue_is_read_only(client, fake, method, path):
    resp = getattr(client, method)(path, headers=STAFF_AUTH_HEADERS)

    assert resp.status_code == 405
