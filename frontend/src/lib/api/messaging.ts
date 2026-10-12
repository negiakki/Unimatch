/**
 * Conversations & messages.
 *
 * GET  /api/v1/conversations — the caller's conversations (active matches)
 *   with unread counts. Each carries the OPPORTUNITY it belongs to, because
 *   the opportunity is the reason two people are talking.
 * GET  /api/v1/conversations/{id}/messages — history, newest first, keyset
 *   paginated via the opaque `cursor`.
 * POST /api/v1/conversations/{id}/messages — send one text message
 *   (1–2000 characters after trimming; the backend trims).
 * POST /api/v1/conversations/{id}/read — mark the conversation read.
 *
 * A conversation id IS a match id; an unmatched conversation surfaces as
 * `not_found` everywhere. Chats are temporary: the backend drops a
 * conversation after 24 hours without a new message, while the match remains.
 */

import { ApiError, requestJson } from "@/lib/api/http";
import type { Person } from "@/lib/api/discovery";
import type { OpportunityContext } from "@/lib/api/opportunities";

export const MAX_MESSAGE_LENGTH = 2000;

/** Hours a conversation stays open without a new message. */
export const CHAT_LIFETIME_HOURS = 24;

export interface Conversation {
  id: string;
  created_at: string | null;
  unread_count: number;
  profile: Person;
  /** Why these two matched — shown as conversation context. */
  opportunity?: OpportunityContext | null;
}

export interface ChatMessage {
  id: string;
  sender_profile_id: string;
  is_own: boolean;
  body: string;
  created_at: string | null;
}

export interface MessagePage {
  messages: ChatMessage[];
  next_cursor: string | null;
}

const MESSAGES = {
  not_verified: "Verify your student status before messaging.",
  not_found: "This conversation is no longer available.",
  validation: "That message couldn't be sent. Please check it and try again.",
  unavailable: "Messaging is temporarily unavailable. Please try again shortly.",
} as const;

export async function fetchConversations(): Promise<Conversation[]> {
  const page = await requestJson<{ conversations: Conversation[] }>(
    "/api/v1/conversations",
    { method: "GET" },
    MESSAGES,
  );
  return page.conversations ?? [];
}

export async function fetchMessages(
  conversationId: string,
  options?: { cursor?: string | null; limit?: number },
): Promise<MessagePage> {
  const params = new URLSearchParams();
  if (options?.cursor) {
    params.set("cursor", options.cursor);
  }
  if (options?.limit) {
    params.set("limit", String(options.limit));
  }
  const query = params.toString();
  return requestJson<MessagePage>(
    `/api/v1/conversations/${encodeURIComponent(conversationId)}/messages${
      query ? `?${query}` : ""
    }`,
    { method: "GET" },
    MESSAGES,
  );
}

export async function sendMessage(
  conversationId: string,
  body: string,
): Promise<ChatMessage> {
  return requestJson<ChatMessage>(
    `/api/v1/conversations/${encodeURIComponent(conversationId)}/messages`,
    { method: "POST", body: JSON.stringify({ body }) },
    MESSAGES,
  );
}

export async function markConversationRead(
  conversationId: string,
): Promise<{ conversation_id: string; unread_count: number }> {
  return requestJson(
    `/api/v1/conversations/${encodeURIComponent(conversationId)}/read`,
    { method: "POST" },
    MESSAGES,
  );
}

export { ApiError };