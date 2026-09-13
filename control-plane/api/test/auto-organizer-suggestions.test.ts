import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { suggestionTapData } from "../tools/organizer-suggestions.js";
import type { IntakeQuestion } from "../src/interview.js";

// Regression, 2026-09-13: the automated organizer's `answer()` always tapped
// `a:${q.id}:${option}` for a choice question, never checking whether the
// question currently on screen was rendered as a document Yes/No suggestion
// (`y:${q.id}` / `x:${q.id}`) rather than its normal options. The 'multi'
// scenario's own document proposes `trip_type: family` below the confidence
// floor, so it renders as a suggestion — the tool tapped a button that was
// never sent, waited out BUTTON_PATIENCE, and the whole run stalled and
// failed. A scenario's scripted answers are written to match what its own
// documents say, so accepting a suggestion is the right move whenever one is
// on screen — not just for `choice` questions.
const Q = (id: string, type: IntakeQuestion["type"] = "choice"): IntakeQuestion =>
  ({ id, type, required: true } as IntakeQuestion);

describe("suggestionTapData", () => {
  test("taps Yes when the current question has a pending suggestion", () => {
    assert.equal(suggestionTapData(Q("trip_type"), { trip_type: { optionId: "family" } }), "y:trip_type");
  });

  test("is not fooled by a suggestion on a DIFFERENT question", () => {
    assert.equal(suggestionTapData(Q("trip_type"), { dietary: { optionId: "vegetarian" } }), null);
  });

  test("defers to the normal answer path when there is no suggestion", () => {
    assert.equal(suggestionTapData(Q("trip_type"), {}), null);
  });

  test("applies to every question type, not only choice", () => {
    assert.equal(suggestionTapData(Q("travelers", "structured"), { travelers: { structuredData: [] } }), "y:travelers");
    assert.equal(suggestionTapData(Q("dietary", "multi_choice"), { dietary: { optionIds: ["vegetarian"] } }), "y:dietary");
  });
});
