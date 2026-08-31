"""Focused backend tests for Phase 8 — blocks & reports.

Scope: HTTP-level tests of THIS backend's logic — auth (401), the VERIFIED
gate for blocking/reporting (403), self/unknown/unverified targets (404,
no existence leak), idempotent re-blocking, reporter spoof immunity,
report validation (reason enum, detail trim/length, content pair, 422),
duplicate reports allowed, admin-only report listing (403 for non-staff),
and the two-direction block integration: discovery exclusion, like/pass
404, hidden matches/conversations on both sides, message read/send/mark-read
404, unmatch 404 while blocked, and full restoration after unblock.

Supabase is replaced at the `get_supabase_service_client` dependency boundary
with a small in-memory double implementing only the client surface the
backend uses (including working DELETE and blocks uniqueness). These are NOT
Supabase integration tests and never touch a network; the RLS/database-level
behavior is covered separately by supabase/tests/run-tests.mjs.
"""

from types import SimpleNamespace
from uuid import UUID, uuid4

import pytest
from fastapi.testclient import TestClient

from app.main import create_app
from app.services.supabase import get_supabase_service_client

BLOCKS_API = "/api/v1/blocks"
REPORTS_API = "/api/v1/reports"
ADMIN_REPORTS_API = "/api/v1/admin/reports"
FEED_API = "/api/v1/discovery/feed"
MATCHES_API = "/api/v1/matches"
CONVERSATIONS_API = "/api/v1/conversations"

VIEWER_AUTH_ID = UUID("11111111-1111-1111-1111-111111111111")
OTHER_AUTH_ID = UUID("22222222-2222-2222-2222-222222222222")
THIRD_AUTH_ID = UUID("55555555-5555-5555-5555-555555555555")
STAFF_AUTH_ID = UUID("77777777-7777-7777-7777-777777777777")
VIEWER_PROFILE_ID = UUID("33333333-3333-3333-3333-333333333333")
OTHER_PROFILE_ID = UUID("44444444-4444-4444-4444-444444444444")
THIRD_PROFILE_ID = UUID("66666666-6666-6666-6666-666666666666")
UNVERIFIED_PROFILE_ID = UUID("88888888-8888-8888-8888-888888888888")
STATE_UNIVERSITY_ID = UUID("aaaaaaaa-0000-0000-0000-000000000001")

VALID_TOKEN = "valid-access-token"
OTHER_TOKEN = "other-access-token"
THIRD_TOKEN = "third-access-token"
STAFF_TOKEN = "staff-access-token"

AUTH_HEADERS = {"Authorization": f"Bearer {VALID_TOKEN}"}
OTHER_HEADERS = {"Authorization": f"Bearer {OTHER_TOKEN}"}
THIRD_HEADERS = {"Authorization": f"Bearer {THIRD_TOKEN}"}
STAFF_HEADERS = {"Authorization": f"Bearer {STAFF_TOKEN}"}


# ---------------------------------------------------------------------------
# In-memory Supabase double (only the surface the backend uses).
# ---------------------------------------------------------------------------


class FakeResponse:
    def __init__(self, data):
        self.data = data


class DuplicateKeyError(RuntimeError):
    pass


class FakeTable:
    def __init__(self, tables, table_name, fail_tables):
        self._tables = tables
        self._table_name = table_name
        self._fail = table_name in fail_tables
        self._filters: dict = {}
        self._neq_filters: dict = {}
        self._in_filters: dict = {}
        self._is_filters: dict = {}
        self._or_filters: list = []
        self._orders: list = []
        self._limit: int | None = None
        self._single = False
        self._insert_rows = None
        self._update_values = None
        self._delete = False

    def select(self, _columns):
        return self

    def insert(self, rows):
        self._insert_rows = rows if isinstance(rows, list) else [rows]
        return self

    def update(self, values):
        self._update_values = values
        return self

    def delete(self):
        self._delete = True
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
        if self._table_name == "blocks":
            keys = {
                (str(r.get("blocker_profile_id")), str(r.get("blocked_profile_id")))
                for r in self._tables["blocks"]
            }
            for row in rows:
                key = (
                    str(row.get("blocker_profile_id")),
                    str(row.get("blocked_profile_id")),
                )
                if key in keys:
                    raise DuplicateKeyError(
                        'duplicate key value violates unique constraint '
                        '"blocks_blocker_blocked_unique"'
                    )
                keys.add(key)
        return True

    def execute(self):
        if self._fail:
            raise RuntimeError("database unavailable")

        if self._insert_rows is not None:
            prepared = []
            for row in self._insert_rows:
                row = {"id": str(uuid4()), **row, "created_at": "2026-08-30T10:00:00+00:00"}
                if self._table_name == "reports":
                    row.setdefault("status", "OPEN")  # DB default
                prepared.append(row)
            self._enforce_uniques(prepared)
            self._tables[self._table_name].extend(prepared)
            return FakeResponse([dict(row) for row in prepared])

        matched = [row for row in self._tables[self._table_name] if self._row_matches(row)]

        if self._delete:
            self._tables[self._table_name] = [
                row for row in self._tables[self._table_name] if row not in matched
            ]
            return FakeResponse([dict(row) for row in matched])

        if self._update_values is not None:
            for stored in matched:
                stored.update(self._update_values)
            return FakeResponse([dict(row) for row in matched])

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
        return {"signedUrl": f"https://storage.test/sign/{path}?token=x"}

    def get_signed_url(self, path, expires_in):
        return self.create_signed_url(path, expires_in)


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
            "messages": [],
            "blocks": [],
            "reports": [],
            "staff_admins": [],
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


def block_row(blocker_profile_id, blocked_profile_id):
    return {
        "id": str(uuid4()),
        "blocker_profile_id": str(blocker_profile_id),
        "blocked_profile_id": str(blocked_profile_id),
        "created_at": "2026-08-29T10:00:00+00:00",
    }


def report_row(
    reporter_profile_id,
    reported_profile_id,
    reason,
    created_at="2026-08-30T08:00:00+00:00",
    **overrides,
):
    row = {
        "id": str(uuid4()),
        "reporter_profile_id": str(reporter_profile_id),
        "reported_profile_id": str(reported_profile_id),
        "reason": reason,
        "detail": None,
        "content_type": None,
        "content_id": None,
        "status": "OPEN",
        "created_at": created_at,
    }
    row.update(overrides)
    return row


def match_row(match_id, user_a, user_b, created_at="2026-08-30T10:00:00+00:00"):
    return {
        "id": str(match_id),
        "user_a_id": str(user_a),
        "user_b_id": str(user_b),
        "created_at": created_at,
        "unmatched_at": None,
    }


def message_row(match_id, sender_profile_id, body):
    return {
        "id": str(uuid4()),
        "match_id": str(match_id),
        "sender_profile_id": str(sender_profile_id),
        "body": body,
        "created_at": "2026-08-30T11:00:00+00:00",
    }


def populated_fake():
    """Viewer (woman, seeks men, VERIFIED) + two verified men + one unverified
    man, with the staff registry present."""
    fake = FakeSupabase(
        {
            VALID_TOKEN: str(VIEWER_AUTH_ID),
            OTHER_TOKEN: str(OTHER_AUTH_ID),
            THIRD_TOKEN: str(THIRD_AUTH_ID),
            STAFF_TOKEN: str(STAFF_AUTH_ID),
        }
    )
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
        profile_row(UNVERIFIED_PROFILE_ID, uuid4(), first_name="Ghost"),
    ]
    fake.tables["universities"] = [university_row()]
    fake.tables["verification_submissions"] = [
        submission_row(VIEWER_PROFILE_ID, "VERIFIED"),
        submission_row(OTHER_PROFILE_ID, "VERIFIED"),
        submission_row(THIRD_PROFILE_ID, "VERIFIED"),
        submission_row(UNVERIFIED_PROFILE_ID, "PENDING"),
    ]
    fake.tables["staff_admins"] = [{"auth_user_id": str(STAFF_AUTH_ID)}]
    return fake


@pytest.fixture()
def fake():
    return populated_fake()


@pytest.fixture()
def client(fake):
    app = create_app()
    app.dependency_overrides[get_supabase_service_client] = lambda: fake
    return TestClient(app)


def block_payload(target=OTHER_PROFILE_ID):
    return {"target_profile_id": str(target)}


def report_payload(target=OTHER_PROFILE_ID, **overrides):
    payload = {"reported_profile_id": str(target), "reason": "harassment"}
    payload.update(overrides)
    return payload


def matched_match_id(fake, user_a, user_b):
    smaller, larger = sorted((str(user_a), str(user_b)))
    return str(uuid4())


# ---------------------------------------------------------------------------
# 1. Authentication.
# ---------------------------------------------------------------------------


def test_unauthenticated_block_is_rejected(client):
    resp = client.post(BLOCKS_API, json=block_payload())
    assert resp.status_code == 401
    assert resp.json()["error"]["code"] == "unauthorized"


def test_unauthenticated_report_is_rejected(client):
    resp = client.post(REPORTS_API, json=report_payload())
    assert resp.status_code == 401


def test_invalid_token_is_rejected(client):
    resp = client.post(
        BLOCKS_API, json=block_payload(), headers={"Authorization": "Bearer nope"}
    )
    assert resp.status_code == 401


def test_unauthenticated_unblock_is_rejected(client):
    resp = client.delete(f"{BLOCKS_API}/{uuid4()}")
    assert resp.status_code == 401


def test_unauthenticated_blocks_me_is_rejected(client):
    resp = client.get(f"{BLOCKS_API}/me")
    assert resp.status_code == 401


# ---------------------------------------------------------------------------
# 2. Verification gate.
# ---------------------------------------------------------------------------


def test_unverified_viewer_cannot_block(client, fake):
    fake.tables["verification_submissions"] = [
        submission_row(VIEWER_PROFILE_ID, "PENDING")
    ]
    resp = client.post(BLOCKS_API, json=block_payload(), headers=AUTH_HEADERS)
    assert resp.status_code == 403
    assert resp.json()["error"]["code"] == "permission_denied"


def test_unverified_viewer_cannot_report(client, fake):
    fake.tables["verification_submissions"] = [
        submission_row(VIEWER_PROFILE_ID, "PENDING")
    ]
    resp = client.post(REPORTS_API, json=report_payload(), headers=AUTH_HEADERS)
    assert resp.status_code == 403


# ---------------------------------------------------------------------------
# 3. Block target gates (self / unknown / unverified → same 404).
# ---------------------------------------------------------------------------


def test_self_block_is_not_found(client):
    resp = client.post(BLOCKS_API, json=block_payload(VIEWER_PROFILE_ID), headers=AUTH_HEADERS)
    assert resp.status_code == 404
    assert resp.json()["error"]["code"] == "not_found"


def test_unknown_block_target_is_not_found(client):
    resp = client.post(BLOCKS_API, json=block_payload(uuid4()), headers=AUTH_HEADERS)
    assert resp.status_code == 404


def test_unverified_block_target_is_not_found(client):
    resp = client.post(
        BLOCKS_API, json=block_payload(UNVERIFIED_PROFILE_ID), headers=AUTH_HEADERS
    )
    assert resp.status_code == 404


# ---------------------------------------------------------------------------
# 4. Block creation (identity, idempotency).
# ---------------------------------------------------------------------------


def test_block_succeeds_with_server_derived_blocker(client, fake):
    resp = client.post(BLOCKS_API, json=block_payload(), headers=AUTH_HEADERS)
    assert resp.status_code == 200
    body = resp.json()
    assert body["blocker_profile_id"] == str(VIEWER_PROFILE_ID)
    assert body["blocked_profile_id"] == str(OTHER_PROFILE_ID)
    assert body["id"] and body["created_at"]
    stored = fake.tables["blocks"][0]
    assert stored["blocker_profile_id"] == str(VIEWER_PROFILE_ID)
    assert stored["blocked_profile_id"] == str(OTHER_PROFILE_ID)


def test_reblocking_the_same_target_is_idempotent(client, fake):
    first = client.post(BLOCKS_API, json=block_payload(), headers=AUTH_HEADERS).json()
    second = client.post(BLOCKS_API, json=block_payload(), headers=AUTH_HEADERS)
    assert second.status_code == 200
    assert second.json()["id"] == first["id"]
    assert len(fake.tables["blocks"]) == 1


# ---------------------------------------------------------------------------
# 5. Block list and unblock (ownership).
# ---------------------------------------------------------------------------


def test_blocks_me_lists_only_outgoing_blocks(client, fake):
    fake.tables["blocks"] = [
        block_row(VIEWER_PROFILE_ID, OTHER_PROFILE_ID),
        block_row(OTHER_PROFILE_ID, THIRD_PROFILE_ID),
    ]
    resp = client.get(f"{BLOCKS_API}/me", headers=AUTH_HEADERS)
    assert resp.status_code == 200
    blocks = resp.json()["blocks"]
    assert len(blocks) == 1
    assert blocks[0]["profile_id"] == str(OTHER_PROFILE_ID)
    assert blocks[0]["first_name"] == "Adam"
    assert set(blocks[0].keys()) == {"id", "profile_id", "first_name", "created_at"}


def test_unblock_own_block_succeeds(client, fake):
    client.post(BLOCKS_API, json=block_payload(), headers=AUTH_HEADERS)
    resp = client.delete(f"{BLOCKS_API}/{OTHER_PROFILE_ID}", headers=AUTH_HEADERS)
    assert resp.status_code == 200
    assert resp.json() == {
        "profile_id": str(OTHER_PROFILE_ID),
        "unblocked": True,
    }
    assert fake.tables["blocks"] == []


def test_unblock_without_a_block_is_not_found(client):
    resp = client.delete(f"{BLOCKS_API}/{OTHER_PROFILE_ID}", headers=AUTH_HEADERS)
    assert resp.status_code == 404


def test_another_user_cannot_unblock_someone_elses_block(client, fake):
    fake.tables["blocks"] = [block_row(VIEWER_PROFILE_ID, OTHER_PROFILE_ID)]
    resp = client.delete(f"{BLOCKS_API}/{OTHER_PROFILE_ID}", headers=THIRD_HEADERS)
    assert resp.status_code == 404
    assert len(fake.tables["blocks"]) == 1


# ---------------------------------------------------------------------------
# 6. Reports.
# ---------------------------------------------------------------------------


def test_report_succeeds_and_returns_only_a_receipt(client, fake):
    resp = client.post(REPORTS_API, json=report_payload(), headers=AUTH_HEADERS)
    assert resp.status_code == 201
    body = resp.json()
    assert set(body.keys()) == {"id", "status", "created_at"}
    assert body["status"] == "OPEN"
    stored = fake.tables["reports"][0]
    assert stored["reporter_profile_id"] == str(VIEWER_PROFILE_ID)
    assert stored["reported_profile_id"] == str(OTHER_PROFILE_ID)
    assert stored["reason"] == "harassment"


def test_duplicate_reports_are_allowed(client, fake):
    for _ in range(2):
        resp = client.post(REPORTS_API, json=report_payload(), headers=AUTH_HEADERS)
        assert resp.status_code == 201
    assert len(fake.tables["reports"]) == 2


def test_report_with_invalid_reason_is_rejected(client):
    resp = client.post(
        REPORTS_API, json=report_payload(reason="because"), headers=AUTH_HEADERS
    )
    assert resp.status_code == 422
    assert resp.json()["error"]["code"] == "validation_error"


def test_report_with_overlong_detail_is_rejected(client):
    resp = client.post(
        REPORTS_API,
        json=report_payload(detail="x" * 1001),
        headers=AUTH_HEADERS,
    )
    assert resp.status_code == 422


def test_report_detail_is_trimmed_and_empty_becomes_null(client, fake):
    resp = client.post(
        REPORTS_API, json=report_payload(detail="   "), headers=AUTH_HEADERS
    )
    assert resp.status_code == 201
    assert fake.tables["reports"][0]["detail"] is None


def test_report_content_reference_is_nullable_as_a_pair(client, fake):
    missing_id = client.post(
        REPORTS_API,
        json=report_payload(content_type="message"),
        headers=AUTH_HEADERS,
    )
    assert missing_id.status_code == 422

    invalid_type = client.post(
        REPORTS_API,
        json=report_payload(content_type="story", content_id=str(uuid4())),
        headers=AUTH_HEADERS,
    )
    assert invalid_type.status_code == 422

    ok = client.post(
        REPORTS_API,
        json=report_payload(
            content_type="message", content_id=str(uuid4()), detail="See this"
        ),
        headers=AUTH_HEADERS,
    )
    assert ok.status_code == 201
    stored = fake.tables["reports"][-1]
    assert stored["content_type"] == "message"
    assert stored["content_id"]


def test_self_report_is_not_found(client):
    resp = client.post(
        REPORTS_API, json=report_payload(VIEWER_PROFILE_ID), headers=AUTH_HEADERS
    )
    assert resp.status_code == 404


def test_report_unknown_target_is_not_found(client):
    resp = client.post(REPORTS_API, json=report_payload(uuid4()), headers=AUTH_HEADERS)
    assert resp.status_code == 404


def test_report_target_merely_needs_to_exist(client, fake):
    resp = client.post(
        REPORTS_API, json=report_payload(UNVERIFIED_PROFILE_ID), headers=AUTH_HEADERS
    )
    assert resp.status_code == 201


# ---------------------------------------------------------------------------
# 7. Admin report viewing (staff-only).
# ---------------------------------------------------------------------------


def test_admin_reports_require_staff(client):
    resp = client.get(ADMIN_REPORTS_API, headers=AUTH_HEADERS)
    assert resp.status_code == 403
    assert resp.json()["error"]["code"] == "permission_denied"


def test_admin_reports_are_newest_first_and_reviewer_safe(client, fake):
    fake.tables["reports"] = [
        report_row(
            VIEWER_PROFILE_ID,
            OTHER_PROFILE_ID,
            "harassment",
            created_at="2026-08-30T08:00:00+00:00",
        ),
        report_row(
            THIRD_PROFILE_ID,
            VIEWER_PROFILE_ID,
            "spam",
            created_at="2026-08-30T09:00:00+00:00",
            detail="Repeated messages",
        ),
    ]
    resp = client.get(ADMIN_REPORTS_API, headers=STAFF_HEADERS)
    assert resp.status_code == 200
    reports = resp.json()
    assert [r["reason"] for r in reports] == ["spam", "harassment"]
    assert reports[0]["detail"] == "Repeated messages"
    assert reports[0]["status"] == "OPEN"
    assert reports[0]["reporter"]["profile_id"] == str(THIRD_PROFILE_ID)
    assert reports[0]["reported"]["first_name"] == "Jamie"
    assert reports[0]["reported"]["university"]["name"] == "State University"


# ---------------------------------------------------------------------------
# 8. Block integration — discovery.
# ---------------------------------------------------------------------------


def feed_candidate_ids(client, headers=AUTH_HEADERS):
    resp = client.get(FEED_API, headers=headers)
    assert resp.status_code == 200
    return [candidate["id"] for candidate in resp.json()["candidates"]]


def test_discovery_feed_excludes_blocked_candidates_in_both_directions(client, fake):
    assert set(feed_candidate_ids(client)) == {
        str(OTHER_PROFILE_ID),
        str(THIRD_PROFILE_ID),
    }

    # The viewer blocked Adam…
    fake.tables["blocks"].append(block_row(VIEWER_PROFILE_ID, OTHER_PROFILE_ID))
    assert set(feed_candidate_ids(client)) == {str(THIRD_PROFILE_ID)}

    # …and Ben blocked the viewer.
    fake.tables["blocks"].append(block_row(THIRD_PROFILE_ID, VIEWER_PROFILE_ID))
    assert feed_candidate_ids(client) == []


def test_like_and_pass_cannot_cross_an_active_block(client, fake):
    fake.tables["blocks"].append(block_row(VIEWER_PROFILE_ID, OTHER_PROFILE_ID))
    like = client.post(
        f"/api/v1/discovery/{OTHER_PROFILE_ID}/like", headers=AUTH_HEADERS
    )
    assert like.status_code == 404
    passed = client.post(
        f"/api/v1/discovery/{OTHER_PROFILE_ID}/pass", headers=AUTH_HEADERS
    )
    assert passed.status_code == 404
    assert fake.tables["dating_actions"] == []


# ---------------------------------------------------------------------------
# 9. Block integration — matches, conversations, messages.
# ---------------------------------------------------------------------------


def build_blocked_conversation(fake):
    smaller, larger = sorted((str(VIEWER_PROFILE_ID), str(OTHER_PROFILE_ID)))
    match_id = str(uuid4())
    fake.tables["matches"].append(match_row(match_id, smaller, larger))
    fake.tables["messages"].append(message_row(match_id, OTHER_PROFILE_ID, "hello"))
    fake.tables["blocks"].append(block_row(VIEWER_PROFILE_ID, OTHER_PROFILE_ID))
    return match_id


def test_blocked_match_disappears_from_both_match_lists(client, fake):
    build_blocked_conversation(fake)
    for headers in (AUTH_HEADERS, OTHER_HEADERS):
        resp = client.get(MATCHES_API, headers=headers)
        assert resp.status_code == 200
        assert resp.json()["matches"] == []


def test_blocked_conversation_disappears_from_both_conversation_lists(client, fake):
    build_blocked_conversation(fake)
    for headers in (AUTH_HEADERS, OTHER_HEADERS):
        resp = client.get(CONVERSATIONS_API, headers=headers)
        assert resp.status_code == 200
        assert resp.json()["conversations"] == []


def test_blocked_messages_are_inaccessible_for_read_send_and_mark_read(client, fake):
    match_id = build_blocked_conversation(fake)

    history = client.get(f"{CONVERSATIONS_API}/{match_id}/messages", headers=AUTH_HEADERS)
    assert history.status_code == 404

    send = client.post(
        f"{CONVERSATIONS_API}/{match_id}/messages",
        json={"body": "still there?"},
        headers=AUTH_HEADERS,
    )
    assert send.status_code == 404

    mark = client.post(f"{CONVERSATIONS_API}/{match_id}/read", headers=AUTH_HEADERS)
    assert mark.status_code == 404

    # The blocked side experiences the identical silence.
    other_history = client.get(
        f"{CONVERSATIONS_API}/{match_id}/messages", headers=OTHER_HEADERS
    )
    assert other_history.status_code == 404


def test_unmatch_is_not_found_while_blocked(client, fake):
    match_id = build_blocked_conversation(fake)
    resp = client.delete(f"{MATCHES_API}/{match_id}", headers=AUTH_HEADERS)
    assert resp.status_code == 404
    assert fake.tables["matches"][0]["unmatched_at"] is None


def test_unblocking_restores_matches_conversations_and_messages(client, fake):
    match_id = build_blocked_conversation(fake)

    client.delete(f"{BLOCKS_API}/{OTHER_PROFILE_ID}", headers=AUTH_HEADERS)

    matches = client.get(MATCHES_API, headers=AUTH_HEADERS)
    assert [m["id"] for m in matches.json()["matches"]] == [match_id]

    conversations = client.get(CONVERSATIONS_API, headers=OTHER_HEADERS)
    assert [c["id"] for c in conversations.json()["conversations"]] == [match_id]

    history = client.get(
        f"{CONVERSATIONS_API}/{match_id}/messages", headers=AUTH_HEADERS
    )
    assert history.status_code == 200
    assert [m["body"] for m in history.json()["messages"]] == ["hello"]
