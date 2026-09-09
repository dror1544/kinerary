import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import pg from "pg";
import { applyMigrations } from "../src/migrations.js";
import { dispatchPendingTripNotifications } from "../src/outbox-dispatcher.js";
import { FakeNotificationAdapter } from "../src/adapters/notification.js";
import { testDatabaseUrl } from "./support/test-database.js";

const databaseUrl = testDatabaseUrl();
const skip = !databaseUrl;
const migrationsDir = fileURLToPath(new URL("../../db/migrations/", import.meta.url));

async function resetDb(client: pg.PoolClient) {
  await client.query("DROP SCHEMA IF EXISTS control_plane CASCADE");
  await client.query("DROP TABLE IF EXISTS public.control_plane_schema_migrations");
}

function testId(prefix: string): string {
  return `${prefix}_${randomBytes(16).toString("hex")}`;
}

async function insertTrip(pool: pg.Pool): Promise<string> {
  const tripId = testId("trip");
  await pool.query(
    "INSERT INTO control_plane.trips(id, slug, lifecycle_state) VALUES ($1, $2, 'ready_private')",
    [tripId, tripId.replace(/_/g, "-")],
  );
  return tripId;
}

async function insertOutboxRow(
  pool: pg.Pool,
  tripId: string,
  notificationType: string,
  recipient: string | null,
  payload: Record<string, unknown>,
): Promise<string> {
  const id = testId("notf");
  await pool.query(
    `INSERT INTO control_plane.notification_outbox
       (id, trip_id, kind, recipient, payload, notification_type, adapter, state)
     VALUES ($1, $2, $3, $4, $5::jsonb, $3, 'provisioner', 'pending')`,
    [id, tripId, notificationType, recipient, JSON.stringify(payload)],
  );
  return id;
}

test("dispatches a pending provisioning_complete row to the real chat id", { skip }, async () => {
  const pool = new pg.Pool({ connectionString: databaseUrl });
  const client = await pool.connect();
  try {
    await resetDb(client);
    await applyMigrations(client, migrationsDir);
    client.release();

    const tripId = await insertTrip(pool);
    const notifId = await insertOutboxRow(pool, tripId, "provisioning_complete", "555000111", {
      private_url: "https://example.test/trip",
    });

    const notification = new FakeNotificationAdapter();
    const dispatched = await dispatchPendingTripNotifications(pool, notification);

    assert.equal(dispatched, 1);
    assert.equal(notification.messageCalls.length, 1);
    assert.equal(notification.messageCalls[0].chatId, "555000111");
    assert.match(notification.messageCalls[0].text, /https:\/\/example\.test\/trip/);

    const row = await pool.query("SELECT state, sent_at FROM control_plane.notification_outbox WHERE id = $1", [notifId]);
    assert.equal(row.rows[0].state, "sent");
    assert.ok(row.rows[0].sent_at);
  } finally {
    const c2 = await pool.connect();
    await resetDb(c2);
    c2.release();
    await pool.end();
  }
});

test("a row with no recipient chat id is skipped, not sent or retried forever", { skip }, async () => {
  const pool = new pg.Pool({ connectionString: databaseUrl });
  const client = await pool.connect();
  try {
    await resetDb(client);
    await applyMigrations(client, migrationsDir);
    client.release();

    const tripId = await insertTrip(pool);
    const notifId = await insertOutboxRow(pool, tripId, "provisioning_complete", null, {
      private_url: "https://example.test/trip",
    });

    const notification = new FakeNotificationAdapter();
    const dispatched = await dispatchPendingTripNotifications(pool, notification);

    assert.equal(dispatched, 0);
    assert.equal(notification.messageCalls.length, 0);
    const row = await pool.query("SELECT state FROM control_plane.notification_outbox WHERE id = $1", [notifId]);
    assert.equal(row.rows[0].state, "skipped");
  } finally {
    const c2 = await pool.connect();
    await resetDb(c2);
    c2.release();
    await pool.end();
  }
});

test("a provisioning_failed row gets a generic, error-code-free message", { skip }, async () => {
  const pool = new pg.Pool({ connectionString: databaseUrl });
  const client = await pool.connect();
  try {
    await resetDb(client);
    await applyMigrations(client, migrationsDir);
    client.release();

    const tripId = await insertTrip(pool);
    await insertOutboxRow(pool, tripId, "provisioning_failed", "555000222", {
      safe_error_code: "PROVISIONER_ERROR",
    });

    const notification = new FakeNotificationAdapter();
    const dispatched = await dispatchPendingTripNotifications(pool, notification);

    assert.equal(dispatched, 1);
    assert.equal(notification.messageCalls[0].chatId, "555000222");
    assert.doesNotMatch(notification.messageCalls[0].text, /PROVISIONER_ERROR/);
  } finally {
    const c2 = await pool.connect();
    await resetDb(c2);
    c2.release();
    await pool.end();
  }
});

test("send failure re-queues the row until max_attempts, then marks it failed", { skip }, async () => {
  const pool = new pg.Pool({ connectionString: databaseUrl });
  const client = await pool.connect();
  try {
    await resetDb(client);
    await applyMigrations(client, migrationsDir);
    client.release();

    const tripId = await insertTrip(pool);
    const notifId = await insertOutboxRow(pool, tripId, "provisioning_complete", "555000333", {
      private_url: "https://example.test/trip",
    });
    await pool.query("UPDATE control_plane.notification_outbox SET max_attempts = 2 WHERE id = $1", [notifId]);

    const failing = new FakeNotificationAdapter();
    failing.sendMessage = async () => { throw new Error("simulated send failure"); };

    await dispatchPendingTripNotifications(pool, failing);
    let row = await pool.query("SELECT state, attempt FROM control_plane.notification_outbox WHERE id = $1", [notifId]);
    assert.equal(row.rows[0].state, "pending");
    assert.equal(row.rows[0].attempt, 1);

    await dispatchPendingTripNotifications(pool, failing);
    row = await pool.query("SELECT state, attempt FROM control_plane.notification_outbox WHERE id = $1", [notifId]);
    assert.equal(row.rows[0].state, "failed");
    assert.equal(row.rows[0].attempt, 2);
  } finally {
    const c2 = await pool.connect();
    await resetDb(c2);
    c2.release();
    await pool.end();
  }
});

test("the legacy admin_signup_approval row (no trip_id) is never touched by this dispatcher", { skip }, async () => {
  const pool = new pg.Pool({ connectionString: databaseUrl });
  const client = await pool.connect();
  try {
    await resetDb(client);
    await applyMigrations(client, migrationsDir);
    client.release();

    // A real admin_signup_approval row also needs a signup_approval_requests
    // FK; irrelevant here — this dispatcher's query filters on trip_id IS NOT
    // NULL, so a bare outbox row with no trip_id is enough to prove it's skipped.
    const notifId = testId("notf");
    await pool.query(
      `INSERT INTO control_plane.notification_outbox
         (id, notification_type, adapter, state)
       VALUES ($1, 'admin_signup_approval', 'fake', 'pending')`,
      [notifId],
    );

    const notification = new FakeNotificationAdapter();
    const dispatched = await dispatchPendingTripNotifications(pool, notification);

    assert.equal(dispatched, 0);
    assert.equal(notification.messageCalls.length, 0);
    const row = await pool.query("SELECT state FROM control_plane.notification_outbox WHERE id = $1", [notifId]);
    assert.equal(row.rows[0].state, "pending");
  } finally {
    const c2 = await pool.connect();
    await resetDb(c2);
    c2.release();
    await pool.end();
  }
});

test("operator rows carry identifiers and a safe error code the organizer copy withholds", { skip }, async () => {
  const pool = new pg.Pool({ connectionString: databaseUrl });
  const client = await pool.connect();
  try {
    await resetDb(client);
    await applyMigrations(client, migrationsDir);
  } finally { client.release(); }
  try {
    const tripId = await insertTrip(pool);
    const context = { trip_id: tripId, trip_title: "Rome 2026", trip_slug: "rome-2026", organizer: "Dana" };
    await insertOutboxRow(pool, tripId, "operator_provisioning_approved", "operator-chat", {
      ...context, plan_id: "plan_abc", plan_digest: "sha256:deadbeef", release_id: "rel_1", approved_by: "user_1",
    });
    await insertOutboxRow(pool, tripId, "operator_provisioning_complete", "operator-chat", {
      ...context, private_url: "https://rome.example.test",
    });
    await insertOutboxRow(pool, tripId, "operator_provisioning_failed", "operator-chat", {
      ...context, safe_error_code: "DEPLOY_FAILED",
    });
    // The organizer's own copy of the same failure, for contrast.
    await insertOutboxRow(pool, tripId, "provisioning_failed", "organizer-chat", { safe_error_code: "DEPLOY_FAILED" });

    const notification = new FakeNotificationAdapter();
    assert.equal(await dispatchPendingTripNotifications(pool, notification), 4);

    const byChat = new Map(notification.messageCalls.map((call) => [call.text, call.chatId]));
    const operatorTexts = notification.messageCalls.filter((c) => c.chatId === "operator-chat").map((c) => c.text);
    assert.equal(operatorTexts.length, 3);

    const approved = operatorTexts.find((t) => t.includes("Provisioning approved"))!;
    assert.match(approved, /Rome 2026/);
    assert.match(approved, /Organizer: Dana/);
    assert.match(approved, /plan_abc/);
    assert.match(approved, /sha256:deadbeef/);
    assert.match(approved, /provisioning queued/);

    const complete = operatorTexts.find((t) => t.includes("Provisioning complete"))!;
    assert.match(complete, /https:\/\/rome\.example\.test/);
    assert.match(complete, /ready_private/);

    // The operator hears the error code; the organizer explicitly does not.
    const operatorFailure = operatorTexts.find((t) => t.includes("Provisioning failed"))!;
    assert.match(operatorFailure, /DEPLOY_FAILED/);
    const organizerFailure = notification.messageCalls.find((c) => c.chatId === "organizer-chat")!;
    assert.doesNotMatch(organizerFailure.text, /DEPLOY_FAILED/);
    assert.equal(byChat.get(organizerFailure.text), "organizer-chat");

    const states = await pool.query("SELECT state FROM control_plane.notification_outbox WHERE trip_id = $1", [tripId]);
    assert.deepEqual([...new Set(states.rows.map((r) => r.state))], ["sent"]);
  } finally {
    const cleanup = await pool.connect();
    try { await resetDb(cleanup); } finally { cleanup.release(); await pool.end(); }
  }
});

test("an unrecognized operator_ type is skipped, not retried forever", { skip }, async () => {
  const pool = new pg.Pool({ connectionString: databaseUrl });
  const client = await pool.connect();
  try {
    await resetDb(client);
    await applyMigrations(client, migrationsDir);
  } finally { client.release(); }
  try {
    const tripId = await insertTrip(pool);
    const id = await insertOutboxRow(pool, tripId, "operator_something_new", "operator-chat", { trip_id: tripId });
    const notification = new FakeNotificationAdapter();
    assert.equal(await dispatchPendingTripNotifications(pool, notification), 0);
    assert.equal(notification.messageCalls.length, 0);
    const row = await pool.query("SELECT state FROM control_plane.notification_outbox WHERE id = $1", [id]);
    assert.equal(row.rows[0].state, "skipped");
  } finally {
    const cleanup = await pool.connect();
    try { await resetDb(cleanup); } finally { cleanup.release(); await pool.end(); }
  }
});

test("site-ready says only that, and mints no binding token", { skip }, async () => {
  // The ordering bug this exists to prevent, live on 2026-09-07: the
  // introduction was enqueued INSIDE the provisioning transaction while the
  // companion installs AFTER it commits. The organizer received a group-binding
  // token before there was any companion to bind to, bound their family group,
  // and the binding stored NULL — answering "I'm still finishing your
  // assistant" permanently.
  //
  // provisioning_complete now carries the URL and nothing else. It cannot
  // introduce an assistant that does not exist yet, and it cannot hand out a
  // token for one.
  const pool = new pg.Pool({ connectionString: databaseUrl });
  const client = await pool.connect();
  try {
    await resetDb(client);
    await applyMigrations(client, migrationsDir);
    client.release();

    const tripId = await insertTrip(pool);
    await insertOutboxRow(pool, tripId, "provisioning_complete", "555000111", {
      private_url: "https://example.test/trip",
    });

    const sent: Array<{ chatId: string; text: string }> = [];
    await dispatchPendingTripNotifications(pool, {
      async sendApprovalRequest() {},
      async sendMessage(p) { sent.push(p); },
    }, () => {}, { botUsername: "Kinerary_bot" });

    assert.equal(sent.length, 1, "one message, not an introduction plus a token");
    assert.match(sent[0]!.text, /https:\/\/example\.test\/trip/);
    assert.doesNotMatch(sent[0]!.text, /KIN-/, "no binding token");

    const { rowCount } = await pool.query(
      "SELECT 1 FROM control_plane.telegram_group_binding_tokens WHERE trip_id = $1",
      [tripId],
    );
    assert.equal(rowCount, 0, "and none was minted");
  } finally {
    await pool.end();
  }
});

test("companion-ready introduces the assistant and hands over the token", { skip }, async () => {
  const pool = new pg.Pool({ connectionString: databaseUrl });
  const client = await pool.connect();
  try {
    await resetDb(client);
    await applyMigrations(client, migrationsDir);
    client.release();

    const tripId = await insertTrip(pool);
    await insertOutboxRow(pool, tripId, "companion_ready", "555000111", {
      private_url: "https://example.test/trip",
      assistant_name: "Rio",
      trip_title: "Japan 2026",
      trip_slug: "japan-2026",
      language: "en",
      login_password: "seed-pw",
    });

    const sent: Array<{ chatId: string; text: string }> = [];
    await dispatchPendingTripNotifications(pool, {
      async sendApprovalRequest() {},
      async sendMessage(p) { sent.push(p); },
    }, () => {}, { botUsername: "Kinerary_bot" });

    // Two messages: the introduction, then the line to copy on its own.
    assert.equal(sent.length, 2);
    assert.match(sent[0]!.text, /Rio/);
    assert.match(sent[0]!.text, /seed-pw/);
    assert.match(sent[1]!.text, /^\/group KIN-/, "the copyable command, alone");

    const { rowCount } = await pool.query(
      "SELECT 1 FROM control_plane.telegram_group_binding_tokens WHERE trip_id = $1",
      [tripId],
    );
    assert.equal(rowCount, 1, "exactly one live token for the trip");
  } finally {
    await pool.end();
  }
});
