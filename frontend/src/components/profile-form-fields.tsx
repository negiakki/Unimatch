"use client";

import type {
  ProfileFieldErrors,
  ProfileFormValues,
  University,
} from "@/lib/api/profile";

/**
 * Presentational profile fields shared by the /onboarding creation form and
 * the /profile/edit form. Pure UI only — validation rules live in the
 * profile API module (UX checks) and the backend (authoritative).
 */

const FOCUS_RING =
  "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent focus-visible:ring-offset-2 focus-visible:ring-offset-background";

const INPUT_CLASSES = `w-full rounded-2xl border border-line bg-surface px-4 py-3.5 text-[15px] text-ink shadow-card placeholder:text-muted/60 focus:border-accent disabled:opacity-40 ${FOCUS_RING}`;

const ACADEMIC_YEARS = [1, 2, 3, 4, 5, 6, 7, 8];

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

interface ProfileFormFieldsProps {
  values: ProfileFormValues;
  errors: ProfileFieldErrors;
  universities: University[];
  universitiesLoading: boolean;
  disabled: boolean;
  onChange: (patch: Partial<ProfileFormValues>) => void;
}

export function ProfileFormFields({
  values,
  errors,
  universities,
  universitiesLoading,
  disabled,
  onChange,
}: ProfileFormFieldsProps) {
  const maxDate = todayIsoDate();

  return (
    <div className="text-left">
      <fieldset disabled={disabled} className="min-w-0">
        <h2 className="text-sm font-semibold uppercase tracking-wide text-muted">
          About you
        </h2>

        <label htmlFor="profile-first-name" className="mt-4 block text-sm font-semibold">
          First name
        </label>
        <input
          id="profile-first-name"
          type="text"
          autoComplete="given-name"
          placeholder="Jamie"
          maxLength={50}
          value={values.first_name}
          onChange={(event) => onChange({ first_name: event.target.value })}
          className={`mt-1.5 ${INPUT_CLASSES}`}
          aria-invalid={Boolean(errors.first_name)}
        />
        <FieldError message={errors.first_name} />

        <label
          htmlFor="profile-date-of-birth"
          className="mt-4 block text-sm font-semibold"
        >
          Date of birth
        </label>
        <input
          id="profile-date-of-birth"
          type="date"
          min="1900-01-01"
          max={maxDate}
          autoComplete="bday"
          value={values.date_of_birth}
          onChange={(event) => onChange({ date_of_birth: event.target.value })}
          className={`mt-1.5 ${INPUT_CLASSES}`}
          aria-invalid={Boolean(errors.date_of_birth)}
        />
        <FieldError message={errors.date_of_birth} />

        <h2 className="mt-8 text-sm font-semibold uppercase tracking-wide text-muted">
          Your studies
        </h2>

        <label
          htmlFor="profile-university"
          className="mt-4 block text-sm font-semibold"
        >
          University
        </label>
        <select
          id="profile-university"
          value={values.university_id}
          onChange={(event) => onChange({ university_id: event.target.value })}
          className={`mt-1.5 ${INPUT_CLASSES}`}
          aria-invalid={Boolean(errors.university_id)}
        >
          <option value="">
            {universitiesLoading ? "Loading universities…" : "Select your university"}
          </option>
          {universities.map((university) => (
            <option key={university.id} value={university.id}>
              {universityLabel(university)}
            </option>
          ))}
        </select>
        <FieldError message={errors.university_id} />

        <label htmlFor="profile-course" className="mt-4 block text-sm font-semibold">
          Course
        </label>
        <input
          id="profile-course"
          type="text"
          autoComplete="off"
          placeholder="Computer Science"
          maxLength={120}
          value={values.course}
          onChange={(event) => onChange({ course: event.target.value })}
          className={`mt-1.5 ${INPUT_CLASSES}`}
          aria-invalid={Boolean(errors.course)}
        />
        <FieldError message={errors.course} />

        <label
          htmlFor="profile-academic-year"
          className="mt-4 block text-sm font-semibold"
        >
          Academic year
        </label>
        <select
          id="profile-academic-year"
          value={values.academic_year}
          onChange={(event) => onChange({ academic_year: event.target.value })}
          className={`mt-1.5 ${INPUT_CLASSES}`}
          aria-invalid={Boolean(errors.academic_year)}
        >
          <option value="">Select your year</option>
          {ACADEMIC_YEARS.map((year) => (
            <option key={year} value={String(year)}>
              Year {year}
            </option>
          ))}
        </select>
        <FieldError message={errors.academic_year} />

        <h2 className="mt-8 text-sm font-semibold uppercase tracking-wide text-muted">
          About your dating profile
        </h2>

        <label htmlFor="profile-gender" className="mt-4 block text-sm font-semibold">
          Gender
        </label>
        <select
          id="profile-gender"
          value={values.gender}
          onChange={(event) => onChange({ gender: event.target.value })}
          className={`mt-1.5 ${INPUT_CLASSES}`}
          aria-invalid={Boolean(errors.gender)}
        >
          <option value="">Select your gender</option>
          {GENDERS.map((option) => (
            <option key={option.value} value={option.value}>
              {option.label}
            </option>
          ))}
        </select>
        <FieldError message={errors.gender} />

        <label
          htmlFor="profile-seeking-gender"
          className="mt-4 block text-sm font-semibold"
        >
          Interested in
        </label>
        <select
          id="profile-seeking-gender"
          value={values.seeking_gender}
          onChange={(event) => onChange({ seeking_gender: event.target.value })}
          className={`mt-1.5 ${INPUT_CLASSES}`}
          aria-invalid={Boolean(errors.seeking_gender)}
        >
          <option value="">Select who you&apos;d like to meet</option>
          {SEEKING_GENDERS.map((option) => (
            <option key={option.value} value={option.value}>
              {option.label}
            </option>
          ))}
        </select>
        <FieldError message={errors.seeking_gender} />

        <label
          htmlFor="profile-relationship-intent"
          className="mt-4 block text-sm font-semibold"
        >
          Looking for <span className="font-normal text-muted">(optional)</span>
        </label>
        <select
          id="profile-relationship-intent"
          value={values.relationship_intent}
          onChange={(event) => onChange({ relationship_intent: event.target.value })}
          className={`mt-1.5 ${INPUT_CLASSES}`}
        >
          <option value="">Prefer not to say</option>
          {RELATIONSHIP_INTENTS.map((option) => (
            <option key={option.value} value={option.value}>
              {option.label}
            </option>
          ))}
        </select>

        <label htmlFor="profile-height" className="mt-4 block text-sm font-semibold">
          Height in cm <span className="font-normal text-muted">(optional)</span>
        </label>
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
          className={`mt-1.5 ${INPUT_CLASSES}`}
          aria-invalid={Boolean(errors.height_cm)}
        />
        <FieldError message={errors.height_cm} />

        <label htmlFor="profile-hometown" className="mt-4 block text-sm font-semibold">
          Hometown <span className="font-normal text-muted">(optional)</span>
        </label>
        <input
          id="profile-hometown"
          type="text"
          autoComplete="off"
          placeholder="Springfield"
          maxLength={100}
          value={values.hometown}
          onChange={(event) => onChange({ hometown: event.target.value })}
          className={`mt-1.5 ${INPUT_CLASSES}`}
          aria-invalid={Boolean(errors.hometown)}
        />
        <FieldError message={errors.hometown} />

        <label htmlFor="profile-bio" className="mt-4 block text-sm font-semibold">
          Bio
        </label>
        <textarea
          id="profile-bio"
          rows={4}
          placeholder="Tell people a little about yourself…"
          value={values.bio}
          onChange={(event) => onChange({ bio: event.target.value })}
          className={`mt-1.5 ${INPUT_CLASSES} resize-none`}
          aria-invalid={Boolean(errors.bio)}
        />
        <div className="mt-1 flex items-baseline justify-between gap-3">
          <FieldError message={errors.bio} />
          <span className="ml-auto shrink-0 text-xs text-muted">
            {values.bio.trim().length}/500
          </span>
        </div>
      </fieldset>
    </div>
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
