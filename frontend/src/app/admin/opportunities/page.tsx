"use client";

import Link from "next/link";
import { useCallback, useState } from "react";

import {
  createOpportunity,
  deleteOpportunity,
  fetchAdminActivities,
  fetchAdminCategories,
  fetchAdminOpportunities,
  fetchOpportunityApplications,
  setOpportunityStatus,
  updateOpportunity,
  type AdminOpportunity,
  type OpportunityApplication,
  type OpportunityInput,
  type OpportunityState,
} from "@/lib/api/admin";
import { isApiError } from "@/lib/api/http";
import { cx } from "@/lib/format";
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
 * Opportunity management: the full DRAFT -> PUBLISHED -> PAUSED -> CANCELLED /
 * EXPIRED lifecycle, plus the applications attached to each opportunity.
 *
 * The state machine is enforced server-side; this page only offers the
 * transitions the backend actually supports and surfaces its refusal (409 on
 * an illegal move) rather than hiding state or inventing one. An opportunity is
 * always born DRAFT — the create payload has no `status` field, matching
 * `OpportunityWrite` on the backend.
 */

const STATES: (OpportunityState | "ALL")[] = [
  "ALL",
  "DRAFT",
  "PUBLISHED",
  "PAUSED",
  "CANCELLED",
  "EXPIRED",
];

/** Transitions the backend routes exist for, per source state. */
const TRANSITIONS: Record<OpportunityState, { action: string; label: string }[]> = {
  DRAFT: [{ action: "publish", label: "Publish" }],
  PUBLISHED: [
    { action: "pause", label: "Pause" },
    { action: "cancel", label: "Cancel" },
    { action: "expire", label: "Expire" },
  ],
  PAUSED: [
    { action: "publish", label: "Publish" },
    { action: "cancel", label: "Cancel" },
  ],
  CANCELLED: [],
  EXPIRED: [],
};

const EMPTY_FORM = {
  title: "",
  description: "",
  category_id: "",
  activity_id: "",
  opportunity_date: "",
  location: "",
  capacity: "",
};

export default function AdminOpportunitiesPage() {
  const [status, setStatus] = useState<OpportunityState | "ALL">("ALL");
  const [opportunities, setOpportunities] = useState<AdminOpportunity[]>([]);
  const [categories, setCategories] = useState<{ id: string; name: string | null }[]>([]);
  const [activities, setActivities] = useState<
    { id: string; name: string | null; category_id: string | null }[]
  >([]);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [form, setForm] = useState(EMPTY_FORM);
  const [formError, setFormError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [applications, setApplications] = useState<OpportunityApplication[] | null>(null);

  const load = useCallback(async () => {
    const [list, cats, acts] = await Promise.all([
      fetchAdminOpportunities(status === "ALL" ? undefined : status),
      fetchAdminCategories(),
      fetchAdminActivities(),
    ]);
    setOpportunities(list);
    setCategories(cats);
    setActivities(acts);
  }, [status]);

  const { phase, error, errorTitle, fatal, refresh } = useAdminLoad(load, [status]);

  const flash = useCallback((message: string) => {
    setNotice(message);
    window.setTimeout(() => setNotice(null), 6000);
  }, []);

  /** Resolves true when the action and the follow-up refresh both succeeded. */
  async function run(
    id: string,
    action: () => Promise<unknown>,
    message: string,
  ): Promise<boolean> {
    setBusy(id);
    setActionError(null);
    try {
      await action();
      await load();
      flash(message);
      return true;
    } catch (caught) {
      setActionError(
        isApiError(caught) ? caught.message : "That action couldn't be completed.",
      );
      return false;
    } finally {
      setBusy(null);
    }
  }

  function payload(): OpportunityInput {
    return {
      title: form.title.trim(),
      description: form.description.trim(),
      category_id: form.category_id,
      activity_id: form.activity_id || null,
      opportunity_date: form.opportunity_date || null,
      location: form.location.trim() || null,
      capacity: form.capacity ? Number(form.capacity) : null,
    };
  }

  async function submit() {
    if (!form.title.trim()) {
      setFormError("A title is required.");
      return;
    }
    if (!form.category_id) {
      setFormError("Choose a category — every opportunity needs one.");
      return;
    }
    setFormError(null);
    const body = payload();
    const saved = editingId
      ? await run(editingId, () => updateOpportunity(editingId, body), "Opportunity updated.")
      : await run("new", () => createOpportunity(body), "Opportunity created as a draft.");
    // Keep everything the user typed when the save failed, so it can be retried.
    if (!saved) return;
    setForm(EMPTY_FORM);
    setEditingId(null);
  }

  function startEdit(opportunity: AdminOpportunity) {
    setEditingId(opportunity.id);
    setFormError(null);
    setForm({
      title: opportunity.title ?? "",
      description: opportunity.description ?? "",
      category_id: opportunity.category_id ?? "",
      activity_id: opportunity.activity_id ?? "",
      opportunity_date: opportunity.opportunity_date ?? "",
      location: opportunity.location ?? "",
      capacity: opportunity.capacity ? String(opportunity.capacity) : "",
    });
    window.scrollTo({ top: 0, behavior: "smooth" });
  }

  // An activity can only be chosen from the activity's parent category.
  const selectableActivities = form.category_id
    ? activities.filter((activity) => activity.category_id === form.category_id)
    : [];

  // `busy` and `editingId` both use null as their idle value, so comparing them
  // directly is true for two nulls and pins the button to "Saving…" forever.
  const saving = busy === "new" || (editingId !== null && busy === editingId);

  return (
    <div className="mx-auto w-full max-w-4xl">
      <header className="border-b border-line pb-5">
        <Label>Opportunities</Label>
        <h1 className="type-display mt-3 text-[clamp(2rem,6vw,3rem)]">
          Opportunities
        </h1>
        <p className="mt-3 max-w-2xl text-[15px] leading-relaxed text-muted">
          Drafts are invisible to students. Only published opportunities appear
          in discovery.
        </p>
      </header>

      {categories.length === 0 && phase === "ready" && (
        <p className="mt-6 rounded-2xl border border-line bg-surface px-4 py-3 text-sm">
          There are no categories yet, so an opportunity can&rsquo;t be created.{" "}
          <Link href="/admin/catalog" className="font-semibold text-accent underline">
            Create one in the catalog
          </Link>
          .
        </p>
      )}

      <section className="mt-8 rounded-2xl border border-line bg-surface p-5">
        <h2 className="text-lg font-bold tracking-tight">
          {editingId ? "Edit opportunity" : "New opportunity"}
        </h2>
        <div className="mt-4 space-y-3">
          <div>
            <label htmlFor="opp-title" className="text-sm font-semibold">
              Title
            </label>
            <input
              id="opp-title"
              value={form.title}
              onChange={(event) => setForm({ ...form, title: event.target.value })}
              maxLength={120}
              className="mt-1 w-full rounded-2xl border border-line bg-background px-4 py-3 text-[15px] focus:border-accent"
            />
          </div>
          <div>
            <label htmlFor="opp-description" className="text-sm font-semibold">
              Description
            </label>
            <textarea
              id="opp-description"
              value={form.description}
              onChange={(event) => setForm({ ...form, description: event.target.value })}
              rows={2}
              maxLength={2000}
              className="mt-1 w-full rounded-2xl border border-line bg-background px-4 py-3 text-[15px] focus:border-accent"
            />
          </div>
          <div className="grid gap-3 sm:grid-cols-2">
            <div>
              <label htmlFor="opp-category" className="text-sm font-semibold">
                Category <span className="text-danger">*</span>
              </label>
              <select
                id="opp-category"
                value={form.category_id}
                onChange={(event) =>
                  setForm({ ...form, category_id: event.target.value, activity_id: "" })
                }
                className="mt-1 w-full rounded-2xl border border-line bg-background px-4 py-3 text-[15px]"
              >
                <option value="">Choose a category…</option>
                {categories.map((category) => (
                  <option key={category.id} value={category.id}>
                    {category.name}
                  </option>
                ))}
              </select>
            </div>
            <div>
              <label htmlFor="opp-activity" className="text-sm font-semibold">
                Activity
              </label>
              <select
                id="opp-activity"
                value={form.activity_id}
                onChange={(event) => setForm({ ...form, activity_id: event.target.value })}
                disabled={!form.category_id}
                className="mt-1 w-full rounded-2xl border border-line bg-background px-4 py-3 text-[15px] disabled:opacity-50"
              >
                <option value="">No activity</option>
                {selectableActivities.map((activity) => (
                  <option key={activity.id} value={activity.id}>
                    {activity.name}
                  </option>
                ))}
              </select>
              {!form.category_id && (
                <p className="mt-1 text-xs text-muted">Choose a category first.</p>
              )}
            </div>
            <div>
              <label htmlFor="opp-date" className="text-sm font-semibold">
                Date
              </label>
              <input
                id="opp-date"
                type="date"
                value={form.opportunity_date ?? ""}
                onChange={(event) => setForm({ ...form, opportunity_date: event.target.value })}
                className="mt-1 w-full rounded-2xl border border-line bg-background px-4 py-3 text-[15px]"
              />
            </div>
            <div>
              <label htmlFor="opp-location" className="text-sm font-semibold">
                Location
              </label>
              <input
                id="opp-location"
                value={form.location}
                onChange={(event) => setForm({ ...form, location: event.target.value })}
                maxLength={200}
                className="mt-1 w-full rounded-2xl border border-line bg-background px-4 py-3 text-[15px]"
              />
            </div>
            <div>
              <label htmlFor="opp-capacity" className="text-sm font-semibold">
                Capacity
              </label>
              <input
                id="opp-capacity"
                type="number"
                min={1}
                value={form.capacity}
                onChange={(event) => setForm({ ...form, capacity: event.target.value })}
                className="mt-1 w-full rounded-2xl border border-line bg-background px-4 py-3 text-[15px]"
              />
            </div>
          </div>
        </div>

        {formError && (
          <p role="alert" className="mt-3 text-sm font-medium text-danger">
            {formError}
          </p>
        )}

        <div className="mt-4 flex flex-wrap gap-2">
          <Button disabled={saving} onClick={() => void submit()}>
            {saving ? "Saving…" : editingId ? "Save changes" : "Create draft"}
          </Button>
          {editingId && (
            <Button
              variant="ghost"
              onClick={() => {
                setEditingId(null);
                setForm(EMPTY_FORM);
                setFormError(null);
              }}
            >
              Cancel
            </Button>
          )}
        </div>
      </section>

      <div role="tablist" aria-label="Filter by status" className="mt-10 inline-flex flex-wrap gap-1 rounded-full border border-line bg-surface p-1">
        {STATES.map((state) => (
          <button
            key={state}
            type="button"
            role="tab"
            aria-selected={status === state}
            onClick={() => setStatus(state)}
            className={cx(
              "rounded-full px-4 py-2 text-sm font-semibold transition-colors",
              status === state ? "bg-accent text-accent-ink" : "text-muted hover:text-ink",
            )}
          >
            {state === "ALL" ? "All" : state}
          </button>
        ))}
      </div>

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
        <div aria-busy="true" aria-live="polite" className="mt-6 space-y-3">
          <span className="sr-only">Loading opportunities</span>
          {Array.from({ length: 3 }, (_, index) => (
            <Skeleton key={index} className="h-24 rounded-2xl" />
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

      {phase === "ready" && opportunities.length === 0 && (
        <EmptyState
          title="No opportunities"
          body={
            status === "ALL"
              ? "Create the first opportunity above. It starts as a draft."
              : `No ${status.toLowerCase()} opportunities.`
          }
        />
      )}

      {phase === "ready" && opportunities.length > 0 && (
        <ul className="mt-6 space-y-3">
          {opportunities.map((opportunity) => (
            <li
              key={opportunity.id}
              className="rounded-2xl border border-line bg-surface p-5"
            >
              <div className="flex flex-wrap items-center gap-2">
                <span className="font-semibold">{opportunity.title}</span>
                <Chip tone={opportunity.status === "PUBLISHED" ? "accent" : "quiet"}>
                  {opportunity.status}
                </Chip>
                <span className="text-[13px] text-muted">
                  {[
                    opportunity.category?.name,
                    opportunity.activity?.name,
                    opportunity.opportunity_date,
                  ]
                    .filter(Boolean)
                    .join(" · ")}
                </span>
              </div>

              <div className="mt-4 flex flex-wrap gap-2">
                {opportunity.status === "DRAFT" && (
                  <Button
                    variant="outline"
                    className="!px-4 !py-2 text-sm"
                    disabled={busy === opportunity.id}
                    onClick={() => startEdit(opportunity)}
                  >
                    Edit
                  </Button>
                )}
                {TRANSITIONS[opportunity.status].map((transition) => (
                  <Button
                    key={transition.action}
                    variant="outline"
                    className="!px-4 !py-2 text-sm"
                    disabled={busy === opportunity.id}
                    onClick={() => {
                      const verb =
                        transition.action === "publish"
                          ? "publish"
                          : transition.action === "pause"
                            ? "pause"
                            : transition.action === "cancel"
                              ? "cancel"
                              : "expire";
                      if (
                        !window.confirm(
                          `${verb.charAt(0).toUpperCase() + verb.slice(1)} “${opportunity.title}”?`,
                        )
                      ) {
                        return;
                      }
                      void run(
                        opportunity.id,
                        () =>
                          setOpportunityStatus(
                            opportunity.id,
                            transition.action as "publish" | "pause" | "cancel" | "expire",
                          ),
                        `“${opportunity.title}” ${transition.label.toLowerCase()}d.`,
                      );
                    }}
                  >
                    {busy === opportunity.id ? "Working…" : transition.label}
                  </Button>
                ))}
                <Button
                  variant="ghost"
                  className="!px-4 !py-2 text-sm"
                  disabled={busy === opportunity.id}
                  onClick={() => {
                    if (
                      !window.confirm(
                        `Delete “${opportunity.title}”? Its applications and any matches through it go away.`,
                      )
                    ) {
                      return;
                    }
                    void run(
                      opportunity.id,
                      () => deleteOpportunity(opportunity.id),
                      `“${opportunity.title}” deleted.`,
                    );
                  }}
                >
                  Delete
                </Button>
                <Button
                  variant="ghost"
                  className="!px-4 !py-2 text-sm"
                  disabled={busy === opportunity.id}
                  onClick={async () => {
                    setBusy(opportunity.id);
                    try {
                      setApplications(
                        await fetchOpportunityApplications(opportunity.id),
                      );
                    } catch (caught) {
                      setActionError(
                        isApiError(caught)
                          ? caught.message
                          : "Couldn't load applications.",
                      );
                    } finally {
                      setBusy(null);
                    }
                  }}
                >
                  Applications
                </Button>
              </div>

              {applications && (
                <div className="mt-4 border-t border-line pt-4">
                  <p className="type-meta text-muted">Applications</p>
                  {applications.length === 0 ? (
                    <p className="mt-2 text-sm text-muted">Nobody has applied yet.</p>
                  ) : (
                    <ul className="mt-2 space-y-1 text-sm">
                      {applications.map((application) => (
                        <li key={application.id} className="flex items-center gap-2">
                          <span>
                            {application.first_name ?? application.profile_id}
                          </span>
                          <Chip>{application.status}</Chip>
                        </li>
                      ))}
                    </ul>
                  )}
                </div>
              )}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}