import assert from "node:assert/strict";
import { test } from "node:test";
import { createTripAppReadiness } from "../src/relay/trip-app-readiness.js";
import type { BotIdentityResult } from "../src/telegram-mini-app.js";

/** Replays answers in order; the last repeats. */
function answers(list: (BotIdentityResult | "throw")[]) {
  let calls = 0;
  return {
    check: async (): Promise<BotIdentityResult> => {
      const next = list[Math.min(calls, list.length - 1)]!;
      calls += 1;
      if (next === "throw") throw new Error("network");
      return next;
    },
    calls: () => calls,
  };
}

const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

test("no Mini App configured (no web block / token): never ready, and nothing is asked", async () => {
  const readiness = createTripAppReadiness({ check: null });
  await readiness.start();
  assert.equal(readiness.ready(), false);
  readiness.stop();
});

test("ready only when the bot is confirmed AND says it has its Main Mini App", async () => {
  const yes = createTripAppReadiness({ check: answers([{ ok: true, hasMainWebApp: true }]).check });
  await yes.start();
  assert.equal(yes.ready(), true);
  yes.stop();

  // Every other answer - the BotFather step undone, unknown, refused, unreachable, a thrown error - is not ready.
  for (const answer of [
    { ok: true, hasMainWebApp: false },
    { ok: true, hasMainWebApp: null },
    { ok: false, reason: "UNREACHABLE" },
    { ok: false, reason: "UNUSABLE" },
    { ok: false, reason: "MISMATCH" },
    "throw",
  ] as const) {
    const readiness = createTripAppReadiness({ check: answers([answer]).check, retryMs: 1_000_000 });
    await readiness.start();
    assert.equal(readiness.ready(), false, JSON.stringify(answer));
    readiness.stop();
  }
});

test("before the first answer it is not ready (unknown is not ready)", () => {
  const readiness = createTripAppReadiness({ check: answers([{ ok: true, hasMainWebApp: true }]).check });
  assert.equal(readiness.ready(), false);
});

test("it turns ready later without a restart, and says so through onChange", async () => {
  const source = answers([
    { ok: false, reason: "UNREACHABLE" },
    { ok: true, hasMainWebApp: false },
    { ok: true, hasMainWebApp: false },
    { ok: true, hasMainWebApp: true },
  ]);
  const changes: boolean[] = [];
  const readiness = createTripAppReadiness({ check: source.check, retryMs: 5, onChange: (value) => changes.push(value) });
  await readiness.start();
  assert.equal(readiness.ready(), false, "first round: unreachable");
  const deadline = Date.now() + 5000;
  while (!readiness.ready() && Date.now() < deadline) await wait(5);
  assert.equal(readiness.ready(), true, "BotFather done, noticed on a later round");
  await wait(30);
  assert.deepEqual(changes, [true], "one flip, reported once");
  const callsWhenReady = source.calls();
  await wait(30);
  assert.equal(source.calls(), callsWhenReady, "and it stops asking once ready");
  readiness.stop();
});

test("a blip after it is ready never turns it off", async () => {
  const source = answers([{ ok: true, hasMainWebApp: true }, { ok: false, reason: "UNREACHABLE" }]);
  const readiness = createTripAppReadiness({ check: source.check, retryMs: 1_000_000 });
  await readiness.start();
  assert.equal(readiness.ready(), true);
  await readiness.runOnce();
  assert.equal(readiness.ready(), true);
  readiness.stop();
});

test("a token for another bot is final: not ready, and not asked again", async () => {
  const source = answers([{ ok: false, reason: "MISMATCH" }, { ok: true, hasMainWebApp: true }]);
  const readiness = createTripAppReadiness({ check: source.check, retryMs: 5 });
  await readiness.start();
  await wait(40);
  assert.equal(readiness.ready(), false);
  assert.equal(source.calls(), 1);
  readiness.stop();
});

test("a check that keeps throwing never crashes and never reads as ready", async () => {
  const source = answers(["throw"]);
  const readiness = createTripAppReadiness({ check: source.check, retryMs: 5 });
  await readiness.start();
  await wait(30);
  assert.equal(readiness.ready(), false);
  assert.ok(source.calls() > 1, "it keeps trying");
  readiness.stop();
});
