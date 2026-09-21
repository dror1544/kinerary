/**
 * The review queue's three properties, which only a database can show.
 *
 * `plan-review.test.ts` covers the judge, which is pure and is where the
 * reasoning lives. What it cannot cover is what happens on the SECOND pass:
 * that re-reviewing an unchanged plan does not file a copy of every finding,
 * that an organizer's "no" survives the next review, and that a finding the
 * organizer actually fixed stops being asked about. All three are the
 * difference between a queue people open and a queue people learn to ignore.
 *
 * It also proves the loop picks a trip up at all: the post-deploy pass exists
 * because the provisioner now stores the plan it shipped, and a snapshot
 * nothing reads would be a column with a comment on it.
 */
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { describe, test } from "node:test";
import { fileURLToPath } from "node:url";
import pg from "pg";
import { applyMigrations } from "../src/migrations.js";
import { reviewPlan } from "../src/plan-review.js";
import {
  decidePlanProposal,
  planReviewQueue,
  runPendingPlanReviews,
  savePlanReview,
  tripsNeedingPlanReview,
} from "../src/plan-review-store.js";
import { testDatabaseUrl } from "./support/test-database.js";

const databaseUrl = testDatabaseUrl();
const SKIP = !databaseUrl;
const migrationsDir = fileURLToPath(new URL("../../db/migrations/", import.meta.url));

function testId(prefix: string): string {
  return `${prefix}_${randomBytes(16).toString("hex")}`;
}

/** The shape the pipeline ships today: a leg whose days hold only the dated
 *  things the organizer had already booked. */
const CONFIG = {
  phases: [
    {
      id: "tokyo",
      title: { he: "טוקיו", en: "Tokyo" },
      dates: { start: "2026-09-19", end: "2026-09-21" },
      accommodation: { name: "OMO3 Asakusa", name_en: "OMO3 Asakusa" },
      venues: [{ name: { he: "Tokyo Skytree", en: "Tokyo Skytree" } }],
      days: [
        { date: "2026-09-20", items: [
          { time: "18:00", text: { he: "teamLab", en: "teamLab Planets" } },
          { time: "10:00", text: { he: "Skytree", en: "Tokyo Skytree" } },
        ] },
      ],
    },
  ],
};

const ANSWERS = {
  destination: { kind: "text", text: "Japan" },
  trip_pace: { kind: "choice", option_id: "balanced" },
};

async function withDatabase(fn: (pool: pg.Pool) => Promise<void>): Promise<void> {
  const pool = new pg.Pool({ connectionString: databaseUrl });
  const client = await pool.connect();
  try {
    await client.query("DROP SCHEMA IF EXISTS control_plane CASCADE");
    await client.query("DROP TABLE IF EXISTS public.control_plane_schema_migrations");
    await applyMigrations(client, migrationsDir);
  } finally {
    client.release();
  }
  try {
    await fn(pool);
  } finally {
    await pool.end();
  }
}

async function seedTrip(pool: pg.Pool, options: { snapshot?: unknown; intake?: boolean } = {}): Promise<string> {
  const tripId = testId("trip");
  await pool.query(
    "INSERT INTO control_plane.trips(id, slug, lifecycle_state) VALUES ($1, $2, 'ready_private')",
    [tripId, tripId.replace(/_/g, "-")],
  );
  if (options.intake !== false) {
    await pool.query(
      `INSERT INTO control_plane.intake_versions(id, trip_id, version, artifact_ref, digest, confirmed_at, schema_version, data, source_document)
       VALUES ($1, $2, 1, $3, $4, now(), 2, $5::jsonb, $6::jsonb)`,
      [
        testId("intk"), tripId, `intake:${tripId}:v1`, `sha256:${"a".repeat(64)}`,
        JSON.stringify(ANSWERS),
        JSON.stringify({ filename: "plan.pdf", text: "Day 2 — Tokyo Skytree at 10:00, then teamLab Planets." }),
      ],
    );
  }
  if (options.snapshot !== undefined) {
    await pool.query(
      "UPDATE control_plane.trips SET plan_snapshot = $2::jsonb, plan_snapshot_at = now() WHERE id = $1",
      [tripId, JSON.stringify(options.snapshot)],
    );
  }
  return tripId;
}

describe("the review queue", { skip: SKIP ? "CONTROL_PLANE_TEST_DATABASE_URL not set" : false }, () => {
  test("reviewing the same plan twice does not file a second copy of every finding", async () => {
    await withDatabase(async (pool) => {
      const tripId = await seedTrip(pool);
      const review = await reviewPlan({ config: CONFIG, answers: ANSWERS, destination: "Japan" });
      assert.ok(review.proposals.length > 2);

      const first = await savePlanReview(pool, tripId, review, CONFIG);
      const second = await savePlanReview(pool, tripId, review, CONFIG);
      assert.equal(second.written, first.written);
      assert.equal(second.fixed, 0, "nothing was fixed — the plan did not change");

      const rows = await pool.query(
        "SELECT count(*)::int AS n FROM control_plane.plan_review_proposals WHERE trip_id = $1",
        [tripId],
      );
      assert.equal(rows.rows[0].n, review.proposals.length);

      // Two reviews, one row per finding, and the row points at the newer one.
      const reviews = await pool.query(
        "SELECT count(*)::int AS n FROM control_plane.plan_reviews WHERE trip_id = $1", [tripId],
      );
      assert.equal(reviews.rows[0].n, 2);
    });
  });

  test("a dismissed finding stays dismissed when the next review raises it again", async () => {
    await withDatabase(async (pool) => {
      const tripId = await seedTrip(pool);
      const review = await reviewPlan({ config: CONFIG, answers: ANSWERS, destination: "Japan" });
      await savePlanReview(pool, tripId, review, CONFIG);

      const open = await planReviewQueue(pool, tripId);
      const target = open[0]!;
      assert.equal(await decidePlanProposal(pool, tripId, target.id, "dismissed", "organizer:test"), true);

      await savePlanReview(pool, tripId, review, CONFIG);
      const stillOpen = await planReviewQueue(pool, tripId);
      assert.ok(!stillOpen.some((row) => row.id === target.id), "it did not come back");

      const dismissed = await planReviewQueue(pool, tripId, ["dismissed"]);
      assert.equal(dismissed.length, 1);
      assert.equal(dismissed[0]!.id, target.id);
    });
  });

  test("a finding the organizer actually fixed stops being asked about", async () => {
    await withDatabase(async (pool) => {
      const tripId = await seedTrip(pool);
      await savePlanReview(pool, tripId, await reviewPlan({ config: CONFIG, answers: ANSWERS }), CONFIG);
      const before = await planReviewQueue(pool, tripId);
      const checkin = before.find((row) => row.title.includes("No check-in"));
      assert.ok(checkin, "the thin plan has no check-in on it");

      // The organizer adds the check-in. A review of the NEW plan no longer
      // raises it.
      const fixedConfig = JSON.parse(JSON.stringify(CONFIG));
      fixedConfig.phases[0].days.unshift({
        date: "2026-09-19",
        items: [{ time: "15:00", text: { he: "צ׳ק-אין", en: "Check-in at OMO3 Asakusa" } }],
      });
      const second = await savePlanReview(
        pool, tripId, await reviewPlan({ config: fixedConfig, answers: ANSWERS }), fixedConfig,
      );
      assert.ok(second.fixed > 0);

      const after = await planReviewQueue(pool, tripId);
      assert.ok(!after.some((row) => row.id === checkin.id));
      const fixed = await planReviewQueue(pool, tripId, ["fixed"]);
      assert.ok(fixed.some((row) => row.id === checkin.id));
    });
  });

  test("a finding that comes back after being fixed is open again", async () => {
    await withDatabase(async (pool) => {
      const tripId = await seedTrip(pool);
      const thin = await reviewPlan({ config: CONFIG, answers: ANSWERS });
      const fixedConfig = JSON.parse(JSON.stringify(CONFIG));
      fixedConfig.phases[0].days.unshift({
        date: "2026-09-19",
        items: [{ time: "15:00", text: { he: "צ׳ק-אין", en: "Check-in at OMO3 Asakusa" } }],
      });

      await savePlanReview(pool, tripId, thin, CONFIG);
      await savePlanReview(pool, tripId, await reviewPlan({ config: fixedConfig, answers: ANSWERS }), fixedConfig);
      await savePlanReview(pool, tripId, thin, CONFIG);

      const open = await planReviewQueue(pool, tripId);
      assert.ok(open.some((row) => row.title.includes("No check-in")), "a regression reopens");
    });
  });

  test("evidence and the proposed patch survive the round trip", async () => {
    await withDatabase(async (pool) => {
      const tripId = await seedTrip(pool);
      await savePlanReview(pool, tripId, await reviewPlan({ config: CONFIG, answers: ANSWERS }), CONFIG);
      const rows = await planReviewQueue(pool, tripId);
      const reorder = rows.find((row) => row.kind === "reorder_day");
      assert.ok(reorder);
      assert.deepEqual((reorder!.patch as { order: string[] }).order, [
        "tokyo|2026-09-20|1",
        "tokyo|2026-09-20|0",
      ]);
      for (const row of rows) {
        assert.ok(Array.isArray(row.evidence) && row.evidence.length > 0, `${row.title} kept its evidence`);
      }
      // Calendar days, not instants. A DATE read back through a Date object
      // and sliced as ISO lands on the previous day west of UTC.
      const dated = rows.find((row) => row.date !== null);
      assert.match(dated!.date!, /^2026-09-\d\d$/);
    });
  });
});

describe("the post-deploy loop", { skip: SKIP ? "CONTROL_PLANE_TEST_DATABASE_URL not set" : false }, () => {
  test("picks up a trip whose plan snapshot has never been reviewed, once", async () => {
    await withDatabase(async (pool) => {
      const tripId = await seedTrip(pool, { snapshot: CONFIG });
      const pending = await tripsNeedingPlanReview(pool);
      assert.deepEqual(pending.map((row) => row.tripId), [tripId]);
      // The intake reaches it too — the arrival and pace rules need it, and
      // the config it reviews carries neither.
      assert.equal(pending[0]!.destination, "Japan");
      assert.match(pending[0]!.documentText, /Tokyo Skytree at 10:00/);

      assert.equal(await runPendingPlanReviews(pool), 1);
      assert.deepEqual(await tripsNeedingPlanReview(pool), []);

      const open = await planReviewQueue(pool, tripId);
      assert.ok(open.length > 2, `${open.length} proposals filed`);
      assert.ok(open.some((row) => row.title.includes("No check-in")));
    });
  });

  test("ignores a trip with no snapshot — nothing was deployed to review", async () => {
    await withDatabase(async (pool) => {
      await seedTrip(pool);
      assert.deepEqual(await tripsNeedingPlanReview(pool), []);
      assert.equal(await runPendingPlanReviews(pool), 0);
    });
  });

  test("reviews again after a re-provision writes a new snapshot", async () => {
    await withDatabase(async (pool) => {
      const tripId = await seedTrip(pool, { snapshot: CONFIG });
      await runPendingPlanReviews(pool);
      assert.deepEqual(await tripsNeedingPlanReview(pool), []);

      await pool.query(
        "UPDATE control_plane.trips SET plan_snapshot_at = now() + interval '1 second' WHERE id = $1",
        [tripId],
      );
      assert.deepEqual((await tripsNeedingPlanReview(pool)).map((row) => row.tripId), [tripId]);
    });
  });

  test("a review still counts when the API host's clock runs behind the database's", async () => {
    await withDatabase(async (pool) => {
      const tripId = await seedTrip(pool, { snapshot: CONFIG });
      const review = await reviewPlan({ config: CONFIG, answers: ANSWERS, destination: "Japan" });

      // The only thing this test changes is the clock the review reports. An
      // hour is theatre; the real number was single-digit milliseconds, which
      // is why this failed roughly one run in twenty instead of every time
      // (#134). `plan_snapshot_at` is written by the worker as Postgres
      // `now()`, so while `created_at` carried `generatedAt` — the API
      // process's own wall clock, a different machine in production — the two
      // sides of `created_at >= plan_snapshot_at` came from two clocks that
      // drift independently. A review that had just been written could look
      // older than the snapshot it reviewed, leaving the trip in the queue and
      // re-reviewing it on every pass, forever.
      const slowHost = { ...review, generatedAt: new Date(Date.now() - 3_600_000).toISOString() };
      await savePlanReview(pool, tripId, slowHost, CONFIG);

      assert.deepEqual(await tripsNeedingPlanReview(pool), []);
    });
  });

  test("a trip with no intake version still gets the findings the config can carry", async () => {
    await withDatabase(async (pool) => {
      // A hand-seeded or imported trip. The arrival and pace rules go quiet;
      // the rest still run, which is the whole reason they are separate.
      const tripId = await seedTrip(pool, { snapshot: CONFIG, intake: false });
      assert.equal(await runPendingPlanReviews(pool), 1);
      const open = await planReviewQueue(pool, tripId);
      assert.ok(open.some((row) => row.kind === "reorder_day"));
      assert.ok(!open.some((row) => row.kind === "pace"));
    });
  });

  test("records that the model half did not run, rather than looking like a clean plan", async () => {
    await withDatabase(async (pool) => {
      const tripId = await seedTrip(pool, { snapshot: CONFIG });
      await runPendingPlanReviews(pool);
      const row = await pool.query(
        "SELECT model_used, model_skipped FROM control_plane.plan_reviews WHERE trip_id = $1", [tripId],
      );
      assert.equal(row.rows[0].model_used, false);
      assert.equal(row.rows[0].model_skipped, "NO_RUNNER");
    });
  });

  test("one trip failing does not stop the pass", async () => {
    await withDatabase(async (pool) => {
      // A snapshot that is not a config at all. readPlan survives it and the
      // review is empty; the point is that the next trip is still reached.
      await seedTrip(pool, { snapshot: { phases: "corrupt" } });
      const good = await seedTrip(pool, { snapshot: CONFIG });
      assert.equal(await runPendingPlanReviews(pool), 2);
      assert.ok((await planReviewQueue(pool, good)).length > 0);
    });
  });

  test("an unreadable snapshot does not close every open finding", async () => {
    await withDatabase(async (pool) => {
      // A review that read nothing found nothing, and "found nothing" must
      // not be recorded as "the organizer fixed everything".
      const tripId = await seedTrip(pool, { snapshot: CONFIG });
      await runPendingPlanReviews(pool);
      const before = await planReviewQueue(pool, tripId);
      assert.ok(before.length > 0);

      await pool.query(
        "UPDATE control_plane.trips SET plan_snapshot = $2::jsonb, plan_snapshot_at = now() + interval '1 second' WHERE id = $1",
        [tripId, JSON.stringify({ phases: "corrupt" })],
      );
      await runPendingPlanReviews(pool);
      const after = await planReviewQueue(pool, tripId);
      assert.deepEqual(after.map((row) => row.id).sort(), before.map((row) => row.id).sort());
    });
  });
});
