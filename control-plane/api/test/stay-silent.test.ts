/**
 * The marks the relay prefixes to a group message (stay-silent.ts) and the SOUL
 * template that teaches the companion to read them. They are one contract in two
 * repositories' worth of text: a mark the SOUL does not name is a line the
 * companion has never been told how to treat, which is how the staging run of
 * 2026-10-17 got a companion that answered an @mention with the silence sentinel.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, test } from "node:test";
import {
  addressedMark,
  conversationMark,
  ExplicitTurns,
  reactionAnswerMark,
  silenceVerdict,
  SILENCE_SENTINEL,
} from "../src/relay/stay-silent.js";

const soul = readFileSync(
  fileURLToPath(new URL("../../../profile-templates/familytrip-companion/templates/SOUL.md.tpl", import.meta.url)),
  "utf8",
);

describe("the marks and the SOUL template agree", () => {
  test("every mark the relay can prefix opens with the words the SOUL names", () => {
    const named: Array<[string, string]> = [
      [addressedMark("Some_bot"), "[addressed to you directly"],
      [conversationMark(), "[not addressed to you by name"],
      [reactionAnswerMark(), "[a reaction sent right after your last question"],
    ];
    for (const [mark, prefix] of named) {
      assert.ok(mark.startsWith(prefix), `the relay's mark opens with ${prefix}`);
      assert.ok(soul.includes(`\`${prefix}\``), `the SOUL template names ${prefix}`);
    }
    assert.ok(soul.includes(SILENCE_SENTINEL), "and the sentinel itself");
  });

  test("the SOUL tells the companion an addressed line is never answered with the sentinel", () => {
    assert.match(soul, /always\*\* for you: answer it\. Never reply with the\s+silence marker/);
  });
});

describe("addressedMark", () => {
  test("carries the handle, strips anything that is not one, and names none when unknown", () => {
    assert.ok(addressedMark("Kinerary_bot").includes("@Kinerary_bot"));
    assert.ok(addressedMark("@Kinerary_bot").includes("@Kinerary_bot") && !addressedMark("@Kinerary_bot").includes("@@"));
    assert.equal(addressedMark("a] b [c\nd"), addressedMark("abcd"));
    assert.ok(!addressedMark(undefined).includes("@"));
    assert.ok(!addressedMark("").includes("@"));
  });

  test("it is itself never mistaken for a silence reply", () => {
    assert.equal(silenceVerdict(addressedMark("x_bot")).kind, "deliver");
  });
});

describe("ExplicitTurns", () => {
  test("reply_to picks its turn; the latest decides without one; unknown is not explicit", () => {
    const turns = new ExplicitTurns();
    assert.equal(turns.wasExplicit("c1"), false, "nothing remembered");
    turns.note("c1", "10", true);
    turns.note("c1", "11", false);
    assert.equal(turns.wasExplicit("c1", "10"), true);
    assert.equal(turns.wasExplicit("c1", "11"), false);
    assert.equal(turns.wasExplicit("c1"), false, "latest forwarded turn");
    assert.equal(turns.wasExplicit("c1", "999"), false, "an id we do not hold falls back to the latest");
    assert.equal(turns.wasExplicit("c2", "10"), false, "chats are separate");
  });

  test("a turn is forgotten after its memory window, and memory is bounded", () => {
    let now = 1_000_000;
    const turns = new ExplicitTurns(() => now);
    turns.note("c1", "10", true);
    now += 31 * 60_000;
    assert.equal(turns.wasExplicit("c1", "10"), false, "30 minutes later it is gone");
    for (let i = 0; i < 600; i++) turns.note(`chat${i}`, "1", true);
    assert.equal(turns.wasExplicit("chat0"), false, "the oldest chat was dropped past the cap");
    assert.equal(turns.wasExplicit("chat599"), true);
  });
});
