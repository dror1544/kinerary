/**
 * Letting the companion stay silent on a message that was not addressed to it.
 *
 * The per-person conversation window forwards a member's untagged messages to
 * the companion (dispatch.ts). Some of those are the family talking among
 * themselves, so the companion is told so — `conversationMark` is prefixed to
 * the message text, the only field that reaches the model (#122) — and given
 * one way to say nothing: a reply that is exactly `SILENCE_SENTINEL`.
 *
 * WHY A SENTINEL OF OUR OWN. Hermes has native silence markers
 * (`[SILENT]`, `NO_REPLY`, … in gateway/response_filters.py), but it honours
 * them on a human turn only when the event's `reply_expected` is false, and the
 * relay lane's `_event_from_wire` never reads that from the wire. On this lane
 * Hermes would replace its own marker with a visible fallback sentence — a
 * message to the family, the opposite of silence. The sentinel below is
 * deliberately NOT one of Hermes's markers (nor a "silence narration" its
 * delivery layer drops), so it travels through Hermes untouched as ordinary
 * text, and the connector — the last hop before Telegram — is where it is
 * recognised and dropped.
 */

/** The whole reply that means "I have nothing to say to this". */
export const SILENCE_SENTINEL = "[[KINERARY_STAY_SILENT]]";

/**
 * The line prefixed to a message admitted ONLY by the conversation window. A
 * message that named the assistant, @mentioned it, replied to it or answered
 * its "?" never gets this mark: a name, @mention or reply gets `addressedMark`, an answer to its "?" gets none.
 */
export function conversationMark(): string {
  return (
    `[not addressed to you by name — sent in an ongoing conversation with you; ` +
    `reply only if it is meant for you, otherwise reply with exactly ${SILENCE_SENTINEL} and nothing else]`
  );
}

/**
 * The opposite fence: the line prefixed to a GROUP message that addressed the
 * assistant explicitly - by name, by @mention of the bot, or as a reply to one of
 * its messages (never the windows, never the judge).
 *
 * It exists because the companion cannot otherwise tell. On 2026-10-17 a member
 * wrote "@<bot> where is the hotel relative to the centre?" and the companion,
 * whose prompt contained neither the bot's @handle nor its name, answered with
 * the sentinel both times: it had learnt the sentinel from the window mark and
 * read a mention it did not recognise as meant for someone else. So the line says it plainly, forbids the sentinel for this
 * turn, and tells the companion its own Telegram handle - which differs per
 * deployment, so it comes from the bot's identity (getMe), never from a constant.
 * The handle goes in this line rather than being substituted into the member's
 * text: the words reach the model exactly as typed, and the handle is learnt from
 * any explicit turn, whichever way it was addressed.
 *
 * Starts with `[addressed to you directly` - profile-templates' SOUL names that
 * exact prefix, so the two change together.
 */
export function addressedMark(botUsername?: string): string {
  // Telegram usernames are [A-Za-z0-9_]; anything else is dropped, not trusted into a prompt.
  const handle = (botUsername ?? "").trim().replace(/^@/, "").replace(/[^A-Za-z0-9_]/g, "");
  const who = handle ? ` In Telegram you are @${handle}.` : "";
  return (
    `[addressed to you directly — this message is for you; answer it. ` +
    `Never reply with ${SILENCE_SENTINEL} to it.${who}]`
  );
}

/**
 * The line prefixed to a bare reaction (an emoji, a "?") that took the one-shot
 * "?" window: the assistant's last message ended in a question, and a thumbs-up
 * to "Should I update the site?" is the answer. Without it the companion sees
 * "👍" with no sign of what it answers. Not an explicit address - the reaction
 * might be any member's - so a silence stays allowed.
 */
export function reactionAnswerMark(): string {
  return (
    `[a reaction sent right after your last question — read it as a reply to that question ` +
    `(a thumbs-up is yes), and act on it]`
  );
}

/** How long a forwarded turn is remembered for the "was it explicit?" question. */
const TURN_MEMORY_MS = 30 * 60_000;
const TURNS_PER_CHAT = 8;
const MAX_CHATS = 500;

/**
 * Which forwarded group turns were explicit, per chat, so the connector can tell
 * "the companion stayed silent on a message that was not for it" (fine) from "the
 * companion stayed silent on one that named it" (a defect we cannot repair - there
 * is no answer to invent - but must count).
 *
 * Correlation: the reply's `reply_to` names the inbound message id when the
 * gateway sends it, so that exact turn is looked up; without it (or with an id we
 * no longer hold) the LATEST forwarded turn in the chat decides. The latest-turn
 * fallback can only err towards "explicit" when an explicit turn is followed by a
 * window turn the companion then silences - an over-count of one defect, never a
 * dropped or invented answer. In memory only, bounded, keyed by chat id exactly as
 * the emitter's reply attribution is; no text is ever stored.
 */
export class ExplicitTurns {
  private readonly chats = new Map<string, Array<{ messageId: string | undefined; explicit: boolean; at: number }>>();

  constructor(private readonly now: () => number = Date.now) {}

  note(chatId: string, messageId: string | undefined, explicit: boolean): void {
    const list = this.chats.get(chatId) ?? [];
    list.push({ messageId, explicit, at: this.now() });
    while (list.length > TURNS_PER_CHAT) list.shift();
    // Re-insert so the map's order is least-recently-noted first.
    this.chats.delete(chatId);
    this.chats.set(chatId, list);
    while (this.chats.size > MAX_CHATS) {
      const oldest = this.chats.keys().next().value;
      if (oldest === undefined) break;
      this.chats.delete(oldest);
    }
  }

  /** Whether the turn a reply answers was explicit; false when nothing is known. */
  wasExplicit(chatId: string, replyTo?: string): boolean {
    const list = this.chats.get(chatId);
    if (!list) return false;
    const cutoff = this.now() - TURN_MEMORY_MS;
    const live = list.filter((t) => t.at >= cutoff);
    if (replyTo) {
      const hit = live.find((t) => t.messageId === replyTo);
      if (hit) return hit.explicit;
    }
    return live.length > 0 ? live[live.length - 1]!.explicit : false;
  }
}

export type SilenceVerdict =
  | { kind: "silent" }
  | { kind: "deliver"; content: string };

/**
 * What to do with a companion send or edit.
 *
 * - Exactly the sentinel (surrounding whitespace ignored, case-sensitive): stay
 *   silent. So is a bare prefix of it that starts with `[[` — a streaming
 *   adapter sends the first words of a reply before the rest exists, and
 *   half a sentinel must not reach the chat either.
 * - Text that merely CONTAINS the sentinel is delivered with the token removed,
 *   not unchanged: the token is control syntax, never something to say to a
 *   family, and not dropping the rest means a real answer is never swallowed
 *   because the model appended the token to it.
 * - Everything else is delivered as it came.
 */
export function silenceVerdict(content: string): SilenceVerdict {
  const trimmed = content.trim();
  if (trimmed === SILENCE_SENTINEL) return { kind: "silent" };
  if (trimmed.length >= 2 && trimmed.startsWith("[[") && SILENCE_SENTINEL.startsWith(trimmed)) {
    return { kind: "silent" };
  }
  if (!content.includes(SILENCE_SENTINEL)) return { kind: "deliver", content };
  const stripped = content.split(SILENCE_SENTINEL).join("").trim();
  return stripped.length === 0 ? { kind: "silent" } : { kind: "deliver", content: stripped };
}
