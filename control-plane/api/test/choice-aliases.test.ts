import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { resolveTypedOption } from "../src/choice-aliases.js";
import { applyProposals, buildInterpretPrompt, type ProposedAnswer } from "../src/interpret.js";
import { INTAKE_QUESTIONS } from "../src/interview.js";

const TRIP_TYPE = INTAKE_QUESTIONS.find((q) => q.id === "trip_type")!;
const IDS = TRIP_TYPE.options!.map((o) => o.id);
const resolve = (text: string) => resolveTypedOption("trip_type", text, IDS);

describe("resolveTypedOption — trip_type", () => {
  test("the exact sentence the star e2e types: couples, NOT family", () => {
    assert.equal(resolve("טיול זוגות ולא משפחה, נהיה שני זוגות"), "couple");
  });

  test("the otherText the model returned for it", () => {
    assert.equal(resolve("שני זוגות"), "couple");
  });

  test("Hebrew prefixes and forms", () => {
    assert.equal(resolve("לזוג"), "couple");
    assert.equal(resolve("טיול זוגי"), "couple");
    assert.equal(resolve("הטיול הוא משפחתי"), "family");
    assert.equal(resolve("בטיול של המשפחה"), "family");
  });

  test("English, and 'not X' names what it IS", () => {
    assert.equal(resolve("two couples"), "couple");
    assert.equal(resolve("A couple's trip"), "couple");
    assert.equal(resolve("couples, not family"), "couple");
    assert.equal(resolve("not a family trip, a couples trip"), "couple");
    assert.equal(resolve("a family trip"), "family");
  });

  test("'not X but Y' and 'לא X אלא Y' resolve to Y", () => {
    assert.equal(resolve("לא משפחה אלא זוגות"), "couple");
    assert.equal(resolve("not a couple but a family"), "family");
  });

  test("a group of families is its own option, not 'family'", () => {
    assert.equal(resolve("קבוצת משפחות"), "group_of_families");
    assert.equal(resolve("כמה משפחות ביחד"), "group_of_families");
    assert.equal(resolve("a group of families"), "group_of_families");
    assert.equal(resolve("three families"), "group_of_families");
  });

  test("two options named and neither negated is ambiguous: left alone", () => {
    assert.equal(resolve("משפחה וזוג"), null);
    assert.equal(resolve("couple and family"), null);
  });

  test("everything named is negated: nothing left to resolve", () => {
    assert.equal(resolve("לא זוגות ולא משפחה"), null);
  });

  test("a genuinely different answer stays free text", () => {
    assert.equal(resolve("טיול חברים"), null);
    assert.equal(resolve("friends trip"), null);
    assert.equal(resolve("טיול חברים עם המשפחה"), null);
    assert.equal(resolve("business trip"), null);
    assert.equal(resolve(""), null);
    assert.equal(resolve("a couple of days"), null);
    assert.equal(resolve("זוג נשוי עם ילדים"), null);
    assert.equal(resolve("a couple and their kids"), null);
  });

  test("a word that merely contains an alias is not the alias", () => {
    assert.equal(resolve("זוגיות"), null);
    assert.equal(resolve("familiar places"), null);
  });

  test("only options the question actually has can be resolved to", () => {
    assert.equal(resolveTypedOption("trip_type", "זוגות", ["family", "friends"]), null);
    assert.equal(resolveTypedOption("trip_type", "זוגות", ["couple", "family"]), "couple");
    assert.equal(resolveTypedOption("no_such_question", "זוגות", ["couple"]), null);
  });
});

describe("applyProposals — typed choice safety net", () => {
  const SOURCE = "טיול זוגות ולא משפחה, נהיה שני זוגות";
  const propose = (value: ProposedAnswer["value"], evidence = SOURCE): ProposedAnswer => ({
    questionId: "trip_type", value, confidence: 0.9, evidence, sourceMessageId: "m1",
  });
  const gate = (p: ProposedAnswer, sourceText = SOURCE) =>
    applyProposals([p], { sourceText, outstanding: ["trip_type"], answered: [], pendingQuestionId: "trip_type" });
  const optionOf = (decided: ReturnType<typeof gate>) =>
    (decided.accepted[0]?.answer as { option_id?: string } | undefined)?.option_id;

  test("choice_other 'שני זוגות' is recorded as the couple option", () => {
    const decided = gate(propose({ kind: "choice_other", otherText: "שני זוגות" }));
    assert.equal(decided.accepted.length, 1);
    assert.equal(decided.accepted[0]!.answer.kind, "choice");
    assert.equal(optionOf(decided), "couple");
  });

  test("choice_other carrying the whole sentence is the couple option too", () => {
    assert.equal(optionOf(gate(propose({ kind: "choice_other", otherText: SOURCE }))), "couple");
  });

  test("the model's own correct answer is untouched", () => {
    assert.equal(optionOf(gate(propose({ kind: "choice", optionId: "couple" }))), "couple");
  });

  test("a free answer stays free text", () => {
    const decided = gate(propose({ kind: "choice_other", otherText: "טיול חברים" }, "טיול חברים"), "טיול חברים");
    assert.equal(decided.accepted[0]!.answer.kind, "choice_other");
  });

  test("after the Other button the typed words stay free text (literalOther)", () => {
    const text = "שני זוגות";
    const decided = applyProposals(
      [propose({ kind: "choice_other", otherText: text }, text)],
      { sourceText: text, outstanding: ["trip_type"], answered: [], pendingQuestionId: "trip_type", literalOther: true },
    );
    assert.equal(decided.accepted[0]!.answer.kind, "choice_other");
  });

  test("an ambiguous otherText stays as the model said", () => {
    const decided = gate(propose({ kind: "choice_other", otherText: "משפחה וזוג" }, "משפחה וזוג"), "משפחה וזוג");
    assert.equal(decided.accepted[0]!.answer.kind, "choice_other");
  });
});

describe("buildInterpretPrompt — two couples", () => {
  test("says two couples is the Couple option when trip_type is asked", () => {
    const prompt = buildInterpretPrompt({ sourceText: "x", outstanding: ["trip_type"], language: "he" });
    assert.match(prompt, /Two couples travelling together/);
  });

  test("stays out of a prompt that is not asking trip_type", () => {
    const prompt = buildInterpretPrompt({ sourceText: "x", outstanding: ["destination"], language: "he" });
    assert.doesNotMatch(prompt, /Two couples travelling together/);
  });
});
