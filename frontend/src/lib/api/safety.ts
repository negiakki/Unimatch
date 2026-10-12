/**
 * Blocks & reports.
 *
 * POST /api/v1/blocks — block a verified profile. Idempotent (re-blocking
 *   returns the existing block) and reversible server-side; a block is a
 *   silent visibility filter: the pair disappears from discovery, matches, and
 *   messaging in BOTH directions while it stands.
 * POST /api/v1/reports — report a user (fixed reason category + optional
 *   detail). A report writes one row and has NO automatic consequences;
 *   report contents are admin-only and the response is just the receipt.
 *
 * The reporter/blocker identity derives server-side from the token — this
 * client only ever sends the target profile id.
 */

import { ApiError, requestJson } from "@/lib/api/http";

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

export interface ReportInput {
  reported_profile_id: string;
  reason: ReportReason;
  detail?: string;
}

const MESSAGES = {
  not_verified: "Verify your student status before using safety tools.",
  not_found: "This profile is no longer available.",
  validation: "That couldn't be submitted. Please check it and try again.",
  unavailable: "That's temporarily unavailable. Please try again shortly.",
} as const;

export async function blockUser(
  profileId: string,
): Promise<{ id: string }> {
  return requestJson<{ id: string }>(
    "/api/v1/blocks",
    { method: "POST", body: JSON.stringify({ target_profile_id: profileId }) },
    MESSAGES,
  );
}

export async function reportUser(input: ReportInput): Promise<{ id: string }> {
  return requestJson<{ id: string }>(
    "/api/v1/reports",
    {
      method: "POST",
      body: JSON.stringify({
        reported_profile_id: input.reported_profile_id,
        reason: input.reason,
        ...(input.detail ? { detail: input.detail } : {}),
      }),
    },
    MESSAGES,
  );
}

export { ApiError };