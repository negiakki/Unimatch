"use client";

import { useRouter } from "next/navigation";
import { useCallback, useEffect, useState, type FormEvent } from "react";

import { PhotoManager } from "@/components/photo-manager";
import { ProfileFormFields } from "@/components/profile-form-fields";
import {
  ProfileApiError,
  createMyProfile,
  fetchMyProfile,
  fetchUniversities,
  profileInputFromForm,
  validateProfileForm,
  type ProfileFieldErrors,
  type ProfileFormValues,
  type University,
} from "@/lib/api/profile";

/**
 * Profile creation for a signed-in user who doesn't have a profile yet.
 * On load the caller's profile is checked: an existing profile continues to
 * the verification flow, a missing session returns to sign-in. After the
 * profile is created, a photo step lets the new user add their photos before
 * continuing to verification. Ownership is decided by the backend from the
 * session token — nothing here sends or displays auth_user_id.
 */

const EMPTY_VALUES: ProfileFormValues = {
  first_name: "",
  date_of_birth: "",
  university_id: "",
  course: "",
  academic_year: "",
  gender: "",
  seeking_gender: "",
  bio: "",
  relationship_intent: "",
  height_cm: "",
  hometown: "",
};

const FOCUS_RING =
  "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent focus-visible:ring-offset-2 focus-visible:ring-offset-background";

function messageFor(error: unknown): string {
  if (error instanceof ProfileApiError) {
    return error.message;
  }
  return "Something went wrong. Please try again.";
}

export function ProfileOnboardingForm() {
  const router = useRouter();
  const [phase, setPhase] = useState<"loading" | "ready" | "error">("loading");
  const [step, setStep] = useState<"profile" | "photos">("profile");
  const [loadError, setLoadError] = useState<string | null>(null);

  const [universities, setUniversities] = useState<University[]>([]);
  const [universitiesLoading, setUniversitiesLoading] = useState(true);

  const [values, setValues] = useState<ProfileFormValues>(EMPTY_VALUES);
  const [fieldErrors, setFieldErrors] = useState<ProfileFieldErrors>({});
  const [submitError, setSubmitError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [reloadKey, setReloadKey] = useState(0);

  const loadUniversities = useCallback(async () => {
    setUniversitiesLoading(true);
    try {
      const catalog = await fetchUniversities();
      setUniversities(catalog);
    } catch (error) {
      // Non-fatal: the form stays usable and the backend re-validates the
      // selected university; a reload/retry can repopulate the selector.
      console.error("Failed to load universities:", error);
    } finally {
      setUniversitiesLoading(false);
    }
  }, []);

  useEffect(() => {
    void (async () => {
      try {
        await fetchMyProfile();
        // Already has a profile — continue to the verification flow.
        router.replace("/verify");
        return;
      } catch (error) {
        if (error instanceof ProfileApiError) {
          if (error.code === "not_found") {
            await loadUniversities();
            setPhase("ready");
            return;
          }
          if (error.code === "unauthorized") {
            router.replace("/login");
            return;
          }
        }
        console.error("Failed to check profile existence:", error);
        setLoadError(messageFor(error));
        setPhase("error");
      }
    })();
  }, [router, loadUniversities, reloadKey]);

  const retryLoad = useCallback(() => {
    setLoadError(null);
    setReloadKey((key) => key + 1);
  }, []);

  function handleChange(patch: Partial<ProfileFormValues>) {
    setValues((current) => ({ ...current, ...patch }));
    setSubmitError(null);
  }

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (submitting) {
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
      await createMyProfile(profileInputFromForm(values));
      setStep("photos");
    } catch (error) {
      if (error instanceof ProfileApiError) {
        if (error.code === "already_exists") {
          router.replace("/verify");
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
        <span className="sr-only">Preparing your profile</span>
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

  if (step === "photos") {
    return (
      <section className="pt-14">
        <div className="text-center">
          <div className="mx-auto grid size-14 place-items-center rounded-2xl bg-accent/15 text-accent">
            <UserIcon className="size-7" />
          </div>
          <h1 className="mt-5 text-3xl font-bold tracking-tight">
            Add your photos
          </h1>
          <p className="mx-auto mt-3 max-w-sm text-[15px] leading-relaxed text-muted">
            Photos are the first thing other students see. Add at least one —
            you can always change them later.
          </p>
        </div>

        <div className="mt-8 rounded-card border border-line bg-surface p-5 text-left shadow-card">
          <PhotoManager />
        </div>

        <button
          type="button"
          onClick={() => router.replace("/verify")}
          className={`mt-5 w-full rounded-2xl bg-accent py-3.5 font-semibold text-white shadow-card transition-transform active:scale-[0.98] ${FOCUS_RING}`}
        >
          Continue to student ID check
        </button>
      </section>
    );
  }

  return (
    <section className="pt-14 text-center">
      <div className="mx-auto grid size-14 place-items-center rounded-2xl bg-accent/15 text-accent">
        <UserIcon className="size-7" />
      </div>
      <h1 className="mt-5 text-3xl font-bold tracking-tight">
        Create your profile
      </h1>
      <p className="mx-auto mt-3 max-w-sm text-[15px] leading-relaxed text-muted">
        Tell us a little about yourself. This is what other verified students
        will see once you&apos;re verified.
      </p>

      <form onSubmit={handleSubmit} noValidate className="mt-8">
        <ProfileFormFields
          values={values}
          errors={fieldErrors}
          universities={universities}
          universitiesLoading={universitiesLoading}
          disabled={submitting}
          onChange={handleChange}
        />

        {submitError && (
          <p role="alert" className="mt-3 text-sm font-medium text-red-600">
            {submitError}
          </p>
        )}
        <p aria-live="polite" className="sr-only">
          {submitting ? "Creating your profile" : ""}
        </p>

        <button
          type="submit"
          disabled={submitting || universitiesLoading}
          aria-busy={submitting}
          className={`mt-5 w-full rounded-2xl bg-accent py-3.5 font-semibold text-white shadow-card transition-transform active:scale-[0.98] disabled:pointer-events-none disabled:opacity-40 ${FOCUS_RING}`}
        >
          {submitting ? "Creating your profile…" : "Create profile"}
        </button>
        <p className="mt-4 text-center text-xs leading-relaxed text-muted">
          Next up: a quick student ID check so everyone on UniMatch is a real
          student.
        </p>
      </form>
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
