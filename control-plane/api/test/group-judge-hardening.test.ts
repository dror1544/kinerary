/**
 * The group judge, review round 2 (no database): fenced verdicts, only the
 * completion's `content` is read, JUDGE_DATA_COLLECTION, the JUDGE_TIMEOUT_MS
 * clamp, HTTP-runner-only bindings (env and `/model`), and the circuit breaker.
 */
import assert from "node:assert/strict";
import { describe, test } from "node:test";
import {
  createGroupJudge,
  groupJudgeFromEnv,
  JudgeRateLimiter,
  JUDGE_TASK,
  parseJudgeVerdict,
} from "../src/relay/group-judge.js";
import {
  CODEX_LUNA_MODEL,
  isJudgeRunner,
  judgeDataCollection,
  judgeEffort,
  judgeTimeoutMs,
  modelRunnerFromEnv,
  OPENROUTER_TASK_OPTIONS,
  openRouterRunner,
  openRouterSpec,
  runnerForBinding,
  taskTimeoutMs,
  type StructuredModelRunner,
} from "../src/model-runner.js";
import { handleModelCommand, switchableRunner } from "../src/model-task-settings.js";
import { withFakeBinDir, writeFakeBin } from "./support/child-env-harness.js";
import { JUDGE_FALLBACK_REASONS } from "../src/analytics/contract.js";

const pick = (out: { kind: string; reason?: string }) =>
  out.kind === "fallback" ? { kind: out.kind, reason: out.reason } : { kind: out.kind };

/** A runner bound to the judge task that never answers anything useful. */
function boundRunner(): StructuredModelRunner {
  return {
    describe: (task) => (task === JUDGE_TASK ? { provider: "fake", model: "vendor/judge-model" } : null),
    run: (async () => ({ ok: false, reason: "FAILED", attempts: 1, ms: 1 })) as unknown as StructuredModelRunner["run"],
  };
}

function withFetch<T>(fetcher: typeof fetch, fn: () => Promise<T>): Promise<T> {
  const original = globalThis.fetch;
  globalThis.fetch = fetcher;
  return fn().finally(() => { globalThis.fetch = original; });
}

describe("parseJudgeVerdict - fenced text (liquid-style answers)", () => {
  const body = '{"for_assistant": true, "confidence": 0.9}';
  test("accepts one JSON object with surrounding whitespace and one code fence, with or without 'json'", () => {
    const expected = { forAssistant: true, confidence: 0.9 };
    for (const text of [
      body,
      `  \n${body}\n  `,
      "```json\n" + body + "\n```",
      "```JSON\n" + body + "\n```\n",
      "```\n" + body + "\n```",
      "  ```json\n{\n  \"for_assistant\": true,\n  \"confidence\": 0.9\n}\n```  ",
      "```json\n" + body + "\n```\n\nThe message asks about check-in times, so it is for the assistant.",
      "```json\n" + body + "\n``` and that is my answer",
      "```json" + body + "```",
    ]) {
      assert.deepEqual(parseJudgeVerdict(text), expected, JSON.stringify(text));
    }
  });

  test("stays strict: truncated, wrong fields, prose around it, two objects, an open fence, wrong types", () => {
    for (const text of [
      "```json\n{\n  \"ok\": true\n",
      "```json\n{\"ok\": true}\n```",
      `Sure! ${body}`,
      `${body} ${body}`,
      "```json\n" + body + "\n``` then another: ```json\n" + body + "\n```",
      "```json\n" + body + "\n```\nOr maybe {\"for_assistant\": false, \"confidence\": 1}",
      "Here you go:\n```json\n" + body + "\n```",
      "```json\n" + body,
      '```json\n{"for_assistant": "true", "confidence": 0.9}\n```',
      '```json\n{"for_assistant": true, "confidence": 1.5}\n```',
      "```json\n[" + body + "]\n```",
      "",
      "   ",
    ]) {
      assert.equal(parseJudgeVerdict(text), null, JSON.stringify(text));
    }
  });
});

describe("what the OpenRouter runner hands the parser", () => {
  function completion(message: Record<string, unknown>, finish = "stop") {
    const fetcher = (async () =>
      new Response(JSON.stringify({ choices: [{ message, finish_reason: finish }] }), { status: 200 })) as unknown as typeof fetch;
    return openRouterRunner({ group_judge: openRouterSpec("vendor/m", "sk-test", 3000, OPENROUTER_TASK_OPTIONS.group_judge) }, fetcher);
  }
  const run = (runner: StructuredModelRunner) => runner.run({ task: "group_judge", prompt: "p", parse: parseJudgeVerdict });

  test("a fenced reply is read end to end", async () => {
    const result = await run(completion({ content: '```json\n{\n  "for_assistant": true,\n  "confidence": 0.85\n}\n```\n' }));
    assert.deepEqual(result.ok && result.value, { forAssistant: true, confidence: 0.85 });
  });

  test("only `content` is parsed: a reasoning field holding a different verdict is ignored", async () => {
    const result = await run(completion({
      reasoning: 'Thinking it over... maybe {"for_assistant": false, "confidence": 1}. Hmm.',
      content: '{"for_assistant": true, "confidence": 0.9}',
    }));
    assert.deepEqual(result.ok && result.value, { forAssistant: true, confidence: 0.9 });
  });

  test("reasoning but no content (the budget went on thinking) fails; it is never read from the reasoning", async () => {
    const result = await run(completion({ content: null, reasoning: '{"for_assistant": true, "confidence": 1}' }, "length"));
    assert.equal(result.ok, false);
  });

  test("the answer budget leaves room for a short reasoning pass", () => {
    assert.equal(OPENROUTER_TASK_OPTIONS.group_judge?.maxOutputTokens, 512);
  });
});

describe("JUDGE_DATA_COLLECTION - deny by default, allow when the owner says so, judge only", () => {
  const ok = '{"for_assistant": false, "confidence": 0.9}';
  async function sent(task: string, env: NodeJS.ProcessEnv): Promise<Record<string, unknown>> {
    const bodies: Record<string, unknown>[] = [];
    const fetcher = (async (_u: string, init?: { body?: string }) => {
      bodies.push(JSON.parse(init?.body ?? "{}"));
      return new Response(JSON.stringify({ choices: [{ message: { content: ok } }] }), { status: 200 });
    }) as unknown as typeof fetch;
    await withFetch(fetcher, async () => {
      const runner = runnerForBinding("openrouter", "vendor/m", 3000, task, { OPENROUTER_API_KEY: "sk-test", ...env });
      await runner!.run({ task, prompt: "p", parse: (raw) => raw as object });
    });
    return bodies[0]!;
  }

  test("unset, 'deny', and anything unrecognised send data_collection: deny", async () => {
    for (const env of [{}, { JUDGE_DATA_COLLECTION: "" }, { JUDGE_DATA_COLLECTION: "deny" }, { JUDGE_DATA_COLLECTION: "DENY" }, { JUDGE_DATA_COLLECTION: "maybe" }]) {
      assert.deepEqual((await sent("group_judge", env)).provider, { data_collection: "deny" }, JSON.stringify(env));
    }
  });

  test("'allow' sends no provider field at all; the rest of the request is unchanged", async () => {
    const body = await sent("group_judge", { JUDGE_DATA_COLLECTION: "allow" });
    assert.equal("provider" in body, false);
    assert.equal(body.max_tokens, 512);
    assert.equal(body.model, "vendor/m");
  });

  test("the parser: allow only for exactly allow; a typo is flagged and reads as deny", () => {
    assert.deepEqual(judgeDataCollection({}), { policy: "deny", invalid: false });
    assert.deepEqual(judgeDataCollection({ JUDGE_DATA_COLLECTION: " Allow " }), { policy: "allow", invalid: false });
    assert.deepEqual(judgeDataCollection({ JUDGE_DATA_COLLECTION: "alow" }), { policy: "deny", invalid: true });
  });

  test("the effective policy is logged once at start, and a typo is warned about", () => {
    const lines: string[] = [];
    const runner = { ...boundRunner() };
    groupJudgeFromEnv(runner, { JUDGE_DATA_COLLECTION: "allow" }, (l) => lines.push(l));
    assert.match(lines.join("\n"), /"data_collection":"allow"/);
    const typo: string[] = [];
    groupJudgeFromEnv(runner, { JUDGE_DATA_COLLECTION: "alow" }, (l) => typo.push(l));
    assert.match(typo.join("\n"), /judge_data_collection_invalid/);
    assert.match(typo.join("\n"), /"data_collection":"deny"/);
  });

  test("other OpenRouter tasks never get a provider field from it", async () => {
    assert.equal("provider" in (await sent("extract", { JUDGE_DATA_COLLECTION: "deny" })), false);
    assert.equal("provider" in (await sent("extract", { JUDGE_DATA_COLLECTION: "allow" })), false);
  });
});

describe("JUDGE_TIMEOUT_MS is clamped per runner: openrouter (0, 3000], claude and codex (0, 10000] with a default of 8000", () => {
  test("openrouter and unknown kinds: above 3000 clamps, junk reads as 3000, in range is kept", () => {
    for (const kind of [undefined, "openrouter", "fake"]) {
      assert.deepEqual(judgeTimeoutMs({ JUDGE_TIMEOUT_MS: "10000" }, kind), { ms: 3000, clamped: "above", ceiling: 3000 }, String(kind));
      assert.deepEqual(judgeTimeoutMs({ JUDGE_TIMEOUT_MS: "3000" }, kind), { ms: 3000, clamped: null, ceiling: 3000 });
      assert.deepEqual(judgeTimeoutMs({ JUDGE_TIMEOUT_MS: "1500" }, kind), { ms: 1500, clamped: null, ceiling: 3000 });
      assert.deepEqual(judgeTimeoutMs({}, kind), { ms: 3000, clamped: null, ceiling: 3000 });
      for (const bad of ["0", "-5", "abc", "NaN"]) assert.deepEqual(judgeTimeoutMs({ JUDGE_TIMEOUT_MS: bad }, kind), { ms: 3000, clamped: "invalid", ceiling: 3000 }, bad);
    }
  });

  test("claude and codex: default 8000, ceiling 10000, junk reads as 8000", () => {
    for (const kind of ["claude", "codex"]) {
      assert.deepEqual(judgeTimeoutMs({}, kind), { ms: 8000, clamped: null, ceiling: 10000 }, kind);
      assert.deepEqual(judgeTimeoutMs({ JUDGE_TIMEOUT_MS: "6000" }, kind), { ms: 6000, clamped: null, ceiling: 10000 });
      assert.deepEqual(judgeTimeoutMs({ JUDGE_TIMEOUT_MS: "10000" }, kind), { ms: 10000, clamped: null, ceiling: 10000 });
      assert.deepEqual(judgeTimeoutMs({ JUDGE_TIMEOUT_MS: "10001" }, kind), { ms: 10000, clamped: "above", ceiling: 10000 });
      assert.deepEqual(judgeTimeoutMs({ JUDGE_TIMEOUT_MS: "60000" }, kind), { ms: 10000, clamped: "above", ceiling: 10000 });
      for (const bad of ["0", "-5", "abc"]) assert.deepEqual(judgeTimeoutMs({ JUDGE_TIMEOUT_MS: bad }, kind), { ms: 8000, clamped: "invalid", ceiling: 10000 }, bad);
    }
  });

  test("it applies where the binding is built: taskTimeoutMs follows JUDGE_RUNNER, and the OpenRouter call is aborted at 3 s", async () => {
    assert.equal(taskTimeoutMs("group_judge", { JUDGE_TIMEOUT_MS: "9000" }), 3000);
    assert.equal(taskTimeoutMs("group_judge", { JUDGE_RUNNER: "claude", JUDGE_TIMEOUT_MS: "9000" }), 9000);
    assert.equal(taskTimeoutMs("group_judge", { JUDGE_RUNNER: "codex" }), 8000);
    assert.equal(taskTimeoutMs("group_judge", { JUDGE_RUNNER: "claude", JUDGE_TIMEOUT_MS: "99999" }), 10000);
    let aborted = false;
    const started = Date.now();
    const hang = ((_u: string, init?: { signal?: AbortSignal }) =>
      new Promise((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => { aborted = true; reject(Object.assign(new Error("t"), { name: "TimeoutError" })); });
      })) as unknown as typeof fetch;
    // 60 s asked for; the call must be cut near 3 s. (AbortSignal.timeout does not
    // keep the event loop alive, so this test holds it open itself.)
    const keepAlive = setTimeout(() => {}, 10_000);
    const result = await withFetch(hang, async () => {
      const runner = modelRunnerFromEnv({ OPENROUTER_API_KEY: "sk", JUDGE_RUNNER: "openrouter", JUDGE_MODEL: "vendor/m", JUDGE_TIMEOUT_MS: "60000" });
      return runner!.run({ task: "group_judge", prompt: "p", parse: parseJudgeVerdict });
    });
    clearTimeout(keepAlive);
    assert.equal(result.ok, false);
    assert.equal(aborted, true);
    assert.ok(Date.now() - started < 8_000, "cut at about 3 s, not 60 s");
  });

  test("the hard stop follows the bound runner's kind, and a clamped value is warned about once at start", () => {
    const lines: string[] = [];
    groupJudgeFromEnv(boundRunner(), { JUDGE_TIMEOUT_MS: "20000" }, (l) => lines.push(l));
    assert.equal(lines.filter((l) => l.includes("judge_timeout_clamped")).length, 1);
    assert.match(lines.join("\n"), /"effective_ms":3000/);
    assert.match(lines.join("\n"), /above the 3000 ms ceiling/);
    const cli = (provider: string): StructuredModelRunner => ({
      describe: (task) => (task === JUDGE_TASK ? { provider, model: "m" } : null),
      run: (async () => ({ ok: false })) as unknown as StructuredModelRunner["run"],
    });
    const claudeLines: string[] = [];
    groupJudgeFromEnv(cli("claude"), { JUDGE_TIMEOUT_MS: "20000" }, (l) => claudeLines.push(l));
    assert.match(claudeLines.join("\n"), /"effective_ms":10000/);
    assert.match(claudeLines.join("\n"), /above the 10000 ms ceiling/);
    const quiet: string[] = [];
    groupJudgeFromEnv(cli("codex"), {}, (l) => quiet.push(l));
    assert.ok(!quiet.some((l) => l.includes("clamped")));
    assert.match(quiet.join("\n"), /"runner":"codex","timeout_ms":8000/);
    assert.match(quiet.join("\n"), /"effort":"low"/, "the CLI runners' start line states the effort");
    assert.ok(!quiet.join("\n").includes("data_collection"), "and not the OpenRouter-only policy");
    const fine: string[] = [];
    groupJudgeFromEnv(boundRunner(), { JUDGE_TIMEOUT_MS: "1500" }, (l) => fine.push(l));
    assert.ok(!fine.some((l) => l.includes("clamped")));
  });
});

describe("the judge takes openrouter, claude or codex - never hermes", () => {
  const ENV = { OPENROUTER_API_KEY: "sk" } as NodeJS.ProcessEnv;

  test("the allow matrix at the binding: openrouter, claude and codex build; hermes does not; other tasks keep hermes", () => {
    assert.ok(runnerForBinding("openrouter", "vendor/m", 3000, "group_judge", ENV));
    assert.ok(runnerForBinding("claude", "claude-haiku-4-5-20251001", 3000, "group_judge", {}));
    assert.ok(runnerForBinding("codex", "gpt-5.6-luna", 3000, "group_judge", {}));
    assert.equal(runnerForBinding("hermes", "profile", 3000, "group_judge", {}), undefined);
    assert.equal(isJudgeRunner("hermes"), false);
    assert.ok(runnerForBinding("hermes", "profile", 45000, "interpret", {}), "hermes still serves the tasks it served");
  });

  test("the allow matrix from the environment: JUDGE_RUNNER=claude or codex binds (codex defaults to the luna model), hermes does not", () => {
    assert.deepEqual(modelRunnerFromEnv({ JUDGE_RUNNER: "claude", JUDGE_MODEL: "claude-haiku-4-5-20251001" })?.describe?.("group_judge"), { provider: "claude", model: "claude-haiku-4-5-20251001" });
    assert.deepEqual(modelRunnerFromEnv({ JUDGE_RUNNER: "codex" })?.describe?.("group_judge"), { provider: "codex", model: CODEX_LUNA_MODEL });
    assert.deepEqual(modelRunnerFromEnv({ JUDGE_RUNNER: "codex", JUDGE_MODEL: "gpt-6-luna" })?.describe?.("group_judge"), { provider: "codex", model: "gpt-6-luna" });
    assert.equal(modelRunnerFromEnv({ JUDGE_RUNNER: "hermes", JUDGE_MODEL: "profile" }), undefined);
    assert.equal(modelRunnerFromEnv({ JUDGE_RUNNER: "claude" }), undefined, "claude has no default model: configuration, not a guess");
  });

  test("/model group_judge: openrouter, claude and codex are accepted (they reach the database); hermes is refused with the reason and writes nothing", async () => {
    const runner = switchableRunner(boundRunner(), (task, b) => runnerForBinding(b.runner, b.model, taskTimeoutMs(task), task, { OPENROUTER_API_KEY: "sk" }));
    const touched = () => new Proxy({}, { get: () => { throw new Error("DB-TOUCHED"); } }) as never;
    const admin = "sha256:" + "0".repeat(64);
    const verified = async () => null;
    for (const binding of ["openrouter:vendor/m", "claude:claude-haiku-4-5-20251001", "codex:gpt-5.6-luna"]) {
      await assert.rejects(handleModelCommand(touched(), runner, { name: "model", args: `group_judge ${binding}` }, admin, () => {}, verified), /DB-TOUCHED/, binding);
    }
    const reply = await handleModelCommand(touched(), runner, { name: "model", args: "group_judge hermes:profile" }, admin, () => {}, verified);
    assert.match(reply, /group_judge takes only openrouter:<model>, claude:<model> or codex:<model>/);
    assert.match(reply, /hermes is an agent runtime/);
    assert.match(reply, /Nothing changed/);
    assert.equal(runner.effective("group_judge").source, "environment");
  });

  test("codex for the judge stays behind the isolation gate: an unverified codex is no binding, and /model runs the probe", async () => {
    assert.equal(runnerForBinding("codex", "gpt-5.6-luna", 8000, "group_judge", { KINERARY_CODEX_ISOLATION_UNVERIFIED: "1" }), undefined);
    assert.equal(modelRunnerFromEnv({ JUDGE_RUNNER: "codex", KINERARY_CODEX_ISOLATION_UNVERIFIED: "1" }), undefined);
    const runner = switchableRunner(boundRunner(), (task, b) => runnerForBinding(b.runner, b.model, taskTimeoutMs(task), task, {}));
    const touched = new Proxy({}, { get: () => { throw new Error("DB-TOUCHED"); } }) as never;
    const reply = await handleModelCommand(touched, runner, { name: "model", args: "group_judge codex:gpt-5.6-luna" }, "sha256:" + "0".repeat(64), () => {}, async () => "codex does not know isolation feature(s): shell_tool");
    assert.match(reply, /cannot serve calls/);
    assert.match(reply, /shell_tool/);
    assert.match(reply, /Nothing changed/);
  });

  test("an unusable JUDGE_RUNNER (hermes, or claude without a model) is named at start as unusable", () => {
    const none: StructuredModelRunner = { describe: () => null, run: (async () => ({ ok: false })) as unknown as StructuredModelRunner["run"] };
    for (const runnerName of ["hermes", "claude"]) {
      const lines: string[] = [];
      groupJudgeFromEnv(none, { JUDGE_RUNNER: runnerName }, (l) => lines.push(l));
      assert.match(lines.join("\n"), /judge_unusable/, runnerName);
      assert.match(lines.join("\n"), /openrouter, claude or codex/, runnerName);
    }
  });
});

describe("the CLI runners as the judge: what the call looks like", () => {
  /** What a fake CLI hands back: the verdict, plus the argv it was started with. */
  const withArgv = (parsed: unknown) => parsed as { for_assistant?: boolean; confidence?: number; argv: string[] };
  const parseWithArgv = (raw: unknown) => {
    const o = withArgv(raw);
    return { verdict: parseJudgeVerdict(raw), argv: o.argv };
  };

  test("claude: haiku-style model, effort low by default (so settings, hooks and MCP are dropped), no tools, one attempt; fence plus trailing prose is read", async () => {
    await withFakeBinDir("kinerary-judge-claude-", async (dir) => {
      const bin = await writeFakeBin(dir, "claude", [
        "const argv = process.argv.slice(2);",
        'const verdict = { for_assistant: true, confidence: 0.9, argv };',
        'const text = "```json\\n" + JSON.stringify(verdict) + "\\n```\\n\\nThe message asks about check-in, so it is for the assistant.";',
        'process.stdout.write(JSON.stringify({ type: "result", subtype: "success", is_error: false, result: text }));',
      ]);
      const runner = runnerForBinding("claude", "claude-haiku-4-5-20251001", 8000, "group_judge", { CLAUDE_BIN: bin });
      const result = await runner!.run({ task: "group_judge", prompt: "PROMPT", parse: parseWithArgv });
      assert.equal(result.ok, true, result.ok ? "" : `${result.reason}: ${result.detail}`);
      if (!result.ok) return;
      const { verdict, argv } = result.value;
      assert.deepEqual(verdict, { forAssistant: true, confidence: 0.9 });
      assert.equal(argv[argv.indexOf("--model") + 1], "claude-haiku-4-5-20251001");
      assert.equal(argv[argv.indexOf("--effort") + 1], "low");
      assert.equal(argv[argv.indexOf("--tools") + 1], "", "no tools");
      assert.ok(argv.includes("--strict-mcp-config") && argv.includes("--setting-sources"), "no MCP, no personal settings");
      assert.equal(result.attempts, 1, "one attempt: a retry would double the wait");
    });
  });

  test("claude: JUDGE_EFFORT overrides the default, a typo is refused at build time", () => {
    assert.ok(runnerForBinding("claude", "m", 8000, "group_judge", { JUDGE_EFFORT: "medium" }));
    assert.throws(() => runnerForBinding("claude", "m", 8000, "group_judge", { JUDGE_EFFORT: "fast" }), /not an effort level/);
    assert.equal(judgeEffort({}), "low");
    assert.equal(judgeEffort({ JUDGE_EFFORT: "HIGH" }), "high");
  });

  test("codex: the lowest effort the catalog offers, the same isolation flags, one attempt, and its answer is parsed", async () => {
    await withFakeBinDir("kinerary-judge-codex-", async (dir) => {
      const bin = await writeFakeBin(dir, "codex", [
        "const argv = process.argv.slice(2);",
        "const out = argv[argv.indexOf('-o') + 1];",
        "require('fs').writeFileSync(out, JSON.stringify({ for_assistant: false, confidence: 0.8, argv }));",
      ]);
      const runner = runnerForBinding("codex", CODEX_LUNA_MODEL, 8000, "group_judge", { CODEX_BIN: bin });
      const result = await runner!.run({ task: "group_judge", prompt: "PROMPT", parse: parseWithArgv, schema: { type: "object" } });
      assert.equal(result.ok, true, result.ok ? "" : `${result.reason}: ${result.detail}`);
      if (!result.ok) return;
      const { verdict, argv } = result.value;
      assert.deepEqual(verdict, { forAssistant: false, confidence: 0.8 });
      assert.equal(argv[argv.indexOf("-m") + 1], "gpt-5.6-luna");
      assert.ok(argv.some((a, i) => a === 'model_reasoning_effort="low"' && argv[i - 1] === "-c"), "the lowest level in the catalog");
      for (const flag of ["--ignore-user-config", "--ignore-rules", "--ephemeral", "--skip-git-repo-check"]) assert.ok(argv.includes(flag), flag);
      assert.ok(argv.some((a, i) => a === "--disable" && argv[i + 1] === "shell_tool"), "the isolation list every codex task gets");
      assert.ok(argv.some((a, i) => a === "-c" && argv[i + 1] === "mcp_servers={}"));
      assert.equal(argv[argv.indexOf("-s") + 1], "read-only");
      assert.equal(result.attempts, 1);
    });
  });

  test("codex: another task's call carries no effort flag at all", async () => {
    await withFakeBinDir("kinerary-judge-codex2-", async (dir) => {
      const bin = await writeFakeBin(dir, "codex", [
        "const argv = process.argv.slice(2);",
        "const out = argv[argv.indexOf('-o') + 1];",
        "require('fs').writeFileSync(out, JSON.stringify({ argv }));",
      ]);
      const runner = runnerForBinding("codex", CODEX_LUNA_MODEL, 8000, "interpret", { CODEX_BIN: bin });
      const result = await runner!.run({ task: "interpret", prompt: "P", parse: (raw) => raw as { argv: string[] } });
      assert.equal(result.ok, true);
      if (result.ok) assert.ok(!result.value.argv.some((a) => a.includes("model_reasoning_effort")));
    });
  });
});

describe("the circuit breaker", () => {
  const input = { chatId: "-100", text: "when do we leave?", assistantNames: ["Solo"], language: "en" as const };
  type Mode = "ok" | "error" | "hang" | "garbage" | "limited";
  function flaky() {
    let mode: Mode = "error";
    let calls = 0;
    const runner: StructuredModelRunner = {
      describe: (task) => (task === JUDGE_TASK ? { provider: "fake", model: "vendor/m" } : null),
      run: (async (req: { parse: (raw: unknown) => unknown }) => {
        calls += 1;
        if (mode === "hang") return new Promise(() => {});
        if (mode === "error") return { ok: false, reason: "UPSTREAM_ERROR", attempts: 1, ms: 1 };
        if (mode === "limited") return { ok: false, reason: "RATE_LIMITED", attempts: 1, ms: 1 };
        if (mode === "garbage") return { ok: false, reason: "BAD_OUTPUT", attempts: 1, ms: 1 };
        return { ok: true, value: req.parse({ for_assistant: false, confidence: 0.9 }), attempts: 1, ms: 1 };
      }) as unknown as StructuredModelRunner["run"],
    };
    return { runner, set: (m: Mode) => { mode = m; }, calls: () => calls };
  }
  const make = (f: ReturnType<typeof flaky>, lines: string[] = []) => {
    const clock = { t: 0 };
    const judge = createGroupJudge({
      runner: f.runner, timeoutMs: 40, now: () => clock.t, rateLimiter: new JudgeRateLimiter(10_000),
      breakerThreshold: 5, breakerCooldownMs: 300_000, log: (l) => lines.push(l),
    });
    return { clock, judge };
  };

  test("five consecutive errors open it: no call, reason circuit_open, one log line", async () => {
    const f = flaky();
    const lines: string[] = [];
    const { judge } = make(f, lines);
    for (let i = 0; i < 5; i += 1) assert.equal(pick(await judge.judge(input)).reason, "error");
    assert.equal(f.calls(), 5);
    const open = await judge.judge(input);
    assert.deepEqual(pick(open), { kind: "fallback", reason: "circuit_open" });
    assert.equal(open.ms, 0);
    for (let i = 0; i < 20; i += 1) await judge.judge(input);
    assert.equal(f.calls(), 5, "no call while open");
    assert.equal(lines.filter((l) => l.includes("group_judge_circuit_open")).length, 1, "logged once");
  });

  test("timeouts and the provider's own rate limit count; a success or a garbage answer resets the run", async () => {
    const f = flaky();
    const { judge } = make(f);
    f.set("hang");
    for (let i = 0; i < 2; i += 1) assert.equal(pick(await judge.judge(input)).reason, "timeout");
    f.set("limited");
    for (let i = 0; i < 2; i += 1) assert.equal(pick(await judge.judge(input)).reason, "rate_limited");
    f.set("garbage");
    assert.equal(pick(await judge.judge(input)).reason, "unparseable", "a garbage answer: the model is reachable");
    f.set("error");
    for (let i = 0; i < 4; i += 1) await judge.judge(input);
    f.set("ok");
    assert.equal((await judge.judge(input)).kind, "no", "4 failures after a reset do not open it");
    f.set("error");
    for (let i = 0; i < 4; i += 1) await judge.judge(input);
    f.set("ok");
    assert.equal((await judge.judge(input)).kind, "no", "a success in between keeps it closed");
  });

  test("after the cool-down ONE probe goes out; failure re-arms quietly, success closes it (logged once)", async () => {
    const f = flaky();
    const lines: string[] = [];
    const { judge, clock } = make(f, lines);
    for (let i = 0; i < 5; i += 1) await judge.judge(input);
    clock.t += 299_999;
    assert.equal(pick(await judge.judge(input)).reason, "circuit_open", "still cooling down");
    clock.t += 2;
    assert.equal(pick(await judge.judge(input)).reason, "error", "the probe: a real call, and it failed");
    assert.equal(f.calls(), 6);
    assert.equal(pick(await judge.judge(input)).reason, "circuit_open", "re-armed for another cool-down");
    clock.t += 300_001;
    f.set("ok");
    assert.equal((await judge.judge(input)).kind, "no", "the next probe succeeded");
    assert.equal((await judge.judge(input)).kind, "no", "and the circuit is closed: ordinary calls");
    assert.equal(lines.filter((l) => l.includes("group_judge_circuit_closed")).length, 1);
    assert.equal(lines.filter((l) => l.includes("group_judge_circuit_open")).length, 1, "no second 'open' line for the failed probe");
  });

  test("only one probe at a time: a concurrent call while the probe is out is circuit_open", async () => {
    const f = flaky();
    const { judge, clock } = make(f);
    for (let i = 0; i < 5; i += 1) await judge.judge(input);
    clock.t += 300_001;
    f.set("hang");
    const probe = judge.judge(input);
    const other = await judge.judge(input);
    assert.equal(pick(other).reason, "circuit_open");
    assert.equal(pick(await probe).reason, "timeout");
  });

  test("our own per-chat limit is not a provider failure and does not open it", async () => {
    const f = flaky();
    f.set("ok");
    const judge = createGroupJudge({ runner: f.runner, rateLimiter: new JudgeRateLimiter(1), breakerThreshold: 2 });
    await judge.judge(input);
    for (let i = 0; i < 6; i += 1) assert.equal(pick(await judge.judge(input)).reason, "rate_limited");
    assert.equal(f.calls(), 1);
  });

  test("circuit_open is a recordable fallback reason", () => {
    assert.ok((JUDGE_FALLBACK_REASONS as readonly string[]).includes("circuit_open"));
  });
});
