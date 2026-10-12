"""Admin console support: dashboard metrics, user directory, and security.

Reuses the EXISTING staff authorization mechanism — every function here is
reached only through the `CurrentStaffUserDep` route dependency, which
resolves the authenticated bearer token's user id and checks membership in
`public.staff_admins` (service role). Unauthenticated → 401 (from the auth
dependency), authenticated non-staff → 403, staff → allowed. There is no
second auth system and no reliance on frontend route hiding.

Only real, queryable counts are returned for the dashboard — nothing is
fabricated. User directory returns minimal, admin-safe fields: NO auth ids,
NO email, NO date_of_birth, NO verification documents, NO storage paths. The
suspension is the account-level restriction (indefinite = block, timed = until
a timestamp); it is ENFORCED server-side for every interactive request by
`is_suspended()`, which the shared `CurrentAuthUserDep` dependency calls — see
`app.api.deps`. That gate reads this same table through
`active_suspension_filter()`, the single shared definition of an active
suspension, so recording a suspension here immediately blocks the account.
"""

import logging
from datetime import datetime, timezone
from typing import Any
from uuid import UUID

from supabase import Client

from app.core.exceptions import (
    ConflictError,
    NotFoundError,
    ServiceUnavailableError,
)

logger = logging.getLogger(__name__)

_ADMIN_PROFILE_COLUMNS = (
    "id,first_name,course,academic_year,university_id,custom_university_name,"
    "gender,created_at,universities(id,name)"
)

# Hard server-side caps so a directory/report list can never be unbounded.
USER_SEARCH_LIMIT = 50
SUSPENSIONS_LIMIT = 100


# ---------------------------------------------------------------------------
# Dashboard.
# ---------------------------------------------------------------------------


def get_dashboard_metrics(supabase: Client) -> dict[str, Any]:
    """Return real counts for the admin dashboard (no fabricated metrics).

    Each metric is a genuine COUNT over the authoritative table, with the
    verification-derived counts computed from the latest submission per profile.
    """
    return {
        "users": {
            "total": _count(supabase, "profiles"),
            "verified": _count_verified_profiles(supabase),
        },
        "verification": {
            "pending": _count_where(
                supabase, "verification_submissions", "status", "PENDING"
            ),
        },
        "opportunities": {
            "total": _count(supabase, "opportunities"),
            "published": _count_where(
                supabase, "opportunities", "status", "PUBLISHED"
            ),
        },
        "matches": {
            "active": _count_active_matches(supabase),
        },
        "reports": {
            "total": _count(supabase, "reports"),
            "open": _count_where(supabase, "reports", "status", "OPEN"),
        },
        "applications": {
            "total": _count(supabase, "applications"),
            "applied": _count_where(supabase, "applications", "status", "APPLIED"),
        },
        "suspensions": {
            "active": _count_active_suspensions(supabase),
        },
    }


def _count(supabase: Client, table: str) -> int:
    return _count_where(supabase, table, None, None)


def _count_where(
    supabase: Client, table: str, column: str | None, value: Any
) -> int:
    try:
        query = supabase.table(table).select("id", count="exact")
        if column is not None:
            query = query.eq(column, value)
        response = query.limit(1).execute()
    except Exception as exc:
        logger.exception("Dashboard count failed for %s", table)
        raise ServiceUnavailableError(
            "Dashboard metrics are temporarily unavailable.",
            code="database_unavailable",
        ) from exc
    count = getattr(response, "count", None)
    if isinstance(count, int):
        return count
    # Fallback: count rows directly (some clients don't surface `count`).
    return len(getattr(response, "data", None) or [])


def _count_verified_profiles(supabase: Client) -> int:
    """Number of profiles whose latest verification submission is VERIFIED."""
    try:
        response = (
            supabase.table("verification_submissions")
            .select("profile_id,status,submitted_at")
            .order("submitted_at", desc=True)
            .limit(10000)
            .execute()
        )
    except Exception as exc:
        logger.exception("Verified count lookup failed")
        raise ServiceUnavailableError(
            "Dashboard metrics are temporarily unavailable.",
            code="database_unavailable",
        ) from exc
    latest: dict[str, str] = {}
    for row in getattr(response, "data", None) or []:
        profile_id = row.get("profile_id")
        if profile_id is not None and profile_id not in latest:
            latest[profile_id] = row.get("status")
    return sum(1 for status in latest.values() if status == "VERIFIED")


def _count_active_matches(supabase: Client) -> int:
    try:
        response = (
            supabase.table("matches")
            .select("id", count="exact")
            .is_("unmatched_at", "null")
            .limit(1)
            .execute()
        )
    except Exception as exc:
        logger.exception("Active match count failed")
        raise ServiceUnavailableError(
            "Dashboard metrics are temporarily unavailable.",
            code="database_unavailable",
        ) from exc
    count = getattr(response, "count", None)
    return count if isinstance(count, int) else len(getattr(response, "data", None) or [])


def active_suspension_filter() -> str:
    """The ONE definition of "this suspension restricts the account right now".

    A suspension row is active when it is indefinite (`suspended_until IS
    NULL` — the admin "block" action) or when its expiry is still in the
    future (the admin "suspend" action). Every read of the table filters on
    this, so the admin console and the request-path enforcement gate can never
    disagree about whether an account is restricted.
    """
    now_iso = datetime.now(timezone.utc).isoformat()
    return f"suspended_until.is.null,suspended_until.gt.{now_iso}"


def is_suspended(supabase: Client, auth_user_id: UUID) -> bool:
    """Return True iff the token-owned profile currently has an ACTIVE suspension.

    This is the server-side enforcement predicate, reading the same
    `public.suspensions` table the admin console writes — there is no second
    moderation system. Identity comes from the resolved auth user id only.

    A caller with no profile is never suspended (there is nothing to
    restrict). A lapsed timed suspension is not active, so interaction
    resumes automatically once one expires.

    ponytail: two indexed lookups per gated request (profiles by auth_user_id,
    then suspensions by profile_id) and no caching — correct and cheap at this
    scale; add a short-TTL cache here if it ever shows up in latency.
    """
    profile_id = _profile_id_for_auth_user(supabase, auth_user_id)
    if profile_id is None:
        return False
    try:
        response = (
            supabase.table("suspensions")
            .select("id")
            .eq("profile_id", profile_id)
            .or_(active_suspension_filter())
            .execute()
        )
    except Exception as exc:
        logger.exception("Suspension lookup failed")
        raise ServiceUnavailableError(
            "Account status is temporarily unavailable.",
            code="database_unavailable",
        ) from exc
    return bool(getattr(response, "data", None) or [])


def _profile_id_for_auth_user(supabase: Client, auth_user_id: UUID) -> str | None:
    """Resolve the auth user id to its profile id (None when no profile)."""
    try:
        response = (
            supabase.table("profiles")
            .select("id")
            .eq("auth_user_id", str(auth_user_id))
            .maybe_single()
            .execute()
        )
    except Exception as exc:
        logger.exception("Profile lookup failed")
        raise ServiceUnavailableError(
            "Account status is temporarily unavailable.",
            code="database_unavailable",
        ) from exc
    row = getattr(response, "data", response)
    return str(row["id"]) if row else None


def _count_active_suspensions(supabase: Client) -> int:
    """Suspensions that are indefinite (NULL) or whose expiry is in the future."""
    try:
        response = (
            supabase.table("suspensions")
            .select("id,suspended_until")
            .or_(active_suspension_filter())
            .execute()
        )
    except Exception as exc:
        logger.exception("Active suspension count failed")
        raise ServiceUnavailableError(
            "Dashboard metrics are temporarily unavailable.",
            code="database_unavailable",
        ) from exc
    return len(getattr(response, "data", None) or [])


# ---------------------------------------------------------------------------
# User directory.
# ---------------------------------------------------------------------------


def search_users(
    supabase: Client, *, query: str | None, limit: int
) -> list[dict[str, Any]]:
    """Return admin-safe user records, optionally filtered by a name query.

    Only minimal, non-invasive fields are returned (first name, course, year,
    university, gender, created_at). auth ids, emails, date_of_birth,
    verification documents, and storage paths are never included. The result
    is enriched with the profile's account status (verification + suspension).
    """
    try:
        query_builder = supabase.table("profiles").select(_ADMIN_PROFILE_COLUMNS)
        if query:
            # Case-insensitive prefix/substring match on first_name.
            query_builder = query_builder.ilike("first_name", f"%{query}%")
        response = (
            query_builder.order("created_at", desc=True)
            .limit(min(limit, USER_SEARCH_LIMIT))
            .execute()
        )
    except Exception as exc:
        logger.exception("User search failed")
        raise ServiceUnavailableError(
            "The user directory is temporarily unavailable.",
            code="database_unavailable",
        ) from exc
    rows = getattr(response, "data", None) or []

    profile_ids = [str(row["id"]) for row in rows]
    verification = _latest_verification_by_profile(supabase, profile_ids)
    suspensions = _active_suspensions_by_profile(supabase, profile_ids)

    return [
        _admin_user_payload(row, verification.get(str(row["id"])), suspensions.get(str(row["id"])))
        for row in rows
    ]


def get_user_detail(supabase: Client, profile_id: UUID) -> dict[str, Any]:
    """Return one admin-safe user record with account status (404 if unknown)."""
    try:
        response = (
            supabase.table("profiles")
            .select(_ADMIN_PROFILE_COLUMNS)
            .eq("id", str(profile_id))
            .maybe_single()
            .execute()
        )
    except Exception as exc:
        logger.exception("User detail lookup failed")
        raise ServiceUnavailableError(
            "The user directory is temporarily unavailable.",
            code="database_unavailable",
        ) from exc
    row = getattr(response, "data", response)
    if not row:
        raise NotFoundError("Profile not found.")

    pid = str(profile_id)
    verification = _latest_verification_by_profile(supabase, [pid])
    suspensions = _active_suspensions_by_profile(supabase, [pid])
    return _admin_user_payload(
        row, verification.get(pid), suspensions.get(pid)
    )


def _admin_user_payload(
    row: dict[str, Any],
    verification: dict[str, Any] | None,
    suspension: dict[str, Any] | None,
) -> dict[str, Any]:
    university = row.get("universities") or {}
    # A profile claims exactly one university, so exactly one of
    # `university.name` / `custom_university_name` is populated. Mirror the
    # verification queue (staff._queue_item): a custom institution must never
    # render as a blank catalog row.
    custom_name = (row.get("custom_university_name") or "").strip() or None
    payload: dict[str, Any] = {
        "profile_id": str(row["id"]),
        "first_name": row.get("first_name"),
        "course": row.get("course"),
        "academic_year": row.get("academic_year"),
        "gender": row.get("gender"),
        "created_at": row.get("created_at"),
        "university": (
            {"id": str(university["id"]), "name": university.get("name")}
            if university.get("id")
            else None
        ),
        "custom_university_name": custom_name,
        "university_label": (
            custom_name or university.get("name") or "University not on file"
        ),
        "verification": {
            "status": (verification or {}).get("status"),
            "submitted_at": (verification or {}).get("submitted_at"),
        },
        "account": {
            "suspended": bool(suspension),
            "suspension_reason": (suspension or {}).get("reason"),
            "suspended_until": (suspension or {}).get("suspended_until"),
        },
    }
    return payload


def _latest_verification_by_profile(
    supabase: Client, profile_ids: list[str]
) -> dict[str, dict[str, Any]]:
    if not profile_ids:
        return {}
    try:
        response = (
            supabase.table("verification_submissions")
            .select("profile_id,status,submitted_at")
            .in_("profile_id", profile_ids)
            .order("submitted_at", desc=True)
            .execute()
        )
    except Exception as exc:
        logger.exception("Verification batch lookup failed")
        raise ServiceUnavailableError(
            "The user directory is temporarily unavailable.",
            code="database_unavailable",
        ) from exc
    latest: dict[str, dict[str, Any]] = {}
    for row in getattr(response, "data", None) or []:
        pid = row.get("profile_id")
        if pid is not None and str(pid) not in latest:
            latest[str(pid)] = {
                "status": row.get("status"),
                "submitted_at": row.get("submitted_at"),
            }
    return latest


def _active_suspensions_by_profile(
    supabase: Client, profile_ids: list[str]
) -> dict[str, dict[str, Any]]:
    if not profile_ids:
        return {}
    try:
        response = (
            supabase.table("suspensions")
            .select("id,profile_id,reason,suspended_until")
            .in_("profile_id", profile_ids)
            .or_(active_suspension_filter())
            .execute()
        )
    except Exception as exc:
        logger.exception("Suspension batch lookup failed")
        raise ServiceUnavailableError(
            "The user directory is temporarily unavailable.",
            code="database_unavailable",
        ) from exc
    out: dict[str, dict[str, Any]] = {}
    for row in getattr(response, "data", None) or []:
        pid = str(row.get("profile_id"))
        # If multiple active, prefer the indefinite one.
        current = out.get(pid)
        if current is None or (
            current.get("suspended_until") is not None
            and row.get("suspended_until") is None
        ):
            out[pid] = {
                "reason": row.get("reason"),
                "suspended_until": row.get("suspended_until"),
            }
    return out


# ---------------------------------------------------------------------------
# Security: account-level restrictions (indefinite block + timed suspend).
#
# The database models one account-level restriction: `suspensions`, with an
# optional `suspended_until` (NULL = indefinite). The admin "block a user"
# action is therefore an indefinite suspension and the admin "suspend a user"
# action is a timed suspension — both write the same table, so a block is
# simply the unbounded case. Lifting either removes the active rows. This
# avoids a second, redundant block mechanism.
# ---------------------------------------------------------------------------


def suspend_user(
    supabase: Client,
    staff_user_id: UUID,
    profile_id: UUID,
    *,
    reason: str,
    suspended_until: datetime | None = None,
) -> dict[str, Any]:
    """Suspend a user indefinitely (suspended_until NULL) or until a timestamp.

    `suspended_until=None` is the indefinite/block case. The suspension is an
    account-level restriction. The admin identity comes from the authenticated
    staff token (created_by). The database CHECK requires suspended_until >
    created_at (i.e., in the future).
    """
    _require_profile(supabase, profile_id)
    data: dict[str, Any] = {
        "profile_id": str(profile_id),
        "reason": reason,
        "created_by": str(staff_user_id),
        # Explicit NULL = indefinite (the block case).
        "suspended_until": suspended_until.isoformat() if suspended_until else None,
    }
    try:
        response = supabase.table("suspensions").insert(data).execute()
    except Exception as exc:
        detail = str(exc)
        if "suspensions_until_valid" in detail:
            raise ConflictError(
                "The suspension expiry must be in the future.",
                code="invalid_suspension_window",
            ) from exc
        logger.exception("Suspension insert failed")
        raise ServiceUnavailableError(
            "The user could not be suspended.", code="database_insert_failed"
        ) from exc
    rows = getattr(response, "data", None) or []
    if not rows:
        raise ServiceUnavailableError(
            "The user could not be suspended.", code="database_insert_failed"
        )
    return {
        "id": str(rows[0]["id"]),
        "profile_id": str(rows[0]["profile_id"]),
        "reason": rows[0].get("reason"),
        "suspended_until": rows[0].get("suspended_until"),
        "created_at": rows[0].get("created_at"),
    }


def unsuspend_user(supabase: Client, profile_id: UUID) -> dict[str, Any]:
    """Lift all active suspensions on a profile (delete the rows).

    Withdraw is modeled as removal (the schema has no soft-delete flag);
    lifting every active suspension restores the account.
    """
    _require_profile(supabase, profile_id)
    try:
        response = (
            supabase.table("suspensions")
            .delete()
            .eq("profile_id", str(profile_id))
            .or_(active_suspension_filter())
            .execute()
        )
    except Exception as exc:
        logger.exception("Unsuspend delete failed")
        raise ServiceUnavailableError(
            "The user could not be reinstated.",
            code="database_delete_failed",
        ) from exc
    rows = getattr(response, "data", None) or []
    return {"profile_id": str(profile_id), "suspended": False, "lifted": len(rows)}


def list_suspensions(supabase: Client) -> list[dict[str, Any]]:
    """Return active suspensions (newest first), staff-only."""
    try:
        response = (
            supabase.table("suspensions")
            .select("id,profile_id,reason,suspended_until,created_by,created_at")
            .or_(active_suspension_filter())
            .order("created_at", desc=True)
            .limit(SUSPENSIONS_LIMIT)
            .execute()
        )
    except Exception as exc:
        logger.exception("Suspension list lookup failed")
        raise ServiceUnavailableError(
            "Suspensions are temporarily unavailable.",
            code="database_unavailable",
        ) from exc
    rows = getattr(response, "data", None) or []
    return [
        {
            "id": str(row["id"]),
            "profile_id": str(row["profile_id"]),
            "reason": row.get("reason"),
            "suspended_until": row.get("suspended_until"),
            "created_by": str(row["created_by"]),
            "created_at": row.get("created_at"),
        }
        for row in rows
    ]


def _require_profile(supabase: Client, profile_id: UUID) -> None:
    try:
        response = (
            supabase.table("profiles")
            .select("id")
            .eq("id", str(profile_id))
            .maybe_single()
            .execute()
        )
    except Exception as exc:
        logger.exception("Profile existence check failed")
        raise ServiceUnavailableError(
            "The user directory is temporarily unavailable.",
            code="database_unavailable",
        ) from exc
    if not getattr(response, "data", response):
        raise NotFoundError("Profile not found.")
