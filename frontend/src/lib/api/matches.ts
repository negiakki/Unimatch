/**
 * Opportunity-scoped actions and contextual matches.
 *
 * POST /api/v1/opportunities/{id}/discovery/{profile_id}/interest — interested;
 *   a mutual interest in the SAME opportunity returns the contextual match.
 * POST /api/v1/opportunities/{id}/discovery/{profile_id}/pass — pass.
 * GET  /api/v1/matches — the caller's active matches, each with the
 *   opportunity it belongs to (this is *why* two people matched).
 * DELETE /api/v1/matches/{match_id} — participant-only soft unmatch.
 *
 * Nothing here is a global swipe feed: every action is scoped to one
 * opportunity, and the same pair can match independently through different
 * opportunities.
 */

import { ApiError, requestJson } from "@/lib/api/http";
import type { Person } from "@/lib/api/discovery";
import type { OpportunityContext } from "@/lib/api/opportunities";

export interface ContextualMatch {
  id: string;
  created_at: string | null;
  /** True once the 24h messaging window has lapsed; the match stays listed. */
  chat_expired: boolean;
  /** The opportunity this match belongs to — present for V1 matches. */
  opportunity?: OpportunityContext | null;
  profile: Person;
}

export type InterestOutcome = "interest_recorded" | "matched";

export interface InterestResult {
  outcome: InterestOutcome;
  match?: ContextualMatch;
}

const MESSAGES = {
  not_verified: "Verify your student status before finding people.",
  not_applied: "Join this opportunity first, then find your partner.",
  not_found: "This opportunity is no longer available.",
  validation: "That couldn't be completed. Please try again.",
} as const;

export async function showInterest(
  opportunityId: string,
  profileId: string,
): Promise<InterestResult> {
  return requestJson<InterestResult>(
    `/api/v1/opportunities/${encodeURIComponent(opportunityId)}/discovery/${encodeURIComponent(profileId)}/interest`,
    { method: "POST" },
    MESSAGES,
  );
}

export async function passOn(
  opportunityId: string,
  profileId: string,
): Promise<{ outcome: "pass_recorded" }> {
  return requestJson<{ outcome: "pass_recorded" }>(
    `/api/v1/opportunities/${encodeURIComponent(opportunityId)}/discovery/${encodeURIComponent(profileId)}/pass`,
    { method: "POST" },
    MESSAGES,
  );
}

export async function fetchMatches(): Promise<ContextualMatch[]> {
  const page = await requestJson<{ matches: ContextualMatch[] }>(
    "/api/v1/matches",
    { method: "GET" },
    MESSAGES,
  );
  return page.matches ?? [];
}

export async function unmatch(
  matchId: string,
): Promise<{ id: string; unmatched_at: string | null }> {
  return requestJson(
    `/api/v1/matches/${encodeURIComponent(matchId)}`,
    { method: "DELETE" },
    MESSAGES,
  );
}

export { ApiError };