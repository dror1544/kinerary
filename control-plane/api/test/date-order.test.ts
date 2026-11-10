import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { renderQuestion } from "../src/chat-router.js";
import { INTAKE_QUESTIONS, datesInOrder, isAnswered, validateAnswer, type AnswerStore, type IntakeAnswer } from "../src/interview.js";

// 2026-09-16, the chaos run: a return date given before any departure was on
// record, the real departure afterwards, and a confirmed trip from 12 July to 1 July.
const returnDate = INTAKE_QUESTIONS.find((q) => q.id === "return_date")!;
const text = (t: string): IntakeAnswer => ({ kind: "text", schema_version: 3, text: t });
const trip = (start: string, end: string): AnswerStore => ({ departure_date: text(start), return_date: text(end) });

describe("the trip ends on or after the day it starts", () => {
  test("a return before the departure is not an answer", () => {
    assert.equal(datesInOrder(trip("2027-07-12", "2027-07-01")), false);
    assert.equal(isAnswered(returnDate, trip("2027-07-12", "2027-07-01")), false);
  });

  test("a same-day or later return is", () => {
    assert.equal(isAnswered(returnDate, trip("2027-07-12", "2027-07-12")), true);
    assert.equal(isAnswered(returnDate, trip("2027-07-12", "2027-07-26")), true);
  });

  test("nothing to compare yet is not a refusal", () => {
    assert.equal(isAnswered(returnDate, { return_date: text("2027-07-01") }), true);
    assert.equal(isAnswered(returnDate, trip("sometime in July", "2027-07-01")), true);
  });

  test("asking again quotes the date the way a person says it, never YYYY-MM-DD", () => {
    const he = renderQuestion(returnDate, [], "he", null, { unsettled: "2027-07-01" }).text;
    const en = renderQuestion(returnDate, [], "en", null, { unsettled: "2027-07-01" }).text;
    assert.match(he, /1 ביולי 2027/);
    assert.match(en, /July 1, 2027/);
    assert.doesNotMatch(he + en, /2027-07-01/);
  });
});

// 2026-11-08: a return typed at the summary was stored as the organizer's words ("22 בנובמבר 2026"). The worker reads
// ISO only, `datesInOrder` called the words "fine", and the trip was built for February 2027.
const departureDate = INTAKE_QUESTIONS.find((q) => q.id === "departure_date")!;

describe("a date question stores a day, never words", () => {
  test("validateAnswer stores an ISO day for words that carry their year, in both languages", () => {
    for (const [question, said, want] of [
      ["return_date", "22 בנובמבר 2026", "2026-11-22"],
      ["return_date", "22 November 2026", "2026-11-22"],
      ["departure_date", "ה-14 בנובמבר 2026", "2026-11-14"],
      ["departure_date", "2026-11-14", "2026-11-14"],
    ] as const) {
      const checked = validateAnswer(question, null, said);
      assert.ok(checked.ok, said);
      assert.deepEqual(checked.ok && checked.answer.kind === "text" ? checked.answer.text : null, want, said);
    }
  });

  test("validateAnswer refuses what it cannot make a day of - the question is asked again", () => {
    for (const said of ["next Friday", "31 June 2026", "3/4/2026", "3/4", "31 June", "22 Foo"]) {
      const checked = validateAnswer("return_date", null, said);
      assert.equal(checked.ok, false, said);
      assert.equal(!checked.ok && checked.reason, "INCOMPLETE_ANSWER", said);
    }
  });

  test("a day and month with no year is placed against the other date, else against today, and stored as ISO", () => {
    const today = new Date("2026-11-09T10:00:00Z");
    const stored = (question: string, said: string, answers?: AnswerStore) => {
      const checked = validateAnswer(question, null, said, INTAKE_QUESTIONS, undefined, undefined, { answers, today });
      return checked.ok && checked.answer.kind === "text" ? checked.answer.text : null;
    };
    // return: first such day on or after the held departure
    assert.equal(stored("return_date", "22 November", { departure_date: text("2026-11-14") }), "2026-11-22");
    assert.equal(stored("return_date", "22 בנובמבר", { departure_date: text("2026-11-14") }), "2026-11-22");
    assert.equal(stored("return_date", "3 January", { departure_date: text("2026-12-28") }), "2027-01-03", "across the new year");
    // departure: last such day on or before the held return
    assert.equal(stored("departure_date", "13 November", { return_date: text("2026-11-21") }), "2026-11-13");
    assert.equal(stored("departure_date", "28 December", { return_date: text("2027-01-03") }), "2026-12-28", "across the new year");
    // no anchor: the next such day on or after today
    assert.equal(stored("departure_date", "14 November"), "2026-11-14");
    assert.equal(stored("departure_date", "5 March"), "2027-03-05", "today is past it, so next year");
    assert.equal(stored("return_date", "22/11"), "2026-11-22");
    // cannot be placed
    assert.equal(stored("departure_date", "3/4", { return_date: text("2026-11-21") }), null, "3/4 is ambiguous");
    assert.equal(stored("return_date", "30 February", { departure_date: text("2026-11-14") }), null, "no such day");
  });

  test("a stored date in words still compares, and is made a day by canonicalize", () => {
    assert.equal(datesInOrder(trip("2026-11-14", "22 בנובמבר 2026")), true);
    assert.equal(datesInOrder(trip("2026-11-23", "22 בנובמבר 2026")), false, "words are no longer 'fine' - they are compared");
    const made = returnDate.canonicalize?.(trip("2026-11-14", "22 בנובמבר 2026"));
    assert.equal(made?.kind === "text" ? made.text : null, "2026-11-22");
    assert.equal(returnDate.canonicalize?.(trip("2026-11-14", "2026-11-22")), null, "an ISO day is left alone");
  });

  test("a stored date that reads as a date but is not a usable day is not an answer; a placeholder is left as it was", () => {
    assert.equal(isAnswered(returnDate, trip("2026-11-14", "22 בנובמבר")), false, "no year");
    assert.equal(isAnswered(departureDate, trip("22 November", "2026-11-22")), false);
    assert.equal(isAnswered(departureDate, trip("x", "x")), true, "no digit, no month word: not an attempt at a date");
  });
});
