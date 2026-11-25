/**
 * AC-20 at the REAL relay entrypoint (spec 625): `src/relay/server.ts` is the file the
 * relay container runs, so a WhatsApp loop that only a test builds would prove nothing.
 * Boots it three times against the bridge stand-in on loopback:
 *
 *   - no `relay.whatsapp` block: the relay serves, and the stand-in receives NO request;
 *   - a valid block: the relay asks the stand-in for its health, with the bearer secret;
 *   - a block that cannot work (a `localhost` URL, a ref that does not resolve, a short
 *     secret or key, a sender key equal to the bridge secret): WhatsApp alone is disabled
 *     (owner's decision 2026-11-24). The relay comes up and serves Telegram, logs one
 *     `relay.whatsapp_disabled` line naming the field, contacts no bridge, and answers every
 *     action for a WhatsApp chat PLATFORM_UNAVAILABLE.
 *
 * Telegram is a loopback stand-in (TELEGRAM_API_ROOT) that records the methods called, so
 * nothing leaves this machine. Only the child processes this file starts are ever stopped.
 */
import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { createServer as createHttpServer, type Server } from "node:http";
import { WebSocket } from "ws";
import { makeUpgradeToken } from "../src/relay/protocol.js";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, test } from "node:test";
import { fileURLToPath } from "node:url";
import type pg from "pg";
import { startFakeWhatsApp, type FakeWhatsApp } from "../tools/fake-whatsapp.js";
import { testDatabaseUrl } from "./support/test-database.js";
import { freshDatabase, mkWhatsappTrip, openBinding, waGroupAddress, waGroupId } from "./support/whatsapp-fixture.js";

const databaseUrl = testDatabaseUrl();
const SKIP = !databaseUrl;
const apiDirectory = fileURLToPath(new URL("../", import.meta.url));
const relayEntrypoint = fileURLToPath(new URL("../src/relay/server.ts", import.meta.url));
const examplePath = fileURLToPath(new URL("../../config/architecture.example.json", import.meta.url));
const BRIDGE_SECRET = `boot-bridge-${randomBytes(16).toString("hex")}`;
const SENDER_KEY = `boot-sender-${randomBytes(16).toString("hex")}`;

async function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const probe = createServer();
    probe.on("error", reject);
    probe.listen(0, "127.0.0.1", () => {
      const address = probe.address();
      if (address === null || typeof address === "string") { probe.close(() => reject(new Error("no port"))); return; }
      probe.close(() => resolve(address.port));
    });
  });
}

async function profileWith(whatsapp: Record<string, unknown> | null): Promise<Record<string, unknown>> {
  const base = JSON.parse(await readFile(examplePath, "utf8")) as Record<string, unknown>;
  // Only what the relay reads: no signup bot, no Mini App.
  delete base.signup;
  delete base.web;
  return {
    ...base,
    relay: {
      bind_host: "127.0.0.1",
      port: await freePort(),
      gateway_secret_refs: ["env://BOOT_GATEWAY_SECRET"],
      telegram_bot_token_secret_ref: "env://BOOT_TELEGRAM_TOKEN",
      ...(whatsapp ? { whatsapp } : {}),
    },
  };
}

interface Booted { stderr: () => string; exited: () => number | null; stop: () => Promise<void> }

const GATEWAY_SECRET = "boot-gateway-secret-boot-gateway";

/** A loopback stand-in for the Telegram Bot API: answers every method, records which were called. */
interface FakeTelegramApi { root: string; methods: string[]; close(): Promise<void> }
async function startTelegramApi(): Promise<FakeTelegramApi> {
  const methods: string[] = [];
  const server: Server = createHttpServer((req, res) => {
    const method = (req.url ?? "").split("?")[0]!.split("/").at(-1) ?? "";
    methods.push(method);
    const result = method === "getMe" ? { id: 4242, is_bot: true, first_name: "Boot", username: "boot_test_bot" }
      : method === "getUpdates" ? []
      : method === "sendMessage" ? { message_id: methods.length, chat: { id: 0 }, date: 0 }
      : true;
    const reply = () => {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ ok: true, result }));
    };
    // A long poll that returns empty at once makes the poller back off; a short wait keeps it polling normally.
    if (method === "getUpdates") setTimeout(reply, 200); else reply();
  });
  const port = await new Promise<number>((resolve) => server.listen(0, "127.0.0.1", () => resolve((server.address() as { port: number }).port)));
  return {
    root: `http://127.0.0.1:${port}`,
    methods,
    close: () => new Promise<void>((resolve) => { server.closeAllConnections?.(); server.close(() => resolve()); }),
  };
}

/** One outbound action from a gateway, as Hermes sends it; returns the outbound_result. */
async function act(port: number, profile: string, action: Record<string, unknown>): Promise<Record<string, unknown>> {
  const ws = new WebSocket(`ws://127.0.0.1:${port}/relay`, { headers: { authorization: `Bearer ${makeUpgradeToken(profile, GATEWAY_SECRET, 300)}` } });
  const frames: Record<string, unknown>[] = [];
  ws.on("message", (raw) => { for (const line of String(raw).split("\n")) if (line.trim()) frames.push(JSON.parse(line)); });
  await new Promise<void>((resolve, reject) => { ws.once("open", () => resolve()); ws.once("error", reject); });
  ws.send(`${JSON.stringify({ type: "outbound", requestId: "req_boot", action })}\n`);
  await until(() => frames.some((f) => f.type === "outbound_result"), 5000, "outbound_result");
  ws.close();
  return frames.find((f) => f.type === "outbound_result")!.result as Record<string, unknown>;
}

async function boot(profile: Record<string, unknown>, telegramRoot?: string): Promise<Booted> {
  const directory = await mkdtemp(join(tmpdir(), "kinerary-wa-relay-boot-"));
  const profilePath = join(directory, "architecture.json");
  await writeFile(profilePath, JSON.stringify(profile), "utf8");
  const child: ChildProcess = spawn(process.execPath, ["--import", "tsx", relayEntrypoint], {
    cwd: apiDirectory,
    env: {
      PATH: process.env.PATH ?? "/usr/bin:/bin",
      HOME: process.env.HOME ?? "/tmp",
      CONTROL_PLANE_ARCHITECTURE_PROFILE: profilePath,
      CONTROL_PLANE_DATABASE_URL: databaseUrl!,
      BOOT_GATEWAY_SECRET: GATEWAY_SECRET,
      BOOT_TELEGRAM_TOKEN: "123456:boot-test-token",
      BOOT_BRIDGE_SECRET: BRIDGE_SECRET,
      BOOT_SENDER_KEY: SENDER_KEY,
      // Telegram is a loopback stand-in, or a closed loopback port: nothing leaves this machine.
      TELEGRAM_API_ROOT: telegramRoot ?? `http://127.0.0.1:${await freePort()}`,
      RELAY_GATEWAY_WAIT_SECONDS: "0",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let stderr = "";
  child.stderr?.on("data", (chunk) => { stderr += String(chunk); });
  child.stdout?.on("data", () => {});
  let exitCode: number | null = null;
  child.on("exit", (code) => { exitCode = code ?? 0; });
  return {
    stderr: () => stderr,
    exited: () => exitCode,
    async stop() {
      if (exitCode === null) {
        child.kill("SIGTERM");
        await new Promise((resolve) => (exitCode !== null ? resolve(null) : child.once("exit", resolve)));
      }
      await rm(directory, { recursive: true, force: true });
    },
  };
}

async function until(check: () => boolean, timeoutMs: number, what: string): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!check()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 100));
  }
}

const block = (fake: FakeWhatsApp, over: Record<string, unknown> = {}) => ({
  bridge_url: fake.url,
  bridge_secret_ref: "env://BOOT_BRIDGE_SECRET",
  sender_id_secret_ref: "env://BOOT_SENDER_KEY",
  number: "15550100123",
  ...over,
});

describe("AC-20: the real relay entrypoint starts WhatsApp only with a relay.whatsapp block", { skip: SKIP }, () => {
  let pool: pg.Pool;
  let fake: FakeWhatsApp;
  before(async () => {
    pool = await freshDatabase();
    fake = await startFakeWhatsApp({ secret: BRIDGE_SECRET });
  });
  after(async () => {
    await fake?.close();
    await pool?.end();
  });

  test("no block: the relay serves, says WhatsApp is not configured, and never contacts a bridge", async () => {
    fake.control.reset();
    const relay = await boot(await profileWith(null));
    try {
      await until(() => relay.stderr().includes('"event":"relay.ready"') || relay.exited() !== null, 30_000, "relay.ready");
      assert.equal(relay.exited(), null, relay.stderr());
      await new Promise((r) => setTimeout(r, 1500));
      console.log(`EVIDENCE AC-20 no relay.whatsapp block: bridge requests=${JSON.stringify(fake.control.requests())}; boot line=${relay.stderr().split("\n").find((l) => l.includes('"event":"relay.whatsapp"'))}`);
      assert.deepEqual(fake.control.requests(), [], "no connection attempt");
      assert.match(relay.stderr(), /"event":"relay\.whatsapp","configured":false/);
      assert.ok(!relay.stderr().includes("whatsapp.loop_started"));
    } finally { await relay.stop(); }
  });

  test("a valid block: the relay starts the loop and asks the bridge for its health, with the bearer secret", async () => {
    fake.control.reset();
    const relay = await boot(await profileWith(block(fake)));
    try {
      await until(() => fake.control.requests().some((r) => r.path === "/messages") || relay.exited() !== null, 30_000, "a poll");
      assert.equal(relay.exited(), null, relay.stderr());
      const requests = fake.control.requests();
      console.log(`EVIDENCE AC-20 relay.whatsapp present: first bridge requests=${JSON.stringify(requests.slice(0, 3))}`);
      assert.deepEqual(requests[0], { method: "GET", path: "/health", authorised: true });
      assert.ok(requests.every((r) => r.authorised));
      assert.match(relay.stderr(), /"event":"relay\.whatsapp","configured":true/);
      assert.ok(!relay.stderr().includes(BRIDGE_SECRET) && !relay.stderr().includes(SENDER_KEY), "no secret is logged");
    } finally { await relay.stop(); }
  });

  // Owner's decision 2026-11-24: a WhatsApp block that cannot work disables WhatsApp, never the relay.
  const unusable: Array<{ name: string; over: Record<string, unknown>; field: RegExp }> = [
    { name: "a bridge_url the bridge never binds (localhost)", over: { bridge_url: "LOCALHOST" }, field: /^relay\.whatsapp\.bridge_url$/ },
    { name: "a bridge secret ref that does not resolve", over: { bridge_secret_ref: "env://BOOT_NOT_SET" }, field: /^relay\.whatsapp\.bridge_secret_ref$/ },
    { name: "a bridge secret that is too short", over: { bridge_secret_ref: "env://BOOT_TELEGRAM_TOKEN" }, field: /^relay\.whatsapp\.bridge_secret_ref$/ },
    { name: "a sender-id key that is too short", over: { sender_id_secret_ref: "env://BOOT_TELEGRAM_TOKEN" }, field: /^relay\.whatsapp\.sender_id_secret_ref$/ },
    { name: "a sender-id key equal to the bridge secret", over: { sender_id_secret_ref: "env://BOOT_BRIDGE_SECRET" }, field: /^relay\.whatsapp\.sender_id_secret_ref$/ },
    // Blocks the profile SCHEMA refuses (boundary review of #655, F1): each of these used to exit the relay with ZodError
    // before Telegram was polled. They now go the same way as the runtime refusals above.
    { name: "a bridge_url on the LAN (schema)", over: { bridge_url: "http://10.1.2.3:4398" }, field: /^relay\.whatsapp\.bridge_url$/ },
    { name: "an https bridge_url (schema)", over: { bridge_url: "https://bridge.example.org" }, field: /^relay\.whatsapp\.bridge_url$/ },
    { name: "a missing number (schema)", over: { number: undefined }, field: /^relay\.whatsapp\.number$/ },
    { name: "an unknown key (schema)", over: { bridge_secret: "boot-literal-value" }, field: /^relay\.whatsapp$/ },
    { name: "a code lifetime out of range (schema)", over: { code_ttl_seconds: 5 }, field: /^relay\.whatsapp\.code_ttl_seconds$/ },
  ];
  for (const bad of unusable) {
    test(`${bad.name}: WhatsApp is disabled, the relay comes up and serves Telegram, no bridge is contacted, and a WhatsApp chat is PLATFORM_UNAVAILABLE`, async () => {
      fake.control.reset();
      const telegram = await startTelegramApi();
      const { tripId } = await mkWhatsappTrip(pool);
      const profileId = `gw-boot-${randomBytes(4).toString("hex")}`;
      const waChat = waGroupId();
      const tgChat = `-100${Math.floor(1e9 + Math.random() * 8e9)}`;
      await openBinding(pool, { tripId, chatId: waChat, platform: "whatsapp", profile: profileId, transportAddress: waGroupAddress() });
      await openBinding(pool, { tripId, chatId: tgChat, platform: "telegram", profile: profileId });
      const over = bad.over.bridge_url === "LOCALHOST" ? { bridge_url: fake.url.replace("127.0.0.1", "localhost") } : bad.over;
      const prof = await profileWith(block(fake, over));
      const relay = await boot(prof, telegram.root);
      try {
        await until(() => relay.stderr().includes('"event":"relay.ready"') || relay.exited() !== null, 30_000, "relay.ready");
        assert.equal(relay.exited(), null, `the relay must not exit:\n${relay.stderr()}`);
        await until(() => telegram.methods.includes("getUpdates"), 10_000, "Telegram polling");
        const port = (prof.relay as { port: number }).port;
        const waResult = await act(port, profileId, { op: "send", chat_id: waChat, content: "hello" });
        const tgResult = await act(port, profileId, { op: "send", chat_id: tgChat, content: "hello" });
        await new Promise((r) => setTimeout(r, 500));
        const lines = relay.stderr().split("\n").filter((l) => l.startsWith("{")).map((l) => JSON.parse(l) as Record<string, unknown>);
        const disabled = lines.filter((l) => l.event === "relay.whatsapp_disabled");
        const ready = lines.find((l) => l.event === "relay.ready");
        console.log(`EVIDENCE round 2 item 2, ${bad.name}: disabled=${JSON.stringify(disabled)}; ready=${JSON.stringify(ready)}; telegram methods=${JSON.stringify([...new Set(telegram.methods)])}; whatsapp send -> ${JSON.stringify(waResult)}; telegram send -> ${JSON.stringify(tgResult)}; bridge requests=${JSON.stringify(fake.control.requests())}`);
        assert.equal(disabled.length, 1, "one line");
        assert.match(String(disabled[0]!.field), bad.field);
        assert.equal(typeof disabled[0]!.reason, "string");
        assert.equal(ready?.polling, true);
        assert.equal(ready?.whatsapp, false);
        assert.deepEqual(waResult, { success: false, error: "PLATFORM_UNAVAILABLE" });
        assert.equal(tgResult.success, true, "Telegram served");
        assert.ok(telegram.methods.includes("sendMessage"));
        assert.deepEqual(fake.control.requests(), [], "no bridge connection");
        assert.ok(!relay.stderr().includes("whatsapp.loop_started"));
        for (const secret of [BRIDGE_SECRET, SENDER_KEY, "boot-test-token"]) assert.ok(!relay.stderr().includes(secret), "never a value");
      } finally {
        await relay.stop();
        await telegram.close();
      }
    });
  }
});
