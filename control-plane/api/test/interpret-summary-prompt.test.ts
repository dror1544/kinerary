/**
 * The interpret prompt when the SUMMARY is on the organizer's screen.
 *
 * Live, 2026-10-15: at the summary the organizer tried to add the hotel they were
 * sleeping at; the reader was shown only the unanswered questions (and the
 * answered ones as "correct only if plainly corrected"), so a hotel had no home
 * and came back `unclear`. At the summary every answerable question is offered,
 * answered or not, and a hotel is told where it lives.
 */
import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { buildInterpretPrompt } from "../src/interpret.js";
import { INTAKE_QUESTIONS, partitionQuestions } from "../src/interview.js";

const stop = { name: "Colmar", name_en: "Colmar", start: "2026-12-01", end: "2026-12-05" };
const store = () => {
  const answers: Record<string, unknown> = {};
  for (const q of INTAKE_QUESTIONS.filter((x) => x.required)) {
    answers[q.id] = q.id === "travelers"
      ? { kind: "structured", schema_version: 3, data: [{ name: "x" }] }
      : { kind: "text", schema_version: 3, text: "x" };
  }
  answers.phases = { kind: "structured", schema_version: 3, data: [stop] };
  answers.travel_anchors = { kind: "structured", schema_version: 3, data: [{ type: "flight", name: "XY1 A → B" }] };
  return answers as never;
};

describe("buildInterpretPrompt with the summary on screen", () => {
  const state = partitionQuestions(store());
  const base = {
    sourceText: "נישן במלון Hotel Le Colombier בקולמר",
    outstanding: state.outstanding,
    answered: state.answered,
    language: "he",
    correctable: [{ id: "travel_anchors", current: "XY1 A → B" }],
    heldLists: { stops: [{ id: "s1", label: "Colmar, 2026-12-01 to 2026-12-05" }], travellers: [{ id: "p1", label: "x" }] },
  };

  test("names the summary, and tells the reader where a hotel lives", () => {
    const prompt = buildInterpretPrompt({ ...base, summaryOnScreen: true });
    assert.match(prompt, /THE SUMMARY IS ON THEIR SCREEN/);
    assert.match(prompt, /ACCOMMODATION of the stop in that place: an update_stop operation/);
    assert.match(prompt, /"accommodation": \{"name":"Hotel X"\}/);
    assert.match(prompt, /Stops:\n- s1: Colmar/, "the held stops are offered, under their ids, for the operation's target");
  });

  test("describes the ANSWERED bookings question in full - not just as 'currently: …'", () => {
    const prompt = buildInterpretPrompt({ ...base, summaryOnScreen: true });
    assert.match(prompt, /- id: travel_anchors {2}\(structured\)\n {2}asks: /, "travel_anchors is described, with its field names");
    assert.match(prompt, /Questions \(answered already or not\):/);
    assert.match(prompt, /- id: constraints/);
    assert.match(prompt, /- id: trip_interests/);
    assert.match(prompt, /- id: trip_type/, "answered choices come with their options");
    assert.match(prompt, /ADDS to it or CHANGES it/, "answered questions may be added to, not only corrected");
  });

  test("the stops and travellers are still changed by operations only", () => {
    const prompt = buildInterpretPrompt({ ...base, summaryOnScreen: true });
    assert.doesNotMatch(prompt, /- id: phases {2}\(/, "no proposal path to the held stops");
    assert.doesNotMatch(prompt, /- id: travelers {2}\(/);
    assert.match(prompt, /CHANGES TO STOPS OR TRAVELLERS ALREADY GIVEN/);
  });

  test("without the summary on screen, answered questions stay out of the list", () => {
    const prompt = buildInterpretPrompt({ ...base });
    assert.doesNotMatch(prompt, /THE SUMMARY IS ON THEIR SCREEN/);
    assert.doesNotMatch(prompt, /- id: travel_anchors {2}\(structured\)/, "answered, so not offered in full mid-interview");
    assert.match(prompt, /Questions still outstanding:/);
  });

  test("stops not yet held are offered as the phases question itself", () => {
    const prompt = buildInterpretPrompt({
      ...base,
      outstanding: [...state.outstanding, "phases"],
      answered: state.answered.filter((id) => id !== "phases"),
      heldLists: { stops: [], travellers: [] },
      summaryOnScreen: true,
    });
    assert.match(prompt, /- id: phases {2}\(structured/);
  });
});
