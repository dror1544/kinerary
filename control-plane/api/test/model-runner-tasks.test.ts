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
import { chmod, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
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

const identity = (raw: unknown) => (raw && typeof raw === "object" ? raw : null);

/**
 * A fake `claude` CLI that always fails with rate-limit text, and records
 * every invocation to a file whose path is baked into the script itself
 * (never passed through the env, which the CLI's allow-listed environment
 * would drop). Counting invocations, not just the final reason, is what
 * proves a fallback hop did or did not happen — RATE_LIMITED after 2 calls
 * (claude's own `maxAttempts`) looks identical to RATE_LIMITED after 2 calls
 * with a mistaken extra hop unless something outside the result itself is
 * checked too.
 */
async function fakeRateLimitedClaudeBin(): Promise<{ bin: string; countInvocations: () => Promise<number> }> {
  const dir = await mkdtemp(join(tmpdir(), "kinerary-fake-claude-429-"));
  const bin = join(dir, "claude");
  const counter = join(dir, "calls");
  await writeFile(counter, "");
  await writeFile(
    bin,
    `#!/usr/bin/env node\nrequire("fs").appendFileSync(${JSON.stringify(counter)}, "x");\nprocess.stderr.write("429 too many requests");\nprocess.exit(1);\n`,
  );
  await chmod(bin, 0o755);
  return { bin, countInvocations: async () => (await readFile(counter, "utf8")).length };
}

/** A fake `claude` CLI that always succeeds, echoing back which model it ran as. */
async function fakeSucceedingClaudeBin(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "kinerary-fake-claude-ok-"));
  const bin = join(dir, "claude");
  await writeFile(
    bin,
    `#!/usr/bin/env node\nconst args = process.argv.slice(2);\nprocess.stdout.write(JSON.stringify({\n  type: "result", subtype: "success", is_error: false,\n  result: JSON.stringify({ model: args[args.indexOf("--model") + 1], args }),\n}));\n`,
  );
  await chmod(bin, 0o755);
  return bin;
}

/**
 * Installs a global `fetch` that always answers 429 — the primary's quota
 * exhausted — because `modelRunnerFromEnv`'s openrouter binding has no
 * injection point of its own; it calls the real global. Same pattern as
 * `telegram-api-failures.test.ts`: patch, use, restore in `finally`.
 */
function installAlwaysRateLimitedFetch(): { calls: string[]; restore: () => void } {
  const real = globalThis.fetch;
  const calls: string[] = [];
  globalThis.fetch = (async (url: string | URL) => {
    calls.push(String(url));
    return { ok: false, status: 429, text: async () => "rate limited" } as unknown as Response;
  }) as unknown as typeof fetch;
  return { calls, restore: () => { globalThis.fetch = real; } };
}

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

/**
 * decision 48 (docs/sprint6-tracks.md #48): the quota-only Gemini fallback.
 * `EXTRACT_FALLBACK_*` follows exactly the inheritance shape `EXTRACT_*`
 * itself already has — a task's own `<PREFIX>_FALLBACK_*` wins, else it
 * inherits `EXTRACT_FALLBACK_*` whole, else there is no fallback at all —
 * and this is a SEPARATE axis from which runner serves the primary: a task
 * detached onto its own primary runner (`EXTRACT_INTAKE_RUNNER=codex`, say)
 * still inherits `EXTRACT_FALLBACK_*` unless it names its own.
 */
describe("the quota-only fallback (decision 48)", () => {
  test("regression: with no fallback configured, a rate limit surfaces exactly as it always has", async () => {
    const { bin, countInvocations } = await fakeRateLimitedClaudeBin();
    const runner = modelRunnerFromEnv({ CLAUDE_BIN: bin, EXTRACT_RUNNER: "claude", EXTRACT_MODEL: "m" });
    assert.ok(runner);
    const result = await runner.run({ task: EXTRACT_INTAKE_TASK, prompt: "p", parse: identity });
    assert.equal(result.ok, false);
    assert.equal(result.ok === false && result.reason, "RATE_LIMITED");
    assert.equal(result.attempts, 2, "claude's own maxAttempts — the same-model retry, nothing more");
    assert.equal((result as { usedFallback?: boolean }).usedFallback, undefined);
    assert.equal(await countInvocations(), 2, "no extra hop happened — unset is unchanged, not default-on");
  });

  test("interpret structurally cannot be given a fallback — the env scheme has no branch that reads *_FALLBACK_* for it", async () => {
    const { bin, countInvocations } = await fakeRateLimitedClaudeBin();
    const runner = modelRunnerFromEnv({
      CLAUDE_BIN: bin,
      INTERPRET_RUNNER: "claude",
      INTERPRET_MODEL: "m",
      // Misconfigured on purpose: interpret has no `*_FALLBACK_*` variable in
      // the scheme at all (only EXTRACT_FALLBACK_*, EXTRACT_INTAKE_FALLBACK_*
      // and EXTRACT_ITINERARY_FALLBACK_* are ever read), so this is inert
      // rather than merely unused.
      INTERPRET_FALLBACK_RUNNER: "claude",
      INTERPRET_FALLBACK_MODEL: "m",
    });
    assert.ok(runner);
    const result = await runner.run({ task: "interpret", prompt: "p", parse: identity });
    assert.equal(result.ok, false);
    assert.equal(result.ok === false && result.reason, "RATE_LIMITED");
    assert.equal(await countInvocations(), 2, "exactly interpret's own maxAttempts — no fallback hop");
  });

  test("end to end: extract_intake escalates from a quota-limited OpenRouter primary to the Claude fallback inherited from EXTRACT_FALLBACK_*", async () => {
    const { calls, restore } = installAlwaysRateLimitedFetch();
    try {
      const fallbackBin = await fakeSucceedingClaudeBin();
      const runner = modelRunnerFromEnv({
        OPENROUTER_API_KEY: "sk-test",
        EXTRACT_RUNNER: "openrouter",
        EXTRACT_MODEL: "google/gemini-3.8-flash",
        EXTRACT_FALLBACK_RUNNER: "claude",
        EXTRACT_FALLBACK_MODEL: "claude-sonnet-5",
        CLAUDE_BIN: fallbackBin,
      });
      assert.ok(runner);
      const result = await runner.run({ task: EXTRACT_INTAKE_TASK, prompt: "PROMPT", parse: identity });
      assert.equal(result.ok, true, result.ok ? "" : JSON.stringify(result));
      if (!result.ok) return;
      assert.equal((result.value as { model: string }).model, "claude-sonnet-5");
      assert.equal(result.usedFallback, true);
      assert.equal(calls.length, 3, "the primary's own retry (openrouter's maxAttempts) ran to exhaustion first");
    } finally {
      restore();
    }
  });

  test("EXTRACT_INTAKE_FALLBACK_* overrides the inherited EXTRACT_FALLBACK_* — own beats inherited, same as the primary axis", async () => {
    const { restore } = installAlwaysRateLimitedFetch();
    try {
      const fallbackBin = await fakeSucceedingClaudeBin();
      const runner = modelRunnerFromEnv({
        OPENROUTER_API_KEY: "sk-test",
        EXTRACT_RUNNER: "openrouter",
        EXTRACT_MODEL: "google/gemini-3.8-flash",
        EXTRACT_FALLBACK_RUNNER: "claude",
        EXTRACT_FALLBACK_MODEL: "claude-generic-fallback",
        EXTRACT_INTAKE_FALLBACK_RUNNER: "claude",
        EXTRACT_INTAKE_FALLBACK_MODEL: "claude-intake-specific-fallback",
        CLAUDE_BIN: fallbackBin,
      });
      assert.ok(runner);

      const intake = await runner.run({ task: EXTRACT_INTAKE_TASK, prompt: "PROMPT", parse: identity });
      assert.ok(intake.ok, intake.ok ? "" : JSON.stringify(intake));
      assert.equal(intake.ok && (intake.value as { model: string }).model, "claude-intake-specific-fallback");

      // extract_itinerary named no override, so it still inherits EXTRACT_FALLBACK_*.
      const itinerary = await runner.run({ task: EXTRACT_ITINERARY_TASK, prompt: "PROMPT", parse: identity });
      assert.ok(itinerary.ok, itinerary.ok ? "" : JSON.stringify(itinerary));
      assert.equal(itinerary.ok && (itinerary.value as { model: string }).model, "claude-generic-fallback");
    } finally {
      restore();
    }
  });

  test("a forbidden model configured as the fallback is refused — misconfiguring it behaves as if no fallback were configured", async () => {
    const { bin, countInvocations } = await fakeRateLimitedClaudeBin();
    const runner = modelRunnerFromEnv({
      CLAUDE_BIN: bin,
      EXTRACT_RUNNER: "claude",
      EXTRACT_MODEL: "m",
      EXTRACT_FALLBACK_RUNNER: "openrouter",
      EXTRACT_FALLBACK_MODEL: "openrouter/auto",
      OPENROUTER_API_KEY: "sk-x",
    });
    assert.ok(runner);
    const result = await runner.run({ task: "extract", prompt: "p", parse: identity });
    assert.equal(result.ok, false);
    assert.equal(result.ok === false && result.reason, "RATE_LIMITED");
    assert.equal((result as { usedFallback?: boolean }).usedFallback, undefined);
    assert.equal(await countInvocations(), 2, "the forbidden fallback was never wired, so only the primary ran");
  });

  test("a fallback runner with no model to default to is not wired — the primary's own result surfaces", async () => {
    const { bin, countInvocations } = await fakeRateLimitedClaudeBin();
    const runner = modelRunnerFromEnv({
      CLAUDE_BIN: bin,
      EXTRACT_RUNNER: "claude",
      EXTRACT_MODEL: "m",
      // hermes has no default model to fall back on when unset, unlike
      // openrouter (its task default) or codex (CODEX_LUNA_MODEL).
      EXTRACT_FALLBACK_RUNNER: "hermes",
    });
    assert.ok(runner);
    const result = await runner.run({ task: "extract", prompt: "p", parse: identity });
    assert.equal(result.ok, false);
    assert.equal(result.ok === false && result.reason, "RATE_LIMITED");
    assert.equal(await countInvocations(), 2);
  });
});
