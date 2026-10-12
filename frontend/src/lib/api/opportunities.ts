/**
 * Opportunities, participation, and opportunity-scoped actions.
 *
 * GET  /api/v1/opportunities                  — browse PUBLISHED opportunities
 * GET  /api/v1/opportunities/{id}             — one opportunity's detail
 * POST /api/v1/opportunities/{id}/applications  — join (needs VERIFIED)
 * GET  /api/v1/applications                   — "My activity"
 * POST /api/v1/applications/{id}/withdraw     — leave
 * POST /api/v1/opportunities/{id}/discovery/{profile_id}/interest — interested
 * POST /api/v1/opportunities/{id}/discovery/{profile_id}/pass — pass
 *
 * Opportunities are created by admins only; there is no user-facing create
 * path. Every action and every match carries an opportunity id, so the same
 * two people can connect independently through different opportunities.
 *
 * The list/detail reads are public, so no session is required for them.
 */

import { ApiError, requestJson } from "@/lib/api/http";

export interface OpportunityCategory {
  id: string;
  name: string | null;
  slug: string | null;
  icon: string | null;
}

export interface OpportunityActivity {
  id: string;
  name: string | null;
  slug: string | null;
}

/** The slice of an opportunity carried by matches and conversations. */
export interface OpportunityContext {
  id: string;
  title: string | null;
  category?: OpportunityCategory | null;
  activity?: OpportunityActivity | null;
  opportunity_date?: string | null;
  location?: string | null;
}

export interface Opportunity extends OpportunityContext {
  description: string | null;
  start_time: string | null;
  end_time: string | null;
  cover_image_url: string | null;
  capacity: number | null;
  /** Free-text note about what kind of partner this needs. */
  partner_requirement: string | null;
  status: string;
  created_at: string | null;
}

export type ApplicationStatus = "APPLIED" | "WITHDRAWN";

export interface Application {
  id: string;
  status: ApplicationStatus;
  created_at: string | null;
  opportunity: Opportunity;
}

export function isJoined(application: Application): boolean {
  return application.status === "APPLIED";
}

const MESSAGES = {
  already_applied: "You're already going to this.",
  not_verified: "Verify your student status before joining an opportunity.",
  not_found: "This opportunity is no longer available.",
  validation: "That couldn't be completed. Please try again.",
} as const;

export async function fetchOpportunities(filters?: {
  categoryId?: string | null;
  activityId?: string | null;
}): Promise<Opportunity[]> {
  const params = new URLSearchParams();
  if (filters?.categoryId) {
    params.set("category_id", filters.categoryId);
  }
  if (filters?.activityId) {
    params.set("activity_id", filters.activityId);
  }
  const query = params.toString();
  return (
    (await requestJson<Opportunity[]>(
      `/api/v1/opportunities${query ? `?${query}` : ""}`,
      { method: "GET" },
      MESSAGES,
    )) ?? []
  );
}

export async function fetchOpportunity(id: string): Promise<Opportunity> {
  return requestJson<Opportunity>(
    `/api/v1/opportunities/${encodeURIComponent(id)}`,
    { method: "GET" },
    MESSAGES,
  );
}

export async function joinOpportunity(id: string): Promise<Application> {
  return requestJson<Application>(
    `/api/v1/opportunities/${encodeURIComponent(id)}/applications`,
    { method: "POST" },
    MESSAGES,
  );
}

export async function fetchMyApplications(): Promise<Application[]> {
  const page = await requestJson<{ applications: Application[] }>(
    "/api/v1/applications",
    { method: "GET" },
    MESSAGES,
  );
  return page.applications ?? [];
}

export async function withdrawApplication(
  applicationId: string,
): Promise<Pick<Application, "id" | "status" | "created_at">> {
  return requestJson(`/api/v1/applications/${encodeURIComponent(applicationId)}/withdraw`, {
    method: "POST",
  });
}

export { ApiError };