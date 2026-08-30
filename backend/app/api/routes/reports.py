"""Reports endpoints for verified students (Phase 8).

POST /api/v1/reports — record a report against another profile: a fixed
reason category, optional free-text detail (trimmed, ≤1000 chars), and an
optional (content_type, content_id) content reference (both set or both
absent; no FK — a deleted message/photo must not destroy the reference).

A report writes exactly one row and changes nothing else: no automatic
block, unmatch, or matching effect (admin review decides any action). Report
contents are admin-only — the reporter cannot read reports back (no user
SELECT policy), so the response is just the receipt (id, status, created_at).
Unknown and self targets surface the same 404 (no existence leak); duplicate
reports are allowed.
"""

from enum import Enum
from typing import Any, Literal
from uuid import UUID

from fastapi import APIRouter
from pydantic import BaseModel, field_validator, model_validator

from app.api.deps import CurrentAuthUserDep, SupabaseDep
from app.services import safety as safety_service

router = APIRouter(prefix="/reports", tags=["reports"])


class ReportReason(str, Enum):
    """Fixed reason categories (database CHECK re-enforces this exact set)."""

    HARASSMENT = "harassment"
    INAPPROPRIATE_CONTENT = "inappropriate_content"
    FAKE_PROFILE = "fake_profile"
    UNDERAGE = "underage"
    SPAM = "spam"
    OTHER = "other"


class ReportRequest(BaseModel):
    """Report payload. The reporter is server-derived, never client input."""

    reported_profile_id: UUID
    reason: ReportReason
    detail: str | None = None
    content_type: Literal["profile", "message", "photo"] | None = None
    content_id: UUID | None = None

    @field_validator("detail")
    @classmethod
    def _normalize_detail(cls, value: str | None) -> str | None:
        if value is None:
            return None
        trimmed = value.strip()
        if not trimmed:
            return None
        if len(trimmed) > safety_service.REPORT_DETAIL_MAX_LENGTH:
            raise ValueError(
                f"detail must be at most "
                f"{safety_service.REPORT_DETAIL_MAX_LENGTH} characters "
                "after trimming."
            )
        return trimmed

    @model_validator(mode="after")
    def _require_content_pair(self) -> "ReportRequest":
        if (self.content_type is None) != (self.content_id is None):
            raise ValueError(
                "content_type and content_id must be provided together."
            )
        return self


@router.post("", status_code=201)
def report_user(
    payload: ReportRequest,
    auth_user_id: CurrentAuthUserDep,
    supabase: SupabaseDep,
) -> dict[str, Any]:
    """Report another user (no automatic consequences; admin review only)."""
    return safety_service.report_user(
        supabase,
        auth_user_id,
        reported_profile_id=payload.reported_profile_id,
        reason=payload.reason.value,
        detail=payload.detail,
        content_type=payload.content_type,
        content_id=payload.content_id,
    )
