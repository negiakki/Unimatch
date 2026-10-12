"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useState } from "react";

import { AppNav, TAB_BAR_SPACE } from "@/components/app-nav";
import { SignOutButton } from "@/components/sign-out-button";
import {
  Avatar,
  ButtonLink,
  EmptyState,
  ErrorState,
  Label,
  LoadingBlock,
  SuspendedState,
} from "@/components/ui";
import { primaryPhotoUrl } from "@/lib/api/discovery";
import { isSuspended, isUnauthorized } from "@/lib/api/http";
import {
  CHAT_LIFETIME_HOURS,
  fetchConversations,
  type Conversation,
} from "@/lib/api/messaging";
import { formatEventDate } from "@/lib/format";

/**
 * /messages — one conversation per active match, each carrying the
 * OPPORTUNITY it belongs to. The reason for talking is always visible, and the
 * temporary nature of the chat is stated once here rather than nagging in every
 * thread.
 *
 * The backend already drops conversations after 24 hours without a message, so
 * this list only ever shows live ones.
 */

export default function MessagesPage() {
  const router = useRouter();
  const [phase, setPhase] = useState<"loading" | "ready" | "error" | "suspended">(
    "loading",
  );
  const [conversations, setConversations] = useState<Conversation[]>([]);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setConversations(await fetchConversations());
  }, []);

  useEffect(() => {
    void (async () => {
      try {
        await load();
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
        setError(
          caught instanceof Error
            ? caught.message
            : "Something went wrong. Please try again.",
        );
        setPhase("error");
      }
    })();
  }, [load, router]);

  function retry() {
    setPhase("loading");
    setError(null);
    void load()
      .then(() => setPhase("ready"))
      .catch((caught: unknown) => {
        setError(
          caught instanceof Error
            ? caught.message
            : "Something went wrong. Please try again.",
        );
        setPhase("error");
      });
  }

  return (
    <>
      <AppNav />
      <main className={`mx-auto w-full max-w-6xl px-5 sm:px-8 ${TAB_BAR_SPACE}`}>
        <section
          data-category="social"
          className="animate-rise -mx-5 px-5 pt-10 pb-8 sm:-mx-8 sm:px-8"
        >
          <Label>Chats</Label>
          <h1 className="type-display mt-4 text-display">Talks that start somewhere</h1>
          <p className="mt-4 max-w-lg text-[15px] leading-relaxed text-muted">
            Each chat belongs to the opportunity you matched through, and stays
            open for {CHAT_LIFETIME_HOURS} hours after your last message.
          </p>
        </section>

        {phase === "suspended" && (
          <SuspendedState
            message="Your account has been suspended from participating in UniMatch."
            action={<SignOutButton />}
          />
        )}

        {phase === "loading" && <LoadingBlock label="Loading your chats" rows={4} />}

        {phase === "error" && (
          <ErrorState
            message={error ?? "We couldn't load your chats."}
            onRetry={retry}
          />
        )}

        {phase === "ready" && conversations.length === 0 && (
          <EmptyState
            title="No chats yet"
            body="When you and another student both want a partner for the same opportunity, you can start talking."
            action={<ButtonLink href="/explore">Find an opportunity</ButtonLink>}
          />
        )}

        {phase === "ready" && conversations.length > 0 && (
          <ul className="divide-y divide-line border-t border-line">
            {conversations.map((conversation) => (
              <li key={conversation.id}>
                <ConversationRow conversation={conversation} />
              </li>
            ))}
          </ul>
        )}
      </main>
    </>
  );
}

function ConversationRow({ conversation }: { conversation: Conversation }) {
  const name = conversation.profile.first_name ?? "Student";
  const reason = conversation.opportunity?.title;
  const place = [conversation.opportunity?.opportunity_date, conversation.opportunity?.location]
    .filter(Boolean)
    .map((value, index) => (index === 0 ? formatEventDate(value) : value))
    .join(" · ");

  return (
    <Link
      href={`/messages/${conversation.id}`}
      data-category="social"
      className="group flex items-center gap-4 py-5 transition-colors hover:bg-accent/5 sm:gap-5"
    >
      <Avatar
        src={primaryPhotoUrl(conversation.profile)}
        name={conversation.profile.first_name}
        size="md"
      />
      <span className="min-w-0 flex-1">
        {/* Context first: why are these two talking? */}
        <span className="type-meta block truncate text-accent">
          {reason ? `Matched for ${reason}` : "Matched"}
        </span>
        <span className="mt-1 block truncate text-lg font-bold tracking-tight">
          {name}
        </span>
        <span className="mt-0.5 block truncate text-sm text-muted">{place}</span>
      </span>
      {conversation.unread_count > 0 && (
        <span className="grid size-7 shrink-0 place-items-center rounded-full bg-accent text-xs font-bold text-accent-ink">
          {conversation.unread_count > 9 ? "9+" : conversation.unread_count}
        </span>
      )}
      <span
        aria-hidden
        className="shrink-0 text-muted transition-transform duration-300 group-hover:translate-x-1 group-hover:text-accent"
      >
        →
      </span>
    </Link>
  );
}