/**
 * Free text from WhatsApp, made safe to pass on (spec 625, "Sender ids and phone numbers"; AC-27). Every rule here is
 * the same rule: text a person or their phone chose (a message, a display name, a file name, a group title) must not
 * carry a WhatsApp id or a phone number onwards, to a gateway, the judge, a log line or the database.
 *
 * DIGITS IN ANY SCRIPT. A number can be written in Arabic-Indic, Extended Arabic-Indic, full-width or any other decimal
 * digits, so every count here is of `\p{Nd}`, never `[0-9]` (#655 review, F4). Seven is the threshold everywhere: shorter
 * runs are times, room numbers and years; seven or more is treated as a number someone could dial.
 *
 * All functions are pure and never throw.
 */
import { cleanChatText } from "../../chat-binding-codes.js";
import type { MediaKind } from "../media-store.js";

/** At or above this many decimal digits (any script), free text is treated as a phone number. */
export const NUMBER_DIGITS = 7;

const digitCount = (text: string): number => text.match(/\p{Nd}/gu)?.length ?? 0;

/** Whether free text holds a number someone could dial (seven or more digits, in any script). */
export function holdsNumber(text: string): boolean {
  return digitCount(text) >= NUMBER_DIGITS;
}

const DIGITS_OF = (id: string) => id.slice(0, id.indexOf("@"));

/**
 * Rewrites every @mention in WhatsApp text (spec, Sender ids): each listed id's token, the number's own in either form,
 * and any other `@` followed by seven or more digits. The number's own becomes `ownName`; anyone else's "someone".
 */
export function rewriteMentions(
  text: string,
  mentionedIds: readonly string[],
  ownIds: ReadonlySet<string>,
  ownName: string,
): string {
  if (!text.includes("@")) return text;
  const replacement = new Map<string, string>();
  for (const id of mentionedIds) {
    const digits = DIGITS_OF(id);
    if (/^[0-9]+$/.test(digits)) replacement.set(digits, ownIds.has(id) ? ownName : "someone");
  }
  for (const id of ownIds) {
    const digits = DIGITS_OF(id);
    if (/^[0-9]+$/.test(digits)) replacement.set(digits, ownName);
  }
  return text.replace(/@\+?(\p{Nd}+)/gu, (whole, digits: string) => {
    const known = replacement.get(digits);
    if (known !== undefined) return known;
    return digits.length >= NUMBER_DIGITS ? "someone" : whole;
  });
}

/**
 * A sender's display name as the companion may see it: one clean line, and EMPTY rather than a number (a WhatsApp name a
 * person never set is often their number written out).
 */
export function whatsappSenderName(raw: string | null | undefined): string | null {
  const cleaned = cleanChatText(raw, 64);
  if (!cleaned || holdsNumber(cleaned)) return null;
  if (/@/.test(cleaned) && /\p{Nd}{5,}/u.test(cleaned)) return null;
  return cleaned;
}

/** A group's title as it may be stored (`chat_title`) and shown (get_chat_info): no title rather than a number. */
export function whatsappChatTitle(raw: string | null | undefined): string | null {
  const cleaned = cleanChatText(raw);
  return cleaned && !holdsNumber(cleaned) ? cleaned : null;
}

/**
 * A media file's name as the companion may see it. A phone names files after numbers and dates
 * (`IMG-20261124-WA0007.jpg`) and a sender may name one after a number: such a name becomes `photo.<ext>` or
 * `document.<ext>` (`audio`, `video` likewise), keeping a plain extension so the reader still knows the type.
 */
export function whatsappFilename(raw: string | null | undefined, kind: MediaKind): string | undefined {
  const cleaned = cleanChatText(raw, 200);
  if (!cleaned) return undefined;
  if (!holdsNumber(cleaned)) return cleaned;
  const ext = /\.([A-Za-z0-9]{1,8})$/.exec(cleaned)?.[1];
  const base = kind === "image" ? "photo" : kind === "document" ? "document" : kind;
  return ext && !holdsNumber(ext) ? `${base}.${ext.toLowerCase()}` : base;
}
