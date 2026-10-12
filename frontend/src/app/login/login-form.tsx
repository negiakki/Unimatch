"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState, type FormEvent } from "react";

import {
  AuthDivider,
  GoogleSignInButton,
  destinationAfterAuth,
} from "@/components/google-sign-in-button";
import { Button } from "@/components/ui";
import { createClient } from "@/lib/supabase/client";

/**
 * Sign-in form backed by the existing Supabase browser client.
 * Calls supabase.auth.signInWithPassword(); @supabase/ssr persists the
 * session cookie. After sign-in the caller's profile is checked: without a
 * profile the user continues to /onboarding, with one to verification.
 *
 * Google sign-in sits above the form and reuses that same profile check
 * through destinationAfterAuth(), so both routes enter the same flow.
 */

const INPUT_CLASSES =
  "w-full border border-line bg-surface px-4 py-3 text-[15px] text-ink placeholder:text-muted/60 disabled:opacity-40";

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
      const { error: authError } = await createClient().auth.signInWithPassword({
        email: trimmedEmail,
        password,
      });
      if (authError) {
        setError(messageForAuthError(authError));
        return;
      }
      router.replace(await destinationAfterAuth());
    } catch {
      setError(
        "We couldn't reach the sign-in service. Check your connection and try again.",
      );
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <form onSubmit={handleSubmit} noValidate>
      <GoogleSignInButton />
      <AuthDivider />

      <label htmlFor="login-email" className="block text-sm font-semibold">
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
        className={`mt-2 ${INPUT_CLASSES}`}
      />

      <label
        htmlFor="login-password"
        className="mt-6 block text-sm font-semibold"
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
        className={`mt-2 ${INPUT_CLASSES}`}
      />

      {error && (
        <p role="alert" className="mt-4 text-sm font-medium text-danger">
          {error}
        </p>
      )}
      <p aria-live="polite" className="sr-only">
        {submitting ? "Signing you in" : ""}
      </p>

      <Button
        type="submit"
        className="mt-8 w-full"
        disabled={submitting}
        aria-busy={submitting}
      >
        {submitting ? "Signing in…" : "Sign in"}
      </Button>

      <p className="mt-6 text-sm text-muted">
        Don&apos;t have an account yet?{" "}
        <Link
          href="/signup"
          className="font-semibold text-ink underline underline-offset-4"
        >
          Create an account
        </Link>
      </p>
    </form>
  );
}
