/**
 * API client for blocks & reports (Phase 8).
 *
 * POST /api/v1/blocks — block a verified profile. Idempotent (re-blocking
 *   returns the existing block) and reversible server-side via
 *   DELETE /api/v1/blocks/{profile_id}; the unblock and block-list endpoints
 *   exist in the API but have no v1 UI. A block is a silent visibility
 *   filter: the pair disappears from discovery, matches, and messaging in
 *   BOTH directions while it stands, and everything is restored on unblock.
 * POST /api/v1/reports — report a user (fixed reason category + optional
 *   detail). A report writes one row and has NO automatic consequences;
 *   report contents are admin-only and the response is just the receipt.
 *
 * Authentication uses the existing Supabase browser session; the JWT is
 * attached as a bearer token and validated by FastAPI. The reporter/blocker
 * identity derives server-side from the token — this client only ever sends
 * the target profile id.
 *
 * Backend failures arrive as `{ "error": { "code": "...", "message": "..." } }`.
 * Raw backend messages are never surfaced to users — errors are mapped to
 * concise, curated copy by code.
 */

import { apiBaseUrl } from "@/lib/env";
import { createClient } from "@/lib/supabase/client";

export type ReportReason =
  | "harassment"
  | "inappropriate_content"
  | "fake_profile"
  | "underage"
  | "spam"
  | "other";

export const MAX_REPORT_DETAIL_LENGTH = 1000;

export const REPORT_REASON_OPTIONS: { value: ReportReason; label: string }[] = [
  { value: "harassment", label: "Harassment or bullying" },
  { value: "inappropriate_content", label: "Inappropriate content" },
  { value: "fake_profile", label: "Fake profile" },
  { value: "underage", label: "Under 18" },
  { value: "spam", label: "Spam or scam" },
  { value: "other", label: "Something else" },
];

export interface BlockResult {
  id: string;
  blocker_profile_id: string;
  blocked_profile_id: string;
  created_at: string | null;
}

export interface ReportResult {
  id: string;
  status: string;
  created_at: string | null;
}

export interface ReportInput {
  reported_profile_id: string;
  reason: ReportReason;
  detail?: string;
}

export type SafetyApiErrorCode =
  | "unauthorized"
  | "not_verified"
  | "not_found"
  | "validation"
  | "unavailable"
  | "network"
  | "unknown";

const USER_MESSAGES: Record<SafetyApiErrorCode, string> = {
  unauthorized: "You need to sign in to do that.",
  not_verified: "You need to be verified to do that.",
  not_found: "This profile is no longer available.",
  validation: "That couldn't be submitted. Please check it and try again.",
  unavailable:
    "That action is temporarily unavailable. Please try again in a moment.",
  network: "We couldn't reach the server. Check your connection and try again.",
  unknown: "Something went wrong. Please try again.",
};

export class SafetyApiError extends Error {
  readonly code: SafetyApiErrorCode;

  constructor(code: SafetyApiErrorCode) {
    super(USER_MESSAGES[code]);
    this.name = "SafetyApiError";
    this.code = code;
  }
}

export async function blockUser(profileId: string): Promise<BlockResult> {
  return requestJson<BlockResult>("/api/v1/blocks", {
    method: "POST",
    body: JSON.stringify({ target_profile_id: profileId }),
  });
}

export async function reportUser(input: ReportInput): Promise<ReportResult> {
  return requestJson<ReportResult>("/api/v1/reports", {
    method: "POST",
    body: JSON.stringify({
      reported_profile_id: input.reported_profile_id,
      reason: input.reason,
      ...(input.detail ? { detail: input.detail } : {}),
    }),
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
    throw new SafetyApiError("unauthorized");
  }

  const headers = new Headers(init.headers);
  headers.set("Authorization", `Bearer ${token}`);
  if (init.body) {
    headers.set("Content-Type", "application/json");
  }

  let response: Response;
  try {
    response = await fetch(`${apiBaseUrl()}${path}`, { ...init, headers });
  } catch {
    throw new SafetyApiError("network");
  }

  if (!response.ok) {
    throw new SafetyApiError(
      errorCodeFor(await readBackendErrorCode(response), response.status),
    );
  }

  try {
    return (await response.json()) as T;
  } catch {
    throw new SafetyApiError("unknown");
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
): SafetyApiErrorCode {
  switch (backendCode) {
    case "unauthorized":
      return "unauthorized";
    case "permission_denied":
      return "not_verified";
    case "not_found":
      return "not_found";
    case "validation_error":
      return "validation";
    case "database_unavailable":
    case "database_insert_failed":
    case "database_delete_failed":
    case "service_unavailable":
      return "unavailable";
    default:
      if (status === 401) {
        return "unauthorized";
      }
      if (status === 403) {
        return "not_verified";
      }
      if (status === 404) {
        return "not_found";
      }
      if (status === 422) {
        return "validation";
      }
      if (status >= 500) {
        return "unavailable";
      }
      return "unknown";
  }
}
