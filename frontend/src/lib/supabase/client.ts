import { createBrowserClient } from "@supabase/ssr";

import { supabaseAnonKey, supabaseUrl } from "@/lib/env";

/**
 * Supabase client for Client Components ("use client").
 * Creates a new instance per call; do not store it in module/global scope
 * so each request stays isolated (recommended @supabase/ssr pattern).
 */
export function createClient() {
  return createBrowserClient(supabaseUrl(), supabaseAnonKey());
}
