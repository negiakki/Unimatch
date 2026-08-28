"""Reviewer (staff) verification endpoints.

GET /api/v1/admin/verifications — the review queue. GET /api/v1/admin/
verifications/{id}/document-url — a short-lived signed URL for the private
document. POST /api/v1/admin/verifications/{id}/decision — record a reviewer
decision (VERIFIED / REJECTED). Authorization is derived exclusively from the
authenticated bearer token's identity, checked against `public.staff_admins`
via the service-role client. Responses carry only reviewer-safe data: the
private document reference (storage_path) is never exposed, and document URLs
are signed server-side with the service-role client against the private bucket.
Decisions are constrained by the database state machine (PENDING -> VERIFIED |
REJECTED only) and automatically audited by the existing verification_reviews
trigger.
"""

from enum import Enum
from typing import Annotated, Any
from uuid import UUID

from fastapi import APIRouter, Query
from pydantic import BaseModel, model_validator

from app.api.deps import CurrentStaffUserDep, SettingsDep, SupabaseDep
from app.services import staff as staff_service

router = APIRouter(prefix="/admin", tags=["admin"])


class VerificationStatus(str, Enum):
    """Submission states, exactly as stored (database check constraint)."""

    PENDING = "PENDING"
    VERIFIED = "VERIFIED"
    REJECTED = "REJECTED"


class DecisionStatus(str, Enum):
    """Reviewer decisions. Only these two are legal (database check constraint)."""

    VERIFIED = "VERIFIED"
    REJECTED = "REJECTED"


class DecisionRequest(BaseModel):
    """Reviewer decision payload.

    Only `status` is meaningful. `rejection_reason` is required (non-empty,
    trimmed, ≤500 chars, matching the database constraint) when status is
    REJECTED and is otherwise ignored so it can never be persisted for a
    VERIFIED decision. Reviewer identity and timestamps are server-derived and
    never accepted from the client.
    """

    status: DecisionStatus
    rejection_reason: str | None = None

    @model_validator(mode="after")
    def _normalize_decision(self) -> "DecisionRequest":
        if self.status is DecisionStatus.REJECTED:
            reason = (self.rejection_reason or "").strip()
            if not reason:
                raise ValueError(
                    "rejection_reason is required for a REJECTED decision."
                )
            if len(reason) > 500:
                raise ValueError(
                    "rejection_reason must be at most 500 characters after trimming."
                )
            self.rejection_reason = reason
        else:
            self.rejection_reason = None
        return self


@router.get("/verifications")
def list_verifications(
    _staff_user_id: CurrentStaffUserDep,
    supabase: SupabaseDep,
    status: Annotated[
        VerificationStatus, Query(description="Filter submissions by status.")
    ] = VerificationStatus.PENDING,
) -> list[dict[str, Any]]:
    """Return reviewer-safe queue metadata (oldest submissions first)."""
    return staff_service.get_review_queue(supabase, status.value)


@router.get("/verifications/{verification_id}/document-url")
def get_verification_document_url(
    verification_id: UUID,
    _staff_user_id: CurrentStaffUserDep,
    supabase: SupabaseDep,
    settings: SettingsDep,
) -> dict[str, Any]:
    """Return a short-lived signed URL for the submission's private document.

    The submission UUID is the only client-supplied identifier. The document
    reference (storage_path) is resolved server-side from the database and
    signed with the backend-only service-role client; the private bucket is
    never made public, and storage_path is never returned.
    """
    storage_path = staff_service.get_submission_storage_path(
        supabase, verification_id
    )
    signed_url = staff_service.create_signed_document_url(
        supabase,
        settings.verification_bucket_name,
        storage_path,
        settings.verification_signed_url_ttl_seconds,
    )
    return {
        "url": signed_url,
        "expires_in": settings.verification_signed_url_ttl_seconds,
    }


@router.post("/verifications/{verification_id}/decision")
def decide_verification(
    verification_id: UUID,
    decision: DecisionRequest,
    reviewer_id: CurrentStaffUserDep,
    supabase: SupabaseDep,
) -> dict[str, Any]:
    """Record a reviewer decision (VERIFIED or REJECTED) on a submission.

    The reviewer identity derives exclusively from the authenticated staff
    token — the client can never supply or override reviewer_id, reviewed_at,
    or audit information. The submission UUID in the URL is the only
    client-supplied identifier. The database trigger enforces the state
    machine (PENDING -> VERIFIED | REJECTED only, decided rows immutable),
    timestamps the decision server-side, and automatically writes the
    append-only verification_reviews audit record. storage_path and private
    document access are unrelated to and unaffected by a decision.
    """
    updated = staff_service.make_decision(
        supabase,
        verification_id,
        reviewer_id,
        decision.status.value,
        decision.rejection_reason,
    )
    return _decision_payload(updated)


def _decision_payload(submission: dict[str, Any]) -> dict[str, Any]:
    """Project an updated submission row to the reviewer-decision response.

    Only reviewer-safe fields are returned: storage_path, private document
    references, and internal reviewer/audit details are never exposed.
    """
    return {
        "id": str(submission.get("id")),
        "profile_id": str(submission.get("profile_id")),
        "status": submission.get("status"),
        "submitted_at": submission.get("submitted_at"),
        "reviewed_at": submission.get("reviewed_at"),
        "rejection_reason": submission.get("rejection_reason"),
    }
