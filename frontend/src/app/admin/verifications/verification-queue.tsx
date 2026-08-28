"use client";

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
  type AdminDecisionStatus,
  type AdminVerificationItem,
} from "@/lib/api/admin-verification";

const FOCUS_RING =
  "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent focus-visible:ring-offset-2 focus-visible:ring-offset-background";

const BUTTON_BASE =
  "rounded-2xl px-4 py-2.5 text-sm font-semibold transition-transform active:scale-[0.98] disabled:pointer-events-none disabled:opacity-40";

const ACCENT_BUTTON = `${BUTTON_BASE} bg-accent text-white shadow-card ${FOCUS_RING}`;
const GHOST_BUTTON = `${BUTTON_BASE} border border-line bg-surface text-ink shadow-card hover:bg-line/40 ${FOCUS_RING}`;
const REJECT_BUTTON = `${BUTTON_BASE} border border-line bg-surface text-red-600 shadow-card hover:bg-red-50 ${FOCUS_RING}`;
const REJECT_SOLID_BUTTON = `${BUTTON_BASE} bg-red-600 text-white shadow-card hover:bg-red-700 ${FOCUS_RING}`;

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

function AlertIcon({ className }: { className?: string }) {
  return (
    <Icon className={className}>
      <circle cx="12" cy="12" r="10" />
      <path d="M12 8v4" />
      <path d="M12 16h.01" />
    </Icon>
  );
}

function DocumentIcon({ className }: { className?: string }) {
  return (
    <Icon className={className}>
      <path d="M15 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7Z" />
      <path d="M14 2v4a2 2 0 0 0 2 2h4" />
      <path d="M16 13H8" />
      <path d="M16 17H8" />
    </Icon>
  );
}

function StatusBadge({ children }: { children: ReactNode }) {
  return (
    <div className="mx-auto grid size-14 place-items-center rounded-2xl bg-accent/15 text-accent">
      {children}
    </div>
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

function EmptyQueue() {
  return (
    <section className="rounded-card border border-line bg-surface p-8 text-center shadow-card">
      <span className="mx-auto grid size-12 place-items-center rounded-2xl bg-accent/15 text-accent">
        <CheckIcon className="size-6" />
      </span>
      <h2 className="mt-4 text-lg font-bold tracking-tight">All caught up</h2>
      <p className="mx-auto mt-1 max-w-sm text-sm leading-relaxed text-muted">
        There are no pending verification submissions right now. New
        submissions will appear here as students upload them.
      </p>
    </section>
  );
}

function Notice({ children }: { children: ReactNode }) {
  return (
    <div
      role="status"
      aria-live="polite"
      className="flex items-start gap-3 rounded-card border border-line bg-surface p-4 shadow-card"
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
  const universityLine = university.name
    ? locationParts.length > 0
      ? `${university.name} · ${locationParts.join(", ")}`
      : university.name
    : "University not on file";
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
  if (confirmingVerify) {
    actions = (
      <div className="mt-5 rounded-card border border-line bg-background p-4">
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
      <div className="mt-5 rounded-card border border-line bg-background p-4">
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
          className={`mt-1.5 w-full rounded-2xl border border-line bg-surface px-4 py-3 text-[15px] text-ink shadow-card placeholder:text-muted/60 focus:border-accent disabled:opacity-40 ${FOCUS_RING}`}
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
    <article className="rounded-card border border-line bg-surface p-5 shadow-card">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <h2 className="text-lg font-bold tracking-tight">{name}</h2>
          <p className="mt-0.5 text-sm text-muted">{universityLine}</p>
        </div>
        <span className="shrink-0 rounded-full bg-accent/15 px-3 py-1 text-xs font-semibold text-accent">
          Pending
        </span>
      </div>

      <dl className="mt-4 grid grid-cols-1 gap-x-6 gap-y-3 text-sm sm:grid-cols-2">
        <Field label="Course" value={student.course} />
        <Field label="Academic year" value={academicYearLabel} />
        <Field label="Date of birth" value={dobLabel} />
        <Field label="Submitted" value={submittedLabel} />
      </dl>

      {documentStatus === "open" && (
        <p className="mt-4 rounded-card bg-accent/10 px-4 py-3 text-sm leading-relaxed text-ink">
          <strong className="font-semibold">Document opened</strong> in a new
          tab. This secure link expires in {documentExpiresIn ?? 5} minutes —
          request a fresh link to view it again.
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
  const [phase, setPhase] = useState<"loading" | "error" | "ready">("loading");
  const [items, setItems] = useState<AdminVerificationItem[]>([]);
  const [queueError, setQueueError] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);

  const loadQueue = useCallback(async () => {
    setQueueError(null);
    setPhase("loading");
    try {
      const queue = await fetchVerificationQueue("PENDING");
      setItems(queue);
      setPhase("ready");
    } catch (error) {
      console.error("Failed to load the verification queue:", error);
      setQueueError(messageFor(error));
      setPhase("error");
    }
  }, []);

  useEffect(() => {
    void (async () => {
      await loadQueue();
    })();
  }, [loadQueue]);

  const refresh = useCallback(async () => {
    setRefreshing(true);
    setQueueError(null);
    try {
      const queue = await fetchVerificationQueue("PENDING");
      setItems(queue);
      setPhase("ready");
    } catch (error) {
      console.error("Failed to refresh the verification queue:", error);
      setQueueError(messageFor(error));
      setPhase("error");
    } finally {
      setRefreshing(false);
    }
  }, []);

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
            className="h-44 animate-pulse rounded-card border border-line bg-surface shadow-card"
          />
        ))}
      </section>
    );
  } else if (phase === "error") {
    body = (
      <section className="mt-8 rounded-card border border-line bg-surface p-6 text-center shadow-card">
        <StatusBadge>
          <AlertIcon className="size-7" />
        </StatusBadge>
        <h2 className="mt-4 text-xl font-bold tracking-tight">
          Couldn&apos;t load the queue
        </h2>
        <p
          role="alert"
          className="mx-auto mt-2 max-w-md text-sm leading-relaxed text-muted"
        >
          {queueError}
        </p>
        <button
          type="button"
          onClick={() => void refresh()}
          disabled={refreshing}
          className={`mt-6 ${GHOST_BUTTON}`}
        >
          {refreshing ? "Loading…" : "Try again"}
        </button>
      </section>
    );
  } else {
    body = (
      <>
        {notice && <Notice>{notice}</Notice>}
        <section aria-live="polite" className="mt-6 space-y-4">
          {items.length === 0 ? (
            <EmptyQueue />
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
    <div>
      <header className="pt-12 text-center">
        <StatusBadge>
          <DocumentIcon className="size-7" />
        </StatusBadge>
        <h1 className="mt-5 text-3xl font-bold tracking-tight">
          Verification queue
        </h1>
        <p className="mx-auto mt-3 max-w-md text-[15px] leading-relaxed text-muted">
          Review pending student ID submissions. Documents stay private and are
          shown only to staff reviewers.
        </p>
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