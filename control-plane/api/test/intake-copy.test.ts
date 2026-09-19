/**
 * EVERY SENTENCE THE ROUTER SAYS, IN BOTH LANGUAGES.
 *
 * `uiString` is untyped by design — `Record<Language, Record<string, string>>`
 * — and total: a key with no Hebrew falls back to English, and a key that
 * exists in neither falls back to the KEY ITSELF. Both are deliberate. A
 * missing translation should degrade to a sentence in the wrong language,
 * never to a blank message or a crash (see this file's header in
 * `intake-copy.ts`).
 *
 * The cost of that is that nothing fails when a string is added on one side
 * only, or when a call site misspells a key. The organizer is simply shown
 * English mid-Hebrew, or the literal text `confirmFinsh`, and the interview
 * carries on — which is precisely the failure nobody notices from the code.
 * There was no test here at all until 2026-09-18.
 *
 * So: the types cannot check it, the fallbacks will not fail on it, and these
 * four do. `INTAKE_COPY` needs none of this — `Localised` is
 * `Record<Language, string>`, so a question's copy cannot be half-translated
 * — but a question with NO entry is the same silent fallback, onto a prompt
 * written for a model. That is the last case here.
 */
import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, test } from "node:test";
import { fileURLToPath } from "node:url";
import { INTAKE_COPY, LANGUAGES, UI_STRINGS, askText, optionLabel, recapLabel } from "../src/intake-copy.js";
import { INTAKE_QUESTIONS, RETIRED_QUESTION_IDS } from "../src/interview.js";

/**
 * Strings that are the same in both languages ON PURPOSE. Empty, and adding to
 * it should feel like a decision: a Hebrew sentence identical to its English
 * one is an untranslated sentence in almost every case.
 */
const SHARED_BY_DESIGN = new Set<string>();

const srcDir = fileURLToPath(new URL("../src/", import.meta.url));

function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) return sourceFiles(full);
    return full.endsWith(".ts") ? [full] : [];
  });
}

describe("router copy", () => {
  test("every UI string exists in every language", () => {
    const keys = new Map<string, Set<string>>();
    for (const language of LANGUAGES) {
      for (const key of Object.keys(UI_STRINGS[language])) {
        if (!keys.has(key)) keys.set(key, new Set());
        keys.get(key)!.add(language);
      }
    }
    const partial = [...keys.entries()]
      .filter(([, langs]) => langs.size !== LANGUAGES.length)
      .map(([key, langs]) => `${key} (only ${[...langs].join(", ")})`);
    assert.deepEqual(partial, [], "a key on one side only silently falls back to English mid-conversation");
  });

  test("no UI string is blank", () => {
    const blank: string[] = [];
    for (const language of LANGUAGES) {
      for (const [key, value] of Object.entries(UI_STRINGS[language])) {
        if (typeof value !== "string" || value.trim().length === 0) blank.push(`${language}.${key}`);
      }
    }
    assert.deepEqual(blank, [], "a blank string is a message the organizer receives as nothing at all");
  });

  test("no Hebrew string is its English self", () => {
    const untranslated = Object.keys(UI_STRINGS.en)
      .filter((key) => !SHARED_BY_DESIGN.has(key))
      .filter((key) => UI_STRINGS.he[key] !== undefined && UI_STRINGS.he[key] === UI_STRINGS.en[key]);
    assert.deepEqual(
      untranslated, [],
      "identical copy means a key was added to both sides and translated in neither; add it to SHARED_BY_DESIGN if that is genuinely intended",
    );
  });

  /**
   * THE MISSPELLING CASE, which is the one that actually bites.
   *
   * `uiString("confirmFinsh")` returns the string "confirmFinsh" and sends it.
   * No type error, no exception, no log line — a person reads an identifier.
   */
  test("every key a call site asks for exists", () => {
    const direct = new Map<string, string[]>();
    const indirect: { where: string; literals: string[] }[] = [];
    for (const file of sourceFiles(srcDir)) {
      const text = readFileSync(file, "utf8");
      for (const call of text.matchAll(/\buiString\(([^)]*)\)/g)) {
        const args = call[1] ?? "";
        const literals = [...args.matchAll(/"([^"]+)"/g)].map((m) => m[1]!);
        const first = /^\s*"([^"]+)"/.exec(args);
        if (first) {
          const key = first[1]!;
          if (!direct.has(key)) direct.set(key, []);
          direct.get(key)!.push(file.slice(srcDir.length));
        } else if (literals.length > 0) {
          indirect.push({ where: file.slice(srcDir.length), literals });
        }
      }
    }
    assert.ok(direct.size > 20, `the scan found ${direct.size} keys, which is too few to be reading the source`);

    const missing = [...direct.entries()]
      .filter(([key]) => UI_STRINGS.en[key] === undefined)
      .map(([key, files]) => `${key} (${[...new Set(files)].join(", ")})`);
    assert.deepEqual(missing, [], "uiString returns the key itself when it has no string — the organizer reads the identifier");

    // A key chosen by a ternary (`reason === "EXPIRING" ? a : b`) cannot be
    // resolved by reading, because the other literals in the call are not keys
    // at all. What CAN be said is that such a call names at least one real
    // string — which is false exactly when every branch of it is misspelled.
    const blind = indirect
      .filter((call) => !call.literals.some((literal) => UI_STRINGS.en[literal] !== undefined))
      .map((call) => `${call.where}: ${call.literals.join(" | ")}`);
    assert.deepEqual(blind, [], "none of the strings this call could pass is a known key");
  });

  test("every question a person is asked has copy written for a person", () => {
    // Without an entry, `askText` falls back to `IntakeQuestion.prompt` — the
    // field spec written for the interviewer model. That is not a hypothetical
    // degradation: the `phases` spec, "a short place name (city or region —
    // e.g. …) … it's fine to just not record it structurally", was read out to
    // a live organizer twice, including on the confirmation screen.
    const live = INTAKE_QUESTIONS.filter((q) => !RETIRED_QUESTION_IDS.has(q.id));
    const missing = live.filter((q) => !INTAKE_COPY[q.id]).map((q) => q.id);
    assert.deepEqual(missing, [], "these questions would be asked in the model's own words");

    for (const language of LANGUAGES) {
      for (const question of live) {
        // Read off INTAKE_COPY rather than compared with `prompt`: some
        // questions are short enough that the spec and the sentence coincide
        // ("What type of trip is this?"), and a fallback that happens to land
        // on the right words is still a fallback.
        assert.ok(
          (INTAKE_COPY[question.id]?.ask[language] ?? "").trim().length > 0,
          `${question.id} has no sentence to ask in ${language}`,
        );
        assert.ok(askText(question, language).trim().length > 0, `${question.id} asks nothing in ${language}`);
        assert.ok(
          (INTAKE_COPY[question.id]?.recap[language] ?? "").trim().length > 0,
          `${question.id} has no recap label in ${language}`,
        );
        assert.ok(recapLabel(question, language).length > 0, `${question.id} has no recap label in ${language}`);
        // A tappable option with no translation shows the English label from
        // the question set — an English button in a Hebrew keyboard.
        for (const option of question.options ?? []) {
          assert.notEqual(
            optionLabel(question, option.id, language), option.id,
            `${question.id}/${option.id} has no label at all in ${language}`,
          );
          if (language !== "en") {
            assert.notEqual(
              optionLabel(question, option.id, language), option.label,
              `${question.id}/${option.id} is untranslated in ${language}`,
            );
          }
        }
      }
    }
  });
});
