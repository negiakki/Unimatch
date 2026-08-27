/**
 * Centralized environment variable access.
 *
 * Values are read lazily at call time so that builds (CI, Vercel) never
 * require real credentials. Validation happens only when a value is used.
 */

function getPublicEnv(key: string): string {
  const value = process.env[key];
  if (!value) {
    throw new Error(
      `Missing environment variable ${key}. ` +
        "Copy .env.example to .env.local and fill in the values.",
    );
  }
  return value;
}

export function supabaseUrl(): string {
  return getPublicEnv("NEXT_PUBLIC_SUPABASE_URL");
}

export function supabaseAnonKey(): string {
  return getPublicEnv("NEXT_PUBLIC_SUPABASE_ANON_KEY");
}
