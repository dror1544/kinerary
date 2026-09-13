import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { MAX_ASSISTANT_NAMES, parseAssistantNames } from "../src/assistant-names.js";

describe("parseAssistantNames — what a rename may be", () => {
  test("a command argument in two languages becomes two names", () => {
    assert.deepEqual(parseAssistantNames("סולו / Solo"), { ok: true, names: ["סולו", "Solo"] });
  });

  test("a tool's list is accepted as given, trimmed and de-duplicated", () => {
    assert.deepEqual(parseAssistantNames(["  סולו ", "סולו", "Solo"]), { ok: true, names: ["סולו", "Solo"] });
  });

  test("inner whitespace is collapsed, so a name matches the way it is typed", () => {
    assert.deepEqual(parseAssistantNames("Tal   Bot"), { ok: true, names: ["Tal Bot"] });
  });

  test("nothing to rename to is refused", () => {
    assert.deepEqual(parseAssistantNames("   "), { ok: false, reason: "EMPTY" });
    assert.deepEqual(parseAssistantNames([]), { ok: false, reason: "EMPTY" });
  });

  test("too many names is refused rather than truncated", () => {
    const names = Array.from({ length: MAX_ASSISTANT_NAMES + 1 }, (_, i) => `Name${i}`);
    assert.deepEqual(parseAssistantNames(names), { ok: false, reason: "TOO_MANY" });
  });

  test("a name nobody could type in a sentence is refused", () => {
    // Names are matched as whole words in ordinary chat: a command, an
    // @handle or markup would either never match or match the wrong thing.
    for (const bad of ["/start", "@kinerary_bot", "a", "<b>Tal</b>", "Tal\nBot"]) {
      assert.equal(parseAssistantNames([bad]).ok, false, `${JSON.stringify(bad)} should be refused`);
    }
  });

  test("an overlong name is refused", () => {
    assert.deepEqual(parseAssistantNames(["x".repeat(41)]), { ok: false, reason: "TOO_LONG" });
  });
});
