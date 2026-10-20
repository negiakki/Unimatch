"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useState } from "react";

import { OpportunityHero } from "@/components/opportunity-hero";
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
  formatEventDate,
  partnerCta,
} from "@/lib/format";
import {
  opportunityThemeStyle,
  resolveOpportunityTheme,
} from "@/lib/opportunity-theme";

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
      <div aria-busy="true" aria-live="polite">
        <span className="sr-only">Loading opportunity</span>
        <div className="h-[min(76svh,760px)] w-full animate-pulse bg-ink/10 sm:h-[min(88svh,820px)]" />
        <div className="mx-auto mt-10 max-w-6xl px-5 sm:px-8">
          <div className="h-12 w-2/3 animate-pulse bg-line" />
          <div className="mt-4 h-5 w-48 animate-pulse bg-line" />
          <div className="mt-10 h-5 w-full animate-pulse bg-line" />
          <div className="mt-3 h-5 w-5/6 animate-pulse bg-line" />
        </div>
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

  const theme = resolveOpportunityTheme(opportunity);
  const heroCta = application
    ? {
        href: `/opportunities/${opportunity.id}/people`,
        label: partnerCta(opportunity.activity, opportunity.title),
      }
    : signedIn === false
      ? { href: "#join", label: "Sign up to join" }
      : { href: "#join", label: "I'm going" };

  return (
    <article
      data-category={categoryKey(opportunity.category ?? {})}
      style={opportunityThemeStyle(theme) as React.CSSProperties}
    >
      <OpportunityHero
        opportunity={opportunity}
        theme={theme}
        ctaLabel={heroCta.label}
        ctaHref={heroCta.href}
      />

      <div aria-hidden className="h-1.5 w-full bg-accent" />

      <div className="mx-auto w-full max-w-6xl px-5 sm:px-8">
        {/* The event's atmosphere, set as an editorial pull quote. */}
        <section
          className="animate-rise relative overflow-hidden border-b border-line py-8 sm:py-12"
          style={{ backgroundColor: theme.soft }}
        >
          <div className="flex flex-col gap-4 sm:gap-7 md:flex-row md:items-end md:justify-between">
            <div>
              <Label className="text-accent">The mood</Label>
              <p className="type-display mt-3 max-w-2xl text-[clamp(1.75rem,4.5vw,3.25rem)] leading-[1.02]">
                {theme.atmosphere}
              </p>
            </div>
            <ul className="flex flex-wrap gap-2">
              {theme.mood.map((word) => (
                <li key={word}>
                  <span className="inline-flex rounded-full border border-accent/25 bg-paper/80 px-3.5 py-1.5 text-[13px] font-semibold text-accent">
                    {word}
                  </span>
                </li>
              ))}
            </ul>
          </div>
        </section>

        {/* The step that matters, stated plainly. */}
        <section className="mt-8 grid gap-7 sm:mt-12 md:grid-cols-12 md:gap-8">
          <div className="md:col-span-7">
            <Label className="text-accent">The idea</Label>
            <h2 className="type-display mt-3 text-title">
              {opportunity.activity?.name
                ? `About ${opportunity.activity.name}`
                : "About this"}
            </h2>
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
            <div
              id="join"
              className="scroll-mt-20 border border-line border-t-4 border-t-accent bg-surface p-5 sm:p-6 md:sticky md:top-24"
            >
              <Label className="text-accent">Next step</Label>
              <h2 className="type-display mt-2 text-title">Who&apos;s looking?</h2>
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
    <section className="mt-12 border-t border-line pt-8 sm:mt-20">
      <h2 className="type-display text-title">Also happening</h2>
      <ul className="mt-8 grid gap-8 sm:grid-cols-3">
        {related.map((opportunity) => {
          const theme = resolveOpportunityTheme(opportunity);
          return (
            <li key={opportunity.id}>
              <Link
                href={`/opportunities/${opportunity.id}`}
                data-category={categoryKey(opportunity.category ?? {})}
                style={opportunityThemeStyle(theme) as React.CSSProperties}
                className="group block"
              >
                <CoverImage
                  src={opportunity.cover_image_url}
                  alt=""
                  fallbackSrc={theme.photo?.src ?? null}
                  fallbackAlt={theme.photo?.alt}
                  objectPosition={theme.photo?.position}
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
                  {[
                    formatEventDate(opportunity.opportunity_date),
                    opportunity.location,
                  ]
                    .filter(Boolean)
                    .join(" · ")}
                </p>
              </Link>
            </li>
          );
        })}
      </ul>
    </section>
  );
}

function messageFor(error: unknown): string {
  return error instanceof Error
    ? error.message
    : "Something went wrong. Please try again.";
}