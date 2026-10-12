"""Category & activity catalog: the PUBLIC reference-data read surface.

GET /api/v1/categories returns the active categories with their nested
activities; GET /api/v1/activities returns the flat active activity catalog.
Only ACTIVE rows are returned, and the rows are read through the service-role
client (which bypasses RLS), so the `is_active` filter is re-applied
server-side — never trusted to the database policy. There is no
authenticated-required gate: reference data is public (mirrors the DB grants
to anon + authenticated).

The staff-only write path (create/update/delete for categories and activities)
lives in `app.services.admin_catalog`.
"""

import logging
from typing import Any

from supabase import Client

from app.core.exceptions import ServiceUnavailableError

logger = logging.getLogger(__name__)

_ACTIVITY_COLUMNS = "id,category_id,name,slug,sort_order,is_active,created_at,updated_at"
_ACTIVITY_SELECT = "id,name,slug,icon,sort_order,is_active,activities(id,name,slug,sort_order,is_active)"


def list_categories(supabase: Client, *, include_inactive: bool = False) -> list[dict[str, Any]]:
    """Return categories with their nested activities (sort_order order).

    Public callers get ACTIVE categories only; admin callers pass
    `include_inactive=True` to see the full catalog (including disabled rows).
    """
    try:
        response = (
            supabase.table("categories")
            .select(_ACTIVITY_SELECT)
            .order("sort_order")
            .order("name")
            .execute()
        )
    except Exception as exc:
        logger.exception("Category catalog lookup failed")
        raise ServiceUnavailableError(
            "The category catalog is temporarily unavailable.",
            code="database_unavailable",
        ) from exc
    rows = getattr(response, "data", None) or []
    return [
        _category_payload(row, include_inactive=include_inactive) for row in rows
    ]


def list_activities(supabase: Client, *, include_inactive: bool = False) -> list[dict[str, Any]]:
    """Return activities (sort_order order, then name).

    Public callers get ACTIVE activities only; admin callers pass
    `include_inactive=True` for the full catalog.
    """
    try:
        response = (
            supabase.table("activities")
            .select(_ACTIVITY_COLUMNS)
            .order("sort_order")
            .order("name")
            .execute()
        )
    except Exception as exc:
        logger.exception("Activity catalog lookup failed")
        raise ServiceUnavailableError(
            "The activity catalog is temporarily unavailable.",
            code="database_unavailable",
        ) from exc
    rows = getattr(response, "data", None) or []
    return [
        _activity_payload(row)
        for row in rows
        if include_inactive or row.get("is_active")
    ]


# ---------------------------------------------------------------------------
# Internal helpers.
# ---------------------------------------------------------------------------


def _category_payload(row: dict[str, Any], *, include_inactive: bool) -> dict[str, Any]:
    activities = row.get("activities") or []
    if not include_inactive:
        activities = [a for a in activities if a.get("is_active")]
    return {
        "id": str(row["id"]),
        "name": row.get("name"),
        "slug": row.get("slug"),
        "icon": row.get("icon"),
        "sort_order": row.get("sort_order"),
        "is_active": row.get("is_active"),
        "activities": [_activity_payload(a) for a in activities],
    }


def _activity_payload(row: dict[str, Any]) -> dict[str, Any]:
    return {
        "id": str(row["id"]),
        "category_id": str(row["category_id"]) if row.get("category_id") else None,
        "name": row.get("name"),
        "slug": row.get("slug"),
        "sort_order": row.get("sort_order"),
        "is_active": row.get("is_active"),
    }
