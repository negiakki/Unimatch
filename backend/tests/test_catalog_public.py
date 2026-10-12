"""Backend tests for the PUBLIC catalog and public opportunity browse/detail.

  * the category/activity catalog is public, returns ACTIVE rows only, and
    nests the active activities under their category;
  * public opportunity browse shows PUBLISHED opportunities only, newest first,
    and filters by category;
  * opportunity detail carries its category/activity context;
  * DRAFT and unknown ids are the same 404 — no existence leak;
  * none of these reads require a session.

Supabase is replaced at the `get_supabase_service_client` dependency boundary
with the shared in-memory double. No network, no real database.
"""

from uuid import uuid4

import pytest

from app.api.routes import catalog, opportunities
from tests.fakes import make_client
from tests.phase2_world import (
    ACTIVITIES_API,
    CATEGORIES_API,
    CATEGORY_2,
    OPP_A,
    OPPORTUNITIES_API,
    OPP_DRAFT,
    build_fake,
)


@pytest.fixture()
def fake():
    return build_fake()


@pytest.fixture()
def client(fake):
    return make_client(fake, catalog.router, opportunities.router)


# ---------------------------------------------------------------------------
# Catalog.
# ---------------------------------------------------------------------------


def test_categories_are_public_and_active_only(client):
    resp = client.get(CATEGORIES_API)
    assert resp.status_code == 200
    body = resp.json()
    assert [c["slug"] for c in body] == ["sports", "events"]
    sports = body[0]
    assert sports["name"] == "Sports"
    # Inactive activities are hidden from the public catalog.
    assert [a["slug"] for a in sports["activities"]] == ["badminton"]


def test_activities_are_public_and_active_only(client):
    resp = client.get(ACTIVITIES_API)
    assert resp.status_code == 200
    assert [a["slug"] for a in resp.json()] == ["badminton"]


def test_categories_require_no_authentication(client):
    assert client.get(CATEGORIES_API).status_code == 200
    assert client.get(ACTIVITIES_API).status_code == 200


# ---------------------------------------------------------------------------
# Public opportunity discovery.
# ---------------------------------------------------------------------------


def test_public_opportunity_list_shows_published_only(client):
    resp = client.get(OPPORTUNITIES_API)
    assert resp.status_code == 200
    titles = [o["title"] for o in resp.json()]
    # Newest first (Dandiya 08-06, Badminton 08-05); the DRAFT is never public.
    assert titles == ["Dandiya Night", "Badminton Tournament"]
    assert "Secret Draft" not in titles


def test_public_opportunity_list_filters_by_category(client):
    resp = client.get(OPPORTUNITIES_API, params={"category_id": str(CATEGORY_2)})
    assert resp.status_code == 200
    assert [o["title"] for o in resp.json()] == ["Dandiya Night"]


def test_public_opportunity_detail_includes_category_and_activity(client):
    resp = client.get(f"{OPPORTUNITIES_API}/{OPP_A}")
    assert resp.status_code == 200
    body = resp.json()
    assert body["title"] == "Badminton Tournament"
    assert body["category"]["slug"] == "sports"
    assert body["activity"]["slug"] == "badminton"
    assert body["partner_requirement"] == "Mixed doubles"


def test_unpublished_opportunity_detail_is_404(client):
    resp = client.get(f"{OPPORTUNITIES_API}/{OPP_DRAFT}")
    assert resp.status_code == 404
    assert resp.json()["error"]["code"] == "not_found"


def test_unknown_opportunity_detail_is_404(client):
    resp = client.get(f"{OPPORTUNITIES_API}/{uuid4()}")
    assert resp.status_code == 404


def test_public_opportunity_read_needs_no_authentication(client):
    assert client.get(OPPORTUNITIES_API).status_code == 200
    assert client.get(f"{OPPORTUNITIES_API}/{OPP_A}").status_code == 200
