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
import { MEDIA_MAX_BYTES, type MediaKind } from "./media-store.js";
import type { ChatType, WireMessageEvent, WireSessionSource } from "./protocol.js";

/** The subset of Telegram's Update we consume. */
export interface TelegramUser {
  id?: number | string;
  username?: string;
  first_name?: string;
  last_name?: string;
  is_bot?: boolean;
  /**
   * The sender's Telegram client locale ("he", "en-GB"). Present on most
   * updates, absent on some — it is a hint about which language to DRAW in,
   * never an identity claim and never a substitute for what the organizer
   * actually writes.
   */
  language_code?: string;
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
  document?: { file_id?: string; file_name?: string; mime_type?: string; file_size?: number };
  photo?: Array<{ file_id?: string; file_size?: number }>;
  voice?: { file_id?: string; mime_type?: string };
  audio?: { file_id?: string; mime_type?: string; file_name?: string };
  video?: { file_id?: string; mime_type?: string; file_name?: string };
  date?: number;
  message_thread_id?: number;
  reply_to_message?: { message_id?: number; from?: TelegramUser };
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
/**
 * What normalize needs to re-host an attachment. Optional throughout: a
 * connector wired without a media plane keeps its previous behaviour, and the
 * attachment degrades to its caption rather than failing the turn.
 */
export interface MediaDeps {
  telegram: { fetchFile(fileId: string, maxBytes: number): Promise<{ bytes: Buffer; mime?: string } | null> };
  store: { put(input: { kind: MediaKind; mime: string; size: number; filename?: string; caption?: string; bytes: Buffer }): string | null };
  /** Public base the gateway can reach this connector on, e.g. http://127.0.0.1:4312 */
  baseUrl: string;
}

export interface Attachment {
  fileId: string;
  kind: MediaKind;
  mime: string;
  filename?: string;
}

/**
 * Picks the one attachment a Telegram message carries, if any.
 *
 * Telegram sends photos as an array of sizes, largest last — the last entry is
 * the one worth re-hosting; the thumbnails are the same image again.
 */
export function describeAttachment(message: TelegramMessage): Attachment | null {
  if (message.document?.file_id) {
    return {
      fileId: message.document.file_id,
      kind: "document",
      mime: message.document.mime_type || "application/octet-stream",
      ...(message.document.file_name ? { filename: message.document.file_name } : {}),
    };
  }
  if (message.photo?.length) {
    const largest = message.photo[message.photo.length - 1];
    if (largest?.file_id) return { fileId: largest.file_id, kind: "image", mime: "image/jpeg" };
  }
  if (message.voice?.file_id) {
    return { fileId: message.voice.file_id, kind: "voice", mime: message.voice.mime_type || "audio/ogg" };
  }
  if (message.audio?.file_id) {
    return {
      fileId: message.audio.file_id,
      kind: "audio",
      mime: message.audio.mime_type || "audio/mpeg",
      ...(message.audio.file_name ? { filename: message.audio.file_name } : {}),
    };
  }
  if (message.video?.file_id) {
    return {
      fileId: message.video.file_id,
      kind: "video",
      mime: message.video.mime_type || "video/mp4",
      ...(message.video.file_name ? { filename: message.video.file_name } : {}),
    };
  }
  return null;
}

/** message_type reflects the first attachment's kind (contract §"Phase 2 media ingress"). */
function messageTypeFor(kind: MediaKind): "image" | "audio" | "document" {
  if (kind === "image") return "image";
  if (kind === "voice" || kind === "audio") return "audio";
  return "document";
}

/**
 * Builds the wire event, re-hosting an attachment when one is present.
 *
 * A failed download degrades rather than drops: the organizer still gets their
 * caption through, and the agent is told nothing that did not happen.
 */
export async function toWireEventWithMedia(
  message: TelegramMessage,
  chatId: string,
  text: string,
  profile: string,
  attachment: Attachment | null,
  deps?: MediaDeps,
): Promise<WireMessageEvent> {
  const event = toWireEvent(message, chatId, text, profile);
  if (!attachment || !deps) return event;

  const file = await deps.telegram.fetchFile(attachment.fileId, MEDIA_MAX_BYTES);
  if (!file) return event;

  const id = deps.store.put({
    kind: attachment.kind,
    mime: file.mime || attachment.mime,
    size: file.bytes.length,
    ...(attachment.filename ? { filename: attachment.filename } : {}),
    ...(message.caption ? { caption: message.caption } : {}),
    bytes: file.bytes,
  });
  if (!id) return event;

  return {
    ...event,
    message_type: messageTypeFor(attachment.kind),
    media_urls: [`${deps.baseUrl.replace(/\/$/, "")}/relay/media/${id}`],
    media: [{
      kind: attachment.kind,
      mime: file.mime || attachment.mime,
      size: file.bytes.length,
      ...(attachment.filename ? { filename: attachment.filename } : {}),
      ...(message.caption ? { caption: message.caption } : {}),
    }],
  };
}

export async function normalizeUpdate(
  db: pg.Pool,
  update: TelegramUpdate,
  deps?: MediaDeps,
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
  const attachment = describeAttachment(message);

  // An attachment with no caption is a real turn, not an empty one. Dropping
  // it on NO_TEXT is what made "upload your trip plan" a dead end: the
  // organizer's document vanished with no error on either side.
  if (!text.trim() && !attachment) return { kind: "dropped", reason: "NO_TEXT" };

  const route = await resolveChatRoute(db, chatId);

  // Fail closed. On a shared bot, "no trip resolved" can never mean "use the
  // default" — the default would be somebody else's trip.
  if (route.kind === "unbound") return { kind: "dropped", reason: "UNROUTED" };
  // Dropped here, rebuilt by dispatch.ts — which is why `describeAttachment`
  // and `toWireEventWithMedia` are exported rather than private to this
  // module. The interview route is the one that ASKS for a document, and it
  // spent 2026-09-04's run handing the agent an empty message because this
  // branch returned before the re-host and dispatch rebuilt the event without
  // it. Whatever this branch skips, that one has to do itself.
  if (route.kind === "interview") return { kind: "dropped", reason: "INTERVIEW" };

  return {
    kind: "event",
    event: await toWireEventWithMedia(message, chatId, text, route.hermesProfile, attachment, deps),
    route,
  };
}

/**
 * Builds the wire event for one Telegram message under a given profile.
 *
 * Split out because the interview path needs the same event shape but reaches
 * it differently: its profile is the shared interviewer's rather than a trip
 * companion's, and it is resolved by the caller. Keeping one builder means the
 * `source.profile` stamp — the Trip Context Gateway decision on the wire — is
 * constructed in exactly one place regardless of which route produced it.
 */
export function toWireEvent(
  message: TelegramMessage,
  chatId: string,
  text: string,
  profile: string,
): WireMessageEvent {
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
    profile,
  };

  return {
    text,
    message_type: "text",
    source,
    message_id: message.message_id !== undefined ? String(message.message_id) : undefined,
    reply_to_message_id:
      message.reply_to_message?.message_id !== undefined
        ? String(message.reply_to_message.message_id)
        : undefined,
  };
}
