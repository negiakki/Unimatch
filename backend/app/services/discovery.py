"""Discovery feed business logic.

GET /api/v1/discovery/feed returns an ordered, cursor-paginated list of
eligible candidate profiles for the authenticated, VERIFIED viewer.

Eligibility for this slice (exactly per the Discovery Design Report, Phase 5):

  * the candidate is not the current user;
  * the candidate has a profile (implicit — the feed is a profile query);
  * the candidate is VERIFIED (latest verification submission is VERIFIED);
  * the candidate's gender satisfies the viewer's seeking_gender;
  * the viewer's gender satisfies the candidate's seeking_gender
    (two-sided compatibility);
  * seeking_gender = 'everyone' imposes no restriction on that side;
  * neither side's outcome is undecided: candidates the VIEWER has already
    acted on (any LIKE/PASS) are excluded from the feed — the exclusion is
    viewer-scoped. Candidates who acted on the viewer remain visible so the
    mutual like can happen; after both sides act, both feed directions are
    excluded (Phase 6).

Deliberately NOT implemented in this slice: age preferences, blocks,
location filtering, AI recommendations, and complex ranking.

Security model:
  * The viewer is derived exclusively from the Supabase bearer token via the
    existing authentication dependency; client-supplied `auth_user_id` or
    viewer `profile_id` values are never accepted and carry no weight.
  * The viewer must be VERIFIED (403 permission_denied otherwise). Both the
    viewer's own gate and every candidate's gate resolve to the boolean
    `public.is_profile_verified(...)` semantics: the latest submission must be
    VERIFIED.
  * The service role bypasses RLS, so this module re-enforces every eligibility
    rule server-side. Responses expose only client-safe fields: age is derived
    from date_of_birth (the raw date is never returned), auth_user_id,
    verification status strings, verification documents, and storage paths are
    never returned. Photo delivery uses short-lived signed URLs generated
    server-side with the service-role client against the private bucket.

Deterministic, explainable ordering: newest profiles first (`created_at`
descending), with `id` ascending as a stable tiebreaker. Cursor pagination
resumes after the last returned candidate (opaque base64 cursor encoding the
candidate's `created_at` + `id`).

Query shape avoids N+1 fan-out where practical: candidate profiles, candidate
verification statuses, candidate interests, and candidate photos are each
fetched with one batched `in_` query (photos still require one Storage call
per photo to sign a URL, which Storage does not batch).
"""

import base64
import json
import logging
from datetime import date
from typing import Any
from uuid import UUID

from supabase import Client

from app.core.exceptions import AppError, PermissionDeniedError, ServiceUnavailableError
from app.services.photos import create_signed_photo_url

logger = logging.getLogger(__name__)

DEFAULT_LIMIT = 20
MAX_LIMIT = 50

# Client-safe projection of a candidate profile + its university. Note the
# deliberate absence of auth_user_id and any verification/submission columns.
_CANDIDATE_COLUMNS = (
    "id,first_name,date_of_birth,university_id,course,academic_year,gender,"
    "seeking_gender,bio,relationship_intent,height_cm,hometown,profile_prompts,"
    "created_at,universities(id,name,city,state,country)"
)

_INTEREST_COLUMNS = "id,name"


def get_discovery_feed(
    supabase: Client,
    auth_user_id: UUID,
    *,
    limit: int,
    cursor: str | None,
    bucket: str,
    signed_url_ttl: int,
) -> dict[str, Any]:
    """Return the viewer's eligible candidate feed.

    `limit` (1..MAX_LIMIT, default DEFAULT_LIMIT) and the opaque `cursor` are
    route-layer validated; the viewer identity comes from the token only.
    """
    viewer = _get_verified_viewer(supabase, auth_user_id)

    candidates = _query_candidates(supabase, viewer["id"])
    decided_ids = _viewer_decided_ids(supabase, viewer["id"])
    eligible = _filter_eligible(supabase, candidates, viewer, decided_ids)
    page, next_cursor = _paginate(eligible, cursor, limit)

    enriched = _enrich_page(
        supabase,
        page,
        bucket=bucket,
        signed_url_ttl=signed_url_ttl,
    )
    return {
        "candidates": enriched,
        "next_cursor": next_cursor,
    }


def _get_verified_viewer(
    supabase: Client, auth_user_id: UUID, *, action: str = "use the discovery feed"
) -> dict[str, Any]:
    """Resolve the token-owned profile and require it to be VERIFIED.

    A caller with no profile is not VERIFIED, so both cases surface the same
    403 `permission_denied` — no existence leak about profiles. `action`
    customizes the error copy for the consuming slice (messaging, dating…).
    """
    try:
        response = (
            supabase.table("profiles")
            .select("id,gender,seeking_gender,created_at")
            .eq("auth_user_id", str(auth_user_id))
            .maybe_single()
            .execute()
        )
    except Exception as exc:
        logger.exception("Viewer profile lookup failed")
        raise ServiceUnavailableError(
            "The discovery feed is temporarily unavailable.",
            code="database_unavailable",
        ) from exc
    viewer = getattr(response, "data", response)
    if not viewer:
        raise PermissionDeniedError(f"Verification is required to {action}.")
    if not _is_verified(supabase, viewer["id"]):
        raise PermissionDeniedError(f"Verification is required to {action}.")
    return viewer


def _is_verified(supabase: Client, profile_id: str) -> bool:
    """True iff the profile's latest verification submission is VERIFIED."""
    try:
        response = (
            supabase.table("verification_submissions")
            .select("status")
            .eq("profile_id", str(profile_id))
            .order("submitted_at", desc=True)
            .limit(1)
            .execute()
        )
    except Exception as exc:
        logger.exception("Viewer verification lookup failed")
        raise ServiceUnavailableError(
            "The discovery feed is temporarily unavailable.",
            code="database_unavailable",
        ) from exc
    rows = getattr(response, "data", None) or []
    return bool(rows) and rows[0].get("status") == "VERIFIED"


def _query_candidates(supabase: Client, viewer_profile_id: str) -> list[dict[str, Any]]:
    """Fetch every candidate profile (excluding the viewer) in feed order.

    One batched query with the university embedded. Eligibility (verification,
    two-sided gender compatibility) is applied server-side in Python below;
    the service role bypasses RLS, so no cross-read policy is relied upon.
    """
    try:
        response = (
            supabase.table("profiles")
            .select(_CANDIDATE_COLUMNS)
            .neq("id", str(viewer_profile_id))
            .order("created_at", desc=True)
            .order("id")
            .execute()
        )
    except Exception as exc:
        logger.exception("Discovery candidate lookup failed")
        raise ServiceUnavailableError(
            "The discovery feed is temporarily unavailable.",
            code="database_unavailable",
        ) from exc
    return getattr(response, "data", None) or []


def _filter_eligible(
    supabase: Client,
    candidates: list[dict[str, Any]],
    viewer: dict[str, Any],
    decided_ids: set[str],
) -> list[dict[str, Any]]:
    """Return candidates satisfying the Discovery eligibility rules.

    Verification is resolved in one batched query over the whole candidate
    set (avoiding N+1), then two-sided gender compatibility and the
    already-decided exclusion are applied.
    """
    candidate_ids = [str(row["id"]) for row in candidates]
    verified_ids = _verified_profile_ids(supabase, candidate_ids)

    eligible: list[dict[str, Any]] = []
    for candidate in candidates:
        if str(candidate["id"]) not in verified_ids:
            continue
        if str(candidate["id"]) in decided_ids:
            continue
        if not _gender_compatible(viewer, candidate):
            continue
        eligible.append(candidate)
    return eligible


def _viewer_decided_ids(supabase: Client, viewer_profile_id: str) -> set[str]:
    """Profiles the VIEWER has already decided on (any LIKE/PASS).

    The exclusion is viewer-scoped: a candidate the viewer acted on never
    reappears. Candidates who acted on the viewer stay discoverable so the
    mutual like can form the match — once both sides act, both directions
    are excluded. One batched query; no per-candidate lookups.
    """
    try:
        outgoing = (
            supabase.table("dating_actions")
            .select("target_profile_id")
            .eq("actor_profile_id", viewer_profile_id)
            .execute()
        )
    except Exception as exc:
        logger.exception("Dating action exclusion lookup failed")
        raise ServiceUnavailableError(
            "The discovery feed is temporarily unavailable.",
            code="database_unavailable",
        ) from exc
    return {
        str(row["target_profile_id"])
        for row in getattr(outgoing, "data", None) or []
        if row.get("target_profile_id")
    }


def _verified_profile_ids(supabase: Client, profile_ids: list[str]) -> set[str]:
    """Return the subset of `profile_ids` whose latest submission is VERIFIED.

    A single query ordered by `submitted_at desc`; the first row seen per
    profile is its latest submission (the existing server-assigned order).
    """
    if not profile_ids:
        return set()
    try:
        response = (
            supabase.table("verification_submissions")
            .select("profile_id,status,submitted_at")
            .in_("profile_id", profile_ids)
            .order("submitted_at", desc=True)
            .execute()
        )
    except Exception as exc:
        logger.exception("Candidate verification batch lookup failed")
        raise ServiceUnavailableError(
            "The discovery feed is temporarily unavailable.",
            code="database_unavailable",
        ) from exc
    rows = getattr(response, "data", None) or []
    latest: dict[str, str] = {}
    for row in rows:
        profile_id = row.get("profile_id")
        if profile_id not in latest:
            latest[profile_id] = row.get("status")
    return {pid for pid, status in latest.items() if status == "VERIFIED"}


def _gender_compatible(viewer: dict[str, Any], candidate: dict[str, Any]) -> bool:
    """Two-sided gender compatibility.

    The candidate's gender must satisfy the viewer's seeking_gender AND the
    viewer's gender must satisfy the candidate's seeking_gender.
    seeking_gender = 'everyone' imposes no restriction on that side.
    """
    return _gender_matches(viewer.get("seeking_gender"), candidate.get("gender")) and _gender_matches(
        candidate.get("seeking_gender"), viewer.get("gender")
    )


def _gender_matches(seeking_gender: str | None, gender: str | None) -> bool:
    if seeking_gender == "everyone":
        return True
    if seeking_gender == "women":
        return gender == "woman"
    if seeking_gender == "men":
        return gender == "man"
    return False


def _paginate(
    eligible: list[dict[str, Any]], cursor: str | None, limit: int
) -> tuple[list[dict[str, Any]], str | None]:
    """Slice the ordered eligible list at `limit`, resuming after `cursor`.

    The candidate list is already in feed order (created_at desc, id asc).
    Returns the page and an opaque next_cursor when more candidates follow.
    """
    start = 0
    if cursor:
        cursor_created, cursor_id = _decode_cursor(cursor)
        for index, candidate in enumerate(eligible):
            created = candidate.get("created_at")
            candidate_id = str(candidate["id"])
            if created == cursor_created and candidate_id == cursor_id:
                start = index + 1
                break
            if _sorts_after(created, candidate_id, cursor_created, cursor_id):
                start = index
                break
        else:
            # Cursor item no longer in the eligible set (e.g. it became
            # ineligible since the previous page); resume at the end.
            start = len(eligible)

    page = eligible[start : start + limit]
    next_cursor = None
    if start + limit < len(eligible) and page:
        last = page[-1]
        next_cursor = _encode_cursor(last.get("created_at"), str(last["id"]))
    return page, next_cursor


def _sorts_after(created: str | None, profile_id: str, cursor_created: str | None, cursor_id: str) -> bool:
    """True if (created, id) comes after the cursor in (created_at desc, id asc)."""
    if created != cursor_created:
        return (created or "") < (cursor_created or "")
    return profile_id > cursor_id


def _encode_cursor(created_at: str | None, profile_id: str) -> str:
    payload = json.dumps(
        {"c": created_at, "i": profile_id}, separators=(",", ":")
    )
    return base64.urlsafe_b64encode(payload.encode("utf-8")).decode("ascii")


def _decode_cursor(cursor: str) -> tuple[str | None, str]:
    try:
        payload = json.loads(
            base64.urlsafe_b64decode(cursor.encode("ascii")).decode("utf-8")
        )
        profile_id = str(UUID(str(payload["i"])))
        return payload.get("c"), profile_id
    except Exception as exc:
        raise AppError(
            "The pagination cursor is invalid.",
            status_code=422,
            code="validation_error",
        ) from exc


def _enrich_page(
    supabase: Client,
    page: list[dict[str, Any]],
    *,
    bucket: str,
    signed_url_ttl: int,
) -> list[dict[str, Any]]:
    """Attach interests and signed photo URLs to the page's candidates.

    Interests resolve through two batched queries (links then catalog names).
    Photos resolve through one batched query; each photo's URL is a short-lived
    signed URL generated server-side with the service-role client. Neither
    storage_path nor any private field is ever included in the payloads.
    """
    if not page:
        return []
    profile_ids = [str(row["id"]) for row in page]
    interests_by_profile = _interests_by_profile(supabase, profile_ids)
    photos_by_profile = _photos_by_profile(supabase, profile_ids, bucket, signed_url_ttl)

    return [
        _candidate_payload(
            row,
            interests_by_profile.get(str(row["id"]), []),
            photos_by_profile.get(str(row["id"]), []),
        )
        for row in page
    ]


def _interests_by_profile(
    supabase: Client, profile_ids: list[str]
) -> dict[str, list[dict[str, Any]]]:
    try:
        links_response = (
            supabase.table("profile_interests")
            .select("profile_id,interest_id")
            .in_("profile_id", profile_ids)
            .execute()
        )
        links = getattr(links_response, "data", None) or []
        interest_ids = sorted({str(link["interest_id"]) for link in links if link.get("interest_id")})
        catalog: dict[str, dict[str, Any]] = {}
        if interest_ids:
            catalog_response = (
                supabase.table("interests")
                .select(_INTEREST_COLUMNS)
                .in_("id", interest_ids)
                .execute()
            )
            for row in getattr(catalog_response, "data", None) or []:
                catalog[str(row["id"])] = {
                    "id": str(row["id"]),
                    "name": row.get("name"),
                }
    except Exception as exc:
        logger.exception("Candidate interests lookup failed")
        raise ServiceUnavailableError(
            "The discovery feed is temporarily unavailable.",
            code="database_unavailable",
        ) from exc

    by_profile: dict[str, list[dict[str, Any]]] = {pid: [] for pid in profile_ids}
    for link in links:
        profile_id = str(link["profile_id"])
        interest = catalog.get(str(link["interest_id"]))
        if profile_id in by_profile and interest is not None:
            by_profile[profile_id].append(interest)
    for entries in by_profile.values():
        entries.sort(key=lambda item: (item["name"] or "", item["id"]))
    return by_profile


def _photos_by_profile(
    supabase: Client,
    profile_ids: list[str],
    bucket: str,
    signed_url_ttl: int,
) -> dict[str, list[dict[str, Any]]]:
    try:
        response = (
            supabase.table("profile_photos")
            .select("id,profile_id,storage_path,is_primary,position")
            .in_("profile_id", profile_ids)
            .order("position")
            .execute()
        )
    except Exception as exc:
        logger.exception("Candidate photo lookup failed")
        raise ServiceUnavailableError(
            "The discovery feed is temporarily unavailable.",
            code="database_unavailable",
        ) from exc
    rows = getattr(response, "data", None) or []

    by_profile: dict[str, list[dict[str, Any]]] = {pid: [] for pid in profile_ids}
    for row in rows:
        profile_id = str(row["profile_id"])
        if profile_id not in by_profile:
            continue
        signed_url = None
        storage_path = row.get("storage_path")
        if storage_path:
            signed_url = create_signed_photo_url(
                supabase, bucket, str(storage_path), signed_url_ttl
            )
        by_profile[profile_id].append(
            {
                "id": str(row["id"]),
                "url": signed_url,
                "is_primary": bool(row.get("is_primary")),
            }
        )
    return by_profile


def _candidate_payload(
    row: dict[str, Any],
    interests: list[dict[str, Any]],
    photos: list[dict[str, Any]],
) -> dict[str, Any]:
    """Project a candidate row to the client-safe discovery shape.

    Only the documented response fields are returned. `date_of_birth` becomes
    `age`; auth_user_id, seeking_gender, verification status, storage_path,
    and timestamps are deliberately excluded.
    """
    university = row.get("universities") or {}
    return {
        "id": str(row["id"]),
        "first_name": row.get("first_name"),
        "age": _age_from_dob(row.get("date_of_birth")),
        "university": {
            "id": str(university["id"]) if university.get("id") else None,
            "name": university.get("name"),
            "city": university.get("city"),
            "state": university.get("state"),
            "country": university.get("country"),
        },
        "course": row.get("course"),
        "academic_year": row.get("academic_year"),
        "gender": row.get("gender"),
        "bio": row.get("bio"),
        "relationship_intent": row.get("relationship_intent"),
        "height_cm": row.get("height_cm"),
        "hometown": row.get("hometown"),
        "interests": interests,
        "profile_prompts": row.get("profile_prompts") or [],
        "photos": photos,
    }


def _age_from_dob(dob: Any) -> int | None:
    """Derive the current age from a date_of_birth string; never return the date."""
    if not dob:
        return None
    try:
        born = date.fromisoformat(str(dob)[:10])
    except ValueError:
        return None
    today = date.today()
    return today.year - born.year - ((today.month, today.day) < (born.month, born.day))
