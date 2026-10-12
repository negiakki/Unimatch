"use client";

import Link from "next/link";
import { useCallback, useState } from "react";

import {
  fetchDashboard,
  type DashboardMetrics,
} from "@/lib/api/admin";
import { cx } from "@/lib/format";
import { ButtonLink, ErrorState, Label, Skeleton } from "@/components/ui";

import { useAdminLoad } from "./_admin-load";

/**
 * Admin overview. Every number here is a real COUNT served by
 * `GET /api/v1/admin/dashboard` — nothing is computed client-side or invented,
 * and there is no fallback value when a figure is missing.
 */

interface Tile {
  label: string;
  value: number;
  href?: string;
  hint?: string;
}

export default function AdminOverviewPage() {
  const [metrics, setMetrics] = useState<DashboardMetrics | null>(null);

  const load = useCallback(async () => {
    setMetrics(await fetchDashboard());
  }, []);

  const { phase, error, errorTitle, fatal, refresh } = useAdminLoad(load, []);

  const tiles: Tile[] = metrics
    ? [
        {
          label: "Pending verifications",
          value: metrics.verification.pending,
          href: "/admin/verifications",
          hint: "Submissions waiting for a reviewer",
        },
        {
          label: "Open reports",
          value: metrics.reports.open,
          href: "/admin/safety",
          hint: `${metrics.reports.total} total`,
        },
        {
          label: "Active suspensions",
          value: metrics.suspensions.active,
          href: "/admin/safety",
          hint: "Accounts currently restricted",
        },
        {
          label: "Published opportunities",
          value: metrics.opportunities.published,
          href: "/admin/opportunities",
          hint: `${metrics.opportunities.total} total`,
        },
        {
          label: "Verified students",
          value: metrics.users.verified,
          href: "/admin/people",
          hint: `${metrics.users.total} profiles`,
        },
        {
          label: "Active matches",
          value: metrics.matches.active,
          hint: "Live conversations on the platform",
        },
        {
          label: "Live applications",
          value: metrics.applications.applied,
          href: "/admin/opportunities",
          hint: `${metrics.applications.total} total`,
        },
      ]
    : [];

  return (
    <div className="mx-auto w-full max-w-5xl">
      <header className="border-b border-line pb-5">
        <Label>Overview</Label>
        <h1 className="type-display mt-3 text-[clamp(2rem,6vw,3rem)]">
          What needs attention
        </h1>
        <p className="mt-3 max-w-2xl text-[15px] leading-relaxed text-muted">
          Live platform counts, straight from the database.
        </p>
      </header>

      {phase === "loading" && (
        <div aria-busy="true" aria-live="polite">
          <span className="sr-only">Loading dashboard metrics</span>
          <div className="mt-8 grid grid-cols-2 gap-4 lg:grid-cols-4">
            {Array.from({ length: 7 }, (_, index) => (
              <Skeleton key={index} className={cx("h-28 rounded-2xl", index === 6 && "col-span-2 lg:col-span-1")} />
            ))}
          </div>
        </div>
      )}

      {phase === "error" && (
        <ErrorState
          title={errorTitle ?? "Couldn't load this"}
          message={error ?? "Please try again."}
          onRetry={fatal ? undefined : refresh}
        />
      )}

      {phase === "ready" && metrics && (
        <>
          {tiles.length === 0 ? (
            <p className="mt-10 text-[15px] text-muted">No metrics available.</p>
          ) : (
            <div className="mt-8 grid grid-cols-2 gap-4 lg:grid-cols-4">
              {tiles.map((tile) => {
                const body = (
                  <>
                    <p className="type-meta text-muted">{tile.label}</p>
                    <p className="type-display mt-3 text-[clamp(2rem,5vw,2.75rem)]">
                      {tile.value}
                    </p>
                    {tile.hint && (
                      <p className="mt-1 text-[13px] text-muted">{tile.hint}</p>
                    )}
                  </>
                );
                return tile.href ? (
                  <Link
                    key={tile.label}
                    href={tile.href}
                    className="rounded-2xl border border-line bg-surface p-5 transition-transform hover:border-line-strong active:scale-[0.99]"
                  >
                    {body}
                  </Link>
                ) : (
                  <div
                    key={tile.label}
                    className="rounded-2xl border border-line bg-surface p-5"
                  >
                    {body}
                  </div>
                );
              })}
            </div>
          )}

          <section className="mt-14">
            <Label>Queues</Label>
            <div className="mt-4 flex flex-wrap gap-3">
              <ButtonLink variant="outline" href="/admin/verifications">
                Review verifications
              </ButtonLink>
              <ButtonLink variant="outline" href="/admin/safety">
                Review reports
              </ButtonLink>
              <ButtonLink variant="outline" href="/admin/opportunities">
                Manage opportunities
              </ButtonLink>
              <ButtonLink variant="outline" href="/admin/catalog">
                Manage catalog
              </ButtonLink>
            </div>
          </section>
        </>
      )}
    </div>
  );
}