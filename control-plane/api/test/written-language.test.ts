import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { writtenLanguage } from "../src/intake-copy.js";

// 2026-09-15: an organizer with an English phone wrote the whole interview in
// Hebrew and got an English trip, because nothing followed what they wrote.
describe("the language someone is writing in", () => {
  test("any Hebrew is Hebrew, even beside English words", () => {
    assert.equal(writtenLanguage("ניר"), "he");
    assert.equal(writtenLanguage("נוסעים לטוקיו ב-Airbnb"), "he");
  });

  test("an English sentence is English", () => {
    assert.equal(writtenLanguage("we are four people"), "en");
  });

  test("a place name, a code or a date says nothing about the language", () => {
    for (const text of ["Tokyo", "Kyoto Osaka", "LY 91", "19/9", "2026-09-19", "", "👍"]) {
      assert.equal(writtenLanguage(text), null, text);
    }
  });
});
