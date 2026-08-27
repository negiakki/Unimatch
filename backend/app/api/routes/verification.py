"""Student ID verification endpoints.

POST /api/v1/verification/submit — upload a student ID document for manual
review. GET /api/v1/verification/status — the caller's own verification state.

Documents are stored in the private `verification-documents` bucket under
`<auth.uid()>/<random-file-id>.<extension>`; PostgreSQL stores the object
reference only. Ownership comes exclusively from the authenticated identity.
"""

import logging
from typing import Annotated, Any

from fastapi import APIRouter, File, UploadFile

from app.api.deps import CurrentAuthUserDep, SettingsDep, SupabaseDep
from app.core.exceptions import PayloadTooLargeError
from app.services import verification as verification_service

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/verification", tags=["verification"])

_UPLOAD_CHUNK_BYTES = 1024 * 1024


@router.post("/submit", status_code=201)
def submit_verification_document(
    auth_user_id: CurrentAuthUserDep,
    supabase: SupabaseDep,
    settings: SettingsDep,
    file: Annotated[
        UploadFile,
        File(description="Student ID document: JPEG, PNG, WebP, or PDF (max 10 MB)."),
    ],
) -> dict[str, Any]:
    """Create a PENDING verification submission for the authenticated student."""
    max_bytes = settings.verification_max_upload_bytes
    data = _read_limited(file.file, max_bytes)
    content_type = verification_service.validate_upload(
        data, file.content_type, max_bytes
    )

    profile_id = verification_service.get_profile_id(supabase, auth_user_id)
    verification_service.enforce_submission_rules(
        verification_service.get_existing_statuses(supabase, profile_id)
    )

    bucket = settings.verification_bucket_name
    storage_path = verification_service.build_object_path(auth_user_id, content_type)
    verification_service.upload_document(
        supabase, bucket, storage_path, data, content_type
    )

    try:
        submission = verification_service.insert_submission(
            supabase, profile_id, storage_path
        )
    except Exception:
        verification_service.remove_document(supabase, bucket, storage_path)
        raise

    return _submission_payload(submission)


@router.get("/status")
def get_verification_status(
    auth_user_id: CurrentAuthUserDep,
    supabase: SupabaseDep,
) -> dict[str, Any]:
    """Return the authenticated user's own verification state (and nothing else)."""
    profile_id = verification_service.get_profile_id(supabase, auth_user_id)
    latest = verification_service.get_latest_submission(supabase, profile_id)
    if latest is None:
        return {"verification_status": None, "submission": None}
    return {
        "verification_status": latest.get("status"),
        "submission": _submission_payload(latest),
    }


def _submission_payload(submission: dict[str, Any]) -> dict[str, Any]:
    """Project a submission row to client-safe fields (never the storage path)."""
    return {
        "id": str(submission.get("id")),
        "status": submission.get("status"),
        "submitted_at": submission.get("submitted_at"),
        "reviewed_at": submission.get("reviewed_at"),
        "rejection_reason": submission.get("rejection_reason"),
    }


def _read_limited(upload_file: Any, max_bytes: int) -> bytes:
    """Read the upload in chunks so oversized bodies never buffer fully."""
    chunks: list[bytes] = []
    total = 0
    while True:
        chunk = upload_file.read(_UPLOAD_CHUNK_BYTES)
        if not chunk:
            break
        total += len(chunk)
        if total > max_bytes:
            raise PayloadTooLargeError(
                "The uploaded file exceeds the maximum allowed size.",
                code="file_too_large",
            )
        chunks.append(chunk)
    return b"".join(chunks)
