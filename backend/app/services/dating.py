"""Likes, passes and matches business logic (Phase 6).

POST /api/v1/discovery/{profile_id}/like and /pass record one immutable
action per (viewer, candidate) pair; a mutual LIKE creates the canonical
match exactly once. GET /api/v1/matches lists active matches; DELETE
/api/v1/matches/{match_id} soft-unmatches (unmatched_at) for participants.

Security model (mirrors the discovery slice):
  * Identity derives exclusively from the Supabase bearer token — the actor
    profile is resolved server-side; client-supplied actor ids carry no
    weight. The target profile id comes from the URL path only.
  * The viewer must be VERIFIED (403 otherwise, reusing the discovery gate).
  * The target must exist and be VERIFIED (404 otherwise — no existence
    leak; self-actions surface the same 404).
  * An already-decided target (any prior action by the viewer, or a duplicate
    insert under concurrency) is a 409 `already_decided`. A LIKE after PASS
    or a PASS after LIKE is the same unique pair — rejected identically.
  * Incoming actions are never read and never returned ("who liked you" does
    not exist in v1).

Match creation is atomic-by-constraint: the service role inserts the match
with the canonical (user_a_id < user_b_id) pair ordering using
`ignore_duplicates`; the UNIQUE(user_a_id, user_b_id) constraint guarantees
concurrent mutual likes converge on exactly one match row.
"""

import logging
from datetime import datetime, timezone
from typing import Any
from uuid import UUID

from supabase import Client

from app.core.exceptions import (
    ConflictError,
    NotFoundError,
    ServiceUnavailableError,
)
from app.services.discovery import (
    _CANDIDATE_COLUMNS,
    _get_verified_viewer,
    _interests_by_profile,
    _is_verified,
    _photos_by_profile,
    _candidate_payload,
)

logger = logging.getLogger(__name__)


def like_candidate(
    supabase: Client,
    auth_user_id: UUID,
    target_profile_id: UUID,
    *,
    bucket: str,
    signed_url_ttl: int,
) -> dict[str, Any]:
    """Record the viewer's LIKE; create the match on a mutual LIKE.

    Returns `{"outcome": "like_recorded"}` or, when the candidate had already
    liked the viewer back, `{"outcome": "matched", "match": {...}}` with the
    client-safe matched-profile payload.
    """
    viewer = _verified_viewer(supabase, auth_user_id)
    target = _eligible_target(supabase, target_profile_id, viewer["id"])

    _reject_if_already_decided(supabase, viewer["id"], str(target["id"]))
    _insert_action(supabase, viewer["id"], str(target["id"]), "LIKE")

    reverse = _find_like(supabase, actor=str(target["id"]), target=viewer["id"])
    if not reverse:
        return {"outcome": "like_recorded"}

    match = _create_match_once(supabase, viewer["id"], str(target["id"]))
    return {
        "outcome": "matched",
        "match": {
            "id": match["id"],
            "created_at": match.get("created_at"),
            "profile": _matched_profile_payload(
                supabase, target, bucket=bucket, signed_url_ttl=signed_url_ttl
            ),
        },
    }


def pass_candidate(supabase: Client, auth_user_id: UUID, target_profile_id: UUID) -> dict[str, Any]:
    """Record the viewer's PASS (viewer-scoped; no match can ever result)."""
    viewer = _verified_viewer(supabase, auth_user_id)
    target = _eligible_target(supabase, target_profile_id, viewer["id"])

    _reject_if_already_decided(supabase, viewer["id"], str(target["id"]))
    _insert_action(supabase, viewer["id"], str(target["id"]), "PASS")
    return {"outcome": "pass_recorded"}


def list_matches(
    supabase: Client,
    auth_user_id: UUID,
    *,
    bucket: str,
    signed_url_ttl: int,
) -> dict[str, Any]:
    """List the caller's ACTIVE matches (newest first) with safe profiles."""
    viewer = _verified_viewer(supabase, auth_user_id)
    viewer_id = str(viewer["id"])

    try:
        response = (
            supabase.table("matches")
            .select("id,user_a_id,user_b_id,created_at")
            .is_("unmatched_at", "null")
            .or_(f"user_a_id.eq.{viewer_id},user_b_id.eq.{viewer_id}")
            .order("created_at", desc=True)
            .execute()
        )
    except Exception as exc:
        logger.exception("Match list lookup failed")
        raise ServiceUnavailableError(
            "Matches are temporarily unavailable.", code="database_unavailable"
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

    matches = []
    for row in rows:
        partner_id = str(
            row["user_b_id"] if str(row["user_a_id"]) == viewer_id else row["user_a_id"]
        )
        profile = profiles_by_id.get(partner_id)
        if profile is None:
            continue
        matches.append(
            {
                "id": str(row["id"]),
                "created_at": row.get("created_at"),
                "profile": _candidate_payload(
                    profile,
                    interests_by_profile.get(partner_id, []),
                    photos_by_profile.get(partner_id, []),
                ),
            }
        )
    return {"matches": matches}


def unmatch(supabase: Client, auth_user_id: UUID, match_id: UUID) -> dict[str, Any]:
    """Soft-unmatch an active match for one of its two participants.

    Unknown matches, nonparticipants, and already-unmatched matches all
    surface the same 404 — no existence leak. The row is retained (never
    deleted) so an unmatched pair cannot rematch through normal discovery.
    """
    viewer = _verified_viewer(supabase, auth_user_id)
    viewer_id = str(viewer["id"])

    try:
        response = (
            supabase.table("matches")
            .select("id,user_a_id,user_b_id,unmatched_at")
            .eq("id", str(match_id))
            .maybe_single()
            .execute()
        )
    except Exception as exc:
        logger.exception("Match lookup failed")
        raise ServiceUnavailableError(
            "Matches are temporarily unavailable.", code="database_unavailable"
        ) from exc
    match = getattr(response, "data", response)
    if (
        not match
        or match.get("unmatched_at") is not None
        or viewer_id not in (str(match.get("user_a_id")), str(match.get("user_b_id")))
    ):
        raise NotFoundError("Match not found.")

    try:
        # PostgREST treats JSON values as literals, so the timestamp is
        # generated here (the CHECK keeps unmatched_at >= created_at).
        response = (
            supabase.table("matches")
            .update({"unmatched_at": datetime.now(timezone.utc).isoformat()})
            .eq("id", str(match["id"]))
            .execute()
        )
    except Exception as exc:
        logger.exception("Unmatch update failed")
        raise ServiceUnavailableError(
            "The match could not be removed. Please try again later.",
            code="database_update_failed",
        ) from exc
    rows = getattr(response, "data", None) or []
    if not rows:
        raise ServiceUnavailableError(
            "The match could not be removed. Please try again later.",
            code="database_update_failed",
        )
    return {"id": str(rows[0]["id"]), "unmatched_at": rows[0].get("unmatched_at")}


# ---------------------------------------------------------------------------
# Internal helpers.
# ---------------------------------------------------------------------------


def _verified_viewer(supabase: Client, auth_user_id: UUID) -> dict[str, Any]:
    """Reuse the discovery VERIFIED-viewer gate (403, no existence leak)."""
    return _get_verified_viewer(supabase, auth_user_id)


def _eligible_target(
    supabase: Client, target_profile_id: UUID, viewer_profile_id: str
) -> dict[str, Any]:
    """Resolve the target profile and require it to be a VERIFIED candidate.

    Self-actions, unknown profiles, and unverified profiles all surface the
    same 404 — no existence leak.
    """
    if str(target_profile_id) == viewer_profile_id:
        raise NotFoundError("Profile not found.")
    try:
        response = (
            supabase.table("profiles")
            .select(_CANDIDATE_COLUMNS)
            .eq("id", str(target_profile_id))
            .maybe_single()
            .execute()
        )
    except Exception as exc:
        logger.exception("Target profile lookup failed")
        raise ServiceUnavailableError(
            "This action is temporarily unavailable.", code="database_unavailable"
        ) from exc
    target = getattr(response, "data", response)
    if not target or not _is_verified(supabase, str(target["id"])):
        raise NotFoundError("Profile not found.")
    return target


def _reject_if_already_decided(
    supabase: Client, actor_profile_id: str, target_profile_id: str
) -> None:
    """409 when the viewer has ANY prior action on this target."""
    try:
        response = (
            supabase.table("dating_actions")
            .select("id")
            .eq("actor_profile_id", actor_profile_id)
            .eq("target_profile_id", target_profile_id)
            .maybe_single()
            .execute()
        )
    except Exception as exc:
        logger.exception("Existing action lookup failed")
        raise ServiceUnavailableError(
            "This action is temporarily unavailable.", code="database_unavailable"
        ) from exc
    if getattr(response, "data", response):
        raise ConflictError(
            "You have already decided on this profile.", code="already_decided"
        )


def _insert_action(
    supabase: Client, actor_profile_id: str, target_profile_id: str, action_type: str
) -> None:
    """Insert the action row; a concurrent duplicate surfaces as 409."""
    try:
        response = (
            supabase.table("dating_actions")
            .insert(
                {
                    "actor_profile_id": actor_profile_id,
                    "target_profile_id": target_profile_id,
                    "action_type": action_type,
                }
            )
            .execute()
        )
    except Exception as exc:
        detail = str(exc)
        if "duplicate key" in detail or "dating_actions_actor_target_unique" in detail:
            raise ConflictError(
                "You have already decided on this profile.", code="already_decided"
            ) from exc
        logger.exception("Dating action insert failed")
        raise ServiceUnavailableError(
            "This action could not be recorded. Please try again later.",
            code="database_insert_failed",
        ) from exc
    if not getattr(response, "data", None):
        raise ServiceUnavailableError(
            "This action could not be recorded. Please try again later.",
            code="database_insert_failed",
        )


def _find_like(supabase: Client, *, actor: str, target: str) -> bool:
    """True iff a LIKE row exists from `actor` to `target`."""
    try:
        response = (
            supabase.table("dating_actions")
            .select("id")
            .eq("actor_profile_id", actor)
            .eq("target_profile_id", target)
            .eq("action_type", "LIKE")
            .maybe_single()
            .execute()
        )
    except Exception as exc:
        logger.exception("Reverse like lookup failed")
        raise ServiceUnavailableError(
            "This action is temporarily unavailable.", code="database_unavailable"
        ) from exc
    return bool(getattr(response, "data", response))


def _create_match_once(
    supabase: Client, profile_id_a: str, profile_id_b: str
) -> dict[str, Any]:
    """Create the canonical match exactly once; return the match row.

    The pair is stored in canonical order (user_a_id < user_b_id) and the
    UNIQUE(user_a_id, user_b_id) constraint is the concurrency arbiter:
    `ignore_duplicates` turns a concurrent duplicate creation into a no-op,
    then the existing row is read back.
    """
    user_a, user_b = sorted((profile_id_a, profile_id_b))
    try:
        response = (
            supabase.table("matches")
            .upsert(
                {"user_a_id": user_a, "user_b_id": user_b},
                ignore_duplicates=True,
            )
            .execute()
        )
        rows = getattr(response, "data", None) or []
        if rows:
            return rows[0]
        response = (
            supabase.table("matches")
            .select("id,created_at")
            .eq("user_a_id", user_a)
            .eq("user_b_id", user_b)
            .maybe_single()
            .execute()
        )
        match = getattr(response, "data", response)
        if not match:
            raise ServiceUnavailableError(
                "The match could not be created. Please try again later.",
                code="database_insert_failed",
            )
        return match
    except ServiceUnavailableError:
        raise
    except Exception as exc:
        logger.exception("Match creation failed")
        raise ServiceUnavailableError(
            "The match could not be created. Please try again later.",
            code="database_insert_failed",
        ) from exc


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
        logger.exception("Matched profile lookup failed")
        raise ServiceUnavailableError(
            "Matches are temporarily unavailable.", code="database_unavailable"
        ) from exc
    return {str(row["id"]): row for row in getattr(response, "data", None) or []}


def _matched_profile_payload(
    supabase: Client,
    target: dict[str, Any],
    *,
    bucket: str,
    signed_url_ttl: int,
) -> dict[str, Any]:
    """Client-safe payload for the freshly matched candidate."""
    profile_id = str(target["id"])
    interests = _interests_by_profile(supabase, [profile_id]).get(profile_id, [])
    photos = _photos_by_profile(
        supabase, [profile_id], bucket=bucket, signed_url_ttl=signed_url_ttl
    ).get(profile_id, [])
    return _candidate_payload(target, interests, photos)
