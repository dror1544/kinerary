import { createHash, randomBytes } from "node:crypto";
import type pg from "pg";
import { INTAKE_SCHEMA_VERSION, organizerMatch, type AnswerStore } from "./interview.js";
import { issueApproval } from "./plan-approval.js";

function generateId(prefix: string): string {
  return `${prefix}_${randomBytes(16).toString("hex")}`;
}

function sha256hex(input: string): string {
  return createHash("sha256").update(input).digest("hex");
}

/**
 * Whether an intake carries any answers. NULL and `{}` both mean none — the
 * worker's `_load_intake_data` refuses either ("has no data"), so neither can
 * become a trip, and neither is judged by the organizer rule.
 */
function hasAnswers(data: AnswerStore | null | undefined): data is AnswerStore {
  return Boolean(data) && Object.keys(data as object).length > 0;
}

export type GeneratePlanResult =
  | { ok: true; planId: string; planDigest: string; releaseId: string; jobId: string }
  | { ok: false; reason: "TRIP_NOT_CONFIRMED" | "NO_INTAKE_VERSION" | "NO_COMPATIBLE_RELEASE" | "PLAN_ALREADY_PENDING" | "ORGANIZER_NOT_ON_ROSTER" };

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

  const intakeRow = await db.query<{ id: string; version: number; digest: string; schema_version: number; data: AnswerStore | null }>(
    `SELECT id, version, digest, schema_version, data
     FROM control_plane.intake_versions
     WHERE trip_id = $1
     ORDER BY version DESC LIMIT 1`,
    [tripId],
  );
  const intake = intakeRow.rows[0];
  if (!intake) return { ok: false, reason: "NO_INTAKE_VERSION" };

  // THE COMPLETION INVARIANT, at the last gate before anything is built: a trip is
  // approvable only when its organizer is exactly one traveller on its own roster.
  // The interview already refuses to confirm otherwise (`isAnswered`). This holds
  // it for every other way an intake arrives — a correction, an import, a future
  // bug in either — because the alternative is the trip of 2026-09-15: built,
  // "succeeded", and unreachable, with no companion behind it.
  //
  // An intake with no answers at all (a row from before migration 0013) is not
  // judged here: the worker refuses to build one outright, so it can never become
  // a trip without an organizer.
  if (hasAnswers(intake.data) && organizerMatch(intake.data).kind !== "matched") {
    return { ok: false, reason: "ORGANIZER_NOT_ON_ROSTER" };
  }

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

    // R4-1 (boundary review, 2026-10-14): the pre-checks above (including the
    // `lifecycle_state` read at the top of this function) are all UNLOCKED
    // and run before this transaction even opens. That is fine for the fast,
    // common-case rejection they give a caller, but it is not what actually
    // prevents a race — reproduced live, twice, against this exact function
    // and `trip-clear.ts`'s `executeClear`: an operator's clear call locked
    // and found no job, and in the window before it committed, a concurrent
    // `generatePlan` (this function, from the organizer's own interview
    // confirmation, or an admin retry) inserted a brand-new job — one
    // `FOR UPDATE` can never see, because the row didn't exist yet when the
    // lock was taken. This function must re-read `lifecycle_state` UNDER
    // THAT SAME LOCK, inside its own transaction, as the authoritative
    // check, not rely on the unlocked read above — that is what the code
    // right below does.
    //
    // CORRECTED (boundary review round 12, 2026-10-15): this comment used
    // to say `executeClear` closes its own half by locking `trips` BEFORE
    // it ever reads `jobs` — that was round 4's FIRST attempt, and round 5
    // found it deadlocks against four other real transactions that all lock
    // something else before `trips` (R4-2, see trip-clear.ts's own module
    // doc). What actually shipped is the opposite order: `executeClear`
    // locks `jobs` (among other things) FIRST, `trips` LAST like every
    // other transaction that touches it, then does a PLAIN (lockless)
    // re-read of `jobs` once `trips` is held — and it is THAT late re-read,
    // not a trips-before-jobs lock order, that closes this function's own
    // race from the other side: with `trips` locked by whichever side gets
    // there first, the two transactions still genuinely serialize, just via
    // the opposite lock order than this comment used to claim. If
    // `executeClear` wins, this read below sees `draft` (not
    // `intake_confirmed`) and refuses — the job this finding was about is
    // never created. If this function wins, `executeClear`'s own `trips`
    // lock blocks until this transaction commits, then its LATE, PLAIN
    // re-read of `jobs` (not a second `FOR UPDATE` — see trip-clear.ts for
    // why) sees the job this INSERT is about to create and refuses to
    // proceed instead of clearing a trip whose provisioning just started.
    const lockedTrip = await client.query<{ lifecycle_state: string }>(
      "SELECT lifecycle_state FROM control_plane.trips WHERE id = $1 FOR UPDATE",
      [tripId],
    );
    const locked = lockedTrip.rows[0];
    if (!locked || locked.lifecycle_state !== "intake_confirmed") {
      await client.query("ROLLBACK");
      // Same reasoning as the unlocked racedPlan re-check above: a trip that
      // moved past intake_confirmed because a concurrent generatePlan won is
      // reported as PLAN_ALREADY_PENDING, not TRIP_NOT_CONFIRMED, if that
      // plan is findable; otherwise (e.g. a clear reverted it to draft)
      // TRIP_NOT_CONFIRMED is the honest answer.
      const racedPlan = await db.query(
        "SELECT id FROM control_plane.plans WHERE trip_id = $1 AND status IN ('pending_approval', 'approved') LIMIT 1",
        [tripId],
      );
      return { ok: false, reason: racedPlan.rows.length > 0 ? "PLAN_ALREADY_PENDING" : "TRIP_NOT_CONFIRMED" };
    }

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
        | "PLAN_ALREADY_PENDING"
        | "ORGANIZER_NOT_ON_ROSTER";
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
 *
 * LOCK ORDER (issue #387): `jobs` (non-terminal provision rows, FOR UPDATE),
 * then `trips` (FOR UPDATE), then the `plans` / `jobs` / `trips` writes under
 * those locks, with a PLAIN re-read of `jobs` once `trips` is held. It must
 * agree with the worker's `_complete` and `_claim` (provisioner.py: jobs ->
 * plan_approvals -> plans -> trips, `trips` last), `executeClear`
 * (trip-clear.ts: jobs first, `trips` last, plain late re-read) and
 * `correctIntake` (intake-correction.ts: same order). The job lock is the
 * gate: any worker that has a non-terminal job on this trip holds that row
 * before it touches plans or trips, so it is either finished (the row drops
 * out of our locking read) or we queue behind it. It deliberately does NOT
 * lock `plans` before `trips`: `resumeTrip` (admin-mutations.ts) takes
 * trips -> plans, and a plans-first order here would conflict with it.
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

    // 1. `jobs` FIRST. Lock every non-terminal provision job for this trip,
    // THEN take `trips`, THEN decide. The worker claims with
    // `... FOR UPDATE OF j SKIP LOCKED`, so once we hold these row locks a
    // claim racing us skips the row instead of leasing it in the window
    // between our check and our cancel — without the lock, a job claimed in
    // that window would be cancelled here while its worker kept provisioning,
    // and generatePlan would then queue a second one. `live` is computed
    // against the DB clock in the same statement so a job that is genuinely
    // in flight is never cancelled from under its worker. A worker finishing
    // (`_complete`) holds its job row first, so this statement queues behind
    // it (and re-evaluates the WHERE once it commits: a now-`succeeded` job
    // drops out) instead of holding `trips` while the worker waits for it.
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
    const lockedJobIds = new Set(provisionJobs.rows.map((j) => j.id));

    // 2. `trips` LAST of the contended rows. The existence and state checks
    // are made HERE, under this lock, so the decision is taken under it.
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

    // Refused BEFORE anything is superseded. generatePlan would refuse this intake
    // anyway — and by then a live trip would already have lost its plan and been
    // reverted to intake_confirmed, by a retry that could never succeed.
    const latestIntake = await client.query<{ data: AnswerStore | null }>(
      "SELECT data FROM control_plane.intake_versions WHERE trip_id = $1 ORDER BY version DESC LIMIT 1",
      [tripId],
    );
    const latest = latestIntake.rows[0];
    if (latest && hasAnswers(latest.data) && organizerMatch(latest.data).kind !== "matched") {
      await client.query("ROLLBACK");
      return { ok: false, reason: "ORGANIZER_NOT_ON_ROSTER" };
    }

    if (provisionJobs.rows.some((j) => j.live)) {
      await client.query("ROLLBACK");
      return { ok: false, reason: "PROVISION_IN_PROGRESS" };
    }

    // 3. A PLAIN re-read of the non-terminal provision jobs, now that `trips`
    // is held (never a second FOR UPDATE: that would lock `jobs` after
    // `trips` and reopen the deadlock — trip-clear.ts, LOCK ORDER step 4).
    // A job that was created between the locking read above and the `trips`
    // lock committed under a concurrent generatePlan, which itself locks
    // `trips`; it is a job we did not lock, so we must not cancel it (its
    // worker could be claiming it right now, holding the job and waiting on
    // our `trips` lock) and must not supersede its plan out from under it.
    // Refuse, as for any in-flight provision.
    const reread = await client.query<{ id: string }>(
      `SELECT id FROM control_plane.jobs
       WHERE trip_id = $1 AND job_type = 'provision'
         AND state NOT IN ('succeeded', 'failed', 'cancelled')`,
      [tripId],
    );
    if (reread.rows.some((j) => !lockedJobIds.has(j.id))) {
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

/**
 * CONFIRMING THE INTAKE IS THE APPROVAL.
 *
 * The organizer tapping "אישור" on the recap has approved their trip. Sending
 * them to a web app afterwards to approve the same thing again is a second
 * decision about the first one, and it is the reason a finished interview sat
 * with no plan and no job: the interview ended, and provisioning waited for a
 * button in a SPA that is not deployed.
 *
 * Deliberately the SAME two calls the route makes — `generatePlan` then
 * `issueApproval` — rather than a second path into provisioning. The identity
 * question the route answers with a login is already answered here: the confirm
 * arrived on the organizer's own bound chat, which is how every other write in
 * this interview is authorised.
 *
 * Failure is a value. A trip whose plan could not be created is still a
 * confirmed intake, and the organizer has been told their site is being built —
 * so this reports rather than throws, and the caller decides what to say.
 */
export async function provisionOnConfirm(
  db: pg.Pool,
  tripId: string,
  userId: string,
  approvalTtlSeconds = 3600,
): Promise<{ ok: true; planId: string } | { ok: false; stage: "plan" | "approve"; reason: string }> {
  const plan = await generatePlan(db, tripId, generateId("corr"));
  if (!plan.ok) return { ok: false, stage: "plan", reason: plan.reason };
  const approved = await issueApproval(db, plan.planId, `user:${userId}`, approvalTtlSeconds);
  if (!approved.ok) return { ok: false, stage: "approve", reason: approved.reason };
  return { ok: true, planId: plan.planId };
}
