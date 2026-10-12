"""Contextual (opportunity-scoped) people discovery.

GET /api/v1/opportunities/{opportunity_id}/discovery returns the eligible
people feed for ONE opportunity. The opportunity is the context: the
candidate pool is exactly the people who applied to the same PUBLISHED
opportunity, so a match or action from one opportunity can never surface in
another opportunity's feed.

Eligibility for this slice (mirrors the global discovery feed, Phase 5, plus
the opportunity scope):

  * the opportunity exists and is PUBLISHED (404 otherwise — no existence
    leak for DRAFT/PAUSED/CANCELLED/EXPIRED or unknown ids);
  * the viewer must be VERIFIED (403, reusing the discovery gate) and have
    APPLIED to this opportunity (403 otherwise — discovery is for
    participants of the opportunity);
  * the candidate applied to THIS SAME opportunity (status APPLIED);
  * the candidate is not the current user;
  * the candidate is VERIFIED (latest submission is VERIFIED);
  * the candidate's gender satisfies the viewer's seeking_gender AND the
    viewer's gender satisfies the candidate's seeking_gender — both sides'
    partner preferences are respected;
  * seeking_gender 'men' / 'women' / 'everyone' semantics are preserved
    verbatim from the existing profile preferences: 'everyone' imposes no
    restriction on that side;
  * no active block in either direction;
  * the viewer has not already acted on the candidate WITHIN THIS
    OPPORTUNITY (viewer-scoped, opportunity-scoped exclusion). Acting on
    someone through a different opportunity does NOT exclude them here, and
    a match in one opportunity does not remove the other side from this
    opportunity's feed before they have acted here.

Ordering is deterministic and identical to the global feed: newest profiles
first (`created_at` descending), `id` ascending as a stable tiebreaker, with
opaque cursor pagination. Only client-safe fields are returned; photos use
short-lived server-signed URLs and the raw date_of_birth is never returned.

Query shape avoids N+1 fan-out: applicants, their verification statuses, and
their interest/photo rows are each resolved with batched `in_` queries.
"""

import logging
from typing import Any
from uuid import UUID

from supabase import Client

from app.core.exceptions import (
    PermissionDeniedError,
    ServiceUnavailableError,
)
from app.services.discovery import (
    DEFAULT_LIMIT,
    MAX_LIMIT,
    _CANDIDATE_COLUMNS,
    _active_blocked_ids,
    _enrich_page,
    _gender_compatible,
    _get_verified_viewer,
    _paginate,
    _verified_profile_ids,
)
from app.services.opportunities import require_published_opportunity

logger = logging.getLogger(__name__)

__all__ = ["get_opportunity_discovery", "DEFAULT_LIMIT", "MAX_LIMIT"]


def get_opportunity_discovery(
    supabase: Client,
    auth_user_id: UUID,
    opportunity_id: UUID,
    *,
    limit: int,
    cursor: str | None,
    bucket: str,
    signed_url_ttl: int,
) -> dict[str, Any]:
    """Return the eligible people feed for one opportunity.

    The opportunity must be PUBLISHED and the viewer must be VERIFIED *and*
    an APPLIED participant of that same opportunity. Identity comes from the
    bearer token only — no client-supplied viewer or target ids carry weight.
    """
    # 404 before 403: an unknown / unpublished opportunity must not reveal
    # whether the caller is verified.
    require_published_opportunity(supabase, opportunity_id)

    viewer_id = _require_verified_participant(supabase, auth_user_id, opportunity_id)

    candidates = _candidate_rows(supabase, opportunity_id, viewer_id)
    decided_ids = _viewer_decided_ids(supabase, viewer_id, opportunity_id)
    blocked_ids = _active_blocked_ids(supabase, viewer_id)

    eligible = _filter_eligible(supabase, candidates, viewer_id, decided_ids, blocked_ids)
    page, next_cursor = _paginate(eligible, cursor, limit)
    enriched = _enrich_page(supabase, page, bucket=bucket, signed_url_ttl=signed_url_ttl)
    return {"candidates": enriched, "next_cursor": next_cursor}


# ---------------------------------------------------------------------------
# Internal helpers.
# ---------------------------------------------------------------------------


def _require_verified_participant(
    supabase: Client, auth_user_id: UUID, opportunity_id: UUID
) -> str:
    """Resolve the token-owned profile: VERIFIED *and* applied here.

    Reuses the discovery VERIFIED-viewer gate (same 403 `permission_denied`
    and no existence leak about profiles), then requires an APPLIED
    application for this exact opportunity — contextual discovery is for
    people taking part in the opportunity.
    """
    viewer = _get_verified_viewer(
        supabase,
        auth_user_id,
        action="discover people through an opportunity",
    )
    viewer_id = str(viewer["id"])
    if not _has_application(supabase, viewer_id, opportunity_id):
        raise PermissionDeniedError(
            "You must apply to this opportunity before discovering people through it.",
            code="not_applied",
        )
    return viewer_id


def _has_application(
    supabase: Client, profile_id: str, opportunity_id: UUID
) -> bool:
    try:
        response = (
            supabase.table("applications")
            .select("id")
            .eq("opportunity_id", str(opportunity_id))
            .eq("profile_id", profile_id)
            .eq("status", "APPLIED")
            .maybe_single()
            .execute()
        )
    except Exception as exc:
        logger.exception("Application lookup failed")
        raise ServiceUnavailableError(
            "The opportunity feed is temporarily unavailable.",
            code="database_unavailable",
        ) from exc
    return bool(getattr(response, "data", response))


def _opportunity_applicant_ids(
    supabase: Client, opportunity_id: UUID
) -> set[str]:
    """Every APPLIED profile id for this opportunity (one batched query)."""
    try:
        response = (
            supabase.table("applications")
            .select("profile_id")
            .eq("opportunity_id", str(opportunity_id))
            .eq("status", "APPLIED")
            .execute()
        )
    except Exception as exc:
        logger.exception("Opportunity applicant lookup failed")
        raise ServiceUnavailableError(
            "The opportunity feed is temporarily unavailable.",
            code="database_unavailable",
        ) from exc
    return {
        str(row["profile_id"])
        for row in getattr(response, "data", None) or []
        if row.get("profile_id")
    }


def _candidate_rows(
    supabase: Client, opportunity_id: UUID, viewer_profile_id: str
) -> list[dict[str, Any]]:
    """Candidate profiles for this opportunity, in the global feed's order.

    One batched query. Verification and gender compatibility are applied in
    Python below; the service role bypasses RLS, so no cross-read policy is
    relied upon.
    """
    applicants = _opportunity_applicant_ids(supabase, opportunity_id)
    applicants.discard(viewer_profile_id)
    if not applicants:
        return []
    try:
        response = (
            supabase.table("profiles")
            .select(_CANDIDATE_COLUMNS)
            .in_("id", sorted(applicants))
            .order("created_at", desc=True)
            .order("id")
            .execute()
        )
    except Exception as exc:
        logger.exception("Opportunity candidate lookup failed")
        raise ServiceUnavailableError(
            "The opportunity feed is temporarily unavailable.",
            code="database_unavailable",
        ) from exc
    return getattr(response, "data", None) or []


def _filter_eligible(
    supabase: Client,
    candidates: list[dict[str, Any]],
    viewer_id: str,
    decided_ids: set[str],
    blocked_ids: set[str],
) -> list[dict[str, Any]]:
    """Apply verification, already-decided, block, and two-sided gender rules.

    The viewer's own gender/seeking_gender is read here so the existing
    `_gender_compatible` helper can be reused unchanged: it enforces BOTH
    directions (viewer's preference against the candidate's gender, and the
    candidate's preference against the viewer's gender).
    """
    if not candidates:
        return []
    candidate_ids = [str(row["id"]) for row in candidates]
    verified_ids = _verified_profile_ids(supabase, candidate_ids)

    viewer_row = _viewer_preferences(supabase, viewer_id)
    if viewer_row is None:
        # The viewer is VERIFIED and applied, so their profile exists; an
        # absent row here is an inconsistent read, not a client error.
        raise ServiceUnavailableError(
            "The opportunity feed is temporarily unavailable.",
            code="database_unavailable",
        )

    eligible: list[dict[str, Any]] = []
    for candidate in candidates:
        candidate_id = str(candidate["id"])
        if candidate_id not in verified_ids:
            continue
        if candidate_id in decided_ids:
            continue
        if candidate_id in blocked_ids:
            continue
        if not _gender_compatible(viewer_row, candidate):
            continue
        eligible.append(candidate)
    return eligible


def _viewer_preferences(supabase: Client, viewer_profile_id: str) -> dict[str, Any] | None:
    """The viewer's gender + seeking_gender (input for `_gender_compatible`)."""
    try:
        response = (
            supabase.table("profiles")
            .select("id,gender,seeking_gender")
            .eq("id", viewer_profile_id)
            .maybe_single()
            .execute()
        )
    except Exception as exc:
        logger.exception("Viewer preference lookup failed")
        raise ServiceUnavailableError(
            "The opportunity feed is temporarily unavailable.",
            code="database_unavailable",
        ) from exc
    return getattr(response, "data", response)


def _viewer_decided_ids(
    supabase: Client, viewer_profile_id: str, opportunity_id: UUID
) -> set[str]:
    """Targets the VIEWER already decided on WITHIN THIS OPPORTUNITY.

    Scoped to the opportunity on purpose: acting on someone through a
    different opportunity must not remove them from this opportunity's feed,
    and a match formed elsewhere is not a decision here. One batched query.
    """
    try:
        response = (
            supabase.table("dating_actions")
            .select("target_profile_id")
            .eq("actor_profile_id", viewer_profile_id)
            .eq("opportunity_id", str(opportunity_id))
            .execute()
        )
    except Exception as exc:
        logger.exception("Contextual action exclusion lookup failed")
        raise ServiceUnavailableError(
            "The opportunity feed is temporarily unavailable.",
            code="database_unavailable",
        ) from exc
    return {
        str(row["target_profile_id"])
        for row in getattr(response, "data", None) or []
        if row.get("target_profile_id")
    }
