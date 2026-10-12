/**
 * Interest catalog (public reference data).
 *
 * GET /api/v1/interests — the read-only shared interest catalog used by the
 * profile forms (onboarding selection and later edits). Reference data: this
 * client can only list it — creating or modifying entries is impossible over
 * this surface.
 */

import { ApiError, requestJson } from "@/lib/api/http";

export interface Interest {
  id: string;
  name: string;
}

/** Max interests per profile — mirrors the backend product limit. */
export const MAX_INTERESTS = 8;

const MESSAGES = {
  unauthorized: "You need to sign in to see interests.",
  unavailable: "Interests are temporarily unavailable. Please try again shortly.",
} as const;

export async function fetchInterests(): Promise<Interest[]> {
  return (
    (await requestJson<Interest[]>("/api/v1/interests", { method: "GET" }, MESSAGES)) ?? []
  );
}

export { ApiError };