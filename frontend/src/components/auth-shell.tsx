import Link from "next/link";
import type { ReactNode } from "react";

import { Label } from "@/components/ui";

/**
 * Shell for the pre-product surfaces (sign in, sign up, verification,
 * onboarding). No app navigation — these screens come before there is
 * anything to navigate to — just the wordmark and a calm, narrow column.
 *
 * The first line of the column is the editorial statement for the screen, so
 * every step of getting set up speaks in the same voice.
 */
export function AuthShell({
  eyebrow,
  title,
  lede,
  children,
}: {
  eyebrow: string;
  title: string;
  lede: string;
  children: ReactNode;
}) {
  return (
    <main className="flex flex-1 flex-col">
      <header className="mx-auto flex w-full max-w-2xl items-center justify-between px-5 py-6 sm:px-8">
        <Link href="/" className="type-display text-lg tracking-tight">
          UniMatch
        </Link>
      </header>

      <div className="mx-auto w-full max-w-2xl flex-1 px-5 pb-16 sm:px-8">
        <div className="animate-rise">
          <Label>{eyebrow}</Label>
          <h1 className="type-display mt-4 text-display">{title}</h1>
          <p className="mt-4 max-w-md text-[15px] leading-relaxed text-muted">
            {lede}
          </p>
        </div>
        <div className="mt-10">{children}</div>
      </div>
    </main>
  );
}