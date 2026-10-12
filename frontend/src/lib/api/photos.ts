/**
 * Profile photos.
 *
 * GET    /api/v1/profiles/me/photos        — the caller's photos (ordered,
 *                                            with short-lived signed URLs).
 * POST   /api/v1/profiles/me/photos        — multipart upload (max 6 photos,
 *                                            JPEG/PNG/WebP, up to 10 MB).
 * DELETE /api/v1/profiles/me/photos/{id}   — delete + re-compact ordering.
 * PUT    /api/v1/profiles/me/photos/order  — full reorder; first = primary.
 *
 * Ownership is derived server-side from the session token — this client never
 * sends auth_user_id or profile ids, and the backend never returns storage
 * paths, only short-lived signed URLs for the private bucket.
 */

import { ApiError, requestJson } from "@/lib/api/http";

export interface ProfilePhoto {
  id: string;
  position: number;
  is_primary: boolean;
  /** Short-lived signed URL; may be absent on a fresh upload — refetch. */
  url?: string;
}

export interface ProfilePhotoCollection {
  photos: ProfilePhoto[];
  max_photos: number;
}

/** 6 photos per profile — mirrors the backend product limit. */
export const MAX_PHOTOS = 6;

/** 10 MB — mirrors the backend limit. Client-side checks are UX only. */
export const MAX_PHOTO_BYTES = 10 * 1024 * 1024;

const ALLOWED_MIME_TYPES = new Set(["image/jpeg", "image/png", "image/webp"]);
const ALLOWED_EXTENSIONS = [".jpg", ".jpeg", ".png", ".webp"];

const MESSAGES = {
  unauthorized: "You need to sign in to manage your photos.",
  not_found: "We couldn't find your profile.",
  invalid_file: "That file can't be used. Please choose a JPEG, PNG, or WebP image.",
  file_too_large: "That photo is too large. The maximum size is 10 MB.",
  limit_reached: "You can have up to 6 photos. Delete one before adding another.",
  conflict: "That change conflicted with another. Please try again.",
  unavailable: "Your photos are temporarily unavailable. Please try again shortly.",
} as const;

/**
 * UX-only pre-flight validation. The backend re-validates the photo
 * authoritatively (size + magic bytes). Returns an error message, or null
 * when the file looks usable.
 */
export function validatePhotoFile(file: File): string | null {
  if (file.size === 0) {
    return "That file appears to be empty. Please choose a valid photo.";
  }
  if (file.size > MAX_PHOTO_BYTES) {
    return MESSAGES.file_too_large;
  }
  const mimeAllowed = ALLOWED_MIME_TYPES.has(file.type);
  const extensionAllowed = ALLOWED_EXTENSIONS.some((extension) =>
    file.name.toLowerCase().endsWith(extension),
  );
  const typeAllowed = file.type ? mimeAllowed : extensionAllowed;
  if (!typeAllowed) {
    return "Unsupported file type. Please use JPEG, PNG, or WebP.";
  }
  return null;
}

export async function fetchPhotos(): Promise<ProfilePhotoCollection> {
  return requestJson<ProfilePhotoCollection>("/api/v1/profiles/me/photos", {
    method: "GET",
  });
}

export async function uploadPhoto(file: File): Promise<ProfilePhoto> {
  const formData = new FormData();
  formData.append("file", file, file.name);
  return requestJson<ProfilePhoto>(
    "/api/v1/profiles/me/photos",
    { method: "POST", body: formData },
    MESSAGES,
  );
}

export async function deletePhoto(photoId: string): Promise<ProfilePhotoCollection> {
  return requestJson<ProfilePhotoCollection>(
    `/api/v1/profiles/me/photos/${encodeURIComponent(photoId)}`,
    { method: "DELETE" },
    MESSAGES,
  );
}

export async function reorderPhotos(
  photoIds: string[],
): Promise<ProfilePhotoCollection> {
  return requestJson<ProfilePhotoCollection>(
    "/api/v1/profiles/me/photos/order",
    { method: "PUT", body: JSON.stringify({ photo_ids: photoIds }) },
    MESSAGES,
  );
}

export { ApiError };