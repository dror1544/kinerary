// Read-only queries behind the super-admin dashboard's slice 1 (Sprint 6,
// decision 23 in docs/sprint6-tracks.md). This module itself never mutates
// state — slice 2's suspend/retry mutations live in admin-mutations.ts, kept
// separate precisely so this sentence stays true without a reader having to
// re-check every function — and every function here takes a pool and returns
// plain data for app.ts's routes to serve.
//
// `EVIDENCE_ALLOWLIST` below is shared with admin-mutations.ts: that file
// writes `audit_events` rows for the three mutation actions listed in it
// (`admin.retry_trip`, `admin.suspend_trip`, `admin.resume_trip`), and
// `listAuditEvents`'s `/v1/admin/audit` route is what reads any of them back
// — so a mutation action needs an entry here for its evidence to be visible
// at all, on the same "a field not named is withheld, not exposed" rule as
// every other action in the map.
//
// This file reads across every trip, on purpose: that is the one thing no
// other authenticated route in this codebase does (everything else is scoped
// to a single trip through a binding or a trip id). The authorization gate
// lives in app.ts (`adminAuth`, X-API-Key against CONTROL_PLANE_ADMIN_KEY);
// this module assumes the caller already passed it.
//
// REDACTION IS ALLOW-LIST, NOT DENY-LIST (fixed 2026-09-27 after boundary
// review on PR #275, finding F1). `jobs.result` and `audit_events.evidence`
// are caller-shaped JSON blobs with no schema — nothing in this codebase
// today writes traveler text into either column, but the moment something
// does, a deny-list (`redact()`'s known-bad key names and three string
// patterns) lets it straight through, because that is what a deny-list is
// for: things it was told to remove. The boundary reviewer proved this live
// by seeding an email, a phone number, a child's name and age, an allergy
// note and a hotel address into both columns and reading every one of them
// back verbatim. That is the exact bug class `sanitizeConfig()`'s 2026-09-25
// rewrite (#172, CLAUDE.md "Security-sensitive paths") exists to forbid: "a
// field it does not name is withheld, silently and on purpose." So:
//
//   - `/v1/admin/failures` no longer serves `result` AT ALL. `safeErrorCode`
//     is the channel every job-failure path already designs to be safe
//     (`^[A-Z][A-Z0-9_]{2,63}$`, migrations 0001/0005) — there is nothing to
//     allow-list inside `result` worth keeping, so it is dropped whole.
//   - `/v1/admin/audit` serves `evidence` only through `EVIDENCE_ALLOWLIST`,
//     keyed by `action`: an action with a known key set gets exactly those
//     keys (via `projectEvidence`); an action with none — which includes
//     every action this codebase does not itself produce — gets `{}`. A
//     future writer that starts putting traveler text into `evidence` for a
//     NEW action name is withheld by default, not exposed by default.
//   - `promoted_by` (versions) is NOT the same shape of risk as the two
//     above: `control_plane.releases` carries an actual DB-level CHECK
//     (`promoted_by IS NULL OR promoted_by ~ '^[A-Za-z0-9:_.-]{1,128}$'`,
//     migration 0027) that every writer, present or future, has to satisfy —
//     free text (an email, a name with a space) cannot land there at all,
//     confirmed by reading the constraint rather than assumed. `safePlain`
//     is still applied to it below, but as defense-in-depth against that
//     CHECK ever being loosened, not because it was found exposed.
//   - `actorRef` / `targetRef` / `action` on `audit_events` are the real
//     version of that risk: that table carries NO DB-level format CHECK on
//     any of the three (confirmed by reading migrations 0001 and 0005 —
//     0005's opaque-id format sweep covers `audit_events.id`, not these).
//     Today's only writers happen to constrain `actorRef`/`action` at the
//     application layer before insert (`recordAdminRead`'s literals;
//     `promoteRelease`'s `PROMOTED_BY_RE` check on `actorRef`,
//     release-registry.ts) — but trusting that forever is the same
//     "individual fields judged harmless" reasoning CLAUDE.md's rule was
//     written against: nothing stops a future writer, migration, or direct
//     SQL from putting free text there (fixed 2026-09-27, boundary review on
//     PR #275 round 2, finding R1 — `action` was still a raw column when
//     round 1 shipped). So this file re-checks at the READ boundary too
//     (`safePlain`, below): a value that does not look like the opaque
//     machine identifiers this codebase actually produces (`user:<id>`,
//     `admin:api-key`, `operator:cli`, a release id, a trip id, `all_trips`,
//     a `YYYY-MM-DD` date, an action like `release.promote` or
//     `admin.read.jobs`) is withheld rather than served on trust. Fails safe,
//     per the same rule `shared/needs-schema.js` follows: unrecognized
//     resolves to the most restrictive option, not to "probably fine."
//     `action` is passed to `projectEvidence` in its RAW form regardless —
//     the allow-list lookup needs to see what is actually in the row to pick
//     the right bucket (or correctly find none); only the value served back
//     to the caller goes through `safePlain`.
//
// WHAT IS SPEC-BACKED VS DESIGN CHOICE, stated once so each function does not
// have to repeat it:
//
//   - `listJobs` and `listAuditEvents` read tables (`jobs`, `audit_events`)
//     whose shape is not this file's to invent — the response is a direct,
//     allow-list-projected view of existing rows, per the redaction note
//     above (not this file's invention either — it is CLAUDE.md's own rule).
//   - `listReleasesForAdmin` wraps release-registry.ts's own `listReleases`
//     (not new logic) and additionally applies `safePlain` to `promotedBy`.
//   - `getFunnelSummary` computes conversion rates over the CHECK-enforced
//     ten-name `funnel_events` vocabulary (db/migrations/0034). The choice of
//     which adjacent pairs count as a "conversion" (FUNNEL_SEQUENCE below) is
//     THIS FILE'S DESIGN, not a spec: no document names an ordered sequence
//     for these ten event names.
//   - `getDailyReport` is THIS FILE'S DESIGN, not the "Suggested Daily Control
//     Plan Report" specified in
//     .agents/skills/trip-assistant-experience-evaluation/references/control-plan-metrics.md
//     (Usage / Value Delivered / Information Quality / Learning and
//     Enrichment / Organizer Enablement) and restated in the sprint plan and
//     docs/trip-bot-analytics-and-metrics-design.md. That report is defined
//     entirely over `assistant_events` (response rate, grounded-answer rate,
//     missing-data rate, traveler self-service rate, post-write trust rate,
//     messages/travelers/follow-ups) — a table that exists but is unpopulated in
//     every deployment today (off by default, no ingest route, no Hermes
//     plugin; docs/sprint6-tracks.md "Data gathering" section). Building
//     against empty data would mean fabricating either a placeholder number
//     or a misleading zero, so this report is instead assembled from what
//     genuinely has rows — `funnel_events` and `jobs` — and says plainly, in
//     `notMeasuredYet`, which of the intended rates it is not computing and
//     why. This mirrors the sprint plan's own rule for the real report ("a
//     trip with no traffic renders an empty report rather than a
//     divide-by-zero or a fabricated rate") without claiming to BE it.

import { randomBytes } from "node:crypto";
import type pg from "pg";
import { listReleases, type ReleaseSummary } from "./release-registry.js";

function generateId(prefix: string): string {
  return `${prefix}_${randomBytes(16).toString("hex")}`;
}

export type { ReleaseSummary };

// The opaque-machine-identifier shape every legitimate actor_ref/target_ref/
// promoted_by value in this codebase takes — the SAME charset
// release-registry.ts's `PROMOTED_BY_RE` already enforces at write time for
// `promoted_by`, reused here as the read-time safety net for every column
// that shares its shape. No space, no `@`, no punctuation wide enough to
// carry a name, an email or a free-text note — a phone number formatted as
// digits-and-hyphens is the one PII shape narrow enough to slip through this
// charset, which is why this is a floor, not the whole fix: real free text
// (an email, a name, an address, an allergy note) cannot pass it.
const SAFE_PLAIN_TOKEN = /^[A-Za-z0-9:_.-]{1,200}$/;

function safePlain(value: string): string {
  return SAFE_PLAIN_TOKEN.test(value) ? value : "[REDACTED]";
}

/**
 * Per-action allow-list for `audit_events.evidence`. An action not listed
 * here — including every action a future writer might invent — gets `{}`:
 * withheld by default, exactly `sanitizeConfig()`'s rule for a config field
 * this codebase has not named. Keys not in an action's own list are dropped
 * even when the action IS listed; this is a projection, not a delete-the-rest.
 *
 * A `Map`, not a plain object (fixed 2026-09-27, boundary review on PR #275
 * round 2, finding R3): `action` is an unconstrained DB column (see the
 * module doc's `actorRef`/`targetRef` note — the same gap applies to it,
 * fixed separately below via `safePlain`), so a row whose `action` happens to
 * be a JS built-in property name (`constructor`, `__proto__`, `toString`, …)
 * would resolve against `{}[action]` as a plain-object lookup and return
 * `Object.prototype`'s own method instead of `undefined` — not a leak (it
 * fails closed: `for (const key of allowedKeys)` then throws on a
 * non-iterable, and the caught... except nothing catches it, so the whole
 * route 500s), but `audit_events` is append-only (0002's triggers block
 * UPDATE/DELETE/TRUNCATE), so one such row breaks `/v1/admin/audit`
 * permanently, not for one request. A `Map.get` never touches the prototype
 * chain regardless of what string it is asked for.
 *
 * Values are not further redacted: every key named below is populated only
 * by code in this repository from data that is itself format-constrained
 * (a release id, a status enum, a sha256 digest) — never from traveler or
 * organizer text. If that stops being true for an action, its entry here
 * has to be reconsidered, not just widened.
 */
const EVIDENCE_ALLOWLIST: ReadonlyMap<string, readonly string[]> = new Map([
  // release-registry.ts's promoteRelease() — from/to are ReleaseStatus enum
  // values, artifactDigest is the release's own sha256 digest.
  ["release.promote", ["from", "to", "artifactDigest"]],
  // recordAdminRead() below always writes '{}'::jsonb for these — listed
  // explicitly so a reader of this file does not have to guess whether the
  // omission is an oversight.
  ["admin.read.jobs", []],
  ["admin.read.funnel", []],
  ["admin.read.versions", []],
  ["admin.read.failures", []],
  ["admin.read.audit", []],
  ["admin.read.report", []],
  // Slice 2 mutations (admin-mutations.ts). `ok` is always a boolean; the
  // rest are opaque ids this codebase generates itself (retryProvision's own
  // plan/job/release ids) or a closed reason enum (RetryProvisionResult's own
  // `reason` union / SuspendTripResult's) — never traveler, organizer, or
  // even operator free text. The operator's suspend `reason` is deliberately
  // NOT in this list — see admin-mutations.ts's module doc for why it is
  // withheld from evidence on purpose, not an omission to fix later.
  ["admin.retry_trip", ["ok", "jobId", "planId", "releaseId", "supersededPlanId", "reason"]],
  // #review 2026-10-03, finding 5: a refusal is audited now too (admin-
  // mutations.ts), carrying SuspendTripResult's/ResumeTripResult's own
  // closed `reason` enum (TRIP_NOT_FOUND / ALREADY_SUSPENDED / NOT_SUSPENDED)
  // — same posture as admin.retry_trip's `reason` above, never free text.
  ["admin.suspend_trip", ["ok", "reason"]],
  ["admin.resume_trip", ["ok", "reason"]],
]);

function projectEvidence(action: string, evidence: unknown): unknown {
  const allowedKeys = EVIDENCE_ALLOWLIST.get(action);
  if (!allowedKeys || evidence === null || typeof evidence !== "object" || Array.isArray(evidence)) return {};
  const source = evidence as Record<string, unknown>;
  const projected: Record<string, unknown> = {};
  for (const key of allowedKeys) {
    if (Object.hasOwn(source, key)) projected[key] = source[key];
  }
  return projected;
}

// ── Versions ─────────────────────────────────────────────────────────────

export interface AdminReleaseSummary extends Omit<ReleaseSummary, "promotedBy"> {
  promotedBy: string | null;
}

/**
 * `listReleases` itself (release-registry.ts) is untouched — other callers
 * (the CLI, the CLI's own tests) still get the raw value. This wrapper is
 * the admin route's own read-time safety net on `promotedBy`, same reasoning
 * as `actorRef`/`targetRef` in the module doc above.
 */
export async function listReleasesForAdmin(db: pg.Pool): Promise<AdminReleaseSummary[]> {
  const releases = await listReleases(db);
  return releases.map((release) => ({
    ...release,
    promotedBy: release.promotedBy === null ? null : safePlain(release.promotedBy),
  }));
}

// ── Jobs ──────────────────────────────────────────────────────────────────

// Mirrors control_plane.jobs' CHECK constraint as of migration 0010, which
// widened the original list to add 'waiting_for_user_action' (the human
// approval gate) — see that migration's own comment before trusting this
// list again if the schema moves.
export const JOB_STATES = [
  "queued", "leased", "running", "waiting", "waiting_for_user_action",
  "succeeded", "failed", "cancelled",
] as const;
export type JobState = (typeof JOB_STATES)[number];

export const JOB_TYPES = [
  "provision", "activate", "upgrade", "rollback", "archive", "cleanup",
] as const;
export type JobType = (typeof JOB_TYPES)[number];

export interface JobRow {
  id: string;
  tripId: string;
  tripSlug: string;
  jobType: string;
  state: string;
  attempt: number;
  safeErrorCode: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface JobListFilters {
  tripId?: string;
  state?: JobState;
  jobType?: JobType;
  limit?: number;
  offset?: number;
}

const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 200;

function boundedLimit(limit: number | undefined): number {
  if (!Number.isFinite(limit) || !limit) return DEFAULT_LIMIT;
  return Math.min(Math.max(1, Math.trunc(limit as number)), MAX_LIMIT);
}

export async function listJobs(db: pg.Pool, filters: JobListFilters = {}): Promise<{ jobs: JobRow[]; limit: number; offset: number }> {
  const limit = boundedLimit(filters.limit);
  const offset = Math.max(0, Math.trunc(filters.offset ?? 0));
  const rows = await db.query<{
    id: string; trip_id: string; slug: string; job_type: string; state: string;
    attempt: number; safe_error_code: string | null; created_at: Date; updated_at: Date;
  }>(
    `SELECT j.id, j.trip_id, t.slug, j.job_type, j.state, j.attempt, j.safe_error_code, j.created_at, j.updated_at
       FROM control_plane.jobs j
       JOIN control_plane.trips t ON t.id = j.trip_id
      WHERE ($1::text IS NULL OR j.trip_id = $1)
        AND ($2::text IS NULL OR j.state = $2)
        AND ($3::text IS NULL OR j.job_type = $3)
      ORDER BY j.created_at DESC
      LIMIT $4 OFFSET $5`,
    [filters.tripId ?? null, filters.state ?? null, filters.jobType ?? null, limit, offset],
  );
  return {
    jobs: rows.rows.map((r) => ({
      id: r.id, tripId: r.trip_id, tripSlug: r.slug, jobType: r.job_type, state: r.state,
      attempt: r.attempt, safeErrorCode: r.safe_error_code,
      createdAt: r.created_at.toISOString(), updatedAt: r.updated_at.toISOString(),
    })),
    limit,
    offset,
  };
}

// ── Redacted failures ────────────────────────────────────────────────────

// NOT a redacted projection of `result` — `result` is not served at all.
// See the module doc's redaction note (F1): `result` is caller-shaped JSON
// with no allow-list worth building, because there is nothing inside it this
// route is designed to need. `safeErrorCode` is the whole answer to "what
// failed" that this route was ever meant to carry.
export interface FailureRow {
  id: string;
  tripId: string;
  tripSlug: string;
  jobType: string;
  attempt: number;
  safeErrorCode: string | null;
  createdAt: string;
  updatedAt: string;
}

export async function listRedactedFailures(
  db: pg.Pool,
  options: { since?: Date; limit?: number } = {},
): Promise<{ failures: FailureRow[]; limit: number }> {
  const limit = boundedLimit(options.limit);
  const rows = await db.query<{
    id: string; trip_id: string; slug: string; job_type: string; attempt: number;
    safe_error_code: string | null; created_at: Date; updated_at: Date;
  }>(
    // No j.result — never selected, so there is nothing for a future edit to
    // start passing through by accident.
    `SELECT j.id, j.trip_id, t.slug, j.job_type, j.attempt, j.safe_error_code, j.created_at, j.updated_at
       FROM control_plane.jobs j
       JOIN control_plane.trips t ON t.id = j.trip_id
      WHERE j.state = 'failed'
        AND ($1::timestamptz IS NULL OR j.updated_at >= $1)
      ORDER BY j.updated_at DESC
      LIMIT $2`,
    [options.since ?? null, limit],
  );
  return {
    failures: rows.rows.map((r) => ({
      id: r.id, tripId: r.trip_id, tripSlug: r.slug, jobType: r.job_type, attempt: r.attempt,
      safeErrorCode: r.safe_error_code,
      createdAt: r.created_at.toISOString(), updatedAt: r.updated_at.toISOString(),
    })),
    limit,
  };
}

// ── Audit ────────────────────────────────────────────────────────────────

export interface AuditRow {
  id: string;
  actorRef: string;
  action: string;
  targetRef: string;
  correlationId: string;
  evidence: unknown;
  occurredAt: string;
}

export async function listAuditEvents(
  db: pg.Pool,
  options: { since?: Date; action?: string; limit?: number } = {},
): Promise<{ events: AuditRow[]; limit: number }> {
  const limit = boundedLimit(options.limit);
  const rows = await db.query<{
    id: string; actor_ref: string; action: string; target_ref: string;
    correlation_id: string; evidence: unknown; occurred_at: Date;
  }>(
    `SELECT id, actor_ref, action, target_ref, correlation_id, evidence, occurred_at
       FROM control_plane.audit_events
      WHERE ($1::timestamptz IS NULL OR occurred_at >= $1)
        AND ($2::text IS NULL OR action = $2)
      ORDER BY occurred_at DESC
      LIMIT $3`,
    [options.since ?? null, options.action ?? null, limit],
  );
  return {
    events: rows.rows.map((r) => ({
      id: r.id, actorRef: safePlain(r.actor_ref), action: safePlain(r.action), targetRef: safePlain(r.target_ref),
      // The RAW action, not the display value above: the allow-list lookup
      // has to see exactly what is in the row to pick the right bucket (or
      // correctly find none) — redacting it first would make an
      // already-illegible action ALSO fail to match a legitimate entry it
      // might otherwise have matched, which is not a real case (a legitimate
      // action name is always `safePlain`-shaped already) but would be a
      // confusing accident to introduce.
      correlationId: r.correlation_id, evidence: projectEvidence(r.action, r.evidence),
      occurredAt: r.occurred_at.toISOString(),
    })),
    limit,
  };
}

/**
 * Writes the admin surface's own read to `audit_events` — "log who read what
 * at the audit level", per the brief. `actorRef` is necessarily coarse: every
 * caller of `/v1/admin/*` presents the same shared key today, so this cannot
 * yet distinguish one operator from another. That is a real limitation, not
 * an oversight — see the handover's carry-forward. Best-effort: a failure
 * here must never turn a successful read into a 500, so callers should log
 * and continue rather than throw.
 */
export async function recordAdminRead(
  db: pg.Pool,
  action: string,
  targetRef: string,
): Promise<void> {
  await db.query(
    `INSERT INTO control_plane.audit_events
       (id, actor_ref, action, target_ref, correlation_id, evidence, occurred_at)
     VALUES ($1, 'admin:api-key', $2, $3, $4, '{}'::jsonb, now())`,
    [generateId("audit"), action, targetRef, `corr_${randomBytes(8).toString("hex")}`],
  );
}

// ── Funnel ───────────────────────────────────────────────────────────────

// The CHECK-enforced vocabulary (db/migrations/0034_web_portal_addenda.sql).
export const FUNNEL_EVENT_NAMES = [
  "landing_cta", "google_auth", "draft_created", "interview_launched",
  "interview_confirmed", "provisioning_requested", "provisioning_approved",
  "provisioning_completed", "runtime_launched", "invitation_redeemed",
] as const;
export type FunnelEventName = (typeof FUNNEL_EVENT_NAMES)[number];

// DESIGN CHOICE (see module doc): the ordered organic-signup path a visitor
// walks. `invitation_redeemed` is a distinct entry point (an operator's
// invitation, not the landing page) and is reported as its own count rather
// than forced into this chain.
const FUNNEL_SEQUENCE: readonly FunnelEventName[] = [
  "landing_cta", "google_auth", "draft_created", "interview_launched",
  "interview_confirmed", "provisioning_requested", "provisioning_approved",
  "provisioning_completed", "runtime_launched",
];

export interface FunnelConversion {
  from: FunnelEventName;
  to: FunnelEventName;
  fromCount: number;
  toCount: number;
  // null, never NaN or a fabricated 0, when the "from" step never happened —
  // see the module doc's "never a divide-by-zero or a fabricated rate" rule.
  rate: number | null;
}

export interface FunnelSummary {
  since: string | null;
  until: string | null;
  counts: Record<string, number>;
  conversions: FunnelConversion[];
}

export async function getFunnelSummary(
  db: pg.Pool,
  window: { since?: Date; until?: Date } = {},
): Promise<FunnelSummary> {
  const rows = await db.query<{ event_name: string; n: string }>(
    `SELECT event_name, count(*)::text AS n
       FROM control_plane.funnel_events
      WHERE ($1::timestamptz IS NULL OR created_at >= $1)
        AND ($2::timestamptz IS NULL OR created_at < $2)
      GROUP BY event_name`,
    [window.since ?? null, window.until ?? null],
  );
  const counts: Record<string, number> = {};
  for (const name of FUNNEL_EVENT_NAMES) counts[name] = 0;
  for (const row of rows.rows) counts[row.event_name] = Number(row.n);

  const conversions: FunnelConversion[] = [];
  for (let i = 0; i < FUNNEL_SEQUENCE.length - 1; i += 1) {
    const from = FUNNEL_SEQUENCE[i]!;
    const to = FUNNEL_SEQUENCE[i + 1]!;
    const fromCount = counts[from] ?? 0;
    const toCount = counts[to] ?? 0;
    conversions.push({
      from, to, fromCount, toCount,
      rate: fromCount > 0 ? toCount / fromCount : null,
    });
  }

  return {
    since: window.since ? window.since.toISOString() : null,
    until: window.until ? window.until.toISOString() : null,
    counts,
    conversions,
  };
}

// ── The report ───────────────────────────────────────────────────────────

// The five assistant-quality rates the sprint plan and
// docs/trip-bot-analytics-and-metrics-design.md describe for the daily
// control-plan report. Named here, not computed: see the module doc.
export const NOT_MEASURED_YET = [
  "response_rate",
  "grounded_answer_rate",
  "missing_data_rate",
  "traveler_self_service_rate",
  "post_write_trust_rate",
] as const;

export interface JobsByTypeAndState {
  jobType: string;
  state: string;
  count: number;
}

export interface DailyReport {
  date: string;
  windowStart: string;
  windowEnd: string;
  funnel: FunnelSummary;
  jobs: { byTypeAndState: JobsByTypeAndState[] };
  releases: { byStatus: Record<string, number> };
  notMeasuredYet: readonly string[];
}

function dayWindow(dateStr: string): { start: Date; end: Date } {
  const start = new Date(`${dateStr}T00:00:00.000Z`);
  const end = new Date(start.getTime() + 24 * 60 * 60 * 1000);
  return { start, end };
}

/** `YYYY-MM-DD`, strict, no rollover leniency — an invalid date is the
 * caller's mistake to fix, not this function's to guess at. */
export function isValidReportDate(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const { start } = dayWindow(value);
  return !Number.isNaN(start.getTime()) && start.toISOString().slice(0, 10) === value;
}

export async function getDailyReport(db: pg.Pool, dateStr: string): Promise<DailyReport> {
  const { start, end } = dayWindow(dateStr);

  const [funnel, jobRows, releaseRows] = await Promise.all([
    getFunnelSummary(db, { since: start, until: end }),
    db.query<{ job_type: string; state: string; n: string }>(
      `SELECT job_type, state, count(*)::text AS n
         FROM control_plane.jobs
        WHERE created_at >= $1 AND created_at < $2
        GROUP BY job_type, state
        ORDER BY job_type, state`,
      [start, end],
    ),
    db.query<{ status: string; n: string }>(
      `SELECT status, count(*)::text AS n
         FROM control_plane.releases
        GROUP BY status`,
    ),
  ]);

  const byStatus: Record<string, number> = {};
  for (const row of releaseRows.rows) byStatus[row.status] = Number(row.n);

  return {
    date: dateStr,
    windowStart: start.toISOString(),
    windowEnd: end.toISOString(),
    funnel,
    jobs: {
      byTypeAndState: jobRows.rows.map((r) => ({ jobType: r.job_type, state: r.state, count: Number(r.n) })),
    },
    releases: { byStatus },
    notMeasuredYet: NOT_MEASURED_YET,
  };
}
