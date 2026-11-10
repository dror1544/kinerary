/**
 * The operator's force-clear: revoke a trip's interview/intake layer and the
 * DB-reachable half of its infrastructure bindings, in an archive-first
 * transaction — but SCOPED, UNCONDITIONALLY, to a trip that was NEVER
 * provisioned (issue #378; scope cut 2026-10-15, Dror's decision after
 * boundary review round 7 — full writeup: issue #378's own comment thread;
 * the deferred provisioned-trip capability is #390).
 *
 * WHY THIS EXISTS. Two scripts already do something like this, and both
 * refuse on purpose: `scripts/fresh-interview.py` refuses a trip past
 * `intake_in_progress` or with a confirmed intake version ("an intake version
 * is immutable by design... there is no --force"); `scripts/teardown-trip.py`
 * refuses a trip past `ready_private` ("real people have used it"). Neither
 * refusal is a bug — they are there so a convenience script cannot discard a
 * real organizer's answers or tear down a live site by accident. But there is
 * no production path for a deliberate, reviewed override of either one for a
 * trip that never reached either real-person stage, and Dror's decision on
 * this issue is to build one. The two bypassed guardrails are named here and
 * in the handover, not quietly removed.
 *
 * WHY "NEVER PROVISIONED" IS THE WHOLE SCOPE NOW, NOT A SPECIAL CASE OF A
 * BIGGER ONE. Seven rounds of boundary review (F1-F7, N1/N2, G1-G3, R4-1,
 * R4-2, R6-1, R6-2 — see git history and issue #378 for each) all closed
 * cleanly for a trip with no job past `queued`, no chat binding, no
 * group-binding token. Every round from R6 onward kept finding a NEW edge of
 * one DIFFERENT, structural problem instead: a provisioned trip's
 * companion-attach phase (`provisioner.py`'s `_attach_companion`) runs for
 * MINUTES entirely OUTSIDE any database transaction — there is no row for
 * this file to lock, because what is racing against it is a live SSH session
 * and a Hermes profile directory on disk, not a committed row. R6-1's
 * notification/token race, R7-2's finding that `_attach_companion` is itself
 * a fourth, untracked producer of exactly the state this file exists to
 * protect, and R7-3's regression (an R6-1 fix attempt that broke
 * `relay/dispatch.ts`'s `/group` command and `intake-correction.ts`'s own
 * `ready_private`-correction flow) are three symptoms of that one fact, not
 * three bugs to keep patching separately. Dror's call: split the provisioned
 * case into its own, differently-shaped capability (#390) rather than keep
 * iterating on Postgres locks against something that is not in Postgres at
 * all for most of its duration.
 *
 * So: `previewClear` and `executeClear` both refuse, UNCONDITIONALLY and
 * with NO override, any trip this process can see EVER was provisioned —
 * see `everProvisioned` below for the four durable signals this checks and
 * why each is deliberately over-inclusive rather than exact. Everything else
 * in this file protects a trip this check lets through (never provisioned)
 * from the two scripts' own refusals, exactly as it did before round 8.
 *
 * ONE GUARDRAIL SURVIVES REGARDLESS OF FORCE: `teardown-trip.py`'s "profile
 * named by another trip's open binding" check (`resolve()`'s `shared` query).
 * Every other refusal in both scripts protects THIS trip's own data from
 * being discarded — which is exactly what an operator invoking "force clear"
 * is asking for. This one protects a DIFFERENT trip (whichever one still
 * holds that Hermes profile with an open chat binding) from having its
 * companion's profile pulled out from under it. Bypassing it would corrupt a
 * trip nobody asked to touch, so `executeClear` keeps it unconditionally.
 *
 * WHAT IS — AND IS NOT — REACHABLE FROM THIS PROCESS. Everything in this file
 * is a `control_plane` Postgres mutation, because that is the only thing
 * `control-plane/api` can reach. For a NEVER-provisioned trip that is also
 * everything there is to undo: no container, no DNS record, no NPM host, no
 * Hermes profile or gateway conversation was ever created for it, so there is
 * nothing physical this file is leaving outstanding — unlike the provisioned
 * case this file now refuses outright (see #390 for that one).
 *
 * WHAT GETS ARCHIVED AND WHAT GETS DELETED. `executeClear` writes one
 * `trip_clear_archives` row — a full snapshot of every `control_plane` table
 * this operation touches or removes rows from — in the SAME transaction as
 * the mutation, before any destructive statement commits. `intake_versions`
 * rows are archived but never deleted: they are not in `fresh-interview.py`'s
 * own mutation list (it never reaches a trip that has one), and keeping them
 * preserves the "an intake version is immutable" invariant even inside an
 * operation whose whole point is overriding the REFUSAL that invariant used
 * to imply. Everything else this reset touches — enrollments and sessions
 * (plus whatever `intake_sessions` cascades to, not only the session row
 * itself — see `SESSION_CASCADE_TABLES`'s own doc, F1, boundary review
 * 2026-10-13) — is archived AND THEN deleted or revoked, because those are
 * the rows that made the two scripts' refusals necessary in the first
 * place.
 *
 * CORRECTED, boundary review round 12, 2026-10-15: this used to also name
 * chat bindings and group-binding tokens as archived-then-closed/revoked.
 * Since round 8's EVER_PROVISIONED refusal, that is no longer what happens
 * on a SUCCESSFUL clear: either table having ANY row for this trip is
 * itself one of EVER_PROVISIONED's four signals (see that check's own
 * doc), so a clear that reaches the point of actually committing has
 * ALREADY confirmed both tables are empty for this trip. The CTE-based
 * capture-and-conditionally-mutate statements for both still exist in the
 * code (so the archive/mutation logic is exercised and correct if this
 * ever changes), but on every path that reaches `COMMIT`, both capture
 * zero rows and revoke/close nothing — belt and suspenders, not the normal
 * case this paragraph used to describe.
 *
 * EVERY ARCHIVED ROW IS CAPTURED BY THE SAME STATEMENT THAT MUTATES IT — NOT
 * A SEPARATE READ, LOCKED OR NOT (R7-4, boundary review round 7, 2026-10-14,
 * fixed round 8). R6-2 already closed one version of this gap: an earlier
 * version of this function read its archive "up front," an UNLOCKED read,
 * which round 6 found stale when this function then had to WAIT on a row's
 * lock. The fix at the time — `SELECT * ... FOR UPDATE` immediately before
 * each table's own mutation, as a SEPARATE statement right before the
 * UPDATE/DELETE — closed THAT gap but opened a narrower one: a `SELECT *
 * FROM x WHERE trip_id = $1 FOR UPDATE` only locks rows that ALREADY EXIST.
 * It locks (and so captures) nothing for a trip with zero rows in that table
 * yet. If a brand-new row for this trip is INSERTed by a different session
 * in the gap between that SELECT and the FOLLOWING statement — a real gap:
 * each is its own round trip, even inside one already-open transaction — the
 * later `UPDATE ... WHERE trip_id = $1` / `DELETE ... WHERE trip_id = $1`
 * matches it BLINDLY, by `trip_id`, not by the specific ids the SELECT
 * captured. That row is destroyed or mutated having never been archived at
 * all — reproduced live by the round-7 reviewer: a second session's INSERT,
 * committed while this function was paused mid-wait on an unrelated lock,
 * was gone with no trace in the archive once `executeClear` returned `ok`.
 *
 * The fix (CORRECTED, boundary review round 12, 2026-10-15 — the original
 * wording here overclaimed): most tables are captured by ONE statement — a
 * `DELETE ... RETURNING *` for a table rows are removed from, or a CTE-based
 * `UPDATE ... FROM (SELECT * ... FOR UPDATE) ... RETURNING <the CTE's own
 * columns>` for a table only some rows of are mutated (the CTE supplies the
 * PRE-mutation values `RETURNING` needs — Postgres's own `RETURNING` on an
 * `UPDATE` always reflects the row AFTER the `SET`, so capturing the
 * "before" value requires joining back to a value read as part of the SAME
 * statement, not a separate earlier one). `trips` and `intake_sessions` are
 * each genuinely TWO statements (lock-by-id, then mutate-by-the-SAME-locked-
 * id-list) — still race-free, because the id list a LATER statement uses to
 * scope its `WHERE` is exactly what the EARLIER, locking statement already
 * returned, never a blind `trip_id` re-match (see those two statements' own
 * inline comments, and R8-1 below for why `intake_sessions` needed this
 * shape specifically). The pattern that actually matters, everywhere in
 * this function, is: whatever scopes a mutation is EITHER the same statement
 * that mutates it, OR an id list a lock already fixed earlier in the SAME
 * transaction — never a plain `trip_id` re-match computed independently of
 * what got locked. The cascade tables (R8-1, further below) resolve their
 * own `session_id` scope the second way: against the id list `intake_sessions
 * WHERE trip_id = $1 FOR UPDATE` already locked and returned, not a live
 * subquery computed fresh at delete time. `trip_memberships`, `intake_
 * versions` and `organizer_invitations` are the standing exception: this
 * function never mutates any of the three, so a plain read (taken late —
 * F-R9-2, further below) carries no such window regardless.
 *
 * Also fixed here (the reviewer's "minor" half of the same finding): the
 * archive's own `slug_at_archive`/`lifecycle_state_at_archive` columns now
 * come from the LOCKED `trips` row this function itself reads inside its
 * transaction, not from `buildPlan`'s earlier, unlocked, pre-transaction
 * read — a trip renamed or transitioned between those two reads would
 * otherwise archive the WRONG pre-clear slug/state.
 *
 * The SAME locked reads for group-binding tokens and chat bindings do double
 * duty, round 8: right after each, if ANY row was found, `executeClear`
 * rolls back and refuses EVER_PROVISIONED rather than archiving and
 * mutating it. This catches a token/binding that already existed by the
 * TIME EACH STATEMENT RAN — not the whole window from the top-level check
 * to the end of the transaction; see the THREE ROUND-8 FIXES below, found
 * by the same reviewer on this same delta after round 8 shipped, for what
 * actually closes the rest of it.
 *
 * THREE MORE FIXES, ALL FOUND ON ROUND 8'S OWN DELTA (boundary review round
 * 8, 2026-10-15, filed as R8-1/R8-2/R8-3 — a fourth recurrence, after F1/
 * R6-2/R7-4, of the SAME archive-completeness class, plus a genuine gap in
 * the new EVER_PROVISIONED refusal itself):
 *
 *   R8-1 (highest severity): the session cascade deletes were scoped by a
 *   LIVE SUBQUERY against `intake_sessions` (`WHERE session_id IN (SELECT id
 *   FROM intake_sessions WHERE trip_id = $1)`), not by a row this function
 *   had itself LOCKED — so a session's CHILD could still be inserted (by
 *   `claimInterpretation`, `openAgentTurn`, or typed-changes-store, each a
 *   single autocommit `INSERT` that only takes an implicit FK lock on the
 *   PARENT session for its own statement's duration) in the gap between
 *   this function's cascade-table deletes and the EVENTUAL `DELETE FROM
 *   intake_sessions`, surviving the former and being destroyed by the
 *   latter with no archive entry. Fixed by locking every session row for
 *   the trip FIRST (`FOR UPDATE`, no filter), BEFORE any cascade delete, and
 *   scoping every statement that follows by that LOCKED id list — never a
 *   blind `trip_id` match again. See the code's own comment at that lock for
 *   the full reasoning.
 *
 *   R8-2 (high — undermined the whole scope cut): the LATE `JOB_IN_PROGRESS`
 *   pass (below) only ever asked "is there a non-terminal job" — it never
 *   re-ran the actual EVER_PROVISIONED job predicate. A job created AFTER
 *   the EARLY pass (so invisible to it) and run all the way to
 *   `succeeded`/`failed` BEFORE `trips` was locked was therefore invisible
 *   to BOTH passes, and clear would have reset the trip's lifecycle and
 *   freed its slug anyway. Fixed by adding a LATE, AUTHORITATIVE re-run of
 *   `everProvisioned` itself (the real SQL predicate, never a second
 *   diverging implementation) as a plain read right after `trips` is
 *   locked — see that check's own comment for why a plain read is already
 *   authoritative there.
 *
 *   R8-3 (low — a wrong claim in a comment, not a live bug): the chat-
 *   bindings re-check's own comment overclaimed that it alone closed the
 *   `/switch`-binding race; it only catches what existed by the time ITS
 *   OWN statement ran. The SAME new late, authoritative re-check that
 *   fixes R8-2 also closes this — bindings are monotonic (never deleted),
 *   so anything inserted anywhere before that late read is still visible
 *   to it.
 *
 * A TRIP WITH UNFINISHED WORK IS REFUSED OUTRIGHT, NOT RECONCILED
 * (JOB_IN_PROGRESS; boundary review 2026-10-13, rounds 2 and 3; narrowed in
 * practical effect by the EVER_PROVISIONED refusal below, round 8 — see its
 * own note on this). This capability's third round of review found a THIRD
 * variant of the same failure class in the same area: round 2's N1 tried to
 * close the gap by cancelling queued jobs and consuming their approvals, and
 * round 3 found that narrower fix still missed a job a worker currently
 * holds (`leased`), a genuine TOCTOU race (the old unlocked read ran BEFORE
 * the transaction, so a claim landing in that window was invisible to it),
 * and a job in `waiting_for_user_action` whose plan the organizer could
 * simply re-approve afterward through the normal route. Dror's decision at
 * the time was to stop trying to out-engineer every job-lifecycle state this
 * capability could collide with, and narrow it instead — the SAME instinct
 * that produced round 8's much larger scope cut.
 *
 * So: `executeClear` locks every one of the trip's jobs `FOR UPDATE`. If any
 * locked row is not in a terminal state (`succeeded`, `failed`, `cancelled`
 * — so `queued`, `leased`, `running` and `waiting_for_user_action` all
 * count), the whole call refuses: no archive, no mutation, nothing
 * proceeds. There is no override. `previewClear` still reports the same
 * thing informationally from an unlocked read — the locked read inside
 * `executeClear`'s own transaction is the real gate.
 *
 * NARROWED IN PRACTICE BY EVER_PROVISIONED (round 8): a job that is `leased`,
 * `running`, `succeeded`, `failed`, or `cancelled` AFTER being claimed at
 * least once is now caught by EVER_PROVISIONED first (it is one of that
 * check's own four signals) — `JOB_IN_PROGRESS`'s own refusal is reached, in
 * practice, only by `queued` and `waiting_for_user_action`: a job created
 * (possibly already approved) but never yet claimed by a worker. That is
 * exactly the window EVER_PROVISIONED deliberately does NOT treat as
 * "provisioned" — see that check's own doc for why — and exactly the window
 * where a trip is still, truthfully, never-provisioned but ABOUT to not be.
 * `JOB_IN_PROGRESS` is what stops `executeClear` racing past that transition
 * rather than refusing cleanly while it is still underway.
 *
 * This is also why `executeClear`'s "EARLY pass" locks and re-evaluates
 * EVERY job row for the trip, not only non-terminal ones: a job that was
 * still `queued` (so the top-level, UNLOCKED `everProvisioned` check read
 * false before this call even opened a transaction) can be claimed, and
 * reach `succeeded`, WHILE this call sits blocked waiting for that same
 * lock — reproduced live in `test/trip-clear.test.ts`'s R4-2 "_complete
 * shape" case. By the time the lock is granted the trip IS provisioned, and
 * only a re-check against the now-committed, now-locked row catches it;
 * the earlier unlocked read cannot.
 *
 * THAT LOCK ALONE WAS STILL NOT ENOUGH (R4-1, boundary review round 4,
 * 2026-10-14) — round 4's own review found this the moment it tried the
 * obvious next attack: `FOR UPDATE` can only lock a row that already
 * exists. A concurrent `generatePlan` — triggered by an organizer
 * confirming their interview, or an admin retry, landing within
 * milliseconds of an operator's `clear` call — INSERTs a brand-new job
 * after this lock-and-check has already passed and found nothing.
 * Reproduced live, twice: once racing the real `provisionOnConfirm` route
 * against the real `executeClear` (clear reported success, archived,
 * retired the slug — then the organizer's confirm landed, created a job,
 * and the worker claimed and built it under the retired slug); once with
 * both transactions paused mid-flight to show the exact serialization gap.
 *
 * The fix needs both sides: `generatePlan` (planner.ts) now re-checks
 * `lifecycle_state` under `SELECT ... FOR UPDATE` on `trips`, inside its own
 * transaction, as its authoritative gate rather than trusting the unlocked
 * read it still does first for the fast common-case rejection. This file's
 * OWN half of the fix is described under LOCK ORDER below — round 4's first
 * attempt at it (lock `trips` before `jobs`) is what round 5 found deadlocks
 * against four other real transactions (R4-2, immediately below); the
 * version that actually ships locks `jobs` (among other things) BEFORE
 * `trips`, then re-reads `jobs` plainly once `trips` is held, which still
 * closes R4-1 — see LOCK ORDER's own reasoning for why that re-read is
 * authoritative. Verified with a live two-connection reproduction of both
 * race directions and 10 repeated real-function races, not inferred from
 * the lock existing — see `test/trip-clear.test.ts` and `test/planner.test.ts`.
 *
 * `generatePlan` (planner.ts) always creates a plan and its job in the SAME
 * transaction, and `completeJob`/`provisioner.py`'s success path always
 * retires the plan to `executed` in the SAME transaction as the job's own
 * terminal state — so a plan sitting in `pending_approval` or `approved`
 * NECESSARILY has a job in a non-terminal state too (confirmed by reading
 * both, not assumed), which this refusal already catches. A plan can only
 * ever reach a cleared trip in its terminal `executed` state, which does
 * not collide with a later `generatePlan` call's own
 * `status IN ('pending_approval', 'approved')` check — the "can't replan
 * after clear" failure mode the reviewer asked about does not reach this
 * path at all.
 *
 * R4-2 (boundary review round 5, 2026-10-14) — ROUND 4'S OWN FIX DEADLOCKED.
 * Locking `trips` before `jobs` closed R4-1, but it is the OPPOSITE of the
 * order every other transaction in this codebase already uses when it
 * touches both: the worker's own `_complete` (provisioner.py) locks `jobs`,
 * then `plan_approvals`, then `plans`, then `trips` LAST; `startSession`
 * locks `interview_enrollments` then `trips`; `confirmIntakeVia` locks
 * `intake_sessions` then `trips`; a portal plan-reject locks `plans` then
 * `jobs` then `trips`; `issueApproval` locks `plans` then `jobs` then
 * `trips`. Every one of them treats `trips` as the LAST row it locks when a
 * transaction touches it at all. Round 4's `executeClear`, locking `trips`
 * BEFORE `jobs`, was the one transaction in the whole codebase going the
 * other way — and reproduced a real `40P01` against all four, live, no
 * injected pause needed for the worst of them (`_complete` — a worker that
 * had just finished a verified deploy could lose its own success commit).
 *
 * LOCK ORDER actually shipped — everything else, THEN `trips` last, THEN a
 * plain (lockless) re-read of `jobs`:
 *
 *   1. `jobs` locked FIRST (`FOR UPDATE`, no `SKIP LOCKED`) — the
 *      JOB_IN_PROGRESS check, EARLY pass. Catches a job that already
 *      existed before this call started; locks nothing at all when the
 *      trip has none (the `WHERE` matches zero rows). Matches `_complete`'s
 *      and the portal reject's own jobs-before-trips order — and, since
 *      issue #387, `retryProvision`'s and `correctIntake`'s (both used to
 *      lock `trips` first and deadlocked against `_complete`), and
 *      `scripts/teardown-trip.py`'s `retire_in_db` (tokens, sessions,
 *      bindings, trips, teardown-pin clear: it used to close the sessions
 *      AFTER the `trips` slug update, the opposite of step 2 below).
 *   2. Group-binding tokens, interview enrollments, intake sessions (and
 *      everything `SESSION_CASCADE_TABLES` cascades), and chat bindings are
 *      all touched here — before `trips`, matching `redeemGroupBindingToken`
 *      (issue #175), `startSession`, and `confirmIntakeVia`'s own orders
 *      respectively. None of these has an ordering constraint against any
 *      OTHER one of them in this codebase — only against `trips` — so their
 *      relative order among themselves is not load-bearing.
 *   3. `trips` is locked LAST (`FOR UPDATE`) — matching every other
 *      transaction that touches it.
 *   4. `jobs` is re-read, PLAINLY (no lock), ONE more time — the
 *      JOB_IN_PROGRESS check, LATE pass. This is what still closes R4-1:
 *      with `trips` now held exclusively by this transaction, nothing else
 *      can create or revive a job for this trip without first waiting on
 *      THIS SAME lock (`generatePlan`'s own authoritative re-check locks
 *      `trips`; so do `issueApproval`, `retryProvision`, and the worker's
 *      `_claim` via `FOR UPDATE OF j, pa, t`) — so a plain read of the
 *      currently-committed state is authoritative, and does not need its
 *      own `FOR UPDATE`, which would reopen R4-2's deadlock right back up
 *      by locking `jobs` a second time, this time AFTER `trips`.
 */
import { randomBytes } from "node:crypto";
import type pg from "pg";
import type { TripState } from "./lifecycle.js";
import { RETIRED_SLUG_PREFIX } from "./trip-retirement.js";

function generateId(prefix: string): string {
  return `${prefix}_${randomBytes(16).toString("hex")}`;
}

/** Same opaque-id shape every table in this codebase uses (migration 0005). */
const TRIP_ID_FORMAT = /^trip_[A-Za-z0-9]{8,64}$/;

export interface ClearPlan {
  tripId: string;
  slug: string;
  lifecycleState: TripState;
  /** Values `executeClear`'s `confirm` field will accept for this trip. */
  acceptableConfirmations: string[];
  issuedEnrollments: number;
  intakeSessions: number;
  interviewAgentTurns: number;
  /** Confirmed intake versions — archived, never deleted. See module doc. */
  confirmedIntakeVersions: number;
  openChatBindings: number;
  liveGroupBindingTokens: number;
  /** Every profile this trip is, or has ever been, bound to (F5 — not just the newest). */
  hermesProfiles: string[];
  /**
   * True if ANY of this function's four durable "was this ever
   * provisioned" signals fired — see `everProvisioned` below. When true,
   * BOTH `previewClear` and `executeClear` refuse unconditionally
   * (EVER_PROVISIONED), regardless of this field's own value having come
   * from an unlocked, best-effort read (same caveat every other informational
   * `ClearPlan` field already carries).
   */
  everProvisioned: boolean;
  /** A still-open router/agent binding to one of this trip's sessions — see OPEN_INTERVIEW_BINDING (F3). */
  openInterviewBindings: number;
  /**
   * The trip's own unfinished work, from an UNLOCKED, informational read —
   * see JOB_IN_PROGRESS in this module's own doc. `null` means none found at
   * read time; `executeClear`'s own locked re-check inside its transaction
   * is the real gate, not this field.
   */
  nonTerminalJob: { id: string; jobType: string; state: string } | null;
}

export type ClearRefusalReason =
  | "TRIP_NOT_FOUND"
  | "EVER_PROVISIONED"
  | "PROFILE_SHARED_WITH_ANOTHER_TRIP"
  | "OPEN_INTERVIEW_BINDING"
  | "JOB_IN_PROGRESS"
  | "UNREVOKED_SESSION";

export type ClearPreviewResult =
  | { ok: true; plan: ClearPlan }
  | { ok: false; reason: ClearRefusalReason; detail: string; plan?: ClearPlan };

/**
 * Whether this trip was EVER provisioned — the hard, unconditional,
 * no-override refusal (EVER_PROVISIONED; round 8 scope cut, see this
 * module's own top-of-file doc) that replaces every job-lifecycle/
 * notification/token patch rounds 4-7 kept finding a new edge of. Checked
 * against DURABLE signals, never the trip's CURRENT `lifecycle_state` alone
 * — a prior partial/failed clear attempt, or this very capability's own
 * unconditional reset to `draft` on success, can leave `lifecycle_state`
 * reading `draft` for a trip that was fully provisioned months ago, so
 * trusting it would silently let a SECOND force-clear through a trip this
 * capability was never meant to touch at all.
 *
 * Four signals, each conservative/over-inclusive ON PURPOSE — this
 * codebase's existing fail-safe philosophy (`shared/needs-schema.js`'s "an
 * unknown value falling through to the permissive answer is the bug class
 * this exists to prevent") applied here as "ambiguous means provisioned,
 * never the reverse":
 *
 *   1. Any `jobs` row for this trip — any `job_type`, not only `provision`;
 *      `activate`/`upgrade`/`rollback`/`archive`/`cleanup` are all
 *      later-lifecycle operations that presuppose a trip already has
 *      physical infra, so any of THOSE existing at all is itself a signal
 *      — that ever got past `queued`/`waiting_for_user_action`, the two
 *      states a job sits in before a worker has ever claimed it.
 *      `attempt > 0` is the durable proof of a claim having happened.
 *      CORRECTED (boundary review round 12, 2026-10-15): this used to say
 *      only `claimJob` (job-queue.ts) increments it — `provisioner.py`'s
 *      own `_claim` (control-plane/worker) does too, on the identical
 *      successful `FOR UPDATE ... SKIP LOCKED` claim, since that class's
 *      whole docstring promise is mirroring job-queue.ts's claim/complete/
 *      fail logic exactly. Either way, only a successful claim increments
 *      it — `recoverStaleLeases` re-queues a lost lease without resetting
 *      it. `state NOT IN (...)` is there in
 *      case `attempt` ever misses a path. A job cancelled while still
 *      `queued` or `waiting_for_user_action` (`attempt = 0`) does NOT
 *      count — nothing ever ran — matching `intake-correction.ts`'s and
 *      `planner.ts`'s own cancellation, which cancels a job in either of
 *      those two states.
 *   2. Any `telegram_chat_bindings` row that ever existed for this trip,
 *      open or closed. Deliberately broader than "this trip's companion was
 *      attached": `organizer-trips.ts`'s `/switch` command can bind a chat
 *      to a trip that has no companion at all yet (the inserted row's
 *      `hermes_profile` is simply `NULL`), so this signal is a conservative
 *      OVER-approximation of "provisioned," not an exact one. That is the
 *      point of this whole function: a trip this signal wrongly flags is
 *      refused, never silently cleared.
 *   3. Any `telegram_group_binding_tokens` row that ever existed for this
 *      trip, live or expired/revoked. Only ever INSERTed by
 *      `issueGroupBindingToken` (group-binding.ts), whose own two callers —
 *      `relay/dispatch.ts`'s `/group` command, gated by `resolveChatRoute`'s
 *      "chat is currently bound to an active companion" check, and
 *      `outbox-dispatcher.ts`'s `companion_ready` dispatch, which only
 *      exists once the worker's provisioning job has already succeeded —
 *      both presuppose a companion that only provisioning creates.
 *   4. The trip's own `lifecycle_state` having EVER reached `provisioning`
 *      or anything past it (`ready_private`, `activation_approved`,
 *      `active`, `completed`, `sealed` — i.e. everything except the six
 *      states that precede provisioning: `pending_signup_approval`,
 *      `draft`, `intake_in_progress`, `intake_confirmed`, `planned`,
 *      `provisioning_approved`). ADDED round 12, 2026-10-15 — this signal
 *      was named in round 8's own scope-cut decision from the start
 *      ("a job ever claimed, a chat binding ever existing, a group token
 *      ever existing, OR the trip ever reaching `ready_private` or
 *      beyond") but was never actually wired into this function's SQL
 *      until a later review found the gap: harmless on every REAL code
 *      path in this repo, since nothing here ever sets `lifecycle_state`
 *      to `provisioning`/`ready_private`/beyond without going through the
 *      job pathway signal 1 already covers (`provisioner.py`'s `_complete`
 *      sets `ready_private` in the SAME transaction it marks the job
 *      `succeeded`) — but a trip whose `lifecycle_state` was set directly,
 *      by hand or by a future code path that does not also touch `jobs`,
 *      would have silently passed every check without this signal. Checked
 *      directly against `trips.lifecycle_state`, not derived from any
 *      other table, so it has no caller to reason about the way signals
 *      1-3 do.
 *
 * CONSIDERED AND DELIBERATELY NOT ADDED AS A FIFTH SIGNAL: a
 * `notification_outbox` row of type `provisioning_complete`/`companion_ready`
 * ever existing for the trip. Checked against `provisioner.py`'s `_complete`
 * (control-plane/worker) directly: the `provisioning_complete` row is
 * INSERTed in the exact SAME database transaction that marks the job
 * `succeeded` and flips `lifecycle_state` to `ready_private` — so by the
 * time that notification row could exist, BOTH signal 1 (the job's own
 * state) and signal 4 (the lifecycle transition) above have already fired.
 * It would be a real signal, just a strictly redundant one; adding it
 * would be more surface protecting against nothing this function does not
 * already catch.
 *
 * THE RACE THIS CHECK ITSELF DOES NOT NEED TO CLOSE (CORRECTED, boundary
 * review round 12, 2026-10-15 — an earlier version of this paragraph
 * claimed the EARLY jobs pass's own locking was what closes this race by
 * itself; R8-2 found a real case where it does not: a job created AFTER
 * that pass already ran, then claimed and run to `succeeded` BEFORE `trips`
 * is locked, which the early pass never saw and the LATE `JOB_IN_PROGRESS`
 * pass does not either, on purpose, since that filter answers a different
 * question). What ACTUALLY closes a trip transitioning from never- to
 * ever-provisioned WHILE a call is in flight is `executeClear`'s LATE,
 * AUTHORITATIVE re-run of `everProvisioned` itself, taken as a plain read
 * right after `trips` is locked (see that re-check's own comment, below the
 * function body that calls it, for the full reasoning: every table this
 * predicate reads has an FK to `trips(id)`, so nothing new can land in any
 * of them, and no existing job can be freshly claimed, without first
 * waiting on the very lock that re-check already runs under). THIS
 * function — `everProvisioned` itself, called here as a single unlocked
 * read from `buildPlan`, exactly like `PROFILE_SHARED_WITH_ANOTHER_TRIP`'s
 * and `OPEN_INTERVIEW_BINDING`'s own top-level checks — is only ever the
 * FAST, common-case, best-effort path; the late re-run of this exact same
 * function is the one that is actually race-free, and is what closes the
 * window this paragraph is about.
 */
async function everProvisioned(db: pg.Pool | pg.PoolClient, tripId: string): Promise<boolean> {
  const r = await db.query<{ ever: boolean }>(
    `SELECT (
       EXISTS (
         SELECT 1 FROM control_plane.jobs
          WHERE trip_id = $1
            AND (attempt > 0 OR state NOT IN ('queued', 'waiting_for_user_action', 'cancelled'))
       )
       OR EXISTS (SELECT 1 FROM control_plane.telegram_chat_bindings WHERE trip_id = $1)
       OR EXISTS (SELECT 1 FROM control_plane.telegram_group_binding_tokens WHERE trip_id = $1)
       OR EXISTS (
         SELECT 1 FROM control_plane.trips
          WHERE id = $1
            AND lifecycle_state NOT IN (
              'pending_signup_approval', 'draft', 'intake_in_progress',
              'intake_confirmed', 'planned', 'provisioning_approved'
            )
       )
     ) AS ever`,
    [tripId],
  );
  return r.rows[0]?.ever === true;
}

/**
 * Signal 1 of `everProvisioned` above, as a plain JS predicate over an
 * already-fetched job row — used by `executeClear`'s own EARLY, LOCKED pass
 * (see its own comment) against rows it already holds `FOR UPDATE`. Must
 * stay logically identical to the SQL clause in `everProvisioned` above —
 * the comment there is the one to update first.
 *
 * CORRECTED (round 9, 2026-10-15): an earlier version of this comment
 * justified keeping this helper by claiming a fresh SQL read here would see
 * "the wrong, unlocked-at-the-time snapshot." That is not true — a plain
 * read under READ COMMITTED always sees the current committed state,
 * locked or not; there is no stale-snapshot risk a SQL query would hit that
 * reading the already-fetched JS rows avoids. The REAL reason to keep this
 * helper is the one the paragraph below already gives: classifying `leased`
 * as `EVER_PROVISIONED` the MOMENT the early pass itself observes it (not
 * only later, at the authoritative late pass), so a job already locked by
 * this early pass is never misreported as merely `JOB_IN_PROGRESS`.
 *
 * KEPT, round 8's R8-2 fix (boundary review round 8, 2026-10-15) — a
 * reviewer suggestion to delete this in favor of relying solely on a NEW
 * late, authoritative `everProvisioned()` re-check (added below, right
 * after `trips` is locked) was tried and reverted: deleting it broke the
 * G1-race test's own correct precedence (a job that is ALREADY locked by
 * this EARLY pass — i.e., existed before this call started — and becomes
 * `leased` while this pass waits on it must be classified EVER_PROVISIONED,
 * not JOB_IN_PROGRESS, the moment the EARLY pass itself observes `leased`;
 * waiting for the LATE pass to say so would require the EARLY pass's own
 * `earlyInProgress` check — which this file still needs, to correctly
 * refuse `queued`/`waiting_for_user_action` — to NOT also fire for `leased`,
 * which is exactly what this predicate is for). The late check below closes
 * a NARROWER, genuinely separate gap: a job NOT YET EXISTING when this
 * EARLY pass ran at all (so its own `FOR UPDATE` never covered it), created
 * and run to a terminal state entirely within the window between this pass
 * and the `trips` lock. Two checks, two different gaps; neither makes the
 * other redundant.
 */
function jobCountsAsProvisioned(job: { state: string; attempt: number }): boolean {
  return job.attempt > 0 || !["queued", "waiting_for_user_action", "cancelled"].includes(job.state);
}

/** Shared detail text for EVER_PROVISIONED — used by both previewClear and executeClear, so the two never drift in wording. */
function everProvisionedDetail(): string {
  return "this trip shows at least one durable sign of having been provisioned (a job that reached a " +
    "non-queued/non-waiting-for-approval state, a chat binding, or a group-binding token, any of which " +
    "may have since been closed, revoked or expired) — see issue #378's own comment thread. This " +
    "capability is scoped to a trip that was NEVER provisioned; #390 tracks the provisioned case " +
    "separately. There is no override.";
}

/**
 * Every Hermes profile this trip is, or has ever been, bound to — unscoped by
 * `closed_at`, matching `teardown-trip.py`'s own `resolve()` (its `bound`
 * query carries no such filter either). F5 (boundary review, 2026-10-13):
 * this used to take only the NEWEST such binding, so a trip with two open
 * bindings — one shared with another trip, one not — could clear
 * successfully without the shared profile ever being checked. Falls back to
 * the slug's own alphanumeric-only form when this trip has no binding at
 * all, exactly as `teardown-trip.py`'s `trip["profile"] = bound or "".join(…
 * isalnum())` does — a profile directory can exist under that convention-
 * derived name even before any chat binding row does.
 */
async function profilesOfTrip(db: pg.Pool, tripId: string, slug: string): Promise<string[]> {
  const bound = await db.query<{ hermes_profile: string }>(
    `SELECT DISTINCT hermes_profile FROM control_plane.telegram_chat_bindings
      WHERE trip_id = $1 AND hermes_profile IS NOT NULL`,
    [tripId],
  );
  if (bound.rows.length > 0) return bound.rows.map((r) => r.hermes_profile);
  // N2 (boundary review, 2026-10-13): teardown-trip.py's own fallback runs
  // against `original_slug(slug)`, not the raw slug — an already-retired
  // trip's resources are still named by the slug it HAD before retirement,
  // stripped of the `retired-` prefix and the `-YYYYMMDD[-n]` suffix
  // `executeClear` itself appends (see `RETIRED_SLUG_PREFIX`'s use below).
  // Without this, a trip cleared a second time (or previewed after being
  // retired by `teardown-trip.py` itself) derived a DIFFERENT fallback name
  // than that script would — low practical harm (this route never touches a
  // profile directly; `teardown-trip.py` re-derives the correct name itself
  // before doing anything physical), but worth matching exactly since the
  // whole point of this function is to mirror that script's own guard.
  const original = slug.startsWith(RETIRED_SLUG_PREFIX)
    ? slug.slice(RETIRED_SLUG_PREFIX.length).replace(/-\d{8}(-\d+)?$/, "")
    : slug;
  const fallback = original.replace(/[^a-z0-9]/gi, "");
  return fallback ? [fallback] : [];
}

/**
 * Whether ANY profile this trip is or has been bound to is still the one
 * bound to ANOTHER trip's open chat binding — the one guardrail
 * `executeClear` keeps regardless of force. See `profilesOfTrip`'s own doc
 * for what changed here under F5, and this module's top-of-file doc for why
 * the guard exists at all.
 */
async function profileSharedWithAnotherOpenTrip(
  db: pg.Pool,
  tripId: string,
  slug: string,
): Promise<{ profiles: string[]; shared: boolean; sharedProfile: string | null }> {
  const profiles = await profilesOfTrip(db, tripId, slug);
  if (profiles.length === 0) return { profiles, shared: false, sharedProfile: null };
  const shared = await db.query<{ hermes_profile: string }>(
    `SELECT DISTINCT hermes_profile FROM control_plane.telegram_chat_bindings
      WHERE hermes_profile = ANY($1) AND trip_id <> $2 AND closed_at IS NULL`,
    [profiles, tripId],
  );
  return { profiles, shared: shared.rows.length > 0, sharedProfile: shared.rows[0]?.hermes_profile ?? null };
}

async function buildPlan(db: pg.Pool, tripId: string): Promise<ClearPlan | null> {
  const tripRow = await db.query<{ slug: string; lifecycle_state: string }>(
    "SELECT slug, lifecycle_state FROM control_plane.trips WHERE id = $1",
    [tripId],
  );
  const trip = tripRow.rows[0];
  if (!trip) return null;

  const [enrollments, sessions, turns, versions, bindings, tokens, everProvisionedResult, latestVersion, profileCheck, interviewBindings, nonTerminalJob] =
    await Promise.all([
      db.query<{ n: string }>(
        "SELECT count(*)::text AS n FROM control_plane.interview_enrollments WHERE trip_id = $1 AND state = 'issued'",
        [tripId],
      ),
      db.query<{ n: string }>(
        "SELECT count(*)::text AS n FROM control_plane.intake_sessions WHERE trip_id = $1",
        [tripId],
      ),
      db.query<{ n: string }>(
        `SELECT count(*)::text AS n FROM control_plane.interview_agent_turns t
           JOIN control_plane.intake_sessions s ON s.id = t.session_id
          WHERE s.trip_id = $1`,
        [tripId],
      ),
      db.query<{ n: string }>(
        "SELECT count(*)::text AS n FROM control_plane.intake_versions WHERE trip_id = $1",
        [tripId],
      ),
      db.query<{ n: string }>(
        "SELECT count(*)::text AS n FROM control_plane.telegram_chat_bindings WHERE trip_id = $1 AND closed_at IS NULL",
        [tripId],
      ),
      db.query<{ n: string }>(
        "SELECT count(*)::text AS n FROM control_plane.telegram_group_binding_tokens WHERE trip_id = $1 AND expires_at > now()",
        [tripId],
      ),
      everProvisioned(db, tripId),
      db.query<{ id: string }>(
        "SELECT id FROM control_plane.intake_versions WHERE trip_id = $1 ORDER BY version DESC LIMIT 1",
        [tripId],
      ),
      profileSharedWithAnotherOpenTrip(db, tripId, trip.slug),
      // F3 (boundary review, 2026-10-13): telegram_interview_bindings.session_id
      // is `NOT NULL REFERENCES intake_sessions(id)` with no `ON DELETE`
      // action, i.e. `NO ACTION` — deleting a session it still points at
      // raises a raw FK violation. Surfaced here so both routes can refuse
      // cleanly instead of letting that violation reach the caller as a 500.
      db.query<{ n: string }>(
        `SELECT count(*)::text AS n FROM control_plane.telegram_interview_bindings b
           JOIN control_plane.intake_sessions s ON s.id = b.session_id
          WHERE s.trip_id = $1`,
        [tripId],
      ),
      // JOB_IN_PROGRESS (boundary review round 3, 2026-10-13): unlocked and
      // informational only — see this module's own doc. `executeClear`'s
      // locked re-check inside its transaction is the real, race-free gate.
      db.query<{ id: string; job_type: string; state: string }>(
        `SELECT id, job_type, state FROM control_plane.jobs
          WHERE trip_id = $1 AND state NOT IN ('succeeded', 'failed', 'cancelled')
          ORDER BY created_at LIMIT 1`,
        [tripId],
      ),
    ]);

  const confirmations = [trip.slug];
  if (latestVersion.rows[0]?.id) confirmations.push(latestVersion.rows[0].id);

  return {
    tripId,
    slug: trip.slug,
    lifecycleState: trip.lifecycle_state as TripState,
    acceptableConfirmations: confirmations,
    issuedEnrollments: Number(enrollments.rows[0]?.n ?? 0),
    intakeSessions: Number(sessions.rows[0]?.n ?? 0),
    interviewAgentTurns: Number(turns.rows[0]?.n ?? 0),
    confirmedIntakeVersions: Number(versions.rows[0]?.n ?? 0),
    openChatBindings: Number(bindings.rows[0]?.n ?? 0),
    liveGroupBindingTokens: Number(tokens.rows[0]?.n ?? 0),
    hermesProfiles: profileCheck.profiles,
    everProvisioned: everProvisionedResult,
    openInterviewBindings: Number(interviewBindings.rows[0]?.n ?? 0),
    nonTerminalJob: nonTerminalJob.rows[0]
      ? { id: nonTerminalJob.rows[0].id, jobType: nonTerminalJob.rows[0].job_type, state: nonTerminalJob.rows[0].state }
      : null,
  };
}

/** Shared detail text for JOB_IN_PROGRESS — used by both the unlocked preview check and executeClear's own locked re-check, so the two never drift in wording. */
// Worded carefully (boundary review round 4, 2026-10-14): the original text
// said clear "will not touch it until that job succeeds, fails, or is
// cancelled," which reads as something the caller can wait out or act on.
// For `waiting_for_user_action` specifically that is not true — the
// operator key has no route that resolves one; only the organizer's own
// approval (or an admin route this key is not) does. So this states the
// fact — unfinished work, no override — without implying a path the
// operator-key caller actually has.
function jobInProgressDetail(job: { id: string; jobType: string; state: string }): string {
  return `job ${job.id} (${job.jobType}, ${job.state}) has not reached a terminal state ` +
    "(succeeded, failed, or cancelled) — this trip has unfinished work and clear refuses to touch it " +
    "while that is true. There is no override.";
}

/**
 * What an operator's force-clear would do, without doing any of it. Mirrors
 * `teardown-trip.py`'s own dry-run/plan mode (and `organizer-invite.ts`'s
 * `previewInvitation`, the same split for the same reason: the tool an
 * operator drives shows this first and asks for confirmation only after).
 *
 * Still returns `ok: false` for the refusals that survive force — see this
 * module's doc — WITH the plan attached, so a caller can see exactly what
 * collided rather than just a bare refusal.
 */
export async function previewClear(db: pg.Pool, tripId: string): Promise<ClearPreviewResult> {
  if (!TRIP_ID_FORMAT.test(tripId)) {
    return { ok: false, reason: "TRIP_NOT_FOUND", detail: `${tripId} is not a trip id` };
  }
  const plan = await buildPlan(db, tripId);
  if (!plan) {
    return { ok: false, reason: "TRIP_NOT_FOUND", detail: `no trip ${tripId}` };
  }
  // EVER_PROVISIONED (round 8 scope cut) — checked first, before every other
  // refusal: this capability no longer has anything to say about a
  // provisioned trip at all. See `everProvisioned`'s own doc.
  if (plan.everProvisioned) {
    return { ok: false, reason: "EVER_PROVISIONED", detail: everProvisionedDetail(), plan };
  }
  const shared = await profileSharedWithAnotherOpenTrip(db, tripId, plan.slug);
  if (shared.shared) {
    return {
      ok: false,
      reason: "PROFILE_SHARED_WITH_ANOTHER_TRIP",
      detail: `profile ${shared.sharedProfile} is still bound to another trip's open chat — ` +
        "clearing this trip would pull that profile out from under a DIFFERENT trip's companion. " +
        "This refusal survives --force on purpose (issue #378).",
      plan,
    };
  }
  // F3 (boundary review, 2026-10-13): a real refusal, not a 500 from the FK
  // `telegram_interview_bindings.session_id` holds — see buildPlan's own
  // comment on `openInterviewBindings`. Pre-existing in fresh-interview.py
  // too (it never deletes this table either), but this is a new HTTP route
  // and a caller deserves a status code, not a stack trace.
  if (plan.openInterviewBindings > 0) {
    return {
      ok: false,
      reason: "OPEN_INTERVIEW_BINDING",
      detail: `${plan.openInterviewBindings} telegram_interview_bindings row(s) still reference this trip's ` +
        "session(s) — deleting the session(s) would violate that table's foreign key. Changing the " +
        "binding's state does not clear this (the FK is on session_id, not state); the row itself " +
        "must be deleted or repointed before this trip can be cleared.",
      plan,
    };
  }
  // JOB_IN_PROGRESS (boundary review round 3, 2026-10-13). Unlocked read —
  // see this module's own doc and `ClearPlan.nonTerminalJob`'s comment.
  // `executeClear`'s locked re-check is the real gate; this is informational.
  if (plan.nonTerminalJob) {
    return { ok: false, reason: "JOB_IN_PROGRESS", detail: jobInProgressDetail(plan.nonTerminalJob), plan };
  }
  return { ok: true, plan };
}

export interface ClearExecuteResult {
  ok: true;
  tripId: string;
  archiveId: string;
  slugBefore: string;
  slugAfter: string;
  stepsPerformed: Record<string, number | string | boolean>;
}

export type ClearExecuteRefusal =
  | { ok: false; reason: "TRIP_NOT_FOUND"; detail: string }
  | { ok: false; reason: "EVER_PROVISIONED"; detail: string }
  | { ok: false; reason: "CONFIRMATION_REQUIRED"; detail: string }
  | { ok: false; reason: "CONFIRMATION_MISMATCH"; detail: string }
  | { ok: false; reason: "PROFILE_SHARED_WITH_ANOTHER_TRIP"; detail: string }
  | { ok: false; reason: "OPEN_INTERVIEW_BINDING"; detail: string }
  | { ok: false; reason: "JOB_IN_PROGRESS"; detail: string }
  | { ok: false; reason: "UNREVOKED_SESSION"; detail: string };

/**
 * Every table that `ON DELETE CASCADE`s from `intake_sessions`, as of this
 * writing — F1 (boundary review, 2026-10-13): `DELETE FROM intake_sessions`
 * cascades to `interview_interpretations` (holds the organizer's VERBATIM
 * typed text — reproduced live by the reviewer with a real allergy note) and
 * `intake_pending_changes`, neither of which `snapshot()` originally
 * captured, so clearing a trip silently lost exactly the kind of data the
 * archive exists to protect. Both are deleted EXPLICITLY below (not left to
 * the cascade), scoped by the JS-side id list `intake_sessions WHERE
 * trip_id = $1 FOR UPDATE` already locked and returned (CORRECTED, boundary
 * review round 12, 2026-10-15 — this used to say the opposite, "a live
 * subquery... not a JS-side id list," which was true of an earlier version
 * of the fix and stopped being true once R8-1 made sessions themselves get
 * locked first; see R7-4 and R8-1 in this module's own doc for why each
 * mattered).
 *
 * This list is also the thing `test/trip-clear.test.ts`'s own FK-discovery
 * test checks against `pg_constraint` — so a FUTURE migration that cascades a
 * new table from `intake_sessions` fails that test loudly instead of
 * silently losing rows the next time a trip is cleared, the same way this
 * one did.
 */
export const SESSION_CASCADE_TABLES = ["interview_agent_turns", "interview_interpretations", "intake_pending_changes"] as const;

/**
 * A plain read of a table `executeClear` never mutates. Used only for
 * `trip_memberships`, `intake_versions` and `organizer_invitations` below;
 * every table `executeClear` actually mutates is captured a different way —
 * see this module's own doc on R7-4 for why.
 *
 * CORRECTED (boundary review round 9, 2026-10-15): this used to say "safe at
 * any point in the transaction" — not quite true for `trip_memberships`
 * specifically. Every INSERT into any of the three is blocked once `trips`
 * is locked (each has an FK to `trips(id)`, same reasoning as the LATE
 * AUTHORITATIVE `everProvisioned` re-check), so an insert is genuinely safe
 * at any point past that lock. But `portal.ts`'s site-invite redemption also
 * UPDATEs an EXISTING `trip_memberships` row (`ON CONFLICT (trip_id,
 * user_id) DO UPDATE`), and an UPDATE of an existing row's OTHER columns
 * does not need to re-touch the FK, so it is not blocked by the `trips`
 * lock the same way. That path is still unreachable for any trip this
 * function ever mutates, though: it only runs after
 * `runtimeAccounts.provisionParticipant` succeeds, which requires a runtime
 * participant — only possible for an ALREADY-provisioned trip, which
 * `EVER_PROVISIONED` has already refused before this read is ever reached.
 * So the read taken here (now moved late — F-R9-2, this same round) is
 * final for `intake_versions` and `organizer_invitations` for the reason
 * stated above, and final for `trip_memberships` for the SAME reason plus
 * this one; either way, this function never restores or otherwise acts on
 * `trip_memberships`'s own content, so staleness in that one specific,
 * unreachable path would be harmless even if it somehow occurred.
 */
async function unmutatedRows(client: pg.PoolClient, table: string, tripId: string): Promise<unknown[]> {
  const r = await client.query(
    `SELECT coalesce(jsonb_agg(row_to_json(t)), '[]'::jsonb) AS j
       FROM control_plane.${table} t WHERE t.trip_id = $1`,
    [tripId],
  );
  return (r.rows[0]?.j ?? []) as unknown[];
}

/** Postgres's own deadlock-detected SQLSTATE — see `executeClear`'s retry loop (F-R9-1) for why this is checked. */
function isDeadlockError(err: unknown): boolean {
  return Boolean(err) && typeof err === "object" && (err as { code?: unknown }).code === "40P01";
}

/**
 * Archives, then revokes the interview/intake layer, then does the
 * DB-reachable half of infrastructure teardown — the sequence issue #378
 * asks for, minus the bypassed refusals named in this module's own doc, and
 * only for a trip EVER_PROVISIONED has already confirmed never touched
 * physical infra at all.
 *
 * `confirm` must equal the trip's current slug or one of its confirmed
 * intake version ids (`ClearPlan.acceptableConfirmations`) — the fat-finger
 * guard the issue asks for beyond the bare operator key.
 *
 * RETRIES ONCE ON A REAL DEADLOCK (F-R9-1, boundary review round 9,
 * 2026-10-15). R8-1's own fix — locking every session row for the trip
 * FIRST, before any cascade-table work — put this function's lock order at
 * odds with `openAgentTurn` (interview.ts), which locks a turn's own row
 * BEFORE the session it belongs to: the opposite order. The reviewer
 * confirmed there is no single ordering that satisfies both this function
 * (which needs sessions locked before their children, so a new child
 * cannot land unseen — R8-1's whole point) and `openAgentTurn` (which is
 * already in conflict with `confirmIntakeVia` independently of this file —
 * not a new problem this round introduced, and not one this function can
 * fix by picking a different order of its own). Measured by the reviewer
 * as real but rare (0/30 under natural timing, reproducible only under
 * forced timing). Rather than surface a raw `500` for a genuinely
 * occasional `40P01`, the whole transaction retries ONCE with a fresh
 * client — and therefore fresh locks, taken from scratch against whatever
 * is now actually true. A SECOND deadlock is left to surface as a `500`;
 * this absorbs the measured window, it does not claim to guarantee zero
 * deadlocks forever.
 */
export async function executeClear(
  db: pg.Pool,
  tripId: string,
  confirm: string,
  actorRef: string,
): Promise<ClearExecuteResult | ClearExecuteRefusal> {
  if (!TRIP_ID_FORMAT.test(tripId)) {
    return { ok: false, reason: "TRIP_NOT_FOUND", detail: `${tripId} is not a trip id` };
  }
  const plan = await buildPlan(db, tripId);
  if (!plan) return { ok: false, reason: "TRIP_NOT_FOUND", detail: `no trip ${tripId}` };

  // EVER_PROVISIONED — checked before confirmation and before every other
  // refusal, same reasoning as previewClear's own placement.
  if (plan.everProvisioned) {
    return { ok: false, reason: "EVER_PROVISIONED", detail: everProvisionedDetail() };
  }

  const confirmValue = (confirm ?? "").trim();
  if (!confirmValue) {
    return {
      ok: false,
      reason: "CONFIRMATION_REQUIRED",
      detail: "echo back the trip's slug (or a confirmed intake version id) in `confirm`",
    };
  }
  if (!plan.acceptableConfirmations.includes(confirmValue)) {
    return {
      ok: false,
      reason: "CONFIRMATION_MISMATCH",
      detail: "`confirm` must equal this trip's current slug or one of its confirmed intake version ids",
    };
  }

  // The one guardrail that survives force — checked again here (not just in
  // the preview) so a caller who never previewed still cannot cross it.
  const shared = await profileSharedWithAnotherOpenTrip(db, tripId, plan.slug);
  if (shared.shared) {
    return {
      ok: false,
      reason: "PROFILE_SHARED_WITH_ANOTHER_TRIP",
      detail: `profile ${shared.sharedProfile} is still bound to another trip's open chat — refusing regardless of force`,
    };
  }

  // F3 — see previewClear's own comment on the same check.
  if (plan.openInterviewBindings > 0) {
    return {
      ok: false,
      reason: "OPEN_INTERVIEW_BINDING",
      detail: `${plan.openInterviewBindings} telegram_interview_bindings row(s) still reference this trip's ` +
        "session(s) — deleting the session(s) would violate that table's foreign key. Changing the " +
        "binding's state does not clear this (the FK is on session_id, not state); the row itself " +
        "must be deleted or repointed before this trip can be cleared.",
    };
  }

  for (let attempt = 1; attempt <= 2; attempt++) {
  const client = await db.connect();
  try {
    await client.query("BEGIN");

    // 0. EVER_PROVISIONED + JOB_IN_PROGRESS, EARLY pass — ONE locked read of
    // EVERY job row this trip has, not only non-terminal ones. Broadened
    // (round 8) from JOB_IN_PROGRESS's original filtered read specifically
    // to close a race the TOP-LEVEL, unlocked `plan.everProvisioned` check
    // above cannot: a job that is merely `queued`/`waiting_for_user_action`
    // when THIS call started (so that check correctly read false) can be
    // claimed, and even reach `succeeded`, WHILE this call is blocked
    // waiting on the very lock below — see `test/trip-clear.test.ts`'s R4-2
    // "_complete shape" case, which reproduces exactly this live. By the
    // time that lock is actually granted the trip is unambiguously
    // provisioned, and re-evaluating against what is ACTUALLY committed now
    // that this transaction holds every job row is what catches it. Costs
    // nothing extra for the common case: a trip with zero jobs locks and
    // returns zero rows.
    const earlyJobs = await client.query<{ id: string; job_type: string; state: string; attempt: number }>(
      `SELECT id, job_type, state, attempt FROM control_plane.jobs
        WHERE trip_id = $1
        ORDER BY created_at
        FOR UPDATE`,
      [tripId],
    );
    const provisionedJob = earlyJobs.rows.find((j) => jobCountsAsProvisioned(j));
    if (provisionedJob) {
      await client.query("ROLLBACK");
      return { ok: false, reason: "EVER_PROVISIONED", detail: everProvisionedDetail() };
    }
    // See this module's own doc (boundary review round 3) for why this is a
    // hard refusal with no override. Reached, in practice, only by
    // `queued`/`waiting_for_user_action` jobs now — anything the check just
    // above would have called provisioned is refused there instead.
    const earlyInProgress = earlyJobs.rows.find((j) => !["succeeded", "failed", "cancelled"].includes(j.state));
    if (earlyInProgress) {
      await client.query("ROLLBACK");
      return {
        ok: false,
        reason: "JOB_IN_PROGRESS",
        detail: jobInProgressDetail({ id: earlyInProgress.id, jobType: earlyInProgress.job_type, state: earlyInProgress.state }),
      };
    }

    // ARCHIVE — built incrementally below. Every mutated table is captured
    // by the SAME statement that mutates it (R7-4, see this module's own
    // doc); the three tables this function never mutates are a plain read
    // taken LATE (see the comment where that read actually happens, right
    // after `trips` is locked) — not here, even though "never mutated"
    // sounds like it would be safe at any point (F-R9-2, below).
    const payload: Record<string, unknown> = {};

    // Group-binding tokens — one statement: a CTE locks and captures every
    // row this trip has (regardless of current expiry, so an already-dead
    // token is archived too, exactly as before R7-4), the UPDATE revokes
    // only the ones that were still live, and RETURNING hands back the
    // CTE's own (pre-mutation) values — before `trips`, matching issue
    // #175's own order (`redeemGroupBindingToken`).
    const tokenResult = await client.query<{ was_revoked: boolean } & Record<string, unknown>>(
      `WITH old AS (
         SELECT * FROM control_plane.telegram_group_binding_tokens WHERE trip_id = $1 FOR UPDATE
       )
       UPDATE control_plane.telegram_group_binding_tokens t
          SET expires_at = CASE WHEN old.expires_at > now() THEN now() ELSE old.expires_at END
         FROM old
        WHERE t.id = old.id
      RETURNING old.*, (old.expires_at > now()) AS was_revoked`,
      [tripId],
    );
    // EVER_PROVISIONED, signal 3, LOCKED re-check — closes the same class of
    // race as the jobs EARLY pass above, for a signal jobs cannot catch: a
    // group-binding token minted for this trip by a DIFFERENT session AFTER
    // the top-level, unlocked `plan.everProvisioned` read found none. The
    // lock this statement already took is what makes this read authoritative
    // (R7-4, see this module's own doc) — no separate query needed.
    if (tokenResult.rows.length > 0) {
      await client.query("ROLLBACK");
      return { ok: false, reason: "EVER_PROVISIONED", detail: everProvisionedDetail() };
    }
    payload.telegram_group_binding_tokens = tokenResult.rows.map(({ was_revoked, ...row }) => row);
    const tokensRevoked = tokenResult.rows.filter((r) => r.was_revoked).length;

    // Interview enrollments — same one-statement shape, before `trips`,
    // matching `startSession`'s own order.
    const enrollmentResult = await client.query<{ was_revoked: boolean } & Record<string, unknown>>(
      `WITH old AS (
         SELECT * FROM control_plane.interview_enrollments WHERE trip_id = $1 FOR UPDATE
       )
       UPDATE control_plane.interview_enrollments e
          SET state = CASE WHEN old.state = 'issued' THEN 'revoked' ELSE old.state END
         FROM old
        WHERE e.id = old.id
      RETURNING old.*, (old.state = 'issued') AS was_revoked`,
      [tripId],
    );
    payload.interview_enrollments = enrollmentResult.rows.map(({ was_revoked, ...row }) => row);
    const enrollmentsRevoked = enrollmentResult.rows.filter((r) => r.was_revoked).length;

    // Sessions LOCKED FIRST, before any cascade-table delete (R8-1,
    // boundary review round 8, 2026-10-15 — a THIRD recurrence of the F1/
    // R6-2/R7-4 archive-completeness class, found after R7-4's own fix
    // shipped). R7-4 closed the gap where a NEW SESSION landed between an
    // earlier read and a later blind `trip_id` mutation; it did NOT close
    // the narrower gap one level down: a NEW CHILD of an EXISTING,
    // already-known session. `claimInterpretation` (interpret.ts),
    // `openAgentTurn` (interview.ts) and typed-changes-store's own inserts
    // are each a single autocommit `INSERT` — no explicit lock of their
    // own, but the FK to `intake_sessions(id)` still takes an implicit
    // KEY SHARE lock on the parent session row for the statement's
    // duration. Reproduced live: such an insert landing WHILE this
    // function was paused mid-wait on some unrelated lock survived the
    // (then-unlocked) cascade-table deletes — which had already run and
    // returned before the child existed — and was destroyed with no
    // archive entry once the LATER, separate `DELETE FROM intake_sessions
    // WHERE trip_id = $1` finally ran and cascaded.
    //
    // The fix: lock every session row for this trip FIRST, by itself —
    // `FOR UPDATE` conflicts with the FK's KEY SHARE, so once this
    // statement returns, nothing can still be inserting a new child of
    // ANY of these sessions; a concurrent `claimInterpretation`/
    // `openAgentTurn`/typed-changes-store call blocks until this
    // transaction commits or rolls back, exactly as a concurrent
    // `lockSession` call already does (confirmIntakeVia's own order:
    // sessions, then `trips` — unchanged). Captured AND locked as one
    // statement, matching every other table in this function (R7-4) —
    // but, unlike the rest, the session ids are then kept in JS and used
    // to scope every statement that follows, NEVER by a blind `trip_id`
    // match: a session created in the brief window before this lock is
    // simply left untouched (not destroyed) rather than risking the same
    // "new row the blind mutate also catches" bug class R7-4 fixed
    // elsewhere in this function.
    const sessionRows = await client.query<{ id: string }>(
      "SELECT id FROM control_plane.intake_sessions WHERE trip_id = $1 FOR UPDATE",
      [tripId],
    );
    const sessionIds = sessionRows.rows.map((r) => r.id);

    // Cascade tables, explicitly, each its own one-statement
    // DELETE...RETURNING scoped by the LOCKED id list above — not a live
    // subquery (an earlier version of this fix used one, which is race-free
    // against a NEW SESSION but not against a new CHILD of an EXISTING
    // session, since nothing locked the session itself) and not a blind
    // `trip_id` match. Done before deleting the sessions themselves so the
    // cascade never fires invisibly ahead of this explicit, capturing delete
    // (F1's own reasoning, unchanged). Zero sessions means zero ids means
    // every one of these deletes affects nothing — cheap, not a special case.
    for (const table of SESSION_CASCADE_TABLES) {
      const deleted = await client.query(
        `DELETE FROM control_plane.${table} WHERE session_id = ANY($1::text[]) RETURNING *`,
        [sessionIds],
      );
      payload[table] = deleted.rows;
    }
    const turnsDeleted = { rowCount: (payload.interview_agent_turns as unknown[]).length };

    // Intake sessions themselves — by the SAME locked id list, not a blind
    // `trip_id` match (so a session created after the lock above, however
    // unlikely, is left alone rather than deleted with nothing to show for
    // it).
    const sessionsDeleted = await client.query(
      "DELETE FROM control_plane.intake_sessions WHERE id = ANY($1::text[]) RETURNING *",
      [sessionIds],
    );
    payload.intake_sessions = sessionsDeleted.rows;

    // Chat bindings — same one-statement shape as tokens/enrollments above.
    // Does not itself set `telegram_chat_bindings.trip_id` (only
    // `closed_at`/`closed_reason`), so it carries no FK-driven lock on
    // `trips` either way; grouped here for readability, not for lock order.
    const bindingResult = await client.query<{ was_closed: boolean } & Record<string, unknown>>(
      `WITH old AS (
         SELECT * FROM control_plane.telegram_chat_bindings WHERE trip_id = $1 FOR UPDATE
       )
       UPDATE control_plane.telegram_chat_bindings b
          SET closed_at = CASE WHEN old.closed_at IS NULL THEN now() ELSE old.closed_at END,
              closed_reason = CASE WHEN old.closed_at IS NULL THEN 'operator_cleared' ELSE old.closed_reason END
         FROM old
        WHERE b.id = old.id
      RETURNING old.*, (old.closed_at IS NULL) AS was_closed`,
      [tripId],
    );
    // EVER_PROVISIONED, signal 2, LOCKED re-check — same reasoning as
    // tokens' own re-check just above, for a chat binding instead. This is
    // the specific race the round-7 reviewer reproduced (R7-4): a SECOND
    // session's binding INSERT, committed while this call was paused
    // mid-wait on an unrelated lock, caught by a later blind `WHERE trip_id
    // = $1` mutation with no trace in the archive. `organizer-trips.ts`'s
    // `/switch` command can create this row independently of any job, so
    // (unlike tokens) the jobs EARLY pass above cannot stand in for this
    // check BY ITSELF.
    //
    // CORRECTION (R8-3, boundary review round 8, 2026-10-15): an earlier
    // version of this comment claimed this check alone closes the `/switch`
    // race — it does not, on its own: a binding inserted AFTER this exact
    // statement runs but BEFORE `trips` is locked a few lines below would
    // slip past THIS check untouched (not destroyed — `/switch` never
    // touches anything this function also writes to — just a correctness
    // claim this comment got wrong, not a safety bug). What actually closes
    // that narrower window is the LATE, authoritative `everProvisioned`
    // re-check right after `trips` is locked, below — this statement's own
    // job is only to catch what already existed BEFORE this point.
    if (bindingResult.rows.length > 0) {
      await client.query("ROLLBACK");
      return { ok: false, reason: "EVER_PROVISIONED", detail: everProvisionedDetail() };
    }
    payload.telegram_chat_bindings = bindingResult.rows.map(({ was_closed, ...row }) => row);
    const bindingsClosed = bindingResult.rows.filter((r) => r.was_closed).length;

    // NOW lock `trips` — last, as every other transaction in this codebase
    // does when it touches this row at all. Its own pre-clear row is
    // captured here too, the same way — the read and the lock are one
    // statement, not a separate earlier look. (`trips` is looked up by its
    // own primary key, not a `trip_id` filter over potentially-many rows, so
    // R7-4's "new row the blind mutate also catches" bug class never applied
    // to this table — only WHICH values feed the archive did; see this
    // module's own doc.)
    const tripRows = await client.query<{ slug: string; lifecycle_state: string } & Record<string, unknown>>(
      "SELECT * FROM control_plane.trips WHERE id = $1 FOR UPDATE", [tripId]);
    payload.trips = tripRows.rows;
    const lockedTrip = tripRows.rows[0]!;

    // The three never-mutated tables (F-R9-2, boundary review round 9,
    // 2026-10-15) — read HERE, now that `trips` is locked, not back when the
    // EARLY pass ran. "Never mutated" was true and is still true, but it
    // only means MUTATION can't make these stale — it says nothing about a
    // brand-new row. `intake_versions` in particular can gain a row (a
    // confirmed intake version) WHILE this function is paused mid-wait on
    // some unrelated lock; reading it early archived a snapshot from before
    // that version existed, leaving the archive self-contradictory (a
    // session shown confirmed, with no matching version to show for it) —
    // not a data-loss bug, since nothing in this trio is ever deleted, but a
    // wrong archive is still wrong. Moved to the same point every other
    // final read in this function already happens, for the same reason.
    payload.trip_memberships = await unmutatedRows(client, "trip_memberships", tripId);
    payload.intake_versions = await unmutatedRows(client, "intake_versions", tripId);
    payload.organizer_invitations = await unmutatedRows(client, "organizer_invitations", tripId);

    // EVER_PROVISIONED, LATE AUTHORITATIVE pass (R8-2/R8-3, boundary review
    // round 8, 2026-10-15 — found AFTER round 8's own scope cut shipped, by
    // the SAME reviewer, on the SAME delta). CHECKED BEFORE UNREVOKED_SESSION
    // below (reordered, boundary review round 9, 2026-10-15): a trip can have
    // BOTH a stray session AND a job that reached `succeeded` during the same
    // wait, and the two refusals mean different things to whoever reads
    // them — EVER_PROVISIONED is permanent (there is no retry that helps; the
    // trip is simply out of this capability's scope for good), while
    // UNREVOKED_SESSION's own detail text suggests retrying once the stray
    // row is accounted for. Telling the caller UNREVOKED_SESSION when
    // EVER_PROVISIONED is ALSO true would be true but misleading — it invites
    // a retry that cannot possibly succeed. Checking this one first means a
    // trip that is both never sees anything but the permanent reason.
    //
    // The EARLY jobs pass just above and the per-table checks right after the
    // tokens/bindings CTE captures each close their own gap, but none of them
    // re-examines a row that did not exist yet when ITS OWN check ran: a
    // brand-new `jobs` row, created AND claimed AND run all the way to
    // `succeeded`/`failed` entirely within the window between the EARLY pass
    // and this point, was reproduced live reaching neither check — invisible
    // to the EARLY pass (didn't exist when it locked existing rows) and
    // invisible to the LATE `JOB_IN_PROGRESS` pass below (`succeeded`/
    // `failed` are excluded from ITS filter, on purpose, because that filter
    // answers a different question). The trip was genuinely provisioned
    // during the race, and clear would otherwise have reset its lifecycle
    // and freed its slug anyway.
    //
    // The fix: re-run `everProvisioned` itself — the exact SQL predicate
    // every other check in this function is derived from or defers to,
    // never a second, divergent implementation — as a PLAIN read on this
    // SAME client, no new lock. This is authoritative for the SAME reason
    // the `JOB_IN_PROGRESS` LATE pass below is: `trips` is now locked
    // exclusively by this transaction, and every path that can insert into
    // any of the three tables this predicate reads also needs `trips`
    // first — every job-creating path locks it directly (R4-1); a job
    // CLAIM locks it via `FOR UPDATE OF j, pa, t` (job-queue.ts's
    // `claimJob`); and both `jobs.trip_id` and `telegram_chat_bindings
    // .trip_id`/`telegram_group_binding_tokens.trip_id` are foreign keys
    // to `trips(id)`, so any INSERT into either needs at least a KEY SHARE
    // lock on this exact row, which conflicts with the `FOR UPDATE` this
    // transaction already holds. So nothing new can land in any of the
    // three tables, and no existing job can be freshly claimed, without
    // first waiting on the very lock this transaction already holds — a
    // plain read is therefore the true, final answer, with no need to
    // lock `jobs`/bindings/tokens a second time (which would reopen R4-2's
    // deadlock for jobs specifically, the reason the LATE `JOB_IN_PROGRESS`
    // pass below is already a plain read rather than its own `FOR UPDATE`).
    if (await everProvisioned(client, tripId)) {
      await client.query("ROLLBACK");
      return { ok: false, reason: "EVER_PROVISIONED", detail: everProvisionedDetail() };
    }

    // UNREVOKED_SESSION (F-R9-3, boundary review round 9, 2026-10-15 — the
    // most consequential of this round's three findings): the session and
    // enrollment steps above each ran, and finished, BEFORE `trips` was
    // locked — so a brand-new `intake_sessions` row (with its own freshly
    // `issued` `interview_enrollments` row) created for this trip WHILE this
    // function was paused mid-wait on some OTHER lock was not yet there to
    // be captured, revoked or deleted. Reproduced live: clear reported `ok`,
    // leaving a real, usable interview link and a live session behind on a
    // trip that was otherwise fully cleared — unlike a FRESH link an operator
    // or organizer might deliberately issue after a successful clear (that is
    // the normal, intended way back in), this one is specifically a row this
    // function's OWN archive/revoke steps should have caught and did not,
    // which is what the refusal exists to prevent.
    //
    // Both tables are FKs to `trips(id)` exactly like the three EVER_PROVISIONED
    // signal tables are, so the SAME reasoning as the LATE AUTHORITATIVE pass
    // just above applies: once `trips` is locked, nothing new can land in
    // either without first waiting on this very lock, so a plain read here is
    // final. Unlike that check, this one does not need to re-derive which ids
    // are "new" — the session/enrollment steps above already mutated
    // EVERYTHING that existed when they ran (every session deleted, every
    // `issued` enrollment revoked), so ANY row still matching `trip_id = $1`
    // (for sessions) or `trip_id = $1 AND state = 'issued'` (for enrollments)
    // at this point can only be one that arrived after those steps already
    // finished — there is nothing left to exclude by id.
    const stray = await client.query<{ sessions: string; enrollments: string }>(
      `SELECT
         (SELECT count(*) FROM control_plane.intake_sessions WHERE trip_id = $1)::text AS sessions,
         (SELECT count(*) FROM control_plane.interview_enrollments WHERE trip_id = $1 AND state = 'issued')::text AS enrollments`,
      [tripId],
    );
    const strayRow = stray.rows[0]!;
    if (Number(strayRow.sessions) > 0 || Number(strayRow.enrollments) > 0) {
      await client.query("ROLLBACK");
      return {
        ok: false,
        reason: "UNREVOKED_SESSION",
        detail: "a new intake session or interview enrollment for this trip appeared while clear was " +
          "already running, after this function's own session/enrollment steps had already finished — " +
          "refusing rather than leaving it live on a trip whose slug is about to be retired. There is no " +
          "override; retry the clear once whatever created it (a fresh interview link, most likely) is " +
          "accounted for.",
      };
    }

    // JOB_IN_PROGRESS, LATE pass — a PLAIN re-read, no `FOR UPDATE` needed:
    // this transaction now holds the `trips` lock exclusively, and every
    // path that can create or revive a job for this trip also locks `trips`
    // before committing one (`generatePlan`'s own locked re-check, R4-1;
    // `issueApproval`; `retryProvision`; the worker's `_claim`, via
    // `FOR UPDATE OF j, pa, t`). So nothing can still be creating a job for
    // this trip without first waiting on the very lock this transaction
    // already holds — a plain read of the current committed state is
    // therefore authoritative. This is what still catches a job a
    // concurrent `generatePlan` created while THIS call was waiting to
    // acquire `trips` (R4-1's own scenario) without this function ever
    // having to lock `jobs` a second time, which would reopen R4-2's
    // deadlock right back up.
    const lateJobs = await client.query<{ id: string; job_type: string; state: string }>(
      `SELECT id, job_type, state FROM control_plane.jobs
        WHERE trip_id = $1 AND state NOT IN ('succeeded', 'failed', 'cancelled')
        ORDER BY created_at LIMIT 1`,
      [tripId],
    );
    const lateInProgress = lateJobs.rows[0];
    if (lateInProgress) {
      await client.query("ROLLBACK");
      return {
        ok: false,
        reason: "JOB_IN_PROGRESS",
        detail: jobInProgressDetail({ id: lateInProgress.id, jobType: lateInProgress.job_type, state: lateInProgress.state }),
      };
    }

    // ARCHIVE — written now that both job checks have passed. "No archive on
    // a refusal" still holds: nothing above wrote to `trip_clear_archives`,
    // and everything above rolls back cleanly if either check had fired.
    // slug_at_archive/lifecycle_state_at_archive come from `lockedTrip` — the
    // LOCKED read taken just above — never from `plan` (buildPlan's earlier,
    // unlocked, pre-transaction read), which R7-4's "minor" finding named
    // directly: a trip renamed or transitioned between those two reads would
    // otherwise archive the wrong pre-clear slug/state.
    const archiveId = generateId("tca");
    await client.query(
      `INSERT INTO control_plane.trip_clear_archives
         (id, trip_id, slug_at_archive, lifecycle_state_at_archive, payload, created_by)
       VALUES ($1, $2, $3, $4, $5::jsonb, $6)`,
      [archiveId, tripId, lockedTrip.slug, lockedTrip.lifecycle_state, JSON.stringify(payload), actorRef],
    );

    // Lifecycle reset + slug retirement — one UPDATE on `trips`, now that it
    // is already locked above. Retiring the slug frees it for reuse, same
    // convention as teardown-trip.py's `retire_in_db` (trip-retirement.ts's
    // RETIRED_SLUG_PREFIX) — skipped only if this trip's slug was already
    // retired. EVER_PROVISIONED's own refusal (above) means every trip that
    // reaches this point has no physical infra at all, so — unlike before
    // round 8 — there is never a reason to HOLD the slug; it is always safe
    // to retire immediately.
    let slugAfter = lockedTrip.slug;
    if (!lockedTrip.slug.startsWith(RETIRED_SLUG_PREFIX)) {
      const base = `${RETIRED_SLUG_PREFIX}${lockedTrip.slug}-${new Date().toISOString().slice(0, 10).replace(/-/g, "")}`;
      let candidate = base;
      for (let n = 2; n < 20; n++) {
        const clash = await client.query("SELECT 1 FROM control_plane.trips WHERE slug = $1", [candidate]);
        if (clash.rows.length === 0) break;
        candidate = `${base}-${n}`;
      }
      slugAfter = candidate;
    }
    await client.query(
      "UPDATE control_plane.trips SET slug = $2, lifecycle_state = 'draft', updated_at = now() WHERE id = $1",
      [tripId, slugAfter],
    );

    // AUDIT — same transaction as the mutation, admin-mutations.ts's own
    // posture ("a mutation this consequential should not exist without
    // one"). Evidence is opaque-shaped only — see admin-dashboard.ts's
    // EVIDENCE_ALLOWLIST entry for 'operator.clear_trip' and this module's
    // own doc on why the full payload is NOT here.
    const stepsPerformed = {
      enrollmentsRevoked,
      agentTurnsDeleted: turnsDeleted.rowCount ?? 0,
      intakeSessionsDeleted: sessionsDeleted.rowCount ?? 0,
      // Named without the substring this database's canonical-evidence guard
      // (control_plane.canonical_json_is_safe, migration 0004) rejects
      // unconditionally in any evidence key: "token" (also: password,
      // secret, credential, api_key, chat_id, telegram_id, vmid, ...).
      // "Codes" here means the group-binding tokens this step revoked.
      groupBindingCodesRevoked: tokensRevoked,
      chatBindingsClosed: bindingsClosed,
      lifecycleResetToDraft: true,
      slugRetired: slugAfter !== lockedTrip.slug,
    };
    await client.query(
      `INSERT INTO control_plane.audit_events
         (id, actor_ref, action, target_ref, correlation_id, evidence, occurred_at)
       VALUES ($1, $2, 'operator.clear_trip', $3, $4, $5::jsonb, now())`,
      [
        generateId("audit"),
        actorRef,
        tripId,
        generateId("corr"),
        JSON.stringify({
          ok: true,
          archiveId,
          slugBefore: lockedTrip.slug,
          slugAfter,
          ...stepsPerformed,
        }),
      ],
    );

    await client.query("COMMIT");
    return {
      ok: true,
      tripId,
      archiveId,
      slugBefore: lockedTrip.slug,
      slugAfter,
      stepsPerformed,
    };
  } catch (err) {
    await client.query("ROLLBACK").catch(() => undefined);
    // F-R9-1: absorb exactly one real deadlock by retrying the whole
    // transaction with a fresh client/fresh locks — see this function's own
    // doc. Anything else (including a SECOND deadlock) still throws.
    if (isDeadlockError(err) && attempt === 1) continue;
    throw err;
  } finally {
    client.release();
  }
  }
  // Unreachable: every path above either returns or throws. Satisfies TS's
  // control-flow analysis across a `for` loop without an explicit trailing
  // return inside it.
  throw new Error("executeClear: retry loop exited without returning");
}

/**
 * Reverses an `executeClear` call from its archive — a scripted restore,
 * demonstrating the archive is actually usable rather than only written
 * (issue #378's done-when criterion). Not wired to any route: an operator
 * restoring from this archive is a deliberate, rare act best done by someone
 * reading the payload first, not a one-click HTTP undo next to a one-click
 * destroy. Used by this file's own test; kept exported so a future operator
 * tool (or a one-off script) has a real function to call instead of
 * hand-rolling it again.
 *
 * Two different shapes of restore, because `executeClear` did two different
 * shapes of damage:
 *   - `intake_sessions` and everything `SESSION_CASCADE_TABLES` names
 *     (`interview_agent_turns`, `interview_interpretations`,
 *     `intake_pending_changes`) were DELETED — directly, or via
 *     `intake_sessions`'s own cascade — so restoring them is a re-INSERT of
 *     the archived rows (skipped if the row is somehow already there — a
 *     restore onto a trip cleared twice is a conflict the caller must
 *     resolve, not something this overwrites).
 *   - `trips` (slug, lifecycle_state), `interview_enrollments` (state),
 *     `telegram_chat_bindings` (closed_at/closed_reason) and
 *     `telegram_group_binding_tokens` (expires_at) were only MUTATED — the
 *     rows still exist — so restoring them is an UPDATE back to the
 *     archived pre-clear values, by id, not an insert that would never
 *     match anything.
 *
 * `jobs` and `plan_approvals` are not part of either shape: `executeClear`
 * never reaches a mutation while either table has a non-terminal row for
 * this trip (JOB_IN_PROGRESS), so there is nothing on them to restore.
 */
export async function restoreFromArchive(db: pg.Pool, archiveId: string): Promise<Record<string, number>> {
  const archived = await db.query<{ payload: Record<string, unknown[]> }>(
    "SELECT payload FROM control_plane.trip_clear_archives WHERE id = $1",
    [archiveId],
  );
  const payload = archived.rows[0]?.payload;
  if (!payload) throw new Error(`no archive ${archiveId}`);

  const restored: Record<string, number> = {};
  const client = await db.connect();
  try {
    await client.query("BEGIN");

    // Re-inserted: rows `executeClear` deleted outright (directly, or via
    // `intake_sessions`'s own cascade — SESSION_CASCADE_TABLES, F1). Order
    // matters for foreign keys — sessions before everything that references
    // them.
    for (const table of ["intake_sessions", ...SESSION_CASCADE_TABLES] as const) {
      const rows = (payload[table] ?? []) as Record<string, unknown>[];
      for (const row of rows) {
        const keys = Object.keys(row);
        const columns = keys.map((k) => `"${k}"`).join(", ");
        const placeholders = keys.map((_, i) => `$${i + 1}`).join(", ");
        await client.query(
          `INSERT INTO control_plane.${table} (${columns}) VALUES (${placeholders})
           ON CONFLICT (id) DO NOTHING`,
          keys.map((k) => row[k]),
        );
      }
      restored[table] = rows.length;
    }

    // Restored in place: rows `executeClear` only mutated, by id.
    for (const row of (payload.trips ?? []) as Record<string, unknown>[]) {
      await client.query(
        "UPDATE control_plane.trips SET slug = $2, lifecycle_state = $3 WHERE id = $1",
        [row.id, row.slug, row.lifecycle_state],
      );
    }
    restored.trips = ((payload.trips ?? []) as unknown[]).length;

    for (const row of (payload.interview_enrollments ?? []) as Record<string, unknown>[]) {
      await client.query(
        "UPDATE control_plane.interview_enrollments SET state = $2 WHERE id = $1",
        [row.id, row.state],
      );
    }
    restored.interview_enrollments = ((payload.interview_enrollments ?? []) as unknown[]).length;

    for (const row of (payload.telegram_chat_bindings ?? []) as Record<string, unknown>[]) {
      await client.query(
        "UPDATE control_plane.telegram_chat_bindings SET closed_at = $2, closed_reason = $3 WHERE id = $1",
        [row.id, row.closed_at, row.closed_reason],
      );
    }
    restored.telegram_chat_bindings = ((payload.telegram_chat_bindings ?? []) as unknown[]).length;

    for (const row of (payload.telegram_group_binding_tokens ?? []) as Record<string, unknown>[]) {
      await client.query(
        "UPDATE control_plane.telegram_group_binding_tokens SET expires_at = $2 WHERE id = $1",
        [row.id, row.expires_at],
      );
    }
    restored.telegram_group_binding_tokens = ((payload.telegram_group_binding_tokens ?? []) as unknown[]).length;

    await client.query("COMMIT");
  } catch (err) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw err;
  } finally {
    client.release();
  }
  return restored;
}
