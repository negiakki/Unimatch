"use client";

import Image from "next/image";
import { useRouter } from "next/navigation";
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

import { Button, ButtonLink, Label, SuspendedState } from "@/components/ui";
import {
  ApiError,
  isApiError,
  isSuspended,
  isUnauthorized,
} from "@/lib/api/http";
import {
  MAX_DOCUMENT_BYTES,
  fetchVerificationState,
  submitVerificationDocument,
  validateVerificationDocument,
  type VerificationState,
} from "@/lib/api/verification";
import { cx, formatFileSize } from "@/lib/format";

/**
 * Student verification.
 *
 * A verified student status is what unlocks joining opportunities and finding
 * people, so each state explains what happens next. The document stays private
 * and is stated once, up front, rather than repeated on every screen.
 */

const ACCEPTED_FILES =
  "image/jpeg,image/png,image/webp,application/pdf,.jpg,.jpeg,.png,.webp,.pdf";

/** Derived from the shared limit so the copy can't drift from validation. */
const MAX_DOCUMENT_LABEL = formatFileSize(MAX_DOCUMENT_BYTES);

function formatDate(iso: string): string | null {
  const date = new Date(iso);
  return Number.isNaN(date.getTime())
    ? null
    : date.toLocaleDateString(undefined, {
        year: "numeric",
        month: "long",
        day: "numeric",
      });
}

function messageFor(error: unknown): string {
  return error instanceof ApiError
    ? error.message
    : "Something went wrong. Please try again.";
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
      strokeWidth={1.6}
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
      <circle cx="12" cy="12" r="9" />
      <path d="m8.5 12 2.5 2.5 4.5-5" />
    </Icon>
  );
}

function ClockIcon({ className }: { className?: string }) {
  return (
    <Icon className={className}>
      <circle cx="12" cy="12" r="9" />
      <path d="M12 7v5l3.5 2" />
    </Icon>
  );
}

function DocumentIcon({ className }: { className?: string }) {
  return (
    <Icon className={className}>
      <path d="M15 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7Z" />
      <path d="M14 2v4a2 2 0 0 0 2 2h4" />
      <path d="M16 13H8M16 17H8" />
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

function Note({ title, body }: { title: string; body: string }) {
  return (
    <div className="mt-8 flex items-start gap-3 border-t border-line pt-6">
      <span className="mt-0.5 shrink-0 text-accent">
        <LockIcon className="size-5" />
      </span>
      <div>
        <p className="text-sm font-semibold">{title}</p>
        <p className="mt-1 text-sm leading-relaxed text-muted">{body}</p>
      </div>
    </div>
  );
}

export function VerificationFlow() {
  const router = useRouter();
  const [phase, setPhase] = useState<
    "loading" | "ready" | "error" | "suspended"
  >("loading");
  const [state, setState] = useState<VerificationState | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);

  const [file, setFile] = useState<File | null>(null);
  // The server is the authority on the >=1 photo minimum; this only makes the
  // rejection actionable (the fix lives on the profile, not on this page).
  const [photoRequired, setPhotoRequired] = useState(false);
  const [previewUrl, setPreviewUrl] = useState<string | null>(null);
  const [fileError, setFileError] = useState<string | null>(null);
  const [submitError, setSubmitError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [dragging, setDragging] = useState(false);

  const inputRef = useRef<HTMLInputElement>(null);
  const previewUrlRef = useRef<string | null>(null);

  const loadStatus = useCallback(async () => {
    try {
      setState(await fetchVerificationState());
      setPhase("ready");
    } catch (error) {
      if (isUnauthorized(error)) {
        router.replace("/login");
        return;
      }
      // Reads stay open to a suspended account, so this only surfaces on the
      // submit path — but render it here too rather than leaking a raw code.
      if (isSuspended(error)) {
        setPhase("suspended");
        return;
      }
      // Verification requires a profile first; send them to create one rather
      // than offering a retry that can never succeed.
      if (isApiError(error) && error.code === "not_found") {
        router.replace("/onboarding");
        return;
      }
      console.error("Failed to load verification status:", error);
      setLoadError(messageFor(error));
      setPhase("error");
    }
  }, [router]);

  useEffect(() => {
    void (async () => {
      await loadStatus();
    })();
  }, [loadStatus]);

  function retryStatus() {
    setPhase("loading");
    setLoadError(null);
    void loadStatus();
  }

  // Blob URLs are revoked on replace and on unmount — no leaks.
  useEffect(
    () => () => {
      if (previewUrlRef.current) {
        URL.revokeObjectURL(previewUrlRef.current);
      }
    },
    [],
  );

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

  function handleInputChange(event: ChangeEvent<HTMLInputElement>) {
    const nextFile = event.target.files?.[0] ?? null;
    event.target.value = "";
    selectFile(nextFile);
  }

  function handleDrop(event: DragEvent<HTMLButtonElement>) {
    event.preventDefault();
    setDragging(false);
    if (!submitting) {
      selectFile(event.dataTransfer.files?.[0] ?? null);
    }
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
      // The server is authoritative about "already submitted" / "already
      // verified" — re-read the real state instead of guessing.
      if (
        isApiError(error) &&
        (error.code === "pending_review" || error.code === "already_verified")
      ) {
        await loadStatus();
        return;
      }
      // Suspension is a deliberate state, not a transient failure: replace the
      // form so a retry can't even be attempted.
      if (isSuspended(error)) {
        setPhase("suspended");
        return;
      }
      if (isApiError(error) && error.code === "photo_required") {
        setPhotoRequired(true);
      }
      setSubmitError(messageFor(error));
    } finally {
      setSubmitting(false);
    }
  }

  if (phase === "loading") {
    return (
      <div aria-busy="true" aria-live="polite">
        <span className="sr-only">Checking your verification status</span>
        <div className="mt-10 h-10 w-48 animate-pulse bg-line" />
        <div className="mt-8 h-52 animate-pulse bg-line" />
      </div>
    );
  }

  if (phase === "suspended") {
    return (
      <SuspendedState
        message="Your account is suspended, so a new student ID can't be submitted. Documents already submitted are unaffected."
        action={<ButtonLink href="/profile" variant="outline">Back to profile</ButtonLink>}
      />
    );
  }

  if (phase === "error") {
    return (
      <section>
        <Label>Problem</Label>
        <h2 className="type-display mt-4 text-title">Something went wrong</h2>
        <p role="alert" className="mt-3 max-w-md text-[15px] leading-relaxed text-muted">
          {loadError}
        </p>
        <Button variant="outline" className="mt-8" onClick={retryStatus}>
          Try again
        </Button>
      </section>
    );
  }

  const isPdf =
    file !== null &&
    (file.type === "application/pdf" || file.name.toLowerCase().endsWith(".pdf"));

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
        <div className="border border-line bg-surface p-4">
          <div className="flex items-center gap-3">
            {previewUrl ? (
              <Image
                src={previewUrl}
                alt=""
                width={56}
                height={56}
                unoptimized
                className="size-14 shrink-0 object-cover"
              />
            ) : (
              <span className="grid size-14 shrink-0 place-items-center bg-line/40 text-muted">
                <DocumentIcon className="size-6" />
              </span>
            )}
            <div className="min-w-0 flex-1">
              <p className="truncate text-sm font-semibold">{file.name}</p>
              <p className="mt-0.5 text-sm text-muted">
                {isPdf ? "PDF document" : "Image"} · {formatFileSize(file.size)}
              </p>
            </div>
            <div className="flex shrink-0 gap-1">
              <button
                type="button"
                onClick={() => inputRef.current?.click()}
                disabled={submitting}
                className="px-2 py-2 text-sm font-semibold text-accent disabled:opacity-40"
              >
                Change
              </button>
              <button
                type="button"
                onClick={clearFile}
                disabled={submitting}
                className="px-2 py-2 text-sm font-semibold text-muted disabled:opacity-40"
              >
                Remove
              </button>
            </div>
          </div>
        </div>
      ) : (
        <button
          type="button"
          onClick={() => inputRef.current?.click()}
          onDragOver={(event) => {
            event.preventDefault();
            if (!submitting) {
              setDragging(true);
            }
          }}
          onDragLeave={() => setDragging(false)}
          onDrop={handleDrop}
          aria-describedby="upload-hint"
          className={cx(
            "flex w-full flex-col items-center border-2 border-dashed px-6 py-10 text-center transition-colors",
            dragging
              ? "border-accent bg-accent/5"
              : "border-line bg-surface hover:border-muted/40",
          )}
        >
          <UploadIcon className="size-7 text-muted" />
          <span className="mt-3 font-semibold">Add your student ID</span>
          <span id="upload-hint" className="mt-1 text-sm text-muted">
            Drag &amp; drop, or tap to browse
          </span>
          <span className="mt-3 text-xs text-muted">
            {`JPEG, PNG, WebP or PDF · up to ${MAX_DOCUMENT_LABEL}`}
          </span>
        </button>
      )}

      {fileError && (
        <p role="alert" className="mt-3 text-sm font-medium text-danger">
          {fileError}
        </p>
      )}
      {submitError && (
        <p role="alert" className="mt-3 text-sm font-medium text-danger">
          {submitError}
        </p>
      )}
      <p aria-live="polite" className="sr-only">
        {submitting ? "Submitting your document for review" : ""}
      </p>

      <Button
        type="submit"
        className="mt-6 w-full"
        disabled={!file || submitting}
        aria-busy={submitting}
      >
        {submitting ? "Submitting…" : "Submit for review"}
      </Button>

      {/* Photos are required server-side; the fix lives on the profile. */}
      {photoRequired && (
        <ButtonLink href="/profile/edit" variant="outline" className="mt-3 w-full">
          Add a profile photo
        </ButtonLink>
      )}
    </form>
  );

  switch (state?.verification_status) {
    case "PENDING": {
      const submittedAt = state.submission?.submitted_at
        ? formatDate(state.submission.submitted_at)
        : null;
      return (
        <section>
          <span className="text-accent">
            <ClockIcon className="size-8" />
          </span>
          <h2 className="type-display mt-5 text-title">Verification pending</h2>
          <p className="mt-3 max-w-md text-[15px] leading-relaxed text-muted">
            Your document is with our review team. Nothing else to do — you can
            browse opportunities in the meantime and join as soon as you&apos;re
            verified.
          </p>
          {submittedAt && (
            <p className="mt-3 text-sm text-muted">Submitted on {submittedAt}</p>
          )}
          <Note
            title="Private by default"
            body="Your document is visible only to the review team and never appears on your profile."
          />
          <ButtonLink href="/explore" variant="outline" className="mt-8 w-full">
            Browse opportunities
          </ButtonLink>
        </section>
      );
    }
    case "VERIFIED": {
      const verifiedAt = state.submission?.reviewed_at
        ? formatDate(state.submission.reviewed_at)
        : null;
      return (
        <section>
          <span className="text-accent">
            <CheckIcon className="size-8" />
          </span>
          <h2 className="type-display mt-5 text-title">You&apos;re verified</h2>
          <p className="mt-3 max-w-md text-[15px] leading-relaxed text-muted">
            Student status confirmed. Now you can join opportunities and find
            the people going to them.
          </p>
          {verifiedAt && (
            <p className="mt-3 text-sm text-muted">Verified on {verifiedAt}</p>
          )}
          <ButtonLink href="/explore" className="mt-8 w-full">
            Find an opportunity
          </ButtonLink>
        </section>
      );
    }
    case "REJECTED": {
      const reason = state.submission?.rejection_reason;
      return (
        <section>
          <Label>Needs another try</Label>
          <h2 className="type-display mt-4 text-title">Verification not approved</h2>
          <p className="mt-3 max-w-md text-[15px] leading-relaxed text-muted">
            {reason ?? "The document couldn't be accepted."} You can submit a
            new one below.
          </p>
          {uploadForm}
        </section>
      );
    }
    default:
      return (
        <section>
          {uploadForm}
          <Note
            title="Reviewed by hand, kept private"
            body="UniMatch is only for university students. Every document is reviewed manually by our team and never shows on your profile."
          />
        </section>
      );
  }
}