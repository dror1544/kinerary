/**
 * Is this group message actually for the assistant?
 *
 * In a DM the question does not arise — a 1:1 with the bot is addressed to the
 * bot. In a GROUP it is the whole question: the shared Trip Bot sits in a chat
 * where people mostly talk to each other, and a bot that answers every message
 * is both useless and, on a shared bot, a way to spend one trip's budget on
 * another trip's small talk.
 *
 * **Why this lives here and not in Hermes.** Hermes gates a directly-connected
 * adapter with `telegram.mention_patterns`. That does not survive the relay:
 * the gateway projects only a generic policy to a connector —
 * `requireAddress` / `freeResponseScopes` / `allowOtherBots` — and
 * mention_patterns is not in that vocabulary, while the adapter that reads it
 * is disabled outright by the relay-exclusive sweep. Under Sprint 5's model the
 * connector owns the socket, so the connector owns the gate.
 *
 * Three ways to address the assistant, and a group message that does none of
 * them is not for it:
 *
 *   1. by name — either language (migration 0030 stores both)
 *   2. by @username mention
 *   3. by replying to something the assistant said
 *
 * The fallback when a trip has no names configured is `@mention or reply`, NOT
 * "answer everything". Silence from a misconfigured trip is recoverable; a bot
 * that interrupts a family conversation is the thing people remember.
 */
import type { ChatType } from "./protocol.js";

export interface AddressingContext {
  /** Already mapped to the contract's vocabulary by normalize.ts. */
  chatType: ChatType;
  text: string;
  /** The trip's assistant names, both languages. Empty is allowed. */
  assistantNames: readonly string[];
  /** The bot's own @username, without the @. Enables mention detection. */
  botUsername?: string;
  /** True when this message replies to one the assistant itself sent. */
  isReplyToAssistant?: boolean;
}

/**
 * Escapes a name for use inside a RegExp. Names come from an organizer's free
 * text, so a name containing `.` or `(` must match literally rather than
 * becoming a pattern.
 */
function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Matches a name as a whole word, in any script.
 *
 * `\b` is ASCII-only in JavaScript, so it treats every Hebrew letter as a
 * boundary — `\bבוטסאן\b` would match inside a longer Hebrew word and report a
 * mention that never happened. The Unicode property escapes below are the
 * script-agnostic equivalent: a name counts only when what surrounds it is not
 * another letter, digit or underscore.
 */
export function mentionsName(text: string, name: string): boolean {
  const trimmed = name.trim();
  if (!trimmed) return false;
  const pattern = new RegExp(
    `(?<![\\p{L}\\p{N}_])${escapeRegExp(trimmed)}(?![\\p{L}\\p{N}_])`,
    "iu",
  );
  return pattern.test(text);
}

/** Matches `@botusername`, case-insensitively — Telegram usernames are not case-sensitive. */
export function mentionsUsername(text: string, botUsername: string | undefined): boolean {
  const handle = (botUsername ?? "").trim().replace(/^@/, "");
  if (!handle) return false;
  return new RegExp(`@${escapeRegExp(handle)}(?![A-Za-z0-9_])`, "i").test(text);
}

/**
 * Whether a message should engage the assistant.
 *
 * A DM always engages. Anything else must address it explicitly.
 */
export function isAddressedToAssistant(context: AddressingContext): boolean {
  // A direct message is addressed by construction — there is nobody else in
  // the room to be talking to.
  if (context.chatType === "dm") return true;

  if (context.isReplyToAssistant) return true;
  if (mentionsUsername(context.text, context.botUsername)) return true;

  for (const name of context.assistantNames) {
    if (mentionsName(context.text, name)) return true;
  }
  return false;
}
