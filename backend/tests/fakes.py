"""Shared in-memory Supabase double for the Phase 2 backend tests.

Implements only the client surface the Phase 2 code paths use: filtered
selects (eq / neq / in_ / is_ / or_ / ilike), ordering, limits, maybe_single,
insert / update / delete / upsert(ignore_duplicates), `count="exact"`, plus
`auth.get_user` and Storage signed-URL generation. Joined rows (a category
nested in an opportunity, a university nested in a profile) are supplied by
the test fixtures, exactly like the existing per-module test doubles.

These are NOT Supabase integration tests and never touch a network.
"""

from datetime import datetime, timezone
from types import SimpleNamespace
from typing import Any
from uuid import UUID, uuid4

import pytest
from fastapi import APIRouter
from fastapi.testclient import TestClient

from app.core.config import get_settings
from app.main import create_app
from app.services.supabase import get_supabase_service_client


class FakeResponse:
    def __init__(self, data, count=None):
        self.data = data
        self.count = count


class DuplicateKeyError(RuntimeError):
    pass


def _match_op(row: dict[str, Any], column: str, op: str, value: str) -> bool:
    actual = row.get(column)
    if op == "eq":
        return actual == value
    if op == "is":
        # `is.null` is the only form the backend builds.
        return (actual is None) if value == "null" else actual == value
    if op == "gt":
        return actual is not None and str(actual) > value
    if op == "lt":
        return actual is not None and str(actual) < value
    raise AssertionError(f"unsupported operator {op!r}")


def matches_or_filter(row: dict[str, Any], expr: str) -> bool:
    """Whether `row` satisfies a PostgREST `or_` expression.

    The backend builds two shapes of `or_`:

      * simple comma-separated `col.op.value` alternatives — e.g. the
        suspension filter `suspended_until.is.null,suspended_until.gt.<iso>`
        (indefinite or unexpired), and match/visibility lookups
        `user_a_id.eq.X,user_b_id.eq.X`;
      * keyset pagination `created_at.lt.V,and(created_at.eq.V,id.lt.V)`,
        where each alternative may itself be an `and(...)` conjunction.

    Per-module test doubles delegate here so the PostgREST subset the backend
    relies on has ONE definition in the tests, and the suspension model stays
    in step with `app.services.admin.active_suspension_filter`.
    """
    return any(
        all(_match_op(row, col, op, val) for col, op, val in _or_alternative(part))
        for part in _split_top_level(expr)
    )


def _split_top_level(expr: str) -> list[str]:
    """Split on commas that are not inside parentheses."""
    parts: list[str] = []
    depth = 0
    current = ""
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
    parts.append(current)
    return parts


def _or_alternative(part: str) -> list[tuple[str, str, str]]:
    """One `or_` alternative: `col.op.value`, or `and(...)` of those."""
    part = part.strip()
    if part.startswith("and(") and part.endswith(")"):
        return [
            _condition(cond) for cond in _split_top_level(part[len("and(") : -1])
        ]
    return [_condition(part)]


def _condition(condition: str) -> tuple[str, str, str]:
    column, op, value = condition.split(".", 2)
    return column, op, value


class FakeTable:
    def __init__(self, tables, table_name, state):
        self._tables = tables
        self._table_name = table_name
        self._state = state
        self._filters: dict[str, Any] = {}
        self._neq: dict[str, Any] = {}
        self._in: dict[str, list] = {}
        self._is_null: dict[str, bool] = {}
        self._ilike: list[tuple[str, str]] = []
        self._or_filters: list[str] = []
        self._orders: list[tuple[str, bool]] = []
        self._limit: int | None = None
        self._single = False
        self._count_exact = False
        self._insert_rows = None
        self._upsert_rows = None
        self._ignore_duplicates = False
        self._update_values = None
        self._is_delete = False
        state["queries"][table_name] = state["queries"].get(table_name, 0) + 1

    # --- builder ------------------------------------------------------------
    def select(self, _columns, count=None):
        self._count_exact = count == "exact"
        return self

    def insert(self, rows):
        self._insert_rows = rows if isinstance(rows, list) else [rows]
        return self

    def upsert(self, rows, ignore_duplicates=False, **_):
        self._upsert_rows = rows if isinstance(rows, list) else [rows]
        self._ignore_duplicates = ignore_duplicates
        return self

    def update(self, values):
        self._update_values = dict(values)
        return self

    def delete(self):
        self._is_delete = True
        return self

    def eq(self, column, value):
        self._filters[column] = value
        return self

    def neq(self, column, value):
        self._neq[column] = value
        return self

    def in_(self, column, values):
        self._in[column] = list(values)
        return self

    def is_(self, column, value):
        self._is_null[column] = value in (None, "null")
        return self

    def ilike(self, column, pattern):
        self._ilike.append((column, pattern))
        return self

    def or_(self, expr):
        self._or_filters.append(expr)
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

    # --- matching -----------------------------------------------------------
    def _row_matches(self, row: dict[str, Any]) -> bool:
        if not all(row.get(c) == v for c, v in self._filters.items()):
            return False
        if not all(row.get(c) != v for c, v in self._neq.items()):
            return False
        if not all(row.get(c) in values for c, values in self._in.items()):
            return False
        for column, want_null in self._is_null.items():
            if want_null and row.get(column) is not None:
                return False
            if not want_null and row.get(column) is None:
                return False
        for column, pattern in self._ilike:
            value = row.get(column) or ""
            needle = pattern.strip("%")
            if needle.lower() not in str(value).lower():
                return False
        for expr in self._or_filters:
            if not matches_or_filter(row, expr):
                return False
        return True

    # --- uniqueness ---------------------------------------------------------
    def _violates_unique(self, candidate: dict[str, Any]) -> str | None:
        name = self._table_name
        rows = self._tables[name]
        if name == "dating_actions":
            key = (
                candidate.get("actor_profile_id"),
                candidate.get("target_profile_id"),
                candidate.get("opportunity_id"),
            )
            for row in rows:
                if (
                    row.get("actor_profile_id"),
                    row.get("target_profile_id"),
                    row.get("opportunity_id"),
                ) == key:
                    return "dating_actions_actor_target_opportunity_unique"
        if name == "matches":
            key = (
                candidate.get("user_a_id"),
                candidate.get("user_b_id"),
                candidate.get("opportunity_id"),
            )
            for row in rows:
                if (
                    row.get("user_a_id"),
                    row.get("user_b_id"),
                    row.get("opportunity_id"),
                ) == key:
                    return "matches_pair_opportunity_unique"
        if name == "applications":
            key = (candidate.get("opportunity_id"), candidate.get("profile_id"))
            for row in rows:
                if (
                    row.get("opportunity_id"),
                    row.get("profile_id"),
                ) == key:
                    return "applications_opportunity_profile_key"
        if name == "categories":
            for row in rows:
                if str(row.get("name", "")).lower() == str(
                    candidate.get("name", "")
                ).lower():
                    return "categories_name_lower_key"
        if name == "activities":
            for row in rows:
                if row.get("category_id") == candidate.get("category_id") and str(
                    row.get("name", "")
                ).lower() == str(candidate.get("name", "")).lower():
                    return "activities_category_name_lower_key"
        if name == "blocks":
            for row in rows:
                if (
                    row.get("blocker_profile_id"),
                    row.get("blocked_profile_id"),
                ) == (
                    candidate.get("blocker_profile_id"),
                    candidate.get("blocked_profile_id"),
                ):
                    return "blocks_blocker_blocked_unique"
        return None

    def _violates_check(self, candidate: dict[str, Any]) -> str | None:
        """The subset of database CHECK constraints the service relies on."""
        if self._table_name == "suspensions":
            until = candidate.get("suspended_until")
            created = candidate.get("created_at") or "1970-01-01T00:00:00+00:00"
            if until is not None and str(until) <= str(created):
                return "suspensions_until_valid"
        if self._table_name == "opportunities":
            if candidate.get("status") not in (
                None,
                "DRAFT",
                "PUBLISHED",
                "PAUSED",
                "CANCELLED",
                "EXPIRED",
            ):
                return "opportunities_status_valid"
        return None

    # --- execution ----------------------------------------------------------
    def execute(self):
        if self._state.get("fail_tables") and self._table_name in self._state["fail_tables"]:
            raise RuntimeError("database unavailable")

        name = self._table_name
        stored = self._tables[name]

        if self._insert_rows is not None or self._upsert_rows is not None:
            rows = self._insert_rows if self._insert_rows is not None else self._upsert_rows
            prepared = []
            for row in rows:
                # created_at is assigned before the CHECKs, exactly as the
                # database does (default now() applies first).
                candidate = {
                    "id": str(uuid4()),
                    "created_at": datetime.now(timezone.utc).isoformat(),
                    **row,
                }
                violation = self._violates_check(candidate)
                if violation:
                    raise DuplicateKeyError(violation)
                violation = self._violates_unique(candidate)
                if violation:
                    if self._ignore_duplicates:
                        return FakeResponse([])
                    raise DuplicateKeyError(
                        f'duplicate key value violates unique constraint "{violation}"'
                    )
                prepared.append(candidate)
            stored.extend(prepared)
            return FakeResponse([dict(r) for r in prepared])

        if self._update_values is not None:
            updated = []
            for row in stored:
                if self._row_matches(row):
                    row.update(self._update_values)
                    updated.append(dict(row))
            return FakeResponse(updated)

        if self._is_delete:
            doomed = [row for row in stored if self._row_matches(row)]
            for row in doomed:
                stored.remove(row)
            return FakeResponse([dict(r) for r in doomed])

        matched = [dict(row) for row in stored if self._row_matches(row)]

        if self._count_exact:
            return FakeResponse(matched, count=len(matched))

        for column, desc in reversed(self._orders):
            matched.sort(
                key=lambda r: r.get(column) if r.get(column) is not None else "",
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
        self._state["signed"].append(path)
        return {"signedUrl": f"https://storage.test/sign/{path}?token=x"}


class FakeStorage:
    def __init__(self, state):
        self._state = state

    def from_(self, _bucket):
        return FakeSignedUrlBucket(self._state)


class FakeSupabase:
    """In-memory Supabase stand-in. `delete()` semantics are handled inside
    FakeTable.execute by tracking the delete intent."""

    TABLES = (
        "profiles",
        "universities",
        "verification_submissions",
        "verification_reviews",
        "profile_interests",
        "custom_interests",
        "interests",
        "profile_photos",
        "dating_actions",
        "matches",
        "messages",
        "blocks",
        "reports",
        "categories",
        "activities",
        "opportunities",
        "applications",
        "suspensions",
        "staff_admins",
    )

    def __init__(self, users_by_token, *, staff_ids=()):
        self.tables = {name: [] for name in self.TABLES}
        self._users_by_token = dict(users_by_token)
        self.tables["staff_admins"] = [
            {"auth_user_id": str(a), "created_at": "2026-01-01T00:00:00+00:00"}
            for a in staff_ids
        ]
        self.auth = self
        self.state: dict[str, Any] = {
            "signed": [],
            "queries": {},
            "fail_tables": set(),
        }

    def get_user(self, jwt=None):
        user_id = self._users_by_token.get(jwt)
        if user_id is None:
            raise RuntimeError("invalid JWT")
        return SimpleNamespace(user=SimpleNamespace(id=user_id))

    def table(self, name):
        return FakeTable(self.tables, name, self.state)

    @property
    def storage(self):
        return FakeStorage(self.state)


def _registered_paths(routes) -> set[str]:
    """Every route path the app already serves, flattened through inclusions.

    FastAPI keeps an included router as a wrapper, so the mounted paths are
    reached through `original_router`.
    """
    paths: set[str] = set()
    pending = list(routes)
    while pending:
        route = pending.pop()
        path = getattr(route, "path", None)
        if path is not None:
            paths.add(path)
        inner = getattr(route, "original_router", None)
        if inner is not None:
            pending.extend(inner.routes)
    return paths


def make_client(fake: FakeSupabase, *extra_routers: APIRouter) -> TestClient:
    """Build a TestClient over the service-client double.

    `extra_routers` mount routers the application's own `api_router` does not
    serve yet: the production registration lives in `app.api.routes.router`,
    and a test targeting a router that is not registered there passes it
    explicitly so the router module itself is exercised without waiting for
    the central registration. A router that is already registered is skipped,
    so passing one never registers a duplicate path.
    """
    app = create_app()
    if extra_routers:
        served = _registered_paths(app.routes)
        for router in extra_routers:
            if any(getattr(r, "path", None) in served for r in router.routes):
                continue
            app.include_router(router, prefix=get_settings().api_v1_prefix)
    app.dependency_overrides[get_supabase_service_client] = lambda: fake
    return TestClient(app)


@pytest.fixture()
def make_fake():
    return FakeSupabase


# ---------------------------------------------------------------------------
# Row builders.
# ---------------------------------------------------------------------------

STATE_UNIVERSITY_ID = UUID("aaaaaaaa-0000-0000-0000-000000000001")


def university_row(**overrides):
    row = {
        "id": str(STATE_UNIVERSITY_ID),
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
    seeking_gender="everyone",
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
        "relationship_intent": None,
        "height_cm": 180,
        "hometown": "Springfield",
        "motivations": [],
        "profile_prompts": [],
        "created_at": created_at,
        "universities": university_row(),
    }
    row.update(overrides)
    return row


def submission_row(profile_id, status="VERIFIED", submitted_at="2026-08-20T10:00:00+00:00"):
    return {
        "id": str(uuid4()),
        "profile_id": str(profile_id),
        "status": status,
        "submitted_at": submitted_at,
    }


def category_row(category_id, name="Sports", slug="sports", is_active=True, sort_order=10):
    return {
        "id": str(category_id),
        "name": name,
        "slug": slug,
        "icon": None,
        "sort_order": sort_order,
        "is_active": is_active,
        "created_at": "2026-08-01T00:00:00+00:00",
        "updated_at": "2026-08-01T00:00:00+00:00",
    }


def activity_row(
    activity_id,
    category_id,
    name="Badminton",
    slug="badminton",
    is_active=True,
    sort_order=10,
):
    return {
        "id": str(activity_id),
        "category_id": str(category_id),
        "name": name,
        "slug": slug,
        "sort_order": sort_order,
        "is_active": is_active,
        "created_at": "2026-08-01T00:00:00+00:00",
        "updated_at": "2026-08-01T00:00:00+00:00",
    }


def opportunity_row(
    opportunity_id,
    category_id,
    activity_id=None,
    *,
    title="Badminton Tournament",
    status="PUBLISHED",
    created_at="2026-08-05T09:00:00+00:00",
):
    return {
        "id": str(opportunity_id),
        "title": title,
        "category_id": str(category_id),
        "activity_id": str(activity_id) if activity_id else None,
        "description": "Bring a racket.",
        "opportunity_date": "2026-11-01",
        "start_time": "18:00:00",
        "end_time": "21:00:00",
        "location": "Sports Complex",
        "cover_image_url": None,
        "capacity": 16,
        "partner_requirement": "Mixed doubles",
        "status": status,
        "expiry": None,
        "created_by": None,
        "created_at": created_at,
        "updated_at": created_at,
        "categories": {
            "id": str(category_id),
            "name": "Sports",
            "slug": "sports",
            "icon": None,
        },
        "activities": (
            {
                "id": str(activity_id),
                "name": "Badminton",
                "slug": "badminton",
            }
            if activity_id
            else None
        ),
    }


def application_row(application_id, opportunity_id, profile_id, status="APPLIED"):
    return {
        "id": str(application_id),
        "opportunity_id": str(opportunity_id),
        "profile_id": str(profile_id),
        "status": status,
        "created_at": "2026-10-01T09:00:00+00:00",
        "opportunities": None,
    }


def action_row(actor_profile_id, target_profile_id, action_type, opportunity_id=None):
    return {
        "id": str(uuid4()),
        "actor_profile_id": str(actor_profile_id),
        "target_profile_id": str(target_profile_id),
        "action_type": action_type,
        "opportunity_id": str(opportunity_id) if opportunity_id else None,
        "created_at": "2026-10-02T09:00:00+00:00",
    }
