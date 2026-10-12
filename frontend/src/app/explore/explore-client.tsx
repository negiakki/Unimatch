"use client";

import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { Suspense, useCallback, useEffect, useMemo, useState } from "react";

import { SignOutButton } from "@/components/sign-out-button";
import {
  Button,
  ButtonLink,
  CoverImage,
  EmptyState,
  ErrorState,
  Label,
  LoadingBlock,
  SectionHead,
  SuspendedState,
} from "@/components/ui";
import { fetchCategories, type Category } from "@/lib/api/catalog";
import { isApiError, isSuspended } from "@/lib/api/http";
import {
  fetchMyApplications,
  fetchOpportunities,
  isJoined,
  withdrawApplication,
  type Application,
  type Opportunity,
} from "@/lib/api/opportunities";
import { categoryKey, cx, formatWhen, partnerCta } from "@/lib/format";

/**
 * The discovery hub: categories, what's happening, and your own activity.
 *
 * "Your activity" is the bridge into people discovery — the opportunities you
 * already joined, each with its own "find your partner" entry point. That is
 * why this page, and not a profile feed, is the product's front door.
 *
 * Requests: the public catalog and opportunity list are fetched once and
 * filtered locally (the backend caps the public list at 100); "my activity" is
 * one authenticated call that is skipped entirely when signed out.
 */

type Phase = "loading" | "ready" | "error";

function messageFor(error: unknown): string {
  return error instanceof Error ? error.message : "Something went wrong. Please try again.";
}

export function ExploreClient() {
  return (
    <Suspense fallback={<LoadingBlock label="Loading opportunities" />}>
      <Explore />
    </Suspense>
  );
}

function Explore() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const activeCategoryId = searchParams.get("category");

  const [phase, setPhase] = useState<Phase>("loading");
  const [error, setError] = useState<string | null>(null);
  const [categories, setCategories] = useState<Category[]>([]);
  const [opportunities, setOpportunities] = useState<Opportunity[]>([]);
  const [applications, setApplications] = useState<Application[] | null>(null);
  const [suspended, setSuspended] = useState(false);

  const load = useCallback(async () => {
    // Public first — an unauthenticated visitor still sees everything.
    const [catalog, list] = await Promise.all([
      fetchCategories().catch(() => []),
      fetchOpportunities().catch(() => []),
    ]);
    setCategories(catalog);
    setOpportunities(list);
    try {
      setApplications(await fetchMyApplications());
    } catch (caught) {
      // Suspended first: a suspended account must see SuspendedState, never
      // be nudged into the verification funnel.
      if (isSuspended(caught)) {
        setSuspended(true);
      } else if (isApiError(caught) && caught.code === "not_verified") {
        // Signed in but not verified — send them to the verification funnel
        // instead of a page they cannot act on. Routing only: the backend
        // stays authoritative and still refuses every write. A user with no
        // profile at all lands here too, and /verify sends them to /onboarding.
        router.replace("/verify");
      }
      // Signed out simply means no personal section here.
      setApplications(null);
    }
  }, [router]);

  useEffect(() => {
    void (async () => {
      try {
        await load();
        setPhase("ready");
      } catch (caught) {
        setError(messageFor(caught));
        setPhase("error");
      }
    })();
  }, [load]);

  // Retry resets the phase in the handler, not in the effect body.
  function retry() {
    setPhase("loading");
    setError(null);
    void load()
      .then(() => setPhase("ready"))
      .catch((caught: unknown) => {
        setError(messageFor(caught));
        setPhase("error");
      });
  }

  const activeCategory = useMemo(
    () => categories.find((category) => category.id === activeCategoryId) ?? null,
    [categories, activeCategoryId],
  );

  const visible = useMemo(
    () =>
      activeCategoryId
        ? opportunities.filter(
            (opportunity) => opportunity.category?.id === activeCategoryId,
          )
        : opportunities,
    [opportunities, activeCategoryId],
  );

  if (suspended) {
    return (
      <SuspendedState
        message="Your account has been suspended from participating in UniMatch."
        action={<SignOutButton />}
      />
    );
  }

  const joined = (applications ?? []).filter(isJoined);

  return (
    <>
      {/* Editorial opening — the atmosphere follows the selected category. */}
      <section
        data-category={activeCategory ? categoryKey(activeCategory) : "events"}
        className="animate-rise -mx-5 px-5 pt-10 pb-12 sm:-mx-8 sm:px-8"
      >
        <Label>{activeCategory?.name ?? "Discover"}</Label>
        <h1 className="type-display mt-4 text-display">
          {activeCategory
            ? `${activeCategory.name} coming up`
            : "What's happening"}
        </h1>
        <p className="mt-4 max-w-lg text-[15px] leading-relaxed text-muted">
          {activeCategory
            ? "Join one, then find the people going with you."
            : "Pick an opportunity, join it, and the people going with you become the people you find."}
        </p>
      </section>

      {/* Category navigation — data-driven from the admin catalog. */}
      {categories.length > 0 && (
        <nav aria-label="Categories" className="-mx-5 sm:-mx-8">
          <ul className="flex gap-2 overflow-x-auto px-5 pb-4 sm:px-8">
            <li>
              <CategoryChip
                active={!activeCategoryId}
                onClick={() => router.replace("/explore")}
              >
                All
              </CategoryChip>
            </li>
            {categories.map((category) => (
              <li key={category.id} data-category={categoryKey(category)}>
                <CategoryChip
                  active={category.id === activeCategoryId}
                  onClick={() =>
                    router.replace(`/explore?category=${category.id}`)
                  }
                >
                  {category.name}
                </CategoryChip>
              </li>
            ))}
          </ul>
        </nav>
      )}

      {/* Your activity — the way back into people discovery. */}
      {phase === "ready" && joined.length > 0 && (
        <section className="mt-10">
          <SectionHead
            action={
              <Link
                href="/matches"
                className="text-sm font-semibold text-muted hover:text-ink"
              >
                Matches
              </Link>
            }
          >
            You&apos;re going
          </SectionHead>
          <ul className="mt-6 grid gap-4 sm:grid-cols-2">
            {joined.map((application) => (
              <li key={application.id}>
                <JoinedCard
                  application={application}
                  onWithdraw={() =>
                    void withdrawApplication(application.id)
                      .then(() =>
                        setApplications((current) =>
                          (current ?? []).map((entry) =>
                            entry.id === application.id
                              ? { ...entry, status: "WITHDRAWN" }
                              : entry,
                          ),
                        ),
                      )
                      .catch(() => retry())
                  }
                />
              </li>
            ))}
          </ul>
        </section>
      )}

      {/* Opportunities. */}
      <section className="mt-14">
        <SectionHead>
          {activeCategory ? activeCategory.name : "All opportunities"}
        </SectionHead>

        {phase === "loading" && <LoadingBlock label="Loading opportunities" />}

        {phase === "error" && (
          <ErrorState
            message={error ?? "We couldn't load opportunities."}
            onRetry={retry}
          />
        )}

        {phase === "ready" && visible.length === 0 && (
          <EmptyState
            title="Nothing happening here yet"
            body={
              activeCategory
                ? `There are no upcoming ${activeCategory.name?.toLowerCase()} opportunities right now. Try another category.`
                : "There are no published opportunities right now. Check back soon — new ones go live all term."
            }
            action={
              activeCategory ? (
                <Button variant="outline" onClick={() => router.replace("/explore")}>
                  See all opportunities
                </Button>
              ) : null
            }
          />
        )}

        {phase === "ready" && visible.length > 0 && (
          <ul className="mt-8 space-y-10">
            {visible.map((opportunity, index) => (
              <li key={opportunity.id}>
                <OpportunityTile
                  opportunity={opportunity}
                  lead={index === 0 && !activeCategoryId}
                />
              </li>
            ))}
          </ul>
        )}
      </section>
    </>
  );
}

/* ------------------------------------------------------------- fragments -- */

function CategoryChip({
  children,
  active,
  onClick,
}: {
  children: React.ReactNode;
  active: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      aria-pressed={active}
      onClick={onClick}
      className={cx(
        "whitespace-nowrap rounded-full border px-4 py-2 text-sm font-semibold transition-colors",
        active
          ? "border-transparent bg-accent text-accent-ink"
          : "border-line bg-surface text-muted hover:border-ink hover:text-ink",
      )}
    >
      {children}
    </button>
  );
}

function JoinedCard({
  application,
  onWithdraw,
}: {
  application: Application;
  onWithdraw: () => void;
}) {
  const opportunity = application.opportunity;
  const when = formatWhen(opportunity.opportunity_date, opportunity.start_time);
  return (
    <article
      data-category={categoryKey(opportunity.category ?? {})}
      className="flex h-full flex-col justify-between gap-6 border-l-2 border-accent pl-5"
    >
      <div>
        <Label className="text-accent">You&apos;re going</Label>
        <h3 className="type-display mt-2 text-2xl leading-tight">
          {opportunity.title}
        </h3>
        <p className="mt-1 text-sm text-muted">
          {[when, opportunity.location].filter(Boolean).join(" · ")}
        </p>
      </div>
      <div className="flex flex-wrap items-center gap-3">
        <ButtonLink
          href={`/opportunities/${opportunity.id}/people`}
          className="px-5 py-2.5 text-[13px]"
        >
          {partnerCta(opportunity.activity, opportunity.title)}
        </ButtonLink>
        <Button
          variant="ghost"
          className="px-3 py-2 text-[13px]"
          onClick={onWithdraw}
        >
          Leave
        </Button>
      </div>
    </article>
  );
}

function OpportunityTile({
  opportunity,
  lead,
}: {
  opportunity: Opportunity;
  lead: boolean;
}) {
  const when = formatWhen(opportunity.opportunity_date, opportunity.start_time);

  if (lead) {
    return (
      <Link
        href={`/opportunities/${opportunity.id}`}
        data-category={categoryKey(opportunity.category ?? {})}
        className="group block"
      >
        <CoverImage
          src={opportunity.cover_image_url}
          alt={opportunity.title ?? "Opportunity"}
          slug={opportunity.category?.slug}
          name={opportunity.category?.name}
          priority
          sizes="(max-width: 1024px) 100vw, 1024px"
          className="animate-wipe-up aspect-4/3 sm:aspect-16/9"
        />
        <div className="mt-5">
          <Label className="text-accent">
            {[opportunity.activity?.name, opportunity.category?.name]
              .filter(Boolean)
              .join(" · ")}
          </Label>
          <h3 className="type-display mt-2 text-title">{opportunity.title}</h3>
          <p className="mt-2 text-sm text-muted">
            {[when, opportunity.location].filter(Boolean).join(" · ")}
          </p>
        </div>
      </Link>
    );
  }

  return (
    <Link
      href={`/opportunities/${opportunity.id}`}
      data-category={categoryKey(opportunity.category ?? {})}
      className="group flex gap-4 border-b border-line pb-6 sm:gap-6"
    >
      <CoverImage
        src={opportunity.cover_image_url}
        alt=""
        slug={opportunity.category?.slug}
        name={opportunity.category?.name}
        sizes="160px"
        className="aspect-4/3 w-28 shrink-0 sm:w-44"
      />
      <div className="min-w-0 flex-1">
        <Label className="text-accent">
          {[opportunity.activity?.name, opportunity.category?.name]
            .filter(Boolean)
            .join(" · ")}
        </Label>
        <h3 className="type-display mt-1 truncate text-xl sm:text-2xl">
          {opportunity.title}
        </h3>
        <p className="mt-1 truncate text-sm text-muted">
          {[when, opportunity.location].filter(Boolean).join(" · ")}
        </p>
        <p className="mt-3 text-sm font-semibold text-ink">
          {partnerCta(opportunity.activity, opportunity.title)}
          <span
            aria-hidden
            className="ml-2 inline-block text-accent transition-transform duration-300 group-hover:translate-x-1"
          >
            →
          </span>
        </p>
      </div>
    </Link>
  );
}