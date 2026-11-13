/**
 * #548: a dashboard-seeded interview opens with one message in Dror's wording (2026-11-13): the greeting, who is
 * writing and the trip, then that a few short questions follow and that any plan, ticket or booking can be sent, with a
 * "Let's start" button. The older introduction is not sent. No database: this is the opening's shape.
 */
import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { renderDocumentOffer, renderOpeningMessages } from "../src/chat-router.js";
import { uiString } from "../src/intake-copy.js";

const seeded = { destination: "Gatecity", departureDate: "2026-11-14", returnDate: "2026-11-21", organizerName: "Arlo" };
const seededHe = { ...seeded, destination: "גייטסיטי", organizerName: "ארלו" };

describe("#548 the seeded opening is a greeting, one explanation, and then its own messages", () => {
  test("AC-17 the opening, exactly, in English", () => {
    const messages = renderOpeningMessages("en", false, seeded);
    assert.equal(messages.length, 1);
    assert.equal(messages[0]!.text, "Hi Arlo 👋\nI'm your Kinerary travel assistant, and I'd love to help you plan your trip to Gatecity in November. How exciting! 🎉\n\nTo plan the trip that suits you best, I'll ask a few short questions. If you have a trip plan, flight tickets or any other booking, send it to me here in the chat and I'll learn more about the trip. So let's start!");
  });

  test("AC-17 the opening, exactly, in Hebrew (plural voice, name and destination as given)", () => {
    const messages = renderOpeningMessages("he", false, seededHe);
    assert.equal(messages.length, 1);
    assert.equal(messages[0]!.text, "היי ארלו 👋\nאני עוזר הטיולים שלכם מבית Kinerary, ואשמח לעזור לכם לתכנן את הטיול לגייטסיטי בנובמבר. איזה כיף! 🎉\n\nכדי שנתכנן את הטיול שהכי מתאים לכם, נעבור על כמה שאלות קצרות. אם יש לכם תוכנית טיול, כרטיסי טיסה או כל הזמנה אחרת, שלחו לי אותם כאן בצ׳אט ואלמד מהם עוד על הטיול. אז בואו נתחיל!");
    assert.doesNotMatch(messages[0]!.text, /אתה|תענה|תשלח|בוא נתחיל/, "plural, never the masculine singular");
  });

  test("AC-18 the one button is Let's start, and it moves on exactly as I-don't-have-one does", () => {
    for (const language of ["en", "he"] as const) {
      const [button, ...more] = renderOpeningMessages(language, false, seeded)[0]!.replyMarkup!.inline_keyboard.flat();
      assert.equal(more.length, 0, language);
      assert.equal(button!.text, uiString("seedStart", language));
      assert.equal(button!.callback_data, renderDocumentOffer(language, false).replyMarkup!.inline_keyboard.flat()[0]!.callback_data);
    }
  });

  test("AC-17 none of the introduction's paragraphs (bar the returning note) is in a seeded opening", () => {
    for (const language of ["en", "he"] as const) {
      for (const returning of [false, true]) {
        const intro = uiString(returning ? "introductionReturning" : "introduction", language);
        const [m] = renderOpeningMessages(language, returning, seeded);
        for (const paragraph of intro.split("\n\n").filter((p) => p !== uiString("seedReturningNote", language))) assert.ok(!m!.text.includes(paragraph), `${language}/${returning}: ${paragraph.slice(0, 30)}`);
      }
    }
  });

  test("AC-18 a returning account's opening carries the untouched-trip note between the greeting and the invitation", () => {
    for (const language of ["en", "he"] as const) {
      const fresh = renderOpeningMessages(language, false, seeded)[0]!.text.split("\n\n");
      const back = renderOpeningMessages(language, true, seeded)[0]!.text.split("\n\n");
      assert.deepEqual(back, [fresh[0], uiString("seedReturningNote", language), fresh[1]], language);
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
