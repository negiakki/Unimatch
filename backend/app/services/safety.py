"""Blocks & reports business logic (Phase 8) + admin moderation surface.

POST /api/v1/blocks records one reversible blocker → blocked pair (idempotent:
a duplicate insert surfaces the existing row); DELETE /api/v1/blocks/{id}
unblocks. POST /api/v1/reports records a report — nothing else changes: there
are deliberately NO automatic consequences (no auto-block/unmatch; reports are
admin-review-only). GET /api/v1/admin/reports is the staff read surface and now
resolves an opportunity context for reports that reference one (content_type
='opportunity'). POST /api/v1/admin/reports/{id}/decision records a staff
decision (OPEN / REVIEWED / DISMISSED). GET /api/v1/admin/blocks +
DELETE /api/v1/admin/blocks/{id} are the staff block-moderation surface.

Security model (mirrors the dating/discovery/messaging slices):
  * Identity derives exclusively from the Supabase bearer token — the actor
    profile is resolved server-side; client-supplied profile ids carry no
    authorization weight.
  * Blocking and reporting require the CALLER to be VERIFIED (403 otherwise).
    A block target must be a VERIFIED profile (404 otherwise — self, unknown,
    and unverified targets all surface the same 404, no existence leak). A
    report target must merely exist (404 for self/unknown) so a report is
    never structurally impossible.
  * A block is a pure visibility filter: it never deletes matches, messages,
    or actions. The backend hides blocked pairs from discovery, likes/passes,
    matches, conversations, and every message operation; RLS mirrors this via
    public.pair_is_blocked. Unblocking restores everything automatically.
  * Reports are admin-only at the database: no user SELECT policy exists, so
    the service returns only what it just wrote (id, status, created_at).
"""

import logging
from typing import Any
from uuid import UUID

from supabase import Client

from app.core.exceptions import (
    NotFoundError,
    ServiceUnavailableError,
)
from app.services.discovery import _get_verified_viewer
from app.services.dating import _eligible_target

logger = logging.getLogger(__name__)

# Fixed reason categories (database CHECK re-enforces this exact set).
REPORT_REASONS = (
    "harassment",
    "inappropriate_content",
    "fake_profile",
    "underage",
    "spam",
    "other",
)

REPORT_DETAIL_MAX_LENGTH = 1000

# Hard cap for the staff report list, mirroring the verification queue.
REPORTS_LIST_LIMIT = 100

_ADMIN_PROFILE_COLUMNS = "id,first_name,course,academic_year,university_id"
_UNIVERSITY_COLUMNS = "id,name,city,state,country"


# ---------------------------------------------------------------------------
# Blocks.
# ---------------------------------------------------------------------------


def block_user(
    supabase: Client, auth_user_id: UUID, target_profile_id: UUID
) -> dict[str, Any]:
    """Block a VERIFIED profile (idempotent; reversible via unblock).

    The idempotency check runs FIRST so re-blocking never re-runs target
    eligibility (a blocked target is invisible everywhere else). Unknown,
    self, and unverified targets surface the same 404 as the dating gate —
    no existence leak. A concurrent duplicate insert also surfaces the
    existing row, so re-blocking is always a no-op success, never an error.
    """
    viewer = _get_verified_viewer(supabase, auth_user_id, action="block other users")

    existing = _find_block(supabase, str(viewer["id"]), str(target_profile_id))
    if existing:
        return _block_payload(existing)

    _eligible_target(supabase, target_profile_id, str(viewer["id"]))

    try:
        response = (
            supabase.table("blocks")
            .insert(
                {
                    "blocker_profile_id": str(viewer["id"]),
                    "blocked_profile_id": str(target_profile_id),
                }
            )
            .execute()
        )
        rows = getattr(response, "data", None) or []
    except Exception as exc:
        detail = str(exc)
        if "duplicate key" in detail or "blocks_blocker_blocked_unique" in detail:
            existing = _find_block(
                supabase, str(viewer["id"]), str(target_profile_id)
            )
            if existing:
                return _block_payload(existing)
        logger.exception("Block insert failed")
        raise ServiceUnavailableError(
            "This action could not be completed. Please try again later.",
            code="database_insert_failed",
        ) from exc
    if not rows:
        raise ServiceUnavailableError(
            "This action could not be completed. Please try again later.",
            code="database_insert_failed",
        )
    return _block_payload(rows[0])


def unblock_user(
    supabase: Client, auth_user_id: UUID, target_profile_id: UUID
) -> dict[str, Any]:
    """Remove the caller's block on a profile.

    Only the blocker's own outgoing rows are removable (server-side filter);
    a missing block is a 404, identical for "never blocked" and "not yours".
    """
    viewer = _get_verified_viewer(supabase, auth_user_id, action="manage blocks")

    try:
        response = (
            supabase.table("blocks")
            .delete()
            .eq("blocker_profile_id", str(viewer["id"]))
            .eq("blocked_profile_id", str(target_profile_id))
            .execute()
        )
    except Exception as exc:
        logger.exception("Unblock delete failed")
        raise ServiceUnavailableError(
            "This action could not be completed. Please try again later.",
            code="database_delete_failed",
        ) from exc
    rows = getattr(response, "data", None) or []
    if not rows:
        raise NotFoundError("Block not found.")
    return {"profile_id": str(target_profile_id), "unblocked": True}


def list_my_blocks(supabase: Client, auth_user_id: UUID) -> dict[str, Any]:
    """List the caller's outgoing blocks (newest first), minimal fields.

    Only OUTGOING blocks are ever readable — the blocked side has no read
    path in either the backend or RLS, so blocking stays silent for its
    target.
    """
    viewer = _get_verified_viewer(supabase, auth_user_id, action="manage blocks")

    try:
        response = (
            supabase.table("blocks")
            .select("id,blocked_profile_id,created_at")
            .eq("blocker_profile_id", str(viewer["id"]))
            .order("created_at", desc=True)
            .execute()
        )
    except Exception as exc:
        logger.exception("Block list lookup failed")
        raise ServiceUnavailableError(
            "Blocks are temporarily unavailable.", code="database_unavailable"
        ) from exc
    rows = getattr(response, "data", None) or []

    blocked_ids = [str(row["blocked_profile_id"]) for row in rows]
    names = _first_names_by_id(supabase, blocked_ids)
    return {
        "blocks": [
            {
                "id": str(row["id"]),
                "profile_id": str(row["blocked_profile_id"]),
                "first_name": names.get(str(row["blocked_profile_id"])),
                "created_at": row.get("created_at"),
            }
            for row in rows
        ]
    }


# ---------------------------------------------------------------------------
# Reports.
# ---------------------------------------------------------------------------


def report_user(
    supabase: Client,
    auth_user_id: UUID,
    *,
    reported_profile_id: UUID,
    reason: str,
    detail: str | None = None,
    content_type: str | None = None,
    content_id: UUID | None = None,
) -> dict[str, Any]:
    """Record a report against another profile.

    The report writes exactly one row and changes nothing else — no block,
    no unmatch, no effect on discovery or matching. Duplicate reports are
    allowed: report volume per target is admin signal, not an error.
    Unknown and self targets surface the same 404 (no existence leak).
    """
    viewer = _get_verified_viewer(supabase, auth_user_id, action="report other users")
    _require_reportable_target(
        supabase, reported_profile_id, str(viewer["id"])
    )

    try:
        response = (
            supabase.table("reports")
            .insert(
                {
                    "reporter_profile_id": str(viewer["id"]),
                    "reported_profile_id": str(reported_profile_id),
                    "reason": reason,
                    "detail": detail,
                    "content_type": content_type,
                    "content_id": str(content_id) if content_id else None,
                }
            )
            .execute()
        )
    except Exception as exc:
        logger.exception("Report insert failed")
        raise ServiceUnavailableError(
            "The report could not be submitted. Please try again later.",
            code="database_insert_failed",
        ) from exc
    rows = getattr(response, "data", None) or []
    if not rows:
        raise ServiceUnavailableError(
            "The report could not be submitted. Please try again later.",
            code="database_insert_failed",
        )
    row = rows[0]
    # Reports are admin-only at the database (no user SELECT policy), so the
    # response echoes only the receipt: id, status, created_at.
    return {
        "id": str(row["id"]),
        "status": row.get("status"),
        "created_at": row.get("created_at"),
    }


def list_admin_reports(supabase: Client) -> list[dict[str, Any]]:
    """Return reviewer-safe report metadata (newest first, capped).

    Staff-only (route dependency); the projection carries the reason,
    optional detail/content reference, processing status, and minimal
    profile/university context for both sides. No private document
    references exist here; nothing beyond these fields is ever returned.
    """
    try:
        response = (
            supabase.table("reports")
            .select(
                "id,reporter_profile_id,reported_profile_id,reason,detail,"
                "content_type,content_id,status,created_at"
            )
            .order("created_at", desc=True)
            .limit(REPORTS_LIST_LIMIT)
            .execute()
        )
    except Exception as exc:
        logger.exception("Report list lookup failed")
        raise ServiceUnavailableError(
            "The report list is temporarily unavailable.",
            code="database_unavailable",
        ) from exc
    rows = getattr(response, "data", None) or []

    profile_ids = sorted(
        {str(row["reporter_profile_id"]) for row in rows}
        | {str(row["reported_profile_id"]) for row in rows}
    )
    profiles = _admin_profiles_by_id(supabase, profile_ids)
    university_ids = sorted(
        {
            str(profile["university_id"])
            for profile in profiles.values()
            if profile.get("university_id")
        }
    )
    universities = _universities_by_id(supabase, university_ids)

    # A report may reference an opportunity/event (content_type='opportunity');
    # resolve that context so staff see the reported listing, not just a UUID.
    opportunity_ids = sorted(
        {
            str(row["content_id"])
            for row in rows
            if row.get("content_type") == "opportunity" and row.get("content_id")
        }
    )
    opportunities = _admin_opportunities_by_id(supabase, opportunity_ids)

    return [
        _admin_report_payload(row, profiles, universities, opportunities) for row in rows
    ]


def decide_report(supabase: Client, report_id: UUID, status: str) -> dict[str, Any]:
    """Record a staff decision on a report (REVIEWED / DISMISSED / OPEN).

    The reviewer identity is not stored on the row (the schema keeps no
    reviewer column); the authenticated staff caller has already been
    authorized by the route. The database CHECK (status value set) stays
    authoritative. Re-deciding is allowed (a dismissed report can be
    reopened); there is no destructive operation here.
    """
    try:
        response = (
            supabase.table("reports")
            .select("id,status")
            .eq("id", str(report_id))
            .maybe_single()
            .execute()
        )
    except Exception as exc:
        logger.exception("Report lookup failed")
        raise ServiceUnavailableError(
            "The report is temporarily unavailable.", code="database_unavailable"
        ) from exc
    row = getattr(response, "data", response)
    if not row:
        raise NotFoundError("Report not found.")

    try:
        response = (
            supabase.table("reports")
            .update({"status": status})
            .eq("id", str(report_id))
            .execute()
        )
    except Exception as exc:
        logger.exception("Report decision failed")
        raise ServiceUnavailableError(
            "The report decision could not be recorded.",
            code="database_update_failed",
        ) from exc
    rows = getattr(response, "data", None) or []
    if not rows:
        raise ServiceUnavailableError(
            "The report decision could not be recorded.",
            code="database_update_failed",
        )
    return {
        "id": str(rows[0]["id"]),
        "status": rows[0].get("status"),
        "created_at": rows[0].get("created_at"),
    }


# ---------------------------------------------------------------------------
# Admin block management.
#
# These operate on the existing user-to-user `blocks` table so staff can audit
# and lift blocks during moderation. A block is a pure visibility filter, so
# lifting one simply restores the pair everywhere. Account-level restrictions
# are suspensions (see the admin service), not blocks.
# ---------------------------------------------------------------------------


def list_admin_blocks(supabase: Client) -> list[dict[str, Any]]:
    """Return blocks for admin moderation (newest first, capped)."""
    try:
        response = (
            supabase.table("blocks")
            .select("id,blocker_profile_id,blocked_profile_id,created_at")
            .order("created_at", desc=True)
            .limit(REPORTS_LIST_LIMIT)
            .execute()
        )
    except Exception as exc:
        logger.exception("Admin block list lookup failed")
        raise ServiceUnavailableError(
            "The block list is temporarily unavailable.",
            code="database_unavailable",
        ) from exc
    rows = getattr(response, "data", None) or []

    profile_ids = sorted(
        {str(row["blocker_profile_id"]) for row in rows}
        | {str(row["blocked_profile_id"]) for row in rows}
    )
    profiles = _admin_profiles_by_id(supabase, profile_ids)
    universities = _universities_by_id(
        supabase,
        sorted(
            {
                str(profile["university_id"])
                for profile in profiles.values()
                if profile.get("university_id")
            }
        ),
    )

    def context(profile_id: str) -> dict[str, Any]:
        profile = profiles.get(profile_id) or {}
        university = universities.get(str(profile.get("university_id"))) or {}
        return {
            "profile_id": profile_id,
            "first_name": profile.get("first_name"),
            "course": profile.get("course"),
            "university": {"name": university.get("name")} if university else None,
        }

    return [
        {
            "id": str(row["id"]),
            "created_at": row.get("created_at"),
            "blocker": context(str(row["blocker_profile_id"])),
            "blocked": context(str(row["blocked_profile_id"])),
        }
        for row in rows
    ]


def remove_admin_block(supabase: Client, block_id: UUID) -> dict[str, Any]:
    """Lift a specific block by id (staff-only). 404 when it does not exist."""
    try:
        response = (
            supabase.table("blocks").delete().eq("id", str(block_id)).execute()
        )
    except Exception as exc:
        logger.exception("Admin block delete failed")
        raise ServiceUnavailableError(
            "The block could not be lifted.", code="database_delete_failed"
        ) from exc
    if not getattr(response, "data", None):
        raise NotFoundError("Block not found.")
    return {"id": str(block_id), "removed": True}


# ---------------------------------------------------------------------------
# Internal helpers.
# ---------------------------------------------------------------------------


def _find_block(
    supabase: Client, blocker_profile_id: str, blocked_profile_id: str
) -> dict[str, Any] | None:
    """Read back an existing block row (the idempotent re-block path)."""
    try:
        response = (
            supabase.table("blocks")
            .select("id,blocker_profile_id,blocked_profile_id,created_at")
            .eq("blocker_profile_id", blocker_profile_id)
            .eq("blocked_profile_id", blocked_profile_id)
            .maybe_single()
            .execute()
        )
    except Exception as exc:
        logger.exception("Existing block lookup failed")
        raise ServiceUnavailableError(
            "This action could not be completed. Please try again later.",
            code="database_unavailable",
        ) from exc
    return getattr(response, "data", response)


def _block_payload(row: dict[str, Any]) -> dict[str, Any]:
    return {
        "id": str(row["id"]),
        "blocker_profile_id": str(row["blocker_profile_id"]),
        "blocked_profile_id": str(row["blocked_profile_id"]),
        "created_at": row.get("created_at"),
    }


def _require_reportable_target(
    supabase: Client, target_profile_id: UUID, viewer_profile_id: str
) -> None:
    """404 unless the report target exists and is not the caller.

    Verification is deliberately NOT required for the target: a report must
    never be structurally impossible. Unknown and self targets surface the
    same 404 — no existence leak.
    """
    if str(target_profile_id) == viewer_profile_id:
        raise NotFoundError("Profile not found.")
    try:
        response = (
            supabase.table("profiles")
            .select("id")
            .eq("id", str(target_profile_id))
            .maybe_single()
            .execute()
        )
    except Exception as exc:
        logger.exception("Report target lookup failed")
        raise ServiceUnavailableError(
            "This action is temporarily unavailable.", code="database_unavailable"
        ) from exc
    if not getattr(response, "data", response):
        raise NotFoundError("Profile not found.")


def _first_names_by_id(
    supabase: Client, profile_ids: list[str]
) -> dict[str, str | None]:
    """One batched first-name lookup for the block list (minimal fields)."""
    if not profile_ids:
        return {}
    try:
        response = (
            supabase.table("profiles")
            .select("id,first_name")
            .in_("id", profile_ids)
            .execute()
        )
    except Exception as exc:
        logger.exception("Blocked profile lookup failed")
        raise ServiceUnavailableError(
            "Blocks are temporarily unavailable.", code="database_unavailable"
        ) from exc
    return {
        str(row["id"]): row.get("first_name")
        for row in getattr(response, "data", None) or []
    }


def _admin_profiles_by_id(
    supabase: Client, profile_ids: list[str]
) -> dict[str, dict[str, Any]]:
    """One batched fetch of admin-safe profile context by id."""
    if not profile_ids:
        return {}
    try:
        response = (
            supabase.table("profiles")
            .select(_ADMIN_PROFILE_COLUMNS)
            .in_("id", profile_ids)
            .execute()
        )
    except Exception as exc:
        logger.exception("Report profile lookup failed")
        raise ServiceUnavailableError(
            "The report list is temporarily unavailable.",
            code="database_unavailable",
        ) from exc
    return {str(row["id"]): row for row in getattr(response, "data", None) or []}


def _universities_by_id(
    supabase: Client, university_ids: list[str]
) -> dict[str, dict[str, Any]]:
    """One batched fetch of university context for the report list."""
    if not university_ids:
        return {}
    try:
        response = (
            supabase.table("universities")
            .select(_UNIVERSITY_COLUMNS)
            .in_("id", university_ids)
            .execute()
        )
    except Exception as exc:
        logger.exception("Report university lookup failed")
        raise ServiceUnavailableError(
            "The report list is temporarily unavailable.",
            code="database_unavailable",
        ) from exc
    return {str(row["id"]): row for row in getattr(response, "data", None) or []}


def _admin_opportunities_by_id(
    supabase: Client, opportunity_ids: list[str]
) -> dict[str, dict[str, Any]]:
    """One batched fetch of opportunity context for referenced reports."""
    if not opportunity_ids:
        return {}
    try:
        response = (
            supabase.table("opportunities")
            .select(
                "id,title,status,category_id,activity_id,"
                "categories(id,name,slug,icon),activities(id,name,slug)"
            )
            .in_("id", opportunity_ids)
            .execute()
        )
    except Exception as exc:
        logger.exception("Report opportunity lookup failed")
        raise ServiceUnavailableError(
            "The report list is temporarily unavailable.",
            code="database_unavailable",
        ) from exc
    out: dict[str, dict[str, Any]] = {}
    for row in getattr(response, "data", None) or []:
        category = row.get("categories") or {}
        activity = row.get("activities") or {}
        out[str(row["id"])] = {
            "id": str(row["id"]),
            "title": row.get("title"),
            "status": row.get("status"),
            "category": (
                {
                    "id": str(category["id"]),
                    "name": category.get("name"),
                    "slug": category.get("slug"),
                    "icon": category.get("icon"),
                }
                if category.get("id")
                else None
            ),
            "activity": (
                {
                    "id": str(activity["id"]),
                    "name": activity.get("name"),
                    "slug": activity.get("slug"),
                }
                if activity.get("id")
                else None
            ),
        }
    return out


def _admin_report_payload(
    row: dict[str, Any],
    profiles: dict[str, dict[str, Any]],
    universities: dict[str, dict[str, Any]],
    opportunities: dict[str, dict[str, Any]],
) -> dict[str, Any]:
    """Project a report row to the reviewer-safe admin shape."""

    def profile_context(profile_id: str) -> dict[str, Any]:
        profile = profiles.get(profile_id) or {}
        university = universities.get(str(profile.get("university_id"))) or {}
        return {
            "profile_id": profile_id,
            "first_name": profile.get("first_name"),
            "course": profile.get("course"),
            "academic_year": profile.get("academic_year"),
            "university": (
                {
                    "name": university.get("name"),
                    "city": university.get("city"),
                    "state": university.get("state"),
                    "country": university.get("country"),
                }
                if university
                else None
            ),
        }

    payload = {
        "id": str(row["id"]),
        "status": row.get("status"),
        "reason": row.get("reason"),
        "detail": row.get("detail"),
        "content_type": row.get("content_type"),
        "content_id": str(row["content_id"]) if row.get("content_id") else None,
        "created_at": row.get("created_at"),
        "reporter": profile_context(str(row["reporter_profile_id"])),
        "reported": profile_context(str(row["reported_profile_id"])),
    }
    if row.get("content_type") == "opportunity" and row.get("content_id"):
        payload["opportunity"] = opportunities.get(str(row["content_id"]))
    return payload
