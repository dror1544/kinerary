/**
 * The last gate before the organizer.
 *
 * Every example that suppresses here is real text an interviewer sent to a
 * real organizer, and every example that passes is real text it should keep
 * sending. That balance is the whole design: a filter that eats ordinary
 * conversation would cost more than the leak does.
 */
import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { detectInternalLeak } from "../src/relay/internal-leak.js";

describe("internal leak detection", () => {
  test("suppresses the message that prompted this, verbatim", () => {
    const actual =
      "`bot_gender`, `bot_tone` ו-`bot_proactive` עדיין ב-optionalRemaining — " +
      "הבחירה שנלחצה עוד לא נרשמה. אשאל על `trip_pace` בינתיים, ואת שאלות הכפתורים הנותרות ישאל הראוטר.";
    const verdict = detectInternalLeak(actual);
    assert.equal(verdict.leaks, true);
  });

  test("catches tool names, response fields and the router by name", () => {
    for (const text of [
      "I'll call submit_answer_for_chat with that.",
      "It is still listed in optionalRemaining.",
      "אשאל את `dietary` עכשיו",
      "הראוטר ישאל את השאלה הבאה",
      "confirm_intake needs a session token I don't hold",
    ]) {
      assert.equal(detectInternalLeak(text).leaks, true, text);
    }
  });

  test("leaves ordinary interview conversation alone", () => {
    // The cost of a false positive is a silent bot, so these matter more than
    // the catches. Every one is a sentence the interviewer SHOULD send.
    for (const text of [
      "נרשם! מתי אתם חוזרים הביתה?",
      "Got it — Tokyo, Kyoto and Osaka. What dates?",
      "Does anyone have dietary restrictions?",          // the bare word, not the id
      "What pace suits the group — easygoing or packed?",
      "I'll show you a summary once we have the essentials.",
      "רשמתי את התאריכים מהמסמך ששלחת.",
      "The router at the hotel should give you wifi.",   // English 'router', a real sentence
    ]) {
      assert.equal(detectInternalLeak(text).leaks, false, text);
    }
  });

  test("an empty message is not a leak", () => {
    assert.equal(detectInternalLeak("").leaks, false);
  });
});
