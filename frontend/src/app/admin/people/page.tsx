"use client";

import { useCallback, useState } from "react";

import {
  blockUser,
  fetchUser,
  searchUsers,
  suspendUser,
  unblockUser,
  unsuspendUser,
  type AdminUser,
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
 * User directory and account moderation. Search is a live query against
 * `GET /admin/users?q=`; the detail panel is the same record from
 * `GET /admin/users/{id}` with account status.
 *
 * Moderation acts only through the endpoints that already exist: suspend
 * (timed), block (indefinite), lift suspension, lift block. There is no
 * delete-user and no data export — the admin surface deliberately cannot
 * remove an account or read private verification documents.
 *
 * KNOWN LIMITATION: `GET /admin/users` caps at 50 rows (backend `limit` is
 * 1..50, default 50) and returns no cursor or total, so the directory silently
 * truncates past 50 matching students and this page cannot page through them.
 * Narrowing the search query is the only way to reach a specific profile today.
 * Adding pagination needs a backend contract change first — an explicit `limit`
 * plus a stable cursor — so it is deliberately out of scope here.
 */

function dateLabel(iso: string | null): string {
  if (!iso) return "—";
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "—";
  return date.toLocaleDateString(undefined, { dateStyle: "medium" });
}

export default function AdminPeoplePage() {
  const [query, setQuery] = useState("");
  const [search, setSearch] = useState("");
  const [users, setUsers] = useState<AdminUser[]>([]);
  const [selected, setSelected] = useState<AdminUser | null>(null);
  const [detailBusy, setDetailBusy] = useState(false);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [reason, setReason] = useState("");
  const [timed, setTimed] = useState(true);
  const [suspendUntil, setSuspendUntil] = useState("");

  const load = useCallback(async () => {
    setUsers(await searchUsers(search));
  }, [search]);

  const { phase, error, errorTitle, fatal, refresh } = useAdminLoad(load, [search]);

  const flash = useCallback((message: string) => {
    setNotice(message);
    window.setTimeout(() => setNotice(null), 6000);
  }, []);

  async function openDetail(profileId: string) {
    setDetailBusy(true);
    setActionError(null);
    try {
      setSelected(await fetchUser(profileId));
    } catch (caught) {
      setActionError(
        isApiError(caught) ? caught.message : "Couldn't load that user.",
      );
    } finally {
      setDetailBusy(false);
    }
  }

  async function act(action: () => Promise<AdminUser>, message: string) {
    if (!selected) return;
    setBusy(true);
    setActionError(null);
    try {
      const updated = await action();
      setSelected(updated);
      await load();
      flash(message);
    } catch (caught) {
      setActionError(
        isApiError(caught) ? caught.message : "That action couldn't be completed.",
      );
    } finally {
      setBusy(false);
    }
  }

  async function applyModeration(kind: "suspend" | "block") {
    if (!selected) return;
    if (!reason.trim()) {
      setActionError("Enter a reason — it is recorded on the account.");
      return;
    }
    const payload = {
      reason: reason.trim(),
      suspended_until:
        kind === "suspend" && timed && suspendUntil
          ? new Date(`${suspendUntil}T23:59:59Z`).toISOString()
          : null,
    };
    if (kind === "block") {
      await act(
        () => blockUser(selected.profile_id, { reason: payload.reason }),
        "Account blocked indefinitely.",
      );
    } else {
      await act(
        () => suspendUser(selected.profile_id, payload),
        timed && suspendUntil ? "Account suspended." : "Account suspended indefinitely.",
      );
    }
    setReason("");
  }

  return (
    <div className="mx-auto w-full max-w-5xl">
      <header className="border-b border-line pb-5">
        <Label>People</Label>
        <h1 className="type-display mt-3 text-[clamp(2rem,6vw,3rem)]">
          User directory
        </h1>
        <p className="mt-3 max-w-2xl text-[15px] leading-relaxed text-muted">
          Search students, review account status, and apply moderation. Only
          admin-safe profile fields are exposed.
        </p>
      </header>

      <form
        className="mt-6 flex flex-wrap gap-3"
        onSubmit={(event) => {
          event.preventDefault();
          setSearch(query.trim());
        }}
      >
        <label htmlFor="admin-user-search" className="sr-only">
          Search users by first name
        </label>
        <input
          id="admin-user-search"
          type="search"
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          placeholder="Search by first name"
          className="min-w-0 flex-1 rounded-full border border-line bg-surface px-5 py-3 text-[15px] placeholder:text-muted/60 focus:border-accent"
        />
        <Button type="submit" variant="outline">
          Search
        </Button>
        {search && (
          <Button
            type="button"
            variant="ghost"
            onClick={() => {
              setQuery("");
              setSearch("");
            }}
          >
            Clear
          </Button>
        )}
      </form>

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
          <span className="sr-only">Loading users</span>
          {Array.from({ length: 4 }, (_, index) => (
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
        <div className="mt-8 grid gap-6 lg:grid-cols-2">
          <div>
            {users.length === 0 ? (
              <EmptyState
                title="No users found"
                body={
                  search
                    ? `Nothing matched “${search}”.`
                    : "No profiles yet."
                }
              />
            ) : (
              <ul className="space-y-3">
                {users.map((user) => (
                  <li key={user.profile_id}>
                    <button
                      type="button"
                      onClick={() => void openDetail(user.profile_id)}
                      aria-busy={detailBusy && selected?.profile_id === user.profile_id}
                      className={cx(
                        "w-full rounded-2xl border border-line bg-surface p-4 text-left transition-colors hover:border-line-strong",
                        selected?.profile_id === user.profile_id && "border-accent",
                      )}
                    >
                      <div className="flex flex-wrap items-center gap-2">
                        <span className="font-semibold">
                          {user.first_name ?? "Unnamed student"}
                        </span>
                        {user.account.suspended && <Chip tone="accent">Suspended</Chip>}
                        {user.verification.status === "VERIFIED" && (
                          <Chip tone="accent">Verified</Chip>
                        )}
                        {user.verification.status === "PENDING" && (
                          <Chip>In review</Chip>
                        )}
                        {user.verification.status === "REJECTED" && (
                          <Chip>Rejected</Chip>
                        )}
                      </div>
                      <p className="mt-1 text-[13px] text-muted">
                        {[
                          user.course,
                          user.academic_year ? `Year ${user.academic_year}` : null,
                          user.university_label,
                        ]
                          .filter(Boolean)
                          .join(" · ")}
                      </p>
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </div>

          <div>
            {selected ? (
              <section className="rounded-2xl border border-line bg-surface p-5">
                <h2 className="text-lg font-bold tracking-tight">
                  {selected.first_name ?? "Unnamed student"}
                </h2>
                <p className="mt-1 text-sm text-muted">{selected.profile_id}</p>

                <dl className="mt-4 space-y-2 text-sm">
                  <div>
                    <dt className="type-meta text-muted">University</dt>
                    <dd className="mt-0.5">
                      {selected.university_label}
                      {selected.custom_university_name && (
                        <span className="ml-2 inline-flex rounded-full border border-line px-2 py-0.5 text-xs text-muted">
                          Student entered this
                        </span>
                      )}
                    </dd>
                  </div>
                  <div>
                    <dt className="type-meta text-muted">Course</dt>
                    <dd className="mt-0.5">{selected.course ?? "—"}</dd>
                  </div>
                  <div>
                    <dt className="type-meta text-muted">Joined</dt>
                    <dd className="mt-0.5">{dateLabel(selected.created_at)}</dd>
                  </div>
                  <div>
                    <dt className="type-meta text-muted">Verification</dt>
                    <dd className="mt-0.5">
                      {selected.verification.status ?? "Never submitted"}
                      {selected.verification.submitted_at
                        ? ` · ${dateLabel(selected.verification.submitted_at)}`
                        : ""}
                    </dd>
                  </div>
                  <div>
                    <dt className="type-meta text-muted">Account</dt>
                    <dd className="mt-0.5">
                      {selected.account.suspended ? "Suspended" : "Active"}
                      {selected.account.suspended && selected.account.suspension_reason
                        ? ` — ${selected.account.suspension_reason}`
                        : ""}
                      {selected.account.suspended && selected.account.suspended_until
                        ? ` (until ${dateLabel(selected.account.suspended_until)})`
                        : ""}
                    </dd>
                  </div>
                </dl>

                {selected.account.suspended ? (
                  <div className="mt-5 flex flex-wrap gap-2">
                    <Button
                      variant="outline"
                      disabled={busy}
                      onClick={() =>
                        void act(
                          () => unsuspendUser(selected.profile_id),
                          "Suspension lifted.",
                        )
                      }
                    >
                      {busy ? "Working…" : "Lift suspension"}
                    </Button>
                    <Button
                      variant="ghost"
                      disabled={busy}
                      onClick={() =>
                        void act(
                          () => unblockUser(selected.profile_id),
                          "Block lifted.",
                        )
                      }
                    >
                      Lift block
                    </Button>
                  </div>
                ) : (
                  <div className="mt-5 border-t border-line pt-5">
                    <label
                      htmlFor="moderation-reason"
                      className="text-sm font-semibold"
                    >
                      Reason
                    </label>
                    <input
                      id="moderation-reason"
                      value={reason}
                      onChange={(event) => setReason(event.target.value)}
                      maxLength={500}
                      placeholder="Recorded on the account"
                      className="mt-1.5 w-full rounded-2xl border border-line bg-background px-4 py-3 text-[15px] placeholder:text-muted/60 focus:border-accent"
                    />

                    <div className="mt-3 flex flex-wrap items-center gap-3">
                      <label className="flex items-center gap-2 text-sm">
                        <input
                          type="checkbox"
                          checked={timed}
                          onChange={(event) => setTimed(event.target.checked)}
                          className="size-4"
                        />
                        Timed
                      </label>
                      {timed && (
                        <>
                          <label htmlFor="suspend-until" className="sr-only">
                            Suspend until
                          </label>
                          <input
                            id="suspend-until"
                            type="date"
                            value={suspendUntil}
                            onChange={(event) => setSuspendUntil(event.target.value)}
                            className="rounded-xl border border-line bg-background px-3 py-2 text-sm"
                          />
                        </>
                      )}
                    </div>

                    <div className="mt-4 flex flex-wrap gap-2">
                      <Button
                        disabled={busy || !reason.trim()}
                        onClick={() => void applyModeration("suspend")}
                      >
                        {busy ? "Working…" : "Suspend"}
                      </Button>
                      <Button
                        variant="outline"
                        disabled={busy || !reason.trim()}
                        onClick={() => void applyModeration("block")}
                      >
                        Block indefinitely
                      </Button>
                    </div>
                    <p className="mt-3 text-xs text-muted">
                      A suspended account becomes read-only across the whole
                      platform. Blocking is indefinite.
                    </p>
                  </div>
                )}
              </section>
            ) : (
              <EmptyState
                title="Select a person"
                body="Choose someone from the directory to see their account status and moderation actions."
              />
            )}
          </div>
        </div>
      )}
    </div>
  );
}