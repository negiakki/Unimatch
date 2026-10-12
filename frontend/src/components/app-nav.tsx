"use client";

import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { useState } from "react";

import { createClient } from "@/lib/supabase/client";
import { cx } from "@/lib/format";

/**
 * Signed-in navigation: a top bar on desktop, a thumb-reachable bottom tab
 * bar on mobile. One component, both presentations — no separate mobile shell.
 *
 * Client Component so it can mark the active route and sign out through the
 * existing Supabase browser client.
 */

const NAV_ITEMS = [
  { href: "/explore", label: "Discover" },
  { href: "/matches", label: "Matches" },
  { href: "/messages", label: "Chats" },
  { href: "/profile", label: "Profile" },
] as const;

function isActive(pathname: string, href: string) {
  return pathname === href || pathname.startsWith(`${href}/`);
}

/** Line-art tab glyphs: stroke-only, no emoji, no filled blobs. */
function TabIcon({ name }: { name: (typeof NAV_ITEMS)[number]["href"] }) {
  const common = {
    viewBox: "0 0 24 24",
    fill: "none",
    stroke: "currentColor",
    strokeWidth: 1.6,
    strokeLinecap: "round" as const,
    strokeLinejoin: "round" as const,
    "aria-hidden": true,
    className: "size-[22px]",
  };
  if (name === "/explore") {
    return (
      <svg {...common}>
        <circle cx="12" cy="12" r="8.5" />
        <path d="m14.8 9.2-1.7 4.4-4.4 1.7 1.7-4.4z" />
      </svg>
    );
  }
  if (name === "/matches") {
    return (
      <svg {...common}>
        <path d="M12 4.5 19 9v6l-7 4.5L5 15V9z" />
      </svg>
    );
  }
  if (name === "/messages") {
    return (
      <svg {...common}>
        <path d="M5 6.5h14v9H9l-4 3.5z" />
      </svg>
    );
  }
  return (
    <svg {...common}>
      <circle cx="12" cy="9" r="3.5" />
      <path d="M5.5 19.5c1.2-3.2 3.6-4.8 6.5-4.8s5.3 1.6 6.5 4.8" />
    </svg>
  );
}

export function AppNav() {
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
      const { error: signOutError } = await createClient().auth.signOut();
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
    <>
      {/* Desktop: horizontal bar with the wordmark. */}
      <header className="sticky top-0 z-40 hidden border-b border-line bg-paper/90 backdrop-blur md:block">
        <nav
          aria-label="Main"
          className="mx-auto flex w-full max-w-6xl items-center gap-8 px-8 py-4"
        >
          <Link href="/explore" className="type-display text-xl tracking-tight">
            UniMatch
          </Link>
          <ul className="flex flex-1 items-center gap-7">
            {NAV_ITEMS.map((item) => {
              const active = isActive(pathname, item.href);
              return (
                <li key={item.href}>
                  <Link
                    href={item.href}
                    aria-current={active ? "page" : undefined}
                    className={cx(
                      "relative py-1 text-sm font-semibold transition-colors",
                      active ? "text-ink" : "text-muted hover:text-ink",
                    )}
                  >
                    {item.label}
                    {active && (
                      <span
                        aria-hidden
                        className="absolute inset-x-0 -bottom-0.5 h-0.5 bg-accent"
                      />
                    )}
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
            className="text-sm font-semibold text-muted transition-colors hover:text-ink disabled:opacity-40"
          >
            {signingOut ? "Signing out…" : "Log out"}
          </button>
        </nav>
        {error && (
          <p role="alert" className="mx-auto max-w-6xl px-8 pb-2 text-sm text-danger">
            {error}
          </p>
        )}
      </header>

      {/* Mobile: minimal wordmark up top, tabs pinned to the bottom edge. */}
      <header className="sticky top-0 z-40 flex items-center justify-between border-b border-line bg-paper/90 px-5 py-3 backdrop-blur md:hidden">
        <Link href="/explore" className="type-display text-lg tracking-tight">
          UniMatch
        </Link>
        <button
          type="button"
          onClick={() => void handleSignOut()}
          disabled={signingOut}
          aria-busy={signingOut}
          className="text-[13px] font-semibold text-muted disabled:opacity-40"
        >
          {signingOut ? "…" : "Log out"}
        </button>
        {error && (
          <p role="alert" className="absolute inset-x-4 top-full border-b border-line bg-surface px-4 py-2 text-xs text-danger">
            {error}
          </p>
        )}
      </header>

      <nav
        aria-label="Main"
        className="fixed inset-x-0 bottom-0 z-40 border-t border-line bg-paper/95 pb-[env(safe-area-inset-bottom)] backdrop-blur md:hidden"
      >
        <ul className="grid grid-cols-4">
          {NAV_ITEMS.map((item) => {
            const active = isActive(pathname, item.href);
            return (
              <li key={item.href}>
                <Link
                  href={item.href}
                  aria-current={active ? "page" : undefined}
                  className={cx(
                    "flex min-h-14 flex-col items-center justify-center gap-1 py-2 text-[11px] font-semibold transition-colors",
                    active ? "text-accent" : "text-muted",
                  )}
                >
                  <TabIcon name={item.href} />
                  {item.label}
                </Link>
              </li>
            );
          })}
        </ul>
      </nav>
    </>
  );
}

/** Bottom-nav safe padding for the last element of a signed-in page. */
export const TAB_BAR_SPACE = "pb-24 md:pb-16";