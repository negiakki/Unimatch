"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState, type FormEvent, type ReactNode } from "react";

import { createClient } from "@/lib/supabase/client";

/**
 * Account creation backed by the existing Supabase browser client.
 * Calls supabase.auth.signUp() only — no profile is created here; the
 * authenticated user continues to /onboarding where profile creation
 * already happens. Email confirmation is enabled on the Supabase project,
 * so a successful signup usually returns a user but no session: that state
 * shows a "check your inbox" notice instead of pretending the user is
 * signed in. Only when a session is returned (confirmation disabled) does
 * the user route straight to onboarding.
 */

const FOCUS_RING =
  "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent focus-visible:ring-offset-2 focus-visible:ring-offset-background";

const INPUT_CLASSES = `w-full rounded-2xl border border-line bg-surface px-4 py-3.5 text-[15px] text-ink shadow-card placeholder:text-muted/60 focus:border-accent disabled:opacity-40 ${FOCUS_RING}`;

const MIN_PASSWORD_LENGTH = 8;

function messageForAuthError(error: {
  code?: string | undefined;
  status?: number | undefined;
}): string {
  switch (error.code) {
    case "user_already_exists":
    case "email_exists":
      return "An account with this email already exists. Try signing in instead.";
    case "weak_password":
      return "This password is too weak. Use at least 8 characters.";
    case "email_address_not_authorized":
      return "Sign-ups from this email address aren't allowed.";
    case "signup_disabled":
      return "New sign-ups are currently disabled. Please try again later.";
    case "over_request_rate_limit":
    case "over_email_send_rate_limit":
      return "Too many attempts. Please wait a moment and try again.";
    case "user_banned":
      return "This account has been disabled.";
    default:
      if (error.status === 400 || error.status === 422) {
        return "We couldn't create your account. Please check your details and try again.";
      }
      return "We couldn't create your account. Please try again.";
  }
}

function isValidEmail(value: string): boolean {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value);
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

function LockIcon({ className }: { className?: string }) {
  return (
    <Icon className={className}>
      <rect width="18" height="11" x="3" y="11" rx="2" />
      <path d="M7 11V7a5 5 0 0 1 10 0v4" />
    </Icon>
  );
}

function MailIcon({ className }: { className?: string }) {
  return (
    <Icon className={className}>
      <rect width="20" height="16" x="2" y="4" rx="2" />
      <path d="m22 7-8.97 5.7a1.94 1.94 0 0 1-2.06 0L2 7" />
    </Icon>
  );
}

export function SignupForm() {
  const router = useRouter();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [confirmationEmail, setConfirmationEmail] = useState<string | null>(null);

  function validate(): Record<string, string> {
    const errors: Record<string, string> = {};
    const trimmedEmail = email.trim();
    if (!trimmedEmail) {
      errors.email = "Enter your email address.";
    } else if (!isValidEmail(trimmedEmail)) {
      errors.email = "Enter a valid email address.";
    }
    if (!password) {
      errors.password = "Create a password.";
    } else if (password.length < MIN_PASSWORD_LENGTH) {
      errors.password = "Your password must be at least 8 characters.";
    }
    if (!confirmPassword) {
      errors.confirmPassword = "Re-enter your password to confirm it.";
    } else if (confirmPassword !== password) {
      errors.confirmPassword = "Passwords don't match.";
    }
    return errors;
  }

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (submitting) {
      return;
    }

    const errors = validate();
    if (Object.keys(errors).length > 0) {
      setFieldErrors(errors);
      setError(null);
      return;
    }
    setFieldErrors({});
    setError(null);

    setSubmitting(true);
    try {
      const supabase = createClient();
      const { data, error: authError } = await supabase.auth.signUp({
        email: email.trim(),
        password,
      });
      if (authError) {
        setError(messageForAuthError(authError));
        return;
      }
      if (data.session) {
        // Confirmation disabled: the user is authenticated right away.
        router.replace("/onboarding");
        return;
      }
      // Email confirmation enabled: no session yet — the user must confirm
      // their address before signing in.
      setConfirmationEmail(email.trim());
    } catch {
      setError(
        "We couldn't reach the sign-up service. Check your connection and try again.",
      );
    } finally {
      setSubmitting(false);
    }
  }

  if (confirmationEmail) {
    return (
      <section className="pt-14 text-center">
        <div className="mx-auto grid size-14 place-items-center rounded-2xl bg-accent/15 text-accent">
          <MailIcon className="size-7" />
        </div>
        <h1 className="mt-5 text-3xl font-bold tracking-tight">
          Check your inbox
        </h1>
        <p className="mx-auto mt-3 max-w-sm text-[15px] leading-relaxed text-muted">
          We sent a confirmation link to{" "}
          <span className="font-semibold text-ink">{confirmationEmail}</span>.
          Confirm your email address, then sign in to create your profile.
        </p>
        <Link
          href="/login"
          className={`mt-8 block w-full rounded-2xl bg-accent py-3.5 font-semibold text-white shadow-card transition-transform active:scale-[0.98] ${FOCUS_RING}`}
        >
          Go to sign in
        </Link>
      </section>
    );
  }

  return (
    <section className="pt-14 text-center">
      <div className="mx-auto grid size-14 place-items-center rounded-2xl bg-accent/15 text-accent">
        <LockIcon className="size-7" />
      </div>
      <h1 className="mt-5 text-3xl font-bold tracking-tight">
        Create your account
      </h1>
      <p className="mx-auto mt-3 max-w-sm text-[15px] leading-relaxed text-muted">
        Start with an account — next you&apos;ll create your profile and verify
        your student ID.
      </p>

      <form onSubmit={handleSubmit} noValidate className="mt-8 text-left">
        <label htmlFor="signup-email" className="text-sm font-semibold">
          Email
        </label>
        <input
          id="signup-email"
          type="email"
          autoComplete="email"
          inputMode="email"
          placeholder="you@university.edu"
          value={email}
          onChange={(event) => setEmail(event.target.value)}
          disabled={submitting}
          aria-invalid={Boolean(fieldErrors.email)}
          className={`mt-1.5 ${INPUT_CLASSES}`}
        />
        {fieldErrors.email && (
          <p className="mt-1.5 text-sm font-medium text-red-600">
            {fieldErrors.email}
          </p>
        )}

        <label
          htmlFor="signup-password"
          className="mt-4 block text-sm font-semibold"
        >
          Password
        </label>
        <input
          id="signup-password"
          type="password"
          autoComplete="new-password"
          placeholder="At least 8 characters"
          value={password}
          onChange={(event) => setPassword(event.target.value)}
          disabled={submitting}
          aria-invalid={Boolean(fieldErrors.password)}
          className={`mt-1.5 ${INPUT_CLASSES}`}
        />
        {fieldErrors.password && (
          <p className="mt-1.5 text-sm font-medium text-red-600">
            {fieldErrors.password}
          </p>
        )}

        <label
          htmlFor="signup-confirm-password"
          className="mt-4 block text-sm font-semibold"
        >
          Confirm password
        </label>
        <input
          id="signup-confirm-password"
          type="password"
          autoComplete="new-password"
          placeholder="Repeat your password"
          value={confirmPassword}
          onChange={(event) => setConfirmPassword(event.target.value)}
          disabled={submitting}
          aria-invalid={Boolean(fieldErrors.confirmPassword)}
          className={`mt-1.5 ${INPUT_CLASSES}`}
        />
        {fieldErrors.confirmPassword && (
          <p className="mt-1.5 text-sm font-medium text-red-600">
            {fieldErrors.confirmPassword}
          </p>
        )}

        {error && (
          <p role="alert" className="mt-3 text-sm font-medium text-red-600">
            {error}
          </p>
        )}
        <p aria-live="polite" className="sr-only">
          {submitting ? "Creating your account" : ""}
        </p>

        <button
          type="submit"
          disabled={submitting}
          aria-busy={submitting}
          className={`mt-5 w-full rounded-2xl bg-accent py-3.5 font-semibold text-white shadow-card transition-transform active:scale-[0.98] disabled:pointer-events-none disabled:opacity-40 ${FOCUS_RING}`}
        >
          {submitting ? "Creating account…" : "Create account"}
        </button>
      </form>

      <p className="mt-4 text-center text-sm text-muted">
        Already have an account?{" "}
        <Link
          href="/login"
          className="font-semibold text-accent underline underline-offset-2 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent focus-visible:ring-offset-2 focus-visible:ring-offset-background"
        >
          Sign in
        </Link>
      </p>
    </section>
  );
}
