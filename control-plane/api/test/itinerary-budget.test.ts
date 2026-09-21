/**
 * The day-by-day pass reads a bounded amount of a document — and says so when
 * that is less than all of it. It used to slice at 20,000 characters with no
 * flag and no log, so a long plan's later days disappeared without a trace.
 */
import assert from "node:assert/strict";
import { describe, test } from "node:test";
import {
  extractItinerary,
  ITINERARY_DOCUMENT_BUDGET_CHARS,
  ITINERARY_TRUNCATED_WARNING,
} from "../src/itinerary-extract.js";
import { fakeRunner } from "../src/model-runner.js";

describe("the day-by-day budget", () => {
  test("a document past the budget is read up to it, and the result says so", async () => {
    const runner = fakeRunner(['{"phases":[]}']);
    const line = "Day plan: temple in the morning, market after lunch\n";
    const tail = "Last day: flight home from Narita";
    const long = line.repeat(Math.ceil((ITINERARY_DOCUMENT_BUDGET_CHARS + 1_000) / line.length)) + tail;

    const result = await extractItinerary({ destination: "Japan", phases: [{ name: "Tokyo" }], documentText: long }, runner);

    assert.ok(result.ok);
    if (!result.ok) return;
    assert.ok(result.warnings.some((w) => w.startsWith(ITINERARY_TRUNCATED_WARNING)), "never a silent cut");
    assert.ok(!runner.calls[0]!.prompt.includes(tail), "the model was given the budget, not the whole");
  });

  test("a document within the budget is read whole, with no warning", async () => {
    const runner = fakeRunner(['{"phases":[]}']);
    const short = "Tokyo 2026-09-19: Senso-ji, then Ueno Park.";

    const result = await extractItinerary({ destination: "Japan", phases: [{ name: "Tokyo" }], documentText: short }, runner);

    assert.ok(result.ok);
    if (!result.ok) return;
    assert.ok(!result.warnings.some((w) => w.startsWith(ITINERARY_TRUNCATED_WARNING)));
    assert.ok(runner.calls[0]!.prompt.includes(short));
    assert.equal(runner.calls[0]!.task, "extract_itinerary", "pinned to its own task");
  });
});
