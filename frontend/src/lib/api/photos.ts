/**
 * API client for the profile photo endpoints.
 *
 * GET    /api/v1/profiles/me/photos        — the caller's photos (ordered,
 *                                            with short-lived signed URLs).
 * POST   /api/v1/profiles/me/photos        — multipart upload (max 6 photos,
 *                                            JPEG/PNG/WebP, up to 10 MB).
 * DELETE /api/v1/profiles/me/photos/{id}   — delete + re-compact ordering.
 * PUT    /api/v1/profiles/me/photos/order  — full reorder; first = primary.
 *
 * Authentication uses the existing Supabase browser session; the JWT is
 * attached as a bearer token and validated by FastAPI. Ownership is derived
 * server-side from the token — this client never sends auth_user_id or
 * profile ids, and the backend never returns storage paths, only
 * short-lived signed URLs for the private bucket.
 *
 * Backend failures arrive as `{ "error": { "code": "...", "message": "..." } }`.
 * Raw backend messages are never surfaced to users — errors are mapped to
 * concise, curated copy by code.
 */

import { apiBaseUrl } from "@/lib/env";
import { createClient } from "@/lib/supabase/client";

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

/** 6 photos per profile — mirrors the backend product limit (PRD 1–6). */
export const MAX_PHOTOS = 6;

/** 10 MB — mirrors the backend limit. Client-side checks are UX only. */
export const MAX_PHOTO_BYTES = 10 * 1024 * 1024;

const ALLOWED_MIME_TYPES = new Set(["image/jpeg", "image/png", "image/webp"]);

const ALLOWED_EXTENSIONS = [".jpg", ".jpeg", ".png", ".webp"];

export type PhotoApiErrorCode =
  | "unauthorized"
  | "not_found"
  | "invalid_file"
  | "file_too_large"
  | "photo_limit_reached"
  | "photo_not_found"
  | "invalid_photo_order"
  | "conflict"
  | "unavailable"
  | "network"
  | "unknown";

const USER_MESSAGES: Record<PhotoApiErrorCode, string> = {
  unauthorized: "You need to sign in to manage your photos.",
  not_found: "We couldn't find your profile.",
  invalid_file:
    "That file can't be used. Please choose a JPEG, PNG, or WebP image.",
  file_too_large: "That photo is too large. The maximum size is 10 MB.",
  photo_limit_reached:
    "You can have up to 6 photos. Delete one before adding another.",
  photo_not_found: "That photo no longer exists.",
  invalid_photo_order: "Your photo order couldn't be applied. Please try again.",
  conflict: "That change conflicted with another. Please try again.",
  unavailable:
    "Your photos are temporarily unavailable. Please try again in a moment.",
  network:
    "We couldn't reach the server. Check your connection and try again.",
  unknown: "Something went wrong. Please try again.",
};

export class PhotoApiError extends Error {
  readonly code: PhotoApiErrorCode;

  constructor(code: PhotoApiErrorCode) {
    super(USER_MESSAGES[code]);
    this.name = "PhotoApiError";
    this.code = code;
  }
}

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
    return USER_MESSAGES.file_too_large;
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
  return requestJson<ProfilePhoto>("/api/v1/profiles/me/photos", {
    method: "POST",
    body: formData,
  });
}

export async function deletePhoto(
  photoId: string,
): Promise<ProfilePhotoCollection> {
  return requestJson<ProfilePhotoCollection>(
    `/api/v1/profiles/me/photos/${encodeURIComponent(photoId)}`,
    { method: "DELETE" },
  );
}

export async function reorderPhotos(
  photoIds: string[],
): Promise<ProfilePhotoCollection> {
  return requestJson<ProfilePhotoCollection>("/api/v1/profiles/me/photos/order", {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ photo_ids: photoIds }),
  });
}

/**
 * Resolves the Supabase access token from the existing browser session.
 * No second auth mechanism is introduced; missing/expired sessions surface
 * as an unauthorized error and the backend re-validates every token.
 */
async function getAccessToken(): Promise<string | null> {
  const supabase = createClient();
  const { data } = await supabase.auth.getSession();
  return data.session?.access_token ?? null;
}

async function requestJson<T>(path: string, init: RequestInit): Promise<T> {
  const token = await getAccessToken();
  if (!token) {
    throw new PhotoApiError("unauthorized");
  }

  const headers = new Headers(init.headers);
  headers.set("Authorization", `Bearer ${token}`);

  let response: Response;
  try {
    response = await fetch(`${apiBaseUrl()}${path}`, { ...init, headers });
  } catch {
    throw new PhotoApiError("network");
  }

  if (!response.ok) {
    throw new PhotoApiError(
      errorCodeFor(await readBackendErrorCode(response), response.status),
    );
  }

  try {
    return (await response.json()) as T;
  } catch {
    throw new PhotoApiError("unknown");
  }
}

async function readBackendErrorCode(
  response: Response,
): Promise<string | undefined> {
  try {
    const body = (await response.json()) as {
      error?: { code?: unknown };
    };
    return typeof body?.error?.code === "string" ? body.error.code : undefined;
  } catch {
    return undefined;
  }
}

function errorCodeFor(
  backendCode: string | undefined,
  status: number,
): PhotoApiErrorCode {
  switch (backendCode) {
    case "unauthorized":
      return "unauthorized";
    case "profile_not_found":
      return "not_found";
    case "invalid_file_type":
      return "invalid_file";
    case "file_too_large":
      return "file_too_large";
    case "photo_limit_reached":
      return "photo_limit_reached";
    case "photo_not_found":
      return "photo_not_found";
    case "invalid_photo_order":
      return "invalid_photo_order";
    case "photo_upload_conflict":
      return "conflict";
    default:
      if (status === 401 || status === 403) {
        return "unauthorized";
      }
      if (status === 404) {
        return "photo_not_found";
      }
      if (status === 409) {
        return "conflict";
      }
      if (status >= 500) {
        return "unavailable";
      }
      return "unknown";
  }
}
