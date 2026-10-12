"use client";

import Image from "next/image";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useState } from "react";

import { SignOutButton } from "@/components/sign-out-button";
import { SwipeDeck, type SwipeDirection } from "@/components/swipe-deck";
import {
  Avatar,
  Button,
  ButtonLink,
  Chip,
  Label,
  SuspendedState,
} from "@/components/ui";
import {
  fetchOpportunityDiscovery,
  type Person,
} from "@/lib/api/discovery";
import { primaryPhotoUrl } from "@/lib/api/discovery";
import { isApiError, isSuspended, isUnauthorized } from "@/lib/api/http";
import { passOn, showInterest, type ContextualMatch } from "@/lib/api/matches";
import { fetchOpportunity, type Opportunity } from "@/lib/api/opportunities";
import { categoryKey, cx } from "@/lib/format";

/**
 * People discovery for ONE opportunity, with interested / pass.
 *
 * The card is ordered for humans: photo, name, university and year, interests,
 * then a short bio. Legacy dating-era fields are never rendered — the backend
 * may still send them, and this client doesn't model them.
 *
 * Actions are scoped to the opportunity, so a decision here never affects any
 * other opportunity's feed. The buttons below the deck are the non-gesture
 * path; they call exactly the same handler as the swipe.
 */

type Phase = "loading" | "ready" | "not_applied" | "error";

export function PeopleDiscovery({ opportunityId }: { opportunityId: string }) {
  const router = useRouter();
  const [phase, setPhase] = useState<Phase>("loading");
  const [opportunity, setOpportunity] = useState<Opportunity | null>(null);
  const [people, setPeople] = useState<Person[]>([]);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [suspended, setSuspended] = useState(false);
  const [match, setMatch] = useState<ContextualMatch | null>(null);
  const [command, setCommand] = useState<SwipeDirection | null>(null);

  const load = useCallback(async () => {
    const [detail, page] = await Promise.all([
      fetchOpportunity(opportunityId),
      fetchOpportunityDiscovery(opportunityId, { limit: 20 }),
    ]);
    setOpportunity(detail);
    setPeople(page.people);
    setNextCursor(page.next_cursor);
  }, [opportunityId]);

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
          setSuspended(true);
          return;
        }
        // Contextual discovery is for participants: "not applied yet" is a
        // different screen from a failure, not an error.
        if (isApiError(caught) && caught.code === "not_applied") {
          setPhase("not_applied");
          return;
        }
        setPhase("error");
      }
    })();
  }, [load, router]);

  /** Paging forward is a background nicety, never a blocker. */
  const loadMore = useCallback(async () => {
    if (!nextCursor) {
      return;
    }
    try {
      const page = await fetchOpportunityDiscovery(opportunityId, {
        cursor: nextCursor,
        limit: 20,
      });
      setPeople((current) => [...current, ...page.people]);
      setNextCursor(page.next_cursor);
    } catch {
      setNotice("Couldn't load more people just now.");
    }
  }, [nextCursor, opportunityId]);

  const handleDecide = useCallback(
    (person: Person, direction: SwipeDirection) => {
      setNotice(null);
      const action =
        direction === "interested"
          ? showInterest(opportunityId, person.id)
          : passOn(opportunityId, person.id);

      void action
        .then((result) => {
          if (result.outcome === "matched" && result.match) {
            setMatch(result.match);
          }
        })
        .catch((caught: unknown) => {
          if (isSuspended(caught)) {
            setSuspended(true);
            return;
          }
          if (isUnauthorized(caught)) {
            router.replace("/login");
            return;
          }
          // Decided elsewhere, or the record is gone: the card is spent, so
          // stay quiet rather than corrupting the deck with a stale error.
          const spent =
            isApiError(caught) &&
            (caught.code === "already_decided" || caught.code === "not_found");
          if (!spent) {
            setNotice(
              caught instanceof Error
                ? caught.message
                : "That didn't go through. Please try again.",
            );
          }
        });
    },
    [opportunityId, router],
  );

  /** The deck calls this once the exit animation has played. */
  const handleAdvance = useCallback(() => {
    setPeople((current) => current.slice(1));
    void loadMore();
  }, [loadMore]);

  const handleBusyChange = useCallback((next: boolean) => {
    setBusy(next);
  }, []);

  const clearCommand = useCallback(() => setCommand(null), []);

  if (suspended) {
    return (
      <SuspendedState
        message="Your account has been suspended from participating in UniMatch."
        action={<SignOutButton />}
      />
    );
  }

  return (
    <div
      data-category={categoryKey(opportunity?.category ?? {})}
      className="flex flex-1 flex-col"
    >
      <ContextHeader opportunity={opportunity} />

      {phase === "loading" && (
        <div aria-busy="true" aria-live="polite" className="pt-6">
          <span className="sr-only">Finding people here</span>
          <div className="aspect-4/5 w-full animate-pulse bg-line" />
        </div>
      )}

      {phase === "not_applied" && (
        <Blocked
          title="Join this first"
          body="You can only see the people here once you've joined the opportunity. That constraint is what makes this a partner search rather than a directory."
          action={
            <ButtonLink href={`/opportunities/${opportunityId}`}>
              {opportunity ? "I'm going" : "View opportunity"}
            </ButtonLink>
          }
        />
      )}

      {phase === "error" && (
        <Blocked
          title="Couldn't load people"
          body="Something went wrong on our side. Try again in a moment."
          action={
            <Button variant="outline" onClick={() => window.location.reload()}>
              Try again
            </Button>
          }
        />
      )}

      {phase === "ready" && people.length === 0 && (
        <Blocked
          title="No one's left here"
          body="You've been through everyone who applied for this and is looking for a partner. Your next partner might be at the next event."
          action={<ButtonLink href="/explore">Explore other opportunities</ButtonLink>}
        />
      )}

      {phase === "ready" && people.length > 0 && (
        <>
          <SwipeDeck
            items={people}
            getKey={(person) => person.id}
            busy={busy}
            onBusyChange={handleBusyChange}
            onDecide={handleDecide}
            onAdvance={handleAdvance}
            command={command}
            onCommandHandled={clearCommand}
            stamps={["Pass", "Interested"]}
            render={(person, isTop) => <PersonCard person={person} top={isTop} />}
            className="pt-6"
          />

          {notice && (
            <p role="alert" className="mt-4 text-center text-sm text-danger">
              {notice}
            </p>
          )}

          {/* Non-gesture path. Drives the same gesture as a swipe, so the
              card exits identically either way. */}
          <div className="mt-6 grid grid-cols-2 gap-3">
            <Button
              variant="outline"
              disabled={busy}
              onClick={() => setCommand("pass")}
            >
              Pass
            </Button>
            <Button disabled={busy} onClick={() => setCommand("interested")}>
              Interested
            </Button>
          </div>
          <p className="mt-3 text-center text-xs text-muted">
            Swipe left to pass, right if you&apos;d like to join them — or use
            the buttons.
          </p>
        </>
      )}

      {match && (
        <MatchMoment
          match={match}
          opportunity={opportunity}
          onDismiss={() => setMatch(null)}
        />
      )}
    </div>
  );
}

/* ------------------------------------------------------------- fragments -- */

/** Persistent context: what this partner search is for. */
function ContextHeader({ opportunity }: { opportunity: Opportunity | null }) {
  return (
    <header className="sticky top-0 z-30 -mx-5 flex items-start gap-4 border-b border-line bg-paper/92 px-5 py-4 backdrop-blur">
      <Link
        href={opportunity ? `/opportunities/${opportunity.id}` : "/explore"}
        aria-label="Back to opportunity"
        className="mt-0.5 grid size-9 shrink-0 place-items-center rounded-full border border-line text-ink transition-colors hover:border-ink"
      >
        <span aria-hidden>←</span>
      </Link>
      <div className="min-w-0 flex-1">
        <Label className="text-accent">Find your partner</Label>
        <h1 className="type-display mt-1 truncate text-xl">
          {opportunity?.title ?? "Loading…"}
        </h1>
        <p className="mt-0.5 truncate text-[13px] text-muted">
          {opportunity ? "Students going · looking for a partner" : " "}
        </p>
      </div>
    </header>
  );
}

/**
 * The card. Order is deliberate: photo, name, academic context, interests,
 * short bio — enough to feel like a person, not a database record.
 */
function PersonCard({ person, top }: { person: Person; top: boolean }) {
  const [photoIndex, setPhotoIndex] = useState(0);
  const signed = person.photos.filter((photo) => photo.url);
  const active = signed[Math.min(photoIndex, signed.length - 1)] ?? null;
  const name = person.first_name ?? "Student";

  const study = [
    person.course,
    person.academic_year !== null ? `Year ${person.academic_year}` : null,
  ]
    .filter(Boolean)
    .join(" · ");
  const place = [person.university.name, person.university.city]
    .filter(Boolean)
    .join(" · ");

  return (
    <article
      aria-hidden={!top}
      className={cx(
        "overflow-hidden border border-line bg-surface",
        top && "animate-rise",
      )}
    >
      <div className="relative aspect-4/5 bg-line/40">
        {active?.url ? (
          <Image
            src={active.url}
            alt={`${name}'s photo`}
            fill
            priority={top}
            unoptimized
            sizes="(max-width: 512px) 100vw, 512px"
            className="object-cover"
          />
        ) : (
          <div className="grid size-full place-items-center bg-accent/12">
            <span aria-hidden className="type-display text-7xl text-accent">
              {name.charAt(0).toUpperCase()}
            </span>
          </div>
        )}

        {signed.length > 1 && (
          <>
            <div aria-hidden className="absolute inset-x-4 top-3 flex gap-1.5">
              {signed.map((photo, index) => (
                <span
                  key={photo.id}
                  className={cx(
                    "h-1 flex-1 rounded-full",
                    index === photoIndex ? "bg-white" : "bg-white/40",
                  )}
                />
              ))}
            </div>
            {/* Tapping the photo steps through it — but only on the top card,
                so the gesture never fights the swipe. */}
            {top && (
              <>
                <button
                  type="button"
                  aria-label="Previous photo"
                  onClick={() =>
                    setPhotoIndex((i) => (i - 1 + signed.length) % signed.length)
                  }
                  className="absolute inset-y-0 left-0 w-1/2 cursor-pointer focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-white"
                />
                <button
                  type="button"
                  aria-label="Next photo"
                  onClick={() => setPhotoIndex((i) => (i + 1) % signed.length)}
                  className="absolute inset-y-0 right-0 w-1/2 cursor-pointer focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-white"
                />
                <p aria-live="polite" className="sr-only">
                  Photo {photoIndex + 1} of {signed.length}
                </p>
              </>
            )}
          </>
        )}

        <div className="pointer-events-none absolute inset-x-0 bottom-0 bg-linear-to-t from-black/75 via-black/25 to-transparent px-5 pt-16 pb-4">
          <h2 className="type-display text-3xl text-white">
            {name}
            {person.age !== null && (
              <span className="text-white/70">, {person.age}</span>
            )}
          </h2>
          {(place || study) && (
            <p className="mt-1 text-sm font-medium text-white/85">
              {[place, study].filter(Boolean).join(" · ")}
            </p>
          )}
        </div>
      </div>

      <div className="p-5">
        {person.interests.length > 0 && (
          <ul className="flex flex-wrap gap-2">
            {person.interests.slice(0, 6).map((interest) => (
              <li key={interest.id}>
                <Chip tone="accent">{interest.name}</Chip>
              </li>
            ))}
          </ul>
        )}

        {person.bio && (
          <p className="mt-4 text-[15px] leading-relaxed text-ink">
            {person.bio}
          </p>
        )}

        {person.profile_prompts.length > 0 && (
          <dl className="mt-5 space-y-4 border-t border-line pt-5">
            {person.profile_prompts.slice(0, 2).map((prompt, index) => (
              <div key={index}>
                <dt className="text-sm font-semibold leading-snug">
                  {prompt.prompt}
                </dt>
                <dd className="mt-1 text-sm leading-relaxed text-muted">
                  {prompt.answer}
                </dd>
              </div>
            ))}
          </dl>
        )}
      </div>
    </article>
  );
}

function Blocked({
  title,
  body,
  action,
}: {
  title: string;
  body: string;
  action: React.ReactNode;
}) {
  return (
    <section className="flex flex-1 flex-col items-start justify-center py-20">
      <h2 className="type-display text-display">{title}</h2>
      <p className="mt-4 max-w-sm text-[15px] leading-relaxed text-muted">
        {body}
      </p>
      <div className="mt-8">{action}</div>
    </section>
  );
}

/**
 * The match moment: a small, memorable beat — the two photos moving together,
 * the opportunity that caused it, one clear next action. No hearts, no
 * confetti, no casino.
 */
function MatchMoment({
  match,
  opportunity,
  onDismiss,
}: {
  match: ContextualMatch;
  opportunity: Opportunity | null;
  onDismiss: () => void;
}) {
  const name = match.profile.first_name ?? "Someone";
  const reason = match.opportunity?.title ?? opportunity?.title ?? "this opportunity";

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label={`You and ${name} both want a partner for ${reason}`}
      className="fixed inset-0 z-50 flex items-center justify-center bg-ink/80 p-6"
      onClick={onDismiss}
    >
      <div
        className="w-full max-w-sm bg-paper p-7"
        onClick={(event) => event.stopPropagation()}
      >
        <Label className="text-accent">You both want a partner</Label>
        <h2 className="type-display mt-3 text-display leading-[0.95]">
          Matched for {reason}
        </h2>

        <div className="mt-7 flex items-center -space-x-4">
          <You />
          <Avatar
            src={primaryPhotoUrl(match.profile)}
            name={match.profile.first_name}
            size="lg"
            ring
          />
        </div>

        <p className="mt-6 text-[15px] leading-relaxed text-muted">
          You and {name} are both interested in finding someone for {reason}.
          You can talk for the next 24 hours.
        </p>

        <div className="mt-7 space-y-3">
          <ButtonLink href={`/messages/${match.id}`} className="w-full">
            Start chatting
          </ButtonLink>
          <Button
            variant="ghost"
            className="w-full"
            onClick={onDismiss}
            autoFocus
          >
            Keep going
          </Button>
        </div>
      </div>
    </div>
  );
}

/** The caller's side of the match — we don't fetch /me on this screen. */
function You() {
  return (
    <span
      aria-label="You"
      className="relative grid size-24 shrink-0 place-items-center overflow-hidden rounded-full bg-ink text-paper ring-2 ring-paper"
    >
      <span className="type-meta">You</span>
    </span>
  );
}