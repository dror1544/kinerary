/**
 * The group judge's quota-only fallback (owner's decision of 2026-11-27, an
 * extension of decision 48, docs/sprint6-tracks.md #48): when the judge's
 * primary runner answers RATE_LIMITED - OpenRouter's 402 "credits are out" or a
 * 429 - the call goes ONCE to a second, explicitly configured runner
 * (JUDGE_FALLBACK_*). Every other failure surfaces exactly as it did.
 *
 * Fakes throughout: no network, no real CLI except two stub binaries.
 */
import assert from "node:assert/strict";
import { describe, test } from "node:test";
import {
  composeRunners,
  modelRunnerFromEnv,
  quotaFallbackRunner,
  type RunnerFailure,
  type RunnerResult,
  type StructuredModelRequest,
  type StructuredModelRunner,
} from "../src/model-runner.js";
import { switchableRunner } from "../src/model-task-settings.js";
import { createGroupJudge, groupJudgeFromEnv, JUDGE_TASK, type JudgeOutcome } from "../src/relay/group-judge.js";
import { withFakeBinDir, writeFakeBin } from "./support/child-env-harness.js";

const INPUT = { chatId: "-1001", text: "what time is check-in?", assistantNames: ["Tripper"], language: "en" as const };
const YES = { forAssistant: true, confidence: 0.9 };

type Script = (req: StructuredModelRequest<unknown>, n: number) => RunnerResult<unknown> | Promise<RunnerResult<unknown>>;

/** A runner that runs `script`, and remembers every request it was given. */
function leg(provider: string, model: string, script: Script) {
  const calls: StructuredModelRequest<unknown>[] = [];
  const runner: StructuredModelRunner & { calls: typeof calls } = {
    calls,
    describe: () => ({ provider, model }),
    async run<T>(req: StructuredModelRequest<T>): Promise<RunnerResult<T>> {
      calls.push(req as StructuredModelRequest<unknown>);
      return (await script(req as StructuredModelRequest<unknown>, calls.length)) as RunnerResult<T>;
    },
  };
  return runner;
}
const ok: Script = () => ({ ok: true, value: YES, attempts: 1, ms: 1 });
const fails = (reason: RunnerFailure, detail = "x"): Script => () => ({ ok: false, reason, detail, attempts: 1, ms: 1 });
const hangs: Script = () => new Promise(() => {});
const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

const PRIMARY = "anthropic/claude-haiku-5.5";
const FALLBACK = "claude-haiku-5-5";

/** The judge over primary -> fallback, wired the way modelRunnerFromEnv wires it. */
function judgeOver(primary: StructuredModelRunner, fallback: StructuredModelRunner, extra: Partial<Parameters<typeof createGroupJudge>[0]> = {}, fbTimeoutMs = 8000) {
  const lines: string[] = [];
  const runner = quotaFallbackRunner(primary, fallback, JUDGE_TASK, { fallbackTimeoutMs: fbTimeoutMs });
  const judge = createGroupJudge({
    runner,
    timeoutMs: (provider) => (provider === "openrouter" ? 3000 : 8000),
    rateLimiter: { allow: () => true } as never,
    log: (l) => lines.push(l),
    ...extra,
  });
  return { judge, lines, runner };
}

describe("the judge's quota fallback: when it is used", () => {
  test("a 402 (RATE_LIMITED) on the primary goes to the fallback, with the FALLBACK's own timeout", async () => {
    const primary = leg("openrouter", PRIMARY, fails("RATE_LIMITED", "OpenRouter 402: insufficient credits"));
    const fallback = leg("claude", FALLBACK, ok);
    const { judge } = judgeOver(primary, fallback);
    const outcome = await judge.judge(INPUT);
    assert.equal(outcome.kind, "yes");
    assert.equal((outcome as { usedFallback?: boolean }).usedFallback, true);
    assert.equal(outcome.model, FALLBACK, "the decision is recorded against the model that made it");
    assert.equal(primary.calls[0]!.timeoutMs, 3000, "the primary keeps openrouter's 3 s");
    assert.equal(fallback.calls.length, 1);
    assert.equal(fallback.calls[0]!.timeoutMs, 8000, "the fallback gets its own, not the primary's 3 s: with 3 s a CLI could never answer");
  });

  for (const reason of ["TIMED_OUT", "FAILED", "UPSTREAM_ERROR", "BAD_OUTPUT", "UNAUTHORIZED", "NOT_CONFIGURED"] as RunnerFailure[]) {
    test(`a ${reason} on the primary is NOT a quota limit: no fallback, the failure surfaces as before`, async () => {
      const primary = leg("openrouter", PRIMARY, fails(reason));
      const fallback = leg("claude", FALLBACK, ok);
      const { judge } = judgeOver(primary, fallback);
      const outcome = await judge.judge(INPUT);
      assert.equal(outcome.kind, "fallback");
      assert.equal(fallback.calls.length, 0, `a ${reason} must never reach the fallback`);
      assert.equal(outcome.model, PRIMARY);
      assert.equal((outcome as { usedFallback?: boolean }).usedFallback, undefined);
    });
  }

  test("the fallback's own RATE_LIMITED is the answer: exactly one hop, no third runner", async () => {
    const primary = leg("openrouter", PRIMARY, fails("RATE_LIMITED"));
    const fallback = leg("claude", FALLBACK, fails("RATE_LIMITED", "usage limit reached"));
    const { judge } = judgeOver(primary, fallback);
    const outcome = await judge.judge(INPUT);
    assert.equal(outcome.kind, "fallback");
    assert.equal(outcome.kind === "fallback" && outcome.reason, "rate_limited");
    assert.equal(primary.calls.length, 1);
    assert.equal(fallback.calls.length, 1);
    assert.equal((outcome as { usedFallback?: boolean }).usedFallback, true, "it was the fallback that ran out too");
  });

  test("a fallback that times out or errors is a fallback outcome with that reason (not the primary's)", async () => {
    for (const [reason, expected] of [["TIMED_OUT", "timeout"], ["FAILED", "error"], ["BAD_OUTPUT", "unparseable"]] as const) {
      const { judge } = judgeOver(leg("openrouter", PRIMARY, fails("RATE_LIMITED")), leg("claude", FALLBACK, fails(reason)));
      const outcome = await judge.judge(INPUT);
      assert.equal(outcome.kind === "fallback" && outcome.reason, expected, reason);
    }
  });

  test("a primary that succeeds never touches the fallback, and its outcome has no marker", async () => {
    const fallback = leg("claude", FALLBACK, ok);
    const { judge } = judgeOver(leg("openrouter", PRIMARY, ok), fallback);
    const outcome = await judge.judge(INPUT);
    assert.equal(outcome.kind, "yes");
    assert.equal(fallback.calls.length, 0);
    assert.equal(outcome.model, PRIMARY);
    assert.equal("usedFallback" in outcome, false);
  });
});

describe("the judge's quota fallback: breaker, bounds and slots", () => {
  test("a 402 storm RESCUED by the fallback never opens the breaker: call N+1 still reaches the fallback", async () => {
    const primary = leg("openrouter", PRIMARY, fails("RATE_LIMITED", "402"));
    const fallback = leg("claude", FALLBACK, ok);
    const { judge, lines } = judgeOver(primary, fallback, { breakerThreshold: 3 });
    for (let i = 0; i < 8; i += 1) {
      const outcome = await judge.judge(INPUT);
      assert.equal(outcome.kind, "yes", `call ${i + 1}`);
    }
    assert.equal(primary.calls.length, 8, "every call still tries the primary first, so a recovery is noticed at once");
    assert.equal(fallback.calls.length, 8);
    assert.equal(lines.some((l) => l.includes("circuit_open")), false);
  });

  test("a 402 whose fallback ALSO fails counts as one failure: the breaker opens at the threshold, and an open breaker calls neither runner", async () => {
    const primary = leg("openrouter", PRIMARY, fails("RATE_LIMITED"));
    const fallback = leg("claude", FALLBACK, fails("TIMED_OUT"));
    const { judge, lines } = judgeOver(primary, fallback, { breakerThreshold: 3 });
    for (let i = 0; i < 3; i += 1) assert.equal((await judge.judge(INPUT)).kind, "fallback");
    assert.equal(lines.filter((l) => l.includes("circuit_open")).length, 1);
    const open = await judge.judge(INPUT);
    assert.equal(open.kind === "fallback" && open.reason, "circuit_open");
    assert.equal(primary.calls.length, 3);
    assert.equal(fallback.calls.length, 3);
  });

  test("a bad answer from the fallback is a reachable model, not a breaker failure", async () => {
    const { judge, lines } = judgeOver(leg("openrouter", PRIMARY, fails("RATE_LIMITED")), leg("claude", FALLBACK, fails("BAD_OUTPUT")), { breakerThreshold: 2 });
    for (let i = 0; i < 5; i += 1) await judge.judge(INPUT);
    assert.equal(lines.some((l) => l.includes("circuit_open")), false);
  });

  test("with NO fallback wired, a 402 storm opens the breaker exactly as before", async () => {
    const primary = leg("openrouter", PRIMARY, fails("RATE_LIMITED"));
    const lines: string[] = [];
    const judge = createGroupJudge({ runner: primary, timeoutMs: 3000, breakerThreshold: 3, rateLimiter: { allow: () => true } as never, log: (l) => lines.push(l) });
    for (let i = 0; i < 4; i += 1) await judge.judge(INPUT);
    assert.equal(lines.filter((l) => l.includes("circuit_open")).length, 1);
    assert.equal(primary.calls.length, 3);
  });

  test("a primary that never answers is cut at ITS timeout and does not hop: each leg is bounded by its own budget", async () => {
    const primary = leg("openrouter", PRIMARY, hangs);
    const fallback = leg("claude", FALLBACK, ok);
    const { judge } = judgeOver(primary, fallback, { timeoutMs: 60 }, 2000);
    const started = Date.now();
    const outcome = await judge.judge(INPUT);
    const took = Date.now() - started;
    assert.equal(outcome.kind === "fallback" && outcome.reason, "timeout");
    assert.equal(fallback.calls.length, 0, "a timeout is not a quota limit");
    assert.ok(took < 400, `the hung primary held the call for ${took} ms; the fallback's 2000 ms must not be added to it`);
  });

  test("a fallback that never answers is cut at its own timeout, not held until some larger wall", async () => {
    const { judge } = judgeOver(leg("openrouter", PRIMARY, fails("RATE_LIMITED")), leg("claude", FALLBACK, hangs), { timeoutMs: 60 }, 150);
    const started = Date.now();
    const outcome = await judge.judge(INPUT);
    const took = Date.now() - started;
    assert.equal(outcome.kind === "fallback" && outcome.reason, "timeout");
    assert.equal((outcome as { usedFallback?: boolean }).usedFallback, true);
    assert.ok(took < 600, `took ${took} ms`);
  });

  test("a call waits for a slot for as long as its WHOLE budget (primary + fallback), so a fallback episode does not turn into queue_full", async () => {
    // One slot. The first call is a slow fallback (~250 ms); the primary's own timeout is 60 ms,
    // which used to be the whole wait for a slot.
    const primary = leg("openrouter", PRIMARY, fails("RATE_LIMITED"));
    const fallback = leg("claude", FALLBACK, async () => { await sleep(250); return { ok: true, value: YES, attempts: 1, ms: 250 }; });
    const { judge } = judgeOver(primary, fallback, { timeoutMs: 60, concurrency: 1 }, 2000);
    const [a, b] = await Promise.all([judge.judge(INPUT), judge.judge({ ...INPUT, chatId: "-1002" })]);
    assert.equal(a.kind, "yes");
    assert.equal(b.kind, "yes", `the second call waited for the slot instead of ${JSON.stringify(b)}`);
  });

  test("without a fallback the slot wait is still the call's own timeout (unchanged)", async () => {
    const slow = leg("openrouter", PRIMARY, async () => { await sleep(250); return { ok: true, value: YES, attempts: 1, ms: 250 }; });
    const judge = createGroupJudge({ runner: slow, timeoutMs: 60, concurrency: 1, maxQueued: 5, rateLimiter: { allow: () => true } as never });
    const [a, b] = await Promise.all([judge.judge(INPUT), judge.judge({ ...INPUT, chatId: "-1002" })]);
    assert.equal(a.kind === "fallback" && a.reason, "timeout");
    assert.equal(b.kind === "fallback" && b.reason, "queue_full");
  });
});

describe("the judge's quota fallback: visible, once per episode", () => {
  test("entering and leaving the fallback each log ONE line, however many messages it served", async () => {
    let credits = false;
    const primary = leg("openrouter", PRIMARY, () => (credits ? { ok: true, value: YES, attempts: 1, ms: 1 } : { ok: false, reason: "RATE_LIMITED", detail: "402", attempts: 1, ms: 1 }));
    const { judge, lines } = judgeOver(primary, leg("claude", FALLBACK, ok));
    for (let i = 0; i < 4; i += 1) await judge.judge(INPUT);
    assert.equal(lines.filter((l) => l.includes("relay.group_judge_fallback_engaged")).length, 1);
    assert.equal(lines.filter((l) => l.includes("relay.group_judge_fallback_ended")).length, 0);
    credits = true;
    for (let i = 0; i < 3; i += 1) await judge.judge(INPUT);
    assert.equal(lines.filter((l) => l.includes("relay.group_judge_fallback_engaged")).length, 1);
    assert.equal(lines.filter((l) => l.includes("relay.group_judge_fallback_ended")).length, 1);
    const engaged = lines.find((l) => l.includes("relay.group_judge_fallback_engaged"))!;
    assert.match(engaged, /"warn"/);
    assert.ok(engaged.includes(FALLBACK) && engaged.includes(PRIMARY));
  });

  test("quotaFallbackRunner marks the result and logs the hop (task and reason, never content)", async () => {
    const warnings: string[] = [];
    const original = console.warn;
    console.warn = (line: unknown) => { warnings.push(String(line)); };
    try {
      const runner = quotaFallbackRunner(leg("openrouter", PRIMARY, fails("RATE_LIMITED")), leg("claude", FALLBACK, ok), JUDGE_TASK, { fallbackTimeoutMs: 8000 });
      const result = await runner.run({ task: JUDGE_TASK, prompt: "SECRET PROMPT TEXT", parse: (x) => x });
      assert.equal(result.usedFallback, true);
    } finally {
      console.warn = original;
    }
    assert.equal(warnings.length, 1);
    assert.ok(warnings[0]!.includes("model_runner.quota_fallback") && warnings[0]!.includes(FALLBACK));
    assert.ok(!warnings[0]!.includes("SECRET PROMPT TEXT"));
  });
});

describe("the wrappers pass the fallback pin through", () => {
  const wired = () => quotaFallbackRunner(leg("openrouter", PRIMARY, ok), leg("claude", FALLBACK, ok), JUDGE_TASK, { fallbackTimeoutMs: 7000 });

  test("describeFallback names the fallback's provider, model and timeout; describe still names the primary", () => {
    const runner = wired();
    assert.deepEqual(runner.describeFallback?.(JUDGE_TASK), { provider: "claude", model: FALLBACK, timeoutMs: 7000 });
    assert.deepEqual(runner.describe?.(JUDGE_TASK), { provider: "openrouter", model: PRIMARY });
  });

  test("composeRunners and switchableRunner keep it; a `/model group_judge` override has NO fallback (an explicit pin is a pin)", async () => {
    const composed = composeRunners({ [JUDGE_TASK]: wired() });
    assert.equal(composed.describeFallback?.(JUDGE_TASK)?.model, FALLBACK);
    assert.equal(composed.describeFallback?.("interpret") ?? null, null);

    const overridden = leg("openrouter", "vendor/pinned", fails("RATE_LIMITED"));
    const switchable = switchableRunner(composed, () => overridden);
    assert.equal(switchable.describeFallback?.(JUDGE_TASK)?.model, FALLBACK);
    switchable.apply(new Map([[JUDGE_TASK, { runner: "openrouter", model: "vendor/pinned" }]]));
    assert.equal(switchable.describeFallback?.(JUDGE_TASK) ?? null, null, "the override replaces the whole binding, fallback included");
    const result = await switchable.run({ task: JUDGE_TASK, prompt: "p", parse: (x) => x });
    assert.equal(result.ok, false);
    assert.equal(result.usedFallback, undefined);
  });
});

describe("JUDGE_FALLBACK_* from the environment", () => {
  const BASE = { JUDGE_RUNNER: "openrouter", JUDGE_MODEL: PRIMARY, OPENROUTER_API_KEY: "sk-test", JUDGE_TIMEOUT_MS: "3000" };

  test("unset means no fallback at all", () => {
    const runner = modelRunnerFromEnv({ ...BASE })!;
    assert.equal(runner.describeFallback?.(JUDGE_TASK) ?? null, null);
  });

  test("the four variables wire a quota fallback; its timeout is its OWN (JUDGE_TIMEOUT_MS is the primary's)", () => {
    const env = { ...BASE, JUDGE_FALLBACK_RUNNER: "claude", JUDGE_FALLBACK_MODEL: FALLBACK, JUDGE_FALLBACK_EFFORT: "low" };
    assert.deepEqual(modelRunnerFromEnv(env)!.describeFallback?.(JUDGE_TASK), { provider: "claude", model: FALLBACK, timeoutMs: 8000 });
    assert.equal(modelRunnerFromEnv({ ...env, JUDGE_FALLBACK_TIMEOUT_MS: "5000" })!.describeFallback?.(JUDGE_TASK)?.timeoutMs, 5000);
    assert.equal(modelRunnerFromEnv({ ...env, JUDGE_FALLBACK_TIMEOUT_MS: "60000" })!.describeFallback?.(JUDGE_TASK)?.timeoutMs, 10000, "the CLI ceiling");
    assert.equal(modelRunnerFromEnv({ ...env, JUDGE_FALLBACK_TIMEOUT_MS: "abc" })!.describeFallback?.(JUDGE_TASK)?.timeoutMs, 8000);
    const http = { ...BASE, JUDGE_FALLBACK_RUNNER: "openrouter", JUDGE_FALLBACK_MODEL: "vendor/other", JUDGE_FALLBACK_TIMEOUT_MS: "9000" };
    assert.equal(modelRunnerFromEnv(http)!.describeFallback?.(JUDGE_TASK)?.timeoutMs, 3000, "an HTTP fallback is clamped to 3 s like an HTTP primary");
  });

  test("a JUDGE_FALLBACK_EFFORT typo is refused at build time, naming that variable (not JUDGE_EFFORT)", () => {
    const env = { ...BASE, JUDGE_FALLBACK_RUNNER: "claude", JUDGE_FALLBACK_MODEL: FALLBACK, JUDGE_FALLBACK_EFFORT: "fast" };
    assert.throws(() => modelRunnerFromEnv(env), /JUDGE_FALLBACK_EFFORT="fast" is not an effort level/);
  });

  test("scope: no other task reads a judge fallback, and a judge fallback is not read for documents", () => {
    const env = {
      ...BASE, JUDGE_FALLBACK_RUNNER: "claude", JUDGE_FALLBACK_MODEL: FALLBACK,
      INTERPRET_RUNNER: "openrouter", INTERPRET_MODEL: "vendor/i", INTERPRET_FALLBACK_RUNNER: "claude", INTERPRET_FALLBACK_MODEL: "m",
      EXTRACT_RUNNER: "openrouter", EXTRACT_MODEL: "vendor/e",
    };
    const runner = modelRunnerFromEnv(env)!;
    assert.equal(runner.describeFallback?.("interpret") ?? null, null);
    assert.equal(runner.describeFallback?.("extract_intake") ?? null, null, "EXTRACT_* has no fallback named; the judge's does not leak into it");
    assert.ok(runner.describeFallback?.(JUDGE_TASK));
  });

  test("a fallback that cannot be built is said at start-up, loudly; the judge itself still runs", () => {
    for (const bad of [
      { JUDGE_FALLBACK_RUNNER: "hermes", JUDGE_FALLBACK_MODEL: "profile" },
      { JUDGE_FALLBACK_RUNNER: "claude" },
      { JUDGE_FALLBACK_MODEL: FALLBACK },
      { JUDGE_FALLBACK_RUNNER: "openrouter", JUDGE_FALLBACK_MODEL: "openrouter/auto" },
    ]) {
      const env = { ...BASE, ...bad };
      const lines: string[] = [];
      const judge = groupJudgeFromEnv(modelRunnerFromEnv(env), env, (l) => lines.push(l));
      assert.ok(judge?.model(), JSON.stringify(bad));
      assert.ok(lines.some((l) => l.includes("model_runner.judge_fallback_unusable") && l.includes('"warn"')), `${JSON.stringify(bad)}: ${lines.join("\n")}`);
    }
  });

  test("a wired fallback is on the relay.group_judge start-up line; an out-of-range timeout is said", () => {
    const env = { ...BASE, JUDGE_FALLBACK_RUNNER: "claude", JUDGE_FALLBACK_MODEL: FALLBACK, JUDGE_FALLBACK_TIMEOUT_MS: "60000" };
    const lines: string[] = [];
    groupJudgeFromEnv(modelRunnerFromEnv(env), env, (l) => lines.push(l));
    const start = lines.find((l) => l.includes("relay.group_judge\""))!;
    assert.ok(start.includes('"fallback_runner":"claude"') && start.includes(`"fallback_model":"${FALLBACK}"`) && start.includes('"fallback_timeout_ms":10000'), start);
    assert.ok(lines.some((l) => l.includes("model_runner.judge_timeout_clamped") && l.includes("JUDGE_FALLBACK_TIMEOUT_MS")));
    const quiet: string[] = [];
    groupJudgeFromEnv(modelRunnerFromEnv(BASE), BASE, (l) => quiet.push(l));
    assert.ok(!quiet.some((l) => l.includes("fallback_runner") || l.includes("judge_fallback_unusable")));
  });

  test("end to end through the real runners: a 402 from OpenRouter reaches the Claude CLI, which is given its own 8 s, not the primary's 3 s", async () => {
    await withFakeBinDir("kinerary-judge-fallback-", async (dir) => {
      const bin = await writeFakeBin(dir, "claude", [
        // Slower than the primary's 3 s, faster than the fallback's own budget.
        "setTimeout(() => {",
        '  const text = JSON.stringify({ for_assistant: true, confidence: 0.95 });',
        '  process.stdout.write(JSON.stringify({ type: "result", subtype: "success", is_error: false, result: text }));',
        "}, 3300);",
      ]);
      const env = { ...BASE, CLAUDE_BIN: bin, JUDGE_FALLBACK_RUNNER: "claude", JUDGE_FALLBACK_MODEL: FALLBACK, JUDGE_EFFORT: "high" };
      const original = globalThis.fetch;
      let fetches = 0;
      globalThis.fetch = (async () => { fetches += 1; return new Response(JSON.stringify({ error: { message: "Insufficient credits" } }), { status: 402 }); }) as typeof fetch;
      const warn = console.warn;
      console.warn = () => {};
      try {
        const runner = switchableRunner(modelRunnerFromEnv(env)!, () => undefined);
        const lines: string[] = [];
        const judge = groupJudgeFromEnv(runner, env, (l) => lines.push(l))!;
        const outcome: JudgeOutcome = await judge.judge(INPUT);
        assert.equal(fetches, 1, "OpenRouter was tried first");
        assert.equal(outcome.kind, "yes", JSON.stringify(outcome));
        assert.equal((outcome as { usedFallback?: boolean }).usedFallback, true);
        assert.equal(outcome.model, FALLBACK);
        assert.ok(outcome.ms >= 3300);
      } finally {
        globalThis.fetch = original;
        console.warn = warn;
      }
    });
  });

  test("the fallback's effort is its own: JUDGE_EFFORT (the primary's) is not inherited, JUDGE_FALLBACK_EFFORT is used", async () => {
    await withFakeBinDir("kinerary-judge-fallback-effort-", async (dir) => {
      const bin = await writeFakeBin(dir, "claude", [
        "const argv = process.argv.slice(2);",
        'const verdict = { for_assistant: true, confidence: 0.9, effort: argv[argv.indexOf("--effort") + 1] };',
        'process.stdout.write(JSON.stringify({ type: "result", subtype: "success", is_error: false, result: JSON.stringify(verdict) }));',
      ]);
      const original = globalThis.fetch;
      globalThis.fetch = (async () => new Response(JSON.stringify({ error: { message: "Insufficient credits" } }), { status: 402 })) as typeof fetch;
      const warn = console.warn;
      console.warn = () => {};
      try {
        const effortOf = async (extra: Record<string, string>) => {
          const env = { ...BASE, CLAUDE_BIN: bin, JUDGE_EFFORT: "high", JUDGE_FALLBACK_RUNNER: "claude", JUDGE_FALLBACK_MODEL: FALLBACK, ...extra };
          const result = await modelRunnerFromEnv(env)!.run({ task: JUDGE_TASK, prompt: "p", parse: (raw) => raw as { effort: string } });
          assert.equal(result.usedFallback, true);
          return result.ok ? result.value.effort : `${result.reason}: ${result.detail}`;
        };
        assert.equal(await effortOf({}), "low");
        assert.equal(await effortOf({ JUDGE_FALLBACK_EFFORT: "medium" }), "medium");
      } finally {
        globalThis.fetch = original;
        console.warn = warn;
      }
    });
  });
});
