"use client";

import { useState } from "react";

import { Button } from "@/components/ui";
import { ApiError } from "@/lib/api/http";
import { fetchMyProfile } from "@/lib/api/profile";
import { createClient } from "@/lib/supabase/client";

/**
 * Google sign-in, offered on both the sign-in and sign-up screens.
 *
 * OAuth cannot know whether the visitor meant to sign up or sign in, so both
 * buttons do the same thing: hand off to Supabase, which round-trips through
 * Google and lands back on /auth/callback. From there the shared
 * destinationAfterAuth() below decides between onboarding and verification,
 * exactly as the password form does - so a Google user enters the same
 * UniMatch funnel as an email/password user.
 *
 * The Google client secret is never referenced here. It lives in Supabase;
 * the browser only ever sees the authorize URL and a PKCE code.
 */

/**
 * Redirect target for the OAuth round-trip. Derived from the current origin
 * rather than hardcoded, so local development resolves to
 * http://localhost:3000/auth/callback while production follows the deployed
 * domain. Both must be listed under Authentication -> URL Configuration.
 */
export function oauthRedirectTo(): string {
  return `${window.location.origin}/auth/callback`;
}

/**
 * Post-auth destination, shared by the password form and the OAuth callback:
 * users without a profile go to onboarding, everyone else continues to
 * verification. If the profile check can't complete (network, backend hiccup)
 * the pre-existing default applies so sign-in is never blocked by it.
 */
export async function destinationAfterAuth(): Promise<string> {
  try {
    await fetchMyProfile();
    return "/verify";
  } catch (error) {
    if (error instanceof ApiError && error.code === "not_found") {
      return "/onboarding";
    }
    return "/verify";
  }
}

function messageForOAuthError(error: {
  code?: string | undefined;
  message?: string | undefined;
}): string {
  switch (error.code) {
    case "access_denied":
      return "Google sign-in was cancelled. You can try again whenever you like.";
    case "oauth_provider_not_supported":
      return "Google sign-in isn't enabled for UniMatch. Please use email and password.";
    case "bad_oauth_state":
    case "bad_oauth_callback":
    case "flow_state_not_found":
    case "flow_state_expired":
      return "That sign-in attempt expired or was interrupted. Please try again.";
    case "user_banned":
      return "This account has been disabled.";
    case "over_request_rate_limit":
      return "Too many attempts. Please wait a moment and try again.";
    default:
      return (
        error.message ??
        "We couldn't sign you in with Google. Please try again."
      );
  }
}

/** The Google mark, in its own colours, so the button reads as Google's. */
function GoogleMark() {
  return (
    <svg
      viewBox="0 0 24 24"
      className="size-4 shrink-0"
      aria-hidden="true"
      focusable="false"
    >
      <path
        fill="#4285F4"
        d="M23.52 12.27c0-.85-.08-1.67-.22-2.45H12v4.64h6.46a5.52 5.52 0 0 1-2.4 3.62v3h3.88c2.27-2.09 3.58-5.17 3.58-8.81Z"
      />
      <path
        fill="#34A853"
        d="M12 24c3.24 0 5.96-1.08 7.94-2.91l-3.88-3c-1.08.72-2.45 1.15-4.06 1.15-3.13 0-5.78-2.11-6.73-4.96H1.26v3.1A12 12 0 0 0 12 24Z"
      />
      <path
        fill="#FBBC05"
        d="M5.27 14.28a7.2 7.2 0 0 1 0-4.56v-3.1H1.26a12 12 0 0 0 0 10.76l4.01-3.1Z"
      />
      <path
        fill="#EA4335"
        d="M12 4.75c1.77 0 3.35.61 4.6 1.8l3.44-3.44C17.95 1.19 15.24 0 12 0A12 12 0 0 0 1.26 6.62l4.01 3.1C6.22 6.86 8.87 4.75 12 4.75Z"
      />
    </svg>
  );
}

export function GoogleSignInButton() {
  const [error, setError] = useState<string | null>(null);
  const [starting, setStarting] = useState(false);

  async function handleClick() {
    if (starting) {
      return;
    }
    setStarting(true);
    setError(null);
    try {
      const { error: oauthError } =
        await createClient().auth.signInWithOAuth({
          provider: "google",
          options: { redirectTo: oauthRedirectTo() },
        });
      if (oauthError) {
        setError(messageForOAuthError(oauthError));
        setStarting(false);
      }
      // On success the browser leaves for Google, so `starting` stays true.
    } catch {
      setError(
        "We couldn't reach the sign-in service. Check your connection and try again.",
      );
      setStarting(false);
    }
  }

  return (
    <div>
      <Button
        type="button"
        variant="outline"
        className="w-full"
        onClick={handleClick}
        disabled={starting}
        aria-busy={starting}
      >
        <GoogleMark />
        {starting ? "Redirecting." : "Continue with Google"}
      </Button>

      {error && (
        <p role="alert" className="mt-4 text-sm font-medium text-danger">
          {error}
        </p>
      )}
      <p aria-live="polite" className="sr-only">
        {starting ? "Redirecting you to Google" : ""}
      </p>
    </div>
  );
}

/**
 * "or" rule between the Google button and the email/password form. Included
 * here so both auth screens stay visually identical above the fold.
 */
export function AuthDivider() {
  return (
    <div aria-hidden="true" className="my-6 flex items-center gap-3">
      <span className="h-px flex-1 bg-line" />
      <span className="type-meta text-muted">or</span>
      <span className="h-px flex-1 bg-line" />
    </div>
  );
}
