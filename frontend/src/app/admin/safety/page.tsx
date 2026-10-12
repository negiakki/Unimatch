"use client";

import { useCallback, useState } from "react";

import {
  decideReport,
  fetchAdminReports,
  listBlocks,
  listSuspensions,
  removeBlock,
  unsuspendUser,
  type AdminBlock,
  type AdminReport,
  type ReportStatus,
  type Suspension,
} from "@/lib/api/admin";
import { isApiError } from "@/lib/api/http";
import { cx } from "@/lib/format";
import {
  Button,
  Chip,
  EmptyState,
  ErrorState,
  Label,
  Skeleton,
} from "@/components/ui";

import { useAdminLoad } from "../_admin-load";

/**
 * Safety & moderation console. Consolidates the existing read-only reports
 * view with three capabilities the backend already exposed but nothing called:
 * report decisions, user-to-user block moderation, and account suspensions.
 *
 * Every mutation goes to an existing staff endpoint. Nothing here invents a
 * transition the database doesn't already model, and no action is automatic —
 * a report never triggers a consequence without an explicit reviewer choice.
 */

const REASON_LABELS: Record<string, string> = {
  harassment: "Harassment or bullying",
  inappropriate_content: "Inappropriate content",
  fake_profile: "Fake profile",
  underage: "Under 18",
  spam: "Spam or scam",
  other: "Something else",
};

const DECISIONS: { status: ReportStatus; label: string; tone: string }[] = [
  { status: "REVIEWED", label: "Mark reviewed", tone: "border border-line bg-surface text-ink hover:border-line-strong" },
  { status: "DISMISSED", label: "Dismiss", tone: "border border-line bg-surface text-muted hover:border-line-strong" },
];

function dateLabel(iso: string | null): string {
  if (!iso) return "";
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "";
  return date.toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" });
}

function personLabel(person: AdminReport["reported"]): string {
  const place = person.university?.name ?? "";
  return [person.first_name ?? "Unknown student", person.course, place]
    .filter(Boolean)
    .join(" — ");
}

type Tab = "reports" | "suspensions" | "blocks";

export default function AdminSafetyPage() {
  const [tab, setTab] = useState<Tab>("reports");
  const [reports, setReports] = useState<AdminReport[]>([]);
  const [suspensions, setSuspensions] = useState<Suspension[]>([]);
  const [blocks, setBlocks] = useState<AdminBlock[]>([]);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);

  const load = useCallback(async () => {
    const [r, s, b] = await Promise.all([
      fetchAdminReports(),
      listSuspensions(),
      listBlocks(),
    ]);
    setReports(r);
    setSuspensions(s);
    setBlocks(b);
  }, []);

  const { phase, error, errorTitle, fatal, refresh } = useAdminLoad(load, []);

  const flash = useCallback((message: string) => {
    setNotice(message);
    window.setTimeout(() => setNotice(null), 6000);
  }, []);

  async function run(id: string, action: () => Promise<unknown>, message: string) {
    setBusyId(id);
    setActionError(null);
    try {
      await action();
      await load();
      flash(message);
    } catch (caught) {
      setActionError(
        isApiError(caught) ? caught.message : "That action couldn't be completed.",
      );
    } finally {
      setBusyId(null);
    }
  }

  return (
    <div className="mx-auto w-full max-w-4xl">
      <header className="border-b border-line pb-5">
        <Label>Safety &amp; Moderation</Label>
        <h1 className="type-display mt-3 text-[clamp(2rem,6vw,3rem)]">
          Reports, blocks &amp; suspensions
        </h1>
        <p className="mt-3 max-w-2xl text-[15px] leading-relaxed text-muted">
          Nothing here happens automatically. Every consequence is an explicit
          reviewer decision.
        </p>
      </header>

      <div role="tablist" aria-label="Moderation sections" className="mt-6 inline-flex gap-1 rounded-full border border-line bg-surface p-1">
        {(
          [
            ["reports", `Reports${reports.length ? ` (${reports.length})` : ""}`],
            ["suspensions", `Suspensions${suspensions.length ? ` (${suspensions.length})` : ""}`],
            ["blocks", `Blocks${blocks.length ? ` (${blocks.length})` : ""}`],
          ] as const
        ).map(([value, label]) => (
          <button
            key={value}
            type="button"
            role="tab"
            aria-selected={tab === value}
            onClick={() => setTab(value)}
            className={cx(
              "rounded-full px-4 py-2 text-sm font-semibold transition-colors",
              tab === value ? "bg-accent text-accent-ink" : "text-muted hover:text-ink",
            )}
          >
            {label}
          </button>
        ))}
      </div>

      {notice && (
        <p role="status" className="mt-6 rounded-2xl bg-accent/12 px-4 py-3 text-sm font-medium">
          {notice}
        </p>
      )}
      {actionError && (
        <p role="alert" className="mt-6 rounded-2xl border border-danger/30 bg-danger/5 px-4 py-3 text-sm font-medium text-danger">
          {actionError}
        </p>
      )}

      {phase === "loading" && (
        <div aria-busy="true" aria-live="polite" className="space-y-4">
          <span className="sr-only">Loading moderation data</span>
          {Array.from({ length: 3 }, (_, index) => (
            <Skeleton key={index} className="h-28 rounded-2xl" />
          ))}
        </div>
      )}

      {phase === "error" && (
        <ErrorState
          title={errorTitle ?? "Couldn't load this"}
          message={error ?? "Please try again."}
          onRetry={fatal ? undefined : refresh}
        />
      )}

      {phase === "ready" && tab === "reports" && (
        reports.length === 0 ? (
          <EmptyState title="No reports" body="Nobody has reported anything yet. New reports appear here." />
        ) : (
          <div className="mt-8 space-y-5">
            {reports.map((report) => (
              <article key={report.id} className="rounded-2xl border border-line bg-surface p-5">
                <div className="flex flex-wrap items-center gap-2">
                  <Chip tone="accent">{REASON_LABELS[report.reason] ?? report.reason}</Chip>
                  <Chip>{report.status}</Chip>
                  <span className="ml-auto text-xs text-muted">{dateLabel(report.created_at)}</span>
                </div>
                {report.detail && (
                  <p className="mt-3 whitespace-pre-wrap break-words text-[15px] leading-relaxed">{report.detail}</p>
                )}
                <dl className="mt-4 space-y-1 text-sm text-muted">
                  <div>
                    <dt className="inline font-semibold text-ink">Reported: </dt>
                    <dd className="inline">{personLabel(report.reported)}</dd>
                  </div>
                  <div>
                    <dt className="inline font-semibold text-ink">Reporter: </dt>
                    <dd className="inline">{report.reporter.first_name ?? "Unknown student"}</dd>
                  </div>
                  {report.content_type && (
                    <div>
                      <dt className="inline font-semibold text-ink">Content: </dt>
                      <dd className="inline">
                        {report.content_type}
                        {report.content_id ? ` · ${report.content_id}` : ""}
                      </dd>
                    </div>
                  )}
                  {report.opportunity && (
                    <div>
                      <dt className="inline font-semibold text-ink">Opportunity: </dt>
                      <dd className="inline">{report.opportunity.title ?? report.opportunity.id}</dd>
                    </div>
                  )}
                </dl>
                {report.status === "OPEN" && (
                  <div className="mt-4 flex flex-wrap gap-2">
                    {DECISIONS.map((decision) => (
                      <Button
                        key={decision.status}
                        className={decision.tone}
                        disabled={busyId === report.id}
                        onClick={() =>
                          void run(
                            report.id,
                            () => decideReport(report.id, decision.status),
                            decision.status === "DISMISSED"
                              ? "Report dismissed."
                              : "Report marked reviewed.",
                          )
                        }
                      >
                        {busyId === report.id ? "Saving…" : decision.label}
                      </Button>
                    ))}
                  </div>
                )}
              </article>
            ))}
          </div>
        )
      )}

      {phase === "ready" && tab === "suspensions" && (
        suspensions.length === 0 ? (
          <EmptyState title="No active suspensions" body="No account is currently restricted." />
        ) : (
          <div className="mt-8 space-y-4">
            {suspensions.map((suspension) => (
              <article key={suspension.id} className="rounded-2xl border border-line bg-surface p-5">
                <div className="flex flex-wrap items-center gap-2">
                  <Chip tone="accent">Suspended</Chip>
                  <Chip>{suspension.first_name ?? suspension.profile_id}</Chip>
                  <span className="ml-auto text-xs text-muted">
                    {suspension.suspended_until
                      ? `Until ${dateLabel(suspension.suspended_until)}`
                      : "Indefinite"}
                  </span>
                </div>
                <p className="mt-3 text-[15px]">{suspension.reason}</p>
                <Button
                  variant="outline"
                  className="mt-4"
                  disabled={busyId === suspension.profile_id}
                  onClick={() =>
                    void run(
                      suspension.profile_id,
                      () => unsuspendUser(suspension.profile_id),
                      "Suspension lifted.",
                    )
                  }
                >
                  {busyId === suspension.profile_id ? "Lifting…" : "Lift suspension"}
                </Button>
              </article>
            ))}
          </div>
        )
      )}

      {phase === "ready" && tab === "blocks" && (
        blocks.length === 0 ? (
          <EmptyState title="No active blocks" body="No user has blocked another user." />
        ) : (
          <div className="mt-8 space-y-4">
            {blocks.map((block) => (
              <article key={block.id} className="rounded-2xl border border-line bg-surface p-5">
                <p className="text-[15px]">
                  <span className="font-semibold">{block.blocker.first_name ?? "Unknown"}</span>{" "}
                  blocked{" "}
                  <span className="font-semibold">{block.blocked.first_name ?? "Unknown"}</span>
                </p>
                <p className="mt-1 text-xs text-muted">{dateLabel(block.created_at)}</p>
                <Button
                  variant="outline"
                  className="mt-4"
                  disabled={busyId === block.id}
                  onClick={() =>
                    void run(block.id, () => removeBlock(block.id), "Block lifted.")
                  }
                >
                  {busyId === block.id ? "Lifting…" : "Lift block"}
                </Button>
              </article>
            ))}
          </div>
        )
      )}
    </div>
  );
}