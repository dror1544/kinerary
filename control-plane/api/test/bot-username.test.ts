import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { createBotUsernameResolver } from "../src/bot-username.js";

function getMeFetch(result: unknown, calls: string[], status = 200): typeof fetch {
  return (async (url: string | URL | Request) => {
    calls.push(String(url));
    return new Response(JSON.stringify(result), { status });
  }) as typeof fetch;
}

describe("createBotUsernameResolver", () => {
  test("a configured handle is returned as is (leading @ stripped) and Telegram is never called", async () => {
    const calls: string[] = [];
    const resolve = createBotUsernameResolver({
      configured: "@Kinerary_bot", botToken: "tok", fetchImpl: getMeFetch({}, calls),
    });
    assert.equal(await resolve(), "Kinerary_bot");
    assert.deepEqual(calls, []);
  });

  test("an absent handle is derived from getMe on the bot token, once, then cached", async () => {
    const calls: string[] = [];
    const resolve = createBotUsernameResolver({
      configured: null,
      botToken: "123:abc",
      fetchImpl: getMeFetch({ ok: true, result: { id: 1, is_bot: true, username: "Derived_bot" } }, calls),
    });
    assert.equal(await resolve(), "Derived_bot");
    assert.equal(await resolve(), "Derived_bot");
    assert.equal(calls.length, 1, "cached after the first success");
    assert.match(calls[0]!, /\/bot123:abc\/getMe$/);
  });

  test("a handle that is not a Telegram username shape is not used, configured or derived", async () => {
    const calls: string[] = [];
    const resolve = createBotUsernameResolver({
      configured: "not a handle",
      botToken: "tok",
      fetchImpl: getMeFetch({ ok: true, result: { username: "bad handle!" } }, calls),
    });
    assert.equal(await resolve(), null);
  });

  test("a failed getMe is null and is NOT cached: the next call tries again", async () => {
    let n = 0;
    const resolve = createBotUsernameResolver({
      configured: null,
      botToken: "tok",
      fetchImpl: (async () => {
        n += 1;
        if (n === 1) return new Response("nope", { status: 502 });
        return new Response(JSON.stringify({ ok: true, result: { username: "Later_bot" } }), { status: 200 });
      }) as typeof fetch,
    });
    assert.equal(await resolve(), null);
    assert.equal(await resolve(), "Later_bot");
  });

  test("a network error is null, never a throw", async () => {
    const resolve = createBotUsernameResolver({
      configured: undefined,
      botToken: "tok",
      fetchImpl: (async () => { throw new Error("ECONNRESET"); }) as typeof fetch,
    });
    assert.equal(await resolve(), null);
  });

  test("no handle and no token: null", async () => {
    const resolve = createBotUsernameResolver({ configured: null, botToken: undefined });
    assert.equal(await resolve(), null);
  });

  test("the bot token never appears in anything it logs", async () => {
    const lines: string[] = [];
    const resolve = createBotUsernameResolver({
      configured: null,
      botToken: "999:SECRET-TOKEN",
      log: (l) => lines.push(l),
      fetchImpl: (async () => { throw new Error("connect failed for https://api.telegram.org/bot999:SECRET-TOKEN/getMe"); }) as typeof fetch,
    });
    assert.equal(await resolve(), null);
    assert.ok(lines.length > 0, "a failure is logged");
    assert.ok(!lines.join("\n").includes("SECRET-TOKEN"), lines.join("\n"));
  });
});
