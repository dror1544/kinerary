import type pg from "pg";
import { z } from "zod";
import { findSwitch } from "../../../shared/feature-switches.js";
import { structuredLog } from "./redaction.js";
import { runtimeUpstreamFor } from "./runtime-upstream.js";
import { enqueueTripMessage, resolveTripAudience } from "./trip-audience.js";
import { readCapped } from "./plan-change-poller.js";
import { GROUP_PHOTO_SWITCH, GROUP_PHOTO_TYPE, settleGroupPhoto, type GroupPhotoReporter } from "./group-photo.js";

/**
 * The trigger for "the bot sets the trip group's Telegram photo from the trip logo"
 * (docs/specs/sprint-9/x-trip-group-photo.md). Modelled on plan-change-poller.ts, and different where the job is.
 *
 * Once a minute, for each trip whose switch `trip_group_photo` is on and that has a ready route, it CLAIMS the trip's
 * newest pending request through the runtime gateway (`POST <runtimeOrigin>/internal/t/<trip id>/group-photo/claim`, with
 * the control-plane exchange key; the gateway reads the site with that trip's own key). A claim hands over the request and
 * the logo as a 640x640 PNG, and the site records that the request is out. Then:
 *
 *   - no open group binding -> the request is answered `no_group` at once (the candidate query here is NOT "trips with a
 *     group", as the plan-change line's is: such a trip is exactly the one that must be told it has no group);
 *   - otherwise ONE targeted outbox row per bound group (`target = trip_group`), carrying the bytes. The chat is never
 *     named here: the dispatcher re-reads the binding at send time (trip-audience.ts) and checks the bot's rights before it
 *     calls setChatPhoto. The dedupe key is the request's own identity, so claiming the same request again (the site puts a
 *     request back after ten minutes when its answer was lost) never sends it twice: the rows already hold their outcome and
 *     it is reported again from them.
 *
 * It sends nothing to Telegram itself and has no cursor table: the site's request row is the state. Nothing here loops: the
 * site hands a request out at most three times, and the outbox retries a send as it retries any other.
 *
 * It does not use the relay.
 */

export const GROUP_PHOTO_POLL_INTERVAL_MS = 60_000;
const SITE_TIMEOUT_MS = 10_000;
/** A 640x640 PNG is at most ~1.7 MB; as base64, ~2.3 MB. The gateway applies the same cap. */
export const MAX_CLAIM_BYTES = 3 * 1024 * 1024;
/** The base64 of 2 MB of PNG: far above any real 640x640 logo, and the payload's own bound. */
const MAX_PHOTO_BASE64 = 3 * 1024 * 1024;

export const claimSchema = z.union([
  z.object({ request: z.null() }),
  z.object({
    request: z.object({
      id: z.number().int().min(1),
      attempt: z.number().int().min(1).max(10),
      claim_token: z.string().regex(/^[0-9a-f]{24}$/),
      logo_hash: z.string().max(64),
      requested_at: z.string().refine((value) => !Number.isNaN(Date.parse(value)), "not a time"),
    }),
    photo: z.object({ content_type: z.literal("image/png"), base64: z.string().min(8).max(MAX_PHOTO_BASE64) }),
  }),
]);

export interface GroupPhotoPollerDeps {
  db: pg.Pool;
  /** The control-plane exchange key: sent to `runtimeOrigin` and to nothing else. */
  exchangeKey: string;
  runtimeOrigin: string;
  /** Only the readiness check: is there a ready route for this trip? The address it finds is never used. */
  upstreamHostSuffixes: readonly string[];
  upstreamAllowedHosts?: readonly string[];
  /** How the answer reaches the site (group-photo.ts createGroupPhotoReporter). */
  report: GroupPhotoReporter;
  fetchImpl?: typeof fetch;
  log?: (line: string) => void;
  /** Overrides the switch read (tests). Absent: control_plane.feature_enabled, anything but a literal true is off. */
  switchOn?: (tripId: string) => Promise<boolean>;
}

export interface GroupPhotoPollSummary {
  /** Trips whose switch was on and that have a ready route. */
  polled: number;
  /** Requests handed to the outbox. */
  enqueued: number;
  /** Requests answered here without a send (no group, an unreadable photo) or settled from rows that already had an outcome. */
  answered: number;
  failed: number;
}

type ClaimResult = { ok: true; body: z.infer<typeof claimSchema> } | { ok: false; code: string };

async function claim(deps: GroupPhotoPollerDeps, tripId: string): Promise<ClaimResult> {
  const fetchImpl = deps.fetchImpl ?? fetch;
  let response: Response;
  try {
    response = await fetchImpl(`${deps.runtimeOrigin.replace(/\/$/, "")}/internal/t/${encodeURIComponent(tripId)}/group-photo/claim`, {
      method: "POST",
      headers: { "x-api-key": deps.exchangeKey, "content-type": "application/json", accept: "application/json" },
      body: "{}",
      // The key rides this request: it is never forwarded to wherever a redirect points.
      redirect: "manual",
      signal: AbortSignal.timeout(SITE_TIMEOUT_MS),
    });
  } catch {
    return { ok: false, code: "SITE_UNREACHABLE" };
  }
  if (!response.ok) {
    await response.body?.cancel().catch(() => {});
    return { ok: false, code: `SITE_HTTP_${response.status}` };
  }
  const raw = await readCapped(response, MAX_CLAIM_BYTES);
  if (raw === "unreachable") return { ok: false, code: "SITE_UNREACHABLE" };
  if (raw === "too_large") return { ok: false, code: "SITE_BODY_INVALID" };
  let json: unknown;
  try { json = JSON.parse(raw); } catch { return { ok: false, code: "SITE_BODY_INVALID" }; }
  const parsed = claimSchema.safeParse(json);
  if (!parsed.success) return { ok: false, code: "SITE_BODY_INVALID" };
  return { ok: true, body: parsed.data };
}

async function readSwitch(deps: GroupPhotoPollerDeps, tripId: string, log: (line: string) => void): Promise<boolean> {
  try {
    if (deps.switchOn) return (await deps.switchOn(tripId)) === true;
    if (!findSwitch(GROUP_PHOTO_SWITCH)) return false;
    const result = await deps.db.query<{ enabled: unknown }>("SELECT control_plane.feature_enabled($1, $2) AS enabled", [tripId, GROUP_PHOTO_SWITCH]);
    return result.rows[0]?.enabled === true;
  } catch (error) {
    log(structuredLog("warn", "feature_switch.read_failed", { switch: GROUP_PHOTO_SWITCH, safe_error_code: error instanceof Error ? error.name : "UNKNOWN" }));
    return false; // uncertain is off
  }
}

/** The request's identity: the trip, its id on the site and the instant it was asked. A site rebuilt from nothing starts its ids again, and the instant keeps an old request's rows from being mistaken for a new one. */
export const requestKeyFor = (tripId: string, requestId: number, requestedAt: string) =>
  `group-photo:${tripId}:${requestId}:${Date.parse(requestedAt)}`;

/** Ends, without sending, every row of this site request that was queued under an older key and is still waiting. */
async function supersedeOlderRows(db: pg.Pool, tripId: string, requestId: number, newKey: string, log: (line: string) => void): Promise<void> {
  const ended = await db.query(
    `UPDATE control_plane.notification_outbox
     SET state = 'skipped', updated_at = now(),
         payload = (payload - 'photo_base64') || jsonb_build_object('superseded_by', $4::text)
     WHERE trip_id = $1 AND notification_type = $2 AND state = 'pending'
       AND payload->>'request_id' = $3::text AND payload->>'request_key' IS DISTINCT FROM $4`,
    [tripId, GROUP_PHOTO_TYPE, String(requestId), newKey],
  );
  if ((ended.rowCount ?? 0) > 0) log(structuredLog("info", "group_photo_poll.superseded", { trip_id: tripId, request_id: requestId, rows: ended.rowCount }));
}

async function pollTrip(deps: GroupPhotoPollerDeps, tripId: string, log: (line: string) => void): Promise<"enqueued" | "answered" | "none" | "failed"> {
  const fail = (code: string) => {
    log(structuredLog("warn", "group_photo_poll.failed", { trip_id: tripId, safe_error_code: code }));
    return "failed" as const;
  };
  const ready = await runtimeUpstreamFor(deps.db, tripId, deps.upstreamHostSuffixes, deps.upstreamAllowedHosts);
  if (!ready.ok) return fail(ready.error);

  const claimed = await claim(deps, tripId);
  if (!claimed.ok) return fail(claimed.code);
  if (claimed.body.request === null) return "none";
  const { request } = claimed.body;
  const photo = "photo" in claimed.body ? claimed.body.photo : null;
  if (!photo) return fail("SITE_BODY_INVALID");

  const answer = async (status: "no_group" | "failed", detail: string | null) => {
    try {
      await deps.report(tripId, { request_id: request.id, claim_token: request.claim_token, status, detail });
      log(structuredLog("info", "group_photo.reported", { trip_id: tripId, request_id: request.id, status }));
      return "answered" as const;
    } catch (error) {
      // The site puts the request back after ten minutes and it is claimed again, at most three times in all.
      return fail(error instanceof Error ? error.message : "REPORT_FAILED");
    }
  };

  // AC-3: no open group. Resolved here only to know there is none; with one, the dispatcher resolves it again.
  const audience = await resolveTripAudience(deps.db, tripId, "trip_group");
  if (audience.length === 0) return answer("no_group", null);

  const requestKey = requestKeyFor(tripId, request.id, request.requested_at);
  let written = 0;
  try {
    written = await enqueueTripMessage(deps.db, {
      tripId,
      type: GROUP_PHOTO_TYPE,
      target: "trip_group",
      dedupeKey: requestKey,
      payload: {
        request_id: request.id,
        request_key: requestKey,
        attempt: request.attempt,
        claim_token: request.claim_token,
        logo_hash: request.logo_hash,
        content_type: photo.content_type,
        photo_base64: photo.base64,
      },
    });
  } catch (error) {
    log(structuredLog("error", "group_photo_poll.enqueue_failed", { trip_id: tripId, safe_error_code: error instanceof Error ? error.name : "UNKNOWN" }));
    return "failed";
  }
  if (written > 0) {
    // A NEWER claim of the same site request (the organizer asked again, so its instant, and maybe its logo, changed) makes the
    // older rows of that request that have not been sent stale: they end superseded and are never sent, so the group is not
    // sent two photos for one request and the older one cannot land after the newer. A row already being sent cannot be taken
    // back (see dispatchGroupPhotoRow), and the site's token check keeps its answer from being taken for this claim.
    await supersedeOlderRows(deps.db, tripId, request.id, requestKey, log);
    log(structuredLog("info", "group_photo_poll.enqueued", { trip_id: tripId, request_id: request.id, groups: written }));
    return "enqueued";
  }
  // Nothing written: this request is already in the outbox (claimed again after a report that never arrived). Its rows hold
  // the outcome, so say it again, for THIS claim; a row still waiting to be sent is moved onto this claim's token, so it
  // reports for the claim the site now holds out.
  await deps.db.query(
    `UPDATE control_plane.notification_outbox SET payload = jsonb_set(payload, '{claim_token}', to_jsonb($4::text))
     WHERE trip_id = $1 AND notification_type = $2 AND state = 'pending' AND payload->>'request_key' = $3`,
    [tripId, GROUP_PHOTO_TYPE, requestKey, request.claim_token],
  );
  const settled = await settleGroupPhoto(deps.db, deps.report, tripId, requestKey, request.id, request.claim_token, log);
  return settled === "reported" ? "answered" : settled === "unreported" ? "failed" : "none";
}

/**
 * One tick over every trip that could have a request. Never throws: a failure is a log line and the trip is tried again
 * next tick.
 */
export async function pollGroupPhotosOnce(deps: GroupPhotoPollerDeps): Promise<GroupPhotoPollSummary> {
  const log = deps.log ?? (() => {});
  const summary: GroupPhotoPollSummary = { polled: 0, enqueued: 0, answered: 0, failed: 0 };
  const eligible: string[] = [];
  try {
    // Every trip with a ready route, NOT only trips with a group: a trip with no group must be told so (AC-3). Only a trip
    // whose switch is on is then asked anything.
    const candidates = await deps.db.query<{ trip_id: string }>(
      "SELECT trip_id FROM control_plane.runtime_routes WHERE state = 'ready' ORDER BY trip_id",
    );
    for (const { trip_id: tripId } of candidates.rows) {
      if (await readSwitch(deps, tripId, log)) eligible.push(tripId);
    }
  } catch (error) {
    log(structuredLog("error", "group_photo_poll.tick_failed", { safe_error_code: error instanceof Error ? error.name : "UNKNOWN" }));
    return summary;
  }
  for (const tripId of eligible) {
    summary.polled++;
    try {
      const outcome = await pollTrip(deps, tripId, log);
      if (outcome === "enqueued") summary.enqueued++;
      if (outcome === "answered") summary.answered++;
      if (outcome === "failed") summary.failed++;
    } catch (error) {
      summary.failed++;
      log(structuredLog("warn", "group_photo_poll.failed", { trip_id: tripId, safe_error_code: error instanceof Error ? error.name : "UNKNOWN" }));
    }
  }
  return summary;
}

/** Starts the loop beside the outbox dispatcher: one tick at a time, `unref`'d. Returns the function that stops it. */
export function startGroupPhotoPoller(deps: GroupPhotoPollerDeps, intervalMs = GROUP_PHOTO_POLL_INTERVAL_MS): () => void {
  let running = false;
  const timer = setInterval(() => {
    if (running) return;
    running = true;
    pollGroupPhotosOnce(deps)
      .catch(() => { /* pollGroupPhotosOnce never throws; this is the last line of defence for the loop */ })
      .finally(() => { running = false; });
  }, intervalMs);
  timer.unref();
  return () => clearInterval(timer);
}
