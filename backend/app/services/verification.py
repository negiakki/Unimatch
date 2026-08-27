"""Student ID verification submission business logic.

Covers document validation (size + magic bytes, never the client MIME type),
server-side storage object naming, the one-pending / already-verified
submission rules, and partial-failure cleanup. Documents live in the private
`verification-documents` bucket under `<auth.uid()>/<random-file-id>.<ext>`;
PostgreSQL stores the object reference only — never binaries or URLs.
"""

import logging
from typing import Any
from uuid import UUID, uuid4

from supabase import Client

from app.core.exceptions import (
    BadRequestError,
    ConflictError,
    NotFoundError,
    PayloadTooLargeError,
    ServiceUnavailableError,
)

logger = logging.getLogger(__name__)

ALLOWED_CONTENT_TYPES: dict[str, str] = {
    "image/jpeg": "jpg",
    "image/png": "png",
    "image/webp": "webp",
    "application/pdf": "pdf",
}

_DECLARED_TYPE_ALIASES = {
    "image/jpg": "image/jpeg",
    "image/pjpeg": "image/jpeg",
}

_OCTET_STREAM = "application/octet-stream"


def sniff_content_type(data: bytes) -> str | None:
    """Detect the true content type from magic bytes, ignoring the client MIME."""
    if data.startswith(b"\xff\xd8\xff"):
        return "image/jpeg"
    if data.startswith(b"\x89PNG\r\n\x1a\n"):
        return "image/png"
    if len(data) >= 12 and data[:4] == b"RIFF" and data[8:12] == b"WEBP":
        return "image/webp"
    if data.startswith(b"%PDF-"):
        return "application/pdf"
    return None


def validate_upload(
    data: bytes, declared_content_type: str | None, max_bytes: int
) -> str:
    """Validate the upload server-side; return the canonical content type.

    The browser-declared MIME type is never trusted on its own: the file must
    sniff as an allowed type, and a declared type that contradicts the actual
    bytes is rejected.
    """
    if not data:
        raise BadRequestError(
            "The uploaded file is empty.", code="invalid_file_type"
        )
    if len(data) > max_bytes:
        raise PayloadTooLargeError(
            "The uploaded file exceeds the maximum allowed size.",
            code="file_too_large",
        )
    sniffed = sniff_content_type(data)
    if sniffed is None or sniffed not in ALLOWED_CONTENT_TYPES:
        raise BadRequestError(
            "Unsupported file type. Accepted formats: JPEG, PNG, WebP, PDF.",
            code="invalid_file_type",
        )
    if declared_content_type:
        declared = declared_content_type.split(";", 1)[0].strip().lower()
        declared = _DECLARED_TYPE_ALIASES.get(declared, declared)
        if declared != _OCTET_STREAM and declared != sniffed:
            raise BadRequestError(
                "The declared file type does not match the file contents.",
                code="invalid_file_type",
            )
    return sniffed


def build_object_path(auth_user_id: UUID, content_type: str) -> str:
    """Server-side Storage object name: <auth.uid()>/<random-file-id>.<ext>.

    Never derived from student name, student ID number, university ID, or the
    profile ID.
    """
    extension = ALLOWED_CONTENT_TYPES[content_type]
    return f"{auth_user_id}/{uuid4().hex}.{extension}"


def get_profile_id(supabase: Client, auth_user_id: UUID) -> UUID:
    """Resolve the caller's own profile via the authenticated identity."""
    try:
        response = (
            supabase.table("profiles")
            .select("id")
            .eq("auth_user_id", str(auth_user_id))
            .maybe_single()
            .execute()
        )
    except Exception as exc:
        logger.exception("Profile lookup failed")
        raise ServiceUnavailableError(
            "Verification is temporarily unavailable.", code="database_unavailable"
        ) from exc
    profile = getattr(response, "data", response)
    if not profile:
        raise NotFoundError(
            "No student profile exists for this account.", code="profile_not_found"
        )
    return UUID(str(profile["id"]))


def get_existing_statuses(supabase: Client, profile_id: UUID) -> list[str]:
    """Return the statuses of the profile's existing submissions."""
    try:
        response = (
            supabase.table("verification_submissions")
            .select("status")
            .eq("profile_id", str(profile_id))
            .execute()
        )
    except Exception as exc:
        logger.exception("Verification history lookup failed")
        raise ServiceUnavailableError(
            "Verification is temporarily unavailable.", code="database_unavailable"
        ) from exc
    rows = getattr(response, "data", None) or []
    return [str(row["status"]) for row in rows]


def enforce_submission_rules(statuses: list[str]) -> None:
    """One PENDING at a time; VERIFIED is terminal; REJECTED may resubmit."""
    if "VERIFIED" in statuses:
        raise ConflictError(
            "Verification is already complete; further submissions are not allowed.",
            code="already_verified",
        )
    if "PENDING" in statuses:
        raise ConflictError(
            "A verification submission is already under review.",
            code="pending_submission_exists",
        )


def upload_document(
    supabase: Client, bucket: str, storage_path: str, data: bytes, content_type: str
) -> None:
    """Upload the document to the private bucket with the service role."""
    try:
        supabase.storage.from_(bucket).upload(
            path=storage_path,
            file=data,
            file_options={"content-type": content_type, "upsert": False},
        )
    except Exception as exc:
        logger.exception("Storage upload failed for verification document")
        raise ServiceUnavailableError(
            "The document could not be stored. Please try again later.",
            code="storage_upload_failed",
        ) from exc


def remove_document(supabase: Client, bucket: str, storage_path: str) -> bool:
    """Best-effort removal of a just-uploaded document (partial-failure cleanup).

    Only ever called with the object path created by the current request, so an
    existing valid submission's document is never touched. A cleanup failure is
    logged and never masks the original error.
    """
    try:
        supabase.storage.from_(bucket).remove([storage_path])
        return True
    except Exception:
        logger.exception(
            "Failed to clean up orphaned verification document %s", storage_path
        )
        return False


def insert_submission(
    supabase: Client, profile_id: UUID, storage_path: str
) -> dict[str, Any]:
    """Insert a PENDING submission row with server-authoritative values."""
    try:
        response = (
            supabase.table("verification_submissions")
            .insert(
                {
                    "profile_id": str(profile_id),
                    "status": "PENDING",
                    "storage_path": storage_path,
                }
            )
            .execute()
        )
    except Exception as exc:
        detail = str(exc)
        if "duplicate key" in detail or "one_pending_per_profile" in detail:
            raise ConflictError(
                "A verification submission is already under review.",
                code="pending_submission_exists",
            ) from exc
        logger.exception("Verification submission insert failed")
        raise ServiceUnavailableError(
            "The submission could not be recorded. Please try again later.",
            code="database_insert_failed",
        ) from exc
    rows = getattr(response, "data", None) or []
    if not rows:
        raise ServiceUnavailableError(
            "The submission could not be recorded. Please try again later.",
            code="database_insert_failed",
        )
    return rows[0]


def get_latest_submission(supabase: Client, profile_id: UUID) -> dict[str, Any] | None:
    """Return the profile's most recent submission (current verification state)."""
    try:
        response = (
            supabase.table("verification_submissions")
            .select("id,status,submitted_at,reviewed_at,rejection_reason")
            .eq("profile_id", str(profile_id))
            .order("submitted_at", desc=True)
            .limit(1)
            .execute()
        )
    except Exception as exc:
        logger.exception("Verification status lookup failed")
        raise ServiceUnavailableError(
            "Verification is temporarily unavailable.", code="database_unavailable"
        ) from exc
    rows = getattr(response, "data", None) or []
    return rows[0] if rows else None
