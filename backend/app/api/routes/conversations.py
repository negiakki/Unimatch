"""Conversations endpoints for verified students (Phase 7).

A conversation IS an active match — the match id doubles as the conversation
id, so a future unmatch makes the conversation inaccessible immediately.

  * GET    /api/v1/conversations — the caller's active-match conversations
    (newest first) with the matched profile (the MatchCard shape) and the
    caller's unread_count.
  * GET    /api/v1/conversations/{id}/messages — message history, newest
    first, keyset-paginated on (created_at, id) via the opaque `cursor`.
  * POST   /api/v1/conversations/{id}/messages — send one text message
    (trimmed, 1–2000 characters); immutable once sent.
  * POST   /api/v1/conversations/{id}/read — zero the caller's unread counter.

Identity derives exclusively from the Supabase bearer token; the caller must
be VERIFIED (403) and an active participant (404 otherwise — unknown match,
nonparticipant, and unmatched all look identical). There is no
edit/delete-message path in v1.
"""

from typing import Annotated, Any
from uuid import UUID

from fastapi import APIRouter, Query
from pydantic import BaseModel, Field, field_validator

from app.api.deps import CurrentAuthUserDep, SettingsDep, SupabaseDep
from app.services import messaging as messaging_service

router = APIRouter(prefix="/conversations", tags=["conversations"])


class SendMessageRequest(BaseModel):
    """One outgoing text message. Whitespace is trimmed server-side; the
    trimmed body must be 1..2000 characters."""

    body: str

    @field_validator("body")
    @classmethod
    def _trim_and_check_length(cls, value: str) -> str:
        trimmed = value.strip()
        if not 1 <= len(trimmed) <= messaging_service.MESSAGE_BODY_MAX_LENGTH:
            raise ValueError(
                f"Message must be 1-{messaging_service.MESSAGE_BODY_MAX_LENGTH} "
                "characters after trimming."
            )
        return trimmed


@router.get("")
def list_conversations(
    auth_user_id: CurrentAuthUserDep,
    supabase: SupabaseDep,
    settings: SettingsDep,
) -> dict[str, Any]:
    """List the caller's conversations (active matches) with unread counts."""
    return messaging_service.list_conversations(
        supabase,
        auth_user_id,
        bucket=settings.profile_photos_bucket_name,
        signed_url_ttl=settings.profile_photos_signed_url_ttl_seconds,
    )


@router.get("/{conversation_id}/messages")
def get_messages(
    conversation_id: UUID,
    auth_user_id: CurrentAuthUserDep,
    supabase: SupabaseDep,
    limit: Annotated[
        int,
        Query(ge=1, le=messaging_service.MESSAGES_MAX_LIMIT, description="Page size (1-100)."),
    ] = messaging_service.MESSAGES_DEFAULT_LIMIT,
    cursor: Annotated[
        str | None,
        Query(description="Opaque cursor from the previous page's next_cursor."),
    ] = None,
) -> dict[str, Any]:
    """Return one page of the conversation's history (newest first)."""
    return messaging_service.get_messages(
        supabase,
        auth_user_id,
        conversation_id,
        cursor=cursor,
        limit=limit,
    )


@router.post("/{conversation_id}/messages", status_code=201)
def send_message(
    conversation_id: UUID,
    payload: SendMessageRequest,
    auth_user_id: CurrentAuthUserDep,
    supabase: SupabaseDep,
) -> dict[str, Any]:
    """Send one text message (participant of an active conversation only)."""
    return messaging_service.send_message(
        supabase,
        auth_user_id,
        conversation_id,
        payload.body,
    )


@router.post("/{conversation_id}/read")
def mark_conversation_read(
    conversation_id: UUID,
    auth_user_id: CurrentAuthUserDep,
    supabase: SupabaseDep,
) -> dict[str, Any]:
    """Mark the conversation read for the caller (zeroes their unread count)."""
    return messaging_service.mark_conversation_read(
        supabase,
        auth_user_id,
        conversation_id,
    )
