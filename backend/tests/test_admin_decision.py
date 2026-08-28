"""Focused backend tests for the staff reviewer decision endpoint.

Scope: HTTP-level tests of POST /api/v1/admin/verifications/{id}/decision —
staff-only authorization, server-derived reviewer identity, the PENDING ->
VERIFIED | REJECTED state machine, rejection-reason validation, audit-trigger
compatibility, and failure handling.

Supabase is replaced at the `get_supabase_service_client` dependency boundary
with a small in-memory double implementing only the client surface this
endpoint uses (staff membership lookup, submission lookup + update). The fake
simulates the essential database trigger behavior: decisions are timestamped
server-side, only PENDING submissions may be decided, and a REJECTED decision
must carry a reason. These are NOT Supabase integration tests and never touch
a network.
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

_REVIEWED_AT = "2026-08-28T14:00:00+00:00"


# ---------------------------------------------------------------------------
# In-memory Supabase double (staff + decision surface).
# ---------------------------------------------------------------------------


class FakeResponse:
    def __init__(self, data):
        self.data = data


class FakeTable:
    def __init__(self, tables, table_name, fail_tables, state):
        self._tables = tables
        self._table_name = table_name
        self._fail = table_name in fail_tables
        self._state = state
        self._filters: dict = {}
        self._single = False
        self._update_data = None

    def select(self, _columns):
        return self

    def update(self, data):
        self._update_data = dict(data)
        return self

    def eq(self, column, value):
        self._filters[column] = value
        return self

    def maybe_single(self):
        self._single = True
        return self

    def _matches(self, row):
        return all(
            row.get(column) == value for column, value in self._filters.items()
        )

    def execute(self):
        if self._fail:
            raise RuntimeError("database unavailable")
        matched = [dict(row) for row in self._tables[self._table_name] if self._matches(row)]
        if self._update_data is not None:
            self._state["updates"].append(
                {
                    "table": self._table_name,
                    "data": dict(self._update_data),
                    "filters": dict(self._filters),
                }
            )
            if self._state.get("fail_update"):
                raise RuntimeError("database error: could not serialize access")
            for row in self._tables[self._table_name]:
                if self._matches(row):
                    # Simulate the database trigger: only PENDING submissions
                    # may be decided, and REJECTED decisions must carry a reason.
                    if row["status"] != "PENDING":
                        raise RuntimeError("illegal verification status transition")
                    row.update(self._update_data)
                    if row["status"] == "REJECTED":
                        reason = row.get("rejection_reason")
                        if not reason or reason != reason.strip():
                            raise RuntimeError(
                                "a REJECTED decision requires a rejection reason"
                            )
                    else:
                        row["rejection_reason"] = None
                    row["reviewed_at"] = _REVIEWED_AT
            matched = [
                dict(row) for row in self._tables[self._table_name] if self._matches(row)
            ]
        if self._single:
            return FakeResponse(matched[0] if matched else None)
        return FakeResponse(matched)


class FakeSupabase:
    def __init__(self, tables, fail_tables):
        self.tables = tables
        self._fail_tables = fail_tables
        self.state = {"updates": [], "fail_update": False}
        self.auth = self

    def get_user(self, jwt=None):
        user_id = self.tables["__users_by_token__"].get(jwt)
        if user_id is None:
            raise RuntimeError("invalid JWT")
        return SimpleNamespace(user=SimpleNamespace(id=user_id))

    def table(self, name):
        return FakeTable(self.tables, name, self._fail_tables, self.state)


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
        "reviewed_at": None,
        "reviewer_id": None,
        "rejection_reason": None,
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
        "verification_reviews": [],
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


def last_update(fake):
    assert fake.state["updates"], "no database update was performed"
    return fake.state["updates"][-1]


# ---------------------------------------------------------------------------
# 1. Unauthenticated / invalid tokens rejected.
# ---------------------------------------------------------------------------


def test_unauthenticated_decision_is_rejected(client, fake):
    resp = client.post(f"{API}/{uuid4()}/decision", json={"status": "VERIFIED"})

    assert resp.status_code == 401
    assert resp.json()["error"]["code"] == "unauthorized"
    assert fake.state["updates"] == []


def test_invalid_token_is_rejected(client, fake):
    resp = client.post(
        f"{API}/{uuid4()}/decision",
        headers={"Authorization": "Bearer wrong-token"},
        json={"status": "VERIFIED"},
    )

    assert resp.status_code == 401
    assert resp.json()["error"]["code"] == "unauthorized"
    assert fake.state["updates"] == []


# ---------------------------------------------------------------------------
# 2. Authenticated non-staff rejected (403), even with spoofed identity.
# ---------------------------------------------------------------------------


def test_non_staff_cannot_decide(client, fake):
    sub = submission_row()
    fake.tables["verification_submissions"] = [sub]

    resp = client.post(
        f"{API}/{sub['id']}/decision",
        headers=STUDENT_AUTH_HEADERS,
        json={"status": "VERIFIED"},
    )

    assert resp.status_code == 403
    assert resp.json()["error"]["code"] == "permission_denied"
    assert fake.tables["verification_submissions"][0]["status"] == "PENDING"
    assert fake.state["updates"] == []


def test_staff_removed_loses_decision_access(client, fake):
    fake = make_fake(staff_ids=[])
    client = make_client(fake)

    resp = client.post(
        f"{API}/{uuid4()}/decision",
        headers=STAFF_AUTH_HEADERS,
        json={"status": "VERIFIED"},
    )

    assert resp.status_code == 403
    assert resp.json()["error"]["code"] == "permission_denied"
    assert fake.state["updates"] == []


def test_client_supplied_reviewer_id_cannot_grant_authorization(client, fake):
    sub = submission_row()
    fake.tables["verification_submissions"] = [sub]

    resp = client.post(
        f"{API}/{sub['id']}/decision",
        headers=STUDENT_AUTH_HEADERS,
        json={
            "status": "VERIFIED",
            "reviewer_id": str(STAFF_AUTH_ID),
            "auth_user_id": str(STAFF_AUTH_ID),
            "user_id": str(STAFF_AUTH_ID),
        },
    )

    assert resp.status_code == 403
    assert resp.json()["error"]["code"] == "permission_denied"


# ---------------------------------------------------------------------------
# 3. Malformed verification UUID rejected.
# ---------------------------------------------------------------------------


def test_malformed_verification_uuid_is_rejected(client, fake):
    resp = client.post(
        f"{API}/not-a-uuid/decision",
        headers=STAFF_AUTH_HEADERS,
        json={"status": "VERIFIED"},
    )

    assert resp.status_code == 422
    assert resp.json()["error"]["code"] == "validation_error"
    assert fake.state["updates"] == []


# ---------------------------------------------------------------------------
# 4. Nonexistent verification.
# ---------------------------------------------------------------------------


def test_nonexistent_verification_returns_404(client, fake):
    resp = client.post(
        f"{API}/{uuid4()}/decision",
        headers=STAFF_AUTH_HEADERS,
        json={"status": "VERIFIED"},
    )

    assert resp.status_code == 404
    assert resp.json()["error"]["code"] == "verification_not_found"
    assert fake.state["updates"] == []


# ---------------------------------------------------------------------------
# 5/6. PENDING -> VERIFIED / PENDING -> REJECTED succeed.
# ---------------------------------------------------------------------------


def test_pending_to_verified_succeeds(client, fake):
    sub = submission_row()
    fake.tables["verification_submissions"] = [sub]

    resp = client.post(
        f"{API}/{sub['id']}/decision",
        headers=STAFF_AUTH_HEADERS,
        json={"status": "VERIFIED"},
    )

    assert resp.status_code == 200
    body = resp.json()
    assert body["id"] == sub["id"]
    assert body["profile_id"] == sub["profile_id"]
    assert body["status"] == "VERIFIED"
    assert body["submitted_at"] == sub["submitted_at"]
    assert body["reviewed_at"] == _REVIEWED_AT
    assert body["rejection_reason"] is None
    assert fake.tables["verification_submissions"][0]["status"] == "VERIFIED"


def test_pending_to_rejected_succeeds_with_reason(client, fake):
    sub = submission_row()
    fake.tables["verification_submissions"] = [sub]

    resp = client.post(
        f"{API}/{sub['id']}/decision",
        headers=STAFF_AUTH_HEADERS,
        json={"status": "REJECTED", "rejection_reason": "Document unreadable"},
    )

    assert resp.status_code == 200
    body = resp.json()
    assert body["status"] == "REJECTED"
    assert body["rejection_reason"] == "Document unreadable"
    assert body["reviewed_at"] == _REVIEWED_AT
    assert fake.tables["verification_submissions"][0]["status"] == "REJECTED"


def test_rejection_reason_is_trimmed(client, fake):
    sub = submission_row()
    fake.tables["verification_submissions"] = [sub]

    resp = client.post(
        f"{API}/{sub['id']}/decision",
        headers=STAFF_AUTH_HEADERS,
        json={"status": "REJECTED", "rejection_reason": "  blurry photo  "},
    )

    assert resp.status_code == 200
    assert resp.json()["rejection_reason"] == "blurry photo"


# ---------------------------------------------------------------------------
# 7/8. REJECTED without a valid reason -> 422.
# ---------------------------------------------------------------------------


def test_rejected_without_reason_is_422(client, fake):
    sub = submission_row()
    fake.tables["verification_submissions"] = [sub]

    resp = client.post(
        f"{API}/{sub['id']}/decision",
        headers=STAFF_AUTH_HEADERS,
        json={"status": "REJECTED"},
    )

    assert resp.status_code == 422
    assert resp.json()["error"]["code"] == "validation_error"
    assert fake.tables["verification_submissions"][0]["status"] == "PENDING"
    assert fake.state["updates"] == []


def test_rejected_with_null_reason_is_422(client, fake):
    sub = submission_row()
    fake.tables["verification_submissions"] = [sub]

    resp = client.post(
        f"{API}/{sub['id']}/decision",
        headers=STAFF_AUTH_HEADERS,
        json={"status": "REJECTED", "rejection_reason": None},
    )

    assert resp.status_code == 422
    assert resp.json()["error"]["code"] == "validation_error"
    assert fake.state["updates"] == []


def test_rejected_with_whitespace_reason_is_422(client, fake):
    sub = submission_row()
    fake.tables["verification_submissions"] = [sub]

    for reason in ["", "   ", "\t\n"]:
        resp = client.post(
            f"{API}/{sub['id']}/decision",
            headers=STAFF_AUTH_HEADERS,
            json={"status": "REJECTED", "rejection_reason": reason},
        )
        assert resp.status_code == 422
        assert resp.json()["error"]["code"] == "validation_error"
        assert fake.state["updates"] == []


def test_rejected_reason_over_500_chars_is_422(client, fake):
    sub = submission_row()
    fake.tables["verification_submissions"] = [sub]

    resp = client.post(
        f"{API}/{sub['id']}/decision",
        headers=STAFF_AUTH_HEADERS,
        json={"status": "REJECTED", "rejection_reason": "x" * 501},
    )

    assert resp.status_code == 422
    assert resp.json()["error"]["code"] == "validation_error"
    assert fake.state["updates"] == []


# ---------------------------------------------------------------------------
# 9/10. Decided submissions are immutable (no second decision).
# ---------------------------------------------------------------------------


def test_verified_cannot_be_decided_again(client, fake):
    sub = submission_row(status="VERIFIED")
    fake.tables["verification_submissions"] = [sub]

    resp = client.post(
        f"{API}/{sub['id']}/decision",
        headers=STAFF_AUTH_HEADERS,
        json={"status": "VERIFIED"},
    )

    assert resp.status_code == 409
    assert resp.json()["error"]["code"] == "invalid_state_transition"
    assert fake.tables["verification_submissions"][0]["status"] == "VERIFIED"
    assert fake.state["updates"] == []


def test_rejected_cannot_be_decided_again(client, fake):
    sub = submission_row(
        status="REJECTED",
        reviewed_at=_REVIEWED_AT,
        reviewer_id=str(STAFF_AUTH_ID),
        rejection_reason="Document unreadable",
    )
    fake.tables["verification_submissions"] = [sub]

    resp = client.post(
        f"{API}/{sub['id']}/decision",
        headers=STAFF_AUTH_HEADERS,
        json={"status": "VERIFIED"},
    )

    assert resp.status_code == 409
    assert resp.json()["error"]["code"] == "invalid_state_transition"
    assert fake.tables["verification_submissions"][0]["status"] == "REJECTED"
    assert fake.state["updates"] == []


def test_rejected_cannot_be_rejected_again(client, fake):
    sub = submission_row(
        status="REJECTED",
        reviewed_at=_REVIEWED_AT,
        reviewer_id=str(STAFF_AUTH_ID),
        rejection_reason="Document unreadable",
    )
    fake.tables["verification_submissions"] = [sub]

    resp = client.post(
        f"{API}/{sub['id']}/decision",
        headers=STAFF_AUTH_HEADERS,
        json={"status": "REJECTED", "rejection_reason": "Another reason"},
    )

    assert resp.status_code == 409
    assert resp.json()["error"]["code"] == "invalid_state_transition"
    assert fake.state["updates"] == []


# ---------------------------------------------------------------------------
# 11/12/13. Client-supplied identifiers never override server-side facts.
# ---------------------------------------------------------------------------


def test_client_supplied_reviewer_id_cannot_override_identity(client, fake):
    sub = submission_row()
    fake.tables["verification_submissions"] = [sub]
    fake_reviewer = str(uuid4())

    resp = client.post(
        f"{API}/{sub['id']}/decision",
        headers=STAFF_AUTH_HEADERS,
        json={"status": "VERIFIED", "reviewer_id": fake_reviewer},
    )

    assert resp.status_code == 200
    update = last_update(fake)
    assert update["data"]["reviewer_id"] == str(STAFF_AUTH_ID)
    assert fake_reviewer not in resp.text


def test_client_supplied_auth_user_id_cannot_override_identity(client, fake):
    sub = submission_row()
    fake.tables["verification_submissions"] = [sub]
    fake_auth = str(uuid4())

    resp = client.post(
        f"{API}/{sub['id']}/decision",
        headers=STAFF_AUTH_HEADERS,
        json={"status": "VERIFIED", "auth_user_id": fake_auth, "user_id": fake_auth},
    )

    assert resp.status_code == 200
    update = last_update(fake)
    assert update["data"]["reviewer_id"] == str(STAFF_AUTH_ID)
    assert fake_auth not in resp.text


def test_client_cannot_supply_storage_path_or_profile_id(client, fake):
    sub = submission_row()
    fake.tables["verification_submissions"] = [sub]
    fake_path = "fake/path/to/bypass.png"
    fake_profile = str(uuid4())

    resp = client.post(
        f"{API}/{sub['id']}/decision",
        headers=STAFF_AUTH_HEADERS,
        json={
            "status": "VERIFIED",
            "storage_path": fake_path,
            "profile_id": fake_profile,
            "reviewed_at": "2030-01-01T00:00:00+00:00",
        },
    )

    assert resp.status_code == 200
    update = last_update(fake)
    assert "storage_path" not in update["data"]
    assert "profile_id" not in update["data"]
    assert "reviewed_at" not in update["data"]
    assert fake_path not in resp.text
    assert fake_profile not in resp.text


def test_response_never_discloses_storage_path(client, fake):
    sub = submission_row()
    fake.tables["verification_submissions"] = [sub]

    resp = client.post(
        f"{API}/{sub['id']}/decision",
        headers=STAFF_AUTH_HEADERS,
        json={"status": "VERIFIED"},
    )

    assert resp.status_code == 200
    assert "storage_path" not in resp.text
    assert set(resp.json().keys()) == {
        "id",
        "profile_id",
        "status",
        "submitted_at",
        "reviewed_at",
        "rejection_reason",
    }


# ---------------------------------------------------------------------------
# 14. VERIFIED never persists a rejection reason.
# ---------------------------------------------------------------------------


def test_verified_does_not_persist_rejection_reason(client, fake):
    sub = submission_row()
    fake.tables["verification_submissions"] = [sub]

    resp = client.post(
        f"{API}/{sub['id']}/decision",
        headers=STAFF_AUTH_HEADERS,
        json={"status": "VERIFIED", "rejection_reason": "ignored reason"},
    )

    assert resp.status_code == 200
    assert resp.json()["rejection_reason"] is None
    assert fake.tables["verification_submissions"][0]["rejection_reason"] is None
    update = last_update(fake)
    assert "rejection_reason" not in update["data"]


# ---------------------------------------------------------------------------
# 15. Audit behavior is compatible with the verification_reviews trigger.
# ---------------------------------------------------------------------------


def test_decision_does_not_manually_write_audit_records(client, fake):
    sub = submission_row()
    fake.tables["verification_submissions"] = [sub]

    resp = client.post(
        f"{API}/{sub['id']}/decision",
        headers=STAFF_AUTH_HEADERS,
        json={"status": "REJECTED", "rejection_reason": "Document unreadable"},
    )

    assert resp.status_code == 200
    # The backend never touches the audit table; the existing database trigger
    # records the decision automatically.
    assert fake.tables["verification_reviews"] == []
    assert all(u["table"] != "verification_reviews" for u in fake.state["updates"])
    assert fake.state["updates"][-1]["table"] == "verification_submissions"


# ---------------------------------------------------------------------------
# 16. Raw database errors are never leaked.
# ---------------------------------------------------------------------------


def test_database_lookup_failure_returns_503(client, fake):
    fake = make_fake(fail_tables={"verification_submissions"})
    client = make_client(fake)

    resp = client.post(
        f"{API}/{uuid4()}/decision",
        headers=STAFF_AUTH_HEADERS,
        json={"status": "VERIFIED"},
    )

    assert resp.status_code == 503
    assert resp.json()["error"]["code"] == "database_unavailable"
    assert "database unavailable" not in resp.text.lower()


def test_database_update_failure_returns_503(client, fake):
    sub = submission_row()
    fake.tables["verification_submissions"] = [sub]
    fake.state["fail_update"] = True

    resp = client.post(
        f"{API}/{sub['id']}/decision",
        headers=STAFF_AUTH_HEADERS,
        json={"status": "VERIFIED"},
    )

    assert resp.status_code == 503
    assert resp.json()["error"]["code"] == "database_update_failed"
    assert "could not serialize access" not in resp.text


def test_staff_lookup_failure_returns_503(client, fake):
    fake = make_fake(fail_tables={"staff_admins"})
    client = make_client(fake)

    resp = client.post(
        f"{API}/{uuid4()}/decision",
        headers=STAFF_AUTH_HEADERS,
        json={"status": "VERIFIED"},
    )

    assert resp.status_code == 503
    assert resp.json()["error"]["code"] == "database_unavailable"


# ---------------------------------------------------------------------------
# Extra: decision value constraints and method restrictions.
# ---------------------------------------------------------------------------


def test_pending_is_not_a_valid_decision(client, fake):
    resp = client.post(
        f"{API}/{uuid4()}/decision",
        headers=STAFF_AUTH_HEADERS,
        json={"status": "PENDING"},
    )

    assert resp.status_code == 422
    assert resp.json()["error"]["code"] == "validation_error"
    assert fake.state["updates"] == []


def test_invalid_status_value_is_rejected(client, fake):
    resp = client.post(
        f"{API}/{uuid4()}/decision",
        headers=STAFF_AUTH_HEADERS,
        json={"status": "APPROVED"},
    )

    assert resp.status_code == 422
    assert resp.json()["error"]["code"] == "validation_error"
    assert fake.state["updates"] == []


def test_missing_body_is_rejected(client, fake):
    resp = client.post(f"{API}/{uuid4()}/decision", headers=STAFF_AUTH_HEADERS)

    assert resp.status_code == 422
    assert resp.json()["error"]["code"] == "validation_error"


@pytest.mark.parametrize("method", ["get", "put", "delete", "patch"])
def test_decision_rejects_non_post_methods(client, fake, method):
    resp = getattr(client, method)(
        f"{API}/{uuid4()}/decision", headers=STAFF_AUTH_HEADERS
    )

    assert resp.status_code == 405
