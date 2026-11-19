import assert from "node:assert/strict";
import { after, before, beforeEach, describe, test } from "node:test";
import { fileURLToPath } from "node:url";
import pg from "pg";
import { setFeatureSwitch } from "../src/feature-switches.js";
import { applyMigrations } from "../src/migrations.js";
import { MAX_WAIT_MS, QUIET_MS, pollPlanChangesOnce, type PlanChangePollerDeps } from "../src/plan-change-poller.js";
import { BASE_PLAN, bindGroup, seedTrip, startFakeGateway, startStubSite, tripKeyFor, type FakeGateway, type StubSite } from "./support/plan-change-site.js";
import { testDatabaseUrl, testPool } from "./support/test-database.js";

// Video Release 1C, G2: the trigger (docs/specs/sprint-9/x-video-r1-group-line.md, AC-9 to AC-20).
// A stub site answers the route, the clock is injected, and every number below is trip time: Europe/Paris unless a
// test says otherwise. This process is not in Paris, which is the point of AC-16.
const databaseUrl = testDatabaseUrl();
const skip = !databaseUrl;
const migrationsDir = fileURLToPath(new URL("../../db/migrations/", import.meta.url));

const KEY = "test-exchange-key-not-a-real-one";
const GROUP = "-1001000000011";
const min = 60_000;
const at = (iso: string) => new Date(iso);

let pool: pg.Pool;
let site: StubSite;
let gateway: FakeGateway;
let tripId: string;
let clock: Date;
let logs: string[];

const deps = (over: Partial<PlanChangePollerDeps> = {}): PlanChangePollerDeps => ({
  db: pool, exchangeKey: KEY, runtimeOrigin: gateway.origin, upstreamHostSuffixes: ["localhost"], now: () => clock, log: (line) => logs.push(line), ...over,
});
const tick = () => pollPlanChangesOnce(deps());
const advance = async (ms: number) => { clock = new Date(clock.getTime() + ms); return tick(); };

const dinner = (time = "19:00", previous = "20:00") => ({ kind: "updated", fields: ["time"], date: "2026-12-03", time, previous_time: previous, text_en: "Dinner", text_he: "ארוחת ערב" });
const winery = { kind: "added", fields: [], date: "2026-12-04", time: "16:00", text_en: "Winery visit", text_he: "ביקור ביקב" };
/** A new revision of the stub's plan, written `agoMs` before the clock. */
function revise(rev: string, changes: Array<Record<string, unknown>>, agoMs = 0) {
  site.plan = { ...site.plan, active_revision_id: rev, active_created_at: new Date(clock.getTime() - agoMs).toISOString(), changes };
}

async function outbox() {
  return (await pool.query<{ state: string; target: string | null; recipient: string | null; payload: { changes: Array<Record<string, unknown>>; language: string; time_zone: string; as_of: string }; trip_id: string; dedupe_key: string }>(
    "SELECT state, target, recipient, payload, trip_id, dedupe_key FROM control_plane.notification_outbox WHERE notification_type = 'trip_plan_changed' ORDER BY created_at, id",
  )).rows;
}
async function cursor() {
  return (await pool.query<{ revision_id: string; pending_since: Date | null; held_for_night: boolean; last_sent_at: Date | null }>(
    "SELECT revision_id, pending_since, held_for_night, last_sent_at FROM control_plane.plan_change_cursors WHERE trip_id = $1", [tripId],
  )).rows[0] ?? null;
}
const failedLines = () => logs.map((line) => JSON.parse(line)).filter((entry) => entry.event === "plan_change_poll.failed");

describe("the group line's trigger (G2)", { skip }, () => {
  before(async () => {
    gateway = await startFakeGateway(KEY);
    pool = testPool();
    const client = await pool.connect();
    try {
      await client.query("DROP SCHEMA IF EXISTS control_plane CASCADE");
      await client.query("DROP TABLE IF EXISTS public.control_plane_schema_migrations");
      await applyMigrations(client, migrationsDir);
    } finally { client.release(); }
  });
  after(async () => {
    const client = await pool.connect();
    try {
      await client.query("DROP SCHEMA IF EXISTS control_plane CASCADE");
      await client.query("DROP TABLE IF EXISTS public.control_plane_schema_migrations");
    } finally { client.release(); await pool.end(); }
  });
  beforeEach(async () => {
    await pool.query("TRUNCATE control_plane.notification_outbox, control_plane.plan_change_cursors, control_plane.telegram_chat_bindings, control_plane.runtime_routes, control_plane.jobs, control_plane.plans, control_plane.feature_switch_settings, control_plane.trips CASCADE");
    await site?.close();
    site = await startStubSite();
    tripId = await seedTrip(pool, "colmar-test", site.origin);
    await bindGroup(pool, tripId, GROUP);
    const on = await setFeatureSwitch(pool, { switch: "plan_change_group_line", enabled: true, scope: "trip", trip: tripId, live: true, by: "test" });
    assert.equal(on.ok, true);
    clock = at("2026-12-03T10:00:00Z"); // 11:00 in Paris
    logs = [];
    // The first tick of every test is "first sight": the cursor is the plan as it is, nothing is replayed.
    await tick();
    assert.equal((await cursor())?.revision_id, BASE_PLAN.active_revision_id);
    site.requests.length = 0;
  });
  after(async () => { await site?.close(); await gateway?.close(); });

  test("AC-17: a trip seen for the first time stores the active revision and sends nothing, however much history it has", async () => {
    await pool.query("TRUNCATE control_plane.plan_change_cursors");
    site.plan = { ...site.plan, active_revision_id: "rev_history99", changes: [dinner()] };
    clock = new Date(clock.getTime() + 60 * min);
    const summary = await tick();
    assert.deepEqual(summary, { polled: 1, enqueued: 0, failed: 0 });
    assert.equal((await cursor())?.revision_id, "rev_history99");
    assert.deepEqual(await outbox(), []);
    assert.equal(site.requests[0]!.since, null, "no cursor, so no since: the site is only asked where the plan is");
  });

  test("AC-K2.11: the poll goes to the gateway with the control-plane key; the site is read with the trip's own key and id, since the group's revision", async () => {
    gateway.requests.length = 0;
    await tick();
    assert.deepEqual(gateway.requests, [{ url: `/internal/t/${tripId}/plan-changes?since=rev_base0001`, since: BASE_PLAN.active_revision_id, apiKey: KEY }]);
    assert.deepEqual(site.requests.map((r) => ({ key: r.apiKey, trip: r.tripId, since: r.since })), [{ key: tripKeyFor(tripId), trip: tripId, since: BASE_PLAN.active_revision_id }]);
    assert.match(site.requests[0]!.url, /^\/api\/internal\/control-plane\/plan-changes\?since=rev_base0001$/);
  });

  test("AC-K2.11: the control-plane key is sent to runtimeOrigin and to nothing else: the site's address is never contacted by the poller", async () => {
    const calls: Array<{ url: string; key: string | undefined; redirect: RequestRedirect | undefined }> = [];
    const spy = (async (input: string | URL | Request, init?: RequestInit) => {
      calls.push({ url: String(input), key: (init?.headers as Record<string, string> | undefined)?.["x-api-key"], redirect: init?.redirect });
      return fetch(input, init);
    }) as typeof fetch;
    gateway.requests.length = 0; site.requests.length = 0;
    await pollPlanChangesOnce(deps({ fetchImpl: spy }));
    assert.equal(calls.length, 1);
    assert.ok(calls[0]!.url.startsWith(`${gateway.origin}/internal/t/${tripId}/plan-changes`), calls[0]!.url);
    assert.equal(calls[0]!.key, KEY);
    assert.equal(calls[0]!.redirect, "manual");
    assert.ok(calls.every((c) => !c.url.startsWith(site.origin)), "no request to the site's own address");
    assert.ok(site.requests.every((r) => r.apiKey !== KEY), "the site never saw the control-plane key");
  });

  test("AC-K2.11: a gateway that refuses the key, or is not there, is a logged failure code with no cursor move", async () => {
    revise("rev_2", [dinner()], 10 * min);
    assert.deepEqual(await pollPlanChangesOnce(deps({ exchangeKey: "not-the-key" })), { polled: 1, enqueued: 0, failed: 1 });
    assert.equal(failedLines().at(-1)!.safe_error_code, "SITE_HTTP_401");
    const away = await startFakeGateway(KEY);
    const gone = away.origin;
    await away.close();
    assert.deepEqual(await pollPlanChangesOnce(deps({ runtimeOrigin: gone })), { polled: 1, enqueued: 0, failed: 1 });
    assert.equal(failedLines().at(-1)!.safe_error_code, "SITE_UNREACHABLE");
    assert.equal((await cursor())?.revision_id, BASE_PLAN.active_revision_id);
    const text = logs.join("\n");
    assert.ok(!text.includes(KEY) && !text.includes(gone) && !text.includes(gateway.origin), "no key and no address in a log line");
  });

  test("AC-K2.14: when every poll of a tick fails the way a missing gateway fails, one aggregate line says so, once per ten minutes, with no address or key", async () => {
    const away = await startFakeGateway(KEY);
    const gone = away.origin;
    await away.close();
    const suspect = { lastLoggedAt: null as number | null };
    const lines = () => logs.map((line) => JSON.parse(line)).filter((entry) => entry.event === "plan_change_poll.gateway_suspect");
    const tickGone = () => pollPlanChangesOnce(deps({ runtimeOrigin: gone, gatewaySuspect: suspect }));

    assert.deepEqual(await tickGone(), { polled: 1, enqueued: 0, failed: 1 });
    assert.equal(lines().length, 1, "the tick's one failure is also said once as a whole");
    assert.equal(lines()[0].level, "warn");
    assert.equal(lines()[0].safe_error_codes, "SITE_UNREACHABLE=1");
    assert.match(lines()[0].consequence, /the group line cannot reach any trip until the runtime gateway answers/);
    assert.equal(failedLines().length, 1, "the per-trip line is still written");

    clock = new Date(clock.getTime() + 9 * min);
    await tickGone();
    assert.equal(lines().length, 1, "nine minutes later: no second line");
    clock = new Date(clock.getTime() + 2 * min);
    await tickGone();
    assert.equal(lines().length, 2, "eleven minutes after the first: the next one");

    const text = logs.join("\n");
    assert.ok(!text.includes(KEY) && !text.includes(gone) && !text.includes(gateway.origin), "no key and no address in any line");
  });

  test("AC-K2.14: the aggregate names the road, not the trip: a site's own failure, or one trip that polled fine, is not it", async () => {
    const suspect = { lastLoggedAt: null as number | null };
    const lines = () => logs.map((line) => JSON.parse(line)).filter((entry) => entry.event === "plan_change_poll.gateway_suspect");
    // the gateway refuses the key: SITE_HTTP_401 is not a code that points at the road
    await pollPlanChangesOnce(deps({ exchangeKey: "not-the-key", gatewaySuspect: suspect }));
    assert.equal(lines().length, 0);
    // a good tick
    await pollPlanChangesOnce(deps({ gatewaySuspect: suspect }));
    assert.equal(lines().length, 0);
    // a site's own 500 comes back through the gateway unchanged
    site.broken = { status: 500, body: "{}" };
    await pollPlanChangesOnce(deps({ gatewaySuspect: suspect }));
    assert.equal(lines().length, 0);
    // a gateway that has no such route, or cannot reach the site, is what the aggregate is for
    for (const status of [404, 502, 503]) {
      suspect.lastLoggedAt = null;
      site.broken = { status, body: "{}" };
      await pollPlanChangesOnce(deps({ gatewaySuspect: suspect }));
      assert.equal(lines().at(-1)?.safe_error_codes, `SITE_HTTP_${status}=1`);
    }
    assert.equal(lines().length, 3);
  });

  test("AC-9: with the switch off nothing is asked of the site and nothing is enqueued", async () => {
    const off = await setFeatureSwitch(pool, { switch: "plan_change_group_line", enabled: false, scope: "trip", trip: tripId, live: true, by: "test" });
    assert.equal(off.ok, true);
    revise("rev_2", [dinner()], 10 * min);
    const summary = await advance(10 * min);
    assert.deepEqual(summary, { polled: 0, enqueued: 0, failed: 0 });
    assert.deepEqual(site.requests, []);
    assert.deepEqual(await outbox(), []);
    assert.equal(await cursor(), null, "a trip that is off has no cursor, so turning it on never replays history");
  });

  test("a trip whose group is gone is not polled either, and loses its cursor", async () => {
    await pool.query("UPDATE control_plane.telegram_chat_bindings SET closed_at = now(), closed_reason = 'left_group' WHERE trip_id = $1", [tripId]);
    revise("rev_2", [dinner()], 10 * min);
    assert.deepEqual(await advance(10 * min), { polled: 0, enqueued: 0, failed: 0 });
    assert.deepEqual(site.requests, []);
    assert.equal(await cursor(), null);
  });

  test("a private chat alone is no group: the trip is not polled", async () => {
    await pool.query("UPDATE control_plane.telegram_chat_bindings SET chat_id = '555000111' WHERE trip_id = $1", [tripId]);
    revise("rev_2", [dinner()], 10 * min);
    assert.deepEqual(await advance(10 * min), { polled: 0, enqueued: 0, failed: 0 });
    assert.deepEqual(site.requests, []);
  });

  test("AC-11: dinner moved at 14:00 trip time is one message once the plan has been quiet for 5 minutes, and not before", async () => {
    clock = at("2026-12-03T13:00:00Z"); // 14:00 in Paris
    await tick();
    revise("rev_2", [dinner()], 0); // the edit happens now
    assert.equal((await tick()).enqueued, 0, "just edited: wait");
    assert.equal((await advance(4 * min)).enqueued, 0, "4 minutes is not 5");
    assert.deepEqual(await outbox(), []);
    assert.equal((await advance(1 * min + 1)).enqueued, 1, "5 minutes with no further version");
    const rows = await outbox();
    assert.equal(rows.length, 1);
    assert.deepEqual({ target: rows[0]!.target, recipient: rows[0]!.recipient, trip: rows[0]!.trip_id, state: rows[0]!.state }, { target: "trip_group", recipient: null, trip: tripId, state: "pending" });
    assert.equal(rows[0]!.payload.language, "en");
    assert.equal(rows[0]!.payload.time_zone, "Europe/Paris");
    assert.deepEqual(rows[0]!.payload.changes.map((c) => [c.kind, c.time, c.previous_time, c.text_en]), [["updated", "19:00", "20:00", "Dinner"]]);
    assert.equal(rows[0]!.dedupe_key.startsWith(`plan-change:${tripId}:rev_2#`), true);
    assert.equal((await cursor())?.revision_id, "rev_2", "the cursor moved in the same transaction");
    assert.equal((await cursor())?.pending_since, null);
    // and it is not sent twice
    assert.equal((await advance(10 * min)).enqueued, 0);
    assert.equal((await outbox()).length, 1);
  });

  test("a Hebrew trip's payload says so", async () => {
    clock = at("2026-12-03T13:00:00Z");
    await tick();
    site.plan = { ...site.plan, language: "he" };
    revise("rev_2", [dinner()], 6 * min);
    await tick();
    assert.equal((await outbox())[0]!.payload.language, "he");
  });

  test("AC-12: three edits inside 4 minutes are one message after the quiet period, from the revision the group last heard", async () => {
    clock = at("2026-12-03T13:00:00Z");
    await tick();
    revise("rev_2", [dinner("19:30")], 0);
    await tick();
    await advance(2 * min);
    revise("rev_3", [dinner("19:00"), winery], 0); // second edit and a new item, 2 minutes in
    await tick();
    await advance(2 * min);
    assert.deepEqual(await outbox(), [], "still inside the quiet period of the last edit");
    assert.equal((await advance(3 * min + 1)).enqueued, 1);
    const rows = await outbox();
    assert.equal(rows.length, 1);
    assert.deepEqual(rows[0]!.payload.changes.map((c) => c.text_en), ["Dinner", "Winery visit"]);
    assert.equal(rows[0]!.payload.changes[0]!.time, "19:00");
    assert.equal(rows[0]!.payload.changes[0]!.previous_time, "20:00");
    assert.ok(site.requests.every((r) => r.since === "rev_base0001" || r.since === "rev_3" || r.since === "rev_2" || r.since === null || r.since.startsWith("rev_")));
  });

  test("AC-13: an item changed and changed back sends nothing, and the cursor advances", async () => {
    clock = at("2026-12-03T13:00:00Z");
    await tick();
    revise("rev_2", [dinner()], 0);
    await tick();
    await advance(2 * min);
    revise("rev_3", [], 0); // back as it was: the net difference is empty
    assert.equal((await tick()).enqueued, 0);
    assert.equal((await cursor())?.revision_id, "rev_3");
    assert.equal((await cursor())?.pending_since, null);
    await advance(30 * min);
    assert.deepEqual(await outbox(), []);
  });

  test("AC-14: edits every 3 minutes without pause: a message goes out no later than 15 minutes after the first, and the later edits are a later message", async () => {
    clock = at("2026-12-03T13:00:00Z");
    await tick();
    const first = clock.getTime();
    let sentAfter: number | null = null;
    let n = 1;
    for (let minute = 0; minute <= 24; minute++) {
      if (minute % 3 === 0) { n++; revise(`rev_${n}`, [dinner(`${10 + n}:00`)], 0); }
      await tick();
      if (sentAfter === null && (await outbox()).length === 1) sentAfter = clock.getTime() - first;
      clock = new Date(clock.getTime() + min);
    }
    assert.ok(sentAfter !== null && sentAfter <= MAX_WAIT_MS + 60_000, `first message after ${sentAfter! / min} minutes`);
    assert.ok(sentAfter! >= MAX_WAIT_MS - 60_000, "and not earlier than the cap while the edits kept coming");
    const rows = await outbox();
    assert.equal(rows.length >= 1, true);
    assert.ok(rows.every((r, i) => i === 0 || r.dedupe_key !== rows[i - 1]!.dedupe_key), "a later message is a later revision");
    assert.equal(QUIET_MS, 5 * min);
  });

  test("AC-15: a change at 23:10 trip time is held, nothing goes out overnight, and at 08:00 one message carries it", async () => {
    clock = at("2026-12-03T22:00:00Z"); // 23:00 in Paris
    await tick();
    clock = at("2026-12-03T22:10:00Z"); // 23:10
    revise("rev_2", [{ ...winery, date: "2026-12-04", time: "12:30", text_en: "Lunch at the market" }], 0);
    await tick();
    for (const iso of ["2026-12-03T22:30:00Z", "2026-12-04T00:30:00Z", "2026-12-04T05:00:00Z", "2026-12-04T06:59:00Z"]) {
      clock = at(iso);
      assert.equal((await tick()).enqueued, 0, `${iso} is night in Paris`);
    }
    assert.equal((await cursor())?.held_for_night, true);
    assert.deepEqual(await outbox(), []);
    clock = at("2026-12-04T07:00:00Z"); // 08:00 in Paris
    assert.equal((await tick()).enqueued, 1);
    assert.equal((await outbox()).length, 1);
    assert.equal((await cursor())?.held_for_night, false);
  });

  test("AC-15: an item whose day is over by 08:00 is dropped from it, and with nothing else pending nothing is sent", async () => {
    clock = at("2026-12-03T22:00:00Z");
    await tick();
    clock = at("2026-12-03T22:10:00Z");
    revise("rev_2", [{ ...winery, date: "2026-12-03", time: "23:30", text_en: "Night walk" }], 0);
    await tick();
    clock = at("2026-12-04T07:00:00Z");
    assert.equal((await tick()).enqueued, 0, "the walk was last night");
    assert.deepEqual(await outbox(), []);
    assert.equal((await cursor())?.revision_id, "rev_2", "the cursor still advances: it is not news, and not a backlog");
  });

  test("an item earlier today, already past at send time, is dropped; one later today stays", async () => {
    clock = at("2026-12-03T10:00:00Z"); // 11:00 Paris
    await tick();
    revise("rev_2", [{ ...dinner("09:00", "08:00"), text_en: "Breakfast" }, dinner("19:00", "20:00")], 6 * min);
    await tick();
    assert.deepEqual((await outbox())[0]!.payload.changes.map((c) => c.text_en), ["Dinner"]);
  });

  test("AC-16: the night window is the TRIP's: the same instant is night in Tokyo and day in Paris", async () => {
    const tokyoSite = await startStubSite({ time_zone: "Asia/Tokyo", today: "2026-12-03" });
    try {
      const tokyo = await seedTrip(pool, "tokyo-test", tokyoSite.origin);
      await bindGroup(pool, tokyo, "-1001000000012");
      await setFeatureSwitch(pool, { switch: "plan_change_group_line", enabled: true, scope: "trip", trip: tokyo, live: true, by: "test" });
      clock = at("2026-12-03T13:00:00Z"); // 14:00 Paris, 22:00 Tokyo
      await tick();
      for (const s of [site, tokyoSite]) {
        s.plan = { ...s.plan, active_revision_id: "rev_2", active_created_at: new Date(clock.getTime() - 10 * min).toISOString(), changes: [{ ...winery, date: "2026-12-04" }] };
      }
      await tick();
      const rows = await outbox();
      assert.deepEqual(rows.map((r) => r.trip_id), [tripId], "Paris sent, Tokyo held for the night");
      const held = await pool.query("SELECT held_for_night FROM control_plane.plan_change_cursors WHERE trip_id = $1", [tokyo]);
      assert.equal(held.rows[0].held_for_night, true);
    } finally { await tokyoSite.close(); }
  });

  test("AC-10: with the setting off nothing is enqueued and the cursor follows the plan; turning it back on sends only later changes", async () => {
    clock = at("2026-12-03T13:00:00Z");
    await tick();
    site.plan = { ...site.plan, group_change_line: false };
    revise("rev_2", [dinner()], 10 * min);
    assert.equal((await tick()).enqueued, 0);
    assert.equal((await cursor())?.revision_id, "rev_2");
    await advance(10 * min);
    assert.deepEqual(await outbox(), []);
    site.plan = { ...site.plan, group_change_line: true, changes: [] };
    await advance(min);
    assert.deepEqual(await outbox(), [], "no backlog");
    revise("rev_3", [winery], 10 * min);
    assert.equal((await tick()).enqueued, 1);
    assert.deepEqual((await outbox())[0]!.payload.changes.map((c) => c.text_en), ["Winery visit"]);
  });

  test("a cursor the site no longer knows (restore-original) says nothing and starts again from there", async () => {
    clock = at("2026-12-03T13:00:00Z");
    await tick();
    site.plan = { ...site.plan, since_known: false, active_revision_id: "rev_other", changes: [dinner()] };
    assert.equal((await tick()).enqueued, 0);
    assert.equal((await cursor())?.revision_id, "rev_other");
    assert.deepEqual(await outbox(), []);
  });

  test("AC-18: a removed item and an update are in the payload as the site gave them", async () => {
    clock = at("2026-12-03T13:00:00Z");
    await tick();
    revise("rev_2", [{ kind: "removed", fields: [], date: "2026-12-05", time: "16:00", text_en: "Winery visit", text_he: "ביקור ביקב" }], 7 * min);
    await tick();
    assert.deepEqual((await outbox())[0]!.payload.changes.map((c) => c.kind), ["removed"]);
  });

  test("AC-18: an item on a past day is not in the message", async () => {
    clock = at("2026-12-03T13:00:00Z");
    await tick();
    revise("rev_2", [{ ...dinner(), date: "2026-12-02", text_en: "Yesterday's lunch" }, winery], 7 * min);
    await tick();
    assert.deepEqual((await outbox())[0]!.payload.changes.map((c) => c.text_en), ["Winery visit"]);
  });

  describe("AC-20: a site that cannot be read changes nothing", () => {
    for (const [label, apply] of [
      ["answering 500", (s: StubSite) => { s.broken = { status: 500, body: "{}" }; }],
      ["answering a redirect (the key is never sent on)", (s: StubSite) => { s.broken = { status: 302, headers: { location: "http://127.0.0.1:1/steal" } }; }],
      ["answering something that is not JSON", (s: StubSite) => { s.broken = { status: 200, body: "<html>" }; }],
      ["answering a body that fails the schema", (s: StubSite) => { s.broken = { status: 200, body: JSON.stringify({ active_revision_id: "rev_9", changes: "nope" }) }; }],
      ["answering a time zone of a hundred characters", (s: StubSite) => { s.broken = { status: 200, body: JSON.stringify({ ...BASE_PLAN, time_zone: "x".repeat(100) }) }; }],
    ] as const) {
      test(`${label}: nothing enqueued, the cursor does not move, one failure line with the trip id and a code only; the next good poll sends the net difference`, async () => {
        clock = at("2026-12-03T13:00:00Z");
        await tick();
        revise("rev_2", [dinner()], 10 * min);
        const good = site.plan;
        apply(site);
        const summary = await tick();
        assert.deepEqual(summary, { polled: 1, enqueued: 0, failed: 1 });
        assert.deepEqual(await outbox(), []);
        assert.equal((await cursor())?.revision_id, BASE_PLAN.active_revision_id);
        const lines = failedLines();
        assert.equal(lines.length, 1);
        assert.deepEqual(Object.keys(lines[0]).sort(), ["event", "level", "safe_error_code", "trip_id"]);
        assert.equal(lines[0].trip_id, tripId);
        assert.match(lines[0].safe_error_code, /^SITE_[A-Z0-9_]+$/);
        assert.ok(!logs.join("\n").includes(KEY) && !logs.join("\n").includes(site.origin));
        site.broken = null;
        site.plan = good;
        assert.equal((await advance(min)).enqueued, 1);
      });
    }

    test("an unreachable site (nothing listening): the gateway answers 503, which is the code the poller logs", async () => {
      clock = at("2026-12-03T13:00:00Z");
      await tick();
      await site.close();
      revise("rev_2", [dinner()], 10 * min);
      assert.deepEqual(await tick(), { polled: 1, enqueued: 0, failed: 1 });
      assert.equal(failedLines()[0].safe_error_code, "SITE_HTTP_503");
      assert.equal((await cursor())?.revision_id, BASE_PLAN.active_revision_id);
      site = await startStubSite(); // so afterEach hooks have something to close
    });

    test("a trip with no ready route is a failure line, not a send", async () => {
      await pool.query("UPDATE control_plane.runtime_routes SET state = 'suspended' WHERE trip_id = $1", [tripId]);
      assert.deepEqual(await tick(), { polled: 1, enqueued: 0, failed: 1 });
      assert.equal(failedLines()[0].safe_error_code, "RUNTIME_NOT_READY");
      assert.deepEqual(site.requests, []);
    });

    test("a site on a host outside the allow-list is never sent the key", async () => {
      assert.deepEqual(await pollPlanChangesOnce(deps({ upstreamHostSuffixes: ["sites.example.invalid"] })), { polled: 1, enqueued: 0, failed: 1 });
      assert.equal(failedLines()[0].safe_error_code, "RUNTIME_ROUTE_INVALID");
      assert.deepEqual(site.requests, []);
    });
  });

  describe("one bad entry does not wedge a trip (regression plan, round 3)", () => {
    const tooLong = { kind: "added", fields: [], date: "2026-12-04", time: "16:00", text_en: "x".repeat(500), text_he: "ארוך" };
    const droppedLines = () => logs.map((line) => JSON.parse(line)).filter((entry) => entry.event === "plan_change_poll.entries_dropped");

    test("an entry past the text limit is dropped on its own: the rest of the body is still sent, with one logged code", async () => {
      clock = at("2026-12-03T13:00:00Z");
      await tick();
      revise("rev_2", [tooLong, dinner()], 7 * min);
      const summary = await tick();
      assert.deepEqual(summary, { polled: 1, enqueued: 1, failed: 0 });
      assert.deepEqual((await outbox())[0]!.payload.changes.map((c) => c.text_en), ["Dinner"]);
      assert.equal((await cursor())?.revision_id, "rev_2");
      const lines = droppedLines();
      assert.equal(lines.length, 1);
      assert.deepEqual({ trip: lines[0].trip_id, code: lines[0].safe_error_code, invalid: lines[0].invalid }, { trip: tripId, code: "ENTRY_INVALID", invalid: 1 });
      assert.ok(!JSON.stringify(lines[0]).includes("xxxx"), "the text is never logged");
      assert.equal(failedLines().length, 0, "it is not a failed poll");
    });

    test("an entry of an unknown kind, or with a malformed day, is dropped too", async () => {
      clock = at("2026-12-03T13:00:00Z");
      await tick();
      revise("rev_2", [{ kind: "exploded", date: "2026-12-04" }, { kind: "added", date: "12/04/2026", text_en: "Bad day" }, dinner()], 7 * min);
      assert.equal((await tick()).enqueued, 1);
      assert.deepEqual((await outbox())[0]!.payload.changes.map((c) => c.text_en), ["Dinner"]);
      assert.equal(droppedLines()[0].invalid, 2);
    });

    test("when nothing valid is left the cursor still advances, and the drop is logged rather than silent", async () => {
      clock = at("2026-12-03T13:00:00Z");
      await tick();
      revise("rev_2", [tooLong], 7 * min);
      assert.equal((await tick()).enqueued, 0);
      assert.equal((await cursor())?.revision_id, "rev_2");
      assert.equal(droppedLines().length, 1);
    });

    test("more than 200 valid entries: the first 200 are kept and the surplus is logged", async () => {
      clock = at("2026-12-03T13:00:00Z");
      await tick();
      revise("rev_2", Array.from({ length: 230 }, (_, i) => ({ ...winery, text_en: `Thing ${i}`, time: "16:00" })), 7 * min);
      assert.equal((await tick()).enqueued, 1);
      assert.equal((await outbox())[0]!.payload.changes.length, 200);
      assert.deepEqual({ code: droppedLines()[0].safe_error_code, surplus: droppedLines()[0].surplus }, { code: "ENTRIES_OVER_LIMIT", surplus: 30 });
    });

    test("a body whose envelope is wrong is still refused whole", async () => {
      clock = at("2026-12-03T13:00:00Z");
      await tick();
      revise("rev_2", [dinner()], 7 * min);
      site.plan = { ...site.plan, language: "fr" as never };
      assert.deepEqual(await tick(), { polled: 1, enqueued: 0, failed: 1 });
      assert.equal(failedLines()[0].safe_error_code, "SITE_BODY_INVALID");
    });
  });

  describe("a failed switch read must not wipe the cursors (boundary review, round 3)", () => {
    const cursorCount = async () => (await pool.query("SELECT count(*)::int AS n FROM control_plane.plan_change_cursors")).rows[0].n as number;
    const feature = () => logs.map((line) => JSON.parse(line)).filter((entry) => entry.event === "plan_change_poll.cleanup_skipped");

    test("a switch read that throws skips cleanup: the cursor and its pending edit survive, and the edit is sent after recovery", async () => {
      clock = at("2026-12-03T13:00:00Z");
      await tick();
      revise("rev_2", [dinner()], 0); // an edit is pending: the cursor is the plan the group last heard
      await tick();
      assert.ok((await cursor())?.pending_since, "the edit is waiting out its quiet period");
      assert.equal((await cursor())?.revision_id, BASE_PLAN.active_revision_id);

      const broken = await pollPlanChangesOnce(deps({ switchOn: async () => { throw new Error("connection reset"); } }));
      assert.deepEqual(broken, { polled: 0, enqueued: 0, failed: 0 });
      assert.equal(await cursorCount(), 1, "nothing was deleted");
      assert.equal((await cursor())?.revision_id, BASE_PLAN.active_revision_id, "and the cursor is still the plan the group heard");
      assert.equal(feature().length, 1, "the skipped cleanup is logged, with a code");
      assert.equal(feature()[0].safe_error_code, "SWITCH_READ_FAILED");

      // The database recovers. The pending edit is sent, not lost to a re-baseline.
      assert.equal((await advance(6 * min)).enqueued, 1);
      assert.deepEqual((await outbox())[0]!.payload.changes.map((c) => c.text_en), ["Dinner"]);
    });

    test("the real switch read failing in the database does the same", async () => {
      clock = at("2026-12-03T13:00:00Z");
      await tick();
      revise("rev_2", [dinner()], 0);
      await tick();
      const flaky = {
        query: (sql: string, params?: unknown[]) => (String(sql).includes("feature_enabled")
          ? Promise.reject(Object.assign(new Error("terminating connection"), { code: "57P01" }))
          : pool.query(sql, params)),
        connect: () => pool.connect(),
      } as unknown as pg.Pool;
      assert.deepEqual(await pollPlanChangesOnce(deps({ db: flaky })), { polled: 0, enqueued: 0, failed: 0 });
      assert.equal(await cursorCount(), 1);
      assert.ok(logs.some((line) => JSON.parse(line).event === "feature_switch.read_failed"));
      assert.equal((await advance(6 * min)).enqueued, 1);
    });

    test("one trip's failed read keeps every trip's cursor, not just its own", async () => {
      const other = await startStubSite();
      try {
        const otherTrip = await seedTrip(pool, "other-test", other.origin);
        await bindGroup(pool, otherTrip, "-1001000000013");
        await setFeatureSwitch(pool, { switch: "plan_change_group_line", enabled: true, scope: "trip", trip: otherTrip, live: true, by: "test" });
        await tick();
        assert.equal(await cursorCount(), 2);
        await pollPlanChangesOnce(deps({ switchOn: async (id) => { if (id === otherTrip) throw new Error("boom"); return true; } }));
        assert.equal(await cursorCount(), 2);
      } finally { await other.close(); }
    });

    test("a switch positively read as off still drops the cursor, once every read succeeds", async () => {
      assert.equal(await cursorCount(), 1);
      await setFeatureSwitch(pool, { switch: "plan_change_group_line", enabled: false, scope: "trip", trip: tripId, live: true, by: "test" });
      await tick();
      assert.equal(await cursorCount(), 0);
      assert.equal(feature().length, 0);
    });

    test("a trip with no open group still loses its cursor on a clean tick", async () => {
      await pool.query("UPDATE control_plane.telegram_chat_bindings SET closed_at = now(), closed_reason = 'left_group' WHERE trip_id = $1", [tripId]);
      await tick();
      assert.equal(await cursorCount(), 0);
    });
  });

  test("a switch that reads as anything but a literal true is off", async () => {
    for (const value of [undefined, null, "true", 1, false] as unknown[]) {
      const summary = await pollPlanChangesOnce(deps({ switchOn: async () => value as boolean }));
      assert.deepEqual(summary, { polled: 0, enqueued: 0, failed: 0 }, String(value));
    }
    assert.deepEqual(site.requests, []);
  });

  test("a tick that cannot read the database says so and does nothing", async () => {
    const broken = { query: async () => { throw Object.assign(new Error("boom"), { code: "08006" }); }, connect: async () => { throw new Error("boom"); } } as unknown as pg.Pool;
    const summary = await pollPlanChangesOnce(deps({ db: broken }));
    assert.deepEqual(summary, { polled: 0, enqueued: 0, failed: 0 });
    assert.ok(logs.some((line) => JSON.parse(line).event === "plan_change_poll.tick_failed"));
  });
});
