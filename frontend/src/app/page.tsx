import Link from "next/link";

import { fetchCategories } from "@/lib/api/catalog";
import { fetchOpportunities } from "@/lib/api/opportunities";
import { categoryKey, formatWhen } from "@/lib/format";
import { ButtonLink, CoverImage, Label } from "@/components/ui";

export const revalidate = 300;

/**
 * The public front door. It should feel like entering an active university
 * social ecosystem — not opening a dashboard — so it opens on an oversized
 * editorial statement, moves through a moving category band, then shows real
 * opportunities at two different scales.
 *
 * The opportunity and category reads are public (anon SELECT), so this renders
 * on the server with a five-minute cache. A backend hiccup degrades to the
 * static composition instead of failing the page.
 */

const STEPS = [
  {
    title: "Pick what's happening",
    body: "Sports, events, concerts, movie nights, campus life. Admin-created opportunities, with the date and place already set.",
  },
  {
    title: "Say you're going",
    body: "Join the opportunity. That's the context — you only ever meet people through something you're both doing.",
  },
  {
    title: "Find your partner",
    body: "Browse the people who applied for the same thing. Interested or pass. Mutual interest and you can talk for 24 hours.",
  },
];

const MARQUEE_ITEMS = [
  "Find your people",
  "Dandiya",
  "Badminton",
  "Movie night",
  "College fest",
  "Concerts",
  "Find your partner",
];

export default async function Home() {
  const [opportunities, categories] = await Promise.all([
    fetchOpportunities().catch(() => []),
    fetchCategories().catch(() => []),
  ]);

  const [featured, ...rest] = opportunities;
  const categoryNames = categories.length
    ? categories.map((category) => category.name).filter(Boolean)
    : null;
  const marquee = MARQUEE_ITEMS;

  return (
    <main className="flex-1">
      {/* ---------------------------------------------------------- header */}
      <header className="mx-auto flex w-full max-w-6xl items-center justify-between px-5 py-5 sm:px-8">
        <span className="type-display text-xl tracking-tight">UniMatch</span>
        <nav aria-label="Account" className="flex items-center gap-5">
          <Link
            href="/login"
            className="text-sm font-semibold text-muted transition-colors hover:text-ink"
          >
            Sign in
          </Link>
          <Link
            href="/signup"
            className="rounded-full bg-ink px-5 py-2 text-sm font-semibold text-paper transition-transform active:scale-[0.98]"
          >
            Join
          </Link>
        </nav>
      </header>

      {/* ------------------------------------------------------------- hero */}
      <section className="relative overflow-hidden pt-8 pb-16 sm:pt-14">
        <div className="mx-auto w-full max-w-6xl px-5 sm:px-8">
          <Label className="animate-rise">
            For verified university students
          </Label>

          <h1 className="mt-6">
            <span className="block overflow-hidden">
              <span className="type-display animate-line-in block text-hero">
                Find your
              </span>
            </span>
            <span className="block overflow-hidden">
              <span
                className="type-display animate-line-in block text-hero text-accent"
                style={{ "--i": 1 } as React.CSSProperties}
              >
                people
              </span>
            </span>
          </h1>

          <div className="mt-8 grid gap-10 md:grid-cols-12 md:gap-8">
            <p className="type-display animate-rise text-title md:col-span-5 md:text-[clamp(1.5rem,3vw,2.25rem)]">
              for whatever you&apos;re doing.
            </p>
            <div className="animate-rise md:col-span-6 md:col-start-7" style={{ "--i": 1 } as React.CSSProperties}>
              <p className="max-w-md text-[15px] leading-relaxed text-muted">
                UniMatch starts with what you&apos;re doing, not who you want to
                meet. Join an opportunity, and the people who are also going
                become the people you find.
              </p>
              <div className="mt-8 flex flex-wrap gap-3">
                <ButtonLink href="/signup">Get started</ButtonLink>
                <ButtonLink href="/explore" variant="outline">
                  See what&apos;s happening
                </ButtonLink>
              </div>
            </div>
          </div>
        </div>
      </section>

      {/* ---------------------------------------------------------- marquee */}
      {/*
        A brand device, not navigation: one slow horizontal run that names the
        product and its worlds. Disabled under prefers-reduced-motion.
      */}
      <section
        aria-hidden
        className="grain overflow-hidden bg-ink py-5 text-paper"
      >
        <div
          className="marquee-track flex w-max items-center gap-8"
          style={{ "--marquee-duration": "42s" } as React.CSSProperties}
        >
          {[0, 1].map((copy) => (
            <div key={copy} className="flex shrink-0 items-center gap-8">
              {marquee.map((word) => (
                <span key={word} className="flex items-center gap-8">
                  <span className="type-display whitespace-nowrap text-2xl">
                    {word}
                  </span>
                  <span className="text-accent">✳</span>
                </span>
              ))}
            </div>
          ))}
        </div>
      </section>

      {/* ------------------------------------------------- what's happening */}
      {featured ? (
        <section className="bg-ink py-16 text-paper sm:py-24">
          <div className="mx-auto w-full max-w-6xl px-5 sm:px-8">
            <div className="flex items-end justify-between gap-6 border-b border-paper/20 pb-4">
              <h2 className="type-display text-[clamp(2rem,7vw,4rem)]">
                What&apos;s happening
              </h2>
              <Link
                href="/explore"
                className="shrink-0 text-sm font-semibold text-paper underline underline-offset-4 hover:text-accent"
              >
                All opportunities
              </Link>
            </div>

            {/* One big editorial moment. */}
            <FeaturedOpportunity opportunity={featured} />

            {/* The rest at a deliberately different scale — typographic rows,
                not another card grid. */}
            {rest.length > 0 && (
              <ul className="mt-4 divide-y divide-paper/15 border-t border-paper/15">
                {rest.slice(0, 6).map((opportunity) => (
                  <li key={opportunity.id}>
                    <OpportunityRow opportunity={opportunity} />
                  </li>
                ))}
              </ul>
            )}
          </div>
        </section>
      ) : (
        <section className="grain bg-ink py-20 text-paper">
          <div className="mx-auto w-full max-w-6xl px-5 sm:px-8">
            <Label className="text-paper/50">What&apos;s happening</Label>
            <h2 className="type-display mt-4 text-display">
              Nothing happening yet.
            </h2>
            <p className="mt-4 max-w-md text-[15px] leading-relaxed text-paper/60">
              Opportunities are created by the UniMatch team. Join UniMatch and
              you&apos;ll see them the moment they go live.
            </p>
          </div>
        </section>
      )}

      {/* -------------------------------------------------------- categories */}
      {categoryNames && (
        <section className="mx-auto w-full max-w-6xl px-5 py-16 sm:px-8 sm:py-24">
          <h2 className="type-display text-display">Pick a world</h2>
          <ol className="mt-10 divide-y divide-line border-t border-line">
            {categories.map((category, index) => (
              <li key={category.id} data-category={categoryKey(category)}>
                <Link
                  href={`/explore?category=${category.id}`}
                  className="group flex items-baseline gap-6 py-6 transition-colors hover:bg-accent/5"
                >
                  <span className="type-meta w-8 shrink-0 text-accent">
                    {String(index + 1).padStart(2, "0")}
                  </span>
                  <span className="type-display flex-1 text-[clamp(1.75rem,6vw,3.5rem)] leading-none transition-transform duration-300 group-hover:translate-x-2">
                    {category.name}
                  </span>
                  <span
                    aria-hidden
                    className="shrink-0 text-xl text-muted transition-transform duration-300 group-hover:translate-x-1 group-hover:text-accent"
                  >
                    →
                  </span>
                </Link>
              </li>
            ))}
          </ol>
        </section>
      )}

      {/* ------------------------------------------------------- how it works */}
      <section className="grain bg-accent text-accent-ink">
        <div className="mx-auto w-full max-w-6xl px-5 py-16 sm:px-8 sm:py-24">
          <h2 className="type-display text-display">How it works</h2>
          <ol className="mt-12 grid gap-10 sm:grid-cols-3 sm:gap-8">
            {STEPS.map((step, index) => (
              <li
                key={step.title}
                className="animate-rise border-t border-accent-ink/30 pt-5"
                style={{ "--i": index } as React.CSSProperties}
              >
                <span className="type-meta text-accent-ink/60">
                  Step {index + 1}
                </span>
                <h3 className="type-display mt-3 text-title">{step.title}</h3>
                <p className="mt-3 text-[15px] leading-relaxed text-accent-ink/80">
                  {step.body}
                </p>
              </li>
            ))}
          </ol>
        </div>
      </section>

      {/* ------------------------------------------------------------ footer */}
      <footer className="bg-ink text-paper">
        <div className="mx-auto w-full max-w-6xl px-5 py-14 sm:px-8">
          <div className="flex flex-wrap items-end justify-between gap-8">
            <div>
              <p className="type-display text-display leading-[0.9]">
                Find your people
                <br />
                for whatever you&apos;re doing.
              </p>
              <p className="mt-5 max-w-sm text-sm leading-relaxed text-paper/55">
                Every member is a real student with a verified university ID.
                Verification is manual, and your document stays private.
              </p>
            </div>
            <div className="flex gap-6 text-sm font-semibold">
              <Link href="/signup" className="hover:text-accent">
                Join UniMatch
              </Link>
              <Link href="/login" className="hover:text-accent">
                Sign in
              </Link>
            </div>
          </div>
          <p className="mt-12 border-t border-paper/15 pt-6 text-xs text-paper/40">
            © {new Date().getFullYear()} UniMatch
          </p>
        </div>
      </footer>
    </main>
  );
}

/* ------------------------------------------------------------- fragments -- */

function FeaturedOpportunity({
  opportunity,
}: {
  opportunity: Awaited<ReturnType<typeof fetchOpportunities>>[number];
}) {
  const when = formatWhen(opportunity.opportunity_date, opportunity.start_time);
  return (
    <Link
      href={`/opportunities/${opportunity.id}`}
      data-category={categoryKey(opportunity.category ?? {})}
      className="group mt-10 block"
    >
      <div className="relative overflow-hidden">
        <CoverImage
          src={opportunity.cover_image_url}
          alt={opportunity.title ?? "Opportunity"}
          slug={opportunity.category?.slug}
          name={opportunity.category?.name}
          priority
          sizes="(max-width: 1024px) 100vw, 1024px"
          className="animate-wipe-up aspect-16/10 sm:aspect-21/9"
        />
      </div>
      <div className="mt-5 flex flex-wrap items-end justify-between gap-4">
        <div>
          <Label className="text-accent">
            {[opportunity.activity?.name, opportunity.category?.name]
              .filter(Boolean)
              .join(" · ")}
          </Label>
          <h3 className="type-display mt-2 text-[clamp(2rem,6vw,4rem)] leading-[0.95]">
            {opportunity.title}
          </h3>
        </div>
        <p className="shrink-0 pb-2 text-sm text-paper/60">
          {[when, opportunity.location].filter(Boolean).join(" · ")}
        </p>
      </div>
    </Link>
  );
}

function OpportunityRow({
  opportunity,
}: {
  opportunity: Awaited<ReturnType<typeof fetchOpportunities>>[number];
}) {
  const when = formatWhen(opportunity.opportunity_date, opportunity.start_time);
  return (
    <Link
      href={`/opportunities/${opportunity.id}`}
      data-category={categoryKey(opportunity.category ?? {})}
      className="group flex items-center gap-4 py-5 transition-colors hover:bg-paper/5 sm:gap-8"
    >
      <CoverImage
        src={opportunity.cover_image_url}
        alt=""
        slug={opportunity.category?.slug}
        name={opportunity.category?.name}
        sizes="96px"
        className="aspect-square w-20 shrink-0 sm:w-28"
      />
      <span className="min-w-0 flex-1">
        <span className="type-meta block text-accent">
          {[opportunity.activity?.name, opportunity.category?.name]
            .filter(Boolean)
            .join(" · ")}
        </span>
        <span className="type-display mt-1 block truncate text-xl sm:text-2xl">
          {opportunity.title}
        </span>
        <span className="mt-1 block truncate text-sm text-paper/55">
          {[when, opportunity.location].filter(Boolean).join(" · ")}
        </span>
      </span>
      <span
        aria-hidden
        className="shrink-0 text-lg text-paper/40 transition-transform duration-300 group-hover:translate-x-1 group-hover:text-accent"
      >
        →
      </span>
    </Link>
  );
}