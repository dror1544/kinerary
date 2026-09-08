/**
 * The OpenRouter adapter, with fetch injected — no network, no key.
 *
 * The assertions that matter most are not about happy-path parsing. They are
 * about what the request does NOT contain (a model-fallback array), and about
 * a limit reaching the caller as a limit. Both are the 2026-09-07 failure
 * written as tests: a 429 let OpenRouter's own fallback finish an interview
 * under a different model, in the wrong language, and nothing upstream could
 * tell that from success.
 */
import assert from "node:assert/strict";
import { describe, test } from "node:test";
import {
  DEFAULT_EXTRACT_MODEL,
  composeRunners,
  completionText,
  isJsonModeRejection,
  modelRunnerFromEnv,
  openRouterKey,
  openRouterRunner,
  openRouterSpec,
  reasonForStatus,
  worthRetrying,
  type StructuredModelRunner,
} from "../src/model-runner.js";

const identity = (raw: unknown) => (raw && typeof raw === "object" ? raw : null);

/** A fetch double: one queued reply per call, plus the requests it received. */
function fakeFetch(replies: readonly { status: number; body: unknown }[]) {
  const seen: { url: string; body: Record<string, unknown>; headers: Record<string, string> }[] = [];
  let i = 0;
  const doFetch = (async (url: string, init: RequestInit) => {
    seen.push({
      url: String(url),
      body: JSON.parse(String(init.body)),
      headers: init.headers as Record<string, string>,
    });
    const reply = replies[i++] ?? { status: 500, body: { error: { message: "no reply queued" } } };
    const text = typeof reply.body === "string" ? reply.body : JSON.stringify(reply.body);
    return {
      ok: reply.status >= 200 && reply.status < 300,
      status: reply.status,
      text: async () => text,
    } as Response;
  }) as unknown as typeof fetch;
  return { doFetch, seen };
}

function completion(content: string) {
  return { choices: [{ message: { content } }] };
}

function runnerWith(replies: readonly { status: number; body: unknown }[], over = {}) {
  const { doFetch, seen } = fakeFetch(replies);
  const runner = openRouterRunner(
    { extract: openRouterSpec(DEFAULT_EXTRACT_MODEL, "sk-test", 5000, over) },
    doFetch,
  );
  return { runner, seen };
}

describe("reasonForStatus", () => {
  test("maps the statuses that mean different things", () => {
    assert.equal(reasonForStatus(401, ""), "UNAUTHORIZED");
    assert.equal(reasonForStatus(403, ""), "UNAUTHORIZED");
    assert.equal(reasonForStatus(429, ""), "RATE_LIMITED");
    // 402 is OpenRouter for out of credits: a limit, not a fault.
    assert.equal(reasonForStatus(402, ""), "RATE_LIMITED");
    assert.equal(reasonForStatus(408, ""), "TIMED_OUT");
    assert.equal(reasonForStatus(504, ""), "TIMED_OUT");
    assert.equal(reasonForStatus(500, ""), "UPSTREAM_ERROR");
    assert.equal(reasonForStatus(503, ""), "UPSTREAM_ERROR");
    assert.equal(reasonForStatus(400, "bad request"), "FAILED");
  });

  test("a limit named only in the body is still a limit", () => {
    assert.equal(reasonForStatus(400, "quota exceeded for this key"), "RATE_LIMITED");
  });

  test("only transient reasons are retried, and never onto another model", () => {
    assert.equal(worthRetrying("UPSTREAM_ERROR"), true);
    assert.equal(worthRetrying("RATE_LIMITED"), true);
    assert.equal(worthRetrying("TIMED_OUT"), true);
    assert.equal(worthRetrying("UNAUTHORIZED"), false);
    assert.equal(worthRetrying("BAD_OUTPUT"), false);
  });
});

describe("completionText", () => {
  test("reads a plain string content", () => {
    assert.equal(completionText(completion("hello")), "hello");
  });

  test("joins content returned as parts", () => {
    assert.equal(
      completionText({ choices: [{ message: { content: [{ text: "a" }, { text: "b" }] } }] }),
      "ab",
    );
  });

  test("null rather than a throw for a shape it does not know", () => {
    assert.equal(completionText({}), null);
    assert.equal(completionText({ choices: [] }), null);
    assert.equal(completionText(null), null);
  });
});

describe("openRouterRunner", () => {
  test("a good completion parses", async () => {
    const { runner } = runnerWith([{ status: 200, body: completion('{"phases":[]}') }]);
    const result = await runner.run({ task: "extract", prompt: "p", parse: identity });
    assert.equal(result.ok, true);
    assert.deepEqual(result.ok && result.value, { phases: [] });
    assert.equal(result.attempts, 1);
  });

  // THE assertion. OpenRouter's `models: [...]` silently substitutes another
  // model when the first is unavailable — the exact shape of the 2026-09-07
  // failure. It must never be in the request.
  test("the request carries no model-fallback array", async () => {
    const { runner, seen } = runnerWith([{ status: 200, body: completion("{}") }]);
    await runner.run({ task: "extract", prompt: "p", parse: identity });
    assert.equal("models" in seen[0]!.body, false);
    assert.equal(seen[0]!.body.model, DEFAULT_EXTRACT_MODEL);
  });

  test("structuring is deterministic, not creative", async () => {
    const { runner, seen } = runnerWith([{ status: 200, body: completion("{}") }]);
    await runner.run({ task: "extract", prompt: "p", parse: identity });
    assert.equal(seen[0]!.body.temperature, 0);
  });

  test("the key travels as a bearer token and the prompt as the user message", async () => {
    const { runner, seen } = runnerWith([{ status: 200, body: completion("{}") }]);
    await runner.run({ task: "extract", prompt: "read this", parse: identity });
    assert.equal(seen[0]!.headers.authorization, "Bearer sk-test");
    assert.deepEqual(seen[0]!.body.messages, [{ role: "user", content: "read this" }]);
    assert.match(seen[0]!.url, /\/chat\/completions$/);
  });

  test("a rate limit is retried on the SAME model, then surfaced as a limit", async () => {
    const { runner, seen } = runnerWith([
      { status: 429, body: "rate limited" },
      { status: 429, body: "rate limited" },
      { status: 429, body: "rate limited" },
    ]);
    const result = await runner.run({ task: "extract", prompt: "p", parse: identity });
    assert.equal(result.ok, false);
    assert.equal(result.ok === false && result.reason, "RATE_LIMITED");
    assert.equal(result.attempts, 3);
    assert.deepEqual(new Set(seen.map((s) => s.body.model)), new Set([DEFAULT_EXTRACT_MODEL]));
  });

  test("a transient upstream error recovers on retry", async () => {
    const { runner } = runnerWith([
      { status: 503, body: "upstream down" },
      { status: 200, body: completion('{"ok":true}') },
    ]);
    const result = await runner.run({ task: "extract", prompt: "p", parse: identity });
    assert.equal(result.ok, true);
    assert.equal(result.attempts, 2);
  });

  test("a rejected key is not retried — a second identical call cannot help", async () => {
    const { runner, seen } = runnerWith([{ status: 401, body: "invalid key" }]);
    const result = await runner.run({ task: "extract", prompt: "p", parse: identity });
    assert.equal(result.ok === false && result.reason, "UNAUTHORIZED");
    assert.equal(seen.length, 1);
  });

  test("an error object inside a 200 is a failure, not a completion", async () => {
    const embedded = { status: 200, body: { error: { message: "upstream 429", code: 429 } } };
    const { runner } = runnerWith([embedded, embedded, embedded]);
    const result = await runner.run({ task: "extract", prompt: "p", parse: identity });
    assert.equal(result.ok === false && result.reason, "RATE_LIMITED");
  });

  test("an embedded error recovers on retry like any transient one", async () => {
    const { runner } = runnerWith([
      { status: 200, body: { error: { message: "provider temporarily unavailable", code: 502 } } },
      { status: 200, body: completion('{"ok":true}') },
    ]);
    const result = await runner.run({ task: "extract", prompt: "p", parse: identity });
    assert.equal(result.ok, true);
    assert.equal(result.attempts, 2);
  });

  test("output the parser refuses is BAD_OUTPUT and is not retried", async () => {
    const { runner, seen } = runnerWith([{ status: 200, body: completion("I'd be glad to help!") }]);
    const result = await runner.run({ task: "extract", prompt: "p", parse: identity });
    assert.equal(result.ok === false && result.reason, "BAD_OUTPUT");
    assert.equal(seen.length, 1);
  });

  test("no key configured is NOT_CONFIGURED, and costs no request", async () => {
    const { doFetch, seen } = fakeFetch([]);
    const runner = openRouterRunner({ extract: openRouterSpec(DEFAULT_EXTRACT_MODEL, "", 5000) }, doFetch);
    const result = await runner.run({ task: "extract", prompt: "p", parse: identity });
    assert.equal(result.ok === false && result.reason, "NOT_CONFIGURED");
    assert.equal(seen.length, 0);
  });

  test("a task nobody configured is NOT_CONFIGURED", async () => {
    const { runner } = runnerWith([]);
    const result = await runner.run({ task: "interpret", prompt: "p", parse: identity });
    assert.equal(result.ok === false && result.reason, "NOT_CONFIGURED");
  });

  // A model without json mode must not be a permanent failure.
  test("a model that rejects response_format is retried without it, and remembered", async () => {
    const { doFetch, seen } = fakeFetch([
      { status: 400, body: { error: { message: "response_format is not supported" } } },
      { status: 200, body: completion('{"phases":[]}') },
      { status: 200, body: completion('{"phases":[]}') },
    ]);
    // Its own model id, so the process-lifetime memo cannot leak between tests.
    const runner = openRouterRunner({ extract: openRouterSpec("vendor/no-json-mode", "sk-test", 5000) }, doFetch);

    const first = await runner.run({ task: "extract", prompt: "p", parse: identity });
    assert.equal(first.ok, true);
    assert.equal(first.attempts, 2);
    assert.ok("response_format" in seen[0]!.body, "first attempt asks for json mode");
    assert.equal("response_format" in seen[1]!.body, false, "retry drops it");

    const second = await runner.run({ task: "extract", prompt: "p", parse: identity });
    assert.equal(second.attempts, 1, "remembered — no wasted request the second time");
    assert.equal("response_format" in seen[2]!.body, false);
  });

  test("isJsonModeRejection tells that 400 apart from a real one", () => {
    assert.equal(isJsonModeRejection("response_format is not supported"), true);
    assert.equal(isJsonModeRejection("json mode unavailable for this model"), true);
    assert.equal(isJsonModeRejection("context length exceeded"), false);
  });
});

describe("composeRunners", () => {
  test("routes each task to its own runner", async () => {
    const stub = (tag: string): StructuredModelRunner => ({
      run: async () => ({ ok: true, value: tag as never, attempts: 1, ms: 0 }),
    });
    const runner = composeRunners({ interpret: stub("i"), extract: stub("e") });
    assert.equal((await runner.run({ task: "interpret", prompt: "", parse: identity })).ok, true);
    const e = await runner.run({ task: "extract", prompt: "", parse: identity });
    assert.equal(e.ok && e.value, "e");
    const missing = await runner.run({ task: "phrase", prompt: "", parse: identity });
    assert.equal(missing.ok === false && missing.reason, "NOT_CONFIGURED");
  });
});

describe("modelRunnerFromEnv", () => {
  test("nothing configured means no runner at all", () => {
    assert.equal(modelRunnerFromEnv({}), undefined);
  });

  test("openrouter without a key is not a runner — it would fail every call", () => {
    assert.equal(modelRunnerFromEnv({ EXTRACT_RUNNER: "openrouter" }), undefined);
  });

  test("extract defaults to MiniMax, the model the extract profile already names", async () => {
    const runner = modelRunnerFromEnv({ EXTRACT_RUNNER: "openrouter", OPENROUTER_API_KEY: "sk-x" });
    assert.ok(runner);
    // interpret stays unconfigured: one task being wired must not imply the other.
    const interpret = await runner.run({ task: "interpret", prompt: "", parse: identity });
    assert.equal(interpret.ok === false && interpret.reason, "NOT_CONFIGURED");
  });

  test("each task is pinned separately", async () => {
    const runner = modelRunnerFromEnv({
      OPENROUTER_API_KEY: "sk-x",
      EXTRACT_RUNNER: "openrouter",
      EXTRACT_MODEL: "vendor/long-context",
      INTERPRET_RUNNER: "openrouter",
      INTERPRET_MODEL: "vendor/cheap-precise",
    });
    assert.ok(runner);
  });

  test("the key can come from a file", () => {
    assert.equal(openRouterKey({ OPENROUTER_API_KEY_FILE: "/nonexistent" }), "");
    assert.equal(openRouterKey({ OPENROUTER_API_KEY: " sk-y " }), "sk-y");
  });
});
