import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { renderQuestion } from "../src/chat-router.js";
import { INTAKE_QUESTIONS, datesInOrder, isAnswered, type AnswerStore, type IntakeAnswer } from "../src/interview.js";

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
