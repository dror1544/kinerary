/**
 * WhatsApp S2: the REAL server entrypoint wires `relay.whatsapp` into the portal (spec 625, Configuration). server.ts is the
 * file the container runs; a route tested only through buildApp() with hand-built dependencies would still 404 in a real
 * deployment if server.ts never passed the number (server-boot.test.ts exists for the same reason). Boots `src/server.ts`
 * against the test database twice: with a `relay.whatsapp` block (a WhatsApp route answers, not 404) and without one (404).
 */
import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, test } from "node:test";
import { fileURLToPath } from "node:url";
import type pg from "pg";
import { sha256 } from "../src/portal.js";
import { testDatabaseUrl } from "./support/test-database.js";
import { freshDatabase, mkWhatsappTrip, uid } from "./support/whatsapp-fixture.js";

const databaseUrl = testDatabaseUrl();
const SKIP = !databaseUrl;
const apiDirectory = fileURLToPath(new URL("../", import.meta.url));
const serverEntrypoint = fileURLToPath(new URL("../src/server.ts", import.meta.url));
const ORIGIN = "http://portal.wiring.test";
const FIXTURE_NUMBER = "15550100123";

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

function profile(port: number, workerPort: number, relayPort: number | null): Record<string, unknown> {
  return {
    version: 1, environment: "test",
    public_api: { bind_host: "127.0.0.1", port },
    worker: { queue: "postgres", health_bind_host: "127.0.0.1", health_port: workerPort },
    database: { connection_secret_ref: "env://CONTROL_PLANE_DATABASE_URL" },
    adapters: { compute: "fake", ingress: "fake", agent_runtime: "fake", messaging: "fake", secrets: "fake" },
    test_resources: { enabled: true, label_key: "kinerary.test_run_id", allowed_name_prefix: "kinerary-test-local" },
    web: {
      public_origin: ORIGIN, runtime_origin: "http://runtime.wiring.test",
      runtime_exchange_key_secret_ref: "env://KINERARY_TEST_RUNTIME_EXCHANGE_KEY",
      runtime_upstream_host_suffixes: ["internal"], telegram_bot_username: "kinerary_bot",
    },
    ...(relayPort === null ? {} : {
      relay: {
        bind_host: "127.0.0.1", port: relayPort, gateway_secret_refs: ["env://KINERARY_TEST_RUNTIME_EXCHANGE_KEY"],
        telegram_bot_token_secret_ref: "env://KINERARY_TEST_RUNTIME_EXCHANGE_KEY",
        whatsapp: {
          bridge_url: "http://127.0.0.1:4390", bridge_secret_ref: "env://KINERARY_TEST_RUNTIME_EXCHANGE_KEY",
          sender_id_secret_ref: "env://KINERARY_TEST_RUNTIME_EXCHANGE_KEY", number: FIXTURE_NUMBER, code_ttl_seconds: 600,
        },
      },
    }),
  };
}

async function boot(prof: Record<string, unknown>, port: number): Promise<{ stop: () => Promise<void> }> {
  const directory = await mkdtemp(join(tmpdir(), "kinerary-wa-wiring-"));
  const profilePath = join(directory, "architecture.json");
  await writeFile(profilePath, JSON.stringify(prof), "utf8");
  const child: ChildProcess = spawn(process.execPath, ["--import", "tsx", serverEntrypoint], {
    cwd: apiDirectory,
    env: { ...process.env, CONTROL_PLANE_ARCHITECTURE_PROFILE: profilePath, CONTROL_PLANE_DATABASE_URL: databaseUrl!, KINERARY_TEST_RUNTIME_EXCHANGE_KEY: "wiring-test-exchange-key" },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let stderr = "";
  child.stderr?.on("data", (chunk) => { stderr += String(chunk); });
  let exited: number | null = null;
  child.on("exit", (code) => { exited = code ?? 0; });
  const stop = async () => {
    child.kill("SIGTERM");
    await new Promise((resolve) => (exited !== null ? resolve(null) : child.once("exit", resolve)));
    await rm(directory, { recursive: true, force: true });
  };
  const deadline = Date.now() + 25_000;
  while (Date.now() < deadline) {
    if (exited !== null) { await stop(); throw new Error(`server exited with code ${exited} before listening:\n${stderr}`); }
    try {
      if ((await fetch(`http://127.0.0.1:${port}/healthz`, { signal: AbortSignal.timeout(500) })).ok) return { stop };
    } catch { /* not listening yet */ }
    await new Promise((resolve) => setTimeout(resolve, 150));
  }
  await stop();
  throw new Error(`server did not listen within 25s:\n${stderr}`);
}

describe("the real server entrypoint and the WhatsApp portal settings", { skip: SKIP }, () => {
  let pool: pg.Pool;
  let tripId: string;
  let cookie: string;
  let csrf: string;
  before(async () => {
    pool = await freshDatabase();
    const trip = await mkWhatsappTrip(pool);
    tripId = trip.tripId;
    const raw = `sess-${randomBytes(8).toString("hex")}`;
    csrf = `csrf-${randomBytes(8).toString("hex")}`;
    await pool.query(
      "INSERT INTO control_plane.web_sessions(id,user_id,token_digest,csrf_digest,expires_at) VALUES ($1,$2,$3,$4,now() + interval '1 hour')",
      [uid("wsess"), trip.ownerId, sha256(raw), sha256(csrf)]);
    cookie = `kit_session=${raw}; kit_csrf=${csrf}`;
  });
  after(async () => { await pool.end(); });

  const askForCode = (port: number) => fetch(`http://127.0.0.1:${port}/v1/trips/${tripId}/whatsapp-codes`, {
    method: "POST", headers: { cookie, "x-csrf-token": csrf, origin: ORIGIN, "content-type": "application/json" }, body: JSON.stringify({ kind: "me" }),
  });

  test("with a relay.whatsapp block and the switch on, the real server mints a code (not 404) and the link opens the configured number with its TTL", async () => {
    const port = await freePort();
    const server = await boot(profile(port, await freePort(), await freePort()), port);
    try {
      const response = await askForCode(port);
      const body = await response.json() as { link: string; expiresAt: string };
      console.log(`EVIDENCE real server entrypoint, relay.whatsapp configured: POST whatsapp-codes -> HTTP ${response.status} link=${body.link.replace(/KWA-[A-Z0-9]{8}/i, "KWA-********").replace(/%3A%20[A-Z0-9-]+/, "%3A%20<code>")}`);
      assert.notEqual(response.status, 404, "server.ts does not pass whatsappPortalSettings(profile) to the portal");
      assert.equal(response.status, 201);
      assert.equal(new URL(body.link).pathname, `/${FIXTURE_NUMBER}`);
      assert.ok(Math.abs(new Date(body.expiresAt).getTime() - Date.now() - 600_000) < 15_000, "code_ttl_seconds from the profile");
      const page = await fetch(`http://127.0.0.1:${port}/v1/trips/${tripId}`, { headers: { cookie } });
      assert.deepEqual((await page.json() as { whatsapp?: unknown }).whatsapp, { number: FIXTURE_NUMBER, owner: true });
    } finally { await server.stop(); }
  });

  test("with no relay.whatsapp block the same request, switch still on, is 404 and the trip page shows no section", async () => {
    // Without this the test above could pass for the wrong reason.
    const port = await freePort();
    const server = await boot(profile(port, await freePort(), null), port);
    try {
      const response = await askForCode(port);
      console.log(`EVIDENCE real server entrypoint, no relay.whatsapp: POST whatsapp-codes -> HTTP ${response.status} ${await response.text()}`);
      assert.equal(response.status, 404);
      const page = await fetch(`http://127.0.0.1:${port}/v1/trips/${tripId}`, { headers: { cookie } });
      assert.equal(page.status, 200);
      assert.ok(!("whatsapp" in (await page.json() as object)));
    } finally { await server.stop(); }
  });
});
