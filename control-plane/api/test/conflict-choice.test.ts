/**
 * Applying an organizer's decision about a disagreement between documents.
 *
 * The decision is about ONE field of ONE entry, and it is only valid while the
 * thing it was asked about is still true. Pure.
 */
import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { applyConflictChoice, entryIdentity, reconcileStructured } from "../src/answer-merge.js";

const tokyo = { name: "Tokyo", start: "2026-09-19", end: "2026-09-23", accommodation: { name: "OMO3 Asakusa" } };
const kyoto = { name: "Kyoto", start: "2026-09-23", end: "2026-09-26" };
const tokyoReturn = { name: "Tokyo", start: "2026-10-01", end: "2026-10-03" };

describe("applyConflictChoice", () => {
  test("takes the document's value for exactly the disputed field of exactly the disputed entry", () => {
    const held = [tokyo, kyoto, tokyoReturn];
    const { conflicts } = reconcileStructured(held, [{ ...tokyo, end: "2026-09-24" }]);
    assert.equal(conflicts.length, 1);

    const updated = applyConflictChoice(held, conflicts[0]!) as Record<string, unknown>[];
    assert.equal(updated.find((p) => p.start === "2026-09-19")?.end, "2026-09-24");
    assert.equal(updated.find((p) => p.start === "2026-10-01")?.end, "2026-10-03", "the return visit is untouched");
    assert.equal(updated.length, 3);
  });

  test("works on a nested field", () => {
    const held = [tokyo, kyoto];
    const { conflicts } = reconcileStructured(held, [{ ...tokyo, accommodation: { name: "Hotel Gracery Shinjuku" } }]);
    const updated = applyConflictChoice(held, conflicts[0]!) as { accommodation?: { name: string } }[];
    assert.equal(updated[0]?.accommodation?.name, "Hotel Gracery Shinjuku");
  });

  test("refuses when the question has stopped being true", () => {
    const held = [tokyo, kyoto];
    const conflict = { entryKey: entryIdentity(tokyo), path: "end", held: "2026-09-23", incoming: "2026-09-24" };

    assert.equal(applyConflictChoice([kyoto], conflict), null, "the entry is gone");
    assert.equal(
      applyConflictChoice([{ ...tokyo, end: "2026-09-25" }, kyoto], conflict),
      null,
      "the held value changed since — someone already corrected it",
    );
    assert.equal(applyConflictChoice([tokyo, { ...tokyo }], conflict), null, "the entry is no longer one entry");
    assert.notEqual(applyConflictChoice(held, conflict), null);
  });

  test("a whole-answer disagreement replaces the whole answer, while it still holds", () => {
    const conflict = { entryKey: "", path: "", held: "Japan", incoming: "Korea" };
    assert.equal(applyConflictChoice("Japan", conflict), "Korea");
    assert.equal(applyConflictChoice("Taiwan", conflict), null);
  });
});
