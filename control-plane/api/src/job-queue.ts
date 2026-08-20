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
     SET lease_expires_at = now() + ($1 || ' seconds')::interval,
         last_heartbeat_at = now(),
         updated_at = now()
     WHERE id = $2 AND lease_owner = $3 AND state = 'leased'`,
    [leaseSeconds.toString(), jobId, workerId],
  );
  return (result.rowCount ?? 0) > 0;
}

/**
 * Re-queues jobs whose leases expired without a successful completion.
 * Jobs that have exhausted max_attempts are moved to failed instead.
 * Returns the number of jobs recovered.
 */
export async function recoverStaleLeases(db: pg.Pool): Promise<number> {
  const result = await db.query(
    `UPDATE control_plane.jobs
     SET state = CASE
           WHEN attempt >= max_attempts THEN 'failed'
           ELSE 'queued'
         END,
         safe_error_code = CASE
           WHEN attempt >= max_attempts THEN 'LEASE_EXHAUSTED'
           ELSE NULL
         END,
         lease_owner = NULL,
         lease_expires_at = NULL,
         updated_at = now()
     WHERE state = 'leased'
       AND lease_expires_at < now()`,
  );
  return result.rowCount ?? 0;
}

/**
 * Re-queues jobs in waiting_for_user_action whose approval has expired.
 * The plan reverts to pending_approval so a fresh approval can be issued.
 */
export async function recoverExpiredApprovals(db: pg.Pool): Promise<number> {
  const result = await db.query(
    `UPDATE control_plane.jobs j
     SET state = 'waiting_for_user_action', updated_at = now()
     FROM control_plane.plans p
     JOIN control_plane.plan_approvals pa ON pa.plan_id = p.id
     WHERE j.plan_id = p.id
       AND j.state = 'queued'
       AND pa.used_at IS NULL
       AND pa.expires_at < now()`,
  );
  // Revert plans whose only approval has expired.
  await db.query(
    `UPDATE control_plane.plans p
     SET status = 'pending_approval', updated_at = now()
     FROM control_plane.plan_approvals pa
     WHERE pa.plan_id = p.id
       AND p.status = 'approved'
       AND pa.used_at IS NULL
       AND pa.expires_at < now()
       AND NOT EXISTS (
         SELECT 1 FROM control_plane.plan_approvals pa2
         WHERE pa2.plan_id = p.id AND pa2.used_at IS NULL AND pa2.expires_at >= now()
       )`,
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
 * it is re-queued; otherwise it is marked failed.
 */
export async function failJob(
  db: pg.Pool,
  jobId: string,
  workerId: string,
  safeErrorCode: string,
): Promise<boolean> {
  const updateResult = await db.query(
    `UPDATE control_plane.jobs
     SET state = CASE
           WHEN attempt >= max_attempts THEN 'failed'
           ELSE 'queued'
         END,
         safe_error_code = CASE
           WHEN attempt >= max_attempts THEN $1
           ELSE NULL
         END,
         lease_owner = NULL,
         lease_expires_at = NULL,
         updated_at = now()
     WHERE id = $2 AND lease_owner = $3 AND state = 'leased'`,
    [safeErrorCode, jobId, workerId],
  );
  return (updateResult.rowCount ?? 0) > 0;
}
