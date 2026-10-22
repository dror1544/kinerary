import { createHash, randomBytes } from "node:crypto";
import type pg from "pg";
import { structuredLog } from "./redaction.js";

// hex gives 32 lowercase alphanumeric chars, satisfying id pattern
function generateId(prefix: string): string {
  return `${prefix}_${randomBytes(16).toString("hex")}`;
}

function sha256hex(input: string): string {
  return createHash("sha256").update(input).digest("hex");
}

function tokenDigest(token: string): string {
  return `sha256:${sha256hex(token)}`;
}

export interface EnrollmentConfig {
  /** Seconds until an issued enrollment link expires. */
  enrollmentTtlSeconds: number;
}

export type EnrollmentIssueResult =
  | { ok: true; enrollmentId: string; token: string; expiresAt: Date }
  | { ok: false; reason: "TRIP_NOT_DRAFT" | "NOT_OWNER" | "ACTIVE_ENROLLMENT_EXISTS" };

export type EnrollmentVerifyResult =
  | { ok: true; enrollmentId: string; tripId: string; userId: string }
  | { ok: false; reason: "NOT_FOUND" | "WRONG_USER" | "WRONG_TRIP" | "EXPIRED" | "ALREADY_CONSUMED" | "REVOKED" };

/**
 * Issues a single-use, expiring enrollment link for the trip's owner to hand
 * to the Hermes interviewer. Verifies the trip is in 'draft' and the
 * requesting user holds an active owner membership.
 *
 * At most one active ('issued') enrollment per trip is allowed — re-requesting
 * while one is still live returns an error rather than silently creating a
 * second link that could confuse an ongoing interview.
 */
export async function issueEnrollment(
  db: pg.Pool,
  userId: string,
  tripId: string,
  config: EnrollmentConfig,
  log: (line: string) => void = () => {},
): Promise<EnrollmentIssueResult> {
  const client = await db.connect();
  try {
    await client.query("BEGIN");

    // Verify the trip exists in 'draft' and the user is an active owner.
    const tripRow = await client.query<{ lifecycle_state: string }>(
      `SELECT t.lifecycle_state
       FROM control_plane.trips t
       JOIN control_plane.trip_memberships m ON m.trip_id = t.id
       WHERE t.id = $1 AND m.user_id = $2 AND m.role = 'owner' AND m.status = 'active'`,
      [tripId, userId],
    );
    const [trip] = tripRow.rows;
    if (!trip) {
      await client.query("ROLLBACK");
      return { ok: false, reason: "NOT_OWNER" };
    }
    if (trip.lifecycle_state !== "draft") {
      await client.query("ROLLBACK");
      return { ok: false, reason: "TRIP_NOT_DRAFT" };
    }

    // Expire any issued enrollments for this trip that are past their deadline.
    // Without this step, a single expired enrollment would block re-issue forever
    // because the partial unique index (0009) prevents two 'issued' rows per trip.
    await client.query(
      "UPDATE control_plane.interview_enrollments SET state = 'expired' WHERE trip_id = $1 AND state = 'issued' AND expires_at < now()",
      [tripId],
    );

    // Generate token before the INSERT so that a unique-violation rollback does
    // not cause us to waste a DB round-trip generating a token we can't use.
    const rawToken = randomBytes(32).toString("base64url");
    const digest = tokenDigest(rawToken);
    const expiresAt = new Date(Date.now() + config.enrollmentTtlSeconds * 1000);
    const enrollmentId = generateId("enrl");

    try {
      await client.query(
        `INSERT INTO control_plane.interview_enrollments(id, trip_id, user_id, token_digest, state, expires_at)
         VALUES ($1, $2, $3, $4, 'issued', $5)`,
        [enrollmentId, tripId, userId, digest, expiresAt],
      );
    } catch (err) {
      // SQLSTATE 23505 = unique_violation — the partial unique index on (trip_id)
      // WHERE state = 'issued' fired, meaning a concurrent call won the race.
      const code = (err as { code?: unknown }).code;
      if (code === "23505") {
        await client.query("ROLLBACK");
        return { ok: false, reason: "ACTIVE_ENROLLMENT_EXISTS" };
      }
      throw err;
    }

    await client.query("COMMIT");

    log(structuredLog("info", "enrollment.issued", { enrollment_id: enrollmentId, trip_id: tripId }));
    return { ok: true, enrollmentId, token: rawToken, expiresAt };
  } catch (error) {
    try { await client.query("ROLLBACK"); } catch { /* ignore */ }
    throw error;
  } finally {
    client.release();
  }
}

/**
 * Verifies a raw enrollment token without consuming it. Used by tests and
 * the session-start path to check validity before taking side effects.
 */
export async function verifyEnrollmentToken(
  db: pg.Pool,
  rawToken: string,
): Promise<EnrollmentVerifyResult> {
  const digest = tokenDigest(rawToken);
  const row = await db.query<{
    id: string;
    trip_id: string;
    user_id: string;
    state: string;
    expires_at: Date;
  }>(
    "SELECT id, trip_id, user_id, state, expires_at FROM control_plane.interview_enrollments WHERE token_digest = $1",
    [digest],
  );
  const [enrollment] = row.rows;
  if (!enrollment) return { ok: false, reason: "NOT_FOUND" };

  if (enrollment.state === "consumed") return { ok: false, reason: "ALREADY_CONSUMED" };
  if (enrollment.state === "revoked") return { ok: false, reason: "REVOKED" };
  if (enrollment.state === "expired" || enrollment.expires_at.getTime() < Date.now()) {
    return { ok: false, reason: "EXPIRED" };
  }

  return { ok: true, enrollmentId: enrollment.id, tripId: enrollment.trip_id, userId: enrollment.user_id };
}

/**
 * Atomically consumes an enrollment (marks it 'consumed') as part of starting
 * an interview session. Must be called inside a transaction held by the caller
 * so the enrollment consumption and session creation are atomic.
 *
 * Returns the enrollment row or null if it is no longer valid (expired,
 * consumed, revoked, or not found). The caller is responsible for ROLLBACK.
 */
/**
 * Which trip a token authorizes, without consuming it.
 *
 * `startFromDeepLink` needs this to tell two situations apart before deciding
 * whether an existing session on the chat means anything: a fresh, valid link
 * for the SAME trip as an in-progress interview (genuinely "already in this
 * interview" — refuse, leave the token unconsumed) versus a fresh, valid link
 * for a DIFFERENT trip while a stale, unconfirmed session from an earlier,
 * abandoned attempt still occupies the chat. Read-only and unlocked: it is
 * advisory, and `consumeEnrollmentInTx` still re-validates everything
 * atomically when the token is actually used a moment later.
 */
export async function peekEnrollmentTripId(db: pg.Pool, rawToken: string): Promise<string | null> {
  const digest = tokenDigest(rawToken);
  const row = await db.query<{ trip_id: string; state: string; expires_at: Date }>(
    `SELECT trip_id, state, expires_at FROM control_plane.interview_enrollments WHERE token_digest = $1`,
    [digest],
  );
  const [enrollment] = row.rows;
  if (!enrollment) return null;
  if (enrollment.state !== "issued") return null;
  if (enrollment.expires_at.getTime() < Date.now()) return null;
  return enrollment.trip_id;
}

export async function consumeEnrollmentInTx(
  client: pg.PoolClient,
  rawToken: string,
): Promise<{ enrollmentId: string; tripId: string; userId: string } | null> {
  const digest = tokenDigest(rawToken);

  // Row-level lock prevents two concurrent start-session calls from both
  // succeeding with the same token.
  const row = await client.query<{
    id: string;
    trip_id: string;
    user_id: string;
    state: string;
    expires_at: Date;
  }>(
    `SELECT id, trip_id, user_id, state, expires_at
     FROM control_plane.interview_enrollments
     WHERE token_digest = $1
     FOR UPDATE`,
    [digest],
  );
  const [enrollment] = row.rows;
  if (!enrollment) return null;
  if (enrollment.state !== "issued") return null;
  if (enrollment.expires_at.getTime() < Date.now()) return null;

  await client.query(
    "UPDATE control_plane.interview_enrollments SET state = 'consumed', consumed_at = now() WHERE id = $1",
    [enrollment.id],
  );

  return { enrollmentId: enrollment.id, tripId: enrollment.trip_id, userId: enrollment.user_id };
}

export type EnrollmentReplacementResult =
  | { ok: true; enrollmentId: string; token: string; expiresAt: Date }
  | { ok: false; reason: "NOT_OWNER" | "TRIP_NOT_DRAFT" | "ENROLLMENT_NOT_REPLACEABLE" | "INTERVIEW_ALREADY_STARTED" | "ENROLLMENT_BUSY" };

/** Explicit recovery of a lost, unused link. The expected id prevents a stale
 * request (including a second tab) from rotating a newly returned link. Never
 * resumes or resets a session, and never persists a plaintext token. */
export async function replaceEnrollment(
  db: pg.Pool, userId: string, tripId: string, expectedEnrollmentId: string,
  config: EnrollmentConfig,
): Promise<EnrollmentReplacementResult> {
  const client = await db.connect();
  const refuse = async (reason: Exclude<EnrollmentReplacementResult, { ok: true }>['reason']): Promise<EnrollmentReplacementResult> => {
    await client.query("ROLLBACK"); return { ok: false, reason };
  };
  try {
    await client.query("BEGIN");
    // startSession consumes/locks enrollment before locking its trip. Follow
    // that order so a consume racing recovery cannot create an inverse wait.
    const row = await client.query<{ state: string; expires_at: Date }>(
      `SELECT state, expires_at FROM control_plane.interview_enrollments
       WHERE id=$1 AND trip_id=$2 FOR UPDATE`, [expectedEnrollmentId, tripId]);
    const trip = await client.query<{ lifecycle_state: string }>(
      `SELECT t.lifecycle_state FROM control_plane.trips t
       JOIN control_plane.trip_memberships m ON m.trip_id=t.id
       JOIN control_plane.users u ON u.id=m.user_id
       WHERE t.id=$1 AND m.user_id=$2 AND m.role='owner' AND m.status='active'
         AND m.dashboard_access=true AND u.status='active'
       FOR UPDATE OF t NOWAIT FOR SHARE OF m, u NOWAIT`, [tripId, userId]);
    // Account/membership changes may have their own lock order. Do not wait
    // behind them while holding enrollment: refuse safely and allow a retry.
    if (!trip.rows[0]) return await refuse("NOT_OWNER");
    if (!row.rows[0] || row.rows[0].state !== "issued" || row.rows[0].expires_at.getTime() <= Date.now()) {
      return await refuse("ENROLLMENT_NOT_REPLACEABLE");
    }
    if (trip.rows[0].lifecycle_state !== "draft") return await refuse("TRIP_NOT_DRAFT");
    const sessions = await client.query("SELECT 1 FROM control_plane.intake_sessions WHERE trip_id=$1 LIMIT 1", [tripId]);
    if (sessions.rowCount) return await refuse("INTERVIEW_ALREADY_STARTED");
    const token = randomBytes(32).toString("base64url"), enrollmentId = generateId("enrl");
    const expiresAt = new Date(Date.now() + config.enrollmentTtlSeconds * 1000);
    await client.query("UPDATE control_plane.interview_enrollments SET state='revoked' WHERE id=$1", [expectedEnrollmentId]);
    await client.query(
      `INSERT INTO control_plane.interview_enrollments(id,trip_id,user_id,token_digest,state,expires_at)
       VALUES ($1,$2,$3,$4,'issued',$5)`, [enrollmentId, tripId, userId, tokenDigest(token), expiresAt]);
    await client.query("COMMIT");
    return { ok: true, enrollmentId, token, expiresAt };
  } catch (error) {
    await client.query("ROLLBACK");
    if ((error as { code?: string }).code === "55P03") return { ok: false, reason: "ENROLLMENT_BUSY" };
    throw error;
  } finally { client.release(); }
}
