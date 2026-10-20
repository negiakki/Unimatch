"use client";

import Link from "next/link";
import { useParams, useRouter } from "next/navigation";
import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type FormEvent,
} from "react";

import { AppNav } from "@/components/app-nav";
import {
  Avatar,
  Button,
  Label,
  SuspendedState,
} from "@/components/ui";
import { SignOutButton } from "@/components/sign-out-button";
import { primaryPhotoUrl } from "@/lib/api/discovery";
import { isSuspended, isUnauthorized } from "@/lib/api/http";
import {
  CHAT_LIFETIME_HOURS,
  fetchConversations,
  fetchMessages,
  markConversationRead,
  MAX_MESSAGE_LENGTH,
  sendMessage,
  type ChatMessage,
  type Conversation,
} from "@/lib/api/messaging";
import {
  blockUser,
  MAX_REPORT_DETAIL_LENGTH,
  REPORT_REASON_OPTIONS,
  reportUser,
  type ReportReason,
} from "@/lib/api/safety";
import { categoryKey, cx, formatEventDate, formatMessageTime } from "@/lib/format";

/**
 * /messages/[id] — one conversation (its id IS the match id).
 *
 * The header keeps the opportunity visible, so the thread never reads as an
 * open-ended social inbox. Chats are temporary: the backend expires a
 * conversation 24 hours after the last message, and the fact is stated once in
 * the header rather than repeated.
 *
 * Polling (not realtime subscriptions) refreshes the open thread; blocked or
 * expired conversations surface as gone. Safety actions live here: report is an
 * admin-reviewed receipt with no automatic consequence, block silently hides
 * the pair in both directions.
 */

const POLL_INTERVAL_MS = 5000;
const PAGE_SIZE = 30;

type Phase = "loading" | "ready" | "gone" | "error" | "suspended";

export default function ConversationPage() {
  const router = useRouter();
  const params = useParams<{ id: string }>();
  const conversationId = typeof params?.id === "string" ? params.id : "";

  const [phase, setPhase] = useState<Phase>("loading");
  const [conversation, setConversation] = useState<Conversation | null>(null);
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [olderCursor, setOlderCursor] = useState<string | null>(null);
  const [loadingOlder, setLoadingOlder] = useState(false);
  const [draft, setDraft] = useState("");
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const bottomRef = useRef<HTMLDivElement | null>(null);

  const [blockBusy, setBlockBusy] = useState(false);
  const [reportOpen, setReportOpen] = useState(false);
  const [reportDone, setReportDone] = useState(false);
  const [reportBusy, setReportBusy] = useState(false);
  const [reportReason, setReportReason] = useState<ReportReason>("harassment");
  const [reportDetail, setReportDetail] = useState("");
  const [safetyError, setSafetyError] = useState<string | null>(null);

  const merge = useCallback((incoming: ChatMessage[]) => {
    setMessages((current) => {
      const byId = new Map(current.map((message) => [message.id, message]));
      for (const message of incoming) {
        byId.set(message.id, message);
      }
      return [...byId.values()].sort((a, b) => {
        const byTime = (a.created_at ?? "").localeCompare(b.created_at ?? "");
        return byTime !== 0 ? byTime : a.id.localeCompare(b.id);
      });
    });
  }, []);

  // Initial load: newest page, the partner + opportunity context, read marker.
  useEffect(() => {
    if (!conversationId) {
      return;
    }
    void (async () => {
      try {
        const [page, conversations] = await Promise.all([
          fetchMessages(conversationId, { limit: PAGE_SIZE }),
          fetchConversations(),
        ]);
        const entry =
          conversations.find((item) => item.id === conversationId) ?? null;
        if (!entry) {
          setPhase("gone");
          return;
        }
        setConversation(entry);
        merge(page.messages);
        setOlderCursor(page.next_cursor);
        await markConversationRead(conversationId);
        setPhase("ready");
      } catch (caught) {
        if (isUnauthorized(caught)) {
          router.replace("/login");
          return;
        }
        if (isSuspended(caught)) {
          setPhase("suspended");
          return;
        }
        if (
          caught instanceof Error &&
          "code" in caught &&
          (caught as { code: string }).code === "not_found"
        ) {
          setPhase("gone");
          return;
        }
        setError(caught instanceof Error ? caught.message : null);
        setPhase("error");
      }
    })();
  }, [conversationId, merge, router]);

  // Poll the open thread; hidden tabs skip it and failures never kick the user.
  useEffect(() => {
    if (phase !== "ready") {
      return;
    }
    const interval = setInterval(() => {
      if (document.hidden) {
        return;
      }
      void fetchMessages(conversationId, { limit: PAGE_SIZE })
        .then(async (page) => {
          merge(page.messages);
          await markConversationRead(conversationId);
        })
        .catch((caught: unknown) => {
          if (isSuspended(caught)) {
            setPhase("suspended");
          }
        });
    }, POLL_INTERVAL_MS);
    return () => clearInterval(interval);
  }, [conversationId, merge, phase]);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ block: "end" });
  }, [messages.length]);

  async function loadOlder() {
    if (!olderCursor || loadingOlder) {
      return;
    }
    setLoadingOlder(true);
    try {
      const page = await fetchMessages(conversationId, {
        cursor: olderCursor,
        limit: PAGE_SIZE,
      });
      merge(page.messages);
      setOlderCursor(page.next_cursor);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : null);
    } finally {
      setLoadingOlder(false);
    }
  }

  async function handleSend() {
    const body = draft.trim();
    if (!body || sending || body.length > MAX_MESSAGE_LENGTH) {
      return;
    }
    setSending(true);
    setError(null);
    try {
      merge([await sendMessage(conversationId, body)]);
      setDraft("");
    } catch (caught) {
      if (isUnauthorized(caught)) {
        router.replace("/login");
        return;
      }
      setError(caught instanceof Error ? caught.message : null);
    } finally {
      setSending(false);
    }
  }

  async function handleBlock() {
    if (!conversation || blockBusy) {
      return;
    }
    const name = conversation.profile.first_name ?? "this person";
    if (!window.confirm(`Block ${name}? You won't see each other any more.`)) {
      return;
    }
    setBlockBusy(true);
    setSafetyError(null);
    try {
      await blockUser(conversation.profile.id);
      router.replace("/messages");
    } catch (caught) {
      if (isUnauthorized(caught)) {
        router.replace("/login");
        return;
      }
      setSafetyError(
        caught instanceof Error ? caught.message : "That didn't work. Try again.",
      );
    } finally {
      setBlockBusy(false);
    }
  }

  async function handleReportSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!conversation || reportBusy) {
      return;
    }
    setReportBusy(true);
    setSafetyError(null);
    try {
      await reportUser({
        reported_profile_id: conversation.profile.id,
        reason: reportReason,
        detail: reportDetail.trim() || undefined,
      });
      setReportDone(true);
    } catch (caught) {
      setSafetyError(
        caught instanceof Error ? caught.message : "That didn't work. Try again.",
      );
    } finally {
      setReportBusy(false);
    }
  }

  if (phase === "suspended") {
    return (
      <SuspendedState
        message="Your account has been suspended from participating in UniMatch."
        action={<SignOutButton />}
      />
    );
  }

  const name = conversation?.profile.first_name ?? "Student";
  const reason = conversation?.opportunity?.title ?? null;
  const when = conversation?.opportunity?.opportunity_date
    ? formatEventDate(conversation.opportunity.opportunity_date)
    : "";
  const place = conversation?.opportunity?.location ?? "";

  return (
    <div
      data-category={categoryKey(conversation?.opportunity?.category ?? {})}
      className="flex h-dvh flex-col pb-[calc(var(--app-nav-height)+env(safe-area-inset-bottom))] md:pb-0"
    >
      <AppNav />

      <header className="flex items-center gap-3 border-b border-line px-4 py-3">
        <Link
          href="/messages"
          aria-label="Back to chats"
          className="grid size-10 shrink-0 place-items-center rounded-full border border-line text-ink transition-colors hover:border-ink"
        >
          <span aria-hidden>←</span>
        </Link>

        {conversation && (
          <Avatar
            src={primaryPhotoUrl(conversation.profile)}
            name={conversation.profile.first_name}
            size="sm"
            className="size-10"
          />
        )}

        <div className="min-w-0 flex-1">
          <h1 className="truncate text-[15px] font-bold tracking-tight">
            {phase === "ready" ? name : "Chat"}
          </h1>
          {/* Why this conversation exists, plus the temporary nature. */}
          {reason && (
            <p className="truncate text-[12px] text-muted">
              {reason}
              {when || place ? ` · ${[when, place].filter(Boolean).join(" · ")}` : ""}
              <span className="text-muted/70"> · open {CHAT_LIFETIME_HOURS}h</span>
            </p>
          )}
        </div>

        {phase === "ready" && (
          <div className="flex shrink-0 items-center gap-2">
            {!reportOpen && (
              <button
                type="button"
                onClick={() => {
                  setReportOpen(true);
                  setSafetyError(null);
                }}
                disabled={blockBusy}
                className="rounded-full border border-line px-3 py-1.5 text-[13px] font-semibold text-muted transition-colors hover:border-ink hover:text-ink disabled:opacity-40"
              >
                Report
              </button>
            )}
            <button
              type="button"
              onClick={() => void handleBlock()}
              disabled={blockBusy}
              aria-busy={blockBusy}
              className="rounded-full border border-line px-3 py-1.5 text-[13px] font-semibold text-muted transition-colors hover:border-ink hover:text-ink disabled:opacity-40"
            >
              {blockBusy ? "Blocking…" : "Block"}
            </button>
          </div>
        )}
      </header>

      {phase === "ready" && reportOpen && (
        <section aria-label={`Report ${name}`} className="border-b border-line p-4">
          {reportDone ? (
            <div>
              <p className="text-[15px] leading-relaxed">
                Thanks — our team will review this.
              </p>
              <Button
                variant="outline"
                className="mt-4 px-5 py-2 text-[13px]"
                onClick={() => {
                  setReportOpen(false);
                  setReportDone(false);
                  setReportDetail("");
                }}
              >
                Done
              </Button>
            </div>
          ) : (
            <form onSubmit={(event) => void handleReportSubmit(event)} className="space-y-3">
              <div>
                <label htmlFor="report-reason" className="block text-sm font-semibold">
                  What&apos;s wrong?
                </label>
                <select
                  id="report-reason"
                  value={reportReason}
                  onChange={(event) =>
                    setReportReason(event.target.value as ReportReason)
                  }
                  className="mt-2 w-full rounded-full border border-line bg-surface px-4 py-2.5 text-[15px] text-ink"
                >
                  {REPORT_REASON_OPTIONS.map((option) => (
                    <option key={option.value} value={option.value}>
                      {option.label}
                    </option>
                  ))}
                </select>
              </div>
              <div>
                <label htmlFor="report-detail" className="block text-sm font-semibold">
                  Details <span className="font-normal text-muted">(optional)</span>
                </label>
                <textarea
                  id="report-detail"
                  value={reportDetail}
                  onChange={(event) => setReportDetail(event.target.value)}
                  rows={3}
                  maxLength={MAX_REPORT_DETAIL_LENGTH}
                  placeholder="What happened?"
                  className="mt-2 w-full resize-none border border-line bg-surface px-4 py-2.5 text-[15px] text-ink placeholder:text-muted/70"
                />
              </div>
              {safetyError && (
                <p role="alert" className="text-sm text-danger">
                  {safetyError}
                </p>
              )}
              <div className="flex gap-2">
                <Button type="submit" disabled={reportBusy} className="px-5 py-2.5 text-[13px]">
                  {reportBusy ? "Sending…" : "Send report"}
                </Button>
                <Button
                  type="button"
                  variant="outline"
                  className="px-5 py-2.5 text-[13px]"
                  disabled={reportBusy}
                  onClick={() => {
                    setReportOpen(false);
                    setReportDone(false);
                    setSafetyError(null);
                  }}
                >
                  Cancel
                </Button>
              </div>
            </form>
          )}
        </section>
      )}

      {phase === "loading" && (
        <div className="flex-1 space-y-3 py-6" aria-busy="true" aria-live="polite">
          <span className="sr-only">Loading messages</span>
          {[0, 1, 2].map((index) => (
            <div
              key={index}
              className={cx(
                "h-12 w-2/3 animate-pulse bg-line",
                index % 2 === 1 && "ml-auto",
              )}
            />
          ))}
        </div>
      )}

      {(phase === "gone" || phase === "error") && (
        <div className="flex flex-1 flex-col items-start justify-center px-5">
          <Label>{phase === "gone" ? "Closed" : "Problem"}</Label>
          <h2 className="type-display mt-3 text-title">
            {phase === "gone"
              ? "This chat has closed"
              : "Something went wrong"}
          </h2>
          <p className="mt-3 max-w-sm text-[15px] leading-relaxed text-muted">
            {phase === "gone"
              ? `Chats stay open for ${CHAT_LIFETIME_HOURS} hours after your last message. Your match is still on your matches page.`
              : (error ?? "Please try again in a moment.")}
          </p>
          <Link
            href="/matches"
            className="mt-8 inline-flex items-center rounded-full bg-accent px-6 py-3 text-sm font-semibold text-accent-ink"
          >
            Back to matches
          </Link>
        </div>
      )}

      {phase === "ready" && (
        <>
          <div className="flex-1 space-y-3 overflow-y-auto px-4 py-5">
            {olderCursor && (
              <div className="flex justify-center">
                <Button
                  variant="outline"
                  className="px-4 py-1.5 text-[13px]"
                  disabled={loadingOlder}
                  onClick={() => void loadOlder()}
                >
                  {loadingOlder ? "Loading…" : "Earlier messages"}
                </Button>
              </div>
            )}

            {messages.length === 0 && (
              <p className="pt-8 text-center text-[15px] leading-relaxed text-muted">
                Say hi to {name} — you matched to find a partner for{" "}
                {reason ?? "an opportunity"}.
              </p>
            )}

            {messages.map((message) => (
              <div
                key={message.id}
                className={cx(
                  "animate-fade-in flex flex-col",
                  message.is_own ? "items-end" : "items-start",
                )}
              >
                <p
                  className={cx(
                    "max-w-[82%] whitespace-pre-wrap break-words px-4 py-2.5 text-[15px] leading-relaxed",
                    message.is_own
                      ? "bg-accent text-accent-ink"
                      : "border border-line bg-surface text-ink",
                  )}
                >
                  {message.body}
                </p>
                <span className="mt-1 px-1 text-[11px] text-muted">
                  {formatMessageTime(message.created_at)}
                </span>
              </div>
            ))}
            <div ref={bottomRef} />
          </div>

          {error && (
            <p role="alert" className="px-4 pb-2 text-sm text-danger">
              {error}
            </p>
          )}

          <form
            className="flex items-end gap-2 border-t border-line px-4 py-3"
            onSubmit={(event) => {
              event.preventDefault();
              void handleSend();
            }}
          >
            <textarea
              value={draft}
              onChange={(event) => setDraft(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Enter" && !event.shiftKey) {
                  event.preventDefault();
                  void handleSend();
                }
              }}
              rows={1}
              maxLength={MAX_MESSAGE_LENGTH}
              aria-label={`Message ${name}`}
              placeholder={`Message ${name}`}
              className="min-h-11 flex-1 resize-none border border-line bg-surface px-4 py-2.5 text-[15px] text-ink placeholder:text-muted/70"
            />
            <Button type="submit" disabled={sending || draft.trim().length === 0} className="h-11 px-5">
              {sending ? "…" : "Send"}
            </Button>
          </form>
        </>
      )}
    </div>
  );
}