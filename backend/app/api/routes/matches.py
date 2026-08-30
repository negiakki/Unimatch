"""Matches endpoints for verified students.

GET /api/v1/matches — the caller's ACTIVE matches (newest first) with
client-safe matched-profile payloads. DELETE /api/v1/matches/{match_id} —
participant-only soft unmatch (unmatched_at is set server-side; the row is
retained so an unmatched pair cannot rematch through normal discovery).

Identity derives exclusively from the Supabase bearer token; match creation
happens only inside the like flow's service-role atomic operation — there is
no client-facing match create/update path. Unknown matches, nonparticipants,
and already-unmatched matches all surface 404 (no existence leak).
"""

from typing import Any
from uuid import UUID

from fastapi import APIRouter

from app.api.deps import CurrentAuthUserDep, SettingsDep, SupabaseDep
from app.services import dating as dating_service

router = APIRouter(prefix="/matches", tags=["matches"])


@router.get("")
def list_matches(
    auth_user_id: CurrentAuthUserDep,
    supabase: SupabaseDep,
    settings: SettingsDep,
) -> dict[str, Any]:
    """List the caller's active matches."""
    return dating_service.list_matches(
        supabase,
        auth_user_id,
        bucket=settings.profile_photos_bucket_name,
        signed_url_ttl=settings.profile_photos_signed_url_ttl_seconds,
    )


@router.delete("/{match_id}")
def unmatch(
    match_id: UUID,
    auth_user_id: CurrentAuthUserDep,
    supabase: SupabaseDep,
) -> dict[str, Any]:
    """Soft-unmatch an active match (participants only)."""
    return dating_service.unmatch(supabase, auth_user_id, match_id)
