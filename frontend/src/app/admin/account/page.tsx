"use client";

import { useEffect, useState } from "react";

import { SignOutButton } from "@/components/sign-out-button";
import { Label } from "@/components/ui";
import { createClient } from "@/lib/supabase/client";

/**
 * Reviewer account information and sign-out.
 *
 * Deliberately minimal: the backend exposes no admin preferences, no profile
 * editing for staff, and no notification settings, so there is nothing to
 * configure here that isn't already in `/profile`. Inventing settings would be
 * a dead end.
 */

export default function AdminAccountPage() {
  const [email, setEmail] = useState<string | null>(null);
  const [loaded, setLoaded] = useState(false);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const { data } = await createClient().auth.getUser();
        if (!cancelled) setEmail(data.user?.email ?? null);
      } catch {
        if (!cancelled) setEmail(null);
      } finally {
        if (!cancelled) setLoaded(true);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  return (
    <div className="mx-auto w-full max-w-2xl">
      <header className="border-b border-line pb-5">
        <Label>Account</Label>
        <h1 className="type-display mt-3 text-[clamp(2rem,6vw,3rem)]">
          Reviewer account
        </h1>
        <p className="mt-3 text-[15px] leading-relaxed text-muted">
          Your access is granted by the staff registry. Removing yourself from it
          immediately ends admin access.
        </p>
      </header>

      <dl className="mt-8 space-y-4">
        <div>
          <dt className="type-meta text-muted">Signed in as</dt>
          <dd className="mt-1 text-[15px]">
            {loaded ? (email ?? "Signed in") : "Loading…"}
          </dd>
        </div>
        <div>
          <dt className="type-meta text-muted">Role</dt>
          <dd className="mt-1 text-[15px]">Staff reviewer</dd>
        </div>
      </dl>

      <div className="mt-10 border-t border-line pt-6">
        <SignOutButton />
      </div>
    </div>
  );
}