/**
 * The review queue: where `plan-review.ts`'s proposals wait for an organizer,
 * and the background drain that fills it after a trip is provisioned.
 *
 * Shaped after `venue-links.ts`, which solves the same problem one layer down:
 * something the interview could not finish is parked, and a loop in server.ts
 * finishes it later. The same reasoning applies harder here, because a plan
 * review wants a model call per leg and a provision job is the wrong place to
 * spend ninety seconds of somebody's deploy.
 *
 * THREE PROPERTIES THIS FILE EXISTS TO HOLD:
 *
 *  1. A proposal is identified by what it SAYS, not by when it was made.
 *     `(trip_id, proposal_id)` is the primary key and `proposal_id` is the
 *     content fingerprint from plan-review.ts, so re-reviewing an unchanged
 *     plan updates rows rather than filing a second copy of every finding.
 *     The trip site's living-journey.js learned this the same way — its
 *     `trip_quality_issues` are keyed by fingerprint for exactly this reason.
 *
 *  2. AN ORGANIZER'S DECISION IS STICKY. A later review refreshes a
 *     proposal's wording and never touches its status. Dismissing "this day
 *     is too full" has to mean it, or the queue becomes something people stop
 *     opening — which is how the trip site's own enrichment queue ended up
 *     ignored, and a queue nobody reads is worse than no queue.
 *
 *  3. Nothing here writes to a plan. `patch` is stored, never applied. The
 *     component that applies an accepted patch to a live trip does not exist
 *     yet, and building it in the same pass as the thing that GENERATES the
 *     patches would have meant a model's opinion reaching a family's
 *     itinerary with one bug between them.
 */
import { createHash, randomBytes } from "node:crypto";
import type pg from "pg";
import type { StructuredModelRunner } from "./model-runner.js";
import { reviewPlan, type PlanProposal, type PlanReview } from "./plan-review.js";

function reviewId(): string {
  return `plrev_${randomBytes(12).toString("hex")}`;
}

/** sha256 of the config as stored. Recorded on the review so a finding can
 *  always be traced to the exact plan that produced it. */
export function configDigest(config: unknown): string {
  return `sha256:${createHash("sha256").update(JSON.stringify(config ?? null)).digest("hex")}`;
}

export interface StoredProposal extends PlanProposal {
  status: "proposed" | "accepted" | "dismissed" | "fixed";
  firstSeenAt: Date;
  lastSeenAt: Date;
}

/**
 * Write one review and reconcile the trip's queue against it.
 *
 * Reconciliation, in one transaction:
 *   - every proposal in this review is upserted, keeping its status;
 *   - every row still `proposed` that this review did NOT raise becomes
 *     `fixed` — the plan changed and the finding no longer applies. Only
 *     `proposed` rows: an `accepted` one is a decision, and a `dismissed` one
 *     is a decision, and neither becomes "fixed" because a later pass stopped
 *     mentioning it.
 */
export async function savePlanReview(
  db: pg.Pool,
  tripId: string,
  review: PlanReview,
  config: unknown,
): Promise<{ reviewId: string; written: number; fixed: number }> {
  const id = reviewId();
  const client = await db.connect();
  try {
    await client.query("BEGIN");
    await client.query(
      // `created_at` is deliberately NOT `review.generatedAt`, and the column's
      // `DEFAULT now()` is what fills it. It is compared with
      // `trips.plan_snapshot_at` further down (`r.created_at >= t.plan_snapshot_at`),
      // and that column is written by the worker as Postgres `now()`
      // (provisioner.py). `generatedAt` is the API process's own wall clock —
      // a different machine in production — so the two sides of that `>=` came
      // from two clocks that drift independently. When the API host ran even a
      // few milliseconds behind the database, a review that HAD just been
      // written looked older than the snapshot it reviewed, the trip stayed in
      // the queue, and the post-deploy pass reviewed it again on every tick.
      // Both sides now come from the database clock. `generatedAt` stays on the
      // returned review as the moment the work started; nothing else reads this
      // column. See #134.
      `INSERT INTO control_plane.plan_reviews (id, trip_id, config_digest, model_used, model_skipped, rejected)
       VALUES ($1, $2, $3, $4, $5, $6::jsonb)`,
      [
        id,
        tripId,
        configDigest(config),
        review.modelUsed,
        review.modelSkipped,
        JSON.stringify(review.rejected),
      ],
    );

    for (const proposal of review.proposals) {
      await client.query(
        `INSERT INTO control_plane.plan_review_proposals
           (trip_id, proposal_id, review_id, kind, severity, phase_id, day_date,
            title, detail, ask, patch, evidence, origin, last_seen_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11::jsonb,$12::jsonb,$13, now())
         ON CONFLICT (trip_id, proposal_id) DO UPDATE SET
           review_id = EXCLUDED.review_id,
           severity  = EXCLUDED.severity,
           title     = EXCLUDED.title,
           detail    = EXCLUDED.detail,
           ask       = EXCLUDED.ask,
           patch     = EXCLUDED.patch,
           evidence  = EXCLUDED.evidence,
           origin    = EXCLUDED.origin,
           last_seen_at = now(),
           -- Property 2. A finding that comes back after being dismissed is
           -- the same finding; only its wording is allowed to improve. The
           -- one exception is 'fixed': the plan regressed, so it is open again.
           status    = CASE WHEN control_plane.plan_review_proposals.status = 'fixed'
                            THEN 'proposed'
                            ELSE control_plane.plan_review_proposals.status END`,
        [
          tripId,
          proposal.id,
          id,
          proposal.kind,
          proposal.severity,
          proposal.phaseId,
          proposal.date,
          proposal.title,
          proposal.detail,
          proposal.ask,
          proposal.patch ? JSON.stringify(proposal.patch) : null,
          JSON.stringify(proposal.evidence),
          proposal.origin,
        ],
      );
    }

    // "This review did not raise it, so the organizer fixed it" is only a
    // safe conclusion if the review could READ the plan. A snapshot that does
    // not parse produces zero proposals and would otherwise close every open
    // finding on the trip at once — a corrupt input reading as a tidy-up.
    let fixed = 0;
    if (review.phasesReviewed > 0) {
      const ids = review.proposals.map((proposal) => proposal.id);
      const swept = await client.query(
        `UPDATE control_plane.plan_review_proposals
         SET status = 'fixed', last_seen_at = now()
         WHERE trip_id = $1 AND status = 'proposed' AND NOT (proposal_id = ANY($2::text[]))`,
        [tripId, ids],
      );
      fixed = swept.rowCount ?? 0;
    }
    await client.query("COMMIT");
    return { reviewId: id, written: review.proposals.length, fixed };
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

/** The queue for one trip. Defaults to what is still waiting on somebody. */
export async function planReviewQueue(
  db: pg.Pool,
  tripId: string,
  statuses: readonly string[] = ["proposed"],
): Promise<StoredProposal[]> {
  const rows = await db.query(
    `SELECT proposal_id, kind, severity, phase_id, day_date, title, detail, ask,
            patch, evidence, origin, status, first_seen_at, last_seen_at
     FROM control_plane.plan_review_proposals
     WHERE trip_id = $1 AND status = ANY($2::text[])
     ORDER BY CASE severity WHEN 'warning' THEN 0 ELSE 1 END,
              day_date NULLS LAST, phase_id, proposal_id`,
    [tripId, [...statuses]],
  );
  return rows.rows.map((row) => ({
    id: row.proposal_id,
    kind: row.kind,
    severity: row.severity,
    phaseId: row.phase_id,
    // `date` is a DATE column; pg hands back a Date in the server's zone, and
    // an ISO slice of that can land on the previous day west of UTC. Formatted
    // from the local parts instead — these are calendar days on a trip, not
    // instants.
    date: row.day_date ? localIsoDate(row.day_date) : null,
    title: row.title,
    detail: row.detail,
    ask: row.ask,
    ...(row.patch ? { patch: row.patch } : {}),
    evidence: row.evidence,
    origin: row.origin,
    status: row.status,
    firstSeenAt: row.first_seen_at,
    lastSeenAt: row.last_seen_at,
  }));
}

function localIsoDate(value: Date): string {
  const year = value.getFullYear();
  const month = String(value.getMonth() + 1).padStart(2, "0");
  const day = String(value.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

/** An organizer's decision on one proposal. Sticky — see property 2. */
export async function decidePlanProposal(
  db: pg.Pool,
  tripId: string,
  proposalId: string,
  status: "accepted" | "dismissed",
  actorRef: string,
): Promise<boolean> {
  const result = await db.query(
    `UPDATE control_plane.plan_review_proposals
     SET status = $3, decided_by = $4, decided_at = now()
     WHERE trip_id = $1 AND proposal_id = $2`,
    [tripId, proposalId, status, actorRef],
  );
  return (result.rowCount ?? 0) > 0;
}

// ── The drain ────────────────────────────────────────────────────────────────

export interface PendingTrip {
  tripId: string;
  config: unknown;
  answers: unknown;
  destination: string;
  documentText: string;
}

/**
 * Trips whose deployed plan has never been reviewed, or has been re-deployed
 * since its last review.
 *
 * `plan_snapshot_at > last review` rather than a digest comparison: a
 * re-provision that produced an identical config still costs one review, and
 * that is the cheap direction to be wrong in. The expensive direction — a
 * changed plan whose digest happened to collide with the review loop's idea of
 * "already done" — would leave a trip permanently unreviewed with nothing
 * saying so.
 */
export async function tripsNeedingPlanReview(db: pg.Pool, limit = 3): Promise<PendingTrip[]> {
  const rows = await db.query(
    `SELECT t.id                AS trip_id,
            t.plan_snapshot     AS config,
            iv.data             AS answers,
            iv.source_document  AS source_document
     FROM control_plane.trips t
     LEFT JOIN LATERAL (
       SELECT data, source_document
       FROM control_plane.intake_versions
       WHERE trip_id = t.id
       ORDER BY version DESC
       LIMIT 1
     ) iv ON TRUE
     WHERE t.plan_snapshot IS NOT NULL
       AND t.plan_snapshot_at IS NOT NULL
       AND NOT EXISTS (
         SELECT 1 FROM control_plane.plan_reviews r
         WHERE r.trip_id = t.id AND r.created_at >= t.plan_snapshot_at
       )
     ORDER BY t.plan_snapshot_at ASC
     LIMIT $1`,
    [limit],
  );
  return rows.rows.map((row) => ({
    tripId: row.trip_id,
    config: row.config,
    answers: row.answers ?? null,
    destination: destinationOf(row.answers),
    documentText: documentTextOf(row.source_document),
  }));
}

/** The intake's `destination` answer, which the built config does not carry —
 *  it reaches trip.config.json only as a title and a `travel_info` country
 *  key. The review uses it to trim a venue name's trailing city word. */
function destinationOf(answers: unknown): string {
  if (!answers || typeof answers !== "object") return "";
  const node = (answers as Record<string, unknown>).destination;
  if (!node || typeof node !== "object") return "";
  const answer = node as Record<string, unknown>;
  const text = answer.kind === "text" ? answer.text : answer.other_text;
  return String(text ?? "").trim().slice(0, 120);
}

function documentTextOf(sourceDocument: unknown): string {
  if (!sourceDocument || typeof sourceDocument !== "object") return "";
  return String((sourceDocument as Record<string, unknown>).text ?? "");
}

export interface DrainDeps {
  /** Absent means the deterministic half only — a smaller review, never a
   *  broken one, and the reason is recorded on the review row. */
  runner?: StructuredModelRunner;
  log?: (line: string) => void;
}

/**
 * One pass. Reviews up to `limit` trips and writes each result.
 *
 * Never throws: this runs on a `setInterval` where an escaping rejection is an
 * unhandled promise and, on a Node that is configured to, a dead API process.
 * `resolvePendingVenueLinks` is wrapped by its caller for the same reason;
 * this one wraps itself, because a review failing for one trip must not stop
 * the next trip in the same pass.
 */
export async function runPendingPlanReviews(
  db: pg.Pool,
  deps: DrainDeps = {},
  limit = 3,
): Promise<number> {
  const log = deps.log ?? (() => undefined);
  let pending: PendingTrip[];
  try {
    pending = await tripsNeedingPlanReview(db, limit);
  } catch (error) {
    log(`plan_review.query_failed ${String(error)}`);
    return 0;
  }
  let reviewed = 0;
  for (const trip of pending) {
    try {
      const review = await reviewPlan({
        config: trip.config,
        answers: trip.answers,
        destination: trip.destination,
        documentText: trip.documentText,
        runner: deps.runner,
      });
      const written = await savePlanReview(db, trip.tripId, review, trip.config);
      reviewed += 1;
      log(
        `plan_review.done trip=${trip.tripId} proposals=${written.written} fixed=${written.fixed} `
        + `model_used=${review.modelUsed} model_skipped=${review.modelSkipped ?? "-"} `
        + `rejected=${review.rejected.length}`,
      );
    } catch (error) {
      // No retry bookkeeping on purpose. The trip stays un-reviewed, so the
      // next tick picks it up again — which is the right behaviour for a pass
      // whose usual failure is a model being briefly unreachable. A permanent
      // failure shows as the same line every five minutes, which is a symptom
      // somebody can see, rather than a row that quietly aged out.
      log(`plan_review.failed trip=${trip.tripId} ${String(error)}`);
    }
  }
  return reviewed;
}
