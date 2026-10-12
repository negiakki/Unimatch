"""Contextual (opportunity-scoped) discovery and actions.

  * GET  /api/v1/opportunities/{id}/discovery — the eligible people feed for
    ONE opportunity (the candidate pool is that opportunity's applicants, with
    both sides' partner preferences respected).
  * POST /api/v1/opportunities/{id}/discovery/{profile_id}/interest — record
    interest; a mutual interest in the SAME opportunity creates a contextual
    match.
  * POST /api/v1/opportunities/{id}/discovery/{profile_id}/pass — record a pass.

The opportunity is the context: every action and match carries an
opportunity_id, so the same two people can connect independently through
different opportunities and nothing leaks across opportunity contexts.

The public opportunity browse/detail surface lives in
`app.api.routes.opportunities` and the application lifecycle in
`app.api.routes.applications`; a caller must have applied to the opportunity to
reach any of these.
"""

from typing import Annotated, Any
from uuid import UUID

from fastapi import APIRouter, Query

from app.api.deps import CurrentAuthUserDep, SettingsDep, SupabaseDep
from app.services import contextual as contextual_service
from app.services import dating as dating_service

router = APIRouter(tags=["opportunities"])


@router.get("/opportunities/{opportunity_id}/discovery")
def get_opportunity_discovery(
    opportunity_id: UUID,
    auth_user_id: CurrentAuthUserDep,
    supabase: SupabaseDep,
    settings: SettingsDep,
    limit: Annotated[
        int,
        Query(
            ge=1,
            le=contextual_service.MAX_LIMIT,
            description="Page size (1-50).",
        ),
    ] = contextual_service.DEFAULT_LIMIT,
    cursor: Annotated[
        str | None,
        Query(description="Opaque cursor from the previous page's next_cursor."),
    ] = None,
) -> dict[str, Any]:
    """Return the eligible people feed for one opportunity."""
    return contextual_service.get_opportunity_discovery(
        supabase,
        auth_user_id,
        opportunity_id,
        limit=limit,
        cursor=cursor,
        bucket=settings.profile_photos_bucket_name,
        signed_url_ttl=settings.profile_photos_signed_url_ttl_seconds,
    )


@router.post("/opportunities/{opportunity_id}/discovery/{profile_id}/interest")
def record_interest(
    opportunity_id: UUID,
    profile_id: UUID,
    auth_user_id: CurrentAuthUserDep,
    supabase: SupabaseDep,
    settings: SettingsDep,
) -> dict[str, Any]:
    """Record interest in someone through this opportunity (mutual -> match)."""
    return dating_service.like_in_opportunity(
        supabase,
        auth_user_id,
        profile_id,
        opportunity_id,
        bucket=settings.profile_photos_bucket_name,
        signed_url_ttl=settings.profile_photos_signed_url_ttl_seconds,
    )


@router.post("/opportunities/{opportunity_id}/discovery/{profile_id}/pass")
def record_pass(
    opportunity_id: UUID,
    profile_id: UUID,
    auth_user_id: CurrentAuthUserDep,
    supabase: SupabaseDep,
) -> dict[str, Any]:
    """Record a pass on someone within this opportunity."""
    return dating_service.pass_in_opportunity(
        supabase, auth_user_id, profile_id, opportunity_id
    )
