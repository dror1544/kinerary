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
import { HttpTelegramClient, isPermanentRefusal, REQUEST_TIMEOUT_MS, RETRY_AFTER_CAP_SECONDS } from "../src/relay/telegram-api.js";

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

  test("ONLY a 400 is permanent: a 401, a 403 and a 404 are not (round 2) - the bot blocked, the token revoked or a chat gone is no verdict on THIS message", async () => {
    for (const [status, description] of [
      [401, "Unauthorized"],
      [403, "Forbidden: bot was blocked by the user"],
      [404, "Not Found"],
      [409, "Conflict: terminated by other getUpdates request"],
    ] as const) {
      const { result, calls, waits } = await send([{ status, body: { ok: false, error_code: status, description } }]);
      assert.equal(result.ok, false, String(status));
      assert.notEqual(result.permanent, true, `${status} must be transient`);
      assert.equal(isPermanentRefusal(result), false, String(status));
      assert.equal(calls.length, 1, `${status}: not retried`);
      assert.deepEqual(waits, [], `${status}: not waited on`);
    }
    const { result } = await send([badRequest]);
    assert.equal(isPermanentRefusal(result), true, "and a 400 still is");
  });

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

  test("a timed-out call leaks it neither (#225 item 8): the log names the method, the error is a fixed word", async () => {
    for (const honoursAbort of [true, false]) {
      const { result, logs } = await sendHung({ honoursAbort });
      for (const line of logs) assert.ok(!line.includes(TOKEN) && !line.includes("SECRET"), line);
      assert.ok(!String(result.error ?? "").includes("SECRET"), String(result.error));
      assert.ok(!String(result.error ?? "").includes("api.telegram.org"), String(result.error));
    }
  });
});

/**
 * A connection that never answers: `fetch` that never settles. `honoursAbort`
 * is what undici does (the signal rejects it); a stub that ignores the signal
 * is the worst case, and the call must still come back within its bound.
 */
function stubHungFetch({ honoursAbort }: { honoursAbort: boolean }) {
  const calls: string[] = [];
  const realFetch = globalThis.fetch;
  globalThis.fetch = ((input: string | URL, init?: RequestInit) => {
    calls.push(String(input));
    return new Promise<Response>((_resolve, reject) => {
      if (!honoursAbort) return;
      init?.signal?.addEventListener("abort", () => {
        // What undici rejects with; its message would be the only place a URL could ride.
        reject(new DOMException(`This operation was aborted: ${String(input)}`, "AbortError"));
      });
    });
  }) as typeof fetch;
  return { calls, restore: () => { globalThis.fetch = realFetch; } };
}

const SHORT_TIMEOUT_MS = 30;

async function sendHung(opts: { honoursAbort: boolean }, method: "send" | "edit" = "send") {
  const t = stubHungFetch(opts);
  const logs: string[] = [];
  const waits: number[] = [];
  const c = new HttpTelegramClient(TOKEN, (line) => logs.push(line), undefined, {
    sleep: async (ms) => { waits.push(ms); },
    timeoutMs: SHORT_TIMEOUT_MS,
  });
  try {
    const started = Date.now();
    const result = method === "send"
      ? await c.sendMessage({ chatId: "900", text: "hello" })
      : await c.editMessageText({ chatId: "900", messageId: "7", text: "hello" });
    return { result, logs, waits, calls: t.calls, took: Date.now() - started };
  } finally {
    t.restore();
  }
}

describe("#225 item 8: a hung connection is bounded, transient, and not retried", () => {
  for (const honoursAbort of [true, false]) {
    test(`a fetch that never settles (${honoursAbort ? "honours" : "ignores"} the abort) returns transient within the bound`, async () => {
      const { result, calls, waits, took, logs } = await sendHung({ honoursAbort });
      assert.equal(result.ok, false);
      assert.notEqual(result.permanent, true, "a timeout is no verdict on the message");
      assert.equal(isPermanentRefusal(result), false);
      assert.equal(result.error, "TIMEOUT", "a fixed word, like NETWORK");
      assert.equal(calls.length, 1, "not retried: only a short 429 is");
      assert.deepEqual(waits, [], "nothing waited out");
      assert.ok(took < 2000, `bounded by the timeout, not by undici's default: ${took}ms`);
      assert.ok(logs.some((l) => l.includes("telegram_api.call_timed_out") && l.includes("sendMessage")), logs.join("\n"));
    });
  }

  for (const body of ["never settles", "rejects late"] as const) {
    test(`round 2 (R2): headers arrive at once but the body ${body} - transient TIMEOUT within the bound, not retried, no token, no unhandled rejection`, async () => {
      const calls: string[] = [];
      const realFetch = globalThis.fetch;
      const unhandled: unknown[] = [];
      const onUnhandled = (reason: unknown) => { unhandled.push(reason); };
      process.on("unhandledRejection", onUnhandled);
      // A response whose status line is in and whose body is not: the connection
      // hangs after the headers. The stub does not wire the signal into the body,
      // so only the bound on the body read can end the wait.
      globalThis.fetch = (async (input: string | URL) => {
        calls.push(String(input));
        return {
          ok: true,
          status: 200,
          text: () => new Promise<string>((_resolve, reject) => {
            if (body === "rejects late") {
              setTimeout(() => reject(new Error(`socket closed for ${String(input)}`)), SHORT_TIMEOUT_MS * 3);
            }
          }),
        } as unknown as Response;
      }) as typeof fetch;
      const logs: string[] = [];
      const waits: number[] = [];
      try {
        const c = new HttpTelegramClient(TOKEN, (line) => logs.push(line), undefined, {
          sleep: async (ms) => { waits.push(ms); },
          timeoutMs: SHORT_TIMEOUT_MS,
        });
        const started = Date.now();
        const result = await c.sendMessage({ chatId: "900", text: "hello" });
        const took = Date.now() - started;
        // Long enough for the late rejection to land, and for an unhandled one to be reported.
        await new Promise((r) => setTimeout(r, SHORT_TIMEOUT_MS * 6));
        assert.equal(result.ok, false);
        assert.equal(result.error, "TIMEOUT");
        assert.equal(isPermanentRefusal(result), false);
        assert.equal(calls.length, 1, "not retried");
        assert.deepEqual(waits, []);
        assert.ok(took < 2000, `${took}ms`);
        for (const line of logs) assert.ok(!line.includes(TOKEN) && !line.includes("SECRET"), line);
        assert.ok(!String(result.error).includes("SECRET"));
        assert.deepEqual(unhandled, [], "no unhandled rejection");
      } finally {
        globalThis.fetch = realFetch;
        process.off("unhandledRejection", onUnhandled);
      }
    });
  }

  test("an edit carries the same bound and the same verdict", async () => {
    const { result, calls } = await sendHung({ honoursAbort: true }, "edit");
    assert.equal(result.ok, false);
    assert.equal(isPermanentRefusal(result), false);
    assert.equal(result.error, "TIMEOUT");
    assert.equal(calls.length, 1);
  });

  test("round 2 (R7a): the request carries an abort signal, and the timer aborts it - the hung connection is CANCELLED, not merely abandoned (a late delivery would be a duplicate)", async () => {
    const signals: (AbortSignal | undefined)[] = [];
    const realFetch = globalThis.fetch;
    // Ignores the signal on purpose: the race ends the wait either way, so only
    // looking at the signal tells whether the connection itself was cancelled.
    globalThis.fetch = ((_input: string | URL, init?: RequestInit) => {
      signals.push(init?.signal ?? undefined);
      return new Promise<Response>(() => {});
    }) as typeof fetch;
    try {
      const c = new HttpTelegramClient(TOKEN, () => {}, undefined, { timeoutMs: SHORT_TIMEOUT_MS });
      const result = await c.sendMessage({ chatId: "900", text: "hello" });
      assert.equal(result.error, "TIMEOUT");
      assert.equal(signals.length, 1);
      assert.ok(signals[0] instanceof AbortSignal, "the request was handed a signal");
      assert.equal(signals[0]!.aborted, true, "and the timer aborted it");
    } finally {
      globalThis.fetch = realFetch;
    }
  });

  test("round 2 (R4): a MarkdownV2 send whose FIRST attempt hangs is not followed by the plain-text fallback (a timeout is not a parse error)", async () => {
    const t = stubHungFetch({ honoursAbort: true });
    try {
      const c = new HttpTelegramClient(TOKEN, () => {}, undefined, { sleep: async () => {}, timeoutMs: SHORT_TIMEOUT_MS });
      const result = await c.sendMessage({ chatId: "900", text: "hello.", parseMode: "MarkdownV2" });
      assert.equal(result.error, "TIMEOUT");
      assert.equal(t.calls.length, 1, "one attempt: no fallback, no retry");
    } finally {
      t.restore();
    }
  });

  test("round 2 (R4): the longest sendMessage - MarkdownV2: 429, wait, parse error; plain fallback: 429, wait, hang - is 2 waits and ONE timeout, under the gateway's 30 s outbound wait", async () => {
    // Scripted replies; the fourth call hangs. A hang is never retried and is not
    // a parse error, so nothing follows it.
    const script = [
      rateLimited(RETRY_AFTER_CAP_SECONDS),
      { status: 400, body: { ok: false, error_code: 400, description: "Bad Request: can't parse entities: bad" } },
      rateLimited(RETRY_AFTER_CAP_SECONDS),
      "hang" as const,
    ];
    const calls: string[] = [];
    const realFetch = globalThis.fetch;
    globalThis.fetch = ((input: string | URL) => {
      calls.push(String(input));
      const reply = script[calls.length - 1] ?? "hang";
      if (reply === "hang") return new Promise<Response>(() => {});
      return Promise.resolve(new Response(JSON.stringify(reply.body), { status: reply.status }));
    }) as typeof fetch;
    const waits: number[] = [];
    try {
      const c = new HttpTelegramClient(TOKEN, () => {}, undefined, { sleep: async (ms) => { waits.push(ms); }, timeoutMs: SHORT_TIMEOUT_MS });
      const result = await c.sendMessage({ chatId: "900", text: "hello.", parseMode: "MarkdownV2" });
      assert.equal(result.error, "TIMEOUT");
      assert.equal(calls.length, 4, "nothing after the hang");
      assert.deepEqual(waits, [RETRY_AFTER_CAP_SECONDS * 1000, RETRY_AFTER_CAP_SECONDS * 1000]);
    } finally {
      globalThis.fetch = realFetch;
    }
    // In production: the waits above plus one REQUEST_TIMEOUT_MS (plus round trips).
    assert.ok(REQUEST_TIMEOUT_MS >= 5_000, String(REQUEST_TIMEOUT_MS));
    assert.ok(2 * RETRY_AFTER_CAP_SECONDS * 1000 + REQUEST_TIMEOUT_MS < 30_000, String(REQUEST_TIMEOUT_MS));
  });

  test("a call that answers in time is untouched by the timer, and the timer does not outlive it", async () => {
    const t = stubFetch([ok]);
    try {
      const c = new HttpTelegramClient(TOKEN, () => {}, undefined, { timeoutMs: SHORT_TIMEOUT_MS });
      const result = await c.sendMessage({ chatId: "900", text: "hello" });
      assert.equal(result.ok, true);
      // Long past the bound: a timer left armed would have aborted nothing, but
      // must not have been counted against a later call either.
      await new Promise((r) => setTimeout(r, SHORT_TIMEOUT_MS * 3));
      const again = await c.sendMessage({ chatId: "900", text: "hello" });
      assert.equal(again.ok, true);
    } finally {
      t.restore();
    }
  });
});
