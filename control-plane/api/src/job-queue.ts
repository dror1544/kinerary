import type pg from "pg";

export interface JobClaim {
  jobId: string;
  tripId: string;
  planId: string;
  planDigest: string;
  jobType: string;
  attempt: number;
  leaseExpiresAt: Date;
}

export type ClaimJobResult =
  | { ok: true; claim: JobClaim }
  | { ok: false; reason: "NO_CLAIMABLE_JOB" };

/**
 * Atomically claims one queued job whose plan has a valid (non-expired,
 * non-used) approval whose digest matches the plan. Uses SKIP LOCKED so
 * concurrent workers never block each other and each job is claimed at
 * most once.
 */
export async function claimJob(
  db: pg.Pool,
  workerId: string,
  leaseSeconds: number,
): Promise<ClaimJobResult> {
  const client = await db.connect();
  try {
    await client.query("BEGIN");

    // Select a queued job that has a valid approval. The plan_digest join
    // ensures the approval was bound to the exact plan currently attached.
    const row = await client.query<{
      job_id: string; trip_id: string; plan_id: string; plan_digest: string;
      job_type: string; attempt: number;
    }>(
      `SELECT j.id AS job_id, j.trip_id, j.plan_id, p.digest AS plan_digest,
              j.job_type, j.attempt
       FROM control_plane.jobs j
       JOIN control_plane.plans p ON p.id = j.plan_id
       JOIN control_plane.plan_approvals pa ON pa.plan_id = j.plan_id
       WHERE j.state = 'queued'
         AND pa.used_at IS NULL
         AND pa.expires_at > now()
         AND pa.plan_digest = p.digest
       ORDER BY j.created_at
       LIMIT 1
       FOR UPDATE OF j, pa SKIP LOCKED`,
    );

    const job = row.rows[0];
    if (!job) {
      await client.query("ROLLBACK");
      return { ok: false, reason: "NO_CLAIMABLE_JOB" };
    }

    const leaseExpiresAt = new Date(Date.now() + leaseSeconds * 1000);

    await client.query(
      `UPDATE control_plane.jobs
       SET state = 'leased',
           lease_owner = $1,
           lease_expires_at = $2,
           last_heartbeat_at = now(),
           attempt = attempt + 1,
           updated_at = now()
       WHERE id = $3`,
      [workerId, leaseExpiresAt, job.job_id],
    );
    // Mark the approval used — one-time use.
    await client.query(
      "UPDATE control_plane.plan_approvals SET used_at = now() WHERE plan_id = $1 AND used_at IS NULL",
      [job.plan_id],
    );

    await client.query("COMMIT");

    return {
      ok: true,
      claim: {
        jobId: job.job_id,
        tripId: job.trip_id,
        planId: job.plan_id,
        planDigest: job.plan_digest,
        jobType: job.job_type,
        attempt: job.attempt + 1,
        leaseExpiresAt,
      },
    };
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }
}

/**
 * Extends the lease and records a heartbeat. The worker calls this
 * periodically while running a job so stale-lease recovery does not
 * re-queue an active job.
 */
export async function heartbeat(
  db: pg.Pool,
  jobId: string,
  workerId: string,
  leaseSeconds: number,
): Promise<boolean> {
  const result = await db.query(
    `UPDATE control_plane.jobs
     SET lease_expires_at = now() + make_interval(secs => $1::float8),
         last_heartbeat_at = now(),
         updated_at = now()
     WHERE id = $2 AND lease_owner = $3 AND state = 'leased'`,
    [leaseSeconds, jobId, workerId],
  );
  return (result.rowCount ?? 0) > 0;
}

/**
 * Re-queues jobs whose leases expired without a successful completion.
 * Jobs that have exhausted max_attempts are moved to failed instead.
 * Jobs with remaining attempts move to waiting_for_user_action and their
 * plan/trip are reverted so the organizer can issue a fresh approval before
 * the next claim attempt (the prior approval was consumed at claim time).
 * Returns the number of jobs recovered.
 */
export async function recoverStaleLeases(db: pg.Pool): Promise<number> {
  const client = await db.connect();
  try {
    await client.query("BEGIN");

    const result = await client.query<{
      plan_id: string; trip_id: string; attempt: number; max_attempts: number;
    }>(
      `UPDATE control_plane.jobs
       SET state = CASE
             WHEN attempt >= max_attempts THEN 'failed'
             ELSE 'waiting_for_user_action'
           END,
           safe_error_code = CASE
             WHEN attempt >= max_attempts THEN 'LEASE_EXHAUSTED'
             ELSE NULL
           END,
           lease_owner = NULL,
           lease_expires_at = NULL,
           updated_at = now()
       WHERE state = 'leased'
         AND lease_expires_at < now()
       RETURNING plan_id, trip_id, attempt, max_attempts`,
    );

    // For retriable jobs: revert plan + trip so the organizer can re-approve.
    const retriable = result.rows.filter((r) => r.attempt < r.max_attempts);
    if (retriable.length > 0) {
      const planIds = [...new Set(retriable.map((r) => r.plan_id))];
      const tripIds = [...new Set(retriable.map((r) => r.trip_id))];
      await client.query(
        "UPDATE control_plane.plans SET status = 'pending_approval', updated_at = now() WHERE id = ANY($1)",
        [planIds],
      );
      // Only revert trips still in provisioning_approved; a trip that has moved
      // further along should not be wound back.
      await client.query(
        `UPDATE control_plane.trips SET lifecycle_state = 'planned', updated_at = now()
         WHERE id = ANY($1) AND lifecycle_state = 'provisioning_approved'`,
        [tripIds],
      );
    }

    await client.query("COMMIT");
    return result.rowCount ?? 0;
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }
}

/**
 * Re-queues jobs in waiting_for_user_action whose approval has expired.
 * The plan reverts to pending_approval so a fresh approval can be issued.
 * Both updates execute as a single CTE statement so they share one snapshot —
 * a concurrent fresh approval INSERT cannot slip between the plan revert and
 * the job revert the way it could with two sequential UPDATE statements.
 */
export async function recoverExpiredApprovals(db: pg.Pool): Promise<number> {
  const result = await db.query(
    `WITH reverted_plans AS (
       UPDATE control_plane.plans p
       SET status = 'pending_approval', updated_at = now()
       FROM control_plane.plan_approvals pa
       WHERE pa.plan_id = p.id
         AND p.status = 'approved'
         AND pa.used_at IS NULL
         AND pa.expires_at < now()
         AND NOT EXISTS (
           SELECT 1 FROM control_plane.plan_approvals pa2
           WHERE pa2.plan_id = p.id AND pa2.used_at IS NULL AND pa2.expires_at >= now()
         )
       RETURNING p.id AS plan_id
     )
     UPDATE control_plane.jobs j
     SET state = 'waiting_for_user_action', updated_at = now()
     FROM reverted_plans
     WHERE j.plan_id = reverted_plans.plan_id
       AND j.state = 'queued'`,
  );
  return result.rowCount ?? 0;
}

/**
 * Marks a job as succeeded and records the result.
 */
export async function completeJob(
  db: pg.Pool,
  jobId: string,
  workerId: string,
  result: unknown,
): Promise<boolean> {
  const updateResult = await db.query(
    `UPDATE control_plane.jobs
     SET state = 'succeeded',
         result = $1::jsonb,
         lease_owner = NULL,
         lease_expires_at = NULL,
         updated_at = now()
     WHERE id = $2 AND lease_owner = $3 AND state = 'leased'`,
    [JSON.stringify(result), jobId, workerId],
  );
  return (updateResult.rowCount ?? 0) > 0;
}

/**
 * Fails a job step with a safe error code. If the job has remaining attempts
 * it moves to waiting_for_user_action and the plan/trip are reverted so the
 * organizer can issue a fresh approval (the prior approval was consumed at
 * claim time and cannot be reused). If attempts are exhausted the job is
 * marked failed.
 */
export async function failJob(
  db: pg.Pool,
  jobId: string,
  workerId: string,
  safeErrorCode: string,
): Promise<boolean> {
  const client = await db.connect();
  try {
    await client.query("BEGIN");

    const result = await client.query<{
      plan_id: string; trip_id: string; attempt: number; max_attempts: number;
    }>(
      `UPDATE control_plane.jobs
       SET state = CASE
             WHEN attempt >= max_attempts THEN 'failed'
             ELSE 'waiting_for_user_action'
           END,
           safe_error_code = CASE
             WHEN attempt >= max_attempts THEN $1
             ELSE NULL
           END,
           lease_owner = NULL,
           lease_expires_at = NULL,
           updated_at = now()
       WHERE id = $2 AND lease_owner = $3 AND state = 'leased'
       RETURNING plan_id, trip_id, attempt, max_attempts`,
      [safeErrorCode, jobId, workerId],
    );

    if ((result.rowCount ?? 0) === 0) {
      await client.query("ROLLBACK");
      return false;
    }

    const row = result.rows[0]!;
    if (row.attempt < row.max_attempts) {
      // Retryable: revert plan + trip so the organizer can re-approve.
      await client.query(
        "UPDATE control_plane.plans SET status = 'pending_approval', updated_at = now() WHERE id = $1",
        [row.plan_id],
      );
      await client.query(
        `UPDATE control_plane.trips SET lifecycle_state = 'planned', updated_at = now()
         WHERE id = $1 AND lifecycle_state = 'provisioning_approved'`,
        [row.trip_id],
      );
    }

    await client.query("COMMIT");
    return true;
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }
}
