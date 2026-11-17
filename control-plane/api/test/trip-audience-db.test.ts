import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { after, before, beforeEach, describe, test } from "node:test";
import { fileURLToPath } from "node:url";
import pg from "pg";
import { FakeNotificationAdapter } from "../src/adapters/notification.js";
import { dispatchPendingTripNotifications } from "../src/outbox-dispatcher.js";
import { applyMigrations } from "../src/migrations.js";
import { confirmAudience, enqueueTripMessage, resolveTripAudience } from "../src/trip-audience.js";
import { testDatabaseUrl, testPool } from "./support/test-database.js";

// Video Release 1C, G1: the outbound path (docs/specs/sprint-9/x-video-r1-group-line.md, AC-1 to AC-6, AC-8).
// Runs against the caller's own cptest_<name> database, never against the shared `cptest`.
const databaseUrl = testDatabaseUrl();
const skip = !databaseUrl;
const migrationsDir = fileURLToPath(new URL("../../db/migrations/", import.meta.url));

const GROUP_A = "-1001000000001";
const GROUP_A2 = "-1001000000003";
const GROUP_B = "-1001000000002";
const PRIVATE_A = "555000111";

const id = (prefix: string) => `${prefix}_${randomBytes(16).toString("hex")}`;

let pool: pg.Pool;
let tripA: string;
let tripB: string;
const bindingOf: Record<string, string> = {};

async function insertTrip(slug: string): Promise<string> {
  const tripId = id("trip");
  await pool.query("INSERT INTO control_plane.trips(id, slug, lifecycle_state) VALUES ($1, $2, 'ready_private')", [tripId, slug]);
  return tripId;
}

async function bind(tripId: string, chatId: string): Promise<string> {
  const bindingId = id("tcb");
  await pool.query(
    "INSERT INTO control_plane.telegram_chat_bindings(id, chat_id, trip_id, hermes_profile) VALUES ($1, $2, $3, 'profile')",
    [bindingId, chatId, tripId],
  );
  bindingOf[chatId] = bindingId;
  return bindingId;
}

const payload = (extra: Record<string, unknown> = {}) => ({
  language: "en",
  time_zone: "Europe/Paris",
  as_of: "2026-12-03T13:00:00Z",
  changes: [{ kind: "updated", fields: ["time"], date: "2026-12-03", time: "19:00", previous_date: null, previous_time: "20:00", text_en: "Dinner", text_he: "ארוחת ערב" }],
  ...extra,
});

async function rowsOf(tripId: string) {
  return (await pool.query<{ id: string; state: string; target: string | null; recipient: string | null; binding_id: string | null; adapter: string; dedupe_key: string | null; attempt: number }>(
    "SELECT id, state, target, recipient, binding_id, adapter, dedupe_key, attempt FROM control_plane.notification_outbox WHERE trip_id = $1 ORDER BY created_at, id",
    [tripId],
  )).rows;
}

async function dispatch(notification = new FakeNotificationAdapter()) {
  const logs: string[] = [];
  const sent = await dispatchPendingTripNotifications(pool, notification, (line) => logs.push(line));
  return { notification, logs, sent };
}

describe("trip audience: the outbound path (G1)", { skip }, () => {
  before(async () => {
    pool = testPool();
    const client = await pool.connect();
    try {
      await client.query("DROP SCHEMA IF EXISTS control_plane CASCADE");
      await client.query("DROP TABLE IF EXISTS public.control_plane_schema_migrations");
      await applyMigrations(client, migrationsDir);
    } finally {
      client.release();
    }
  });
  after(async () => {
    const client = await pool.connect();
    try {
      await client.query("DROP SCHEMA IF EXISTS control_plane CASCADE");
      await client.query("DROP TABLE IF EXISTS public.control_plane_schema_migrations");
    } finally {
      client.release();
      await pool.end();
    }
  });
  beforeEach(async () => {
    await pool.query("TRUNCATE control_plane.notification_outbox, control_plane.telegram_chat_bindings, control_plane.trips CASCADE");
    tripA = await insertTrip("trip-a");
    tripB = await insertTrip("trip-b");
    await bind(tripA, GROUP_A);
    await bind(tripA, PRIVATE_A);
    await bind(tripB, GROUP_B);
  });

  test("resolveTripAudience: the trip's own open GROUP bindings only, never a private chat, a closed binding or another trip", async () => {
    assert.deepEqual(await resolveTripAudience(pool, tripA, "trip_group"), [{ channel: "telegram", bindingId: bindingOf[GROUP_A], chatId: GROUP_A }]);
    await bind(tripA, GROUP_A2);
    assert.deepEqual((await resolveTripAudience(pool, tripA, "trip_group")).map((m) => m.chatId).sort(), [GROUP_A, GROUP_A2].sort());
    await pool.query("UPDATE control_plane.telegram_chat_bindings SET closed_at = now(), closed_reason = 'left_group' WHERE id = $1", [bindingOf[GROUP_A2]]);
    assert.deepEqual((await resolveTripAudience(pool, tripA, "trip_group")).map((m) => m.chatId), [GROUP_A]);
    assert.deepEqual((await resolveTripAudience(pool, tripB, "trip_group")).map((m) => m.chatId), [GROUP_B]);
  });

  test("AC-1: a targeted row for trip A reaches A's group exactly once and no other chat", async () => {
    const written = await enqueueTripMessage(pool, { tripId: tripA, type: "trip_plan_changed", target: "trip_group", payload: payload(), dedupeKey: "k1" });
    assert.equal(written, 1);
    const [row] = await rowsOf(tripA);
    assert.deepEqual({ target: row!.target, recipient: row!.recipient, binding: row!.binding_id, adapter: row!.adapter, state: row!.state }, {
      target: "trip_group", recipient: null, binding: bindingOf[GROUP_A], adapter: "control-plane", state: "pending",
    });
    const { notification, sent } = await dispatch();
    assert.equal(sent, 1);
    assert.deepEqual(notification.messageCalls, [{ chatId: GROUP_A, text: "Plan change: Dinner — now at 19:00 (was 20:00)" }]);
    assert.equal((await rowsOf(tripA))[0]!.state, "sent");
    assert.deepEqual(await rowsOf(tripB), [], "trip B has no row and its group heard nothing");
  });

  test("a trip with two open groups gets one row, and one message, per group", async () => {
    await bind(tripA, GROUP_A2);
    assert.equal(await enqueueTripMessage(pool, { tripId: tripA, type: "trip_plan_changed", target: "trip_group", payload: payload({ language: "he" }), dedupeKey: "k2" }), 2);
    const { notification } = await dispatch();
    assert.deepEqual(notification.messageCalls.map((m) => m.chatId).sort(), [GROUP_A, GROUP_A2].sort());
    assert.ok(notification.messageCalls.every((m) => m.text === "שינוי בתוכנית: ארוחת ערב — עכשיו ב-19:00 (במקום 20:00)"));
  });

  test("the message is plain text: no parse mode, so a title can never be markup", async () => {
    await enqueueTripMessage(pool, { tripId: tripA, type: "trip_plan_changed", target: "trip_group", payload: payload({
      changes: [{ kind: "added", fields: [], date: "2026-12-10", time: "16:00", text_en: "<b>Tour</b> & more" }],
    }), dedupeKey: "k3" });
    const { notification } = await dispatch();
    assert.equal(notification.messageCalls.length, 1);
    assert.equal("parseMode" in notification.messageCalls[0]!, false);
    assert.equal(notification.messageCalls[0]!.text, "Added to the plan: <b>Tour</b> & more — on Thursday, Dec 10 at 16:00");
  });

  test("AC-2: a binding closed after the row was enqueued gets nothing, and the row ends skipped (binding_closed)", async () => {
    await enqueueTripMessage(pool, { tripId: tripA, type: "trip_plan_changed", target: "trip_group", payload: payload(), dedupeKey: "k4" });
    await pool.query("UPDATE control_plane.telegram_chat_bindings SET closed_at = now(), closed_reason = 'left_group' WHERE id = $1", [bindingOf[GROUP_A]]);
    const { notification, logs, sent } = await dispatch();
    assert.equal(sent, 0);
    assert.deepEqual(notification.messageCalls, []);
    assert.equal((await rowsOf(tripA))[0]!.state, "skipped");
    const line = logs.map((l) => JSON.parse(l)).find((l) => l.event === "outbox.targeted_skipped");
    assert.equal(line.reason, "binding_closed");
    assert.ok(!logs.join("\n").includes(GROUP_A), "the log carries no chat id");
  });

  test("AC-3: a row for trip A whose binding names trip B sends nothing and ends skipped (binding_trip_mismatch)", async () => {
    await pool.query(
      `INSERT INTO control_plane.notification_outbox (id, trip_id, kind, recipient, payload, signup_request_id, notification_type, adapter, state, target, binding_id)
       VALUES ($1, $2, 'trip_plan_changed', NULL, $3::jsonb, NULL, 'trip_plan_changed', 'control-plane', 'pending', 'trip_group', $4)`,
      [id("notif"), tripA, JSON.stringify(payload()), bindingOf[GROUP_B]],
    );
    const { notification, logs } = await dispatch();
    assert.deepEqual(notification.messageCalls, [], "B's group heard nothing about A");
    assert.equal((await rowsOf(tripA))[0]!.state, "skipped");
    assert.equal(logs.map((l) => JSON.parse(l)).find((l) => l.event === "outbox.targeted_skipped").reason, "binding_trip_mismatch");
  });

  test("a targeted row whose binding is a private chat, or has none, is never sent (no_audience)", async () => {
    for (const binding of [bindingOf[PRIVATE_A], null]) {
      await pool.query(
        `INSERT INTO control_plane.notification_outbox (id, trip_id, kind, recipient, payload, signup_request_id, notification_type, adapter, state, target, binding_id)
         VALUES ($1, $2, 'trip_plan_changed', NULL, $3::jsonb, NULL, 'trip_plan_changed', 'control-plane', 'pending', 'trip_group', $4)`,
        [id("notif"), tripA, JSON.stringify(payload()), binding],
      );
    }
    const { notification, logs } = await dispatch();
    assert.deepEqual(notification.messageCalls, [], "no DM, ever");
    assert.deepEqual((await rowsOf(tripA)).map((r) => r.state), ["skipped", "skipped"]);
    assert.deepEqual(logs.map((l) => JSON.parse(l)).filter((l) => l.event === "outbox.targeted_skipped").map((l) => l.reason), ["no_audience", "no_audience"]);
  });

  test("AC-4: the database refuses a recipient beside a target, and a target with no trip", async () => {
    const insert = (recipient: string | null, tripId: string | null) => pool.query(
      `INSERT INTO control_plane.notification_outbox (id, trip_id, kind, recipient, payload, signup_request_id, notification_type, adapter, state, target, binding_id)
       VALUES ($1, $2, 'trip_plan_changed', $3, '{}'::jsonb, NULL, 'trip_plan_changed', 'control-plane', 'pending', 'trip_group', $4)`,
      [id("notif"), tripId, recipient, bindingOf[GROUP_A]],
    );
    await assert.rejects(insert("999111222", tripA), (error: { code?: string }) => error.code === "23514");
    await assert.rejects(insert(null, null), (error: { code?: string }) => error.code === "23514");
    await assert.rejects(pool.query(
      `INSERT INTO control_plane.notification_outbox (id, trip_id, kind, recipient, payload, signup_request_id, notification_type, adapter, state, target)
       VALUES ($1, $2, 'x', NULL, '{}'::jsonb, NULL, 'x', 'control-plane', 'pending', 'everyone')`,
      [id("notif"), tripA],
    ), (error: { code?: string }) => error.code === "23514", "an unknown target is not a target");
    await insert(null, tripA); // and the valid shape goes in
  });

  test("AC-5 (deferred by the brief, 'never DM'): trip_organizer resolves to nobody and a row that carries it is skipped, never sent", async () => {
    assert.deepEqual(await resolveTripAudience(pool, tripA, "trip_organizer"), []);
    assert.equal(await enqueueTripMessage(pool, { tripId: tripA, type: "trip_plan_changed", target: "trip_organizer", payload: payload(), dedupeKey: "k5" }), 0);
    await pool.query(
      `INSERT INTO control_plane.notification_outbox (id, trip_id, kind, recipient, payload, signup_request_id, notification_type, adapter, state, target, binding_id)
       VALUES ($1, $2, 'trip_plan_changed', NULL, $3::jsonb, NULL, 'trip_plan_changed', 'control-plane', 'pending', 'trip_organizer', $4)`,
      [id("notif"), tripA, JSON.stringify(payload()), bindingOf[PRIVATE_A]],
    );
    const { notification, logs } = await dispatch();
    assert.deepEqual(notification.messageCalls, []);
    assert.equal((await rowsOf(tripA))[0]!.state, "skipped");
    assert.equal(logs.map((l) => JSON.parse(l)).find((l) => l.event === "outbox.targeted_skipped").reason, "target_unsupported");
    assert.deepEqual(await confirmAudience(pool, { trip_id: tripA, target: "trip_organizer", binding_id: bindingOf[PRIVATE_A]! }), { ok: false, reason: "target_unsupported" });
  });

  test("AC-6: a second enqueue with the same dedupe key is a no-op; a different key is a new row", async () => {
    const input = { tripId: tripA, type: "trip_plan_changed", target: "trip_group" as const, payload: payload(), dedupeKey: "plan-change:a:rev1" };
    assert.equal(await enqueueTripMessage(pool, input), 1);
    assert.equal(await enqueueTripMessage(pool, input), 0);
    assert.equal((await rowsOf(tripA)).length, 1);
    assert.equal(await enqueueTripMessage(pool, { ...input, dedupeKey: "plan-change:a:rev2" }), 1);
    assert.equal((await rowsOf(tripA)).length, 2);
    // Two groups: one enqueue is two rows, and the repeat is still a no-op for both.
    await bind(tripA, GROUP_A2);
    assert.equal(await enqueueTripMessage(pool, { ...input, dedupeKey: "plan-change:a:rev3" }), 2);
    assert.equal(await enqueueTripMessage(pool, { ...input, dedupeKey: "plan-change:a:rev3" }), 0);
  });

  test("a send that fails is retried like any other row, then fails for good; nothing reaches another chat", async () => {
    await enqueueTripMessage(pool, { tripId: tripA, type: "trip_plan_changed", target: "trip_group", payload: payload(), dedupeKey: "k6" });
    const failing = new FakeNotificationAdapter();
    failing.sendMessage = async () => { throw new Error("telegram sendMessage failed: HTTP 500"); };
    for (let attempt = 1; attempt <= 3; attempt++) {
      const { sent, logs } = await dispatch(failing);
      assert.equal(sent, 0);
      assert.ok(logs.some((l) => l.includes("NOTIFICATION_SEND_FAILED")));
      const [row] = await rowsOf(tripA);
      assert.equal(row!.attempt, attempt);
      assert.equal(row!.state, attempt < 3 ? "pending" : "failed");
    }
  });

  test("a row whose payload says nothing wordable is skipped (no_text), not sent empty", async () => {
    await enqueueTripMessage(pool, { tripId: tripA, type: "trip_plan_changed", target: "trip_group", payload: { language: "en" }, dedupeKey: "k7" });
    const { notification, logs } = await dispatch();
    assert.deepEqual(notification.messageCalls, []);
    assert.equal(logs.map((l) => JSON.parse(l)).find((l) => l.event === "outbox.targeted_skipped").reason, "no_text");
  });

  test("AC-28: a plan beside organizer-only needs and a named author renders without either", async () => {
    // The payload is what the poller writes: the closed shape only. Hostile extras riding in it never reach the text.
    await enqueueTripMessage(pool, { tripId: tripA, type: "trip_plan_changed", target: "trip_group", dedupeKey: "k8", payload: payload({
      author: "hermes", participant_needs: "celiac", created_by: "alice",
      changes: [{ kind: "updated", fields: ["time"], date: "2026-12-03", time: "19:00", previous_time: "20:00", text_en: "Dinner", author: "alice", note: "Dana is celiac", participant_needs: "celiac", confirmation: "ABC123" }],
    }) });
    const { notification } = await dispatch();
    assert.equal(notification.messageCalls[0]!.text, "Plan change: Dinner — now at 19:00 (was 20:00)");
  });

  test("AC-8: a legacy row (no target) keeps its recipient path", async () => {
    await pool.query(
      `INSERT INTO control_plane.notification_outbox (id, trip_id, kind, recipient, payload, signup_request_id, notification_type, adapter, state)
       VALUES ($1, $2, 'provisioning_complete', '555000111', '{"private_url":"https://example.test/trip"}'::jsonb, NULL, 'provisioning_complete', 'provisioner', 'pending')`,
      [id("notif"), tripA],
    );
    const { notification } = await dispatch();
    assert.equal(notification.messageCalls[0]!.chatId, "555000111");
    const [row] = await rowsOf(tripA);
    assert.deepEqual({ target: row!.target, binding: row!.binding_id, key: row!.dedupe_key }, { target: null, binding: null, key: null });
  });
});
