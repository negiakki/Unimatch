"""Backend tests for SERVER-SIDE enforcement of account suspensions.

Phase 2 records suspensions (indefinite block = `suspended_until IS NULL`,
timed suspend = an expiry timestamp) and surfaces them in the admin console.
These tests prove the recorded suspension is actually ENFORCED, so a
suspended account cannot interact with the platform.

Coverage required here:

  1. an ACTIVE account can perform the normal interactive actions;
  2. a SUSPENDED (timed, future expiry) account is blocked;
  3. an INDEFINITELY suspended account is blocked;
  4. an EXPIRED suspension no longer blocks — access returns automatically;
  5. the block cannot be bypassed through another endpoint or method;
  6. the existing admin suspension authorization still works end-to-end:
     staff can suspend, and the target is blocked the moment the row lands;
  7. being staff is NOT a bypass — authorization and suspension are
     independent, so a suspended moderator is gated on admin routes too.

The enforcement point is the shared `CurrentAuthUserDep` in `app.api.deps`,
which every authenticated route already depends on — so there is no
per-route check to omit and no second moderation system. Supabase is
replaced at the `get_supabase_service_client` dependency boundary with the
shared in-memory double. No network, no real database.

Sends are covered for real in test_messaging.py, whose double implements the
send_conversation_message RPC and can therefore prove a rejected message is
not persisted; here a send is asserted only on the blocked path.
"""

from datetime import datetime, timedelta, timezone
from uuid import UUID, uuid4

import pytest

from app.api.deps import _SUSPENDED_READ_DENYLIST as SUSPENDED_READ_DENYLIST
from app.core.config import get_settings

from app.api.routes import (
    admin_catalog,
    admin_opportunities,
    admin_users,
    applications,
    catalog,
    opportunities,
    opportunity_discovery,
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

USER_AUTH = UUID("11111111-1111-1111-1111-111111111111")
OTHER_AUTH = UUID("22222222-2222-2222-2222-222222222222")
STAFF_AUTH = UUID("99999999-9999-9999-9999-999999999999")

USER_PROFILE = UUID("aaaaaaaa-1111-1111-1111-111111111111")
OTHER_PROFILE = UUID("aaaaaaaa-2222-2222-2222-222222222222")
STAFF_PROFILE = UUID("aaaaaaaa-9999-9999-9999-999999999999")

USER_TOKEN = "user-token"
OTHER_TOKEN = "other-token"
STAFF_TOKEN = "staff-token"

HEADERS = {"Authorization": f"Bearer {USER_TOKEN}"}
OTHER_HEADERS = {"Authorization": f"Bearer {OTHER_TOKEN}"}
STAFF_HEADERS = {"Authorization": f"Bearer {STAFF_TOKEN}"}

CATEGORY = UUID("bbbbbbbb-0000-0000-0000-000000000001")
ACTIVITY = UUID("bbbbbbbb-0000-0000-0000-000000000002")
OPP = UUID("cccccccc-0000-0000-0000-000000000001")

MATCH_ID = uuid4()
APPLICATION_ID = uuid4()

API_PREFIX = get_settings().api_v1_prefix

ADMIN = "/api/v1/admin"
OPPORTUNITIES = "/api/v1/opportunities"
DISCOVERY = "/api/v1/discovery"
CONVERSATIONS = "/api/v1/conversations"
MATCHES = "/api/v1/matches"


def build_fake(*, staff=(STAFF_AUTH,)):
    """A verified user with a partner, a published opportunity, a match and
    an application — i.e. every interactive surface has something real to act
    on, so a blocked call proves the gate fired and not the fixture."""
    fake = FakeSupabase(
        {
            USER_TOKEN: str(USER_AUTH),
            OTHER_TOKEN: str(OTHER_AUTH),
            STAFF_TOKEN: str(STAFF_AUTH),
        },
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
            USER_PROFILE,
            USER_AUTH,
            first_name="Akshat",
            gender="man",
            seeking_gender="everyone",
        ),
        profile_row(
            OTHER_PROFILE,
            OTHER_AUTH,
            first_name="Rahul",
            gender="man",
            seeking_gender="everyone",
        ),
    ]
    fake.tables["verification_submissions"] = [
        submission_row(USER_PROFILE),
        submission_row(OTHER_PROFILE),
    ]
    fake.tables["categories"] = [
        {**category_row(CATEGORY, "Sports", "sports"), "activities": []}
    ]
    fake.tables["activities"] = [
        activity_row(ACTIVITY, CATEGORY, "Badminton", "badminton")
    ]
    fake.tables["opportunities"] = [
        opportunity_row(OPP, CATEGORY, ACTIVITY, status="PUBLISHED")
    ]
    # The user already applied to OPP so `withdraw` has a real target, and a
    # match exists so messaging / unmatch do too.
    fake.tables["applications"] = [
        application_row(APPLICATION_ID, OPP, USER_PROFILE)
    ]
    fake.tables["matches"] = [
        {
            "id": str(MATCH_ID),
            "user_a_id": str(USER_PROFILE),
            "user_b_id": str(OTHER_PROFILE),
            "opportunity_id": None,
            "created_at": "2026-10-01T09:00:00+00:00",
            "unmatched_at": None,
        }
    ]
    return fake


@pytest.fixture()
def fake():
    return build_fake()


@pytest.fixture()
def client(fake):
    return make_client(
        fake, catalog.router, opportunities.router, applications.router,
        opportunity_discovery.router, admin_users.router,
        admin_catalog.router, admin_opportunities.router
    )


def suspend(fake, profile_id, *, until=None):
    """Insert an active suspension row directly (indefinite when until=None)."""
    fake.tables["suspensions"].append(
        {
            "id": str(uuid4()),
            "profile_id": str(profile_id),
            "reason": "abuse",
            "suspended_until": until,
            "created_by": str(STAFF_AUTH),
            "created_at": "2026-10-01T00:00:00+00:00",
        }
    )


def assert_suspended(resp):
    """Every gated call fails identically, with a stable client-facing code."""
    assert resp.status_code == 403, resp.text
    body = resp.json()
    assert body["error"]["code"] == "account_suspended", body
    assert "suspended" in body["error"]["message"].lower()


# ---------------------------------------------------------------------------
# Interactive actions, grouped by the surfaces a suspension must gate.
# ---------------------------------------------------------------------------


def _apply():
    return ("post", f"{OPPORTUNITIES}/{OPP}/applications", None)


def _withdraw():
    return ("post", f"/api/v1/applications/{APPLICATION_ID}/withdraw", None)


def _interest():
    return (
        "post",
        f"{OPPORTUNITIES}/{OPP}/discovery/{OTHER_PROFILE}/interest",
        None,
    )


def _opportunity_pass():
    return (
        "post",
        f"{OPPORTUNITIES}/{OPP}/discovery/{OTHER_PROFILE}/pass",
        None,
    )


def _like():
    return ("post", f"{DISCOVERY}/{OTHER_PROFILE}/like", None)


def _pass():
    return ("post", f"{DISCOVERY}/{OTHER_PROFILE}/pass", None)


def _send_message():
    return (
        "post",
        f"{CONVERSATIONS}/{MATCH_ID}/messages",
        {"body": "hello there"},
    )


SEND_MESSAGE = _send_message()


def _mark_read():
    return ("post", f"{CONVERSATIONS}/{MATCH_ID}/read", None)


def _unmatch():
    return ("delete", f"{MATCHES}/{MATCH_ID}", None)


def _block():
    return ("post", "/api/v1/blocks", {"target_profile_id": str(OTHER_PROFILE)})


def _report():
    return (
        "post",
        "/api/v1/reports",
        {"reported_profile_id": str(OTHER_PROFILE), "reason": "spam"},
    )


def _update_profile():
    return (
        "put",
        "/api/v1/profiles/me",
        {
            "first_name": "Akshat",
            "date_of_birth": "2001-05-10",
            "university_id": "aaaaaaaa-0000-0000-0000-000000000001",
            "course": "Computer Science",
            "academic_year": 3,
            "gender": "man",
            "seeking_gender": "everyone",
            "bio": "Still here.",
            "motivations": ["dating"],
        },
    )


# Writes across every interactive surface. Requirement: opportunity discovery,
# applying, withdrawing, likes/passes/interests, match creation (mutual like)
# and messaging/conversation actions — plus the remaining interactive writes.
INTERACTIVE_REQUESTS = [
    _apply(),
    _withdraw(),
    _interest(),
    _opportunity_pass(),
    _like(),
    _pass(),
    SEND_MESSAGE,
    _mark_read(),
    _unmatch(),
    _block(),
    _report(),
    _update_profile(),
]

# The subset the shared double can actually execute end-to-end. Sending a
# message goes through a Postgres RPC the shared double does not implement, so
# it is asserted only on the blocked path (where the gate rejects before the
# handler runs); test_messaging.py covers successful sends with its own double.
EXECUTABLE_REQUESTS = [r for r in INTERACTIVE_REQUESTS if r is not SEND_MESSAGE]

# Reads that are interaction entry points rather than plain reads.
DISCOVERY_READS = [
    f"{DISCOVERY}/feed",
    f"{OPPORTUNITIES}/{OPP}/discovery",
]


# ---------------------------------------------------------------------------
# 1. An active account can perform the normal interactive actions.
# ---------------------------------------------------------------------------


@pytest.mark.parametrize("method,path,body", EXECUTABLE_REQUESTS)
def test_active_user_can_interact(client, method, path, body):
    resp = client.request(method, path, headers=HEADERS, json=body)
    assert resp.status_code not in (401, 403), f"{method} {path} -> {resp.text}"
    assert resp.status_code < 500, f"{method} {path} -> {resp.text}"


@pytest.mark.parametrize("path", DISCOVERY_READS)
def test_active_user_can_read_discovery(client, path):
    resp = client.get(path, headers=HEADERS)
    assert resp.status_code == 200, resp.text


# ---------------------------------------------------------------------------
# 2. A timed (future expiry) suspension blocks every interactive action.
# ---------------------------------------------------------------------------


def _fake_of(client):
    """Recover the shared double behind the client so a test can seed rows."""
    return next(
        override()
        for override in client.app.dependency_overrides.values()
        if callable(override)
    )


def _assert_all_blocked(client):
    for method, path, body in INTERACTIVE_REQUESTS:
        assert_suspended(client.request(method, path, headers=HEADERS, json=body))
    for path in DISCOVERY_READS:
        assert_suspended(client.get(path, headers=HEADERS))


# ---------------------------------------------------------------------------
# 2. A timed (future expiry) suspension blocks every interactive action.
# ---------------------------------------------------------------------------


def test_timed_suspension_blocks_interactive_actions(client):
    until = (datetime.now(timezone.utc) + timedelta(days=7)).isoformat()
    suspend(_fake_of(client), USER_PROFILE, until=until)
    _assert_all_blocked(client)


# ---------------------------------------------------------------------------
# 3. An indefinite suspension (suspended_until IS NULL) blocks as well.
# ---------------------------------------------------------------------------


def test_indefinite_suspension_blocks_interactive_actions(client):
    suspend(_fake_of(client), USER_PROFILE)
    _assert_all_blocked(client)


# ---------------------------------------------------------------------------
# 4. An expired suspension no longer blocks: interaction resumes on its own.
# ---------------------------------------------------------------------------


def test_expired_suspension_allows_interaction_again(client):
    expired = (datetime.now(timezone.utc) - timedelta(minutes=1)).isoformat()
    suspend(_fake_of(client), USER_PROFILE, until=expired)

    # Reads first: the write loop below blocks the partner, which would make
    # the discovery feeds 403 for an unrelated, legitimate reason.
    for path in DISCOVERY_READS:
        assert client.get(path, headers=HEADERS).status_code == 200
    for method, path, body in EXECUTABLE_REQUESTS:
        resp = client.request(method, path, headers=HEADERS, json=body)
        assert resp.status_code not in (401, 403), f"{method} {path} -> {resp.text}"


# ---------------------------------------------------------------------------
# 5. The block cannot be bypassed through another endpoint, method or identity.
# ---------------------------------------------------------------------------


def test_no_interactive_endpoint_bypasses_the_gate(client):
    """Sweep EVERY mounted operation from the OpenAPI surface — admin routes
    included, since staff status is not a suspension bypass — and prove a
    suspended caller cannot perform a state change on any of them. This is what
    makes the gate unbypassable: it lives in the shared auth dependency, so a
    newly added endpoint is covered without anyone having to remember to
    annotate it."""
    fake = _fake_of(client)
    suspend(fake, USER_PROFILE)

    paths = client.app.openapi()["paths"]
    assert paths, "no API operations discovered — the sweep proves nothing"

    writes = 0
    for templated, operations in paths.items():
        path = _concrete(templated)
        for method in operations:
            if method in {"head", "options"}:
                continue
            resp = client.request(method.upper(), path, headers=HEADERS)
            if method == "get":
                # Reads stay available (own account, public catalog) except the
                # discovery feeds, which are interaction entry points. Both
                # outcomes are correct; anything else is not.
                # The denylist holds router-relative templates; OpenAPI paths
                # carry the API prefix, so strip it before comparing.
                relative = templated.removeprefix(API_PREFIX)
                if relative in SUSPENDED_READ_DENYLIST:
                    assert_suspended(resp)
                else:
                    assert resp.status_code != 403 or resp.json()["error"][
                        "code"
                    ] != "account_suspended", f"GET {templated} -> {resp.text}"
                continue
            writes += 1
            assert_suspended(resp)

    # Guard against the sweep silently degenerating into GET-only coverage, and
    # against admin writes dropping out of it.
    assert writes >= 15, f"sweep only checked {writes} state-changing operations"
    admin_writes = sum(
        1
        for templated, operations in paths.items()
        if templated.startswith(ADMIN)
        for method in operations
        if method not in {"head", "options", "get"}
    )
    assert admin_writes >= 5, f"sweep only checked {admin_writes} admin writes"


def _concrete(templated: str) -> str:
    """Replace path placeholders with a UUID so the route actually matches."""
    out = templated
    while "{" in out:
        start = out.index("{")
        end = out.index("}")
        name = out[start + 1 : end]
        value = {
            "profile_id": str(USER_PROFILE),
            "target_profile_id": str(OTHER_PROFILE),
            "reported_profile_id": str(OTHER_PROFILE),
            "reporter_profile_id": str(USER_PROFILE),
            "conversation_id": str(MATCH_ID),
            "match_id": str(MATCH_ID),
            "application_id": str(APPLICATION_ID),
            "photo_id": str(uuid4()),
            "opportunity_id": str(OPP),
            "block_id": str(uuid4()),
            "report_id": str(uuid4()),
            "verification_id": str(uuid4()),
        }.get(name, str(uuid4()))
        out = out[:start] + value + out[end + 1 :]
    return out


def test_suspension_is_not_bypassable_by_a_different_token(client):
    """A suspended account cannot act by presenting another user's id —
    the gate resolves the profile from the bearer token only."""
    fake = _fake_of(client)
    suspend(fake, USER_PROFILE)

    # Spoofing the partner's id in the body/path changes nothing.
    assert_suspended(
        client.post(
            f"{OPPORTUNITIES}/{OPP}/applications",
            headers=HEADERS,
            json={"auth_user_id": str(OTHER_AUTH), "profile_id": str(OTHER_PROFILE)},
        )
    )
    # The unsuspended partner is unaffected.
    assert client.post(
        f"{OPPORTUNITIES}/{OPP}/applications", headers=OTHER_HEADERS
    ).status_code in (201, 409)


def test_public_reads_remain_available_while_suspended(client):
    """Public catalog/browse is anonymous and carries no user state, so it is
    not gated — but it also grants no ability to interact."""
    fake = _fake_of(client)
    suspend(fake, USER_PROFILE)

    assert client.get(f"{OPPORTUNITIES}").status_code == 200
    assert client.get(f"{OPPORTUNITIES}/{OPP}").status_code == 200
    assert client.get("/api/v1/categories").status_code == 200
    assert client.get("/api/v1/activities").status_code == 200


def test_own_account_reads_remain_available_while_suspended(client):
    """Requirement: read-only access stays available where appropriate, so a
    suspended user can still see their own account and why it is blocked."""
    fake = _fake_of(client)
    suspend(fake, USER_PROFILE)

    assert client.get("/api/v1/profiles/me", headers=HEADERS).status_code == 200
    assert client.get("/api/v1/verification/status", headers=HEADERS).status_code == 200


# ---------------------------------------------------------------------------
# 6. Existing admin suspension authorization stays intact.
# ---------------------------------------------------------------------------


def test_admin_can_suspend_and_the_gate_activates_immediately(client):
    """End to end through the real admin endpoint: staff record a suspension
    and the target is blocked on the very next request — the console and the
    enforcement gate read the same table."""
    assert client.post(
        f"{OPPORTUNITIES}/{OPP}/applications", headers=HEADERS
    ).status_code == 409  # fixture already applied

    resp = client.post(
        f"{ADMIN}/users/{USER_PROFILE}/suspend",
        headers=STAFF_HEADERS,
        json={"reason": "abuse"},
    )
    assert resp.status_code == 201

    assert_suspended(client.post(f"{OPPORTUNITIES}/{OPP}/applications", headers=HEADERS))


def test_admin_suspension_still_rejects_non_staff(client):
    """The suspension gate must not weaken the staff check: a non-staff user
    still cannot reach the admin surface that writes suspensions."""
    resp = client.post(
        f"{ADMIN}/users/{USER_PROFILE}/suspend",
        headers=HEADERS,
        json={"reason": "abuse"},
    )
    assert resp.status_code == 403
    assert resp.json()["error"]["code"] == "permission_denied"


def test_admin_suspension_still_requires_authentication(client):
    resp = client.post(
        f"{ADMIN}/users/{USER_PROFILE}/suspend",
        json={"reason": "abuse"},
    )
    assert resp.status_code == 401


def test_admin_can_lift_a_suspension_and_access_returns(client):
    fake = _fake_of(client)
    client.post(
        f"{ADMIN}/users/{USER_PROFILE}/suspend",
        headers=STAFF_HEADERS,
        json={"reason": "abuse"},
    )
    assert_suspended(client.post(f"{OPPORTUNITIES}/{OPP}/applications", headers=HEADERS))

    resp = client.delete(f"{ADMIN}/users/{USER_PROFILE}/suspension", headers=STAFF_HEADERS)
    assert resp.status_code == 200
    assert fake.tables["suspensions"] == []
    assert client.post(
        f"{OPPORTUNITIES}/{OPP}/applications", headers=HEADERS
    ).status_code == 409  # back to the fixture's duplicate, i.e. gate passed


def test_suspended_staff_is_not_exempt_from_the_gate():
    """Authorization and suspension are independent checks. Staff membership
    grants admin access only while the account is not itself suspended: a
    suspended moderator's admin WRITE is refused with account_suspended, and
    nothing is written. There is no superadmin bypass — reinstating the
    moderator is what restores access, and nothing else has to change."""
    fake = build_fake()
    fake.tables["profiles"].append(
        profile_row(
            STAFF_PROFILE,
            STAFF_AUTH,
            first_name="Mod",
            gender="woman",
            seeking_gender="everyone",
        )
    )
    client = make_client(
        fake, catalog.router, opportunities.router, applications.router,
        opportunity_discovery.router, admin_users.router,
        admin_catalog.router, admin_opportunities.router
    )

    # Active moderator: admin access works.
    assert client.get(f"{ADMIN}/dashboard", headers=STAFF_HEADERS).status_code == 200

    suspend(fake, STAFF_PROFILE)

    resp = client.post(
        f"{ADMIN}/users/{USER_PROFILE}/suspend",
        headers=STAFF_HEADERS,
        json={"reason": "abuse"},
    )
    assert_suspended(resp)
    # Only the moderator's own suspension row — the refused write added nothing.
    assert [row["profile_id"] for row in fake.tables["suspensions"]] == [
        str(STAFF_PROFILE)
    ]

    # Lifting the suspension is all it takes to get admin access back.
    fake.tables["suspensions"].clear()
    assert client.post(
        f"{ADMIN}/users/{USER_PROFILE}/suspend",
        headers=STAFF_HEADERS,
        json={"reason": "abuse"},
    ).status_code == 201


def test_suspension_lookup_failure_fails_closed(client):
    """If the suspension cannot be checked, the request is refused rather than
    allowed — an outage must not silently lift enforcement."""
    fake = _fake_of(client)
    fake.state["fail_tables"] = {"suspensions"}
    resp = client.post(f"{OPPORTUNITIES}/{OPP}/applications", headers=HEADERS)
    assert resp.status_code == 503
    assert resp.json()["error"]["code"] == "database_unavailable"
