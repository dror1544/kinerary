import { createHash, randomBytes } from "node:crypto";
import type pg from "pg";
import { INTAKE_SCHEMA_VERSION } from "./interview.js";

function generateId(prefix: string): string {
  return `${prefix}_${randomBytes(16).toString("hex")}`;
}

function sha256hex(input: string): string {
  return createHash("sha256").update(input).digest("hex");
}

export type CorrectIntakeResult =
  | { ok: true; versionId: string; version: number; digest: string }
  | {
      ok: false;
      reason:
        | "TRIP_NOT_FOUND"
        | "NOT_AUTHORIZED"
        | "NO_INTAKE_TO_CORRECT"
        | "INVALID_STATE";
    };

const CORRECTABLE_STATES = new Set([
  "intake_confirmed",
  "planned",
  "provisioning_approved",
]);

/**
 * Creates a new confirmed intake version from updated answers, supersedes
 * any active plan, cancels associated jobs, and reverts the trip to
 * 'intake_confirmed'. The previous confirmed version is never modified.
 *
 * actorRef identifies the caller for audit (e.g. "user:trip_xxx"). The caller
 * must be the trip owner; ownership verification happens before this function.
 */
export async function correctIntake(
  db: pg.Pool,
  tripId: string,
  actorRef: string,
  newAnswers: Record<string, unknown>,
): Promise<CorrectIntakeResult> {
  const client = await db.connect();
  try {
    await client.query("BEGIN");

    // Lock the trip row.
    const tripRow = await client.query<{ lifecycle_state: string }>(
      "SELECT lifecycle_state FROM control_plane.trips WHERE id = $1 FOR UPDATE",
      [tripId],
    );
    const trip = tripRow.rows[0];
    if (!trip) {
      await client.query("ROLLBACK");
      return { ok: false, reason: "TRIP_NOT_FOUND" };
    }
    if (!CORRECTABLE_STATES.has(trip.lifecycle_state)) {
      await client.query("ROLLBACK");
      return { ok: false, reason: "INVALID_STATE" };
    }

    // Require at least one existing confirmed intake version.
    const existingRow = await client.query<{ max_version: number | null }>(
      "SELECT MAX(version) AS max_version FROM control_plane.intake_versions WHERE trip_id = $1",
      [tripId],
    );
    const previousVersion = existingRow.rows[0]?.max_version;
    if (previousVersion == null) {
      await client.query("ROLLBACK");
      return { ok: false, reason: "NO_INTAKE_TO_CORRECT" };
    }

    // Compute new digest and create the corrected version.
    const dataJson = JSON.stringify(newAnswers);
    const digest = `sha256:${sha256hex(`${tripId}:v${previousVersion + 1}:${dataJson}`)}`;
    const versionId = generateId("intk");
    const nextVersion = previousVersion + 1;
    const artifactRef = `intake:correction:${tripId}:v${nextVersion}:${actorRef}`;

    await client.query(
      `INSERT INTO control_plane.intake_versions
         (id, trip_id, version, artifact_ref, digest, confirmed_at, schema_version, data)
       VALUES ($1, $2, $3, $4, $5, now(), $6, $7::jsonb)`,
      [versionId, tripId, nextVersion, artifactRef, digest, INTAKE_SCHEMA_VERSION, dataJson],
    );

    // Supersede any active plan (pending_approval or approved) and cancel jobs.
    // The plans_trip_active_idx only covers these two statuses, so the UPDATE
    // automatically removes the plan from the uniqueness domain.
    const planRow = await client.query<{ id: string }>(
      `UPDATE control_plane.plans
       SET    status = 'superseded', updated_at = now()
       WHERE  trip_id = $1
         AND  status IN ('pending_approval', 'approved')
       RETURNING id`,
      [tripId],
    );
    if (planRow.rowCount && planRow.rowCount > 0) {
      const planIds = planRow.rows.map((r) => r.id);
      await client.query(
        `UPDATE control_plane.jobs
         SET    state = 'cancelled', updated_at = now()
         WHERE  plan_id = ANY($1)
           AND  state NOT IN ('succeeded', 'failed', 'cancelled')`,
        [planIds],
      );
    }

    // Revert trip to intake_confirmed so the organizer can generate a new plan.
    await client.query(
      `UPDATE control_plane.trips
       SET    lifecycle_state = 'intake_confirmed', updated_at = now()
       WHERE  id = $1`,
      [tripId],
    );

    await client.query("COMMIT");
    return { ok: true, versionId, version: nextVersion, digest };
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }
}
