"use client";

import { useState } from "react";

import { cx } from "@/lib/format";
import { Label } from "@/components/ui";

import type { Interest } from "@/lib/api/interests";
import {
  CUSTOM_UNIVERSITY_ID,
  MAX_COMBINED_INTERESTS,
  MAX_CUSTOM_INTEREST_LENGTH,
  MAX_CUSTOM_UNIVERSITY_NAME_LENGTH,
  MOTIVATION_OPTIONS,
  type ProfileFieldErrors,
  type ProfileFormValues,
  type ProfileMotivation,
  type University,
} from "@/lib/api/profile";

/**
 * Presentational profile fields shared by the /onboarding wizard and the
 * /profile/edit form. Pure UI — validation rules live in the profile API
 * module (UX checks) and the backend (authoritative).
 *
 * V1 exposes no relationship-intent control: that column is legacy, so it is
 * neither asked for nor rendered (it round-trips through the form values
 * untouched instead).
 */

const INPUT_CLASSES =
  "w-full border border-line bg-surface px-4 py-3 text-[15px] text-ink placeholder:text-muted/60 focus:border-ink disabled:opacity-40";

// Product scope: UniMatch covers years 1–6 end to end (UI, API, DB).
const ACADEMIC_YEARS = [1, 2, 3, 4, 5, 6];

export const GENDERS: { value: string; label: string }[] = [
  { value: "woman", label: "Woman" },
  { value: "man", label: "Man" },
  { value: "non_binary", label: "Non-binary" },
  { value: "other", label: "Other" },
];

/** Partner-discovery preference, deliberately not a dating preference. */
export const SEEKING_GENDERS: { value: string; label: string }[] = [
  { value: "everyone", label: "Everyone" },
  { value: "women", label: "Women" },
  { value: "men", label: "Men" },
];

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
  children: React.ReactNode;
}) {
  return (
    <section className="border-t border-line pt-6">
      <Label>{title}</Label>
      {hint && (
        <p className="mt-2 max-w-prose text-sm leading-relaxed text-muted">
          {hint}
        </p>
      )}
      <div className="mt-5 space-y-5">{children}</div>
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
  children: React.ReactNode;
}) {
  return (
    <div>
      <label htmlFor={id} className="block text-sm font-semibold">
        {label}
        {optional && <span className="font-normal text-muted"> (optional)</span>}
      </label>
      <div className="mt-2">{children}</div>
      <FieldError message={error} />
    </div>
  );
}

/** Controlled values + change pipeline shared by every field group. */
export interface ProfileFieldGroupProps {
  values: ProfileFormValues;
  errors: ProfileFieldErrors;
  onChange: (patch: Partial<ProfileFormValues>) => void;
}

export function BasicsFields({
  values,
  errors,
  onChange,
}: ProfileFieldGroupProps) {
  const maxDate = new Date().toISOString().slice(0, 10);

  return (
    <>
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

      {/*
        Partner discovery, stated neutrally: this filters WHO turns up in an
        opportunity's feed. It is not a dating or relationship preference.
      */}
      <Field
        id="profile-seeking-gender"
        label="Who would you like to discover?"
        error={errors.seeking_gender}
      >
        <select
          id="profile-seeking-gender"
          value={values.seeking_gender}
          onChange={(event) => onChange({ seeking_gender: event.target.value })}
          className={INPUT_CLASSES}
          aria-invalid={Boolean(errors.seeking_gender)}
        >
          <option value="">Select one</option>
          {SEEKING_GENDERS.map((option) => (
            <option key={option.value} value={option.value}>
              {option.label}
            </option>
          ))}
        </select>
        <p className="mt-2 text-xs leading-relaxed text-muted">
          This decides who you&apos;re shown inside each opportunity&apos;s
          people feed.
        </p>
      </Field>
    </>
  );
}

export function StudiesFields({
  values,
  errors,
  onChange,
  universities,
  universitiesLoading,
}: ProfileFieldGroupProps & {
  universities: University[];
  universitiesLoading: boolean;
}) {
  const usesCustomUniversity = values.university_id === CUSTOM_UNIVERSITY_ID;
  return (
    <>
      <Field id="profile-university" label="University" error={errors.university_id}>
        <select
          id="profile-university"
          value={values.university_id}
          onChange={(event) =>
            // Clearing the typed name when switching back to a catalog pick
            // keeps the form consistent with the exactly-one API rule.
            onChange({
              university_id: event.target.value,
              custom_university_name:
                event.target.value === CUSTOM_UNIVERSITY_ID
                  ? values.custom_university_name
                  : "",
            })
          }
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
          <option value={CUSTOM_UNIVERSITY_ID}>My university isn&apos;t listed</option>
        </select>
      </Field>

      {usesCustomUniversity && (
        <Field
          id="profile-custom-university"
          label="Your university's name"
          error={errors.custom_university_name}
        >
          <input
            id="profile-custom-university"
            type="text"
            autoComplete="off"
            placeholder="e.g. Forest Research Institute"
            maxLength={MAX_CUSTOM_UNIVERSITY_NAME_LENGTH}
            value={values.custom_university_name}
            onChange={(event) =>
              onChange({ custom_university_name: event.target.value })
            }
            className={INPUT_CLASSES}
            aria-invalid={Boolean(errors.custom_university_name)}
          />
        </Field>
      )}

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
    </>
  );
}

export function AboutFields({ values, errors, onChange }: ProfileFieldGroupProps) {
  return (
    <Field id="profile-bio" label="Short bio" error={errors.bio}>
      <textarea
        id="profile-bio"
        rows={4}
        placeholder="What are you usually up to?"
        value={values.bio}
        onChange={(event) => onChange({ bio: event.target.value })}
        className={cx(INPUT_CLASSES, "resize-none")}
        aria-invalid={Boolean(errors.bio)}
      />
      <div className="mt-1 flex items-baseline justify-between gap-3">
        <FieldError message={errors.bio} />
        <span className="ml-auto shrink-0 text-xs text-muted">
          {values.bio.trim().length}/500
        </span>
      </div>
    </Field>
  );
}

export function MotivationsFields({
  values,
  errors,
  onChange,
}: ProfileFieldGroupProps) {
  function toggle(motivation: ProfileMotivation) {
    const next = values.motivations.includes(motivation)
      ? values.motivations.filter((value) => value !== motivation)
      : [...values.motivations, motivation];
    onChange({ motivations: next });
  }

  return (
    <div>
      <ul className="flex flex-wrap gap-2">
        {MOTIVATION_OPTIONS.map((option) => {
          const selected = values.motivations.includes(option.value);
          return (
            <li key={option.value}>
              <button
                type="button"
                aria-pressed={selected}
                onClick={() => toggle(option.value)}
                className={cx(
                  "rounded-full border px-4 py-2 text-sm font-medium transition-colors",
                  selected
                    ? "border-transparent bg-accent text-accent-ink"
                    : "border-line bg-surface text-ink hover:border-ink",
                )}
              >
                {selected && <CheckIcon className="mr-1.5 inline size-3.5" />}
                {option.label}
              </button>
            </li>
          );
        })}
      </ul>
      <FieldError message={errors.motivations} />
    </div>
  );
}

export function InterestsPickerFields({
  values,
  errors,
  onChange,
  interests,
  interestsLoading,
  interestsError,
  onRetryInterests,
}: ProfileFieldGroupProps & {
  interests: Interest[];
  interestsLoading: boolean;
  interestsError: string | null;
  onRetryInterests?: () => void;
}) {
  return (
    <>
      <InterestPicker
        interests={interests}
        interestsLoading={interestsLoading}
        interestsError={interestsError}
        selectedIds={values.interest_ids}
        customNames={values.custom_interest_names}
        onToggle={(id) =>
          onChange({
            interest_ids: values.interest_ids.includes(id)
              ? values.interest_ids.filter((value) => value !== id)
              : [...values.interest_ids, id],
          })
        }
        onAddCustom={(name) =>
          onChange({ custom_interest_names: [...values.custom_interest_names, name] })
        }
        onRemoveCustom={(name) =>
          onChange({
            custom_interest_names: values.custom_interest_names.filter(
              (existing) => existing !== name,
            ),
          })
        }
        onRetry={onRetryInterests}
      />
      <FieldError message={errors.interest_ids} />
      <FieldError message={errors.custom_interest_names} />
    </>
  );
}

export function OptionalFields({
  values,
  errors,
  onChange,
}: ProfileFieldGroupProps) {
  return (
    <>
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
    </>
  );
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
}: {
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
}) {
  return (
    <fieldset disabled={disabled} className="min-w-0 space-y-10">
      <FormSection title="The basics">
        <BasicsFields values={values} errors={errors} onChange={onChange} />
      </FormSection>

      <FormSection
        title="Your studies"
        hint="Your university is matched against your student ID during verification."
      >
        <StudiesFields
          values={values}
          errors={errors}
          onChange={onChange}
          universities={universities}
          universitiesLoading={universitiesLoading}
        />
      </FormSection>

      <FormSection
        title="About you"
        hint="This is what other students read after your photo."
      >
        <AboutFields values={values} errors={errors} onChange={onChange} />
      </FormSection>

      <FormSection title="Optional details">
        <OptionalFields values={values} errors={errors} onChange={onChange} />
      </FormSection>

      <FormSection title="Why I'm here" hint="Pick every reason that applies.">
        <MotivationsFields values={values} errors={errors} onChange={onChange} />
      </FormSection>

      <FormSection title="Your interests">
        <InterestsPickerFields
          values={values}
          errors={errors}
          onChange={onChange}
          interests={interests}
          interestsLoading={interestsLoading}
          interestsError={interestsError}
          onRetryInterests={onRetryInterests}
        />
      </FormSection>
    </fieldset>
  );
}

/**
 * Interest chips backed by the server catalog plus user-created entries.
 * Catalog and custom share one budget; at the limit, additions are refused with
 * a clear message while deselection stays possible. Parent owns the state.
 */
function InterestPicker({
  interests,
  interestsLoading,
  interestsError,
  selectedIds,
  customNames,
  onToggle,
  onAddCustom,
  onRemoveCustom,
  onRetry,
}: {
  interests: Interest[];
  interestsLoading: boolean;
  interestsError: string | null;
  selectedIds: string[];
  customNames: string[];
  onToggle: (interestId: string) => void;
  onAddCustom: (name: string) => void;
  onRemoveCustom: (name: string) => void;
  onRetry?: () => void;
}) {
  const [draft, setDraft] = useState("");
  const [notice, setNotice] = useState<string | null>(null);
  const count = selectedIds.length + customNames.length;
  const atLimit = count >= MAX_COMBINED_INTERESTS;
  const limitMessage = `That's the maximum of ${MAX_COMBINED_INTERESTS} interests — deselect one to pick another.`;

  function handleToggle(interest: Interest) {
    const selected = selectedIds.includes(interest.id);
    if (!selected && atLimit) {
      setNotice(limitMessage);
      return;
    }
    setNotice(null);
    onToggle(interest.id);
  }

  function handleAddCustom() {
    const name = draft.trim();
    if (!name) {
      return;
    }
    if (name.length > MAX_CUSTOM_INTEREST_LENGTH) {
      setNotice(`Custom interests must be ${MAX_CUSTOM_INTEREST_LENGTH} characters or fewer.`);
      return;
    }
    const folded = name.toLowerCase();
    if (interests.some((interest) => interest.name.toLowerCase() === folded)) {
      setNotice(`"${name}" is already in the catalog — select it from the chips.`);
      return;
    }
    if (customNames.some((existing) => existing.toLowerCase() === folded)) {
      setNotice("You've already added that one.");
      return;
    }
    if (atLimit) {
      setNotice(limitMessage);
      return;
    }
    setNotice(null);
    onAddCustom(name);
    setDraft("");
  }

  return (
    <div>
      <div className="flex items-baseline justify-between gap-3">
        <p className="text-sm text-muted">
          Up to {MAX_COMBINED_INTERESTS} things you&apos;re into — add your own
          if they&apos;re missing.
        </p>
        <span className="shrink-0 text-xs font-medium text-muted">
          {count}/{MAX_COMBINED_INTERESTS}
        </span>
      </div>

      {interestsLoading ? (
        <p className="mt-4 text-sm text-muted">Loading interests…</p>
      ) : interestsError ? (
        <div className="mt-4 flex flex-wrap items-center gap-3">
          <p role="alert" className="text-sm text-danger">
            {interestsError}
          </p>
          {onRetry && (
            <button
              type="button"
              onClick={onRetry}
              className="rounded-full border border-line bg-surface px-3 py-1.5 text-xs font-semibold text-ink"
            >
              Retry
            </button>
          )}
        </div>
      ) : (
        <ul className="mt-4 flex flex-wrap gap-2">
          {interests.map((interest) => {
            const selected = selectedIds.includes(interest.id);
            return (
              <li key={interest.id}>
                <button
                  type="button"
                  aria-pressed={selected}
                  onClick={() => handleToggle(interest)}
                  className={cx(
                    "rounded-full border px-4 py-2 text-sm font-medium transition-colors",
                    selected
                      ? "border-transparent bg-accent text-accent-ink"
                      : "border-line bg-surface text-ink hover:border-ink",
                  )}
                >
                  {selected && <CheckIcon className="mr-1.5 inline size-3.5" />}
                  {interest.name}
                </button>
              </li>
            );
          })}
          {customNames.map((name) => (
            <li key={name}>
              <span className="inline-flex items-center gap-1.5 rounded-full border border-accent bg-accent/12 px-4 py-2 text-sm font-medium text-ink">
                {name}
                <button
                  type="button"
                  aria-label={`Remove ${name}`}
                  onClick={() => {
                    setNotice(null);
                    onRemoveCustom(name);
                  }}
                  className="text-muted transition-colors hover:text-ink"
                >
                  <XIcon className="size-3.5" />
                </button>
              </span>
            </li>
          ))}
        </ul>
      )}

      {!interestsLoading && !interestsError && (
        <div className="mt-4 flex max-w-sm items-center gap-2">
          <input
            id="profile-custom-interest"
            type="text"
            autoComplete="off"
            placeholder="Add your own…"
            maxLength={MAX_CUSTOM_INTEREST_LENGTH + 1}
            value={draft}
            onChange={(event) => setDraft(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter") {
                event.preventDefault();
                handleAddCustom();
              }
            }}
            className={INPUT_CLASSES}
          />
          <button
            type="button"
            onClick={handleAddCustom}
            className="shrink-0 border border-line bg-surface px-4 py-3 text-sm font-semibold text-ink transition-colors hover:border-ink"
          >
            Add
          </button>
        </div>
      )}

      <p aria-live="polite" className="mt-2 min-h-5 text-xs font-medium text-accent">
        {notice}
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

function XIcon({ className }: { className?: string }) {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={2.5}
      strokeLinecap="round"
      aria-hidden="true"
      className={className}
    >
      <path d="M6 6l12 12M18 6L6 18" />
    </svg>
  );
}

function FieldError({ message }: { message: string | undefined }) {
  if (!message) {
    return null;
  }
  return (
    <p role="alert" className="mt-2 text-sm font-medium text-danger">
      {message}
    </p>
  );
}