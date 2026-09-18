/**
 * A completion with no message at all is the host failing, not the model
 * answering — retried on the SAME model, never failed on the first attempt and
 * never sent to another model.
 */
import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { openRouterRunner, openRouterSpec } from "../src/model-runner.js";

function fetchSequence(bodies: unknown[]) {
  const models: string[] = [];
  let i = 0;
  const fetcher = (async (_url: unknown, init?: { body?: unknown }) => {
    models.push(JSON.parse(String(init?.body)).model);
    const body = bodies[Math.min(i, bodies.length - 1)];
    i += 1;
    return new Response(JSON.stringify(body), { status: 200 });
  }) as typeof fetch;
  return { fetcher, models };
}

const empty = { choices: [{ message: { content: null }, finish_reason: "stop" }] };
const answered = { choices: [{ message: { content: '{"ok": true}' } }], usage: { prompt_tokens: 10, completion_tokens: 3, cost: 0.00001 } };

describe("OpenRouter: an empty completion", () => {
  test("is retried on the same model and the next answer is used", async () => {
    const { fetcher, models } = fetchSequence([empty, answered]);
    const runner = openRouterRunner({ t: openRouterSpec("minimax/minimax-m3", "sk-fake", 5_000) }, fetcher);
    const res = await runner.run({ task: "t", prompt: "p", parse: (raw: unknown) => raw });
    assert.equal(res.ok, true, res.ok ? "" : `${res.reason} ${res.detail}`);
    assert.equal(res.attempts, 2);
    assert.deepEqual(models, ["minimax/minimax-m3", "minimax/minimax-m3"], "never another model");
    if (res.ok) assert.deepEqual(res.usage, { inputTokens: 10, outputTokens: 3, costUsd: 0.00001, costKind: "billed" });
  });

  test("empty on every attempt ends as an upstream error naming the finish reason", async () => {
    const { fetcher, models } = fetchSequence([empty]);
    const runner = openRouterRunner({ t: openRouterSpec("minimax/minimax-m3", "sk-fake", 5_000) }, fetcher);
    const res = await runner.run({ task: "t", prompt: "p", parse: (raw: unknown) => raw });
    assert.equal(res.ok, false);
    if (!res.ok) {
      assert.equal(res.reason, "UPSTREAM_ERROR");
      assert.match(res.detail ?? "", /finish_reason: stop/);
    }
    assert.equal(models.length, 3, "the spec's attempt budget, all on one model");
  });
});
