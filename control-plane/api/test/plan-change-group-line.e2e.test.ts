import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { createServer } from "node:net";
import { after, before, beforeEach, describe, test } from "node:test";
import { fileURLToPath } from "node:url";
import pg from "pg";
import { TelegramNotificationAdapter } from "../src/adapters/telegram.js";
import { setFeatureSwitch } from "../src/feature-switches.js";
import { applyMigrations } from "../src/migrations.js";
import { dispatchPendingTripNotifications } from "../src/outbox-dispatcher.js";
import { pollPlanChangesOnce } from "../src/plan-change-poller.js";
import { telegramApiRoot } from "../src/relay/telegram-api.js";
import { bindGroup, seedTrip, startStubSite, type StubSite } from "./support/plan-change-site.js";
import { testDatabaseUrl, testPool } from "./support/test-database.js";

// Video Release 1C, "the sending proof from the approved plan" (docs/specs/sprint-9/x-video-r1-group-line.md, Test plan).
// The real adapter, the real dispatcher and the real poller, against the Bot API stand-in (tools/fake-telegram.ts)
// reached through the validated TELEGRAM_API_ROOT, and two stub trip sites. What the stand-in recorded is what a
// Telegram group would have shown.
const databaseUrl = testDatabaseUrl();
const skip = !databaseUrl;
const apiDir = fileURLToPath(new URL("..", import.meta.url));
const migrationsDir = fileURLToPath(new URL("../../db/migrations/", import.meta.url));

const KEY = "test-exchange-key-not-a-real-one";
const GROUP_A = "-1001000000021";
const GROUP_B = "-1001000000022";
const min = 60_000;
const SWITCH = "plan_change_group_line";

async function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address() as { port: number };
      server.close(() => resolve(port));
    });
  });
}

interface Sent { seq: number; chatId: string; text: string }

describe("the group line, end to end", { skip }, () => {
  let pool: pg.Pool;
  let telegram: ChildProcess;
  let telegramBase: string;
  let adapter: TelegramNotificationAdapter;
  let siteA: StubSite;
  let siteB: StubSite;
  let tripA: string;
  let tripB: string;
  let bindingA: string;
  let clock: Date;
  let floor = 0;
  const logs: string[] = [];

  const sentTo = async (chatId: string): Promise<Sent[]> => {
    const res = await fetch(`${telegramBase}/_control/sent?chatId=${encodeURIComponent(chatId)}&after=${floor}`);
    return ((await res.json()) as { result: { messages: Sent[] } }).result.messages;
  };
  /** One minute of the control plane's life: the poller looks, then the dispatcher sends what it queued. */
  async function minute(advanceMs = min) {
    clock = new Date(clock.getTime() + advanceMs);
    await pollPlanChangesOnce({ db: pool, exchangeKey: KEY, upstreamHostSuffixes: ["localhost"], now: () => clock, log: (line) => logs.push(line) });
    await dispatchPendingTripNotifications(pool, adapter, (line) => logs.push(line));
  }
  const dinner = (time: string, previous = "20:00") => ({ kind: "updated", fields: ["time"], date: "2026-12-03", time, previous_time: previous, text_en: "Dinner", text_he: "ארוחת ערב" });
  const edit = (site: StubSite, rev: string, changes: Array<Record<string, unknown>>) => {
    site.plan = { ...site.plan, active_revision_id: rev, active_created_at: clock.toISOString(), changes };
  };

  before(async () => {
    pool = testPool();
    const client = await pool.connect();
    try {
      await client.query("DROP SCHEMA IF EXISTS control_plane CASCADE");
      await client.query("DROP TABLE IF EXISTS public.control_plane_schema_migrations");
      await applyMigrations(client, migrationsDir);
    } finally { client.release(); }

    const port = await freePort();
    telegramBase = `http://127.0.0.1:${port}`;
    telegram = spawn(process.execPath, ["--import", "tsx", "tools/fake-telegram.ts", "--port", String(port)], { cwd: apiDir, stdio: ["ignore", "pipe", "inherit"] });
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("fake-telegram did not start")), 15_000);
      telegram.once("exit", (code) => reject(new Error(`fake-telegram exited ${code}`)));
      telegram.stdout!.on("data", (chunk) => { if (String(chunk).includes("fake_telegram.listening")) { clearTimeout(timer); resolve(); } });
    });
    // The same path server.ts takes: the root goes through the validator that guards the bot token.
    adapter = new TelegramNotificationAdapter({ botToken: "123456:test-bot-token", superAdminChatId: "1", db: pool, apiRoot: telegramApiRoot(telegramBase) });
  });
  after(async () => {
    telegram?.kill();
    await siteA?.close();
    await siteB?.close();
    const client = await pool.connect();
    try {
      await client.query("DROP SCHEMA IF EXISTS control_plane CASCADE");
      await client.query("DROP TABLE IF EXISTS public.control_plane_schema_migrations");
    } finally { client.release(); await pool.end(); }
  });
  beforeEach(async () => {
    await pool.query("TRUNCATE control_plane.notification_outbox, control_plane.plan_change_cursors, control_plane.telegram_chat_bindings, control_plane.runtime_routes, control_plane.jobs, control_plane.plans, control_plane.feature_switch_settings, control_plane.trips CASCADE");
    await siteA?.close();
    await siteB?.close();
    siteA = await startStubSite();
    siteB = await startStubSite();
    tripA = await seedTrip(pool, "colmar-a", siteA.origin);
    tripB = await seedTrip(pool, "colmar-b", siteB.origin);
    bindingA = await bindGroup(pool, tripA, GROUP_A);
    await bindGroup(pool, tripB, GROUP_B);
    for (const trip of [tripA, tripB]) {
      const result = await setFeatureSwitch(pool, { switch: SWITCH, enabled: true, scope: "trip", trip, live: true, by: "test" });
      assert.equal(result.ok, true);
    }
    logs.length = 0;
    clock = new Date("2026-12-03T10:00:00Z"); // 11:00 in Paris
    await minute(0); // first sight of both trips
    const { messages } = (await (await fetch(`${telegramBase}/_control/sent`)).json() as { result: { messages: Sent[] } }).result;
    floor = Math.max(0, ...messages.map((m) => m.seq));
  });

  test("AC-30 shape: dinner moved 20:00 to 19:00 in the day is ONE line in A's group, none in B's; moving it back inside 5 minutes sends nothing", async () => {
    await minute(2 * min);
    edit(siteA, "rev_a2", [dinner("19:00")]);
    for (let i = 0; i < 4; i++) await minute();
    assert.deepEqual(await sentTo(GROUP_A), [], "still inside the quiet period");
    await minute(2 * min);
    const toA = await sentTo(GROUP_A);
    assert.deepEqual(toA.map((m) => m.text), ["Plan change: Dinner — now at 19:00 (was 20:00)"]);
    assert.deepEqual(await sentTo(GROUP_B), [], "another trip's group hears nothing");
    for (let i = 0; i < 5; i++) await minute();
    assert.equal((await sentTo(GROUP_A)).length, 1, "and it is not repeated");

    // Back again before anyone is told: the net difference is empty.
    edit(siteA, "rev_a3", [dinner("20:00", "19:00")]);
    await minute();
    edit(siteA, "rev_a4", []);
    for (let i = 0; i < 10; i++) await minute();
    assert.equal((await sentTo(GROUP_A)).length, 1, "a change and its undo send nothing");
  });

  test("each trip's line goes to its own group only, in its own language", async () => {
    siteB.plan = { ...siteB.plan, language: "he" };
    edit(siteA, "rev_a2", [dinner("19:00")]);
    edit(siteB, "rev_b2", [dinner("18:00", "19:00")]);
    for (let i = 0; i < 7; i++) await minute();
    assert.deepEqual((await sentTo(GROUP_A)).map((m) => m.text), ["Plan change: Dinner — now at 19:00 (was 20:00)"]);
    assert.deepEqual((await sentTo(GROUP_B)).map((m) => m.text), ["שינוי בתוכנית: ארוחת ערב — עכשיו ב-18:00 (במקום 19:00)"]);
  });

  test("with A's setting off nothing is sent to A's group, and turning it back on does not replay it", async () => {
    siteA.plan = { ...siteA.plan, group_change_line: false };
    edit(siteA, "rev_a2", [dinner("19:00")]);
    for (let i = 0; i < 8; i++) await minute();
    assert.deepEqual(await sentTo(GROUP_A), []);
    siteA.plan = { ...siteA.plan, group_change_line: true, changes: [] };
    for (let i = 0; i < 8; i++) await minute();
    assert.deepEqual(await sentTo(GROUP_A), [], "no backlog");
  });

  test("night: a change at 23:00 Paris waits, and at 08:00 one line is sent", async () => {
    clock = new Date("2026-12-03T21:50:00Z"); // 22:50
    await minute(0);
    clock = new Date("2026-12-03T22:00:00Z"); // 23:00
    edit(siteA, "rev_a2", [{ ...dinner("12:30", "13:00"), date: "2026-12-04", text_en: "Lunch at the market" }]);
    for (const iso of ["2026-12-03T22:10:00Z", "2026-12-03T23:30:00Z", "2026-12-04T03:00:00Z", "2026-12-04T06:55:00Z"]) {
      clock = new Date(new Date(iso).getTime() - min);
      await minute();
      assert.deepEqual(await sentTo(GROUP_A), [], `${iso}: night in Paris`);
    }
    clock = new Date("2026-12-04T06:59:00Z");
    await minute(); // 08:00 Paris
    assert.deepEqual((await sentTo(GROUP_A)).map((m) => m.text), ["Plan change: Lunch at the market — now at 12:30 (was 13:00)"]);
  });

  test("three edits inside the quiet period arrive as one message, with the dinner line once", async () => {
    edit(siteA, "rev_a2", [dinner("19:30")]);
    await minute();
    await minute();
    edit(siteA, "rev_a3", [dinner("19:00"), { kind: "added", fields: [], date: "2026-12-04", time: "16:00", text_en: "Winery visit", text_he: "ביקור ביקב" }]);
    for (let i = 0; i < 8; i++) await minute();
    const toA = await sentTo(GROUP_A);
    assert.equal(toA.length, 1);
    assert.equal(toA[0]!.text, "Plan update\nDinner — now at 19:00 (was 20:00)\nAdded to the plan: Winery visit — tomorrow (Friday, Dec 4) at 16:00");
  });

  test("a closed binding gets nothing, even for a line already queued", async () => {
    edit(siteA, "rev_a2", [dinner("19:00")]);
    // Let the poller enqueue, but close the group before the dispatcher runs.
    for (let i = 0; i < 7; i++) {
      clock = new Date(clock.getTime() + min);
      await pollPlanChangesOnce({ db: pool, exchangeKey: KEY, upstreamHostSuffixes: ["localhost"], now: () => clock, log: (line) => logs.push(line) });
    }
    const queued = await pool.query("SELECT count(*)::int AS n FROM control_plane.notification_outbox WHERE trip_id = $1 AND state = 'pending'", [tripA]);
    assert.equal(queued.rows[0].n, 1);
    await pool.query("UPDATE control_plane.telegram_chat_bindings SET closed_at = now(), closed_reason = 'left_group' WHERE id = $1", [bindingA]);
    await dispatchPendingTripNotifications(pool, adapter, (line) => logs.push(line));
    assert.deepEqual(await sentTo(GROUP_A), []);
    const row = await pool.query("SELECT state FROM control_plane.notification_outbox WHERE trip_id = $1", [tripA]);
    assert.equal(row.rows[0].state, "skipped");
    assert.ok(logs.some((line) => line.includes('"reason":"binding_closed"')));
    assert.ok(!logs.join("\n").includes(GROUP_A), "no log line carries the chat id");
  });

  test("a group of another trip is never reached by A's row, even if the binding is swapped under it", async () => {
    edit(siteA, "rev_a2", [dinner("19:00")]);
    for (let i = 0; i < 7; i++) {
      clock = new Date(clock.getTime() + min);
      await pollPlanChangesOnce({ db: pool, exchangeKey: KEY, upstreamHostSuffixes: ["localhost"], now: () => clock, log: (line) => logs.push(line) });
    }
    // A bug (or an attacker with a database write) points A's row at B's group.
    await pool.query(
      "UPDATE control_plane.notification_outbox SET binding_id = (SELECT id FROM control_plane.telegram_chat_bindings WHERE chat_id = $2) WHERE trip_id = $1",
      [tripA, GROUP_B],
    );
    await dispatchPendingTripNotifications(pool, adapter, (line) => logs.push(line));
    assert.deepEqual(await sentTo(GROUP_B), []);
    assert.deepEqual(await sentTo(GROUP_A), []);
    assert.ok(logs.some((line) => line.includes('"reason":"binding_trip_mismatch"')));
  });

  test("with the switch off for A, nothing is asked of A's site and nothing is sent", async () => {
    const off = await setFeatureSwitch(pool, { switch: SWITCH, enabled: false, scope: "trip", trip: tripA, live: true, by: "test" });
    assert.equal(off.ok, true);
    siteA.requests.length = 0;
    edit(siteA, "rev_a2", [dinner("19:00")]);
    for (let i = 0; i < 8; i++) await minute();
    assert.deepEqual(siteA.requests, []);
    assert.deepEqual(await sentTo(GROUP_A), []);
  });
});
