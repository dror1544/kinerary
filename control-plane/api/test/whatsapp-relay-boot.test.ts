/**
 * AC-20 at the REAL relay entrypoint (spec 625): `src/relay/server.ts` is the file the
 * relay container runs, so a WhatsApp loop that only a test builds would prove nothing.
 * Boots it three times against the bridge stand-in on loopback:
 *
 *   - no `relay.whatsapp` block: the relay serves, and the stand-in receives NO request;
 *   - a valid block: the relay asks the stand-in for its health, with the bearer secret;
 *   - a block that cannot work (`localhost`): the relay refuses to start, naming the field.
 *
 * Telegram is pointed at a closed loopback port (TELEGRAM_API_ROOT), so nothing leaves
 * this machine. Only the child processes this file starts are ever stopped.
 */
import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, test } from "node:test";
import { fileURLToPath } from "node:url";
import type pg from "pg";
import { startFakeWhatsApp, type FakeWhatsApp } from "../tools/fake-whatsapp.js";
import { testDatabaseUrl } from "./support/test-database.js";
import { freshDatabase } from "./support/whatsapp-fixture.js";

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

async function boot(profile: Record<string, unknown>): Promise<Booted> {
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
      BOOT_GATEWAY_SECRET: "boot-gateway-secret-boot-gateway",
      BOOT_TELEGRAM_TOKEN: "123456:boot-test-token",
      BOOT_BRIDGE_SECRET: BRIDGE_SECRET,
      BOOT_SENDER_KEY: SENDER_KEY,
      // Telegram is a closed loopback port: nothing leaves this machine.
      TELEGRAM_API_ROOT: `http://127.0.0.1:${await freePort()}`,
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

  test("a block that cannot work refuses to start, naming the field and never a value, and contacts nothing", async () => {
    for (const over of [{ bridge_url: fake.url.replace("127.0.0.1", "localhost") }, { sender_id_secret_ref: "env://BOOT_TELEGRAM_TOKEN" }]) {
      fake.control.reset();
      const relay = await boot(await profileWith(block(fake, over)));
      try {
        await until(() => relay.exited() !== null, 30_000, "exit");
        const line = relay.stderr().split("\n").find((l) => l.includes("relay.whatsapp_invalid")) ?? "";
        console.log(`EVIDENCE AC-20 unusable block ${JSON.stringify(Object.keys(over))}: exit=${relay.exited()} line=${line}`);
        assert.equal(relay.exited(), 1);
        assert.match(line, /relay\.whatsapp\.(bridge_url|sender_id_secret_ref)/);
        assert.ok(!relay.stderr().includes(BRIDGE_SECRET) && !relay.stderr().includes("boot-test-token"));
        assert.deepEqual(fake.control.requests(), []);
      } finally { await relay.stop(); }
    }
  });
});
