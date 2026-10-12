"""Admin category & activity management (staff-only).

The category/activity system is data-driven: administrators create, rename,
reorder, enable/disable categories and activities without frontend or schema
changes. All routes here are staff-only via the shared `CurrentStaffUserDep`
dependency (bearer token -> staff_admins lookup): unauthenticated → 401,
authenticated non-staff → 403, staff → allowed. No user-facing catalog write
path exists.

GET    /api/v1/admin/categories         — full catalog (incl. inactive)
POST   /api/v1/admin/categories         — create a category
PUT    /api/v1/admin/categories/{id}    — update a category
DELETE /api/v1/admin/categories/{id}    — remove a category

GET    /api/v1/admin/activities         — full activity catalog (incl. inactive)
POST   /api/v1/admin/activities         — create an activity
PUT    /api/v1/admin/activities/{id}    — update an activity (incl. moving it
                                          between categories)
DELETE /api/v1/admin/activities/{id}    — remove an activity
"""

from typing import Any
from uuid import UUID

from fastapi import APIRouter
from pydantic import BaseModel, Field, field_validator

from app.api.deps import CurrentStaffUserDep, SupabaseDep
from app.services import admin_catalog as admin_catalog_service
from app.services import catalog as catalog_service

router = APIRouter(prefix="/admin", tags=["admin"])


class CategoryWrite(BaseModel):
    """Category create/update payload. Every field is required so an update is
    a full replace and never silently clears a field."""

    name: str = Field(min_length=1, max_length=60)
    slug: str = Field(min_length=1, max_length=60)
    icon: str | None = None
    sort_order: int = Field(default=0, ge=0)
    is_active: bool = True

    @field_validator("name", "slug")
    @classmethod
    def _trim(cls, value: str) -> str:
        trimmed = value.strip()
        if not trimmed:
            raise ValueError("must not be blank")
        return trimmed

    @field_validator("icon")
    @classmethod
    def _trim_optional(cls, value: str | None) -> str | None:
        if value is None:
            return None
        trimmed = value.strip()
        return trimmed or None


class ActivityWrite(BaseModel):
    """Activity create/update payload (category assignment is explicit, so an
    activity can be moved between categories by updating category_id)."""

    category_id: UUID
    name: str = Field(min_length=1, max_length=60)
    slug: str = Field(min_length=1, max_length=60)
    sort_order: int = Field(default=0, ge=0)
    is_active: bool = True

    @field_validator("name", "slug")
    @classmethod
    def _trim(cls, value: str) -> str:
        trimmed = value.strip()
        if not trimmed:
            raise ValueError("must not be blank")
        return trimmed


# ---------------------------------------------------------------------------
# Categories.
# ---------------------------------------------------------------------------


@router.get("/categories")
def list_categories(
    _staff_user_id: CurrentStaffUserDep, supabase: SupabaseDep
) -> list[dict[str, Any]]:
    """Return the full category catalog (including inactive)."""
    return catalog_service.list_categories(supabase, include_inactive=True)


@router.post("/categories", status_code=201)
def create_category(
    payload: CategoryWrite,
    _staff_user_id: CurrentStaffUserDep,
    supabase: SupabaseDep,
) -> dict[str, Any]:
    """Create a category."""
    return admin_catalog_service.create_category(
        supabase,
        name=payload.name,
        slug=payload.slug,
        icon=payload.icon,
        sort_order=payload.sort_order,
        is_active=payload.is_active,
    )


@router.put("/categories/{category_id}")
def update_category(
    category_id: UUID,
    payload: CategoryWrite,
    _staff_user_id: CurrentStaffUserDep,
    supabase: SupabaseDep,
) -> dict[str, Any]:
    """Update a category (full replace)."""
    return admin_catalog_service.update_category(
        supabase,
        category_id,
        name=payload.name,
        slug=payload.slug,
        icon=payload.icon,
        sort_order=payload.sort_order,
        is_active=payload.is_active,
    )


@router.delete("/categories/{category_id}")
def delete_category(
    category_id: UUID,
    _staff_user_id: CurrentStaffUserDep,
    supabase: SupabaseDep,
) -> dict[str, Any]:
    """Remove a category (409 if an opportunity still references it)."""
    return admin_catalog_service.delete_category(supabase, category_id)


# ---------------------------------------------------------------------------
# Activities.
# ---------------------------------------------------------------------------


@router.get("/activities")
def list_activities(
    _staff_user_id: CurrentStaffUserDep, supabase: SupabaseDep
) -> list[dict[str, Any]]:
    """Return the full activity catalog (including inactive)."""
    return catalog_service.list_activities(supabase, include_inactive=True)


@router.post("/activities", status_code=201)
def create_activity(
    payload: ActivityWrite,
    _staff_user_id: CurrentStaffUserDep,
    supabase: SupabaseDep,
) -> dict[str, Any]:
    """Create an activity under a category."""
    return admin_catalog_service.create_activity(
        supabase,
        category_id=payload.category_id,
        name=payload.name,
        slug=payload.slug,
        sort_order=payload.sort_order,
        is_active=payload.is_active,
    )


@router.put("/activities/{activity_id}")
def update_activity(
    activity_id: UUID,
    payload: ActivityWrite,
    _staff_user_id: CurrentStaffUserDep,
    supabase: SupabaseDep,
) -> dict[str, Any]:
    """Update an activity (may move it to another category)."""
    return admin_catalog_service.update_activity(
        supabase,
        activity_id,
        category_id=payload.category_id,
        name=payload.name,
        slug=payload.slug,
        sort_order=payload.sort_order,
        is_active=payload.is_active,
    )


@router.delete("/activities/{activity_id}")
def delete_activity(
    activity_id: UUID,
    _staff_user_id: CurrentStaffUserDep,
    supabase: SupabaseDep,
) -> dict[str, Any]:
    """Remove an activity (opportunities referencing it get NULL)."""
    return admin_catalog_service.delete_activity(supabase, activity_id)
