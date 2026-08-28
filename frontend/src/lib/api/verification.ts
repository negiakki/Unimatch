/**
 * API client for the student verification endpoints.
 *
 * POST /api/v1/verification/submit — multipart upload of the student ID
 * document. GET /api/v1/verification/status — the caller's own verification
 * state. Authentication uses the existing Supabase browser session; the JWT
 * is attached as a bearer token and validated by FastAPI. Ownership, storage
 * paths, and submission status are decided by the backend only.
 *
 * Backend failures arrive as `{ "error": { "code": "...", "message": "..." } }`.
 * Raw backend messages are never surfaced to users — errors are mapped to
 * concise, curated copy by code.
 */

import { apiBaseUrl } from "@/lib/env";
import { createClient } from "@/lib/supabase/client";

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

export type VerificationErrorCode =
  | "unauthorized"
  | "invalid_file"
  | "file_too_large"
  | "already_verified"
  | "pending_submission_exists"
  | "profile_not_found"
  | "unavailable"
  | "network"
  | "unknown";

const USER_MESSAGES: Record<VerificationErrorCode, string> = {
  unauthorized: "You need to sign in before verifying your student status.",
  invalid_file:
    "That file can't be used. Please choose a JPEG, PNG, WebP, or PDF document.",
  file_too_large: "That file is too large. The maximum size is 10 MB.",
  already_verified: "Your student status is already verified.",
  pending_submission_exists: "Your verification is already awaiting review.",
  profile_not_found:
    "Create your student profile before verifying your student status.",
  unavailable:
    "Verification is temporarily unavailable. Please try again in a moment.",
  network:
    "We couldn't reach the server. Check your connection and try again.",
  unknown: "Something went wrong. Please try again.",
};

export class VerificationApiError extends Error {
  readonly code: VerificationErrorCode;

  constructor(code: VerificationErrorCode) {
    super(USER_MESSAGES[code]);
    this.name = "VerificationApiError";
    this.code = code;
  }
}

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
    return USER_MESSAGES.file_too_large;
  }
  const mimeAllowed = ALLOWED_MIME_TYPES.has(file.type);
  const extensionAllowed = ALLOWED_EXTENSIONS.some((extension) =>
    file.name.toLowerCase().endsWith(extension),
  );
  const typeAllowed = file.type ? mimeAllowed : extensionAllowed;
  if (!typeAllowed) {
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
  return requestJson<VerificationSubmission>("/api/v1/verification/submit", {
    method: "POST",
    body: formData,
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
    throw new VerificationApiError("unauthorized");
  }

  const headers = new Headers(init.headers);
  headers.set("Authorization", `Bearer ${token}`);

  let response: Response;
  try {
    response = await fetch(`${apiBaseUrl()}${path}`, { ...init, headers });
  } catch {
    throw new VerificationApiError("network");
  }

  if (!response.ok) {
    throw new VerificationApiError(
      errorCodeFor(await readBackendErrorCode(response), response.status),
    );
  }

  try {
    return (await response.json()) as T;
  } catch {
    throw new VerificationApiError("unknown");
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
): VerificationErrorCode {
  switch (backendCode) {
    case "unauthorized":
      return "unauthorized";
    case "file_too_large":
      return "file_too_large";
    case "invalid_file_type":
      return "invalid_file";
    case "already_verified":
      return "already_verified";
    case "pending_submission_exists":
      return "pending_submission_exists";
    case "profile_not_found":
      return "profile_not_found";
    default:
      if (status === 401 || status === 403) {
        return "unauthorized";
      }
      if (status >= 500) {
        return "unavailable";
      }
      return "unknown";
  }
}
