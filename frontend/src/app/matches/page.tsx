"use client";

import Image from "next/image";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useState } from "react";

import {
  DatingApiError,
  fetchMatches,
  unmatch,
  type MatchEntry,
} from "@/lib/api/dating";
import type { DiscoveryCandidate } from "@/lib/api/discovery";

/**
 * /matches — the signed-in user's active matches, newest first.
 *
 * Only ACTIVE matches are listed (the backend hides unmatched ones). Each
 * entry renders the client-safe matched profile; unmatch is participant-only
 * and soft (both sides stop seeing the match immediately).
 */

const FOCUS_RING =
  "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent focus-visible:ring-offset-2 focus-visible:ring-offset-background";

function errorMessageFor(error: unknown): string {
  if (error instanceof DatingApiError) {
    return error.message;
  }
  return "Something went wrong. Please try again.";
}

function displayablePhoto(candidate: DiscoveryCandidate) {
  return candidate.photos.find((photo) => photo.url)?.url ?? null;
}

function MatchCard({
  entry,
  onUnmatched,
}: {
  entry: MatchEntry;
  onUnmatched: (matchId: string) => void;
}) {
  const [busy, setBusy] = useState(false);
  const router = useRouter();
  const profile = entry.profile;
  const firstName = profile.first_name ?? "Student";
  const photoUrl = displayablePhoto(profile);
  const universityPlace = [profile.university.name, profile.university.city]
    .filter(Boolean)
    .join(" · ");

  async function handleUnmatch() {
    if (busy) {
      return;
    }
    const confirmed = window.confirm(
      `Unmatch ${firstName}? You won't see each other in discovery or matches.`,
    );
    if (!confirmed) {
      return;
    }
    setBusy(true);
    try {
      await unmatch(entry.id);
      onUnmatched(entry.id);
    } catch (caught) {
      if (caught instanceof DatingApiError && caught.code === "unauthorized") {
        router.replace("/login");
        return;
      }
      console.error("Failed to unmatch:", caught);
      window.alert(errorMessageFor(caught));
    } finally {
      setBusy(false);
    }
  }

  return (
    <article className="overflow-hidden rounded-card border border-line bg-surface shadow-card">
      <div className="relative aspect-[4/5] bg-background">
        {photoUrl ? (
          <Image
            src={photoUrl}
            alt={`${firstName}'s photo`}
            fill
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
        <div className="pointer-events-none absolute inset-x-0 bottom-0 bg-linear-to-t from-black/70 via-black/30 to-transparent px-5 pb-4 pt-16">
          <h2 className="text-2xl font-bold tracking-tight text-white">
            {firstName}
            {profile.age !== null && <span>, {profile.age}</span>}
          </h2>
          {universityPlace && (
            <p className="mt-1 text-sm font-medium text-white/90">
              {universityPlace}
            </p>
          )}
        </div>
      </div>
      <div className="flex items-center gap-3 p-4">
        {profile.course && (
          <p className="min-w-0 flex-1 truncate text-sm text-muted">
            {profile.course}
          </p>
        )}
        <button
          type="button"
          onClick={() => void handleUnmatch()}
          disabled={busy}
          aria-busy={busy}
          className={`shrink-0 rounded-xl border border-line bg-surface px-4 py-2 text-sm font-semibold text-muted transition-transform active:scale-[0.98] disabled:pointer-events-none disabled:opacity-40 ${FOCUS_RING}`}
        >
          {busy ? "Unmatching…" : "Unmatch"}
        </button>
      </div>
    </article>
  );
}

export default function MatchesPage() {
  const router = useRouter();
  const [phase, setPhase] = useState<"loading" | "ready" | "error">("loading");
  const [matches, setMatches] = useState<MatchEntry[]>([]);
  const [error, setError] = useState<DatingApiError | null>(null);

  const load = useCallback(async () => {
    const page = await fetchMatches();
    setMatches(page.matches);
  }, []);

  useEffect(() => {
    void (async () => {
      try {
        await load();
        setPhase("ready");
      } catch (caught) {
        if (caught instanceof DatingApiError && caught.code === "unauthorized") {
          router.replace("/login");
          return;
        }
        console.error("Failed to load matches:", caught);
        setError(caught instanceof DatingApiError ? caught : null);
        setPhase("error");
      }
    })();
  }, [load, router]);

  function removeMatch(matchId: string) {
    setMatches((current) => current.filter((match) => match.id !== matchId));
  }

  return (
    <main className="mx-auto w-full max-w-lg px-5 pb-16">
      <section className="pt-10">
        <div className="flex items-center justify-between">
          <h1 className="text-3xl font-bold tracking-tight">Matches</h1>
          <Link
            href="/discovery"
            className={`rounded-xl border border-line bg-surface px-4 py-2 text-sm font-semibold text-ink shadow-card transition-transform active:scale-[0.98] ${FOCUS_RING}`}
          >
            Discover
          </Link>
        </div>

        {phase === "loading" && (
          <div className="mt-8 space-y-5" aria-busy="true" aria-live="polite">
            <span className="sr-only">Loading your matches</span>
            <div className="aspect-[4/5] animate-pulse rounded-card bg-line" />
          </div>
        )}

        {phase === "error" && (
          <div className="mt-8 text-center">
            <p role="alert" className="text-[15px] leading-relaxed text-muted">
              {errorMessageFor(error)}
            </p>
            <button
              type="button"
              onClick={() => {
                setPhase("loading");
                setError(null);
                void load()
                  .then(() => setPhase("ready"))
                  .catch((caught: unknown) => {
                    console.error("Failed to load matches:", caught);
                    setError(
                      caught instanceof DatingApiError ? caught : null,
                    );
                    setPhase("error");
                  });
              }}
              className={`mt-6 w-full rounded-2xl border border-line bg-surface py-3.5 font-semibold text-ink shadow-card transition-transform active:scale-[0.98] ${FOCUS_RING}`}
            >
              Try again
            </button>
          </div>
        )}

        {phase === "ready" && matches.length === 0 && (
          <div className="mt-16 text-center">
            <h2 className="text-2xl font-bold tracking-tight">
              No matches yet
            </h2>
            <p className="mx-auto mt-3 max-w-sm text-[15px] leading-relaxed text-muted">
              When you and another student like each other, they&apos;ll show
              up here.
            </p>
            <Link
              href="/discovery"
              className={`mt-8 inline-block w-full rounded-2xl bg-accent py-3.5 font-semibold text-white shadow-card transition-transform active:scale-[0.98] ${FOCUS_RING}`}
            >
              Start discovering
            </Link>
          </div>
        )}

        {phase === "ready" && matches.length > 0 && (
          <div className="mt-8 space-y-8">
            {matches.map((entry) => (
              <MatchCard
                key={entry.id}
                entry={entry}
                onUnmatched={removeMatch}
              />
            ))}
          </div>
        )}
      </section>
    </main>
  );
}
