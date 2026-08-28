/**
 * API client for the reviewer/admin verification endpoints.
 *
 * GET /api/v1/admin/verifications — the PENDING review queue (metadata only).
 * GET /api/v1/admin/verifications/{id}/document-url — a short-lived signed
 * URL for the private ID document, generated server-side.
 * POST /api/v1/admin/verifications/{id}/decision — record a VERIFIED or
 * REJECTED decision.
 *
 * Authentication uses the existing Supabase browser session; the JWT is
 * attached as a bearer token and validated by FastAPI. Authorization
 * (authenticated user -> staff_admins membership) is enforced entirely
 * server-side — this client never sends reviewer_id, auth_user_id, or
 * storage_path, and never constructs Storage URLs.
 *
 * Backend failures arrive as `{ "error": { "code": "...", "message": "..." } }`.
 * Raw backend messages are never surfaced to users — errors are mapped to
 * concise, curated copy by code.
 */

import { apiBaseUrl } from "@/lib/env";
import { createClient } from "@/lib/supabase/client";

export type AdminVerificationStatus = "PENDING" | "VERIFIED" | "REJECTED";
export type AdminDecisionStatus = "VERIFIED" | "REJECTED";

export interface AdminUniversity {
  name: string | null;
  city: string | null;
  state: string | null;
  country: string | null;
}

export interface AdminStudent {
  first_name: string | null;
  date_of_birth: string | null;
  course: string | null;
  academic_year: number | null;
  university: AdminUniversity;
}

export interface AdminVerificationItem {
  id: string;
  profile_id: string;
  status: AdminVerificationStatus;
  submitted_at: string | null;
  student: AdminStudent;
}

export interface AdminDocumentUrl {
  url: string;
  expires_in: number;
}

export interface AdminDecisionResult {
  id: string;
  profile_id: string;
  status: AdminVerificationStatus;
  submitted_at: string | null;
  reviewed_at: string | null;
  rejection_reason: string | null;
}

export type AdminDecisionPayload =
  | { status: "VERIFIED" }
  | { status: "REJECTED"; rejection_reason: string };

export type AdminApiErrorCode =
  | "unauthorized"
  | "permission_denied"
  | "not_found"
  | "already_decided"
  | "validation"
  | "unavailable"
  | "network"
  | "unknown";

const USER_MESSAGES: Record<AdminApiErrorCode, string> = {
  unauthorized: "You need to sign in to review verification submissions.",
  permission_denied:
    "This area is for staff reviewers only. Your account doesn't have review access.",
  not_found: "This verification submission no longer exists.",
  already_decided:
    "This submission has already been decided, so no further decision is possible.",
  validation:
    "That decision couldn't be submitted. Check the rejection reason and try again.",
  unavailable:
    "Review is temporarily unavailable. Please try again in a moment.",
  network:
    "We couldn't reach the server. Check your connection and try again.",
  unknown: "Something went wrong. Please try again.",
};

export class AdminApiError extends Error {
  readonly code: AdminApiErrorCode;

  constructor(code: AdminApiErrorCode) {
    super(USER_MESSAGES[code]);
    this.name = "AdminApiError";
    this.code = code;
  }

  /** True when the caller should reload the queue (item no longer valid). */
  get isStale(): boolean {
    return this.code === "already_decided" || this.code === "not_found";
  }
}

export const MAX_REJECTION_REASON_LENGTH = 500;

export function validateRejectionReason(reason: string): string | null {
  const trimmed = reason.trim();
  if (!trimmed) {
    return "Enter a reason for rejecting this submission.";
  }
  if (trimmed.length > MAX_REJECTION_REASON_LENGTH) {
    return `The rejection reason must be 500 characters or fewer (currently ${trimmed.length}).`;
  }
  return null;
}

export async function fetchVerificationQueue(
  status: AdminVerificationStatus = "PENDING",
): Promise<AdminVerificationItem[]> {
  return requestJson<AdminVerificationItem[]>(
    `/api/v1/admin/verifications?status=${encodeURIComponent(status)}`,
    { method: "GET" },
  );
}

export async function fetchVerificationDocumentUrl(
  verificationId: string,
): Promise<AdminDocumentUrl> {
  return requestJson<AdminDocumentUrl>(
    `/api/v1/admin/verifications/${encodeURIComponent(verificationId)}/document-url`,
    { method: "GET" },
  );
}

export async function submitVerificationDecision(
  verificationId: string,
  payload: AdminDecisionPayload,
): Promise<AdminDecisionResult> {
  return requestJson<AdminDecisionResult>(
    `/api/v1/admin/verifications/${encodeURIComponent(verificationId)}/decision`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    },
  );
}

async function getAccessToken(): Promise<string | null> {
  const supabase = createClient();
  const { data } = await supabase.auth.getSession();
  return data.session?.access_token ?? null;
}

async function requestJson<T>(path: string, init: RequestInit): Promise<T> {
  const token = await getAccessToken();
  if (!token) {
    throw new AdminApiError("unauthorized");
  }

  const headers = new Headers(init.headers);
  headers.set("Authorization", `Bearer ${token}`);

  let response: Response;
  try {
    response = await fetch(`${apiBaseUrl()}${path}`, { ...init, headers });
  } catch {
    throw new AdminApiError("network");
  }

  if (!response.ok) {
    throw new AdminApiError(
      errorCodeFor(await readBackendErrorCode(response), response.status),
    );
  }

  try {
    return (await response.json()) as T;
  } catch {
    throw new AdminApiError("unknown");
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
): AdminApiErrorCode {
  switch (backendCode) {
    case "unauthorized":
      return "unauthorized";
    case "permission_denied":
      return "permission_denied";
    case "verification_not_found":
      return "not_found";
    case "invalid_state_transition":
      return "already_decided";
    case "invalid_rejection_reason":
    case "validation_error":
      return "validation";
    case "database_unavailable":
    case "document_unavailable":
    case "storage_signing_failed":
    case "database_update_failed":
      return "unavailable";
    default:
      if (status === 401) return "unauthorized";
      if (status === 403) return "permission_denied";
      if (status === 404) return "not_found";
      if (status === 409) return "already_decided";
      if (status === 422) return "validation";
      if (status >= 500) return "unavailable";
      return "unknown";
  }
}