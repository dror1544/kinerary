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
 * its "?" is never marked: those are addressed to it by definition.
 */
export function conversationMark(): string {
  return (
    `[not addressed to you by name — sent in an ongoing conversation with you; ` +
    `reply only if it is meant for you, otherwise reply with exactly ${SILENCE_SENTINEL} and nothing else]`
  );
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
