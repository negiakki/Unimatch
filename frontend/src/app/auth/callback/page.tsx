"use client";

import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";

import { AuthShell } from "@/components/auth-shell";
import { destinationAfterAuth } from "@/components/google-sign-in-button";
import { Button, ButtonLink, LoadingBlock } from "@/components/ui";
import { createClient } from "@/lib/supabase/client";

/**
 * Landing route for the Google OAuth round-trip.
 *
 * No PKCE exchange is written here on purpose. The browser client from
 * @supabase/ssr is created with flowType "pkce" and detectSessionInUrl
 * enabled, so the act of constructing it exchanges the ?code= in this URL for
 * a session and writes the auth cookies. getSession() awaits that
 * initialisation, which is why waiting on it below is enough - no middleware,
 * no route handler, no second session mechanism.
 *
 * A brand-new Google user has no profile, so destinationAfterAuth() sends them
 * to /onboarding; an existing one continues to /verify. Same funnel as the
 * password form.
 *
 * query params are read from window.location rather than useSearchParams so
 * this route stays statically prerenderable and needs no Suspense boundary.
 */

function messageForCallbackParams(params: URLSearchParams): string {
  const code = params.get("error_code");
  switch (code) {
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
    default:
      // Google sends a human-readable reason in error_description; fall back
      // to it rather than showing a raw OAuth error code.
      return (
        params.get("error_description") ??
        "We couldn't complete sign-in with Google. Please try again."
      );
  }
}

export default function AuthCallbackPage() {
  const router = useRouter();
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    void (async () => {
      const params = new URLSearchParams(window.location.search);
      if (params.has("error") || params.has("error_code")) {
        setError(messageForCallbackParams(params));
        return;
      }
      try {
        // Constructing the client runs the PKCE exchange; getSession()
        // resolves only once it has finished.
        const { data, error: sessionError } =
          await createClient().auth.getSession();
        if (sessionError) {
          setError(messageForCallbackParams(params));
          return;
        }
        if (!data.session) {
          setError(
            "We couldn't complete sign-in with Google. Please try again.",
          );
          return;
        }
        router.replace(await destinationAfterAuth());
      } catch {
        setError(
          "We couldn't complete sign-in with Google. Check your connection and try again.",
        );
      }
    })();
  }, [router]);

  return (
    <AuthShell
      eyebrow="One moment"
      title="Finishing sign-in"
      lede="Connecting your Google account to UniMatch."
    >
      {error ? (
        <>
          <p role="alert" className="text-[15px] font-medium text-danger">
            {error}
          </p>
          <p className="mt-2 text-sm leading-relaxed text-muted">
            Nothing is wrong with your account - the Google hand-off just
            didn&apos;t complete.
          </p>
          <div className="mt-8 flex flex-wrap items-center gap-3">
            <Button onClick={() => router.replace("/login")}>Try again</Button>
            <ButtonLink href="/signup" variant="outline">
              Create an account
            </ButtonLink>
          </div>
        </>
      ) : (
        <LoadingBlock label="Finishing sign-in with Google" rows={2} />
      )}
    </AuthShell>
  );
}
