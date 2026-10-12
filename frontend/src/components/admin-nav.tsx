"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useState, type ReactNode } from "react";

import { cx } from "@/lib/format";

/**
 * Admin shell navigation. One list, two presentations: a persistent left rail
 * on desktop, a disclosure panel on mobile. Active state is derived from the
 * pathname so a nested route (e.g. /admin/verifications) still lights up.
 *
 * This is navigation only — it is NOT an authorization boundary. Staff
 * membership is enforced server-side by the `staff_admins` lookup behind
 * `CurrentStaffUserDep`; a non-staff user can reach any of these URLs and every
 * request they make comes back 401/403.
 */

const ADMIN_NAV = [
  { href: "/admin", label: "Overview", exact: true },
  { href: "/admin/verifications", label: "People & Verification", exact: false },
  { href: "/admin/people", label: "People", exact: false },
  { href: "/admin/safety", label: "Safety & Moderation", exact: false },
  { href: "/admin/opportunities", label: "Opportunities", exact: false },
  { href: "/admin/catalog", label: "Catalog", exact: false },
  { href: "/admin/account", label: "Account", exact: false },
] as const;

function isActive(pathname: string, href: string, exact: boolean): boolean {
  return exact ? pathname === href : pathname === href || pathname.startsWith(`${href}/`);
}

/** Line-art glyphs, matching the consumer nav: stroke-only, no emoji. */
function NavIcon({ href }: { href: string }) {
  const common = {
    viewBox: "0 0 24 24",
    fill: "none",
    stroke: "currentColor",
    strokeWidth: 1.6,
    strokeLinecap: "round" as const,
    strokeLinejoin: "round" as const,
    "aria-hidden": true,
    className: "size-[18px] shrink-0",
  };
  if (href === "/admin") {
    return (
      <svg {...common}>
        <rect x="3.5" y="3.5" width="7" height="9" rx="1.5" />
        <rect x="13.5" y="3.5" width="7" height="5.5" rx="1.5" />
        <rect x="13.5" y="12" width="7" height="8.5" rx="1.5" />
        <rect x="3.5" y="15.5" width="7" height="5" rx="1.5" />
      </svg>
    );
  }
  if (href === "/admin/verifications") {
    return (
      <svg {...common}>
        <path d="M15 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7Z" />
        <path d="M14 2v4a2 2 0 0 0 2 2h4" />
        <path d="m9 14 2 2 4-4" />
      </svg>
    );
  }
  if (href === "/admin/people") {
    return (
      <svg {...common}>
        <circle cx="9" cy="8" r="3.2" />
        <path d="M3.5 19.5c1.1-3.1 3-4.7 5.5-4.7s4.4 1.6 5.5 4.7" />
        <path d="M16 5.2a3 3 0 0 1 0 5.6M17.5 19.5c-.4-1.9-1.2-3.3-2.3-4.2" />
      </svg>
    );
  }
  if (href === "/admin/safety") {
    return (
      <svg {...common}>
        <path d="M12 2.8 20 6v6c0 4.6-3.2 8.4-8 9.4-4.8-1-8-4.8-8-9.4V6Z" />
        <path d="M12 8.5v4.5M12 16h.01" />
      </svg>
    );
  }
  if (href === "/admin/opportunities") {
    return (
      <svg {...common}>
        <rect x="3.5" y="5" width="17" height="15" rx="2" />
        <path d="M3.5 9.5h17M8 3v4M16 3v4" />
      </svg>
    );
  }
  if (href === "/admin/catalog") {
    return (
      <svg {...common}>
        <path d="M4 5.5h16M4 12h16M4 18.5h10" />
      </svg>
    );
  }
  return (
    <svg {...common}>
      <circle cx="12" cy="8" r="3.4" />
      <path d="M5 20c1.2-3.3 3.7-5 7-5s5.8 1.7 7 5" />
    </svg>
  );
}

function NavList({ pathname, onNavigate }: { pathname: string; onNavigate?: () => void }) {
  return (
    <ul className="flex flex-col gap-1">
      {ADMIN_NAV.map((item) => {
        const active = isActive(pathname, item.href, item.exact);
        return (
          <li key={item.href}>
            <Link
              href={item.href}
              aria-current={active ? "page" : undefined}
              // onClick closes the mobile panel directly, so the overlay is
              // dismissed by the interaction itself rather than by an effect
              // that watches the pathname and re-renders on every navigation.
              onClick={onNavigate}
              className={cx(
                "flex items-center gap-3 rounded-xl px-3 py-2.5 text-sm font-semibold transition-colors",
                active
                  ? "bg-accent/12 text-accent"
                  : "text-muted hover:bg-line/40 hover:text-ink",
              )}
            >
              <NavIcon href={item.href} />
              <span className="truncate">{item.label}</span>
            </Link>
          </li>
        );
      })}
    </ul>
  );
}

export function AdminNav() {
  const pathname = usePathname();
  const [open, setOpen] = useState(false);

  return (
    <>
      {/* Mobile: a disclosure button that toggles the same list. */}
      <div className="sticky top-0 z-30 border-b border-line bg-paper/95 px-5 py-3 backdrop-blur md:hidden">
        <button
          type="button"
          onClick={() => setOpen((value) => !value)}
          aria-expanded={open}
          aria-controls="admin-mobile-nav"
          className="flex w-full items-center justify-between gap-3 text-sm font-semibold"
        >
          <span className="type-display text-lg tracking-tight">UniMatch Admin</span>
          <span className="text-muted" aria-hidden>
            {open ? "✕" : "☰"}
          </span>
          <span className="sr-only">{open ? "Close admin menu" : "Open admin menu"}</span>
        </button>
        {open && (
          <nav
            id="admin-mobile-nav"
            aria-label="Admin"
            className="mt-3 pb-2"
          >
            <NavList pathname={pathname} onNavigate={() => setOpen(false)} />
          </nav>
        )}
      </div>

      {/* Desktop: the persistent left rail. */}
      <nav
        aria-label="Admin"
        className="hidden w-56 shrink-0 border-r border-line px-4 py-8 md:block"
      >
        <Link href="/admin" className="type-display block text-lg tracking-tight">
          UniMatch
        </Link>
        <p className="type-meta mt-1 text-muted">Admin</p>
        <div className="mt-8">
          <NavList pathname={pathname} />
        </div>
      </nav>
    </>
  );
}

export function AdminShell({ children }: { children: ReactNode }) {
  return (
    <div className="flex min-h-full flex-col md:flex-row">
      <AdminNav />
      <main className="min-w-0 flex-1 px-5 pb-20 pt-8 md:px-8 md:pb-16">{children}</main>
    </div>
  );
}