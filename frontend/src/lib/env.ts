/**
 * Centralized environment variable access.
 *
 * Values are read lazily at call time so that builds (CI, Vercel) never
 * require real credentials. Validation happens only when a value is used.
 *
 * Each variable must be referenced as a static `process.env.NEXT_PUBLIC_*`
 * member expression at its call site: Next.js only inlines static lookups
 * into the browser bundle, so dynamic `process.env[key]` access would be
 * `undefined` in the client.
 */

function getPublicEnv(key: string, value: string | undefined): string {
  if (!value) {
    throw new Error(
      `Missing environment variable ${key}. ` +
        "Copy .env.example to .env.local and fill in the values.",
    );
  }
  return value;
}

export function supabaseUrl(): string {
  return getPublicEnv(
    "NEXT_PUBLIC_SUPABASE_URL",
    process.env.NEXT_PUBLIC_SUPABASE_URL,
  );
}

export function supabaseAnonKey(): string {
  return getPublicEnv(
    "NEXT_PUBLIC_SUPABASE_ANON_KEY",
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY,
  );
}

/** Base URL of the FastAPI backend (no trailing slash). */
export function apiBaseUrl(): string {
  return getPublicEnv(
    "NEXT_PUBLIC_API_BASE_URL",
    process.env.NEXT_PUBLIC_API_BASE_URL,
  ).replace(/\/+$/, "");
}
