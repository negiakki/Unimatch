"""Admin opportunity management (staff-only).

Admin-created opportunities are the primary source of partner-finding
activities. All routes are staff-only via the shared `CurrentStaffUserDep`
dependency (bearer token -> staff_admins): unauthenticated → 401,
authenticated non-staff → 403, staff → allowed.

GET    /api/v1/admin/opportunities                 — all opportunities (any state)
POST   /api/v1/admin/opportunities                 — create (born DRAFT)
GET    /api/v1/admin/opportunities/{id}            — one opportunity (any state)
PUT    /api/v1/admin/opportunities/{id}            — edit a DRAFT opportunity
DELETE /api/v1/admin/opportunities/{id}            — remove an opportunity
POST   /api/v1/admin/opportunities/{id}/publish    — DRAFT/PAUSED -> PUBLISHED
POST   /api/v1/admin/opportunities/{id}/pause      — PUBLISHED -> PAUSED
POST   /api/v1/admin/opportunities/{id}/cancel     — PUBLISHED -> CANCELLED
POST   /api/v1/admin/opportunities/{id}/expire     — PUBLISHED -> EXPIRED
GET    /api/v1/admin/opportunities/{id}/applications — who applied

The state machine (DRAFT -> PUBLISHED -> PAUSED -> CANCELLED -> EXPIRED) is
enforced here and re-checked by the database status CHECK; only PUBLISHED
opportunities are publicly visible, so a non-published transition immediately
removes an opportunity from the public surface. Normal users hold no write
path at all — this is the only place opportunities are managed.
"""

from datetime import date, datetime, time
from typing import Annotated, Any
from uuid import UUID

from fastapi import APIRouter, Query
from pydantic import BaseModel, Field, field_validator

from app.api.deps import CurrentStaffUserDep, SupabaseDep
from app.core.exceptions import BadRequestError
from app.services import admin_opportunities as admin_opportunities_service

router = APIRouter(prefix="/admin", tags=["admin"])

# Mirrors the database CHECK: opportunities_status_valid.
_OPPORTUNITY_STATES = ("DRAFT", "PUBLISHED", "PAUSED", "CANCELLED", "EXPIRED")


class OpportunityWrite(BaseModel):
    """Create/update payload for an opportunity.

    `status` is intentionally NOT accepted here: an opportunity is born DRAFT
    and only moves between states through the dedicated transition endpoints,
    so the state machine stays explicit and auditable.
    """

    title: str = Field(min_length=1, max_length=120)
    category_id: UUID
    activity_id: UUID | None = None
    description: str = Field(default="", max_length=2000)
    opportunity_date: date | None = None
    start_time: time | None = None
    end_time: time | None = None
    location: str | None = Field(default=None, max_length=200)
    cover_image_url: str | None = Field(default=None, max_length=1024)
    capacity: int | None = Field(default=None, gt=0)
    partner_requirement: str | None = Field(default=None, max_length=200)
    expiry: datetime | None = None

    @field_validator("title", "location", "cover_image_url", "partner_requirement")
    @classmethod
    def _trim(cls, value: str | None, info) -> str | None:
        if value is None:
            return None
        trimmed = value.strip()
        if info.field_name == "title":
            # Title is NOT NULL and must be 1..120 chars trimmed.
            if not trimmed:
                raise ValueError("title must not be blank")
            return trimmed
        # The optional fields may be blanked by submitting "".
        return trimmed or None

    @field_validator("description")
    @classmethod
    def _trim_description(cls, value: str) -> str:
        return value.strip()

    @field_validator("end_time")
    @classmethod
    def _check_times(cls, value: time | None, info) -> time | None:
        start = info.data.get("start_time")
        if value is not None and start is not None and value <= start:
            raise ValueError("end_time must be after start_time")
        return value


def _opportunity_row(payload: OpportunityWrite) -> dict[str, Any]:
    """Project the validated payload into the database column shape."""
    return {
        "title": payload.title,
        "category_id": str(payload.category_id),
        "activity_id": str(payload.activity_id) if payload.activity_id else None,
        "description": payload.description,
        "opportunity_date": payload.opportunity_date.isoformat()
        if payload.opportunity_date
        else None,
        "start_time": payload.start_time.strftime("%H:%M:%S")
        if payload.start_time
        else None,
        "end_time": payload.end_time.strftime("%H:%M:%S") if payload.end_time else None,
        "location": payload.location,
        "cover_image_url": payload.cover_image_url,
        "capacity": payload.capacity,
        "partner_requirement": payload.partner_requirement,
        "expiry": payload.expiry.isoformat() if payload.expiry else None,
    }


@router.get("/opportunities")
def list_opportunities(
    _staff_user_id: CurrentStaffUserDep,
    supabase: SupabaseDep,
    status: Annotated[
        str | None,
        Query(description="Optional state filter (DRAFT/PUBLISHED/PAUSED/CANCELLED/EXPIRED)."),
    ] = None,
) -> list[dict[str, Any]]:
    """List all opportunities (any state), newest first."""
    if status is not None and status not in _OPPORTUNITY_STATES:
        raise BadRequestError("Unknown opportunity state.", code="invalid_state")
    return admin_opportunities_service.list_admin_opportunities(supabase, status=status)


@router.post("/opportunities", status_code=201)
def create_opportunity(
    payload: OpportunityWrite,
    staff_user_id: CurrentStaffUserDep,
    supabase: SupabaseDep,
) -> dict[str, Any]:
    """Create a DRAFT opportunity."""
    return admin_opportunities_service.create_opportunity(
        supabase, staff_user_id, _opportunity_row(payload)
    )


@router.get("/opportunities/{opportunity_id}")
def get_opportunity(
    opportunity_id: UUID,
    _staff_user_id: CurrentStaffUserDep,
    supabase: SupabaseDep,
) -> dict[str, Any]:
    """Return one opportunity in any state."""
    return admin_opportunities_service.get_admin_opportunity(supabase, opportunity_id)


@router.put("/opportunities/{opportunity_id}")
def update_opportunity(
    opportunity_id: UUID,
    payload: OpportunityWrite,
    _staff_user_id: CurrentStaffUserDep,
    supabase: SupabaseDep,
) -> dict[str, Any]:
    """Edit a DRAFT opportunity (409 for any other state)."""
    return admin_opportunities_service.update_opportunity(
        supabase, opportunity_id, _opportunity_row(payload)
    )


@router.delete("/opportunities/{opportunity_id}")
def delete_opportunity(
    opportunity_id: UUID,
    _staff_user_id: CurrentStaffUserDep,
    supabase: SupabaseDep,
) -> dict[str, Any]:
    """Remove an opportunity (applications/actions/matches cascade away)."""
    return admin_opportunities_service.delete_opportunity(supabase, opportunity_id)


@router.post("/opportunities/{opportunity_id}/publish")
def publish_opportunity(
    opportunity_id: UUID,
    staff_user_id: CurrentStaffUserDep,
    supabase: SupabaseDep,
) -> dict[str, Any]:
    """Publish an opportunity (makes it publicly visible)."""
    return admin_opportunities_service.set_opportunity_status(
        supabase, staff_user_id, opportunity_id, "PUBLISHED"
    )


@router.post("/opportunities/{opportunity_id}/pause")
def pause_opportunity(
    opportunity_id: UUID,
    staff_user_id: CurrentStaffUserDep,
    supabase: SupabaseDep,
) -> dict[str, Any]:
    """Pause a PUBLISHED opportunity (hides it from the public surface)."""
    return admin_opportunities_service.set_opportunity_status(
        supabase, staff_user_id, opportunity_id, "PAUSED"
    )


@router.post("/opportunities/{opportunity_id}/cancel")
def cancel_opportunity(
    opportunity_id: UUID,
    staff_user_id: CurrentStaffUserDep,
    supabase: SupabaseDep,
) -> dict[str, Any]:
    """Cancel a PUBLISHED opportunity (terminal)."""
    return admin_opportunities_service.set_opportunity_status(
        supabase, staff_user_id, opportunity_id, "CANCELLED"
    )


@router.post("/opportunities/{opportunity_id}/expire")
def expire_opportunity(
    opportunity_id: UUID,
    staff_user_id: CurrentStaffUserDep,
    supabase: SupabaseDep,
) -> dict[str, Any]:
    """Expire a PUBLISHED opportunity."""
    return admin_opportunities_service.set_opportunity_status(
        supabase, staff_user_id, opportunity_id, "EXPIRED"
    )


@router.get("/opportunities/{opportunity_id}/applications")
def list_opportunity_applications(
    opportunity_id: UUID,
    _staff_user_id: CurrentStaffUserDep,
    supabase: SupabaseDep,
) -> list[dict[str, Any]]:
    """List who applied to an opportunity (admin)."""
    return admin_opportunities_service.list_opportunity_applications(
        supabase, opportunity_id
    )
