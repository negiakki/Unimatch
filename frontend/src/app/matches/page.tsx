"use client";

import Image from "next/image";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useState } from "react";

import { AppHeader } from "@/components/app-header";
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
    <article className="rounded-card border-line bg-surface shadow-card overflow-hidden border">
      <div className="bg-background relative aspect-[4/5]">
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
          <div className="bg-accent/10 grid size-full place-items-center">
            <span aria-hidden className="text-accent text-7xl font-bold">
              {firstName.charAt(0).toUpperCase()}
            </span>
          </div>
        )}
        <div className="pointer-events-none absolute inset-x-0 bottom-0 bg-linear-to-t from-black/70 via-black/30 to-transparent px-5 pt-16 pb-4">
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
          <p className="text-muted min-w-0 flex-1 truncate text-sm">
            {profile.course}
          </p>
        )}
        <Link
          href={`/messages/${entry.id}`}
          className={`bg-accent shadow-card shrink-0 rounded-xl px-4 py-2 text-sm font-semibold text-white transition-transform active:scale-[0.98] ${FOCUS_RING}`}
        >
          Message
        </Link>
        <button
          type="button"
          onClick={() => void handleUnmatch()}
          disabled={busy}
          aria-busy={busy}
          className={`border-line bg-surface text-muted shrink-0 rounded-xl border px-4 py-2 text-sm font-semibold transition-transform active:scale-[0.98] disabled:pointer-events-none disabled:opacity-40 ${FOCUS_RING}`}
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
        if (
          caught instanceof DatingApiError &&
          caught.code === "unauthorized"
        ) {
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
    <>
      <AppHeader />
      <main className="mx-auto w-full max-w-lg px-5 pb-16">
        <section className="pt-10">
          <div className="flex items-center justify-between gap-2">
            <h1 className="text-3xl font-bold tracking-tight">Matches</h1>
          </div>

          {phase === "loading" && (
            <div className="mt-8 space-y-5" aria-busy="true" aria-live="polite">
              <span className="sr-only">Loading your matches</span>
              <div className="rounded-card bg-line aspect-[4/5] animate-pulse" />
            </div>
          )}

          {phase === "error" && (
            <div className="mt-8 text-center">
              <p
                role="alert"
                className="text-muted text-[15px] leading-relaxed"
              >
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
                className={`border-line bg-surface text-ink shadow-card mt-6 w-full rounded-2xl border py-3.5 font-semibold transition-transform active:scale-[0.98] ${FOCUS_RING}`}
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
              <p className="text-muted mx-auto mt-3 max-w-sm text-[15px] leading-relaxed">
                When you and another student like each other, they&apos;ll show
                up here.
              </p>
              <Link
                href="/discovery"
                className={`bg-accent shadow-card mt-8 inline-block w-full rounded-2xl py-3.5 font-semibold text-white transition-transform active:scale-[0.98] ${FOCUS_RING}`}
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
    </>
  );
}
