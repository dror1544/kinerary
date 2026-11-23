import { afterEach, describe, test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { startFakeWhatsApp, type FakeWhatsApp } from "../tools/fake-whatsapp.js";

const SECRET = "stand-in-test-secret-0123456789";
const ALICE = "100000000000001@lid";
const GROUP = "120000000000000001@g.us";
const api = join(dirname(fileURLToPath(import.meta.url)), "..");

const started: FakeWhatsApp[] = [];
afterEach(async () => {
  while (started.length) await started.pop()!.close();
});
async function fake(): Promise<FakeWhatsApp> {
  const f = await startFakeWhatsApp({ secret: SECRET });
  started.push(f);
  return f;
}
const auth = { Authorization: `Bearer ${SECRET}` };

describe("the stand-in bridge", () => {
  test("it listens on loopback only, and needs a real secret", async () => {
    const f = await fake();
    assert.match(f.url, /^http:\/\/127\.0\.0\.1:\d+$/);
    await assert.rejects(startFakeWhatsApp({ secret: "short" }), /16 characters/);
  });

  test("every bridge path needs the bearer; the control API does not", async () => {
    const f = await fake();
    for (const path of ["/health", "/messages", "/chat/x", "/nope"]) {
      assert.equal((await fetch(`${f.url}${path}`)).status, 401);
      assert.equal((await fetch(`${f.url}${path}`, { headers: { Authorization: "Bearer nope-nope-nope-nope" } })).status, 401);
    }
    assert.equal((await fetch(`${f.url}/_control/sent`)).status, 200);
    assert.deepEqual(f.control.requests().map((r) => r.authorised), Array(8).fill(false));
  });

  test("the control API scripts inbound events and records outbound calls over HTTP", async () => {
    const f = await fake();
    const post = (path: string, body: unknown) =>
      fetch(`${f.url}/_control/${path}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });

    assert.equal((await post("group", { chatId: GROUP, title: "Fixture", participants: [ALICE] })).status, 200);
    const made = await (await post("message", { chatId: GROUP, senderId: ALICE, text: "hi", messageId: "IN1" })).json();
    assert.deepEqual(made, { ok: true, messageId: "IN1" });
    assert.equal((await post("added", { chatId: "120000000000000002@g.us", addedBy: ALICE })).status, 200);

    const polled = await (await fetch(`${f.url}/messages?after=0&waitMs=0`, { headers: auth })).json();
    assert.deepEqual(polled.events.map((e: { type: string }) => e.type), ["message", "added_to_group"]);

    const sent = await (await fetch(`${f.url}/send`, { method: "POST", headers: { ...auth, "Content-Type": "application/json" }, body: JSON.stringify({ chatId: GROUP, text: "reply", replyTo: "IN1" }) })).json();
    assert.equal(sent.quoted, true);
    const recorded = await (await fetch(`${f.url}/_control/sent`)).json();
    assert.deepEqual(recorded.sent.map((c: { kind: string; text: string; quoted: boolean }) => [c.kind, c.text, c.quoted]), [["send", "reply", true]]);

    assert.equal((await post("state", { state: "bogus" })).status, 400);
    assert.equal((await post("message", { chatId: "junk" })).status, 400);
  });

  test("scripted failures fire the stated number of times and then stop", async () => {
    const f = await fake();
    f.control.failNext({ path: "/health", status: 502, times: 2 });
    assert.equal((await fetch(`${f.url}/health`, { headers: auth })).status, 502);
    assert.equal((await fetch(`${f.url}/health`, { headers: auth })).status, 502);
    assert.equal((await fetch(`${f.url}/health`, { headers: auth })).status, 200);
  });

  test("reset forgets everything", async () => {
    const f = await fake();
    f.control.message({ chatId: ALICE, text: "x" });
    f.control.setState("logged_out");
    f.control.reset();
    const health = await (await fetch(`${f.url}/health`, { headers: auth })).json();
    assert.equal(health.state, "connected");
    assert.equal(health.buffered, 0);
  });

  test("started from the command line it refuses to run without a secret", () => {
    const res = spawnSync(process.execPath, ["--import", "tsx", join(api, "tools", "fake-whatsapp.ts")], {
      cwd: api,
      env: { PATH: process.env.PATH },
      encoding: "utf8",
      timeout: 30_000,
    });
    assert.equal(res.status, 2);
    assert.match(res.stderr, /usage:/);
  });
});
