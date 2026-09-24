"use client";

import Image from "next/image";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useState } from "react";

import {
  MAX_PHOTOS,
  PhotoApiError,
  fetchPhotos,
  type ProfilePhoto,
} from "@/lib/api/photos";
import {
  MOTIVATION_OPTIONS,
  ProfileApiError,
  fetchMyProfile,
  type Profile,
  type ProfileInterest,
  type ProfileMotivation,
  type ProfileRelationshipIntent,
  type University,
  fetchUniversities,
} from "@/lib/api/profile";

/**
 * Profile presentation for the signed-in user's own profile — how other
 * students see them. Reads GET /profiles/me + /profiles/me/photos; ownership
 * is decided server-side from the session token and nothing here is editable
 * (editing lives in /profile/edit, reusing the same APIs). Optional fields
 * are rendered only when they actually have values.
 */

const FOCUS_RING =
  "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent focus-visible:ring-offset-2 focus-visible:ring-offset-background";

const GENDER_LABELS: Record<string, string> = {
  woman: "Woman",
  man: "Man",
  non_binary: "Non-binary",
  other: "Other",
};

const INTENT_LABELS: Record<string, string> = {
  casual: "Casual",
  serious: "Serious relationship",
  friendship: "Friendship",
  not_sure: "Not sure yet",
};

function messageFor(error: unknown): string {
  if (error instanceof ProfileApiError || error instanceof PhotoApiError) {
    return error.message;
  }
  return "Something went wrong. Please try again.";
}

function ageFromDob(dateOfBirth: string): number | null {
  const birth = new Date(`${dateOfBirth}T00:00:00`);
  if (Number.isNaN(birth.getTime())) {
    return null;
  }
  const today = new Date();
  let age = today.getFullYear() - birth.getFullYear();
  const beforeBirthday =
    today.getMonth() < birth.getMonth() ||
    (today.getMonth() === birth.getMonth() && today.getDate() < birth.getDate());
  if (beforeBirthday) {
    age -= 1;
  }
  return age;
}

function Chip({
  children,
  accent = false,
}: {
  children: React.ReactNode;
  accent?: boolean;
}) {
  return (
    <span
      className={`inline-flex items-center rounded-full px-3 py-1.5 text-sm font-medium ${
        accent ? "bg-accent/15 text-accent" : "border border-line bg-surface text-ink"
      }`}
    >
      {children}
    </span>
  );
}

function SectionHeading({ children }: { children: React.ReactNode }) {
  return (
    <h2 className="text-xs font-semibold uppercase tracking-wide text-muted">
      {children}
    </h2>
  );
}

function intentLabel(intent: ProfileRelationshipIntent): string {
  return INTENT_LABELS[intent] ?? intent;
}

function motivationLabel(motivation: ProfileMotivation): string {
  return (
    MOTIVATION_OPTIONS.find((option) => option.value === motivation)?.label ??
    motivation
  );
}

function InterestChip({ interest }: { interest: ProfileInterest }) {
  return (
    <span
      className={`inline-flex items-center rounded-full px-3 py-1.5 text-sm font-medium ${
        interest.source === "custom"
          ? "border border-accent/40 bg-accent/10 text-ink"
          : "bg-accent/15 text-accent"
      }`}
    >
      {interest.name}
    </span>
  );
}

export function ProfileView() {
  const router = useRouter();
  const [phase, setPhase] = useState<"loading" | "ready" | "error">("loading");
  const [loadError, setLoadError] = useState<string | null>(null);
  const [profile, setProfile] = useState<Profile | null>(null);
  const [photos, setPhotos] = useState<ProfilePhoto[]>([]);
  const [universities, setUniversities] = useState<University[]>([]);
  const [reloadKey, setReloadKey] = useState(0);

  const load = useCallback(async () => {
    // Universities are display-only reference data — a failed catalog load
    // hides the university name but must not fail the whole profile view.
    const [profileData, photoCollection] = await Promise.all([
      fetchMyProfile(),
      fetchPhotos(),
    ]);
    setProfile(profileData);
    setPhotos(photoCollection.photos);
    try {
      setUniversities(await fetchUniversities());
    } catch (error) {
      console.error("Failed to load universities:", error);
    }
  }, []);

  useEffect(() => {
    void (async () => {
      try {
        await load();
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
  }, [load, router, reloadKey]);

  const retry = useCallback(() => {
    setPhase("loading");
    setLoadError(null);
    setReloadKey((key) => key + 1);
  }, []);

  if (phase === "loading") {
    return (
      <section className="pt-10" aria-busy="true" aria-live="polite">
        <span className="sr-only">Loading your profile</span>
        <div className="aspect-[4/5] animate-pulse rounded-card bg-line" />
        <div className="mt-5 h-8 w-48 animate-pulse rounded-full bg-line" />
        <div className="mt-3 h-4 w-64 max-w-full animate-pulse rounded-full bg-line" />
        <div className="mt-8 h-40 rounded-card border border-line bg-surface shadow-card" />
      </section>
    );
  }

  if (phase === "error" || !profile) {
    return (
      <section className="pt-14 text-center">
        <h1 className="text-3xl font-bold tracking-tight">Something went wrong</h1>
        <p
          role="alert"
          className="mx-auto mt-3 max-w-sm text-[15px] leading-relaxed text-muted"
        >
          {loadError ?? messageFor(null)}
        </p>
        <button
          type="button"
          onClick={retry}
          className={`mt-8 w-full rounded-2xl border border-line bg-surface py-3.5 font-semibold text-ink shadow-card transition-transform active:scale-[0.98] ${FOCUS_RING}`}
        >
          Try again
        </button>
      </section>
    );
  }

  const firstName = profile.first_name;
  const age = ageFromDob(profile.date_of_birth);
  const university = universities.find(
    (candidate) => candidate.id === profile.university_id,
  );
  const gender = GENDER_LABELS[profile.gender] ?? null;
  const photosWithUrls = photos.filter((photo) => photo.url);
  const primaryPhoto = photosWithUrls.find((photo) => photo.is_primary) ?? photosWithUrls[0];
  const extraPhotos = photosWithUrls.filter((photo) => photo.id !== primaryPhoto?.id);

  const chips = [
    gender,
    `${profile.course} · Year ${profile.academic_year}`,
    profile.height_cm !== null ? `${profile.height_cm} cm` : null,
    profile.hometown ? `From ${profile.hometown}` : null,
  ].filter((chip): chip is string => chip !== null);

  const studyLine = university ? university.name : null;

  return (
    <section className="pt-10">
      {/* Photos — the primary photo leads, extras follow in a strip. */}
      {primaryPhoto?.url ? (
        <>
          <div className="relative aspect-[4/5] overflow-hidden rounded-card border border-line bg-background shadow-card">
            <Image
              src={primaryPhoto.url}
              alt="Your primary profile photo"
              fill
              priority
              unoptimized
              sizes="(max-width: 512px) 100vw, 512px"
              className="object-cover"
            />
            <div className="pointer-events-none absolute inset-x-0 bottom-0 bg-linear-to-t from-black/70 via-black/30 to-transparent px-5 pb-4 pt-16">
              <h1 className="text-3xl font-bold tracking-tight text-white">
                {firstName}
                {age !== null && <span>, {age}</span>}
              </h1>
              {studyLine && (
                <p className="mt-1 text-sm font-medium text-white/90">{studyLine}</p>
              )}
            </div>
          </div>

          {extraPhotos.length > 0 && (
            <div className="mt-3 grid grid-cols-3 gap-3">
              {extraPhotos.map((photo, index) => (
                <div
                  key={photo.id}
                  className="relative aspect-square overflow-hidden rounded-2xl border border-line bg-background shadow-card"
                >
                  <Image
                    src={photo.url ?? ""}
                    alt={`Your profile photo ${index + 2}`}
                    fill
                    unoptimized
                    sizes="(max-width: 640px) 33vw, 160px"
                    className="object-cover"
                  />
                </div>
              ))}
            </div>
          )}
        </>
      ) : (
        /* Empty state — no photos yet. */
        <div className="relative aspect-[4/5] overflow-hidden rounded-card border border-line bg-accent/5 shadow-card">
          <div className="grid size-full place-items-center">
            <div className="text-center">
              <span
                aria-hidden
                className="inline-grid size-16 place-items-center rounded-2xl bg-accent/15 text-4xl font-bold text-accent"
              >
                {firstName.charAt(0).toUpperCase()}
              </span>
              <p className="mt-4 text-lg font-semibold">No photos yet</p>
              <p className="mx-auto mt-1 max-w-xs text-sm leading-relaxed text-muted">
                Photos are the first thing other students see — add one to make
                your profile shine.
              </p>
            </div>
          </div>
        </div>
      )}

      {/* Chips — identity and optional facts, only when present. */}
      {(chips.length > 0 || studyLine) && (
        <div className="mt-5 flex flex-wrap gap-2">
          {studyLine && <Chip accent>{studyLine}</Chip>}
          {chips.map((chip) => (
            <Chip key={chip}>{chip}</Chip>
          ))}
        </div>
      )}

      {profile.bio && (
        <div className="mt-8">
          <SectionHeading>About</SectionHeading>
          <p className="mt-2 text-[15px] leading-relaxed text-ink">{profile.bio}</p>
        </div>
      )}

      {(profile.relationship_intent !== null || profile.motivations.length > 0) && (
        <div className="mt-8">
          <SectionHeading>Looking for</SectionHeading>
          <div className="mt-2 flex flex-wrap gap-2">
            {profile.relationship_intent !== null && (
              <Chip accent>{intentLabel(profile.relationship_intent)}</Chip>
            )}
            {profile.motivations.map((motivation) => (
              <Chip key={motivation}>{motivationLabel(motivation)}</Chip>
            ))}
          </div>
        </div>
      )}

      {profile.interests.length > 0 && (
        <div className="mt-8">
          <SectionHeading>Interests</SectionHeading>
          <div className="mt-2 flex flex-wrap gap-2">
            {profile.interests.map((interest) => (
              <InterestChip key={interest.id} interest={interest} />
            ))}
          </div>
        </div>
      )}

      <div className="mt-10">
        <Link
          href="/profile/edit"
          className={`block w-full rounded-2xl bg-accent py-3.5 text-center font-semibold text-white shadow-card transition-transform active:scale-[0.98] ${FOCUS_RING}`}
        >
          Edit profile
        </Link>
        <p className="mt-3 text-center text-xs text-muted">
          {photosWithUrls.length} of {MAX_PHOTOS} photos · manage them from the
          editor
        </p>
      </div>
    </section>
  );
}
