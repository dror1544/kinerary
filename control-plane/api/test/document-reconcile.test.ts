/**
 * Reconciling several documents' answers into one trip — the failures a real
 * 22-file booking folder showed on 2026-09-13
 * (docs/test-reports/document-intake-real-booking-folder-2026-09-13.md).
 * Deterministic: no model, no database. Every name, place and code below is
 * invented; none comes from that folder.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, test } from "node:test";
import { reconcileStructured, samePerson } from "../src/answer-merge.js";
import { clockTime, normaliseDatesAndTimes, tripWindow } from "../src/document-dates.js";
import { gateDocumentProposals } from "../src/document-gate.js";
import { applyProposals, type ProposedAnswer } from "../src/interpret.js";
import { INTAKE_QUESTIONS } from "../src/interview.js";

const ALL = INTAKE_QUESTIONS.map((q) => q.id);

describe("samePerson — one traveller, however a document prints the name", () => {
  test("order, commas, slashes, case and titles aside", () => {
    assert.equal(samePerson("Noa Barak", "BARAK, NOA"), true);
    assert.equal(samePerson("Noa Barak", "BARAK/NOA MS"), true);
    assert.equal(samePerson("Noa Barak", "noa barak"), true);
  });

  test("a middle name printed on one document and not another", () => {
    assert.equal(samePerson("Noa Barak", "Noa Lee Barak"), true);
    assert.equal(samePerson("BARAK/NOA LEE MS", "Noa Barak"), true);
  });

  test("given names a ticket runs together", () => {
    assert.equal(samePerson("Noa Lee Barak", "BARAK/NOALEE"), true);
  });

  test("a word cut short at its start by a clipped PDF column", () => {
    assert.equal(samePerson("Noa Barak", "ARAK/NOA"), true);
    assert.equal(samePerson("Noa Lee Barak", "ARAK/NOALEE"), true);
    assert.equal(samePerson("Noa Barak", "ARAK/NOA LEE"), true, "clipped, and with a middle name the other printing lacks");
  });

  test("a letter dropped from the end, when two other words agree", () => {
    assert.equal(samePerson("Moran Lee Barak", "Mora Lee Barak"), true);
    assert.equal(samePerson("Moran Barak", "Mora Barak"), false, "one agreeing word is not enough");
  });

  test("different people stay different", () => {
    assert.equal(samePerson("Noa Barak", "Tal Barak"), false);
    assert.equal(samePerson("Noa Barak", "Noa"), false, "a lone given name is not enough");
    assert.equal(samePerson("Noa Barak", "Noa Karak"), false, "a different letter is not a clipped one");
    assert.equal(samePerson("Noa Barak", "RAK/NOA"), false, "too little left to be the same surname");
    assert.equal(samePerson("Dan Barak", "Idan Barak"), false, "a short name inside a longer one is another name");
  });
});

describe("reconcileStructured with people — no phantom travellers, no false questions", () => {
  const held = [
    { name: "Noa Barak", name_en: "Noa Barak" },
    { name: "Tal Lee Barak", name_en: "Tal Lee Barak" },
  ];

  test("a surname-first printing of a held traveller is neither added nor asked about", () => {
    const step = reconcileStructured(held, [{ name: "BARAK, NOA", name_en: "Noa Barak" }], { people: true });
    assert.equal((step.merged as unknown[]).length, 2);
    assert.deepEqual(step.conflicts, []);
    assert.equal(step.changed, false);
  });

  test("the same traveller without a middle name, or with a clipped surname, is the held one", () => {
    const step = reconcileStructured(held, [{ name: "Tal Barak" }, { name: "ARAK/NOA" }], { people: true });
    assert.equal((step.merged as unknown[]).length, 2);
    assert.deepEqual(step.conflicts, []);
  });

  test("a name two held travellers could both be is ambiguous, not merged into either", () => {
    const twoTals = [{ name: "Tal Lee Barak" }, { name: "Tal Ron Barak" }];
    const step = reconcileStructured(twoTals, [{ name: "Tal Barak" }], { people: true });
    assert.equal((step.merged as unknown[]).length, 2);
    assert.equal(step.ambiguous.length, 1);
  });

  test("a new person is still added", () => {
    const step = reconcileStructured(held, [{ name: "Maya Barak" }], { people: true });
    assert.equal((step.merged as unknown[]).length, 3);
  });

  test("place names keep exact matching: 'South Harbour' is not 'Harbour'", () => {
    const stops = [{ name: "Harbour", start: "2027-03-04", end: "2027-03-06" }];
    const step = reconcileStructured(stops, [{ name: "South Harbour", start: "2027-03-04", end: "2027-03-06" }]);
    assert.equal((step.merged as unknown[]).length, 2);
  });

  test("a booking matched by its reference is not disputed over its label", () => {
    const held = [{ type: "flight", name: "XY 305 Home-Gateway", date: "2027-07-05", confirmation: "QW7ER2" }];
    const step = reconcileStructured(held, [{ type: "flight", name: "Sky Air XY 305", date: "2027-07-05", time: "01:00", confirmation: "QW7ER2" }]);
    assert.equal((step.merged as unknown[]).length, 1);
    assert.deepEqual(step.conflicts, []);
    assert.equal((step.merged as Record<string, unknown>[])[0]!.time, "01:00", "what it adds is still filled");
  });

  test("a stop's hotel is still a fact: two hotel names for one stay are asked about", () => {
    const stops = [{ name: "Harbour", start: "2027-07-05", end: "2027-07-08", accommodation: { name: "Harbour Inn" } }];
    const step = reconcileStructured(stops, [{ name: "Harbour", start: "2027-07-05", end: "2027-07-08", accommodation: { name: "Cliff Hotel" } }]);
    assert.equal(step.conflicts.length, 1);
    assert.equal(step.conflicts[0]!.path, "accommodation.name");
  });
});

describe("clockTime — the one form the site places on a day", () => {
  test("24-hour and 12-hour clocks become HH:MM", () => {
    assert.equal(clockTime("15:47"), "15:47");
    assert.equal(clockTime("9:30"), "09:30");
    assert.equal(clockTime("12:21 PM"), "12:21");
    assert.equal(clockTime("3:10 pm"), "15:10");
    assert.equal(clockTime("12:05 AM"), "00:05");
  });

  test("a range or words are not a time", () => {
    assert.equal(clockTime("15:00 - 22:00"), null);
    assert.equal(clockTime("from 16:00"), null);
    assert.equal(clockTime("noon"), null);
    assert.equal(clockTime(""), null);
  });
});

describe("normaliseDatesAndTimes — a date with no year completed from the trip", () => {
  const window = { start: "2027-06-30", end: "2027-07-24" };

  test("the one year that puts the day inside the trip", () => {
    const out = normaliseDatesAndTimes([{ name: "Harbour", start: "--07-02", end: "--07-05" }], window) as Record<string, unknown>[];
    assert.deepEqual(out, [{ name: "Harbour", start: "2027-07-02", end: "2027-07-05" }]);
  });

  test("a day past the trip's known dates still takes the trip's year", () => {
    // A document may extend a stay, or date a part of the trip no other document covers yet.
    assert.deepEqual(normaliseDatesAndTimes([{ name: "Harbour", end: "--07-26" }], window), [{ name: "Harbour", end: "2027-07-26" }]);
    assert.deepEqual(normaliseDatesAndTimes([{ name: "Harbour", start: "--09-01" }], window), [{ name: "Harbour", start: "2027-09-01" }]);
  });

  test("a day two years could explain, or no trip dates at all, is left out rather than guessed", () => {
    assert.deepEqual(normaliseDatesAndTimes([{ name: "Harbour", start: "--01-15" }], window), [{ name: "Harbour" }]);
    assert.deepEqual(normaliseDatesAndTimes([{ name: "Harbour", start: "--07-02" }], null), [{ name: "Harbour" }]);
  });

  test("a trip over New Year takes each day's own year", () => {
    const winter = { start: "2027-12-28", end: "2028-01-04" };
    assert.deepEqual(
      normaliseDatesAndTimes([{ type: "hotel", name: "Lodge", date: "--12-30" }, { type: "activity", name: "Show", date: "--01-02" }], winter),
      [{ type: "hotel", name: "Lodge", date: "2027-12-30" }, { type: "activity", name: "Show", date: "2028-01-02" }],
    );
  });

  test("an anchor's time becomes HH:MM, and one that is not a time is dropped", () => {
    assert.deepEqual(
      normaliseDatesAndTimes([{ type: "flight", name: "XY 101", date: "2027-07-01", time: "3:10 PM" }, { type: "hotel", name: "Lodge", time: "15:00 - 22:00" }], window),
      [{ type: "flight", name: "XY 101", date: "2027-07-01", time: "15:10" }, { type: "hotel", name: "Lodge" }],
    );
  });

  test("tripWindow spans every ISO day given, and ignores anything else", () => {
    assert.deepEqual(tripWindow([{ kind: "text", text: "2027-07-01" }, [{ date: "2027-07-24" }, { start: "--06-01" }], "2027-06-30"]), window);
    assert.equal(tripWindow([{ start: "--07-02" }]), null);
  });
});

describe("applyProposals — several documents in one burst", () => {
  const SOURCE = [
    "XY 101 Sun 04JUL 10:15 Home - Gateway",
    "XY 305 Mon 05JUL 01:00 Home - Gateway",
    "XY 102 Fri 23JUL 13:30 Coast - Home",
    "Harbour Inn CHECK-IN 5 JULY CHECK-OUT 8 JULY",
    "Hotel address: Harbour, Coastland",
    "Mountain lodge, Ridge",
  ].join("\n");
  // Each proposal from its own document, as in a burst: one reading per file.
  let documents = 0;
  const proposal = (questionId: string, value: ProposedAnswer["value"], evidence: string, confidence = 0.95): ProposedAnswer =>
    ({ questionId, value, confidence, evidence, sourceMessageId: `doc-${(documents += 1)}` });
  const decide = (proposals: ProposedAnswer[]) => applyProposals(proposals, { sourceText: SOURCE, outstanding: ALL, answered: [] });
  const textOf = (decisions: ReturnType<typeof decide>, id: string) =>
    (decisions.accepted.find((a) => a.questionId === id)?.answer as { text?: string } | undefined)?.text;

  test("two itineraries starting the trip on different days: the trip starts with the first", () => {
    const decisions = decide([
      proposal("departure_date", { kind: "text", text: "2027-07-05" }, "XY 305 Mon 05JUL 01:00 Home - Gateway", 0.99),
      proposal("departure_date", { kind: "text", text: "2027-07-04" }, "XY 101 Sun 04JUL 10:15 Home - Gateway", 0.95),
    ]);
    assert.equal(textOf(decisions, "departure_date"), "2027-07-04");
  });

  test("and ends with the last", () => {
    const decisions = decide([
      proposal("return_date", { kind: "text", text: "2027-07-23" }, "XY 102 Fri 23JUL 13:30 Coast - Home", 0.9),
      proposal("return_date", { kind: "text", text: "2027-07-22" }, "XY 305 Mon 05JUL 01:00 Home - Gateway", 0.99),
    ]);
    assert.equal(textOf(decisions, "return_date"), "2027-07-23");
  });

  test("two documents naming different destinations: asked, not decided by confidence", () => {
    const decisions = decide([
      proposal("destination", { kind: "text", text: "Harbour" }, "Hotel address: Harbour, Coastland", 0.99),
      proposal("destination", { kind: "text", text: "Ridge" }, "Mountain lodge, Ridge", 0.97),
    ]);
    assert.equal(textOf(decisions, "destination"), undefined);
    assert.equal(decisions.rejected.filter((r) => r.reason === "CONFLICTING_PROPOSALS").length, 2);
    assert.ok(decisions.askAnyway.includes("destination"));
  });

  test("two documents saying the same thing are one answer, not a disagreement", () => {
    const decisions = decide([
      proposal("return_date", { kind: "text", text: "2027-07-23" }, "XY 102 Fri 23JUL 13:30 Coast - Home"),
      proposal("return_date", { kind: "text", text: "2027-07-23" }, "XY 102 Fri 23JUL 13:30 Coast - Home"),
    ]);
    assert.equal(textOf(decisions, "return_date"), "2027-07-23");
    assert.ok(!decisions.rejected.some((r) => r.reason === "CONFLICTING_PROPOSALS"));
  });

  test("a hotel stay with no year is dated from another document's flights, through the document gate", async () => {
    const { gateDocumentProposals } = await import("../src/document-gate.js");
    type Reading = Parameters<typeof gateDocumentProposals>[0][number];
    const flights = "XY 101 Sun 04JUL 10:15 Home - Gateway\nXY 102 Fri 23JUL 1:30 PM Coast - Home";
    const hotel = "Harbour Inn CHECK-IN 5 JULY CHECK-OUT 8 JULY";
    const reading = (documentId: string, text: string, proposals: ProposedAnswer[]): Reading =>
      ({ documentId, text, payload: { proposals, unclear: [] } as unknown as Reading["payload"] });
    const { decisions } = gateDocumentProposals([
      reading("doc-flights", flights, [proposal("travel_anchors", { kind: "structured", data: [
        { type: "flight", name: "XY 101", date: "2027-07-04", time: "10:15" },
        { type: "flight", name: "XY 102", date: "2027-07-23", time: "1:30 PM" },
      ] }, flights)]),
      reading("doc-hotel", hotel, [proposal("phases", { kind: "structured", data: [
        { name: "Harbour", start: "--07-05", end: "--07-08", accommodation: { name: "Harbour Inn" } },
      ] }, hotel)]),
    ], { outstanding: ALL, answered: [] });

    const phases = decisions.accepted.find((a) => a.questionId === "phases");
    assert.ok(phases, JSON.stringify(decisions.rejected));
    assert.deepEqual((phases.answer as unknown as { data: unknown }).data, [
      { name: "Harbour", start: "2027-07-05", end: "2027-07-08", accommodation: { name: "Harbour Inn" } },
    ]);
    const anchors = decisions.accepted.find((a) => a.questionId === "travel_anchors");
    assert.ok(anchors, JSON.stringify(decisions.rejected));
    assert.deepEqual((anchors.answer as unknown as { data: { time: string }[] }).data.map((a) => a.time), ["10:15", "13:30"]);
  });

  test("two documents naming different destinations are asked about through the document gate too", async () => {
    const { gateDocumentProposals } = await import("../src/document-gate.js");
    type Reading = Parameters<typeof gateDocumentProposals>[0][number];
    const reading = (documentId: string, text: string, proposals: ProposedAnswer[]): Reading =>
      ({ documentId, text, payload: { proposals, unclear: [] } as unknown as Reading["payload"] });
    // The model leaves sourceMessageId empty on a document: the reading decides the source.
    const bare = (p: ProposedAnswer): ProposedAnswer => ({ ...p, sourceMessageId: "" });
    const { decisions } = gateDocumentProposals([
      reading("doc-a", "Hotel address: Harbour, Coastland", [bare(proposal("destination", { kind: "text", text: "Harbour" }, "Hotel address: Harbour, Coastland"))]),
      reading("doc-b", "Mountain lodge, Ridge", [bare(proposal("destination", { kind: "text", text: "Ridge" }, "Mountain lodge, Ridge"))]),
    ], { outstanding: ALL, answered: [] });
    assert.ok(!decisions.accepted.some((a) => a.questionId === "destination"));
    assert.ok(decisions.askAnyway.includes("destination"));
  });

  test("a document's disagreement stays traceable to that document — the gate keeps the reading's own proposal", async () => {
    const { gateDocumentProposals } = await import("../src/document-gate.js");
    type Reading = Parameters<typeof gateDocumentProposals>[0][number];
    const text = "Harbour Inn CHECK-IN 5 JULY CHECK-OUT 9 JULY";
    const own = proposal("phases", { kind: "structured", data: [{ name: "Harbour", start: "--07-05", end: "--07-09" }] }, text);
    const held = { phases: { kind: "structured", schema_version: 3, data: [{ name: "Harbour", start: "2027-07-05", end: "2027-07-08" }] } };
    const reading: Reading = { documentId: "doc-hotel", text, payload: { proposals: [own], unclear: [] } as unknown as Reading["payload"] };
    const gated = gateDocumentProposals([reading], { outstanding: ALL.filter((id) => id !== "phases"), answered: ["phases"], held });

    const [conflict] = gated.decisions.conflicts;
    assert.ok(conflict, JSON.stringify(gated.decisions.rejected));
    assert.equal(conflict.path, "end");
    assert.equal(conflict.incoming, "2027-07-09", "the year was completed before comparing, from the stay already held");
    // The relay finds a conflict's document by this object's identity
    // (recordDocumentOutcomes). Handed a copy, it dropped the conflict without a word.
    assert.equal(conflict.proposal, own);
    assert.equal(gated.documentOf(conflict.proposal), "doc-hotel");
  });

  test("travellers printed two ways by two documents are one list, with no question", () => {
    const decisions = decide([
      proposal("travelers", { kind: "structured", data: [{ name: "Noa Barak", name_en: "Noa Barak" }, { name: "Tal Lee Barak", name_en: "Tal Lee Barak" }] }, "Hotel address: Harbour, Coastland", 0.99),
      proposal("travelers", { kind: "structured", data: [{ name: "BARAK, NOA", name_en: "Noa Barak" }, { name: "Tal Barak", name_en: "Tal Barak" }] }, "Mountain lodge, Ridge", 0.95),
    ]);
    const travelers = decisions.accepted.find((a) => a.questionId === "travelers");
    assert.ok(travelers, JSON.stringify(decisions.rejected));
    assert.equal(((travelers.answer as unknown as { data: unknown[] }).data).length, 2);
    assert.deepEqual(decisions.conflicts, []);
  });
});

// ── #412: two tickets for two parties on the same flight ─────────────────────
//
// The fixture is two invented ticket texts (same flight, same date, different
// booking references and passengers) and the model readings recorded for them.
// `gateDocumentProposals` is the production gate; only the model is absent.

describe("two tickets for two parties (#412)", () => {
  const dir = new URL("./fixtures/two-parties-same-flight/", import.meta.url);
  const ticket1 = readFileSync(new URL("ticket-1.txt", dir), "utf8");
  const ticket2 = readFileSync(new URL("ticket-2.txt", dir), "utf8");
  type Recorded = { confidence: number; evidence: string; data: unknown[] };
  const recorded = JSON.parse(readFileSync(new URL("readings.json", dir), "utf8")) as Record<string, Recorded>;

  const reading = (documentId: string, text: string, key: string, confidence?: number) => {
    const r = recorded[key]!;
    const proposal: ProposedAnswer = {
      questionId: "travelers",
      value: { kind: "structured", data: structuredClone(r.data) },
      confidence: confidence ?? r.confidence,
      evidence: r.evidence,
      sourceMessageId: "",
    };
    return { documentId, text, payload: { proposals: [proposal], unclear: [] } as never };
  };
  const gate = (second: ReturnType<typeof reading>, held?: Record<string, unknown>) =>
    gateDocumentProposals(
      held ? [second] : [reading("doc-1", ticket1, "ticket-1"), second],
      held
        ? { outstanding: ALL.filter((id) => id !== "travelers"), answered: ["travelers"], held }
        : { outstanding: ALL, answered: [] },
    );
  const namesEn = (answer: unknown) => ((answer as { data: { name_en: string }[] } | undefined)?.data ?? []).map((p) => p.name_en).sort();
  const BOTH = ["ARLO VESPER", "BRIA TALLIS", "COLE TALLIS", "LENA VESPER"];
  const FIRST = ["ARLO VESPER", "LENA VESPER"];

  test("two tickets for two parties give all four travellers", () => {
    const { decisions, sources } = gate(reading("doc-2", ticket2, "ticket-2-sure"));
    const travelers = decisions.accepted.find((a) => a.questionId === "travelers");
    assert.ok(travelers, JSON.stringify(decisions.rejected));
    assert.deepEqual(namesEn(travelers.answer), BOTH);
    assert.deepEqual(sources.get("travelers")?.sort(), ["doc-1", "doc-2"], "the answer names both tickets");
    assert.deepEqual(decisions.suggested, []);
  });

  test("a low-confidence second party is suggested, not dropped", () => {
    const { decisions } = gate(reading("doc-2", ticket2, "ticket-2-unsure"));
    const accepted = decisions.accepted.find((a) => a.questionId === "travelers");
    assert.ok(accepted, JSON.stringify(decisions.rejected));
    assert.deepEqual(namesEn(accepted.answer), FIRST, "only the sure ticket is written");

    assert.equal(decisions.suggested.length, 1, `the unsure couple must be offered — rejected: ${JSON.stringify(decisions.rejected.map((r) => r.reason))}`);
    const offer = decisions.suggested[0]!;
    assert.equal(offer.questionId, "travelers");
    assert.deepEqual(namesEn(offer.answer), BOTH, "a Yes writes the union, never the unsure couple alone");
    assert.deepEqual(namesEn(offer.proposal.value), BOTH, "and what the relay stores is the same union");
    assert.ok(decisions.rejected.some((r) => r.questionId === "travelers" && r.reason === "LOW_CONFIDENCE"), "the refusal is still on record");
  });

  test("an unsure ticket that adds nobody is not offered", () => {
    const { decisions } = gateDocumentProposals(
      [reading("doc-1", ticket1, "ticket-1"), reading("doc-2", ticket1, "ticket-1", 0.3)],
      { outstanding: ALL, answered: [] },
    );
    assert.deepEqual(decisions.suggested, []);
    assert.deepEqual(namesEn(decisions.accepted.find((a) => a.questionId === "travelers")?.answer), FIRST);
  });

  test("a traveller slice quoted in the interview's script passes when name_en is printed", () => {
    const { decisions, sources } = gate(reading("doc-2", ticket2, "ticket-2-hebrew-evidence"));
    const travelers = decisions.accepted.find((a) => a.questionId === "travelers");
    assert.ok(travelers, `rejected: ${JSON.stringify(decisions.rejected.map((r) => `${r.questionId}:${r.reason}`))}`);
    assert.deepEqual(namesEn(travelers.answer), BOTH);
    assert.deepEqual(sources.get("travelers")?.sort(), ["doc-1", "doc-2"]);
    assert.ok(!decisions.rejected.some((r) => r.reason === "EVIDENCE_NOT_IN_SOURCE"));
  });

  test("an unsure reading whose evidence is in the interview's script is still offered (both causes at once)", () => {
    const { decisions } = gate(reading("doc-2", ticket2, "ticket-2-hebrew-evidence", 0.5));
    assert.deepEqual(namesEn(decisions.accepted.find((a) => a.questionId === "travelers")?.answer), FIRST);
    assert.deepEqual(namesEn(decisions.suggested[0]?.answer), BOTH);
  });

  test("script evidence does NOT pass when a name_en is not printed in the ticket", () => {
    const r = reading("doc-2", ticket2, "ticket-2-hebrew-evidence");
    // One name the ticket never printed: the model made her up.
    ((r.payload.proposals[0] as ProposedAnswer).value as { data: { name_en: string }[] }).data[1]!.name_en = "DINA MARLOW";
    const { decisions } = gate(r);
    assert.deepEqual(namesEn(decisions.accepted.find((a) => a.questionId === "travelers")?.answer), FIRST);
    assert.ok(decisions.rejected.some((x) => x.reason === "EVIDENCE_NOT_IN_SOURCE"), "refused, as before");
    assert.deepEqual(decisions.suggested, [], "and an invented traveller is not offered either");
  });

  test("a name_en printed only in ANOTHER ticket does not satisfy this ticket's evidence", () => {
    // Ticket 2's slice claims ticket 1's people while quoting script text:
    // each proposal must quote its own document.
    const r = reading("doc-2", ticket2, "ticket-2-hebrew-evidence");
    ((r.payload.proposals[0] as ProposedAnswer).value as { data: unknown[] }).data = structuredClone(recorded["ticket-1"]!.data);
    const { decisions } = gate(r);
    assert.ok(decisions.rejected.some((x) => x.reason === "EVIDENCE_NOT_IN_SOURCE"));
  });

  test("a later upload's unsure couple is offered on top of the held couple (the gate half of AC-4)", () => {
    const held = { travelers: { kind: "structured", schema_version: 3, data: structuredClone(recorded["ticket-1"]!.data) } };
    const { decisions } = gate(reading("doc-2", ticket2, "ticket-2-unsure"), held);
    assert.deepEqual(decisions.accepted, []);
    assert.deepEqual(namesEn(decisions.suggested[0]?.answer), BOTH);
  });

  test("a sure second couple beside a held couple is added, and nothing is left to ask", () => {
    const held = { travelers: { kind: "structured", schema_version: 3, data: structuredClone(recorded["ticket-1"]!.data) } };
    const { decisions } = gate(reading("doc-2", ticket2, "ticket-2-sure"), held);
    assert.deepEqual(namesEn(decisions.accepted[0]?.answer), BOTH);
    assert.deepEqual(decisions.suggested, []);
  });
});
