"""Public opportunity browse and detail.

GET /api/v1/opportunities          — browse PUBLISHED opportunities, newest
                                      first, optionally filtered by category or
                                      activity.
GET /api/v1/opportunities/{id}     — one PUBLISHED opportunity's detail.

Both are public: the database grants anon + authenticated SELECT on PUBLISHED
opportunities only, and the service role bypasses RLS, so the PUBLISHED filter
is re-applied in the service layer. A non-PUBLISHED or unknown id surfaces the
same 404, so there is no existence leak for content that is not public.

Authenticated surfaces over the same resource (apply, My Activity, contextual
discovery and interest/pass) live in `app.api.routes.applications` and
`app.api.routes.opportunity_discovery`.
"""

from typing import Annotated, Any
from uuid import UUID

from fastapi import APIRouter, Query

from app.api.deps import SupabaseDep
from app.services import opportunities as opportunities_service

router = APIRouter(tags=["opportunities"])


@router.get("/opportunities")
def list_opportunities(
    supabase: SupabaseDep,
    category_id: Annotated[UUID | None, Query(description="Filter by category.")] = None,
    activity_id: Annotated[UUID | None, Query(description="Filter by activity.")] = None,
) -> list[dict[str, Any]]:
    """Browse PUBLISHED opportunities (newest first)."""
    return opportunities_service.list_opportunities(
        supabase, category_id=category_id, activity_id=activity_id
    )


@router.get("/opportunities/{opportunity_id}")
def get_opportunity(
    opportunity_id: UUID, supabase: SupabaseDep
) -> dict[str, Any]:
    """Return one PUBLISHED opportunity's detail."""
    return opportunities_service.get_opportunity(supabase, opportunity_id)
