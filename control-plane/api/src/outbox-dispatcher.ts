import type pg from "pg";
import type { NotificationAdapter } from "./signup.js";
import { structuredLog } from "./redaction.js";

interface OutboxRow {
  id: string;
  notification_type: string;
  recipient: string | null;
  payload: Record<string, unknown> | null;
  attempt: number;
  max_attempts: number;
}

/**
 * Builds the DM text for one trip-notification outbox row, or null for a
 * notification_type this dispatcher doesn't know how to word yet (the row is
 * marked 'skipped', not retried forever).
 */
function messageTextFor(row: OutboxRow): string | null {
  if (row.notification_type === "provisioning_complete") {
    const url = row.payload && typeof row.payload.private_url === "string" ? row.payload.private_url : null;
    if (!url) return null;
    return `Your trip site is ready: ${url}`;
  }
  if (row.notification_type === "provisioning_failed") {
    // Deliberately no error code/detail here — payload.safe_error_code is an
    // operator-facing diagnostic, not organizer-facing content.
    return "There was a problem setting up your trip site. We're looking into it — no action needed from you right now.";
  }
  return null;
}

/**
 * Sends every pending trip notification (notification_outbox rows with a
 * trip_id — the legacy admin_signup_approval row is sent inline by
 * startSignup() and never reaches this path). Scoped to trip_id IS NOT NULL
 * deliberately, matching notification_outbox_trip_unsent_idx.
 *
 * No row-level locking: this assumes a single dispatcher caller at a time
 * (server.ts's setInterval loop guards against overlapping runs of itself).
 * If this ever runs from more than one API process concurrently, this needs
 * an atomic claim (UPDATE ... FOR UPDATE SKIP LOCKED) instead.
 */
export async function dispatchPendingTripNotifications(
  db: pg.Pool,
  notification: NotificationAdapter,
  log: (line: string) => void = () => {},
): Promise<number> {
  const { rows } = await db.query<OutboxRow>(
    `SELECT id, notification_type, recipient, payload, attempt, max_attempts
     FROM control_plane.notification_outbox
     WHERE state = 'pending' AND trip_id IS NOT NULL
     ORDER BY created_at
     LIMIT 20`,
  );

  let dispatched = 0;
  for (const row of rows) {
    const text = messageTextFor(row);
    if (!row.recipient || !text) {
      await db.query(
        "UPDATE control_plane.notification_outbox SET state = 'skipped', updated_at = now() WHERE id = $1 AND state = 'pending'",
        [row.id],
      );
      continue;
    }
    try {
      await notification.sendMessage({ chatId: row.recipient, text });
      await db.query(
        "UPDATE control_plane.notification_outbox SET state = 'sent', sent_at = now(), updated_at = now() WHERE id = $1",
        [row.id],
      );
      dispatched++;
    } catch {
      log(structuredLog("error", "outbox.dispatch_failed", {
        safe_error_code: "NOTIFICATION_SEND_FAILED",
        notification_id: row.id,
      }));
      await db.query(
        `UPDATE control_plane.notification_outbox
         SET state = CASE WHEN attempt + 1 >= max_attempts THEN 'failed' ELSE 'pending' END,
             attempt = attempt + 1, updated_at = now()
         WHERE id = $1`,
        [row.id],
      );
    }
  }
  return dispatched;
}
