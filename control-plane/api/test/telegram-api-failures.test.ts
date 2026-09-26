/**
 * #225 item 5 - a transient Telegram failure is not a verdict.
 *
 * `HttpTelegramClient` says whether a failed call would fail again (`permanent`:
 * Telegram's 400 "Bad Request…" and nothing else), and waits out a 429 once, in
 * the call, only when `retry_after` is at most RETRY_AFTER_CAP_SECONDS - the
 * relay's poll loop awaits every send, so a longer wait would hold every chat.
 * The poller drops a waiting change only on `permanent`
 * (typed-changes-integrity-db.test.ts, "#225 item 5").
 */
import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { HttpTelegramClient, isPermanentRefusal, RETRY_AFTER_CAP_SECONDS } from "../src/relay/telegram-api.js";

const TOKEN = "123456:SECRET-token-value";

type Reply = { status: number; body: unknown } | "throw";

/** Replays `replies` in order (the last one repeats), recording each call. */
function stubFetch(replies: Reply[]) {
  const calls: string[] = [];
  const realFetch = globalThis.fetch;
  globalThis.fetch = (async (input: string | URL) => {
    calls.push(String(input));
    const reply = replies[Math.min(calls.length - 1, replies.length - 1)]!;
    if (reply === "throw") throw new TypeError(`fetch failed for ${String(input)}`);
    return new Response(JSON.stringify(reply.body), { status: reply.status });
  }) as typeof fetch;
  return { calls, restore: () => { globalThis.fetch = realFetch; } };
}

function client() {
  const logs: string[] = [];
  const waits: number[] = [];
  const c = new HttpTelegramClient(TOKEN, (line) => logs.push(line), undefined, {
    sleep: async (ms) => { waits.push(ms); },
  });
  return { c, logs, waits };
}

const ok = { status: 200, body: { ok: true, result: { message_id: 42 } } };
const rateLimited = (retryAfter: number) => ({
  status: 429,
  body: { ok: false, error_code: 429, description: `Too Many Requests: retry after ${retryAfter}`, parameters: { retry_after: retryAfter } },
});
const badRequest = { status: 400, body: { ok: false, error_code: 400, description: "Bad Request: message is too long" } };
const serverError = { status: 502, body: { ok: false, error_code: 502, description: "Bad Gateway" } };

async function send(replies: Reply[]) {
  const t = stubFetch(replies);
  const { c, logs, waits } = client();
  try {
    const result = await c.sendMessage({ chatId: "900", text: "hello" });
    return { result, logs, waits, calls: t.calls };
  } finally {
    t.restore();
  }
}

describe("#225: a failed send says whether it would fail again", () => {
  test("a 400 Bad Request is permanent: not retried, and the caller can tell", async () => {
    const { result, calls, waits } = await send([badRequest]);
    assert.equal(result.ok, false);
    assert.equal(result.permanent, true);
    assert.equal(isPermanentRefusal(result), true);
    assert.equal(calls.length, 1);
    assert.deepEqual(waits, []);
  });

  for (const [label, replies] of [
    ["a 5xx", [serverError]],
    ["the network (fetch throws)", ["throw"]],
    ["a 429 longer than the cap", [rateLimited(RETRY_AFTER_CAP_SECONDS + 1)]],
    ["a 429 without retry_after", [{ status: 429, body: { ok: false, error_code: 429, description: "Too Many Requests" } }]],
  ] as const) {
    test(`${label} is transient: ok false, NOT permanent, and not waited on`, async () => {
      const { result, calls, waits } = await send([...replies] as Reply[]);
      assert.equal(result.ok, false);
      assert.notEqual(result.permanent, true);
      assert.equal(isPermanentRefusal(result), false);
      assert.equal(calls.length, 1, "no retry");
      assert.deepEqual(waits, [], "nothing held the caller");
    });
  }

  test("a status of 400 without Telegram's body is still permanent; ok:false with no code at all is not", async () => {
    const plain = await send([{ status: 400, body: "not json" }]);
    assert.equal(plain.result.permanent, true);
    const odd = await send([{ status: 200, body: { ok: false, description: "Bad Request: can't parse entities" } }]);
    assert.equal(odd.result.ok, false);
    assert.equal(isPermanentRefusal(odd.result), false, "no 400 anywhere: not called permanent on the strength of a string");
  });

  test("an edit carries the same verdict", async () => {
    const t = stubFetch([badRequest]);
    try {
      const { c } = client();
      const edited = await c.editMessageText({ chatId: "900", messageId: "7", text: "x" });
      assert.equal(isPermanentRefusal(edited), true);
    } finally {
      t.restore();
    }
  });

  test("isPermanentRefusal never calls a success, a missing result, or an unclassified failure permanent", () => {
    assert.equal(isPermanentRefusal({ ok: true, permanent: true }), false);
    assert.equal(isPermanentRefusal(undefined), false);
    assert.equal(isPermanentRefusal(null), false);
    assert.equal(isPermanentRefusal({ ok: false }), false);
  });
});

describe("#225: a 429 is waited out once, inside the call, only up to the cap", () => {
  test("retry_after within the cap: waited for exactly that long, retried once, delivered", async () => {
    const { result, calls, waits } = await send([rateLimited(1), ok]);
    assert.equal(result.ok, true);
    assert.equal(result.messageId, "42");
    assert.equal(calls.length, 2);
    assert.deepEqual(waits, [1000]);
  });

  test("at the cap exactly: still waited out", async () => {
    const { result, waits } = await send([rateLimited(RETRY_AFTER_CAP_SECONDS), ok]);
    assert.equal(result.ok, true);
    assert.deepEqual(waits, [RETRY_AFTER_CAP_SECONDS * 1000]);
  });

  test("rate-limited again after the wait: ONE retry only, and the result is transient", async () => {
    const { result, calls, waits } = await send([rateLimited(1), rateLimited(1), ok]);
    assert.equal(result.ok, false);
    assert.equal(isPermanentRefusal(result), false);
    assert.equal(calls.length, 2, "never a third attempt");
    assert.deepEqual(waits, [1000]);
  });

  test("the cap is small: a caller is never held longer than a few seconds by one call", () => {
    assert.ok(RETRY_AFTER_CAP_SECONDS > 0 && RETRY_AFTER_CAP_SECONDS <= 5, String(RETRY_AFTER_CAP_SECONDS));
  });

  test("the real wait is a timer: a 1s retry_after takes about a second, not zero and not forever", async () => {
    const t = stubFetch([rateLimited(1), ok]);
    try {
      const c = new HttpTelegramClient(TOKEN, () => {});
      const started = Date.now();
      const result = await c.sendMessage({ chatId: "900", text: "hello" });
      const took = Date.now() - started;
      assert.equal(result.ok, true);
      assert.ok(took >= 900 && took < 3000, `${took}ms`);
    } finally {
      t.restore();
    }
  });
});

describe("#225: nothing added leaks the bot token", () => {
  test("no log line and no error string carries it, whatever failed", async () => {
    for (const replies of [[rateLimited(1), ok], [rateLimited(60)], [badRequest], [serverError], ["throw"]] as Reply[][]) {
      const { result, logs } = await send(replies);
      for (const line of logs) assert.ok(!line.includes(TOKEN) && !line.includes("SECRET"), line);
      assert.ok(!String(result.error ?? "").includes("SECRET"), String(result.error));
    }
    const limited = await send([rateLimited(60)]);
    assert.ok(limited.logs.some((l) => l.includes("telegram_api.rate_limited")), "the rate limit is logged, as the method only");
  });
});
