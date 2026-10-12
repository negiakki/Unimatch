"use client";

import { useRouter } from "next/navigation";
import { useCallback, useEffect, useState } from "react";

import { PhotoManager } from "@/components/photo-manager";
import {
  AboutFields,
  BasicsFields,
  GENDERS,
  InterestsPickerFields,
  MotivationsFields,
  OptionalFields,
  SEEKING_GENDERS,
  StudiesFields,
} from "@/components/profile-form-fields";
import { Button } from "@/components/ui";
import { Label } from "@/components/ui";
import { ApiError } from "@/lib/api/http";
import { fetchInterests, type Interest } from "@/lib/api/interests";
import {
  CUSTOM_UNIVERSITY_ID,
  MOTIVATION_OPTIONS,
  createMyProfile,
  fetchMyProfile,
  fetchUniversities,
  profileInputFromForm,
  updateMyProfile,
  validateProfileForm,
  type ProfileFieldErrors,
  type ProfileFieldKey,
  type ProfileFormValues,
  type University,
} from "@/lib/api/profile";
import { cx } from "@/lib/format";

/**
 * Profile creation as a multi-step wizard for a signed-in user who doesn't
 * have a profile yet. On load the caller's profile is checked: an existing
 * profile continues to the verification flow, a missing session returns to
 * sign-in. Form state lives at the wizard level so navigating Back/Next
 * never loses input; each step validates only its own fields (rules stay in
 * the profile API module). The profile is persisted once the required steps
 * are valid (photo endpoints need an existing profile), then later steps
 * save through the update endpoint — nothing here sends auth_user_id.
 */

const EMPTY_VALUES: ProfileFormValues = {
  first_name: "",
  date_of_birth: "",
  university_id: "",
  custom_university_name: "",
  course: "",
  academic_year: "",
  gender: "",
  seeking_gender: "",
  bio: "",
  relationship_intent: "",
  height_cm: "",
  hometown: "",
  motivations: [],
  interest_ids: [],
  custom_interest_names: [],
};

/** Field keys each step is responsible for — errors are filtered to these. */
const STEP_FIELD_KEYS: Record<StepKey, ProfileFieldKey[]> = {
  basics: ["first_name", "date_of_birth", "gender", "seeking_gender"],
  studies: ["university_id", "custom_university_name", "course", "academic_year"],
  about: ["bio"],
  interests: ["motivations", "interest_ids", "custom_interest_names"],
  photos: [],
  optional: ["height_cm", "hometown"],
  review: [],
};

const STEPS = [
  { key: "basics", title: "The basics", blurb: "Your name, birthday, and who you'd like to meet." },
  { key: "studies", title: "Your studies", blurb: "Your university is matched against your student ID during verification." },
  { key: "about", title: "About you", blurb: "A short bio is what people read after your photo." },
  { key: "interests", title: "Interests & motives", blurb: "Pick what you're here for and the things you love." },
  { key: "photos", title: "Your photos", blurb: "Your photo is the first thing other students see. Add at least one." },
  { key: "optional", title: "Optional details", blurb: "Every field here is optional — skip anything you'd rather not share." },
  { key: "review", title: "Review your profile", blurb: "Check it looks right. You can go back and edit any section." },
] as const;

type StepKey = (typeof STEPS)[number]["key"];

function messageFor(error: unknown): string {
  return error instanceof ApiError
    ? error.message
    : "Something went wrong. Please try again.";
}

export function ProfileOnboardingForm() {
  const router = useRouter();
  const [phase, setPhase] = useState<"loading" | "ready" | "error">("loading");
  const [loadError, setLoadError] = useState<string | null>(null);

  const [universities, setUniversities] = useState<University[]>([]);
  const [universitiesLoading, setUniversitiesLoading] = useState(true);

  const [interests, setInterests] = useState<Interest[]>([]);
  const [interestsLoading, setInterestsLoading] = useState(true);
  const [interestsError, setInterestsError] = useState<string | null>(null);

  const [values, setValues] = useState<ProfileFormValues>(EMPTY_VALUES);
  const [stepIndex, setStepIndex] = useState(0);
  const [fieldErrors, setFieldErrors] = useState<ProfileFieldErrors>({});
  const [submitError, setSubmitError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  /** Flips after the profile is created; later saves go through PUT. */
  const [profileCreated, setProfileCreated] = useState(false);
  /** Owned by PhotoManager; onboarding needs it to require at least one photo. */
  const [photoCount, setPhotoCount] = useState(0);
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

  const loadInterests = useCallback(async () => {
    setInterestsLoading(true);
    setInterestsError(null);
    try {
      const catalog = await fetchInterests();
      setInterests(catalog);
    } catch (error) {
      // Non-fatal: interests are optional, the selection is preserved, and
      // the backend re-validates every submitted id. A retry can repopulate
      // the picker.
      console.error("Failed to load interests:", error);
      setInterestsError(
        "Couldn't load interests right now. You can continue without them.",
      );
    } finally {
      setInterestsLoading(false);
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
        if (error instanceof ApiError) {
          if (error.code === "not_found") {
            await Promise.all([loadUniversities(), loadInterests()]);
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
  }, [router, loadUniversities, loadInterests, reloadKey]);

  const retryLoad = useCallback(() => {
    setLoadError(null);
    setReloadKey((key) => key + 1);
  }, []);

  function handleChange(patch: Partial<ProfileFormValues>) {
    setValues((current) => ({ ...current, ...patch }));
    setSubmitError(null);
  }

  function goToStep(index: number) {
    setStepIndex(Math.max(0, Math.min(STEPS.length - 1, index)));
    setSubmitError(null);
    window.scrollTo({ top: 0, behavior: "smooth" });
  }

  /** Persists the profile: POST the first time, PUT afterwards. */
  async function persistProfile() {
    if (profileCreated) {
      await updateMyProfile(profileInputFromForm(values));
    } else {
      await createMyProfile(profileInputFromForm(values));
      setProfileCreated(true);
    }
  }

  function handleRedirect(error: unknown): boolean {
    if (error instanceof ApiError) {
      // The profile already exists (created in another tab) — continue.
      if (error.code === "conflict") {
        router.replace("/verify");
        return true;
      }
      if (error.code === "unauthorized") {
        router.replace("/login");
        return true;
      }
    }
    return false;
  }

  function errorsForStep(step: StepKey, allErrors: ProfileFieldErrors) {
    const keys = STEP_FIELD_KEYS[step] ?? [];
    return keys.filter((key) => allErrors[key] !== undefined);
  }

  /** Next: validate the current step, persist when required steps complete. */
  async function handleNext() {
    if (saving) {
      return;
    }
    const allErrors = validateProfileForm(values);
    const step = STEPS[stepIndex].key;
    const stepKeys = errorsForStep(step, allErrors);
    if (stepKeys.length > 0) {
      setFieldErrors(allErrors);
      setSubmitError("Please fix the highlighted fields and try again.");
      return;
    }
    setFieldErrors({});

    // Photos endpoints need an existing profile — persist after the last
    // required step, before the photos step. The optional step persists too:
    // it's the last step with editable fields, and review/finish assume
    // everything is already saved.
    if (step === "interests" || step === "optional") {
      setSaving(true);
      setSubmitError(null);
      try {
        await persistProfile();
        goToStep(stepIndex + 1);
      } catch (error) {
        if (handleRedirect(error)) {
          return;
        }
        setSubmitError(messageFor(error));
      } finally {
        setSaving(false);
      }
      return;
    }

    // A profile photo is required: it is the first thing other students see,
    // and discovery is worthless without one. Gated here so the photos step
    // cannot be skipped past, and re-checked on finish.
    if (step === "photos" && photoCount === 0) {
      setSubmitError("Add at least one photo before continuing.");
      return;
    }

    goToStep(stepIndex + 1);
  }

  /** Review finish: everything is already saved; just continue to verify. */
  async function handleFinish() {
    if (saving) {
      return;
    }
    const allErrors = validateProfileForm(values);
    if (Object.keys(allErrors).length > 0) {
      setFieldErrors(allErrors);
      setSubmitError("Some sections still need your attention.");
      const firstStep = STEPS.findIndex(
        (candidate) => errorsForStep(candidate.key, allErrors).length > 0,
      );
      if (firstStep >= 0) {
        goToStep(firstStep);
      }
      return;
    }
    // Defensive: the photos step already blocks this, but finish is also
    // reachable via the review step's jump-back buttons.
    if (photoCount === 0) {
      setSubmitError("Add at least one photo before continuing.");
      goToStep(STEPS.findIndex((step) => step.key === "photos"));
      return;
    }
    if (!profileCreated) {
      // Defensive: review is only reachable through the interests step,
      // but a direct jump here would still create the profile.
      setSaving(true);
      try {
        await persistProfile();
      } catch (error) {
        if (handleRedirect(error)) {
          return;
        }
        setSubmitError(messageFor(error));
        return;
      } finally {
        setSaving(false);
      }
    }
    router.replace("/verify");
  }

  if (phase === "loading") {
    return (
      <section className="pt-14" aria-busy="true" aria-live="polite">
        <span className="sr-only">Preparing your profile</span>
        <div className="h-3 w-32 animate-pulse bg-line" />
        <div className="mt-8 h-10 w-56 animate-pulse bg-line" />
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

  const step = STEPS[stepIndex];
  const isReview = step.key === "review";
  const fieldGroupProps = { values, errors: fieldErrors, onChange: handleChange };

  return (
    <section className="pt-12">
      <OnboardingProgress
        steps={STEPS.map(({ title }) => title)}
        currentStep={stepIndex}
        onStepClick={goToStep}
      />

      <div className="mt-10">
        <h1 className="type-display text-display">{step.title}</h1>
        <p className="mt-3 max-w-md text-[15px] leading-relaxed text-muted">
          {step.blurb}
        </p>
      </div>

      {step.key === "basics" && (
        <WizardCard>
          <BasicsFields {...fieldGroupProps} />
        </WizardCard>
      )}

      {step.key === "studies" && (
        <WizardCard>
          <StudiesFields
            {...fieldGroupProps}
            universities={universities}
            universitiesLoading={universitiesLoading}
          />
        </WizardCard>
      )}

      {step.key === "about" && (
        <WizardCard>
          <AboutFields {...fieldGroupProps} />
        </WizardCard>
      )}

      {step.key === "interests" && (
        <div className="text-left">
          <WizardCard heading="Why I'm here" hint="Pick every reason that applies.">
            <MotivationsFields {...fieldGroupProps} />
          </WizardCard>
          <WizardCard heading="Your interests">
            <InterestsPickerFields
              {...fieldGroupProps}
              interests={interests}
              interestsLoading={interestsLoading}
              interestsError={interestsError}
              onRetryInterests={loadInterests}
            />
          </WizardCard>
        </div>
      )}

      {step.key === "photos" && (
        <WizardCard>
          <PhotoManager onCountChange={setPhotoCount} />
          <p className="mt-3 text-xs leading-relaxed text-muted">
            You can add or change photos any time from your profile.
          </p>
        </WizardCard>
      )}

      {step.key === "optional" && (
        <WizardCard>
          <OptionalFields {...fieldGroupProps} />
        </WizardCard>
      )}

      {isReview && (
        <div className="text-left">
          <ReviewRow
            section="Basics"
            stepIndex={0}
            onEdit={goToStep}
            lines={[
              values.first_name,
              values.date_of_birth,
              genderSummary(values),
            ]}
          />
          <ReviewRow
            section="Studies"
            stepIndex={1}
            onEdit={goToStep}
            lines={[
              universitySummary(
                universities,
                values.university_id,
                values.custom_university_name,
              ),
              [values.course, yearSummary(values.academic_year)]
                .filter(Boolean)
                .join(" · "),
            ]}
          />
          <ReviewRow
            section="About you"
            stepIndex={2}
            onEdit={goToStep}
            lines={[values.bio]}
          />
          <ReviewRow
            section="Interests & motives"
            stepIndex={3}
            onEdit={goToStep}
            lines={[
              motivationSummary(values),
              [
                values.interest_ids.length > 0
                  ? `${values.interest_ids.length} interests`
                  : "",
                values.custom_interest_names.length > 0
                  ? `${values.custom_interest_names.length} custom`
                  : "",
              ]
                .filter(Boolean)
                .join(" · "),
            ]}
          />
          <ReviewRow
            section="Photos"
            stepIndex={4}
            onEdit={goToStep}
            lines={[
              photoCount > 0
                ? `${photoCount} added`
                : "None yet — add at least one to continue",
            ]}
          />
          <ReviewRow
            section="Optional details"
            stepIndex={5}
            onEdit={goToStep}
            lines={[
              [values.height_cm ? `${values.height_cm} cm` : "", values.hometown ? `From ${values.hometown}` : ""]
                .filter(Boolean)
                .join(" · "),
            ]}
          />

          <p className="px-1 pt-6 text-sm leading-relaxed text-muted">
            Next up: a quick student ID check so everyone on UniMatch is a real
            student.
          </p>
        </div>
      )}

      {submitError && (
        <p role="alert" className="mt-6 text-sm font-medium text-danger">
          {submitError}
        </p>
      )}
      <p aria-live="polite" className="sr-only">
        {saving ? "Saving your profile" : ""}
      </p>

      <div className="mt-8 flex items-center gap-3">
        {stepIndex > 0 && (
          <Button
            type="button"
            variant="outline"
            onClick={() => goToStep(stepIndex - 1)}
            disabled={saving}
            className="px-5"
          >
            Back
          </Button>
        )}
        <Button
          type="button"
          onClick={isReview ? handleFinish : handleNext}
          disabled={saving || (step.key === "studies" && universitiesLoading)}
          aria-busy={saving}
          className="flex-1"
        >
          {saving
            ? "Saving…"
            : isReview
              ? "Finish and verify"
              : stepIndex === STEPS.length - 2
                ? "Review your profile"
                : "Next"}
        </Button>
      </div>
    </section>
  );
}

function genderSummary(values: ProfileFormValues): string {
  const gender = GENDERS.find((option) => option.value === values.gender)?.label;
  const seeking = SEEKING_GENDERS.find(
    (option) => option.value === values.seeking_gender,
  )?.label;
  if (!gender && !seeking) {
    return "";
  }
  // Partner-discovery preference, worded neutrally.
  return [gender, seeking && `discover: ${seeking.toLowerCase()}`]
    .filter(Boolean)
    .join(", ");
}

function motivationSummary(values: ProfileFormValues): string {
  const labels = values.motivations
    .map(
      (value) =>
        MOTIVATION_OPTIONS.find((option) => option.value === value)?.label,
    )
    .filter(Boolean);
  return labels.length > 0 ? `Here for: ${labels.join(", ")}` : "";
}

/**
 * Review-step label for the claimed university. A custom pick has no catalog
 * row, so fall back to the student's own typed name rather than a blank line.
 */
function universitySummary(
  universities: University[],
  universityId: string,
  customName: string,
): string {
  if (universityId === CUSTOM_UNIVERSITY_ID) {
    return customName.trim();
  }
  return universities.find((item) => item.id === universityId)?.name ?? "";
}

function yearSummary(academicYear: string): string {
  return academicYear ? `Year ${academicYear}` : "";
}

function WizardCard({
  heading,
  hint,
  children,
}: {
  heading?: string;
  hint?: string;
  children: React.ReactNode;
}) {
  return (
    <div className="mt-8 border-t border-line pt-6 text-left">
      {heading && <Label>{heading}</Label>}
      {hint && <p className="mt-2 text-xs leading-relaxed text-muted">{hint}</p>}
      <div className={heading ? "mt-5 space-y-4" : "space-y-4"}>{children}</div>
    </div>
  );
}

/**
 * Progress rail: "Step X of 7" plus one segment per step. Completed segments
 * fill in accent, the current one widens, future ones stay dim and are not
 * clickable (you can only go back, never skip ahead).
 */
function OnboardingProgress({
  steps,
  currentStep,
  onStepClick,
}: {
  steps: string[];
  currentStep: number;
  onStepClick: (index: number) => void;
}) {
  return (
    <nav aria-label="Onboarding progress">
      <div className="flex items-baseline justify-between gap-3">
        <Label>
          Step {currentStep + 1} / {steps.length}
        </Label>
        <p className="truncate text-sm text-muted">{steps[currentStep]}</p>
      </div>
      <div className="mt-3 flex gap-1.5">
        {steps.map((title, index) => {
          const state =
            index < currentStep ? "done" : index === currentStep ? "current" : "todo";
          return (
            <button
              key={title}
              type="button"
              onClick={() => onStepClick(index)}
              disabled={index >= currentStep}
              aria-label={`Step ${index + 1}: ${title}${index < currentStep ? " (completed — go back)" : ""}`}
              aria-current={index === currentStep ? "step" : undefined}
              className={cx(
                "h-1 flex-1 rounded-full transition-all disabled:pointer-events-none",
                state === "done"
                  ? "bg-accent"
                  : state === "current"
                    ? "flex-[2] bg-accent/12"
                    : "bg-line",
              )}
            />
          );
        })}
      </div>
    </nav>
  );
}

function ReviewRow({
  section,
  stepIndex,
  onEdit,
  lines,
}: {
  section: string;
  stepIndex: number;
  onEdit: (index: number) => void;
  lines: string[];
}) {
  const filled = lines.filter((line) => line && line.trim());
  return (
    <div className="flex items-start justify-between gap-4 border-b border-line py-4">
      <div className="min-w-0 flex-1">
        <Label>{section}</Label>
        <div className="mt-2 space-y-0.5">
          {filled.length > 0 ? (
            filled.map((line, index) => (
              <p key={index} className="text-sm leading-relaxed text-muted">
                {line}
              </p>
            ))
          ) : (
            <p className="text-sm italic text-muted">Nothing added yet.</p>
          )}
        </div>
      </div>
      <button
        type="button"
        onClick={() => onEdit(stepIndex)}
        aria-label={`Edit ${section}`}
        className="shrink-0 rounded-full border border-line px-3 py-1 text-xs font-semibold text-ink transition-colors hover:border-ink"
      >
        Edit
      </button>
    </div>
  );
}
