"""Category & activity catalog ADMIN writes (staff-only).

Create/update/delete for categories and activities. Authorization is the
existing staff check (`CurrentStaffUserDep` on the admin route) over the
service role, which is the only writer. Database CHECKs and unique indexes
remain authoritative for names/slugs/ordering; constraint failures are
translated into clean API errors.

The public read surface stays in `app.services.catalog`; the payload builders
are shared from there so both projections cannot drift.
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
from app.services.catalog import _activity_payload, _category_payload

logger = logging.getLogger(__name__)


# ---------------------------------------------------------------------------
# Admin CRUD — categories.
# ---------------------------------------------------------------------------


def create_category(
    supabase: Client, *, name: str, slug: str, icon: str | None, sort_order: int, is_active: bool
) -> dict[str, Any]:
    """Create a category (staff-only; the service role is the only writer)."""
    try:
        response = (
            supabase.table("categories")
            .insert(
                {
                    "name": name,
                    "slug": slug,
                    "icon": icon,
                    "sort_order": sort_order,
                    "is_active": is_active,
                }
            )
            .execute()
        )
    except Exception as exc:
        _raise_catalog_write_error(exc, "category", "created")
    rows = getattr(response, "data", None) or []
    if not rows:
        raise ServiceUnavailableError(
            "The category could not be created.", code="database_insert_failed"
        )
    return _category_payload(rows[0], include_inactive=True)


def update_category(
    supabase: Client, category_id: UUID, *, name: str, slug: str, icon: str | None, sort_order: int, is_active: bool
) -> dict[str, Any]:
    """Update a category (staff-only). 404 when the category is unknown."""
    _require_category(supabase, category_id)
    try:
        response = (
            supabase.table("categories")
            .update(
                {
                    "name": name,
                    "slug": slug,
                    "icon": icon,
                    "sort_order": sort_order,
                    "is_active": is_active,
                }
            )
            .eq("id", str(category_id))
            .execute()
        )
    except Exception as exc:
        _raise_catalog_write_error(exc, "category", "updated")
    rows = getattr(response, "data", None) or []
    if not rows:
        raise ServiceUnavailableError(
            "The category could not be updated.", code="database_update_failed"
        )
    return _category_payload(rows[0], include_inactive=True)


def delete_category(supabase: Client, category_id: UUID) -> dict[str, Any]:
    """Delete a category (staff-only).

    Activities under the category cascade away (schema), so a category with
    live opportunities is protected by the FK from opportunities (restrict).
    """
    _require_category(supabase, category_id)
    try:
        response = (
            supabase.table("categories").delete().eq("id", str(category_id)).execute()
        )
    except Exception as exc:
        detail = str(exc)
        if "foreign key" in detail or "opportunities_category_id_fkey" in detail:
            raise ConflictError(
                "This category is in use by opportunities and cannot be removed.",
                code="category_in_use",
            ) from exc
        logger.exception("Category delete failed")
        raise ServiceUnavailableError(
            "The category could not be removed.", code="database_delete_failed"
        ) from exc
    if not getattr(response, "data", None):
        raise NotFoundError("Category not found.")
    return {"id": str(category_id), "deleted": True}


# ---------------------------------------------------------------------------
# Admin CRUD — activities.
# ---------------------------------------------------------------------------


def create_activity(
    supabase: Client,
    *,
    category_id: UUID,
    name: str,
    slug: str,
    sort_order: int,
    is_active: bool,
) -> dict[str, Any]:
    """Create an activity under a category (staff-only)."""
    _require_category(supabase, category_id)
    try:
        response = (
            supabase.table("activities")
            .insert(
                {
                    "category_id": str(category_id),
                    "name": name,
                    "slug": slug,
                    "sort_order": sort_order,
                    "is_active": is_active,
                }
            )
            .execute()
        )
    except Exception as exc:
        _raise_catalog_write_error(exc, "activity", "created")
    rows = getattr(response, "data", None) or []
    if not rows:
        raise ServiceUnavailableError(
            "The activity could not be created.", code="database_insert_failed"
        )
    return _activity_payload(rows[0])


def update_activity(
    supabase: Client,
    activity_id: UUID,
    *,
    category_id: UUID,
    name: str,
    slug: str,
    sort_order: int,
    is_active: bool,
) -> dict[str, Any]:
    """Update an activity (staff-only). 404 when the activity is unknown."""
    _require_activity(supabase, activity_id)
    _require_category(supabase, category_id)
    try:
        response = (
            supabase.table("activities")
            .update(
                {
                    "category_id": str(category_id),
                    "name": name,
                    "slug": slug,
                    "sort_order": sort_order,
                    "is_active": is_active,
                }
            )
            .eq("id", str(activity_id))
            .execute()
        )
    except Exception as exc:
        _raise_catalog_write_error(exc, "activity", "updated")
    rows = getattr(response, "data", None) or []
    if not rows:
        raise ServiceUnavailableError(
            "The activity could not be updated.", code="database_update_failed"
        )
    return _activity_payload(rows[0])


def delete_activity(supabase: Client, activity_id: UUID) -> dict[str, Any]:
    """Delete an activity (staff-only).

    Opportunities referencing the activity get NULL (schema SET NULL), so a
    deletion is always safe.
    """
    _require_activity(supabase, activity_id)
    try:
        response = (
            supabase.table("activities").delete().eq("id", str(activity_id)).execute()
        )
    except Exception as exc:
        logger.exception("Activity delete failed")
        raise ServiceUnavailableError(
            "The activity could not be removed.", code="database_delete_failed"
        ) from exc
    if not getattr(response, "data", None):
        raise NotFoundError("Activity not found.")
    return {"id": str(activity_id), "deleted": True}


# ---------------------------------------------------------------------------
# Internal helpers.
# ---------------------------------------------------------------------------


def _require_category(supabase: Client, category_id: UUID) -> None:
    try:
        response = (
            supabase.table("categories")
            .select("id")
            .eq("id", str(category_id))
            .maybe_single()
            .execute()
        )
    except Exception as exc:
        logger.exception("Category lookup failed")
        raise ServiceUnavailableError(
            "The category catalog is temporarily unavailable.",
            code="database_unavailable",
        ) from exc
    if not getattr(response, "data", response):
        raise NotFoundError("Category not found.")


def _require_activity(supabase: Client, activity_id: UUID) -> None:
    try:
        response = (
            supabase.table("activities")
            .select("id")
            .eq("id", str(activity_id))
            .maybe_single()
            .execute()
        )
    except Exception as exc:
        logger.exception("Activity lookup failed")
        raise ServiceUnavailableError(
            "The activity catalog is temporarily unavailable.",
            code="database_unavailable",
        ) from exc
    if not getattr(response, "data", response):
        raise NotFoundError("Activity not found.")


def _raise_catalog_write_error(exc: Exception, noun: str, verb: str) -> None:
    detail = str(exc)
    if "duplicate key" in detail:
        raise ConflictError(
            f"A {noun} with that name or slug already exists.",
            code="duplicate_catalog_entry",
        ) from exc
    if "foreign key" in detail:
        raise ConflictError(
            "The referenced category does not exist.",
            code="invalid_category",
        ) from exc
    logger.exception("Catalog write failed")
    raise ServiceUnavailableError(
        f"The {noun} could not be {verb}. Please try again later.",
        code="database_write_failed",
    ) from exc
