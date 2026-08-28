"use client";

import { useRouter } from "next/navigation";
import { useState, type FormEvent, type ReactNode } from "react";

import { createClient } from "@/lib/supabase/client";

/**
 * Sign-in form backed by the existing Supabase browser client.
 * Calls supabase.auth.signInWithPassword(); @supabase/ssr persists the
 * session cookie, so /verify can read the access token as usual.
 */

const FOCUS_RING =
  "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent focus-visible:ring-offset-2 focus-visible:ring-offset-background";

const INPUT_CLASSES = `w-full rounded-2xl border border-line bg-surface px-4 py-3.5 text-[15px] text-ink shadow-card placeholder:text-muted/60 focus:border-accent disabled:opacity-40 ${FOCUS_RING}`;

function messageForAuthError(error: {
  code?: string | undefined;
  status?: number | undefined;
}): string {
  switch (error.code) {
    case "invalid_credentials":
    case "user_not_found":
      return "Incorrect email or password.";
    case "email_not_confirmed":
      return "Confirm your email address before signing in.";
    case "over_request_rate_limit":
    case "over_email_send_rate_limit":
      return "Too many attempts. Please wait a moment and try again.";
    case "user_banned":
      return "This account has been disabled.";
    default:
      if (error.status === 400 || error.status === 422) {
        return "Incorrect email or password.";
      }
      return "We couldn't sign you in. Please try again.";
  }
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

export function LoginForm() {
  const router = useRouter();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (submitting) {
      return;
    }

    const trimmedEmail = email.trim();
    if (!trimmedEmail || !password) {
      setError("Enter your email and password to sign in.");
      return;
    }

    setSubmitting(true);
    setError(null);
    try {
      const supabase = createClient();
      const { error: authError } = await supabase.auth.signInWithPassword({
        email: trimmedEmail,
        password,
      });
      if (authError) {
        setError(messageForAuthError(authError));
        return;
      }
      router.replace("/verify");
    } catch {
      setError(
        "We couldn't reach the sign-in service. Check your connection and try again.",
      );
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <section className="pt-14 text-center">
      <div className="mx-auto grid size-14 place-items-center rounded-2xl bg-accent/15 text-accent">
        <LockIcon className="size-7" />
      </div>
      <h1 className="mt-5 text-3xl font-bold tracking-tight">Sign in</h1>
      <p className="mx-auto mt-3 max-w-sm text-[15px] leading-relaxed text-muted">
        Welcome back. Sign in to continue with your student verification.
      </p>

      <form onSubmit={handleSubmit} noValidate className="mt-8 text-left">
        <label htmlFor="login-email" className="text-sm font-semibold">
          Email
        </label>
        <input
          id="login-email"
          type="email"
          autoComplete="email"
          inputMode="email"
          placeholder="you@university.edu"
          value={email}
          onChange={(event) => setEmail(event.target.value)}
          disabled={submitting}
          className={`mt-1.5 ${INPUT_CLASSES}`}
        />

        <label
          htmlFor="login-password"
          className="mt-4 block text-sm font-semibold"
        >
          Password
        </label>
        <input
          id="login-password"
          type="password"
          autoComplete="current-password"
          placeholder="Your password"
          value={password}
          onChange={(event) => setPassword(event.target.value)}
          disabled={submitting}
          className={`mt-1.5 ${INPUT_CLASSES}`}
        />

        {error && (
          <p role="alert" className="mt-3 text-sm font-medium text-red-600">
            {error}
          </p>
        )}
        <p aria-live="polite" className="sr-only">
          {submitting ? "Signing you in" : ""}
        </p>

        <button
          type="submit"
          disabled={submitting}
          aria-busy={submitting}
          className={`mt-5 w-full rounded-2xl bg-accent py-3.5 font-semibold text-white shadow-card transition-transform active:scale-[0.98] disabled:pointer-events-none disabled:opacity-40 ${FOCUS_RING}`}
        >
          {submitting ? "Signing in…" : "Sign in"}
        </button>
      </form>

      <p className="mt-4 text-center text-xs leading-relaxed text-muted">
        Don&apos;t have an account yet? You&apos;ll be able to create one
        during onboarding.
      </p>
    </section>
  );
}
