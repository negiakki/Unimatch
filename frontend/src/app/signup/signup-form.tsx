"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState, type FormEvent } from "react";

import {
  AuthDivider,
  GoogleSignInButton,
} from "@/components/google-sign-in-button";
import { Button } from "@/components/ui";
import { createClient } from "@/lib/supabase/client";

/**
 * Account creation backed by the existing Supabase browser client.
 * Calls supabase.auth.signUp() only - no profile is created here; the
 * authenticated user continues to /onboarding where profile creation already
 * happens. Email confirmation is enabled on the Supabase project, so a
 * successful signup usually returns a user but no session: that state shows a
 * "check your inbox" notice instead of pretending the user is signed in.
 *
 * Google sign-in sits above the form and needs no confirmation step - Google
 * already verified the address - so /auth/callback sends these users straight
 * into the same /onboarding flow.
 */

const INPUT_CLASSES =
  "w-full border border-line bg-surface px-4 py-3 text-[15px] text-ink placeholder:text-muted/60 disabled:opacity-40";

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
      const { data, error: authError } = await createClient().auth.signUp({
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
      // Confirmation enabled: no session yet — confirm the address first.
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
      <section>
        <h2 className="type-display text-title">Check your inbox</h2>
        <p className="mt-4 max-w-md text-[15px] leading-relaxed text-muted">
          We sent a confirmation link to{" "}
          <span className="font-semibold text-ink">{confirmationEmail}</span>.
          Confirm your email address, then sign in to create your profile.
        </p>
        <Button
          className="mt-8 w-full"
          onClick={() => router.replace("/login")}
        >
          Go to sign in
        </Button>
      </section>
    );
  }

  return (
    <form onSubmit={handleSubmit} noValidate>
      <GoogleSignInButton />
      <AuthDivider />

      <label htmlFor="signup-email" className="block text-sm font-semibold">
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
        className={`mt-2 ${INPUT_CLASSES}`}
      />
      {fieldErrors.email && (
        <p className="mt-2 text-sm font-medium text-danger">{fieldErrors.email}</p>
      )}

      <label htmlFor="signup-password" className="mt-6 block text-sm font-semibold">
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
        className={`mt-2 ${INPUT_CLASSES}`}
      />
      {fieldErrors.password && (
        <p className="mt-2 text-sm font-medium text-danger">
          {fieldErrors.password}
        </p>
      )}

      <label
        htmlFor="signup-confirm-password"
        className="mt-6 block text-sm font-semibold"
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
        className={`mt-2 ${INPUT_CLASSES}`}
      />
      {fieldErrors.confirmPassword && (
        <p className="mt-2 text-sm font-medium text-danger">
          {fieldErrors.confirmPassword}
        </p>
      )}

      {error && (
        <p role="alert" className="mt-4 text-sm font-medium text-danger">
          {error}
        </p>
      )}
      <p aria-live="polite" className="sr-only">
        {submitting ? "Creating your account" : ""}
      </p>

      <Button
        type="submit"
        className="mt-8 w-full"
        disabled={submitting}
        aria-busy={submitting}
      >
        {submitting ? "Creating account…" : "Create account"}
      </Button>

      <p className="mt-6 text-sm text-muted">
        Already have an account?{" "}
        <Link href="/login" className="font-semibold text-ink underline underline-offset-4">
          Sign in
        </Link>
      </p>
    </form>
  );
}