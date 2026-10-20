/**
 * Shared HTTP plumbing for every backend API client.
 *
 * One place for: base URL, bearer-token attachment, backend error-envelope
 * decoding, and the curated code → user-copy mapping. Raw backend messages are
 * never surfaced to users.
 *
 * Token resolution reuses the existing Supabase browser session; when there is
 * no session the request still goes out (the public catalog/opportunity reads
 * need no auth) and protected endpoints answer 401 → `unauthorized`, which
 * callers already treat as "send the user to /login".
 *
 * Backend failures arrive as `{ "error": { "code": "...", "message": "..." } }`.
 */

import { apiBaseUrl } from "@/lib/env";
import { createClient } from "@/lib/supabase/client";

export type ApiErrorCode =
  | "unauthorized"
  | "not_verified"
  | "suspended"
  | "not_applied"
  | "already_decided"
  | "already_applied"
  | "not_found"
  | "validation"
  | "unavailable"
  | "network"
  | "unknown"
  // uploads & verification
  | "invalid_file"
  | "file_too_large"
  | "limit_reached"
  | "conflict"
  | "already_verified"
  | "pending_review"
  | "photo_required";

/**
 * Default copy per code. Clients pass a partial override map when their
 * surface wants different wording; anything unlisted falls back to this.
 */
const DEFAULT_MESSAGES: Record<ApiErrorCode, string> = {
  unauthorized: "You need to sign in to do that.",
  not_verified: "You need to be verified to do that.",
  suspended: "Your account is temporarily unavailable.",
  not_applied: "Join this opportunity first to find people here.",
  already_decided: "You've already decided on this person.",
  already_applied: "You're already going to this.",
  not_found: "That's no longer available.",
  validation: "That couldn't be completed. Please check it and try again.",
  unavailable: "That's temporarily unavailable. Please try again in a moment.",
  network: "We couldn't reach the server. Check your connection and try again.",
  unknown: "Something went wrong. Please try again.",
  invalid_file: "That file can't be used. Please choose a JPEG, PNG, WebP, or PDF.",
  file_too_large: "That file is too large. The maximum size is 10 MB.",
  limit_reached: "You've hit the limit — remove one before adding another.",
  conflict: "That change conflicted with another. Please try again.",
  already_verified: "Your student status is already verified.",
  pending_review: "Your verification is already awaiting review.",
  photo_required: "Add at least one profile photo first.",
};

export class ApiError extends Error {
  readonly code: ApiErrorCode;

  constructor(code: ApiErrorCode, messages?: Partial<Record<ApiErrorCode, string>>) {
    super(messages?.[code] ?? DEFAULT_MESSAGES[code]);
    this.name = "ApiError";
    this.code = code;
  }
}

/** True for the "you need to sign in" case every page redirects on. */
export function isUnauthorized(error: unknown): boolean {
  return error instanceof ApiError && error.code === "unauthorized";
}

/** Narrows an unknown caught value to a coded API failure. */
export function isApiError(error: unknown): error is ApiError {
  return error instanceof ApiError;
}

/** True when the backend refused the session because the account is suspended. */
export function isSuspended(error: unknown): boolean {
  return error instanceof ApiError && error.code === "suspended";
}

/** True when the conversation (or other resource) is gone for this caller. */
export function isNotFound(error: unknown): boolean {
  return error instanceof ApiError && error.code === "not_found";
}

/**
 * Fetch JSON from the backend with the Supabase bearer token attached.
 *
 * `messages` supplies per-surface curated copy for the codes that read
 * differently in different places (e.g. "You're already going to this").
 */
export async function requestJson<T>(
  path: string,
  init: RequestInit = {},
  messages?: Partial<Record<ApiErrorCode, string>>,
): Promise<T> {
  const headers = new Headers(init.headers);
  // FormData must keep the browser's own `multipart/form-data; boundary=…`;
  // setting a Content-Type here would strip the boundary and FastAPI could not
  // parse the upload. Everything else defaults to JSON.
  if (
    init.body &&
    !(init.body instanceof FormData) &&
    !headers.has("Content-Type")
  ) {
    headers.set("Content-Type", "application/json");
  }

  try {
    const token = await accessToken();
    if (token) {
      headers.set("Authorization", `Bearer ${token}`);
    }

    const response = await fetch(`${apiBaseUrl()}${path}`, { ...init, headers });
    if (!response.ok) {
      throw new ApiError(
        codeFor(await readErrorCode(response), response.status),
        messages,
      );
    }
    try {
      return (await response.json()) as T;
    } catch {
      throw new ApiError("unknown", messages);
    }
  } catch (error) {
    if (error instanceof ApiError) {
      throw error;
    }
    throw new ApiError("network", messages);
  }
}

async function accessToken(): Promise<string | null> {
  // Server Components have no browser session; the public catalog/opportunity
  // reads work fine unauthenticated.
  if (typeof window === "undefined") {
    return null;
  }
  try {
    const { data } = await createClient().auth.getSession();
    return data.session?.access_token ?? null;
  } catch {
    // A signed-out or unreachable Supabase is not fatal here: protected
    // endpoints answer 401 and the page redirects to sign-in.
    return null;
  }
}

async function readErrorCode(response: Response): Promise<string | undefined> {
  try {
    const body = (await response.json()) as { error?: { code?: unknown } };
    return typeof body?.error?.code === "string" ? body.error.code : undefined;
  } catch {
    return undefined;
  }
}

function codeFor(backendCode: string | undefined, status: number): ApiErrorCode {
  switch (backendCode) {
    case "unauthorized":
      return "unauthorized";
    case "account_suspended":
      return "suspended";
    case "profile_not_found":
    case "not_found":
      return "not_found";
    case "already_applied":
      return "already_applied";
    case "already_decided":
      return "already_decided";
    case "not_applied":
      return "not_applied";
    case "invalid_file_type":
      return "invalid_file";
    case "file_too_large":
      return "file_too_large";
    case "photo_limit_reached":
      return "limit_reached";
    case "already_verified":
      return "already_verified";
    case "photo_required":
      return "photo_required";
    case "pending_submission_exists":
      return "pending_review";
    case "validation_error":
      return "validation";
    case "database_unavailable":
    case "database_insert_failed":
    case "database_update_failed":
    case "database_delete_failed":
    case "service_unavailable":
    case "database_write_failed":
      return "unavailable";
    default:
      break;
  }
  // 403 is either "not verified" or "not a participant of this opportunity";
  // the backend codes those precisely, so an uncoded 403 stays a 403.
  if (status === 401) return "unauthorized";
  if (status === 403) return "not_verified";
  if (status === 404) return "not_found";
  if (status === 409) return "conflict";
  if (status === 422) return "validation";
  if (status >= 500) return "unavailable";
  return "unknown";
}