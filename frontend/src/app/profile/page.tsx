"use client";

import Image from "next/image";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useState } from "react";

import { AppNav, TAB_BAR_SPACE } from "@/components/app-nav";
import { SignOutButton } from "@/components/sign-out-button";
import {
  Button,
  ButtonLink,
  Chip,
  Label,
  LoadingBlock,
  SuspendedState,
} from "@/components/ui";
import { isApiError, isSuspended, isUnauthorized } from "@/lib/api/http";
import { fetchMyApplications, isJoined } from "@/lib/api/opportunities";
import { cx } from "@/lib/format";
import { fetchPhotos, MAX_PHOTOS, type ProfilePhoto } from "@/lib/api/photos";
import {
  MOTIVATION_OPTIONS,
  fetchMyProfile,
  fetchUniversities,
  type Profile,
  type ProfileMotivation,
  type University,
} from "@/lib/api/profile";
import {
  fetchVerificationState,
  type VerificationStatus,
} from "@/lib/api/verification";

/**
 * /profile — ONE universal UniMatch profile, reused across every opportunity.
 * There is no per-opportunity profile and no per-activity variant.
 *
 * The view mirrors exactly what another student sees in people discovery —
 * photo, name, university and year, interests, short bio — plus the places the
 * student is going. Partner preference is shown as a neutral discovery
 * setting, not a dating preference, and legacy dating-era fields are never
 * rendered.
 */

export default function ProfilePage() {
  const router = useRouter();
  const [phase, setPhase] = useState<"loading" | "ready" | "error" | "suspended">(
    "loading",
  );
  const [profile, setProfile] = useState<Profile | null>(null);
  const [photos, setPhotos] = useState<ProfilePhoto[]>([]);
  const [universities, setUniversities] = useState<University[]>([]);
  const [goingCount, setGoingCount] = useState(0);
  const [verification, setVerification] =
    useState<VerificationStatus | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    const [profileData, photoCollection] = await Promise.all([
      fetchMyProfile(),
      fetchPhotos(),
    ]);
    setProfile(profileData);
    setPhotos(photoCollection.photos.filter((photo) => photo.url));
    // Display-only reference data: never fail the profile over it.
    fetchUniversities()
      .then(setUniversities)
      .catch(() => setUniversities([]));
    fetchVerificationState()
      .then((state) => setVerification(state.verification_status))
      .catch(() => setVerification(null));
    fetchMyApplications()
      .then((applications) =>
        setGoingCount(applications.filter(isJoined).length),
      )
      .catch(() => setGoingCount(0));
  }, []);

  useEffect(() => {
    void (async () => {
      try {
        await load();
        setPhase("ready");
      } catch (caught) {
        if (isUnauthorized(caught)) {
          router.replace("/login");
          return;
        }
        if (isSuspended(caught)) {
          setPhase("suspended");
          return;
        }
        if (isApiError(caught) && caught.code === "not_found") {
          router.replace("/onboarding");
          return;
        }
        setError(
          caught instanceof Error
            ? caught.message
            : "Something went wrong. Please try again.",
        );
        setPhase("error");
      }
    })();
  }, [load, router]);

  function retry() {
    setPhase("loading");
    setError(null);
    void load()
      .then(() => setPhase("ready"))
      .catch((caught: unknown) => {
        setError(
          caught instanceof Error
            ? caught.message
            : "Something went wrong. Please try again.",
        );
        setPhase("error");
      });
  }

  if (phase === "suspended") {
    return (
      <>
        <AppNav />
        <SuspendedState
          message="Your account has been suspended from participating in UniMatch."
          action={<SignOutButton />}
        />
      </>
    );
  }

  const primary =
    photos.find((photo) => photo.is_primary) ?? photos[0] ?? null;
  const extras = photos.filter((photo) => photo.id !== primary?.id);
  const name = profile?.first_name ?? "";

  return (
    <>
      <AppNav />
      <main className={`mx-auto w-full max-w-6xl px-5 sm:px-8 ${TAB_BAR_SPACE}`}>
        {phase === "loading" && <LoadingBlock label="Loading your profile" rows={4} />}

        {phase === "error" && (
          <div className="py-16">
            <h1 className="type-display text-display">Something went wrong</h1>
            <p role="alert" className="mt-4 max-w-md text-[15px] leading-relaxed text-muted">
              {error}
            </p>
            <Button
              variant="outline"
              className="mt-8"
              onClick={retry}
            >
              Try again
            </Button>
          </div>
        )}

        {phase === "ready" && profile && (
          <>
            {/* Photos lead — same priority they have in people discovery. */}
            <section className="animate-rise -mx-5 pt-0 sm:-mx-8">
              {primary?.url ? (
                <div className="relative h-[52svh] min-h-72 w-full bg-line/40">
                  <Image
                    src={primary.url}
                    alt="Your primary profile photo"
                    fill
                    priority
                    unoptimized
                    sizes="100vw"
                    className="object-cover"
                  />
                </div>
              ) : (
                <div className="grid h-64 place-items-center bg-accent/12">
                  <div className="text-center">
                    <span
                      aria-hidden
                      className="type-display text-6xl text-accent"
                    >
                      {name.charAt(0).toUpperCase()}
                    </span>
                    <p className="mt-3 text-sm font-semibold text-muted">
                      No photos yet
                    </p>
                  </div>
                </div>
              )}
            </section>

            <section className="mt-8 grid gap-10 md:grid-cols-12 md:gap-8">
              <div className="md:col-span-7">
                <Label>Your profile</Label>
                <h1 className="type-display mt-3 text-display">{name}</h1>

                <dl className="mt-6 divide-y divide-line border-y border-line">
                  <Row label="Studies">
                    {[profile.course, `Year ${profile.academic_year}`]
                      .filter(Boolean)
                      .join(" · ")}
                  </Row>
                  <Row label="University">
                    {/* A custom-university profile has no catalog row, so fall
                        back to the name the student typed. */}
                    {profile.custom_university_name ??
                      universities.find((item) => item.id === profile.university_id)
                        ?.name ??
                      "Added"}
                  </Row>
                  <Row label="Where from">{profile.hometown ?? "—"}</Row>
                  {/* Neutral partner-discovery preference, not a dating one. */}
                  <Row label="Who you'd like to discover">
                    {SEEKING_LABELS[profile.seeking_gender] ?? "Everyone"}
                  </Row>
                  <Row label="Going to">{goingCount} opportunities</Row>
                </dl>

                {profile.bio && (
                  <div className="mt-8">
                    <Label>About</Label>
                    <p className="mt-3 max-w-prose text-[17px] leading-relaxed">
                      {profile.bio}
                    </p>
                  </div>
                )}

                {profile.interests.length > 0 && (
                  <div className="mt-8">
                    <Label>Interests</Label>
                    <ul className="mt-3 flex flex-wrap gap-2">
                      {profile.interests.map((interest) => (
                        <li key={interest.id}>
                          <Chip tone={interest.source === "custom" ? "quiet" : "accent"}>
                            {interest.name}
                          </Chip>
                        </li>
                      ))}
                    </ul>
                  </div>
                )}

                {profile.motivations.length > 0 && (
                  <div className="mt-8">
                    <Label>Why I&apos;m here</Label>
                    <ul className="mt-3 flex flex-wrap gap-2">
                      {profile.motivations.map((motivation) => (
                        <li key={motivation}>
                          <Chip>{motivationLabel(motivation)}</Chip>
                        </li>
                      ))}
                    </ul>
                  </div>
                )}
              </div>

              <div className="md:col-span-5">
                <div className="border border-line bg-surface p-6 md:sticky md:top-24">
                  <Label>Photos</Label>
                  <p className="mt-2 text-sm text-muted">
                    {photos.length} of {MAX_PHOTOS} · the first one is what people
                    see first.
                  </p>

                  {extras.length > 0 && (
                    <ul className="mt-4 grid grid-cols-3 gap-2">
                      {extras.map((photo, index) => (
                        <li
                          key={photo.id}
                          className="relative aspect-square overflow-hidden bg-line/40"
                        >
                          <Image
                            src={photo.url ?? ""}
                            alt={`Profile photo ${index + 2}`}
                            fill
                            unoptimized
                            sizes="120px"
                            className="object-cover"
                          />
                        </li>
                      ))}
                    </ul>
                  )}

                  {/* Verification state is public-facing ("Verified student")
                      but carries no document, submission id, or reviewer
                      detail — only the coarse status. */}
                  <div className="mt-8 flex items-center gap-3">
                    <Chip tone={verification === "VERIFIED" ? "accent" : "quiet"}>
                      {VERIFICATION_LABELS[verification ?? "NONE"]}
                    </Chip>
                    {verification === "PENDING" && (
                      <Link
                        href="/verify"
                        className="text-sm font-semibold text-ink underline underline-offset-4"
                      >
                        Check status
                      </Link>
                    )}
                    {verification === "REJECTED" && (
                      <Link
                        href="/verify"
                        className="text-sm font-semibold text-accent underline underline-offset-4"
                      >
                        Fix and resubmit
                      </Link>
                    )}
                  </div>

                  <div className="mt-6 space-y-3">
                    <ButtonLink href="/profile/edit" className="w-full">
                      Edit profile
                    </ButtonLink>
                    {verification !== "VERIFIED" && (
                      <ButtonLink
                        href="/verify"
                        variant="outline"
                        className="w-full"
                      >
                        Student verification
                      </ButtonLink>
                    )}
                  </div>

                  <p className="mt-6 border-t border-line pt-4 text-xs leading-relaxed text-muted">
                    One profile, every opportunity. You don&apos;t need a
                    separate profile for anything you do.
                  </p>
                </div>
              </div>
            </section>

            <p className={cx("mt-10 text-sm text-muted", TAB_BAR_SPACE)}>
              <Link href="/explore" className="underline underline-offset-4 hover:text-ink">
                Back to what&apos;s happening
              </Link>
            </p>
          </>
        )}
      </main>
    </>
  );
}

const SEEKING_LABELS: Record<string, string> = {
  women: "Women",
  men: "Men",
  everyone: "Everyone",
};

/** Coarse status only — never a document, submission id, or reviewer detail. */
const VERIFICATION_LABELS: Record<string, string> = {
  VERIFIED: "✓ Verified student",
  PENDING: "Verification pending",
  REJECTED: "Verification needs attention",
  NONE: "Not verified yet",
};

function motivationLabel(motivation: ProfileMotivation): string {
  return (
    MOTIVATION_OPTIONS.find((option) => option.value === motivation)?.label ??
    motivation
  );
}

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex gap-6 py-3.5">
      <dt className="type-meta w-40 shrink-0 pt-1 text-muted">{label}</dt>
      <dd className="min-w-0 flex-1 text-[15px]">{children}</dd>
    </div>
  );
}