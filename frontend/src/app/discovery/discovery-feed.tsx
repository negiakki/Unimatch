"use client";

import Image from "next/image";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useRef, useState } from "react";

import {
  DiscoveryApiError,
  fetchDiscoveryFeed,
  type DiscoveryCandidate,
} from "@/lib/api/discovery";
import {
  DatingApiError,
  likeCandidate,
  passCandidate,
  type MatchInfo,
} from "@/lib/api/dating";

/**
 * Discovery feed — one candidate card at a time, with like/pass actions.
 *
 * Loads pages through GET /discovery/feed with the existing Supabase session.
 * PASS (swipe left) and LIKE (swipe right) record the action via
 * /discovery/{id}/pass|like and advance to the next candidate; a mutual like
 * returns the canonical match and opens the match celebration. The buttons
 * below the card are the non-gesture fallback and remain fully usable.
 *
 * Candidates are client-safe projections from the backend: age (never the
 * raw date of birth), signed photo URLs (never storage paths), and no
 * verification status are ever rendered here because they are never sent.
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

const SWIPE_THRESHOLD_PX = 72;
const EXIT_ANIMATION_MS = 180;

function messageFor(error: unknown): string {
  if (error instanceof DiscoveryApiError || error instanceof DatingApiError) {
    return error.message;
  }
  return "Something went wrong. Please try again.";
}

/** Photo URL — the backend may return photos without a signed URL. */
function displayable(candidate: DiscoveryCandidate) {
  return candidate.photos.filter((photo) => photo.url);
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

const PHOTO_TAP_ZONE_CLASSES =
  "absolute inset-y-0 w-1/2 cursor-pointer focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white focus-visible:ring-inset";

function CandidateCard({ candidate }: { candidate: DiscoveryCandidate }) {
  const photos = displayable(candidate);
  const [photoIndex, setPhotoIndex] = useState(0);
  const activeIndex = photos.length ? Math.min(photoIndex, photos.length - 1) : 0;
  const active = photos[activeIndex];

  const firstName = candidate.first_name ?? "Student";
  const gender =
    candidate.gender !== null ? GENDER_LABELS[candidate.gender] : null;
  const intent =
    candidate.relationship_intent !== null
      ? INTENT_LABELS[candidate.relationship_intent]
      : null;
  const prompts = candidate.profile_prompts.filter(
    (item) => typeof item?.prompt === "string" && typeof item?.answer === "string",
  );

  const universityPlace = [candidate.university.name, candidate.university.city]
    .filter(Boolean)
    .join(" · ");
  const studyLine = [
    candidate.course,
    candidate.academic_year !== null ? `Year ${candidate.academic_year}` : null,
  ]
    .filter(Boolean)
    .join(" · ");

  function step(offset: -1 | 1) {
    if (photos.length < 2) {
      return;
    }
    setPhotoIndex(
      (current) => (current + offset + photos.length) % photos.length,
    );
  }

  return (
    <article className="overflow-hidden rounded-card border border-line bg-surface shadow-card">
      <div className="relative aspect-[4/5] bg-background">
        {active?.url ? (
          <Image
            key={active.id}
            src={active.url}
            alt={`${firstName}'s photo ${activeIndex + 1} of ${photos.length}`}
            fill
            priority
            unoptimized
            sizes="(max-width: 512px) 100vw, 512px"
            className="object-cover"
          />
        ) : (
          <div className="grid size-full place-items-center bg-accent/10">
            <span aria-hidden className="text-7xl font-bold text-accent">
              {firstName.charAt(0).toUpperCase()}
            </span>
          </div>
        )}

        {photos.length > 1 && (
          <>
            <div
              className="absolute inset-x-4 top-3 flex gap-1.5"
              aria-hidden="true"
            >
              {photos.map((photo, index) => (
                <span
                  key={photo.id}
                  className={`h-1 flex-1 rounded-full transition-colors ${
                    index === activeIndex ? "bg-white" : "bg-white/40"
                  }`}
                />
              ))}
            </div>
            <button
              type="button"
              onClick={() => step(-1)}
              aria-label="Previous photo"
              className={`${PHOTO_TAP_ZONE_CLASSES} left-0`}
            />
            <button
              type="button"
              onClick={() => step(1)}
              aria-label="Next photo"
              className={`${PHOTO_TAP_ZONE_CLASSES} right-0`}
            />
            <p aria-live="polite" className="sr-only">
              Photo {activeIndex + 1} of {photos.length}
            </p>
          </>
        )}

        <div className="pointer-events-none absolute inset-x-0 bottom-0 bg-linear-to-t from-black/70 via-black/30 to-transparent px-5 pb-4 pt-16">
          <h2 className="text-3xl font-bold tracking-tight text-white">
            {firstName}
            {candidate.age !== null && <span>, {candidate.age}</span>}
          </h2>
          {universityPlace && (
            <p className="mt-1 text-sm font-medium text-white/90">
              {universityPlace}
            </p>
          )}
        </div>
      </div>

      <div className="p-5">
        {(intent || gender || studyLine || candidate.height_cm !== null || candidate.hometown) && (
          <div className="flex flex-wrap gap-2">
            {intent && <Chip accent>{intent}</Chip>}
            {gender && <Chip>{gender}</Chip>}
            {studyLine && <Chip>{studyLine}</Chip>}
            {candidate.height_cm !== null && <Chip>{candidate.height_cm} cm</Chip>}
            {candidate.hometown && <Chip>From {candidate.hometown}</Chip>}
          </div>
        )}

        {candidate.bio && (
          <div className="mt-5">
            <h3 className="text-xs font-semibold uppercase tracking-wide text-muted">
              About
            </h3>
            <p className="mt-1.5 text-[15px] leading-relaxed text-ink">
              {candidate.bio}
            </p>
          </div>
        )}

        {candidate.interests.length > 0 && (
          <div className="mt-5">
            <h3 className="text-xs font-semibold uppercase tracking-wide text-muted">
              Interests
            </h3>
            <div className="mt-2 flex flex-wrap gap-2">
              {candidate.interests.map((interest) => (
                <Chip key={interest.id} accent>
                  {interest.name}
                </Chip>
              ))}
            </div>
          </div>
        )}

        {prompts.length > 0 && (
          <div className="mt-5 space-y-4 border-t border-line pt-5">
            {prompts.map((item, index) => (
              <div key={index}>
                <p className="text-sm font-semibold leading-snug">{item.prompt}</p>
                <p className="mt-1 text-sm leading-relaxed text-muted">{item.answer}</p>
              </div>
            ))}
          </div>
        )}
      </div>
    </article>
  );
}

function MatchModal({
  match,
  onKeepDiscovering,
}: {
  match: MatchInfo;
  onKeepDiscovering: () => void;
}) {
  const profile = match.profile;
  const firstName = profile.first_name ?? "Student";
  const photo = displayable(profile)[0];

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label="It's a match"
      className="fixed inset-0 z-50 grid place-items-center bg-ink/60 p-6"
    >
      <div className="w-full max-w-xs rounded-card border border-line bg-surface p-6 text-center shadow-card">
        <p className="text-3xl font-bold tracking-tight text-accent">
          It&apos;s a match!
        </p>
        <p className="mt-1 text-sm leading-relaxed text-muted">
          You and {firstName} liked each other.
        </p>
        <div className="mx-auto mt-5 size-28 overflow-hidden rounded-full border border-line bg-background">
          {photo?.url ? (
            <Image
              src={photo.url}
              alt={`${firstName}'s photo`}
              width={112}
              height={112}
              unoptimized
              className="size-full object-cover"
            />
          ) : (
            <span
              aria-hidden
              className="grid size-full place-items-center text-4xl font-bold text-accent"
            >
              {firstName.charAt(0).toUpperCase()}
            </span>
          )}
        </div>
        <p className="mt-3 text-lg font-semibold">
          {firstName}
          {profile.age !== null && <span>, {profile.age}</span>}
        </p>
        <div className="mt-6 space-y-3">
          <button
            type="button"
            onClick={onKeepDiscovering}
            autoFocus
            className={`w-full rounded-2xl bg-accent py-3.5 font-semibold text-white shadow-card transition-transform active:scale-[0.98] ${FOCUS_RING}`}
          >
            Keep discovering
          </button>
          <Link
            href="/matches"
            className={`block w-full rounded-2xl border border-line bg-surface py-3.5 font-semibold text-ink shadow-card transition-transform active:scale-[0.98] ${FOCUS_RING}`}
          >
            View matches
          </Link>
        </div>
      </div>
    </div>
  );
}

type ActionKind = "like" | "pass";

export function DiscoveryFeed() {
  const router = useRouter();
  const [phase, setPhase] = useState<"loading" | "ready" | "error">("loading");
  const [candidates, setCandidates] = useState<DiscoveryCandidate[]>([]);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [index, setIndex] = useState(0);
  const [error, setError] = useState<DiscoveryApiError | null>(null);
  const [submitting, setSubmitting] = useState<ActionKind | null>(null);
  const [exiting, setExiting] = useState<ActionKind | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [matched, setMatched] = useState<MatchInfo | null>(null);
  const touchStart = useRef<{ x: number; y: number } | null>(null);
  const feedReady = phase === "ready" && !submitting && !exiting && !matched;
  const loadFeed = useCallback(async () => {
    const page = await fetchDiscoveryFeed();
    setCandidates(page.candidates);
    setNextCursor(page.next_cursor);
    setIndex(0);
  }, []);

  useEffect(() => {
    void (async () => {
      try {
        await loadFeed();
        setPhase("ready");
      } catch (caught) {
        if (caught instanceof DiscoveryApiError && caught.code === "unauthorized") {
          router.replace("/login");
          return;
        }
        console.error("Failed to load discovery feed:", caught);
        setError(caught instanceof DiscoveryApiError ? caught : null);
        setPhase("error");
      }
    })();
  }, [loadFeed, router]);

  const retry = useCallback(() => {
    setPhase("loading");
    setError(null);
    void (async () => {
      try {
        await loadFeed();
        setPhase("ready");
      } catch (caught) {
        console.error("Failed to load discovery feed:", caught);
        setError(caught instanceof DiscoveryApiError ? caught : null);
        setPhase("error");
      }
    })();
  }, [loadFeed]);

  async function loadMore() {
    try {
      const page = await fetchDiscoveryFeed({ cursor: nextCursor });
      setCandidates((current) => [...current, ...page.candidates]);
      setNextCursor(page.next_cursor);
      setIndex((current) => current + 1);
      setError(null);
    } catch (caught) {
      if (caught instanceof DiscoveryApiError && caught.code === "unauthorized") {
        router.replace("/login");
        return;
      }
      console.error("Failed to load more candidates:", caught);
      setError(caught instanceof DiscoveryApiError ? caught : null);
      setActionError(messageFor(caught));
    }
  }

  async function advance() {
    setActionError(null);
    if (index < candidates.length - 1) {
      setIndex(index + 1);
    } else if (nextCursor) {
      await loadMore(); // appends the next page and advances the index
    } else {
      setIndex(index + 1); // past the end → "all caught up" view
    }
  }

  async function decide(kind: ActionKind) {
    if (!feedReady) {
      return;
    }
    const candidate = candidates[index];
    if (!candidate) {
      return;
    }
    setSubmitting(kind);
    setActionError(null);
    try {
      const result =
        kind === "like"
          ? await likeCandidate(candidate.id)
          : await passCandidate(candidate.id);
      if (result.outcome === "matched" && result.match) {
        setMatched(result.match);
        await advance();
      } else {
        setExiting(kind);
        // Let the exit animation play before the next card appears — the
        // action is already recorded, so this cannot cause inconsistency.
        setTimeout(() => {
          setExiting(null);
          void advance();
        }, EXIT_ANIMATION_MS);
      }
    } catch (caught) {
      if (caught instanceof DatingApiError) {
        if (caught.code === "unauthorized") {
          router.replace("/login");
          return;
        }
        if (caught.code === "already_decided" || caught.code === "not_found") {
          // The candidate was decided elsewhere meanwhile — advance safely
          // instead of corrupting the feed state.
          await advance();
          return;
        }
      }
      console.error(`Failed to ${kind} candidate:`, caught);
      setActionError(messageFor(caught));
    } finally {
      setSubmitting(null);
    }
  }

  function onTouchStart(event: React.TouchEvent) {
    const touch = event.touches[0];
    touchStart.current = { x: touch.clientX, y: touch.clientY };
  }

  function onTouchEnd(event: React.TouchEvent) {
    const start = touchStart.current;
    touchStart.current = null;
    if (!start || !feedReady) {
      return;
    }
    const touch = event.changedTouches[0];
    const deltaX = touch.clientX - start.x;
    const deltaY = touch.clientY - start.y;
    if (
      Math.abs(deltaX) < SWIPE_THRESHOLD_PX ||
      Math.abs(deltaX) < Math.abs(deltaY)
    ) {
      return;
    }
    void decide(deltaX < 0 ? "pass" : "like");
  }

  if (phase === "loading") {
    return (
      <section className="pt-14" aria-busy="true" aria-live="polite">
        <span className="sr-only">Loading your discovery feed</span>
        <div className="aspect-[4/5] animate-pulse rounded-card bg-line" />
        <div className="mt-5 h-8 w-48 animate-pulse rounded-full bg-line" />
        <div className="mt-3 h-4 w-64 max-w-full animate-pulse rounded-full bg-line" />
      </section>
    );
  }

  if (phase === "error") {
    return (
      <section className="pt-14 text-center">
        <h1 className="text-3xl font-bold tracking-tight">
          {error?.code === "not_verified"
            ? "Verification required"
            : "Something went wrong"}
        </h1>
        <p
          role="alert"
          className="mx-auto mt-3 max-w-sm text-[15px] leading-relaxed text-muted"
        >
          {messageFor(error)}
        </p>
        {error?.code === "not_verified" ? (
          <Link
            href="/verify"
            className={`mt-8 inline-block w-full rounded-2xl bg-accent py-3.5 font-semibold text-white shadow-card transition-transform active:scale-[0.98] ${FOCUS_RING}`}
          >
            Go to verification
          </Link>
        ) : (
          <button
            type="button"
            onClick={retry}
            className={`mt-8 w-full rounded-2xl border border-line bg-surface py-3.5 font-semibold text-ink shadow-card transition-transform active:scale-[0.98] ${FOCUS_RING}`}
          >
            Try again
          </button>
        )}
      </section>
    );
  }

  if (candidates.length === 0 || index >= candidates.length) {
    return (
      <section className="pt-14 text-center">
        <h1 className="text-3xl font-bold tracking-tight">
          No one to discover yet
        </h1>
        <p className="mx-auto mt-3 max-w-sm text-[15px] leading-relaxed text-muted">
          You&apos;ve seen every eligible verified student for now. Check back
          soon — new members join all the time.
        </p>
        <button
          type="button"
          onClick={retry}
          className={`mt-8 w-full rounded-2xl border border-line bg-surface py-3.5 font-semibold text-ink shadow-card transition-transform active:scale-[0.98] ${FOCUS_RING}`}
        >
          Check again
        </button>
      </section>
    );
  }

  const candidate = candidates[index];
  const exitingClass =
    exiting === "pass"
      ? "-translate-x-full opacity-0"
      : exiting === "like"
        ? "translate-x-full opacity-0"
        : "";

  return (
    <section className="pt-10">
      <div
        className={`transition-transform duration-150 ease-out ${exitingClass}`}
        onTouchStart={onTouchStart}
        onTouchEnd={onTouchEnd}
      >
        <CandidateCard key={candidate.id} candidate={candidate} />
      </div>

      {actionError && (
        <p role="alert" className="mt-4 text-center text-sm font-medium text-red-600">
          {actionError}
        </p>
      )}

      <div className="mt-6 flex gap-3">
        <button
          type="button"
          onClick={() => void decide("pass")}
          disabled={!feedReady}
          aria-busy={submitting === "pass"}
          className={`flex-1 rounded-2xl border border-line bg-surface py-3.5 font-semibold text-ink shadow-card transition-transform active:scale-[0.98] disabled:pointer-events-none disabled:opacity-40 ${FOCUS_RING}`}
        >
          {submitting === "pass" ? "Passing…" : "Pass"}
        </button>
        <button
          type="button"
          onClick={() => void decide("like")}
          disabled={!feedReady}
          aria-busy={submitting === "like"}
          className={`flex-1 rounded-2xl bg-accent py-3.5 font-semibold text-white shadow-card transition-transform active:scale-[0.98] disabled:pointer-events-none disabled:opacity-40 ${FOCUS_RING}`}
        >
          {submitting === "like" ? "Liking…" : "Like"}
        </button>
      </div>

      <p className="mt-3 text-center text-xs text-muted">
        Swipe left to pass, right to like — or use the buttons.
      </p>

      {matched && (
        <MatchModal
          match={matched}
          onKeepDiscovering={() => setMatched(null)}
        />
      )}
    </section>
  );
}
