import Image from "next/image";
import Link from "next/link";
import type { ReactNode } from "react";

import { categoryKey, cx } from "@/lib/format";

/**
 * The small shared vocabulary of the UniMatch interface: buttons, the
 * editorial label, chips, avatars, and the four system states (loading, empty,
 * error, suspended). Everything else composes these.
 */

/* ----------------------------------------------------------------- button -- */

type ButtonVariant = "solid" | "outline" | "ghost" | "onDark";

const BUTTON_VARIANTS: Record<ButtonVariant, string> = {
  solid: "bg-accent text-accent-ink hover:brightness-110",
  outline: "border border-line-strong text-ink hover:border-ink",
  ghost: "text-muted hover:text-ink",
  onDark: "bg-paper text-ink hover:bg-white",
};

/** 48px min height — a comfortable thumb target, per mobile-first rules. */
const BUTTON_BASE =
  "inline-flex items-center justify-center gap-2 rounded-full px-6 py-3 text-sm font-semibold tracking-tight transition-[transform,filter,background-color,border-color] duration-150 active:scale-[0.98] disabled:pointer-events-none disabled:opacity-40";

export function Button({
  variant = "solid",
  className,
  ...props
}: React.ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: ButtonVariant;
}) {
  return (
    <button
      className={cx(BUTTON_BASE, BUTTON_VARIANTS[variant], className)}
      {...props}
    />
  );
}

export function ButtonLink({
  variant = "solid",
  className,
  ...props
}: React.ComponentProps<typeof Link> & { variant?: ButtonVariant }) {
  return (
    <Link
      className={cx(BUTTON_BASE, BUTTON_VARIANTS[variant], className)}
      {...props}
    />
  );
}

/* ------------------------------------------------------------------- type -- */

/** Small uppercase metadata label — the editorial voice. */
export function Label({ children, className }: { children: ReactNode; className?: string }) {
  return <span className={cx("type-meta text-muted", className)}>{children}</span>;
}

export function SectionHead({
  children,
  action,
  className,
}: {
  children: ReactNode;
  action?: ReactNode;
  className?: string;
}) {
  return (
    <div className={cx("flex items-end justify-between gap-4 border-b border-line pb-3", className)}>
      <h2 className="type-display text-[clamp(1.5rem,4vw,2.25rem)]">{children}</h2>
      {action}
    </div>
  );
}

/* ------------------------------------------------------------------ chips -- */

export function Chip({
  children,
  tone = "quiet",
  className,
}: {
  children: ReactNode;
  tone?: "quiet" | "accent";
  className?: string;
}) {
  return (
    <span
      className={cx(
        "inline-flex items-center rounded-full px-3 py-1 text-[13px] font-medium",
        tone === "accent"
          ? "bg-accent/12 text-accent"
          : "border border-line bg-surface text-ink",
        className,
      )}
    >
      {children}
    </span>
  );
}

/* ----------------------------------------------------------------- avatar -- */

const AVATAR_SIZES = {
  sm: "size-10 text-sm",
  md: "size-14 text-lg",
  lg: "size-24 text-3xl",
} as const;

/** Initials fallback keeps a photo-less profile human rather than empty.
 *
 * Takes a resolved photo URL rather than an API type on purpose: a shared
 * presentational primitive must not depend on one feature's response shape
 * (the same reason `CoverImage` takes `src`). The caller resolves the primary
 * photo with the client that owns it. */
export function Avatar({
  src,
  name = "Student",
  size = "md",
  className,
  ring = false,
}: {
  src: string | null;
  name?: string | null;
  size?: keyof typeof AVATAR_SIZES;
  className?: string;
  ring?: boolean;
}) {
  const url = src;
  const label = name ?? "Student";
  return (
    <span
      className={cx(
        "relative grid shrink-0 place-items-center overflow-hidden rounded-full bg-accent/12 text-accent",
        AVATAR_SIZES[size],
        ring && "ring-2 ring-paper",
        className,
      )}
    >
      {url ? (
        <Image
          src={url}
          alt={`${label}'s photo`}
          fill
          unoptimized
          sizes="96px"
          className="object-cover"
        />
      ) : (
        <span aria-hidden className="font-bold">
          {label.charAt(0).toUpperCase()}
        </span>
      )}
    </span>
  );
}

/** Full-bleed opportunity imagery with a coherent category-tinted fallback. */
export function CoverImage({
  src,
  alt,
  slug,
  name,
  className,
  sizes = "100vw",
  priority,
}: {
  src: string | null;
  alt: string;
  slug?: string | null;
  name?: string | null;
  className?: string;
  sizes?: string;
  priority?: boolean;
}) {
  return (
    <div
      data-category={categoryKey({ slug, name })}
      className={cx("relative overflow-hidden bg-ink", className)}
    >
      {src ? (
        <Image
          src={src}
          alt={alt}
          fill
          unoptimized={!src.startsWith("http")}
          priority={priority}
          sizes={sizes}
          className="object-cover"
        />
      ) : (
        <div
          aria-hidden
          className="grid size-full place-items-center bg-accent"
        >
          <span className="type-display px-4 text-center text-[clamp(2rem,8vw,4rem)] text-accent-ink/90">
            {alt}
          </span>
        </div>
      )}
    </div>
  );
}

/* --------------------------------------------------------- system states -- */

export function Skeleton({ className }: { className?: string }) {
  return (
    <div
      className={cx("animate-pulse bg-line", className)}
      aria-hidden="true"
    />
  );
}

export function LoadingBlock({ label, rows = 3 }: { label: string; rows?: number }) {
  return (
    <div aria-busy="true" aria-live="polite" className="py-8">
      <span className="sr-only">{label}</span>
      {Array.from({ length: rows }, (_, index) => (
        <Skeleton
          key={index}
          className={cx(
            "mb-4 h-28",
            index % 3 === 2 ? "w-2/3" : "w-full",
          )}
        />
      ))}
    </div>
  );
}

export function EmptyState({
  title,
  body,
  action,
}: {
  title: string;
  body: string;
  action?: ReactNode;
}) {
  return (
    <div className="border-t border-line py-16">
      <h2 className="type-display text-[clamp(1.5rem,5vw,2.25rem)]">{title}</h2>
      <p className="mt-3 max-w-md text-[15px] leading-relaxed text-muted">{body}</p>
      {action && <div className="mt-8">{action}</div>}
    </div>
  );
}

export function ErrorState({
  title = "Something went wrong",
  message,
  onRetry,
}: {
  title?: string;
  message: string;
  onRetry?: () => void;
}) {
  return (
    <div className="border-t border-line py-16" role="alert">
      <h2 className="type-display text-[clamp(1.5rem,5vw,2.25rem)]">{title}</h2>
      <p className="mt-3 max-w-md text-[15px] leading-relaxed text-muted">{message}</p>
      {onRetry && (
        <Button variant="outline" className="mt-8" onClick={onRetry}>
          Try again
        </Button>
      )}
    </div>
  );
}

/**
 * Suspended account state. The backend returns `account_suspended` for every
 * interactive request and exposes no expiry on any public surface, so the copy
 * stays restrained and says nothing about moderation internals.
 */
export function SuspendedState({
  message,
  action,
}: {
  message: string;
  action?: ReactNode;
}) {
  return (
    <section
      data-category="other"
      className="mx-auto w-full max-w-lg px-5 py-24"
    >
      <Label>Account</Label>
      <h1 className="type-display mt-4 text-[clamp(2rem,7vw,3.5rem)]">
        Your account is temporarily unavailable
      </h1>
      <p className="mt-4 max-w-md text-[15px] leading-relaxed text-muted">
        {message}
      </p>
      <p className="mt-3 max-w-md text-[15px] leading-relaxed text-muted">
        If you think this is a mistake, contact the UniMatch team.
      </p>
      {action && <div className="mt-8">{action}</div>}
    </section>
  );
}