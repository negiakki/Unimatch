"""Shared in-memory world for the Phase 2 student-facing tests.

One fixture world is used by the catalog, application and contextual-matching
test modules: three viewers/profiles, a category catalog with an inactive
activity, two PUBLISHED opportunities plus a DRAFT, verified submissions, and
applications for both opportunities. Keeping it in one module is what lets the
Phase 2 tests be split along the feature commits without triplicating the
builder or letting two copies drift.

No network, no real database: `FakeSupabase` replaces the service client at
the dependency boundary.
"""

from uuid import UUID, uuid4

from tests.fakes import (
    FakeSupabase,
    activity_row,
    application_row,
    category_row,
    opportunity_row,
    profile_row,
    submission_row,
)


VIEWER_AUTH = UUID("11111111-1111-1111-1111-111111111111")
OTHER_AUTH = UUID("22222222-2222-2222-2222-222222222222")
THIRD_AUTH = UUID("33333333-3333-3333-3333-333333333333")

VIEWER_PROFILE = UUID("aaaaaaaa-1111-1111-1111-111111111111")
OTHER_PROFILE = UUID("aaaaaaaa-2222-2222-2222-222222222222")
THIRD_PROFILE = UUID("aaaaaaaa-3333-3333-3333-333333333333")

CATEGORY = UUID("bbbbbbbb-0000-0000-0000-000000000001")
ACTIVITY = UUID("bbbbbbbb-0000-0000-0000-000000000002")
CATEGORY_2 = UUID("bbbbbbbb-0000-0000-0000-000000000003")

OPP_A = UUID("cccccccc-0000-0000-0000-000000000001")
OPP_B = UUID("cccccccc-0000-0000-0000-000000000002")
OPP_DRAFT = UUID("cccccccc-0000-0000-0000-000000000003")

VIEWER_TOKEN = "viewer-token"
OTHER_TOKEN = "other-token"
THIRD_TOKEN = "third-token"
VIEWER_HEADERS = {"Authorization": f"Bearer {VIEWER_TOKEN}"}
OTHER_HEADERS = {"Authorization": f"Bearer {OTHER_TOKEN}"}
THIRD_HEADERS = {"Authorization": f"Bearer {THIRD_TOKEN}"}

CATEGORIES_API = "/api/v1/categories"
ACTIVITIES_API = "/api/v1/activities"
OPPORTUNITIES_API = "/api/v1/opportunities"
APPLICATIONS_API = "/api/v1/applications"
CONVERSATIONS_API = "/api/v1/conversations"


def build_fake(**overrides):
    """A verified viewer who applied to both opportunities, plus candidates."""
    fake = FakeSupabase(
        {
            VIEWER_TOKEN: str(VIEWER_AUTH),
            OTHER_TOKEN: str(OTHER_AUTH),
            THIRD_TOKEN: str(THIRD_AUTH),
        }
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
    fake.tables["categories"] = [
        {**category_row(CATEGORY, "Sports", "sports"), "activities": []},
        {**category_row(CATEGORY_2, "Events", "events", sort_order=20), "activities": []},
    ]
    badminton = activity_row(ACTIVITY, CATEGORY, "Badminton", "badminton")
    cricket = activity_row(
        uuid4(), CATEGORY, "Cricket", "cricket", is_active=False, sort_order=20
    )
    fake.tables["activities"] = [badminton, cricket]
    # PostgREST embeds the related rows under the parent key; mirror that.
    fake.tables["categories"][0]["activities"] = [badminton, cricket]
    fake.tables["opportunities"] = [
        opportunity_row(OPP_A, CATEGORY, ACTIVITY, title="Badminton Tournament"),
        opportunity_row(
            OPP_B,
            CATEGORY_2,
            None,
            title="Dandiya Night",
            created_at="2026-08-06T09:00:00+00:00",
        ),
        opportunity_row(
            OPP_DRAFT,
            CATEGORY,
            ACTIVITY,
            title="Secret Draft",
            status="DRAFT",
            created_at="2026-08-07T09:00:00+00:00",
        ),
    ]
    fake.tables["profiles"] = [
        profile_row(
            VIEWER_PROFILE,
            VIEWER_AUTH,
            first_name="Akshat",
            gender="man",
            seeking_gender="everyone",
            created_at="2026-08-10T09:00:00+00:00",
        ),
        profile_row(
            OTHER_PROFILE,
            OTHER_AUTH,
            first_name="Rahul",
            gender="man",
            seeking_gender="everyone",
            created_at="2026-08-09T09:00:00+00:00",
        ),
        profile_row(
            THIRD_PROFILE,
            THIRD_AUTH,
            first_name="Priya",
            gender="woman",
            seeking_gender="everyone",
            created_at="2026-08-08T09:00:00+00:00",
        ),
    ]
    fake.tables["verification_submissions"] = [
        submission_row(VIEWER_PROFILE),
        submission_row(OTHER_PROFILE),
        submission_row(THIRD_PROFILE),
    ]
    fake.tables["applications"] = [
        application_row(uuid4(), OPP_A, VIEWER_PROFILE),
        application_row(uuid4(), OPP_B, VIEWER_PROFILE),
        application_row(uuid4(), OPP_A, OTHER_PROFILE),
        application_row(uuid4(), OPP_A, THIRD_PROFILE),
    ]
    # PostgREST embeds the parent row under the relation key.
    by_id = {o["id"]: o for o in fake.tables["opportunities"]}
    for app in fake.tables["applications"]:
        app["opportunities"] = by_id.get(app["opportunity_id"])
    for name, value in overrides.items():
        fake.tables[name] = value
    return fake
