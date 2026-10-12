"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useState } from "react";

import { SignOutButton } from "@/components/sign-out-button";
import {
  Button,
  ButtonLink,
  CoverImage,
  Label,
  SuspendedState,
} from "@/components/ui";
import { isSuspended } from "@/lib/api/http";
import {
  fetchMyApplications,
  fetchOpportunities,
  fetchOpportunity,
  isJoined,
  joinOpportunity,
  type Application,
  type Opportunity,
} from "@/lib/api/opportunities";
import {
  categoryKey,
  cx,
  formatClock,
  formatEventDate,
  partnerCta,
} from "@/lib/format";

/**
 * The opportunity as an event page: cover, title, when/where, the story, and
 * one obvious next step.
 *
 * The CTA is the whole point — "join, then find your partner". The join state
 * comes from GET /applications (the caller's own applications), so a signed-out
 * visitor gets a sign-in prompt instead of an error. Joining is idempotent on
 * the backend (409 already_applied), which is handled as success.
 */

type Phase = "loading" | "ready" | "not_found" | "error";

export function OpportunityView({ opportunityId }: { opportunityId: string }) {
  const router = useRouter();
  const [phase, setPhase] = useState<Phase>("loading");
  const [opportunity, setOpportunity] = useState<Opportunity | null>(null);
  const [application, setApplication] = useState<Application | null>(null);
  const [signedIn, setSignedIn] = useState<boolean | null>(null);
  const [joining, setJoining] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [suspended, setSuspended] = useState(false);

  const load = useCallback(async () => {
    const detail = await fetchOpportunity(opportunityId);
    setOpportunity(detail);
    try {
      const applications = await fetchMyApplications();
      setSignedIn(true);
      setApplication(
        applications.find(
          (entry) =>
            entry.opportunity?.id === opportunityId && isJoined(entry),
        ) ?? null,
      );
    } catch (caught) {
      setSignedIn(false);
      if (isSuspended(caught)) {
        setSuspended(true);
      }
    }
  }, [opportunityId]);

  useEffect(() => {
    void (async () => {
      try {
        await load();
        setPhase("ready");
      } catch {
        setPhase("not_found");
      }
    })();
  }, [load]);

  async function handleJoin() {
    if (joining || !opportunity) {
      return;
    }
    setJoining(true);
    setNotice(null);
    try {
      const created = await joinOpportunity(opportunity.id);
      setApplication(created);
      router.push(`/opportunities/${opportunity.id}/people`);
    } catch (caught) {
      if (isSuspended(caught)) {
        setSuspended(true);
        return;
      }
      setNotice(messageFor(caught));
    } finally {
      setJoining(false);
    }
  }

  if (suspended) {
    return (
      <SuspendedState
        message="Your account has been suspended from participating in UniMatch."
        action={<SignOutButton />}
      />
    );
  }

  if (phase === "loading") {
    return (
      <div aria-busy="true" aria-live="polite" className="mx-auto max-w-6xl px-5 sm:px-8">
        <span className="sr-only">Loading opportunity</span>
        <div className="aspect-16/10 w-full animate-pulse bg-line sm:aspect-21/9" />
        <div className="mt-10 h-14 w-2/3 animate-pulse bg-line" />
        <div className="mt-4 h-5 w-48 animate-pulse bg-line" />
      </div>
    );
  }

  if (phase !== "ready" || !opportunity) {
    return (
      <section className="mx-auto max-w-2xl px-5 py-24 text-center sm:px-8">
        <h1 className="type-display text-display">Nothing here</h1>
        <p className="mt-4 text-[15px] leading-relaxed text-muted">
          This opportunity isn&apos;t available any more — it may have been
          cancelled or it may have ended.
        </p>
        <ButtonLink href="/explore" variant="outline" className="mt-8">
          Browse what&apos;s happening
        </ButtonLink>
      </section>
    );
  }

  const day = formatEventDate(opportunity.opportunity_date);
  const start = formatClock(opportunity.start_time);
  const end = formatClock(opportunity.end_time);

  return (
    <article data-category={categoryKey(opportunity.category ?? {})}>
      {/* Full-bleed cover. */}
      <CoverImage
        src={opportunity.cover_image_url}
        alt={opportunity.title ?? "Opportunity"}
        slug={opportunity.category?.slug}
        name={opportunity.category?.name}
        priority
        sizes="100vw"
        className="animate-wipe-up h-[62svh] min-h-80 w-full"
      />

      <div className="mx-auto w-full max-w-6xl px-5 sm:px-8">
        {/* Title block. */}
        <header className="animate-rise -mt-10 border-t border-line bg-paper pt-8 sm:-mt-16 sm:pt-12">
          <Label className="text-accent">
            {[opportunity.activity?.name, opportunity.category?.name]
              .filter(Boolean)
              .join(" · ")}
          </Label>
          <h1 className="type-display mt-3 text-[clamp(2.25rem,9vw,5.5rem)]">
            {opportunity.title}
          </h1>

          {/* When / where, as a typographic data row rather than a chip grid. */}
          <dl className="mt-8 grid gap-6 border-y border-line py-6 sm:grid-cols-3">
            <Fact label="Date" value={day} />
            <Fact
              label="Time"
              value={start ? (end ? `${start} – ${end}` : start) : "—"}
            />
            <Fact label="Where" value={opportunity.location ?? "—"} />
            {opportunity.capacity !== null && (
              <Fact label="Capacity" value={String(opportunity.capacity)} />
            )}
          </dl>
        </header>

        {/* The step that matters, stated plainly. */}
        <section className="mt-12 grid gap-10 md:grid-cols-12 md:gap-8">
          <div className="md:col-span-7">
            <Label>The idea</Label>
            {opportunity.description ? (
              <p className="mt-4 max-w-prose text-[17px] leading-relaxed">
                {opportunity.description}
              </p>
            ) : (
              <p className="mt-4 max-w-prose text-[17px] leading-relaxed text-muted">
                Details for this one are still being finalised.
              </p>
            )}

            {opportunity.partner_requirement && (
              <div className="mt-8 border-l-2 border-accent pl-5">
                <Label className="text-accent">What&apos;s needed</Label>
                <p className="mt-2 text-[15px] leading-relaxed">
                  {opportunity.partner_requirement}
                </p>
              </div>
            )}
          </div>

          {/* Sticky on desktop so the next step is always in reach. */}
          <div className="md:col-span-5">
            <div className="border border-line bg-surface p-6 md:sticky md:top-24">
              <h2 className="type-display text-title">Who&apos;s looking?</h2>
              <p className="mt-3 text-[15px] leading-relaxed text-muted">
                {application
                  ? "You're going. Now meet the other students who applied for this."
                  : "Join this and you can see the other students who applied — and find someone to do it with."}
              </p>

              <div className="mt-6 space-y-3">
                {application ? (
                  <ButtonLink
                    href={`/opportunities/${opportunity.id}/people`}
                    className="w-full"
                  >
                    {partnerCta(opportunity.activity, opportunity.title)}
                  </ButtonLink>
                ) : signedIn === false ? (
                  <>
                    <ButtonLink href="/signup" className="w-full">
                      Create an account
                    </ButtonLink>
                    <ButtonLink href="/login" variant="outline" className="w-full">
                      I have an account
                    </ButtonLink>
                  </>
                ) : (
                  <Button
                    className="w-full"
                    onClick={() => void handleJoin()}
                    disabled={joining}
                    aria-busy={joining}
                  >
                    {joining ? "Joining…" : "I'm going"}
                  </Button>
                )}

                {!application && signedIn !== false && (
                  <Link
                    href="/verify"
                    className="block text-center text-[13px] text-muted underline underline-offset-4 hover:text-ink"
                  >
                    Verification required
                  </Link>
                )}
              </div>

              {notice && (
                <p role="alert" className="mt-4 text-sm text-danger">
                  {notice}
                </p>
              )}
            </div>
          </div>
        </section>

        {/* Related, at a different scale. */}
        <MoreLikeThis excludeId={opportunity.id} categoryId={opportunity.category?.id} />
      </div>
    </article>
  );
}

/* ------------------------------------------------------------- fragments -- */

function Fact({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <dt className="type-meta text-muted">{label}</dt>
      <dd className="type-display mt-1.5 text-xl">{value}</dd>
    </div>
  );
}

/** A quiet closer so the page doesn't dead-end. */
function MoreLikeThis({
  excludeId,
  categoryId,
}: {
  excludeId: string;
  categoryId: string | undefined;
}) {
  const [related, setRelated] = useState<Opportunity[]>([]);

  useEffect(() => {
    let active = true;
    void fetchOpportunities(
      categoryId ? { categoryId } : undefined,
    )
      .then((list) => {
        if (active) {
          setRelated(list.filter((entry) => entry.id !== excludeId).slice(0, 3));
        }
      })
      .catch(() => setRelated([]));
    return () => {
      active = false;
    };
  }, [excludeId, categoryId]);

  if (related.length === 0) {
    return null;
  }

  return (
    <section className="mt-20 border-t border-line pt-8">
      <h2 className="type-display text-title">Also happening</h2>
      <ul className="mt-8 grid gap-8 sm:grid-cols-3">
        {related.map((opportunity) => (
          <li key={opportunity.id}>
            <Link
              href={`/opportunities/${opportunity.id}`}
              data-category={categoryKey(opportunity.category ?? {})}
              className="group block"
            >
              <CoverImage
                src={opportunity.cover_image_url}
                alt=""
                slug={opportunity.category?.slug}
                name={opportunity.category?.name}
                sizes="(max-width: 640px) 100vw, 320px"
                className="aspect-4/3 w-full"
              />
              <h3
                className={cx(
                  "type-display mt-3 truncate text-xl",
                  "transition-colors group-hover:text-accent",
                )}
              >
                {opportunity.title}
              </h3>
              <p className="mt-1 truncate text-sm text-muted">
                {[formatEventDate(opportunity.opportunity_date), opportunity.location]
                  .filter(Boolean)
                  .join(" · ")}
              </p>
            </Link>
          </li>
        ))}
      </ul>
    </section>
  );
}

function messageFor(error: unknown): string {
  return error instanceof Error
    ? error.message
    : "Something went wrong. Please try again.";
}