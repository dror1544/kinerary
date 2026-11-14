/**
 * #513 (AC-4, AC-7): the welcome back of a resumed interview, and the notice to someone who writes into a closed one.
 * The wording is the owner's to change; what these pin is the shape that makes each sentence true. (That both
 * languages carry every key, and that every key a call site names exists, is `intake-copy.test.ts`.)
 */
import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { LANGUAGES, UI_STRINGS } from "../src/intake-copy.js";

describe("a paused interview, in words (#513)", () => {
  test("AC-4 the welcome back is one line in each language, plural in Hebrew, and is not the introduction", () => {
    const en = UI_STRINGS.en.resumedOpening!;
    const he = UI_STRINGS.he.resumedOpening!;
    assert.match(en, /Welcome back/);
    assert.match(he, /ברוכים השבים/, "plural voice: ברוכים, not ברוך");
    assert.doesNotMatch(he, /ברוך השב/, "no singular");
    for (const line of [en, he]) {
      assert.ok(!line.includes("\n"), "one line");
      assert.ok(line.length < 80, "a line, not a paragraph");
      assert.ok(!line.includes("?"), "it asks nothing: the next question follows it");
    }
    assert.notEqual(en, UI_STRINGS.en.introduction);
    assert.notEqual(he, UI_STRINGS.he.introduction);
  });

  test("AC-7 the dashboard notice points at the dashboard; the other points at whoever set the trip up, and never the reverse", () => {
    for (const language of LANGUAGES) {
      const dashboard = UI_STRINGS[language].expiredWriteAfterDashboard!;
      const other = UI_STRINGS[language].expiredWriteAfter!;
      assert.notEqual(dashboard, other);
      assert.match(dashboard, language === "en" ? /dashboard/ : /לוח הבקרה/, `${language}: the dashboard sentence names it`);
      assert.doesNotMatch(other, language === "en" ? /dashboard/ : /לוח הבקרה/, `${language}: the other one never sends someone to a page they do not have`);
      assert.match(other, language === "en" ? /whoever set (your|the) trip up/ : /ממי שהקים לכם את הטיול/);
      assert.doesNotMatch(dashboard, language === "en" ? /whoever set/ : /ממי שהקים/, `${language}: an organizer with a dashboard is not sent to themselves`);
    }
    assert.match(UI_STRINGS.en.expiredWriteAfterDashboard!, /get a new interview link there/);
    assert.match(UI_STRINGS.he.expiredWriteAfterDashboard!, /היכנסו/, "plural imperative");
  });
});
