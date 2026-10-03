// The super-admin dashboard's slice 2 (Sprint 6, decision 23 in
// docs/sprint6-tracks.md): suspend/retry, the only part of the dashboard that
// mutates state and so the only part that needs its own authorization story
// beyond the shared X-API-Key, per decision 23's own text ("the only part
// that needs boundary review and server-side authorization").
//
// Kept separate from admin-dashboard.ts rather than folded into it: that
// module's header says, correctly until this file existed, "this module
// never mutates state" — a true invariant worth a reader being able to trust
// without re-checking every function. Splitting the file keeps that
// sentence true for the half of the dashboard it was written about, instead
// of becoming stale prose the moment a mutation lands next to it. The two
// modules still share one gate (`adminAuth` in app.ts, the same
// CONTROL_PLANE_ADMIN_KEY) and one audit table — this file does not invent a
// second credential, because that would repeat the exact mistake
// `AdminDependencies`'s own module doc in app.ts argues against: two
// different kinds of power should not share a credential, but splitting one
// kind of power across two credentials for no reason just doubles the
// leak surface for no isolation benefit. What IS different per mutation is
// stated at each function below.
//
// RETRY reuses planner.ts's existing `retryProvision` (Sprint 4.7) outright —
// this file adds no retry logic of its own. Its "server-side authorization
// beyond the bare key" is the state machine `retryProvision` already
// enforces atomically under row locks (RETRYABLE_STATES, the live-lease
// check, the organizer-roster check): the admin key alone cannot force a
// retry on a trip in an unsuitable state, a trip with a job genuinely in
// flight, or an intake whose organizer no longer resolves to a roster
// traveller. An organizer can already trigger the same function for their
// OWN trip (POST /v1/trips/:id/plan/retry, app.ts) — the admin route's only
// added power is doing it for a trip the caller does not own, which is
// exactly what the admin key is for.
//
// SUSPEND/RESUME have no prior mechanism (see migration
// 20261003060350_trip_suspend.sql's header for what suspend deliberately is
// and is not — a pause on job claiming, not a lifecycle state, not a
// teardown, not a relay-side change). Suspend's "more than the bare key"
// requirement is a mandatory, audited `reason`: a shared secret proves WHO
// may suspend a trip, never WHY, and a dashboard control consequential
// enough to stop a trip's provisioning mid-flight should not be one click
// with no justification attached to the audit trail. Resume does not require
// a reason — it only reverses a suspend that was itself already justified,
// and demanding a second justification to undo a pause buys no new
// accountability.
//
// REDACTION: every mutation here writes its own row to `audit_events`, inside
// the SAME transaction as the mutation (unlike `recordAdminRead`'s
// best-effort, outside-the-transaction write for reads — a read has nothing
// to roll back if its audit write fails; a mutation this consequential
// should not exist without one). `suspendTrip`'s operator-authored `reason`
// is stored ONLY in `trips.suspended_reason` — never copied into
// `audit_events.evidence`. That is not an oversight: admin-dashboard.ts's own
// module doc states the EVIDENCE_ALLOWLIST invariant precisely ("every key
// [in it] is populated only by code in this repository from data that is
// itself format-constrained... never from traveler or organizer text") and
// extending that allow-list with a free-text key for THIS action would be the
// same "judged harmless for this one field" reasoning CLAUDE.md's security
// section was written against, even though the text here is operator- rather
// than traveler-authored. Keeping the boundary bright: evidence stays
// opaque-only; the reason lives in its own bounded, DB-CHECKed column.
import { randomBytes } from "node:crypto";
import type pg from "pg";
import { issueApproval } from "./plan-approval.js";
import { retryProvision, type RetryProvisionResult } from "./planner.js";

function generateId(prefix: string): string {
  return `${prefix}_${randomBytes(16).toString("hex")}`;
}

function newCorrelationId(): string {
  return `corr_${randomBytes(8).toString("hex")}`;
}

/**
 * Folds a free-text field to one line before it is ever written — the same
 * defensive move CLAUDE.md documents for `foldSql` on the companion
 * bug-report path (#issue, "Free text is folded to one line inside SQL"):
 * psql-style row delimiting is not the risk here (every write below is a
 * parameterized query, never string-interpolated SQL), but a reason
 * containing an embedded newline would still make a one-row-per-event audit
 * log or a CSV export read as more than one row, which is its own kind of
 * forgery primitive worth closing off at the write boundary rather than
 * trusting every future reader to fold it themselves.
 */
// #review 2026-10-03, finding 4: this used to fold only \r\n. U+2028 (LINE
// SEPARATOR) and U+2029 (PARAGRAPH SEPARATOR) are real line breaks to a
// terminal, a log viewer or a CSV reader -- Unicode's own Zl/Zp categories,
// not control characters -- just not matched by \r\n, which defeated the
// "always one line" guarantee this function's name promises. Folded, not
// rejected, the same treatment \r\n already got. U+0085 (NEL) is NOT folded
// here even though it also acts as a line break in some contexts: Unicode
// categorizes it Cc (a control character, same group as ESC/DEL), so it
// gets CONTROL_CHARS's reject treatment below instead of a fold.
function foldToOneLine(value: string): string {
  return value.replace(/[\r\n\u2028\u2029]+/g, " ");
}

const REASON_MIN = 1;
const REASON_MAX = 500;
// Rejects C0/C1 control characters (NUL, ESC, etc.) outright rather than
// trying to individually denylist the dangerous ones — the same "fails safe"
// posture `shared/needs-schema.js` and this file's own module doc describe.
// #review 2026-10-03, finding 4: the C1 half of that claim was never actually
// true -- the old \u000E-\u001F range stopped at C0 and never reached C1
// (\u0080-\u009F) at all, so every C1 control (confirmed live: U+0085 NEL,
// U+009B CSI) passed through unrejected. C0 and C1 are two separate ranges
// below on purpose, not merged into one \u000E-\u009F span -- a merged range
// would also swallow the entire printable ASCII block between them (found
// the hard way: "pausing to fix a transformer bug" started failing once C0
// and C1 were merged). Also widened to cover the Unicode
// bidirectional-override/isolate controls (U+202A-U+202E, U+2066-U+2069 --
// confirmed live: U+202E let a reason render right-to-left in a
// terminal/log viewer that honours it); U+2028/U+2029 are listed here too
// as defense in depth even though foldToOneLine already removes them first
// in the normal call order.
// eslint-disable-next-line no-control-regex
const CONTROL_CHARS = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F\u202A-\u202E\u2066-\u2069\u2028\u2029]/;

export type ValidateReasonResult =
  | { ok: true; reason: string }
  | { ok: false; error: "REASON_REQUIRED" | "REASON_TOO_LONG" | "REASON_INVALID" };

/**
 * Validates and normalizes a suspend reason before it ever reaches a query.
 * Exported so app.ts's route can return a 400 before calling the database at
 * all, rather than letting the DB's own CHECK constraint (defense in depth,
 * not the primary gate) be the first thing to say so.
 */
export function validateSuspendReason(raw: unknown): ValidateReasonResult {
  if (typeof raw !== "string") return { ok: false, error: "REASON_REQUIRED" };
  const folded = foldToOneLine(raw).trim();
  if (folded.length < REASON_MIN) return { ok: false, error: "REASON_REQUIRED" };
  if (folded.length > REASON_MAX) return { ok: false, error: "REASON_TOO_LONG" };
  if (CONTROL_CHARS.test(folded)) return { ok: false, error: "REASON_INVALID" };
  return { ok: true, reason: folded };
}

/**
 * Writes one audit row for an admin mutation. Unlike `recordAdminRead` this
 * takes the open transaction's client (not the pool) and is called BEFORE
 * COMMIT — a mutation and its audit record either both land or neither does.
 * `evidence` must already be allow-list-shaped by the caller; see
 * admin-dashboard.ts's `EVIDENCE_ALLOWLIST` for the per-action keys this
 * file's actions are allowed to carry.
 */
async function recordAdminMutation(
  client: pg.PoolClient,
  action: string,
  targetRef: string,
  evidence: Record<string, unknown>,
  correlationId: string,
): Promise<void> {
  await client.query(
    `INSERT INTO control_plane.audit_events
       (id, actor_ref, action, target_ref, correlation_id, evidence, occurred_at)
     VALUES ($1, 'admin:api-key', $2, $3, $4, $5::jsonb, now())`,
    [generateId("audit"), action, targetRef, correlationId, JSON.stringify(evidence)],
  );
}

// ── Retry ────────────────────────────────────────────────────────────────

/**
 * Re-runs provisioning for an arbitrary trip on the admin's behalf. A thin
 * wrapper over `retryProvision` (planner.ts) — see this module's header for
 * why that is the whole mechanism rather than a reimplementation — that adds
 * two things: issuing the approval `retryProvision` alone leaves pending, and
 * an audit row, best-effort, after both calls return.
 *
 * #review 2026-10-03 [P1]: `generatePlan` (inside `retryProvision`) always
 * leaves a fresh plan `pending_approval` and its job `waiting_for_user_action`
 * — correct for the organizer's OWN two-step route (POST .../plan/retry, then
 * a separate POST .../plans/:id/approve, so they can look at what changed
 * before committing to it), but this function used to return `ok: true` at
 * exactly that point and stop, with no approval control anywhere on the admin
 * dashboard to ever finish the job. Clicking Retry reported success and left
 * the trip stuck waiting on an approval nobody could give. An admin acting on
 * someone else's trip is not reviewing a diff the way an organizer is — it
 * approves immediately, so Retry is the one-shot action the dashboard already
 * presents it as. `issueApproval`'s only refusals (PLAN_NOT_FOUND,
 * ALREADY_APPROVED, PLAN_NOT_PENDING) cannot fire against a plan this
 * function just created fresh, so a refusal here throws rather than returning
 * a misleading success — a real bug surfacing loudly beats the trip sitting
 * stuck again with the dashboard none the wiser.
 *
 * Both calls are best-effort for the audit row (not inside `retryProvision`'s
 * own transactions) because `retryProvision` already spans two connections by
 * design (its own comment: a fresh connection for the `generatePlan` half)
 * and wrapping a cross-connection operation in a third transaction here would
 * not make it more atomic, only harder to read. A failure to write the audit
 * row must never be reported back as if the retry itself failed — the retry
 * already happened by the time this file can act on it.
 */
// Same shape as document-store.ts's TRIP_ID / chat-router.ts's inline copies
// of it (this codebase inlines this particular regex rather than sharing an
// import for it — matching that convention here rather than introducing a
// new shared module for one constant). #review 2026-10-03: a malformed `:id`
// reached retryTripViaAdmin's audit INSERT unchanged as target_ref — proven
// live with a URL-encoded string carrying a name, an email and a health
// condition. audit_events rejects UPDATE/DELETE/TRUNCATE, so that write is
// permanent. Checked BEFORE retryProvision runs (not after), and on a
// mismatch no audit row is written at all — a malformed id names no real
// trip, so there is nothing safe or meaningful to log about it, unlike a
// well-formed id that genuinely doesn't exist (retryProvision's own
// TRIP_NOT_FOUND, reached below, is already a safe opaque id and is audited
// normally).
const TRIP_ID_FORMAT = /^[a-z]{2,12}_[A-Za-z0-9]{8,64}$/;

export async function retryTripViaAdmin(
  db: pg.Pool,
  tripId: string,
  approvalTtlSeconds: number,
  operatorChatId: string | undefined,
  correlationId: string = newCorrelationId(),
): Promise<RetryProvisionResult> {
  if (!TRIP_ID_FORMAT.test(tripId)) {
    return { ok: false, reason: "TRIP_NOT_FOUND" };
  }
  const result = await retryProvision(db, tripId, correlationId);
  if (result.ok) {
    const approval = await issueApproval(db, result.planId, "admin:api-key", approvalTtlSeconds, { operatorChatId });
    if (!approval.ok) {
      throw new Error(`admin retry: issueApproval unexpectedly refused a fresh plan (${approval.reason})`);
    }
  }
  // #review 2026-10-03, finding N: a well-formed but nonexistent id (a real
  // trip was never found, as opposed to the shape check above) must not
  // reach this permanent audit INSERT with its raw text as target_ref either
  // -- proven live with a crafted alphanumeric string spelling out a name
  // and a health condition. Same reasoning as the shape check: a trip that
  // does not exist has nothing safe or meaningful to log about, whatever the
  // reason it does not exist. ALREADY_SUSPENDED/NOT_RETRYABLE-style refusals
  // below are unaffected -- those only fire for a trip that was actually
  // found, so tripId there is a real, safe opaque id.
  if (!result.ok && result.reason === "TRIP_NOT_FOUND") {
    return result;
  }
  try {
    const evidence = result.ok
      ? { ok: true, jobId: result.jobId, planId: result.planId, releaseId: result.releaseId, supersededPlanId: result.supersededPlanId }
      : { ok: false, reason: result.reason };
    await db.query(
      `INSERT INTO control_plane.audit_events
         (id, actor_ref, action, target_ref, correlation_id, evidence, occurred_at)
       VALUES ($1, 'admin:api-key', 'admin.retry_trip', $2, $3, $4::jsonb, now())`,
      [generateId("audit"), tripId, correlationId, JSON.stringify(evidence)],
    );
  } catch {
    // Best-effort, same posture as recordAdminRead: never let a logging
    // failure overwrite the real result of the retry attempt above.
  }
  return result;
}

// ── Suspend / resume ─────────────────────────────────────────────────────

export type SuspendTripResult =
  | { ok: true; tripId: string; suspendedAt: string }
  | { ok: false; reason: "TRIP_NOT_FOUND" | "ALREADY_SUSPENDED" };

/**
 * Pauses job claiming for a trip (see migration 20261003060350's header for
 * exactly what that does and does not mean). Atomic with its own audit row —
 * see this module's header on why mutations differ from reads here.
 */
export async function suspendTrip(
  db: pg.Pool,
  tripId: string,
  reason: string,
): Promise<SuspendTripResult> {
  // #review 2026-10-03, finding 3's same risk applies here too: a malformed
  // id must never reach the audit INSERT below (finding 5 adds refusal
  // auditing, which would otherwise repeat finding 3's mistake for THIS
  // function specifically). Checked before the transaction opens at all.
  if (!TRIP_ID_FORMAT.test(tripId)) {
    return { ok: false, reason: "TRIP_NOT_FOUND" };
  }
  const correlationId = newCorrelationId();
  const client = await db.connect();
  try {
    await client.query("BEGIN");
    const row = await client.query<{ suspended_at: Date | null }>(
      "SELECT suspended_at FROM control_plane.trips WHERE id = $1 FOR UPDATE",
      [tripId],
    );
    const trip = row.rows[0];
    if (!trip) {
      // #review 2026-10-03, finding N (the same raw-id-in-audit risk as
      // retryTripViaAdmin's TRIP_NOT_FOUND branch, confirmed live for retry
      // and equally true here): a well-formed but nonexistent id is still
      // just caller-chosen text, not a verified safe opaque id, so it is not
      // written to this permanent audit row either — unlike finding 5's
      // ALREADY_SUSPENDED branch below, which only fires for a trip that was
      // actually found and so is safe to log normally.
      await client.query("ROLLBACK");
      return { ok: false, reason: "TRIP_NOT_FOUND" };
    }
    if (trip.suspended_at !== null) {
      await recordAdminMutation(client, "admin.suspend_trip", tripId, { ok: false, reason: "ALREADY_SUSPENDED" }, correlationId);
      await client.query("COMMIT");
      return { ok: false, reason: "ALREADY_SUSPENDED" };
    }

    const updated = await client.query<{ suspended_at: Date }>(
      `UPDATE control_plane.trips
       SET suspended_at = now(), suspended_reason = $2, updated_at = now()
       WHERE id = $1
       RETURNING suspended_at`,
      [tripId, reason],
    );
    const suspendedAt = updated.rows[0]!.suspended_at;

    // Evidence carries no copy of `reason` — see this module's header.
    await recordAdminMutation(client, "admin.suspend_trip", tripId, { ok: true }, correlationId);

    await client.query("COMMIT");
    return { ok: true, tripId, suspendedAt: suspendedAt.toISOString() };
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }
}

export type ResumeTripResult =
  | { ok: true; tripId: string }
  | { ok: false; reason: "TRIP_NOT_FOUND" | "NOT_SUSPENDED" };

/** Reverses `suspendTrip`. Atomic with its own audit row, same as suspend. */
export async function resumeTrip(db: pg.Pool, tripId: string): Promise<ResumeTripResult> {
  // Same reasoning as suspendTrip's own check — see its comment.
  if (!TRIP_ID_FORMAT.test(tripId)) {
    return { ok: false, reason: "TRIP_NOT_FOUND" };
  }
  const correlationId = newCorrelationId();
  const client = await db.connect();
  try {
    await client.query("BEGIN");
    const row = await client.query<{ suspended_at: Date | null }>(
      "SELECT suspended_at FROM control_plane.trips WHERE id = $1 FOR UPDATE",
      [tripId],
    );
    const trip = row.rows[0];
    if (!trip) {
      // Same reasoning as suspendTrip's own TRIP_NOT_FOUND branch — see its
      // comment.
      await client.query("ROLLBACK");
      return { ok: false, reason: "TRIP_NOT_FOUND" };
    }
    if (trip.suspended_at === null) {
      await recordAdminMutation(client, "admin.resume_trip", tripId, { ok: false, reason: "NOT_SUSPENDED" }, correlationId);
      await client.query("COMMIT");
      return { ok: false, reason: "NOT_SUSPENDED" };
    }

    // #review 2026-10-03 [P2]: suspended_reason is deliberately NOT cleared
    // here — see migration 20261003060350's updated header. Nulling it
    // alongside suspended_at used to erase the only durable record of why
    // the trip had been paused; it now simply carries the last reason until
    // the next suspend overwrites it, which no reader treats as "currently
    // suspended" (that's suspended_at alone, cleared below).
    await client.query(
      `UPDATE control_plane.trips
       SET suspended_at = NULL, updated_at = now()
       WHERE id = $1`,
      [tripId],
    );

    await recordAdminMutation(client, "admin.resume_trip", tripId, { ok: true }, correlationId);

    await client.query("COMMIT");
    return { ok: true, tripId };
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }
}
