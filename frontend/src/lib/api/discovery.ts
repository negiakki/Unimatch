/**
 * Person projections + contextual (opportunity-scoped) people discovery.
 *
 * GET /api/v1/opportunities/{id}/discovery — the eligible people feed for ONE
 * opportunity. There is deliberately no global profile feed: the opportunity
 * is always the context for discovering people.
 *
 * People arrive as client-safe projections: age (never the raw date of
 * birth), signed photo URLs (never storage paths), no verification status, and
 * no legacy dating fields — the backend may still send columns like
 * relationship intent, and this client simply does not model or render them.
 *
 * Authentication uses the existing Supabase browser session; the JWT is
 * attached as a bearer token and validated by FastAPI. The viewer is derived
 * server-side from the token.
 *
 * Backend failures arrive as `{ "error": { "code": "...", "message": "..." } }`;
 * `requestJson` maps them to curated copy and never leaks raw messages.
 */

import { ApiError, requestJson } from "@/lib/api/http";

export interface PersonPhoto {
  id: string;
  /** Short-lived signed URL; null when the photo couldn't be signed. */
  url: string | null;
  is_primary: boolean;
}

export interface PersonUniversity {
  id: string | null;
  name: string | null;
  city: string | null;
  state: string | null;
  country: string | null;
}

export interface PersonPrompt {
  prompt: string;
  answer: string;
}

/** A person as another student sees them, inside one opportunity's context. */
export interface Person {
  id: string;
  first_name: string | null;
  /** Derived server-side from date_of_birth — the raw date is never sent. */
  age: number | null;
  university: PersonUniversity;
  /**
   * The university to display, resolved server-side from the shared candidate
   * projection: the student's own typed name when their institution isn't in
   * the catalog, else the catalog name. `university` is always present (and
   * may be empty) so consumers read this one field instead of re-deriving it.
   */
  university_label: string;
  course: string | null;
  academic_year: number | null;
  gender: string | null;
  bio: string | null;
  hometown: string | null;
  /** "Why I'm here" — controlled motivation values. */
  motivations: string[];
  /** Merged catalog + custom interests with a source discriminator. */
  interests: { id: string; name: string; source: "catalog" | "custom" }[];
  profile_prompts: PersonPrompt[];
  photos: PersonPhoto[];
}

export interface PeoplePage {
  people: Person[];
  next_cursor: string | null;
}

/** The caller's photo, or null when the backend could not sign it. */
export function primaryPhotoUrl(person: Person): string | null {
  const signed = person.photos.filter((photo) => photo.url);
  return (signed.find((photo) => photo.is_primary) ?? signed[0])?.url ?? null;
}

const MESSAGES = {
  not_verified: "Verify your student status before finding people.",
  not_applied: "Join this opportunity first, then find your partner.",
  not_found: "This opportunity is no longer available.",
} as const;

export async function fetchOpportunityDiscovery(
  opportunityId: string,
  options?: { cursor?: string | null; limit?: number },
): Promise<PeoplePage> {
  const params = new URLSearchParams();
  if (options?.cursor) {
    params.set("cursor", options.cursor);
  }
  if (options?.limit) {
    params.set("limit", String(options.limit));
  }
  const query = params.toString();
  const page = await requestJson<{
    candidates: Person[];
    next_cursor: string | null;
  }>(
    `/api/v1/opportunities/${encodeURIComponent(opportunityId)}/discovery${
      query ? `?${query}` : ""
    }`,
    { method: "GET" },
    MESSAGES,
  );
  return { people: page.candidates ?? [], next_cursor: page.next_cursor };
}

export { ApiError };