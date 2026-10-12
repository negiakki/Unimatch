"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";

import { createClient } from "@/lib/supabase/client";
import { Button } from "@/components/ui";

/**
 * Sign-out control, including the one offered from the suspended-account
 * state. Split out so server-rendered pages (landing, opportunity detail) can
 * offer it without becoming client components themselves.
 */
export function SignOutButton({ variant = "outline" }: { variant?: "solid" | "outline" }) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);

  return (
    <Button
      variant={variant}
      disabled={busy}
      aria-busy={busy}
      onClick={() => {
        setBusy(true);
        void createClient()
          .auth.signOut()
          .then(() => router.replace("/login"))
          .finally(() => setBusy(false));
      }}
    >
      {busy ? "Signing out…" : "Log out"}
    </Button>
  );
}