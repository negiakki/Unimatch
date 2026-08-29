"""Profile photo endpoints for the authenticated student.

GET    /api/v1/profiles/me/photos           — the caller's photos (ordered,
                                             with short-lived signed URLs).
POST   /api/v1/profiles/me/photos           — multipart upload (max 6 photos,
                                             JPEG/PNG/WebP, max 10 MB).
DELETE /api/v1/profiles/me/photos/{id}      — delete a photo (row + private
                                             object) and re-compact ordering.
PUT    /api/v1/profiles/me/photos/order     — full reordering; the photo put
                                             first becomes the primary photo.

Ownership derives exclusively from the Supabase bearer token: the profile is
resolved server-side from the authenticated identity and a photo id in the
URL never grants access to another user's photo. Storage object paths are
server-side references only — they are never accepted from or returned to
the client; photos are delivered through short-lived signed URLs generated
by the backend service-role client against the private bucket.
"""

import logging
from typing import Annotated, Any
from uuid import UUID

from fastapi import APIRouter, File, UploadFile
from pydantic import BaseModel, Field

from app.api.deps import CurrentAuthUserDep, SettingsDep, SupabaseDep
from app.core.exceptions import PayloadTooLargeError
from app.services import photos as photos_service
from app.services import profile as profile_service

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/profiles/me/photos", tags=["photos"])

_UPLOAD_CHUNK_BYTES = 1024 * 1024


class PhotoOrderUpdate(BaseModel):
    """Full photo ordering.

    Must contain every of the caller's photo ids exactly once (a partial
    order is rejected). The first id becomes the primary photo. Server-side
    facts (position values, is_primary, storage_path) are never accepted
    from the client.
    """

    photo_ids: list[UUID] = Field(max_length=photos_service.MAX_PHOTOS)


@router.get("")
def list_my_photos(
    auth_user_id: CurrentAuthUserDep,
    supabase: SupabaseDep,
    settings: SettingsDep,
) -> dict[str, Any]:
    """Return the authenticated user's own photos, ordered, with signed URLs."""
    profile = profile_service.get_own_profile_or_not_found(supabase, auth_user_id)
    photos = _signed_photo_list(
        supabase,
        settings.profile_photos_bucket_name,
        profile["id"],
        settings.profile_photos_signed_url_ttl_seconds,
    )
    return {
        "photos": photos,
        "max_photos": photos_service.MAX_PHOTOS,
    }


@router.post("", status_code=201)
def upload_my_photo(
    auth_user_id: CurrentAuthUserDep,
    supabase: SupabaseDep,
    settings: SettingsDep,
    file: Annotated[
        UploadFile,
        File(description="Profile photo: JPEG, PNG, or WebP (max 10 MB)."),
    ],
) -> dict[str, Any]:
    """Upload a profile photo for the authenticated user."""
    max_bytes = settings.profile_photos_max_upload_bytes
    data = _read_limited(file.file, max_bytes)
    content_type = photos_service.validate_photo(data, file.content_type)

    profile = profile_service.get_own_profile_or_not_found(supabase, auth_user_id)
    profile_id = UUID(str(profile["id"]))
    existing = photos_service.list_photos(supabase, profile_id)
    photos_service.enforce_photo_limit(len(existing))

    bucket = settings.profile_photos_bucket_name
    storage_path = photos_service.build_object_path(auth_user_id, content_type)
    photos_service.upload_photo(supabase, bucket, storage_path, data, content_type)

    # PRD: uploads append to the end of the order; the first photo becomes
    # the primary photo (primary = lowest position).
    position = len(existing) + 1
    is_primary = not existing
    try:
        photo = photos_service.insert_photo(
            supabase, profile_id, storage_path, position, is_primary
        )
    except Exception:
        photos_service.remove_photo_object(supabase, bucket, storage_path)
        raise

    url = None
    try:
        url = photos_service.create_signed_photo_url(
            supabase, bucket, storage_path, settings.profile_photos_signed_url_ttl_seconds
        )
    except Exception:
        # The photo is stored; display URLs come from the next list call.
        logger.warning("Signed-URL generation failed for a freshly uploaded photo")

    return _photo_payload(photo, url)


@router.delete("/{photo_id}")
def delete_my_photo(
    photo_id: UUID,
    auth_user_id: CurrentAuthUserDep,
    supabase: SupabaseDep,
    settings: SettingsDep,
) -> dict[str, Any]:
    """Delete one of the caller's photos and return the remaining ordering.

    Remaining photos keep their relative order and are renumbered to 1..N;
    the photo at position 1 is the primary photo. A foreign or unknown photo
    id is a 404 — existence of other users' photos is never revealed.
    """
    profile = profile_service.get_own_profile_or_not_found(supabase, auth_user_id)
    profile_id = UUID(str(profile["id"]))
    photos_service.delete_photo(
        supabase, settings.profile_photos_bucket_name, profile_id, photo_id
    )
    photos_service.compact_photo_positions(supabase, profile_id)
    return _photo_list_response(supabase, settings, profile_id)


@router.put("/order")
def reorder_my_photos(
    order: PhotoOrderUpdate,
    auth_user_id: CurrentAuthUserDep,
    supabase: SupabaseDep,
    settings: SettingsDep,
) -> dict[str, Any]:
    """Apply a full ordering to the caller's photos; first id becomes primary."""
    profile = profile_service.get_own_profile_or_not_found(supabase, auth_user_id)
    profile_id = UUID(str(profile["id"]))
    photos_service.reorder_photos(supabase, profile_id, order.photo_ids)
    return _photo_list_response(supabase, settings, profile_id)


def _photo_list_response(
    supabase: SupabaseDep, settings: SettingsDep, profile_id: UUID
) -> dict[str, Any]:
    photos = _signed_photo_list(
        supabase,
        settings.profile_photos_bucket_name,
        profile_id,
        settings.profile_photos_signed_url_ttl_seconds,
    )
    return {
        "photos": photos,
        "max_photos": photos_service.MAX_PHOTOS,
    }


def _signed_photo_list(
    supabase: SupabaseDep, bucket: str, profile_id: UUID, ttl_seconds: int
) -> list[dict[str, Any]]:
    """List the profile's photos with short-lived signed URLs (path never returned)."""
    photos = photos_service.list_photos(supabase, profile_id)
    signed: list[dict[str, Any]] = []
    for index, photo in enumerate(photos):
        signed_url = None
        if photo.get("storage_path"):
            signed_url = photos_service.create_signed_photo_url(
                supabase, bucket, str(photo["storage_path"]), ttl_seconds
            )
        signed.append(_photo_payload(photo, signed_url))
    return signed


def _photo_payload(photo: dict[str, Any], url: str | None) -> dict[str, Any]:
    """Project a photo row to client-safe fields (never the storage path)."""
    payload: dict[str, Any] = {
        "id": str(photo["id"]),
        "position": photo.get("position"),
        "is_primary": bool(photo.get("is_primary")),
    }
    if url is not None:
        payload["url"] = url
    return payload


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
