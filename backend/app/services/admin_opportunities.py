"""Opportunity ADMIN surface (staff-only): the full catalog (any status),
CRUD, the DRAFT -> PUBLISHED -> PAUSED/CANCELLED/EXPIRED state machine, and the
per-opportunity application list.

Authorization is the existing staff check (`CurrentStaffUserDep` on the admin
route) over the service role; `created_by` is the staff identity resolved from
the bearer token, never a client field. The database CHECK on `status` stays
authoritative for the stored value.

The public browse/detail projection stays in `app.services.opportunities`;
`_get_opportunity_row` is shared from there so public and admin reads cannot
disagree about which rows exist.
"""

import logging
from typing import Any
from uuid import UUID

from supabase import Client

from app.core.exceptions import (
    ConflictError,
    NotFoundError,
    ServiceUnavailableError,
)
from app.services.opportunities import _get_opportunity_row

logger = logging.getLogger(__name__)

_OPPORTUNITY_COLUMNS = (
    "id,title,category_id,activity_id,description,opportunity_date,start_time,"
    "end_time,location,cover_image_url,capacity,partner_requirement,status,"
    "expiry,created_at,updated_at"
)


def list_opportunity_applications(
    supabase: Client, opportunity_id: UUID
) -> list[dict[str, Any]]:
    """Admin: list applications for an opportunity (any status, newest first)."""
    _require_opportunity_any(supabase, opportunity_id)
    try:
        response = (
            supabase.table("applications")
            .select("id,opportunity_id,profile_id,status,created_at")
            .eq("opportunity_id", str(opportunity_id))
            .order("created_at", desc=True)
            .execute()
        )
    except Exception as exc:
        logger.exception("Opportunity applications lookup failed")
        raise ServiceUnavailableError(
            "Applications are temporarily unavailable.",
            code="database_unavailable",
        ) from exc
    rows = getattr(response, "data", None) or []
    return [
        {
            "id": str(row["id"]),
            "opportunity_id": str(row["opportunity_id"]),
            "profile_id": str(row["profile_id"]),
            "status": row.get("status"),
            "created_at": row.get("created_at"),
        }
        for row in rows
    ]


# ---------------------------------------------------------------------------
# Admin opportunity CRUD + state transitions.
# ---------------------------------------------------------------------------


def list_admin_opportunities(
    supabase: Client, *, status: str | None = None
) -> list[dict[str, Any]]:
    """Admin: return all opportunities (optionally filtered by status)."""
    try:
        query = (
            supabase.table("opportunities")
            .select(_OPPORTUNITY_COLUMNS)
            .order("created_at", desc=True)
            .order("id")
        )
        if status is not None:
            query = query.eq("status", status)
        response = query.limit(200).execute()
    except Exception as exc:
        logger.exception("Admin opportunity list lookup failed")
        raise ServiceUnavailableError(
            "Opportunities are temporarily unavailable.",
            code="database_unavailable",
        ) from exc
    rows = getattr(response, "data", None) or []
    return [_admin_payload(row) for row in rows]


def get_admin_opportunity(supabase: Client, opportunity_id: UUID) -> dict[str, Any]:
    """Admin: return an opportunity in ANY state (404 if unknown)."""
    row = _get_opportunity_row(supabase, opportunity_id)
    if row is None:
        raise NotFoundError("Opportunity not found.")
    return _admin_payload(row)


def create_opportunity(
    supabase: Client,
    staff_user_id: UUID,
    payload: dict[str, Any],
) -> dict[str, Any]:
    """Admin: create a DRAFT opportunity. `created_by` is the staff identity."""
    data = {**payload, "status": "DRAFT", "created_by": str(staff_user_id)}
    try:
        response = (
            supabase.table("opportunities").insert(data).execute()
        )
    except Exception as exc:
        _raise_opportunity_write_error(exc, "created")
    rows = getattr(response, "data", None) or []
    if not rows:
        raise ServiceUnavailableError(
            "The opportunity could not be created.", code="database_insert_failed"
        )
    return _admin_payload(rows[0])


def update_opportunity(
    supabase: Client, opportunity_id: UUID, payload: dict[str, Any]
) -> dict[str, Any]:
    """Admin: update a DRAFT opportunity's fields (staff-only).

    Status is not client-updatable via this path — state transitions have
    dedicated endpoints so the state machine stays explicit.
    """
    row = _require_opportunity_editable(supabase, opportunity_id)
    if row.get("status") != "DRAFT":
        raise ConflictError(
            "Only DRAFT opportunities can be edited. Publish or cancel first.",
            code="invalid_state_transition",
        )
    data = {k: v for k, v in payload.items() if k != "status"}
    try:
        response = (
            supabase.table("opportunities")
            .update(data)
            .eq("id", str(opportunity_id))
            .execute()
        )
    except Exception as exc:
        _raise_opportunity_write_error(exc, "updated")
    rows = getattr(response, "data", None) or []
    if not rows:
        raise ServiceUnavailableError(
            "The opportunity could not be updated.", code="database_update_failed"
        )
    return _admin_payload(rows[0])


def delete_opportunity(supabase: Client, opportunity_id: UUID) -> dict[str, Any]:
    """Admin: delete an opportunity (staff-only).

    Applications and contextual actions/matches cascade away (schema).
    """
    _require_opportunity_any(supabase, opportunity_id)
    try:
        response = (
            supabase.table("opportunities").delete().eq("id", str(opportunity_id)).execute()
        )
    except Exception as exc:
        logger.exception("Opportunity delete failed")
        raise ServiceUnavailableError(
            "The opportunity could not be removed.", code="database_delete_failed"
        ) from exc
    if not getattr(response, "data", None):
        raise NotFoundError("Opportunity not found.")
    return {"id": str(opportunity_id), "deleted": True}


def set_opportunity_status(
    supabase: Client, staff_user_id: UUID, opportunity_id: UUID, status: str
) -> dict[str, Any]:
    """Admin: transition an opportunity to a new state (publish/pause/cancel/expire).

    PUBLISH is allowed from any non-terminal state and moves the row to
    PUBLISHED; PAUSE/CANCEL/EXPIRE move a PUBLISHED row to their state. The
    database CHECK (status value set) stays authoritative for the value.
    """
    row = _require_opportunity_any(supabase, opportunity_id)
    current = row.get("status")
    if status == "PUBLISHED":
        if current == "CANCELLED":
            raise ConflictError(
                "A cancelled opportunity cannot be published.", code="invalid_state_transition"
            )
    elif current != "PUBLISHED":
        raise ConflictError(
            f"Only a PUBLISHED opportunity can be {status.lower()}.",
            code="invalid_state_transition",
        )
    try:
        response = (
            supabase.table("opportunities")
            .update({"status": status})
            .eq("id", str(opportunity_id))
            .execute()
        )
    except Exception as exc:
        _raise_opportunity_write_error(exc, "updated")
    rows = getattr(response, "data", None) or []
    if not rows:
        raise ServiceUnavailableError(
            "The opportunity could not be updated.", code="database_update_failed"
        )
    return _admin_payload(rows[0])


# ---------------------------------------------------------------------------
# Internal helpers.
# ---------------------------------------------------------------------------


def _require_opportunity_any(supabase: Client, opportunity_id: UUID) -> dict[str, Any]:
    row = _get_opportunity_row(supabase, opportunity_id)
    if row is None:
        raise NotFoundError("Opportunity not found.")
    return row


def _require_opportunity_editable(supabase: Client, opportunity_id: UUID) -> dict[str, Any]:
    return _require_opportunity_any(supabase, opportunity_id)


def _admin_payload(row: dict[str, Any]) -> dict[str, Any]:
    return {
        "id": str(row["id"]),
        "title": row.get("title"),
        "category_id": str(row["category_id"]) if row.get("category_id") else None,
        "activity_id": str(row["activity_id"]) if row.get("activity_id") else None,
        "description": row.get("description"),
        "opportunity_date": row.get("opportunity_date"),
        "start_time": row.get("start_time"),
        "end_time": row.get("end_time"),
        "location": row.get("location"),
        "cover_image_url": row.get("cover_image_url"),
        "capacity": row.get("capacity"),
        "partner_requirement": row.get("partner_requirement"),
        "status": row.get("status"),
        "expiry": row.get("expiry"),
        "created_by": str(row["created_by"]) if row.get("created_by") else None,
        "created_at": row.get("created_at"),
        "updated_at": row.get("updated_at"),
    }


def _raise_opportunity_write_error(exc: Exception, verb: str) -> None:
    detail = str(exc)
    if "foreign key" in detail:
        raise ConflictError(
            "The category or activity does not exist.", code="invalid_category"
        ) from exc
    logger.exception("Opportunity write failed")
    raise ServiceUnavailableError(
        f"The opportunity could not be {verb}. Please try again later.",
        code="database_write_failed",
    ) from exc
