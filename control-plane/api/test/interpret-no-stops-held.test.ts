/**
 * Staging, 2026-11-25: a hotel named at the stops question, with NO stop held yet, came back as an operation on a stop
 * that did not exist, and the change asked "which one do you mean?" with nothing to tap.
 *
 * Two layers, because a prompt is a request and not a guarantee:
 *  - the prompt must not teach stop operations while there are no stops (`changeSection`), and
 *  - whatever the model writes anyway, operations on stops while none are held ARE the answer to the stops question
 *    (`stopsAnsweredByOps`), and a reference that names nothing never asks a question with nothing to tap in it.
 */
import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { buildInterpretPrompt, changeSection } from "../src/interpret.js";
import { applyOps, stopsAnsweredByOps, type Op } from "../src/typed-changes.js";
import { renderDraft } from "../src/typed-changes-render.js";
import { draftStateFor } from "../src/typed-changes-store.js";
import type { AnswerStore } from "../src/interview.js";

const structured = (data: unknown) => ({ kind: "structured", schema_version: 3, data }) as never;
const text = (t: string) => ({ kind: "text", schema_version: 3, text: t }) as never;
const flat = (lines: string[]) => lines.join("\n");

const TRAVELLERS_ONLY = { stops: [], travellers: [{ id: "t1", label: "Dana Levi, age 40" }] };
const BOTH = { stops: [{ id: "s1", label: "Tokyo, 2027-05-10 to 2027-05-12" }], travellers: [{ id: "t1", label: "Dana Levi, age 40" }] };

describe("the prompt teaches stop operations only while there are stops to change", () => {
  test("travellers held, no stops: the stops are not an operation, and the stops question stays the stops question", () => {
    const section = flat(changeSection(TRAVELLERS_ONLY));
    assert.match(section, /t1: Dana Levi/);
    for (const op of ["add_traveller", "update_traveller", "remove_traveller"]) assert.ok(section.includes(`"op":"${op}"`), op);
    for (const op of ["add_stop", "update_stop", "remove_stop", "rename_stop", "replace_stop", "move_stop"]) {
      assert.equal(section.includes(`"op":"${op}"`), false, `${op} is not taught while no stop is held`);
    }
    assert.doesNotMatch(section, /"phases" or "travelers"/, "it must not forbid proposing the stops question");
    assert.match(section, /stops are not held yet/i, "it says why");
    assert.match(section, /"phases"/, "and says where a place to stay goes");
  });

  test("the whole prompt for a stops question with travellers already answered still proposes `phases`", () => {
    const prompt = buildInterpretPrompt({
      sourceText: "flight, hotel", outstanding: ["phases", "travel_anchors"], language: "he", heldLists: TRAVELLERS_ONLY,
    });
    assert.doesNotMatch(prompt, /do NOT\s+propose the "phases"/);
    assert.doesNotMatch(prompt, /"op":"update_stop"/);
    assert.match(prompt, /ABOUT STOPS/);
  });

  test("stops held (with or without travellers): the stop operations are taught as before", () => {
    for (const held of [BOTH, { stops: BOTH.stops, travellers: [] }]) {
      const section = flat(changeSection(held));
      for (const op of ["add_stop", "update_stop", "remove_stop", "rename_stop", "replace_stop", "move_stop"]) assert.ok(section.includes(`"op":"${op}"`), op);
    }
    const stopsOnly = flat(changeSection({ stops: BOTH.stops, travellers: [] }));
    assert.equal(stopsOnly.includes('"op":"add_traveller"'), false, "no traveller operations when no traveller is held");
    assert.match(stopsOnly, /do NOT\s+propose the "phases" question and do NOT write out a list/);
    assert.match(flat(changeSection(BOTH)), /do NOT\s+propose the "phases" or "travelers" question and do NOT write out a list/);
  });

  test("nothing held: no section at all", () => {
    assert.deepEqual(changeSection({ stops: [], travellers: [] }), []);
  });
});

const TRIP: AnswerStore = {
  destination: text("Slovenia"),
  departure_date: text("2027-05-10"),
  return_date: text("2027-05-17"),
  travelers: structured([{ name: "Dana Levi", age: 40 }]),
};
const hotelAt = (place: string, extra: Record<string, unknown> = {}): Op =>
  ({ op: "update_stop", target: { name: place }, fields: { accommodation: { name: "Grand Hotel", confirmation: "GU-4471" }, ...extra } });

describe("stopsAnsweredByOps: operations on stops, with none held, are the answer to the stops question", () => {
  test("a stay at a place that is no stop becomes that stop, with the hotel, on the trip's own dates", () => {
    const read = stopsAnsweredByOps([hotelAt("לובליאנה")], TRIP);
    assert.ok(read);
    assert.deepEqual(read.stops, [{ name: "לובליאנה", accommodation: { name: "Grand Hotel", confirmation: "GU-4471" }, start: "2027-05-10", end: "2027-05-17" }]);
    assert.deepEqual(read.rest, []);
  });

  test("dates the message gave are kept, not overwritten by the trip's", () => {
    const read = stopsAnsweredByOps([hotelAt("Ljubljana", { start: "2027-05-10", end: "2027-05-14" })], TRIP);
    assert.deepEqual(read?.stops.map((s) => [s.start, s.end]), [["2027-05-10", "2027-05-14"]]);
  });

  test("several places: nobody gets the whole trip's dates by default", () => {
    const read = stopsAnsweredByOps([
      { op: "add_stop", fields: { name: "A" } }, hotelAt("B"),
    ], TRIP);
    assert.deepEqual(read?.stops.map((s) => [s.name, s.start ?? null, s.end ?? null]), [["A", null, null], ["B", null, null]]);
  });

  test("an add and an update of the same place are one stop", () => {
    const read = stopsAnsweredByOps([{ op: "add_stop", fields: { name: "A", start: "2027-05-10", end: "2027-05-12" } }, hotelAt("A")], TRIP);
    assert.equal(read?.stops.length, 1);
    assert.deepEqual(read?.stops[0], { name: "A", start: "2027-05-10", end: "2027-05-12", accommodation: { name: "Grand Hotel", confirmation: "GU-4471" } });
  });

  test("replace_stop on nothing is an add; a removal or a move of nothing is left for the person to be told", () => {
    const read = stopsAnsweredByOps([
      { op: "replace_stop", target: { name: "A" }, fields: { name: "B" } },
      { op: "remove_stop", target: { name: "C" } },
      { op: "update_traveller", target: { name: "Dana" }, fields: { age: 41 } },
    ], TRIP);
    assert.deepEqual(read?.stops.map((s) => s.name), ["B"]);
    assert.deepEqual(read?.rest.map((o) => o.op), ["remove_stop", "update_traveller"], "what is not a stop answer, in order");
  });

  test("not when stops are held: that is a change, shown and confirmed", () => {
    assert.equal(stopsAnsweredByOps([hotelAt("A")], { ...TRIP, phases: structured([{ name: "A" }]) }), null);
  });

  test("not when there is nothing about a stop in it, or no name to make a stop of", () => {
    assert.equal(stopsAnsweredByOps([{ op: "update_traveller", target: { name: "Dana" }, fields: { age: 41 } }], TRIP), null);
    assert.equal(stopsAnsweredByOps([{ op: "update_stop", target: { id: "s1" }, fields: { start: "2027-05-10" } }], TRIP), null);
  });

  test("trip dates that are not a real range are not used", () => {
    for (const dates of [{ departure_date: text("2027-05-17"), return_date: text("2027-05-10") }, { departure_date: text("x"), return_date: text("y") }, { departure_date: undefined, return_date: undefined }]) {
      const read = stopsAnsweredByOps([hotelAt("A")], { ...TRIP, ...dates } as AnswerStore);
      assert.deepEqual(read?.stops.map((s) => [s.start ?? null, s.end ?? null]), [[null, null]]);
    }
  });
});

describe("a reference that names nothing never asks a question with nothing to tap in it", () => {
  const ask = (answers: AnswerStore, ops: Op[]) => {
    const state = draftStateFor(answers, ops);
    return renderDraft({ id: "pchg_x", ops, base: state.base, result: state.result, preview: state.preview, unresolved: state.unresolved, blocked: state.blocked }, "en");
  };

  test("stops held, the place is not among them: every held stop is offered, and the cancel button", () => {
    const answers: AnswerStore = { ...TRIP, phases: structured([{ name: "Tokyo", start: "2027-05-10", end: "2027-05-12" }, { name: "Kyoto", start: "2027-05-13", end: "2027-05-17" }]) };
    const rendered = ask(answers, [hotelAt("Osaka")]);
    const rows = rendered.replyMarkup!.inline_keyboard;
    assert.equal(rows.length, 3, "Tokyo, Kyoto, cancel");
    assert.match(rendered.text, /Which one do you mean by "Osaka"\?/);
    assert.deepEqual(rows.slice(0, 2).map((r) => r[0]!.text.split(" ")[0]), ["Tokyo", "Kyoto"], "there is something to tap");
  });

  test("nothing held at all: no 'tap one', and no pretence there is anything to pick - cancel, or say what to add", () => {
    const outcome = applyOps(TRIP, [{ op: "remove_stop", target: { name: "Osaka" } }]);
    assert.equal(outcome.ok, false);
    const rendered = ask(TRIP, [{ op: "remove_stop", target: { name: "Osaka" } }]);
    assert.doesNotMatch(rendered.text, /tap one/i);
    assert.match(rendered.text, /couldn't find "Osaka" among your stops/);
    assert.equal(rendered.replyMarkup!.inline_keyboard.length, 1, "only the cancel button");
  });
});
