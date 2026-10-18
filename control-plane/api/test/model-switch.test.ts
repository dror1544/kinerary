/**
 * Switching a task's model at runtime — the parts that need no database.
 *
 * The property that matters most is the one a fallback would break: a call runs
 * start to finish on the model it started with. An override changes what LATER
 * calls get, and never a call already in flight.
 */
import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { parseInbound } from "../src/chat-router.js";
import type { RunnerResult, StructuredModelRequest, StructuredModelRunner } from "../src/model-runner.js";
import { MODEL_TASKS, runnerForBinding, taskTimeoutMs } from "../src/model-runner.js";
import { handleModelCommand, isSwitchableRunner, parseBinding, switchableRunner, verifyCodexOverrides } from "../src/model-task-settings.js";

/** A runner that names itself and answers with its own name. */
function named(provider: string, model: string, gate?: Promise<void>): StructuredModelRunner & { calls: number } {
  const runner = {
    calls: 0,
    describe: () => ({ provider, model }),
    async run<T>(req: StructuredModelRequest<T>): Promise<RunnerResult<T>> {
      runner.calls += 1;
      if (gate) await gate;
      return { ok: true, value: req.parse({ served: `${provider}:${model}` }) as T, attempts: 1, ms: 0 };
    },
  };
  return runner;
}

const identity = (raw: unknown) => raw;

describe("command arguments", () => {
  test("a command carries its arguments, and a bare command parses exactly as before", () => {
    assert.deepEqual(parseInbound("/model extract_intake codex:gpt-5.6-luna"), {
      kind: "command", name: "model", argument: "extract_intake codex:gpt-5.6-luna",
    });
    assert.deepEqual(parseInbound("/model@KineraryBot interpret default"), {
      kind: "command", name: "model", argument: "interpret default",
    });
    assert.deepEqual(parseInbound("/models"), { kind: "command", name: "models", argument: null });
    assert.deepEqual(parseInbound("/help   "), { kind: "command", name: "help", argument: null });
  });
});

describe("parseBinding", () => {
  test("runner:model, default, and nothing else", () => {
    assert.deepEqual(parseBinding("codex:gpt-5.6-luna"), { runner: "codex", model: "gpt-5.6-luna" });
    assert.deepEqual(parseBinding("openrouter:vendor/model:free"), { runner: "openrouter", model: "vendor/model:free" });
    assert.equal(parseBinding("default"), "default");
    assert.equal(parseBinding("gpt:4"), null, "not a runner this relay has");
    assert.equal(parseBinding("claude:"), null);
    assert.equal(parseBinding("claude-sonnet-5"), null);
  });
});

describe("switchableRunner", () => {
  test("an override replaces one task's binding, and clearing it returns that task to the environment", async () => {
    const env = named("claude", "claude-sonnet-5");
    const runner = switchableRunner(env, (_task, b) => named(b.runner, b.model));
    assert.ok(isSwitchableRunner(runner));

    assert.deepEqual(runner.effective("extract_intake"), { binding: { runner: "claude", model: "claude-sonnet-5" }, source: "environment" });

    runner.apply(new Map([["extract_intake", { runner: "codex", model: "gpt-5.6-luna" }]]));
    assert.deepEqual(runner.describe?.("extract_intake"), { provider: "codex", model: "gpt-5.6-luna" });
    assert.deepEqual(runner.describe?.("interpret"), { provider: "claude", model: "claude-sonnet-5" }, "other tasks untouched");
    const served = await runner.run({ task: "extract_intake", prompt: "p", parse: identity });
    assert.deepEqual(served.ok && served.value, { served: "codex:gpt-5.6-luna" });

    runner.apply(new Map());
    const back = await runner.run({ task: "extract_intake", prompt: "p", parse: identity });
    assert.deepEqual(back.ok && back.value, { served: "claude:claude-sonnet-5" });
  });

  test("a call already running finishes on the model it started with", async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const env = named("claude", "claude-sonnet-5", gate);
    const runner = switchableRunner(env, (_task, b) => named(b.runner, b.model));

    const inFlight = runner.run({ task: "extract_intake", prompt: "p", parse: identity });
    runner.apply(new Map([["extract_intake", { runner: "codex", model: "gpt-5.6-luna" }]]));
    release();

    const result = await inFlight;
    assert.deepEqual(result.ok && result.value, { served: "claude:claude-sonnet-5" });
  });

  test("a binding that cannot serve is reported as such, and never silently used", () => {
    const env = named("claude", "claude-sonnet-5");
    const runner = switchableRunner(env, (task, b) => runnerForBinding(b.runner, b.model, taskTimeoutMs(task), task, {}));
    assert.equal(runner.canServe("extract_intake", { runner: "openrouter", model: "vendor/model" }), false, "no key in this environment");
    assert.equal(runner.canServe("extract_intake", { runner: "openrouter", model: "openrouter/auto" }), false, "a model that picks models");
    assert.equal(runner.canServe("extract_intake", { runner: "codex", model: "gpt-5.6-luna" }), true);
  });
});

describe("/model refusals", () => {
  test("read_image on a runner that cannot take files is refused, says why, and writes nothing", async () => {
    const env = named("claude", "claude-sonnet-5");
    const runner = switchableRunner(env, (task, b) => runnerForBinding(b.runner, b.model, taskTimeoutMs(task), task, {}));
    // No database: a refusal must return before anything is recorded, so any
    // touch of this object would throw.
    const db = new Proxy({}, { get: () => { throw new Error("a refused binding touched the database"); } }) as never;
    const reply = await handleModelCommand(db, runner, { name: "model", args: "read_image codex:gpt-5.6-luna" }, "sha256:" + "0".repeat(64));
    assert.match(reply, /read_image sends files, which only claude or openrouter can take/);
    assert.match(reply, /Nothing changed/);
    assert.deepEqual(runner.effective("read_image"), { binding: { runner: "claude", model: "claude-sonnet-5" }, source: "environment" });
  });
});

describe("/model codex is verified before it is saved (#58)", () => {
  const touchedDb = () => new Proxy({}, { get: () => { throw new Error("DB-TOUCHED"); } }) as never;
  const codexRunnerFor = () =>
    switchableRunner(named("claude", "claude-sonnet-5"), (task, b) => runnerForBinding(b.runner, b.model, taskTimeoutMs(task), task, {}));
  const admin = "sha256:" + "0".repeat(64);

  test("a codex that fails the isolation probe is refused and nothing is recorded", async () => {
    const reply = await handleModelCommand(
      touchedDb(), codexRunnerFor(), { name: "model", args: "extract_intake codex:gpt-5.6-luna" }, admin,
      () => {}, async () => "codex does not know isolation feature(s): shell_tool",
    );
    assert.match(reply, /cannot serve calls/);
    assert.match(reply, /shell_tool/);
    assert.match(reply, /Nothing changed/);
  });

  test("a codex that cannot be probed at all is refused, not trusted", async () => {
    const reply = await handleModelCommand(
      touchedDb(), codexRunnerFor(), { name: "model", args: "extract_intake codex:gpt-5.6-luna" }, admin,
      () => {}, async () => 'cannot run "codex features list": ENOENT',
    );
    assert.match(reply, /Nothing changed/);
  });

  test("a verified codex passes the gate (and only then reaches the database)", async () => {
    await assert.rejects(
      handleModelCommand(
        touchedDb(), codexRunnerFor(), { name: "model", args: "extract_intake codex:gpt-5.6-luna" }, admin,
        () => {}, async () => null,
      ),
      /DB-TOUCHED/,
    );
  });

  test("overrides loaded from the database are verified, and an unverifiable codex latches the refusal", async () => {
    const env: NodeJS.ProcessEnv = {};
    const lines: string[] = [];
    await verifyCodexOverrides(new Map([["extract_intake", { runner: "codex", model: "gpt-5.6-luna" }]]), (l) => lines.push(l), async () => "no codex", env);
    assert.equal(env.KINERARY_CODEX_ISOLATION_UNVERIFIED, "1");
    assert.match(lines.join(""), /codex_isolation_unverified/);
    // No codex among the overrides: nothing probed, nothing latched.
    const clean: NodeJS.ProcessEnv = {};
    await verifyCodexOverrides(new Map([["interpret", { runner: "claude", model: "m" }]]), () => {}, async () => { throw new Error("probed"); }, clean);
    assert.equal(clean.KINERARY_CODEX_ISOLATION_UNVERIFIED, undefined);
  });
});

describe("the task table", () => {
  test("names every switchable task, and timeouts inherit the way bindings do", () => {
    const tasks = MODEL_TASKS.map((t) => t.task);
    for (const task of ["interpret", "extract_intake", "extract_itinerary"]) assert.ok(tasks.includes(task), task);
    assert.equal(taskTimeoutMs("extract_intake", { EXTRACT_TIMEOUT_MS: "200000" }), 200_000);
    assert.equal(taskTimeoutMs("extract_intake", { EXTRACT_TIMEOUT_MS: "200000", EXTRACT_INTAKE_TIMEOUT_MS: "90000" }), 90_000);
    assert.equal(taskTimeoutMs("extract_itinerary", {}), 90_000);
  });
});
