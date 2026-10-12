"""Application lifecycle (authenticated student surfaces).

  * POST /api/v1/opportunities/{id}/applications — apply with the caller's
    EXISTING universal profile (never a duplicated profile, never a new one);
    requires VERIFIED + PUBLISHED; duplicates are rejected (409).
  * GET  /api/v1/applications                 — the caller's "My Activity".
  * POST /api/v1/applications/{id}/withdraw   — withdraw (APPLIED -> WITHDRAWN).

Identity comes exclusively from the Supabase bearer token: the profile is
resolved server-side, so a client-supplied `profile_id` cannot apply as
someone else and can never supply the application's profile. The public
opportunity browse/detail surface lives in `app.api.routes.opportunities`.
"""

from typing import Any
from uuid import UUID

from fastapi import APIRouter

from app.api.deps import CurrentAuthUserDep, SupabaseDep
from app.services import applications as applications_service

router = APIRouter(tags=["opportunities"])


@router.post("/opportunities/{opportunity_id}/applications", status_code=201)
def apply_to_opportunity(
    opportunity_id: UUID,
    auth_user_id: CurrentAuthUserDep,
    supabase: SupabaseDep,
) -> dict[str, Any]:
    """Apply to a PUBLISHED opportunity with the caller's existing profile."""
    return applications_service.apply_to_opportunity(
        supabase, auth_user_id, opportunity_id
    )


@router.get("/applications")
def list_my_applications(
    auth_user_id: CurrentAuthUserDep, supabase: SupabaseDep
) -> dict[str, Any]:
    """List the caller's applications (My Activity) with opportunity context."""
    return applications_service.list_my_applications(supabase, auth_user_id)


@router.post("/applications/{application_id}/withdraw")
def withdraw_application(
    application_id: UUID,
    auth_user_id: CurrentAuthUserDep,
    supabase: SupabaseDep,
) -> dict[str, Any]:
    """Withdraw one of the caller's applications."""
    return applications_service.withdraw_application(
        supabase, auth_user_id, application_id
    )
