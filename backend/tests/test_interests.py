"""Focused backend tests for the interests slice.

Scope: the GET /api/v1/interests catalog endpoint and the interest
selection rules of the profile API (create / read / edit): catalog access,
deterministic ordering, valid selections, replace-set updates, validation
failures (unknown id, duplicates, more than 8), and token-only ownership —
client-supplied profile/auth identifiers never influence whose interests are
read or written.

Supabase is replaced at the `get_supabase_service_client` dependency boundary
with a small in-memory double implementing only the client surface the
backend uses. These are NOT Supabase integration tests and never touch a
network.
"""

from datetime import date
from types import SimpleNamespace
from uuid import UUID, uuid4

import pytest
from fastapi.testclient import TestClient

from app.main import create_app
from app.services.supabase import get_supabase_service_client

API = "/api/v1/profiles"
INTERESTS_API = "/api/v1/interests"

STUDENT_AUTH_ID = UUID("11111111-1111-1111-1111-111111111111")
OTHER_AUTH_ID = UUID("22222222-2222-2222-2222-222222222222")
STUDENT_PROFILE_ID = UUID("33333333-3333-3333-3333-333333333333")
OTHER_PROFILE_ID = UUID("44444444-4444-4444-4444-444444444444")
STATE_UNIVERSITY_ID = UUID("aaaaaaaa-0000-0000-0000-000000000001")

# Catalog ids — deliberately non-sequential so ordering tests cannot pass by
# accident of insertion order.
INTEREST_IDS = {
    name: UUID(f"cccc0000-0000-0000-0000-{number:012d}")
    for number, name in enumerate(
        [
            "Hiking",
            "Photography",
            "Cooking",
            "Board Games",
            "Live Music",
            "Reading",
            "Travel",
            "Gaming",
            "Football",
            "Basketball",
        ],
        start=1,
    )
}

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


EIGHTEEN_TODAY = _eighteenth_birthday_cutoff(TODAY)

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
]

# Scrambled on purpose: the catalog endpoint must still return name order.
INTEREST_ROWS = [
    {"id": str(INTEREST_IDS[name]), "name": name}
    for name in [
        "Travel",
        "Hiking",
        "Basketball",
        "Cooking",
        "Gaming",
        "Board Games",
        "Reading",
        "Live Music",
        "Photography",
        "Football",
    ]
]


def make_fake(*, profiles=None, fail_insert_with=None):
    fake = FakeSupabase(
        {VALID_TOKEN: str(STUDENT_AUTH_ID), OTHER_TOKEN: str(OTHER_AUTH_ID)},
        fail_insert_with=fail_insert_with,
    )
    fake.tables["universities"] = [dict(row) for row in UNIVERSITY_ROWS]
    fake.tables["interests"] = [dict(row) for row in INTEREST_ROWS]
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


def stored_link(profile_id, interest_name):
    return {
        "profile_id": str(profile_id),
        "interest_id": str(INTEREST_IDS[interest_name]),
        "created_at": "2026-08-28T09:00:00+00:00",
    }


@pytest.fixture()
def fake():
    return make_fake()


@pytest.fixture()
def client(fake):
    app = create_app()
    app.dependency_overrides[get_supabase_service_client] = lambda: fake
    return TestClient(app)


def link_pairs(fake):
    return sorted(
        (row["profile_id"], row["interest_id"]) for row in fake.tables["profile_interests"]
    )


# ---------------------------------------------------------------------------
# 1. GET /api/v1/interests — authenticated catalog access.
# ---------------------------------------------------------------------------


def test_interests_unauthenticated_is_rejected(client):
    resp = client.get(INTERESTS_API)

    assert resp.status_code == 401
    assert resp.json()["error"]["code"] == "unauthorized"


def test_interests_invalid_token_is_rejected(client):
    resp = client.get(INTERESTS_API, headers={"Authorization": "Bearer nope"})

    assert resp.status_code == 401
    assert resp.json()["error"]["code"] == "unauthorized"


def test_interests_returns_catalog_with_client_safe_fields(client):
    resp = client.get(INTERESTS_API, headers=AUTH_HEADERS)

    assert resp.status_code == 200
    body = resp.json()
    assert len(body) == len(INTEREST_ROWS)
    for entry in body:
        assert set(entry.keys()) == {"id", "name"}
    names = {entry["name"] for entry in body}
    assert names == set(INTEREST_IDS)


def test_interests_are_ordered_deterministically_by_name(client):
    resp = client.get(INTERESTS_API, headers=AUTH_HEADERS)

    assert resp.status_code == 200
    names = [entry["name"] for entry in resp.json()]
    assert names == sorted(names)


def test_interests_cannot_be_created(client, fake):
    resp = client.post(
        INTERESTS_API, json={"name": "Injected Interest"}, headers=AUTH_HEADERS
    )

    assert resp.status_code in (401, 405)
    assert fake.tables["interests"] == [dict(row) for row in INTEREST_ROWS]


# ---------------------------------------------------------------------------
# 2. Profile creation with interests.
# ---------------------------------------------------------------------------


def test_post_with_valid_interests_creates_profile_and_links(client, fake):
    payload = {
        **VALID_PROFILE,
        "interest_ids": [str(INTEREST_IDS["Hiking"]), str(INTEREST_IDS["Gaming"])],
    }

    resp = client.post(f"{API}/me", json=payload, headers=AUTH_HEADERS)

    assert resp.status_code == 201
    body = resp.json()
    assert body["interests"] == [
        {"id": str(INTEREST_IDS["Gaming"]), "name": "Gaming", "source": "catalog"},
        {"id": str(INTEREST_IDS["Hiking"]), "name": "Hiking", "source": "catalog"},
    ]
    profile = fake.tables["profiles"][0]
    assert profile["auth_user_id"] == str(STUDENT_AUTH_ID)
    assert link_pairs(fake) == sorted(
        [
            (profile["id"], str(INTEREST_IDS["Gaming"])),
            (profile["id"], str(INTEREST_IDS["Hiking"])),
        ]
    )


def test_post_without_interests_is_accepted(client, fake):
    resp = client.post(f"{API}/me", json=VALID_PROFILE, headers=AUTH_HEADERS)

    assert resp.status_code == 201
    assert resp.json()["interests"] == []
    assert fake.tables["profile_interests"] == []


def test_post_response_keys_include_interests(client, fake):
    resp = client.post(f"{API}/me", json=VALID_PROFILE, headers=AUTH_HEADERS)

    assert resp.status_code == 201
    assert set(resp.json().keys()) == PROFILE_RESPONSE_KEYS


# ---------------------------------------------------------------------------
# 3. Profile read returns selected interests.
# ---------------------------------------------------------------------------


def test_get_returns_selected_interests_ordered_by_name(client, fake):
    fake.tables["profiles"] = [stored_profile()]
    # Deliberately stored out of name order.
    fake.tables["profile_interests"] = [
        stored_link(STUDENT_PROFILE_ID, "Travel"),
        stored_link(STUDENT_PROFILE_ID, "Cooking"),
        stored_link(STUDENT_PROFILE_ID, "Board Games"),
    ]

    resp = client.get(f"{API}/me", headers=AUTH_HEADERS)

    assert resp.status_code == 200
    body = resp.json()
    assert [entry["name"] for entry in body["interests"]] == [
        "Board Games",
        "Cooking",
        "Travel",
    ]
    for entry in body["interests"]:
        assert set(entry.keys()) == {"id", "name", "source"}
        assert entry["source"] == "catalog"


def test_get_without_selection_returns_empty_interests(client, fake):
    fake.tables["profiles"] = [stored_profile()]

    resp = client.get(f"{API}/me", headers=AUTH_HEADERS)

    assert resp.status_code == 200
    assert resp.json()["interests"] == []


# ---------------------------------------------------------------------------
# 4. Profile update replaces the interest set.
# ---------------------------------------------------------------------------


def test_put_replaces_previous_interest_set(client, fake):
    fake.tables["profiles"] = [stored_profile()]
    fake.tables["profile_interests"] = [
        stored_link(STUDENT_PROFILE_ID, "Hiking"),
        stored_link(STUDENT_PROFILE_ID, "Gaming"),
    ]
    payload = {
        **VALID_PROFILE,
        "interest_ids": [
            str(INTEREST_IDS["Reading"]),
            str(INTEREST_IDS["Gaming"]),
            str(INTEREST_IDS["Travel"]),
        ],
    }

    resp = client.put(f"{API}/me", json=payload, headers=AUTH_HEADERS)

    assert resp.status_code == 200
    body = resp.json()
    assert [entry["name"] for entry in body["interests"]] == [
        "Gaming",
        "Reading",
        "Travel",
    ]
    profile_id = str(STUDENT_PROFILE_ID)
    assert link_pairs(fake) == sorted(
        [
            (profile_id, str(INTEREST_IDS["Gaming"])),
            (profile_id, str(INTEREST_IDS["Reading"])),
            (profile_id, str(INTEREST_IDS["Travel"])),
        ]
    )


def test_put_with_empty_selection_clears_interests(client, fake):
    fake.tables["profiles"] = [stored_profile()]
    fake.tables["profile_interests"] = [
        stored_link(STUDENT_PROFILE_ID, "Hiking"),
        stored_link(STUDENT_PROFILE_ID, "Gaming"),
    ]
    payload = {**VALID_PROFILE, "interest_ids": []}

    resp = client.put(f"{API}/me", json=payload, headers=AUTH_HEADERS)

    assert resp.status_code == 200
    assert resp.json()["interests"] == []
    assert fake.tables["profile_interests"] == []


def test_put_keeps_unrelated_profile_fields_untouched_by_interest_change(
    client, fake
):
    fake.tables["profiles"] = [stored_profile()]
    fake.tables["profile_interests"] = [stored_link(STUDENT_PROFILE_ID, "Hiking")]

    resp = client.put(f"{API}/me", json=VALID_PROFILE, headers=AUTH_HEADERS)

    assert resp.status_code == 200
    assert resp.json()["interests"] == []
    assert fake.tables["profile_interests"] == []
    row = fake.tables["profiles"][0]
    assert row["first_name"] == VALID_PROFILE["first_name"]
    assert row["bio"] == VALID_PROFILE["bio"]


# ---------------------------------------------------------------------------
# 5. Validation failures — structured 422 envelope.
# ---------------------------------------------------------------------------


def assert_validation_error(resp):
    assert resp.status_code == 422
    body = resp.json()
    assert body["error"]["code"] == "validation_error"
    assert body["error"]["message"]


def test_post_unknown_interest_id_is_422(client, fake):
    unknown = "dddddddd-0000-0000-0000-000000000001"
    payload = {
        **VALID_PROFILE,
        "interest_ids": [str(INTEREST_IDS["Hiking"]), unknown],
    }

    resp = client.post(f"{API}/me", json=payload, headers=AUTH_HEADERS)

    assert_validation_error(resp)
    # Nothing was created: the interest check happens before the insert.
    assert fake.tables["profiles"] == []
    assert fake.tables["profile_interests"] == []


def test_put_unknown_interest_id_is_422(client, fake):
    fake.tables["profiles"] = [stored_profile()]
    fake.tables["profile_interests"] = [stored_link(STUDENT_PROFILE_ID, "Hiking")]
    unknown = "dddddddd-0000-0000-0000-000000000002"
    payload = {**VALID_PROFILE, "interest_ids": [unknown]}

    resp = client.put(f"{API}/me", json=payload, headers=AUTH_HEADERS)

    assert_validation_error(resp)
    # The previous selection is untouched.
    assert link_pairs(fake) == [
        (str(STUDENT_PROFILE_ID), str(INTEREST_IDS["Hiking"]))
    ]


def test_duplicate_interest_ids_are_422(client, fake):
    payload = {
        **VALID_PROFILE,
        "interest_ids": [str(INTEREST_IDS["Hiking"]), str(INTEREST_IDS["Hiking"])],
    }

    resp = client.post(f"{API}/me", json=payload, headers=AUTH_HEADERS)

    assert_validation_error(resp)
    assert fake.tables["profiles"] == []
    assert fake.tables["profile_interests"] == []


def test_more_than_eight_interests_is_422(client, fake):
    too_many = [str(interest_id) for interest_id in list(INTEREST_IDS.values())[:9]]
    assert len(too_many) == 9
    payload = {**VALID_PROFILE, "interest_ids": too_many}

    resp = client.post(f"{API}/me", json=payload, headers=AUTH_HEADERS)

    assert_validation_error(resp)
    assert fake.tables["profiles"] == []
    assert fake.tables["profile_interests"] == []


def test_exactly_eight_interests_are_accepted(client, fake):
    eight = [str(interest_id) for interest_id in list(INTEREST_IDS.values())[:8]]
    assert len(eight) == 8
    payload = {**VALID_PROFILE, "interest_ids": eight}

    resp = client.post(f"{API}/me", json=payload, headers=AUTH_HEADERS)

    assert resp.status_code == 201
    assert len(resp.json()["interests"]) == 8
    assert len(fake.tables["profile_interests"]) == 8


def test_malformed_interest_id_is_422(client, fake):
    payload = {**VALID_PROFILE, "interest_ids": ["not-a-uuid"]}

    resp = client.post(f"{API}/me", json=payload, headers=AUTH_HEADERS)

    assert_validation_error(resp)


# ---------------------------------------------------------------------------
# 6. Ownership / authentication behavior.
# ---------------------------------------------------------------------------


def test_unauthenticated_write_cannot_set_interests(client, fake):
    payload = {
        **VALID_PROFILE,
        "interest_ids": [str(INTEREST_IDS["Hiking"])],
    }

    resp = client.post(f"{API}/me", json=payload)

    assert resp.status_code == 401
    assert resp.json()["error"]["code"] == "unauthorized"
    assert fake.tables["profiles"] == []
    assert fake.tables["profile_interests"] == []


def test_interests_are_scoped_to_the_callers_own_profile(client, fake):
    fake.tables["profiles"] = [
        stored_profile(),
        stored_profile(
            profile_id=OTHER_PROFILE_ID, auth_user_id=OTHER_AUTH_ID, first_name="Riley"
        ),
    ]
    fake.tables["profile_interests"] = [
        stored_link(STUDENT_PROFILE_ID, "Hiking"),
        stored_link(OTHER_PROFILE_ID, "Gaming"),
    ]

    # The other user replaces their own set; the caller's links are untouched.
    other_payload = {
        **VALID_PROFILE,
        "interest_ids": [str(INTEREST_IDS["Travel"])],
    }
    resp = client.put(f"{API}/me", json=other_payload, headers=OTHER_HEADERS)

    assert resp.status_code == 200
    assert [entry["name"] for entry in resp.json()["interests"]] == ["Travel"]
    assert link_pairs(fake) == sorted(
        [
            (str(STUDENT_PROFILE_ID), str(INTEREST_IDS["Hiking"])),
            (str(OTHER_PROFILE_ID), str(INTEREST_IDS["Travel"])),
        ]
    )


def test_client_supplied_profile_and_auth_ids_cannot_hijack_interests(client, fake):
    fake.tables["profiles"] = [
        stored_profile(),
        stored_profile(
            profile_id=OTHER_PROFILE_ID, auth_user_id=OTHER_AUTH_ID, first_name="Riley"
        ),
    ]
    fake.tables["profile_interests"] = [
        stored_link(STUDENT_PROFILE_ID, "Hiking"),
        stored_link(OTHER_PROFILE_ID, "Gaming"),
    ]
    payload = {
        **VALID_PROFILE,
        "profile_id": str(OTHER_PROFILE_ID),
        "auth_user_id": str(OTHER_AUTH_ID),
        "interest_ids": [str(INTEREST_IDS["Cooking"])],
    }

    resp = client.put(f"{API}/me", json=payload, headers=AUTH_HEADERS)

    assert resp.status_code == 200
    # Only the caller's own profile/links were touched; the other user's
    # Gaming link is intact.
    assert link_pairs(fake) == sorted(
        [
            (str(STUDENT_PROFILE_ID), str(INTEREST_IDS["Cooking"])),
            (str(OTHER_PROFILE_ID), str(INTEREST_IDS["Gaming"])),
        ]
    )


# ---------------------------------------------------------------------------
# 7. Phase 9.3 — custom interests alongside the catalog.
# ---------------------------------------------------------------------------


def stored_custom(profile_id, interest_id, name):
    return {
        "id": str(interest_id),
        "profile_id": str(profile_id),
        "name": name,
        "created_at": "2026-08-28T09:00:00+00:00",
        "updated_at": "2026-08-28T09:00:00+00:00",
    }


def test_custom_interests_merge_into_profile_interests_with_source(client, fake):
    fake.tables["profiles"] = [stored_profile()]
    fake.tables["profile_interests"] = [stored_link(STUDENT_PROFILE_ID, "Hiking")]
    fake.tables["custom_interests"] = [
        stored_custom(
            STUDENT_PROFILE_ID, uuid4(), "Zombie Films"
        ),
        stored_custom(
            STUDENT_PROFILE_ID, uuid4(), "Archery"
        ),
    ]

    resp = client.get(f"{API}/me", headers=AUTH_HEADERS)

    assert resp.status_code == 200
    body = resp.json()["interests"]
    # Merged and ordered by name across BOTH sources.
    assert [(entry["name"], entry["source"]) for entry in body] == [
        ("Archery", "custom"),
        ("Hiking", "catalog"),
        ("Zombie Films", "custom"),
    ]


def test_custom_interest_colliding_with_catalog_is_422_and_nothing_is_written(
    client, fake
):
    payload = {
        **VALID_PROFILE,
        "custom_interest_names": ["hiking"],  # catalog has "Hiking"
    }

    resp = client.post(f"{API}/me", json=payload, headers=AUTH_HEADERS)

    assert_validation_error(resp)
    assert fake.tables["profiles"] == []
    assert fake.tables["custom_interests"] == []


def test_custom_interest_case_insensitive_duplicates_in_one_request_are_422(
    client, fake
):
    payload = {
        **VALID_PROFILE,
        "custom_interest_names": ["Fencing", "FENCING"],
    }

    resp = client.post(f"{API}/me", json=payload, headers=AUTH_HEADERS)

    assert_validation_error(resp)


def test_put_replaces_custom_interests_as_a_set(client, fake):
    fake.tables["profiles"] = [stored_profile()]
    fake.tables["custom_interests"] = [
        stored_custom(STUDENT_PROFILE_ID, uuid4(), "Chess"),
        stored_custom(STUDENT_PROFILE_ID, uuid4(), "Skating"),
    ]
    payload = {**VALID_PROFILE, "custom_interest_names": ["Chess", "Beekeeping"]}

    resp = client.put(f"{API}/me", json=payload, headers=AUTH_HEADERS)

    assert resp.status_code == 200
    assert sorted(
        row["name"] for row in fake.tables["custom_interests"]
    ) == ["Beekeeping", "Chess"]


def test_custom_interests_are_scoped_to_the_callers_own_profile(client, fake):
    fake.tables["profiles"] = [
        stored_profile(),
        stored_profile(
            profile_id=OTHER_PROFILE_ID, auth_user_id=OTHER_AUTH_ID, first_name="Riley"
        ),
    ]
    fake.tables["custom_interests"] = [
        stored_custom(STUDENT_PROFILE_ID, uuid4(), "Mine"),
        stored_custom(OTHER_PROFILE_ID, uuid4(), "Theirs"),
    ]
    payload = {**VALID_PROFILE, "custom_interest_names": []}

    resp = client.put(f"{API}/me", json=payload, headers=AUTH_HEADERS)

    assert resp.status_code == 200
    # The caller's custom interests were cleared; the other profile's are intact.
    remaining = [(row["profile_id"], row["name"]) for row in fake.tables["custom_interests"]]
    assert remaining == [(str(OTHER_PROFILE_ID), "Theirs")]


def test_combined_catalog_and_custom_budget_is_enforced(client, fake):
    too_many_ids = [str(interest_id) for interest_id in list(INTEREST_IDS.values())[:7]]
    payload = {
        **VALID_PROFILE,
        "interest_ids": too_many_ids,
        "custom_interest_names": ["One", "Two"],
    }

    resp = client.post(f"{API}/me", json=payload, headers=AUTH_HEADERS)

    assert_validation_error(resp)
    assert fake.tables["profiles"] == []


def test_combined_catalog_and_custom_budget_boundary_is_accepted(client, fake):
    seven_ids = [str(interest_id) for interest_id in list(INTEREST_IDS.values())[:7]]
    payload = {
        **VALID_PROFILE,
        "interest_ids": seven_ids,
        "custom_interest_names": ["One"],
    }

    resp = client.post(f"{API}/me", json=payload, headers=AUTH_HEADERS)

    assert resp.status_code == 201
    assert len(resp.json()["interests"]) == 8
