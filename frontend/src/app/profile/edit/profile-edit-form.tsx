"use client";

import { useRouter } from "next/navigation";
import { useCallback, useEffect, useState, type FormEvent } from "react";

import { PhotoManager } from "@/components/photo-manager";
import { ProfileFormFields } from "@/components/profile-form-fields";
import {
  fetchInterests,
  InterestsApiError,
  type Interest,
} from "@/lib/api/interests";
import {
  ProfileApiError,
  fetchMyProfile,
  fetchUniversities,
  profileFormValuesFromProfile,
  profileInputFromForm,
  updateMyProfile,
  validateProfileForm,
  type Profile,
  type ProfileFieldErrors,
  type ProfileFormValues,
  type University,
} from "@/lib/api/profile";

/**
 * Profile editing for the signed-in user's own profile. Loads the profile
 * through GET /profiles/me and saves through PUT /profiles/me; ownership is
 * decided server-side from the session token, and auth_user_id is never
 * displayed or editable. Photo management (upload, reorder, delete, primary)
 * is a separate self-contained section below the profile form.
 */

const FOCUS_RING =
  "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent focus-visible:ring-offset-2 focus-visible:ring-offset-background";

function messageFor(error: unknown): string {
  if (error instanceof ProfileApiError || error instanceof InterestsApiError) {
    return error.message;
  }
  return "Something went wrong. Please try again.";
}

export function ProfileEditForm() {
  const router = useRouter();
  const [phase, setPhase] = useState<"loading" | "ready" | "error">("loading");
  const [loadError, setLoadError] = useState<string | null>(null);

  const [universities, setUniversities] = useState<University[]>([]);
  const [universitiesLoading, setUniversitiesLoading] = useState(true);

  const [interests, setInterests] = useState<Interest[]>([]);
  const [interestsLoading, setInterestsLoading] = useState(true);
  const [interestsError, setInterestsError] = useState<string | null>(null);

  const [values, setValues] = useState<ProfileFormValues | null>(null);
  const [fieldErrors, setFieldErrors] = useState<ProfileFieldErrors>({});
  const [submitError, setSubmitError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [reloadKey, setReloadKey] = useState(0);

  const loadProfile = useCallback(async () => {
    const profile = await fetchMyProfile();
    setValues(profileFormValuesFromProfile(profile));
  }, []);

  const loadUniversities = useCallback(async () => {
    setUniversitiesLoading(true);
    try {
      const catalog = await fetchUniversities();
      setUniversities(catalog);
    } catch (error) {
      // Non-fatal: the currently saved university stays selected and the
      // backend re-validates; a retry can repopulate the selector.
      console.error("Failed to load universities:", error);
    } finally {
      setUniversitiesLoading(false);
    }
  }, []);

  const loadInterests = useCallback(async () => {
    setInterestsLoading(true);
    setInterestsError(null);
    try {
      const catalog = await fetchInterests();
      setInterests(catalog);
    } catch (error) {
      // Non-fatal: the saved selection stays in the form values and is
      // submitted unchanged, so a failed catalog load can never silently
      // clear interests. A retry repopulates the picker.
      console.error("Failed to load interests:", error);
      setInterestsError(
        "Couldn't load interests right now. Your saved interests are kept.",
      );
    } finally {
      setInterestsLoading(false);
    }
  }, []);

  useEffect(() => {
    void (async () => {
      setSaved(false);
      try {
        await loadProfile();
        await Promise.all([loadUniversities(), loadInterests()]);
        setPhase("ready");
      } catch (error) {
        if (error instanceof ProfileApiError) {
          if (error.code === "not_found") {
            router.replace("/onboarding");
            return;
          }
          if (error.code === "unauthorized") {
            router.replace("/login");
            return;
          }
        }
        console.error("Failed to load profile:", error);
        setLoadError(messageFor(error));
        setPhase("error");
      }
    })();
  }, [router, loadProfile, loadUniversities, loadInterests, reloadKey]);

  const retryLoad = useCallback(() => {
    setPhase("loading");
    setLoadError(null);
    setReloadKey((key) => key + 1);
  }, []);

  function handleChange(patch: Partial<ProfileFormValues>) {
    setValues((current) => (current ? { ...current, ...patch } : current));
    setSaved(false);
    setSubmitError(null);
  }

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!values || submitting) {
      return;
    }

    const errors = validateProfileForm(values);
    if (Object.keys(errors).length > 0) {
      setFieldErrors(errors);
      setSubmitError("Please fix the highlighted fields and try again.");
      return;
    }
    setFieldErrors({});
    setSubmitError(null);
    setSubmitting(true);
    try {
      const updated: Profile = await updateMyProfile(
        profileInputFromForm(values),
      );
      setValues(profileFormValuesFromProfile(updated));
      setSaved(true);
    } catch (error) {
      if (error instanceof ProfileApiError) {
        if (error.code === "not_found") {
          router.replace("/onboarding");
          return;
        }
        if (error.code === "unauthorized") {
          router.replace("/login");
          return;
        }
      }
      setSubmitError(messageFor(error));
    } finally {
      setSubmitting(false);
    }
  }

  if (phase === "loading") {
    return (
      <section className="pt-14" aria-busy="true" aria-live="polite">
        <span className="sr-only">Loading your profile</span>
        <div className="mx-auto size-14 animate-pulse rounded-2xl bg-line" />
        <div className="mx-auto mt-5 h-8 w-56 animate-pulse rounded-full bg-line" />
        <div className="mx-auto mt-3 h-4 w-72 max-w-full animate-pulse rounded-full bg-line" />
        <div className="mt-8 h-96 rounded-card border border-line bg-surface shadow-card" />
      </section>
    );
  }

  if (phase === "error") {
    return (
      <section className="pt-14 text-center">
        <div className="mx-auto grid size-14 place-items-center rounded-2xl bg-accent/15 text-accent">
          <AlertIcon className="size-7" />
        </div>
        <h1 className="mt-5 text-3xl font-bold tracking-tight">
          Something went wrong
        </h1>
        <p
          role="alert"
          className="mx-auto mt-3 max-w-sm text-[15px] leading-relaxed text-muted"
        >
          {loadError}
        </p>
        <button
          type="button"
          onClick={retryLoad}
          className={`mt-8 w-full rounded-2xl border border-line bg-surface py-3.5 font-semibold text-ink shadow-card transition-transform active:scale-[0.98] ${FOCUS_RING}`}
        >
          Try again
        </button>
      </section>
    );
  }

  if (!values) {
    return null;
  }

  return (
    <section className="pt-14 text-center">
      <div className="mx-auto grid size-14 place-items-center rounded-2xl bg-accent/15 text-accent">
        <UserIcon className="size-7" />
      </div>
      <h1 className="mt-5 text-3xl font-bold tracking-tight">Edit your profile</h1>
      <p className="mx-auto mt-3 max-w-sm text-[15px] leading-relaxed text-muted">
        Update your details and keep your profile current.
      </p>

      <form onSubmit={handleSubmit} noValidate className="mt-8">
        <ProfileFormFields
          values={values}
          errors={fieldErrors}
          universities={universities}
          universitiesLoading={universitiesLoading}
          disabled={submitting}
          interests={interests}
          interestsLoading={interestsLoading}
          interestsError={interestsError}
          onRetryInterests={loadInterests}
          onChange={handleChange}
        />

        {saved && (
          <p
            role="status"
            aria-live="polite"
            className="mt-3 text-sm font-medium text-emerald-600"
          >
            Profile saved.
          </p>
        )}
        {submitError && (
          <p role="alert" className="mt-3 text-sm font-medium text-red-600">
            {submitError}
          </p>
        )}
        <p aria-live="polite" className="sr-only">
          {submitting ? "Saving your profile" : ""}
        </p>

        <button
          type="submit"
          disabled={submitting || universitiesLoading}
          aria-busy={submitting}
          className={`mt-5 w-full rounded-2xl bg-accent py-3.5 font-semibold text-white shadow-card transition-transform active:scale-[0.98] disabled:pointer-events-none disabled:opacity-40 ${FOCUS_RING}`}
        >
          {submitting ? "Saving changes…" : "Save changes"}
        </button>
      </form>

      <section
        aria-label="Your photos"
        className="mt-10 rounded-card border border-line bg-surface p-5 text-left shadow-card"
      >
        <PhotoManager />
      </section>
    </section>
  );
}

function UserIcon({ className }: { className?: string }) {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.8}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      className={className}
    >
      <circle cx="12" cy="8" r="4" />
      <path d="M4 21c0-4 3.6-6 8-6s8 2 8 6" />
    </svg>
  );
}

function AlertIcon({ className }: { className?: string }) {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.8}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      className={className}
    >
      <circle cx="12" cy="12" r="10" />
      <path d="M12 8v4" />
      <path d="M12 16h.01" />
    </svg>
  );
}
