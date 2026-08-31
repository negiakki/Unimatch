"""Focused backend tests for the profile API (create / read / edit).

Scope: HTTP-level tests of THIS backend's logic — auth handling, ownership
derivation (token-only, client-supplied auth_user_id never accepted),
duplicate-profile conflicts, field validation mirroring the database
constraints, university-catalog checks, and the client-safe response shape.

Supabase is replaced at the `get_supabase_service_client` dependency boundary
with a small in-memory double implementing only the client surface the
backend uses. These are NOT Supabase integration tests and never touch a
network.
"""

from datetime import date, timedelta
from types import SimpleNamespace
from uuid import UUID, uuid4

import pytest
from fastapi.testclient import TestClient

from app.main import create_app
from app.services.supabase import get_supabase_service_client

API = "/api/v1/profiles"
UNIVERSITIES_API = "/api/v1/universities"

STUDENT_AUTH_ID = UUID("11111111-1111-1111-1111-111111111111")
OTHER_AUTH_ID = UUID("22222222-2222-2222-2222-222222222222")
STUDENT_PROFILE_ID = UUID("33333333-3333-3333-3333-333333333333")
OTHER_PROFILE_ID = UUID("44444444-4444-4444-4444-444444444444")
STATE_UNIVERSITY_ID = UUID("aaaaaaaa-0000-0000-0000-000000000001")
TECH_UNIVERSITY_ID = UUID("aaaaaaaa-0000-0000-0000-000000000002")
UNKNOWN_UNIVERSITY_ID = UUID("aaaaaaaa-0000-0000-0000-000000000099")

VALID_TOKEN = "valid-access-token"
OTHER_TOKEN = "other-access-token"

AUTH_HEADERS = {"Authorization": f"Bearer {VALID_TOKEN}"}
OTHER_HEADERS = {"Authorization": f"Bearer {OTHER_TOKEN}"}

TODAY = date.today()


def _eighteenth_birthday_cutoff(today: date) -> date:
    try:
        return today.replace(year=today.year - 18)
    except ValueError:  # Feb 29 on a non-leap year
        return today.replace(year=today.year - 18, day=28)


# Clock-independent dates: exactly 18 today, one day too young, one day in
# the future, and a pre-1900 birth date.
EIGHTEEN_TODAY = _eighteenth_birthday_cutoff(TODAY)
UNDER_18 = (EIGHTEEN_TODAY + timedelta(days=1)).isoformat()
FUTURE_DATE = (TODAY + timedelta(days=1)).isoformat()
PRE_1900 = "1899-12-31"
NOT_A_DATE = "not-a-date"

VALID_PROFILE = {
    "first_name": "Jamie",
    "date_of_birth": "2003-04-12",
    "university_id": str(STATE_UNIVERSITY_ID),
    "course": "Computer Science",
    "academic_year": 3,
    "gender": "woman",
    "seeking_gender": "men",
    "bio": "CS student who loves hiking and bad puns.",
    "relationship_intent": "serious",
    "height_cm": 170,
    "hometown": "Springfield",
}

PROFILE_RESPONSE_KEYS = {
    "id",
    "first_name",
    "date_of_birth",
    "university_id",
    "course",
    "academic_year",
    "gender",
    "seeking_gender",
    "bio",
    "relationship_intent",
    "height_cm",
    "hometown",
    "motivations",
    "interests",
    "profile_prompts",
    "social_links",
    "created_at",
    "updated_at",
}


# ---------------------------------------------------------------------------
# In-memory Supabase double (only the surface the backend uses).
# ---------------------------------------------------------------------------


class FakeResponse:
    def __init__(self, data):
        self.data = data


class FakeTable:
    def __init__(self, tables, table_name, fail_insert_with):
        self._tables = tables
        self._table_name = table_name
        self._fail_insert_with = fail_insert_with
        self._filters: dict = {}
        self._in_filters: dict = {}
        self._single = False
        self._order = None
        self._insert_payload = None
        self._update_payload = None
        self._delete_requested = False

    def select(self, _columns):
        return self

    def eq(self, column, value):
        self._filters[column] = value
        return self

    def in_(self, column, values):
        self._in_filters[column] = list(values)
        return self

    def order(self, column):
        self._order = column
        return self

    def maybe_single(self):
        self._single = True
        return self

    def insert(self, payload):
        self._insert_payload = payload
        return self

    def update(self, payload):
        self._update_payload = payload
        return self

    def delete(self):
        self._delete_requested = True
        return self

    def _matched(self):
        return [
            row
            for row in self._tables[self._table_name]
            if all(row.get(c) == v for c, v in self._filters.items())
            and all(row.get(c) in v for c, v in self._in_filters.items())
        ]

    def execute(self):
        if self._insert_payload is not None:
            if self._fail_insert_with is not None:
                raise self._fail_insert_with
            payloads = (
                self._insert_payload
                if isinstance(self._insert_payload, list)
                else [self._insert_payload]
            )
            inserted = []
            for payload in payloads:
                row = dict(payload)
                row.setdefault("id", str(uuid4()))
                row.setdefault("created_at", "2026-08-29T12:00:00+00:00")
                row.setdefault("updated_at", "2026-08-29T12:00:00+00:00")
                row.setdefault("profile_prompts", [])
                row.setdefault("social_links", {})
                self._tables[self._table_name].append(row)
                inserted.append(dict(row))
            return FakeResponse(inserted)
        if self._update_payload is not None:
            updated = []
            for row in self._tables[self._table_name]:
                if all(row.get(c) == v for c, v in self._filters.items()):
                    row.update(dict(self._update_payload))
                    row["updated_at"] = "2026-08-29T13:00:00+00:00"
                    updated.append(dict(row))
            return FakeResponse(updated)
        if self._delete_requested:
            matched = self._matched()
            self._tables[self._table_name] = [
                row for row in self._tables[self._table_name] if row not in matched
            ]
            return FakeResponse(matched)
        matched = self._matched()
        if self._order is not None:
            matched = sorted(matched, key=lambda row: row.get(self._order) or "")
        if self._single:
            return FakeResponse(matched[0] if matched else None)
        return FakeResponse(matched)


class FakeSupabase:
    def __init__(self, users_by_token, *, fail_insert_with=None):
        self.tables = {
            "profiles": [],
            "universities": [],
            "interests": [],
            "profile_interests": [],
            "custom_interests": [],
        }
        self._fail_insert_with = fail_insert_with
        self._users_by_token = users_by_token
        self.auth = self

    def get_user(self, jwt=None):
        user_id = self._users_by_token.get(jwt)
        if user_id is None:
            raise RuntimeError("invalid JWT")
        return SimpleNamespace(user=SimpleNamespace(id=user_id))

    def table(self, name):
        return FakeTable(self.tables, name, self._fail_insert_with)


# ---------------------------------------------------------------------------
# Helpers / fixtures.
# ---------------------------------------------------------------------------


UNIVERSITY_ROWS = [
    {
        "id": str(STATE_UNIVERSITY_ID),
        "name": "State University",
        "city": "College Town",
        "state": "CA",
        "country": "USA",
    },
    {
        "id": str(TECH_UNIVERSITY_ID),
        "name": "Bay Tech",
        "city": "Bay City",
        "state": None,
        "country": "USA",
    },
]


def make_fake(*, profiles=None, fail_insert_with=None):
    fake = FakeSupabase(
        {VALID_TOKEN: str(STUDENT_AUTH_ID), OTHER_TOKEN: str(OTHER_AUTH_ID)},
        fail_insert_with=fail_insert_with,
    )
    fake.tables["universities"] = [dict(row) for row in UNIVERSITY_ROWS]
    fake.tables["profiles"] = (
        [dict(row) for row in profiles] if profiles is not None else []
    )
    return fake


def stored_profile(
    profile_id=STUDENT_PROFILE_ID, auth_user_id=STUDENT_AUTH_ID, **overrides
):
    row = {
        "id": str(profile_id),
        "auth_user_id": str(auth_user_id),
        "first_name": "Jamie",
        "date_of_birth": "2003-04-12",
        "university_id": str(STATE_UNIVERSITY_ID),
        "course": "Computer Science",
        "academic_year": 3,
        "gender": "woman",
        "seeking_gender": "men",
        "bio": "CS student who loves hiking and bad puns.",
        "relationship_intent": "serious",
        "height_cm": 170,
        "hometown": "Springfield",
        "profile_prompts": [],
        "social_links": {},
        "created_at": "2026-08-28T09:00:00+00:00",
        "updated_at": "2026-08-28T09:00:00+00:00",
    }
    row.update(overrides)
    return row


@pytest.fixture()
def fake():
    return make_fake()


@pytest.fixture()
def client(fake):
    app = create_app()
    app.dependency_overrides[get_supabase_service_client] = lambda: fake
    return TestClient(app)


# ---------------------------------------------------------------------------
# 1. Unauthenticated requests rejected (GET / POST / PUT).
# ---------------------------------------------------------------------------


def test_unauthenticated_get_is_rejected(client):
    resp = client.get(f"{API}/me")

    assert resp.status_code == 401
    assert resp.json()["error"]["code"] == "unauthorized"


def test_unauthenticated_post_is_rejected(client, fake):
    resp = client.post(f"{API}/me", json=VALID_PROFILE)

    assert resp.status_code == 401
    assert resp.json()["error"]["code"] == "unauthorized"
    assert fake.tables["profiles"] == []


def test_unauthenticated_put_is_rejected(client, fake):
    resp = client.put(f"{API}/me", json=VALID_PROFILE)

    assert resp.status_code == 401
    assert resp.json()["error"]["code"] == "unauthorized"
    assert fake.tables["profiles"] == []


def test_invalid_token_is_rejected(client, fake):
    resp = client.get(f"{API}/me", headers={"Authorization": "Bearer nope"})

    assert resp.status_code == 401
    assert resp.json()["error"]["code"] == "unauthorized"


# ---------------------------------------------------------------------------
# 2. GET — own profile only; 404 when none exists.
# ---------------------------------------------------------------------------


def test_get_without_profile_is_not_found(client, fake):
    resp = client.get(f"{API}/me", headers=AUTH_HEADERS)

    assert resp.status_code == 404
    assert resp.json()["error"]["code"] == "profile_not_found"


def test_get_returns_own_profile(client, fake):
    fake.tables["profiles"] = [stored_profile()]

    resp = client.get(f"{API}/me", headers=AUTH_HEADERS)

    assert resp.status_code == 200
    body = resp.json()
    assert body["id"] == str(STUDENT_PROFILE_ID)
    assert body["first_name"] == "Jamie"
    assert body["date_of_birth"] == "2003-04-12"


def test_get_returns_only_callers_own_profile(client, fake):
    fake.tables["profiles"] = [
        stored_profile(),
        stored_profile(
            profile_id=OTHER_PROFILE_ID,
            auth_user_id=OTHER_AUTH_ID,
            first_name="Riley",
        ),
    ]

    resp = client.get(f"{API}/me", headers=OTHER_HEADERS)

    assert resp.status_code == 200
    assert resp.json()["id"] == str(OTHER_PROFILE_ID)
    assert resp.json()["first_name"] == "Riley"


def test_get_query_params_cannot_target_other_profiles(client, fake):
    fake.tables["profiles"] = [
        stored_profile(),
        stored_profile(
            profile_id=OTHER_PROFILE_ID,
            auth_user_id=OTHER_AUTH_ID,
            first_name="Riley",
        ),
    ]

    resp = client.get(
        f"{API}/me",
        headers=AUTH_HEADERS,
        params={"profile_id": str(OTHER_PROFILE_ID)},
    )

    assert resp.status_code == 200
    assert resp.json()["id"] == str(STUDENT_PROFILE_ID)


# ---------------------------------------------------------------------------
# 3. POST — creates the caller's own profile.
# ---------------------------------------------------------------------------


def test_post_creates_own_profile(client, fake):
    resp = client.post(f"{API}/me", json=VALID_PROFILE, headers=AUTH_HEADERS)

    assert resp.status_code == 201
    body = resp.json()
    assert body["first_name"] == "Jamie"
    assert body["university_id"] == str(STATE_UNIVERSITY_ID)

    rows = fake.tables["profiles"]
    assert len(rows) == 1
    assert rows[0]["auth_user_id"] == str(STUDENT_AUTH_ID)
    assert rows[0]["first_name"] == "Jamie"
    assert rows[0]["profile_prompts"] == []
    assert rows[0]["social_links"] == {}


def test_post_trims_text_fields(client, fake):
    payload = {
        **VALID_PROFILE,
        "first_name": "  Ana  ",
        "course": "  Mathematics  ",
        "bio": "  Hello there  ",
        "hometown": "  Springfield  ",
    }

    resp = client.post(f"{API}/me", json=payload, headers=AUTH_HEADERS)

    assert resp.status_code == 201
    row = fake.tables["profiles"][0]
    assert row["first_name"] == "Ana"
    assert row["course"] == "Mathematics"
    assert row["bio"] == "Hello there"
    assert row["hometown"] == "Springfield"


def test_post_hometown_empty_string_becomes_null(client, fake):
    payload = {**VALID_PROFILE, "hometown": "   "}

    resp = client.post(f"{API}/me", json=payload, headers=AUTH_HEADERS)

    assert resp.status_code == 201
    assert fake.tables["profiles"][0]["hometown"] is None


def test_post_duplicate_profile_is_conflict(client, fake):
    fake.tables["profiles"] = [stored_profile()]

    resp = client.post(f"{API}/me", json=VALID_PROFILE, headers=AUTH_HEADERS)

    assert resp.status_code == 409
    assert resp.json()["error"]["code"] == "profile_already_exists"
    assert len(fake.tables["profiles"]) == 1


def test_post_duplicate_race_is_conflict():
    class DuplicateKeyError(RuntimeError):
        pass

    fake = make_fake(
        fail_insert_with=DuplicateKeyError(
            'duplicate key value violates unique constraint "profiles_auth_user_id_key"'
        )
    )
    app = create_app()
    app.dependency_overrides[get_supabase_service_client] = lambda: fake
    client = TestClient(app)

    resp = client.post(f"{API}/me", json=VALID_PROFILE, headers=AUTH_HEADERS)

    assert resp.status_code == 409
    assert resp.json()["error"]["code"] == "profile_already_exists"
    assert fake.tables["profiles"] == []


def test_post_client_cannot_supply_auth_user_id(client, fake):
    payload = {
        **VALID_PROFILE,
        "auth_user_id": str(OTHER_AUTH_ID),
        "id": str(OTHER_PROFILE_ID),
    }

    resp = client.post(f"{API}/me", json=payload, headers=AUTH_HEADERS)

    assert resp.status_code == 201
    row = fake.tables["profiles"][0]
    assert row["auth_user_id"] == str(STUDENT_AUTH_ID)
    assert row["id"] != str(OTHER_PROFILE_ID)


# ---------------------------------------------------------------------------
# 4. PUT — updates the caller's own profile.
# ---------------------------------------------------------------------------


def test_put_updates_own_profile(client, fake):
    fake.tables["profiles"] = [stored_profile()]
    payload = {
        **VALID_PROFILE,
        "first_name": "Jordan",
        "bio": "Updated bio.",
        "relationship_intent": None,
        "height_cm": None,
        "hometown": None,
    }

    resp = client.put(f"{API}/me", json=payload, headers=AUTH_HEADERS)

    assert resp.status_code == 200
    body = resp.json()
    assert body["first_name"] == "Jordan"
    assert body["bio"] == "Updated bio."
    assert body["relationship_intent"] is None
    assert body["height_cm"] is None
    assert body["hometown"] is None

    row = fake.tables["profiles"][0]
    assert row["first_name"] == "Jordan"
    assert row["auth_user_id"] == str(STUDENT_AUTH_ID)


def test_put_without_profile_is_not_found(client, fake):
    resp = client.put(f"{API}/me", json=VALID_PROFILE, headers=AUTH_HEADERS)

    assert resp.status_code == 404
    assert resp.json()["error"]["code"] == "profile_not_found"
    assert fake.tables["profiles"] == []


def test_put_never_changes_auth_user_id_ownership(client, fake):
    fake.tables["profiles"] = [
        stored_profile(),
        stored_profile(profile_id=OTHER_PROFILE_ID, auth_user_id=OTHER_AUTH_ID),
    ]
    payload = {**VALID_PROFILE, "auth_user_id": str(OTHER_AUTH_ID)}

    resp = client.put(f"{API}/me", json=payload, headers=AUTH_HEADERS)

    assert resp.status_code == 200
    own = next(
        row
        for row in fake.tables["profiles"]
        if row["id"] == str(STUDENT_PROFILE_ID)
    )
    other = next(
        row
        for row in fake.tables["profiles"]
        if row["id"] == str(OTHER_PROFILE_ID)
    )
    assert own["auth_user_id"] == str(STUDENT_AUTH_ID)
    assert other["auth_user_id"] == str(OTHER_AUTH_ID)
    assert other["first_name"] == "Jamie"  # untouched


def test_put_cannot_touch_prompts_or_social_links(client, fake):
    fake.tables["profiles"] = [stored_profile()]
    payload = {
        **VALID_PROFILE,
        "profile_prompts": [{"prompt": "hack", "answer": "injected"}],
        "social_links": {"instagram": "https://evil.example"},
    }

    resp = client.put(f"{API}/me", json=payload, headers=AUTH_HEADERS)

    assert resp.status_code == 200
    row = fake.tables["profiles"][0]
    assert row["profile_prompts"] == []
    assert row["social_links"] == {}


# ---------------------------------------------------------------------------
# 5. Validation failures — structured 422 envelope.
# ---------------------------------------------------------------------------


def assert_validation_error(resp):
    assert resp.status_code == 422
    body = resp.json()
    assert body["error"]["code"] == "validation_error"
    assert body["error"]["message"]


def test_missing_required_field_is_422(client, fake):
    payload = {key: value for key, value in VALID_PROFILE.items() if key != "first_name"}

    resp = client.post(f"{API}/me", json=payload, headers=AUTH_HEADERS)

    assert_validation_error(resp)
    assert fake.tables["profiles"] == []


@pytest.mark.parametrize("value", ["", "   "])
def test_blank_first_name_is_422(client, fake, value):
    resp = client.post(
        f"{API}/me", json={**VALID_PROFILE, "first_name": value}, headers=AUTH_HEADERS
    )

    assert_validation_error(resp)


def test_overlong_first_name_is_422(client, fake):
    resp = client.post(
        f"{API}/me",
        json={**VALID_PROFILE, "first_name": "x" * 51},
        headers=AUTH_HEADERS,
    )

    assert_validation_error(resp)


@pytest.mark.parametrize("value", ["female", "WOMAN", "prefer_not_to_say", 3, None])
def test_invalid_gender_is_422(client, fake, value):
    resp = client.post(
        f"{API}/me", json={**VALID_PROFILE, "gender": value}, headers=AUTH_HEADERS
    )

    assert_validation_error(resp)


@pytest.mark.parametrize("value", ["people", "men_and_women", "WOMEN", 0, None])
def test_invalid_seeking_gender_is_422(client, fake, value):
    resp = client.post(
        f"{API}/me",
        json={**VALID_PROFILE, "seeking_gender": value},
        headers=AUTH_HEADERS,
    )

    assert_validation_error(resp)


@pytest.mark.parametrize("value", ["marriage", "SERIOUS", "whatever", ""])
def test_invalid_relationship_intent_is_422(client, fake, value):
    resp = client.post(
        f"{API}/me",
        json={**VALID_PROFILE, "relationship_intent": value},
        headers=AUTH_HEADERS,
    )

    assert_validation_error(resp)


@pytest.mark.parametrize("value", [0, 9, -1, "third", 3.5])
def test_invalid_academic_year_is_422(client, fake, value):
    resp = client.post(
        f"{API}/me",
        json={**VALID_PROFILE, "academic_year": value},
        headers=AUTH_HEADERS,
    )

    assert_validation_error(resp)


@pytest.mark.parametrize(
    "value",
    [
        UNDER_18,  # turns 18 tomorrow — 17 today
        FUTURE_DATE,  # in the future
        PRE_1900,  # before 1900
        NOT_A_DATE,
    ],
)
def test_invalid_date_of_birth_is_422(client, fake, value):
    resp = client.post(
        f"{API}/me",
        json={**VALID_PROFILE, "date_of_birth": value},
        headers=AUTH_HEADERS,
    )

    assert_validation_error(resp)


def test_exactly_eighteen_today_is_accepted(client, fake):
    resp = client.post(
        f"{API}/me",
        json={**VALID_PROFILE, "date_of_birth": EIGHTEEN_TODAY.isoformat()},
        headers=AUTH_HEADERS,
    )

    assert resp.status_code == 201


@pytest.mark.parametrize("value", [99, 251, 0, "tall"])
def test_invalid_height_is_422(client, fake, value):
    resp = client.post(
        f"{API}/me", json={**VALID_PROFILE, "height_cm": value}, headers=AUTH_HEADERS
    )

    assert_validation_error(resp)


def test_null_height_is_accepted(client, fake):
    resp = client.post(
        f"{API}/me", json={**VALID_PROFILE, "height_cm": None}, headers=AUTH_HEADERS
    )

    assert resp.status_code == 201
    assert fake.tables["profiles"][0]["height_cm"] is None


def test_valid_height_bounds_are_accepted(client, fake):
    for height in (100, 250):
        fake = make_fake()
        app = create_app()
        app.dependency_overrides[get_supabase_service_client] = lambda f=fake: f
        client = TestClient(app)

        resp = client.post(
            f"{API}/me",
            json={**VALID_PROFILE, "height_cm": height},
            headers=AUTH_HEADERS,
        )
        assert resp.status_code == 201


def test_overlong_hometown_is_422(client, fake):
    resp = client.post(
        f"{API}/me",
        json={**VALID_PROFILE, "hometown": "x" * 101},
        headers=AUTH_HEADERS,
    )

    assert_validation_error(resp)


def test_overlong_bio_is_422(client, fake):
    resp = client.post(
        f"{API}/me", json={**VALID_PROFILE, "bio": "x" * 501}, headers=AUTH_HEADERS
    )

    assert_validation_error(resp)


@pytest.mark.parametrize("value", ["", "   "])
def test_blank_bio_is_422(client, fake, value):
    resp = client.post(
        f"{API}/me", json={**VALID_PROFILE, "bio": value}, headers=AUTH_HEADERS
    )

    assert_validation_error(resp)


# ---------------------------------------------------------------------------
# 6. University reference validation.
# ---------------------------------------------------------------------------


def test_unknown_university_is_422(client, fake):
    payload = {**VALID_PROFILE, "university_id": str(UNKNOWN_UNIVERSITY_ID)}

    resp = client.post(f"{API}/me", json=payload, headers=AUTH_HEADERS)

    assert_validation_error(resp)
    assert fake.tables["profiles"] == []


def test_malformed_university_id_is_422(client, fake):
    resp = client.post(
        f"{API}/me",
        json={**VALID_PROFILE, "university_id": "not-a-uuid"},
        headers=AUTH_HEADERS,
    )

    assert_validation_error(resp)


def test_put_unknown_university_is_422(client, fake):
    fake.tables["profiles"] = [stored_profile()]

    resp = client.put(
        f"{API}/me",
        json={**VALID_PROFILE, "university_id": str(UNKNOWN_UNIVERSITY_ID)},
        headers=AUTH_HEADERS,
    )

    assert_validation_error(resp)
    assert fake.tables["profiles"][0]["university_id"] == str(STATE_UNIVERSITY_ID)


def test_alternative_university_is_accepted(client, fake):
    payload = {**VALID_PROFILE, "university_id": str(TECH_UNIVERSITY_ID)}

    resp = client.post(f"{API}/me", json=payload, headers=AUTH_HEADERS)

    assert resp.status_code == 201
    assert fake.tables["profiles"][0]["university_id"] == str(TECH_UNIVERSITY_ID)


# ---------------------------------------------------------------------------
# 7. Response shape — client-safe fields only.
# ---------------------------------------------------------------------------


def test_profile_response_shape_is_correct(client, fake):
    fake.tables["profiles"] = [stored_profile()]

    resp = client.get(f"{API}/me", headers=AUTH_HEADERS)

    assert resp.status_code == 200
    body = resp.json()
    assert set(body.keys()) == PROFILE_RESPONSE_KEYS
    assert "auth_user_id" not in body
    assert "storage_path" not in body
    assert isinstance(body["profile_prompts"], list)
    assert isinstance(body["social_links"], dict)


def test_post_response_shape_is_correct(client, fake):
    resp = client.post(f"{API}/me", json=VALID_PROFILE, headers=AUTH_HEADERS)

    assert resp.status_code == 201
    body = resp.json()
    assert set(body.keys()) == PROFILE_RESPONSE_KEYS
    assert "auth_user_id" not in body
    assert body["profile_prompts"] == []
    assert body["social_links"] == {}


# ---------------------------------------------------------------------------
# 8. University catalog endpoint — read-only, authenticated.
# ---------------------------------------------------------------------------


def test_universities_unauthenticated_is_rejected(client):
    resp = client.get(UNIVERSITIES_API)

    assert resp.status_code == 401
    assert resp.json()["error"]["code"] == "unauthorized"


def test_universities_returns_catalog_in_name_order(client, fake):
    resp = client.get(UNIVERSITIES_API, headers=AUTH_HEADERS)

    assert resp.status_code == 200
    body = resp.json()
    assert [uni["name"] for uni in body] == ["Bay Tech", "State University"]
    assert set(body[0].keys()) == {"id", "name", "city", "state", "country"}


def test_universities_cannot_be_created(client, fake):
    resp = client.post(
        UNIVERSITIES_API,
        json={
            "name": "Hacker U",
            "city": "Nowhere",
            "state": None,
            "country": "USA",
        },
        headers=AUTH_HEADERS,
    )

    assert resp.status_code in (401, 405)
    assert fake.tables["universities"] == [dict(row) for row in UNIVERSITY_ROWS]


# ---------------------------------------------------------------------------
# 9. Phase 9.3 — academic year 1–6, motivations, custom interests.
# ---------------------------------------------------------------------------


def stored_custom_interest(profile_id, interest_id, name):
    return {
        "id": str(interest_id),
        "profile_id": str(profile_id),
        "name": name,
        "created_at": "2026-08-28T09:00:00+00:00",
        "updated_at": "2026-08-28T09:00:00+00:00",
    }


@pytest.mark.parametrize("value", [7, 8])
def test_academic_year_seven_and_eight_are_422(client, fake, value):
    resp = client.post(
        f"{API}/me", json={**VALID_PROFILE, "academic_year": value}, headers=AUTH_HEADERS
    )

    assert_validation_error(resp)
    assert fake.tables["profiles"] == []


def test_academic_year_six_is_accepted(client, fake):
    resp = client.post(
        f"{API}/me", json={**VALID_PROFILE, "academic_year": 6}, headers=AUTH_HEADERS
    )

    assert resp.status_code == 201
    assert fake.tables["profiles"][0]["academic_year"] == 6


def test_motivations_are_persisted_on_create_and_update(client, fake):
    payload = {
        **VALID_PROFILE,
        "motivations": ["dating", "making_friends"],
    }

    resp = client.post(f"{API}/me", json=payload, headers=AUTH_HEADERS)

    assert resp.status_code == 201
    assert resp.json()["motivations"] == ["dating", "making_friends"]
    assert fake.tables["profiles"][0]["motivations"] == ["dating", "making_friends"]

    fake.tables["profiles"] = [stored_profile()]
    update_resp = client.put(
        f"{API}/me",
        json={**VALID_PROFILE, "motivations": ["confidence_and_communication"]},
        headers=AUTH_HEADERS,
    )

    assert update_resp.status_code == 200
    assert update_resp.json()["motivations"] == ["confidence_and_communication"]


def test_omitted_motivations_default_to_empty_list(client, fake):
    resp = client.post(f"{API}/me", json=VALID_PROFILE, headers=AUTH_HEADERS)

    assert resp.status_code == 201
    assert resp.json()["motivations"] == []


def test_explicitly_empty_motivations_are_422(client, fake):
    # Omission is backward-compatible, but an explicit empty selection is not
    # a valid value — when supplied, 1-3 motivations are required.
    resp = client.post(
        f"{API}/me", json={**VALID_PROFILE, "motivations": []}, headers=AUTH_HEADERS
    )

    assert_validation_error(resp)


@pytest.mark.parametrize(
    "value",
    ["friendship", "DATING", "dating ", None, 3, ["dating", "dating"]],
)
def test_invalid_motivations_are_422(client, fake, value):
    resp = client.post(
        f"{API}/me", json={**VALID_PROFILE, "motivations": value}, headers=AUTH_HEADERS
    )

    assert_validation_error(resp)
    assert fake.tables["profiles"] == []


def test_too_many_motivations_are_422(client, fake):
    resp = client.post(
        f"{API}/me",
        json={
            **VALID_PROFILE,
            "motivations": [
                "dating",
                "making_friends",
                "confidence_and_communication",
                "dating",
            ],
        },
        headers=AUTH_HEADERS,
    )

    # The duplicate is caught first; either way this is a structured 422.
    assert_validation_error(resp)


def test_custom_interests_are_created_and_returned_with_custom_source(client, fake):
    payload = {
        **VALID_PROFILE,
        "interest_ids": [str(STATE_UNIVERSITY_ID)][:0]
        + [],  # no catalog interests
        "custom_interest_names": ["Indie Game Design", "Street Photography"],
    }

    resp = client.post(f"{API}/me", json=payload, headers=AUTH_HEADERS)

    assert resp.status_code == 201
    body = resp.json()
    custom = [entry for entry in body["interests"] if entry["source"] == "custom"]
    assert [entry["name"] for entry in custom] == [
        "Indie Game Design",
        "Street Photography",
    ]
    rows = fake.tables["custom_interests"]
    assert len(rows) == 2
    assert all(
        row["profile_id"] == fake.tables["profiles"][0]["id"] for row in rows
    )


def test_custom_interest_names_are_trimmed(client, fake):
    payload = {**VALID_PROFILE, "custom_interest_names": ["  Kite Building  "]}

    resp = client.post(f"{API}/me", json=payload, headers=AUTH_HEADERS)

    assert resp.status_code == 201
    assert fake.tables["custom_interests"][0]["name"] == "Kite Building"


@pytest.mark.parametrize(
    "value",
    ["", "   ", "x" * 41],
)
def test_invalid_custom_interest_names_are_422(client, fake, value):
    payload = {**VALID_PROFILE, "custom_interest_names": [value]}

    resp = client.post(f"{API}/me", json=payload, headers=AUTH_HEADERS)

    assert_validation_error(resp)
    assert fake.tables["custom_interests"] == []


def test_duplicate_custom_interest_names_case_insensitive_are_422(client, fake):
    payload = {
        **VALID_PROFILE,
        "custom_interest_names": ["Pottery", "POTTERY"],
    }

    resp = client.post(f"{API}/me", json=payload, headers=AUTH_HEADERS)

    assert_validation_error(resp)


def test_custom_interest_matching_catalog_name_is_422(client, fake):
    fake.tables["interests"] = [
        {"id": str(uuid4()), "name": "Gaming"},
    ]
    payload = {**VALID_PROFILE, "custom_interest_names": ["gaming"]}

    resp = client.post(f"{API}/me", json=payload, headers=AUTH_HEADERS)

    assert_validation_error(resp)
    assert fake.tables["custom_interests"] == []


def test_combined_interest_limit_of_eight_is_enforced(client, fake):
    catalog_ids = [str(uuid4()) for _ in range(5)]
    fake.tables["interests"] = [
        {"id": interest_id, "name": f"Interest {index}"}
        for index, interest_id in enumerate(catalog_ids)
    ]
    payload = {
        **VALID_PROFILE,
        "interest_ids": catalog_ids,
        "custom_interest_names": ["One", "Two", "Three", "Four"],
    }

    resp = client.post(f"{API}/me", json=payload, headers=AUTH_HEADERS)

    assert_validation_error(resp)
    assert fake.tables["profiles"] == []
    assert fake.tables["custom_interests"] == []


def test_combined_interest_limit_boundary_is_accepted(client, fake):
    catalog_ids = [str(uuid4()) for _ in range(4)]
    fake.tables["interests"] = [
        {"id": interest_id, "name": f"Interest {index}"}
        for index, interest_id in enumerate(catalog_ids)
    ]
    payload = {
        **VALID_PROFILE,
        "interest_ids": catalog_ids,
        "custom_interest_names": ["One", "Two", "Three", "Four"],
    }

    resp = client.post(f"{API}/me", json=payload, headers=AUTH_HEADERS)

    assert resp.status_code == 201
    assert len(resp.json()["interests"]) == 8


def test_put_replaces_custom_interests_deleting_removed_and_creating_new(client, fake):
    fake.tables["profiles"] = [stored_profile()]
    fake.tables["custom_interests"] = [
        stored_custom_interest(
            STUDENT_PROFILE_ID, UUID("eeee0000-0000-0000-0000-000000000001"), "Old One"
        ),
        stored_custom_interest(
            STUDENT_PROFILE_ID, UUID("eeee0000-0000-0000-0000-000000000002"), "Kept"
        ),
    ]
    payload = {**VALID_PROFILE, "custom_interest_names": ["Kept", "Brand New"]}

    resp = client.put(f"{API}/me", json=payload, headers=AUTH_HEADERS)

    assert resp.status_code == 200
    names = sorted(
        row["name"] for row in fake.tables["custom_interests"]
    )
    assert names == ["Brand New", "Kept"]
    # Replace-set semantics: removed names are gone, the set matches exactly.
    assert "Old One" not in names


def test_put_with_empty_custom_interests_clears_them(client, fake):
    fake.tables["profiles"] = [stored_profile()]
    fake.tables["custom_interests"] = [
        stored_custom_interest(
            STUDENT_PROFILE_ID, UUID("eeee0000-0000-0000-0000-000000000003"), "Solo"
        ),
    ]
    payload = {**VALID_PROFILE, "custom_interest_names": []}

    resp = client.put(f"{API}/me", json=payload, headers=AUTH_HEADERS)

    assert resp.status_code == 200
    assert fake.tables["custom_interests"] == []
    assert [e["name"] for e in resp.json()["interests"]] == []


def test_custom_interests_are_scoped_to_the_callers_own_profile(client, fake):
    fake.tables["profiles"] = [
        stored_profile(),
        stored_profile(
            profile_id=OTHER_PROFILE_ID, auth_user_id=OTHER_AUTH_ID, first_name="Riley"
        ),
    ]
    fake.tables["custom_interests"] = [
        stored_custom_interest(
            STUDENT_PROFILE_ID, UUID("eeee0000-0000-0000-0000-000000000004"), "Mine"
        ),
        stored_custom_interest(
            OTHER_PROFILE_ID, UUID("eeee0000-0000-0000-0000-000000000005"), "Theirs"
        ),
    ]
    payload = {**VALID_PROFILE, "custom_interest_names": ["Mine", "Replacement"]}

    resp = client.put(f"{API}/me", json=payload, headers=AUTH_HEADERS)

    assert resp.status_code == 200
    # The caller's set was replaced; the other profile's rows are untouched.
    other_names = [
        row["name"]
        for row in fake.tables["custom_interests"]
        if row["profile_id"] == str(OTHER_PROFILE_ID)
    ]
    assert other_names == ["Theirs"]
    own_names = sorted(
        row["name"]
        for row in fake.tables["custom_interests"]
        if row["profile_id"] == str(STUDENT_PROFILE_ID)
    )
    assert own_names == ["Mine", "Replacement"]


def test_client_supplied_profile_id_cannot_hijack_custom_interests(client, fake):
    fake.tables["profiles"] = [
        stored_profile(),
        stored_profile(
            profile_id=OTHER_PROFILE_ID, auth_user_id=OTHER_AUTH_ID, first_name="Riley"
        ),
    ]
    payload = {
        **VALID_PROFILE,
        "profile_id": str(OTHER_PROFILE_ID),
        "custom_interest_names": ["Injected"],
    }

    resp = client.put(f"{API}/me", json=payload, headers=AUTH_HEADERS)

    assert resp.status_code == 200
    assert [
        row["profile_id"] for row in fake.tables["custom_interests"]
    ] == [str(STUDENT_PROFILE_ID)]


def test_get_returns_merged_interests_with_source_discriminator(client, fake):
    catalog_id = uuid4()
    fake.tables["profiles"] = [stored_profile()]
    fake.tables["interests"] = [{"id": str(catalog_id), "name": "Alpha Catalog"}]
    fake.tables["profile_interests"] = [
        {
            "profile_id": str(STUDENT_PROFILE_ID),
            "interest_id": str(catalog_id),
            "created_at": "2026-08-28T09:00:00+00:00",
        }
    ]
    fake.tables["custom_interests"] = [
        stored_custom_interest(
            STUDENT_PROFILE_ID, UUID("eeee0000-0000-0000-0000-000000000006"), "Beta Custom"
        ),
    ]

    resp = client.get(f"{API}/me", headers=AUTH_HEADERS)

    assert resp.status_code == 200
    assert resp.json()["interests"] == [
        {"id": str(catalog_id), "name": "Alpha Catalog", "source": "catalog"},
        {
            "id": "eeee0000-0000-0000-0000-000000000006",
            "name": "Beta Custom",
            "source": "custom",
        },
    ]
