/**
 * API client for likes, passes and matches (Phase 6).
 *
 * POST /api/v1/discovery/{profile_id}/like — record a LIKE; on a mutual like
 *   the response carries the canonical match with the matched profile.
 * POST /api/v1/discovery/{profile_id}/pass — record a PASS.
 * GET  /api/v1/matches — the caller's active matches.
 * DELETE /api/v1/matches/{match_id} — participant-only soft unmatch.
 *
 * Authentication uses the existing Supabase browser session; the JWT is
 * attached as a bearer token and validated by FastAPI. The actor is derived
 * server-side from the token — this client never sends actor ids, and the
 * target profile id comes only from the URL path. Matched profiles arrive as
 * client-safe projections (age, signed photo URLs — never date_of_birth or
 * storage paths).
 *
 * Backend failures arrive as `{ "error": { "code": "...", "message": "..." } }`.
 * Raw backend messages are never surfaced to users — errors are mapped to
 * concise, curated copy by code.
 */

import { apiBaseUrl } from "@/lib/env";
import { createClient } from "@/lib/supabase/client";
import type { DiscoveryCandidate } from "@/lib/api/discovery";

export interface MatchInfo {
  id: string;
  created_at: string | null;
  /** Client-safe matched profile — same shape as a discovery candidate. */
  profile: DiscoveryCandidate;
}

export type LikeOutcome = "like_recorded" | "matched";

export interface LikeResult {
  outcome: LikeOutcome;
  match?: MatchInfo;
}

export interface MatchEntry {
  id: string;
  created_at: string | null;
  profile: DiscoveryCandidate;
}

export type DatingApiErrorCode =
  | "unauthorized"
  | "not_verified"
  | "already_decided"
  | "not_found"
  | "validation"
  | "unavailable"
  | "network"
  | "unknown";

const USER_MESSAGES: Record<DatingApiErrorCode, string> = {
  unauthorized: "You need to sign in to do that.",
  not_verified: "You need to be verified to do that.",
  already_decided: "You've already decided on this profile.",
  not_found: "This profile is no longer available.",
  validation: "That action couldn't be completed. Please try again.",
  unavailable:
    "That action is temporarily unavailable. Please try again in a moment.",
  network: "We couldn't reach the server. Check your connection and try again.",
  unknown: "Something went wrong. Please try again.",
};

export class DatingApiError extends Error {
  readonly code: DatingApiErrorCode;

  constructor(code: DatingApiErrorCode) {
    super(USER_MESSAGES[code]);
    this.name = "DatingApiError";
    this.code = code;
  }
}

export async function likeCandidate(profileId: string): Promise<LikeResult> {
  return requestJson<LikeResult>(
    `/api/v1/discovery/${encodeURIComponent(profileId)}/like`,
    { method: "POST" },
  );
}

export async function passCandidate(profileId: string): Promise<LikeResult> {
  return requestJson<LikeResult>(
    `/api/v1/discovery/${encodeURIComponent(profileId)}/pass`,
    { method: "POST" },
  );
}

export async function fetchMatches(): Promise<{ matches: MatchEntry[] }> {
  return requestJson<{ matches: MatchEntry[] }>("/api/v1/matches", {
    method: "GET",
  });
}

export async function unmatch(
  matchId: string,
): Promise<{ id: string; unmatched_at: string | null }> {
  return requestJson<{ id: string; unmatched_at: string | null }>(
    `/api/v1/matches/${encodeURIComponent(matchId)}`,
    { method: "DELETE" },
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
    throw new DatingApiError("unauthorized");
  }

  const headers = new Headers(init.headers);
  headers.set("Authorization", `Bearer ${token}`);

  let response: Response;
  try {
    response = await fetch(`${apiBaseUrl()}${path}`, { ...init, headers });
  } catch {
    throw new DatingApiError("network");
  }

  if (!response.ok) {
    throw new DatingApiError(
      errorCodeFor(await readBackendErrorCode(response), response.status),
    );
  }

  try {
    return (await response.json()) as T;
  } catch {
    throw new DatingApiError("unknown");
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
): DatingApiErrorCode {
  switch (backendCode) {
    case "unauthorized":
      return "unauthorized";
    case "permission_denied":
      return "not_verified";
    case "already_decided":
      return "already_decided";
    case "not_found":
      return "not_found";
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
      if (status === 404) {
        return "not_found";
      }
      if (status === 409) {
        return "already_decided";
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
