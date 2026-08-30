"use client";

import { useEffect, useState } from "react";

import {
  AdminReportsApiError,
  fetchAdminReports,
  type AdminReportItem,
} from "@/lib/api/admin-reports";

/**
 * Staff report list (read-only, v1). Newest first, reviewer-safe metadata
 * only — no actions are offered: a report never triggers an automatic
 * consequence, and the status transition workflow is a future slice.
 */

const REASON_LABELS: Record<string, string> = {
  harassment: "Harassment or bullying",
  inappropriate_content: "Inappropriate content",
  fake_profile: "Fake profile",
  underage: "Under 18",
  spam: "Spam or scam",
  other: "Something else",
};

function dateLabel(iso: string | null): string {
  if (!iso) {
    return "";
  }
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) {
    return "";
  }
  return date.toLocaleString(undefined, {
    dateStyle: "medium",
    timeStyle: "short",
  });
}

function personLabel(person: AdminReportItem["reported"]): string {
  const place = person.university
    ? [person.university.name, person.university.city].filter(Boolean).join(" · ")
    : "";
  return [person.first_name ?? "Unknown student", person.course, place]
    .filter(Boolean)
    .join(" — ");
}

export function AdminReportsList() {
  const [phase, setPhase] = useState<"loading" | "ready" | "error">("loading");
  const [reports, setReports] = useState<AdminReportItem[]>([]);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    void (async () => {
      try {
        const items = await fetchAdminReports();
        setReports(items);
        setPhase("ready");
      } catch (caught) {
        setError(
          caught instanceof AdminReportsApiError
            ? caught.message
            : "Something went wrong. Please try again.",
        );
        setPhase("error");
      }
    })();
  }, []);

  return (
    <section className="pt-10">
      <div className="flex items-center justify-between gap-2">
        <h1 className="text-3xl font-bold tracking-tight">Reports</h1>
        <a
          href="/admin/verifications"
          className="rounded-xl border border-line bg-surface px-4 py-2 text-sm font-semibold text-ink shadow-card transition-transform active:scale-[0.98]"
        >
          Verifications
        </a>
      </div>
      <p className="mt-2 text-[15px] leading-relaxed text-muted">
        Reports are reviewed manually — nothing happens automatically.
      </p>

      {phase === "loading" && (
        <div className="mt-8 space-y-4" aria-busy="true" aria-live="polite">
          <span className="sr-only">Loading reports</span>
          {[0, 1, 2].map((index) => (
            <div key={index} className="h-28 animate-pulse rounded-card bg-line" />
          ))}
        </div>
      )}

      {phase === "error" && (
        <p role="alert" className="mt-8 text-[15px] leading-relaxed text-muted">
          {error}
        </p>
      )}

      {phase === "ready" && reports.length === 0 && (
        <p className="mt-10 text-[15px] leading-relaxed text-muted">
          No reports yet.
        </p>
      )}

      {phase === "ready" && reports.length > 0 && (
        <div className="mt-8 space-y-5">
          {reports.map((report) => (
            <article
              key={report.id}
              className="rounded-card border border-line bg-surface p-5 shadow-card"
            >
              <div className="flex flex-wrap items-center gap-2">
                <span className="rounded-full bg-accent/10 px-3 py-1 text-xs font-semibold text-accent">
                  {REASON_LABELS[report.reason] ?? report.reason}
                </span>
                <span className="rounded-full border border-line px-3 py-1 text-xs font-semibold text-muted">
                  {report.status}
                </span>
                <span className="ml-auto text-xs text-muted">
                  {dateLabel(report.created_at)}
                </span>
              </div>
              {report.detail && (
                <p className="mt-3 whitespace-pre-wrap break-words text-[15px] leading-relaxed text-ink">
                  {report.detail}
                </p>
              )}
              <dl className="mt-4 space-y-1 text-sm text-muted">
                <div>
                  <dt className="inline font-semibold text-ink">Reported: </dt>
                  <dd className="inline">{personLabel(report.reported)}</dd>
                </div>
                <div>
                  <dt className="inline font-semibold text-ink">Reporter: </dt>
                  <dd className="inline">
                    {report.reporter.first_name ?? "Unknown student"}
                  </dd>
                </div>
                {report.content_type && (
                  <div>
                    <dt className="inline font-semibold text-ink">Content: </dt>
                    <dd className="inline">
                      {report.content_type} · {report.content_id}
                    </dd>
                  </div>
                )}
              </dl>
            </article>
          ))}
        </div>
      )}
    </section>
  );
}
