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

  test("catches the harness narrating its own infrastructure", () => {
    // Reported live on 2026-09-10 from a family companion. A provider failover
    // is a fact about our vendors and our billing, and it names the models
    // behind the persona — to someone asking about their holiday.
    for (const text of [
      "🔄 Switched to fallback model: gpt-5.4-mini via openai-codex → claude-haiku-4-5-20251001 via anthropic",
      "Falling back to model claude-haiku-4-5",
      "/sethome registered this chat",
      "This chat is now set as home channel",
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

  test("catches the gateway's own busy acknowledgements", () => {
    // Verbatim from run 13: the organizer answered the question they were
    // asked, their reply landed while the agent was mid-run, and the HARNESS
    // told them it had adjusted using a correction they never made.
    assert.equal(
      detectInternalLeak("\u21aa Redirected current run. I'll adjust using your correction.").leaks,
      true,
    );
    for (const text of [
      "\u23e9 Steered into current run (2 min elapsed). Your message arrives after the next tool call.",
      "\u23f3 Queued for the next turn. I'll respond once the current task finishes.",
      "\u23f3 Subagent working \u2014 your message is queued for when it finishes (use /stop to cancel everything).",
      "\u23f3 Compressing context \u2014 your message is queued for when it finishes.",
      "\u26a1 Interrupting current task. I'll respond to your message shortly.",
    ]) {
      assert.equal(detectInternalLeak(text).leaks, true, text);
    }
  });

  test("the busy-ack phrases do not swallow real trip sentences", () => {
    for (const text of [
      "We can redirect the drive through Kyoto if the weather turns.",
      "There is a running track near the hotel.",
      "Let's queue the museum for the last day.",
      "\u05d0\u05e0\u05d7\u05e0\u05d5 \u05d1\u05d0\u05de\u05e6\u05e2 \u05d4\u05d8\u05d9\u05d5\u05dc \u2014 \u05e0\u05de\u05e9\u05d9\u05da \u05de\u05db\u05d0\u05df.",
    ]) {
      assert.equal(detectInternalLeak(text).leaks, false, text);
    }
  });

  test("an approval prompt never reaches a family group", () => {
    // Verbatim from 2026-09-12, posted into a family group in answer to a
    // question about the trip. Nobody in that room can judge it, and a "yes"
    // from anyone there would be a real shell command.
    const prompt = [
      "\u26a0\ufe0f Dangerous command requires approval:",
      'cd /opt/data/profiles/japan2026 && python3 -c "',
      "import json",
      "Reason: Security scan \u2014 [HIGH] Inline interpreter with suspicious payload",
      "Reply /approve to execute this one operation, /approve session to approve this pattern",
    ].join("\n");
    assert.equal(detectInternalLeak(prompt).leaks, true);
  });

  test("the approval phrases do not swallow real trip sentences", () => {
    for (const text of [
      "The restaurant requires a reservation, not approval.",
      "\u05d4\u05de\u05dc\u05d5\u05df \u05d0\u05d9\u05e9\u05e8 \u05d0\u05ea \u05d4\u05d4\u05d6\u05de\u05e0\u05d4.",
    ]) {
      assert.equal(detectInternalLeak(text).leaks, false, text);
    }
  });
});
