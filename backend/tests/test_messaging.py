"""Focused backend tests for Phase 7 — conversations & messages.

Scope: HTTP-level tests of THIS backend's logic — auth (401), the VERIFIED
caller gate (403), participant-only + active-match access (404: unknown,
nonparticipant, and unmatched conversations all look identical — an unmatch
makes the conversation inaccessible immediately), message body validation
(trim, 1..2000, 422), token-derived sender identity (spoof immunity),
immutable-history keyset pagination on (created_at, id), per-participant
unread counters (increment on send via the atomic RPC, zero on mark-read,
caller-side counts in the conversation list), payload safety, and that the
matched partner's later verification status is NOT re-checked.

Supabase is replaced at the `get_supabase_service_client` dependency boundary
with a small in-memory double implementing only the client surface the
backend uses (including the send_conversation_message RPC). These are NOT
Supabase integration tests and never touch a network.
"""

from types import SimpleNamespace
from uuid import UUID, uuid4

import pytest
from fastapi.testclient import TestClient

from app.main import create_app
from app.services.supabase import get_supabase_service_client

CONVERSATIONS_API = "/api/v1/conversations"

VIEWER_AUTH_ID = UUID("11111111-1111-1111-1111-111111111111")
PARTNER_AUTH_ID = UUID("22222222-2222-2222-2222-222222222222")
THIRD_AUTH_ID = UUID("55555555-5555-5555-5555-555555555555")
VIEWER_PROFILE_ID = UUID("33333333-3333-3333-3333-333333333333")
PARTNER_PROFILE_ID = UUID("44444444-4444-4444-4444-444444444444")
THIRD_PROFILE_ID = UUID("66666666-6666-6666-6666-666666666666")
STATE_UNIVERSITY_ID = UUID("aaaaaaaa-0000-0000-0000-000000000001")

VALID_TOKEN = "valid-access-token"
PARTNER_TOKEN = "partner-access-token"
THIRD_TOKEN = "third-access-token"

AUTH_HEADERS = {"Authorization": f"Bearer {VALID_TOKEN}"}
PARTNER_HEADERS = {"Authorization": f"Bearer {PARTNER_TOKEN}"}
THIRD_HEADERS = {"Authorization": f"Bearer {THIRD_TOKEN}"}


# ---------------------------------------------------------------------------
# In-memory Supabase double (only the surface the backend uses).
# ---------------------------------------------------------------------------


class FakeResponse:
    def __init__(self, data):
        self.data = data


class FakeTable:
    def __init__(self, tables, table_name, fail_tables, state):
        self._tables = tables
        self._table_name = table_name
        self._fail = table_name in fail_tables
        self._state = state
        self._filters: dict = {}
        self._in_filters: dict = {}
        self._is_filters: dict = {}
        self._or_filters: list = []
        self._orders: list = []
        self._limit: int | None = None
        self._single = False
        self._insert_rows = None
        self._update_values = None
        state["queries"][table_name] = state["queries"].get(table_name, 0) + 1

    def select(self, _columns):
        return self

    def insert(self, rows):
        self._insert_rows = rows if isinstance(rows, list) else [rows]
        return self

    def update(self, values):
        self._update_values = values
        return self

    def eq(self, column, value):
        self._filters[column] = value
        return self

    def in_(self, column, values):
        self._in_filters[column] = list(values)
        return self

    def is_(self, column, value):
        self._is_filters[column] = value
        return self

    def or_(self, expr):
        # Supports "col.eq.v,col.eq.v" and the keyset form
        # "created_at.lt.v,and(created_at.eq.v,id.lt.v)" (top-level commas
        # respect parentheses).
        self._or_filters.extend(_parse_or(expr))
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

    def _row_matches(self, row):
        if not all(row.get(c) == v for c, v in self._filters.items()):
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
            _row_satisfies_conditions(row, group) for group in self._or_filters
        ):
            return False
        return True

    def execute(self):
        if self._fail:
            raise RuntimeError("database unavailable")

        if self._insert_rows is not None:
            prepared = []
            for row in self._insert_rows:
                row = {"id": str(uuid4()), **row, "created_at": "2026-08-30T10:00:00+00:00"}
                prepared.append(row)
            self._tables[self._table_name].extend(prepared)
            return FakeResponse([dict(row) for row in prepared])

        matched = [dict(row) for row in self._tables[self._table_name] if self._row_matches(row)]
        if self._update_values is not None:
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


def _split_top_level(expr: str) -> list[str]:
    parts, depth, current = [], 0, ""
    for char in expr:
        if char == "(":
            depth += 1
        elif char == ")":
            depth -= 1
        if char == "," and depth == 0:
            parts.append(current)
            current = ""
        else:
            current += char
    if current:
        parts.append(current)
    return [p.strip() for p in parts if p.strip()]


def _parse_or(expr: str) -> list[list[tuple[str, str, str]]]:
    """Parse an or_ expression into OR-alternatives of AND-conditions."""
    alternatives = []
    for part in _split_top_level(expr):
        if part.startswith("and(") and part.endswith(")"):
            conditions = [_parse_condition(c) for c in _split_top_level(part[4:-1])]
        else:
            conditions = [_parse_condition(part)]
        alternatives.append(conditions)
    return alternatives


def _parse_condition(condition: str) -> tuple[str, str, str]:
    column, op, value = condition.split(".", 2)
    return column, op, value


def _compare(left, op: str, right) -> bool:
    if op == "eq":
        return str(left) == str(right)
    if op == "lt":
        return str(left) < str(right)
    if op == "gt":
        return str(left) > str(right)
    raise AssertionError(f"unexpected operator in test double: {op}")


def _row_satisfies_conditions(row, conditions) -> bool:
    return all(
        _compare(row.get(column), op, value)
        for column, op, value in conditions
    )


class FakeSupabase:
    def __init__(self, users_by_token, fail_tables=frozenset()):
        self.tables = {
            "profiles": [],
            "universities": [],
            "verification_submissions": [],
            "profile_interests": [],
            "interests": [],
            "profile_photos": [],
            "matches": [],
            "messages": [],
            "blocks": [],
        }
        self._fail_tables = set(fail_tables)
        self._users_by_token = users_by_token
        self.auth = self
        self.state = {"signed": [], "fail_signing": False, "queries": {}, "msg_seq": 0}

    def get_user(self, jwt=None):
        user_id = self._users_by_token.get(jwt)
        if user_id is None:
            raise RuntimeError("invalid JWT")
        return SimpleNamespace(user=SimpleNamespace(id=user_id))

    def table(self, name):
        return FakeTable(self.tables, name, self._fail_tables, self.state)

    def rpc(self, name, params):
        return FakeRpc(self, name, params)

    @property
    def storage(self):
        return FakeStorage(self.state)


class FakeStorage:
    def __init__(self, state):
        self._state = state

    def from_(self, _bucket):
        return FakeSignedUrlBucket(self._state)


class FakeSignedUrlBucket:
    def __init__(self, state):
        self._state = state

    def create_signed_url(self, path, expires_in):
        self._state["signed"].append((path, expires_in))
        return {
            "signedUrl": f"https://storage.test/sign/{path}?token=x",
            "signedURL": f"https://storage.test/sign/{path}?token=x",
        }


class FakeRpc:
    """The send_conversation_message RPC: participant + active-match check,
    insert, and an atomic recipient-counter increment."""

    def __init__(self, fake, name, params):
        assert name == "send_conversation_message"
        self._fake = fake
        self._params = params

    def execute(self):
        fake = self._fake
        if fake._fail_tables:
            raise RuntimeError("database unavailable")
        match_id = self._params["p_match_id"]
        sender = self._params["p_sender_profile_id"]
        body = self._params["p_body"]

        # Mirror the DB CHECK: trimmed, 1..2000.
        assert body == body.strip() and 1 <= len(body) <= 2000, "body must be trimmed, 1..2000"

        match = next(
            (m for m in fake.tables["matches"] if str(m["id"]) == match_id), None
        )
        if (
            match is None
            or match.get("unmatched_at") is not None
            or sender not in (str(match["user_a_id"]), str(match["user_b_id"]))
        ):
            raise RuntimeError("sender is not an active participant of this match")

        fake.state["msg_seq"] += 1
        message = {
            "id": str(uuid4()),
            "match_id": match_id,
            "sender_profile_id": sender,
            "body": body,
            "created_at": f"2026-08-30T10:00:00.{fake.state['msg_seq'] * 1000:06d}+00:00",
        }
        fake.tables["messages"].append(message)

        recipient = (
            str(match["user_b_id"])
            if sender == str(match["user_a_id"])
            else str(match["user_a_id"])
        )
        if recipient == str(match["user_a_id"]):
            match["user_a_unread_count"] += 1
        else:
            match["user_b_unread_count"] += 1
        return FakeResponse([dict(message)])


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
    created_at="2026-08-01T09:00:00+00:00",
    **overrides,
):
    row = {
        "id": str(profile_id),
        "auth_user_id": str(auth_user_id),
        "first_name": first_name,
        "date_of_birth": "2001-05-10",
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


def match_row(match_id, user_a, user_b, created_at="2026-08-30T10:00:00+00:00"):
    return {
        "id": str(match_id),
        "user_a_id": str(user_a),
        "user_b_id": str(user_b),
        "created_at": created_at,
        "unmatched_at": None,
        "user_a_unread_count": 0,
        "user_b_unread_count": 0,
    }


def make_fake():
    return FakeSupabase(
        {
            VALID_TOKEN: str(VIEWER_AUTH_ID),
            PARTNER_TOKEN: str(PARTNER_AUTH_ID),
            THIRD_TOKEN: str(THIRD_AUTH_ID),
        }
    )


def make_verified_pair(fake, *, match_id=None):
    """Verified viewer + partner with an active match, plus a third user."""
    fake.tables["profiles"] = [
        profile_row(
            VIEWER_PROFILE_ID,
            VIEWER_AUTH_ID,
            first_name="Jamie",
            gender="woman",
            seeking_gender="men",
        ),
        profile_row(PARTNER_PROFILE_ID, PARTNER_AUTH_ID, first_name="Adam"),
        profile_row(THIRD_PROFILE_ID, THIRD_AUTH_ID, first_name="Ben"),
    ]
    fake.tables["verification_submissions"] = [
        submission_row(VIEWER_PROFILE_ID, "VERIFIED"),
        submission_row(PARTNER_PROFILE_ID, "VERIFIED"),
        submission_row(THIRD_PROFILE_ID, "VERIFIED"),
    ]
    fake.tables["matches"].append(
        match_row(match_id or MATCH_ID, VIEWER_PROFILE_ID, PARTNER_PROFILE_ID)
    )
    return fake


MATCH_ID = UUID("cccc0000-0000-0000-0000-000000000001")


def make_client(fake):
    app = create_app()
    app.dependency_overrides[get_supabase_service_client] = lambda: fake
    return TestClient(app)


@pytest.fixture()
def fake():
    return make_verified_pair(make_fake())


@pytest.fixture()
def client(fake):
    return make_client(fake)


def list_messages(client, conversation_id=MATCH_ID, headers=AUTH_HEADERS, **params):
    return client.get(
        f"{CONVERSATIONS_API}/{conversation_id}/messages", headers=headers, params=params
    )


def send(client, body, conversation_id=MATCH_ID, headers=AUTH_HEADERS, **extra_json):
    return client.post(
        f"{CONVERSATIONS_API}/{conversation_id}/messages",
        headers=headers,
        json={"body": body, **extra_json},
    )


def mark_read(client, conversation_id=MATCH_ID, headers=AUTH_HEADERS):
    return client.post(
        f"{CONVERSATIONS_API}/{conversation_id}/read", headers=headers
    )


# ---------------------------------------------------------------------------
# 1. Authentication.
# ---------------------------------------------------------------------------


def test_unauthenticated_requests_are_rejected(client, fake):
    # Raw client calls (the request helpers default to authed headers).
    assert client.get(CONVERSATIONS_API).status_code == 401
    assert client.get(f"{CONVERSATIONS_API}/{MATCH_ID}/messages").status_code == 401
    assert (
        client.post(
            f"{CONVERSATIONS_API}/{MATCH_ID}/messages", json={"body": "hi"}
        ).status_code
        == 401
    )
    assert client.post(f"{CONVERSATIONS_API}/{MATCH_ID}/read").status_code == 401
    assert fake.tables["messages"] == []


def test_invalid_token_is_rejected(client):
    resp = client.get(CONVERSATIONS_API, headers={"Authorization": "Bearer nope"})
    assert resp.status_code == 401
    assert resp.json()["error"]["code"] == "unauthorized"


# ---------------------------------------------------------------------------
# 2. Verification gate (caller only).
# ---------------------------------------------------------------------------


def _unverify_viewer(fake):
    fake.tables["verification_submissions"] = [
        submission_row(VIEWER_PROFILE_ID, "REJECTED")
    ]


def test_unverified_caller_cannot_list_conversations(client, fake):
    _unverify_viewer(fake)
    resp = client.get(CONVERSATIONS_API, headers=AUTH_HEADERS)
    assert resp.status_code == 403
    assert resp.json()["error"]["code"] == "permission_denied"
    assert "messaging" in resp.json()["error"]["message"]


def test_unverified_caller_cannot_read_or_send_or_mark_read(client, fake):
    _unverify_viewer(fake)
    assert list_messages(client).status_code == 403
    assert send(client, "hi").status_code == 403
    assert mark_read(client).status_code == 403
    assert fake.tables["messages"] == []


def test_partner_verification_is_not_rechecked(client, fake):
    # Decision: only the CALLER must be VERIFIED per request; the partner's
    # later verification status does not lock the conversation.
    fake.tables["verification_submissions"] = [
        submission_row(VIEWER_PROFILE_ID, "VERIFIED"),
        submission_row(PARTNER_PROFILE_ID, "REJECTED", submitted_at="2026-08-29T00:00:00+00:00"),
    ]
    assert send(client, "still here").status_code == 201
    assert list_messages(client).status_code == 200
    assert client.get(CONVERSATIONS_API, headers=AUTH_HEADERS).status_code == 200


def test_viewer_without_profile_is_403(client, fake):
    fake.tables["profiles"] = [
        p for p in fake.tables["profiles"] if p["id"] != str(VIEWER_PROFILE_ID)
    ]
    assert client.get(CONVERSATIONS_API, headers=AUTH_HEADERS).status_code == 403


# ---------------------------------------------------------------------------
# 3. Participant-only + active-match access (no existence leak).
# ---------------------------------------------------------------------------


def test_unknown_conversation_is_404(client):
    unknown = UUID("dddd0000-0000-0000-0000-000000000009")
    assert list_messages(client, unknown).status_code == 404
    assert send(client, "hi", unknown).status_code == 404
    assert mark_read(client, unknown).status_code == 404
    assert client.get(
        f"{CONVERSATIONS_API}/{unknown}/messages", headers=AUTH_HEADERS
    ).json()["error"]["code"] == "not_found"


def test_malformed_conversation_id_is_422(client):
    assert list_messages(client, "not-a-uuid").status_code == 422


def test_nonparticipant_gets_404_no_leak(client, fake):
    resp = list_messages(client, headers=THIRD_HEADERS)
    assert resp.status_code == 404
    assert send(client, "hi", headers=THIRD_HEADERS).status_code == 404
    assert mark_read(client, headers=THIRD_HEADERS).status_code == 404
    assert fake.tables["messages"] == []


def test_unmatched_conversation_is_inaccessible_immediately(client, fake):
    # Decision: the moment the match becomes inactive, the conversation is
    # inaccessible for reads, sends, and read-markers — but the rows remain.
    fake.tables["messages"].append(
        {
            "id": str(uuid4()),
            "match_id": str(MATCH_ID),
            "sender_profile_id": str(PARTNER_PROFILE_ID),
            "body": "before unmatch",
            "created_at": "2026-08-30T09:00:00+00:00",
        }
    )
    fake.tables["matches"][0]["unmatched_at"] = "2026-08-30T12:00:00+00:00"

    assert list_messages(client).status_code == 404
    assert send(client, "hi").status_code == 404
    assert mark_read(client).status_code == 404
    resp = client.get(CONVERSATIONS_API, headers=AUTH_HEADERS)
    assert resp.json()["conversations"] == []
    # Retained, not deleted.
    assert len(fake.tables["messages"]) == 1


def test_unverified_partner_cannot_use_the_conversation(client, fake):
    fake.tables["verification_submissions"] = [
        submission_row(PARTNER_PROFILE_ID, "PENDING")
    ]
    assert list_messages(client, headers=PARTNER_HEADERS).status_code == 403
    assert send(client, "hi", headers=PARTNER_HEADERS).status_code == 403


# ---------------------------------------------------------------------------
# 4. Conversation list.
# ---------------------------------------------------------------------------


def test_conversation_list_shape_and_unread(client, fake):
    fake.tables["matches"][0]["user_b_unread_count"] = 3
    resp = client.get(CONVERSATIONS_API, headers=AUTH_HEADERS)
    assert resp.status_code == 200
    body = resp.json()
    assert len(body["conversations"]) == 1
    entry = body["conversations"][0]
    assert set(entry.keys()) == {"id", "created_at", "unread_count", "profile"}
    assert entry["id"] == str(MATCH_ID)
    # The viewer is user_a; THEIR counter (incremented when the partner
    # sends) is user_a_unread_count. The partner's counter (3) is not the
    # viewer's unread count.
    assert entry["unread_count"] == 0
    profile = entry["profile"]
    assert profile["id"] == str(PARTNER_PROFILE_ID)
    assert profile["first_name"] == "Adam"


def test_conversation_unread_counts_are_caller_scoped(client, fake):
    fake.tables["matches"][0]["user_a_unread_count"] = 2
    fake.tables["matches"][0]["user_b_unread_count"] = 5

    viewer_entry = client.get(CONVERSATIONS_API, headers=AUTH_HEADERS).json()["conversations"][0]
    partner_entry = client.get(CONVERSATIONS_API, headers=PARTNER_HEADERS).json()["conversations"][0]
    assert viewer_entry["unread_count"] == 2
    assert partner_entry["unread_count"] == 5


def test_third_user_sees_no_conversations(client):
    resp = client.get(CONVERSATIONS_API, headers=THIRD_HEADERS)
    assert resp.status_code == 200
    assert resp.json()["conversations"] == []


def test_conversation_list_payload_is_safe(client, fake):
    fake.tables["profile_photos"] = [
        {
            "id": str(uuid4()),
            "profile_id": str(PARTNER_PROFILE_ID),
            "storage_path": "partner/photo-1.png",
            "position": 1,
            "is_primary": True,
        }
    ]
    body = str(client.get(CONVERSATIONS_API, headers=AUTH_HEADERS).json())
    for forbidden in ("auth_user_id", "date_of_birth", "storage_path", "seeking_gender", "VERIFIED"):
        assert forbidden not in body
    assert "storage.test/sign/partner" in body


# ---------------------------------------------------------------------------
# 5. Sending messages.
# ---------------------------------------------------------------------------


def test_send_message_happy_path(client, fake):
    resp = send(client, "Hey! Want to grab coffee?")
    assert resp.status_code == 201
    message = resp.json()
    assert message["body"] == "Hey! Want to grab coffee?"
    assert message["sender_profile_id"] == str(VIEWER_PROFILE_ID)
    assert message["is_own"] is True
    assert message["created_at"]

    assert len(fake.tables["messages"]) == 1
    # The recipient's unread counter incremented atomically.
    assert fake.tables["matches"][0]["user_b_unread_count"] == 1
    assert fake.tables["matches"][0]["user_a_unread_count"] == 0


def test_send_response_is_own_false_for_partner(client, fake):
    resp = send(client, "hi from Adam", headers=PARTNER_HEADERS)
    assert resp.status_code == 201
    assert resp.json()["is_own"] is True  # own from Adam's perspective
    assert fake.tables["matches"][0]["user_a_unread_count"] == 1


def test_send_body_is_trimmed(client, fake):
    resp = send(client, "   padded message   ")
    assert resp.status_code == 201
    assert resp.json()["body"] == "padded message"
    assert fake.tables["messages"][0]["body"] == "padded message"


def test_send_whitespace_only_is_422(client, fake):
    resp = send(client, "   \n\t  ")
    assert resp.status_code == 422
    assert resp.json()["error"]["code"] == "validation_error"
    assert fake.tables["messages"] == []


def test_send_empty_body_is_422(client):
    assert send(client, "").status_code == 422


def test_send_2000_chars_ok_2001_is_422(client, fake):
    assert send(client, "x" * 2000).status_code == 201
    resp = send(client, "x" * 2001)
    assert resp.status_code == 422
    assert resp.json()["error"]["code"] == "validation_error"
    assert len(fake.tables["messages"]) == 1


def test_send_missing_body_is_422(client):
    resp = client.post(
        f"{CONVERSATIONS_API}/{MATCH_ID}/messages", headers=AUTH_HEADERS, json={}
    )
    assert resp.status_code == 422


def test_sender_identity_comes_from_token_not_body(client, fake):
    resp = send(client, "spoof attempt", sender_profile_id=str(PARTNER_PROFILE_ID))
    assert resp.status_code == 201
    assert fake.tables["messages"][0]["sender_profile_id"] == str(VIEWER_PROFILE_ID)


def test_send_message_failure_is_503(client, fake):
    fake._fail_tables.add("matches")  # the RPC's counter update touches matches
    resp = send(client, "hi")
    assert resp.status_code == 503
    assert resp.json()["error"]["code"] in {"database_insert_failed", "database_unavailable"}
    # Nothing was half-written.
    assert fake.tables["messages"] == []


# ---------------------------------------------------------------------------
# 6. Message history + keyset pagination.
# ---------------------------------------------------------------------------


def _seed_messages(client, fake, count):
    """Alternate sends from both sides; returns nothing (rows are in fake)."""
    for i in range(count):
        headers = AUTH_HEADERS if i % 2 == 0 else PARTNER_HEADERS
        resp = send(client, f"message {i}", headers=headers)
        assert resp.status_code == 201


def test_history_empty_conversation(client):
    resp = list_messages(client)
    assert resp.status_code == 200
    assert resp.json() == {"messages": [], "next_cursor": None}


def test_history_newest_first_with_is_own(client, fake):
    _seed_messages(client, fake, 3)
    resp = list_messages(client)
    assert resp.status_code == 200
    messages = resp.json()["messages"]
    assert [m["body"] for m in messages] == ["message 2", "message 1", "message 0"]
    assert [m["is_own"] for m in messages] == [True, False, True]
    assert messages[0]["sender_profile_id"] == str(VIEWER_PROFILE_ID)
    assert set(messages[0].keys()) == {
        "id",
        "sender_profile_id",
        "is_own",
        "body",
        "created_at",
    }


def test_history_keyset_pagination_walk(client, fake):
    _seed_messages(client, fake, 7)
    collected = []
    cursor = None
    for _ in range(10):
        params = {"limit": 3}
        if cursor:
            params["cursor"] = cursor
        resp = list_messages(client, **params)
        assert resp.status_code == 200
        body = resp.json()
        collected.extend(m["body"] for m in body["messages"])
        cursor = body["next_cursor"]
        if cursor is None:
            break
    # Newest first, no gaps, no duplicates, everything accounted for.
    assert collected == [f"message {i}" for i in range(6, -1, -1)]


def test_history_pagination_is_stable_while_new_messages_arrive(client, fake):
    _seed_messages(client, fake, 4)
    first = list_messages(client, limit=2).json()
    assert [m["body"] for m in first["messages"]] == ["message 3", "message 2"]

    # A new message arrives before the client fetches the next page.
    assert send(client, "message 4").status_code == 201

    second = list_messages(client, limit=2, cursor=first["next_cursor"]).json()
    assert [m["body"] for m in second["messages"]] == ["message 1", "message 0"]
    # A full page always emits a cursor; the follow-up fetch ends the walk.
    assert second["next_cursor"] is not None
    third = list_messages(client, limit=2, cursor=second["next_cursor"]).json()
    assert third["messages"] == []
    assert third["next_cursor"] is None


def test_history_limit_validation(client):
    assert list_messages(client, limit=0).status_code == 422
    assert list_messages(client, limit=101).status_code == 422


def test_history_invalid_cursor_is_422(client):
    resp = list_messages(client, cursor="%%%not-base64%%%")
    assert resp.status_code == 422
    assert resp.json()["error"]["code"] == "validation_error"


def test_history_payload_is_safe(client, fake):
    _seed_messages(client, fake, 1)
    body = str(list_messages(client).json())
    assert "auth_user_id" not in body
    assert "date_of_birth" not in body


# ---------------------------------------------------------------------------
# 7. Read markers + polling flow.
# ---------------------------------------------------------------------------


def test_mark_read_zeroes_callers_counter_only(client, fake):
    fake.tables["matches"][0]["user_a_unread_count"] = 2
    fake.tables["matches"][0]["user_b_unread_count"] = 3

    resp = mark_read(client)
    assert resp.status_code == 200
    assert resp.json() == {"conversation_id": str(MATCH_ID), "unread_count": 0}
    assert fake.tables["matches"][0]["user_a_unread_count"] == 0
    assert fake.tables["matches"][0]["user_b_unread_count"] == 3

    # Partner marking read touches only their own counter.
    assert mark_read(client, headers=PARTNER_HEADERS).status_code == 200
    assert fake.tables["matches"][0]["user_b_unread_count"] == 0


def test_mark_read_is_idempotent(client):
    assert mark_read(client).status_code == 200
    assert mark_read(client).status_code == 200
    assert client.get(CONVERSATIONS_API, headers=AUTH_HEADERS).json()["conversations"][0][
        "unread_count"
    ] == 0


def test_polling_flow_end_to_end(client, fake):
    # 1. Partner sends two messages while the conversation is closed.
    assert send(client, "first", headers=PARTNER_HEADERS).status_code == 201
    assert send(client, "second", headers=PARTNER_HEADERS).status_code == 201

    # 2. The list shows unread_count 2 for the viewer.
    conversations = client.get(CONVERSATIONS_API, headers=AUTH_HEADERS).json()["conversations"]
    assert conversations[0]["unread_count"] == 2

    # 3. Opening the conversation: first poll returns the newest messages.
    page = list_messages(client).json()
    assert [m["body"] for m in page["messages"]] == ["second", "first"]
    assert page["next_cursor"] is None

    # 4. The client marks read → unread back to 0 in the list.
    assert mark_read(client).status_code == 200
    conversations = client.get(CONVERSATIONS_API, headers=AUTH_HEADERS).json()["conversations"]
    assert conversations[0]["unread_count"] == 0

    # 5. Partner replies; the next 5s poll picks it up, unread is 1 again.
    assert send(client, "third", headers=PARTNER_HEADERS).status_code == 201
    page = list_messages(client).json()
    assert [m["body"] for m in page["messages"]] == ["third", "second", "first"]
    conversations = client.get(CONVERSATIONS_API, headers=AUTH_HEADERS).json()["conversations"]
    assert conversations[0]["unread_count"] == 1


def test_database_failure_on_history_is_503(client, fake):
    fake._fail_tables.add("messages")
    assert list_messages(client).status_code == 503
    assert fake.tables["messages"] == []
