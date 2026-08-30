"""Discovery feed endpoint for verified students.

GET /api/v1/discovery/feed — an ordered, cursor-paginated feed of eligible
candidate profiles.

The viewer is derived exclusively from the Supabase bearer token
(CurrentAuthenticatedUser dependency): the client can never supply an
`auth_user_id` or viewer `profile_id`. The viewer's profile is resolved
server-side and must be VERIFIED (403 permission_denied otherwise). Only
client-safe fields are returned — age is derived from date_of_birth, and
auth_user_id, verification data, and storage paths are never exposed.

Query parameters:
  * `limit` — page size, default 20, max 50 (422 outside 1..50).
  * `cursor` — opaque pagination cursor from the previous page's
    `next_cursor`; omitted on the first page.
"""

from typing import Annotated, Any
from uuid import UUID

from fastapi import APIRouter, Query

from app.api.deps import CurrentAuthUserDep, SettingsDep, SupabaseDep
from app.services import dating as dating_service
from app.services import discovery as discovery_service

router = APIRouter(prefix="/discovery", tags=["discovery"])


@router.get("/feed")
def get_discovery_feed(
    auth_user_id: CurrentAuthUserDep,
    supabase: SupabaseDep,
    settings: SettingsDep,
    limit: Annotated[
        int,
        Query(ge=1, le=discovery_service.MAX_LIMIT, description="Page size (1-50)."),
    ] = discovery_service.DEFAULT_LIMIT,
    cursor: Annotated[
        str | None,
        Query(description="Opaque cursor from the previous page's next_cursor."),
    ] = None,
) -> dict[str, Any]:
    """Return the verified viewer's eligible candidate feed."""
    return discovery_service.get_discovery_feed(
        supabase,
        auth_user_id,
        limit=limit,
        cursor=cursor,
        bucket=settings.profile_photos_bucket_name,
        signed_url_ttl=settings.profile_photos_signed_url_ttl_seconds,
    )


@router.post("/{profile_id}/like")
def like_candidate(
    profile_id: UUID,
    auth_user_id: CurrentAuthUserDep,
    supabase: SupabaseDep,
    settings: SettingsDep,
) -> dict[str, Any]:
    """Record the viewer's LIKE; create the match on a mutual LIKE."""
    return dating_service.like_candidate(
        supabase,
        auth_user_id,
        profile_id,
        bucket=settings.profile_photos_bucket_name,
        signed_url_ttl=settings.profile_photos_signed_url_ttl_seconds,
    )


@router.post("/{profile_id}/pass")
def pass_candidate(
    profile_id: UUID,
    auth_user_id: CurrentAuthUserDep,
    supabase: SupabaseDep,
) -> dict[str, Any]:
    """Record the viewer's PASS."""
    return dating_service.pass_candidate(supabase, auth_user_id, profile_id)
