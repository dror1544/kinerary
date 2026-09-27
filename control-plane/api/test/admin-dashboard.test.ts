/**
 * The super-admin dashboard's slice 1 (read-only), Sprint 6 decision 23 in
 * docs/sprint6-tracks.md.
 *
 * Two things are pinned here, in order: first that the gate refuses everyone
 * but the holder of CONTROL_PLANE_ADMIN_KEY — this surface reads across every
 * trip at once, the one thing no other authenticated route in this codebase
 * does — and second that each route's numbers are the numbers actually seeded,
 * not a description of the query that produced them.
 */
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { describe, test, before, after, beforeEach } from "node:test";
import { fileURLToPath } from "node:url";
import pg from "pg";
import { buildApp } from "../src/app.js";
import { validateArchitectureProfile } from "../src/config.js";
import { applyMigrations } from "../src/migrations.js";
import { NOT_MEASURED_YET } from "../src/admin-dashboard.js";
import { testDatabaseUrl } from "./support/test-database.js";

const DB_URL = testDatabaseUrl();
const SKIP = !DB_URL;
const migrationsDir = fileURLToPath(new URL("../../db/migrations/", import.meta.url));
const KEY = "admin-key-for-tests";

const profile = validateArchitectureProfile({
  version: 1,
  environment: "test",
  public_api: { bind_host: "127.0.0.1", port: 4310 },
  worker: { queue: "postgres", health_bind_host: "127.0.0.1", health_port: 4311 },
  database: { connection_secret_ref: "env://CONTROL_PLANE_DATABASE_URL" },
  adapters: { compute: "fake", ingress: "fake", agent_runtime: "fake", messaging: "fake", secrets: "fake" },
  test_resources: { enabled: true, label_key: "kinerary.test_run_id", allowed_name_prefix: "kinerary-test-local" },
});

function suffix(): string {
  return randomBytes(6).toString("hex");
}

function digestFor(label: string): string {
  return `sha256:${label.repeat(64).slice(0, 64).replace(/[^a-f0-9]/g, "a")}`;
}

describe("super-admin dashboard: slice 1 (read-only)", { skip: SKIP ? "no CONTROL_PLANE_TEST_DATABASE_URL" : false }, () => {
  let pool: pg.Pool;

  before(async () => {
    pool = new pg.Pool({ connectionString: DB_URL });
    const client = await pool.connect();
    try {
      // Fresh schema every run of this file, not only every process: the
      // dev loop reruns this file against the same disposable database
      // repeatedly, and control_plane.audit_events cannot be wiped between
      // tests (see below) — only a dropped-and-reapplied schema resets it.
      await client.query("DROP SCHEMA IF EXISTS control_plane CASCADE");
      await client.query("DROP TABLE IF EXISTS public.control_plane_schema_migrations");
      await applyMigrations(client, migrationsDir);
    } finally { client.release(); }
  });

  after(async () => { await pool.end(); });

  beforeEach(async () => {
    // A disposable slate per test: every table this suite touches, wiped in
    // FK-safe order. Cheaper than dropping the schema per test, and just as
    // isolating as long as nothing here relies on data another describe left.
    //
    // NOT control_plane.audit_events: migration 0002 makes it append-only
    // (a BEFORE UPDATE OR DELETE trigger raises), which is the exact property
    // this dashboard's own audit-of-its-own-reads relies on. Tests that read
    // it below compare a before/after delta rather than an absolute count.
    await pool.query("DELETE FROM control_plane.funnel_events");
    await pool.query("DELETE FROM control_plane.jobs");
    await pool.query("DELETE FROM control_plane.plans");
    await pool.query("DELETE FROM control_plane.trips");
    await pool.query("DELETE FROM control_plane.releases");
  });

  function appWithAdmin() {
    return buildApp(profile, { admin: { db: pool, apiKey: KEY } });
  }

  async function seedTrip(label: string): Promise<string> {
    const tripId = `trip_${suffix()}${label}`;
    await pool.query(
      "INSERT INTO control_plane.trips(id, slug, lifecycle_state) VALUES ($1, $2, 'draft')",
      [tripId, tripId.replace(/_/g, "-")],
    );
    return tripId;
  }

  async function seedJob(options: {
    tripId: string;
    label: string;
    jobType: string;
    state: string;
    safeErrorCode?: string;
    result?: unknown;
    createdAt?: Date;
  }): Promise<string> {
    const planId = `plan_${suffix()}${options.label}`;
    const jobId = `job_${suffix()}${options.label}`;
    await pool.query(
      `INSERT INTO control_plane.plans(id, trip_id, release_id, kind, digest, status)
       VALUES ($1, $2, NULL, 'provision', $3, 'executed')`,
      [planId, options.tripId, digestFor(options.label)],
    );
    await pool.query(
      `INSERT INTO control_plane.jobs
         (id, trip_id, plan_id, job_type, idempotency_key, correlation_id, state, safe_error_code, result, created_at, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9::jsonb, coalesce($10, now()), coalesce($10, now()))`,
      [
        jobId, options.tripId, planId, options.jobType, `idem-${jobId}`, `corr_${suffix()}`,
        options.state, options.safeErrorCode ?? null, JSON.stringify(options.result ?? {}), options.createdAt ?? null,
      ],
    );
    return jobId;
  }

  async function seedFunnelEvent(eventName: string, createdAt: Date, tripId?: string): Promise<void> {
    await pool.query(
      `INSERT INTO control_plane.funnel_events(id, event_name, trip_id, created_at)
       VALUES ($1, $2, $3, $4)`,
      [`event_${suffix()}`, eventName, tripId ?? null, createdAt],
    );
  }

  async function seedRelease(label: string, status: string): Promise<string> {
    const id = `release_${suffix()}${label}`;
    // 'available' is unreachable without the promotion bookkeeping
    // (releases_available_requires_promotion, migration 0027) that
    // promoteRelease() normally writes; a plain INSERT (unlike an UPDATE)
    // does not run the transition-guard trigger, so supplying both columns
    // directly is sufficient here.
    await pool.query(
      `INSERT INTO control_plane.releases
         (id, source_revision, artifact_digest, application_schema, data_schema_min, data_schema_max, status,
          promoted_to_available_at, promoted_by)
       VALUES ($1, $2, $3, 1, 1, 1, $4, $5, $6)`,
      [
        id, "a".repeat(40), digestFor(label), status,
        status === "available" ? new Date() : null,
        status === "available" ? "operator:test" : null,
      ],
    );
    return id;
  }

  // ── Authorization ─────────────────────────────────────────────────────

  const ROUTES = ["/v1/admin/jobs", "/v1/admin/funnel", "/v1/admin/versions", "/v1/admin/failures", "/v1/admin/audit", "/v1/admin/report"];

  test("without the key in the environment, none of the routes exist", async () => {
    const app = buildApp(profile, {});
    try {
      for (const url of ROUTES) {
        const response = await app.inject({ method: "GET", url });
        assert.equal(response.statusCode, 503, url);
        assert.equal(JSON.parse(response.body).error, "ADMIN_NOT_CONFIGURED", url);
      }
    } finally {
      await app.close();
    }
  });

  test("a wrong key, an empty key and no key are all refused, on every route", async () => {
    const app = appWithAdmin();
    try {
      for (const url of ROUTES) {
        for (const headers of [{}, { "x-api-key": "" }, { "x-api-key": "nearly-the-key" }]) {
          const response = await app.inject({ method: "GET", url, headers });
          assert.equal(response.statusCode, 401, `${url} ${JSON.stringify(headers)}`);
          assert.equal(JSON.parse(response.body).error, "AUTHENTICATION_REQUIRED");
        }
      }
    } finally {
      await app.close();
    }
  });

  test("the operator's own key does not open this door", async () => {
    // Different powers, different credentials — same invariant
    // organizer-invite.test.ts pins for the operator key against the
    // interview-agent key, applied to the new pair.
    const app = buildApp(profile, {
      admin: { db: pool, apiKey: KEY },
      operator: { db: pool, apiKey: "operator-key", enrollmentTtlSeconds: 86400 },
    });
    try {
      const response = await app.inject({ method: "GET", url: "/v1/admin/jobs", headers: { "x-api-key": "operator-key" } });
      assert.equal(response.statusCode, 401);
    } finally {
      await app.close();
    }
  });

  test("the right key is let through, on every route", async () => {
    const app = appWithAdmin();
    try {
      for (const url of ROUTES) {
        const response = await app.inject({ method: "GET", url, headers: { "x-api-key": KEY } });
        assert.equal(response.statusCode, 200, `${url}: ${response.body}`);
      }
    } finally {
      await app.close();
    }
  });

  // ── Every successful read is itself audited ─────────────────────────────

  test("a successful read writes its own row to the audit trail", async () => {
    // audit_events is append-only and shared with earlier tests in this file
    // (the authorization tests above already hit every route once), so this
    // asserts a DELTA of exactly one new row, not an absolute count.
    const app = appWithAdmin();
    try {
      const before = await pool.query(
        "SELECT count(*)::int AS n FROM control_plane.audit_events WHERE action = 'admin.read.jobs'");
      const response = await app.inject({ method: "GET", url: "/v1/admin/jobs", headers: { "x-api-key": KEY } });
      assert.equal(response.statusCode, 200);
      const after = await pool.query(
        "SELECT count(*)::int AS n FROM control_plane.audit_events WHERE action = 'admin.read.jobs'");
      assert.equal(after.rows[0].n - before.rows[0].n, 1);
      const latest = await pool.query(
        "SELECT actor_ref, target_ref FROM control_plane.audit_events WHERE action = 'admin.read.jobs' ORDER BY occurred_at DESC LIMIT 1");
      assert.equal(latest.rows[0].actor_ref, "admin:api-key");
      assert.equal(latest.rows[0].target_ref, "all_trips");
    } finally {
      await app.close();
    }
  });

  // ── Jobs: data correctness ───────────────────────────────────────────────

  test("GET /v1/admin/jobs returns exactly the seeded jobs, scoped by tripId and state", async () => {
    const tripA = await seedTrip("a");
    const tripB = await seedTrip("b");
    await seedJob({ tripId: tripA, label: "1", jobType: "provision", state: "queued" });
    await seedJob({ tripId: tripA, label: "2", jobType: "provision", state: "succeeded" });
    await seedJob({ tripId: tripB, label: "3", jobType: "activate", state: "failed", safeErrorCode: "BUILD_FAILED" });

    const app = appWithAdmin();
    try {
      const all = await app.inject({ method: "GET", url: "/v1/admin/jobs", headers: { "x-api-key": KEY } });
      assert.equal(all.statusCode, 200);
      assert.equal(JSON.parse(all.body).jobs.length, 3);

      const scoped = await app.inject({ method: "GET", url: `/v1/admin/jobs?tripId=${tripA}`, headers: { "x-api-key": KEY } });
      const scopedJobs = JSON.parse(scoped.body).jobs;
      assert.equal(scopedJobs.length, 2);
      assert.ok(scopedJobs.every((j: { tripId: string }) => j.tripId === tripA));

      const byState = await app.inject({ method: "GET", url: "/v1/admin/jobs?state=failed", headers: { "x-api-key": KEY } });
      const failedJobs = JSON.parse(byState.body).jobs;
      assert.equal(failedJobs.length, 1);
      assert.equal(failedJobs[0].tripId, tripB);
      assert.equal(failedJobs[0].safeErrorCode, "BUILD_FAILED");
    } finally {
      await app.close();
    }
  });

  test("GET /v1/admin/jobs rejects an unrecognized state or job type rather than silently returning nothing", async () => {
    const app = appWithAdmin();
    try {
      const response = await app.inject({ method: "GET", url: "/v1/admin/jobs?state=not-a-real-state", headers: { "x-api-key": KEY } });
      assert.equal(response.statusCode, 400);
    } finally {
      await app.close();
    }
  });

  // ── Failures: F1 (PR #275 boundary review) ───────────────────────────────
  //
  // The reviewer seeded exactly these PII shapes into `result` and `evidence`
  // and read every one of them back verbatim through the old deny-list
  // (`redact()`). These constants are reused across the failures and audit
  // tests below so both prove the same real-world shapes are gone, not a
  // synthetic stand-in for them.
  const PII = {
    email: "family.traveler@example.com",
    phone: "+1-555-123-4567",
    childNameAge: "Emma Cohen, age 7",
    allergyNote: "severe peanut allergy — carries an EpiPen",
    hotelAddress: "123 Main St, Orlando, FL 32819",
  };

  test("GET /v1/admin/failures serves no PII at all — result is not in the response", async () => {
    const tripA = await seedTrip("a");
    await seedJob({
      tripId: tripA, label: "f1", jobType: "provision", state: "failed", safeErrorCode: "BUILD_FAILED",
      result: {
        note: "container did not start",
        email: PII.email, phone: PII.phone, childNameAge: PII.childNameAge,
        allergyNote: PII.allergyNote, hotelAddress: PII.hotelAddress,
      },
    });

    const app = appWithAdmin();
    try {
      const response = await app.inject({ method: "GET", url: "/v1/admin/failures", headers: { "x-api-key": KEY } });
      assert.equal(response.statusCode, 200);
      const { failures } = JSON.parse(response.body);
      assert.equal(failures.length, 1);
      assert.equal("result" in failures[0], false, "result must not be in the response at all");
      assert.equal(failures[0].safeErrorCode, "BUILD_FAILED");
      // Belt and suspenders: none of the seeded PII appears ANYWHERE in the
      // raw response body, not just absent from a `result` key by name.
      for (const value of Object.values(PII)) {
        assert.ok(!response.body.includes(value), `leaked into the response: ${value}`);
      }
    } finally {
      await app.close();
    }
  });

  // ── Audit: F1 (PR #275 boundary review) — allow-list, not deny-list ─────

  test("GET /v1/admin/audit withholds evidence entirely for an action with no allow-list entry", async () => {
    // A future writer inventing a new action name (here: one this codebase
    // does not itself produce) gets `{}`, not a best-effort scrub of a
    // deny-list that has never seen this shape of data before.
    await pool.query(
      `INSERT INTO control_plane.audit_events(id, actor_ref, action, target_ref, correlation_id, evidence, occurred_at)
       VALUES ($1, 'user:test', 'companion.report', 'trip_unknown', 'corr_manualaudittest002', $2::jsonb, now())`,
      [`audit_${suffix()}`, JSON.stringify({ ...PII, note: "traveler reported this via the companion" })],
    );

    const app = appWithAdmin();
    try {
      const response = await app.inject({ method: "GET", url: "/v1/admin/audit?action=companion.report", headers: { "x-api-key": KEY } });
      assert.equal(response.statusCode, 200);
      const { events } = JSON.parse(response.body);
      assert.equal(events.length, 1);
      assert.deepEqual(events[0].evidence, {});
      for (const value of Object.values(PII)) {
        assert.ok(!response.body.includes(value), `leaked into the response: ${value}`);
      }
    } finally {
      await app.close();
    }
  });

  test("GET /v1/admin/audit projects only the allow-listed keys for a known action, dropping everything else", async () => {
    // release.promote IS on the allow-list, but only for {from, to,
    // artifactDigest}. An extra key on the SAME row — however it got there —
    // must still be dropped, not passed through because the action is known.
    await pool.query(
      `INSERT INTO control_plane.audit_events(id, actor_ref, action, target_ref, correlation_id, evidence, occurred_at)
       VALUES ($1, 'user:test', 'release.promote', 'release_1', 'corr_manualaudittest003', $2::jsonb, now())`,
      [`audit_${suffix()}`, JSON.stringify({ from: "candidate", to: "verified", artifactDigest: `sha256:${"a".repeat(64)}`, operatorNote: PII.childNameAge })],
    );

    const app = appWithAdmin();
    try {
      const response = await app.inject({ method: "GET", url: "/v1/admin/audit?action=release.promote", headers: { "x-api-key": KEY } });
      assert.equal(response.statusCode, 200);
      const { events } = JSON.parse(response.body);
      assert.equal(events.length, 1);
      assert.equal(events[0].evidence.to, "verified");
      assert.equal(events[0].evidence.from, "candidate");
      assert.equal("operatorNote" in events[0].evidence, false);
      assert.ok(!response.body.includes(PII.childNameAge));
    } finally {
      await app.close();
    }
  });

  test("GET /v1/admin/audit withholds actorRef and targetRef that do not look like opaque identifiers", async () => {
    // audit_events.actor_ref / target_ref carry no DB-level format CHECK
    // (unlike releases.promoted_by) — this is the read-time safety net for
    // that gap, not a claim that today's writers would ever produce this.
    await pool.query(
      `INSERT INTO control_plane.audit_events(id, actor_ref, action, target_ref, correlation_id, evidence, occurred_at)
       VALUES ($1, $2, 'companion.report', $3, 'corr_manualaudittest004', '{}'::jsonb, now())`,
      [`audit_${suffix()}`, PII.childNameAge, PII.hotelAddress],
    );

    const app = appWithAdmin();
    try {
      const response = await app.inject({ method: "GET", url: "/v1/admin/audit?action=companion.report", headers: { "x-api-key": KEY } });
      assert.equal(response.statusCode, 200);
      const { events } = JSON.parse(response.body);
      // A prior test in this file also seeded a 'companion.report' row
      // (audit_events is append-only, so this file cannot wipe it between
      // tests) — find this one by its own correlation id, never by array
      // position or length.
      const found = events.find((e: { correlationId: string }) => e.correlationId === "corr_manualaudittest004");
      assert.ok(found, "the seeded row must be present");
      assert.equal(found.actorRef, "[REDACTED]");
      assert.equal(found.targetRef, "[REDACTED]");
      assert.ok(!response.body.includes(PII.childNameAge));
      assert.ok(!response.body.includes(PII.hotelAddress));
    } finally {
      await app.close();
    }
  });

  test("GET /v1/admin/audit still shows a normal machine-generated actorRef and targetRef", async () => {
    // The safety net must not swallow the ordinary case.
    await pool.query(
      `INSERT INTO control_plane.audit_events(id, actor_ref, action, target_ref, correlation_id, evidence, occurred_at)
       VALUES ($1, 'operator:cli', 'release.promote', 'release_abc123XY', 'corr_manualaudittest005', '{}'::jsonb, now())`,
      [`audit_${suffix()}`],
    );

    const app = appWithAdmin();
    try {
      const response = await app.inject({ method: "GET", url: "/v1/admin/audit?action=release.promote", headers: { "x-api-key": KEY } });
      assert.equal(response.statusCode, 200);
      const { events } = JSON.parse(response.body);
      const found = events.find((e: { targetRef: string }) => e.targetRef === "release_abc123XY");
      assert.ok(found, "the normal row must still be readable");
      assert.equal(found.actorRef, "operator:cli");
    } finally {
      await app.close();
    }
  });

  // ── Audit: F1 round 2 (PR #275 boundary review, R1 + R3) ────────────────

  test("GET /v1/admin/audit withholds `action` itself when it carries PII, not just actorRef/targetRef/evidence", async () => {
    // R1: `action` had no CHECK constraint and was served as a raw column —
    // the reviewer put a PII sentence directly into it and read it back
    // verbatim. There is no `?action=` filter here on purpose: the seeded
    // value is free text with spaces and punctuation, not something a query
    // string should have to URL-encode to prove a point — find the row by
    // its own correlation id instead, over the unfiltered route.
    const piiAction = "note: severe peanut allergy — carries an EpiPen for Emma Cohen, age 7";
    await pool.query(
      `INSERT INTO control_plane.audit_events(id, actor_ref, action, target_ref, correlation_id, evidence, occurred_at)
       VALUES ($1, 'user:test', $2, 'trip_unknown', 'corr_manualaudittest006', '{}'::jsonb, now())`,
      [`audit_${suffix()}`, piiAction],
    );

    const app = appWithAdmin();
    try {
      const response = await app.inject({ method: "GET", url: "/v1/admin/audit", headers: { "x-api-key": KEY } });
      assert.equal(response.statusCode, 200);
      const { events } = JSON.parse(response.body);
      const found = events.find((e: { correlationId: string }) => e.correlationId === "corr_manualaudittest006");
      assert.ok(found, "the seeded row must be present");
      assert.equal(found.action, "[REDACTED]");
      assert.ok(!response.body.includes(piiAction));
      assert.ok(!response.body.includes("Emma Cohen"));
    } finally {
      await app.close();
    }
  });

  test("GET /v1/admin/audit does not 500 on an action shaped like a JS built-in property name", async () => {
    // R3: `EVIDENCE_ALLOWLIST[action]` as a plain-object lookup resolves
    // 'constructor' to Object.prototype's own constructor (truthy, not an
    // array), so the old code crashed trying to iterate it — and because
    // audit_events is append-only, one such row breaks the route for every
    // future request, not just this one.
    for (const dangerousAction of ["constructor", "__proto__", "toString", "hasOwnProperty"]) {
      await pool.query(
        `INSERT INTO control_plane.audit_events(id, actor_ref, action, target_ref, correlation_id, evidence, occurred_at)
         VALUES ($1, 'user:test', $2, 'trip_unknown', $3, '{}'::jsonb, now())`,
        [`audit_${suffix()}`, dangerousAction, `corr_dangerous${suffix()}`],
      );
    }

    const app = appWithAdmin();
    try {
      const response = await app.inject({ method: "GET", url: "/v1/admin/audit?action=constructor", headers: { "x-api-key": KEY } });
      assert.equal(response.statusCode, 200, "must not 500");
      const { events } = JSON.parse(response.body);
      assert.ok(events.length >= 1);
      for (const event of events) assert.deepEqual(event.evidence, {});

      // And the unfiltered route — the one shape an attacker cannot avoid
      // exercising, since a real operator will read it without ?action= —
      // must also survive every dangerous action name landing in the same
      // page of results.
      const unfiltered = await app.inject({ method: "GET", url: "/v1/admin/audit", headers: { "x-api-key": KEY } });
      assert.equal(unfiltered.statusCode, 200, "must not 500");
    } finally {
      await app.close();
    }
  });

  // ── Versions ──────────────────────────────────────────────────────────────

  test("GET /v1/admin/versions lists the seeded releases", async () => {
    await seedRelease("r1", "candidate");
    await seedRelease("r2", "available");

    const app = appWithAdmin();
    try {
      const response = await app.inject({ method: "GET", url: "/v1/admin/versions", headers: { "x-api-key": KEY } });
      assert.equal(response.statusCode, 200);
      const { releases } = JSON.parse(response.body);
      assert.equal(releases.length, 2);
      assert.deepEqual(new Set(releases.map((r: { status: string }) => r.status)), new Set(["candidate", "available"]));
    } finally {
      await app.close();
    }
  });

  // ── Funnel: counts and conversion rates ──────────────────────────────────

  test("GET /v1/admin/funnel counts within the window and computes conversion rates without dividing by zero", async () => {
    const inWindow = new Date("2026-09-10T12:00:00.000Z");
    const outsideWindow = new Date("2026-09-01T00:00:00.000Z");
    for (let i = 0; i < 10; i += 1) await seedFunnelEvent("landing_cta", inWindow);
    for (let i = 0; i < 4; i += 1) await seedFunnelEvent("google_auth", inWindow);
    for (let i = 0; i < 2; i += 1) await seedFunnelEvent("draft_created", inWindow);
    await seedFunnelEvent("landing_cta", outsideWindow);

    const app = appWithAdmin();
    try {
      const response = await app.inject({
        method: "GET",
        url: "/v1/admin/funnel?since=2026-09-10T00:00:00.000Z&until=2026-09-11T00:00:00.000Z",
        headers: { "x-api-key": KEY },
      });
      assert.equal(response.statusCode, 200);
      const body = JSON.parse(response.body);
      assert.equal(body.counts.landing_cta, 10);
      assert.equal(body.counts.google_auth, 4);
      assert.equal(body.counts.draft_created, 2);
      assert.equal(body.counts.runtime_launched, 0);

      const landingToAuth = body.conversions.find((c: { from: string; to: string }) => c.from === "landing_cta" && c.to === "google_auth");
      assert.equal(landingToAuth.fromCount, 10);
      assert.equal(landingToAuth.toCount, 4);
      assert.equal(landingToAuth.rate, 0.4);

      // A step nobody reached: rate is null, never NaN and never a fabricated 0.
      const provisionToApprove = body.conversions.find((c: { from: string; to: string }) => c.from === "provisioning_requested" && c.to === "provisioning_approved");
      assert.equal(provisionToApprove.fromCount, 0);
      assert.equal(provisionToApprove.rate, null);
    } finally {
      await app.close();
    }
  });

  test("GET /v1/admin/funnel rejects a malformed timestamp rather than silently ignoring it", async () => {
    const app = appWithAdmin();
    try {
      const response = await app.inject({ method: "GET", url: "/v1/admin/funnel?since=not-a-date", headers: { "x-api-key": KEY } });
      assert.equal(response.statusCode, 400);
    } finally {
      await app.close();
    }
  });

  // ── The report ────────────────────────────────────────────────────────────

  test("GET /v1/admin/report rolls up the day's funnel and job activity, and names what it does not measure", async () => {
    const tripA = await seedTrip("a");
    const day = "2026-09-15";
    await seedFunnelEvent("landing_cta", new Date(`${day}T08:00:00.000Z`));
    await seedFunnelEvent("landing_cta", new Date(`${day}T09:00:00.000Z`));
    await seedFunnelEvent("google_auth", new Date(`${day}T09:05:00.000Z`));
    // Outside the day — must not be counted.
    await seedFunnelEvent("landing_cta", new Date(`2026-09-16T00:00:01.000Z`));
    await seedJob({ tripId: tripA, label: "d1", jobType: "provision", state: "succeeded", createdAt: new Date(`${day}T10:00:00.000Z`) });
    await seedJob({ tripId: tripA, label: "d2", jobType: "provision", state: "failed", safeErrorCode: "BUILD_FAILED", createdAt: new Date(`${day}T11:00:00.000Z`) });

    const app = appWithAdmin();
    try {
      const response = await app.inject({ method: "GET", url: `/v1/admin/report?date=${day}`, headers: { "x-api-key": KEY } });
      assert.equal(response.statusCode, 200);
      const body = JSON.parse(response.body);
      assert.equal(body.date, day);
      assert.equal(body.funnel.counts.landing_cta, 2);
      assert.equal(body.funnel.counts.google_auth, 1);
      assert.deepEqual(
        new Set(body.jobs.byTypeAndState.map((r: { jobType: string; state: string; count: number }) => `${r.jobType}:${r.state}:${r.count}`)),
        new Set(["provision:succeeded:1", "provision:failed:1"]),
      );
      assert.deepEqual(body.notMeasuredYet, NOT_MEASURED_YET);
    } finally {
      await app.close();
    }
  });

  test("GET /v1/admin/report rejects a malformed date", async () => {
    const app = appWithAdmin();
    try {
      const response = await app.inject({ method: "GET", url: "/v1/admin/report?date=not-a-date", headers: { "x-api-key": KEY } });
      assert.equal(response.statusCode, 400);
    } finally {
      await app.close();
    }
  });

  test("GET /v1/admin/report with no data for the day renders empty, not NaN or a fabricated rate", async () => {
    const app = appWithAdmin();
    try {
      const response = await app.inject({ method: "GET", url: "/v1/admin/report?date=2099-01-01", headers: { "x-api-key": KEY } });
      assert.equal(response.statusCode, 200);
      const body = JSON.parse(response.body);
      assert.equal(body.funnel.counts.landing_cta, 0);
      assert.deepEqual(body.jobs.byTypeAndState, []);
      for (const c of body.funnel.conversions) assert.equal(c.rate, null);
    } finally {
      await app.close();
    }
  });
});
