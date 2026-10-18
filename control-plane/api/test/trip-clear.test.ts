/**
 * The operator's force-clear (issue #378): what it reports before touching
 * anything, what it actually does, the one guard it keeps regardless of
 * force, and that the archive it writes first is actually restorable.
 *
 * Round 8 scope cut (2026-10-15): this capability now refuses outright,
 * unconditionally, for any trip it can see was EVER provisioned — see
 * trip-clear.ts's own module doc. Most of this file's fixtures are
 * therefore deliberately NEVER-provisioned (no job past queued, no chat
 * binding, no group-binding token); a separate block of tests proves the
 * EVER_PROVISIONED refusal itself, for each of its three signals and for
 * the races round 7/8 found.
 *
 * Fixtures are synthetic (raw inserts for sessions/turns/versions/bindings/
 * tokens/jobs), not a real interview or a real provision — the issue's own
 * done-when criteria calls for synthetic fixtures across five lifecycle
 * states, not an end-to-end run through every upstream flow.
 */
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { test, describe, before, beforeEach, after } from "node:test";
import { fileURLToPath } from "node:url";
import pg from "pg";
import { buildApp } from "../src/app.js";
import { validateArchitectureProfile } from "../src/config.js";
import { applyMigrations } from "../src/migrations.js";
import { inviteOrganizer } from "../src/organizer-invite.js";
import {
  SESSION_CASCADE_TABLES,
  executeClear,
  previewClear,
  restoreFromArchive,
} from "../src/trip-clear.js";
import { testDatabaseUrl, testPool } from "./support/test-database.js";

const DB_URL = testDatabaseUrl();
const SKIP = !DB_URL;
const migrationsDir = fileURLToPath(new URL("../../db/migrations/", import.meta.url));

const CONFIG = { enrollmentTtlSeconds: 86400 };
const BOT = "Kinerary_bot";

function address(): string {
  return `clear-${Math.random().toString(36).slice(2, 10)}@example.test`;
}

function id(prefix: string): string {
  return `${prefix}_${randomBytes(16).toString("hex")}`;
}

function sha256ish(): string {
  return `sha256:${randomBytes(32).toString("hex")}`;
}

interface Extras {
  session?: boolean;
  turn?: boolean;
  interpretation?: boolean;
  pendingChange?: boolean;
  confirmedVersion?: boolean;
  openBinding?: boolean;
  hermesProfile?: string;
  /** Additional open bindings beyond the first, each its own profile — F5. */
  extraProfiles?: string[];
  liveGroupToken?: boolean;
  /** EVER_PROVISIONED signal 1: a job past queued/waiting_for_user_action. */
  provisioned?: boolean;
  /** jobs.state for the synthetic provision job — defaults to 'succeeded'. */
  jobState?: string;
  interviewBinding?: boolean;
  /**
   * JOB_IN_PROGRESS (boundary review round 3): a non-terminal job of this
   * exact state, with a real plan behind it (and a real, valid
   * plan_approval once the state implies one has been issued —
   * `generatePlan` creates the job in `waiting_for_user_action` BEFORE any
   * approval exists; `queued`/`leased` only happen after one does).
   */
  nonTerminalJob?: "queued" | "leased" | "waiting_for_user_action";
}

/**
 * Creates a real trip (through `inviteOrganizer`, same as organizer-invite's
 * own fixtures) at a given lifecycle state, with whichever synthetic rows the
 * test asks for layered on top.
 */
async function makeTrip(pool: pg.Pool, lifecycleState: string, extras: Extras = {}): Promise<{
  tripId: string;
  intakeVersionId: string | null;
  nonTerminalJobId: string | null;
}> {
  const invited = await inviteOrganizer(pool, { email: address(), botUsername: BOT, invitedBy: "test" }, CONFIG);
  assert.equal(invited.ok, true);
  if (!invited.ok) throw new Error("unreachable");
  const { tripId, userId } = invited;

  const enrollment = await pool.query<{ id: string }>(
    "SELECT id FROM control_plane.interview_enrollments WHERE trip_id = $1", [tripId]);
  const enrollmentId = enrollment.rows[0]!.id;

  let sessionId: string | null = null;
  if (extras.session || extras.turn || extras.confirmedVersion || extras.interpretation
      || extras.pendingChange || extras.interviewBinding) {
    sessionId = id("sess");
    await pool.query(
      `INSERT INTO control_plane.intake_sessions (id, trip_id, user_id, enrollment_id, state, answers)
       VALUES ($1, $2, $3, $4, 'interviewing', '{}'::jsonb)`,
      [sessionId, tripId, userId, enrollmentId],
    );
  }

  if (extras.turn && sessionId) {
    await pool.query(
      `INSERT INTO control_plane.interview_agent_turns (id, chat_id, session_id, expires_at)
       VALUES ($1, $2, $3, now() + interval '5 minutes')`,
      [id("turn"), `${100000000 + Math.floor(Math.random() * 1e8)}`, sessionId],
    );
  }

  // F1: the two tables DELETE FROM intake_sessions cascades to.
  if (extras.interpretation && sessionId) {
    await pool.query(
      `INSERT INTO control_plane.interview_interpretations
         (id, session_id, telegram_chat_id, burst_key, source_text, proposals, outcomes)
       VALUES ($1, $2, $3, $4, $5, '[]'::jsonb, '{}'::jsonb)`,
      [id("interp"), sessionId, "555", id("burst"), "severe peanut allergy, carries an EpiPen"],
    );
  }
  if (extras.pendingChange && sessionId) {
    await pool.query(
      `INSERT INTO control_plane.intake_pending_changes
         (id, session_id, trip_id, base, ops, result, preview, unresolved)
       VALUES ($1, $2, $3, '{}'::jsonb, '[]'::jsonb, '{}'::jsonb, '[]'::jsonb, '[]'::jsonb)`,
      [id("pend"), sessionId, tripId],
    );
  }
  // F3: a still-open router binding to this session blocks deleting it.
  if (extras.interviewBinding && sessionId) {
    await pool.query(
      `INSERT INTO control_plane.telegram_interview_bindings (chat_id, trip_id, session_id, state)
       VALUES ($1, $2, $3, 'active')`,
      [`${200000000 + Math.floor(Math.random() * 1e8)}`, tripId, sessionId],
    );
  }

  let intakeVersionId: string | null = null;
  if (extras.confirmedVersion) {
    intakeVersionId = id("iv");
    await pool.query(
      `INSERT INTO control_plane.intake_versions (id, trip_id, version, artifact_ref, digest, confirmed_at)
       VALUES ($1, $2, 1, 'test-artifact', $3, now())`,
      [intakeVersionId, tripId, sha256ish()],
    );
  }

  async function openBinding(profile: string): Promise<void> {
    await pool.query(
      `INSERT INTO control_plane.telegram_chat_bindings (id, chat_id, trip_id, hermes_profile)
       VALUES ($1, $2, $3, $4)`,
      [id("tcb"), `-${100000000 + Math.floor(Math.random() * 1e8)}`, tripId, profile],
    );
  }

  if (extras.openBinding || extras.hermesProfile) {
    // A profile name unique to THIS trip unless the caller explicitly wants
    // to share one (the profile-shared-guard test) — two unrelated fixtures
    // defaulting to the same literal would otherwise trip that guard on each
    // other.
    await openBinding(extras.hermesProfile ?? `profile-${randomBytes(6).toString("hex")}`);
  }
  // F5: a trip can have MORE than one open binding (e.g. a DM and a group),
  // each potentially naming a different profile — the guard has to check all
  // of them, not just the newest.
  for (const profile of extras.extraProfiles ?? []) {
    await openBinding(profile);
  }

  if (extras.liveGroupToken) {
    await pool.query(
      `INSERT INTO control_plane.telegram_group_binding_tokens
         (id, trip_id, token_digest, issued_to_telegram_user_id, expires_at)
       VALUES ($1, $2, $3, '555', now() + interval '7 days')`,
      [id("gbt"), tripId, randomBytes(16).toString("hex")],
    );
  }

  if (extras.provisioned) {
    const planId = id("plan");
    await pool.query(
      `INSERT INTO control_plane.plans (id, trip_id, kind, digest, status, desired)
       VALUES ($1, $2, 'provision', $3, 'executed', '{}'::jsonb)`,
      [planId, tripId, sha256ish()],
    );
    const state = extras.jobState ?? "succeeded";
    // jobs' own CHECK: state <> 'failed' OR safe_error_code IS NOT NULL.
    const safeErrorCode = state === "failed" ? "PROVISION_TEST_FAILURE" : null;
    await pool.query(
      `INSERT INTO control_plane.jobs
         (id, trip_id, plan_id, job_type, idempotency_key, correlation_id, state, safe_error_code)
       VALUES ($1, $2, $3, 'provision', $4, $5, $6, $7)`,
      [id("job"), tripId, planId, id("idem"), id("corr"), state, safeErrorCode],
    );
  }

  // JOB_IN_PROGRESS (boundary review round 3): a job in exactly the
  // requested non-terminal state, with a real plan behind it.
  let nonTerminalJobId: string | null = null;
  if (extras.nonTerminalJob) {
    const planId = id("plan");
    const digest = sha256ish();
    const planStatus = extras.nonTerminalJob === "waiting_for_user_action" ? "pending_approval" : "approved";
    await pool.query(
      `INSERT INTO control_plane.plans (id, trip_id, kind, digest, status, desired)
       VALUES ($1, $2, 'provision', $3, $4, '{}'::jsonb)`,
      [planId, tripId, digest, planStatus],
    );
    nonTerminalJobId = id("job");
    if (extras.nonTerminalJob === "leased") {
      await pool.query(
        `INSERT INTO control_plane.jobs
           (id, trip_id, plan_id, job_type, idempotency_key, correlation_id, state, lease_owner, lease_expires_at)
         VALUES ($1, $2, $3, 'provision', $4, $5, 'leased', 'test-worker', now() + interval '5 minutes')`,
        [nonTerminalJobId, tripId, planId, id("idem"), id("corr")],
      );
    } else {
      await pool.query(
        `INSERT INTO control_plane.jobs
           (id, trip_id, plan_id, job_type, idempotency_key, correlation_id, state)
         VALUES ($1, $2, $3, 'provision', $4, $5, $6)`,
        [nonTerminalJobId, tripId, planId, id("idem"), id("corr"), extras.nonTerminalJob],
      );
    }
    // `queued`/`leased` only happen once an approval has actually been
    // issued; `waiting_for_user_action` (generatePlan's own starting state,
    // confirmed by reading planner.ts) precedes any approval existing.
    if (extras.nonTerminalJob !== "waiting_for_user_action") {
      await pool.query(
        `INSERT INTO control_plane.plan_approvals
           (id, plan_id, plan_digest, token_digest, issued_by, expires_at)
         VALUES ($1, $2, $3, $4, 'test:operator', now() + interval '1 day')`,
        [id("appr"), planId, digest, sha256ish()],
      );
    }
  }

  await pool.query("UPDATE control_plane.trips SET lifecycle_state = $2 WHERE id = $1", [tripId, lifecycleState]);
  return { tripId, intakeVersionId, nonTerminalJobId };
}

describe("the operator's force-clear", { skip: SKIP ? "no CONTROL_PLANE_TEST_DATABASE_URL" : false }, () => {
  let pool: pg.Pool;

  before(async () => {
    pool = testPool();
    const client = await pool.connect();
    try { await applyMigrations(client, migrationsDir); } finally { client.release(); }
  });

  after(async () => { await pool.end(); });

  beforeEach(async () => {
    // inviteOrganizer's own rate limit counts every invitation in the last
    // hour, across the whole suite — organizer-invite.test.ts resets the
    // same way for the same reason.
    await pool.query("DELETE FROM control_plane.organizer_invitations");
  });

  test("preview reports an accurate plan for a trip that was never provisioned", async () => {
    const cases: Array<[string, Extras]> = [
      ["draft", {}],
      ["intake_in_progress", { session: true, turn: true }],
      ["intake_confirmed", { session: true, turn: true, confirmedVersion: true }],
    ];
    for (const [state, extras] of cases) {
      const { tripId, intakeVersionId } = await makeTrip(pool, state, extras);
      const preview = await previewClear(pool, tripId);
      assert.equal(preview.ok, true, `${state}: ${JSON.stringify(preview)}`);
      if (!preview.ok) continue;
      assert.equal(preview.plan.lifecycleState, state);
      assert.equal(preview.plan.intakeSessions, extras.session || extras.turn || extras.confirmedVersion ? 1 : 0);
      assert.equal(preview.plan.interviewAgentTurns, extras.turn ? 1 : 0);
      assert.equal(preview.plan.confirmedIntakeVersions, extras.confirmedVersion ? 1 : 0);
      assert.equal(preview.plan.openChatBindings, 0);
      assert.equal(preview.plan.liveGroupBindingTokens, 0);
      assert.equal(preview.plan.everProvisioned, false);
      assert.equal(preview.plan.openInterviewBindings, 0);
      assert.ok(preview.plan.acceptableConfirmations.includes(preview.plan.slug));
      if (intakeVersionId) assert.ok(preview.plan.acceptableConfirmations.includes(intakeVersionId));
    }
  });

  test("execute archives, then revokes the interview layer, for a past-draft trip", async () => {
    const { tripId, intakeVersionId } = await makeTrip(pool, "intake_confirmed",
      { session: true, turn: true, confirmedVersion: true, interpretation: true, pendingChange: true });

    const result = await executeClear(pool, tripId, intakeVersionId as string, "test:operator");
    assert.equal(result.ok, true, JSON.stringify(result));
    if (!result.ok) return;

    // Archived first. F1: the two tables intake_sessions cascades to must be
    // captured too, verbatim text and all — not just intake_sessions itself.
    const archive = await pool.query(
      "SELECT trip_id, slug_at_archive, lifecycle_state_at_archive, payload FROM control_plane.trip_clear_archives WHERE id = $1",
      [result.archiveId]);
    assert.equal(archive.rows[0]?.trip_id, tripId);
    assert.equal(archive.rows[0]?.lifecycle_state_at_archive, "intake_confirmed");
    assert.equal(archive.rows[0]?.payload.intake_sessions.length, 1);
    assert.equal(archive.rows[0]?.payload.interview_agent_turns.length, 1);
    assert.equal(archive.rows[0]?.payload.intake_versions.length, 1);
    assert.equal(archive.rows[0]?.payload.interview_interpretations.length, 1);
    assert.equal(archive.rows[0]?.payload.interview_interpretations[0].source_text,
      "severe peanut allergy, carries an EpiPen");
    assert.equal(archive.rows[0]?.payload.intake_pending_changes.length, 1);

    // Interview/intake layer reset — the cascade actually ran, not just the
    // archive.
    const sessions = await pool.query("SELECT count(*)::int AS n FROM control_plane.intake_sessions WHERE trip_id = $1", [tripId]);
    assert.equal(sessions.rows[0].n, 0);
    // The session that owned this interpretation is gone (cascade-deleted),
    // so it can no longer be found by joining through intake_sessions — the
    // archived id (captured above, before the delete) is what proves the
    // specific row is actually gone, scoped to this trip rather than an
    // unscoped count across every trip's interpretations.
    const interpretationId = archive.rows[0]?.payload.interview_interpretations[0].id;
    const interpretations = await pool.query(
      "SELECT count(*)::int AS n FROM control_plane.interview_interpretations WHERE id = $1", [interpretationId]);
    assert.equal(interpretations.rows[0].n, 0);
    const pendingChanges = await pool.query("SELECT count(*)::int AS n FROM control_plane.intake_pending_changes WHERE trip_id = $1", [tripId]);
    assert.equal(pendingChanges.rows[0].n, 0);
    const turns = await pool.query(
      `SELECT count(*)::int AS n FROM control_plane.interview_agent_turns t
         JOIN control_plane.intake_sessions s ON s.id = t.session_id WHERE s.trip_id = $1`, [tripId]);
    assert.equal(turns.rows[0].n, 0);
    const enrollments = await pool.query(
      "SELECT state FROM control_plane.interview_enrollments WHERE trip_id = $1", [tripId]);
    assert.ok(enrollments.rows.every((r) => r.state === "revoked"));

    // Intake version is archived, never deleted — it is immutable history.
    const versions = await pool.query("SELECT count(*)::int AS n FROM control_plane.intake_versions WHERE trip_id = $1", [tripId]);
    assert.equal(versions.rows[0].n, 1);

    const trip = await pool.query("SELECT slug, lifecycle_state FROM control_plane.trips WHERE id = $1", [tripId]);
    assert.equal(trip.rows[0].lifecycle_state, "draft");
    assert.match(trip.rows[0].slug, /^retired-/);
    assert.equal(result.slugAfter, trip.rows[0].slug);

    const audit = await pool.query(
      "SELECT action, target_ref, evidence FROM control_plane.audit_events WHERE action = 'operator.clear_trip' AND target_ref = $1",
      [tripId]);
    assert.equal(audit.rows[0]?.evidence.archiveId, result.archiveId);
    assert.equal(audit.rows[0]?.evidence.ok, true);
  });

  test("F3: an open router/agent binding to a session refuses cleanly, not a raw 500", async () => {
    const { tripId } = await makeTrip(pool, "intake_in_progress", { interviewBinding: true });

    const preview = await previewClear(pool, tripId);
    assert.equal(preview.ok, false);
    if (preview.ok) return;
    assert.equal(preview.reason, "OPEN_INTERVIEW_BINDING");

    const result = await executeClear(pool, tripId, preview.plan!.slug, "test:operator");
    assert.equal(result.ok, false);
    if (result.ok) return;
    assert.equal(result.reason, "OPEN_INTERVIEW_BINDING");

    // Refused cleanly before touching anything — no archive, no mutation.
    const archives = await pool.query("SELECT count(*)::int AS n FROM control_plane.trip_clear_archives WHERE trip_id = $1", [tripId]);
    assert.equal(archives.rows[0].n, 0);
    const sessions = await pool.query("SELECT count(*)::int AS n FROM control_plane.intake_sessions WHERE trip_id = $1", [tripId]);
    assert.equal(sessions.rows[0].n, 1, "the session must still be there — nothing was deleted");
  });

  test("F5: with no binding at all, the guard falls back to the slug's own alphanumeric form", async () => {
    // Trip A has NEVER had a chat binding — teardown-trip.py's own fallback
    // (`bound or "".join(... isalnum())`) still derives a profile name for
    // it from the slug, because a profile directory can exist under that
    // convention-derived name even before any binding row does.
    const { tripId: tripA, } = await makeTrip(pool, "draft", {});
    const tripAPreview = await previewClear(pool, tripA);
    assert.equal(tripAPreview.ok, true);
    if (!tripAPreview.ok) return;
    const fallbackProfile = tripAPreview.plan.slug.replace(/[^a-z0-9]/gi, "");
    assert.deepEqual(tripAPreview.plan.hermesProfiles, [fallbackProfile]);

    // Trip B's own open binding happens to use that exact derived name.
    await makeTrip(pool, "ready_private", { hermesProfile: fallbackProfile });

    const preview = await previewClear(pool, tripA);
    assert.equal(preview.ok, false);
    if (preview.ok) return;
    assert.equal(preview.reason, "PROFILE_SHARED_WITH_ANOTHER_TRIP");
  });

  test("a confirmation that does not match the trip is rejected, and nothing changes", async () => {
    const { tripId } = await makeTrip(pool, "intake_confirmed", { confirmedVersion: true });
    const before = await pool.query("SELECT slug, lifecycle_state FROM control_plane.trips WHERE id = $1", [tripId]);

    const wrongSlug = await executeClear(pool, tripId, "not-the-right-slug", "test:operator");
    assert.equal(wrongSlug.ok, false);
    if (wrongSlug.ok) return;
    assert.equal(wrongSlug.reason, "CONFIRMATION_MISMATCH");

    const blank = await executeClear(pool, tripId, "", "test:operator");
    assert.equal(blank.ok, false);
    if (blank.ok) return;
    assert.equal(blank.reason, "CONFIRMATION_REQUIRED");

    const after = await pool.query("SELECT slug, lifecycle_state FROM control_plane.trips WHERE id = $1", [tripId]);
    assert.deepEqual(after.rows[0], before.rows[0]);
    const archives = await pool.query("SELECT count(*)::int AS n FROM control_plane.trip_clear_archives WHERE trip_id = $1", [tripId]);
    assert.equal(archives.rows[0].n, 0);
  });

  test("the confirmed intake version id is accepted as well as the slug", async () => {
    const { tripId, intakeVersionId } = await makeTrip(pool, "intake_confirmed", { confirmedVersion: true });
    const result = await executeClear(pool, tripId, intakeVersionId as string, "test:operator");
    assert.equal(result.ok, true, JSON.stringify(result));
  });

  test("the profile-shared guard survives force — the one refusal that is never bypassed", async () => {
    // Trip A's OWN binding would itself trigger EVER_PROVISIONED (signal
    // 2 — see trip-clear.ts's own doc), so this test has to reach the
    // profile-shared collision the SAME way F5's fallback test does: trip A
    // has no binding of its own at all, and collides only through its
    // slug-derived fallback profile name matching trip B's real one.
    const { tripId: tripA } = await makeTrip(pool, "intake_confirmed", { confirmedVersion: true });
    const previewBefore = await previewClear(pool, tripA);
    assert.equal(previewBefore.ok, true);
    if (!previewBefore.ok) return;
    const fallbackProfile = previewBefore.plan.slug.replace(/[^a-z0-9]/gi, "");

    // A second, unrelated trip's OPEN binding to that same derived name.
    await makeTrip(pool, "ready_private", { hermesProfile: fallbackProfile });

    const preview = await previewClear(pool, tripA);
    assert.equal(preview.ok, false);
    if (preview.ok) return;
    assert.equal(preview.reason, "PROFILE_SHARED_WITH_ANOTHER_TRIP");
    assert.ok(preview.plan, "a refusal still carries the plan");

    const planSlug = preview.plan!.slug;
    const result = await executeClear(pool, tripA, planSlug, "test:operator");
    assert.equal(result.ok, false);
    if (result.ok) return;
    assert.equal(result.reason, "PROFILE_SHARED_WITH_ANOTHER_TRIP");

    // Nothing moved.
    const trip = await pool.query("SELECT lifecycle_state FROM control_plane.trips WHERE id = $1", [tripA]);
    assert.equal(trip.rows[0].lifecycle_state, "intake_confirmed");
  });

  test("a restore from the archive reverses everything execute did — deletes and mutations alike", async () => {
    const { tripId } = await makeTrip(pool, "intake_confirmed",
      { session: true, turn: true, confirmedVersion: true, interpretation: true, pendingChange: true });
    const before = await pool.query(
      "SELECT slug, lifecycle_state FROM control_plane.trips WHERE id = $1", [tripId]);

    const preview = await previewClear(pool, tripId);
    assert.equal(preview.ok, true);
    if (!preview.ok) return;
    const result = await executeClear(pool, tripId, preview.plan.slug, "test:operator");
    assert.equal(result.ok, true);
    if (!result.ok) return;

    const beforeRestore = await pool.query("SELECT count(*)::int AS n FROM control_plane.intake_sessions WHERE trip_id = $1", [tripId]);
    assert.equal(beforeRestore.rows[0].n, 0);

    const restored = await restoreFromArchive(pool, result.archiveId);
    assert.equal(restored.intake_sessions, 1);
    assert.equal(restored.interview_agent_turns, 1);
    assert.equal(restored.interview_interpretations, 1);
    assert.equal(restored.intake_pending_changes, 1);
    assert.equal(restored.trips, 1);
    assert.equal(restored.interview_enrollments, 1);
    assert.equal(restored.telegram_chat_bindings, 0, "this never-provisioned fixture has none");
    assert.equal(restored.telegram_group_binding_tokens, 0, "this never-provisioned fixture has none");

    // The deletes came back — including the two F1 cascade tables.
    const afterRestore = await pool.query("SELECT count(*)::int AS n FROM control_plane.intake_sessions WHERE trip_id = $1", [tripId]);
    assert.equal(afterRestore.rows[0].n, 1);
    const turnsRestored = await pool.query(
      `SELECT count(*)::int AS n FROM control_plane.interview_agent_turns t
         JOIN control_plane.intake_sessions s ON s.id = t.session_id WHERE s.trip_id = $1`, [tripId]);
    assert.equal(turnsRestored.rows[0].n, 1);
    const interpretationsRestored = await pool.query(
      `SELECT source_text FROM control_plane.interview_interpretations t
         JOIN control_plane.intake_sessions s ON s.id = t.session_id WHERE s.trip_id = $1`, [tripId]);
    assert.equal(interpretationsRestored.rows[0]?.source_text, "severe peanut allergy, carries an EpiPen");
    const pendingChangesRestored = await pool.query(
      "SELECT count(*)::int AS n FROM control_plane.intake_pending_changes WHERE trip_id = $1", [tripId]);
    assert.equal(pendingChangesRestored.rows[0].n, 1);

    // The mutations came back too: slug/lifecycle_state and enrollment state.
    const trip = await pool.query("SELECT slug, lifecycle_state FROM control_plane.trips WHERE id = $1", [tripId]);
    assert.deepEqual(trip.rows[0], before.rows[0]);
    const enrollments = await pool.query(
      "SELECT state FROM control_plane.interview_enrollments WHERE trip_id = $1", [tripId]);
    assert.ok(enrollments.rows.every((r) => r.state === "issued"));
  });

  test("restoreFromArchive also restores a chat binding and a group-binding token, mechanically — " +
    "the two tables a never-provisioned trip's own executeClear run can no longer exercise together " +
    "with the rest of the archive, now that having either one at all is EVER_PROVISIONED", async () => {
    // A trip whose binding/token a HAND-BUILT archive stands in for —
    // exactly the shape executeClear itself would have written before round
    // 8, when such a trip could still reach a successful clear. Proves
    // restoreFromArchive's own per-table logic for these two tables still
    // works, decoupled from executeClear's now-stricter gate.
    const { tripId } = await makeTrip(pool, "ready_private", { hermesProfile: `profile-${randomBytes(6).toString("hex")}` });
    const binding = await pool.query<{ id: string; closed_at: string | null; closed_reason: string | null }>(
      "SELECT id, closed_at, closed_reason FROM control_plane.telegram_chat_bindings WHERE trip_id = $1", [tripId]);
    const bindingBefore = binding.rows[0]!;
    await pool.query(
      `INSERT INTO control_plane.telegram_group_binding_tokens
         (id, trip_id, token_digest, issued_to_telegram_user_id, expires_at)
       VALUES ($1, $2, $3, '555', now() + interval '7 days')`,
      [id("gbt"), tripId, randomBytes(16).toString("hex")],
    );
    const token = await pool.query<{ id: string; expires_at: string }>(
      "SELECT id, expires_at FROM control_plane.telegram_group_binding_tokens WHERE trip_id = $1", [tripId]);
    const tokenBefore = token.rows[0]!;

    // Mutate both, exactly as executeClear's own CTE+UPDATE would.
    await pool.query(
      "UPDATE control_plane.telegram_chat_bindings SET closed_at = now(), closed_reason = 'operator_cleared' WHERE id = $1",
      [bindingBefore.id]);
    await pool.query(
      "UPDATE control_plane.telegram_group_binding_tokens SET expires_at = now() WHERE id = $1", [tokenBefore.id]);

    const archiveId = id("tca");
    await pool.query(
      `INSERT INTO control_plane.trip_clear_archives
         (id, trip_id, slug_at_archive, lifecycle_state_at_archive, payload, created_by)
       VALUES ($1, $2, 'test-slug', 'ready_private', $3::jsonb, 'test:operator')`,
      [archiveId, tripId, JSON.stringify({
        telegram_chat_bindings: [bindingBefore],
        telegram_group_binding_tokens: [tokenBefore],
      })],
    );

    const restored = await restoreFromArchive(pool, archiveId);
    assert.equal(restored.telegram_chat_bindings, 1);
    assert.equal(restored.telegram_group_binding_tokens, 1);

    const bindingAfter = await pool.query("SELECT closed_at FROM control_plane.telegram_chat_bindings WHERE id = $1", [bindingBefore.id]);
    assert.equal(bindingAfter.rows[0]?.closed_at, null, "restored back to open");
    const tokenAfter = await pool.query("SELECT expires_at > now() AS live FROM control_plane.telegram_group_binding_tokens WHERE id = $1", [tokenBefore.id]);
    assert.equal(tokenAfter.rows[0]?.live, true, "restored back to live");
  });

  test("F1: every table intake_sessions cascades to is in SESSION_CASCADE_TABLES — pg_constraint, not a hand-kept list", async () => {
    const cascades = await pool.query<{ child: string }>(
      `SELECT c.conrelid::regclass::text AS child
         FROM pg_constraint c
        WHERE c.confrelid = 'control_plane.intake_sessions'::regclass
          AND c.contype = 'f'
          AND c.confdeltype = 'c'`,
    );
    const discovered = cascades.rows.map((r) => r.child.replace(/^control_plane\./, "")).sort();
    assert.deepEqual(
      discovered,
      [...SESSION_CASCADE_TABLES].sort(),
      "a migration added a table that cascades from intake_sessions without teaching this file about it — " +
        "see trip-clear.ts's SESSION_CASCADE_TABLES",
    );
  });

  // ── EVER_PROVISIONED (boundary review round 7, scope cut round 8, ─────────
  // ── 2026-10-15) — each of the three durable signals, independently, ───────
  // ── and the two cases that must NOT trip it. ───────────────────────────────

  test("EVER_PROVISIONED does not fire for a genuinely clean, never-provisioned trip", async () => {
    const { tripId } = await makeTrip(pool, "draft", {});
    const preview = await previewClear(pool, tripId);
    assert.equal(preview.ok, true, JSON.stringify(preview));
    if (!preview.ok) return;
    assert.equal(preview.plan.everProvisioned, false);
  });

  test("EVER_PROVISIONED signal 1: a job that reached succeeded (via a real claim) refuses outright", async () => {
    const { tripId } = await makeTrip(pool, "ready_private", { confirmedVersion: true, provisioned: true });
    const preview = await previewClear(pool, tripId);
    assert.equal(preview.ok, false);
    if (preview.ok) return;
    assert.equal(preview.reason, "EVER_PROVISIONED");
    assert.equal(preview.plan!.everProvisioned, true);

    const result = await executeClear(pool, tripId, preview.plan!.slug, "test:operator");
    assert.equal(result.ok, false);
    if (result.ok) return;
    assert.equal(result.reason, "EVER_PROVISIONED");

    const archives = await pool.query("SELECT count(*)::int AS n FROM control_plane.trip_clear_archives WHERE trip_id = $1", [tripId]);
    assert.equal(archives.rows[0].n, 0, "no archive on a refusal");
    const trip = await pool.query("SELECT lifecycle_state FROM control_plane.trips WHERE id = $1", [tripId]);
    assert.equal(trip.rows[0].lifecycle_state, "ready_private", "nothing moved");
  });

  test("EVER_PROVISIONED signal 1: a provisioning job that failed (claimed then failed) still counts — " +
    "a half-built container/DNS/NPM host can exist with no SUCCEEDED job row to flag it", async () => {
    const { tripId } = await makeTrip(pool, "intake_confirmed",
      { confirmedVersion: true, provisioned: true, jobState: "failed" });
    const preview = await previewClear(pool, tripId);
    assert.equal(preview.ok, false);
    if (preview.ok) return;
    assert.equal(preview.reason, "EVER_PROVISIONED");
    assert.equal(preview.plan!.everProvisioned, true);
  });

  test("EVER_PROVISIONED signal 1: a job cancelled WITHOUT ever being claimed does not count", async () => {
    const { tripId } = await makeTrip(pool, "intake_confirmed",
      { confirmedVersion: true, provisioned: true, jobState: "cancelled" });
    const preview = await previewClear(pool, tripId);
    assert.equal(preview.ok, true, JSON.stringify(preview));
    if (!preview.ok) return;
    assert.equal(preview.plan.everProvisioned, false,
      "cancelled while never claimed (attempt = 0) is not provisioned — matches intake-correction.ts's/planner.ts's own cancellation");
  });

  test("EVER_PROVISIONED signal 1: a queued (never-claimed) job does NOT count — JOB_IN_PROGRESS is the refusal instead", async () => {
    const { tripId } = await makeTrip(pool, "draft", { provisioned: true, jobState: "queued" });
    const preview = await previewClear(pool, tripId);
    assert.equal(preview.ok, false);
    if (preview.ok) return;
    assert.equal(preview.reason, "JOB_IN_PROGRESS");
    assert.equal(preview.plan!.everProvisioned, false);
  });

  test("EVER_PROVISIONED signal 1: a leased job counts — reached before JOB_IN_PROGRESS's own check now", async () => {
    const { tripId, nonTerminalJobId } = await makeTrip(pool, "provisioning_approved", { nonTerminalJob: "leased" });
    assert.ok(nonTerminalJobId);
    const preview = await previewClear(pool, tripId);
    assert.equal(preview.ok, false);
    if (preview.ok) return;
    assert.equal(preview.reason, "EVER_PROVISIONED");

    const result = await executeClear(pool, tripId, preview.plan!.slug, "test:operator");
    assert.equal(result.ok, false);
    if (result.ok) return;
    assert.equal(result.reason, "EVER_PROVISIONED");
    const job = await pool.query("SELECT state FROM control_plane.jobs WHERE id = $1", [nonTerminalJobId]);
    assert.equal(job.rows[0]?.state, "leased", "nothing touched");
  });

  test("EVER_PROVISIONED signal 2: any chat binding ever existing counts, even one that is now closed", async () => {
    const { tripId } = await makeTrip(pool, "intake_confirmed", { confirmedVersion: true, openBinding: true });
    await pool.query(
      "UPDATE control_plane.telegram_chat_bindings SET closed_at = now(), closed_reason = 'test' WHERE trip_id = $1",
      [tripId]);
    const preview = await previewClear(pool, tripId);
    assert.equal(preview.ok, false);
    if (preview.ok) return;
    assert.equal(preview.reason, "EVER_PROVISIONED");
    assert.equal(preview.plan!.everProvisioned, true);
    // openChatBindings itself (the live-only count) correctly reads 0 — this
    // trip's binding IS closed — but everProvisioned still fires, because
    // it asks "ever", not "still".
    assert.equal(preview.plan!.openChatBindings, 0);
  });

  test("EVER_PROVISIONED signal 3: any group-binding token ever existing counts, even one that has expired", async () => {
    const { tripId } = await makeTrip(pool, "intake_confirmed", { confirmedVersion: true });
    // Inserted already-expired (telegram_group_binding_tokens_window's own
    // CHECK requires expires_at > created_at, so both are backdated) rather
    // than reusing the liveGroupToken extra and mutating it afterward.
    await pool.query(
      `INSERT INTO control_plane.telegram_group_binding_tokens
         (id, trip_id, token_digest, issued_to_telegram_user_id, created_at, expires_at)
       VALUES ($1, $2, $3, '555', now() - interval '2 days', now() - interval '1 day')`,
      [id("gbt"), tripId, randomBytes(16).toString("hex")],
    );
    const preview = await previewClear(pool, tripId);
    assert.equal(preview.ok, false);
    if (preview.ok) return;
    assert.equal(preview.reason, "EVER_PROVISIONED");
    assert.equal(preview.plan!.everProvisioned, true);
    assert.equal(preview.plan!.liveGroupBindingTokens, 0, "expired, so the live-only count reads 0 — everProvisioned still fires");
  });

  // Signal 4 (boundary review round 12, 2026-10-15): round 8's own scope-cut
  // decision named this signal from the start ("a job ever claimed, a chat
  // binding ever existing, a group token ever existing, OR the trip ever
  // reaching ready_private or beyond") but it was never actually wired into
  // everProvisioned()'s SQL — harmless on every real code path (nothing in
  // this repo sets lifecycle_state that far without going through the job
  // pathway signal 1 already covers), but a real fail-safe gap against the
  // decision as stated, closed here.
  for (const state of ["provisioning", "ready_private", "activation_approved", "active", "completed", "sealed"]) {
    test(`EVER_PROVISIONED signal 4: lifecycle_state = '${state}' counts on its own, with no job/binding/token row at all`, async () => {
      const { tripId } = await makeTrip(pool, state, {});
      const preview = await previewClear(pool, tripId);
      assert.equal(preview.ok, false, `${state}: ${JSON.stringify(preview)}`);
      if (preview.ok) return;
      assert.equal(preview.reason, "EVER_PROVISIONED");
      assert.equal(preview.plan!.everProvisioned, true);
    });
  }

  test("EVER_PROVISIONED signal 4 does NOT fire for any of the six pre-provisioning lifecycle states, " +
    "with no job/binding/token row either", async () => {
    for (const state of ["pending_signup_approval", "draft", "intake_in_progress", "intake_confirmed", "planned", "provisioning_approved"]) {
      const { tripId } = await makeTrip(pool, state, {});
      const preview = await previewClear(pool, tripId);
      assert.equal(preview.ok, true, `${state}: ${JSON.stringify(preview)}`);
    }
  });

  test("EVER_PROVISIONED fires before PROFILE_SHARED_WITH_ANOTHER_TRIP, even when the trip's own binding " +
    "would otherwise trigger the profile-shared guard (the guard is now reached, in practice, only through " +
    "the no-binding fallback — see trip-clear.ts's own doc for why)", async () => {
    const sharedProfile = `shared-${randomBytes(4).toString("hex")}`;
    const ownProfile = `own-${randomBytes(4).toString("hex")}`;
    const { tripId: tripA } = await makeTrip(pool, "intake_confirmed",
      { confirmedVersion: true, hermesProfile: ownProfile, extraProfiles: [sharedProfile] });
    await makeTrip(pool, "ready_private", { hermesProfile: sharedProfile });

    const preview = await previewClear(pool, tripA);
    assert.equal(preview.ok, false);
    if (preview.ok) return;
    // Both refusals are true of this trip (it has two bindings of its own,
    // AND one of them collides with trip B) — EVER_PROVISIONED wins because
    // it is checked first, unconditionally, in both previewClear and
    // executeClear.
    assert.equal(preview.reason, "EVER_PROVISIONED");
  });

  // ── R4-2 (boundary review round 5): the reorder that closed R4-1 — ──────────
  // ── locking `trips` before `jobs` — deadlocked against four real ───────────
  // ── transactions that all lock something else before `trips`. These four ───
  // ── tests hold each one's own pre-trips lock open on a second connection, ───
  // ── fire `executeClear` concurrently, and confirm neither side ever sees ────
  // ── a 40P01 — only a normal wait, then both reaching a consistent outcome. ──

  test("R4-2: does not deadlock against the worker's own _complete shape (jobs, approvals, plans, trips) — " +
    "and, round 8, correctly ends in EVER_PROVISIONED once the claim it was waiting on actually commits", async () => {
    const { tripId, nonTerminalJobId } = await makeTrip(pool, "provisioning_approved", { nonTerminalJob: "queued" });
    const planRow = await pool.query<{ id: string }>("SELECT plan_id AS id FROM control_plane.jobs WHERE id = $1", [nonTerminalJobId]);
    const planId = planRow.rows[0]!.id;
    const holder = await pool.connect();
    try {
      const preview = await previewClear(pool, tripId);
      const confirmValue = preview.plan!.slug;

      await holder.query("BEGIN");
      // The worker's own claim (job-queue.ts's claimJob / provisioner.py's
      // _claim) — transitions the job to 'leased' BEFORE _complete's own
      // first lock runs. Starting this fixture 'queued' (not 'leased')
      // matters under round 8: EVER_PROVISIONED's signal 1 deliberately does
      // NOT fire for a queued, never-claimed job (see trip-clear.ts), so a
      // 'queued' start is what lets this test actually reach — and exercise
      // — the lock order below, rather than being refused before ever
      // opening a transaction.
      await holder.query(
        `SELECT j.id FROM control_plane.jobs j
           JOIN control_plane.plans p ON p.id = j.plan_id
           JOIN control_plane.plan_approvals pa ON pa.plan_id = j.plan_id
           JOIN control_plane.trips t ON t.id = j.trip_id
          WHERE j.trip_id = $1 AND j.state = 'queued'
          FOR UPDATE OF j, pa, t SKIP LOCKED`,
        [tripId],
      );
      await holder.query(
        `UPDATE control_plane.jobs SET state = 'leased', lease_owner = 'r42-worker',
                lease_expires_at = now() + interval '5 minutes', attempt = attempt + 1
          WHERE id = $1`,
        [nonTerminalJobId]);
      // _complete's own first lock: the now-leased job itself.
      await holder.query(
        "UPDATE control_plane.jobs SET state = 'succeeded', updated_at = now() WHERE id = $1 AND state = 'leased'",
        [nonTerminalJobId]);

      let settled = false;
      const clearPromise = executeClear(pool, tripId, confirmValue, "test:operator").then((r) => { settled = true; return r; });
      await new Promise((resolve) => setTimeout(resolve, 250));
      assert.equal(settled, false, "clear must block on the job row _complete already holds, not deadlock");

      // _complete's own remaining steps, then commit — exactly its order.
      await holder.query("UPDATE control_plane.plan_approvals SET used_at = now() WHERE plan_id = $1 AND used_at IS NULL", [planId]);
      await holder.query("UPDATE control_plane.plans SET status = 'executed', updated_at = now() WHERE id = $1 AND status = 'approved'", [planId]);
      await holder.query("UPDATE control_plane.trips SET lifecycle_state = 'ready_private', updated_at = now() WHERE id = $1", [tripId]);
      await holder.query("COMMIT");

      // No 40P01 on either side: the worker's build genuinely succeeded...
      const job = await pool.query("SELECT state FROM control_plane.jobs WHERE id = $1", [nonTerminalJobId]);
      assert.equal(job.rows[0]?.state, "succeeded", "the worker's own success commit must survive, not be lost to a deadlock");

      // ...and clear, unblocked, now correctly refuses outright: the trip
      // left never-provisioned scope the instant the worker's claim
      // committed, which this function's broadened EARLY pass (locking —
      // and re-evaluating EVER_PROVISIONED against — EVERY job row, not
      // only non-terminal ones) is what catches.
      const result = await clearPromise;
      assert.equal(result.ok, false, JSON.stringify(result));
      if (result.ok) return;
      assert.equal(result.reason, "EVER_PROVISIONED");
      const archives = await pool.query("SELECT count(*)::int AS n FROM control_plane.trip_clear_archives WHERE trip_id = $1", [tripId]);
      assert.equal(archives.rows[0].n, 0, "no archive on a refusal, even one discovered mid-transaction");
    } finally {
      holder.release();
    }
  });

  test("R4-2: does not deadlock against startSession's shape (enrollment, then trips)", async () => {
    const { tripId } = await makeTrip(pool, "draft", {});
    const enrollment = await pool.query<{ id: string }>(
      "SELECT id FROM control_plane.interview_enrollments WHERE trip_id = $1", [tripId]);
    const enrollmentId = enrollment.rows[0]!.id;
    const holder = await pool.connect();
    try {
      const preview = await previewClear(pool, tripId);
      const confirmValue = preview.plan!.slug;

      await holder.query("BEGIN");
      // startSession's own first lock: consumeEnrollmentInTx's FOR UPDATE.
      await holder.query("SELECT id FROM control_plane.interview_enrollments WHERE id = $1 FOR UPDATE", [enrollmentId]);

      let settled = false;
      const clearPromise = executeClear(pool, tripId, confirmValue, "test:operator").then((r) => { settled = true; return r; });
      await new Promise((resolve) => setTimeout(resolve, 250));
      assert.equal(settled, false, "clear must block on the enrollment row startSession already holds, not deadlock");

      await holder.query("UPDATE control_plane.interview_enrollments SET state = 'consumed', consumed_at = now() WHERE id = $1", [enrollmentId]);
      await holder.query("SELECT lifecycle_state FROM control_plane.trips WHERE id = $1 FOR UPDATE", [tripId]);
      await holder.query("UPDATE control_plane.trips SET lifecycle_state = 'intake_in_progress', updated_at = now() WHERE id = $1", [tripId]);
      await holder.query("COMMIT");

      const result = await clearPromise;
      assert.equal(result.ok, true, JSON.stringify(result));
    } finally {
      holder.release();
    }
  });

  test("R4-2: does not deadlock against confirmIntakeVia's shape (session, then trips)", async () => {
    const { tripId } = await makeTrip(pool, "intake_in_progress", { session: true });
    const session = await pool.query<{ id: string }>("SELECT id FROM control_plane.intake_sessions WHERE trip_id = $1", [tripId]);
    const sessionId = session.rows[0]!.id;
    const holder = await pool.connect();
    try {
      const preview = await previewClear(pool, tripId);
      const confirmValue = preview.plan!.slug;

      await holder.query("BEGIN");
      // confirmIntakeVia's own first lock: lockSession's FOR UPDATE.
      await holder.query("SELECT id FROM control_plane.intake_sessions WHERE id = $1 FOR UPDATE", [sessionId]);

      let settled = false;
      const clearPromise = executeClear(pool, tripId, confirmValue, "test:operator").then((r) => { settled = true; return r; });
      await new Promise((resolve) => setTimeout(resolve, 250));
      assert.equal(settled, false, "clear must block on the session row confirmIntakeVia already holds, not deadlock");

      await holder.query("UPDATE control_plane.intake_sessions SET state = 'confirmed', updated_at = now() WHERE id = $1", [sessionId]);
      await holder.query("SELECT lifecycle_state FROM control_plane.trips WHERE id = $1 FOR UPDATE", [tripId]);
      await holder.query("UPDATE control_plane.trips SET lifecycle_state = 'intake_confirmed', updated_at = now() WHERE id = $1", [tripId]);
      await holder.query("COMMIT");

      const result = await clearPromise;
      assert.equal(result.ok, true, JSON.stringify(result));
    } finally {
      holder.release();
    }
  });

  test("R4-2: does not deadlock against a portal plan-reject's shape (plan, then job, then trips)", async () => {
    const { tripId, nonTerminalJobId } = await makeTrip(pool, "planned", { nonTerminalJob: "waiting_for_user_action" });
    const planRow = await pool.query<{ id: string }>("SELECT plan_id AS id FROM control_plane.jobs WHERE id = $1", [nonTerminalJobId]);
    const planId = planRow.rows[0]!.id;
    const holder = await pool.connect();
    try {
      const preview = await previewClear(pool, tripId);
      const confirmValue = preview.plan!.slug;

      await holder.query("BEGIN");
      // portal reject's own first two locks: plan, then its job.
      await holder.query("UPDATE control_plane.plans SET status = 'superseded', updated_at = now() WHERE id = $1 AND status = 'pending_approval'", [planId]);
      await holder.query("UPDATE control_plane.jobs SET state = 'cancelled', updated_at = now() WHERE plan_id = $1 AND state = 'waiting_for_user_action'", [planId]);

      let settled = false;
      const clearPromise = executeClear(pool, tripId, confirmValue, "test:operator").then((r) => { settled = true; return r; });
      await new Promise((resolve) => setTimeout(resolve, 250));
      assert.equal(settled, false, "clear must block on the job row the reject already holds, not deadlock");

      await holder.query("UPDATE control_plane.trips SET lifecycle_state = 'intake_confirmed', updated_at = now() WHERE id = $1", [tripId]);
      await holder.query("COMMIT");

      const result = await clearPromise;
      // Cancelled while still waiting_for_user_action (never claimed —
      // attempt stays 0) does not count toward EVER_PROVISIONED (signal 1's
      // own exclusion, see trip-clear.ts), so this still succeeds.
      assert.equal(result.ok, true, JSON.stringify(result));
    } finally {
      holder.release();
    }
  });

  test("a trip that finished provisioning successfully before clear cannot hit a stale-plan replan collision (G3)", async () => {
    // generatePlan always creates the plan and its job in the SAME
    // transaction (planner.ts), and completeJob/provisioner.py's success
    // path always retires the plan to 'executed' in the SAME transaction as
    // the job's own terminal state (job-queue.ts) — confirmed by reading
    // both, not assumed. So a plan in 'pending_approval'/'approved' always
    // has a non-terminal job behind it, which JOB_IN_PROGRESS already
    // catches; the only way a plan reaches a CLEARED trip at all is already
    // 'executed', which does not collide with generatePlan's own
    // `status IN ('pending_approval', 'approved')` check.
    const { tripId } = await makeTrip(pool, "ready_private", { confirmedVersion: true, provisioned: true });
    const plan = await pool.query("SELECT status FROM control_plane.plans WHERE trip_id = $1", [tripId]);
    assert.equal(plan.rows[0]?.status, "executed");

    const activePlan = await pool.query(
      "SELECT 1 FROM control_plane.plans WHERE trip_id = $1 AND status IN ('pending_approval', 'approved')", [tripId]);
    assert.equal(activePlan.rows.length, 0,
      "generatePlan's own PLAN_ALREADY_PENDING check reads exactly this — an 'executed' plan never matches it");
  });

  test("N2: the no-binding fallback strips the retired-...-YYYYMMDD shape the way teardown-trip.py's original_slug() does", async () => {
    const { tripId } = await makeTrip(pool, "intake_confirmed", { confirmedVersion: true });
    const before = await previewClear(pool, tripId);
    assert.equal(before.ok, true);
    if (!before.ok) return;
    const originalFallback = before.plan.hermesProfiles[0];

    // Simulate what this trip's slug looks like AFTER teardown-trip.py (or
    // an earlier clear) has already retired it once.
    const retiredSlug = `retired-${before.plan.slug}-20261013`;
    await pool.query("UPDATE control_plane.trips SET slug = $2 WHERE id = $1", [tripId, retiredSlug]);

    const after = await previewClear(pool, tripId);
    assert.equal(after.ok, true);
    if (!after.ok) return;
    assert.deepEqual(after.plan.hermesProfiles, [originalFallback],
      "the fallback must still derive from the ORIGINAL slug, not the retired- prefixed one");
  });

  test("F3's refusal does not imply closing the binding is sufficient (the FK ignores state)", async () => {
    const { tripId } = await makeTrip(pool, "intake_in_progress", { interviewBinding: true });
    // A revoked binding still blocks the FK — state is irrelevant to it.
    await pool.query("UPDATE control_plane.telegram_interview_bindings SET state = 'revoked' WHERE trip_id = $1", [tripId]);

    const preview = await previewClear(pool, tripId);
    assert.equal(preview.ok, false);
    if (preview.ok) return;
    assert.equal(preview.reason, "OPEN_INTERVIEW_BINDING");
    assert.doesNotMatch(preview.detail, /close the\s*$/i, "must not imply closing/revoking the binding resolves this");
    assert.doesNotMatch(preview.detail, /\bclose\b/i, "must not name 'close' as the remedy — the FK ignores state");
  });

  // JOB_IN_PROGRESS (boundary review round 3, 2026-10-13). Narrows what used
  // to be N1's "cancel queued jobs" approach to a hard refusal for ANY
  // non-terminal job that EVER_PROVISIONED does not already claim for itself
  // (round 8) — in practice now just `queued` and `waiting_for_user_action`.
  // No override exists for either.
  for (const state of ["queued", "waiting_for_user_action"] as const) {
    test(`JOB_IN_PROGRESS: a ${state} job refuses the whole clear — no archive, no mutation`, async () => {
      const { tripId, nonTerminalJobId } = await makeTrip(pool, "provisioning_approved", { nonTerminalJob: state });
      assert.ok(nonTerminalJobId);

      const preview = await previewClear(pool, tripId);
      assert.equal(preview.ok, false);
      if (preview.ok) return;
      assert.equal(preview.reason, "JOB_IN_PROGRESS");
      assert.match(preview.detail, new RegExp(state));

      const confirmValue = preview.plan!.slug;
      const result = await executeClear(pool, tripId, confirmValue, "test:operator");
      assert.equal(result.ok, false);
      if (result.ok) return;
      assert.equal(result.reason, "JOB_IN_PROGRESS");
      assert.match(result.detail, new RegExp(state));

      // Nothing proceeded: no archive row, the job and trip untouched.
      const archives = await pool.query("SELECT count(*)::int AS n FROM control_plane.trip_clear_archives WHERE trip_id = $1", [tripId]);
      assert.equal(archives.rows[0].n, 0);
      const job = await pool.query("SELECT state FROM control_plane.jobs WHERE id = $1", [nonTerminalJobId]);
      assert.equal(job.rows[0]?.state, state);
      const trip = await pool.query("SELECT lifecycle_state FROM control_plane.trips WHERE id = $1", [tripId]);
      assert.equal(trip.rows[0].lifecycle_state, "provisioning_approved");
    });
  }

  test("JOB_IN_PROGRESS: a terminal job never triggers it — succeeded/failed now correctly trigger " +
    "EVER_PROVISIONED instead (round 8), and cancelled-without-claim lets clear through", async () => {
    for (const state of ["succeeded", "failed"]) {
      const { tripId } = await makeTrip(pool, "intake_confirmed", { confirmedVersion: true, provisioned: true, jobState: state });
      const preview = await previewClear(pool, tripId);
      assert.equal(preview.ok, false, `${state}: ${JSON.stringify(preview)}`);
      if (preview.ok) continue;
      assert.notEqual(preview.reason, "JOB_IN_PROGRESS", `${state} is terminal — JOB_IN_PROGRESS must not fire`);
      assert.equal(preview.reason, "EVER_PROVISIONED", `${state}: only reachable via a real claim`);
    }
    const { tripId: cancelledTripId } = await makeTrip(pool, "intake_confirmed",
      { confirmedVersion: true, provisioned: true, jobState: "cancelled" });
    const cancelledPreview = await previewClear(pool, cancelledTripId);
    assert.equal(cancelledPreview.ok, true,
      `cancelled (never claimed): ${JSON.stringify(cancelledPreview)}`);
  });

  test("JOB_IN_PROGRESS: the locked check closes the race a worker's own claim could otherwise win (G1-race) — " +
    "round 8: the claim landing means EVER_PROVISIONED, not JOB_IN_PROGRESS, is the refusal clear ends on", async () => {
    const { tripId } = await makeTrip(pool, "provisioning_approved", { nonTerminalJob: "queued" });
    const holder = await pool.connect();
    try {
      await holder.query("BEGIN");
      // Mirrors the worker's own claim lock exactly — job-queue.ts's
      // claimJob / provisioner.py's _claim, both `FOR UPDATE OF j, pa, t
      // SKIP LOCKED`. Held open, uncommitted, to simulate a claim that is
      // genuinely mid-flight.
      await holder.query(
        `SELECT j.id FROM control_plane.jobs j
           JOIN control_plane.plans p ON p.id = j.plan_id
           JOIN control_plane.plan_approvals pa ON pa.plan_id = j.plan_id
           JOIN control_plane.trips t ON t.id = j.trip_id
          WHERE j.trip_id = $1 AND j.state = 'queued'
          FOR UPDATE OF j, pa, t SKIP LOCKED`,
        [tripId],
      );

      // A preview taken right now (unlocked) still reports the truth, since
      // nothing has changed yet from its point of view — but it is execute's
      // locked read that this test is actually about.
      const previewForConfirm = await previewClear(pool, tripId);
      const confirmValue = previewForConfirm.plan!.slug;

      let settled = false;
      const clearPromise = executeClear(pool, tripId, confirmValue, "test:operator").then((r) => {
        settled = true;
        return r;
      });

      // While the claim's lock is held, execute's own `SELECT ... FOR UPDATE`
      // (no SKIP LOCKED — it must see the real outcome, not skip past it)
      // blocks on that row rather than reading a stale "still queued" value.
      await new Promise((resolve) => setTimeout(resolve, 250));
      assert.equal(settled, false, "execute must block on the held lock, not race past it");

      // The claim lands: the job becomes leased, and the holder commits —
      // exactly what a real worker's claim does next.
      await holder.query(
        `UPDATE control_plane.jobs SET state = 'leased', lease_owner = 'race-test-worker',
                lease_expires_at = now() + interval '5 minutes'
          WHERE trip_id = $1 AND state = 'queued'`,
        [tripId],
      );
      await holder.query("COMMIT");

      const result = await clearPromise;
      assert.equal(result.ok, false,
        "clear must see the claim's real outcome once unblocked, never a stale 'nothing pending' read");
      if (result.ok) return;
      // Round 8: 'leased' is itself an EVER_PROVISIONED signal (the job was
      // claimed), reached by the SAME broadened, locked EARLY pass that used
      // to only check for JOB_IN_PROGRESS.
      assert.equal(result.reason, "EVER_PROVISIONED");
    } finally {
      holder.release();
    }
  });

  // ── R6-2 (boundary review round 6) — live reproduction of the exact ────────
  // ── timing bug: a write that lands while clear is waiting on the session ───
  // ── lock must still be the version captured in the archive. ────────────────

  test("R6-2: an answer written while clear waits on the session lock is still captured in the archive", async () => {
    const { tripId } = await makeTrip(pool, "intake_in_progress", { session: true });
    const session = await pool.query<{ id: string; answers: unknown }>(
      "SELECT id, answers FROM control_plane.intake_sessions WHERE trip_id = $1", [tripId]);
    const sessionId = session.rows[0]!.id;
    const holder = await pool.connect();
    try {
      const preview = await previewClear(pool, tripId);
      const confirmValue = preview.plan!.slug;

      // Mirrors `lockSession` exactly — the same lock `submitAnswer`/
      // `confirmIntakeVia` take before writing an answer.
      await holder.query("BEGIN");
      await holder.query("SELECT id FROM control_plane.intake_sessions WHERE id = $1 FOR UPDATE", [sessionId]);

      let settled = false;
      const clearPromise = executeClear(pool, tripId, confirmValue, "test:operator").then((r) => { settled = true; return r; });
      await new Promise((resolve) => setTimeout(resolve, 250));
      assert.equal(settled, false, "clear must block on the session lock, not read past it");

      // The write that must survive into the archive — typed DURING the wait.
      const newAnswers = { allergy: { kind: "text", schema_version: 3, text: "severe peanut allergy, typed during clear" } };
      await holder.query("UPDATE control_plane.intake_sessions SET answers = $2, updated_at = now() WHERE id = $1",
        [sessionId, JSON.stringify(newAnswers)]);
      await holder.query("COMMIT");

      const result = await clearPromise;
      assert.equal(result.ok, true, JSON.stringify(result));
      if (!result.ok) return;

      const archive = await pool.query("SELECT payload FROM control_plane.trip_clear_archives WHERE id = $1", [result.archiveId]);
      const archivedSession = (archive.rows[0]?.payload.intake_sessions as Array<{ id: string; answers: unknown }>)
        .find((s) => s.id === sessionId);
      assert.ok(archivedSession, "the session must still be in the archive at all");
      assert.deepEqual(archivedSession!.answers, newAnswers,
        "the archive must hold the answer written DURING the wait, not a stale pre-wait read");
    } finally {
      holder.release();
    }
  });

  // ── R7-4 (boundary review round 7, fixed round 8) — a row for a table ─────
  // ── this function mutates, INSERTed by a different session while this ─────
  // ── call is paused mid-wait on something else entirely, must be caught — ──
  // ── as EVER_PROVISIONED now, not silently archived-and-mutated past. ──────

  test("R7-4: a chat binding inserted for this trip while clear waits on the session lock is caught " +
    "as EVER_PROVISIONED, not silently destroyed", async () => {
    const { tripId } = await makeTrip(pool, "intake_in_progress", { session: true });
    const session = await pool.query<{ id: string }>("SELECT id FROM control_plane.intake_sessions WHERE trip_id = $1", [tripId]);
    const sessionId = session.rows[0]!.id;
    const holder = await pool.connect();
    try {
      const preview = await previewClear(pool, tripId);
      assert.equal(preview.ok, true, "clean at the start — no signal has fired yet");
      const confirmValue = preview.plan!.slug;

      await holder.query("BEGIN");
      await holder.query("SELECT id FROM control_plane.intake_sessions WHERE id = $1 FOR UPDATE", [sessionId]);

      let settled = false;
      const clearPromise = executeClear(pool, tripId, confirmValue, "test:operator").then((r) => { settled = true; return r; });
      await new Promise((resolve) => setTimeout(resolve, 250));
      assert.equal(settled, false, "clear must block on the session lock before it ever reaches the bindings step");

      // The round-7 reviewer's own reproduction, generalized: a SECOND
      // session's write lands while this one is paused mid-wait on
      // something else entirely. Before this fix, a later blind
      // `WHERE trip_id = $1` mutation could have silently destroyed this row
      // with no trace in the archive; after it, the single RETURNING-based
      // statement that would otherwise have missed it sees it instead.
      await holder.query(
        `INSERT INTO control_plane.telegram_chat_bindings (id, chat_id, trip_id, hermes_profile)
         VALUES ($1, $2, $3, $4)`,
        [id("tcb"), `-${900000000 + Math.floor(Math.random() * 1e8)}`, tripId, `profile-${randomBytes(6).toString("hex")}`],
      );
      await holder.query("UPDATE control_plane.intake_sessions SET updated_at = now() WHERE id = $1", [sessionId]);
      await holder.query("COMMIT");

      const result = await clearPromise;
      // Round 8: the NEW binding makes this trip provisioned (signal 2) —
      // clear correctly refuses outright rather than clearing past it.
      assert.equal(result.ok, false, JSON.stringify(result));
      if (result.ok) return;
      assert.equal(result.reason, "EVER_PROVISIONED");

      // Nothing committed: no archive, the session untouched, the new
      // binding exactly as the holder left it (the whole transaction rolled
      // back, not just the step that noticed the problem).
      const archives = await pool.query("SELECT count(*)::int AS n FROM control_plane.trip_clear_archives WHERE trip_id = $1", [tripId]);
      assert.equal(archives.rows[0].n, 0);
      const sessions = await pool.query("SELECT count(*)::int AS n FROM control_plane.intake_sessions WHERE trip_id = $1", [tripId]);
      assert.equal(sessions.rows[0].n, 1, "the session must still be there — the whole call rolled back");
      const bindings = await pool.query("SELECT closed_at FROM control_plane.telegram_chat_bindings WHERE trip_id = $1", [tripId]);
      assert.equal(bindings.rows[0]?.closed_at, null, "the new binding must be untouched, not closed by a rolled-back mutation");
    } finally {
      holder.release();
    }
  });

  // ── R8-1 (boundary review round 8, found AFTER round 8's own scope cut ────
  // ── shipped — a THIRD recurrence of the F1/R6-2/R7-4 archive-completeness ──
  // ── class, one level deeper: not a new SESSION, but a new CHILD of an ──────
  // ── EXISTING one, landing via an autocommit insert the OLD cascade-delete ──
  // ── (a live subquery, no lock of its own) never blocked against. ──────────

  test("R8-1: an interpretation inserted for an EXISTING session while clear holds that same session's " +
    "lock is still archived, not lost to the cascade", async () => {
    const { tripId } = await makeTrip(pool, "intake_in_progress", { session: true });
    const session = await pool.query<{ id: string }>("SELECT id FROM control_plane.intake_sessions WHERE trip_id = $1", [tripId]);
    const sessionId = session.rows[0]!.id;
    const holder = await pool.connect();
    try {
      const preview = await previewClear(pool, tripId);
      assert.equal(preview.ok, true);
      const confirmValue = preview.plan!.slug;

      // The holder takes the SAME lock clear's own session-lock-first step
      // (trip-clear.ts, R8-1) now takes — mirroring a real concurrent
      // `lockSession` call (confirmIntakeVia/submitAnswer's own lock).
      await holder.query("BEGIN");
      await holder.query("SELECT id FROM control_plane.intake_sessions WHERE id = $1 FOR UPDATE", [sessionId]);

      let settled = false;
      const clearPromise = executeClear(pool, tripId, confirmValue, "test:operator").then((r) => { settled = true; return r; });
      await new Promise((resolve) => setTimeout(resolve, 250));
      assert.equal(settled, false, "clear must block on the session lock, not race past it");

      // claimInterpretation's own real shape (interpret.ts): a single
      // autocommit INSERT, which the holder's OWN transaction can still do
      // against a session IT ALREADY HOLDS locked (no self-conflict) —
      // exactly how a real burst of organizer text would land mid-wait.
      await holder.query(
        `INSERT INTO control_plane.interview_interpretations
           (id, session_id, telegram_chat_id, burst_key, source_text, proposals, outcomes)
         VALUES ($1, $2, $3, $4, $5, '[]'::jsonb, '{}'::jsonb)`,
        [id("interp"), sessionId, "555", id("burst"), "typed while clear was waiting on the session lock"],
      );
      await holder.query("COMMIT");

      const result = await clearPromise;
      assert.equal(result.ok, true, JSON.stringify(result));
      if (!result.ok) return;

      // Archived, not silently cascaded away: the cascade-table delete only
      // runs AFTER clear itself acquires the session lock, by which point
      // the holder's insert has already committed — so it is exactly what
      // the archive captures and exactly what gets deleted, atomically.
      const archive = await pool.query("SELECT payload FROM control_plane.trip_clear_archives WHERE id = $1", [result.archiveId]);
      const archivedInterpretations = archive.rows[0]?.payload.interview_interpretations as Array<{ session_id: string; source_text: string }>;
      assert.ok(
        archivedInterpretations.some((r) => r.source_text === "typed while clear was waiting on the session lock"),
        "the interpretation inserted during the wait must be in the archive",
      );
      const interpretations = await pool.query(
        "SELECT count(*)::int AS n FROM control_plane.interview_interpretations WHERE session_id = $1", [sessionId]);
      assert.equal(interpretations.rows[0].n, 0, "and actually deleted, not left behind");
    } finally {
      holder.release();
    }
  });

  // ── R8-2 (boundary review round 8, found AFTER round 8's own scope cut ────
  // ── shipped) — a job created, claimed AND completed entirely within the ───
  // ── window between the EARLY jobs pass and the `trips` lock, invisible to ──
  // ── both until the new LATE authoritative re-check closed it. ─────────────

  test("R8-2: a job created, claimed and run to succeeded entirely while clear is blocked elsewhere " +
    "is still caught as EVER_PROVISIONED by the LATE authoritative re-check", async () => {
    const { tripId } = await makeTrip(pool, "draft", {});
    const enrollment = await pool.query<{ id: string }>(
      "SELECT id FROM control_plane.interview_enrollments WHERE trip_id = $1", [tripId]);
    const enrollmentId = enrollment.rows[0]!.id;
    const holder = await pool.connect();
    try {
      const preview = await previewClear(pool, tripId);
      assert.equal(preview.ok, true, "clean at the start — this trip has no job at all yet");
      const confirmValue = preview.plan!.slug;

      // Block clear on the ENROLLMENT lock — AFTER its own EARLY jobs pass
      // (which, with zero jobs existing yet, locks and sees nothing) but
      // BEFORE `trips`. This is precisely the window the reviewer's S1/S1b
      // reproduction targets: a job that does not exist yet when the EARLY
      // pass runs.
      await holder.query("BEGIN");
      await holder.query("SELECT id FROM control_plane.interview_enrollments WHERE id = $1 FOR UPDATE", [enrollmentId]);

      let settled = false;
      const clearPromise = executeClear(pool, tripId, confirmValue, "test:operator").then((r) => { settled = true; return r; });
      await new Promise((resolve) => setTimeout(resolve, 250));
      assert.equal(settled, false, "clear must block on the enrollment lock before it ever reaches jobs again");

      // A brand-new job, created, claimed AND completed — each a separate,
      // already-committed statement on a THIRD connection (not the holder,
      // which is still mid-transaction) — entirely while clear is paused.
      const third = await pool.connect();
      try {
        const planId = id("plan");
        const digest = sha256ish();
        await third.query(
          `INSERT INTO control_plane.plans (id, trip_id, kind, digest, status, desired)
           VALUES ($1, $2, 'provision', $3, 'approved', '{}'::jsonb)`,
          [planId, tripId, digest],
        );
        await third.query(
          `INSERT INTO control_plane.plan_approvals (id, plan_id, plan_digest, token_digest, issued_by, expires_at)
           VALUES ($1, $2, $3, $4, 'test:operator', now() + interval '1 day')`,
          [id("appr"), planId, digest, sha256ish()],
        );
        const jobId = id("job");
        await third.query(
          `INSERT INTO control_plane.jobs (id, trip_id, plan_id, job_type, idempotency_key, correlation_id, state)
           VALUES ($1, $2, $3, 'provision', $4, $5, 'queued')`,
          [jobId, tripId, planId, id("idem"), id("corr")],
        );
        // Claimed (attempt increments, exactly as job-queue.ts's claimJob
        // does) then run straight to succeeded.
        await third.query(
          "UPDATE control_plane.jobs SET state = 'leased', lease_owner = 'r82-worker', attempt = attempt + 1 WHERE id = $1",
          [jobId]);
        await third.query("UPDATE control_plane.jobs SET state = 'succeeded', updated_at = now() WHERE id = $1", [jobId]);
      } finally {
        third.release();
      }

      await holder.query("UPDATE control_plane.interview_enrollments SET state = 'consumed', consumed_at = now() WHERE id = $1", [enrollmentId]);
      await holder.query("SELECT lifecycle_state FROM control_plane.trips WHERE id = $1 FOR UPDATE", [tripId]);
      await holder.query("UPDATE control_plane.trips SET lifecycle_state = 'intake_in_progress', updated_at = now() WHERE id = $1", [tripId]);
      await holder.query("COMMIT");

      const result = await clearPromise;
      // Before the R8-2 fix, this would have returned ok: true — the EARLY
      // pass never saw this job (it did not exist yet), and the LATE pass
      // only asked "is there a non-terminal job" (succeeded is terminal, so
      // it would not have fired either).
      assert.equal(result.ok, false, JSON.stringify(result));
      if (result.ok) return;
      assert.equal(result.reason, "EVER_PROVISIONED");
      const archives = await pool.query("SELECT count(*)::int AS n FROM control_plane.trip_clear_archives WHERE trip_id = $1", [tripId]);
      assert.equal(archives.rows[0].n, 0, "no archive on a refusal, even one discovered this late");
      const trip = await pool.query("SELECT lifecycle_state, slug FROM control_plane.trips WHERE id = $1", [tripId]);
      assert.equal(trip.rows[0].lifecycle_state, "intake_in_progress", "the holder's own commit stands; clear itself changed nothing");
    } finally {
      holder.release();
    }
  });

  // ── Round 9 (boundary review on round 8's own R8-1/R8-2/R8-3 delta, ───────
  // ── 2026-10-15) — three more findings, all low severity / fail-safe, ──────
  // ── found while re-deriving R8-1/R8-2/R8-3 against the real schema. ───────

  test("F-R9-1: a real deadlock against openAgentTurn's own lock order is absorbed by one retry, " +
    "not surfaced as a raw error", async () => {
    // openAgentTurn (interview.ts) locks a turn row FIRST (closing any open
    // one for the chat), then an INSERT that takes an implicit KEY SHARE on
    // the session — child, then session. R8-1 made this function lock the
    // session FIRST, then its children — session, then child: the opposite
    // order. Reproduced here with the two sides interleaved so Postgres's
    // own deadlock detector genuinely has to choose a victim — this is not
    // simulating the error, it is causing the real one.
    const { tripId } = await makeTrip(pool, "intake_in_progress", { session: true, turn: true });
    const session = await pool.query<{ id: string }>("SELECT id FROM control_plane.intake_sessions WHERE trip_id = $1", [tripId]);
    const sessionId = session.rows[0]!.id;
    const openTurn = await pool.query<{ chat_id: string }>(
      "SELECT chat_id FROM control_plane.interview_agent_turns WHERE session_id = $1 AND closed_at IS NULL", [sessionId]);
    const chatId = openTurn.rows[0]!.chat_id;

    const preview = await previewClear(pool, tripId);
    assert.equal(preview.ok, true);
    if (!preview.ok) return;
    const confirmValue = preview.plan.slug;

    const holder = await pool.connect();
    try {
      // openAgentTurn's own first statement: locks the existing open turn.
      await holder.query("BEGIN");
      await holder.query(
        "UPDATE control_plane.interview_agent_turns SET closed_at = now() WHERE chat_id = $1 AND closed_at IS NULL",
        [chatId]);

      const clearPromise = executeClear(pool, tripId, confirmValue, "test:operator");

      // Give clear time to pass its (now session-first) lock and block on
      // THIS turn row during its cascade-table delete.
      await new Promise((resolve) => setTimeout(resolve, 250));

      // openAgentTurn's own second statement: an INSERT needing a KEY SHARE
      // on the session clear now holds `FOR UPDATE`. Fired without awaiting
      // yet, so both sides are genuinely in-flight and blocked on each
      // other at once — the actual deadlock condition, not two sequential
      // waits.
      const holderInsertPromise = holder.query(
        `INSERT INTO control_plane.interview_agent_turns (id, chat_id, session_id, expires_at)
         VALUES ($1, $2, $3, now() + interval '5 minutes')`,
        [id("turn"), chatId, sessionId],
      ).catch((e) => e);

      // Postgres's own deadlock_timeout (default 1s) needs to elapse before
      // its detector even looks — give it comfortable room.
      const holderOutcome = await Promise.race([
        holderInsertPromise,
        new Promise((resolve) => setTimeout(() => resolve("still-pending"), 4000)),
      ]);

      if (holderOutcome === "still-pending") {
        // Holder's insert never resolved — most likely clear was the
        // deadlock victim and already retried, successfully, without ever
        // needing holder's insert to finish first. Let holder finish its
        // (now-unblocked, since clear's retry uses a fresh client with no
        // conflicting lock yet, or the first attempt's lock was released on
        // its abort) own work and commit.
        await holderInsertPromise;
      } else if (holderOutcome instanceof Error) {
        // Holder was the deadlock's victim. Its transaction is dead;
        // nothing left to commit.
        await holder.query("ROLLBACK").catch(() => undefined);
      }
      if (!(holderOutcome instanceof Error)) {
        await holder.query("COMMIT").catch(() => undefined);
      }

      const result = await clearPromise;
      // The real assertion: whichever side Postgres picked as the deadlock
      // victim, the CALLER of executeClear never sees a thrown error or a
      // raw 40P01 — either clear's own retry absorbed it, or clear simply
      // was not the victim and finished normally once holder's conflicting
      // statement resolved one way or the other.
      assert.equal(result.ok, true, JSON.stringify(result));
    } finally {
      holder.release();
    }
  });

  test("F-R9-2: an intake version confirmed while clear waits elsewhere is still archived, not lost " +
    "to a stale early read", async () => {
    const { tripId } = await makeTrip(pool, "draft", {});
    const enrollment = await pool.query<{ id: string }>(
      "SELECT id FROM control_plane.interview_enrollments WHERE trip_id = $1", [tripId]);
    const enrollmentId = enrollment.rows[0]!.id;
    const holder = await pool.connect();
    try {
      const preview = await previewClear(pool, tripId);
      assert.equal(preview.ok, true);
      const confirmValue = preview.plan!.slug;

      // Block clear on the enrollment lock — AFTER the point an early,
      // once-only read of intake_versions would have already run, BEFORE
      // the point this fix moved that read to.
      await holder.query("BEGIN");
      await holder.query("SELECT id FROM control_plane.interview_enrollments WHERE id = $1 FOR UPDATE", [enrollmentId]);

      let settled = false;
      const clearPromise = executeClear(pool, tripId, confirmValue, "test:operator").then((r) => { settled = true; return r; });
      await new Promise((resolve) => setTimeout(resolve, 250));
      assert.equal(settled, false, "clear must block on the enrollment lock before it ever reaches trips");

      // A confirmed intake version, created on a THIRD connection, entirely
      // while clear is paused — intake_versions is never deleted, so this
      // is not a destructive race, only an archive-accuracy one.
      const third = await pool.connect();
      try {
        await third.query(
          `INSERT INTO control_plane.intake_versions (id, trip_id, version, artifact_ref, digest, confirmed_at)
           VALUES ($1, $2, 1, 'test-artifact', $3, now())`,
          [id("iv"), tripId, sha256ish()],
        );
      } finally {
        third.release();
      }

      await holder.query("UPDATE control_plane.interview_enrollments SET state = 'consumed', consumed_at = now() WHERE id = $1", [enrollmentId]);
      await holder.query("SELECT lifecycle_state FROM control_plane.trips WHERE id = $1 FOR UPDATE", [tripId]);
      await holder.query("UPDATE control_plane.trips SET lifecycle_state = 'intake_in_progress', updated_at = now() WHERE id = $1", [tripId]);
      await holder.query("COMMIT");

      const result = await clearPromise;
      assert.equal(result.ok, true, JSON.stringify(result));
      if (!result.ok) return;
      const archive = await pool.query("SELECT payload FROM control_plane.trip_clear_archives WHERE id = $1", [result.archiveId]);
      const archivedVersions = archive.rows[0]?.payload.intake_versions as Array<{ digest: string }>;
      assert.equal(archivedVersions.length, 1,
        "the version confirmed during the wait must be in the archive — before this fix, reading " +
        "intake_versions right after the early jobs pass would have archived zero");
    } finally {
      holder.release();
    }
  });

  test("F-R9-3: a brand-new session and enrollment created while clear waits on the EXISTING session's " +
    "lock is refused (UNREVOKED_SESSION), not left live on a retired slug", async () => {
    const { tripId } = await makeTrip(pool, "intake_in_progress", { session: true });
    const session = await pool.query<{ id: string; user_id: string }>(
      "SELECT id, user_id FROM control_plane.intake_sessions WHERE trip_id = $1", [tripId]);
    const sessionId = session.rows[0]!.id;
    const userId = session.rows[0]!.user_id;
    // The fixture's synthetic session (a raw INSERT, unlike the real
    // consumeEnrollmentInTx flow) leaves its enrollment 'issued' rather than
    // 'consumed'. Fixed here to match what a real session implies — and,
    // not incidentally, to avoid a SEPARATE Postgres wait this test does not
    // care about: `interview_enrollments_trip_issued_idx` (migration 0009)
    // is a partial unique index on `(trip_id) WHERE state = 'issued'`, so a
    // brand-new 'issued' enrollment for this trip would otherwise have to
    // wait for clear's OWN (uncommitted) enrollment-revoke UPDATE to resolve
    // before Postgres could tell whether it conflicts — which never happens
    // in this test, because that UPDATE is itself waiting on the session
    // lock below. Marking the existing enrollment 'consumed' up front keeps
    // it out of that partial index's predicate entirely, before or after
    // clear's own no-op UPDATE on it, so the new enrollment's insert is free
    // to proceed immediately, as the scenario intends.
    await pool.query(
      "UPDATE control_plane.interview_enrollments SET state = 'consumed', consumed_at = now() WHERE trip_id = $1",
      [tripId]);
    const holder = await pool.connect();
    try {
      const preview = await previewClear(pool, tripId);
      assert.equal(preview.ok, true);
      const confirmValue = preview.plan!.slug;

      await holder.query("BEGIN");
      await holder.query("SELECT id FROM control_plane.intake_sessions WHERE id = $1 FOR UPDATE", [sessionId]);

      let settled = false;
      const clearPromise = executeClear(pool, tripId, confirmValue, "test:operator").then((r) => { settled = true; return r; });
      await new Promise((resolve) => setTimeout(resolve, 250));
      assert.equal(settled, false, "clear must block on the existing session's lock before it reaches trips");

      // A brand-new enrollment AND session for the SAME trip, created on a
      // third connection while clear is paused on the OLD session's lock —
      // this is exactly what a fresh `fresh-interview.py` link (or a brand
      // new /start) would produce, landing after this function's own
      // session/enrollment steps already ran and finished.
      const third = await pool.connect();
      try {
        const newEnrollmentId = id("enr");
        await third.query(
          `INSERT INTO control_plane.interview_enrollments (id, trip_id, user_id, token_digest, state, expires_at)
           VALUES ($1, $2, $3, $4, 'issued', now() + interval '1 day')`,
          [newEnrollmentId, tripId, userId, sha256ish()],
        );
        const newSessionId = id("sess");
        await third.query(
          `INSERT INTO control_plane.intake_sessions (id, trip_id, user_id, enrollment_id, state, answers)
           VALUES ($1, $2, $3, $4, 'interviewing', '{}'::jsonb)`,
          [newSessionId, tripId, userId, newEnrollmentId],
        );
      } finally {
        third.release();
      }

      await holder.query("UPDATE control_plane.intake_sessions SET updated_at = now() WHERE id = $1", [sessionId]);
      await holder.query("COMMIT");

      const result = await clearPromise;
      // Before this fix: ok: true, with the new session and enrollment left
      // completely untouched — a live interview on a trip whose slug was
      // just retired.
      assert.equal(result.ok, false, JSON.stringify(result));
      if (result.ok) return;
      assert.equal(result.reason, "UNREVOKED_SESSION");

      const archives = await pool.query("SELECT count(*)::int AS n FROM control_plane.trip_clear_archives WHERE trip_id = $1", [tripId]);
      assert.equal(archives.rows[0].n, 0, "no archive on a refusal, even one discovered this late");
      const trip = await pool.query("SELECT lifecycle_state FROM control_plane.trips WHERE id = $1", [tripId]);
      assert.equal(trip.rows[0].lifecycle_state, "intake_in_progress", "nothing moved");
      const sessionsNow = await pool.query("SELECT count(*)::int AS n FROM control_plane.intake_sessions WHERE trip_id = $1", [tripId]);
      assert.equal(sessionsNow.rows[0].n, 2, "both the old and the new session must still exist — the whole transaction rolled back");
    } finally {
      holder.release();
    }
  });
});

describe("the operator's force-clear HTTP routes", { skip: SKIP ? "no CONTROL_PLANE_TEST_DATABASE_URL" : false }, () => {
  const KEY = "operator-key-for-clear-tests";
  const profile = validateArchitectureProfile({
    version: 1,
    environment: "test",
    public_api: { bind_host: "127.0.0.1", port: 4310 },
    worker: { queue: "postgres", health_bind_host: "127.0.0.1", health_port: 4311 },
    database: { connection_secret_ref: "env://CONTROL_PLANE_DATABASE_URL" },
    adapters: { compute: "fake", ingress: "fake", agent_runtime: "fake", messaging: "fake", secrets: "fake" },
    test_resources: { enabled: true, label_key: "kinerary.test_run_id", allowed_name_prefix: "kinerary-test-local" },
  });

  let pool: pg.Pool;

  before(async () => {
    pool = testPool();
    const client = await pool.connect();
    try { await applyMigrations(client, migrationsDir); } finally { client.release(); }
  });

  after(async () => { await pool.end(); });

  beforeEach(async () => {
    await pool.query("DELETE FROM control_plane.organizer_invitations");
  });

  function appWithOperator() {
    return buildApp(profile, {
      operator: { db: pool, apiKey: KEY, enrollmentTtlSeconds: 86400, botUsername: "Kinerary_bot" },
    });
  }

  test("without the key in the environment the routes are not there at all", async () => {
    const app = buildApp(profile, {});
    try {
      for (const url of ["/internal/operator/trips/trip_x/clear/preview", "/internal/operator/trips/trip_x/clear"]) {
        const response = await app.inject({ method: "POST", url, payload: {} });
        assert.equal(response.statusCode, 503);
        assert.equal(JSON.parse(response.body).error, "OPERATOR_NOT_CONFIGURED");
      }
    } finally {
      await app.close();
    }
  });

  test("a wrong key, an empty key and no key are all just refused", async () => {
    const { tripId } = await makeTrip(pool, "draft");
    const app = appWithOperator();
    try {
      for (const headers of [{}, { "x-api-key": "" }, { "x-api-key": "nope" }]) {
        const response = await app.inject({
          method: "POST", url: `/internal/operator/trips/${tripId}/clear`, headers, payload: { confirm: "x" },
        });
        assert.equal(response.statusCode, 401, JSON.stringify(headers));
      }
    } finally {
      await app.close();
    }
  });

  test("the interview agent's key does not open this door", async () => {
    const { tripId } = await makeTrip(pool, "draft");
    const app = buildApp(profile, {
      operator: { db: pool, apiKey: KEY, enrollmentTtlSeconds: 86400, botUsername: "Kinerary_bot" },
      interviewAgent: { db: pool, apiKey: "interview-agent-key" },
    });
    try {
      const response = await app.inject({
        method: "POST", url: `/internal/operator/trips/${tripId}/clear`,
        headers: { "x-api-key": "interview-agent-key" }, payload: { confirm: "x" },
      });
      assert.equal(response.statusCode, 401);
    } finally {
      await app.close();
    }
  });

  test("preview over HTTP returns the plan and mutates nothing", async () => {
    const { tripId } = await makeTrip(pool, "intake_confirmed", { confirmedVersion: true, session: true });
    const app = appWithOperator();
    try {
      const response = await app.inject({
        method: "POST", url: `/internal/operator/trips/${tripId}/clear/preview`,
        headers: { "x-api-key": KEY },
      });
      assert.equal(response.statusCode, 200);
      const body = JSON.parse(response.body);
      assert.equal(body.ok, true);
      assert.equal(body.plan.tripId, tripId);
      assert.equal(body.plan.intakeSessions, 1);

      const sessions = await pool.query("SELECT count(*)::int AS n FROM control_plane.intake_sessions WHERE trip_id = $1", [tripId]);
      assert.equal(sessions.rows[0].n, 1, "preview must not delete anything");
    } finally {
      await app.close();
    }
  });

  test("execute over HTTP with the right confirmation clears the trip", async () => {
    const { tripId, intakeVersionId } = await makeTrip(pool, "intake_confirmed", { confirmedVersion: true });
    const app = appWithOperator();
    try {
      const response = await app.inject({
        method: "POST", url: `/internal/operator/trips/${tripId}/clear`,
        headers: { "x-api-key": KEY }, payload: { confirm: intakeVersionId },
      });
      assert.equal(response.statusCode, 200, response.body);
      const body = JSON.parse(response.body);
      assert.equal(body.tripId, tripId);
      assert.ok(body.archiveId);
    } finally {
      await app.close();
    }
  });

  test("execute over HTTP with the wrong confirmation is a 409, and clears nothing", async () => {
    const { tripId } = await makeTrip(pool, "intake_confirmed", { confirmedVersion: true });
    const app = appWithOperator();
    try {
      const response = await app.inject({
        method: "POST", url: `/internal/operator/trips/${tripId}/clear`,
        headers: { "x-api-key": KEY }, payload: { confirm: "definitely-wrong" },
      });
      assert.equal(response.statusCode, 409);
      assert.equal(JSON.parse(response.body).error, "CONFIRMATION_MISMATCH");

      const trip = await pool.query("SELECT lifecycle_state FROM control_plane.trips WHERE id = $1", [tripId]);
      assert.equal(trip.rows[0].lifecycle_state, "intake_confirmed");
    } finally {
      await app.close();
    }
  });

  test("execute over HTTP for a provisioned trip is a 409 EVER_PROVISIONED", async () => {
    const { tripId } = await makeTrip(pool, "ready_private", { confirmedVersion: true, provisioned: true });
    const app = appWithOperator();
    try {
      const response = await app.inject({
        method: "POST", url: `/internal/operator/trips/${tripId}/clear`,
        headers: { "x-api-key": KEY }, payload: { confirm: "whatever" },
      });
      assert.equal(response.statusCode, 409);
      assert.equal(JSON.parse(response.body).error, "EVER_PROVISIONED");
    } finally {
      await app.close();
    }
  });
});
