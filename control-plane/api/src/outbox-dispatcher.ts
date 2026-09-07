import type pg from "pg";
import type { NotificationAdapter } from "./signup.js";
import { structuredLog } from "./redaction.js";
import { organizerIntroText, type ProactiveSettings } from "./companion-intro.js";

interface OutboxRow {
  id: string;
  notification_type: string;
  recipient: string | null;
  payload: Record<string, unknown> | null;
  attempt: number;
  max_attempts: number;
}

function payloadString(row: OutboxRow, key: string): string | null {
  const value = row.payload?.[key];
  return typeof value === "string" && value.length > 0 ? value : null;
}

/**
 * Wording for the `operator_*` types. These are addressed to the operator's own
 * chat id, NOT to an organizer, which is why they may carry identifiers and
 * diagnostics that the organizer-facing text above deliberately withholds.
 *
 * They are observability only. Nothing in the provisioning pipeline reads,
 * waits for, or branches on whether one of these was delivered.
 */
function operatorMessageTextFor(row: OutboxRow): string | null {
  const title = payloadString(row, "trip_title") ?? payloadString(row, "trip_slug") ?? "Untitled trip";
  const lines = [
    `Trip: ${title}${payloadString(row, "trip_id") ? ` (${payloadString(row, "trip_id")})` : ""}`,
  ];
  const organizer = payloadString(row, "organizer");
  if (organizer) lines.push(`Organizer: ${organizer}`);

  if (row.notification_type === "operator_provisioning_approved") {
    const planId = payloadString(row, "plan_id");
    if (!planId) return null;
    lines.unshift("🟡 Provisioning approved by the organizer");
    lines.push(`Plan: ${planId}`);
    const digest = payloadString(row, "plan_digest");
    if (digest) lines.push(`Digest: ${digest}`);
    const releaseId = payloadString(row, "release_id");
    if (releaseId) lines.push(`Release: ${releaseId}`);
    lines.push("Status: provisioning queued");
    return lines.join("\n");
  }

  if (row.notification_type === "operator_provisioning_complete") {
    lines.unshift("🟢 Provisioning complete");
    const url = payloadString(row, "private_url");
    if (url) lines.push(`Site: ${url}`);
    lines.push("Status: ready_private");
    return lines.join("\n");
  }

  if (row.notification_type === "operator_provisioning_failed") {
    lines.unshift("🔴 Provisioning failed");
    // Operator-addressed, so the safe error code belongs here — the organizer
    // copy of this same event deliberately omits it.
    lines.push(`Status: ${payloadString(row, "safe_error_code") ?? "PROVISIONING_FAILED"}`);
    return lines.join("\n");
  }

  return null;
}

/**
 * Builds the DM text for one trip-notification outbox row, or null for a
 * notification_type this dispatcher doesn't know how to word yet (the row is
 * marked 'skipped', not retried forever).
 */
function messageTextFor(row: OutboxRow, options?: DispatchOptions): string | null {
  if (row.notification_type.startsWith("operator_")) return operatorMessageTextFor(row);
  if (row.notification_type === "provisioning_complete") {
    const url = row.payload && typeof row.payload.private_url === "string" ? row.payload.private_url : null;
    if (!url) return null;
    // The full introduction when the provisioner supplied the facts for one,
    // and the original one-liner when it did not. Rows enqueued before this
    // existed carry only `private_url`, and they still have to send something
    // rather than being skipped for missing fields they were never given.
    const assistantName = payloadString(row, "assistant_name");
    if (!assistantName) return `Your trip site is ready: ${url}`;
    return organizerIntroText({
      assistantName,
      tripTitle: payloadString(row, "trip_title"),
      siteUrl: url,
      language: payloadString(row, "language") === "he" ? "he" : "en",
      loginPassword: payloadString(row, "login_password"),
      botUsername: options?.botUsername ?? null,
      tripSlug: payloadString(row, "trip_slug"),
      organizerName: payloadString(row, "organizer"),
      proactive: (row.payload?.proactive as ProactiveSettings | undefined) ?? null,
    });
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
/** Deployment facts the wording needs but the outbox row cannot carry. */
export interface DispatchOptions {
  /**
   * The shared bot's @username, for the add-to-group deep link.
   *
   * Resolved once from `getMe` rather than stored per row: it belongs to the
   * deployment, and a row written before a bot rename would otherwise hand the
   * organizer a link to a handle that no longer exists. Absent simply omits
   * that paragraph.
   */
  botUsername?: string | null;
}

export async function dispatchPendingTripNotifications(
  db: pg.Pool,
  notification: NotificationAdapter,
  log: (line: string) => void = () => {},
  options?: DispatchOptions,
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
    const text = messageTextFor(row, options);
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
