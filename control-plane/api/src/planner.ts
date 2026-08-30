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
  if (trip.lifecycle_state !== "intake_confirmed") return { ok: false, reason: "TRIP_NOT_CONFIRMED" };

  const intakeRow = await db.query<{ id: string; version: number; digest: string; schema_version: number }>(
    `SELECT id, version, digest, schema_version
     FROM control_plane.intake_versions
     WHERE trip_id = $1
     ORDER BY version DESC LIMIT 1`,
    [tripId],
  );
  const intake = intakeRow.rows[0];
  if (!intake) return { ok: false, reason: "NO_INTAKE_VERSION" };

  const releaseRow = await db.query<{ id: string }>(
    `SELECT id FROM control_plane.releases
     WHERE status = 'available'
       AND data_schema_min <= $1 AND data_schema_max >= $1
     ORDER BY created_at DESC LIMIT 1`,
    [intake.schema_version],
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
