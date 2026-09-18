import { describe, test } from "node:test";
import assert from "node:assert/strict";
import type { AnswerStore, IntakeAnswer } from "../src/interview.js";
import {
  CHAOS_PLAN,
  MAX_TRIES_PER_QUESTION,
  chaosMove,
  judgeIntake,
  replyInOtherLanguage,
} from "../tools/organizer-chaos.js";

const text = (t: string): IntakeAnswer => ({ kind: "text", schema_version: 3, text: t });
const GOOD: AnswerStore = {
  destination: text("יוון — אתונה, נקסוס וסנטוריני"),
  departure_date: text("2027-07-12"),
  return_date: text("2027-07-26"),
  travelers: {
    kind: "structured", schema_version: 3, data: [
      { name: "אבי כהן", name_en: "Avi Cohen" }, { name: "רונית כהן", name_en: "Ronit Cohen" },
      { name: "תמר כהן", name_en: "Tamar Cohen" }, { name: "יואב כהן", name_en: "Yoav Cohen" },
      { name: "מיכל כהן", name_en: "Michal Cohen" },
      { name: "רות כהן", name_en: "Ruth Cohen" },
    ],
  },
  organizer_identity: text("רונית כהן"),
  trip_type: { kind: "choice", option_id: "family", schema_version: 3, other_text: null },
};
const failing = (answers: AnswerStore, language = "he", written: "he" | "en" | null = "he") =>
  judgeIntake(answers, language, written).checks.filter((c) => !c.ok).map((c) => c.name);

describe("the chaos organizer's plan", () => {
  test("every question's misbehaviour runs out before the interview is judged unrecovered", () => {
    for (const [question, moves] of Object.entries(CHAOS_PLAN)) {
      assert.ok(moves.length < MAX_TRIES_PER_QUESTION, `${question} leaves room for a proper answer`);
      assert.equal(chaosMove(question, moves.length), null, `${question} answers properly after its chaos`);
    }
  });

  test("it misbehaves in both languages, at buttons, with documents and with a stale keyboard", () => {
    const moves = Object.values(CHAOS_PLAN).flat();
    assert.ok(moves.some((m) => m.kind === "type" && /[א-ת]/u.test(m.text)));
    assert.ok(moves.some((m) => m.kind === "type" && /^[\x00-\x7f]+$/.test(m.text)));
    assert.ok(moves.some((m) => m.kind === "upload"));
    assert.ok(moves.some((m) => m.kind === "tap"));
  });
});

describe("the chaos organizer's verdict", () => {
  test("a sound interview passes every check", () => {
    assert.deepEqual(failing(GOOD), []);
  });

  test("the impossible or reversed dates typed first must not be what was kept", () => {
    assert.equal(failing({ ...GOOD, departure_date: text("2027-02-31") }).length, 1);
    assert.equal(failing({ ...GOOD, return_date: text("2027-07-01") }).length, 1);
    assert.equal(failing({ ...GOOD, departure_date: text("31 בפברואר 2027") }).length, 1);
  });

  test("an organizer who is not on the roster fails", () => {
    assert.deepEqual(failing({ ...GOOD, organizer_identity: text("Grandma Ruth") }), ["the organizer is exactly one traveller on the roster"]);
  });

  test("the travellers typed at the destination question must not become the destination", () => {
    assert.equal(failing({ ...GOOD, destination: text("אנחנו חמישה: אבי כהן 46, רונית כהן 44") }).length, 1);
  });

  test("an interview recorded in a language other than the one last written fails", () => {
    assert.equal(failing(GOOD, "en", "he").length, 1);
  });

  test("a late correction that never reached the roster fails", () => {
    const withoutGrandmother = {
      ...GOOD,
      travelers: {
        kind: "structured" as const, schema_version: 3,
        data: (GOOD.travelers as { data: unknown[] }).data.slice(0, 5),
      },
    };
    assert.deepEqual(failing(withoutGrandmother), ["the late correction reached the roster (a grandmother joining)"]);
  });
});

describe("a reply in the other language", () => {
  test("is noticed in both directions", () => {
    assert.equal(replyInOtherLanguage("he", "When does your trip start?"), true);
    assert.equal(replyInOtherLanguage("he", "מתי הטיול מתחיל?"), false);
    assert.equal(replyInOtherLanguage("en", "מתי הטיול מתחיל?"), true);
    assert.equal(replyInOtherLanguage("he", "Tokyo"), false, "a place name is not a language");
  });
});
