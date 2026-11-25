/**
 * #666 — a typed "no, keep it" does not cancel a waiting change box.
 *
 * Real-model run, 2026-11-25: a box was waiting (stay end 17 May -> 16 May) and the
 * organizer typed "לא, רגע — עד 17 במאי". The held end already IS 17 May, so the
 * reader found nothing to change, emitted no operation, and the draft stayed pending.
 * Two layers, because a prompt is a request and not a guarantee:
 *  - the reader is told a change is waiting and what it would do, so it emits the
 *    operation that restates the held value (which then hits #647's merged no-op), and
 *  - when it returns nothing anyway, a message that opens with a "no" and carries no
 *    value other than what is held is the organizer's "No" (`leadsWithNo`,
 *    `carriesNewValue`).
 */
import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { buildInterpretPrompt, changeSection } from "../src/interpret.js";
import { carriesNewValue, describeWaitingOps, leadsWithNo, type Op } from "../src/typed-changes.js";
import type { AnswerStore } from "../src/interview.js";

const flat = (lines: string[]) => lines.join("\n");
const HELD = { stops: [{ id: "s1", label: "לובליאנה, 2027-05-10 to 2027-05-17" }], travellers: [] };
const WAITING: Op[] = [{ op: "update_stop", target: { name: "לובליאנה" }, fields: { end: "2027-05-16" } }];

describe("the reader is told a change is waiting (#666)", () => {
  test("with a draft waiting, the section names what it would do and asks for the restating operation", () => {
    const section = flat(changeSection(HELD, describeWaitingOps(WAITING)));
    assert.match(section, /A CHANGE IS WAITING/);
    assert.ok(section.includes('"end":"2027-05-16"'), "the waiting change's own value is shown");
    assert.match(section, /HELD/, "and the held value is what a restatement is read against");
    assert.match(section, /restat/i);
    assert.match(section, /no, keep it/i);
  });

  test("with no draft waiting, the prompt is exactly what it was", () => {
    assert.equal(flat(changeSection(HELD)), flat(changeSection(HELD, [])));
    assert.doesNotMatch(flat(changeSection(HELD)), /WAITING/);
  });

  test("nothing held, nothing to restate: a waiting list changes nothing in the prompt", () => {
    assert.deepEqual(changeSection({ stops: [], travellers: [] }, describeWaitingOps(WAITING)), []);
  });

  test("the whole prompt carries it, and only when asked", () => {
    const args = { sourceText: "לא, רגע — עד 17 במאי", outstanding: [], language: "he", heldLists: HELD };
    assert.match(buildInterpretPrompt({ ...args, waitingChange: describeWaitingOps(WAITING) }), /A CHANGE IS WAITING/);
    assert.doesNotMatch(buildInterpretPrompt(args), /A CHANGE IS WAITING/);
  });

  test("the description is bounded and cannot carry a line of its own", () => {
    const many: Op[] = Array.from({ length: 40 }, (_, i) => ({ op: "update_stop", target: { name: `Stop ${i}` }, fields: { end: "2027-05-16" } }));
    const lines = describeWaitingOps(many);
    assert.ok(lines.length <= 13, `at most a dozen operations and a note: ${lines.length}`);
    assert.ok(lines.every((l) => !l.includes("\n")), "one line each");
    assert.ok(lines.join("").length < 3000);
  });
});

describe("leadsWithNo — a message that opens with a refusal (#666)", () => {
  test("Hebrew and English refusals that go on to restate something", () => {
    for (const text of [
      "לא, רגע — עד 17 במאי",
      "לא, הלינה בלובליאנה נשארת עד 17 במאי",
      "לא. עד 17 במאי",
      "לא רגע, עד 17 במאי",
      "no, keep it until 17 May",
      "No - it stays 17 May",
      "nope, it's the 17th",
      "no wait, the 17th",
      "  ❌ לא, תשאירו",
    ]) {
      assert.equal(leadsWithNo(text), true, text);
    }
  });

  test("a message that only contains a no, or negates something else, is not a refusal", () => {
    for (const text of [
      "לא יודע אם עד 17",
      "לא בטוח",
      "we do not know yet",
      "I know, 17 May",
      "now it is 17 May",
      "נו, עד 17 במאי",
      "עד 17 במאי, לא 16",
      "",
    ]) {
      assert.equal(leadsWithNo(text), false, text);
    }
  });
});

describe("carriesNewValue — a number that is not the held value of what the waiting change alters is a different value (#666)", () => {
  const held: AnswerStore = {
    phases: {
      kind: "structured", schema_version: 3,
      data: [
        { name: "לובליאנה", start: "2027-05-10", end: "2027-05-17" },
        { name: "בלד", start: "2027-05-17", end: "2027-05-21" },
      ],
    } as never,
    travelers: { kind: "structured", schema_version: 3, data: [{ name: "Dana", age: 40 }, { name: "Avi", age: 7 }] } as never,
  };
  const endOfLjubljana: Op[] = [{ op: "update_stop", target: { name: "לובליאנה" }, fields: { end: "2027-05-16" } }];
  const danaAge: Op[] = [{ op: "update_traveller", target: { name: "Dana" }, fields: { age: 41 } }];

  test("restating the held value is not new", () => {
    assert.equal(carriesNewValue("לא, רגע — עד 17 במאי", held, endOfLjubljana), false);
    assert.equal(carriesNewValue("no, keep it until 17 May", held, endOfLjubljana), false);
    assert.equal(carriesNewValue("no, keep it until 17 May 2027", held, endOfLjubljana), false);
    assert.equal(carriesNewValue("לא, הלינה בלובליאנה נשארת", held, endOfLjubljana), false, "no number at all");
    assert.equal(carriesNewValue("no, Dana is 40", held, danaAge), false);
  });

  test("a value the held answers do not hold is new, whatever the words around it", () => {
    assert.equal(carriesNewValue("לא, עד 21 במאי", held, endOfLjubljana), true, "21 is another stop's end");
    assert.equal(carriesNewValue("no, make it the 22nd", held, endOfLjubljana), true);
    assert.equal(carriesNewValue("no, Dana is 41", held, danaAge), true, "41 is what the change itself says");
    assert.equal(carriesNewValue("no, Dana is 7", held, danaAge), true, "7 is another traveller's age");
    assert.equal(carriesNewValue("לא, 12 ימים", held, endOfLjubljana), true);
  });

  test("a number that merely collides with another held number is still new", () => {
    // May is month 5, and 10 May is the stay's own START: neither is what the END holds.
    assert.equal(carriesNewValue("לא, עד 5 במאי", held, endOfLjubljana), true);
    assert.equal(carriesNewValue("לא, עד 10 במאי", held, endOfLjubljana), true);
    assert.equal(carriesNewValue("no, until 17.5", held, endOfLjubljana), true, "a numeric month is left to the reader, not guessed");
  });

  test("nothing to read it against - no target held, a choice, an addition: any number is new", () => {
    assert.equal(carriesNewValue("no, the 17th", {}, endOfLjubljana), true);
    assert.equal(carriesNewValue("no, the 17th", held, []), true);
    assert.equal(carriesNewValue("no, the 17th", held, [{ op: "add_stop", fields: { name: "Nara" } }]), true);
    assert.equal(carriesNewValue("no, the 17th", held, [{ op: "update_stop", target: { name: "Nowhere" }, fields: { end: "2027-05-16" } }]), true);
  });
});
