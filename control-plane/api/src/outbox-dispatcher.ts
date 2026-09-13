import type pg from "pg";
import type { NotificationAdapter } from "./signup.js";
import { structuredLog } from "./redaction.js";
import { organizerIntroMessages, type ProactiveSettings } from "./companion-intro.js";
import { issueGroupBindingToken } from "./group-binding.js";

interface OutboxRow {
  id: string;
  trip_id: string | null;
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

/** `[{name, username}]` as written by the provisioner, or null if absent/malformed. */
function payloadPeople(row: OutboxRow, key: string): { name: string; username: string }[] | null {
  const value = row.payload?.[key];
  if (!Array.isArray(value)) return null;
  const people = value.flatMap((entry) => {
    const name = (entry as { name?: unknown })?.name;
    const username = (entry as { username?: unknown })?.username;
    return typeof name === "string" && typeof username === "string" && name && username
      ? [{ name, username }]
      : [];
  });
  return people.length > 0 ? people : null;
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
function messageTextFor(row: OutboxRow, options?: DispatchOptions): string | string[] | null {
  if (row.notification_type.startsWith("operator_")) return operatorMessageTextFor(row);
  if (row.notification_type === "provisioning_complete" || row.notification_type === "companion_ready") {
    const url = row.payload && typeof row.payload.private_url === "string" ? row.payload.private_url : null;
    if (!url) return null;
    // Two different pieces of news, and the difference matters to the
    // organizer. `provisioning_complete` says the SITE is up — true the moment
    // the deploy lands, and all it carries is the URL. `companion_ready` says
    // the ASSISTANT is up, and is the only one that introduces itself and hands
    // over a group-binding token, because it is the only one enqueued after a
    // companion actually exists.
    //
    // A trip whose companion never installs therefore gets the first message
    // and not the second: no introduction claiming an assistant is waiting, and
    // no token to bind a group to a trip that has none.
    //
    // The `assistant_name` test also carries the back-compat case: rows written
    // before any of this exist with only `private_url`, and still send.
    const assistantName = payloadString(row, "assistant_name");
    if (!assistantName) return `Your trip site is ready: ${url}`;
    return organizerIntroMessages({
      assistantName,
      tripTitle: payloadString(row, "trip_title"),
      siteUrl: url,
      language: payloadString(row, "language") === "he" ? "he" : "en",
      loginPassword: payloadString(row, "login_password"),
      loginUsernames: payloadPeople(row, "login_usernames"),
      botUsername: options?.botUsername ?? null,
      tripSlug: payloadString(row, "trip_slug"),
      organizerName: payloadString(row, "organizer"),
      proactive: (row.payload?.proactive as ProactiveSettings | undefined) ?? null,
      groupBindingToken: options?.groupBindingToken ?? null,
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
  /** How long an issued group-binding token stays valid. Defaults to 30 days. */
  groupBindingTtlSeconds?: number;
  /**
   * The trip's group-binding token, issued just before this message is worded.
   *
   * Not stored on the outbox row: the row is written by the provisioner, in a
   * transaction, before anyone knows whether the organizer will ever want a
   * group. Issuing it at send time also means the token's clock starts when the
   * organizer actually receives it.
   */
  groupBindingToken?: string | null;
}

export async function dispatchPendingTripNotifications(
  db: pg.Pool,
  notification: NotificationAdapter,
  log: (line: string) => void = () => {},
  options?: DispatchOptions,
): Promise<number> {
  const { rows } = await db.query<OutboxRow>(
    `SELECT id, trip_id, notification_type, recipient, payload, attempt, max_attempts
     FROM control_plane.notification_outbox
     WHERE state = 'pending' AND trip_id IS NOT NULL
     ORDER BY created_at
     LIMIT 20`,
  );

  let dispatched = 0;
  for (const row of rows) {
    // The organizer's introduction carries a group-binding token, so one is
    // issued here — addressed to the chat this message is going to, which for a
    // DM is the organizer's own Telegram user id. That is what later makes a
    // forwarded token useless: only this recipient can redeem it.
    let groupBindingToken: string | null = null;
    // Only the companion introduction carries a token — the site-ready message
    // must never mint one, because at that point there is no companion for a
    // bound group to reach.
    if (
      row.notification_type === "companion_ready"
      && row.trip_id
      && row.recipient
      && typeof row.payload?.assistant_name === "string"
    ) {
      try {
        const issued = await issueGroupBindingToken(db, row.trip_id, row.recipient, {
          ttlSeconds: options?.groupBindingTtlSeconds ?? 30 * 24 * 3600,
        });
        if (issued.ok) groupBindingToken = issued.token;
      } catch (error) {
        // Never a gate. An introduction without the group step is still worth
        // sending — the organizer can ask for a token at any time.
        log(structuredLog("warn", "outbox.group_token_unavailable", {
          safe_error_code: error instanceof Error ? error.name : "UNKNOWN",
        }));
      }
    }
    const text = messageTextFor(row, { ...options, groupBindingToken });
    if (!row.recipient || !text || (Array.isArray(text) && text.length === 0)) {
      await db.query(
        "UPDATE control_plane.notification_outbox SET state = 'skipped', updated_at = now() WHERE id = $1 AND state = 'pending'",
        [row.id],
      );
      continue;
    }
    try {
      // A list when the introduction hands over a group-binding token: the
      // token goes in its own message so it is one long-press and one Copy,
      // rather than a drag-select across a paragraph on a phone.
      //
      // Sent in order, and the row is only marked sent once ALL of them are.
      // A retry may therefore repeat the prose — which is the right trade:
      // a duplicated paragraph is noise, while a token that never arrived is
      // an organizer who cannot set up their group at all.
      for (const part of Array.isArray(text) ? text : [text]) {
        await notification.sendMessage({ chatId: row.recipient, text: part });
      }
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
