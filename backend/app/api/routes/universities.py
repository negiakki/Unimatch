"""Read-only university catalog endpoint.

GET /api/v1/universities — the supported-university catalog used by the
onboarding profile form. Authentication is required; the surface is
read-only by design (catalog mutation is service-role territory and doubly
blocked at the database for normal users), so students can never create or
modify catalog entries.
"""

from typing import Any

from fastapi import APIRouter

from app.api.deps import CurrentAuthUserDep, SupabaseDep
from app.services import profile as profile_service

router = APIRouter(prefix="/universities", tags=["universities"])


@router.get("")
def list_universities(
    _auth_user_id: CurrentAuthUserDep,
    supabase: SupabaseDep,
) -> list[dict[str, Any]]:
    """Return the supported university catalog (name order)."""
    return profile_service.list_universities(supabase)
