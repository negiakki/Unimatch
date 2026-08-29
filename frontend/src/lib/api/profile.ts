/**
 * API client for the profile endpoints.
 *
 * GET  /api/v1/profiles/me — the caller's own profile.
 * POST /api/v1/profiles/me — create it (one profile per account).
 * PUT  /api/v1/profiles/me — update the editable fields.
 * GET  /api/v1/universities — read-only catalog for the profile forms.
 *
 * Authentication uses the existing Supabase browser session; the JWT is
 * attached as a bearer token and validated by FastAPI. Ownership is derived
 * server-side from the token — this client never sends auth_user_id, profile
 * ids, or any ownership field, and the backend never returns them.
 *
 * Backend failures arrive as `{ "error": { "code": "...", "message": "..." } }`.
 * Raw backend messages are never surfaced to users — errors are mapped to
 * concise, curated copy by code.
 */

import { apiBaseUrl } from "@/lib/env";
import { createClient } from "@/lib/supabase/client";

export type ProfileGender = "woman" | "man" | "non_binary" | "other";
export type ProfileSeekingGender = "women" | "men" | "everyone";
export type ProfileRelationshipIntent =
  | "casual"
  | "serious"
  | "friendship"
  | "not_sure";

export interface University {
  id: string;
  name: string;
  city: string;
  state: string | null;
  country: string;
}

export interface Profile {
  id: string;
  first_name: string;
  date_of_birth: string;
  university_id: string;
  course: string;
  academic_year: number;
  gender: ProfileGender;
  seeking_gender: ProfileSeekingGender;
  bio: string;
  relationship_intent: ProfileRelationshipIntent | null;
  height_cm: number | null;
  hometown: string | null;
  profile_prompts: unknown[];
  social_links: Record<string, unknown>;
  created_at: string;
  updated_at: string;
}

/** Payload for POST/PUT /profiles/me — no auth_user_id, ever. */
export interface ProfileInput {
  first_name: string;
  date_of_birth: string;
  university_id: string;
  course: string;
  academic_year: number;
  gender: ProfileGender;
  seeking_gender: ProfileSeekingGender;
  bio: string;
  relationship_intent: ProfileRelationshipIntent | null;
  height_cm: number | null;
  hometown: string | null;
}

/** Raw form values as typed into the controls (heights etc. stay strings). */
export interface ProfileFormValues {
  first_name: string;
  date_of_birth: string;
  university_id: string;
  course: string;
  academic_year: string;
  gender: string;
  seeking_gender: string;
  bio: string;
  relationship_intent: string;
  height_cm: string;
  hometown: string;
}

export type ProfileFieldKey =
  | "first_name"
  | "date_of_birth"
  | "university_id"
  | "course"
  | "academic_year"
  | "gender"
  | "seeking_gender"
  | "bio"
  | "height_cm"
  | "hometown";

export type ProfileFieldErrors = Partial<Record<ProfileFieldKey, string>>;

export type ProfileApiErrorCode =
  | "unauthorized"
  | "not_found"
  | "already_exists"
  | "validation"
  | "unavailable"
  | "network"
  | "unknown";

const USER_MESSAGES: Record<ProfileApiErrorCode, string> = {
  unauthorized: "You need to sign in to manage your profile.",
  not_found: "We couldn't find your profile.",
  already_exists: "A profile already exists for this account.",
  validation: "Some profile details aren't valid. Please review and try again.",
  unavailable:
    "Your profile is temporarily unavailable. Please try again in a moment.",
  network:
    "We couldn't reach the server. Check your connection and try again.",
  unknown: "Something went wrong. Please try again.",
};

export class ProfileApiError extends Error {
  readonly code: ProfileApiErrorCode;

  constructor(code: ProfileApiErrorCode) {
    super(USER_MESSAGES[code]);
    this.name = "ProfileApiError";
    this.code = code;
  }
}

// ---------------------------------------------------------------------------
// UX-only validation. The backend re-validates authoritatively (mirroring the
// database constraints); client checks exist purely for fast feedback.
// ---------------------------------------------------------------------------

const MIN_BIRTH_DATE = "1900-01-01";

function eighteenthBirthdayCutoff(today: Date): Date {
  const cutoff = new Date(today.getFullYear(), today.getMonth(), today.getDate());
  cutoff.setFullYear(cutoff.getFullYear() - 18);
  return cutoff;
}

function isValidIsoDate(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    return false;
  }
  const parsed = new Date(`${value}T00:00:00`);
  return !Number.isNaN(parsed.getTime());
}

export function validateProfileForm(values: ProfileFormValues): ProfileFieldErrors {
  const errors: ProfileFieldErrors = {};

  const firstName = values.first_name.trim();
  if (!firstName) {
    errors.first_name = "Enter your first name.";
  } else if (firstName.length > 50) {
    errors.first_name = "Your first name must be 50 characters or fewer.";
  }

  const dob = values.date_of_birth;
  if (!dob) {
    errors.date_of_birth = "Enter your date of birth.";
  } else if (!isValidIsoDate(dob)) {
    errors.date_of_birth = "Enter a valid date of birth.";
  } else if (dob < MIN_BIRTH_DATE) {
    errors.date_of_birth = "Enter a birth date of 1900 or later.";
  } else if (dob > new Date().toISOString().slice(0, 10)) {
    errors.date_of_birth = "Your date of birth can't be in the future.";
  } else if (new Date(`${dob}T00:00:00`) > eighteenthBirthdayCutoff(new Date())) {
    errors.date_of_birth = "You must be at least 18 years old to use UniMatch.";
  }

  if (!values.university_id) {
    errors.university_id = "Select your university.";
  }

  const course = values.course.trim();
  if (!course) {
    errors.course = "Enter your course.";
  } else if (course.length > 120) {
    errors.course = "Your course must be 120 characters or fewer.";
  }

  if (!values.academic_year) {
    errors.academic_year = "Select your academic year.";
  }

  if (!values.gender) {
    errors.gender = "Select your gender.";
  }

  if (!values.seeking_gender) {
    errors.seeking_gender = "Select who you're interested in.";
  }

  const bio = values.bio.trim();
  if (!bio) {
    errors.bio = "Write a short bio.";
  } else if (bio.length > 500) {
    errors.bio = "Your bio must be 500 characters or fewer.";
  }

  if (values.height_cm.trim()) {
    const height = Number(values.height_cm);
    if (!Number.isInteger(height) || height < 100 || height > 250) {
      errors.height_cm = "Height must be a whole number between 100 and 250 cm.";
    }
  }

  const hometown = values.hometown.trim();
  if (hometown.length > 100) {
    errors.hometown = "Your hometown must be 100 characters or fewer.";
  }

  return errors;
}

export function profileInputFromForm(values: ProfileFormValues): ProfileInput {
  const heightRaw = values.height_cm.trim();
  return {
    first_name: values.first_name.trim(),
    date_of_birth: values.date_of_birth,
    university_id: values.university_id,
    course: values.course.trim(),
    academic_year: Number(values.academic_year),
    gender: values.gender as ProfileGender,
    seeking_gender: values.seeking_gender as ProfileSeekingGender,
    bio: values.bio.trim(),
    relationship_intent:
      values.relationship_intent === ""
        ? null
        : (values.relationship_intent as ProfileRelationshipIntent),
    height_cm: heightRaw === "" ? null : Number(heightRaw),
    hometown: values.hometown.trim() === "" ? null : values.hometown.trim(),
  };
}

export function profileFormValuesFromProfile(profile: Profile): ProfileFormValues {
  return {
    first_name: profile.first_name,
    date_of_birth: profile.date_of_birth,
    university_id: profile.university_id,
    course: profile.course,
    academic_year: String(profile.academic_year),
    gender: profile.gender,
    seeking_gender: profile.seeking_gender,
    bio: profile.bio,
    relationship_intent: profile.relationship_intent ?? "",
    height_cm: profile.height_cm === null ? "" : String(profile.height_cm),
    hometown: profile.hometown ?? "",
  };
}

// ---------------------------------------------------------------------------
// API calls.
// ---------------------------------------------------------------------------

export async function fetchUniversities(): Promise<University[]> {
  return requestJson<University[]>("/api/v1/universities", { method: "GET" });
}

export async function fetchMyProfile(): Promise<Profile> {
  return requestJson<Profile>("/api/v1/profiles/me", { method: "GET" });
}

export async function createMyProfile(input: ProfileInput): Promise<Profile> {
  return requestJson<Profile>("/api/v1/profiles/me", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(input),
  });
}

export async function updateMyProfile(input: ProfileInput): Promise<Profile> {
  return requestJson<Profile>("/api/v1/profiles/me", {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(input),
  });
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
    throw new ProfileApiError("unauthorized");
  }

  const headers = new Headers(init.headers);
  headers.set("Authorization", `Bearer ${token}`);

  let response: Response;
  try {
    response = await fetch(`${apiBaseUrl()}${path}`, { ...init, headers });
  } catch {
    throw new ProfileApiError("network");
  }

  if (!response.ok) {
    throw new ProfileApiError(
      errorCodeFor(await readBackendErrorCode(response), response.status),
    );
  }

  try {
    return (await response.json()) as T;
  } catch {
    throw new ProfileApiError("unknown");
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
): ProfileApiErrorCode {
  switch (backendCode) {
    case "unauthorized":
      return "unauthorized";
    case "profile_not_found":
      return "not_found";
    case "profile_already_exists":
      return "already_exists";
    case "validation_error":
      return "validation";
    case "database_unavailable":
    case "database_insert_failed":
    case "database_update_failed":
      return "unavailable";
    default:
      if (status === 401 || status === 403) {
        return "unauthorized";
      }
      if (status === 404) {
        return "not_found";
      }
      if (status === 409) {
        return "already_exists";
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
