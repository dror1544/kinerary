import type pg from "pg";
import { z } from "zod";
import { findSwitch } from "../../../shared/feature-switches.js";
import { structuredLog } from "./redaction.js";
import { runtimeUpstreamFor } from "./runtime-upstream.js";
import { enqueueTripMessage } from "./trip-audience.js";
import { dayInZone, minutesInZone } from "./plan-change-line.js";

/**
 * The group line's trigger (video Release 1C, docs/specs/sprint-9/x-video-r1-group-line.md, "G2").
 *
 * Once a minute the control plane asks each switched-on trip's own site "what changed since the plan the group
 * last heard about?" through one read-only `internal()` route, waits until the plan has settled, and enqueues
 * ONE message for the trip's group. The site never calls out and holds no key for this: the control plane already
 * holds the exchange key the site checks, and already knows each trip's private address (runtime-upstream.ts).
 *
 * THE GATE. A line is sent for a trip only when ALL of these hold, and anything uncertain counts as off:
 *   1. the switch `plan_change_group_line` is on for the trip (feature-switches.ts: unknown, failed read = off);
 *   2. the trip's own setting `group_change_line` is on (the site answers it);
 *   3. the trip has an open group binding (the candidate query, and again when the row is written);
 *   4. the site answered the poll with a body that fits the schema.
 * A trip that fails 1 or 3 has its cursor DELETED: when it passes again it is "seen for the first time" and starts
 * from the plan as it is then, never from a stale one (a switch turned on never replays a trip's history).
 *
 * WHAT THE POLLER KEEPS: one cursor row per trip (the revision id the group last heard about, when an unsent change
 * was first seen, whether it is held for the night). No plan text is ever stored: the site is the source.
 *
 * It does not use the relay. It sends nothing itself: it only enqueues, and the outbox dispatcher resolves and
 * re-checks the chat at the moment of sending (trip-audience.ts).
 */

export const PLAN_CHANGE_SWITCH = "plan_change_group_line";
export const PLAN_CHANGED_TYPE = "trip_plan_changed";
/** The plan must have been quiet this long before a line goes out... */
export const QUIET_MS = 5 * 60_000;
/** ...unless the oldest unsent change is this old, which sends anyway. */
export const MAX_WAIT_MS = 15 * 60_000;
/** Nothing is sent from 22:00 to 08:00 trip time. One constant for every trip (Dror, 2026-11-16). */
export const NIGHT_START_MINUTES = 22 * 60;
export const NIGHT_END_MINUTES = 8 * 60;
export const POLL_INTERVAL_MS = 60_000;
const SITE_TIMEOUT_MS = 5_000;
const MAX_BODY_BYTES = 512 * 1024;
const ROUTE = "/api/internal/control-plane/plan-changes";

const text = (max: number) => z.string().max(max);
const day = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);

/**
 * The limits the site's route (server/living-journey.js: MAX_TEXT, MAX_CHANGES) answers inside. They live in two
 * places on purpose, and a contract test (plan-changes-contract.test.ts, over a fixture generated from the real route)
 * fails if the route stops fitting them.
 */
export const MAX_TEXT = 400;
export const MAX_CHANGES = 200;
/** A site with no cap of its own is still read, up to this many entries; the rest are counted, not parsed. */
const MAX_ENTRIES_READ = 1000;

export const changeSchema = z.object({
  kind: z.enum(["updated", "added", "removed"]),
  fields: z.array(text(20)).max(10).default([]),
  date: day.nullish(),
  time: text(20).nullish(),
  previous_date: day.nullish(),
  previous_time: text(20).nullish(),
  text_he: text(MAX_TEXT).nullish(),
  text_en: text(MAX_TEXT).nullish(),
  previous_text_he: text(MAX_TEXT).nullish(),
  previous_text_en: text(MAX_TEXT).nullish(),
});
export type PlanChangeEntry = z.infer<typeof changeSchema>;

const envelope = {
  active_revision_id: z.string().regex(/^[A-Za-z0-9_-]{1,100}$/),
  active_created_at: z.string().refine((value) => !Number.isNaN(Date.parse(value)), "not a time"),
  since_known: z.boolean(),
  group_change_line: z.boolean(),
  time_zone: text(64),
  language: z.enum(["he", "en"]),
  today: day,
  now_local: z.string().regex(/^\d{2}:\d{2}$/),
  /** How many changes the site left out of `changes` (its own cap). Absent from an older site: none. */
  changes_omitted: z.number().int().min(0).default(0),
};

/**
 * The site's answer, STRICT: every entry must fit. This is the contract the site's route is held to. Keys the site
 * adds later are dropped here, never forwarded.
 */
export const planChangesSchema = z.object({ ...envelope, changes: z.array(changeSchema).max(MAX_CHANGES) });
export type PlanChangesResponse = z.infer<typeof planChangesSchema>;

/**
 * The same answer as the poller READS it: the envelope must fit (a body that is not a plan answer at all is refused),
 * but an entry that does not fit is dropped on its own (see keepValidEntries), because refusing the whole body for one
 * long title would leave a trip without its line, with nothing to say why, until the plan changed again.
 */
const planChangesEnvelopeSchema = z.object({ ...envelope, changes: z.array(z.unknown()).max(MAX_ENTRIES_READ) });

/** Keeps the entries that fit the contract, up to MAX_CHANGES; counts the invalid and the surplus. */
export function keepValidEntries(entries: readonly unknown[]): { kept: PlanChangeEntry[]; invalid: number; surplus: number } {
  const kept: PlanChangeEntry[] = [];
  let invalid = 0;
  let surplus = 0;
  for (const entry of entries) {
    const parsed = changeSchema.safeParse(entry);
    if (!parsed.success) { invalid++; continue; }
    if (kept.length >= MAX_CHANGES) { surplus++; continue; }
    kept.push(parsed.data);
  }
  return { kept, invalid, surplus };
}

export interface PlanChangePollerDeps {
  db: pg.Pool;
  /** The key the trip sites check on their `internal()` routes (the portal's runtime exchange key). */
  exchangeKey: string;
  /** The hosts a site may live on: the same allow-list the runtime gateway's route lookup applies. */
  upstreamHostSuffixes: readonly string[];
  fetchImpl?: typeof fetch;
  now?: () => Date;
  log?: (line: string) => void;
  /** Overrides the switch read (tests). Absent: feature-switches.ts, which fails to off. */
  switchOn?: (tripId: string) => Promise<boolean>;
}

export interface PollSummary {
  /** Trips whose switch was on and that have an open group. */
  polled: number;
  enqueued: number;
  failed: number;
}

interface Cursor {
  revision_id: string;
  pending_since: Date | null;
  held_for_night: boolean;
}

const isNight = (minutes: number) => minutes >= NIGHT_START_MINUTES || minutes < NIGHT_END_MINUTES;
const minutesOf = (hhmm: string) => Number(hhmm.slice(0, 2)) * 60 + Number(hhmm.slice(3));

type SiteResult = { ok: true; body: PlanChangesResponse; invalid: number; surplus: number } | { ok: false; code: string };

async function readSite(
  deps: PlanChangePollerDeps,
  origin: string,
  basePath: string,
  tripId: string,
  since: string | null,
): Promise<SiteResult> {
  const fetchImpl = deps.fetchImpl ?? fetch;
  const url = `${origin}${basePath}${ROUTE}${since ? `?since=${encodeURIComponent(since)}` : ""}`;
  let response: Response;
  try {
    response = await fetchImpl(url, {
      method: "GET",
      headers: { "x-api-key": deps.exchangeKey, "x-control-plane-trip-id": tripId, accept: "application/json" },
      // The key rides this request: it is never forwarded to wherever a redirect points.
      redirect: "manual",
      signal: AbortSignal.timeout(SITE_TIMEOUT_MS),
    });
  } catch {
    return { ok: false, code: "SITE_UNREACHABLE" };
  }
  if (!response.ok) return { ok: false, code: `SITE_HTTP_${response.status}` };
  let raw: string;
  try { raw = await response.text(); } catch { return { ok: false, code: "SITE_UNREACHABLE" }; }
  if (raw.length > MAX_BODY_BYTES) return { ok: false, code: "SITE_BODY_INVALID" };
  let json: unknown;
  try { json = JSON.parse(raw); } catch { return { ok: false, code: "SITE_BODY_INVALID" }; }
  const parsed = planChangesEnvelopeSchema.safeParse(json);
  if (!parsed.success) return { ok: false, code: "SITE_BODY_INVALID" };
  // One entry that does not fit is dropped on its own; the rest of the body is still the plan's news.
  const { kept, invalid, surplus } = keepValidEntries(parsed.data.changes);
  return { ok: true, body: { ...parsed.data, changes: kept }, invalid, surplus };
}

/** One trip, one tick. Everything here is a read, a cursor write, or one transactional enqueue. */
async function pollTrip(deps: PlanChangePollerDeps, tripId: string, now: Date, log: (line: string) => void): Promise<"enqueued" | "ok" | "failed"> {
  const { db } = deps;
  const fail = (code: string) => {
    log(structuredLog("warn", "plan_change_poll.failed", { trip_id: tripId, safe_error_code: code }));
    return "failed" as const;
  };

  const upstream = await runtimeUpstreamFor(db, tripId, deps.upstreamHostSuffixes);
  if (!upstream.ok) return fail(upstream.error);

  const cursorRow = await db.query<Cursor>(
    "SELECT revision_id, pending_since, held_for_night FROM control_plane.plan_change_cursors WHERE trip_id = $1",
    [tripId],
  );
  const cursor = cursorRow.rows[0] ?? null;

  const site = await readSite(deps, upstream.upstreamOrigin, upstream.upstreamBasePath, tripId, cursor?.revision_id ?? null);
  if (!site.ok) return fail(site.code); // the cursor does not move: the next good poll sends the net difference
  const plan = site.body;
  // An entry that did not fit the contract, or arrived past the cap, was left out and the trip carries on: say so once,
  // with the trip and a code, so a site writing out-of-contract entries is found instead of quietly losing lines.
  if (site.invalid > 0 || site.surplus > 0) {
    log(structuredLog("warn", "plan_change_poll.entries_dropped", {
      trip_id: tripId,
      safe_error_code: site.invalid > 0 ? "ENTRY_INVALID" : "ENTRIES_OVER_LIMIT",
      invalid: site.invalid,
      surplus: site.surplus,
    }));
  }

  const moveCursor = (client: Pick<pg.Pool, "query">, sent: boolean) => client.query(
    `INSERT INTO control_plane.plan_change_cursors (trip_id, revision_id, pending_since, held_for_night, last_polled_at, last_sent_at, updated_at)
     VALUES ($1, $2, NULL, false, $3::timestamptz, CASE WHEN $4::boolean THEN $3::timestamptz ELSE NULL END, $3::timestamptz)
     ON CONFLICT (trip_id) DO UPDATE
       SET revision_id = EXCLUDED.revision_id, pending_since = NULL, held_for_night = false,
           last_polled_at = EXCLUDED.last_polled_at,
           last_sent_at = CASE WHEN $4::boolean THEN EXCLUDED.last_polled_at ELSE control_plane.plan_change_cursors.last_sent_at END,
           updated_at = EXCLUDED.updated_at`,
    [tripId, plan.active_revision_id, now.toISOString(), sent],
  );

  // 1. First sight of this trip: the plan as it is now is the plan the group has. Nothing is replayed (AC-17).
  if (!cursor) { await moveCursor(db, false); return "ok"; }

  // 2. Nothing changed since the group last heard.
  if (plan.active_revision_id === cursor.revision_id) {
    await db.query(
      "UPDATE control_plane.plan_change_cursors SET pending_since = NULL, held_for_night = false, last_polled_at = $2::timestamptz, updated_at = $2::timestamptz WHERE trip_id = $1",
      [tripId, now.toISOString()],
    );
    return "ok";
  }

  // 3. The organizer turned the line off: follow the plan without saying anything, so turning it back on starts
  //    from the plan as it is then, not from a backlog (AC-10).
  if (!plan.group_change_line) { await moveCursor(db, false); return "ok"; }

  // 4. A cursor the site no longer has in its plan's history (a restore-original, say): there is no honest
  //    difference to describe, so say nothing and start again from here.
  if (!plan.since_known) {
    log(structuredLog("info", "plan_change_poll.cursor_reset", { trip_id: tripId }));
    await moveCursor(db, false);
    return "ok";
  }

  // 5. Net no change (changed and changed back, or only days already over): nothing to say; the cursor advances (AC-13).
  if (plan.changes.length === 0) { await moveCursor(db, false); return "ok"; }

  // 6. Wait for the plan to settle: quiet for 5 minutes, or the oldest unsent change is 15 minutes old.
  const pendingSince = cursor.pending_since ?? now;
  const newestAge = now.getTime() - Date.parse(plan.active_created_at);
  const pendingAge = now.getTime() - pendingSince.getTime();
  const settled = newestAge >= QUIET_MS || pendingAge >= MAX_WAIT_MS;
  const localMinutes = minutesInZone(now, plan.time_zone);
  const night = isNight(localMinutes);
  if (!settled || night) {
    await db.query(
      "UPDATE control_plane.plan_change_cursors SET pending_since = COALESCE(pending_since, $2::timestamptz), held_for_night = $3, last_polled_at = $2::timestamptz, updated_at = $2::timestamptz WHERE trip_id = $1",
      [tripId, now.toISOString(), settled && night],
    );
    return "ok";
  }

  // 7. Send. Anything whose time has already passed is not news (checked on THIS clock, in the trip's zone, because a
  //    change held overnight is judged at 08:00, not when it was made).
  const today = dayInZone(now, plan.time_zone);
  const kept = plan.changes.filter((change) => {
    if (!change.date || change.date < today) return false;
    if (change.date === today && change.time && /^\d{2}:\d{2}$/.test(change.time) && minutesOf(change.time) < localMinutes) return false;
    return true;
  });

  const client = await db.connect();
  try {
    await client.query("BEGIN");
    let written = 0;
    if (kept.length > 0) {
      written = await enqueueTripMessage(client, {
        tripId,
        type: PLAN_CHANGED_TYPE,
        target: "trip_group",
        dedupeKey: `plan-change:${tripId}:${plan.active_revision_id}`,
        payload: {
          language: plan.language,
          time_zone: plan.time_zone,
          as_of: now.toISOString(),
          changes: kept.map((change) => ({
            kind: change.kind,
            fields: change.fields,
            date: change.date ?? null,
            time: change.time ?? null,
            previous_date: change.previous_date ?? null,
            previous_time: change.previous_time ?? null,
            text_he: change.text_he ?? null,
            text_en: change.text_en ?? null,
          })),
        },
      });
    }
    await moveCursor(client, written > 0);
    await client.query("COMMIT");
    if (written > 0) log(structuredLog("info", "plan_change_poll.enqueued", { trip_id: tripId, groups: written, changes: kept.length }));
    return written > 0 ? "enqueued" : "ok";
  } catch (error) {
    await client.query("ROLLBACK").catch(() => {});
    log(structuredLog("error", "plan_change_poll.enqueue_failed", { trip_id: tripId, safe_error_code: error instanceof Error ? error.name : "UNKNOWN" }));
    return "failed";
  } finally {
    client.release();
  }
}

/**
 * Is the switch on for this trip, as a THREE-way answer: "on" (the literal true), "off" (read, and not true) and
 * "unknown" (the read failed, or the injected answer is not a boolean). feature-switches.ts's featureEnabled folds a
 * failed read into false, which is right for a gate ("uncertain is off") and wrong for cleanup ("off" deletes a cursor).
 * The registry is checked first, as there: a name that is not registered is off.
 */
async function readSwitch(deps: PlanChangePollerDeps, tripId: string, log: (line: string) => void): Promise<"on" | "off" | "unknown"> {
  try {
    if (deps.switchOn) {
      const answer = await deps.switchOn(tripId);
      return answer === true ? "on" : answer === false ? "off" : "unknown";
    }
    if (!findSwitch(PLAN_CHANGE_SWITCH)) return "off";
    const result = await deps.db.query<{ enabled: unknown }>("SELECT control_plane.feature_enabled($1, $2) AS enabled", [tripId, PLAN_CHANGE_SWITCH]);
    const enabled = result.rows[0]?.enabled;
    return enabled === true ? "on" : enabled === false ? "off" : "unknown";
  } catch (error) {
    // The code names the failure and nothing else: not the trip, and not the driver's message (it can quote a connection string).
    log(structuredLog("warn", "feature_switch.read_failed", { switch: PLAN_CHANGE_SWITCH, safe_error_code: error instanceof Error ? error.name : "UNKNOWN" }));
    return "unknown";
  }
}

/**
 * One tick over every trip that could have a line. Never throws: a failure is a log line and the trip is tried again
 * next tick, so one trip's trouble never stops another's line.
 */
export async function pollPlanChangesOnce(deps: PlanChangePollerDeps): Promise<PollSummary> {
  const log = deps.log ?? (() => {});
  const now = (deps.now ?? (() => new Date()))();
  const summary: PollSummary = { polled: 0, enqueued: 0, failed: 0 };
  const eligible: string[] = [];
  try {
    // Telegram groups only: `^-[0-9]{1,20}$` does not match a WhatsApp group's alias (`wa_<hex>@g`), so a trip whose only group
    // is a WhatsApp one has nothing to post to and is not polled (spec 625; pinned by whatsapp-exclusions.test.ts).
    const candidates = await deps.db.query<{ trip_id: string }>(
      `SELECT DISTINCT trip_id FROM control_plane.telegram_chat_bindings
       WHERE closed_at IS NULL AND chat_id ~ '^-[0-9]{1,20}$'
       ORDER BY trip_id`,
    );
    let everyReadSucceeded = true;
    for (const { trip_id: tripId } of candidates.rows) {
      const state = await readSwitch(deps, tripId, log);
      if (state === "on") eligible.push(tripId);
      else if (state === "unknown") everyReadSucceeded = false; // not on, and NOT known to be off
    }
    // A trip that is off, or has no group, has no cursor, so when it comes back it starts from then. Only a tick in
    // which EVERY read succeeded may say so: a switch read that failed looks like "off" to the line above, and
    // cleaning up on it would delete every cursor in the fleet and lose each trip's pending change.
    if (everyReadSucceeded) {
      await deps.db.query("DELETE FROM control_plane.plan_change_cursors WHERE trip_id <> ALL($1::text[])", [eligible]);
    } else {
      log(structuredLog("warn", "plan_change_poll.cleanup_skipped", { safe_error_code: "SWITCH_READ_FAILED" }));
    }
  } catch (error) {
    log(structuredLog("error", "plan_change_poll.tick_failed", { safe_error_code: error instanceof Error ? error.name : "UNKNOWN" }));
    return summary;
  }
  for (const tripId of eligible) {
    summary.polled++;
    try {
      const outcome = await pollTrip(deps, tripId, now, log);
      if (outcome === "enqueued") summary.enqueued++;
      if (outcome === "failed") summary.failed++;
    } catch (error) {
      summary.failed++;
      log(structuredLog("warn", "plan_change_poll.failed", { trip_id: tripId, safe_error_code: error instanceof Error ? error.name : "UNKNOWN" }));
    }
  }
  return summary;
}

/**
 * Starts the loop beside the outbox dispatcher: every minute, one tick at a time (a slow site cannot stack ticks),
 * `unref`'d so it never keeps the process alive. Returns the function that stops it.
 */
export function startPlanChangePoller(deps: PlanChangePollerDeps, intervalMs = POLL_INTERVAL_MS): () => void {
  let running = false;
  const timer = setInterval(() => {
    if (running) return;
    running = true;
    pollPlanChangesOnce(deps)
      .catch(() => { /* pollPlanChangesOnce never throws; this is the last line of defence for the loop */ })
      .finally(() => { running = false; });
  }, intervalMs);
  timer.unref();
  return () => clearInterval(timer);
}
