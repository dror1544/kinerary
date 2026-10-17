/**
 * The gate, given the answers already held.
 *
 * Without them the gate behaves exactly as it always has: an answered question
 * refuses a proposal, which is right for a typed message. With them — which is
 * how documents are gated — a structured proposal is reconciled into the held
 * answer: it may add and fill, never replace, and anything it states
 * differently comes back as a conflict for a person rather than being applied
 * or thrown away.
 */
import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { applyProposals, type ProposedAnswer } from "../src/interpret.js";
import type { IntakeQuestion } from "../src/interview.js";

const QUESTIONS: IntakeQuestion[] = [
  { id: "destination", type: "text", prompt: "Where?", required: true },
  { id: "phases", type: "structured", prompt: "Stops?", required: true, dataShape: "array" },
  { id: "travel_anchors", type: "structured", prompt: "Bookings?", required: false, dataShape: "array" },
];

const SOURCE = [
  "Destination: Korea",
  "Hotel Gracery Shinjuku",
  "Check-in 2026-09-19",
  "Confirmation GR-4471",
  "Tokyo 2026-09-19 to 2026-09-24",
].join("\n");

const HELD = {
  destination: { kind: "text", schema_version: 3, text: "Japan" },
  phases: { kind: "structured", schema_version: 3, data: [{ name: "Tokyo", start: "2026-09-19", end: "2026-09-23" }] },
  travel_anchors: {
    kind: "structured",
    schema_version: 3,
    data: [{ type: "hotel", name: "Hotel Gracery Shinjuku", date: "2026-09-19" }],
  },
};

const CTX = {
  sourceText: SOURCE,
  outstanding: [] as string[],
  answered: ["destination", "phases", "travel_anchors"],
  questions: QUESTIONS,
};

function proposal(questionId: string, value: ProposedAnswer["value"], evidence: string, confidence = 0.9): ProposedAnswer {
  return { questionId, value, evidence, confidence, sourceMessageId: "" };
}

const confirmationFor = (confirmation: string) =>
  proposal(
    "travel_anchors",
    { kind: "structured", data: [{ type: "hotel", name: "Hotel Gracery Shinjuku", date: "2026-09-19", confirmation }] },
    `Hotel Gracery Shinjuku\nConfirmation ${confirmation}`,
  );

describe("the gate with nothing held", () => {
  test("an answered question refuses, exactly as before", () => {
    const decisions = applyProposals([confirmationFor("GR-4471")], CTX);
    assert.equal(decisions.accepted.length, 0);
    assert.equal(decisions.rejected[0]?.reason, "ALREADY_ANSWERED");
    assert.deepEqual(decisions.conflicts, []);
  });
});

describe("the gate with the answers held", () => {
  test("a confirmation fills the reference the plan's stay lacked — and says what it merged against", () => {
    const decisions = applyProposals([confirmationFor("GR-4471")], { ...CTX, held: HELD });
    assert.equal(decisions.accepted.length, 1);
    const accepted = decisions.accepted[0]!;
    assert.deepEqual((accepted.answer as { data: unknown }).data, [
      { type: "hotel", name: "Hotel Gracery Shinjuku", date: "2026-09-19", confirmation: "GR-4471" },
    ]);
    assert.equal(accepted.reconciled?.held, HELD.travel_anchors, "the write's precondition");
    assert.deepEqual(accepted.reconciled?.filled.map((f) => f.path), ["confirmation"]);
  });

  test("a different end date is a conflict — refused as nothing new, and reported", () => {
    const decisions = applyProposals(
      [proposal("phases", { kind: "structured", data: [{ name: "Tokyo", start: "2026-09-19", end: "2026-09-24" }] }, "Tokyo 2026-09-19 to 2026-09-24")],
      { ...CTX, held: HELD },
    );
    assert.equal(decisions.accepted.length, 0);
    assert.equal(decisions.rejected[0]?.reason, "NO_NEW_INFORMATION");
    assert.equal(decisions.conflicts.length, 1);
    assert.deepEqual(
      [decisions.conflicts[0]!.questionId, decisions.conflicts[0]!.path, decisions.conflicts[0]!.held, decisions.conflicts[0]!.incoming],
      ["phases", "end", "2026-09-23", "2026-09-24"],
    );
    assert.deepEqual(decisions.askAnyway, [], "an answered question is not re-asked");
  });

  test("a document that only repeats what is held is nothing new and no conflict", () => {
    const decisions = applyProposals(
      [proposal("travel_anchors", { kind: "structured", data: HELD.travel_anchors.data }, "Hotel Gracery Shinjuku\nCheck-in 2026-09-19")],
      { ...CTX, held: HELD },
    );
    assert.equal(decisions.rejected[0]?.reason, "NO_NEW_INFORMATION");
    assert.deepEqual(decisions.conflicts, []);
  });

  test("a text answer is never replaced, but a document credibly saying otherwise is reported", () => {
    const decisions = applyProposals(
      [proposal("destination", { kind: "text", text: "Korea" }, "Destination: Korea")],
      { ...CTX, held: HELD },
    );
    assert.equal(decisions.rejected[0]?.reason, "ALREADY_ANSWERED");
    assert.equal(decisions.conflicts.length, 1);
    assert.equal(decisions.conflicts[0]?.questionId, "destination");
  });

  test("an unsure or unquotable different answer raises no question", () => {
    const unsure = applyProposals(
      [proposal("destination", { kind: "text", text: "Korea" }, "Destination: Korea", 0.3)],
      { ...CTX, held: HELD },
    );
    const unquoted = applyProposals(
      [proposal("destination", { kind: "text", text: "Korea" }, "we are going to Korea")],
      { ...CTX, held: HELD },
    );
    assert.deepEqual(unsure.conflicts, []);
    assert.deepEqual(unquoted.conflicts, []);
  });

  test("two slices of one reply that disagree keep the more confident value and report the other", () => {
    const decisions = applyProposals(
      [
        proposal("travel_anchors", { kind: "structured", data: [{ type: "car", name: "Times Car Hakone", date: "2026-09-24", confirmation: "TC-1" }] },
          "Hotel Gracery Shinjuku", 0.95),
        proposal("travel_anchors", { kind: "structured", data: [{ type: "car", name: "Times Car Hakone", date: "2026-09-24", confirmation: "TC-1", pickup: "Odawara" }] },
          "Hotel Gracery Shinjuku", 0.8),
        proposal("travel_anchors", { kind: "structured", data: [{ type: "car", name: "Times Car Hakone", date: "2026-09-24", confirmation: "TC-1", pickup: "Hakone-Yumoto" }] },
          "Hotel Gracery Shinjuku", 0.75),
      ],
      { ...CTX, answered: [], outstanding: ["travel_anchors"] },
    );
    const car = ((decisions.accepted[0]?.answer as { data: Record<string, unknown>[] }).data)[0]!;
    assert.equal(car.pickup, "Odawara", "the more confident slice's value is kept");
    assert.equal(decisions.conflicts.length, 1);
    assert.equal(decisions.conflicts[0]?.incoming, "Hakone-Yumoto", "and the other is not silently dropped");
  });
});
