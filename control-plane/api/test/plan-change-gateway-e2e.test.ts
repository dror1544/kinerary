// The group-line poller, end to end through the REAL runtime gateway (docs/specs/sprint-9/597-per-gateway-and-per-trip-keys.md,
// AC-K2.12; regression plan for #599, D5).
//
// Until this file the two halves were only ever tested against a stand-in for the other: the poller's tests ran against a
// fake gateway, the gateway's plan-changes tests against a fake control plane. Here nothing between them is fake.
//
// Real: control-plane/api/src/plan-change-poller.ts (pollPlanChangesOnce, the function the minute loop calls), the API
// listening on a port (the gateway asks it for each trip's route), the database, and runtime-gateway/server.js as child
// processes. Faked: only the trip sites, recording servers on loopback. The key a site received is printed as a label
// (exchange / derived / legacy), never as a value.
import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { after, before, describe, test } from "node:test";
import { fileURLToPath } from "node:url";
import pg from "pg";
import { buildApp } from "../src/app.js";
import { validateArchitectureProfile } from "../src/config.js";
import { setFeatureSwitch } from "../src/feature-switches.js";
import { applyMigrations } from "../src/migrations.js";
import { pollPlanChangesOnce, type PlanChangePollerDeps } from "../src/plan-change-poller.js";
import type { PortalDependencies } from "../src/portal.js";
import { startGatewayProcess, type GatewayProcess } from "./support/runtime-gateway-process.js";
import { BASE_PLAN, bindGroup, seedTrip, startStubSite, type StubSite } from "./support/plan-change-site.js";
import { testDatabaseUrl, testPool } from "./support/test-database.js";

const databaseUrl = testDatabaseUrl();
const skip = !databaseUrl;
const migrationsDir = fileURLToPath(new URL("../../db/migrations/", import.meta.url));

const EXCHANGE_KEY = "d5-control-plane-exchange-key";
const MASTER = "d5-trip-key-master";
const LEGACY = "d5-legacy-trip-key";
const TRIP_HOST_SUFFIX = "trips.example.test";
const derive = (tripId: string) => createHmac("sha256", MASTER).update(`kinerary-trip-exchange:v1:${tripId}`).digest("hex");
const min = 60_000;
const NOON = new Date("2026-12-03T10:00:00Z"); // 11:00 in Paris: daytime, so a settled change goes out

const profile = validateArchitectureProfile({
  version: 1, environment: "test", public_api: { bind_host: "127.0.0.1", port: 4310 },
  worker: { queue: "postgres", health_bind_host: "127.0.0.1", health_port: 4311 },
  database: { connection_secret_ref: "env://CONTROL_PLANE_DATABASE_URL" },
  adapters: { compute: "fake", ingress: "fake", agent_runtime: "fake", messaging: "fake", secrets: "fake" },
  test_resources: { enabled: false },
});

describe("the group-line poller against the real runtime gateway", { skip }, () => {
  let pool: pg.Pool;
  let app: ReturnType<typeof buildApp>;
  let apiOrigin = "";
  let keysOff: GatewayProcess;
  let keysOn: GatewayProcess;
  let doomed: GatewayProcess | undefined;
  const sites: StubSite[] = [];
  const trips: string[] = [];
  let groupSeq = 0;
  const runTag = String(Date.now()).slice(-9); // a Telegram group id is one open binding at a time: a leftover run must not collide

  const gatewayEnv = (extra: Record<string, string>) => ({
    CONTROL_PLANE_INTERNAL_ORIGIN: apiOrigin, RUNTIME_EXCHANGE_KEY: EXCHANGE_KEY, RUNTIME_COOKIE_SECRET: "d5-cookie-secret",
    PORTAL_ORIGIN: "http://127.0.0.1:1", TRIP_HOST_SUFFIX, ...extra,
  });

  before(async () => {
    pool = testPool({ max: 4 });
    const client = await pool.connect();
    try { await applyMigrations(client, migrationsDir); } finally { client.release(); }
    const portal: PortalDependencies = {
      db: pool, runtimeAccounts: {} as PortalDependencies["runtimeAccounts"],
      publicOrigin: "http://portal.example.test", runtimeOrigin: "http://runtime.example.test", runtimeExchangeKey: EXCHANGE_KEY,
      runtimeUpstreamHostSuffixes: ["localhost", TRIP_HOST_SUFFIX], runtimeUpstreamAllowedHosts: ["127.0.0.1"], telegramBotUsername: "kinerary_bot",
      sessionTtlSeconds: 3600, enrollmentTtlSeconds: 3600, approvalTtlSeconds: 3600,
    };
    app = buildApp(profile, { portal });
    apiOrigin = await app.listen({ host: "127.0.0.1", port: 0 });
    keysOff = await startGatewayProcess(gatewayEnv({}));
    keysOn = await startGatewayProcess(gatewayEnv({ RUNTIME_TRIP_KEY_MASTER: MASTER, RUNTIME_LEGACY_TRIP_KEY: LEGACY }));
  });

  after(async () => {
    await Promise.all([keysOff?.stop(), keysOn?.stop(), doomed?.stop()]);
    await app?.close();
    for (const site of sites) await site.close();
    if (pool) {
      for (const tripId of trips) {
        const release = await pool.query<{ release_id: string }>("SELECT release_id FROM control_plane.plans WHERE trip_id = $1", [tripId]);
        for (const table of ["notification_outbox", "plan_change_cursors", "telegram_chat_bindings", "feature_switch_settings", "runtime_routes", "jobs", "plans"]) {
          await pool.query(`DELETE FROM control_plane.${table} WHERE trip_id = $1`, [tripId]);
        }
        for (const row of release.rows) await pool.query("DELETE FROM control_plane.releases WHERE id = $1", [row.release_id]);
        await pool.query("DELETE FROM control_plane.trips WHERE id = $1", [tripId]);
      }
      await pool.end();
    }
  });

  interface Seeded { tripId: string; site: StubSite }

  /** A trip with a ready route, an open group and the switch on, whose site is a recording server. */
  async function seed(name: string, options: { tripKey: "shared" | "derived"; wildcard?: boolean }): Promise<Seeded> {
    const site = await startStubSite();
    sites.push(site);
    const slug = `d5-${name}-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
    // A wildcard trip's job records its PUBLIC name (nothing resolves it here) and its route the LAN origin: reaching
    // the stub site at all therefore proves the LAN address was the one used.
    const tripId = await seedTrip(pool, slug, options.wildcard ? `https://${slug}.${TRIP_HOST_SUFFIX}` : site.origin);
    trips.push(tripId);
    if (options.wildcard) {
      await pool.query("UPDATE control_plane.runtime_routes SET public_host = $2, upstream_url = $3 WHERE trip_id = $1",
        [tripId, `${slug}.${TRIP_HOST_SUFFIX}`, `http://127.0.0.1:${new URL(site.origin).port}`]);
    }
    await pool.query("UPDATE control_plane.runtime_routes SET trip_key = $2 WHERE trip_id = $1", [tripId, options.tripKey]);
    await bindGroup(pool, tripId, `-100${runTag}${String(++groupSeq).padStart(3, "0")}`);
    const on = await setFeatureSwitch(pool, { switch: "plan_change_group_line", enabled: true, scope: "trip", trip: tripId, live: true, by: "test" });
    assert.equal(on.ok, true);
    return { tripId, site };
  }

  /** Switches the trip off again so the next case's tick polls one trip only (its outbox row keeps its binding). */
  const release = async (tripId: string) => {
    const off = await setFeatureSwitch(pool, { switch: "plan_change_group_line", enabled: false, scope: "trip", trip: tripId, live: true, by: "test" });
    assert.equal(off.ok, true);
  };
  const outbox = async (tripId: string) => (await pool.query<{ state: string; target: string | null; dedupe_key: string }>(
    "SELECT state, target, dedupe_key FROM control_plane.notification_outbox WHERE trip_id = $1 AND notification_type = 'trip_plan_changed'", [tripId])).rows;
  const cursor = async (tripId: string) => (await pool.query<{ revision_id: string }>("SELECT revision_id FROM control_plane.plan_change_cursors WHERE trip_id = $1", [tripId])).rows[0]?.revision_id ?? null;

  function deps(gateway: GatewayProcess, logs: string[], clock: Date): PlanChangePollerDeps {
    return {
      db: pool, exchangeKey: EXCHANGE_KEY, runtimeOrigin: gateway.origin,
      upstreamHostSuffixes: ["localhost", TRIP_HOST_SUFFIX], upstreamAllowedHosts: ["127.0.0.1"],
      now: () => clock, log: (line) => logs.push(line),
    };
  }

  const label = (tripId: string, key: string | string[] | undefined) =>
    key === EXCHANGE_KEY ? "exchange" : key === derive(tripId) ? "derived(this trip)" : key === LEGACY ? "legacy" : "OTHER";

  /**
   * Three ticks, one change. First sight of the trip (no `since`), the same plan again (nothing to say), then a revised plan
   * that has been quiet for ten minutes: exactly one outbox row, and one more tick adds none.
   */
  async function walk(gateway: GatewayProcess, seeded: Seeded, expectedKey: string, description: string) {
    const logs: string[] = [];
    const { tripId, site } = seeded;
    const poll = () => pollPlanChangesOnce(deps(gateway, logs, NOON));
    const context = () => `poll log: ${logs.join(" | ")} | gateway log: ${gateway.output()}`;

    assert.deepEqual(await poll(), { polled: 1, enqueued: 0, failed: 0 }, context());
    site.plan = {
      ...site.plan, active_revision_id: "rev_d5_two", active_created_at: new Date(NOON.getTime() - 10 * min).toISOString(),
      changes: [{ kind: "updated", fields: ["time"], date: "2026-12-03", time: "19:00", previous_time: "20:00", text_en: "Dinner", text_he: "ארוחת ערב" }],
    };
    assert.deepEqual(await poll(), { polled: 1, enqueued: 1, failed: 0 }, context());
    assert.deepEqual(await poll(), { polled: 1, enqueued: 0, failed: 0 }, context());

    console.log(`${description}: poller -> gateway ${gateway === keysOff ? "(trip keys off)" : "(trip keys on)"} GET /internal/t/<trip id>/plan-changes with the control-plane key`);
    for (const request of site.requests) console.log(`  site received: GET ${request.url} x-api-key=${label(tripId, request.apiKey)} x-control-plane-trip-id=${request.tripId === tripId ? "<trip id>" : "OTHER"}`);
    assert.deepEqual(site.requests.map((r) => r.url), [
      "/api/internal/control-plane/plan-changes",
      `/api/internal/control-plane/plan-changes?since=${BASE_PLAN.active_revision_id}`,
      "/api/internal/control-plane/plan-changes?since=rev_d5_two",
    ], context());
    assert.ok(site.requests.every((r) => r.tripId === tripId));
    assert.deepEqual(site.requests.map((r) => label(tripId, r.apiKey)), [expectedKey, expectedKey, expectedKey]);
    const rows = await outbox(tripId);
    assert.equal(rows.length, 1, "a changed plan is exactly one outbox row");
    assert.ok(rows[0]!.dedupe_key.startsWith(`plan-change:${tripId}:rev_d5_two`), rows[0]!.dedupe_key); // the revision, then the group it is for
    assert.equal(await cursor(tripId), "rev_d5_two");
    assert.ok(!logs.join("\n").includes(EXCHANGE_KEY) && !logs.join("\n").includes(MASTER) && !logs.join("\n").includes(LEGACY), "no key in any poller log line");
    await release(tripId);
  }

  test("AC-K2.12: with trip keys off the site is sent the exchange key", async () => {
    await walk(keysOff, await seed("off", { tripKey: "shared" }), "exchange", "keys off");
  });

  test("AC-K2.12: with trip keys on, a derived trip's site is sent derive(master, trip id) and never the exchange key", async () => {
    await walk(keysOn, await seed("derived", { tripKey: "derived" }), "derived(this trip)", "derived");
  });

  test("AC-K2.12: with trip keys on, a shared trip's site is sent the legacy key", async () => {
    await walk(keysOn, await seed("shared", { tripKey: "shared" }), "legacy", "shared");
  });

  test("AC-K2.12: a wildcard trip is reached at its LAN address (its public name resolves nowhere here), with its derived key", async () => {
    await walk(keysOn, await seed("wild", { tripKey: "derived", wildcard: true }), "derived(this trip)", "wildcard");
  });

  test("AC-K2.12: with the gateway process stopped the poll fails with SITE_UNREACHABLE, the cursor does not move, and one aggregate line says why", async () => {
    doomed = await startGatewayProcess(gatewayEnv({ RUNTIME_TRIP_KEY_MASTER: MASTER, RUNTIME_LEGACY_TRIP_KEY: LEGACY }));
    const { tripId, site } = await seed("stopped", { tripKey: "derived" });
    const logs: string[] = [];
    const poll = () => pollPlanChangesOnce(deps(doomed!, logs, NOON));
    assert.deepEqual(await poll(), { polled: 1, enqueued: 0, failed: 0 });
    const before = await cursor(tripId);
    assert.equal(before, BASE_PLAN.active_revision_id);
    site.plan = {
      ...site.plan, active_revision_id: "rev_d5_three", active_created_at: new Date(NOON.getTime() - 10 * min).toISOString(),
      changes: [{ kind: "added", fields: [], date: "2026-12-04", time: "16:00", text_en: "Winery visit", text_he: "ביקור ביקב" }],
    };
    const gatewayOrigin = doomed.origin;
    await doomed.stop();
    site.requests.length = 0;
    logs.length = 0;

    assert.deepEqual(await poll(), { polled: 1, enqueued: 0, failed: 1 });
    const lines = logs.map((line) => JSON.parse(line));
    console.log(`gateway stopped: poll log events: ${lines.map((l) => `${l.event}(${l.safe_error_code ?? l.safe_error_codes})`).join(", ")}`);
    assert.equal(lines.find((l) => l.event === "plan_change_poll.failed")?.safe_error_code, "SITE_UNREACHABLE");
    assert.equal(lines.filter((l) => l.event === "plan_change_poll.gateway_suspect").length, 1);
    assert.equal(await cursor(tripId), before, "the cursor did not move");
    assert.deepEqual(await outbox(tripId), [], "nothing enqueued");
    assert.deepEqual(site.requests, [], "the site was not reached");
    const text = logs.join("\n");
    assert.ok(!text.includes(gatewayOrigin) && !text.includes("127.0.0.1") && !text.includes(EXCHANGE_KEY), "no address and no key in the lines");
    await release(tripId);
  });
});
