"""Conversations & text messages business logic (Phase 7).

A conversation IS an active match: the match id doubles as the conversation
id and the conversations list reuses the existing MatchCard shape (active
matches + the unread counter for the caller). Messages are immutable text
rows keyed by `match_id` — no edit/delete path exists in v1.

Security model (mirrors the dating/discovery slices):
  * Identity derives exclusively from the Supabase bearer token — the caller
    profile is resolved server-side; client-supplied profile/match ids carry
    no authorization weight.
  * Messaging requires the CALLER to be VERIFIED (403 otherwise). The matched
    partner is not re-checked per request: matches only ever form between
    VERIFIED profiles (both sides pass the like flow's gate).
  * Participant-only access: unknown match ids, nonparticipant calls, and
    calls on already-unmatched matches all surface the same 404 — no
    existence leak, and an unmatch makes the conversation inaccessible
    immediately. The same rule is re-enforced here AND in RLS (the service
    role bypasses RLS, so the backend re-implements every rule).
  * Message bodies are trimmed and must be 1..2000 characters (422 outside;
    the database CHECK re-enforces it).
  * Sending runs through one atomic RPC that also increments the recipient's
    unread counter; mark-read zeroes the caller's counter (service role).
"""

import logging
from typing import Any
from uuid import UUID

from supabase import Client

from app.core.exceptions import (
    NotFoundError,
    ServiceUnavailableError,
)
from app.services.discovery import (
    _CANDIDATE_COLUMNS,
    _candidate_payload,
    _decode_cursor,
    _encode_cursor,
    _get_verified_viewer,
    _interests_by_profile,
    _photos_by_profile,
)

logger = logging.getLogger(__name__)

MESSAGE_BODY_MAX_LENGTH = 2000
MESSAGES_DEFAULT_LIMIT = 30
MESSAGES_MAX_LIMIT = 100

_MESSAGE_COLUMNS = "id,sender_profile_id,body,created_at"


# ---------------------------------------------------------------------------
# Conversations (active matches + unread counts).
# ---------------------------------------------------------------------------


def list_conversations(
    supabase: Client,
    auth_user_id: UUID,
    *,
    bucket: str,
    signed_url_ttl: int,
) -> dict[str, Any]:
    """List the caller's conversations: their ACTIVE matches, newest first.

    Each entry carries the matched profile (the exact MatchCard shape) and
    `unread_count` — how many messages the OTHER side sent since the caller
    last marked the conversation read.
    """
    viewer = _get_verified_viewer(supabase, auth_user_id, action="use messaging")
    viewer_id = str(viewer["id"])

    try:
        response = (
            supabase.table("matches")
            .select(
                "id,user_a_id,user_b_id,created_at,"
                "user_a_unread_count,user_b_unread_count"
            )
            .is_("unmatched_at", "null")
            .or_(f"user_a_id.eq.{viewer_id},user_b_id.eq.{viewer_id}")
            .order("created_at", desc=True)
            .execute()
        )
    except Exception as exc:
        logger.exception("Conversation list lookup failed")
        raise ServiceUnavailableError(
            "Conversations are temporarily unavailable.", code="database_unavailable"
        ) from exc
    rows = getattr(response, "data", None) or []

    partner_ids = [
        str(row["user_b_id"] if str(row["user_a_id"]) == viewer_id else row["user_a_id"])
        for row in rows
    ]
    profiles_by_id = _profiles_by_id(supabase, partner_ids)
    interests_by_profile = _interests_by_profile(supabase, partner_ids)
    photos_by_profile = _photos_by_profile(
        supabase, partner_ids, bucket=bucket, signed_url_ttl=signed_url_ttl
    )

    conversations = []
    for row in rows:
        partner_id = str(
            row["user_b_id"] if str(row["user_a_id"]) == viewer_id else row["user_a_id"]
        )
        profile = profiles_by_id.get(partner_id)
        if profile is None:
            continue
        unread_column = (
            "user_a_unread_count"
            if str(row["user_a_id"]) == viewer_id
            else "user_b_unread_count"
        )
        conversations.append(
            {
                "id": str(row["id"]),
                "created_at": row.get("created_at"),
                "unread_count": int(row.get(unread_column) or 0),
                "profile": _candidate_payload(
                    profile,
                    interests_by_profile.get(partner_id, []),
                    photos_by_profile.get(partner_id, []),
                ),
            }
        )
    return {"conversations": conversations}


# ---------------------------------------------------------------------------
# Message history (keyset pagination on (created_at, id), newest first).
# ---------------------------------------------------------------------------


def get_messages(
    supabase: Client,
    auth_user_id: UUID,
    match_id: UUID,
    *,
    cursor: str | None,
    limit: int,
) -> dict[str, Any]:
    """Return one page of a conversation's messages, newest first.

    Keyset pagination on (created_at, id): the opaque `cursor` resumes the
    page strictly after (i.e. older than) the cursor tuple, so paging is
    stable while new messages arrive. `next_cursor` is present when another
    (older) page may exist; the client polls page 1 (no cursor) for updates.
    """
    viewer = _get_verified_viewer(supabase, auth_user_id, action="use messaging")
    viewer_id = str(viewer["id"])
    _require_active_participant(supabase, viewer_id, match_id)

    # Decoded outside the DB try-block: a bad cursor is a 422, not a 503.
    keyset_filter = None
    if cursor:
        cursor_created, cursor_id = _decode_cursor(cursor)
        # Rows strictly older than the cursor tuple in
        # (created_at DESC, id DESC) order:
        #   created_at < cursor_created
        #   OR (created_at = cursor_created AND id < cursor_id)
        keyset_filter = (
            f"created_at.lt.{cursor_created},"
            f"and(created_at.eq.{cursor_created},id.lt.{cursor_id})"
        )

    try:
        query = (
            supabase.table("messages")
            .select(_MESSAGE_COLUMNS)
            .eq("match_id", str(match_id))
        )
        if keyset_filter:
            query = query.or_(keyset_filter)
        response = (
            query.order("created_at", desc=True)
            .order("id", desc=True)
            .limit(limit)
            .execute()
        )
    except Exception as exc:
        logger.exception("Message history lookup failed")
        raise ServiceUnavailableError(
            "Messages are temporarily unavailable.", code="database_unavailable"
        ) from exc
    rows = getattr(response, "data", None) or []

    next_cursor = None
    if len(rows) == limit and rows:
        last = rows[-1]
        next_cursor = _encode_cursor(last.get("created_at"), str(last["id"]))

    return {
        "messages": [_message_payload(row, viewer_id) for row in rows],
        "next_cursor": next_cursor,
    }


# ---------------------------------------------------------------------------
# Sending.
# ---------------------------------------------------------------------------


def send_message(
    supabase: Client,
    auth_user_id: UUID,
    match_id: UUID,
    body: str,
) -> dict[str, Any]:
    """Send one text message in the caller's conversation.

    The route layer has already trimmed the body and enforced 1..2000
    characters. One atomic RPC inserts the message AND increments the
    recipient's unread counter, so the two can never drift apart.
    """
    viewer = _get_verified_viewer(supabase, auth_user_id, action="use messaging")
    viewer_id = str(viewer["id"])
    _require_active_participant(supabase, viewer_id, match_id)

    try:
        response = supabase.rpc(
            "send_conversation_message",
            {
                "p_match_id": str(match_id),
                "p_sender_profile_id": viewer_id,
                "p_body": body,
            },
        ).execute()
    except Exception as exc:
        if "not an active participant" in str(exc):
            # Lost the race with an unmatch between our check and the RPC.
            raise NotFoundError("Conversation not found.") from exc
        logger.exception("Message send failed")
        raise ServiceUnavailableError(
            "The message could not be sent. Please try again later.",
            code="database_insert_failed",
        ) from exc

    rows = getattr(response, "data", None) or []
    if not rows:
        raise ServiceUnavailableError(
            "The message could not be sent. Please try again later.",
            code="database_insert_failed",
        )
    return _message_payload(rows[0], viewer_id)


# ---------------------------------------------------------------------------
# Read markers.
# ---------------------------------------------------------------------------


def mark_conversation_read(
    supabase: Client, auth_user_id: UUID, match_id: UUID
) -> dict[str, Any]:
    """Zero the caller's unread counter (participant of an active match only).

    Idempotent: marking an already-read conversation returns 200 with 0.
    """
    viewer = _get_verified_viewer(supabase, auth_user_id, action="use messaging")
    viewer_id = str(viewer["id"])
    match = _require_active_participant(supabase, viewer_id, match_id)
    is_a = str(match["user_a_id"]) == viewer_id

    try:
        response = (
            supabase.table("matches")
            .update({"user_a_unread_count" if is_a else "user_b_unread_count": 0})
            .eq("id", str(match_id))
            .execute()
        )
    except Exception as exc:
        logger.exception("Mark-read update failed")
        raise ServiceUnavailableError(
            "Conversations are temporarily unavailable.", code="database_update_failed"
        ) from exc
    if not getattr(response, "data", None):
        raise ServiceUnavailableError(
            "Conversations are temporarily unavailable.", code="database_update_failed"
        )
    return {"conversation_id": str(match_id), "unread_count": 0}


# ---------------------------------------------------------------------------
# Internal helpers.
# ---------------------------------------------------------------------------


def _require_active_participant(
    supabase: Client, viewer_profile_id: str, match_id: UUID
) -> dict[str, Any]:
    """404 unless the viewer is a participant of an ACTIVE match with this id.

    Unknown matches, nonparticipants, and already-unmatched matches all
    surface the same 404 — no existence leak.
    """
    try:
        response = (
            supabase.table("matches")
            .select("id,user_a_id,user_b_id,unmatched_at")
            .eq("id", str(match_id))
            .maybe_single()
            .execute()
        )
    except Exception as exc:
        logger.exception("Conversation match lookup failed")
        raise ServiceUnavailableError(
            "Conversations are temporarily unavailable.", code="database_unavailable"
        ) from exc
    match = getattr(response, "data", response)
    if (
        not match
        or match.get("unmatched_at") is not None
        or viewer_profile_id
        not in (str(match.get("user_a_id")), str(match.get("user_b_id")))
    ):
        raise NotFoundError("Conversation not found.")
    return match


def _profiles_by_id(supabase: Client, profile_ids: list[str]) -> dict[str, dict[str, Any]]:
    """One batched fetch of candidate-projected profiles by id."""
    if not profile_ids:
        return {}
    try:
        response = (
            supabase.table("profiles")
            .select(_CANDIDATE_COLUMNS)
            .in_("id", profile_ids)
            .execute()
        )
    except Exception as exc:
        logger.exception("Conversation profile lookup failed")
        raise ServiceUnavailableError(
            "Conversations are temporarily unavailable.", code="database_unavailable"
        ) from exc
    return {str(row["id"]): row for row in getattr(response, "data", None) or []}


def _message_payload(row: dict[str, Any], viewer_profile_id: str) -> dict[str, Any]:
    return {
        "id": str(row["id"]),
        "sender_profile_id": str(row["sender_profile_id"]),
        "is_own": str(row["sender_profile_id"]) == viewer_profile_id,
        "body": row.get("body"),
        "created_at": row.get("created_at"),
    }
