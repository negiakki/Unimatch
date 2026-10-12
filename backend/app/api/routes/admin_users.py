"""Admin dashboard, user directory, and security endpoints (staff-only).

Every route here is staff-only via the shared `CurrentStaffUserDep` dependency
(bearer token -> `public.staff_admins` lookup via the service-role client):
unauthenticated → 401, authenticated non-staff → 403, staff → allowed.
Frontend route protection is never treated as security.

GET    /api/v1/admin/dashboard             — real platform metrics (counts)
GET    /api/v1/admin/users                — user directory (optional name search)
GET    /api/v1/admin/users/{profile_id}   — one user's admin-safe record

Security (account-level restriction via `public.suspensions`):

POST   /api/v1/admin/users/{profile_id}/block       — indefinite block
DELETE /api/v1/admin/users/{profile_id}/block       — lift the block
POST   /api/v1/admin/users/{profile_id}/suspend     — timed suspension
DELETE /api/v1/admin/users/{profile_id}/suspension  — lift active suspensions
GET    /api/v1/admin/suspensions                    — active suspensions

User-to-user block moderation (the existing `blocks` table):

GET    /api/v1/admin/blocks             — blocks for moderation
DELETE /api/v1/admin/blocks/{block_id}  — lift a specific block

No invasive surveillance: the user directory exposes only first name, course,
academic year, gender, university, created_at, verification status, and
account status — never auth ids, emails, date_of_birth, verification
documents, or storage paths.
"""

from datetime import datetime
from typing import Annotated, Any
from uuid import UUID

from fastapi import APIRouter, Query
from pydantic import BaseModel, Field, field_validator

from app.api.deps import CurrentStaffUserDep, SupabaseDep
from app.services import admin as admin_service
from app.services import safety as safety_service

router = APIRouter(prefix="/admin", tags=["admin"])


class SuspensionWrite(BaseModel):
    """Suspension payload. `reason` is required and trimmed; the caller (staff)
    supplies it — the identity is always server-derived."""

    reason: str = Field(min_length=1, max_length=500)
    suspended_until: datetime | None = None

    @field_validator("reason")
    @classmethod
    def _trim(cls, value: str) -> str:
        trimmed = value.strip()
        if not trimmed:
            raise ValueError("reason must not be blank")
        return trimmed


class ReportDecisionRequest(BaseModel):
    """Report decision payload. Only `status` is meaningful; the reviewer is
    server-derived from the token and never accepted from the client."""

    status: str

    @field_validator("status")
    @classmethod
    def _validate(cls, value: str) -> str:
        allowed = ("OPEN", "REVIEWED", "DISMISSED")
        if value not in allowed:
            raise ValueError(f"status must be one of {allowed}")
        return value


# ---------------------------------------------------------------------------
# Dashboard.
# ---------------------------------------------------------------------------


@router.get("/dashboard")
def get_dashboard(
    _staff_user_id: CurrentStaffUserDep, supabase: SupabaseDep
) -> dict[str, Any]:
    """Return real platform counts for the admin dashboard."""
    return admin_service.get_dashboard_metrics(supabase)


# ---------------------------------------------------------------------------
# User directory.
# ---------------------------------------------------------------------------


@router.get("/users")
def list_users(
    _staff_user_id: CurrentStaffUserDep,
    supabase: SupabaseDep,
    q: Annotated[str | None, Query(description="Case-insensitive first-name search.")] = None,
    limit: Annotated[int, Query(ge=1, le=50, description="Page size (1-50).")] = 50,
) -> list[dict[str, Any]]:
    """Return admin-safe user records with account status."""
    return admin_service.search_users(supabase, query=q, limit=limit)


@router.get("/users/{profile_id}")
def get_user(
    profile_id: UUID,
    _staff_user_id: CurrentStaffUserDep,
    supabase: SupabaseDep,
) -> dict[str, Any]:
    """Return one admin-safe user record with account status."""
    return admin_service.get_user_detail(supabase, profile_id)


# ---------------------------------------------------------------------------
# Security — account-level restriction (suspensions).
# ---------------------------------------------------------------------------


@router.post("/users/{profile_id}/block", status_code=201)
def block_user(
    profile_id: UUID,
    payload: SuspensionWrite,
    staff_user_id: CurrentStaffUserDep,
    supabase: SupabaseDep,
) -> dict[str, Any]:
    """Indefinitely block (suspend) a user. `suspended_until` is ignored (a block
    has no expiry)."""
    return admin_service.suspend_user(
        supabase,
        staff_user_id,
        profile_id,
        reason=payload.reason,
        suspended_until=None,
    )


@router.delete("/users/{profile_id}/block")
def unblock_user(
    profile_id: UUID,
    _staff_user_id: CurrentStaffUserDep,
    supabase: SupabaseDep,
) -> dict[str, Any]:
    """Lift an indefinite block (removes active suspensions)."""
    return admin_service.unsuspend_user(supabase, profile_id)


@router.post("/users/{profile_id}/suspend", status_code=201)
def suspend_user(
    profile_id: UUID,
    payload: SuspensionWrite,
    staff_user_id: CurrentStaffUserDep,
    supabase: SupabaseDep,
) -> dict[str, Any]:
    """Timed-suspend a user (optionally indefinite if `suspended_until` is null)."""
    return admin_service.suspend_user(
        supabase,
        staff_user_id,
        profile_id,
        reason=payload.reason,
        suspended_until=payload.suspended_until,
    )


@router.delete("/users/{profile_id}/suspension")
def unsuspend_user(
    profile_id: UUID,
    _staff_user_id: CurrentStaffUserDep,
    supabase: SupabaseDep,
) -> dict[str, Any]:
    """Lift all active suspensions on a user."""
    return admin_service.unsuspend_user(supabase, profile_id)


@router.get("/suspensions")
def list_suspensions(
    _staff_user_id: CurrentStaffUserDep, supabase: SupabaseDep
) -> list[dict[str, Any]]:
    """List active suspensions (newest first)."""
    return admin_service.list_suspensions(supabase)


# ---------------------------------------------------------------------------
# Security — user-to-user block moderation.
# ---------------------------------------------------------------------------


@router.get("/blocks")
def list_blocks(
    _staff_user_id: CurrentStaffUserDep, supabase: SupabaseDep
) -> list[dict[str, Any]]:
    """List user-to-user blocks for moderation."""
    return safety_service.list_admin_blocks(supabase)


@router.delete("/blocks/{block_id}")
def remove_block(
    block_id: UUID,
    _staff_user_id: CurrentStaffUserDep,
    supabase: SupabaseDep,
) -> dict[str, Any]:
    """Lift a specific user-to-user block."""
    return safety_service.remove_admin_block(supabase, block_id)


# ---------------------------------------------------------------------------
# Report decisions.
# ---------------------------------------------------------------------------


@router.post("/reports/{report_id}/decision")
def decide_report(
    report_id: UUID,
    payload: ReportDecisionRequest,
    _staff_user_id: CurrentStaffUserDep,
    supabase: SupabaseDep,
) -> dict[str, Any]:
    """Record a staff decision on a report (OPEN / REVIEWED / DISMISSED)."""
    return safety_service.decide_report(supabase, report_id, payload.status)
