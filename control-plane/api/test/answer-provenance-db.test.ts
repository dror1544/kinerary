/**
 * Answer provenance and document disagreements, against a real database.
 *
 * Two trips per case, for the reason every suite here seeds two: a claim or a
 * conflict that could be recorded against another trip's document is exactly
 * the leak a single-trip test cannot see.
 */
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { describe, test } from "node:test";
import { fileURLToPath } from "node:url";
import pg from "pg";
import { applyMigrations } from "../src/migrations.js";
import { contentDigest } from "../src/document-store.js";
import { reserveDocument } from "../src/document-registry.js";
import {
  getConflict,
  listAnswerSources,
  nextOpenConflict,
  openConflict,
  recordAnswerSources,
  resolveConflict,
} from "../src/answer-provenance.js";
import { testDatabaseUrl } from "./support/test-database.js";

const databaseUrl = testDatabaseUrl();
const SKIP = !databaseUrl;
const migrationsDir = fileURLToPath(new URL("../../db/migrations/", import.meta.url));

function testId(prefix: string): string {
  return `${prefix}_${randomBytes(16).toString("hex")}`;
}

interface Trip {
  tripId: string;
  documentId: string;
}

async function seedTrip(pool: pg.Pool, body: string): Promise<Trip> {
  const tripId = testId("trip");
  await pool.query("INSERT INTO control_plane.trips(id, slug, lifecycle_state) VALUES ($1, $2, 'draft')", [
    tripId,
    tripId.replace(/_/g, "-"),
  ]);
  const bytes = new TextEncoder().encode(body);
  const { document } = await reserveDocument(pool, { tripId, digest: contentDigest(bytes), byteSize: bytes.length });
  return { tripId, documentId: document.id };
}

async function withTwoTrips(fn: (fix: { pool: pg.Pool; a: Trip; b: Trip }) => Promise<void>): Promise<void> {
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
    await fn({ pool, a: await seedTrip(pool, "voucher a"), b: await seedTrip(pool, "voucher b") });
  } finally {
    await pool.end();
  }
}

const STAY = "c:hotel|gr4471|2026-09-19";

describe("answer provenance", { skip: SKIP ? "no CONTROL_PLANE_TEST_DATABASE_URL" : false }, () => {
  test("a claim is recorded once, and never against another trip's document", async () => {
    await withTwoTrips(async ({ pool, a, b }) => {
      const claim = {
        tripId: a.tripId,
        questionId: "travel_anchors",
        entryKey: STAY,
        documentId: a.documentId,
        disposition: "filled" as const,
        paths: ["confirmation"],
        entrySnapshot: { type: "hotel", name: "Hotel Gracery Shinjuku", confirmation: "GR-4471" },
      };
      assert.equal(await recordAnswerSources(pool, [claim]), 1);
      assert.equal(await recordAnswerSources(pool, [claim]), 0, "re-reading the same document records nothing new");
      assert.equal(
        // Agreeing with what is held supplies no field: a supporting source, not a contributing one.
        await recordAnswerSources(pool, [{ ...claim, disposition: "unchanged", paths: [] }]),
        1,
        "a different outcome for the same claim is its own row",
      );
      assert.equal(
        await recordAnswerSources(pool, [{ ...claim, tripId: b.tripId }]),
        0,
        "trip b cannot record a claim backed by trip a's document",
      );

      const sources = await listAnswerSources(pool, a.tripId);
      assert.deepEqual(sources.map((s) => [s.disposition, s.paths]), [["filled", ["confirmation"]], ["unchanged", []]]);
      assert.deepEqual(await listAnswerSources(pool, b.tripId), []);
    });
  });
});

describe("document disagreements", { skip: SKIP ? "no CONTROL_PLANE_TEST_DATABASE_URL" : false }, () => {
  test("the same disagreement raised twice is one question, and a different one is another", async () => {
    await withTwoTrips(async ({ pool, a }) => {
      const base = {
        tripId: a.tripId,
        questionId: "phases",
        entryKey: "n:|tokyo|2026-09-19",
        path: "end",
        held: "2026-09-23",
        incoming: "2026-09-24",
        documentId: a.documentId,
      };
      const first = await openConflict(pool, base);
      const again = await openConflict(pool, base);
      const other = await openConflict(pool, { ...base, incoming: "2026-09-25" });

      assert.equal(first.created, true);
      assert.equal(again.created, false);
      assert.equal(again.conflict.id, first.conflict.id);
      assert.equal(other.created, true);
      assert.notEqual(other.conflict.id, first.conflict.id);
      assert.equal((await nextOpenConflict(pool, a.tripId))?.id, first.conflict.id, "oldest first");
    });
  });

  test("a decision applies once, and a settled question does not come back when the document is re-read", async () => {
    await withTwoTrips(async ({ pool, a, b }) => {
      const base = {
        tripId: a.tripId,
        questionId: "phases",
        entryKey: "n:|tokyo|2026-09-19",
        path: "end",
        held: "2026-09-23",
        incoming: "2026-09-24",
        documentId: a.documentId,
      };
      const { conflict } = await openConflict(pool, base);

      assert.equal(
        await resolveConflict(pool, { tripId: b.tripId, conflictId: conflict.id, status: "kept", resolvedBy: "organizer" }),
        false,
        "not through another trip",
      );
      assert.equal(await resolveConflict(pool, { tripId: a.tripId, conflictId: conflict.id, status: "kept", resolvedBy: "organizer" }), true);
      assert.equal(
        await resolveConflict(pool, { tripId: a.tripId, conflictId: conflict.id, status: "replaced", resolvedBy: "organizer" }),
        false,
        "a double tap cannot flip the decision",
      );
      assert.equal((await getConflict(pool, a.tripId, conflict.id))?.status, "kept");
      assert.equal(await nextOpenConflict(pool, a.tripId), null);

      const reread = await openConflict(pool, base);
      assert.equal(reread.created, false);
      assert.equal(reread.conflict.status, "kept", "the organizer's answer stands");
    });
  });

  test("a conflict cannot cite another trip's document, and the schema refuses a half-settled row", async () => {
    await withTwoTrips(async ({ pool, a, b }) => {
      await assert.rejects(
        openConflict(pool, {
          tripId: a.tripId,
          questionId: "phases",
          entryKey: "",
          path: "end",
          held: "x",
          incoming: "y",
          documentId: b.documentId,
        }),
        /does not belong to this trip/,
      );

      const { conflict } = await openConflict(pool, {
        tripId: a.tripId,
        questionId: "destination",
        entryKey: "",
        path: "",
        held: "Japan",
        incoming: "Korea",
        documentId: a.documentId,
      });
      await assert.rejects(
        pool.query("UPDATE control_plane.trip_answer_conflicts SET status = 'kept' WHERE id = $1", [conflict.id]),
        /trip_answer_conflicts_resolved_shape/,
      );
    });
  });
});
