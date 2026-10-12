"use client";

import { useRouter } from "next/navigation";
import {
  useCallback,
  useEffect,
  useState,
  type ReactNode,
} from "react";

import {
  AdminApiError,
  MAX_REJECTION_REASON_LENGTH,
  fetchVerificationDocumentUrl,
  fetchVerificationQueue,
  submitVerificationDecision,
  validateRejectionReason,
  type AdminApiErrorCode,
  type AdminDecisionStatus,
  type AdminVerificationItem,
  type AdminVerificationStatus,
} from "@/lib/api/admin-verification";

const BUTTON_BASE =
  "rounded-2xl px-4 py-2.5 text-sm font-semibold transition-transform active:scale-[0.98] disabled:pointer-events-none disabled:opacity-40";

const ACCENT_BUTTON = `${BUTTON_BASE} bg-accent text-white`;
const GHOST_BUTTON = `${BUTTON_BASE} border border-line bg-surface text-ink hover:bg-line/40`;
const REJECT_BUTTON = `${BUTTON_BASE} border border-line bg-surface text-red-600 hover:bg-red-50`;
const REJECT_SOLID_BUTTON = `${BUTTON_BASE} bg-red-600 text-white hover:bg-red-700`;

/** Reviewer-facing filters, defaulting to the actionable queue. */
const QUEUE_STATUSES: AdminVerificationStatus[] = [
  "PENDING",
  "VERIFIED",
  "REJECTED",
];

const STATUS_FILTER_LABELS: Record<AdminVerificationStatus, string> = {
  PENDING: "Pending",
  VERIFIED: "Verified",
  REJECTED: "Rejected",
};

function formatDate(iso: string): string | null {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) {
    return null;
  }
  return date.toLocaleDateString("en-US", {
    year: "numeric",
    month: "long",
    day: "numeric",
  });
}

function formatDateTime(iso: string): string | null {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) {
    return null;
  }
  return date.toLocaleString("en-US", {
    year: "numeric",
    month: "long",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}

function messageFor(error: unknown): string {
  if (error instanceof AdminApiError) {
    return error.message;
  }
  return "Something went wrong. Please try again.";
}

function Icon({
  children,
  className,
}: {
  children: ReactNode;
  className?: string;
}) {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.8}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      className={className}
    >
      {children}
    </svg>
  );
}

function CheckIcon({ className }: { className?: string }) {
  return (
    <Icon className={className}>
      <circle cx="12" cy="12" r="10" />
      <path d="m9 12 2 2 4-4" />
    </Icon>
  );
}

function Field({ label, value }: { label: string; value: ReactNode }) {
  return (
    <div>
      <dt className="text-xs font-semibold uppercase tracking-wide text-muted">
        {label}
      </dt>
      <dd className="mt-0.5 font-medium">{value || "—"}</dd>
    </div>
  );
}

function EmptyQueue({ status }: { status: AdminVerificationStatus }) {
  return (
    <section className="rounded-2xl border border-line bg-surface p-8 text-center">
      <span className="mx-auto grid size-12 place-items-center rounded-2xl bg-accent/12 text-accent">
        <CheckIcon className="size-6" />
      </span>
      <h2 className="mt-4 text-lg font-bold tracking-tight">All caught up</h2>
      <p className="mx-auto mt-1 max-w-sm text-sm leading-relaxed text-muted">
        {status === "PENDING"
          ? "There are no pending verification submissions right now. New submissions will appear here as students upload them."
          : `No ${STATUS_FILTER_LABELS[status].toLowerCase()} submissions to show.`}
      </p>
    </section>
  );
}

function Notice({ children }: { children: ReactNode }) {
  return (
    <div
      role="status"
      aria-live="polite"
      className="flex items-start gap-3 rounded-2xl border border-line bg-surface p-4"
    >
      <span className="mt-0.5 grid size-6 shrink-0 place-items-center rounded-full bg-emerald-100 text-emerald-700">
        <CheckIcon className="size-4" />
      </span>
      <p className="text-sm font-medium leading-relaxed">{children}</p>
    </div>
  );
}

function VerificationCard({
  item,
  onDecided,
  onRemoved,
}: {
  item: AdminVerificationItem;
  onDecided: (item: AdminVerificationItem, kind: AdminDecisionStatus) => void;
  onRemoved: (item: AdminVerificationItem, message: string) => void;
}) {
  const [documentStatus, setDocumentStatus] = useState<
    "idle" | "loading" | "open" | "error"
  >("idle");
  const [documentError, setDocumentError] = useState<string | null>(null);
  const [documentExpiresIn, setDocumentExpiresIn] = useState<number | null>(
    null,
  );
  const [confirmingVerify, setConfirmingVerify] = useState(false);
  const [rejecting, setRejecting] = useState(false);
  const [reason, setReason] = useState("");
  const [reasonError, setReasonError] = useState<string | null>(null);
  const [decisionBusy, setDecisionBusy] = useState<AdminDecisionStatus | null>(
    null,
  );
  const [decisionError, setDecisionError] = useState<string | null>(null);

  const student = item.student;
  const university = student.university;
  const name = student.first_name?.trim() || "Unnamed student";
  const locationParts = [university.city, university.state, university.country]
    .filter((part): part is string => Boolean(part));
  // A custom university has no catalog row, so its location is empty. The
  // student's own typed name is what must be compared against the document,
  // so it renders as the primary line and is flagged as unlisted.
  const isCustomUniversity = Boolean(student.custom_university_name);
  const universityLine = isCustomUniversity
    ? (student.custom_university_name as string)
    : university.name
      ? locationParts.length > 0
        ? `${university.name} · ${locationParts.join(", ")}`
        : university.name
      : student.university_label || "University not on file";
  const academicYearLabel =
    student.academic_year == null ? null : `Year ${student.academic_year}`;
  const dobLabel = student.date_of_birth
    ? formatDate(student.date_of_birth)
    : null;
  const submittedLabel = item.submitted_at
    ? formatDateTime(item.submitted_at)
    : null;
  const trimmedReasonLength = reason.trim().length;

  const busy = decisionBusy !== null || documentStatus === "loading";

  async function handleViewDocument() {
    if (documentStatus === "loading") {
      return;
    }
    setDocumentStatus("loading");
    setDocumentError(null);
    const tab = window.open("", "_blank");
    try {
      const { url, expires_in } = await fetchVerificationDocumentUrl(item.id);
      if (!tab) {
        setDocumentStatus("error");
        setDocumentError(
          "We couldn't open the document. Allow pop-ups for this site and try again.",
        );
        return;
      }
      tab.location.href = url;
      setDocumentExpiresIn(expires_in);
      setDocumentStatus("open");
    } catch (error) {
      if (tab) {
        tab.close();
      }
      setDocumentStatus("error");
      setDocumentError(messageFor(error));
    }
  }

  async function decide(kind: AdminDecisionStatus) {
    if (decisionBusy) {
      return;
    }
    if (kind === "REJECTED") {
      const validation = validateRejectionReason(reason);
      if (validation) {
        setReasonError(validation);
        return;
      }
    }
    setDecisionBusy(kind);
    setDecisionError(null);
    try {
      if (kind === "REJECTED") {
        await submitVerificationDecision(item.id, {
          status: "REJECTED",
          rejection_reason: reason.trim(),
        });
      } else {
        await submitVerificationDecision(item.id, { status: "VERIFIED" });
      }
      onDecided(item, kind);
    } catch (error) {
      if (error instanceof AdminApiError && error.isStale) {
        onRemoved(item, messageFor(error));
        return;
      }
      setDecisionError(messageFor(error));
    } finally {
      setDecisionBusy(null);
    }
  }

  let actions: ReactNode;
  // Only an undecided submission can be decided: the backend rejects any
  // transition out of VERIFIED/REJECTED, so don't offer the controls at all.
  if (item.status !== "PENDING") {
    actions = (
      <div className="mt-5 flex flex-col gap-2 sm:flex-row">
        <button
          type="button"
          onClick={() => void handleViewDocument()}
          disabled={busy}
          className={GHOST_BUTTON}
        >
          {documentStatus === "loading"
            ? "Opening…"
            : documentStatus === "open"
              ? "View again"
              : "View document"}
        </button>
        <p className="self-center text-sm text-muted">
          This submission is already {item.status.toLowerCase()}.
        </p>
      </div>
    );
  } else if (confirmingVerify) {
    actions = (
      <div className="mt-5 rounded-2xl border border-line bg-background p-4">
        <p className="text-sm font-semibold">Verify this submission?</p>
        <p className="mt-1 text-sm text-muted">
          This confirms the student ID is valid. The decision can&apos;t be
          undone.
        </p>
        <div className="mt-3 flex flex-col gap-2 sm:flex-row">
          <button
            type="button"
            onClick={() => void decide("VERIFIED")}
            disabled={busy}
            aria-busy={decisionBusy === "VERIFIED"}
            className={ACCENT_BUTTON}
          >
            {decisionBusy === "VERIFIED" ? "Verifying…" : "Confirm verify"}
          </button>
          <button
            type="button"
            onClick={() => setConfirmingVerify(false)}
            disabled={busy}
            className={GHOST_BUTTON}
          >
            Cancel
          </button>
        </div>
        {decisionError && (
          <p role="alert" className="mt-3 text-sm font-medium text-red-600">
            {decisionError}
          </p>
        )}
      </div>
    );
  } else if (rejecting) {
    actions = (
      <div className="mt-5 rounded-2xl border border-line bg-background p-4">
        <label
          htmlFor={`reject-reason-${item.id}`}
          className="text-sm font-semibold"
        >
          Rejection reason
        </label>
        <textarea
          id={`reject-reason-${item.id}`}
          value={reason}
          onChange={(event) => {
            setReason(event.target.value);
            setReasonError(null);
          }}
          rows={3}
          maxLength={MAX_REJECTION_REASON_LENGTH}
          placeholder="Explain why this document can't be accepted"
          disabled={busy}
          className={`mt-1.5 w-full rounded-2xl border border-line bg-surface px-4 py-3 text-[15px] text-ink placeholder:text-muted/60 focus:border-accent disabled:opacity-40 `}
        />
        <div className="mt-1 flex items-center justify-between gap-3 text-xs text-muted">
          <span>Shown to the student.</span>
          <span aria-live="polite">
            {trimmedReasonLength}/{MAX_REJECTION_REASON_LENGTH}
          </span>
        </div>
        {reasonError && (
          <p role="alert" className="mt-2 text-sm font-medium text-red-600">
            {reasonError}
          </p>
        )}
        <div className="mt-3 flex flex-col gap-2 sm:flex-row">
          <button
            type="button"
            onClick={() => void decide("REJECTED")}
            disabled={busy || trimmedReasonLength === 0}
            aria-busy={decisionBusy === "REJECTED"}
            className={REJECT_SOLID_BUTTON}
          >
            {decisionBusy === "REJECTED"
              ? "Rejecting…"
              : "Confirm rejection"}
          </button>
          <button
            type="button"
            onClick={() => {
              setRejecting(false);
              setReason("");
              setReasonError(null);
              setDecisionError(null);
            }}
            disabled={busy}
            className={GHOST_BUTTON}
          >
            Cancel
          </button>
        </div>
        {decisionError && (
          <p role="alert" className="mt-3 text-sm font-medium text-red-600">
            {decisionError}
          </p>
        )}
      </div>
    );
  } else {
    actions = (
      <div className="mt-5 flex flex-col gap-2 sm:flex-row">
        <button
          type="button"
          onClick={() => void handleViewDocument()}
          disabled={busy}
          className={GHOST_BUTTON}
        >
          {documentStatus === "loading"
            ? "Opening…"
            : documentStatus === "open"
              ? "View again"
              : "View document"}
        </button>
        <button
          type="button"
          onClick={() => {
            setRejecting(true);
            setConfirmingVerify(false);
          }}
          disabled={busy}
          className={REJECT_BUTTON}
        >
          Reject
        </button>
        <button
          type="button"
          onClick={() => {
            setConfirmingVerify(true);
            setRejecting(false);
          }}
          disabled={busy}
          className={ACCENT_BUTTON}
        >
          Verify
        </button>
      </div>
    );
  }

  return (
    <article className="rounded-2xl border border-line bg-surface p-5">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <h2 className="text-lg font-bold tracking-tight">{name}</h2>
          <p className="mt-0.5 text-sm text-muted">{universityLine}</p>
          {/* Typed by the student, so it can disagree with the document —
              that's exactly what the reviewer has to adjudicate. */}
          {isCustomUniversity && (
            <p className="mt-1 inline-flex rounded-full border border-line px-2 py-0.5 text-xs font-semibold text-muted">
              Not in our university list — student entered this name
            </p>
          )}
        </div>
        <span className="shrink-0 rounded-full bg-accent/12 px-3 py-1 text-xs font-semibold text-accent">
          {STATUS_FILTER_LABELS[item.status]}
        </span>
      </div>

      <dl className="mt-4 grid grid-cols-1 gap-x-6 gap-y-3 text-sm sm:grid-cols-2">
        <Field label="Course" value={student.course} />
        <Field label="Academic year" value={academicYearLabel} />
        <Field label="Date of birth" value={dobLabel} />
        <Field label="Submitted" value={submittedLabel} />
      </dl>

      {documentStatus === "open" && (
        <p className="mt-4 rounded-2xl bg-accent/12 px-4 py-3 text-sm leading-relaxed text-ink">
          <strong className="font-semibold">Document opened</strong> in a new
          tab.{" "}
          {/* The TTL is the server's configured value from the signed-URL
              response — never a client-side guess that could drift. */}
          {documentExpiresIn
            ? `This secure link expires in ${Math.round(
                documentExpiresIn / 60,
              )} minutes`
            : "This secure link is short-lived"}
          {" "}
          — request a fresh link to view it again.
        </p>
      )}
      {documentStatus === "error" && documentError && (
        <p role="alert" className="mt-4 text-sm font-medium text-red-600">
          {documentError}
        </p>
      )}

      {actions}

      <p className="mt-3 text-xs text-muted">
        Submission {item.id} · Profile {item.profile_id}
      </p>
    </article>
  );
}

export function VerificationQueue() {
  const router = useRouter();
  const [phase, setPhase] = useState<"loading" | "error" | "ready">("loading");
  const [items, setItems] = useState<AdminVerificationItem[]>([]);
  const [queueError, setQueueError] = useState<string | null>(null);
  const [queueErrorCode, setQueueErrorCode] =
    useState<AdminApiErrorCode | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [status, setStatus] = useState<AdminVerificationStatus>("PENDING");

  /** A signed-out reviewer must land on sign-in, not a static error panel. */
  const handleQueueError = useCallback(
    (error: unknown) => {
      if (error instanceof AdminApiError && error.code === "unauthorized") {
        router.replace("/login");
        return true;
      }
      setQueueErrorCode(error instanceof AdminApiError ? error.code : null);
      setQueueError(messageFor(error));
      setPhase("error");
      return false;
    },
    [router],
  );

  const loadQueue = useCallback(async () => {
    setQueueError(null);
    setQueueErrorCode(null);
    setPhase("loading");
    try {
      const queue = await fetchVerificationQueue(status);
      setItems(queue);
      setPhase("ready");
    } catch (error) {
      console.error("Failed to load the verification queue:", error);
      handleQueueError(error);
    }
  }, [status, handleQueueError]);

  useEffect(() => {
    void (async () => {
      await loadQueue();
    })();
  }, [loadQueue]);

  const refresh = useCallback(async () => {
    setRefreshing(true);
    setQueueError(null);
    setQueueErrorCode(null);
    try {
      const queue = await fetchVerificationQueue(status);
      setItems(queue);
      setPhase("ready");
    } catch (error) {
      console.error("Failed to refresh the verification queue:", error);
      handleQueueError(error);
    } finally {
      setRefreshing(false);
    }
  }, [status, handleQueueError]);

  const flash = useCallback((message: string) => {
    setNotice(message);
    window.setTimeout(() => setNotice(null), 6000);
  }, []);

  const handleDecided = useCallback(
    (item: AdminVerificationItem, kind: AdminDecisionStatus) => {
      setItems((current) => current.filter((entry) => entry.id !== item.id));
      const name = item.student.first_name?.trim() || "This student";
      flash(
        kind === "VERIFIED"
          ? `${name} was verified.`
          : `${name} was rejected.`,
      );
    },
    [flash],
  );

  const handleRemoved = useCallback(
    (item: AdminVerificationItem, message: string) => {
      setItems((current) => current.filter((entry) => entry.id !== item.id));
      flash(message);
    },
    [flash],
  );

  let body: ReactNode;

  if (phase === "loading") {
    body = (
      <section
        aria-busy="true"
        aria-live="polite"
        className="mt-8 space-y-4"
      >
        <span className="sr-only">Loading the verification queue</span>
        {[0, 1, 2].map((index) => (
          <div
            key={index}
            className="h-44 animate-pulse rounded-2xl border border-line bg-surface"
          />
        ))}
      </section>
    );
  } else if (phase === "error") {
    body = (
      <section className="mt-8 rounded-2xl border border-line bg-surface p-6">
        <h2 className="text-xl font-bold tracking-tight">
          {queueErrorCode === "permission_denied"
            ? "Reviewer access required"
            : queueErrorCode === "suspended"
              ? "Account suspended"
              : "Couldn't load the queue"}
        </h2>
        <p role="alert" className="mt-2 text-sm leading-relaxed text-muted">
          {queueError}
        </p>
        {/* Retrying can't fix an authorization or suspension problem, so don't
            offer it for those. */}
        {queueErrorCode !== "permission_denied" &&
          queueErrorCode !== "suspended" && (
            <button
              type="button"
              onClick={() => void refresh()}
              disabled={refreshing}
              className={`mt-6 ${GHOST_BUTTON}`}
            >
              {refreshing ? "Loading…" : "Try again"}
            </button>
          )}
      </section>
    );
  } else {
    body = (
      <>
        {notice && <Notice>{notice}</Notice>}
        <section aria-live="polite" className="mt-6 space-y-4">
          {items.length === 0 ? (
            <EmptyQueue status={status} />
          ) : (
            items.map((item) => (
              <VerificationCard
                key={item.id}
                item={item}
                onDecided={handleDecided}
                onRemoved={handleRemoved}
              />
            ))
          )}
        </section>
      </>
    );
  }

  return (
    <div className="mx-auto w-full max-w-3xl">
      <header className="border-b border-line pb-5">
        <span className="type-meta text-muted">People &amp; Verification</span>
        <h1 className="type-display mt-3 text-[clamp(2rem,6vw,3rem)]">
          Verification queue
        </h1>
        <p className="mt-3 max-w-2xl text-[15px] leading-relaxed text-muted">
          Review student ID submissions. Documents stay private and are shown
          only to staff reviewers.
        </p>

        {/* Real status filter — the backend already scopes by `status`. */}
        <div
          role="tablist"
          aria-label="Filter submissions by status"
          className="mt-6 inline-flex gap-1 rounded-full border border-line bg-surface p-1"
        >
          {QUEUE_STATUSES.map((option) => (
            <button
              key={option}
              type="button"
              role="tab"
              aria-selected={status === option}
              onClick={() => setStatus(option)}
              className={
                status === option
                  ? `${BUTTON_BASE} bg-accent text-accent-ink`
                  : `${BUTTON_BASE} text-muted hover:text-ink`
              }
            >
              {STATUS_FILTER_LABELS[option]}
            </button>
          ))}
        </div>
        {phase === "ready" && (
          <button
            type="button"
            onClick={() => void refresh()}
            disabled={refreshing}
            className={`mt-6 ${GHOST_BUTTON}`}
          >
            {refreshing ? "Refreshing…" : "Refresh queue"}
          </button>
        )}
      </header>
      {body}
    </div>
  );
}