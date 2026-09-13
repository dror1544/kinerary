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
import { structuredLog } from "../redaction.js";

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
  /**
   * Telegram's two announcements of a group becoming a supergroup. The chat id
   * changes, so every routing key we hold for this chat is about to be stale.
   * `migrate_to_chat_id` arrives on a message in the OLD chat, and
   * `migrate_from_chat_id` on one in the NEW chat — both, in practice.
   */
  migrate_to_chat_id?: number | string;
  migrate_from_chat_id?: number | string;
}

/**
 * The (from, to) chat ids of a supergroup migration announced by this message,
 * or null when it announces none.
 *
 * Read off either field, because Telegram sends both and whichever arrives
 * first should be the one that repairs the routing.
 */
export function migrationOf(message: TelegramMessage | undefined): { from: string; to: string } | null {
  if (!message) return null;
  const here = message.chat?.id;
  if (here === undefined || here === null || here === "") return null;
  const to = message.migrate_to_chat_id;
  if (to !== undefined && to !== null && to !== "") return { from: String(here), to: String(to) };
  const from = message.migrate_from_chat_id;
  if (from !== undefined && from !== null && from !== "") return { from: String(from), to: String(here) };
  return null;
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
  /**
   * The bot's own membership in a chat changed — added to a group, removed,
   * or promoted. Delivered only when `my_chat_member` is in `allowedUpdates`.
   */
  my_chat_member?: {
    chat?: TelegramChat;
    from?: TelegramUser;
    new_chat_member?: { user?: TelegramUser; status?: string };
    old_chat_member?: { user?: TelegramUser; status?: string };
  };
}

/**
 * Whether this update is "the bot has just been added to a group".
 *
 * `member` and `administrator` are both arrivals; the difference is only
 * whether the organizer granted rights on the way in. `left` and `kicked` are
 * departures, and `restricted` is neither — treat anything unrecognised as not
 * an arrival, so an unfamiliar status can never trigger an introduction.
 */
export function botJoinedGroup(
  update: TelegramUpdate,
  botId: string | undefined,
): { chatId: string; canPin: boolean } | null {
  const event = update.my_chat_member;
  if (!event) return null;
  const chat = event.chat;
  if (!chat?.id || (chat.type !== "group" && chat.type !== "supergroup")) return null;

  // It has to be US. `my_chat_member` is only ever about the bot, but the id is
  // there and checking it costs nothing — and a shared bot that introduced
  // itself because some OTHER bot joined would be a strange thing to debug.
  const who = event.new_chat_member?.user?.id;
  if (botId && who !== undefined && String(who) !== botId) return null;

  const status = event.new_chat_member?.status;
  if (status !== "member" && status !== "administrator") return null;

  const was = event.old_chat_member?.status;
  // Already inside. A promote-to-admin is not an arrival, and re-introducing
  // on every permissions change would be noise in a live family group.
  if (was === "member" || was === "administrator") return null;

  return { chatId: String(chat.id), canPin: status === "administrator" };
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
  | { kind: "dropped"; reason: "NO_MESSAGE" | "NO_CHAT_ID" | "NO_TEXT" | "FROM_BOT" | "UNROUTED" | "INTERVIEW" | "COMPANION_PENDING" };

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
  store: {
    put(input: { kind: MediaKind; mime: string; size: number; filename?: string; caption?: string; bytes: Buffer }): string | null;
    /**
     * Reading an upload back out by id. Optional because normalisation itself
     * only ever writes — it is the interview that needs the bytes again, to
     * read a booking PDF rather than merely hand its URL to something else.
     * Local by id rather than an HTTP fetch of our own URL: one less round
     * trip, and nothing that could be pointed somewhere other than the store.
     */
    get?(id: string): { bytes: Buffer; mime: string; filename?: string } | null;
  };
  /** Public base the gateway can reach this connector on, e.g. http://127.0.0.1:4312 */
  baseUrl: string;
  /**
   * Optional, and the reason it exists: a failed re-host used to be completely
   * silent on this side. `fetchFile` logs its own failures, but the two
   * degrade-and-continue returns below logged nothing, so "the organizer's
   * document did not reach the agent" was invisible in every log we keep. Run
   * 14 spent an hour reconstructing it from a floor value in the database.
   */
  log?: (line: string) => void;
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
  if (!file) {
    // Degrade, never drop: the turn still goes over so the agent can say it
    // could not read the file, rather than the organizer's upload vanishing.
    // But it must not vanish from the LOGS too.
    deps.log?.(structuredLog("warn", "relay.media_rehost_failed", {
      stage: "fetch",
      kind: attachment.kind,
      has_filename: Boolean(attachment.filename),
    }));
    return event;
  }

  const id = deps.store.put({
    kind: attachment.kind,
    mime: file.mime || attachment.mime,
    size: file.bytes.length,
    ...(attachment.filename ? { filename: attachment.filename } : {}),
    ...(message.caption ? { caption: message.caption } : {}),
    bytes: file.bytes,
  });
  if (!id) {
    deps.log?.(structuredLog("warn", "relay.media_rehost_failed", {
      stage: "store",
      kind: attachment.kind,
      size: file.bytes.length,
    }));
    return event;
  }

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

/**
 * Whether a turn for this trip would reach a running companion right now.
 *
 * Supplied by the connector, which answers from live socket state. Optional:
 * a caller that passes nothing keeps the pre-per-trip behaviour, where a
 * binding was taken to imply a destination.
 */
export type ReachabilityCheck = (profile: string) => boolean;

export async function normalizeUpdate(
  db: pg.Pool,
  update: TelegramUpdate,
  deps?: MediaDeps,
  canReach?: ReachabilityCheck,
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

  // Bound to a trip, but no assistant installed behind it yet (migration
  // 0043). Distinct from UNROUTED on purpose: "I don't have a trip for this
  // chat" would be a lie — we know exactly which trip this is, and the
  // organizer's site is already up. Answering honestly is the difference
  // between a system that looks broken and one that says what it is doing.
  if (!route.hermesProfile) return { kind: "dropped", reason: "COMPANION_PENDING" };

  // Installed is not running. Under one gateway process per trip
  // (`docs/per-trip-gateway-architecture.md`) a stopped companion is an
  // ordinary, recoverable state — `gateway start`, no re-provision — and the
  // organizer is owed the same honest answer as for a trip whose companion was
  // never installed: same reason code, same reply, no new vocabulary.
  //
  // Deliberately NOT its own reason: from the organizer's side "my assistant
  // isn't answering yet" is one situation, and splitting it would leak our
  // process model into their chat. The distinction that matters operationally
  // is already recorded — as reachability (migration 0042), where it can be
  // acted on.
  if (canReach && !canReach(route.hermesProfile)) {
    return { kind: "dropped", reason: "COMPANION_PENDING" };
  }

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
