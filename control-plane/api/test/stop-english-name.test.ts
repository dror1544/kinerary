import assert from "node:assert/strict";
import { describe, test } from "node:test";
import {
  buildExtractIntakePrompt,
  buildInterpretPrompt,
  changeSection,
  applyProposals,
  INTERPRET_OUTPUT_SCHEMA,
  type ProposedAnswer,
} from "../src/interpret.js";
import { INTAKE_QUESTIONS, stopsMissingEnglishName, validateAnswer } from "../src/interview.js";

/**
 * Every stop of a non-English interview carries the place's English name
 * (live star e2e, 2026-10-15; 2 of 3 runs).
 *
 * A Hebrew interview confirmed destination "אלזס, צרפת" and one stop, "קולמר",
 * with NO `name_en`. The third run, and every earlier one, had
 * {"name":"קולמר","name_en":"Colmar"}. Nothing in the prompt asked for the English
 * name: it appeared only inside the `dataExample` JSON, where a model working in
 * Hebrew can drop it without contradicting anything it was told.
 *
 * What a test can pin without a model is that the rule is IN the prompt the
 * model receives, in both prompts that write stops and in the operation that adds
 * one, and that the code which catches the gap does. Whether a model follows it is
 * measured live.
 */

const flat = (s: string) => s.replace(/\s+/g, " ");

const PHASES_ASKED = { sourceText: "x", outstanding: ["phases"], language: "he", onScreen: "phases" } as const;

// The exact stop from the live run.
const COLMAR_NO_ENGLISH = [{ name: "קולמר", start: "2027-12-02", end: "2027-12-09" }];

describe("the prompts ask for name_en on every stop", () => {
  test("the typed-answer prompt says every stop carries name_en, whatever the language", () => {
    const prompt = flat(buildInterpretPrompt(PHASES_ASKED));
    assert.match(prompt, /every stop carries "name_en"/i);
    assert.match(prompt, /common English name/i);
    // "name" stays the organizer's own words; only name_en is the English one.
    assert.match(prompt, /"name" stays exactly as the person wrote it/);
  });

  test("the document prompt says the same", () => {
    const prompt = flat(buildExtractIntakePrompt({ documentText: "x", outstanding: ["phases"], language: "he" }));
    assert.match(prompt, /every stop carries "name_en"/i);
    assert.match(prompt, /common English name/i);
  });

  test("the question itself asks for it, so the agent path and both prompts read the same words", () => {
    const phases = INTAKE_QUESTIONS.find((q) => q.id === "phases")!;
    assert.match(phases.prompt, /name_en/);
  });

  test("an operation that ADDS a stop names name_en too", () => {
    const lines = changeSection({ stops: [{ id: "s1", label: "A" }], travellers: [] });
    const addStop = lines.find((l) => l.includes('{"op":"add_stop"'));
    assert.ok(addStop, "the add_stop operation is shown");
    assert.match(addStop, /"name_en":/);
  });

  test("the rule is only spent where stops are being asked for", () => {
    const other = buildInterpretPrompt({ sourceText: "x", outstanding: ["destination"], language: "he" });
    assert.equal(other.includes("every stop carries"), false);
  });

  test("the prompt names no real trip, so it cannot be echoed into an answer", () => {
    const prompt = flat(buildInterpretPrompt(PHASES_ASKED));
    for (const word of ["Colmar", "Frankfurt", "Alsace", "קולמר", "אלזס"]) {
      assert.equal(prompt.includes(word), false, `${word} is in the prompt`);
    }
  });

  test("the output schema cannot require it: stops travel inside a dataJson STRING", () => {
    // Why the rule is prompt + code, not `required` in the schema: strict
    // structured output sees `dataJson` as one string, so a key inside a stop is
    // out of its reach. If this ever stops being true, require name_en there.
    const proposals = (INTERPRET_OUTPUT_SCHEMA.properties as Record<string, any>).proposals;
    const variants = proposals.items.properties.value.anyOf as Array<Record<string, any>>;
    const structured = variants.find((v) => v.properties.kind.enum[0] === "structured")!;
    assert.deepEqual(structured.properties.dataJson, { type: "string" });
  });
});

describe("stopsMissingEnglishName: the gap, named", () => {
  test("the live Hebrew stop is reported", () => {
    assert.deepEqual(stopsMissingEnglishName(COLMAR_NO_ENGLISH), ["קולמר"]);
  });

  test("a stop with name_en is fine", () => {
    assert.deepEqual(stopsMissingEnglishName([{ name: "קולמר", name_en: "Colmar" }]), []);
  });

  test("a blank name_en counts as missing", () => {
    assert.deepEqual(stopsMissingEnglishName([{ name: "קולמר", name_en: "  " }]), ["קולמר"]);
  });

  test("a stop already written in Latin script needs no second name", () => {
    assert.deepEqual(stopsMissingEnglishName([{ name: "Colmar" }, { name: "Zürich" }]), []);
  });

  test("only the stops that lack it are reported, in order", () => {
    const stops = [
      { name: "פרנקפורט", name_en: "Frankfurt" },
      { name: "קולמר" },
      { name: "Strasbourg" },
      { name: "שטרסבורג" },
    ];
    assert.deepEqual(stopsMissingEnglishName(stops), ["קולמר", "שטרסבורג"]);
  });

  test("anything that is not a stop list reports nothing and does not throw", () => {
    for (const bad of [undefined, null, "קולמר", 7, {}, [null, 3, "x"], [{ name: 5 }], [{}]]) {
      assert.deepEqual(stopsMissingEnglishName(bad), []);
    }
  });
});

describe("the gate keeps a stop without name_en (decision: no rejection)", () => {
  // Rejecting would drop EVERY stop in the answer and re-ask the organizer a
  // question they already answered, for a field that is the reader's job, not
  // theirs; with the model omitting it in 2 of 3 runs that is a loop. The
  // transformer names the trip from the stop's own words instead
  // (worker tests: TripIdentityFromEssenceTests), and the gap is logged at
  // confirmation (interview.test.ts).
  test("validateAnswer accepts the live Hebrew stop as it stands", () => {
    const result = validateAnswer("phases", null, null, undefined, COLMAR_NO_ENGLISH);
    assert.equal(result.ok, true);
  });

  test("applyProposals accepts the same stop from a typed message", () => {
    const proposal: ProposedAnswer = {
      questionId: "phases",
      value: { kind: "structured", data: COLMAR_NO_ENGLISH },
      confidence: 0.9,
      evidence: "קולמר",
      sourceMessageId: "m1",
    };
    const decisions = applyProposals([proposal], {
      sourceText: "אנחנו ישנים בקולמר מ-2 עד 9 בדצמבר 2027",
      outstanding: ["phases"],
      answered: [],
    });
    assert.equal(decisions.accepted.length, 1);
    assert.equal(decisions.rejected.length, 0);
  });
});
