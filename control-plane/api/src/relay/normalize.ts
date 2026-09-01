/**
 * Telegram update → normalized wire event, and the routing decision that goes
 * with it.
 *
 * This is the Trip Context Gateway in its concrete form. The relay contract
 * says the connector resolves the destination from "the event's own
 * discriminator … never from which token/socket/process delivered it", and
 * that the gateway "re-validates nothing" — so whatever this module stamps on
 * `source.profile` IS the trip context, unconditionally, for that turn.
 *
 * Two rules follow, and both are enforced here rather than trusted downstream:
 *
 *   1. The profile comes from `resolveChatRoute` — a database lookup on the
 *      chat id. Message text is never an input to it.
 *   2. A chat that resolves to no trip produces NO event at all. Fail closed:
 *      an unrouted turn must not reach some default profile, because on a
 *      shared bot "the default profile" is another organizer's trip.
 */
import type pg from "pg";
import { resolveChatRoute, type ChatRoute } from "../chat-router.js";
import type { ChatType, WireMessageEvent, WireSessionSource } from "./protocol.js";

/** The subset of Telegram's Update we consume. */
export interface TelegramUser {
  id?: number | string;
  username?: string;
  first_name?: string;
  last_name?: string;
  is_bot?: boolean;
}

export interface TelegramChat {
  id?: number | string;
  type?: string;
  title?: string;
  username?: string;
}

export interface TelegramMessage {
  message_id?: number;
  from?: TelegramUser;
  chat?: TelegramChat;
  text?: string;
  caption?: string;
  date?: number;
  message_thread_id?: number;
  reply_to_message?: { message_id?: number };
}

export interface TelegramUpdate {
  update_id: number;
  message?: TelegramMessage;
  edited_message?: TelegramMessage;
  callback_query?: {
    id: string;
    data?: string;
    from?: TelegramUser;
    message?: TelegramMessage;
  };
}

/**
 * Telegram's chat types mapped onto the contract's vocabulary.
 *
 * `supergroup` collapses to `group`: the distinction is a Telegram migration
 * artifact, and the contract's `chat_type` drives session keying and the
 * multi-party context rules, where both behave identically. A forum topic is
 * its own type because the contract keys `thread_id` off it.
 */
export function mapChatType(telegramType: string | undefined, hasThread: boolean): ChatType {
  switch (telegramType) {
    case "private":
      return "dm";
    case "group":
    case "supergroup":
      return hasThread ? "forum" : "group";
    case "channel":
      return "channel";
    default:
      // An unrecognised chat type is treated as a group, the more restrictive
      // reading: group rules assume other people can see the conversation,
      // and guessing `dm` for something that is not one would be the unsafe
      // direction of a wrong guess.
      return "group";
  }
}

/** Telegram gives no display name field; assemble one the way its own clients do. */
export function displayName(user: TelegramUser | undefined): string | null {
  if (!user) return null;
  const full = [user.first_name, user.last_name].filter(Boolean).join(" ").trim();
  return full || user.username || null;
}

export type NormalizeOutcome =
  | { kind: "event"; event: WireMessageEvent; route: ChatRoute }
  | { kind: "dropped"; reason: "NO_MESSAGE" | "NO_CHAT_ID" | "NO_TEXT" | "FROM_BOT" | "UNROUTED" | "INTERVIEW" };

/**
 * Normalizes one Telegram update into a wire event, or explains why it will
 * not become one.
 *
 * `INTERVIEW` is a drop from the gateway's perspective but not a failure: a
 * chat mid-interview is served by the router's own deterministic layer, which
 * asks the intake questions and records the answers with no LLM involved. The
 * caller handles that turn; it just never becomes an `inbound` frame.
 */
export async function normalizeUpdate(
  db: pg.Pool,
  update: TelegramUpdate,
): Promise<NormalizeOutcome> {
  const message = update.message ?? update.edited_message;
  if (!message) return { kind: "dropped", reason: "NO_MESSAGE" };

  const rawChatId = message.chat?.id;
  if (rawChatId === undefined || rawChatId === null || rawChatId === "") {
    return { kind: "dropped", reason: "NO_CHAT_ID" };
  }
  const chatId = String(rawChatId);

  // A bot's own messages must never start a turn — on a shared bot in a group,
  // echoing our own output back into the agent is a loop, not a conversation.
  if (message.from?.is_bot) return { kind: "dropped", reason: "FROM_BOT" };

  const text = message.text ?? message.caption ?? "";
  if (!text.trim()) return { kind: "dropped", reason: "NO_TEXT" };

  const route = await resolveChatRoute(db, chatId);

  // Fail closed. On a shared bot, "no trip resolved" can never mean "use the
  // default" — the default would be somebody else's trip.
  if (route.kind === "unbound") return { kind: "dropped", reason: "UNROUTED" };
  if (route.kind === "interview") return { kind: "dropped", reason: "INTERVIEW" };

  const hasThread = message.message_thread_id !== undefined;
  const source: WireSessionSource = {
    platform: "telegram",
    chat_id: chatId,
    chat_type: mapChatType(message.chat?.type, hasThread),
    chat_name: message.chat?.title ?? message.chat?.username ?? null,
    user_id: message.from?.id !== undefined ? String(message.from.id) : null,
    user_name: displayName(message.from),
    thread_id: hasThread ? String(message.message_thread_id) : null,
    chat_topic: null,
    // The whole point of this module.
    profile: route.hermesProfile,
  };

  const event: WireMessageEvent = {
    text,
    message_type: "text",
    source,
    message_id: message.message_id !== undefined ? String(message.message_id) : undefined,
    reply_to_message_id:
      message.reply_to_message?.message_id !== undefined
        ? String(message.reply_to_message.message_id)
        : undefined,
  };

  return { kind: "event", event, route };
}
