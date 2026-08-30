/**
 * API client for conversations & messages (Phase 7).
 *
 * GET  /api/v1/conversations — the caller's conversations (active matches)
 *   with unread counts; each carries the same client-safe profile shape as
 *   the matches list.
 * GET  /api/v1/conversations/{id}/messages — message history, newest first,
 *   keyset-paginated via the opaque `cursor`.
 * POST /api/v1/conversations/{id}/messages — send one text message
 *   (1–2000 characters after trimming; the backend trims).
 * POST /api/v1/conversations/{id}/read — mark the conversation read.
 *
 * Authentication uses the existing Supabase browser session; the JWT is
 * attached as a bearer token and validated by FastAPI. Sender identity is
 * derived server-side from the token — this client never sends profile ids.
 * A conversation id IS a match id; an unmatched conversation surfaces as
 * `not_found` everywhere.
 *
 * Backend failures arrive as `{ "error": { "code": "...", "message": "..." } }`.
 * Raw backend messages are never surfaced to users — errors are mapped to
 * concise, curated copy by code.
 */

import { apiBaseUrl } from "@/lib/env";
import { createClient } from "@/lib/supabase/client";
import type { DiscoveryCandidate } from "@/lib/api/discovery";

export const MAX_MESSAGE_LENGTH = 2000;

export interface ConversationEntry {
  id: string;
  created_at: string | null;
  unread_count: number;
  profile: DiscoveryCandidate;
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

export type MessagingApiErrorCode =
  | "unauthorized"
  | "not_verified"
  | "not_found"
  | "validation"
  | "unavailable"
  | "network"
  | "unknown";

const USER_MESSAGES: Record<MessagingApiErrorCode, string> = {
  unauthorized: "You need to sign in to do that.",
  not_verified: "You need to be verified to use messaging.",
  not_found: "This conversation is no longer available.",
  validation: "That message couldn't be sent. Please check it and try again.",
  unavailable:
    "Messaging is temporarily unavailable. Please try again in a moment.",
  network: "We couldn't reach the server. Check your connection and try again.",
  unknown: "Something went wrong. Please try again.",
};

export class MessagingApiError extends Error {
  readonly code: MessagingApiErrorCode;

  constructor(code: MessagingApiErrorCode) {
    super(USER_MESSAGES[code]);
    this.name = "MessagingApiError";
    this.code = code;
  }
}

export async function fetchConversations(): Promise<{
  conversations: ConversationEntry[];
}> {
  return requestJson<{ conversations: ConversationEntry[] }>(
    "/api/v1/conversations",
    { method: "GET" },
  );
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
  );
}

export async function sendMessage(
  conversationId: string,
  body: string,
): Promise<ChatMessage> {
  return requestJson<ChatMessage>(
    `/api/v1/conversations/${encodeURIComponent(conversationId)}/messages`,
    { method: "POST", body: JSON.stringify({ body }) },
  );
}

export async function markConversationRead(
  conversationId: string,
): Promise<{ conversation_id: string; unread_count: number }> {
  return requestJson(
    `/api/v1/conversations/${encodeURIComponent(conversationId)}/read`,
    { method: "POST" },
  );
}

/**
 * Resolves the Supabase access token from the existing browser session.
 * No second auth mechanism is introduced; missing/expired sessions surface
 * as an unauthorized error and the backend re-validates every token.
 */
async function getAccessToken(): Promise<string | null> {
  const supabase = createClient();
  const { data } = await supabase.auth.getSession();
  return data.session?.access_token ?? null;
}

async function requestJson<T>(path: string, init: RequestInit): Promise<T> {
  const token = await getAccessToken();
  if (!token) {
    throw new MessagingApiError("unauthorized");
  }

  const headers = new Headers(init.headers);
  headers.set("Authorization", `Bearer ${token}`);
  if (init.body) {
    headers.set("Content-Type", "application/json");
  }

  let response: Response;
  try {
    response = await fetch(`${apiBaseUrl()}${path}`, { ...init, headers });
  } catch {
    throw new MessagingApiError("network");
  }

  if (!response.ok) {
    throw new MessagingApiError(
      errorCodeFor(await readBackendErrorCode(response), response.status),
    );
  }

  try {
    return (await response.json()) as T;
  } catch {
    throw new MessagingApiError("unknown");
  }
}

async function readBackendErrorCode(
  response: Response,
): Promise<string | undefined> {
  try {
    const body = (await response.json()) as {
      error?: { code?: unknown };
    };
    return typeof body?.error?.code === "string" ? body.error.code : undefined;
  } catch {
    return undefined;
  }
}

function errorCodeFor(
  backendCode: string | undefined,
  status: number,
): MessagingApiErrorCode {
  switch (backendCode) {
    case "unauthorized":
      return "unauthorized";
    case "permission_denied":
      return "not_verified";
    case "not_found":
      return "not_found";
    case "validation_error":
      return "validation";
    case "database_unavailable":
    case "database_insert_failed":
    case "database_update_failed":
    case "service_unavailable":
      return "unavailable";
    default:
      if (status === 401) {
        return "unauthorized";
      }
      if (status === 403) {
        return "not_verified";
      }
      if (status === 404) {
        return "not_found";
      }
      if (status === 422) {
        return "validation";
      }
      if (status >= 500) {
        return "unavailable";
      }
      return "unknown";
  }
}
