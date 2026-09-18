/**
 * One day, written two ways, is not a disagreement.
 *
 * Found by the 2026-09-13 benchmark: an organizer's notes said "Rome 2-6 May",
 * the hotel booking said 02 May 2026, and the gate asked the organizer to choose
 * between them for every start and every end — six questions about dates that
 * agree. Worse, when the notes were merged first, "2 May" became the stop's
 * start, and the site reads only ISO dates, so the stop showed no dates at all.
 */
import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { applyConflictChoice, reconcileStructured } from "../src/answer-merge.js";

const hotels = [
  { name: "Rome", start: "2026-05-02", end: "2026-05-06" },
  { name: "Florence", start: "2026-05-06", end: "2026-05-09" },
];
const notes = [
  { name: "Rome", start: "2 May", end: "6 May" },
  { name: "Florence", start: "6 May", end: "9 May" },
];

describe("dates written two ways", () => {
  test("ISO held, spoken incoming: the same days, no conflict, nothing changed", () => {
    const result = reconcileStructured(hotels, notes);
    assert.deepEqual(result.conflicts, []);
    assert.deepEqual(result.merged, hotels);
    assert.equal(result.changed, false);
  });

  test("spoken held, ISO incoming: the same days, and the ISO form is kept", () => {
    const result = reconcileStructured(notes, hotels);
    assert.deepEqual(result.conflicts, []);
    assert.deepEqual(result.merged, hotels);
    assert.equal(result.filled.length, 4, "each date upgraded once");
  });

  test("the spellings a document uses: month first, ordinals, a year, Hebrew", () => {
    for (const spoken of ["May 2", "2nd May", "2 May 2026", "02 May, 2026", "2 במאי", "2 מאי 2026", "Sept 2", "--05-02"]) {
      const held = [{ name: "Rome", start: spoken === "Sept 2" ? "2026-09-02" : "2026-05-02" }];
      const result = reconcileStructured(held, [{ name: "Rome", start: spoken }]);
      assert.deepEqual(result.conflicts, [], spoken);
    }
  });

  test("a different day, a different year, or a numeric form is still a disagreement", () => {
    for (const spoken of ["3 May", "2 May 2025", "2/5", "early May", "--05-03", "--13-02"]) {
      const result = reconcileStructured([{ name: "Rome", start: "2026-05-02" }], [{ name: "Rome", start: spoken }]);
      assert.equal(result.conflicts.length, 1, spoken);
      assert.deepEqual(result.merged, [{ name: "Rome", start: "2026-05-02" }], `${spoken}: the held value stays`);
    }
  });

  test("only date fields are read as dates", () => {
    const result = reconcileStructured([{ name: "Rome", note: "2026-05-02" }], [{ name: "Rome", note: "2 May" }]);
    assert.equal(result.conflicts.length, 1);
  });

  test("a conflict answered later still recognises a held value written the other way", () => {
    const held = [{ name: "Rome", start: "2026-05-02" }];
    const choice = applyConflictChoice(held, { entryKey: "n:|rome|2026-05-02", path: "start", held: "2 May", incoming: "2026-05-01" });
    assert.deepEqual(choice, [{ name: "Rome", start: "2026-05-01" }]);
  });
});
