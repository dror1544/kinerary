import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { buildExtractIntakePrompt, buildInterpretPrompt } from "../src/interpret.js";

/**
 * The chat-answer prompt's rules about the SHAPE of a trip and about matching a
 * listed option (live Hebrew run, 2026-10-10).
 *
 * A model is not called here: CI has no `claude`, and a wording test that needs a
 * model is not a unit test. What these pin is that the rules are IN the prompt the
 * model receives — they were not, and `unclear phases` followed. The behaviour
 * itself is measured by `tools/trip-shape-eval.ts`, against a real model.
 *
 * Until this fix the stop rules existed only in the DOCUMENT prompt
 * (`buildExtractIntakePrompt`); a typed answer went to a prompt that had never
 * been told a flight is not a stop, or what a base with day trips looks like.
 */

/** The prompt wraps lines by hand; a rule is one sentence however it is wrapped. */
const flat = (s: string) => s.replace(/\s+/g, " ");

const PHASES_SCREEN = {
  sourceText: "x",
  outstanding: ["phases"],
  language: "he",
  onScreen: "phases",
} as const;

describe("chat-answer prompt: the shape of a trip (phases)", () => {
  const prompt = flat(buildInterpretPrompt(PHASES_SCREEN));

  test("a base with day trips is ONE stop, with the dates of the whole trip", () => {
    assert.match(prompt, /sleep in one place/i);
    assert.match(prompt, /day trips?/i);
    assert.match(prompt, /ONE stop/);
    assert.match(prompt, /dates of the whole trip|trip's dates|departure and return dates/i);
  });

  test("the places visited from the base are not stops", () => {
    assert.match(prompt, /villages, towns, markets and sights visited from the base are NOT stops/);
  });

  test("a flight, a rental car and the gateway city are not stops", () => {
    assert.match(prompt, /A FLIGHT is not a stop/);
    assert.match(prompt, /rental car/i);
    assert.match(prompt, /Never write A as a first stop and a last stop/);
  });

  test("'no firm plan yet' is not a reason for unclear", () => {
    assert.match(prompt, /no plan yet/i);
    assert.match(prompt, /does not leave the question unanswered/);
  });

  test("the rules are only spent on a prompt where stops are being asked for", () => {
    const other = buildInterpretPrompt({ sourceText: "x", outstanding: ["destination"], language: "en" });
    assert.equal(other.includes("ONE stop"), false);
    assert.equal(other.includes("A FLIGHT is not a stop"), false);
  });

  test("the worked examples name no real trip, so they cannot be echoed into an answer", () => {
    // `exampleEchoes`: prompt examples reach answers. The live trip's cities are
    // the obvious thing to reach for and must not be in the prompt text.
    for (const word of ["Colmar", "Frankfurt", "Alsace", "קולמר", "פרנקפורט", "אלזס"]) {
      assert.equal(prompt.includes(word), false, `${word} is in the prompt`);
    }
  });
});

describe("chat-answer prompt: matching a listed option", () => {
  const prompt = flat(buildInterpretPrompt({
    sourceText: "x",
    outstanding: ["trip_type"],
    language: "he",
    onScreen: "trip_type",
  }));

  test("an option is matched by meaning: other words, a plural, another language", () => {
    assert.match(prompt, /by MEANING/);
    assert.match(prompt, /plural/i);
    assert.match(prompt, /another language/i);
  });

  test("choice_other is only for when nothing listed fits", () => {
    assert.match(prompt, /kind "choice_other" ONLY when no listed option fits/);
  });

  test("'X, not Y' answers with X", () => {
    assert.match(prompt, /"X, not Y"\), the answer is what it IS/);
  });

  test("the kind they NAME decides, not the people they add to explain it", () => {
    // Live replay: "a couples trip, not family, there will be two couples" came back
    // as group_of_families (0.4-0.55) or choice_other "two couples" in 3 of 6 runs.
    assert.match(prompt, /The kind they NAME decides/);
  });

  test("a question being CORRECTED shows its options too, not just its current answer", () => {
    // The live miss: at the recap trip_type is answered, so it reaches the model only
    // as "currently: Family" — no option ids. "couples, not family" then had nothing
    // to match and came back as choice_other "זוגות", which the router refused.
    const corrected = flat(buildInterpretPrompt({
      sourceText: "x",
      outstanding: [],
      language: "he",
      correctable: [{ id: "trip_type", current: "Family" }, { id: "destination", current: "Alsace" }],
    }));
    assert.match(corrected, /id: trip_type \(currently: Family\)/);
    assert.match(corrected, /options: family = Family \| group_of_families = Group of families \| couple = Couple/);
    // Only a question that HAS options gets the line; a text question does not.
    assert.equal(/id: destination \(currently: Alsace\) options:/.test(corrected), false);
  });

  test("the options themselves are still listed with their ids", () => {
    assert.match(prompt, /couple = Couple/);
    assert.match(prompt, /family = Family/);
  });
});

describe("one rule, two prompts: the document prompt agrees on flights and cars", () => {
  const doc = flat(buildExtractIntakePrompt({ documentText: "x", outstanding: ["phases"], language: "en" }));
  const chat = flat(buildInterpretPrompt(PHASES_SCREEN));

  test("both say a flight is not a stop", () => {
    assert.match(doc, /A FLIGHT is not a stop/);
    assert.match(chat, /A FLIGHT is not a stop/);
  });

  test("both say a rental car's pick-up and return city is not a stop either", () => {
    assert.match(doc, /rental car/i);
    assert.match(chat, /rental car/i);
  });
});
