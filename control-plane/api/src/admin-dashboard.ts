// Read-only queries behind the super-admin dashboard's slice 1 (Sprint 6,
// decision 23 in docs/sprint6-tracks.md). This module never mutates state —
// suspend/retry is slice 2, explicitly out of scope here — and every function
// takes a pool and returns plain data for app.ts's routes to serve.
//
// This file reads across every trip, on purpose: that is the one thing no
// other authenticated route in this codebase does (everything else is scoped
// to a single trip through a binding or a trip id). The authorization gate
// lives in app.ts (`adminAuth`, X-API-Key against CONTROL_PLANE_ADMIN_KEY);
// this module assumes the caller already passed it.
//
// WHAT IS SPEC-BACKED VS DESIGN CHOICE, stated once so each function does not
// have to repeat it:
//
//   - `listJobs`, `listRedactedFailures` and `listAuditEvents` read tables
//     (`jobs`, `audit_events`) whose shape is not this file's to invent —
//     the response is a direct, redacted projection of existing rows.
//   - `listReleases` for the "versions" row is release-registry.ts's own
//     existing function, re-exported here for one import path; not new logic.
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
import { redact } from "./redaction.js";
import { listReleases, type ReleaseSummary } from "./release-registry.js";

function generateId(prefix: string): string {
  return `${prefix}_${randomBytes(16).toString("hex")}`;
}

export { listReleases, type ReleaseSummary };

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

export interface FailureRow {
  id: string;
  tripId: string;
  tripSlug: string;
  jobType: string;
  attempt: number;
  safeErrorCode: string | null;
  result: unknown;
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
    safe_error_code: string | null; result: unknown; created_at: Date; updated_at: Date;
  }>(
    `SELECT j.id, j.trip_id, t.slug, j.job_type, j.attempt, j.safe_error_code, j.result, j.created_at, j.updated_at
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
      // Blanket redaction, same rule sanitizeConfig() follows: whatever a job
      // recorded as its result is not assumed safe just because it reached
      // this table. redact() strips known-sensitive keys and patterns; it is
      // not a per-field judgment call.
      result: redact(r.result),
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
      id: r.id, actorRef: r.actor_ref, action: r.action, targetRef: r.target_ref,
      correlationId: r.correlation_id, evidence: redact(r.evidence),
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
