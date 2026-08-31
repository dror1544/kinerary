import { createHash, randomBytes } from "node:crypto";
import type pg from "pg";
import { INTAKE_SCHEMA_VERSION } from "./interview.js";

function generateId(prefix: string): string {
  return `${prefix}_${randomBytes(16).toString("hex")}`;
}

function sha256hex(input: string): string {
  return createHash("sha256").update(input).digest("hex");
}

export type GeneratePlanResult =
  | { ok: true; planId: string; planDigest: string; releaseId: string; jobId: string }
  | { ok: false; reason: "TRIP_NOT_CONFIRMED" | "NO_INTAKE_VERSION" | "NO_COMPATIBLE_RELEASE" | "PLAN_ALREADY_PENDING" };

/**
 * Creates a provisioning plan from the trip's latest confirmed intake.
 * Selects the most recently available release compatible with the intake's
 * schema version. Stores resource intent only — no provider values.
 * Also creates a job in waiting_for_user_action state; the job moves to
 * queued only after an organizer issues an approval via issueApproval().
 */
export async function generatePlan(
  db: pg.Pool,
  tripId: string,
  correlationId: string,
): Promise<GeneratePlanResult> {
  // Return the stable duplicate-request result before checking lifecycle. Once a
  // plan is created the trip advances from intake_confirmed to planned, so doing
  // the lifecycle check first made later calls report TRIP_NOT_CONFIRMED instead
  // of PLAN_ALREADY_PENDING. The partial unique index still closes the race when
  // two requests both pass this read before either inserts.
  const activePlanRow = await db.query(
    "SELECT id FROM control_plane.plans WHERE trip_id = $1 AND status IN ('pending_approval', 'approved') LIMIT 1",
    [tripId],
  );
  if (activePlanRow.rows.length > 0) return { ok: false, reason: "PLAN_ALREADY_PENDING" };

  const tripRow = await db.query<{ lifecycle_state: string }>(
    "SELECT lifecycle_state FROM control_plane.trips WHERE id = $1",
    [tripId],
  );
  const trip = tripRow.rows[0];
  if (!trip) return { ok: false, reason: "TRIP_NOT_CONFIRMED" };
  if (trip.lifecycle_state !== "intake_confirmed") {
    // A concurrent generatePlan that won the race has already created the plan
    // and advanced the trip to 'planned' — between this call's active-plan
    // pre-check above and this read. Re-check for that plan so the loser gets
    // the stable PLAN_ALREADY_PENDING, not TRIP_NOT_CONFIRMED. (The
    // plans_trip_active_idx 23505 path only covers a loser that reaches its
    // own INSERT; one that reads the trip after the winner's COMMIT bails
    // here first.)
    const racedPlan = await db.query(
      "SELECT id FROM control_plane.plans WHERE trip_id = $1 AND status IN ('pending_approval', 'approved') LIMIT 1",
      [tripId],
    );
    if (racedPlan.rows.length > 0) return { ok: false, reason: "PLAN_ALREADY_PENDING" };
    return { ok: false, reason: "TRIP_NOT_CONFIRMED" };
  }

  const intakeRow = await db.query<{ id: string; version: number; digest: string; schema_version: number }>(
    `SELECT id, version, digest, schema_version
     FROM control_plane.intake_versions
     WHERE trip_id = $1
     ORDER BY version DESC LIMIT 1`,
    [tripId],
  );
  const intake = intakeRow.rows[0];
  if (!intake) return { ok: false, reason: "NO_INTAKE_VERSION" };

  // A real pipeline manifest always carries a non-empty `files` array
  // (buildReleaseManifest throws otherwise). A manifest-less `available` row —
  // or migration 0027's `kind: legacy-hand-seed` backfill of the dev release,
  // which has no `files` — cannot be materialized or digest-verified, so
  // selecting one makes the worker deploy the ambient repo checkout with only a
  // `provisioner.release_unverified` warning. That is acceptable for a local
  // dev box and nowhere else: in production it would mean that deprecating every
  // sealed release silently falls back to shipping unscanned code. So the
  // unsealed fallback is opt-in per deployment. `CONTROL_PLANE_ALLOW_UNSEALED_RELEASE`
  // is read here rather than threaded through generatePlan's ~30 call sites
  // because it is a security default that must hold even for a caller that
  // passes nothing (retryProvision, the plan route); the local compose stack
  // sets it, a real deployment does not.
  const allowUnsealedFallback = process.env.CONTROL_PLANE_ALLOW_UNSEALED_RELEASE === "1";
  const releaseRow = await db.query<{
    id: string; source_revision: string; artifact_digest: string; has_manifest: boolean;
  }>(
    `SELECT id, source_revision, artifact_digest,
            COALESCE(jsonb_typeof(manifest -> 'files') = 'array', false) AS has_manifest
     FROM control_plane.releases
     WHERE status = 'available'
       AND data_schema_min <= $1 AND data_schema_max >= $1
       AND (jsonb_typeof(manifest -> 'files') = 'array' OR $2)
     ORDER BY created_at DESC LIMIT 1`,
    [intake.schema_version, allowUnsealedFallback],
  );
  const release = releaseRow.rows[0];
  if (!release) return { ok: false, reason: "NO_COMPATIBLE_RELEASE" };

  // Has this trip ever been provisioned successfully? A first provision starts
  // from clean per-trip data (the NFS media/DB dir outlives a container, so a
  // failed earlier attempt can leave a stale SQLite users table that blocks
  // re-seeding); a re-provision replaces a container behind a live trip and
  // must preserve it. The provisioner reads this from plan.desired.
  const priorSuccess = await db.query(
    "SELECT 1 FROM control_plane.jobs WHERE trip_id = $1 AND job_type = 'provision' AND state = 'succeeded' LIMIT 1",
    [tripId],
  );
  const firstProvision = priorSuccess.rows.length === 0;

  const desired = {
    release_id: release.id,
    // The exact source the worker must deploy — not "whatever is in the repo
    // checkout". `release_verified` gates whether the worker materializes and
    // digest-checks it (a manifest-backed pipeline release with a real `files`
    // list) or falls back to REPO_ROOT with a warning (the hand-seeded dev
    // release, migrations 0016 + 0027 — its manifest has no `files`).
    release_source_revision: release.source_revision,
    release_artifact_digest: release.artifact_digest,
    release_verified: release.has_manifest,
    intake_version_id: intake.id,
    intake_digest: intake.digest,
    first_provision: firstProvision,
    resource_intent: [
      { logical_type: "trip_runtime", isolation_tier: "shared_test" },
    ],
  };
  const desiredJson = JSON.stringify(desired);
  const planDigest = `sha256:${sha256hex(desiredJson)}`;
  const planId = generateId("plan");
  const jobId = generateId("job");

  const client = await db.connect();
  try {
    await client.query("BEGIN");
    // The partial unique index plans_trip_active_idx enforces one active plan
    // per trip atomically. If a concurrent generatePlan races past the pre-checks
    // above and inserts first, this INSERT gets SQLSTATE 23505.
    await client.query(
      `INSERT INTO control_plane.plans(id, trip_id, release_id, kind, digest, status, desired)
       VALUES ($1, $2, $3, 'provision', $4, 'pending_approval', $5::jsonb)`,
      [planId, tripId, release.id, planDigest, desiredJson],
    );
    // Job starts in waiting_for_user_action — not claimable until approved.
    await client.query(
      `INSERT INTO control_plane.jobs(id, trip_id, plan_id, job_type, idempotency_key, correlation_id, state)
       VALUES ($1, $2, $3, 'provision', $4, $5, 'waiting_for_user_action')`,
      [jobId, tripId, planId, `provision-${planId}`, correlationId],
    );
    await client.query(
      "UPDATE control_plane.trips SET lifecycle_state = 'planned', updated_at = now() WHERE id = $1",
      [tripId],
    );
    await client.query("COMMIT");
  } catch (err) {
    await client.query("ROLLBACK");
    const pgErr = err as { code?: string };
    if (pgErr.code === "23505") return { ok: false, reason: "PLAN_ALREADY_PENDING" };
    throw err;
  } finally {
    client.release();
  }

  return { ok: true, planId, planDigest, releaseId: release.id, jobId };
}

export type RetryProvisionResult =
  | {
      ok: true;
      planId: string;
      planDigest: string;
      releaseId: string;
      jobId: string;
      supersededPlanId: string | null;
    }
  | {
      ok: false;
      reason:
        | "TRIP_NOT_FOUND"
        | "NOT_RETRYABLE_STATE"
        | "PROVISION_IN_PROGRESS"
        | "TRIP_NOT_CONFIRMED"
        | "NO_INTAKE_VERSION"
        | "NO_COMPATIBLE_RELEASE"
        | "PLAN_ALREADY_PENDING";
    };

// States a re-provision can start from. Everything up to and including a live
// private trip; not the activation states or a sealed/completed trip, which
// need their own ceremony. `intake_confirmed` is the degenerate case — nothing
// to supersede, generatePlan alone would do — but it is accepted so the
// endpoint is idempotent to call.
const RETRYABLE_STATES = new Set([
  "intake_confirmed",
  "planned",
  "provisioning_approved",
  "provisioning",
  "ready_private",
]);

/**
 * Re-runs provisioning for a trip whose previous attempt is finished (failed,
 * or succeeded and now being replaced) without a hand DB edit. Supersedes any
 * still-active plan and cancels its non-terminal jobs, reverts the trip to
 * `intake_confirmed`, then calls generatePlan against the latest confirmed
 * intake. `first_provision` is recomputed there from job history, so a
 * re-provision of a live trip (a prior succeeded job) correctly comes out
 * `false` and the container's seeded users survive.
 *
 * Refuses while a provision job holds a live lease — a stale/expired lease is
 * cancelled, an in-flight one is not yanked.
 */
export async function retryProvision(
  db: pg.Pool,
  tripId: string,
  correlationId: string,
): Promise<RetryProvisionResult> {
  const client = await db.connect();
  let supersededPlanId: string | null = null;
  try {
    await client.query("BEGIN");

    const tripRow = await client.query<{ lifecycle_state: string }>(
      "SELECT lifecycle_state FROM control_plane.trips WHERE id = $1 FOR UPDATE",
      [tripId],
    );
    const trip = tripRow.rows[0];
    if (!trip) {
      await client.query("ROLLBACK");
      return { ok: false, reason: "TRIP_NOT_FOUND" };
    }
    if (!RETRYABLE_STATES.has(trip.lifecycle_state)) {
      await client.query("ROLLBACK");
      return { ok: false, reason: "NOT_RETRYABLE_STATE" };
    }

    // Lock every non-terminal provision job for this trip, THEN decide. The
    // worker claims with `... FOR UPDATE OF j SKIP LOCKED`, so once we hold
    // these row locks a claim racing us skips the row instead of leasing it
    // in the window between our check and our cancel — without the lock, a
    // job claimed in that window would be cancelled here while its worker
    // kept provisioning, and generatePlan would then queue a second one.
    // `live` is computed against the DB clock in the same statement so a job
    // that is genuinely in flight is never cancelled from under its worker.
    const provisionJobs = await client.query<{ id: string; live: boolean }>(
      `SELECT id,
              (state IN ('leased', 'running')
               AND lease_expires_at IS NOT NULL
               AND lease_expires_at > now()) AS live
       FROM control_plane.jobs
       WHERE trip_id = $1 AND job_type = 'provision'
         AND state NOT IN ('succeeded', 'failed', 'cancelled')
       FOR UPDATE`,
      [tripId],
    );
    if (provisionJobs.rows.some((j) => j.live)) {
      await client.query("ROLLBACK");
      return { ok: false, reason: "PROVISION_IN_PROGRESS" };
    }

    // Supersede any active plan — same shape as correctIntake, without writing
    // a new intake version.
    const supersededRows = await client.query<{ id: string }>(
      `UPDATE control_plane.plans
       SET status = 'superseded', updated_at = now()
       WHERE trip_id = $1 AND status IN ('pending_approval', 'approved')
       RETURNING id`,
      [tripId],
    );
    if (supersededRows.rowCount && supersededRows.rowCount > 0) {
      supersededPlanId = supersededRows.rows[0]!.id;
    }

    // Cancel the (now lock-held) non-terminal jobs by id — trip-scoped rather
    // than plan-scoped, so an orphan job whose plan already moved on is cleared
    // too. Nothing here is `live` (checked above).
    const jobIds = provisionJobs.rows.map((j) => j.id);
    if (jobIds.length > 0) {
      await client.query(
        `UPDATE control_plane.jobs
         SET state = 'cancelled', lease_owner = NULL, lease_expires_at = NULL, updated_at = now()
         WHERE id = ANY($1)`,
        [jobIds],
      );
    }

    await client.query(
      "UPDATE control_plane.trips SET lifecycle_state = 'intake_confirmed', updated_at = now() WHERE id = $1",
      [tripId],
    );

    await client.query("COMMIT");
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }

  // Fresh connection / transaction. If this fails (e.g. NO_COMPATIBLE_RELEASE)
  // the trip is left at intake_confirmed with no plan — a valid resting state
  // and strictly more recoverable than where it started.
  const gen = await generatePlan(db, tripId, correlationId);
  if (!gen.ok) return { ok: false, reason: gen.reason };
  return {
    ok: true,
    planId: gen.planId,
    planDigest: gen.planDigest,
    releaseId: gen.releaseId,
    jobId: gen.jobId,
    supersededPlanId,
  };
}

export interface PlanView {
  id: string;
  tripId: string;
  releaseId: string | null;
  kind: string;
  digest: string;
  status: string;
  desired: unknown;
}

export type GetPlanResult =
  | { ok: true; plan: PlanView }
  | { ok: false; reason: "NOT_FOUND" };

export async function getPlan(
  db: pg.Pool,
  planId: string,
  tripId: string,
): Promise<GetPlanResult> {
  const row = await db.query<{
    id: string; trip_id: string; release_id: string | null;
    kind: string; digest: string; status: string; desired: unknown;
  }>(
    "SELECT id, trip_id, release_id, kind, digest, status, desired FROM control_plane.plans WHERE id = $1 AND trip_id = $2",
    [planId, tripId],
  );
  const p = row.rows[0];
  if (!p) return { ok: false, reason: "NOT_FOUND" };
  return {
    ok: true,
    plan: { id: p.id, tripId: p.trip_id, releaseId: p.release_id, kind: p.kind, digest: p.digest, status: p.status, desired: p.desired },
  };
}

export interface ReleaseView {
  id: string;
  sourceRevision: string;
  artifactDigest: string;
  applicationSchema: number;
  dataSchemaMin: number;
  dataSchemaMax: number;
  status: string;
}

export async function listAvailableReleases(db: pg.Pool): Promise<ReleaseView[]> {
  const rows = await db.query<{
    id: string; source_revision: string; artifact_digest: string;
    application_schema: number; data_schema_min: number; data_schema_max: number; status: string;
  }>(
    "SELECT id, source_revision, artifact_digest, application_schema, data_schema_min, data_schema_max, status FROM control_plane.releases WHERE status = 'available' ORDER BY created_at DESC",
  );
  return rows.rows.map((r) => ({
    id: r.id,
    sourceRevision: r.source_revision,
    artifactDigest: r.artifact_digest,
    applicationSchema: r.application_schema,
    dataSchemaMin: r.data_schema_min,
    dataSchemaMax: r.data_schema_max,
    status: r.status,
  }));
}

export const INTAKE_SCHEMA_VERSION_CURRENT = INTAKE_SCHEMA_VERSION;
