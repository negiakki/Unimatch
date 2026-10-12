"""Backend tests for contextual (opportunity-scoped) discovery, actions and
the opportunity context on conversations.

  * the discovery feed for ONE opportunity contains only that opportunity's
    applicants, and only VERIFIED, unblocked, two-sided-preference-compatible
    candidates the viewer has not already decided within THIS opportunity;
  * a decision in another opportunity never removes someone here, and a match
    in one opportunity does not remove the other side from another feed;
  * interest/pass record an action carrying opportunity_id; a self, non-applicant
    or undecided target surfaces the same 404 and a repeat decision is a 409;
  * a mutual interest in the same opportunity creates a contextual match, and
    the same pair matches independently in two different opportunities;
  * a request body cannot spoof the actor or the opportunity;
  * conversations carry their opportunity context and keep the 24h expiry.

Supabase is replaced at the `get_supabase_service_client` dependency boundary
with the shared in-memory double. No network, no real database.
"""

from datetime import datetime, timedelta, timezone
from uuid import uuid4

import pytest

from app.api.routes import applications, opportunities, opportunity_discovery
from tests.fakes import (
    action_row,
    application_row,
    make_client,
    submission_row,
)
from tests.phase2_world import (
    CONVERSATIONS_API,
    OPP_A,
    OPP_B,
    OPP_DRAFT,
    OPPORTUNITIES_API,
    OTHER_HEADERS,
    OTHER_PROFILE,
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
    return make_client(
        fake, opportunities.router, applications.router, opportunity_discovery.router
    )


# ---------------------------------------------------------------------------
# Contextual discovery.
# ---------------------------------------------------------------------------

def get_discovery(client, opportunity_id=OPP_A, headers=VIEWER_HEADERS, **params):
    return client.get(
        f"{OPPORTUNITIES_API}/{opportunity_id}/discovery", headers=headers, params=params
    )


def test_contextual_discovery_requires_authentication(client):
    resp = client.get(f"{OPPORTUNITIES_API}/{OPP_A}/discovery")
    assert resp.status_code == 401


def test_contextual_discovery_unpublished_is_404(client):
    resp = get_discovery(client, OPP_DRAFT)
    assert resp.status_code == 404


def test_contextual_discovery_requires_verification(fake, client):
    fake.tables["verification_submissions"] = [
        submission_row(VIEWER_PROFILE),
        submission_row(OTHER_PROFILE),
        submission_row(THIRD_PROFILE),
        submission_row(VIEWER_PROFILE, "PENDING", "2026-09-01T10:00:00+00:00"),
    ]
    resp = get_discovery(client)
    assert resp.status_code == 403


def test_contextual_discovery_requires_application(fake, client):
    fake.tables["applications"] = [
        a for a in fake.tables["applications"] if a["profile_id"] != str(VIEWER_PROFILE)
    ]
    resp = get_discovery(client)
    assert resp.status_code == 403
    assert resp.json()["error"]["code"] == "not_applied"


def test_contextual_discovery_only_shows_this_opportunitys_applicants(client):
    resp = get_discovery(client)
    assert resp.status_code == 200
    names = [c["first_name"] for c in resp.json()["candidates"]]
    assert sorted(names) == ["Priya", "Rahul"]
    # Neither the viewer nor anyone outside this opportunity appears.
    assert "Akshat" not in names


def test_contextual_discovery_scope_is_per_opportunity(fake, client):
    # The viewer only applied to OPP_B here, and only OTHER applied to OPP_B.
    fake.tables["applications"] = [
        application_row(uuid4(), OPP_B, VIEWER_PROFILE),
        application_row(uuid4(), OPP_B, OTHER_PROFILE),
    ]
    resp = get_discovery(client, OPP_B)
    assert resp.status_code == 200
    assert [c["first_name"] for c in resp.json()["candidates"]] == ["Rahul"]

    # …and in OPP_A the applicant set is unchanged (no cross-leak).
    resp = get_discovery(client, OPP_A)
    assert resp.status_code == 403


def test_partner_preference_filters_by_viewer_seeking_gender(fake, client):
    # Viewer seeks women only -> the man applicant drops out.
    viewer = next(
        p for p in fake.tables["profiles"] if p["id"] == str(VIEWER_PROFILE)
    )
    viewer["seeking_gender"] = "women"
    resp = get_discovery(client)
    names = [c["first_name"] for c in resp.json()["candidates"]]
    assert names == ["Priya"]


def test_partner_preference_respects_candidate_seeking_gender(fake, client):
    # The viewer seeks everyone (man). Rahul only wants women, so the viewer
    # (a man) does not satisfy Rahul's preference -> Rahul is filtered out.
    # Both sides' preferences are respected, not just the viewer's.
    for profile in fake.tables["profiles"]:
        if profile["id"] == str(OTHER_PROFILE):
            profile["seeking_gender"] = "women"
    resp = get_discovery(client)
    names = [c["first_name"] for c in resp.json()["candidates"]]
    assert names == ["Priya"]


def test_partner_preference_two_sided_allows_reciprocal(fake, client):
    # Viewer seeks everyone (man); Rahul seeks women -> viewer (man) fails that
    # side. Flip the viewer to a woman who seeks men: Rahul (man, seeks women)
    # is now mutually compatible.
    for profile in fake.tables["profiles"]:
        if profile["id"] == str(VIEWER_PROFILE):
            profile["gender"] = "woman"
            profile["seeking_gender"] = "men"
        if profile["id"] == str(OTHER_PROFILE):
            profile["seeking_gender"] = "women"
    resp = get_discovery(client)
    names = sorted(c["first_name"] for c in resp.json()["candidates"])
    # Priya (woman, everyone) is excluded: viewer seeks men.
    assert names == ["Rahul"]


def test_partner_preference_everyone_allows_all(fake, client):
    resp = get_discovery(client)
    names = sorted(c["first_name"] for c in resp.json()["candidates"])
    assert names == ["Priya", "Rahul"]


def test_unverified_candidates_are_excluded(fake, client):
    fake.tables["verification_submissions"] = [
        submission_row(VIEWER_PROFILE),
        submission_row(OTHER_PROFILE),
        submission_row(THIRD_PROFILE),
        submission_row(OTHER_PROFILE, "PENDING", "2026-09-05T10:00:00+00:00"),
    ]
    resp = get_discovery(client)
    assert [c["first_name"] for c in resp.json()["candidates"]] == ["Priya"]


def test_blocked_candidates_are_excluded(fake, client):
    fake.tables["blocks"] = [
        {
            "id": str(uuid4()),
            "blocker_profile_id": str(OTHER_PROFILE),
            "blocked_profile_id": str(VIEWER_PROFILE),
            "created_at": "2026-09-01T00:00:00+00:00",
        }
    ]
    resp = get_discovery(client)
    assert [c["first_name"] for c in resp.json()["candidates"]] == ["Priya"]


def test_already_decided_in_this_opportunity_is_excluded(fake, client):
    fake.tables["dating_actions"] = [
        action_row(VIEWER_PROFILE, OTHER_PROFILE, "LIKE", OPP_A)
    ]
    resp = get_discovery(client)
    assert [c["first_name"] for c in resp.json()["candidates"]] == ["Priya"]


def test_decision_in_another_opportunity_does_not_leak_in(fake, client):
    # Viewer's LIKE happened in OPP_B; it must NOT remove Rahul from OPP_A.
    fake.tables["dating_actions"] = [
        action_row(VIEWER_PROFILE, OTHER_PROFILE, "LIKE", OPP_B)
    ]
    resp = get_discovery(client, OPP_A)
    names = sorted(c["first_name"] for c in resp.json()["candidates"])
    assert names == ["Priya", "Rahul"]


def test_contextual_discovery_cursor_pagination(fake, client):
    resp = client.get(
        f"{OPPORTUNITIES_API}/{OPP_A}/discovery",
        headers=VIEWER_HEADERS,
        params={"limit": 1},
    )
    assert resp.status_code == 200
    body = resp.json()
    assert len(body["candidates"]) == 1
    assert body["next_cursor"] is not None
    page2 = client.get(
        f"{OPPORTUNITIES_API}/{OPP_A}/discovery",
        headers=VIEWER_HEADERS,
        params={"limit": 1, "cursor": body["next_cursor"]},
    )
    assert page2.status_code == 200
    assert page2.json()["candidates"][0]["first_name"] != body["candidates"][0]["first_name"]


def test_contextual_discovery_never_exposes_private_fields(client):
    resp = get_discovery(client)
    text = str(resp.json())
    for forbidden in ("auth_user_id", "date_of_birth", "storage_path", "seeking_gender"):
        assert forbidden not in text


# ---------------------------------------------------------------------------
# Contextual actions.
# ---------------------------------------------------------------------------

def interest(client, target=OTHER_PROFILE, opportunity_id=OPP_A, headers=VIEWER_HEADERS):
    return client.post(
        f"{OPPORTUNITIES_API}/{opportunity_id}/discovery/{target}/interest",
        headers=headers,
    )


def do_pass(client, target=OTHER_PROFILE, opportunity_id=OPP_A, headers=VIEWER_HEADERS):
    return client.post(
        f"{OPPORTUNITIES_API}/{opportunity_id}/discovery/{target}/pass",
        headers=headers,
    )


def test_interest_records_action_with_opportunity(fake, client):
    resp = interest(client)
    assert resp.status_code == 200
    assert resp.json() == {"outcome": "interest_recorded"}
    row = fake.tables["dating_actions"][0]
    assert row["opportunity_id"] == str(OPP_A)
    assert row["action_type"] == "LIKE"
    assert row["actor_profile_id"] == str(VIEWER_PROFILE)


def test_interest_requires_authentication(client):
    resp = client.post(
        f"{OPPORTUNITIES_API}/{OPP_A}/discovery/{OTHER_PROFILE}/interest"
    )
    assert resp.status_code == 401


def test_interest_on_unpublished_opportunity_is_404(client):
    assert interest(client, opportunity_id=OPP_DRAFT).status_code == 404


def test_interest_on_non_applicant_is_404(fake, client):
    # Remove OTHER's application to OPP_A: they are not in this context.
    fake.tables["applications"] = [
        a for a in fake.tables["applications"] if a["profile_id"] != str(OTHER_PROFILE)
    ]
    assert interest(client).status_code == 404


def test_self_interest_is_404(client):
    assert interest(client, target=VIEWER_PROFILE).status_code == 404


def test_duplicate_decision_in_same_opportunity_is_409(client):
    assert interest(client).status_code == 200
    resp = interest(client)
    assert resp.status_code == 409
    assert resp.json()["error"]["code"] == "already_decided"


def test_pass_after_interest_in_same_opportunity_is_409(client):
    assert interest(client).status_code == 200
    assert do_pass(client).status_code == 409


def test_pass_records_action_with_opportunity(fake, client):
    resp = do_pass(client)
    assert resp.status_code == 200
    assert resp.json() == {"outcome": "pass_recorded"}
    row = fake.tables["dating_actions"][0]
    assert row["action_type"] == "PASS"
    assert row["opportunity_id"] == str(OPP_A)


def test_pass_never_creates_a_match(fake, client):
    assert do_pass(client).status_code == 200
    # OTHER interests back in the same opportunity: a pass is never reciprocated.
    resp = client.post(
        f"{OPPORTUNITIES_API}/{OPP_A}/discovery/{VIEWER_PROFILE}/interest",
        headers=OTHER_HEADERS,
    )
    assert resp.status_code == 200
    assert resp.json() == {"outcome": "interest_recorded"}
    assert fake.tables["matches"] == []


def test_mutual_interest_creates_contextual_match(fake, client):
    assert interest(client).status_code == 200
    resp = client.post(
        f"{OPPORTUNITIES_API}/{OPP_A}/discovery/{VIEWER_PROFILE}/interest",
        headers=OTHER_HEADERS,
    )
    assert resp.status_code == 200
    body = resp.json()
    assert body["outcome"] == "matched"
    match = body["match"]
    assert match["opportunity"]["id"] == str(OPP_A)
    assert match["opportunity"]["title"] == "Badminton Tournament"
    assert len(fake.tables["matches"]) == 1
    row = fake.tables["matches"][0]
    assert row["opportunity_id"] == str(OPP_A)
    assert row["user_a_id"] < row["user_b_id"]


def test_same_pair_matches_independently_in_two_opportunities(fake, client):
    # Opportunity A.
    assert interest(client, opportunity_id=OPP_A).status_code == 200
    resp_a = client.post(
        f"{OPPORTUNITIES_API}/{OPP_A}/discovery/{VIEWER_PROFILE}/interest",
        headers=OTHER_HEADERS,
    )
    assert resp_a.json()["outcome"] == "matched"

    # Opportunity B (both must be participants of B).
    fake.tables["applications"].append(
        application_row(uuid4(), OPP_B, OTHER_PROFILE)
    )
    assert interest(client, opportunity_id=OPP_B).status_code == 200
    resp_b = client.post(
        f"{OPPORTUNITIES_API}/{OPP_B}/discovery/{VIEWER_PROFILE}/interest",
        headers=OTHER_HEADERS,
    )
    assert resp_b.json()["outcome"] == "matched"

    assert len(fake.tables["matches"]) == 2
    opportunity_ids = {m["opportunity_id"] for m in fake.tables["matches"]}
    assert opportunity_ids == {str(OPP_A), str(OPP_B)}
    # The pair is identical, the context is not.
    pairs = {(m["user_a_id"], m["user_b_id"]) for m in fake.tables["matches"]}
    assert len(pairs) == 1


def test_like_in_one_opportunity_does_not_match_a_like_in_another(fake, client):
    # Viewer interests in OPP_A; OTHER interests in OPP_B. No mutual context,
    # so no match may be created.
    fake.tables["applications"].append(
        application_row(uuid4(), OPP_B, OTHER_PROFILE)
    )
    assert interest(client, opportunity_id=OPP_A).status_code == 200
    resp = client.post(
        f"{OPPORTUNITIES_API}/{OPP_B}/discovery/{VIEWER_PROFILE}/interest",
        headers=OTHER_HEADERS,
    )
    assert resp.status_code == 200
    assert resp.json() == {"outcome": "interest_recorded"}
    assert fake.tables["matches"] == []


def test_match_is_listed_with_its_opportunity(fake, client):
    assert interest(client).status_code == 200
    client.post(
        f"{OPPORTUNITIES_API}/{OPP_A}/discovery/{VIEWER_PROFILE}/interest",
        headers=OTHER_HEADERS,
    )
    resp = client.get("/api/v1/matches", headers=VIEWER_HEADERS)
    assert resp.status_code == 200
    matches = resp.json()["matches"]
    assert len(matches) == 1
    assert matches[0]["opportunity"]["id"] == str(OPP_A)
    assert matches[0]["opportunity"]["title"] == "Badminton Tournament"


def test_action_body_cannot_spoof_actor_or_opportunity(client):
    resp = client.post(
        f"{OPPORTUNITIES_API}/{OPP_A}/discovery/{OTHER_PROFILE}/interest",
        headers=VIEWER_HEADERS,
        json={"actor_profile_id": str(THIRD_PROFILE), "opportunity_id": str(OPP_B)},
    )
    assert resp.status_code == 200


# ---------------------------------------------------------------------------
# Conversations carry opportunity context; 24h expiry preserved.
# ---------------------------------------------------------------------------

def _match_with_conversation(fake, opportunity_id, last_message_at):
    fake.tables["matches"].append(
        {
            "id": str(uuid4()),
            "user_a_id": str(min(VIEWER_PROFILE, OTHER_PROFILE)),
            "user_b_id": str(max(VIEWER_PROFILE, OTHER_PROFILE)),
            "opportunity_id": str(opportunity_id),
            "created_at": "2026-10-01T09:00:00+00:00",
            "unmatched_at": None,
            "last_message_at": last_message_at,
            "user_a_unread_count": 0,
            "user_b_unread_count": 0,
        }
    )
    return fake.tables["matches"][-1]["id"]


def test_conversation_carries_opportunity_context(fake, client):
    # Relative to now: the 24h inactivity window would otherwise hide this
    # conversation as soon as the hardcoded date fell more than a day behind.
    _match_with_conversation(
        fake, OPP_A, (datetime.now(timezone.utc) - timedelta(hours=1)).isoformat()
    )
    resp = client.get(CONVERSATIONS_API, headers=VIEWER_HEADERS)
    assert resp.status_code == 200
    convs = resp.json()["conversations"]
    assert len(convs) == 1
    assert convs[0]["opportunity"]["title"] == "Badminton Tournament"
    assert convs[0]["opportunity"]["category"]["slug"] == "sports"


def test_expired_conversation_is_still_hidden(fake, client):
    _match_with_conversation(fake, OPP_A, "2020-01-01T00:00:00+00:00")
    resp = client.get(CONVERSATIONS_API, headers=VIEWER_HEADERS)
    assert resp.status_code == 200
    assert resp.json()["conversations"] == []
