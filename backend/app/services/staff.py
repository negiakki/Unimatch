"""Staff reviewer authorization, the review queue, document access, and decisions.

Staff membership is checked against `public.staff_admins` using the
service-role client, resolved exclusively from the authenticated token's
user ID — client-supplied identifiers (user_id, reviewer_id, ...) carry no
authorization weight. The queue projects only reviewer-safe metadata: the
private document reference (storage_path) and the document itself are never
selected, returned, or exposed through any code path here.

Document access resolves the private object path from the database
server-side (never from the client) and generates a SHORT-LIVED signed URL
through the backend-only service-role client. The bucket stays private;
`storage_path` is never returned to any caller.

Reviewer decisions update the submission with the authenticated staff
identity as reviewer_id. The database triggers remain authoritative: they
enforce the state machine (PENDING -> VERIFIED | REJECTED only), assign the
decision timestamp, validate/clear the rejection reason, and write the
append-only `verification_reviews` audit record. This module never inserts
audit rows itself, and it translates database constraint failures into clean
API errors instead of leaking raw Postgres messages.
"""

import logging
from typing import Any
from uuid import UUID

from supabase import Client

from app.core.exceptions import (
    BadRequestError,
    ConflictError,
    NotFoundError,
    ServiceUnavailableError,
)

logger = logging.getLogger(__name__)

# Oldest-first review order, served by
# verification_submissions_status_submitted_idx (status, submitted_at).
_QUEUE_SELECT = (
    "id,profile_id,status,submitted_at,"
    "profiles(first_name,date_of_birth,course,academic_year,"
    "universities(name,city,state,country))"
)

# Hard server-side cap so a large queue can never produce an unbounded
# response. Cursor pagination may replace this with the reviewer UI slice.
_QUEUE_LIMIT = 100


def is_staff(supabase: Client, auth_user_id: UUID) -> bool:
    """Return True iff the authenticated identity is a registered reviewer.

    Membership is looked up by the authenticated identity alone; callers must
    have resolved `auth_user_id` from the bearer token, never from the request.
    """
    try:
        response = (
            supabase.table("staff_admins")
            .select("auth_user_id")
            .eq("auth_user_id", str(auth_user_id))
            .maybe_single()
            .execute()
        )
    except Exception as exc:
        logger.exception("Staff membership lookup failed")
        raise ServiceUnavailableError(
            "Reviewer authorization is temporarily unavailable.",
            code="database_unavailable",
        ) from exc
    row = getattr(response, "data", response)
    return bool(row)


def get_review_queue(supabase: Client, status: str) -> list[dict[str, Any]]:
    """Return reviewer-safe queue metadata for submissions in `status`.

    Rows are oldest-submitted first and capped at `_QUEUE_LIMIT`. Only
    reviewer-safe fields are selected and projected — storage_path, reviewer
    fields, and profile details unnecessary for ID review never appear.
    """
    try:
        response = (
            supabase.table("verification_submissions")
            .select(_QUEUE_SELECT)
            .eq("status", status)
            .order("submitted_at")
            .limit(_QUEUE_LIMIT)
            .execute()
        )
    except Exception as exc:
        logger.exception("Verification review queue lookup failed")
        raise ServiceUnavailableError(
            "The verification queue is temporarily unavailable.",
            code="database_unavailable",
        ) from exc
    rows = getattr(response, "data", None) or []
    return [_queue_item(row) for row in rows]


def _queue_item(row: dict[str, Any]) -> dict[str, Any]:
    """Project a joined submission row to the reviewer-safe queue shape."""
    profile = row.get("profiles") or {}
    university = profile.get("universities") or {}
    return {
        "id": str(row["id"]),
        "profile_id": str(row["profile_id"]),
        "status": row.get("status"),
        "submitted_at": row.get("submitted_at"),
        "student": {
            "first_name": profile.get("first_name"),
            "date_of_birth": profile.get("date_of_birth"),
            "course": profile.get("course"),
            "academic_year": profile.get("academic_year"),
            "university": {
                "name": university.get("name"),
                "city": university.get("city"),
                "state": university.get("state"),
                "country": university.get("country"),
            },
        },
    }


def get_submission_storage_path(supabase: Client, verification_id: UUID) -> str:
    """Resolve the server-side Storage object path for a submission by ID.

    The path comes exclusively from the database — the client can neither
    supply nor override it. The object reference itself is never returned to
    callers; it only ever feeds the server-side signed-URL generation.
    """
    try:
        response = (
            supabase.table("verification_submissions")
            .select("storage_path")
            .eq("id", str(verification_id))
            .maybe_single()
            .execute()
        )
    except Exception as exc:
        logger.exception("Verification submission lookup failed")
        raise ServiceUnavailableError(
            "The verification document is temporarily unavailable.",
            code="database_unavailable",
        ) from exc
    row = getattr(response, "data", response)
    if not row:
        raise NotFoundError(
            "The verification submission was not found.",
            code="verification_not_found",
        )
    storage_path = row.get("storage_path")
    if not storage_path:
        # storage_path is NOT NULL by schema, so a missing value means the
        # submission's document reference is inconsistent server-side.
        logger.error("Submission %s has no storage_path", verification_id)
        raise ServiceUnavailableError(
            "The verification document is currently unavailable.",
            code="document_unavailable",
        )
    return storage_path


def create_signed_document_url(
    supabase: Client, bucket: str, storage_path: str, expires_in_seconds: int
) -> str:
    """Generate a short-lived signed URL for the private document.

    Performed exclusively with the backend-only service-role client; the
    bucket remains private and no public URL or Storage policy is created.
    """
    try:
        response = supabase.storage.from_(bucket).create_signed_url(
            storage_path, expires_in_seconds
        )
        signed_url = response.get("signedUrl") or response.get("signedURL")
    except Exception as exc:
        logger.exception("Storage signed-URL generation failed")
        raise ServiceUnavailableError(
            "The verification document is temporarily unavailable.",
            code="storage_signing_failed",
        ) from exc
    if not signed_url:
        logger.error("Storage returned no signed URL for %s", bucket)
        raise ServiceUnavailableError(
            "The verification document is temporarily unavailable.",
            code="storage_signing_failed",
        )
    return signed_url


def make_decision(
    supabase: Client,
    verification_id: UUID,
    reviewer_id: UUID,
    status: str,
    rejection_reason: str | None = None,
) -> dict[str, Any]:
    """Record a reviewer decision on a PENDING verification submission.

    The reviewer identity is derived exclusively from the authenticated staff
    token — the caller must have already satisfied `is_staff()`. Review facts
    (reviewed_at, the append-only audit record) are written by the database
    triggers, never by the caller.

    Invalid state transitions produce a clean 409 Conflict; raw database
    constraint errors are translated to the existing error envelope.
    """
    try:
        response = (
            supabase.table("verification_submissions")
            .select("id,status")
            .eq("id", str(verification_id))
            .maybe_single()
            .execute()
        )
    except Exception as exc:
        logger.exception("Verification submission lookup failed")
        raise ServiceUnavailableError(
            "The verification submission is temporarily unavailable.",
            code="database_unavailable",
        ) from exc
    row = getattr(response, "data", response)
    if not row:
        raise NotFoundError(
            "The verification submission was not found.",
            code="verification_not_found",
        )

    if row.get("status") != "PENDING":
        raise ConflictError(
            "The verification submission is not in PENDING state.",
            code="invalid_state_transition",
        )

    update: dict[str, Any] = {"status": status, "reviewer_id": str(reviewer_id)}
    if status == "REJECTED":
        update["rejection_reason"] = rejection_reason

    try:
        response = (
            supabase.table("verification_submissions")
            .update(update)
            .eq("id", str(verification_id))
            .execute()
        )
    except Exception as exc:
        detail = str(exc)
        if "illegal verification status transition" in detail:
            raise ConflictError(
                "The verification submission is not in PENDING state.",
                code="invalid_state_transition",
            ) from exc
        if "rejection reason" in detail:
            raise BadRequestError(
                "A rejection reason is required for a REJECTED decision.",
                code="invalid_rejection_reason",
            ) from exc
        logger.exception("Verification decision update failed")
        raise ServiceUnavailableError(
            "The verification decision could not be recorded.",
            code="database_update_failed",
        ) from exc

    rows = getattr(response, "data", None) or []
    if not rows:
        raise ServiceUnavailableError(
            "The verification decision could not be recorded.",
            code="database_update_failed",
        )
    return rows[0]
