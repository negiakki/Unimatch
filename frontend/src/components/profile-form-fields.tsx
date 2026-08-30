"use client";

import { useState, type ReactNode } from "react";

import { MAX_INTERESTS, type Interest } from "@/lib/api/interests";
import type {
  ProfileFieldErrors,
  ProfileFormValues,
  University,
} from "@/lib/api/profile";

/**
 * Presentational profile fields shared by the /onboarding creation form and
 * the /profile/edit form. Pure UI only — validation rules live in the
 * profile API module (UX checks) and the backend (authoritative). Fields are
 * grouped into sections so onboarding reads as a short, intentional flow
 * rather than one long generic form.
 */

const FOCUS_RING =
  "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent focus-visible:ring-offset-2 focus-visible:ring-offset-background";

const INPUT_CLASSES = `w-full rounded-2xl border border-line bg-background px-4 py-3.5 text-[15px] text-ink shadow-card placeholder:text-muted/60 focus:border-accent disabled:opacity-40 ${FOCUS_RING}`;

// ponytail: UI offers years 1–6 per product scope while the backend + DB
// still accept 1–8; tighten the backend contract to 1–6 in a coordinated
// change (routes + migration + tests) before ever widening this list.
const ACADEMIC_YEARS = [1, 2, 3, 4, 5, 6];

const GENDERS: { value: string; label: string }[] = [
  { value: "woman", label: "Woman" },
  { value: "man", label: "Man" },
  { value: "non_binary", label: "Non-binary" },
  { value: "other", label: "Other" },
];

const SEEKING_GENDERS: { value: string; label: string }[] = [
  { value: "women", label: "Women" },
  { value: "men", label: "Men" },
  { value: "everyone", label: "Everyone" },
];

const RELATIONSHIP_INTENTS: { value: string; label: string }[] = [
  { value: "casual", label: "Casual" },
  { value: "serious", label: "Serious relationship" },
  { value: "friendship", label: "Friendship" },
  { value: "not_sure", label: "Not sure yet" },
];

function todayIsoDate(): string {
  const now = new Date();
  const month = String(now.getMonth() + 1).padStart(2, "0");
  const day = String(now.getDate()).padStart(2, "0");
  return `${now.getFullYear()}-${month}-${day}`;
}

function universityLabel(university: University): string {
  const place = [university.city, university.state, university.country]
    .filter((part) => part && part.trim())
    .join(", ");
  return place ? `${university.name} — ${place}` : university.name;
}

function FormSection({
  title,
  hint,
  children,
}: {
  title: string;
  hint?: string;
  children: ReactNode;
}) {
  return (
    <section className="rounded-card border border-line bg-surface p-5 shadow-card">
      <h2 className="text-sm font-semibold uppercase tracking-wide text-muted">
        {title}
      </h2>
      {hint && (
        <p className="mt-1 text-xs leading-relaxed text-muted">{hint}</p>
      )}
      <div className="mt-4 space-y-4">{children}</div>
    </section>
  );
}

function Field({
  id,
  label,
  optional = false,
  error,
  children,
}: {
  id: string;
  label: string;
  optional?: boolean;
  error?: string;
  children: ReactNode;
}) {
  return (
    <div>
      <label htmlFor={id} className="block text-sm font-semibold">
        {label}
        {optional && (
          <span className="font-normal text-muted"> (optional)</span>
        )}
      </label>
      <div className="mt-1.5">{children}</div>
      <FieldError message={error} />
    </div>
  );
}

interface ProfileFormFieldsProps {
  values: ProfileFormValues;
  errors: ProfileFieldErrors;
  universities: University[];
  universitiesLoading: boolean;
  disabled: boolean;
  interests: Interest[];
  interestsLoading: boolean;
  interestsError: string | null;
  onRetryInterests?: () => void;
  onChange: (patch: Partial<ProfileFormValues>) => void;
}

export function ProfileFormFields({
  values,
  errors,
  universities,
  universitiesLoading,
  disabled,
  interests,
  interestsLoading,
  interestsError,
  onRetryInterests,
  onChange,
}: ProfileFormFieldsProps) {
  const maxDate = todayIsoDate();

  function toggleInterest(interestId: string) {
    const selected = values.interest_ids.includes(interestId);
    const next = selected
      ? values.interest_ids.filter((id) => id !== interestId)
      : [...values.interest_ids, interestId];
    onChange({ interest_ids: next });
  }

  return (
    <div className="text-left">
      <fieldset disabled={disabled} className="min-w-0 space-y-5">
        <FormSection title="The basics">
          <Field id="profile-first-name" label="First name" error={errors.first_name}>
            <input
              id="profile-first-name"
              type="text"
              autoComplete="given-name"
              placeholder="Jamie"
              maxLength={50}
              value={values.first_name}
              onChange={(event) => onChange({ first_name: event.target.value })}
              className={INPUT_CLASSES}
              aria-invalid={Boolean(errors.first_name)}
            />
          </Field>

          <Field id="profile-date-of-birth" label="Date of birth" error={errors.date_of_birth}>
            <input
              id="profile-date-of-birth"
              type="date"
              min="1900-01-01"
              max={maxDate}
              autoComplete="bday"
              value={values.date_of_birth}
              onChange={(event) => onChange({ date_of_birth: event.target.value })}
              className={INPUT_CLASSES}
              aria-invalid={Boolean(errors.date_of_birth)}
            />
          </Field>
        </FormSection>

        <FormSection
          title="Your studies"
          hint="Your university is matched against your student ID during verification."
        >
          <Field id="profile-university" label="University" error={errors.university_id}>
            <select
              id="profile-university"
              value={values.university_id}
              onChange={(event) => onChange({ university_id: event.target.value })}
              className={INPUT_CLASSES}
              aria-invalid={Boolean(errors.university_id)}
            >
              <option value="">
                {universitiesLoading
                  ? "Loading universities…"
                  : "Select your university"}
              </option>
              {universities.map((university) => (
                <option key={university.id} value={university.id}>
                  {universityLabel(university)}
                </option>
              ))}
            </select>
          </Field>

          <Field id="profile-course" label="Course" error={errors.course}>
            <input
              id="profile-course"
              type="text"
              autoComplete="off"
              placeholder="Computer Science"
              maxLength={120}
              value={values.course}
              onChange={(event) => onChange({ course: event.target.value })}
              className={INPUT_CLASSES}
              aria-invalid={Boolean(errors.course)}
            />
          </Field>

          <Field id="profile-academic-year" label="Academic year" error={errors.academic_year}>
            <select
              id="profile-academic-year"
              value={values.academic_year}
              onChange={(event) => onChange({ academic_year: event.target.value })}
              className={INPUT_CLASSES}
              aria-invalid={Boolean(errors.academic_year)}
            >
              <option value="">Select your year</option>
              {ACADEMIC_YEARS.map((year) => (
                <option key={year} value={String(year)}>
                  Year {year}
                </option>
              ))}
            </select>
          </Field>
        </FormSection>

        <FormSection title="Dating profile">
          <Field id="profile-gender" label="Gender" error={errors.gender}>
            <select
              id="profile-gender"
              value={values.gender}
              onChange={(event) => onChange({ gender: event.target.value })}
              className={INPUT_CLASSES}
              aria-invalid={Boolean(errors.gender)}
            >
              <option value="">Select your gender</option>
              {GENDERS.map((option) => (
                <option key={option.value} value={option.value}>
                  {option.label}
                </option>
              ))}
            </select>
          </Field>

          <Field
            id="profile-seeking-gender"
            label="Interested in"
            error={errors.seeking_gender}
          >
            <select
              id="profile-seeking-gender"
              value={values.seeking_gender}
              onChange={(event) => onChange({ seeking_gender: event.target.value })}
              className={INPUT_CLASSES}
              aria-invalid={Boolean(errors.seeking_gender)}
            >
              <option value="">Select who you&apos;d like to meet</option>
              {SEEKING_GENDERS.map((option) => (
                <option key={option.value} value={option.value}>
                  {option.label}
                </option>
              ))}
            </select>
          </Field>

          <Field id="profile-relationship-intent" label="Looking for" optional>
            <select
              id="profile-relationship-intent"
              value={values.relationship_intent}
              onChange={(event) =>
                onChange({ relationship_intent: event.target.value })
              }
              className={INPUT_CLASSES}
            >
              <option value="">Prefer not to say</option>
              {RELATIONSHIP_INTENTS.map((option) => (
                <option key={option.value} value={option.value}>
                  {option.label}
                </option>
              ))}
            </select>
          </Field>

          <Field id="profile-height" label="Height in cm" optional error={errors.height_cm}>
            <input
              id="profile-height"
              type="number"
              inputMode="numeric"
              min={100}
              max={250}
              step={1}
              placeholder="170"
              value={values.height_cm}
              onChange={(event) => onChange({ height_cm: event.target.value })}
              className={INPUT_CLASSES}
              aria-invalid={Boolean(errors.height_cm)}
            />
          </Field>

          <Field id="profile-hometown" label="Hometown" optional error={errors.hometown}>
            <input
              id="profile-hometown"
              type="text"
              autoComplete="off"
              placeholder="Springfield"
              maxLength={100}
              value={values.hometown}
              onChange={(event) => onChange({ hometown: event.target.value })}
              className={INPUT_CLASSES}
              aria-invalid={Boolean(errors.hometown)}
            />
          </Field>

          <Field id="profile-bio" label="Bio" error={errors.bio}>
            <textarea
              id="profile-bio"
              rows={4}
              placeholder="Tell people a little about yourself…"
              value={values.bio}
              onChange={(event) => onChange({ bio: event.target.value })}
              className={`${INPUT_CLASSES} resize-none`}
              aria-invalid={Boolean(errors.bio)}
            />
            <div className="mt-1 flex items-baseline justify-between gap-3">
              <FieldError message={errors.bio} />
              <span className="ml-auto shrink-0 text-xs text-muted">
                {values.bio.trim().length}/500
              </span>
            </div>
          </Field>
        </FormSection>

        <FormSection title="Your interests">
          <InterestPicker
            interests={interests}
            interestsLoading={interestsLoading}
            interestsError={interestsError}
            selectedIds={values.interest_ids}
            onToggle={toggleInterest}
            onRetry={onRetryInterests}
          />
          <FieldError message={errors.interest_ids} />
        </FormSection>
      </fieldset>
    </div>
  );
}

/**
 * Multi-select interest chips backed by the server catalog. Toggling adds or
 * removes a single selection; at the limit, further selections are refused
 * with a clear message (deselection always stays possible). The parent owns
 * the selection state — this component only turns clicks into toggles.
 */
function InterestPicker({
  interests,
  interestsLoading,
  interestsError,
  selectedIds,
  onToggle,
  onRetry,
}: {
  interests: Interest[];
  interestsLoading: boolean;
  interestsError: string | null;
  selectedIds: string[];
  onToggle: (interestId: string) => void;
  onRetry?: () => void;
}) {
  const [refusedExtra, setRefusedExtra] = useState(false);
  const selectedCount = selectedIds.length;
  const atLimit = selectedCount >= MAX_INTERESTS;

  function handleToggle(interest: Interest) {
    const isSelected = selectedIds.includes(interest.id);
    if (!isSelected && atLimit) {
      setRefusedExtra(true);
      return;
    }
    setRefusedExtra(false);
    onToggle(interest.id);
  }

  return (
    <div>
      <div className="flex items-baseline justify-between gap-3">
        <p className="text-sm text-muted">
          Pick up to {MAX_INTERESTS} things you love.
        </p>
        <span className="shrink-0 text-xs font-medium text-muted">
          {selectedCount}/{MAX_INTERESTS}
        </span>
      </div>

      {interestsLoading ? (
        <p className="mt-3 text-sm text-muted">Loading interests…</p>
      ) : interestsError ? (
        <div className="mt-3 flex flex-wrap items-center gap-3">
          <p role="alert" className="text-sm font-medium text-red-600">
            {interestsError}
          </p>
          {onRetry && (
            <button
              type="button"
              onClick={onRetry}
              className={`rounded-full border border-line bg-surface px-3 py-1.5 text-xs font-semibold text-ink shadow-card transition-transform active:scale-[0.98] ${FOCUS_RING}`}
            >
              Retry
            </button>
          )}
        </div>
      ) : interests.length === 0 ? (
        <div className="mt-3 flex flex-wrap items-center gap-3">
          <p role="alert" className="text-sm font-medium text-red-600">
            No interests are available right now.
          </p>
          {onRetry && (
            <button
              type="button"
              onClick={onRetry}
              className={`rounded-full border border-line bg-surface px-3 py-1.5 text-xs font-semibold text-ink shadow-card transition-transform active:scale-[0.98] ${FOCUS_RING}`}
            >
              Retry
            </button>
          )}
        </div>
      ) : (
        <div className="mt-3 flex flex-wrap gap-2">
          {interests.map((interest) => {
            const selected = selectedIds.includes(interest.id);
            return (
              <button
                key={interest.id}
                type="button"
                aria-pressed={selected}
                onClick={() => handleToggle(interest)}
                className={`inline-flex items-center gap-1.5 rounded-full border px-4 py-2 text-sm font-medium transition-colors ${
                  selected
                    ? "border-accent bg-accent text-white shadow-card"
                    : "border-line bg-background text-ink hover:border-accent/50"
                } ${FOCUS_RING}`}
              >
                {selected && <CheckIcon className="size-3.5" />}
                {interest.name}
              </button>
            );
          })}
        </div>
      )}

      <p aria-live="polite" className="mt-2 min-h-5 text-xs font-medium">
        {refusedExtra || atLimit ? (
          <span className="text-accent">
            That&apos;s the maximum of {MAX_INTERESTS} interests — deselect one
            to pick another.
          </span>
        ) : (
          <span className="sr-only">
            {selectedCount} of {MAX_INTERESTS} interests selected
          </span>
        )}
      </p>
    </div>
  );
}

function CheckIcon({ className }: { className?: string }) {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={3}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      className={className}
    >
      <path d="m5 13 4 4L19 7" />
    </svg>
  );
}

function FieldError({ message }: { message: string | undefined }) {
  if (!message) {
    return null;
  }
  return (
    <p role="alert" className="mt-1.5 text-sm font-medium text-red-600">
      {message}
    </p>
  );
}
