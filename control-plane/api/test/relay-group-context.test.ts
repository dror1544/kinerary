/**
 * What the family said while nobody was addressing the assistant.
 *
 * The assertions are about what their absence would allow: a transcript of a
 * family's conversation accumulating in a relay, a DM paying for a gate it
 * does not have, or the same small talk attached to every question for the
 * rest of the trip.
 */
import assert from "node:assert/strict";
import { describe, test } from "node:test";
import {
  GroupContext,
  GROUP_CONTEXT_PER_CHAT,
  GROUP_CONTEXT_TTL_MS,
} from "../src/relay/group-context.js";

describe("GroupContext", () => {
  test("carries what was overheard onto the next addressed turn, oldest first", () => {
    const ctx = new GroupContext();
    ctx.hold("-100", "Shiran", "אני חושבת שעדיף יומיים בהוי אן");
    ctx.hold("-100", "Noam", "ואני רוצה יום חופש בים");

    assert.deepEqual(ctx.take("-100"), [
      { sender: "Shiran", text: "אני חושבת שעדיף יומיים בהוי אן" },
      { sender: "Noam", text: "ואני רוצה יום חופש בים" },
    ]);
  });

  test("taking clears it, so the same turns are never replayed", () => {
    // Otherwise every later question in that group carries the same small talk
    // for the rest of the trip.
    const ctx = new GroupContext();
    ctx.hold("-100", "Dror", "מתי נטוס?");
    assert.equal(ctx.take("-100").length, 1);
    assert.deepEqual(ctx.take("-100"), []);
  });

  test("keeps only the most recent messages for a chat", () => {
    const ctx = new GroupContext();
    for (let i = 0; i < GROUP_CONTEXT_PER_CHAT + 5; i += 1) ctx.hold("-100", "Dror", `m${i}`);
    const held = ctx.take("-100");
    assert.equal(held.length, GROUP_CONTEXT_PER_CHAT);
    assert.equal(held[held.length - 1]?.text, `m${GROUP_CONTEXT_PER_CHAT + 4}`, "the newest survive");
  });

  test("forgets anything older than the window", () => {
    // A conversation from this morning is not context for this afternoon's
    // question; it is a transcript, which is the thing this must not become.
    let now = 1_000_000;
    const ctx = new GroupContext(() => now);
    ctx.hold("-100", "Dror", "stale");
    now += GROUP_CONTEXT_TTL_MS + 1;
    ctx.hold("-100", "Shiran", "fresh");

    assert.deepEqual(ctx.take("-100"), [{ sender: "Shiran", text: "fresh" }]);
  });

  test("one chat's conversation never reaches another", () => {
    const ctx = new GroupContext();
    ctx.hold("-100", "Dror", "ours");
    ctx.hold("-200", "Someone", "theirs");
    assert.deepEqual(ctx.take("-100"), [{ sender: "Dror", text: "ours" }]);
    assert.deepEqual(ctx.take("-200"), [{ sender: "Someone", text: "theirs" }]);
  });

  test("an empty or whitespace-only message is not held at all", () => {
    // A photo with no caption is the family talking, not something to carry.
    const ctx = new GroupContext();
    ctx.hold("-100", "Dror", "   ");
    ctx.hold("-100", "Dror", "");
    assert.deepEqual(ctx.take("-100"), []);
  });
});
