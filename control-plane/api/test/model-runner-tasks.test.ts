/**
 * Which model serves which task — and saying so without deciding anything.
 *
 * Two things live here. `describe` names a task's pinned provider and model, so
 * a stored document reading can be keyed by the configuration that produced it.
 * And the two document tasks — reading intake answers, reading the day-by-day —
 * can now be pinned apart, while a deployment that only sets `EXTRACT_*` (which
 * is every deployment today, and a hard requirement of the VM compose file)
 * keeps working exactly as it did.
 */
import assert from "node:assert/strict";
import { describe, test } from "node:test";
import {
  claudeSpec,
  cliRunner,
  CODEX_LUNA_MODEL,
  codexRunner,
  codexSpec,
  composeRunners,
  fakeRunner,
  modelRunnerFromEnv,
  openRouterRunner,
  openRouterSpec,
} from "../src/model-runner.js";
import { EXTRACT_INTAKE_TASK } from "../src/interpret.js";
import { EXTRACT_ITINERARY_TASK } from "../src/itinerary-extract.js";

describe("describe — the pin, named", () => {
  test("each adapter names its own provider and model, and an unconfigured task names none", () => {
    const claude = cliRunner({ extract_intake: claudeSpec("claude-sonnet-5") });
    assert.deepEqual(claude.describe?.("extract_intake"), { provider: "claude", model: "claude-sonnet-5" });
    assert.equal(claude.describe?.("interpret"), null);

    assert.deepEqual(codexRunner({ x: codexSpec(CODEX_LUNA_MODEL) }).describe?.("x"), { provider: "codex", model: CODEX_LUNA_MODEL });
    assert.deepEqual(
      openRouterRunner({ x: openRouterSpec("vendor/model", "sk-test") }).describe?.("x"),
      { provider: "openrouter", model: "vendor/model" },
    );
    assert.equal(
      openRouterRunner({ x: openRouterSpec("vendor/model", "") }).describe?.("x"),
      null,
      "no key cannot serve a call, so it is not a configuration",
    );

    const composed = composeRunners({ a: claude, b: codexRunner({ b: codexSpec(CODEX_LUNA_MODEL) }) });
    assert.equal(composed.describe?.("a"), null, "routed by task name: `a` asks the claude runner for `a`, which it has no spec for");
    assert.deepEqual(
      composeRunners({ extract_intake: claude }).describe?.("extract_intake"),
      { provider: "claude", model: "claude-sonnet-5" },
    );
    assert.equal(composed.describe?.("nobody"), null);
  });

  test("the test double describes itself", () => {
    assert.deepEqual(fakeRunner([]).describe?.("anything"), { provider: "fake", model: "fake" });
  });
});

describe("the two document tasks", () => {
  test("inherit the deployed EXTRACT_* binding until given their own", () => {
    const runner = modelRunnerFromEnv({ EXTRACT_RUNNER: "claude", EXTRACT_MODEL: "claude-sonnet-5" });
    for (const task of [EXTRACT_INTAKE_TASK, EXTRACT_ITINERARY_TASK, "extract"]) {
      assert.deepEqual(runner?.describe?.(task), { provider: "claude", model: "claude-sonnet-5" }, task);
    }
    assert.equal(runner?.describe?.("interpret"), null, "extraction does not imply interpretation");
  });

  test("can be pinned apart", () => {
    const runner = modelRunnerFromEnv({
      EXTRACT_RUNNER: "claude",
      EXTRACT_MODEL: "claude-sonnet-5",
      EXTRACT_INTAKE_RUNNER: "claude",
      EXTRACT_INTAKE_MODEL: "claude-haiku-4-5",
      // A model with no runner of its own does not detach a task — it would be
      // a model id with nothing to say which runner it was written for.
      EXTRACT_ITINERARY_MODEL: "claude-haiku-4-5",
    });
    assert.deepEqual(runner?.describe?.(EXTRACT_INTAKE_TASK), { provider: "claude", model: "claude-haiku-4-5" });
    assert.deepEqual(runner?.describe?.(EXTRACT_ITINERARY_TASK), { provider: "claude", model: "claude-sonnet-5" });
  });

  test("a task with its own runner never borrows another runner's model", () => {
    const runner = modelRunnerFromEnv({
      EXTRACT_RUNNER: "claude",
      EXTRACT_MODEL: "claude-sonnet-5",
      EXTRACT_INTAKE_RUNNER: "codex",
    });
    assert.deepEqual(runner?.describe?.(EXTRACT_INTAKE_TASK), { provider: "codex", model: CODEX_LUNA_MODEL });
    assert.deepEqual(runner?.describe?.(EXTRACT_ITINERARY_TASK), { provider: "claude", model: "claude-sonnet-5" });
  });

  test("a runner with no model to default to is not configured, rather than guessed", () => {
    assert.equal(modelRunnerFromEnv({ EXTRACT_INTAKE_RUNNER: "claude" }), undefined);
  });
});
