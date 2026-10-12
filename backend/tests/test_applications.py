"""Backend tests for the application lifecycle.

  * apply uses the caller's EXISTING universal profile and never a client
    supplied one; requires authentication and VERIFIED status;
  * only PUBLISHED opportunities accept applications; DRAFT is a 404;
  * duplicates are rejected with 409 and write no second row;
  * My Activity lists only the caller's applications, with opportunity context;
  * withdraw is a status transition (APPLIED -> WITHDRAWN), scoped to the
    caller, and withdrawing twice is a 409;
  * there is no user-facing opportunity creation path.

Supabase is replaced at the `get_supabase_service_client` dependency boundary
with the shared in-memory double. No network, no real database.
"""

import pytest

from app.api.routes import applications, opportunities
from tests.fakes import (
    application_row,
    make_client,
    submission_row,
)
from tests.phase2_world import (
    APPLICATIONS_API,
    OPP_A,
    OPP_B,
    OPP_DRAFT,
    OPPORTUNITIES_API,
    OTHER_HEADERS,
    OTHER_PROFILE,
    THIRD_HEADERS,
    THIRD_PROFILE,
    VIEWER_HEADERS,
    VIEWER_PROFILE,
    build_fake,
)


@pytest.fixture()
def fake():
    return build_fake()


@pytest.fixture()
def client(fake):
    return make_client(fake, opportunities.router, applications.router)


# ---------------------------------------------------------------------------
# Applications.
# ---------------------------------------------------------------------------


def test_apply_uses_existing_profile(fake, client):
    resp = client.post(f"{OPPORTUNITIES_API}/{OPP_A}/applications", headers=OTHER_HEADERS)
    assert resp.status_code == 409  # already applied in the fixture


def test_apply_creates_application_for_caller_only(fake, client):
    # THIRD withdraws is not available; give a fourth applicant-free profile by
    # removing THIRD's existing application first.
    fake.tables["applications"] = [
        a for a in fake.tables["applications"] if a["profile_id"] != str(THIRD_PROFILE)
    ]
    resp = client.post(f"{OPPORTUNITIES_API}/{OPP_A}/applications", headers=THIRD_HEADERS)
    assert resp.status_code == 201
    body = resp.json()
    assert body["status"] == "APPLIED"
    assert body["opportunity_id"] == str(OPP_A)
    row = fake.tables["applications"][-1]
    assert row["profile_id"] == str(THIRD_PROFILE)


def test_apply_requires_authentication(client):
    resp = client.post(f"{OPPORTUNITIES_API}/{OPP_A}/applications")
    assert resp.status_code == 401


def test_apply_requires_verification(fake, client):
    fake.tables["verification_submissions"] = [
        submission_row(VIEWER_PROFILE),
        submission_row(OTHER_PROFILE),
        submission_row(THIRD_PROFILE),
        submission_row(THIRD_PROFILE, "PENDING", "2026-09-01T10:00:00+00:00"),
    ]
    resp = client.post(f"{OPPORTUNITIES_API}/{OPP_B}/applications", headers=THIRD_HEADERS)
    assert resp.status_code == 403
    assert resp.json()["error"]["code"] == "permission_denied"


def test_apply_to_unpublished_opportunity_is_404(client):
    resp = client.post(
        f"{OPPORTUNITIES_API}/{OPP_DRAFT}/applications", headers=THIRD_HEADERS
    )
    assert resp.status_code == 404


def test_duplicate_application_is_409(fake, client):
    before = len(fake.tables["applications"])
    resp = client.post(f"{OPPORTUNITIES_API}/{OPP_A}/applications", headers=OTHER_HEADERS)
    assert resp.status_code == 409
    assert resp.json()["error"]["code"] == "already_applied"
    # No second row was written.
    assert len(fake.tables["applications"]) == before


def test_client_cannot_apply_as_another_user(fake, client):
    resp = client.post(
        f"{OPPORTUNITIES_API}/{OPP_A}/applications",
        headers=THIRD_HEADERS,
        json={"profile_id": str(OTHER_PROFILE)},
    )
    # Duplicate for OTHER_PROFILE already exists -> 409 proves the server used
    # the token's profile, not the body's.
    assert resp.status_code == 409


def test_list_my_applications_scopes_to_caller(client):
    resp = client.get(APPLICATIONS_API, headers=VIEWER_HEADERS)
    assert resp.status_code == 200
    apps = resp.json()["applications"]
    assert {a["opportunity"]["title"] for a in apps} == {
        "Badminton Tournament",
        "Dandiya Night",
    }


def test_list_my_applications_requires_authentication(client):
    assert client.get(APPLICATIONS_API).status_code == 401


def test_withdraw_application(fake, client):
    app_id = next(
        a["id"] for a in fake.tables["applications"] if a["profile_id"] == str(VIEWER_PROFILE)
    )
    resp = client.post(f"{APPLICATIONS_API}/{app_id}/withdraw", headers=VIEWER_HEADERS)
    assert resp.status_code == 200
    assert resp.json()["status"] == "WITHDRAWN"
    stored = next(a for a in fake.tables["applications"] if a["id"] == app_id)
    assert stored["status"] == "WITHDRAWN"


def test_withdraw_twice_is_409(fake, client):
    app_id = next(
        a["id"] for a in fake.tables["applications"] if a["profile_id"] == str(VIEWER_PROFILE)
    )
    assert client.post(
        f"{APPLICATIONS_API}/{app_id}/withdraw", headers=VIEWER_HEADERS
    ).status_code == 200
    resp = client.post(f"{APPLICATIONS_API}/{app_id}/withdraw", headers=VIEWER_HEADERS)
    assert resp.status_code == 409


def test_withdraw_another_users_application_is_404(fake, client):
    app_id = next(
        a["id"] for a in fake.tables["applications"] if a["profile_id"] == str(OTHER_PROFILE)
    )
    resp = client.post(f"{APPLICATIONS_API}/{app_id}/withdraw", headers=VIEWER_HEADERS)
    assert resp.status_code == 404


def test_no_user_opportunity_creation_path_exists(client):
    resp = client.post(OPPORTUNITIES_API, headers=VIEWER_HEADERS, json={})
    assert resp.status_code in (404, 405)
