"""Read-only interest catalog endpoint.

GET /api/v1/interests — the shared interest catalog used by the profile
forms (onboarding selection and later edits). Authentication is required;
the surface is read-only by design (catalog mutation is service-role
territory and doubly blocked at the database for normal users), so students
can never create or modify catalog entries. The list is ordered
deterministically by name and exposes only client-safe fields (`id`, `name`).
"""

from typing import Any

from fastapi import APIRouter

from app.api.deps import CurrentAuthUserDep, SupabaseDep
from app.services import profile as profile_service

router = APIRouter(prefix="/interests", tags=["interests"])


@router.get("")
def list_interests(
    _auth_user_id: CurrentAuthUserDep,
    supabase: SupabaseDep,
) -> list[dict[str, Any]]:
    """Return the interest catalog (name order)."""
    return profile_service.list_interests(supabase)
