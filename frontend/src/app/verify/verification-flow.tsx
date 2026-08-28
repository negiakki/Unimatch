"use client";

import Image from "next/image";
import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type ChangeEvent,
  type DragEvent,
  type FormEvent,
  type ReactNode,
} from "react";

import {
  VerificationApiError,
  fetchVerificationState,
  submitVerificationDocument,
  validateVerificationDocument,
  type VerificationState,
} from "@/lib/api/verification";

const ACCEPTED_FILES =
  "image/jpeg,image/png,image/webp,application/pdf,.jpg,.jpeg,.png,.webp,.pdf";

const FOCUS_RING =
  "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent focus-visible:ring-offset-2 focus-visible:ring-offset-background";

function formatFileSize(bytes: number): string {
  if (bytes >= 1024 * 1024) {
    return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  }
  if (bytes >= 1024) {
    return `${Math.round(bytes / 1024)} KB`;
  }
  return `${bytes} B`;
}

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

function messageFor(error: unknown): string {
  if (error instanceof VerificationApiError) {
    return error.message;
  }
  return "Something went wrong. Please try again.";
}

function Icon({ children, className }: { children: ReactNode; className?: string }) {
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

function UploadIcon({ className }: { className?: string }) {
  return (
    <Icon className={className}>
      <path d="M4 14.9A7 7 0 1 1 15.71 8h1.79a4.5 4.5 0 0 1 2.5 8.24" />
      <path d="M12 12v9" />
      <path d="m8 17 4-4 4 4" />
    </Icon>
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

function ClockIcon({ className }: { className?: string }) {
  return (
    <Icon className={className}>
      <circle cx="12" cy="12" r="10" />
      <path d="M12 6v6l4 2" />
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

function AlertIcon({ className }: { className?: string }) {
  return (
    <Icon className={className}>
      <circle cx="12" cy="12" r="10" />
      <path d="M12 8v4" />
      <path d="M12 16h.01" />
    </Icon>
  );
}

function LockIcon({ className }: { className?: string }) {
  return (
    <Icon className={className}>
      <rect width="18" height="11" x="3" y="11" rx="2" />
      <path d="M7 11V7a5 5 0 0 1 10 0v4" />
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

export function VerificationFlow() {
  const [phase, setPhase] = useState<"loading" | "ready" | "error">("loading");
  const [state, setState] = useState<VerificationState | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);

  const [file, setFile] = useState<File | null>(null);
  const [previewUrl, setPreviewUrl] = useState<string | null>(null);
  const [fileError, setFileError] = useState<string | null>(null);
  const [submitError, setSubmitError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [dragging, setDragging] = useState(false);

  const inputRef = useRef<HTMLInputElement>(null);
  const previewUrlRef = useRef<string | null>(null);

  const loadStatus = useCallback(async () => {
    try {
      const nextState = await fetchVerificationState();
      setState(nextState);
      setPhase("ready");
    } catch (error) {
      console.error("Failed to load verification status:", error);
      setLoadError(messageFor(error));
      setPhase("error");
    }
  }, []);

  useEffect(() => {
    void (async () => {
      await loadStatus();
    })();
  }, [loadStatus]);

  useEffect(() => {
    return () => {
      if (previewUrlRef.current) {
        URL.revokeObjectURL(previewUrlRef.current);
      }
    };
  }, []);

  const openPicker = useCallback(() => inputRef.current?.click(), []);

  const clearFile = useCallback(() => {
    if (previewUrlRef.current) {
      URL.revokeObjectURL(previewUrlRef.current);
      previewUrlRef.current = null;
    }
    setFile(null);
    setPreviewUrl(null);
    setFileError(null);
    setSubmitError(null);
    if (inputRef.current) {
      inputRef.current.value = "";
    }
  }, []);

  const selectFile = useCallback((nextFile: File | null | undefined) => {
    if (!nextFile) {
      return;
    }
    setSubmitError(null);
    const validationMessage = validateVerificationDocument(nextFile);
    if (validationMessage) {
      setFile(null);
      setPreviewUrl(null);
      setFileError(validationMessage);
      return;
    }
    if (previewUrlRef.current) {
      URL.revokeObjectURL(previewUrlRef.current);
      previewUrlRef.current = null;
    }
    if (nextFile.type.startsWith("image/")) {
      previewUrlRef.current = URL.createObjectURL(nextFile);
    }
    setFileError(null);
    setFile(nextFile);
    setPreviewUrl(previewUrlRef.current);
  }, []);

  const retryStatus = useCallback(() => {
    setPhase("loading");
    setLoadError(null);
    void loadStatus();
  }, [loadStatus]);

  function handleInputChange(event: ChangeEvent<HTMLInputElement>) {
    const nextFile = event.target.files?.[0] ?? null;
    event.target.value = "";
    selectFile(nextFile);
  }

  function handleDragOver(event: DragEvent<HTMLButtonElement>) {
    event.preventDefault();
    if (!submitting) {
      setDragging(true);
    }
  }

  function handleDragLeave() {
    setDragging(false);
  }

  function handleDrop(event: DragEvent<HTMLButtonElement>) {
    event.preventDefault();
    setDragging(false);
    if (submitting) {
      return;
    }
    selectFile(event.dataTransfer.files?.[0] ?? null);
  }

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!file || submitting) {
      return;
    }
    setSubmitting(true);
    setSubmitError(null);
    try {
      const submission = await submitVerificationDocument(file);
      setState({ verification_status: submission.status, submission });
      clearFile();
    } catch (error) {
      if (
        error instanceof VerificationApiError &&
        (error.code === "pending_submission_exists" ||
          error.code === "already_verified")
      ) {
        await loadStatus();
        return;
      }
      setSubmitError(messageFor(error));
    } finally {
      setSubmitting(false);
    }
  }

  const isPdf =
    file !== null &&
    (file.type === "application/pdf" ||
      file.name.toLowerCase().endsWith(".pdf"));

  const uploadForm = (
    <form onSubmit={handleSubmit} noValidate className="mt-8">
      <input
        ref={inputRef}
        type="file"
        accept={ACCEPTED_FILES}
        onChange={handleInputChange}
        className="hidden"
        aria-label="Student ID document"
        disabled={submitting}
      />
      {file ? (
        <div className="rounded-card border border-line bg-surface p-4 shadow-card">
          <div className="flex items-center gap-3">
            {previewUrl ? (
              <Image
                src={previewUrl}
                alt=""
                width={56}
                height={56}
                unoptimized
                className="size-14 shrink-0 rounded-xl border border-line object-cover"
              />
            ) : (
              <span className="grid size-14 shrink-0 place-items-center rounded-xl bg-background text-muted">
                <DocumentIcon className="size-6" />
              </span>
            )}
            <div className="min-w-0 flex-1">
              <p className="truncate text-sm font-semibold">{file.name}</p>
              <p className="mt-0.5 text-sm text-muted">
                {isPdf ? "PDF document" : "Image"} ·{" "}
                {formatFileSize(file.size)}
              </p>
            </div>
            <div className="flex shrink-0 gap-1">
              <button
                type="button"
                onClick={openPicker}
                disabled={submitting}
                className={`rounded-xl px-3 py-2 text-sm font-semibold text-accent transition-colors hover:bg-accent/10 disabled:opacity-40 ${FOCUS_RING}`}
              >
                Change
              </button>
              <button
                type="button"
                onClick={clearFile}
                disabled={submitting}
                className={`rounded-xl px-3 py-2 text-sm font-semibold text-muted transition-colors hover:bg-line/60 disabled:opacity-40 ${FOCUS_RING}`}
              >
                Remove
              </button>
            </div>
          </div>
        </div>
      ) : (
        <button
          type="button"
          onClick={openPicker}
          onDragOver={handleDragOver}
          onDragLeave={handleDragLeave}
          onDrop={handleDrop}
          aria-describedby="upload-hint"
          className={`flex w-full flex-col items-center rounded-card border-2 border-dashed px-6 py-10 text-center transition-colors ${FOCUS_RING} ${
            dragging
              ? "border-accent bg-accent/5"
              : "border-line bg-surface hover:border-muted/40"
          }`}
        >
          <UploadIcon className="size-8 text-muted" />
          <span className="mt-3 font-semibold">
            Drag &amp; drop your student ID here
          </span>
          <span className="mt-1 text-sm text-muted">
            or tap to browse your files
          </span>
          <span id="upload-hint" className="mt-3 text-xs text-muted">
            JPEG, PNG, WebP or PDF · up to 10 MB
          </span>
        </button>
      )}
      {fileError && (
        <p role="alert" className="mt-3 text-sm font-medium text-red-600">
          {fileError}
        </p>
      )}
      {submitError && (
        <p role="alert" className="mt-3 text-sm font-medium text-red-600">
          {submitError}
        </p>
      )}
      <p aria-live="polite" className="sr-only">
        {submitting ? "Submitting your document for review" : ""}
      </p>
      <button
        type="submit"
        disabled={!file || submitting}
        aria-busy={submitting}
        className={`mt-5 w-full rounded-2xl bg-accent py-3.5 font-semibold text-white shadow-card transition-transform active:scale-[0.98] disabled:pointer-events-none disabled:opacity-40 ${FOCUS_RING}`}
      >
        {submitting ? "Submitting…" : "Submit for review"}
      </button>
      <p className="mt-4 text-center text-xs leading-relaxed text-muted">
        Stored privately and visible only to our review team — never on your
        profile.
      </p>
    </form>
  );

  let body: ReactNode;
  if (phase === "loading") {
    body = (
      <section className="pt-14" aria-busy="true" aria-live="polite">
        <span className="sr-only">Checking your verification status</span>
        <div className="mx-auto size-14 animate-pulse rounded-2xl bg-line" />
        <div className="mx-auto mt-5 h-8 w-56 animate-pulse rounded-full bg-line" />
        <div className="mx-auto mt-3 h-4 w-72 max-w-full animate-pulse rounded-full bg-line" />
        <div className="mt-8 h-52 rounded-card border border-line bg-surface shadow-card" />
      </section>
    );
  } else if (phase === "error") {
    body = (
      <section className="pt-14 text-center">
        <StatusBadge>
          <AlertIcon className="size-7" />
        </StatusBadge>
        <h1 className="mt-5 text-3xl font-bold tracking-tight">
          Something went wrong
        </h1>
        <p
          role="alert"
          className="mx-auto mt-3 max-w-sm text-[15px] leading-relaxed text-muted"
        >
          {loadError}
        </p>
        <button
          type="button"
          onClick={retryStatus}
          className={`mt-8 w-full rounded-2xl border border-line bg-surface py-3.5 font-semibold text-ink shadow-card transition-transform active:scale-[0.98] ${FOCUS_RING}`}
        >
          Try again
        </button>
      </section>
    );
  } else if (state) {
    switch (state.verification_status) {
      case "PENDING": {
        const submittedAt = state.submission?.submitted_at
          ? formatDate(state.submission.submitted_at)
          : null;
        body = (
          <section className="pt-14 text-center">
            <StatusBadge>
              <ClockIcon className="size-7" />
            </StatusBadge>
            <h1 className="mt-5 text-3xl font-bold tracking-tight">
              Verification pending
            </h1>
            <p className="mx-auto mt-3 max-w-sm text-[15px] leading-relaxed text-muted">
              Your document has been submitted and is awaiting review by our
              team. You don&apos;t need to do anything else — we&apos;ll let
              you know as soon as a decision is made.
            </p>
            {submittedAt && (
              <p className="mt-4 text-sm text-muted">
                Submitted on {submittedAt}
              </p>
            )}
            <div className="mt-8 rounded-card border border-line bg-surface p-5 text-left shadow-card">
              <div className="flex items-start gap-3">
                <span className="mt-0.5 grid size-9 shrink-0 place-items-center rounded-xl bg-accent/15 text-accent">
                  <LockIcon className="size-5" />
                </span>
                <div>
                  <h2 className="font-semibold leading-snug">
                    Private by default
                  </h2>
                  <p className="mt-1 text-sm text-muted">
                    Your document stays private and never appears on your
                    profile.
                  </p>
                </div>
              </div>
            </div>
          </section>
        );
        break;
      }
      case "VERIFIED": {
        const verifiedAt = state.submission?.reviewed_at
          ? formatDate(state.submission.reviewed_at)
          : null;
        body = (
          <section className="pt-14 text-center">
            <StatusBadge>
              <CheckIcon className="size-7" />
            </StatusBadge>
            <h1 className="mt-5 text-3xl font-bold tracking-tight">
              You&apos;re verified
            </h1>
            <p className="mx-auto mt-3 max-w-sm text-[15px] leading-relaxed text-muted">
              Your student status is confirmed. You&apos;re all set — every
              member you meet on UniMatch is a verified student too.
            </p>
            {verifiedAt && (
              <p className="mt-4 text-sm text-muted">
                Verified on {verifiedAt}
              </p>
            )}
          </section>
        );
        break;
      }
      case "REJECTED": {
        const reason = state.submission?.rejection_reason;
        body = (
          <>
            <section className="pt-14 text-center">
              <StatusBadge>
                <AlertIcon className="size-7" />
              </StatusBadge>
              <h1 className="mt-5 text-3xl font-bold tracking-tight">
                Verification needs another submission
              </h1>
            </section>
            <section className="mt-8 rounded-card border border-line bg-surface p-5 text-left shadow-card">
              {reason && (
                <p className="text-sm leading-relaxed">
                  <span className="font-semibold">Reason: </span>
                  <span className="text-muted">{reason}</span>
                </p>
              )}
              <p className="mt-1 text-sm leading-relaxed text-muted">
                You can submit a new document below for another review. Your
                previous submission is kept in your verification history.
              </p>
            </section>
            {uploadForm}
          </>
        );
        break;
      }
      default: {
        body = (
          <>
            <section className="pt-14 text-center">
              <StatusBadge>
                <UploadIcon className="size-7" />
              </StatusBadge>
              <h1 className="mt-5 text-3xl font-bold tracking-tight">
                Verify your student status
              </h1>
              <p className="mx-auto mt-3 max-w-sm text-[15px] leading-relaxed text-muted">
                UniMatch is exclusively for university students. Upload your
                student ID — our team reviews every document manually, and it
                never appears on your profile.
              </p>
            </section>
            {uploadForm}
          </>
        );
        break;
      }
    }
  } else {
    body = null;
  }

  return <div>{body}</div>;
}
