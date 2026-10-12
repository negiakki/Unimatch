"""Backend tests for the Phase 2 admin surface and its authorization.

Two jobs:

  1. AUTHORIZATION. Every Phase 2 admin endpoint must return 401 when
     unauthenticated, 403 for an authenticated NON-staff user, and allow a
     registered staff member. Authorization is enforced server-side through
     the existing `staff_admins` mechanism resolved from the bearer token —
     never by frontend route protection, and never by trusting a
     client-supplied user_id / reviewer_id / created_by field.

  2. FUNCTIONALITY. Dashboard metrics (real counts only), the admin catalog,
     admin opportunity CRUD + the DRAFT -> PUBLISHED -> PAUSED/CANCELLED/
     EXPIRED state machine, the admin user directory, account-level block /
     suspend / lift, block moderation, and report decisions carrying
     opportunity context.

Supabase is replaced at the `get_supabase_service_client` dependency boundary
with the shared in-memory double. No network, no real database.
"""

from datetime import datetime, timedelta, timezone
from uuid import UUID, uuid4

import pytest

from app.api.routes import (
    admin_catalog,
    admin_opportunities,
    admin_users,
    opportunities,
)
from tests.fakes import (
    FakeSupabase,
    activity_row,
    application_row,
    category_row,
    make_client,
    opportunity_row,
    profile_row,
    submission_row,
)

STAFF_AUTH = UUID("99999999-9999-9999-9999-999999999999")
STUDENT_AUTH = UUID("88888888-8888-8888-8888-888888888888")

STAFF_TOKEN = "staff-token"
STUDENT_TOKEN = "student-token"
STAFF_HEADERS = {"Authorization": f"Bearer {STAFF_TOKEN}"}
STUDENT_HEADERS = {"Authorization": f"Bearer {STUDENT_TOKEN}"}

CATEGORY = UUID("bbbbbbbb-0000-0000-0000-000000000001")
ACTIVITY = UUID("bbbbbbbb-0000-0000-0000-000000000002")
OPP_A = UUID("cccccccc-0000-0000-0000-000000000001")
TARGET_PROFILE = UUID("aaaaaaaa-2222-2222-2222-222222222222")

ADMIN = "/api/v1/admin"


def build_fake(*, staff=(STAFF_AUTH,)):
    fake = FakeSupabase(
        {STAFF_TOKEN: str(STAFF_AUTH), STUDENT_TOKEN: str(STUDENT_AUTH)},
        staff_ids=staff,
    )
    fake.tables["universities"] = [
        {
            "id": "aaaaaaaa-0000-0000-0000-000000000001",
            "name": "State University",
            "city": "College Town",
            "state": "CA",
            "country": "USA",
        }
    ]
    fake.tables["profiles"] = [
        profile_row(
            TARGET_PROFILE,
            STUDENT_AUTH,
            first_name="Rahul",
            gender="man",
            seeking_gender="everyone",
        )
    ]
    fake.tables["verification_submissions"] = [submission_row(TARGET_PROFILE)]
    fake.tables["categories"] = [
        {**category_row(CATEGORY, "Sports", "sports"), "activities": []}
    ]
    fake.tables["activities"] = [activity_row(ACTIVITY, CATEGORY, "Badminton", "badminton")]
    fake.tables["opportunities"] = [
        opportunity_row(OPP_A, CATEGORY, ACTIVITY, status="DRAFT")
    ]
    return fake


@pytest.fixture()
def fake():
    return build_fake()


@pytest.fixture()
def client(fake):
    return make_client(
            fake,
            opportunities.router,
            admin_users.router,
            admin_catalog.router,
            admin_opportunities.router,
        )


# ---------------------------------------------------------------------------
# 1. Authorization matrix — every Phase 2 admin endpoint.
# ---------------------------------------------------------------------------

# (method, path, body) for each admin endpoint added in Phase 2.
ADMIN_ENDPOINTS = [
    ("get", f"{ADMIN}/dashboard", None),
    ("get", f"{ADMIN}/users", None),
    ("get", f"{ADMIN}/users/{TARGET_PROFILE}", None),
    ("post", f"{ADMIN}/users/{TARGET_PROFILE}/block", {"reason": "abuse"}),
    ("delete", f"{ADMIN}/users/{TARGET_PROFILE}/block", None),
    ("post", f"{ADMIN}/users/{TARGET_PROFILE}/suspend", {"reason": "abuse"}),
    ("delete", f"{ADMIN}/users/{TARGET_PROFILE}/suspension", None),
    ("get", f"{ADMIN}/suspensions", None),
    ("get", f"{ADMIN}/blocks", None),
    ("delete", f"{ADMIN}/blocks/{uuid4()}", None),
    ("get", f"{ADMIN}/categories", None),
    ("post", f"{ADMIN}/categories", {"name": "New", "slug": "new"}),
    ("put", f"{ADMIN}/categories/{CATEGORY}", {"name": "New", "slug": "new"}),
    ("delete", f"{ADMIN}/categories/{CATEGORY}", None),
    ("get", f"{ADMIN}/activities", None),
    ("post", f"{ADMIN}/activities", {"category_id": str(CATEGORY), "name": "A", "slug": "a"}),
    ("put", f"{ADMIN}/activities/{ACTIVITY}", {"category_id": str(CATEGORY), "name": "A", "slug": "a"}),
    ("delete", f"{ADMIN}/activities/{ACTIVITY}", None),
    ("get", f"{ADMIN}/opportunities", None),
    (
        "post",
        f"{ADMIN}/opportunities",
        {"title": "T", "category_id": str(CATEGORY)},
    ),
    ("get", f"{ADMIN}/opportunities/{OPP_A}", None),
    (
        "put",
        f"{ADMIN}/opportunities/{OPP_A}",
        {"title": "T", "category_id": str(CATEGORY)},
    ),
    ("delete", f"{ADMIN}/opportunities/{OPP_A}", None),
    ("post", f"{ADMIN}/opportunities/{OPP_A}/publish", None),
    ("post", f"{ADMIN}/opportunities/{OPP_A}/pause", None),
    ("post", f"{ADMIN}/opportunities/{OPP_A}/cancel", None),
    ("post", f"{ADMIN}/opportunities/{OPP_A}/expire", None),
    ("get", f"{ADMIN}/opportunities/{OPP_A}/applications", None),
    ("post", f"{ADMIN}/reports/{uuid4()}/decision", {"status": "REVIEWED"}),
]


@pytest.mark.parametrize("method,path,body", ADMIN_ENDPOINTS)
def test_admin_endpoint_requires_authentication(client, method, path, body):
    resp = client.request(method, path, json=body)
    assert resp.status_code == 401, f"{method.upper()} {path}"
    assert resp.json()["error"]["code"] == "unauthorized"


@pytest.mark.parametrize("method,path,body", ADMIN_ENDPOINTS)
def test_admin_endpoint_forbids_non_staff(client, method, path, body):
    resp = client.request(method, path, headers=STUDENT_HEADERS, json=body)
    assert resp.status_code == 403, f"{method.upper()} {path}"
    assert resp.json()["error"]["code"] == "permission_denied"


@pytest.mark.parametrize("method,path,body", ADMIN_ENDPOINTS)
def test_admin_endpoint_allows_staff(method, path, body):
    fake = build_fake()
    client = make_client(
            fake,
            opportunities.router,
            admin_users.router,
            admin_catalog.router,
            admin_opportunities.router,
        )
    resp = client.request(method, path, headers=STAFF_HEADERS, json=body)
    assert resp.status_code not in (401, 403), f"{method.upper()} {path} -> {resp.status_code}"
    assert resp.status_code < 500, f"{method.upper()} {path} -> {resp.text}"


def test_removed_staff_loses_all_admin_access():
    fake = build_fake(staff=())
    client = make_client(
            fake,
            opportunities.router,
            admin_users.router,
            admin_catalog.router,
            admin_opportunities.router,
        )
    for path in (f"{ADMIN}/dashboard", f"{ADMIN}/users", f"{ADMIN}/opportunities"):
        resp = client.get(path, headers=STAFF_HEADERS)
        assert resp.status_code == 403, path


def test_client_supplied_identifiers_cannot_grant_admin_access(client):
    """A student cannot become staff by naming a staff id in the body/params."""
    resp = client.post(
        f"{ADMIN}/users/{TARGET_PROFILE}/suspend",
        headers=STUDENT_HEADERS,
        json={"reason": "abuse", "created_by": str(STAFF_AUTH), "auth_user_id": str(STAFF_AUTH)},
    )
    assert resp.status_code == 403
    assert client.get(f"{ADMIN}/users", headers=STUDENT_HEADERS).status_code == 403


def test_admin_actor_is_derived_from_token(fake, client):
    resp = client.post(
        f"{ADMIN}/users/{TARGET_PROFILE}/suspend",
        headers=STAFF_HEADERS,
        json={"reason": "abuse", "created_by": str(STUDENT_AUTH)},
    )
    assert resp.status_code == 201
    row = fake.tables["suspensions"][-1]
    assert row["created_by"] == str(STAFF_AUTH)


# ---------------------------------------------------------------------------
# 2. Dashboard metrics (real counts only).
# ---------------------------------------------------------------------------


def test_dashboard_returns_real_counts(fake, client):
    fake.tables["applications"] = [application_row(uuid4(), OPP_A, TARGET_PROFILE)]
    fake.tables["matches"] = [
        {
            "id": str(uuid4()),
            "user_a_id": "00000000-0000-0000-0000-000000000001",
            "user_b_id": "00000000-0000-0000-0000-000000000002",
            "opportunity_id": str(OPP_A),
            "created_at": "2026-10-01T00:00:00+00:00",
            "unmatched_at": None,
        }
    ]
    fake.tables["reports"] = [
        {
            "id": str(uuid4()),
            "reporter_profile_id": str(TARGET_PROFILE),
            "reported_profile_id": str(TARGET_PROFILE),
            "reason": "spam",
            "detail": None,
            "content_type": None,
            "content_id": None,
            "status": "OPEN",
            "created_at": "2026-10-01T00:00:00+00:00",
        }
    ]
    resp = client.get(f"{ADMIN}/dashboard", headers=STAFF_HEADERS)
    assert resp.status_code == 200
    body = resp.json()
    assert body["users"]["total"] == 1
    assert body["users"]["verified"] == 1
    assert body["verification"]["pending"] == 0
    assert body["opportunities"]["total"] == 1
    assert body["matches"]["active"] == 1
    assert body["reports"]["total"] == 1
    assert body["reports"]["open"] == 1
    assert body["applications"]["total"] == 1
    assert body["suspensions"]["active"] == 0


def test_dashboard_does_not_invent_group_metrics(client):
    resp = client.get(f"{ADMIN}/dashboard", headers=STAFF_HEADERS)
    assert resp.status_code == 200
    body = resp.json()
    # Group functionality is explicitly out of scope for this phase.
    assert "groups" not in body
    assert "pending_group_requests" not in body


def test_dashboard_database_failure_is_503(fake, client):
    fake.state["fail_tables"] = {"profiles"}
    resp = client.get(f"{ADMIN}/dashboard", headers=STAFF_HEADERS)
    assert resp.status_code == 503
    assert resp.json()["error"]["code"] == "database_unavailable"


# ---------------------------------------------------------------------------
# 3. Admin catalog.
# ---------------------------------------------------------------------------


def test_admin_categories_include_inactive(fake, client):
    fake.tables["categories"].append(
        {**category_row(uuid4(), "Old", "old", is_active=False), "activities": []}
    )
    resp = client.get(f"{ADMIN}/categories", headers=STAFF_HEADERS)
    assert resp.status_code == 200
    slugs = {c["slug"] for c in resp.json()}
    assert slugs == {"sports", "old"}


def test_admin_create_category(fake, client):
    resp = client.post(
        f"{ADMIN}/categories",
        headers=STAFF_HEADERS,
        json={"name": "Travel", "slug": "travel", "icon": "travel", "sort_order": 50},
    )
    assert resp.status_code == 201
    assert resp.json()["slug"] == "travel"
    assert any(c["slug"] == "travel" for c in fake.tables["categories"])


def test_admin_duplicate_category_is_409(client):
    resp = client.post(
        f"{ADMIN}/categories",
        headers=STAFF_HEADERS,
        json={"name": "sports", "slug": "sports-2"},
    )
    assert resp.status_code == 409


def test_admin_update_category(fake, client):
    resp = client.put(
        f"{ADMIN}/categories/{CATEGORY}",
        headers=STAFF_HEADERS,
        json={"name": "Athletics", "slug": "athletics", "sort_order": 5, "is_active": False},
    )
    assert resp.status_code == 200
    stored = next(c for c in fake.tables["categories"] if c["id"] == str(CATEGORY))
    assert stored["name"] == "Athletics"
    assert stored["is_active"] is False


def test_admin_delete_unknown_category_is_404(client):
    resp = client.delete(f"{ADMIN}/categories/{uuid4()}", headers=STAFF_HEADERS)
    assert resp.status_code == 404


def test_admin_move_activity_between_categories(fake, client):
    other = {**category_row(uuid4(), "Social", "social"), "activities": []}
    fake.tables["categories"].append(other)
    resp = client.put(
        f"{ADMIN}/activities/{ACTIVITY}",
        headers=STAFF_HEADERS,
        json={"category_id": other["id"], "name": "Badminton", "slug": "badminton"},
    )
    assert resp.status_code == 200
    stored = next(a for a in fake.tables["activities"] if a["id"] == str(ACTIVITY))
    assert stored["category_id"] == other["id"]


def test_admin_create_activity(fake, client):
    resp = client.post(
        f"{ADMIN}/activities",
        headers=STAFF_HEADERS,
        json={"category_id": str(CATEGORY), "name": "Tennis", "slug": "tennis", "sort_order": 30},
    )
    assert resp.status_code == 201
    assert any(a["slug"] == "tennis" for a in fake.tables["activities"])


# ---------------------------------------------------------------------------
# 4. Admin opportunity CRUD + state machine.
# ---------------------------------------------------------------------------


def test_admin_create_opportunity_is_born_draft(fake, client):
    resp = client.post(
        f"{ADMIN}/opportunities",
        headers=STAFF_HEADERS,
        json={
            "title": "Badminton Tournament",
            "category_id": str(CATEGORY),
            "activity_id": str(ACTIVITY),
            "description": "Doubles",
            "location": "Sports Complex",
            "capacity": 16,
        },
    )
    assert resp.status_code == 201
    body = resp.json()
    assert body["status"] == "DRAFT"
    assert body["created_by"] == str(STAFF_AUTH)
    stored = fake.tables["opportunities"][-1]
    assert stored["status"] == "DRAFT"
    assert stored["created_by"] == str(STAFF_AUTH)


def test_admin_create_opportunity_cannot_force_status(fake, client):
    resp = client.post(
        f"{ADMIN}/opportunities",
        headers=STAFF_HEADERS,
        json={"title": "Sneaky", "category_id": str(CATEGORY), "status": "PUBLISHED"},
    )
    # The extra field is ignored; the opportunity is still born DRAFT.
    assert resp.status_code == 201
    assert resp.json()["status"] == "DRAFT"


def test_admin_create_opportunity_rejects_blank_title(client):
    resp = client.post(
        f"{ADMIN}/opportunities",
        headers=STAFF_HEADERS,
        json={"title": "   ", "category_id": str(CATEGORY)},
    )
    assert resp.status_code == 422


def test_admin_publish_then_public_sees_it(fake, client):
    assert client.get(f"/api/v1/opportunities/{OPP_A}").status_code == 404
    resp = client.post(f"{ADMIN}/opportunities/{OPP_A}/publish", headers=STAFF_HEADERS)
    assert resp.status_code == 200
    assert resp.json()["status"] == "PUBLISHED"
    assert client.get(f"/api/v1/opportunities/{OPP_A}").status_code == 200


def test_admin_edit_only_draft(fake, client):
    assert client.post(
        f"{ADMIN}/opportunities/{OPP_A}/publish", headers=STAFF_HEADERS
    ).status_code == 200
    resp = client.put(
        f"{ADMIN}/opportunities/{OPP_A}",
        headers=STAFF_HEADERS,
        json={"title": "Renamed", "category_id": str(CATEGORY)},
    )
    assert resp.status_code == 409
    assert resp.json()["error"]["code"] == "invalid_state_transition"


def test_admin_edit_draft(fake, client):
    resp = client.put(
        f"{ADMIN}/opportunities/{OPP_A}",
        headers=STAFF_HEADERS,
        json={"title": "Renamed", "category_id": str(CATEGORY)},
    )
    assert resp.status_code == 200
    assert fake.tables["opportunities"][0]["title"] == "Renamed"


def test_admin_pause_cancel_expire_transitions(fake, client):
    # PUBLISHED -> PAUSED -> PUBLISHED -> CANCELLED
    assert client.post(
        f"{ADMIN}/opportunities/{OPP_A}/publish", headers=STAFF_HEADERS
    ).status_code == 200
    for action, expected in (
        ("pause", "PAUSED"),
        ("publish", "PUBLISHED"),
        ("cancel", "CANCELLED"),
    ):
        resp = client.post(f"{ADMIN}/opportunities/{OPP_A}/{action}", headers=STAFF_HEADERS)
        assert resp.status_code == 200, action
        assert resp.json()["status"] == expected


def test_admin_expire_transition(fake, client):
    client.post(f"{ADMIN}/opportunities/{OPP_A}/publish", headers=STAFF_HEADERS)
    resp = client.post(f"{ADMIN}/opportunities/{OPP_A}/expire", headers=STAFF_HEADERS)
    assert resp.status_code == 200
    assert resp.json()["status"] == "EXPIRED"
    # No longer public.
    assert client.get(f"/api/v1/opportunities/{OPP_A}").status_code == 404


def test_admin_cannot_pause_a_draft(fake, client):
    resp = client.post(f"{ADMIN}/opportunities/{OPP_A}/pause", headers=STAFF_HEADERS)
    assert resp.status_code == 409


def test_admin_cancelled_cannot_be_republished(fake, client):
    client.post(f"{ADMIN}/opportunities/{OPP_A}/publish", headers=STAFF_HEADERS)
    client.post(f"{ADMIN}/opportunities/{OPP_A}/cancel", headers=STAFF_HEADERS)
    resp = client.post(f"{ADMIN}/opportunities/{OPP_A}/publish", headers=STAFF_HEADERS)
    assert resp.status_code == 409


def test_admin_transition_on_unknown_opportunity_is_404(client):
    resp = client.post(f"{ADMIN}/opportunities/{uuid4()}/publish", headers=STAFF_HEADERS)
    assert resp.status_code == 404


def test_admin_list_shows_non_public_states(client):
    resp = client.get(f"{ADMIN}/opportunities", headers=STAFF_HEADERS)
    assert resp.status_code == 200
    assert [o["status"] for o in resp.json()] == ["DRAFT"]


def test_admin_list_status_filter_rejects_unknown_state(client):
    resp = client.get(f"{ADMIN}/opportunities", headers=STAFF_HEADERS, params={"status": "NOPE"})
    assert resp.status_code == 400


def test_admin_delete_opportunity(fake, client):
    resp = client.delete(f"{ADMIN}/opportunities/{OPP_A}", headers=STAFF_HEADERS)
    assert resp.status_code == 200
    assert fake.tables["opportunities"] == []


def test_admin_list_opportunity_applications(fake, client):
    fake.tables["applications"] = [application_row(uuid4(), OPP_A, TARGET_PROFILE)]
    resp = client.get(f"{ADMIN}/opportunities/{OPP_A}/applications", headers=STAFF_HEADERS)
    assert resp.status_code == 200
    rows = resp.json()
    assert rows[0]["profile_id"] == str(TARGET_PROFILE)
    assert rows[0]["status"] == "APPLIED"


# ---------------------------------------------------------------------------
# 5. Admin user directory + security.
# ---------------------------------------------------------------------------


def test_admin_user_search(client):
    resp = client.get(f"{ADMIN}/users", headers=STAFF_HEADERS, params={"q": "rah"})
    assert resp.status_code == 200
    assert [u["profile_id"] for u in resp.json()] == [str(TARGET_PROFILE)]


def test_admin_user_detail_exposes_account_status(client):
    resp = client.get(f"{ADMIN}/users/{TARGET_PROFILE}", headers=STAFF_HEADERS)
    assert resp.status_code == 200
    body = resp.json()
    assert body["verification"]["status"] == "VERIFIED"
    assert body["account"]["suspended"] is False


def test_admin_user_payload_never_exposes_private_fields(client):
    resp = client.get(f"{ADMIN}/users/{TARGET_PROFILE}", headers=STAFF_HEADERS)
    assert resp.status_code == 200
    text = resp.text
    for forbidden in ("auth_user_id", "date_of_birth", "storage_path", "email"):
        assert forbidden not in text


def test_admin_unknown_user_is_404(client):
    assert client.get(f"{ADMIN}/users/{uuid4()}", headers=STAFF_HEADERS).status_code == 404


def test_admin_block_is_indefinite(fake, client):
    resp = client.post(
        f"{ADMIN}/users/{TARGET_PROFILE}/block",
        headers=STAFF_HEADERS,
        json={"reason": "repeated harassment"},
    )
    assert resp.status_code == 201
    row = fake.tables["suspensions"][-1]
    assert row["suspended_until"] is None
    assert row["reason"] == "repeated harassment"

    detail = client.get(f"{ADMIN}/users/{TARGET_PROFILE}", headers=STAFF_HEADERS).json()
    assert detail["account"]["suspended"] is True


def test_admin_unblock_lifts_the_suspension(fake, client):
    client.post(
        f"{ADMIN}/users/{TARGET_PROFILE}/block",
        headers=STAFF_HEADERS,
        json={"reason": "harassment"},
    )
    resp = client.delete(f"{ADMIN}/users/{TARGET_PROFILE}/block", headers=STAFF_HEADERS)
    assert resp.status_code == 200
    assert resp.json()["suspended"] is False
    assert fake.tables["suspensions"] == []


def test_admin_timed_suspend(fake, client):
    until = (datetime.now(timezone.utc) + timedelta(days=7)).isoformat()
    resp = client.post(
        f"{ADMIN}/users/{TARGET_PROFILE}/suspend",
        headers=STAFF_HEADERS,
        json={"reason": "spam", "suspended_until": until},
    )
    assert resp.status_code == 201
    assert fake.tables["suspensions"][-1]["suspended_until"] is not None


def test_admin_past_suspension_is_409(client):
    past = (datetime.now(timezone.utc) - timedelta(days=1)).isoformat()
    resp = client.post(
        f"{ADMIN}/users/{TARGET_PROFILE}/suspend",
        headers=STAFF_HEADERS,
        json={"reason": "spam", "suspended_until": past},
    )
    assert resp.status_code == 409


def test_admin_expired_suspension_is_not_active(fake, client):
    # A lapsed row must not report the account as suspended.
    fake.tables["suspensions"] = [
        {
            "id": str(uuid4()),
            "profile_id": str(TARGET_PROFILE),
            "reason": "old",
            "suspended_until": "2020-01-01T00:00:00+00:00",
            "created_by": str(STAFF_AUTH),
            "created_at": "2019-12-01T00:00:00+00:00",
        }
    ]
    detail = client.get(f"{ADMIN}/users/{TARGET_PROFILE}", headers=STAFF_HEADERS).json()
    assert detail["account"]["suspended"] is False


def test_admin_suspensions_list_only_active(fake, client):
    fake.tables["suspensions"] = [
        {
            "id": str(uuid4()),
            "profile_id": str(TARGET_PROFILE),
            "reason": "old",
            "suspended_until": "2020-01-01T00:00:00+00:00",
            "created_by": str(STAFF_AUTH),
            "created_at": "2019-12-01T00:00:00+00:00",
        }
    ]
    resp = client.get(f"{ADMIN}/suspensions", headers=STAFF_HEADERS)
    assert resp.status_code == 200
    assert resp.json() == []


def test_admin_block_moderation(fake, client):
    block_id = str(uuid4())
    fake.tables["blocks"] = [
        {
            "id": block_id,
            "blocker_profile_id": str(TARGET_PROFILE),
            "blocked_profile_id": "00000000-0000-0000-0000-000000000009",
            "created_at": "2026-10-01T00:00:00+00:00",
        }
    ]
    resp = client.get(f"{ADMIN}/blocks", headers=STAFF_HEADERS)
    assert resp.status_code == 200
    assert resp.json()[0]["blocker"]["profile_id"] == str(TARGET_PROFILE)

    removed = client.delete(f"{ADMIN}/blocks/{block_id}", headers=STAFF_HEADERS)
    assert removed.status_code == 200
    assert fake.tables["blocks"] == []


# ---------------------------------------------------------------------------
# 6. Report decisions + opportunity context.
# ---------------------------------------------------------------------------


def _report(content_type=None, content_id=None, status="OPEN"):
    return {
        "id": str(uuid4()),
        "reporter_profile_id": str(TARGET_PROFILE),
        "reported_profile_id": str(TARGET_PROFILE),
        "reason": "harassment",
        "detail": "spam messages",
        "content_type": content_type,
        "content_id": content_id,
        "status": status,
        "created_at": "2026-10-01T00:00:00+00:00",
    }


def test_admin_report_decision_updates_status(fake, client):
    report = _report()
    fake.tables["reports"] = [report]
    resp = client.post(
        f"{ADMIN}/reports/{report['id']}/decision",
        headers=STAFF_HEADERS,
        json={"status": "DISMISSED"},
    )
    assert resp.status_code == 200
    assert resp.json()["status"] == "DISMISSED"
    assert fake.tables["reports"][0]["status"] == "DISMISSED"


def test_admin_report_decision_rejects_unknown_status(fake, client):
    report = _report()
    fake.tables["reports"] = [report]
    resp = client.post(
        f"{ADMIN}/reports/{report['id']}/decision",
        headers=STAFF_HEADERS,
        json={"status": "RESOLVED"},
    )
    assert resp.status_code == 422


def test_admin_report_decision_on_unknown_report_is_404(client):
    resp = client.post(
        f"{ADMIN}/reports/{uuid4()}/decision",
        headers=STAFF_HEADERS,
        json={"status": "REVIEWED"},
    )
    assert resp.status_code == 404


def test_admin_reports_resolve_opportunity_context(fake, client):
    published = opportunity_row(OPP_A, CATEGORY, ACTIVITY, status="PUBLISHED")
    fake.tables["opportunities"] = [published]
    fake.tables["reports"] = [_report(content_type="opportunity", content_id=str(OPP_A))]

    resp = client.get(f"{ADMIN}/reports", headers=STAFF_HEADERS)
    assert resp.status_code == 200
    row = resp.json()[0]
    assert row["opportunity"]["id"] == str(OPP_A)
    assert row["opportunity"]["title"] == "Badminton Tournament"
    assert row["opportunity"]["category"]["slug"] == "sports"


def test_admin_reports_without_opportunity_context_omit_the_key(fake, client):
    fake.tables["reports"] = [_report(content_type="message")]
    resp = client.get(f"{ADMIN}/reports", headers=STAFF_HEADERS)
    assert resp.status_code == 200
    assert "opportunity" not in resp.json()[0]
