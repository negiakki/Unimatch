"use client";

import { useRouter } from "next/navigation";
import Link from "next/link";
import { useCallback, useEffect, useState, type FormEvent } from "react";

import { PhotoManager } from "@/components/photo-manager";
import { ProfileFormFields } from "@/components/profile-form-fields";
import { Button, Label } from "@/components/ui";
import { ApiError } from "@/lib/api/http";
import { fetchInterests, type Interest } from "@/lib/api/interests";
import {
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
 * Profile editing for the signed-in user. Loads through GET /profiles/me and
 * saves through PUT /profiles/me; ownership is decided server-side from the
 * session token.
 *
 * One universal profile, reused across every opportunity — editing here
 * changes what people see in every opportunity feed. The legacy relationship
 * intent column has no control and round-trips untouched.
 */

function messageFor(error: unknown): string {
  return error instanceof ApiError
    ? error.message
    : "Something went wrong. Please try again.";
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
        if (error instanceof ApiError) {
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
      if (error instanceof ApiError) {
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
        <div className="h-10 w-56 animate-pulse bg-line" />
        <div className="mt-10 h-64 animate-pulse bg-line" />
      </section>
    );
  }

  if (phase === "error") {
    return (
      <section className="pt-14">
        <Label>Problem</Label>
        <h1 className="type-display mt-4 text-display">Something went wrong</h1>
        <p role="alert" className="mt-4 max-w-sm text-[15px] leading-relaxed text-muted">
          {loadError}
        </p>
        <Button variant="outline" className="mt-8 w-full" onClick={retryLoad}>
          Try again
        </Button>
      </section>
    );
  }

  if (!values) {
    return null;
  }

  return (
    <section className="pt-10">
      <Link
        href="/profile"
        className="inline-flex items-center gap-1 text-sm font-semibold text-muted transition-colors hover:text-ink"
      >
        <BackIcon className="size-4" />
        Your profile
      </Link>

      <h1 className="type-display mt-4 text-display">Edit your profile</h1>
      <p className="mt-3 max-w-md text-[15px] leading-relaxed text-muted">
        One profile, every opportunity — these are what people see wherever
        they meet you.
      </p>

      <section aria-label="Your photos" className="mt-10 border-t border-line pt-6">
        <PhotoManager />
      </section>

      <form onSubmit={handleSubmit} noValidate className="mt-10">
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
          <p role="status" aria-live="polite" className="mt-6 text-sm font-medium text-positive">
            Profile saved.{" "}
            <Link href="/profile" className="underline underline-offset-2">
              View your profile
            </Link>
          </p>
        )}
        {submitError && (
          <p role="alert" className="mt-6 text-sm font-medium text-danger">
            {submitError}
          </p>
        )}
        <p aria-live="polite" className="sr-only">
          {submitting ? "Saving your profile" : ""}
        </p>

        <Button
          type="submit"
          className="mt-8 w-full"
          disabled={submitting || universitiesLoading}
          aria-busy={submitting}
        >
          {submitting ? "Saving changes…" : "Save changes"}
        </Button>
      </form>
    </section>
  );
}

function BackIcon({ className }: { className?: string }) {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={2}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      className={className}
    >
      <path d="m15 18-6-6 6-6" />
    </svg>
  );
}
