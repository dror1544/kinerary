import assert from "node:assert/strict";
import type { DispatchDecision } from "../../src/relay/dispatch.js";

/**
 * The organizer was sent the interview's OPENING, not a refusal and not an approval question.
 *
 * An opening is one `reply` for a trip with no dashboard card, and for a dashboard trip (#548) the greeting and then
 * the document offer: a `multi_reply` whose last message carries the "I don't have one" button. An approval question
 * is also a `multi_reply`, which is why this checks the button and does not just accept either kind.
 */
export function assertOpening(decision: DispatchDecision, message?: string): void {
  if (decision.kind === "reply") return;
  assert.equal(decision.kind, "multi_reply", message);
  if (decision.kind !== "multi_reply") return;
  const last = decision.replies.at(-1);
  assert.ok(last?.replyMarkup && JSON.stringify(last.replyMarkup).includes("c:nodoc"), message ?? "a multi_reply that is not an opening");
}
