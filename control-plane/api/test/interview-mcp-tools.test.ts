/**
 * The MCP tool parameters an interviewer agent actually answers through.
 *
 * interview.test.ts proves validateAnswer accepts a correct answer, and the
 * HTTP routes forward every field. Neither notices when the MCP layer in
 * between cannot EXPRESS one: `optionIds` was added for
 * `submit_answer_for_chat` and never backported to `submit_answer`, so every
 * `multi_choice` question was unanswerable through the tool the interviewer
 * used — `dietary` threw for a real organizer on the first live signup run
 * (capture ledger, Step 3 #7), because the one parameter that satisfies a
 * multi_choice question was the one the schema left out.
 *
 * So the load-bearing test here is not "dietary works". It is that EVERY
 * question type in the schema is answerable through the shared parameter set
 * — a coverage assertion, so adding a question of a type the tools cannot
 * carry fails here rather than in front of an organizer.
 */
import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { z } from "zod";
import { INTAKE_QUESTIONS, validateAnswer, type IntakeQuestion } from "../src/interview.js";
import { answerParams, dataParam } from "../src/interview-mcp-params.js";

/** The tool call as the MCP SDK would hand it to the tool's handler. */
const toolSchema = z.object(answerParams);

/**
 * The best answer the tool's parameter set can express for a question —
 * chosen the way an interviewer agent would, from the question alone.
 */
function answerFor(q: IntakeQuestion): Record<string, unknown> {
  switch (q.type) {
    case "choice":
      return { questionId: q.id, optionId: q.options![0]!.id };
    case "multi_choice":
      return { questionId: q.id, optionIds: q.options!.map((o) => o.id).slice(0, 2) };
    case "structured":
      return { questionId: q.id, data: q.dataShape === "array" ? [{ note: "x" }] : { note: "x" } };
    case "text":
      return { questionId: q.id, otherText: "an answer" };
    default:
      throw new Error(`no answer shape for question type ${(q as IntakeQuestion).type}`);
  }
}

describe("interview MCP tool parameters", () => {
  test("every question in the schema is answerable through the tool parameters", () => {
    const unanswerable: string[] = [];

    for (const q of INTAKE_QUESTIONS) {
      const parsed = toolSchema.safeParse(answerFor(q));
      if (!parsed.success) {
        unanswerable.push(`${q.id} (${q.type}): rejected at the MCP boundary`);
        continue;
      }
      const { optionId, otherText, optionIds, data } = parsed.data;
      const result = validateAnswer(q.id, optionId ?? null, otherText, undefined, data, optionIds);
      if (!result.ok) unanswerable.push(`${q.id} (${q.type}): ${result.reason}`);
    }

    assert.deepEqual(unanswerable, [], "questions no MCP tool parameter can answer");
  });

  test("every question type in the schema is actually exercised above", () => {
    // Guards the coverage test against a silent narrowing: if a type stops
    // appearing in INTAKE_QUESTIONS the assertion above still passes, but it
    // is no longer proving anything about that type.
    const types = new Set(INTAKE_QUESTIONS.map((q) => q.type));
    assert.deepEqual(
      [...types].sort(),
      ["choice", "multi_choice", "structured", "text"],
      "question types present in the schema",
    );
  });

  test("a multi_choice answer carries the whole set, not one id at a time", () => {
    const parsed = toolSchema.parse({ questionId: "dietary", optionIds: ["kosher", "nut_allergy"] });
    const result = validateAnswer("dietary", null, undefined, undefined, undefined, parsed.optionIds);
    assert.equal(result.ok, true);
    assert.deepEqual(
      result.ok === true && (result.answer as { option_ids: string[] }).option_ids,
      ["kosher", "nut_allergy"].sort(),
    );
  });

  test("the parameters a multi_choice question CANNOT be answered with are still refused", () => {
    // The failure the live run hit. Kept as a test so the fix is not mistaken
    // for "multi_choice now accepts anything": a single optionId still cannot
    // stand in for a set, because it would silently discard the other taps.
    for (const attempt of [{ optionId: "kosher" }, { otherText: "kosher, vegan" }]) {
      const parsed = toolSchema.parse({ questionId: "dietary", ...attempt });
      const result = validateAnswer(
        "dietary", parsed.optionId ?? null, parsed.otherText, undefined, parsed.data, parsed.optionIds,
      );
      assert.equal(result.ok, false);
      assert.equal(result.ok === false && result.reason, "OPTIONS_REQUIRED");
    }
  });

  describe("structured data arriving as a JSON string", () => {
    const phases = [{ name: "Dallas", start: "2026-09-06", end: "2026-09-09" }];

    test("a stringified array is parsed rather than rejected", () => {
      const parsed = dataParam.safeParse(JSON.stringify(phases));
      assert.equal(parsed.success, true);
      const result = validateAnswer("phases", null, undefined, undefined, parsed.success && parsed.data, undefined);
      assert.equal(result.ok, true);
    });

    test("a stringified object is parsed rather than rejected", () => {
      const parsed = dataParam.safeParse(JSON.stringify({ budget: "mid" }));
      assert.equal(parsed.success, true);
      const result = validateAnswer("constraints", null, undefined, undefined, parsed.success && parsed.data, undefined);
      assert.equal(result.ok, true);
    });

    test("a real array is still passed through untouched", () => {
      const parsed = dataParam.safeParse(phases);
      assert.equal(parsed.success, true);
      assert.deepEqual(parsed.success && parsed.data, phases);
    });

    test("a string that is not JSON, or is a JSON scalar, is still refused", () => {
      // Tolerance stops at the boundary of the contract: `data` means an
      // array or an object, and a shape check one hop later is not a reason
      // to let a scalar through here.
      for (const value of ["just some prose", '"a json string"', "42", "null"]) {
        assert.equal(dataParam.safeParse(value).success, false, `should refuse ${value}`);
      }
    });
  });
});
