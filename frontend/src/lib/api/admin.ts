/**
 * Admin API client — every staff surface behind the unified /admin dashboard.
 *
 * One module for the dashboard, users, reports, blocks, suspensions, catalog,
 * and opportunities. Verification queue endpoints live in `admin-verification`
 * (unchanged, still used by the review page).
 *
 * All transport goes through the shared `requestJson` in `@/lib/api/http`:
 * base URL, Supabase bearer token, error-envelope decoding, curated copy.
 * Authorization (authenticated user -> `staff_admins`) is enforced entirely
 * server-side; this client never sends reviewer, reporter, or staff ids.
 *
 * The service-role key stays on the backend — nothing privileged is read here.
 */

import { requestJson } from "@/lib/api/http";

const ADMIN = "/api/v1/admin";

/* -------------------------------------------------------------- dashboard -- */

export interface DashboardMetrics {
  users: { total: number; verified: number };
  verification: { pending: number };
  opportunities: { total: number; published: number };
  matches: { active: number };
  reports: { total: number; open: number };
  applications: { total: number; applied: number };
  suspensions: { active: number };
}

export function fetchDashboard(): Promise<DashboardMetrics> {
  return requestJson<DashboardMetrics>(`${ADMIN}/dashboard`, { method: "GET" });
}

/* ------------------------------------------------------------------ users -- */

export type VerificationState = "PENDING" | "VERIFIED" | "REJECTED";

export interface AdminUser {
  profile_id: string;
  first_name: string | null;
  course: string | null;
  academic_year: number | null;
  gender: string | null;
  created_at: string | null;
  university: { id: string; name: string | null } | null;
  /** Set when the student typed an institution that isn't in the catalog. */
  custom_university_name: string | null;
  /** Catalog name, custom name, or a "not on file" fallback — always renderable. */
  university_label: string;
  verification: { status: VerificationState | null; submitted_at: string | null };
  account: {
    suspended: boolean;
    suspension_reason: string | null;
    suspended_until: string | null;
  };
}

export function searchUsers(query?: string): Promise<AdminUser[]> {
  const params = new URLSearchParams();
  if (query) params.set("q", query);
  const suffix = params.toString() ? `?${params}` : "";
  return requestJson<AdminUser[]>(`${ADMIN}/users${suffix}`, { method: "GET" });
}

export function fetchUser(profileId: string): Promise<AdminUser> {
  return requestJson<AdminUser>(
    `${ADMIN}/users/${encodeURIComponent(profileId)}`,
    { method: "GET" },
  );
}

export interface SuspensionInput {
  reason: string;
  /** null = indefinite. */
  suspended_until?: string | null;
}

export function suspendUser(
  profileId: string,
  input: SuspensionInput,
): Promise<AdminUser> {
  return requestJson<AdminUser>(
    `${ADMIN}/users/${encodeURIComponent(profileId)}/suspend`,
    { method: "POST", body: JSON.stringify(input) },
  );
}

/** Indefinite block — the backend ignores `suspended_until` for this path. */
export function blockUser(
  profileId: string,
  input: SuspensionInput,
): Promise<AdminUser> {
  return requestJson<AdminUser>(
    `${ADMIN}/users/${encodeURIComponent(profileId)}/block`,
    { method: "POST", body: JSON.stringify(input) },
  );
}

export function unsuspendUser(profileId: string): Promise<AdminUser> {
  return requestJson<AdminUser>(
    `${ADMIN}/users/${encodeURIComponent(profileId)}/suspension`,
    { method: "DELETE" },
  );
}

export function unblockUser(profileId: string): Promise<AdminUser> {
  return requestJson<AdminUser>(
    `${ADMIN}/users/${encodeURIComponent(profileId)}/block`,
    { method: "DELETE" },
  );
}

/* ------------------------------------------------------------ suspensions -- */

export interface Suspension {
  id: string;
  profile_id: string;
  first_name: string | null;
  reason: string;
  /** null = indefinite. */
  suspended_until: string | null;
  created_at: string | null;
}

export function listSuspensions(): Promise<Suspension[]> {
  return requestJson<Suspension[]>(`${ADMIN}/suspensions`, { method: "GET" });
}

/* ----------------------------------------------------------------- blocks -- */

export interface AdminBlock {
  id: string;
  blocker: { profile_id: string; first_name: string | null };
  blocked: { profile_id: string; first_name: string | null };
  created_at: string | null;
}

export function listBlocks(): Promise<AdminBlock[]> {
  return requestJson<AdminBlock[]>(`${ADMIN}/blocks`, { method: "GET" });
}

export function removeBlock(blockId: string): Promise<{ id: string }> {
  return requestJson<{ id: string }>(
    `${ADMIN}/blocks/${encodeURIComponent(blockId)}`,
    { method: "DELETE" },
  );
}

/* ---------------------------------------------------------------- reports -- */

export type ReportStatus = "OPEN" | "REVIEWED" | "DISMISSED";
/** `opportunity` was added with the suspensions/reports migration. */
export type ReportContentType = "profile" | "message" | "photo" | "opportunity";

export interface ReportPerson {
  profile_id: string;
  first_name: string | null;
  course: string | null;
  academic_year: number | null;
  university: { name: string | null } | null;
}

export interface AdminReport {
  id: string;
  status: ReportStatus;
  reason: string;
  detail: string | null;
  content_type: ReportContentType | null;
  content_id: string | null;
  created_at: string | null;
  reporter: ReportPerson;
  reported: ReportPerson;
  /** Present only when the report targets an opportunity. */
  opportunity?: { id: string; title: string | null } | null;
}

export function fetchAdminReports(): Promise<AdminReport[]> {
  return requestJson<AdminReport[]>(`${ADMIN}/reports`, { method: "GET" });
}

export function decideReport(
  reportId: string,
  status: ReportStatus,
): Promise<AdminReport> {
  return requestJson<AdminReport>(
    `${ADMIN}/reports/${encodeURIComponent(reportId)}/decision`,
    { method: "POST", body: JSON.stringify({ status }) },
  );
}

/* ---------------------------------------------------------------- catalog -- */

export interface AdminCategory {
  id: string;
  name: string | null;
  slug: string | null;
  icon: string | null;
  sort_order: number;
  is_active: boolean;
  activities?: AdminActivity[];
}

export interface AdminActivity {
  id: string;
  category_id: string | null;
  name: string | null;
  slug: string | null;
  sort_order: number;
  is_active: boolean;
}

export interface CategoryInput {
  name: string;
  slug?: string;
  icon?: string | null;
  sort_order?: number;
  is_active?: boolean;
}

export interface ActivityInput {
  category_id: string;
  name: string;
  slug?: string;
  sort_order?: number;
  is_active?: boolean;
}

export function fetchAdminCategories(): Promise<AdminCategory[]> {
  return requestJson<AdminCategory[]>(`${ADMIN}/categories`, { method: "GET" });
}

export function fetchAdminActivities(): Promise<AdminActivity[]> {
  return requestJson<AdminActivity[]>(`${ADMIN}/activities`, { method: "GET" });
}

export function createCategory(input: CategoryInput): Promise<AdminCategory> {
  return requestJson<AdminCategory>(`${ADMIN}/categories`, {
    method: "POST",
    body: JSON.stringify(input),
  });
}

export function updateCategory(
  categoryId: string,
  input: CategoryInput,
): Promise<AdminCategory> {
  return requestJson<AdminCategory>(
    `${ADMIN}/categories/${encodeURIComponent(categoryId)}`,
    { method: "PUT", body: JSON.stringify(input) },
  );
}

export function deleteCategory(categoryId: string): Promise<{ id: string }> {
  return requestJson<{ id: string }>(
    `${ADMIN}/categories/${encodeURIComponent(categoryId)}`,
    { method: "DELETE" },
  );
}

export function createActivity(input: ActivityInput): Promise<AdminActivity> {
  return requestJson<AdminActivity>(`${ADMIN}/activities`, {
    method: "POST",
    body: JSON.stringify(input),
  });
}

export function updateActivity(
  activityId: string,
  input: ActivityInput,
): Promise<AdminActivity> {
  return requestJson<AdminActivity>(
    `${ADMIN}/activities/${encodeURIComponent(activityId)}`,
    { method: "PUT", body: JSON.stringify(input) },
  );
}

export function deleteActivity(activityId: string): Promise<{ id: string }> {
  return requestJson<{ id: string }>(
    `${ADMIN}/activities/${encodeURIComponent(activityId)}`,
    { method: "DELETE" },
  );
}

/* ----------------------------------------------------------- opportunities -- */

export type OpportunityState =
  | "DRAFT"
  | "PUBLISHED"
  | "PAUSED"
  | "CANCELLED"
  | "EXPIRED";

/** Mirrors `OpportunityWrite` on the backend. `status` is never accepted. */
export interface OpportunityInput {
  title: string;
  category_id: string;
  activity_id?: string | null;
  description?: string;
  opportunity_date?: string | null;
  start_time?: string | null;
  end_time?: string | null;
  location?: string | null;
  cover_image_url?: string | null;
  capacity?: number | null;
  partner_requirement?: string | null;
  expiry?: string | null;
}

export interface AdminOpportunity extends OpportunityInput {
  id: string;
  status: OpportunityState;
  category?: { id: string; name: string | null } | null;
  activity?: { id: string; name: string | null } | null;
  created_at: string | null;
}

export interface OpportunityApplication {
  id: string;
  profile_id: string;
  first_name: string | null;
  status: "APPLIED" | "WITHDRAWN";
  created_at: string | null;
}

export function fetchAdminOpportunities(
  status?: OpportunityState,
): Promise<AdminOpportunity[]> {
  const suffix = status ? `?status=${encodeURIComponent(status)}` : "";
  return requestJson<AdminOpportunity[]>(
    `${ADMIN}/opportunities${suffix}`,
    { method: "GET" },
  );
}

export function createOpportunity(
  input: OpportunityInput,
): Promise<AdminOpportunity> {
  return requestJson<AdminOpportunity>(`${ADMIN}/opportunities`, {
    method: "POST",
    body: JSON.stringify(input),
  });
}

export function updateOpportunity(
  opportunityId: string,
  input: OpportunityInput,
): Promise<AdminOpportunity> {
  return requestJson<AdminOpportunity>(
    `${ADMIN}/opportunities/${encodeURIComponent(opportunityId)}`,
    { method: "PUT", body: JSON.stringify(input) },
  );
}

export function deleteOpportunity(opportunityId: string): Promise<{ id: string }> {
  return requestJson<{ id: string }>(
    `${ADMIN}/opportunities/${encodeURIComponent(opportunityId)}`,
    { method: "DELETE" },
  );
}

/** publish / pause / cancel / expire all share one transition endpoint shape. */
export function setOpportunityStatus(
  opportunityId: string,
  action: "publish" | "pause" | "cancel" | "expire",
): Promise<AdminOpportunity> {
  return requestJson<AdminOpportunity>(
    `${ADMIN}/opportunities/${encodeURIComponent(opportunityId)}/${action}`,
    { method: "POST" },
  );
}

export function fetchOpportunityApplications(
  opportunityId: string,
): Promise<OpportunityApplication[]> {
  return requestJson<OpportunityApplication[]>(
    `${ADMIN}/opportunities/${encodeURIComponent(opportunityId)}/applications`,
    { method: "GET" },
  );
}