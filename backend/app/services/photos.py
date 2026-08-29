"""Profile photo business logic (upload, list, delete, reorder).

Photos are user-owned data. Binaries live in the private `profile-photos`
bucket under `<auth.uid()>/<random-file-id>.<ext>`; the existing
`profile_photos` table stores the object reference plus ordering
(`position`, unique per profile) and the primary flag (at most one primary
per profile, partial unique index). Ownership derives exclusively from the
authenticated identity — never from client input — and the Storage object
path is never returned to any client; photos are delivered through
short-lived signed URLs generated server-side.

Application-level rules (deliberately not database constraints — see
docs/DATABASE.md):
  * at most MAX_PHOTOS (6) photos per profile (PRD 1-6 bounds);
  * the primary photo is the photo at the lowest position; `is_primary`
    is re-derived from `position` on every mutation of this module.

Cross-row mutations use two PostgREST upsert statements (a single statement
cannot shuffle positions among existing rows without transient unique
violations). Each statement is individually atomic and consistent; a failure
between them leaves an ordered, retryable state that never violates the
database invariants.
"""

import logging
from typing import Any
from uuid import UUID, uuid4

from supabase import Client

from app.core.exceptions import (
    BadRequestError,
    ConflictError,
    NotFoundError,
    ServiceUnavailableError,
)

logger = logging.getLogger(__name__)

# Product rule from the PRD: minimum 1 / maximum 6 photos. The minimum is a
# discovery-era gate (not this slice); the maximum is enforced here.
MAX_PHOTOS = 6

ALLOWED_CONTENT_TYPES: dict[str, str] = {
    "image/jpeg": "jpg",
    "image/png": "png",
    "image/webp": "webp",
}

_DECLARED_TYPE_ALIASES = {
    "image/jpg": "image/jpeg",
    "image/pjpeg": "image/jpeg",
}

_OCTET_STREAM = "application/octet-stream"

# Client-safe projection — storage_path is a server-side reference only and
# is never returned to clients; signed URLs are generated server-side.
# (list_photos returns raw rows including storage_path for internal object
# handling; the route layer projects every response through _photo_payload,
# which never includes it.)
_PHOTO_COLUMNS = "id,position,is_primary,storage_path"


def sniff_content_type(data: bytes) -> str | None:
    """Detect the true content type from magic bytes, ignoring the client MIME."""
    if data.startswith(b"\xff\xd8\xff"):
        return "image/jpeg"
    if data.startswith(b"\x89PNG\r\n\x1a\n"):
        return "image/png"
    if len(data) >= 12 and data[:4] == b"RIFF" and data[8:12] == b"WEBP":
        return "image/webp"
    return None


def validate_photo(data: bytes, declared_content_type: str | None) -> str:
    """Validate the photo server-side; return the canonical content type.

    The browser-declared MIME type is never trusted on its own: the file must
    sniff as an allowed photo type, and a declared type that contradicts the
    actual bytes is rejected.
    """
    if not data:
        raise BadRequestError(
            "The uploaded file is empty.", code="invalid_file_type"
        )
    sniffed = sniff_content_type(data)
    if sniffed is None or sniffed not in ALLOWED_CONTENT_TYPES:
        raise BadRequestError(
            "Unsupported file type. Accepted formats: JPEG, PNG, WebP.",
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

    Never derived from names, profile IDs, or any client-supplied value.
    """
    extension = ALLOWED_CONTENT_TYPES[content_type]
    return f"{auth_user_id}/{uuid4().hex}.{extension}"


def list_photos(supabase: Client, profile_id: UUID) -> list[dict[str, Any]]:
    """Return the profile's photo rows ordered by position (internal use).

    Rows include the server-side storage_path for object handling only —
    callers must project through the route layer, which never returns it.
    """
    try:
        response = (
            supabase.table("profile_photos")
            .select(_PHOTO_COLUMNS)
            .eq("profile_id", str(profile_id))
            .order("position")
            .execute()
        )
    except Exception as exc:
        logger.exception("Profile photo lookup failed")
        raise ServiceUnavailableError(
            "Your photos are temporarily unavailable. Please try again in a moment.",
            code="database_unavailable",
        ) from exc
    rows = getattr(response, "data", None) or []
    return [
        {
            "id": str(row["id"]),
            "position": row.get("position"),
            "is_primary": bool(row.get("is_primary")),
            "storage_path": row.get("storage_path"),
        }
        for row in rows
    ]


def enforce_photo_limit(existing_count: int) -> None:
    """PRD maximum: at most six photos per profile."""
    if existing_count >= MAX_PHOTOS:
        raise ConflictError(
            f"You can have at most {MAX_PHOTOS} photos. Delete one first.",
            code="photo_limit_reached",
        )


def upload_photo(
    supabase: Client,
    bucket: str,
    storage_path: str,
    data: bytes,
    content_type: str,
) -> None:
    """Upload the photo to the private bucket with the service role."""
    try:
        supabase.storage.from_(bucket).upload(
            path=storage_path,
            file=data,
            file_options={"content-type": content_type, "upsert": False},
        )
    except Exception as exc:
        logger.exception("Storage upload failed for profile photo")
        raise ServiceUnavailableError(
            "Your photo could not be stored. Please try again later.",
            code="storage_upload_failed",
        ) from exc


def insert_photo(
    supabase: Client,
    profile_id: UUID,
    storage_path: str,
    position: int,
    is_primary: bool,
) -> dict[str, Any]:
    """Insert a photo row with server-authoritative ordering and primary flag."""
    try:
        response = (
            supabase.table("profile_photos")
            .insert(
                {
                    "profile_id": str(profile_id),
                    "storage_path": storage_path,
                    "position": position,
                    "is_primary": is_primary,
                }
            )
            .execute()
        )
    except Exception as exc:
        detail = str(exc)
        if "duplicate key" in detail and "profile_photos_profile_position_key" in detail:
            # Concurrent upload claimed the same next position; the caller can
            # simply retry (the limit re-check happens on the retry).
            raise ConflictError(
                "That upload conflicted with another. Please try again.",
                code="photo_upload_conflict",
            ) from exc
        if "duplicate key" in detail and "profile_photos_storage_path_key" in detail:
            raise ConflictError(
                "That upload conflicted with another. Please try again.",
                code="photo_upload_conflict",
            ) from exc
        logger.exception("Profile photo insert failed")
        raise ServiceUnavailableError(
            "Your photo could not be saved. Please try again later.",
            code="database_insert_failed",
        ) from exc
    rows = getattr(response, "data", None) or []
    if not rows:
        raise ServiceUnavailableError(
            "Your photo could not be saved. Please try again later.",
            code="database_insert_failed",
        )
    row = rows[0]
    return {
        "id": str(row["id"]),
        "position": row.get("position"),
        "is_primary": bool(row.get("is_primary")),
    }


def _get_own_photo_row(
    supabase: Client, profile_id: UUID, photo_id: UUID
) -> dict[str, Any]:
    """Resolve one of the caller's own photo rows (internal, incl. path).

    A photo owned by anyone else is indistinguishable from a photo that does
    not exist (no existence leak). Ownership comes from the server-resolved
    profile — the photo id in the URL carries no authorization weight. The
    storage_path in the result is for server-side object handling only and
    must never reach a response payload.
    """
    try:
        response = (
            supabase.table("profile_photos")
            .select(_PHOTO_COLUMNS)
            .eq("id", str(photo_id))
            .eq("profile_id", str(profile_id))
            .maybe_single()
            .execute()
        )
    except Exception as exc:
        logger.exception("Profile photo lookup failed")
        raise ServiceUnavailableError(
            "Your photos are temporarily unavailable. Please try again in a moment.",
            code="database_unavailable",
        ) from exc
    row = getattr(response, "data", response)
    if not row:
        raise NotFoundError(
            "That photo does not exist.", code="photo_not_found"
        )
    return dict(row)


def delete_photo(
    supabase: Client,
    bucket: str,
    profile_id: UUID,
    photo_id: UUID,
) -> None:
    """Delete the caller's photo row and best-effort its Storage object.

    The row is deleted first (the database reference is the source of truth);
    the private object is then removed with the service role. If object
    cleanup fails the row is already gone and only an orphaned object
    remains (logged for operations) — a dangling row reference pointing at a
    missing object is never created.
    """
    row = _get_own_photo_row(supabase, profile_id, photo_id)
    storage_path = row.get("storage_path")

    try:
        response = (
            supabase.table("profile_photos")
            .delete()
            .eq("id", str(photo_id))
            .eq("profile_id", str(profile_id))
            .execute()
        )
    except Exception as exc:
        logger.exception("Profile photo delete failed")
        raise ServiceUnavailableError(
            "Your photo could not be deleted. Please try again later.",
            code="database_delete_failed",
        ) from exc
    rows = getattr(response, "data", None) or []
    if not rows:
        # Deleted concurrently between the ownership check and now.
        raise NotFoundError(
            "That photo does not exist.", code="photo_not_found"
        )

    if storage_path:
        remove_photo_object(supabase, bucket, storage_path)


def remove_photo_object(supabase: Client, bucket: str, storage_path: str) -> bool:
    """Best-effort removal of a deleted photo's Storage object.

    Called only with the path of a photo whose row is already deleted (or is
    being cleaned up after a failed insert), so a live photo's object is
    never touched. A cleanup failure is logged and never masks the original
    result; an orphaned object is preferable to a dangling row reference.
    """
    try:
        supabase.storage.from_(bucket).remove([storage_path])
        return True
    except Exception:
        logger.exception(
            "Failed to clean up profile photo object %s", storage_path
        )
        return False


def compact_photo_positions(supabase: Client, profile_id: UUID) -> None:
    """Renumber the profile's remaining photos to 1..N in current order.

    After a deletion, positions have a gap; remaining photos keep their
    relative order and the photo at position 1 becomes primary. Rows are
    renumbered in ascending position order, which is conflict-free for a
    single order-preserving compaction (each target position is already
    free when the row is written).
    """
    photos = list_photos(supabase, profile_id)
    if not photos:
        return
    updates = [
        {
            "id": photo["id"],
            "storage_path": photo.get("storage_path"),
            "position": index + 1,
            "is_primary": index == 0,
        }
        for index, photo in enumerate(photos)
    ]
    _upsert_photo_rows(supabase, profile_id, updates, "compact")


def reorder_photos(
    supabase: Client, profile_id: UUID, ordered_photo_ids: list[UUID]
) -> None:
    """Apply a full ordering to the profile's photos (server-authoritative).

    `ordered_photo_ids` must be a permutation of ALL of the profile's photo
    ids. The photo placed first becomes the primary photo (product rule:
    primary = lowest position).

    Performed as two individually-atomic upserts: first offset all positions
    above the occupied range and clear every primary flag, then write the
    final positions with the new primary. A failure between the two leaves
    an ordered, retryable state that violates no database invariant.
    """
    photos = list_photos(supabase, profile_id)
    if not photos:
        if ordered_photo_ids:
            raise NotFoundError(
                "That photo does not exist.", code="photo_not_found"
            )
        return  # Nothing to order; an empty request on an empty set is a no-op.

    current_ids = {photo["id"] for photo in photos}
    requested_ids = [str(photo_id) for photo_id in ordered_photo_ids]
    if len(requested_ids) != len(set(requested_ids)) or set(requested_ids) != current_ids:
        raise BadRequestError(
            "The photo order must include every photo exactly once.",
            code="invalid_photo_order",
        )

    count = len(photos)
    offset = count  # all offset positions (count+1 .. 2*count) are free

    phase_one = [
        {
            "id": photo["id"],
            "storage_path": photo.get("storage_path"),
            "position": offset + index + 1,
            "is_primary": False,
        }
        for index, photo in enumerate(photos)
    ]
    _upsert_photo_rows(supabase, profile_id, phase_one, "reorder-offset")

    order_index = {photo_id: index for index, photo_id in enumerate(requested_ids)}
    phase_two = [
        {
            "id": photo["id"],
            "storage_path": photo.get("storage_path"),
            "position": order_index[photo["id"]] + 1,
            "is_primary": order_index[photo["id"]] == 0,
        }
        for photo in photos
    ]
    _upsert_photo_rows(supabase, profile_id, phase_two, "reorder-final")


def _upsert_photo_rows(
    supabase: Client,
    profile_id: UUID,
    updates: list[dict[str, Any]],
    operation: str,
) -> None:
    """Merge position/primary updates into existing rows (single statement).

    Every update carries the row's `profile_id` and is filtered server-side
    by the caller's profile, so rows can never move between profiles. Only
    the fields this module maintains (`position`, `is_primary`) are written;
    `storage_path` is never touched.
    """
    payload = [
        {
            "id": update["id"],
            "profile_id": str(profile_id),
            "storage_path": update["storage_path"],
            "position": update["position"],
            "is_primary": update["is_primary"],
        }
        for update in updates
    ]
    try:
        response = (
            supabase.table("profile_photos")
            .upsert(payload, on_conflict="id")
            .execute()
        )
    except Exception as exc:
        detail = str(exc)
        if "duplicate key" in detail:
            # A concurrent mutation claimed a position first; a retry applies
            # the caller's ordering to the fresh state.
            raise ConflictError(
                "Your photos were changed elsewhere. Please try again.",
                code="photo_upload_conflict",
            ) from exc
        logger.exception("Profile photo %s failed", operation)
        raise ServiceUnavailableError(
            "Your photos could not be updated. Please try again later.",
            code="database_update_failed",
        ) from exc
    rows = getattr(response, "data", None) or []
    if len(rows) != len(payload):
        logger.error(
            "Profile photo %s updated %s of %s rows",
            operation,
            len(rows),
            len(payload),
        )
        raise ServiceUnavailableError(
            "Your photos could not be updated. Please try again later.",
            code="database_update_failed",
        )


def create_signed_photo_url(
    supabase: Client, bucket: str, storage_path: str, expires_in_seconds: int
) -> str:
    """Generate a short-lived signed URL for the private photo object.

    Performed exclusively with the backend-only service-role client; the
    bucket remains private and no public URL or Storage policy is created.
    """
    try:
        response = supabase.storage.from_(bucket).create_signed_url(
            storage_path, expires_in_seconds
        )
        signed_url = response.get("signedUrl") or response.get("signedURL")
    except Exception as exc:
        logger.exception("Storage signed-URL generation failed for profile photo")
        raise ServiceUnavailableError(
            "Your photos are temporarily unavailable. Please try again in a moment.",
            code="storage_signing_failed",
        ) from exc
    if not signed_url:
        logger.error("Storage returned no signed URL for %s", bucket)
        raise ServiceUnavailableError(
            "Your photos are temporarily unavailable. Please try again in a moment.",
            code="storage_signing_failed",
        )
    return signed_url
