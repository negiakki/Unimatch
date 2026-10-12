"""Opportunities: the PUBLIC browse and detail surface.

GET /api/v1/opportunities lists PUBLISHED opportunities (newest first, with
optional category/activity filters); GET /api/v1/opportunities/{id} returns
one PUBLISHED opportunity's detail. The service role bypasses RLS, so the
PUBLISHED filter is applied here — never trusted to the database policy — and
a non-PUBLISHED or unknown id surfaces the same 404, so there is no existence
leak for content that is not public.

Admin CRUD and state transitions (publish/pause/cancel/expire) run through the
existing staff authorization and the service role and live in
`app.services.admin_opportunities`; normal users hold no write path at all.
"""

import logging
from typing import Any
from uuid import UUID

from supabase import Client

from app.core.exceptions import (
    NotFoundError,
    ServiceUnavailableError,
)

logger = logging.getLogger(__name__)

_PUBLIC_SELECT = (
    "id,title,category_id,activity_id,description,opportunity_date,start_time,"
    "end_time,location,cover_image_url,capacity,partner_requirement,status,"
    "created_at,categories(id,name,slug,icon),activities(id,name,slug)"
)

PUBLIC_LIMIT = 100


def list_opportunities(
    supabase: Client,
    *,
    category_id: UUID | None = None,
    activity_id: UUID | None = None,
) -> list[dict[str, Any]]:
    """Return PUBLISHED opportunities (newest first) for public discovery.

    The service role bypasses RLS, so the PUBLISHED filter is applied here —
    never trusted to the database policy. Optional category/activity filters
    narrow the browse.
    """
    try:
        query = (
            supabase.table("opportunities")
            .select(_PUBLIC_SELECT)
            .eq("status", "PUBLISHED")
        )
        if category_id is not None:
            query = query.eq("category_id", str(category_id))
        if activity_id is not None:
            query = query.eq("activity_id", str(activity_id))
        response = (
            query.order("created_at", desc=True).order("id").limit(PUBLIC_LIMIT).execute()
        )
    except Exception as exc:
        logger.exception("Opportunity list lookup failed")
        raise ServiceUnavailableError(
            "Opportunities are temporarily unavailable.",
            code="database_unavailable",
        ) from exc
    rows = getattr(response, "data", None) or []
    return [_public_payload(row) for row in rows]


def get_opportunity(supabase: Client, opportunity_id: UUID) -> dict[str, Any]:
    """Return a PUBLISHED opportunity by id (public detail).

    Non-PUBLISHED and unknown opportunities surface the same 404 — no
    existence leak for content that is not public.
    """
    row = _get_opportunity_row(supabase, opportunity_id)
    if row is None or row.get("status") != "PUBLISHED":
        raise NotFoundError("Opportunity not found.")
    return _public_payload(row)


# ---------------------------------------------------------------------------
# Internal helpers.
# ---------------------------------------------------------------------------


def _get_opportunity_row(supabase: Client, opportunity_id: UUID) -> dict[str, Any] | None:
    try:
        response = (
            supabase.table("opportunities")
            .select(_PUBLIC_SELECT)
            .eq("id", str(opportunity_id))
            .maybe_single()
            .execute()
        )
    except Exception as exc:
        logger.exception("Opportunity lookup failed")
        raise ServiceUnavailableError(
            "Opportunities are temporarily unavailable.",
            code="database_unavailable",
        ) from exc
    return getattr(response, "data", response)


def require_published_opportunity(supabase: Client, opportunity_id: UUID) -> dict[str, Any]:
    """Resolve a PUBLISHED opportunity or 404 (no existence leak for the rest)."""
    row = _get_opportunity_row(supabase, opportunity_id)
    if row is None or row.get("status") != "PUBLISHED":
        raise NotFoundError("Opportunity not found.")
    return row


def _public_payload(row: dict[str, Any]) -> dict[str, Any]:
    category = row.get("categories") or {}
    activity = row.get("activities") or {}
    row_id = row.get("id")
    return {
        "id": str(row_id) if row_id else None,
        "title": row.get("title"),
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
            {"id": str(activity["id"]), "name": activity.get("name"), "slug": activity.get("slug")}
            if activity.get("id")
            else None
        ),
        "description": row.get("description"),
        "opportunity_date": row.get("opportunity_date"),
        "start_time": row.get("start_time"),
        "end_time": row.get("end_time"),
        "location": row.get("location"),
        "cover_image_url": row.get("cover_image_url"),
        "capacity": row.get("capacity"),
        "partner_requirement": row.get("partner_requirement"),
        "status": row.get("status"),
        "created_at": row.get("created_at"),
    }
