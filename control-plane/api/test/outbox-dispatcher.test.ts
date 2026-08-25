import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import pg from "pg";
import { applyMigrations } from "../src/migrations.js";
import { dispatchPendingTripNotifications } from "../src/outbox-dispatcher.js";
import { FakeNotificationAdapter } from "../src/adapters/notification.js";

const databaseUrl = process.env.CONTROL_PLANE_TEST_DATABASE_URL;
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
