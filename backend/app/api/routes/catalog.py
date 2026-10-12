"""Public opportunity category & activity catalog endpoints.

GET /api/v1/categories — the active categories with their nested activities
    (data-driven; admin-managed through the Admin Console).
GET /api/v1/activities — the flat active activity catalog.

Reference data is public (the database grants anon + authenticated SELECT),
so neither endpoint requires a session. Both return ACTIVE rows only; the
service role bypasses RLS, so the is_active filter is re-applied server-side.
The surfaces are read-only: there is no user-facing catalog write path.
"""

from typing import Any

from fastapi import APIRouter

from app.api.deps import SupabaseDep
from app.services import catalog as catalog_service

router = APIRouter(tags=["catalog"])


@router.get("/categories")
def list_categories(supabase: SupabaseDep) -> list[dict[str, Any]]:
    """Return the active category catalog with nested activities."""
    return catalog_service.list_categories(supabase)


@router.get("/activities")
def list_activities(supabase: SupabaseDep) -> list[dict[str, Any]]:
    """Return the flat active activity catalog."""
    return catalog_service.list_activities(supabase)
