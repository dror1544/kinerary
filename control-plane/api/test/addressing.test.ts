/**
 * The group relevance gate.
 *
 * These are pure-function tests on purpose: the gate is the thing standing
 * between a shared bot and a family's group chat, and it should be provable
 * without a database, a token, or a network.
 */
import assert from "node:assert/strict";
import { describe, test } from "node:test";
import {
  isAddressedToAssistant,
  mentionsName,
  mentionsUsername,
} from "../src/relay/addressing.js";

const NAMES = ["בוטסאן", "botsan"];

describe("mentionsName — whole-word matching in any script", () => {
  test("matches either language", () => {
    assert.equal(mentionsName("בוטסאן מתי הטיסה?", "בוטסאן"), true);
    assert.equal(mentionsName("botsan when is our flight?", "botsan"), true);
  });

  test("is case-insensitive for Latin", () => {
    assert.equal(mentionsName("Botsan, help", "botsan"), true);
    assert.equal(mentionsName("BOTSAN help", "botsan"), true);
  });

  test("matches mid-sentence and against punctuation", () => {
    assert.equal(mentionsName("hey botsan, what's the plan?", "botsan"), true);
    assert.equal(mentionsName("שאלה לבוטסאן: מתי?", "בוטסאן"), false, "prefixed by a Hebrew letter");
    assert.equal(mentionsName("(botsan)", "botsan"), true);
  });

  test("does not match inside a longer word — in EITHER script", () => {
    // \b is ASCII-only in JavaScript, so it treats every Hebrew letter as a
    // word boundary. That is the bug the Unicode property escapes avoid: with
    // \b, "בוטסאנים" would report a mention that never happened.
    assert.equal(mentionsName("botsanic gardens", "botsan"), false);
    assert.equal(mentionsName("robotsan", "botsan"), false);
    assert.equal(mentionsName("בוטסאנים", "בוטסאן"), false);
  });

  test("a name with regex characters is matched literally", () => {
    assert.equal(mentionsName("ask c.a.t please", "c.a.t"), true);
    assert.equal(mentionsName("ask cXaXt please", "c.a.t"), false);
  });

  test("an empty or blank name never matches", () => {
    assert.equal(mentionsName("anything at all", ""), false);
    assert.equal(mentionsName("anything at all", "   "), false);
  });
});

describe("mentionsUsername", () => {
  test("matches @handle case-insensitively, with or without a leading @ in config", () => {
    assert.equal(mentionsUsername("hey @KineraryBot help", "KineraryBot"), true);
    assert.equal(mentionsUsername("hey @kinerarybot help", "KineraryBot"), true);
    assert.equal(mentionsUsername("hey @KineraryBot help", "@KineraryBot"), true);
  });

  test("does not match a longer handle that merely starts the same", () => {
    assert.equal(mentionsUsername("@KineraryBotOther hi", "KineraryBot"), false);
  });

  test("no configured username means no username match", () => {
    assert.equal(mentionsUsername("@KineraryBot hi", undefined), false);
  });
});

describe("isAddressedToAssistant", () => {
  test("a DM is always addressed — there is nobody else in the room", () => {
    assert.equal(
      isAddressedToAssistant({ chatType: "dm", text: "morning", assistantNames: NAMES }),
      true,
    );
    // Even with no names configured at all.
    assert.equal(
      isAddressedToAssistant({ chatType: "dm", text: "morning", assistantNames: [] }),
      true,
    );
  });

  test("a group message that names the assistant engages it", () => {
    for (const text of ["בוטסאן מתי אנחנו יוצאים?", "botsan what time do we leave?"]) {
      assert.equal(
        isAddressedToAssistant({ chatType: "group", text, assistantNames: NAMES }),
        true,
        text,
      );
    }
  });

  test("ordinary group chatter does NOT engage it", () => {
    // The whole point. Without this the shared bot answers a family talking
    // among themselves.
    for (const text of ["מתי אתם מגיעים?", "see you at 8", "who's driving?"]) {
      assert.equal(
        isAddressedToAssistant({ chatType: "group", text, assistantNames: NAMES }),
        false,
        text,
      );
    }
  });

  test("an @mention engages it even without a name match", () => {
    assert.equal(
      isAddressedToAssistant({
        chatType: "supergroup" as never,
        text: "@KineraryBot what's the plan",
        assistantNames: [],
        botUsername: "KineraryBot",
      }),
      true,
    );
  });

  test("a reply to the assistant engages it", () => {
    assert.equal(
      isAddressedToAssistant({
        chatType: "group",
        text: "and the one after that?",
        assistantNames: NAMES,
        isReplyToAssistant: true,
      }),
      true,
    );
  });

  test("no names configured falls back to mention/reply, NOT to answering everything", () => {
    // Silence from a misconfigured trip is recoverable. A bot that interrupts a
    // family conversation is what people remember.
    assert.equal(
      isAddressedToAssistant({ chatType: "group", text: "anything", assistantNames: [] }),
      false,
    );
    assert.equal(
      isAddressedToAssistant({
        chatType: "group",
        text: "anything",
        assistantNames: [],
        isReplyToAssistant: true,
      }),
      true,
    );
  });

  test("a forum topic is gated the same as a group", () => {
    assert.equal(
      isAddressedToAssistant({ chatType: "forum", text: "small talk", assistantNames: NAMES }),
      false,
    );
    assert.equal(
      isAddressedToAssistant({ chatType: "forum", text: "botsan?", assistantNames: NAMES }),
      true,
    );
  });
});
