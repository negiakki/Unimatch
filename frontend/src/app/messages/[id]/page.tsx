"use client";

import Image from "next/image";
import Link from "next/link";
import { useParams, useRouter } from "next/navigation";
import { useCallback, useEffect, useRef, useState } from "react";

import {
  fetchConversations,
  fetchMessages,
  markConversationRead,
  MAX_MESSAGE_LENGTH,
  MessagingApiError,
  sendMessage,
  type ChatMessage,
  type ConversationEntry,
} from "@/lib/api/messaging";

/**
 * /messages/[id] — one conversation (a match id). Shows the newest page of
 * history in chronological order with a "load earlier" control, and polls
 * the first page (~every 5s) while the conversation is open, marking it read
 * so the unread badge stays accurate. Sending is participant-only and
 * immutable once delivered; an unmatched conversation surfaces as gone.
 */

const POLL_INTERVAL_MS = 5000;
const PAGE_SIZE = 30;
const FOCUS_RING =
  "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent focus-visible:ring-offset-2 focus-visible:ring-offset-background";

function displayablePhoto(conversation: ConversationEntry) {
  return conversation.profile.photos.find((photo) => photo.url)?.url ?? null;
}

function timeLabel(iso: string | null): string {
  if (!iso) {
    return "";
  }
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) {
    return "";
  }
  return date.toLocaleTimeString(undefined, {
    hour: "numeric",
    minute: "2-digit",
  });
}

export default function ConversationPage() {
  const router = useRouter();
  const params = useParams<{ id: string }>();
  const conversationId = typeof params?.id === "string" ? params.id : "";

  const [phase, setPhase] = useState<"loading" | "ready" | "gone" | "error">(
    "loading",
  );
  const [conversation, setConversation] = useState<ConversationEntry | null>(
    null,
  );
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [olderCursor, setOlderCursor] = useState<string | null>(null);
  const [loadingOlder, setLoadingOlder] = useState(false);
  const [draft, setDraft] = useState("");
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const bottomRef = useRef<HTMLDivElement | null>(null);

  const mergeMessages = useCallback((incoming: ChatMessage[]) => {
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

  // Initial load: newest page of history + the partner profile from the
  // conversations list + an initial read-marker.
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
          conversations.conversations.find(
            (candidate) => candidate.id === conversationId,
          ) ?? null;
        if (!entry) {
          setPhase("gone");
          return;
        }
        setConversation(entry);
        mergeMessages(page.messages);
        setOlderCursor(page.next_cursor);
        await markConversationRead(conversationId);
        setPhase("ready");
      } catch (caught) {
        if (
          caught instanceof MessagingApiError &&
          caught.code === "unauthorized"
        ) {
          router.replace("/login");
          return;
        }
        if (
          caught instanceof MessagingApiError &&
          caught.code === "not_found"
        ) {
          setPhase("gone");
          return;
        }
        console.error("Failed to load conversation:", caught);
        setError(caught instanceof MessagingApiError ? caught.message : null);
        setPhase("error");
      }
    })();
  }, [conversationId, mergeMessages, router]);

  // Poll the open conversation (~every 5s): newest page + read marker.
  // Background tabs skip polling; poll failures never kick the user out.
  useEffect(() => {
    if (phase !== "ready") {
      return;
    }
    const poll = async () => {
      if (document.hidden) {
        return;
      }
      try {
        const page = await fetchMessages(conversationId, { limit: PAGE_SIZE });
        mergeMessages(page.messages);
        await markConversationRead(conversationId);
      } catch (caught) {
        console.error("Conversation poll failed:", caught);
      }
    };
    const interval = setInterval(() => void poll(), POLL_INTERVAL_MS);
    return () => clearInterval(interval);
  }, [conversationId, mergeMessages, phase]);

  // Keep the newest message in view.
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
      mergeMessages(page.messages);
      setOlderCursor(page.next_cursor);
    } catch (caught) {
      console.error("Failed to load earlier messages:", caught);
      setError(caught instanceof MessagingApiError ? caught.message : null);
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
      const message = await sendMessage(conversationId, body);
      setDraft("");
      mergeMessages([message]);
    } catch (caught) {
      if (
        caught instanceof MessagingApiError &&
        caught.code === "unauthorized"
      ) {
        router.replace("/login");
        return;
      }
      setError(caught instanceof MessagingApiError ? caught.message : null);
    } finally {
      setSending(false);
    }
  }

  const firstName = conversation?.profile.first_name ?? "Student";
  const photoUrl = conversation ? displayablePhoto(conversation) : null;

  return (
    <main className="mx-auto flex h-dvh w-full max-w-lg flex-col px-5">
      <header className="flex items-center gap-3 border-b border-line py-4">
        <Link
          href="/messages"
          aria-label="Back to conversations"
          className={`grid size-10 shrink-0 place-items-center rounded-full border border-line bg-surface text-lg text-ink shadow-card ${FOCUS_RING}`}
        >
          <span aria-hidden>←</span>
        </Link>
        <span className="relative size-10 shrink-0 overflow-hidden rounded-full bg-accent/10">
          {photoUrl ? (
            <Image
              src={photoUrl}
              alt=""
              fill
              unoptimized
              sizes="40px"
              className="object-cover"
            />
          ) : (
            <span
              aria-hidden
              className="grid size-full place-items-center text-base font-bold text-accent"
            >
              {firstName.charAt(0).toUpperCase()}
            </span>
          )}
        </span>
        <h1 className="min-w-0 flex-1 truncate text-lg font-bold tracking-tight">
          {phase === "ready" ? firstName : "Conversation"}
        </h1>
      </header>

      {phase === "loading" && (
        <div className="flex-1 space-y-3 py-6" aria-busy="true" aria-live="polite">
          <span className="sr-only">Loading messages</span>
          {[0, 1, 2].map((index) => (
            <div
              key={index}
              className={`h-12 w-2/3 animate-pulse rounded-2xl bg-line ${
                index % 2 === 1 ? "ml-auto" : ""
              }`}
            />
          ))}
        </div>
      )}

      {phase === "gone" && (
        <div className="flex flex-1 flex-col items-center justify-center text-center">
          <h2 className="text-2xl font-bold tracking-tight">
            Conversation unavailable
          </h2>
          <p className="mx-auto mt-3 max-w-sm text-[15px] leading-relaxed text-muted">
            This conversation is no longer available.
          </p>
          <Link
            href="/messages"
            className={`mt-8 inline-block w-full rounded-2xl bg-accent py-3.5 font-semibold text-white shadow-card transition-transform active:scale-[0.98] ${FOCUS_RING}`}
          >
            Back to messages
          </Link>
        </div>
      )}

      {phase === "error" && (
        <div className="flex flex-1 flex-col items-center justify-center text-center">
          <p role="alert" className="text-[15px] leading-relaxed text-muted">
            {error ?? "Something went wrong. Please try again."}
          </p>
          <button
            type="button"
            onClick={() => window.location.reload()}
            className={`mt-6 w-full rounded-2xl border border-line bg-surface py-3.5 font-semibold text-ink shadow-card transition-transform active:scale-[0.98] ${FOCUS_RING}`}
          >
            Try again
          </button>
        </div>
      )}

      {phase === "ready" && (
        <>
          <div className="flex-1 space-y-3 overflow-y-auto py-6">
            {olderCursor && (
              <div className="flex justify-center">
                <button
                  type="button"
                  onClick={() => void loadOlder()}
                  disabled={loadingOlder}
                  className={`rounded-full border border-line bg-surface px-4 py-2 text-sm font-semibold text-muted shadow-card transition-transform active:scale-[0.98] disabled:opacity-40 ${FOCUS_RING}`}
                >
                  {loadingOlder ? "Loading…" : "Load earlier messages"}
                </button>
              </div>
            )}

            {messages.length === 0 && (
              <p className="pt-8 text-center text-[15px] text-muted">
                Say hi to {firstName} — this is the start of your conversation.
              </p>
            )}

            {messages.map((message) => (
              <div
                key={message.id}
                className={`flex flex-col ${
                  message.is_own ? "items-end" : "items-start"
                }`}
              >
                <p
                  className={`max-w-[80%] whitespace-pre-wrap break-words rounded-2xl px-4 py-2.5 text-[15px] leading-relaxed ${
                    message.is_own
                      ? "bg-accent text-white"
                      : "border border-line bg-surface text-ink"
                  }`}
                >
                  {message.body}
                </p>
                <span className="mt-1 px-1 text-xs text-muted">
                  {timeLabel(message.created_at)}
                </span>
              </div>
            ))}
            <div ref={bottomRef} />
          </div>

          {error && (
            <p role="alert" className="pb-2 text-sm text-muted">
              {error}
            </p>
          )}

          <form
            className="flex items-end gap-2 border-t border-line py-4"
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
              aria-label={`Message ${firstName}`}
              placeholder={`Message ${firstName}`}
              className="min-h-11 flex-1 resize-none rounded-2xl border border-line bg-surface px-4 py-2.5 text-[15px] text-ink placeholder:text-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent"
            />
            <button
              type="submit"
              disabled={sending || draft.trim().length === 0}
              aria-busy={sending}
              className={`h-11 shrink-0 rounded-2xl bg-accent px-5 font-semibold text-white shadow-card transition-transform active:scale-[0.98] disabled:pointer-events-none disabled:opacity-40 ${FOCUS_RING}`}
            >
              {sending ? "Sending…" : "Send"}
            </button>
          </form>
        </>
      )}
    </main>
  );
}
