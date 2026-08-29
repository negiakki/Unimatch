/**
 * API client for the interest catalog endpoint.
 *
 * GET /api/v1/interests — the read-only shared interest catalog used by the
 * profile forms (onboarding selection and later edits). Authentication uses
 * the existing Supabase browser session; the JWT is attached as a bearer
 * token and validated by FastAPI. The catalog is reference data: this client
 * can only list it — creating or modifying entries is impossible over this
 * surface.
 *
 * Backend failures arrive as `{ "error": { "code": "...", "message": "..." } }`.
 * Raw backend messages are never surfaced to users — errors are mapped to
 * concise, curated copy by code.
 */

import { apiBaseUrl } from "@/lib/env";
import { createClient } from "@/lib/supabase/client";

export interface Interest {
  id: string;
  name: string;
}

/** Max interests per profile — mirrors the backend product limit (PRD). */
export const MAX_INTERESTS = 8;

export type InterestApiErrorCode =
  | "unauthorized"
  | "unavailable"
  | "network"
  | "unknown";

const USER_MESSAGES: Record<InterestApiErrorCode, string> = {
  unauthorized: "You need to sign in to see interests.",
  unavailable:
    "Interests are temporarily unavailable. Please try again in a moment.",
  network:
    "We couldn't reach the server. Check your connection and try again.",
  unknown: "Something went wrong. Please try again.",
};

export class InterestsApiError extends Error {
  readonly code: InterestApiErrorCode;

  constructor(code: InterestApiErrorCode) {
    super(USER_MESSAGES[code]);
    this.name = "InterestsApiError";
    this.code = code;
  }
}

export async function fetchInterests(): Promise<Interest[]> {
  return requestJson<Interest[]>("/api/v1/interests", { method: "GET" });
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
    throw new InterestsApiError("unauthorized");
  }

  const headers = new Headers(init.headers);
  headers.set("Authorization", `Bearer ${token}`);

  let response: Response;
  try {
    response = await fetch(`${apiBaseUrl()}${path}`, { ...init, headers });
  } catch {
    throw new InterestsApiError("network");
  }

  if (!response.ok) {
    throw new InterestsApiError(
      errorCodeFor(await readBackendErrorCode(response), response.status),
    );
  }

  try {
    return (await response.json()) as T;
  } catch {
    throw new InterestsApiError("unknown");
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
): InterestApiErrorCode {
  switch (backendCode) {
    case "unauthorized":
      return "unauthorized";
    case "database_unavailable":
      return "unavailable";
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
