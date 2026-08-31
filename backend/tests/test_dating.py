"""Focused backend tests for Phase 6 — likes, passes & matches.

Scope: HTTP-level tests of THIS backend's logic — auth (401), the VERIFIED
viewer gate (403), self/unknown/unverified targets (404), already-decided
rejection (409, in both directions), actor spoofing immunity, mutual-like
match creation (exactly once, canonical pair order), participant-only match
visibility, soft unmatch, discovery exclusion of decided candidates in both
directions (with the existing VERIFIED/gender/ordering/pagination behavior
intact), and the client-safe payload guarantee.

Supabase is replaced at the `get_supabase_service_client` dependency boundary
with a small in-memory double implementing only the client surface the
backend uses (including insert/upsert/update and the dating tables). These
are NOT Supabase integration tests and never touch a network.
"""

from types import SimpleNamespace
from uuid import UUID, uuid4

import pytest
from fastapi.testclient import TestClient

from app.main import create_app
from app.services.supabase import get_supabase_service_client

LIKE_API = "/api/v1/discovery/{profile_id}/like"
PASS_API = "/api/v1/discovery/{profile_id}/pass"
MATCHES_API = "/api/v1/matches"

VIEWER_AUTH_ID = UUID("11111111-1111-1111-1111-111111111111")
OTHER_AUTH_ID = UUID("22222222-2222-2222-2222-222222222222")
THIRD_AUTH_ID = UUID("55555555-5555-5555-5555-555555555555")
VIEWER_PROFILE_ID = UUID("33333333-3333-3333-3333-333333333333")
OTHER_PROFILE_ID = UUID("44444444-4444-4444-4444-444444444444")
THIRD_PROFILE_ID = UUID("66666666-6666-6666-6666-666666666666")
STATE_UNIVERSITY_ID = UUID("aaaaaaaa-0000-0000-0000-000000000001")

VALID_TOKEN = "valid-access-token"
OTHER_TOKEN = "other-access-token"
THIRD_TOKEN = "third-access-token"

AUTH_HEADERS = {"Authorization": f"Bearer {VALID_TOKEN}"}
OTHER_HEADERS = {"Authorization": f"Bearer {OTHER_TOKEN}"}
THIRD_HEADERS = {"Authorization": f"Bearer {THIRD_TOKEN}"}


# ---------------------------------------------------------------------------
# In-memory Supabase double (only the surface the backend uses).
# ---------------------------------------------------------------------------


class FakeResponse:
    def __init__(self, data):
        self.data = data


class DuplicateKeyError(RuntimeError):
    pass


class FakeTable:
    def __init__(self, tables, table_name, fail_tables, state):
        self._tables = tables
        self._table_name = table_name
        self._fail = table_name in fail_tables
        self._state = state
        self._filters: dict = {}
        self._neq_filters: dict = {}
        self._in_filters: dict = {}
        self._is_filters: dict = {}
        self._or_filters: list = []
        self._orders: list = []
        self._limit: int | None = None
        self._single = False
        self._insert_rows = None
        self._upsert_rows = None
        self._ignore_duplicates = False
        self._update_values = None
        state["queries"][table_name] = state["queries"].get(table_name, 0) + 1

    def select(self, _columns):
        return self

    def insert(self, rows):
        self._insert_rows = rows if isinstance(rows, list) else [rows]
        return self

    def upsert(self, rows, ignore_duplicates=False, **_):
        self._upsert_rows = rows if isinstance(rows, list) else [rows]
        self._ignore_duplicates = ignore_duplicates
        return self

    def update(self, values):
        self._update_values = values
        return self

    def delete(self):
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

    def is_(self, column, value):
        self._is_filters[column] = value
        return self

    def or_(self, expr):
        # Supports only "col.eq.value,col.eq.value" (the backend's usage):
        # each comma-separated clause is an independent OR alternative.
        group = []
        for part in expr.split(","):
            column, op, value = part.split(".", 2)
            assert op == "eq"
            group.append([(column, value)])
        self._or_filters.append(group)
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
        matched = []
        for row in self._tables[self._table_name]:
            if self._row_matches(row):
                matched.append(dict(row))
        return matched

    def _row_matches(self, row):
        if not all(row.get(c) == v for c, v in self._filters.items()):
            return False
        if not all(row.get(c) != v for c, v in self._neq_filters.items()):
            return False
        if not all(row.get(c) in values for c, values in self._in_filters.items()):
            return False
        if not all(
            row.get(c) is None
            for c, v in self._is_filters.items()
            if v in (None, "null")
        ):
            return False
        if self._or_filters and not any(
            any(all(row.get(c) == v for c, v in clause) for clause in group)
            for group in self._or_filters
        ):
            return False
        return True

    def _enforce_uniques(self, rows):
        if self._table_name == "dating_actions":
            keys = {
                (str(r.get("actor_profile_id")), str(r.get("target_profile_id")))
                for r in self._tables["dating_actions"]
            }
            for row in rows:
                key = (str(row.get("actor_profile_id")), str(row.get("target_profile_id")))
                if key in keys:
                    raise DuplicateKeyError(
                        'duplicate key value violates unique constraint '
                        '"dating_actions_actor_target_unique"'
                    )
                keys.add(key)
        if self._table_name == "matches":
            keys = {
                (str(r.get("user_a_id")), str(r.get("user_b_id")))
                for r in self._tables["matches"]
            }
            for row in rows:
                key = (str(row.get("user_a_id")), str(row.get("user_b_id")))
                if key in keys:
                    if self._ignore_duplicates:
                        return False
                    raise DuplicateKeyError(
                        'duplicate key value violates unique constraint "matches_pair_unique"'
                    )
                keys.add(key)
        return True

    def execute(self):
        if self._fail:
            raise RuntimeError("database unavailable")

        if self._insert_rows is not None or self._upsert_rows is not None:
            rows = self._insert_rows if self._insert_rows is not None else self._upsert_rows
            prepared = []
            for row in rows:
                row = {"id": str(uuid4()), **row, "created_at": "2026-08-30T10:00:00+00:00"}
                if self._table_name == "matches":
                    row.setdefault("unmatched_at", None)  # DB default
                prepared.append(row)
            if not self._enforce_uniques(prepared):
                return FakeResponse([])  # ignored duplicates → nothing inserted
            self._tables[self._table_name].extend(prepared)
            return FakeResponse([dict(row) for row in prepared])

        matched = self._matched()
        if self._update_values is not None:
            # Apply the update to the matching stored rows.
            updated = []
            for stored in self._tables[self._table_name]:
                if self._row_matches(stored):
                    stored.update(self._update_values)
                    updated.append(dict(stored))
            return FakeResponse(updated)

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
            "custom_interests": [],
            "interests": [],
            "profile_photos": [],
            "dating_actions": [],
            "matches": [],
            "blocks": [],
        }
        self._fail_tables = set(fail_tables)
        self._users_by_token = users_by_token
        self.auth = self
        self.state = {"signed": [], "fail_signing": False, "queries": {}}

    def get_user(self, jwt=None):
        user_id = self._users_by_token.get(jwt)
        if user_id is None:
            raise RuntimeError("invalid JWT")
        return SimpleNamespace(user=SimpleNamespace(id=user_id))

    def table(self, name):
        return FakeTable(self.tables, name, self._fail_tables, self.state)

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
    auth_user_id,
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
        "profile_prompts": [],
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


def action_row(actor_profile_id, target_profile_id, action_type):
    return {
        "id": str(uuid4()),
        "actor_profile_id": str(actor_profile_id),
        "target_profile_id": str(target_profile_id),
        "action_type": action_type,
        "created_at": "2026-08-29T10:00:00+00:00",
    }


def match_row(match_id, user_a, user_b, created_at="2026-08-30T10:00:00+00:00"):
    return {
        "id": str(match_id),
        "user_a_id": str(user_a),
        "user_b_id": str(user_b),
        "created_at": created_at,
        "unmatched_at": None,
    }


def verified_pair_viewers_and_targets(fake):
    """Viewer (woman, seeks men, VERIFIED) + two verified men candidates."""
    fake.tables["profiles"] = [
        profile_row(
            VIEWER_PROFILE_ID,
            VIEWER_AUTH_ID,
            first_name="Jamie",
            gender="woman",
            seeking_gender="men",
            created_at="2026-08-10T09:00:00+00:00",
        ),
        profile_row(OTHER_PROFILE_ID, OTHER_AUTH_ID, first_name="Adam"),
        profile_row(THIRD_PROFILE_ID, THIRD_AUTH_ID, first_name="Ben"),
    ]
    fake.tables["verification_submissions"] = [
        submission_row(VIEWER_PROFILE_ID, "VERIFIED"),
        submission_row(OTHER_PROFILE_ID, "VERIFIED"),
        submission_row(THIRD_PROFILE_ID, "VERIFIED"),
    ]
    return fake


def make_fake():
    return FakeSupabase(
        {
            VALID_TOKEN: str(VIEWER_AUTH_ID),
            OTHER_TOKEN: str(OTHER_AUTH_ID),
            THIRD_TOKEN: str(THIRD_AUTH_ID),
        }
    )


def make_client(fake):
    app = create_app()
    app.dependency_overrides[get_supabase_service_client] = lambda: fake
    return TestClient(app)


@pytest.fixture()
def fake():
    return verified_pair_viewers_and_targets(make_fake())


@pytest.fixture()
def client(fake):
    return make_client(fake)


def like(client, target=OTHER_PROFILE_ID, headers=AUTH_HEADERS):
    return client.post(LIKE_API.format(profile_id=target), headers=headers)


def do_pass(client, target=OTHER_PROFILE_ID, headers=AUTH_HEADERS):
    return client.post(PASS_API.format(profile_id=target), headers=headers)


# ---------------------------------------------------------------------------
# 1. Authentication.
# ---------------------------------------------------------------------------


def test_unauthenticated_like_is_rejected(client):
    resp = client.post(LIKE_API.format(profile_id=OTHER_PROFILE_ID))
    assert resp.status_code == 401
    assert resp.json()["error"]["code"] == "unauthorized"


def test_unauthenticated_pass_is_rejected(client):
    resp = client.post(PASS_API.format(profile_id=OTHER_PROFILE_ID))
    assert resp.status_code == 401
    assert resp.json()["error"]["code"] == "unauthorized"


def test_unauthenticated_matches_is_rejected(client):
    resp = client.get(MATCHES_API)
    assert resp.status_code == 401
    assert resp.json()["error"]["code"] == "unauthorized"


def test_unauthenticated_unmatch_is_rejected(client):
    resp = client.delete(f"{MATCHES_API}/{uuid4()}")
    assert resp.status_code == 401


def test_invalid_token_is_rejected(client):
    resp = client.post(
        LIKE_API.format(profile_id=OTHER_PROFILE_ID),
        headers={"Authorization": "Bearer nope"},
    )
    assert resp.status_code == 401


# ---------------------------------------------------------------------------
# 2. Verification gate.
# ---------------------------------------------------------------------------


def _unverify_viewer(fake):
    fake.tables["verification_submissions"] = [
        submission_row(VIEWER_PROFILE_ID, "PENDING")
    ]


def test_unverified_viewer_cannot_like(client, fake):
    _unverify_viewer(fake)
    resp = like(client)
    assert resp.status_code == 403
    assert resp.json()["error"]["code"] == "permission_denied"


def test_unverified_viewer_cannot_pass(client, fake):
    _unverify_viewer(fake)
    resp = do_pass(client)
    assert resp.status_code == 403
    assert resp.json()["error"]["code"] == "permission_denied"


def test_unverified_viewer_cannot_list_matches(client, fake):
    _unverify_viewer(fake)
    resp = client.get(MATCHES_API, headers=AUTH_HEADERS)
    assert resp.status_code == 403
    assert resp.json()["error"]["code"] == "permission_denied"


def test_viewer_without_profile_cannot_like(client, fake):
    fake.tables["profiles"] = [
        p for p in fake.tables["profiles"] if p["id"] != str(VIEWER_PROFILE_ID)
    ]
    resp = like(client)
    assert resp.status_code == 403


# ---------------------------------------------------------------------------
# 3. Actions.
# ---------------------------------------------------------------------------


def test_verified_user_can_like(client, fake):
    resp = like(client)
    assert resp.status_code == 200
    assert resp.json() == {"outcome": "like_recorded"}
    assert len(fake.tables["dating_actions"]) == 1
    row = fake.tables["dating_actions"][0]
    assert row["actor_profile_id"] == str(VIEWER_PROFILE_ID)
    assert row["target_profile_id"] == str(OTHER_PROFILE_ID)
    assert row["action_type"] == "LIKE"


def test_verified_user_can_pass(client, fake):
    resp = do_pass(client)
    assert resp.status_code == 200
    assert resp.json() == {"outcome": "pass_recorded"}
    assert fake.tables["dating_actions"][0]["action_type"] == "PASS"


def test_self_like_rejected(client, fake):
    resp = like(client, target=VIEWER_PROFILE_ID)
    assert resp.status_code == 404
    assert resp.json()["error"]["code"] == "not_found"
    assert fake.tables["dating_actions"] == []


def test_self_pass_rejected(client, fake):
    resp = do_pass(client, target=VIEWER_PROFILE_ID)
    assert resp.status_code == 404
    assert fake.tables["dating_actions"] == []


def test_duplicate_like_rejected(client, fake):
    assert like(client).status_code == 200
    resp = like(client)
    assert resp.status_code == 409
    assert resp.json()["error"]["code"] == "already_decided"
    assert len(fake.tables["dating_actions"]) == 1


def test_duplicate_pass_rejected(client, fake):
    assert do_pass(client).status_code == 200
    resp = do_pass(client)
    assert resp.status_code == 409
    assert resp.json()["error"]["code"] == "already_decided"
    assert len(fake.tables["dating_actions"]) == 1


def test_like_after_pass_rejected(client, fake):
    assert do_pass(client).status_code == 200
    resp = like(client)
    assert resp.status_code == 409
    assert resp.json()["error"]["code"] == "already_decided"
    assert fake.tables["dating_actions"][0]["action_type"] == "PASS"


def test_pass_after_like_rejected(client, fake):
    assert like(client).status_code == 200
    resp = do_pass(client)
    assert resp.status_code == 409
    assert resp.json()["error"]["code"] == "already_decided"
    assert fake.tables["dating_actions"][0]["action_type"] == "LIKE"


def test_actions_are_viewer_scoped(client, fake):
    # A acts on B: B's ability to act on A is unaffected.
    assert like(client).status_code == 200
    resp = client.post(
        LIKE_API.format(profile_id=VIEWER_PROFILE_ID), headers=OTHER_HEADERS
    )
    assert resp.status_code == 200
    assert resp.json()["outcome"] == "matched"


def test_unknown_target_is_404(client, fake):
    resp = like(client, target=UUID("99999999-9999-9999-9999-999999999999"))
    assert resp.status_code == 404
    assert resp.json()["error"]["code"] == "not_found"


def test_unverified_target_is_404_no_leak(client, fake):
    fake.tables["verification_submissions"] = [
        submission_row(VIEWER_PROFILE_ID, "VERIFIED"),
        submission_row(THIRD_PROFILE_ID, "PENDING"),
    ]
    resp = like(client, target=THIRD_PROFILE_ID)
    assert resp.status_code == 404
    assert resp.json()["error"]["code"] == "not_found"


def test_actor_spoofing_is_rejected_implicitly(client, fake):
    # There is no client-supplied actor field; any body is ignored and the
    # actor is always the token's profile.
    resp = client.post(
        LIKE_API.format(profile_id=THIRD_PROFILE_ID),
        headers=AUTH_HEADERS,
        json={"actor_profile_id": str(OTHER_PROFILE_ID), "target_profile_id": str(THIRD_PROFILE_ID)},
    )
    assert resp.status_code == 200
    row = fake.tables["dating_actions"][0]
    assert row["actor_profile_id"] == str(VIEWER_PROFILE_ID)
    assert row["target_profile_id"] == str(THIRD_PROFILE_ID)


def test_target_identity_comes_from_url_not_body(client, fake):
    resp = client.post(
        LIKE_API.format(profile_id=THIRD_PROFILE_ID),
        headers=AUTH_HEADERS,
        json={"target_profile_id": str(OTHER_PROFILE_ID)},
    )
    assert resp.status_code == 200
    assert fake.tables["dating_actions"][0]["target_profile_id"] == str(THIRD_PROFILE_ID)


def test_malformed_target_uuid_is_422(client):
    resp = like(client, target="not-a-uuid")
    assert resp.status_code == 422
    assert resp.json()["error"]["code"] == "validation_error"


def test_database_failure_on_action_insert_is_503(client, fake):
    fake._fail_tables.add("dating_actions")
    resp = like(client)
    assert resp.status_code == 503
    assert resp.json()["error"]["code"] == "database_unavailable"


# ---------------------------------------------------------------------------
# 4. Matching.
# ---------------------------------------------------------------------------


def test_first_like_returns_like_recorded_no_match(client, fake):
    resp = like(client)
    assert resp.status_code == 200
    assert resp.json()["outcome"] == "like_recorded"
    assert fake.tables["matches"] == []


def test_reciprocal_like_returns_matched_with_safe_payload(client, fake):
    assert like(client).status_code == 200
    fake.tables["profile_photos"] = [
        {
            "id": str(uuid4()),
            "profile_id": str(VIEWER_PROFILE_ID),
            "storage_path": "viewer/photo-1.png",
            "position": 1,
            "is_primary": True,
        }
    ]
    resp = client.post(
        LIKE_API.format(profile_id=VIEWER_PROFILE_ID), headers=OTHER_HEADERS
    )
    assert resp.status_code == 200
    body = resp.json()
    assert body["outcome"] == "matched"
    match = body["match"]
    assert set(match.keys()) == {"id", "created_at", "profile"}
    profile = match["profile"]
    assert profile["id"] == str(VIEWER_PROFILE_ID)
    assert profile["first_name"] == "Jamie"
    assert "auth_user_id" not in str(body)
    assert "date_of_birth" not in str(body)
    assert "storage_path" not in str(body)
    assert "VERIFIED" not in str(body)


def test_match_created_exactly_once_canonical_order(client, fake):
    # B likes A first, then A likes B — one match, canonical (A < B).
    resp = client.post(
        LIKE_API.format(profile_id=VIEWER_PROFILE_ID), headers=OTHER_HEADERS
    )
    assert resp.json()["outcome"] == "like_recorded"
    resp = like(client, target=OTHER_PROFILE_ID)
    assert resp.json()["outcome"] == "matched"

    assert len(fake.tables["matches"]) == 1
    row = fake.tables["matches"][0]
    assert row["user_a_id"] == str(min(VIEWER_PROFILE_ID, OTHER_PROFILE_ID))
    assert row["user_b_id"] == str(max(VIEWER_PROFILE_ID, OTHER_PROFILE_ID))
    assert row["user_a_id"] < row["user_b_id"]


def test_concurrent_reciprocal_likes_cannot_duplicate_match(client, fake):
    # Simulate the race: A likes B; the match row already exists (created by
    # the concurrent request); B's reciprocal like must still succeed with
    # outcome matched and NOT create a second row.
    assert like(client).status_code == 200
    existing = match_row(uuid4(), VIEWER_PROFILE_ID, OTHER_PROFILE_ID)
    fake.tables["matches"].append(existing)

    resp = client.post(
        LIKE_API.format(profile_id=VIEWER_PROFILE_ID), headers=OTHER_HEADERS
    )
    assert resp.status_code == 200
    body = resp.json()
    assert body["outcome"] == "matched"
    assert body["match"]["id"] == existing["id"]
    assert len(fake.tables["matches"]) == 1


def test_match_creation_failure_is_503_and_actions_persist(client, fake):
    assert like(client).status_code == 200
    fake._fail_tables.add("matches")
    resp = client.post(
        LIKE_API.format(profile_id=VIEWER_PROFILE_ID), headers=OTHER_HEADERS
    )
    assert resp.status_code == 503
    assert len(fake.tables["dating_actions"]) == 2


def test_only_participants_see_the_match(client, fake):
    assert like(client).status_code == 200
    assert (
        client.post(
            LIKE_API.format(profile_id=VIEWER_PROFILE_ID), headers=OTHER_HEADERS
        ).status_code
        == 200
    )

    for headers in (AUTH_HEADERS, OTHER_HEADERS):
        resp = client.get(MATCHES_API, headers=headers)
        assert resp.status_code == 200
        body = resp.json()
        assert len(body["matches"]) == 1
        entry = body["matches"][0]
        assert set(entry.keys()) == {"id", "created_at", "profile"}

    # A third verified user sees nothing.
    resp = client.get(MATCHES_API, headers=THIRD_HEADERS)
    assert resp.status_code == 200
    assert resp.json()["matches"] == []


def test_match_list_profiles_are_safe_and_active_only(client, fake):
    assert like(client).status_code == 200
    assert (
        client.post(
            LIKE_API.format(profile_id=VIEWER_PROFILE_ID), headers=OTHER_HEADERS
        ).status_code
        == 200
    )
    match_id = fake.tables["matches"][0]["id"]

    # Unmatch, then the list is empty for both sides.
    resp = client.delete(f"{MATCHES_API}/{match_id}", headers=AUTH_HEADERS)
    assert resp.status_code == 200
    assert resp.json()["id"] == match_id

    for headers in (AUTH_HEADERS, OTHER_HEADERS):
        resp = client.get(MATCHES_API, headers=headers)
        assert resp.status_code == 200
        assert resp.json()["matches"] == []

    # The row is retained (soft unmatch), never deleted.
    assert len(fake.tables["matches"]) == 1
    assert fake.tables["matches"][0]["unmatched_at"] is not None


def test_participant_can_unmatch(client, fake):
    assert like(client).status_code == 200
    assert (
        client.post(
            LIKE_API.format(profile_id=VIEWER_PROFILE_ID), headers=OTHER_HEADERS
        ).status_code
        == 200
    )
    match_id = fake.tables["matches"][0]["id"]

    resp = client.delete(f"{MATCHES_API}/{match_id}", headers=OTHER_HEADERS)
    assert resp.status_code == 200

    # Unmatching twice is a 404.
    resp = client.delete(f"{MATCHES_API}/{match_id}", headers=OTHER_HEADERS)
    assert resp.status_code == 404


def test_nonparticipant_cannot_unmatch(client, fake):
    assert like(client).status_code == 200
    assert (
        client.post(
            LIKE_API.format(profile_id=VIEWER_PROFILE_ID), headers=OTHER_HEADERS
        ).status_code
        == 200
    )
    match_id = fake.tables["matches"][0]["id"]

    resp = client.delete(f"{MATCHES_API}/{match_id}", headers=THIRD_HEADERS)
    assert resp.status_code == 404
    assert resp.json()["error"]["code"] == "not_found"
    assert fake.tables["matches"][0]["unmatched_at"] is None


def test_unknown_match_unmatch_is_404(client):
    resp = client.delete(f"{MATCHES_API}/{uuid4()}", headers=AUTH_HEADERS)
    assert resp.status_code == 404


def test_pass_never_creates_a_match(client, fake):
    # B likes A first; A passes B — no match may be created.
    assert (
        client.post(
            LIKE_API.format(profile_id=VIEWER_PROFILE_ID), headers=OTHER_HEADERS
        ).status_code
        == 200
    )
    resp = do_pass(client)
    assert resp.status_code == 200
    assert resp.json()["outcome"] == "pass_recorded"
    assert fake.tables["matches"] == []


# ---------------------------------------------------------------------------
# 5. Discovery integration.
# ---------------------------------------------------------------------------

FEED_API = "/api/v1/discovery/feed"


def _feed_scenario(fake, candidates, submissions, actions):
    fake.tables["profiles"] = [
        profile_row(
            VIEWER_PROFILE_ID,
            VIEWER_AUTH_ID,
            first_name="Jamie",
            gender="woman",
            seeking_gender="men",
            created_at="2026-08-10T09:00:00+00:00",
        )
    ] + candidates
    fake.tables["verification_submissions"] = submissions
    fake.tables["dating_actions"] = actions
    return fake


def _candidate(cid, created_at="2026-08-05T09:00:00+00:00", **overrides):
    return profile_row(
        UUID(f"bbbb0000-0000-0000-0000-{cid:012d}"),
        OTHER_AUTH_ID,
        created_at=created_at,
        **overrides,
    )


def test_acted_on_candidates_disappear_from_feed(fake):
    c1 = _candidate(1)
    c2 = _candidate(2)
    fake = _feed_scenario(
        fake,
        [c1, c2],
        [submission_row(VIEWER_PROFILE_ID, "VERIFIED"), submission_row(c1["id"], "VERIFIED"), submission_row(c2["id"], "VERIFIED")],
        [action_row(VIEWER_PROFILE_ID, c1["id"], "LIKE")],
    )
    client = make_client(fake)
    resp = client.get(FEED_API, headers=AUTH_HEADERS)
    assert resp.status_code == 200
    ids = [c["id"] for c in resp.json()["candidates"]]
    assert ids == [c2["id"]]


def test_candidates_who_acted_on_viewer_stay_discoverable(fake):
    # Viewer-scoped exclusion: a candidate's LIKE on the viewer keeps the
    # candidate discoverable, so the mutual like can form the match.
    c1 = _candidate(1)
    c2 = _candidate(2)
    fake = _feed_scenario(
        fake,
        [c1, c2],
        [submission_row(VIEWER_PROFILE_ID, "VERIFIED"), submission_row(c1["id"], "VERIFIED"), submission_row(c2["id"], "VERIFIED")],
        [action_row(c1["id"], VIEWER_PROFILE_ID, "LIKE")],
    )
    client = make_client(fake)
    resp = client.get(FEED_API, headers=AUTH_HEADERS)
    ids = [c["id"] for c in resp.json()["candidates"]]
    assert ids == [c1["id"], c2["id"]]

    # After the viewer also acts, the candidate disappears from their feed.
    fake.tables["dating_actions"].append(
        action_row(VIEWER_PROFILE_ID, c1["id"], "LIKE")
    )
    resp = client.get(FEED_API, headers=AUTH_HEADERS)
    ids = [c["id"] for c in resp.json()["candidates"]]
    assert ids == [c2["id"]]

    # A matched pair is excluded for both sides (both have acted).
    fake.tables["dating_actions"].append(
        action_row(VIEWER_PROFILE_ID, c2["id"], "PASS")
    )
    resp = client.get(FEED_API, headers=AUTH_HEADERS)
    assert resp.json()["candidates"] == []


def test_feed_exclusions_preserve_verified_gender_ordering(fake):
    liked_man = _candidate(1)
    unverified_man = _candidate(2)
    woman = _candidate(3, first_name="Woman", gender="woman", seeking_gender="men")
    ineligible_man = _candidate(4, seeking_gender="men")
    ok_man = _candidate(5)
    fake = _feed_scenario(
        fake,
        [liked_man, unverified_man, woman, ineligible_man, ok_man],
        [
            submission_row(VIEWER_PROFILE_ID, "VERIFIED"),
            submission_row(liked_man["id"], "VERIFIED"),
            submission_row(unverified_man["id"], "PENDING"),
            submission_row(woman["id"], "VERIFIED"),
            submission_row(ineligible_man["id"], "VERIFIED"),
            submission_row(ok_man["id"], "VERIFIED"),
        ],
        [action_row(VIEWER_PROFILE_ID, liked_man["id"], "LIKE")],
    )
    client = make_client(fake)
    resp = client.get(FEED_API, headers=AUTH_HEADERS)
    assert resp.status_code == 200
    ids = [c["id"] for c in resp.json()["candidates"]]
    assert ids == [ok_man["id"]]


def test_feed_cursor_pagination_remains_correct_after_exclusions(fake):
    candidates = [_candidate(i, created_at=f"2026-08-{i:02d}T09:00:00+00:00") for i in range(6, 0, -1)]
    submissions = [submission_row(VIEWER_PROFILE_ID, "VERIFIED")]
    submissions += [submission_row(c["id"], "VERIFIED") for c in candidates]
    # Exclude the 3rd and 5th candidates in feed order (viewer-acted).
    actions = [
        action_row(VIEWER_PROFILE_ID, candidates[2]["id"], "PASS"),
        action_row(VIEWER_PROFILE_ID, candidates[4]["id"], "LIKE"),
    ]
    fake = _feed_scenario(fake, candidates, submissions, actions)
    client = make_client(fake)

    expected = [c["id"] for c in candidates if c["id"] not in {candidates[2]["id"], candidates[4]["id"]}]
    collected = []
    cursor = None
    pages = 0
    while True:
        params = {"limit": 2}
        if cursor:
            params["cursor"] = cursor
        resp = client.get(FEED_API, headers=AUTH_HEADERS, params=params)
        assert resp.status_code == 200
        body = resp.json()
        collected.extend(c["id"] for c in body["candidates"])
        pages += 1
        cursor = body["next_cursor"]
        if cursor is None:
            break
        assert pages < 10

    assert collected == expected
    assert pages == 2


def test_feed_exclusion_uses_batched_queries_no_n1(fake):
    candidates = [_candidate(i) for i in range(1, 11)]
    submissions = [submission_row(VIEWER_PROFILE_ID, "VERIFIED")]
    submissions += [submission_row(c["id"], "VERIFIED") for c in candidates]
    fake = _feed_scenario(
        fake, candidates, submissions, [action_row(VIEWER_PROFILE_ID, candidates[0]["id"], "LIKE")]
    )
    client = make_client(fake)
    resp = client.get(FEED_API, headers=AUTH_HEADERS)
    assert resp.status_code == 200

    # Exactly one batched dating_actions query regardless of candidate count.
    assert fake.state["queries"]["dating_actions"] == 1


# ---------------------------------------------------------------------------
# 6. Payload safety on actions.
# ---------------------------------------------------------------------------


def test_action_response_never_exposes_private_fields(client, fake):
    fake.tables["profile_photos"] = [
        {
            "id": str(uuid4()),
            "profile_id": str(VIEWER_PROFILE_ID),
            "storage_path": "viewer/photo-1.png",
            "position": 1,
            "is_primary": True,
        }
    ]
    assert like(client).status_code == 200
    resp = client.post(
        LIKE_API.format(profile_id=VIEWER_PROFILE_ID), headers=OTHER_HEADERS
    )
    body = str(resp.json())
    for forbidden in ("auth_user_id", "date_of_birth", "storage_path", "seeking_gender", "PENDING", "REJECTED"):
        assert forbidden not in body
