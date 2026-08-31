/**
 * API client for the discovery feed endpoint.
 *
 * GET /api/v1/discovery/feed — an ordered, cursor-paginated feed of eligible
 * candidate profiles for the authenticated, VERIFIED viewer.
 *
 * Authentication uses the existing Supabase browser session; the JWT is
 * attached as a bearer token and validated by FastAPI. The viewer is derived
 * server-side from the token — this client never sends auth_user_id or
 * viewer profile ids, and the backend never returns them. Candidates arrive
 * as client-safe projections only: age (never the raw date_of_birth),
 * signed photo URLs (never storage paths), and no verification status.
 *
 * Query parameters:
 *   * `cursor` — opaque cursor from the previous page's `next_cursor`.
 *   * `limit`  — page size (1–50); omitted uses the backend default.
 *
 * Backend failures arrive as `{ "error": { "code": "...", "message": "..." } }`.
 * Raw backend messages are never surfaced to users — errors are mapped to
 * concise, curated copy by code.
 */

import { apiBaseUrl } from "@/lib/env";
import { createClient } from "@/lib/supabase/client";

export interface DiscoveryPhoto {
  id: string;
  /** Short-lived signed URL; null when the photo couldn't be signed. */
  url: string | null;
  is_primary: boolean;
}

export interface DiscoveryUniversity {
  id: string | null;
  name: string | null;
  city: string | null;
  state: string | null;
  country: string | null;
}

export interface DiscoveryPrompt {
  prompt: string;
  answer: string;
}

export interface DiscoveryCandidate {
  id: string;
  first_name: string | null;
  /** Derived server-side from date_of_birth — the raw date is never sent. */
  age: number | null;
  university: DiscoveryUniversity;
  course: string | null;
  academic_year: number | null;
  gender: string | null;
  bio: string | null;
  relationship_intent: string | null;
  height_cm: number | null;
  hometown: string | null;
  /** "Why I'm here" — controlled motivation values. */
  motivations: string[];
  /** Merged catalog + custom interests with a source discriminator. */
  interests: { id: string; name: string; source: "catalog" | "custom" }[];
  profile_prompts: DiscoveryPrompt[];
  photos: DiscoveryPhoto[];
}

export interface DiscoveryFeedPage {
  candidates: DiscoveryCandidate[];
  next_cursor: string | null;
}

export type DiscoveryApiErrorCode =
  | "unauthorized"
  | "not_verified"
  | "validation"
  | "unavailable"
  | "network"
  | "unknown";

const USER_MESSAGES: Record<DiscoveryApiErrorCode, string> = {
  unauthorized: "You need to sign in to use discovery.",
  not_verified: "You need to be verified to use discovery.",
  validation: "The discovery feed couldn't be loaded. Please try again.",
  unavailable:
    "The discovery feed is temporarily unavailable. Please try again in a moment.",
  network:
    "We couldn't reach the server. Check your connection and try again.",
  unknown: "Something went wrong. Please try again.",
};

export class DiscoveryApiError extends Error {
  readonly code: DiscoveryApiErrorCode;

  constructor(code: DiscoveryApiErrorCode) {
    super(USER_MESSAGES[code]);
    this.name = "DiscoveryApiError";
    this.code = code;
  }
}

export async function fetchDiscoveryFeed(options?: {
  cursor?: string | null;
  limit?: number;
}): Promise<DiscoveryFeedPage> {
  const params = new URLSearchParams();
  if (options?.cursor) {
    params.set("cursor", options.cursor);
  }
  if (options?.limit) {
    params.set("limit", String(options.limit));
  }
  const query = params.toString();
  return requestJson<DiscoveryFeedPage>(
    `/api/v1/discovery/feed${query ? `?${query}` : ""}`,
    { method: "GET" },
  );
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
    throw new DiscoveryApiError("unauthorized");
  }

  const headers = new Headers(init.headers);
  headers.set("Authorization", `Bearer ${token}`);

  let response: Response;
  try {
    response = await fetch(`${apiBaseUrl()}${path}`, { ...init, headers });
  } catch {
    throw new DiscoveryApiError("network");
  }

  if (!response.ok) {
    throw new DiscoveryApiError(
      errorCodeFor(await readBackendErrorCode(response), response.status),
    );
  }

  try {
    return (await response.json()) as T;
  } catch {
    throw new DiscoveryApiError("unknown");
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
): DiscoveryApiErrorCode {
  switch (backendCode) {
    case "unauthorized":
      return "unauthorized";
    case "permission_denied":
      return "not_verified";
    case "validation_error":
      return "validation";
    case "database_unavailable":
    case "service_unavailable":
      return "unavailable";
    default:
      if (status === 401) {
        return "unauthorized";
      }
      if (status === 403) {
        return "not_verified";
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
