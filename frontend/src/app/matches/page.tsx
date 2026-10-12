"use client";

import Image from "next/image";
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useState } from "react";

import { AppNav, TAB_BAR_SPACE } from "@/components/app-nav";
import { SignOutButton } from "@/components/sign-out-button";
import {
  Avatar,
  Button,
  ButtonLink,
  EmptyState,
  ErrorState,
  Label,
  LoadingBlock,
  SuspendedState,
} from "@/components/ui";
import { primaryPhotoUrl } from "@/lib/api/discovery";
import { isSuspended, isUnauthorized } from "@/lib/api/http";
import { fetchMatches, unmatch, type ContextualMatch } from "@/lib/api/matches";
import { categoryKey, formatEventDate } from "@/lib/format";

/**
 * /matches — matches are CONTEXTUAL. The same two students can match
 * independently through different opportunities, so every row leads with the
 * opportunity that caused it ("Matched for Dandiya Night") rather than a
 * generic celebration.
 *
 * Unmatch is participant-only and soft: both sides stop seeing the match
 * immediately, and the conversation goes with it.
 */

export default function MatchesPage() {
  const router = useRouter();
  const [phase, setPhase] = useState<"loading" | "ready" | "error" | "suspended">(
    "loading",
  );
  const [matches, setMatches] = useState<ContextualMatch[]>([]);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setMatches(await fetchMatches());
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

  return (
    <>
      <AppNav />
      <main className={`mx-auto w-full max-w-6xl px-5 sm:px-8 ${TAB_BAR_SPACE}`}>
        <section
          data-category="events"
          className="animate-rise -mx-5 px-5 pt-10 pb-10 sm:-mx-8 sm:px-8"
        >
          <Label>Matches</Label>
          <h1 className="type-display mt-4 text-display">Matched for what you&apos;re doing</h1>
          <p className="mt-4 max-w-lg text-[15px] leading-relaxed text-muted">
            Every match belongs to one opportunity. You can match with the same
            person again for something else.
          </p>
        </section>

        {phase === "suspended" && (
          <SuspendedState
            message="Your account has been suspended from participating in UniMatch."
            action={<SignOutButton />}
          />
        )}

        {phase === "loading" && <LoadingBlock label="Loading your matches" />}

        {phase === "error" && (
          <ErrorState
            message={error ?? "We couldn't load your matches."}
            onRetry={retry}
          />
        )}

        {phase === "ready" && matches.length === 0 && (
          <EmptyState
            title="No matches yet"
            body="When you and another student both want a partner for the same opportunity, it shows up here."
            action={<ButtonLink href="/explore">Find an opportunity</ButtonLink>}
          />
        )}

        {phase === "ready" && matches.length > 0 && (
          <ul className="grid gap-8 sm:grid-cols-2 lg:grid-cols-3">
            {matches.map((match) => (
              <li key={match.id}>
                <MatchCard
                  match={match}
                  onUnmatched={() =>
                    setMatches((current) =>
                      current.filter((entry) => entry.id !== match.id),
                    )
                  }
                />
              </li>
            ))}
          </ul>
        )}
      </main>
    </>
  );
}

function MatchCard({
  match,
  onUnmatched,
}: {
  match: ContextualMatch;
  onUnmatched: () => void;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const profile = match.profile;
  const name = profile.first_name ?? "Student";
  const reason = match.opportunity?.title;
  const cover = match.opportunity?.category ?? null;
  const url = primaryPhotoUrl(profile);

  async function handleUnmatch() {
    if (busy) {
      return;
    }
    if (!window.confirm(`Unmatch ${name}? You won't see each other here any more.`)) {
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await unmatch(match.id);
      onUnmatched();
    } catch (caught) {
      setError(
        caught instanceof Error ? caught.message : "That didn't work. Try again.",
      );
    } finally {
      setBusy(false);
    }
  }

  return (
    <article
      data-category={categoryKey(cover ?? {})}
      className="flex h-full flex-col border border-line bg-surface"
    >
      {/* Why you matched — the first thing on the card, always. */}
      <div className="flex items-center gap-3 border-b border-line px-4 py-3">
        <span className="min-w-0 flex-1">
          <Label className="block text-accent">Matched for</Label>
          <span className="mt-0.5 block truncate text-sm font-semibold">
            {reason ?? "an opportunity"}
          </span>
        </span>
        {match.opportunity?.opportunity_date && (
          <span className="shrink-0 text-xs text-muted">
            {formatEventDate(match.opportunity.opportunity_date)}
          </span>
        )}
      </div>

      <div className="flex items-center gap-4 p-4">
              <Avatar src={primaryPhotoUrl(profile)} name={profile.first_name} size="md" />
        <div className="min-w-0 flex-1">
          <p className="truncate text-lg font-bold tracking-tight">{name}</p>
          <p className="truncate text-sm text-muted">
            {[profile.course, profile.university_label].filter(Boolean).join(" · ")}
          </p>
        </div>
      </div>

      {url && (
        <div className="relative aspect-16/10 w-full bg-line/40">
          <Image
            src={url}
            alt={`${name}'s photo`}
            fill
            unoptimized
            sizes="(max-width: 640px) 100vw, 380px"
            className="object-cover"
          />
        </div>
      )}

      <div className="mt-auto space-y-2 p-4">
        {error && (
          <p role="alert" className="text-sm text-danger">
            {error}
          </p>
        )}
        <ButtonLink href={`/messages/${match.id}`} className="w-full">
          Message
        </ButtonLink>
        <Button
          variant="ghost"
          className="w-full py-2 text-[13px]"
          disabled={busy}
          onClick={() => void handleUnmatch()}
        >
          {busy ? "Removing…" : "Unmatch"}
        </Button>
      </div>
    </article>
  );
}