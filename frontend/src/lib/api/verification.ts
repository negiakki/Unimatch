/**
 * Student verification.
 *
 * POST /api/v1/verification/submit — multipart upload of the student ID
 *   document (JPEG/PNG/WebP/PDF, max 10 MB).
 * GET  /api/v1/verification/status — the caller's own verification state.
 *
 * Ownership, storage paths, and the decision are made by the backend only.
 */

import { ApiError, requestJson } from "@/lib/api/http";

export type VerificationStatus = "PENDING" | "VERIFIED" | "REJECTED";

export interface VerificationSubmission {
  id: string;
  status: VerificationStatus;
  submitted_at: string | null;
  reviewed_at: string | null;
  rejection_reason: string | null;
}

export interface VerificationState {
  verification_status: VerificationStatus | null;
  submission: VerificationSubmission | null;
}

/** 10 MB — mirrors the backend limit. Client-side checks are UX only. */
export const MAX_DOCUMENT_BYTES = 10 * 1024 * 1024;

const ALLOWED_MIME_TYPES = new Set([
  "image/jpeg",
  "image/png",
  "image/webp",
  "application/pdf",
]);

const ALLOWED_EXTENSIONS = [".jpg", ".jpeg", ".png", ".webp", ".pdf"];

const MESSAGES = {
  unauthorized: "You need to sign in before verifying your student status.",
  invalid_file:
    "That file can't be used. Please choose a JPEG, PNG, WebP, or PDF document.",
  file_too_large: "That file is too large. The maximum size is 10 MB.",
  already_verified: "Your student status is already verified.",
  pending_review: "Your verification is already awaiting review.",
  not_found: "Create your student profile before verifying your student status.",
  photo_required:
    "Add at least one profile photo before submitting your student ID.",
  unavailable:
    "Verification is temporarily unavailable. Please try again in a moment.",
} as const;

/**
 * UX-only pre-flight validation. The backend re-validates the document
 * authoritatively (size + magic bytes). Returns an error message, or null
 * when the file looks usable.
 */
export function validateVerificationDocument(file: File): string | null {
  if (file.size === 0) {
    return "That file appears to be empty. Please choose a valid document.";
  }
  if (file.size > MAX_DOCUMENT_BYTES) {
    return MESSAGES.file_too_large;
  }
  const mimeAllowed = ALLOWED_MIME_TYPES.has(file.type);
  const extensionAllowed = ALLOWED_EXTENSIONS.some((extension) =>
    file.name.toLowerCase().endsWith(extension),
  );
  if (!(file.type ? mimeAllowed : extensionAllowed)) {
    return "Unsupported file type. Please use JPEG, PNG, WebP, or PDF.";
  }
  return null;
}

export async function fetchVerificationState(): Promise<VerificationState> {
  return requestJson<VerificationState>("/api/v1/verification/status", {
    method: "GET",
  });
}

export async function submitVerificationDocument(
  file: File,
): Promise<VerificationSubmission> {
  const formData = new FormData();
  formData.append("file", file, file.name);
  return requestJson<VerificationSubmission>(
    "/api/v1/verification/submit",
    { method: "POST", body: formData },
    MESSAGES,
  );
}

export { ApiError };