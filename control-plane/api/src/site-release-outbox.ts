/**
 * Durable releases of a trip-site binding (docs/specs/sprint-9/x-member-sign-in.md, amendment A21).
 *
 * When a person's way into a trip ends, the trip site must be told to release their binding: that is what ends the removed
 * person's assistant (MCP) grants, which talk straight to the site, and what stops an already-issued site token. It used to be
 * told once, after the COMMIT, best effort, and a lost call was never retried. Now:
 *
 *   1. THE RECORD is written by the database, in the transaction that ends the claim / revokes the redeemed invite
 *      (migration 20261122110000, two triggers: so a crash between COMMIT and the call loses nothing, and neither does a writer
 *      that is not the portal). This file never inserts for those; it finds the row by what it names.
 *   2. THE PROMPT ATTEMPT (`attemptSiteRelease`) runs right after the COMMIT, as the best-effort call always did. Success marks
 *      the record done; any failure leaves it pending and the request that triggered it still succeeds.
 *   3. THE BACKGROUND PASS (`runSiteReleasePass`, started beside the other loops in server.ts) retries what is due, with backoff,
 *      until the site confirms. Rows are claimed by one atomic statement (`FOR UPDATE SKIP LOCKED` inside an UPDATE that sets a
 *      lease), so two API instances never take the same row, and NO row lock and NO transaction is held across the HTTP call: a
 *      pass that dies mid-call leaves a lease that simply expires. It never runs inside a request.
 *
 * AT-LEAST-ONCE IS CORRECT. The site's release is idempotent (a repeat answers `released:false`) and matches account + name
 * (+ the invite id for an invite's binding), so a late or repeated release cannot remove another account's, or a newer invite's,
 * binding (server/control-plane-auth.js; held by tests/fixtures/site-binding-cases.json). The one thing it cannot tell is the
 * SAME account bound again to the same traveller with no invite: `releaseIsStale` asks the control plane first.
 *
 * WHAT ENDS A RECORD. The site answering 2xx with its own body (`{ok:true, released:true|false}`: "nothing to release" is
 * success) -> done. A 400/403/404, which can never succeed, three attempts in -> given up, ONE warn. The trip retired or gone ->
 * given up, quietly. The control plane holding that very binding again -> done, `superseded`. Everything else (a timeout, a
 * refused connection, a 5xx, a 401, a 429, a 200 that is not the site's answer) is transient and retried for as long as it takes:
 * the operator's query (`PENDING_OLDER_THAN_15_MINUTES_SQL`) is how anyone learns that "as long as it takes" is too long.
 * Records are purged by the pass: done after a day, given up after 30 days, pending never.
 *
 * LOGS carry the event, the reason code, and attempt counts. Never a user id, a username, an invite id, a trip id or a token.
 */
import type pg from "pg";
import { structuredLog } from "./redaction.js";
import { NOT_RETIRED_SQL } from "./trip-retirement.js";

/** Delay before retry n (after the n-th failed attempt); the last entry repeats. */
export const SITE_RELEASE_BACKOFF_MS: readonly number[] = [30_000, 120_000, 600_000, 1_800_000];
/** A refusal that can never succeed is given up on after this many attempts (the prompt one included). */
export const PERMANENT_REFUSAL_ATTEMPTS = 3;
/** A 4xx that can never succeed: malformed, a trip mismatch, a route an older site does not have. */
const PERMANENT_STATUSES: ReadonlySet<number> = new Set([400, 403, 404]);
/** How long a pass owns a row it has taken. The site call times out at 5 s; this only has to outlive a dead process's last call. */
const LEASE_MS = 120_000;
const PASS_BATCH = 20;
export const DONE_RETENTION = "1 day";
export const GIVEN_UP_RETENTION = "30 days";

/** For an operator or the fleet monitor: releases stuck for more than 15 minutes (the column is `n`). */
export const PENDING_OLDER_THAN_15_MINUTES_SQL =
  "SELECT count(*)::int AS n FROM control_plane.site_release_outbox WHERE state = 'pending' AND created_at < now() - interval '15 minutes'";

/** What the site answered when it did answer and the answer was not success; `status` null is "an answer that is not the site's". */
export class SiteReleaseError extends Error {
  constructor(readonly status: number | null) { super("RUNTIME_PARTICIPANT_RELEASE_FAILED"); this.name = "SiteReleaseError"; }
}

export interface SiteReleaseTarget { tripId: string; userId: string; runtimeUsername: string; inviteId?: string | undefined }
export interface SiteReleaser {
  releaseParticipant(input: SiteReleaseTarget & { reason?: string }): Promise<void>;
}
export interface SiteReleaseOptions {
  db: pg.Pool;
  releaser: SiteReleaser;
  log: (line: string) => void;
  /** The clock the pass believes: tests drive the schedule with it instead of sleeping. */
  now?: () => Date;
  backoffMs?: readonly number[];
  permanentAttempts?: number;
  leaseMs?: number;
}

interface Row {
  id: string; trip_id: string; user_id: string; runtime_username: string; invite_id: string | null; reason: string; attempts: number;
}
type Outcome = "released" | "pending" | "given_up" | "superseded" | "error";

const clock = (options: SiteReleaseOptions) => (options.now ?? (() => new Date()))();
const safeCode = (error: unknown) => (error as { code?: string } | null)?.code ?? (error instanceof Error ? error.name : "UNKNOWN");
const targetOf = (row: Row): SiteReleaseTarget & { reason: string } =>
  ({ tripId: row.trip_id, userId: row.user_id, runtimeUsername: row.runtime_username, ...(row.invite_id ? { inviteId: row.invite_id } : {}), reason: row.reason });

/**
 * The control plane holds this very binding again: a live claim of the SAME account on the SAME name. The site's claim release
 * (no invite id) matches account + name, so sending it now would remove the binding the control plane has just made. (Today a
 * claim mints a fresh account, so this cannot happen; it makes it safe if a path ever re-binds one. It also covers a claim whose
 * COMMIT's answer was lost but which did commit.) An invite's release names its invite id and needs no such check.
 */
async function releaseIsStale(db: pg.Pool, row: Row): Promise<boolean> {
  if (row.invite_id) return false;
  const live = await db.query(
    "SELECT 1 FROM control_plane.trip_participant_claims WHERE trip_id = $1 AND user_id = $2 AND runtime_username = $3 AND released_at IS NULL LIMIT 1",
    [row.trip_id, row.user_id, row.runtime_username]);
  return (live.rowCount ?? 0) > 0;
}

async function tripIsGone(db: pg.Pool, tripId: string): Promise<boolean> {
  const live = await db.query(`SELECT 1 FROM control_plane.trips t WHERE t.id = $1 AND ${NOT_RETIRED_SQL}`, [tripId]);
  return (live.rowCount ?? 0) === 0;
}

async function finish(options: SiteReleaseOptions, row: Row, state: "done" | "given_up", outcome: string): Promise<void> {
  await options.db.query(
    "UPDATE control_plane.site_release_outbox SET state = $2, outcome = $3, attempts = attempts + $4, claimed_until = NULL, completed_at = now(), updated_at = now() WHERE id = $1 AND state = 'pending'",
    [row.id, state, outcome, outcome === "superseded" || outcome === "trip_gone" ? 0 : 1]);
}

/** One attempt on a row this caller owns the lease of. Never throws for the site's sake; a database failure is the caller's to catch. */
async function settle(options: SiteReleaseOptions, row: Row): Promise<Outcome> {
  if (await tripIsGone(options.db, row.trip_id)) {
    await finish(options, row, "given_up", "trip_gone");
    options.log(structuredLog("info", "site_release.given_up", { reason: row.reason, why: "trip_gone", attempts: row.attempts }));
    return "given_up";
  }
  if (await releaseIsStale(options.db, row)) {
    await finish(options, row, "done", "superseded");
    options.log(structuredLog("info", "site_release.superseded", { reason: row.reason }));
    return "superseded";
  }
  try {
    await options.releaser.releaseParticipant(targetOf(row));
  } catch (error) {
    const attempts = row.attempts + 1;
    const status = error instanceof SiteReleaseError ? error.status : null;
    if (status !== null && PERMANENT_STATUSES.has(status) && attempts >= (options.permanentAttempts ?? PERMANENT_REFUSAL_ATTEMPTS)) {
      await finish(options, row, "given_up", `refused_${status}`);
      options.log(structuredLog("warn", "site_release.given_up", { reason: row.reason, why: `refused_${status}`, attempts }));
      return "given_up";
    }
    const schedule = options.backoffMs ?? SITE_RELEASE_BACKOFF_MS;
    const delay = schedule[Math.min(attempts - 1, schedule.length - 1)] ?? 1_800_000;
    await options.db.query(
      "UPDATE control_plane.site_release_outbox SET attempts = attempts + 1, next_attempt_at = $2, claimed_until = NULL, updated_at = now() WHERE id = $1 AND state = 'pending'",
      [row.id, new Date(clock(options).getTime() + delay)]);
    // ONE line when it goes pending (the first failed attempt); the retries that follow are silent until they land or are given up.
    if (attempts === 1) options.log(structuredLog("warn", "site_release.pending", { reason: row.reason, effect: "the trip site still holds the removed person's binding until a retry lands" }));
    return "pending";
  }
  await finish(options, row, "done", "released");
  if (row.attempts + 1 > 1) options.log(structuredLog("info", "site_release.landed", { reason: row.reason, attempts: row.attempts + 1 }));
  return "released";
}

/**
 * The prompt attempt, right after the transaction that ended the way in has COMMITTED. Finds the pending record the database
 * wrote for exactly this (trip, account, name, invite) and takes it under a lease; nothing pending means a pass already did it.
 * Never throws: a failure here costs the request nothing, the record stays pending and the pass retries it.
 */
export async function attemptSiteRelease(options: SiteReleaseOptions, target: SiteReleaseTarget): Promise<Outcome | "none"> {
  try {
    const now = clock(options);
    const taken = await options.db.query<Row>(
      `UPDATE control_plane.site_release_outbox SET claimed_until = $6, updated_at = now()
        WHERE id = (SELECT id FROM control_plane.site_release_outbox
                     WHERE trip_id = $1 AND user_id = $2 AND runtime_username = $3 AND COALESCE(invite_id, '') = $4 AND state = 'pending'
                       AND (claimed_until IS NULL OR claimed_until <= $5)
                     ORDER BY id LIMIT 1 FOR UPDATE SKIP LOCKED)
        RETURNING id::text, trip_id, user_id, runtime_username, invite_id, reason, attempts`,
      [target.tripId, target.userId, target.runtimeUsername, target.inviteId ?? "", now, new Date(now.getTime() + (options.leaseMs ?? LEASE_MS))]);
    const row = taken.rows[0];
    return row ? await settle(options, row) : "none";
  } catch (error) {
    options.log(structuredLog("error", "site_release.attempt_error", { safe_error_code: safeCode(error) }));
    return "error";
  }
}

/**
 * The compensating release of a claim whose COMMIT failed: the site was bound before the commit, and there is no committed
 * transaction for the database's trigger to ride on, so this writes its own record, then attempts. If even the record cannot be
 * written (the database is what failed), the site is still asked once, as it always was; never throws.
 */
export async function compensateSiteBinding(options: SiteReleaseOptions, target: SiteReleaseTarget): Promise<void> {
  try {
    await options.db.query(
      `INSERT INTO control_plane.site_release_outbox (trip_id, user_id, runtime_username, invite_id, reason)
       VALUES ($1, $2, $3, $4, 'claim_commit_failed')
       ON CONFLICT (trip_id, user_id, runtime_username, (COALESCE(invite_id, ''))) WHERE state = 'pending' DO NOTHING`,
      [target.tripId, target.userId, target.runtimeUsername, target.inviteId ?? null]);
  } catch (error) {
    options.log(structuredLog("error", "site_release.record_failed", { safe_error_code: safeCode(error) }));
    try { await options.releaser.releaseParticipant({ ...target, reason: "claim_commit_failed" }); } catch { /* the one attempt there ever was */ }
    return;
  }
  await attemptSiteRelease(options, target);
}

export interface PassResult { attempted: number; released: number; pending: number; givenUp: number; superseded: number }

/**
 * One background pass: purge, then take what is due (one atomic claiming statement, no lock held afterwards) and settle each row.
 * Safe to run from two API processes at once; a row is attempted by exactly one of them.
 */
export async function runSiteReleasePass(options: SiteReleaseOptions): Promise<PassResult> {
  const result: PassResult = { attempted: 0, released: 0, pending: 0, givenUp: 0, superseded: 0 };
  await options.db.query(
    `DELETE FROM control_plane.site_release_outbox
      WHERE (state = 'done' AND completed_at < now() - interval '${DONE_RETENTION}')
         OR (state = 'given_up' AND completed_at < now() - interval '${GIVEN_UP_RETENTION}')`);
  const now = clock(options);
  const taken = await options.db.query<Row>(
    `UPDATE control_plane.site_release_outbox o SET claimed_until = $2, updated_at = now()
      WHERE o.id IN (SELECT id FROM control_plane.site_release_outbox
                      WHERE state = 'pending' AND next_attempt_at <= $1 AND (claimed_until IS NULL OR claimed_until <= $1)
                      ORDER BY next_attempt_at, id LIMIT ${PASS_BATCH} FOR UPDATE SKIP LOCKED)
      RETURNING o.id::text, o.trip_id, o.user_id, o.runtime_username, o.invite_id, o.reason, o.attempts`,
    [now, new Date(now.getTime() + (options.leaseMs ?? LEASE_MS))]);
  for (const row of taken.rows) {
    result.attempted += 1;
    let outcome: Outcome;
    try { outcome = await settle(options, row); }
    catch (error) {
      // A database failure mid-row: the lease expires and the row is taken again.
      options.log(structuredLog("error", "site_release.attempt_error", { safe_error_code: safeCode(error) }));
      continue;
    }
    if (outcome === "released") result.released += 1;
    else if (outcome === "pending") result.pending += 1;
    else if (outcome === "given_up") result.givenUp += 1;
    else if (outcome === "superseded") result.superseded += 1;
  }
  return result;
}

/**
 * The loop. Started once per API process (server.ts), beside the notification dispatcher it is modelled on; the in-process
 * overlap guard is the dispatcher's, and `SKIP LOCKED` is what makes a second process safe, which the dispatcher's own loop is not.
 */
export function startSiteReleasePass(options: SiteReleaseOptions & { intervalMs?: number }): { stop(): void } {
  let running = false;
  options.log(structuredLog("info", "site_release.pass_started", { interval_ms: options.intervalMs ?? 30_000 }));
  const timer = setInterval(() => {
    if (running) return;
    running = true;
    runSiteReleasePass(options)
      .catch((error) => options.log(structuredLog("error", "site_release.pass_error", { safe_error_code: safeCode(error) })))
      .finally(() => { running = false; });
  }, options.intervalMs ?? 30_000);
  timer.unref();
  return { stop: () => clearInterval(timer) };
}
