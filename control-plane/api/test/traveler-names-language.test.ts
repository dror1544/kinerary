import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { buildExtractIntakePrompt, buildInterpretPrompt } from "../src/interpret.js";
import { INTAKE_QUESTIONS, travelersMissingNames } from "../src/interview.js";
import { resolveOrganizer } from "../src/organizer-identity.js";

/**
 * A traveller's `name` is in the interview's language and script; `name_en` is
 * the Latin form (owner's manual test, 2026-10-15).
 *
 * A Hebrew interview with a flight-ticket document confirmed these travellers:
 *   [{"name":"Dror Aloul","name_en":"Dror Aloul"},
 *    {"name":"Hagit Mali Aloul","name_en":"Hagit Mali Aloul"},
 *    {"name":"צחי סער"}, {"name":"ליאב סער"}]
 * — the two read off the tickets in English, the two the organizer typed in
 * Hebrew with no name_en. The owner: "It was best that it normalized the name to
 * the interview language." What a test can pin without a model is that the rule
 * is IN the prompts the model receives and that the code which catches the gap
 * does. Whether a model follows it is measured live.
 */

const flat = (s: string) => s.replace(/\s+/g, " ");

const TRAVELERS_ASKED = { sourceText: "x", outstanding: ["travelers"], language: "he", onScreen: "travelers" } as const;

// The owner's roster as it was confirmed.
const AS_CONFIRMED = [
  { name: "Dror Aloul", name_en: "Dror Aloul" },
  { name: "Hagit Mali Aloul", name_en: "Hagit Mali Aloul" },
  { name: "צחי סער" },
  { name: "ליאב סער" },
];
// The same four as the rule asks for them.
const NORMALISED = [
  { name: "דרור אלול", name_en: "Dror Aloul" },
  { name: "חגית מלי אלול", name_en: "Hagit Mali Aloul" },
  { name: "צחי סער", name_en: "Tzachi Saar" },
  { name: "ליאב סער", name_en: "Liav Saar" },
];

describe("the prompts put each traveller's name in the interview language", () => {
  test("the typed-answer prompt names the language, the exact ticket spelling and the transliteration", () => {
    const prompt = flat(buildInterpretPrompt(TRAVELERS_ASKED));
    assert.match(prompt, /ABOUT TRAVELLERS/);
    assert.match(prompt, /"name" is written in Hebrew letters/);
    assert.match(prompt, /"name_en" is the same person's name in Latin letters/);
    assert.match(prompt, /copy those letters EXACTLY as printed/);
    assert.match(prompt, /never leave either field out/i);
  });

  test("the document prompt says the same", () => {
    const prompt = flat(buildExtractIntakePrompt({ documentText: "x", outstanding: ["travelers"], language: "he" }));
    assert.match(prompt, /"name" is written in Hebrew letters/);
    assert.match(prompt, /copy those letters EXACTLY as printed/);
    assert.match(prompt, /never leave either field out/i);
  });

  test("an English interview asks for the Latin form in both fields", () => {
    const prompt = flat(buildInterpretPrompt({ ...TRAVELERS_ASKED, language: "en" }));
    assert.match(prompt, /ABOUT TRAVELLERS/);
    assert.doesNotMatch(prompt, /Hebrew letters/);
    assert.match(prompt, /"name" and "name_en" are both the name in Latin letters/);
  });

  test("the question itself says it, so the agent path reads the same words", () => {
    const q = INTAKE_QUESTIONS.find((x) => x.id === "travelers")!;
    assert.match(q.prompt, /language of this interview/);
    assert.match(q.prompt, /name_en/);
    assert.match(q.prompt, /exactly as printed/);
  });

  test("the rule is only spent where travellers are being asked for", () => {
    const typed = buildInterpretPrompt({ sourceText: "x", outstanding: ["destination"], language: "he" });
    assert.equal(typed.includes("ABOUT TRAVELLERS"), false);
    const doc = buildExtractIntakePrompt({ documentText: "x", outstanding: ["destination"], language: "he" });
    assert.equal(doc.includes("ABOUT TRAVELLERS"), false);
  });

  test("the rule names no real person, so it cannot be echoed into an answer", () => {
    for (const prompt of [
      flat(buildInterpretPrompt(TRAVELERS_ASKED)),
      flat(buildExtractIntakePrompt({ documentText: "x", outstanding: ["travelers"], language: "he" })),
    ]) {
      const start = prompt.indexOf("ABOUT TRAVELLERS");
      assert.ok(start >= 0, "the rule is in the prompt");
      const rule = prompt.slice(start, start + 1500);
      for (const word of ["Dror", "Aloul", "Hagit", "Saar", "Tzachi", "Liav", "דרור", "אלול", "חגית", "סער", "צחי", "ליאב"]) {
        assert.equal(rule.includes(word), false, `${word} is in the prompt`);
      }
    }
  });
});

describe("travelersMissingNames: the gap, counted", () => {
  test("the owner's confirmed roster: two Hebrew-only travellers lack the Latin form", () => {
    assert.deepEqual(travelersMissingNames(AS_CONFIRMED, "he"), { missingInterviewLanguageName: 2, missingEnglishName: 2 });
  });

  test("the normalised roster has no gap", () => {
    assert.deepEqual(travelersMissingNames(NORMALISED, "he"), { missingInterviewLanguageName: 0, missingEnglishName: 0 });
  });

  test("a traveller whose name is still Latin in a Hebrew interview lacks the Hebrew name", () => {
    assert.deepEqual(
      travelersMissingNames([{ name: "Dror Aloul", name_en: "Dror Aloul" }], "he"),
      { missingInterviewLanguageName: 1, missingEnglishName: 0 },
    );
  });

  test("a blank name_en counts as missing", () => {
    assert.equal(travelersMissingNames([{ name: "צחי סער", name_en: "  " }], "he").missingEnglishName, 1);
  });

  test("an English interview needs no second name for a Latin one", () => {
    assert.deepEqual(travelersMissingNames([{ name: "Dror Aloul" }], "en"), { missingInterviewLanguageName: 0, missingEnglishName: 0 });
  });

  test("a language whose script is not known only checks the Latin form", () => {
    assert.deepEqual(travelersMissingNames([{ name: "Юрий" }], "ru"), { missingInterviewLanguageName: 0, missingEnglishName: 1 });
  });

  test("anything that is not a roster reports nothing and does not throw", () => {
    for (const bad of [undefined, null, "x", 7, {}, [null, 3, "x"], [{}], [{ name: 5 }]]) {
      assert.deepEqual(travelersMissingNames(bad, "he"), { missingInterviewLanguageName: 0, missingEnglishName: 0 });
    }
  });
});

describe("the organizer is still found when names are in the interview language", () => {
  // The 2026-09-15 incident: a Hebrew organizer against an English roster. The
  // roster is now Hebrew-first with the Latin form beside it, and the organizer
  // may identify in either.
  for (const [answer, index] of [
    ["דרור אלול", 0], ["Dror Aloul", 0], ["דרור", 0], ["Dror", 0], ["אני דרור", 0],
    ["חגית מלי אלול", 1], ["Hagit Mali Aloul", 1], ["Hagit", 1], ["חגית", 1],
    ["צחי סער", 2], ["Tzachi Saar", 2], ["Tzachi", 2], ["צחי", 2],
    ["ליאב", 3], ["Liav", 3],
  ] as const) {
    test(`"${answer}" is traveller ${index}`, () => {
      const match = resolveOrganizer(answer, NORMALISED);
      assert.equal(match.kind, "matched");
      if (match.kind === "matched") assert.equal(match.index, index);
    });
  }

  test("the recorded value is the roster's Hebrew name, and it matches itself", () => {
    const match = resolveOrganizer("Dror", NORMALISED);
    assert.equal(match.kind === "matched" && match.name, "דרור אלול");
    assert.deepEqual(resolveOrganizer("דרור אלול", NORMALISED), { kind: "matched", index: 0, name: "דרור אלול" });
  });

  test("the roster as it was confirmed before the rule still resolves a Hebrew organizer", () => {
    assert.equal(resolveOrganizer("דרור אלול", AS_CONFIRMED).kind, "matched");
    assert.equal(resolveOrganizer("צחי", AS_CONFIRMED).kind, "matched");
  });
});
