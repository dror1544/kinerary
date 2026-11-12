/**
 * #548: a dashboard-seeded interview opens with the greeting and one short explanation, and nothing else in that
 * message. What the older greeting body said that is still needed (the document offer; for an account with an earlier
 * trip, the note that it is untouched) follows as its own message. No database: this is the opening's shape.
 */
import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { renderDocumentOffer, renderOpeningMessages } from "../src/chat-router.js";
import { uiString } from "../src/intake-copy.js";

const seeded = { destination: "Gatecity", departureDate: "2026-11-14", returnDate: "2026-11-21", organizerName: "Arlo" };
const seededHe = { ...seeded, destination: "גייטסיטי", organizerName: "ארלו" };

describe("#548 the seeded opening is a greeting, one explanation, and then its own messages", () => {
  test("AC-17 the first message, exactly, in English", () => {
    const [first] = renderOpeningMessages("en", false, seeded);
    assert.equal(first!.text, "Hi Arlo, Gatecity in November. How exciting! 🎉\nA few quick questions will fill in your trip's details.");
    assert.equal(first!.replyMarkup, null);
  });

  test("AC-17 the first message, exactly, in Hebrew (plural voice, name and destination as given)", () => {
    const [first] = renderOpeningMessages("he", false, seededHe);
    assert.equal(first!.text, "היי ארלו, גייטסיטי בנובמבר. איזה כיף! 🎉\nכמה שאלות קצרות ישלימו את פרטי הטיול.");
    assert.equal(first!.replyMarkup, null);
  });

  test("AC-17 none of the introduction's paragraphs (bar the returning note) is in any message of a seeded opening", () => {
    for (const language of ["en", "he"] as const) {
      for (const returning of [false, true]) {
        const intro = uiString(returning ? "introductionReturning" : "introduction", language);
        const messages = renderOpeningMessages(language, returning, seeded);
        for (const m of messages) {
          // The one paragraph a returning account still needs is kept, as the note in its own message (AC-18).
          for (const paragraph of intro.split("\n\n").filter((p) => p !== uiString("seedReturningNote", language))) assert.ok(!m.text.includes(paragraph), `${language}/${returning}: ${paragraph.slice(0, 30)}`);
        }
      }
    }
  });

  test("AC-18 the second message is the document offer, with the 'I don't have one' button; a returning account's carries its note first", () => {
    for (const language of ["en", "he"] as const) {
      const fresh = renderOpeningMessages(language, false, seeded);
      assert.equal(fresh.length, 2, language);
      assert.equal(fresh[1]!.text, uiString("documentOffer", language));
      assert.equal(fresh[1]!.replyMarkup?.inline_keyboard.flat()[0]?.text, uiString("noDocument", language));

      const back = renderOpeningMessages(language, true, seeded);
      assert.equal(back.length, 2, language);
      assert.equal(back[0]!.text, fresh[0]!.text, "the greeting is the same for a returning account");
      assert.equal(back[1]!.text, `${uiString("seedReturningNote", language)}\n\n${uiString("documentOffer", language)}`);
      assert.equal(back[1]!.replyMarkup?.inline_keyboard.flat()[0]?.text, uiString("noDocument", language));
    }
  });

  test("AC-7 an unseeded opening is still the one message it always was, byte for byte", () => {
    for (const language of ["en", "he"] as const) {
      for (const returning of [false, true]) {
        const messages = renderOpeningMessages(language, returning);
        assert.deepEqual(messages, [renderDocumentOffer(language, returning)]);
        assert.equal(messages[0]!.text, uiString(returning ? "introductionReturning" : "introduction", language));
      }
    }
  });

  test("the returning note says the first trip is untouched, in the plural voice in Hebrew, and names no deployment", () => {
    assert.match(uiString("seedReturningNote", "en"), /untouched|exactly as they are/);
    const he = uiString("seedReturningNote", "he");
    assert.match(he, /הטיול הקודם/);
    assert.doesNotMatch(he, /אתה|תגיד|שלח\b/);
  });
});
