"""Focused backend tests for the discovery feed API.

Scope: HTTP-level tests of THIS backend's logic — auth handling, the VERIFIED
viewer gate (403), candidate eligibility (not-self, verified, two-sided gender
compatibility, seeking_gender=everyone), deterministic ordering, cursor
pagination, limit enforcement, and the guarantee that only client-safe fields
are returned (auth_user_id, date_of_birth, storage_path, verification status,
and verification documents are never exposed).

Supabase is replaced at the `get_supabase_service_client` dependency boundary
with a small in-memory double implementing only the client surface the backend
uses. These are NOT Supabase integration tests and never touch a network.
"""

from types import SimpleNamespace
from uuid import UUID, uuid4

import pytest
from fastapi.testclient import TestClient

from app.main import create_app
from app.services.supabase import get_supabase_service_client

API = "/api/v1/discovery/feed"

VIEWER_AUTH_ID = UUID("11111111-1111-1111-1111-111111111111")
OTHER_AUTH_ID = UUID("22222222-2222-2222-2222-222222222222")
VIEWER_PROFILE_ID = UUID("33333333-3333-3333-3333-333333333333")
OTHER_PROFILE_ID = UUID("44444444-4444-4444-4444-444444444444")
STATE_UNIVERSITY_ID = UUID("aaaaaaaa-0000-0000-0000-000000000001")

VALID_TOKEN = "valid-access-token"
OTHER_TOKEN = "other-access-token"

AUTH_HEADERS = {"Authorization": f"Bearer {VALID_TOKEN}"}
OTHER_HEADERS = {"Authorization": f"Bearer {OTHER_TOKEN}"}

# ---------------------------------------------------------------------------
# In-memory Supabase double (only the surface the backend uses).
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
        self._neq_filters: dict = {}
        self._in_filters: dict = {}
        self._orders: list = []
        self._limit: int | None = None
        self._single = False

    def select(self, _columns):
        return self

    def eq(self, column, value):
        self._filters[column] = value
        return self

    def neq(self, column, value):
        self._neq_filters[column] = value
        return self

    def in_(self, column, values):
        self._in_filters[column] = list(values)
        return self

    def order(self, column, desc=False):
        self._orders.append((column, desc))
        return self

    def limit(self, count):
        self._limit = count
        return self

    def maybe_single(self):
        self._single = True
        return self

    def _matched(self):
        return [
            row
            for row in self._tables[self._table_name]
            if all(row.get(c) == v for c, v in self._filters.items())
            and all(row.get(c) != v for c, v in self._neq_filters.items())
            and all(row.get(c) in values for c, values in self._in_filters.items())
        ]

    def execute(self):
        if self._fail:
            raise RuntimeError("database unavailable")
        matched = [dict(row) for row in self._matched()]
        # Apply orders so the LAST-specified order is the primary sort (stable
        # sorts applied in reverse preserve secondary ordering).
        for column, desc in reversed(self._orders):
            matched.sort(
                key=lambda row: row.get(column) if row.get(column) is not None else "",
                reverse=desc,
            )
        if self._limit is not None:
            matched = matched[: self._limit]
        if self._single:
            return FakeResponse(matched[0] if matched else None)
        return FakeResponse(matched)


class FakeSignedUrlBucket:
    def __init__(self, state):
        self._state = state

    def create_signed_url(self, path, expires_in):
        self._state["signed"].append((path, expires_in))
        if self._state.get("fail_signing"):
            raise RuntimeError("storage signing unavailable")
        return {
            "signedUrl": f"https://storage.test/sign/{path}?token=x",
            "signedURL": f"https://storage.test/sign/{path}?token=x",
        }


class FakeStorage:
    def __init__(self, state):
        self._state = state

    def from_(self, _bucket):
        return FakeSignedUrlBucket(self._state)


class FakeSupabase:
    def __init__(self, users_by_token, fail_tables=frozenset()):
        self.tables = {
            "profiles": [],
            "universities": [],
            "verification_submissions": [],
            "profile_interests": [],
            "interests": [],
            "profile_photos": [],
            "dating_actions": [],
        }
        self._fail_tables = set(fail_tables)
        self._users_by_token = users_by_token
        self.auth = self
        self.state = {"signed": [], "fail_signing": False}

    def get_user(self, jwt=None):
        user_id = self._users_by_token.get(jwt)
        if user_id is None:
            raise RuntimeError("invalid JWT")
        return SimpleNamespace(user=SimpleNamespace(id=user_id))

    def table(self, name):
        return FakeTable(self.tables, name, self._fail_tables)

    @property
    def storage(self):
        return FakeStorage(self.state)


# ---------------------------------------------------------------------------
# Helpers / fixtures.
# ---------------------------------------------------------------------------


def university_row(university_id=STATE_UNIVERSITY_ID, **overrides):
    row = {
        "id": str(university_id),
        "name": "State University",
        "city": "College Town",
        "state": "CA",
        "country": "USA",
    }
    row.update(overrides)
    return row


def profile_row(
    profile_id,
    auth_user_id=OTHER_AUTH_ID,
    *,
    first_name="Riley",
    gender="man",
    seeking_gender="women",
    date_of_birth="2001-05-10",
    created_at="2026-08-01T09:00:00+00:00",
    **overrides,
):
    row = {
        "id": str(profile_id),
        "auth_user_id": str(auth_user_id),
        "first_name": first_name,
        "date_of_birth": date_of_birth,
        "university_id": str(STATE_UNIVERSITY_ID),
        "course": "Computer Science",
        "academic_year": 3,
        "gender": gender,
        "seeking_gender": seeking_gender,
        "bio": "A bio.",
        "relationship_intent": "serious",
        "height_cm": 180,
        "hometown": "Springfield",
        "profile_prompts": [{"prompt": "My top secret", "answer": "Cooking"}],
        "created_at": created_at,
        "universities": university_row(),
    }
    row.update(overrides)
    return row


def submission_row(profile_id, status, submitted_at="2026-08-20T10:00:00+00:00"):
    return {
        "id": str(uuid4()),
        "profile_id": str(profile_id),
        "status": status,
        "submitted_at": submitted_at,
    }


def link_row(profile_id, interest_id):
    return {"profile_id": str(profile_id), "interest_id": str(interest_id)}


def interest_row(interest_id, name):
    return {"id": str(interest_id), "name": name}


def photo_row(profile_id, storage_path, position, is_primary=False, photo_id=None):
    return {
        "id": str(photo_id or uuid4()),
        "profile_id": str(profile_id),
        "storage_path": storage_path,
        "is_primary": is_primary,
        "position": position,
    }


def make_fake(
    *,
    viewer_profile=None,
    candidates=None,
    submissions=None,
    interests=None,
    interest_links=None,
    photos=None,
    fail_tables=(),
):
    fake = FakeSupabase(
        {VALID_TOKEN: str(VIEWER_AUTH_ID), OTHER_TOKEN: str(OTHER_AUTH_ID)},
        fail_tables=fail_tables,
    )
    fake.tables["universities"] = [university_row()]
    fake.tables["profiles"] = [
        dict(viewer_profile) if viewer_profile else profile_row(
            VIEWER_PROFILE_ID,
            VIEWER_AUTH_ID,
            first_name="Jamie",
            gender="woman",
            seeking_gender="men",
            created_at="2026-08-10T09:00:00+00:00",
        )
    ] + [dict(row) for row in (candidates or [])]
    fake.tables["verification_submissions"] = list(submissions or [])
    fake.tables["interests"] = [dict(row) for row in (interests or [])]
    fake.tables["profile_interests"] = list(interest_links or [])
    fake.tables["profile_photos"] = list(photos or [])
    return fake


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


# --- common candidate/scenario builders --------------------------------------

def _verified_man(who, seeking="women", created_at="2026-08-05T09:00:00+00:00"):
    return profile_row(
        who, first_name=f"Man{who}", gender="man", seeking_gender=seeking,
        created_at=created_at,
    )


def _scenario_standard():
    """Viewer (woman, seeks men, VERIFIED) + a mixed candidate pool."""
    c1 = _verified_man(UUID("aaaa0000-0000-0000-0000-000000000001"), seeking="women")
    c2 = _verified_man(UUID("aaaa0000-0000-0000-0000-000000000002"), seeking="everyone")
    c3 = _verified_man(UUID("aaaa0000-0000-0000-0000-000000000003"), seeking="men")
    c4 = profile_row(
        UUID("aaaa0000-0000-0000-0000-000000000004"),
        first_name="Woman",
        gender="woman",
        seeking_gender="men",
    )
    c5 = _verified_man(UUID("aaaa0000-0000-0000-0000-000000000005"))
    c6 = _verified_man(UUID("aaaa0000-0000-0000-0000-000000000006"))
    submissions = [
        submission_row(VIEWER_PROFILE_ID, "VERIFIED"),
        submission_row(c1["id"], "VERIFIED"),
        submission_row(c2["id"], "VERIFIED"),
        submission_row(c3["id"], "VERIFIED"),
        submission_row(c4["id"], "VERIFIED"),
        submission_row(c5["id"], "PENDING"),
        # c6 has no submission at all.
    ]
    return make_fake(candidates=[c1, c2, c3, c4, c5, c6], submissions=submissions)


# ---------------------------------------------------------------------------
# 1. Unauthenticated / invalid auth.
# ---------------------------------------------------------------------------


def test_unauthenticated_is_rejected(client, fake):
    resp = client.get(API)
    assert resp.status_code == 401
    assert resp.json()["error"]["code"] == "unauthorized"
    assert fake.state["signed"] == []


def test_invalid_token_is_rejected(client, fake):
    resp = client.get(API, headers={"Authorization": "Bearer nope"})
    assert resp.status_code == 401
    assert resp.json()["error"]["code"] == "unauthorized"


def test_malformed_authorization_header_is_rejected(client):
    resp = client.get(API, headers={"Authorization": f"Token {VALID_TOKEN}"})
    assert resp.status_code == 401
    assert resp.json()["error"]["code"] == "unauthorized"


# ---------------------------------------------------------------------------
# 2. Viewer gate.
# ---------------------------------------------------------------------------


def test_unverified_viewer_is_forbidden(client, fake):
    fake.tables["verification_submissions"] = [
        submission_row(VIEWER_PROFILE_ID, "PENDING")
    ]
    resp = client.get(API, headers=AUTH_HEADERS)
    assert resp.status_code == 403
    assert resp.json()["error"]["code"] == "permission_denied"
    assert fake.state["signed"] == []


def test_rejected_viewer_is_forbidden(client, fake):
    fake.tables["verification_submissions"] = [
        submission_row(VIEWER_PROFILE_ID, "REJECTED")
    ]
    resp = client.get(API, headers=AUTH_HEADERS)
    assert resp.status_code == 403
    assert resp.json()["error"]["code"] == "permission_denied"


def test_viewer_without_profile_is_forbidden(client, fake):
    fake.tables["profiles"] = []
    resp = client.get(API, headers=AUTH_HEADERS)
    assert resp.status_code == 403
    assert resp.json()["error"]["code"] == "permission_denied"


def test_client_cannot_inject_viewer_or_auth_ids(client, fake):
    # Query params must never target another viewer.
    fake.tables["verification_submissions"] = [
        submission_row(VIEWER_PROFILE_ID, "VERIFIED")
    ]
    resp = client.get(
        API,
        headers=AUTH_HEADERS,
        params={
            "auth_user_id": str(OTHER_AUTH_ID),
            "profile_id": str(OTHER_PROFILE_ID),
        },
    )
    assert resp.status_code == 200


# ---------------------------------------------------------------------------
# 3. Verified viewer receives an eligible feed.
# ---------------------------------------------------------------------------


def test_verified_viewer_receives_feed(client, fake):
    fake.tables["verification_submissions"] = [
        submission_row(VIEWER_PROFILE_ID, "VERIFIED")
    ]
    fake.tables["profile_photos"] = [
        photo_row(VIEWER_PROFILE_ID, "viewer/self.png", 1, is_primary=True)
    ]
    fake.tables["interests"] = [interest_row(uuid4(), "Hiking")]
    fake.tables["profile_interests"] = [
        link_row(VIEWER_PROFILE_ID, fake.tables["interests"][0]["id"])
    ]

    resp = client.get(API, headers=AUTH_HEADERS)

    assert resp.status_code == 200
    body = resp.json()
    assert "candidates" in body
    assert "next_cursor" in body
    assert isinstance(body["candidates"], list)


def test_current_user_is_excluded(client, fake):
    # The viewer's own profile (verified) must never appear in the feed.
    fake = make_fake(submissions=[submission_row(VIEWER_PROFILE_ID, "VERIFIED")])
    fake.tables["profiles"].append(
        profile_row(
            VIEWER_PROFILE_ID, VIEWER_AUTH_ID, first_name="Jamie",
            gender="woman", seeking_gender="men",
        )
    )
    client = make_client(fake)
    resp = client.get(API, headers=AUTH_HEADERS)
    assert resp.status_code == 200
    ids = [c["id"] for c in resp.json()["candidates"]]
    assert str(VIEWER_PROFILE_ID) not in ids


def test_unverified_candidates_are_excluded(client, fake):
    verified_man = _verified_man(UUID("aaaa0000-0000-0000-0000-000000000001"))
    pending = _verified_man(UUID("aaaa0000-0000-0000-0000-000000000002"))
    rejected = _verified_man(UUID("aaaa0000-0000-0000-0000-000000000003"))
    no_submission = _verified_man(UUID("aaaa0000-0000-0000-0000-000000000004"))
    fake = make_fake(
        candidates=[verified_man, pending, rejected, no_submission],
        submissions=[
            submission_row(VIEWER_PROFILE_ID, "VERIFIED"),
            submission_row(verified_man["id"], "VERIFIED"),
            submission_row(pending["id"], "PENDING"),
            submission_row(rejected["id"], "REJECTED"),
        ],
    )
    client = make_client(fake)
    resp = client.get(API, headers=AUTH_HEADERS)
    assert resp.status_code == 200
    ids = [c["id"] for c in resp.json()["candidates"]]
    assert ids == [str(verified_man["id"])]


def test_gender_preference_filtering(client, fake):
    c1 = _verified_man(UUID("aaaa0000-0000-0000-0000-000000000001"))       # man, seeks women
    c2 = _verified_man(UUID("aaaa0000-0000-0000-0000-000000000002"), seeking="everyone")
    c4 = profile_row(UUID("aaaa0000-0000-0000-0000-000000000003"),
                     first_name="Woman", gender="woman", seeking_gender="men")
    fake = make_fake(
        candidates=[c1, c2, c4],
        submissions=[
            submission_row(VIEWER_PROFILE_ID, "VERIFIED"),
            submission_row(c1["id"], "VERIFIED"),
            submission_row(c2["id"], "VERIFIED"),
            submission_row(c4["id"], "VERIFIED"),
        ],
    )
    client = make_client(fake)
    resp = client.get(API, headers=AUTH_HEADERS)
    assert resp.status_code == 200
    ids = [c["id"] for c in resp.json()["candidates"]]
    # Viewer seeks men: only men are eligible (c4 is a woman → excluded).
    assert str(c1["id"]) in ids
    assert str(c2["id"]) in ids
    assert str(c4["id"]) not in ids


def test_two_sided_gender_compatibility(client, fake):
    # Viewer (woman, seeks everyone) is compatible with:
    #   - a man who seeks women (both directions OK);
    #   - a man who seeks men is NOT compatible (candidate seeks men, viewer is a woman).
    man_seeks_women = _verified_man(UUID("aaaa0000-0000-0000-0000-000000000001"), seeking="women")
    man_seeks_men = _verified_man(UUID("aaaa0000-0000-0000-0000-000000000002"), seeking="men")
    woman_seeks_women = profile_row(
        UUID("aaaa0000-0000-0000-0000-000000000003"),
        first_name="Woman", gender="woman", seeking_gender="women",
    )
    fake = make_fake(
        candidates=[man_seeks_women, man_seeks_men, woman_seeks_women],
        submissions=[
            submission_row(VIEWER_PROFILE_ID, "VERIFIED"),
            submission_row(man_seeks_women["id"], "VERIFIED"),
            submission_row(man_seeks_men["id"], "VERIFIED"),
            submission_row(woman_seeks_women["id"], "VERIFIED"),
        ],
    )
    # Make the viewer seek everyone for this test.
    fake.tables["profiles"][0]["seeking_gender"] = "everyone"
    client = make_client(fake)
    resp = client.get(API, headers=AUTH_HEADERS)
    assert resp.status_code == 200
    ids = [c["id"] for c in resp.json()["candidates"]]
    assert str(man_seeks_women["id"]) in ids
    assert str(woman_seeks_women["id"]) in ids
    assert str(man_seeks_men["id"]) not in ids  # two-sided: he seeks men, viewer is a woman


def test_seeking_everyone_means_no_restriction_on_that_side(client, fake):
    man = _verified_man(UUID("aaaa0000-0000-0000-0000-000000000001"), seeking="everyone")
    woman = profile_row(UUID("aaaa0000-0000-0000-0000-000000000002"),
                        first_name="Woman", gender="woman", seeking_gender="everyone")
    fake = make_fake(
        candidates=[man, woman],
        submissions=[
            submission_row(VIEWER_PROFILE_ID, "VERIFIED"),
            submission_row(man["id"], "VERIFIED"),
            submission_row(woman["id"], "VERIFIED"),
        ],
    )
    # Viewer: woman, seeks everyone.
    fake.tables["profiles"][0]["seeking_gender"] = "everyone"
    client = make_client(fake)
    resp = client.get(API, headers=AUTH_HEADERS)
    assert resp.status_code == 200
    ids = [c["id"] for c in resp.json()["candidates"]]
    assert str(man["id"]) in ids
    assert str(woman["id"]) in ids


# ---------------------------------------------------------------------------
# 4. Deterministic ordering (newest first).
# ---------------------------------------------------------------------------


def test_feed_ordered_newest_first(client, fake):
    old = _verified_man(UUID("aaaa0000-0000-0000-0000-000000000001"), created_at="2026-07-01T09:00:00+00:00")
    mid = _verified_man(UUID("aaaa0000-0000-0000-0000-000000000002"), created_at="2026-08-01T09:00:00+00:00")
    new = _verified_man(UUID("aaaa0000-0000-0000-0000-000000000003"), created_at="2026-08-20T09:00:00+00:00")
    fake = make_fake(
        candidates=[old, mid, new],
        submissions=[
            submission_row(VIEWER_PROFILE_ID, "VERIFIED"),
            submission_row(old["id"], "VERIFIED"),
            submission_row(mid["id"], "VERIFIED"),
            submission_row(new["id"], "VERIFIED"),
        ],
    )
    client = make_client(fake)
    resp = client.get(API, headers=AUTH_HEADERS)
    assert resp.status_code == 200
    ids = [c["id"] for c in resp.json()["candidates"]]
    assert ids == [str(new["id"]), str(mid["id"]), str(old["id"])]


# ---------------------------------------------------------------------------
# 5. Response shape and non-disclosure.
# ---------------------------------------------------------------------------

RESPONSE_KEYS = {
    "id",
    "first_name",
    "age",
    "university",
    "course",
    "academic_year",
    "gender",
    "bio",
    "relationship_intent",
    "height_cm",
    "hometown",
    "interests",
    "profile_prompts",
    "photos",
}

UNIVERSITY_KEYS = {"id", "name", "city", "state", "country"}


def test_response_shape_and_no_private_fields(client, fake):
    cand = _verified_man(UUID("aaaa0000-0000-0000-0000-000000000001"))
    fake = make_fake(
        candidates=[cand],
        submissions=[
            submission_row(VIEWER_PROFILE_ID, "VERIFIED"),
            submission_row(cand["id"], "VERIFIED"),
        ],
    )
    fake.tables["interests"] = [
        interest_row(UUID("cccc0000-0000-0000-0000-000000000001"), "Hiking"),
    ]
    fake.tables["profile_interests"] = [
        link_row(cand["id"], fake.tables["interests"][0]["id"]),
    ]
    fake.tables["profile_photos"] = [
        photo_row(cand["id"], "cand/photo.png", 1, is_primary=True),
    ]
    client = make_client(fake)
    resp = client.get(API, headers=AUTH_HEADERS)

    assert resp.status_code == 200
    body = resp.json()
    assert set(body.keys()) == {"candidates", "next_cursor"}
    assert len(body["candidates"]) == 1
    candidate = body["candidates"][0]

    assert set(candidate.keys()) == RESPONSE_KEYS
    assert set(candidate["university"].keys()) == UNIVERSITY_KEYS
    assert candidate["age"] == 25  # 2001-05-10
    assert candidate["interests"] == [{"id": str(fake.tables["interests"][0]["id"]), "name": "Hiking"}]
    assert candidate["profile_prompts"] == [{"prompt": "My top secret", "answer": "Cooking"}]
    assert candidate["photos"] == [
        {"id": str(fake.tables["profile_photos"][0]["id"]), "url": "https://storage.test/sign/cand/photo.png?token=x", "is_primary": True}
    ]

    # Never expose private/internal fields anywhere in the payload.
    assert "auth_user_id" not in str(body)
    assert "date_of_birth" not in str(body)
    assert "storage_path" not in str(body)
    assert "created_at" not in str(body)
    assert "updated_at" not in str(body)
    assert "VERIFIED" not in str(body)
    assert "PENDING" not in str(body)
    assert "REJECTED" not in str(body)
    assert "seeking_gender" not in str(body)
    assert "student-ids" not in str(body)


def test_photo_urls_are_signed_and_paths_never_disclosed(client, fake):
    cand = _verified_man(UUID("aaaa0000-0000-0000-0000-000000000001"))
    fake = make_fake(
        candidates=[cand],
        submissions=[
            submission_row(VIEWER_PROFILE_ID, "VERIFIED"),
            submission_row(cand["id"], "VERIFIED"),
        ],
    )
    fake.tables["profile_photos"] = [
        photo_row(cand["id"], "cand/primary.png", 1, is_primary=True),
        photo_row(cand["id"], "cand/second.png", 2, is_primary=False),
    ]
    client = make_client(fake)
    resp = client.get(API, headers=AUTH_HEADERS)

    assert resp.status_code == 200
    photos = resp.json()["candidates"][0]["photos"]
    assert len(photos) == 2
    assert all(p["url"].startswith("https://storage.test/sign/") for p in photos)
    assert len(fake.state["signed"]) == 2
    assert "storage_path" not in str(resp.json())
    # Photo order follows position (primary first).
    assert photos[0]["is_primary"] is True
    assert photos[1]["is_primary"] is False


# ---------------------------------------------------------------------------
# 6. Limit enforcement.
# ---------------------------------------------------------------------------


def test_limit_over_max_is_422(client, fake):
    resp = client.get(API, headers=AUTH_HEADERS, params={"limit": 51})
    assert resp.status_code == 422
    assert resp.json()["error"]["code"] == "validation_error"


def test_limit_zero_is_422(client, fake):
    resp = client.get(API, headers=AUTH_HEADERS, params={"limit": 0})
    assert resp.status_code == 422
    assert resp.json()["error"]["code"] == "validation_error"


def test_limit_fifty_is_accepted(client, fake):
    fake.tables["verification_submissions"] = [submission_row(VIEWER_PROFILE_ID, "VERIFIED")]
    resp = client.get(API, headers=AUTH_HEADERS, params={"limit": 50})
    assert resp.status_code == 200


def test_default_limit_is_twenty(client, fake):
    # Build 25 eligible candidates; without a limit param the feed returns 20.
    candidates = [
        _verified_man(UUID(f"bbbb0000-0000-0000-0000-{i:012d}"), created_at=f"2026-08-{min(1+i,28):02d}T09:00:00+00:00")
        for i in range(1, 26)
    ]
    submissions = [submission_row(VIEWER_PROFILE_ID, "VERIFIED")]
    submissions += [submission_row(c["id"], "VERIFIED") for c in candidates]
    fake = make_fake(candidates=candidates, submissions=submissions)
    client = make_client(fake)
    resp = client.get(API, headers=AUTH_HEADERS)
    assert resp.status_code == 200
    body = resp.json()
    assert len(body["candidates"]) == 20
    assert body["next_cursor"] is not None


# ---------------------------------------------------------------------------
# 7. Cursor pagination.
# ---------------------------------------------------------------------------


def test_cursor_pagination_walks_the_feed(client, fake):
    # Six eligible candidates in deterministic order.
    candidates = [
        _verified_man(UUID(f"bbbb0000-0000-0000-0000-{i:012d}"), created_at=f"2026-08-{i:02d}T09:00:00+00:00")
        for i in range(6, 0, -1)  # created_at desc: 6,5,4,3,2,1
    ]
    submissions = [submission_row(VIEWER_PROFILE_ID, "VERIFIED")]
    submissions += [submission_row(c["id"], "VERIFIED") for c in candidates]
    fake = make_fake(candidates=candidates, submissions=submissions)
    client = make_client(fake)

    collected = []
    cursor = None
    pages = 0
    while True:
        params = {"limit": 2}
        if cursor is not None:
            params["cursor"] = cursor
        resp = client.get(API, headers=AUTH_HEADERS, params=params)
        assert resp.status_code == 200
        body = resp.json()
        collected.extend(c["id"] for c in body["candidates"])
        pages += 1
        cursor = body["next_cursor"]
        if cursor is None:
            break
        if pages > 10:
            raise AssertionError("pagination did not terminate")

    expected = [str(c["id"]) for c in candidates]
    assert collected == expected
    assert pages == 3  # 2 + 2 + 2


def test_invalid_cursor_is_422(client, fake):
    fake.tables["verification_submissions"] = [submission_row(VIEWER_PROFILE_ID, "VERIFIED")]
    resp = client.get(API, headers=AUTH_HEADERS, params={"cursor": "not-a-real-cursor"})
    assert resp.status_code == 422
    assert resp.json()["error"]["code"] == "validation_error"


# ---------------------------------------------------------------------------
# 8. Database failures surface as 5xx.
# ---------------------------------------------------------------------------


def test_database_failure_returns_503(client, fake):
    fake = make_fake(fail_tables={"profiles"})
    client = make_client(fake)
    resp = client.get(API, headers=AUTH_HEADERS)
    assert resp.status_code == 503
    assert resp.json()["error"]["code"] == "database_unavailable"


def test_verification_batch_failure_returns_503():
    fake = make_fake(fail_tables={"verification_submissions"})
    client = make_client(fake)
    resp = client.get(API, headers=AUTH_HEADERS)
    assert resp.status_code == 503
    assert resp.json()["error"]["code"] == "database_unavailable"
