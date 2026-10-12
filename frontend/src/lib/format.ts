/**
 * Shared presentation helpers: class joining, category atmosphere keys, and
 * the date/time formatting used across opportunity surfaces.
 *
 * Formatting is done once here so an opportunity reads identically on the
 * hub, the detail page, matches, and chat.
 */

export function cx(...parts: Array<string | false | null | undefined>): string {
  return parts.filter(Boolean).join(" ");
}

/**
 * Maps an admin-managed category to one of the design system's five
 * atmospheres. The catalog is data-driven, so an unknown or renamed category
 * degrades to the brand accent instead of rendering colorless or crashing.
 */
const CATEGORY_KEYWORDS: Record<string, string[]> = {
  sports: ["sport", "game", "athlet", "match", "tournament", "fitness"],
  events: ["event", "fest", "celebrat", "ceremon", "orientation"],
  entertainment: ["entertain", "movie", "film", "concert", "music", "theatre", "theater", "gaming", "comedy"],
  social: ["social", "hang", "meet", "club", "community", "network"],
  travel: ["travel", "trip", "tour", "trip", "outing", "excursion", "adventure"],
};

export function categoryKey(input: {
  slug?: string | null;
  name?: string | null;
}): string {
  const slug = (input.slug ?? "").toLowerCase();
  if (slug in CATEGORY_KEYWORDS) {
    return slug;
  }
  const haystack = `${slug} ${(input.name ?? "").toLowerCase()}`;
  for (const [key, words] of Object.entries(CATEGORY_KEYWORDS)) {
    if (words.some((word) => haystack.includes(word))) {
      return key;
    }
  }
  return "other";
}

const DATE_FORMAT = new Intl.DateTimeFormat(undefined, {
  weekday: "short",
  day: "numeric",
  month: "short",
});

/** "Fri 12 Sep" — null-safe, empty string when there is no date. */
export function formatEventDate(value: string | null | undefined): string {
  const date = toDate(value);
  return date ? DATE_FORMAT.format(date) : "";
}

/** "8:00 PM" from a bare "20:00:00" time string. */
export function formatClock(value: string | null | undefined): string {
  if (!value) {
    return "";
  }
  const match = /^(\d{1,2}):(\d{2})/.exec(value.trim());
  if (!match) {
    return "";
  }
  const date = new Date();
  date.setHours(Number(match[1]), Number(match[2]), 0, 0);
  return new Intl.DateTimeFormat(undefined, {
    hour: "numeric",
    minute: "2-digit",
  }).format(date);
}

/** "Fri 12 Sep · 8:00 PM" — the standard opportunity timestamp. */
export function formatWhen(
  date: string | null | undefined,
  time: string | null | undefined,
): string {
  const day = formatEventDate(date);
  const clock = formatClock(time);
  if (day && clock) return `${day} · ${clock}`;
  return day || clock;
}

export function formatMessageTime(value: string | null | undefined): string {
  const date = toDate(value);
  if (!date) {
    return "";
  }
  return new Intl.DateTimeFormat(undefined, {
    hour: "numeric",
    minute: "2-digit",
  }).format(date);
}

function toDate(value: string | null | undefined): Date | null {
  if (!value) {
    return null;
  }
  // Bare dates/times from Postgres are parsed as local wall-clock time.
  const date = new Date(/^\d{4}-\d{2}-\d{2}$/.test(value) ? `${value}T00:00:00` : value);
  return Number.isNaN(date.getTime()) ? null : date;
}

/** "Dandiya · Events" — the category/activity eyebrow on opportunity surfaces. */
export function formatTaxonomy(
  activity: { name?: string | null } | null | undefined,
  category: { name?: string | null } | null | undefined,
): string {
  return [activity?.name, category?.name].filter(Boolean).join(" · ");
}

/**
 * Human-readable byte size for upload chips. Shared so the verification flow,
 * the photo manager, and the admin queue stop each carrying their own copy.
 */
export function formatFileSize(bytes: number): string {
  if (bytes >= 1024 * 1024) {
    return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  }
  if (bytes >= 1024) {
    return `${Math.round(bytes / 1024)} KB`;
  }
  return `${bytes} B`;
}

/** "Find your Dandiya partner" — the contextual CTA voice. */
export function partnerCta(
  activity: { name?: string | null } | null | undefined,
  title: string | null | undefined,
): string {
  const subject = activity?.name ?? title;
  return subject ? `Find your ${subject} partner` : "Find your partner";
}