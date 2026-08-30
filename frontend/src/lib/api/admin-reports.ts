/**
 * API client for the staff report view (Phase 8).
 *
 * GET /api/v1/admin/reports — reviewer-safe report metadata (newest first,
 * capped server-side). Read-only in v1: reports carry a processing status
 * (born OPEN) but there is deliberately no transition endpoint yet, and no
 * action is taken from this screen — reports never trigger automatic
 * consequences (admin review decides anything, outside this surface).
 *
 * Authentication uses the existing Supabase browser session; the JWT is
 * attached as a bearer token and validated by FastAPI. Authorization
 * (authenticated user -> staff_admins membership) is enforced entirely
 * server-side — this client never sends reviewer or reporter identities.
 *
 * Backend failures arrive as `{ "error": { "code": "...", "message": "..." } }`.
 * Raw backend messages are never surfaced to users — errors are mapped to
 * concise, curated copy by code.
 */

import { apiBaseUrl } from "@/lib/env";
import { createClient } from "@/lib/supabase/client";

export type AdminReportStatus = "OPEN" | "REVIEWED" | "DISMISSED";
export type AdminReportContentType = "profile" | "message" | "photo";

export interface AdminReportPerson {
  profile_id: string;
  first_name: string | null;
  course: string | null;
  academic_year: number | null;
  university: {
    name: string | null;
    city: string | null;
    state: string | null;
    country: string | null;
  } | null;
}

export interface AdminReportItem {
  id: string;
  status: AdminReportStatus;
  reason: string;
  detail: string | null;
  content_type: AdminReportContentType | null;
  content_id: string | null;
  created_at: string | null;
  reporter: AdminReportPerson;
  reported: AdminReportPerson;
}

export type AdminReportsApiErrorCode =
  | "unauthorized"
  | "permission_denied"
  | "unavailable"
  | "network"
  | "unknown";

const USER_MESSAGES: Record<AdminReportsApiErrorCode, string> = {
  unauthorized: "You need to sign in to view reports.",
  permission_denied:
    "This area is for staff reviewers only. Your account doesn't have review access.",
  unavailable:
    "Reports are temporarily unavailable. Please try again in a moment.",
  network:
    "We couldn't reach the server. Check your connection and try again.",
  unknown: "Something went wrong. Please try again.",
};

export class AdminReportsApiError extends Error {
  readonly code: AdminReportsApiErrorCode;

  constructor(code: AdminReportsApiErrorCode) {
    super(USER_MESSAGES[code]);
    this.name = "AdminReportsApiError";
    this.code = code;
  }
}

export async function fetchAdminReports(): Promise<AdminReportItem[]> {
  return requestJson<AdminReportItem[]>("/api/v1/admin/reports", {
    method: "GET",
  });
}

async function getAccessToken(): Promise<string | null> {
  const supabase = createClient();
  const { data } = await supabase.auth.getSession();
  return data.session?.access_token ?? null;
}

async function requestJson<T>(path: string, init: RequestInit): Promise<T> {
  const token = await getAccessToken();
  if (!token) {
    throw new AdminReportsApiError("unauthorized");
  }

  const headers = new Headers(init.headers);
  headers.set("Authorization", `Bearer ${token}`);

  let response: Response;
  try {
    response = await fetch(`${apiBaseUrl()}${path}`, { ...init, headers });
  } catch {
    throw new AdminReportsApiError("network");
  }

  if (!response.ok) {
    throw new AdminReportsApiError(
      errorCodeFor(await readBackendErrorCode(response), response.status),
    );
  }

  try {
    return (await response.json()) as T;
  } catch {
    throw new AdminReportsApiError("unknown");
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
): AdminReportsApiErrorCode {
  switch (backendCode) {
    case "unauthorized":
      return "unauthorized";
    case "permission_denied":
      return "permission_denied";
    case "database_unavailable":
    case "service_unavailable":
      return "unavailable";
    default:
      if (status === 401) return "unauthorized";
      if (status === 403) return "permission_denied";
      if (status >= 500) return "unavailable";
      return "unknown";
  }
}
