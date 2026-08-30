"""Blocks endpoints for verified students (Phase 8).

POST   /api/v1/blocks — block a VERIFIED profile (idempotent: re-blocking
       returns the existing row; reversible via unblock).
GET    /api/v1/blocks/me — the caller's outgoing blocks (blocked users have
       no read path; blocking stays silent for its target).
DELETE /api/v1/blocks/{profile_id} — remove the caller's block (404 when no
       such outgoing block exists).

Identity derives exclusively from the Supabase bearer token. A block is a
pure visibility filter — it never deletes matches, messages, or actions; the
pair disappears from discovery, likes/passes, matches, and messaging in BOTH
directions while the block stands, and everything is restored on unblock.
Self, unknown, and unverified targets all surface 404 (no existence leak).
"""

from typing import Any
from uuid import UUID

from fastapi import APIRouter
from pydantic import BaseModel

from app.api.deps import CurrentAuthUserDep, SupabaseDep
from app.services import safety as safety_service

router = APIRouter(prefix="/blocks", tags=["blocks"])


class BlockRequest(BaseModel):
    """The target is the only client input; the blocker is server-derived."""

    target_profile_id: UUID


@router.post("")
def block_user(
    payload: BlockRequest,
    auth_user_id: CurrentAuthUserDep,
    supabase: SupabaseDep,
) -> dict[str, Any]:
    """Block another verified user (idempotent)."""
    return safety_service.block_user(supabase, auth_user_id, payload.target_profile_id)


@router.get("/me")
def list_my_blocks(
    auth_user_id: CurrentAuthUserDep,
    supabase: SupabaseDep,
) -> dict[str, Any]:
    """List the caller's outgoing blocks (minimal fields, newest first)."""
    return safety_service.list_my_blocks(supabase, auth_user_id)


@router.delete("/{profile_id}")
def unblock_user(
    profile_id: UUID,
    auth_user_id: CurrentAuthUserDep,
    supabase: SupabaseDep,
) -> dict[str, Any]:
    """Remove the caller's block on a profile."""
    return safety_service.unblock_user(supabase, auth_user_id, profile_id)
