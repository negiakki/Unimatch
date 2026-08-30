"use client";

import Image from "next/image";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useState } from "react";

import {
  fetchConversations,
  MessagingApiError,
  type ConversationEntry,
} from "@/lib/api/messaging";
import type { DiscoveryCandidate } from "@/lib/api/discovery";

/**
 * /messages — the signed-in user's conversations (one per active match),
 * newest first. Each row shows the matched profile (the same client-safe
 * shape as the matches list) and the caller's unread count; opening a row
 * goes to the conversation view.
 */

const FOCUS_RING =
  "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent focus-visible:ring-offset-2 focus-visible:ring-offset-background";

function errorMessageFor(error: unknown): string {
  if (error instanceof MessagingApiError) {
    return error.message;
  }
  return "Something went wrong. Please try again.";
}

function displayablePhoto(candidate: DiscoveryCandidate) {
  return candidate.photos.find((photo) => photo.url)?.url ?? null;
}

function ConversationRow({ conversation }: { conversation: ConversationEntry }) {
  const profile = conversation.profile;
  const firstName = profile.first_name ?? "Student";
  const photoUrl = displayablePhoto(profile);
  const universityPlace = [profile.university.name, profile.university.city]
    .filter(Boolean)
    .join(" · ");

  return (
    <Link
      href={`/messages/${conversation.id}`}
      className={`flex items-center gap-4 rounded-card border border-line bg-surface p-4 shadow-card transition-transform active:scale-[0.99] ${FOCUS_RING}`}
    >
      <span className="relative size-14 shrink-0 overflow-hidden rounded-full bg-accent/10">
        {photoUrl ? (
          <Image
            src={photoUrl}
            alt=""
            fill
            unoptimized
            sizes="56px"
            className="object-cover"
          />
        ) : (
          <span
            aria-hidden
            className="grid size-full place-items-center text-xl font-bold text-accent"
          >
            {firstName.charAt(0).toUpperCase()}
          </span>
        )}
      </span>
      <span className="min-w-0 flex-1">
        <span className="flex items-center gap-2">
          <span className="truncate text-[15px] font-bold tracking-tight text-ink">
            {firstName}
          </span>
          {profile.age !== null && (
            <span className="shrink-0 text-sm text-muted">{profile.age}</span>
          )}
        </span>
        {universityPlace && (
          <span className="mt-0.5 block truncate text-sm text-muted">
            {universityPlace}
          </span>
        )}
      </span>
      {conversation.unread_count > 0 && (
        <span className="grid min-w-6 shrink-0 place-items-center rounded-full bg-accent px-1.5 py-0.5 text-xs font-bold text-white">
          {conversation.unread_count > 99 ? "99+" : conversation.unread_count}
        </span>
      )}
    </Link>
  );
}

export default function MessagesPage() {
  const router = useRouter();
  const [phase, setPhase] = useState<"loading" | "ready" | "error">("loading");
  const [conversations, setConversations] = useState<ConversationEntry[]>([]);
  const [error, setError] = useState<MessagingApiError | null>(null);

  const load = useCallback(async () => {
    const page = await fetchConversations();
    setConversations(page.conversations);
  }, []);

  useEffect(() => {
    void (async () => {
      try {
        await load();
        setPhase("ready");
      } catch (caught) {
        if (
          caught instanceof MessagingApiError &&
          caught.code === "unauthorized"
        ) {
          router.replace("/login");
          return;
        }
        console.error("Failed to load conversations:", caught);
        setError(caught instanceof MessagingApiError ? caught : null);
        setPhase("error");
      }
    })();
  }, [load, router]);

  return (
    <main className="mx-auto w-full max-w-lg px-5 pb-16">
      <section className="pt-10">
        <div className="flex items-center justify-between">
          <h1 className="text-3xl font-bold tracking-tight">Messages</h1>
          <Link
            href="/matches"
            className={`rounded-xl border border-line bg-surface px-4 py-2 text-sm font-semibold text-ink shadow-card transition-transform active:scale-[0.98] ${FOCUS_RING}`}
          >
            Matches
          </Link>
        </div>

        {phase === "loading" && (
          <div className="mt-8 space-y-4" aria-busy="true" aria-live="polite">
            <span className="sr-only">Loading your conversations</span>
            {[0, 1, 2].map((index) => (
              <div key={index} className="h-[88px] animate-pulse rounded-card bg-line" />
            ))}
          </div>
        )}

        {phase === "error" && (
          <div className="mt-8 text-center">
            <p role="alert" className="text-[15px] leading-relaxed text-muted">
              {errorMessageFor(error)}
            </p>
            <button
              type="button"
              onClick={() => {
                setPhase("loading");
                setError(null);
                void load()
                  .then(() => setPhase("ready"))
                  .catch((caught: unknown) => {
                    console.error("Failed to load conversations:", caught);
                    setError(
                      caught instanceof MessagingApiError ? caught : null,
                    );
                    setPhase("error");
                  });
              }}
              className={`mt-6 w-full rounded-2xl border border-line bg-surface py-3.5 font-semibold text-ink shadow-card transition-transform active:scale-[0.98] ${FOCUS_RING}`}
            >
              Try again
            </button>
          </div>
        )}

        {phase === "ready" && conversations.length === 0 && (
          <div className="mt-16 text-center">
            <h2 className="text-2xl font-bold tracking-tight">
              No conversations yet
            </h2>
            <p className="mx-auto mt-3 max-w-sm text-[15px] leading-relaxed text-muted">
              Message one of your matches to start a conversation.
            </p>
            <Link
              href="/matches"
              className={`mt-8 inline-block w-full rounded-2xl bg-accent py-3.5 font-semibold text-white shadow-card transition-transform active:scale-[0.98] ${FOCUS_RING}`}
            >
              View matches
            </Link>
          </div>
        )}

        {phase === "ready" && conversations.length > 0 && (
          <div className="mt-8 space-y-4">
            {conversations.map((conversation) => (
              <ConversationRow
                key={conversation.id}
                conversation={conversation}
              />
            ))}
          </div>
        )}
      </section>
    </main>
  );
}
