import type pg from "pg";
import type { NotificationAdapter } from "./signup.js";
import { structuredLog } from "./redaction.js";
import { organizerIntroMessages, type IntroMessage, type ProactiveSettings } from "./companion-intro.js";
import { issueGroupBindingToken } from "./group-binding.js";
import { GROUP_CLAIM_LINK_KIND, SIGN_IN_NOTICE_TYPE, groupClaimNoticeText, signInNoticeText } from "./telegram-mini-app.js";
import { confirmAudience, skippedLine } from "./trip-audience.js";
import { renderPlanChangeLine, type PlanChange } from "./plan-change-line.js";
import { dispatchSignInLinkNotices } from "./sign-in-link.js";

interface OutboxRow {
  id: string;
  trip_id: string | null;
  notification_type: string;
  recipient: string | null;
  payload: Record<string, unknown> | null;
  attempt: number;
  max_attempts: number;
  /** A role of the trip ("trip_group"), for a row that has no recipient: see trip-audience.ts. */
  target: string | null;
  binding_id: string | null;
}

export const TRIP_PLAN_CHANGED_TYPE = "trip_plan_changed";

/**
 * The group line, worded from the row's structured payload (`changes` and the trip's language, zone and the instant
 * they are about). Null when nothing in it can be put into words: the row is then skipped, not sent empty.
 * The payload is read through the same closed shape the poller writes; an unreadable one says nothing.
 */
function planChangedText(row: OutboxRow): string | null {
  const payload = row.payload;
  if (!payload || !Array.isArray(payload.changes)) return null;
  const asOf = typeof payload.as_of === "string" ? new Date(payload.as_of) : null;
  if (!asOf || Number.isNaN(asOf.getTime())) return null;
  const changes = payload.changes.flatMap((entry): PlanChange[] => {
    if (!entry || typeof entry !== "object") return [];
    const e = entry as Record<string, unknown>;
    if (e.kind !== "updated" && e.kind !== "added" && e.kind !== "removed") return [];
    const str = (value: unknown) => (typeof value === "string" ? value : null);
    return [{
      kind: e.kind,
      fields: Array.isArray(e.fields) ? e.fields.filter((f): f is string => typeof f === "string") : [],
      date: str(e.date), time: str(e.time),
      previous_date: str(e.previous_date), previous_time: str(e.previous_time),
      text_he: str(e.text_he), text_en: str(e.text_en),
    }];
  });
  return renderPlanChangeLine(changes, {
    language: payload.language === "he" ? "he" : "en",
    timeZone: typeof payload.time_zone === "string" ? payload.time_zone : "UTC",
    now: asOf,
  });
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
function messageTextFor(row: OutboxRow, options?: DispatchOptions): string | IntroMessage[] | null {
  if (row.notification_type.startsWith("operator_")) return operatorMessageTextFor(row);
  if (row.notification_type === TRIP_PLAN_CHANGED_TYPE) return planChangedText(row);
  if (row.notification_type === SIGN_IN_NOTICE_TYPE) {
    // About an account, not a trip (trip_id is NULL). Wording lives with the
    // sign-in code that queues it.
    // A group claim (docs/specs/sprint-9/x-member-sign-in.md, AC-7) tells the organizers in the trip's language.
    if (payloadString(row, "link_kind") === GROUP_CLAIM_LINK_KIND) return groupClaimNoticeText(row.payload);
    return signInNoticeText({
      accountName: payloadString(row, "account_name") ?? "your account",
      linkKind: payloadString(row, "link_kind") === "member" ? "member" : "organizer",
      tripTitle: payloadString(row, "trip_title"),
      at: payloadString(row, "at"),
    }, options?.publicOrigin ?? null);
  }
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
    // It tells the organizer what they CAN do: the dashboard's trip page offers
    // "Try again" for a build that failed for good (portal.ts
    // `retry_provisioning`). Worded in the interview's language when the worker
    // recorded it; English otherwise.
    if (payloadString(row, "language") === "he") {
      return "הייתה בעיה בהקמת אתר הטיול שלכם. זה בדרך כלל זמני — אפשר ללחוץ על \"נסו שוב\" בעמוד הטיול בלוח הבקרה של Kinerary.";
    }
    return "There was a problem setting up your trip site. This is usually temporary — you can tap Try again on your trip's page in the Kinerary dashboard.";
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
  /**
   * Asked for the handle when `botUsername` is absent (see `bot-username.ts`):
   * a profile without `web.telegram_bot_username` must not silently lose the
   * add-to-group link. A null or a throw is logged, never swallowed quietly.
   */
  resolveBotUsername?: () => Promise<string | null>;
  /** The portal's public origin, for the unlink link in the Mini App sign-in notice. Absent drops the link, not the notice. */
  publicOrigin?: string | null;
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
    `SELECT id, trip_id, notification_type, recipient, payload, attempt, max_attempts, target, binding_id
     FROM control_plane.notification_outbox
     WHERE state = 'pending'
       AND (trip_id IS NOT NULL OR notification_type = '${SIGN_IN_NOTICE_TYPE}')
     ORDER BY created_at
     LIMIT 20`,
  );

  let dispatched = 0;
  // ── Sign-in links (docs/specs/sprint-9/x-member-sign-in.md, S3): a pass of their own, in sign-in-link.ts. Their rows carry a
  // one-time token, so they are sent, blanked and expired by code that knows that; the query above never selects them.
  dispatched += await dispatchSignInLinkNotices(db, notification, log, { publicOrigin: options?.publicOrigin ?? null });
  // ── end of the sign-in links block ──
  for (const row of rows) {
    // A row addressed to a ROLE of the trip, not to a chat. Its `recipient` is never read (the database refuses one
    // beside a target): the chat is the trip's own open binding, re-read now. Everything else below is the path every
    // other type has always taken, untouched.
    if (row.target != null) {
      if (await dispatchTargetedRow(db, notification, row, log, options)) dispatched++;
      continue;
    }
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
    // The add-to-group link needs the bot's handle. Only the companion
    // introduction carries that link, so only it asks — and when no handle can
    // be had the introduction still goes (the manual /group line still works),
    // but the missing link is said out loud: it used to vanish without a trace.
    let botUsername = options?.botUsername ?? null;
    if (!botUsername && row.notification_type === "companion_ready" && options?.resolveBotUsername) {
      try {
        botUsername = await options.resolveBotUsername();
      } catch (error) {
        log(structuredLog("warn", "outbox.bot_username_resolver_threw", {
          safe_error_code: error instanceof Error ? error.name : "UNKNOWN",
        }));
      }
    }
    if (!botUsername && row.notification_type === "companion_ready") {
      log(structuredLog("warn", "outbox.bot_username_unavailable", {
        notification_id: row.id,
        effect: "introduction sent without the one-tap add-to-group link",
      }));
    }
    const text = messageTextFor(row, { ...options, botUsername, groupBindingToken });
    if (!row.recipient || !text || (Array.isArray(text) && text.length === 0)) {
      await db.query(
        "UPDATE control_plane.notification_outbox SET state = 'skipped', updated_at = now() WHERE id = $1 AND state = 'pending'",
        [row.id],
      );
      continue;
    }
    try {
      // A list when the introduction hands over a group-binding token and/or a
      // password: each goes in its own message so it is one long-press and one
      // Copy, rather than a drag-select across a paragraph on a phone (a
      // `<code>` span in the introduction does not copy on tap on every client).
      // Order: introduction, binding line, password.
      //
      // Sent in order, and the row is only marked sent once ALL of them are.
      // A retry therefore repeats every part, the password message included —
      // which is the right trade: a duplicated paragraph is noise, while a
      // token or password that never arrived is an organizer who cannot set up
      // their group or log in at all.
      for (const part of Array.isArray(text) ? text : [{ text } as IntroMessage]) {
        await notification.sendMessage({
          chatId: row.recipient,
          text: part.text,
          ...(part.parseMode ? { parseMode: part.parseMode } : {}),
          ...(part.plainText !== undefined ? { plainText: part.plainText } : {}),
        });
      }
      await db.query(
        // The Mini App sign-in notice carries a raw Telegram id in `recipient`
        // (digests cannot be messaged); once sent, it does not stay at rest.
        `UPDATE control_plane.notification_outbox SET state = 'sent', sent_at = now(), updated_at = now(),
           recipient = CASE WHEN notification_type = '${SIGN_IN_NOTICE_TYPE}' THEN NULL ELSE recipient END
         WHERE id = $1`,
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
             recipient = CASE WHEN attempt + 1 >= max_attempts AND notification_type = '${SIGN_IN_NOTICE_TYPE}' THEN NULL ELSE recipient END,
             attempt = attempt + 1, updated_at = now()
         WHERE id = $1`,
        [row.id],
      );
    }
  }
  return dispatched;
}

/**
 * One row addressed to a trip's audience (target set). Returns whether a message was sent.
 *
 * Order matters: the audience is confirmed FIRST (the binding must still be open and on this row's own trip), and only
 * then is the text worded, so a group that left in between costs nothing and shows nothing. A row that cannot be
 * delivered by its nature ends `skipped` with the reason in a structured log (no chat id in it), exactly as an
 * unwordable type always has. A send that fails is retried like any other row, up to max_attempts.
 */
async function dispatchTargetedRow(
  db: pg.Pool,
  notification: NotificationAdapter,
  row: OutboxRow,
  log: (line: string) => void,
  options?: DispatchOptions,
): Promise<boolean> {
  const skip = async (reason: Parameters<typeof skippedLine>[2]) => {
    log(skippedLine(row.id, row.target, reason));
    await db.query(
      "UPDATE control_plane.notification_outbox SET state = 'skipped', updated_at = now() WHERE id = $1 AND state = 'pending'",
      [row.id],
    );
    return false;
  };
  const audience = await confirmAudience(db, row);
  if (!audience.ok) return skip(audience.reason);
  const text = messageTextFor(row, options);
  if (typeof text !== "string" || text.length === 0) return skip("no_text");
  try {
    // Plain text on purpose: the line carries a title a person typed, and no parse mode means it cannot be markup.
    await notification.sendMessage({ chatId: audience.chatId, text });
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
    return false;
  }
  await db.query(
    "UPDATE control_plane.notification_outbox SET state = 'sent', sent_at = now(), updated_at = now() WHERE id = $1",
    [row.id],
  );
  return true;
}
