/**
 * The way into the Mini App from a trip's Telegram chat: an "Open trip" URL
 * button, and the words that ask for it.
 *
 * WHAT THE LINK IS. `https://t.me/<bot>?startapp=<trip id>` opens the bot's
 * Main Mini App with the trip id as its `start_param`. It is a plain URL button
 * and not a `web_app` button on purpose: an inline `web_app` button is refused
 * in groups, and a group is where this is pinned.
 *
 * WHAT THE LINK IS NOT. It is not access. The start parameter only SELECTS a
 * trip; the Mini App signs the person in with the identity Telegram verified for
 * that launch and opens the trip only for an active member of it (#442,
 * docs/telegram-mini-app.md). A forwarded button therefore opens nothing for a
 * stranger, and nothing secret rides in it: the trip id is already in every
 * trip URL and the bot handle is public. Both are validated against the
 * Mini App's own patterns before a URL is built, so nothing free-form can end
 * up in the button.
 *
 * "WORDS" ARE A CLOSED LIST. The router has no model call on a bound chat's
 * plain text (that goes to the companion), so there is no classifier to lean on.
 * What is here is deliberately dumb: after the assistant's name and the bot's
 * @mention are removed, EVERY remaining word must belong to a small vocabulary
 * and the message must contain an "app" word or "open" + "trip". Anything else
 * - a question, a sentence about the app, a message that merely contains the
 * word - is not a match and goes on to the companion as before. Callers also
 * require the message to be addressed to the assistant.
 */
import { normaliseBotUsername } from "../bot-username.js";
import { mentionsName, mentionsUsername } from "./addressing.js";
import { uiString, type Language } from "../intake-copy.js";
import type { InlineKeyboard } from "../chat-router.js";
import { TRIP_ID_PATTERN } from "../telegram-mini-app.js";

/** What to send, built once and sent by the poller. */
export interface OpenTripMessage {
  text: string;
  replyMarkup: InlineKeyboard;
  /** Said once, in the same chat, when the message could not be pinned. */
  pinFailedText: string;
}

/**
 * `https://t.me/<bot>?startapp=<trip id>`, or null when either part is not
 * something we would put in a link (unknown handle, malformed trip id).
 */
export function tripAppUrl(botUsername: string | null | undefined, tripId: string): string | null {
  const handle = normaliseBotUsername(botUsername);
  if (!handle || !TRIP_ID_PATTERN.test(tripId)) return null;
  return `https://t.me/${handle}?startapp=${tripId}`;
}

export function openTripMessage(
  botUsername: string | null | undefined,
  tripId: string,
  language: Language,
): OpenTripMessage | null {
  const url = tripAppUrl(botUsername, tripId);
  if (!url) return null;
  return {
    text: uiString("openTripText", language),
    replyMarkup: { inline_keyboard: [[{ text: uiString("openTripButton", language), url }]] },
    pinFailedText: uiString("openTripPinFailed", language),
  };
}

/** Is this a message we sent earlier to open a trip? (Used to replace it, never to trust it.) */
export function isOurOpenTripMessage(
  pinned: { fromId: string | null; text: string; buttonUrls: readonly string[] },
  botId: string,
): boolean {
  if (pinned.fromId !== botId) return false;
  if (pinned.buttonUrls.some((url) => /^https:\/\/t\.me\/[A-Za-z0-9_]{5,32}\?startapp=trip_[A-Za-z0-9]+$/.test(url))) return true;
  return (["en", "he"] as const).some((language) => pinned.text === uiString("openTripText", language));
}

// ── Plain words ─────────────────────────────────────────────────────────────

const MAX_WORDS = 8;
/** Words that make it a request for the app by themselves. */
const APP_WORDS = new Set([
  "app", "apps", "miniapp", "application",
  "אפליקציה", "האפליקציה", "אפליקציית", "אפליקצייה", "באפליקציה", "לאפליקציה",
]);
const OPEN_WORDS = new Set(["open", "launch", "start", "פתח", "פתחו", "פתחי", "תפתח", "תפתחי", "לפתוח"]);
const TRIP_WORDS = new Set(["trip", "טיול", "הטיול"]);
/** Politeness and glue that may surround a request without changing it. */
const FILLER = new Set([
  "please", "pls", "plz", "can", "you", "could", "would", "the", "a", "an", "me", "my", "us", "to", "for", "mini",
  "link", "show", "send", "give", "hey", "hi", "hello",
  "בבקשה", "אפשר", "תן", "תני", "תנו", "לי", "לנו", "שלח", "שלחו", "תשלח", "תשלחו", "קישור", "הי", "היי", "שלום", "את",
]);

function wordsOf(text: string): string[] {
  return text.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ").trim().split(" ").filter(Boolean);
}

/**
 * Cheap, pure pre-check: could this message be a request for the app at all?
 * Lets the dispatcher skip a database lookup for every ordinary sentence.
 */
export function couldAskForTripApp(text: string): boolean {
  const words = wordsOf(text);
  if (words.length === 0 || words.length > MAX_WORDS + 4) return false;
  return words.some((w) => APP_WORDS.has(w) || TRIP_WORDS.has(w));
}

/**
 * Is this message, once the assistant's name(s) and the bot's @mention are
 * taken out, nothing but a request for the trip app?
 */
export function asksForTripApp(
  text: string,
  context: { assistantNames: readonly string[]; botUsername?: string },
): boolean {
  let rest = text;
  if (mentionsUsername(rest, context.botUsername)) {
    const handle = (context.botUsername ?? "").replace(/^@/, "");
    rest = rest.replace(new RegExp(`@${handle}(?![A-Za-z0-9_])`, "gi"), " ");
  }
  for (const name of context.assistantNames) {
    const trimmed = name.trim();
    if (!trimmed || !mentionsName(rest, trimmed)) continue;
    const escaped = trimmed.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    rest = rest.replace(new RegExp(`(?<![\\p{L}\\p{N}_])${escaped}(?![\\p{L}\\p{N}_])`, "giu"), " ");
  }
  const words = wordsOf(rest);
  if (words.length === 0 || words.length > MAX_WORDS) return false;
  const known = (w: string) => APP_WORDS.has(w) || OPEN_WORDS.has(w) || TRIP_WORDS.has(w) || FILLER.has(w);
  if (!words.every(known)) return false;
  return words.some((w) => APP_WORDS.has(w)) || (words.some((w) => OPEN_WORDS.has(w)) && words.some((w) => TRIP_WORDS.has(w)));
}
