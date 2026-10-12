"use client";

import { useCallback, useState } from "react";

import {
  createActivity,
  createCategory,
  deleteActivity,
  deleteCategory,
  fetchAdminActivities,
  fetchAdminCategories,
  type AdminActivity,
  type AdminCategory,
} from "@/lib/api/admin";
import { isApiError } from "@/lib/api/http";
import {
  Button,
  Chip,
  EmptyState,
  ErrorState,
  Label,
  Skeleton,
} from "@/components/ui";

import { useAdminLoad } from "../_admin-load";

/**
 * Opportunity catalog: categories and the activities that belong to them.
 *
 * Categories are the required parent of every opportunity, and an activity
 * always belongs to a category — so this page states that dependency on screen
 * instead of leaving an admin to discover it through a validation error while
 * creating an opportunity.
 */

export default function AdminCatalogPage() {
  const [categories, setCategories] = useState<AdminCategory[]>([]);
  const [activities, setActivities] = useState<AdminActivity[]>([]);
  const [busy, setBusy] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);

  const [categoryName, setCategoryName] = useState("");
  const [categoryIcon, setCategoryIcon] = useState("");
  const [activityName, setActivityName] = useState("");
  const [activityCategory, setActivityCategory] = useState("");

  const load = useCallback(async () => {
    const [c, a] = await Promise.all([fetchAdminCategories(), fetchAdminActivities()]);
    setCategories(c);
    setActivities(a);
  }, []);

  const { phase, error, errorTitle, fatal, refresh } = useAdminLoad(load, []);

  const flash = useCallback((message: string) => {
    setNotice(message);
    window.setTimeout(() => setNotice(null), 6000);
  }, []);

  async function run(id: string, action: () => Promise<unknown>, message: string) {
    setBusy(id);
    setActionError(null);
    try {
      await action();
      await load();
      flash(message);
    } catch (caught) {
      setActionError(
        isApiError(caught) ? caught.message : "That action couldn't be completed.",
      );
    } finally {
      setBusy(null);
    }
  }

  /** Slug mirrors the backend's own normalization so the two never disagree. */
  function slugify(value: string): string {
    return value
      .toLowerCase()
      .trim()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "");
  }

  return (
    <div className="mx-auto w-full max-w-4xl">
      <header className="border-b border-line pb-5">
        <Label>Catalog</Label>
        <h1 className="type-display mt-3 text-[clamp(2rem,6vw,3rem)]">
          Categories &amp; activities
        </h1>
        <p className="mt-3 max-w-2xl text-[15px] leading-relaxed text-muted">
          Every opportunity needs a category, and every activity belongs to one.
          Create a category before creating an activity.
        </p>
      </header>

      {notice && (
        <p role="status" className="mt-6 rounded-2xl bg-accent/12 px-4 py-3 text-sm font-medium">
          {notice}
        </p>
      )}
      {actionError && (
        <p role="alert" className="mt-6 rounded-2xl border border-danger/30 bg-danger/5 px-4 py-3 text-sm font-medium text-danger">
          {actionError}
        </p>
      )}

      {phase === "loading" && (
        <div aria-busy="true" aria-live="polite" className="mt-8 space-y-3">
          <span className="sr-only">Loading catalog</span>
          {Array.from({ length: 3 }, (_, index) => (
            <Skeleton key={index} className="h-20 rounded-2xl" />
          ))}
        </div>
      )}

      {phase === "error" && (
        <ErrorState
          title={errorTitle ?? "Couldn't load this"}
          message={error ?? "Please try again."}
          onRetry={fatal ? undefined : refresh}
        />
      )}

      {phase === "ready" && (
        <>
          <section className="mt-10">
            <h2 className="type-display text-[clamp(1.25rem,4vw,1.75rem)]">
              Categories
            </h2>

            <form
              className="mt-4 flex flex-wrap gap-3"
              onSubmit={(event) => {
                event.preventDefault();
                const name = categoryName.trim();
                if (!name) return;
                void run(
                  "new-category",
                  () => createCategory({ name, slug: slugify(name), icon: categoryIcon.trim() || null }),
                  `“${name}” created.`,
                ).then(() => setCategoryName(""));
              }}
            >
              <label htmlFor="category-name" className="sr-only">
                Category name
              </label>
              <input
                id="category-name"
                value={categoryName}
                onChange={(event) => setCategoryName(event.target.value)}
                placeholder="New category"
                className="min-w-0 flex-1 rounded-full border border-line bg-surface px-5 py-3 text-[15px] placeholder:text-muted/60 focus:border-accent"
              />
              <label htmlFor="category-icon" className="sr-only">
                Category icon
              </label>
              <input
                id="category-icon"
                value={categoryIcon}
                onChange={(event) => setCategoryIcon(event.target.value)}
                placeholder="Icon (optional)"
                className="w-40 rounded-full border border-line bg-surface px-5 py-3 text-[15px] placeholder:text-muted/60 focus:border-accent"
              />
              <Button type="submit" disabled={busy === "new-category" || !categoryName.trim()}>
                {busy === "new-category" ? "Adding…" : "Add category"}
              </Button>
            </form>

            {categories.length === 0 ? (
              <EmptyState
                title="No categories yet"
                body="Opportunities can't be created until at least one category exists."
              />
            ) : (
              <ul className="mt-6 space-y-3">
                {categories.map((category) => {
                  const children = activities.filter(
                    (activity) => activity.category_id === category.id,
                  );
                  return (
                    <li
                      key={category.id}
                      className="rounded-2xl border border-line bg-surface p-4"
                    >
                      <div className="flex flex-wrap items-center gap-2">
                        <span className="font-semibold">{category.name}</span>
                        <Chip>{category.slug}</Chip>
                        {!category.is_active && <Chip>Inactive</Chip>}
                        <Button
                          variant="ghost"
                          className="ml-auto !px-4 !py-2 text-[13px]"
                          disabled={busy === category.id}
                          onClick={() => {
                            if (
                              !window.confirm(
                                `Delete “${category.name}”? Opportunities using it are affected. This cannot be undone.`,
                              )
                            ) {
                              return;
                            }
                            void run(
                              category.id,
                              () => deleteCategory(category.id),
                              `“${category.name}” deleted.`,
                            );
                          }}
                        >
                          {busy === category.id ? "Deleting…" : "Delete"}
                        </Button>
                      </div>
                      {children.length > 0 && (
                        <ul className="mt-3 space-y-1 border-t border-line pt-3">
                          {children.map((activity) => (
                            <li
                              key={activity.id}
                              className="flex items-center gap-2 text-sm"
                            >
                              <span>{activity.name}</span>
                              <span className="text-muted">· {activity.slug}</span>
                              <Button
                                variant="ghost"
                                className="ml-auto !px-3 !py-1 text-xs"
                                disabled={busy === activity.id}
                                onClick={() => {
                                  if (!window.confirm(`Delete “${activity.name}”?`)) return;
                                  void run(
                                    activity.id,
                                    () => deleteActivity(activity.id),
                                    `“${activity.name}” deleted.`,
                                  );
                                }}
                              >
                                {busy === activity.id ? "…" : "Delete"}
                              </Button>
                            </li>
                          ))}
                        </ul>
                      )}
                    </li>
                  );
                })}
              </ul>
            )}
          </section>

          <section className="mt-14">
            <h2 className="type-display text-[clamp(1.25rem,4vw,1.75rem)]">
              Activities
            </h2>
            <p className="mt-2 text-[15px] text-muted">
              Activities are optional on an opportunity, but must belong to a
              category.
            </p>

            <form
              className="mt-4 flex flex-wrap gap-3"
              onSubmit={(event) => {
                event.preventDefault();
                const name = activityName.trim();
                if (!name || !activityCategory) return;
                void run(
                  "new-activity",
                  () =>
                    createActivity({
                      name,
                      slug: slugify(name),
                      category_id: activityCategory,
                    }),
                  `“${name}” created.`,
                ).then(() => setActivityName(""));
              }}
            >
              <label htmlFor="activity-name" className="sr-only">
                Activity name
              </label>
              <input
                id="activity-name"
                value={activityName}
                onChange={(event) => setActivityName(event.target.value)}
                placeholder="New activity"
                className="min-w-0 flex-1 rounded-full border border-line bg-surface px-5 py-3 text-[15px] placeholder:text-muted/60 focus:border-accent"
              />
              <label htmlFor="activity-category" className="sr-only">
                Parent category
              </label>
              <select
                id="activity-category"
                value={activityCategory}
                onChange={(event) => setActivityCategory(event.target.value)}
                className="rounded-full border border-line bg-surface px-5 py-3 text-[15px]"
              >
                <option value="">Choose a category…</option>
                {categories.map((category) => (
                  <option key={category.id} value={category.id}>
                    {category.name}
                  </option>
                ))}
              </select>
              <Button
                type="submit"
                disabled={
                  busy === "new-activity" ||
                  !activityName.trim() ||
                  !activityCategory
                }
              >
                {busy === "new-activity" ? "Adding…" : "Add activity"}
              </Button>
            </form>

            {categories.length === 0 && (
              <p className="mt-4 text-sm text-muted">
                Create a category first — an activity must belong to one.
              </p>
            )}
          </section>
        </>
      )}
    </div>
  );
}