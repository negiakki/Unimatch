"use client";

import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { useState } from "react";

import { createClient } from "@/lib/supabase/client";

/**
 * Shared header for signed-in pages. Client Component so it can highlight
 * the active route and run logout through the existing Supabase browser
 * client (supabase.auth.signOut()); redirect to /login only on success.
 */

const FOCUS_RING =
  "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent focus-visible:ring-offset-2 focus-visible:ring-offset-surface";

const NAV_ITEMS = [
  { href: "/discovery", label: "Discover" },
  { href: "/matches", label: "Matches" },
  { href: "/messages", label: "Messages" },
  { href: "/profile/edit", label: "Profile" },
] as const;

const NAV_LINK_CLASSES = `whitespace-nowrap rounded-xl px-2.5 py-2 text-[13px] font-semibold sm:px-3 sm:text-sm ${FOCUS_RING}`;

function isActive(pathname: string, href: string) {
  return pathname === href || pathname.startsWith(`${href}/`);
}

export function AppHeader() {
  const router = useRouter();
  const pathname = usePathname();
  const [signingOut, setSigningOut] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleSignOut() {
    if (signingOut) {
      return;
    }
    setSigningOut(true);
    setError(null);
    try {
      const supabase = createClient();
      const { error: signOutError } = await supabase.auth.signOut();
      if (signOutError) {
        setError("We couldn't sign you out. Please try again.");
        return;
      }
      router.replace("/login");
    } catch {
      setError(
        "We couldn't reach the sign-out service. Check your connection and try again.",
      );
    } finally {
      setSigningOut(false);
    }
  }

  return (
    <header className="border-line bg-surface shadow-card sticky top-0 z-40 border-b">
      <nav
        aria-label="Signed-in navigation"
        className="mx-auto flex w-full max-w-lg items-center gap-2 overflow-x-auto px-4 py-3 sm:px-5"
      >
        <ul className="flex min-w-0 flex-1 items-center gap-1">
          {NAV_ITEMS.map((item) => {
            const active = isActive(pathname, item.href);
            return (
              <li key={item.href}>
                <Link
                  href={item.href}
                  aria-current={active ? "page" : undefined}
                  className={`${NAV_LINK_CLASSES} ${
                    active
                      ? "bg-accent/10 text-accent"
                      : "text-muted hover:bg-line/50 hover:text-ink"
                  }`}
                >
                  {item.label}
                </Link>
              </li>
            );
          })}
        </ul>
        <button
          type="button"
          onClick={() => void handleSignOut()}
          disabled={signingOut}
          aria-busy={signingOut}
          className={`${NAV_LINK_CLASSES} text-muted hover:bg-line/50 hover:text-ink shrink-0 transition-transform active:scale-[0.98] disabled:pointer-events-none disabled:opacity-40`}
        >
          {signingOut ? "Signing out…" : "Log out"}
        </button>
      </nav>
      {error && (
        <p
          role="alert"
          className="mx-auto w-full max-w-lg px-5 pb-2 text-sm font-medium text-red-600"
        >
          {error}
        </p>
      )}
    </header>
  );
}
