/**
 * Opportunity category & activity catalog (public reference data).
 *
 * GET /api/v1/categories — active categories with their nested activities.
 *
 * The catalog is admin-managed and public, so this drives category navigation
 * and the per-category atmosphere (accent colour) instead of hardcoding
 * category logic in the UI.
 */

import { requestJson } from "@/lib/api/http";

export interface Activity {
  id: string;
  category_id: string | null;
  name: string | null;
  slug: string | null;
  sort_order: number;
}

export interface Category {
  id: string;
  name: string | null;
  slug: string | null;
  icon: string | null;
  sort_order: number;
  activities: Activity[];
}

export async function fetchCategories(): Promise<Category[]> {
  return (await requestJson<Category[]>("/api/v1/categories", { method: "GET" })) ?? [];
}