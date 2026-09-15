/**
 * The document registry against a real database.
 *
 * Every case seeds TWO trips, for the reason the interpret suite does: a
 * single-trip test passes just as happily against code that ignores the trip
 * id, and trip isolation is one of the properties this registry exists to hold.
 */
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { describe, test } from "node:test";
import { fileURLToPath } from "node:url";
import pg from "pg";
import { applyMigrations } from "../src/migrations.js";
import { contentDigest } from "../src/document-store.js";
import {
  cleanFilename,
  findExtraction,
  getTripDocument,
  listTripDocuments,
  markDocumentStored,
  processingKey,
  recordDelivery,
  releaseReservation,
  reserveDocument,
  saveExtraction,
  staleReservedDocuments,
  type ProcessingConfig,
} from "../src/document-registry.js";
import { testDatabaseUrl } from "./support/test-database.js";

const databaseUrl = testDatabaseUrl();
const SKIP = !databaseUrl;
const migrationsDir = fileURLToPath(new URL("../../db/migrations/", import.meta.url));

function testId(prefix: string): string {
  return `${prefix}_${randomBytes(16).toString("hex")}`;
}

async function seedTrip(pool: pg.Pool): Promise<string> {
  const tripId = testId("trip");
  await pool.query("INSERT INTO control_plane.trips(id, slug, lifecycle_state) VALUES ($1, $2, 'draft')", [
    tripId,
    tripId.replace(/_/g, "-"),
  ]);
  return tripId;
}

async function withTwoTrips(fn: (fix: { pool: pg.Pool; a: string; b: string }) => Promise<void>): Promise<void> {
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
    const a = await seedTrip(pool);
    const b = await seedTrip(pool);
    await fn({ pool, a, b });
  } finally {
    await pool.end();
  }
}

const CONFIG: ProcessingConfig = {
  readerVersion: "reader-1",
  extractorVersion: "extract-intake-1",
  task: "extract_intake",
  provider: "claude",
  model: "claude-sonnet-5",
};

const VOUCHER = new TextEncoder().encode("Hotel Gracery Shinjuku — check-in 19 Sep 2026");
const DIGEST = contentDigest(VOUCHER);

describe("document registry", { skip: SKIP ? "no CONTROL_PLANE_TEST_DATABASE_URL" : false }, () => {
  test("one document per content per trip, and the same bytes on another trip are another document", async () => {
    await withTwoTrips(async ({ pool, a, b }) => {
      const first = await reserveDocument(pool, { tripId: a, digest: DIGEST, byteSize: VOUCHER.length, mime: "application/pdf" });
      const again = await reserveDocument(pool, { tripId: a, digest: DIGEST, byteSize: VOUCHER.length });
      const elsewhere = await reserveDocument(pool, { tripId: b, digest: DIGEST, byteSize: VOUCHER.length });

      assert.equal(first.created, true);
      assert.equal(again.created, false);
      assert.equal(again.document.id, first.document.id);
      assert.equal(elsewhere.created, true);
      assert.notEqual(elsewhere.document.id, first.document.id);

      assert.equal(await getTripDocument(pool, b, first.document.id), null, "not readable through the wrong trip");
      assert.deepEqual((await listTripDocuments(pool, a)).map((d) => d.id), [first.document.id]);
      assert.deepEqual((await listTripDocuments(pool, b)).map((d) => d.id), [elsewhere.document.id]);
    });
  });

  test("concurrent claims of the same content converge on one row", async () => {
    await withTwoTrips(async ({ pool, a }) => {
      const claims = await Promise.all(
        Array.from({ length: 8 }, () => reserveDocument(pool, { tripId: a, digest: DIGEST, byteSize: VOUCHER.length })),
      );
      assert.equal(new Set(claims.map((c) => c.document.id)).size, 1);
      assert.equal(claims.filter((c) => c.created).length, 1);
    });
  });

  test("stored is a one-way state with a fixed key, and the schema refuses a key-less stored row", async () => {
    await withTwoTrips(async ({ pool, a, b }) => {
      const { document } = await reserveDocument(pool, { tripId: a, digest: DIGEST, byteSize: VOUCHER.length });
      const key = `${a}/${DIGEST.slice(7)}.pdf`;

      assert.equal(await markDocumentStored(pool, { tripId: b, documentId: document.id, storageKey: key }), false, "wrong trip");
      assert.equal(await markDocumentStored(pool, { tripId: a, documentId: document.id, storageKey: key }), true);
      assert.equal(await markDocumentStored(pool, { tripId: a, documentId: document.id, storageKey: key }), true, "idempotent");
      assert.equal(
        await markDocumentStored(pool, { tripId: a, documentId: document.id, storageKey: `${a}/${"f".repeat(64)}.pdf` }),
        false,
        "a stored document's key never moves",
      );
      const stored = await getTripDocument(pool, a, document.id);
      assert.equal(stored?.ingestState, "stored");
      assert.equal(stored?.storageKey, key);

      const other = await reserveDocument(pool, { tripId: a, digest: contentDigest(new Uint8Array([1])), byteSize: 1 });
      await assert.rejects(
        pool.query("UPDATE control_plane.trip_documents SET ingest_state = 'stored' WHERE id = $1", [other.document.id]),
        /trip_documents_stored_has_key/,
      );
    });
  });

  test("a reservation whose bytes never landed can be found and released, and a stored one cannot be", async () => {
    await withTwoTrips(async ({ pool, a }) => {
      const { document } = await reserveDocument(pool, { tripId: a, digest: DIGEST, byteSize: VOUCHER.length });
      await pool.query("UPDATE control_plane.trip_documents SET created_at = now() - interval '1 hour' WHERE id = $1", [document.id]);
      assert.deepEqual((await staleReservedDocuments(pool, 600)).map((d) => d.id), [document.id]);

      assert.equal(await releaseReservation(pool, a, document.id), true);
      assert.equal(await getTripDocument(pool, a, document.id), null);

      const kept = await reserveDocument(pool, { tripId: a, digest: DIGEST, byteSize: VOUCHER.length });
      await markDocumentStored(pool, { tripId: a, documentId: kept.document.id, storageKey: `${a}/${DIGEST.slice(7)}.pdf` });
      assert.equal(await releaseReservation(pool, a, kept.document.id), false);
    });
  });

  test("deliveries: a redelivered message is one row, a new message is another delivery of the same document", async () => {
    await withTwoTrips(async ({ pool, a }) => {
      const { document } = await reserveDocument(pool, { tripId: a, digest: DIGEST, byteSize: VOUCHER.length });
      const base = { tripId: a, documentId: document.id, digest: DIGEST, provider: "telegram", reviewStatus: "approved" as const };

      const first = await recordDelivery(pool, { ...base, sourceRef: "chat:830000001:msg:41", filename: "Yapan Tours.pdf" });
      const redelivered = await recordDelivery(pool, { ...base, sourceRef: "chat:830000001:msg:41", filename: "Yapan Tours.pdf" });
      const resent = await recordDelivery(pool, { ...base, sourceRef: "chat:830000001:msg:57", filename: "Yapan Tours (1).pdf" });

      assert.equal(first.duplicate, false);
      assert.equal(redelivered.duplicate, true);
      assert.equal(redelivered.artifactId, first.artifactId);
      assert.equal(resent.duplicate, false);

      const [listed] = await listTripDocuments(pool, a);
      assert.equal(listed?.deliveries, 2);
      assert.equal(listed?.filename, "Yapan Tours (1).pdf");
    });
  });

  test("ordinary filenames and hostile provenance never make a delivery fail to record", async () => {
    await withTwoTrips(async ({ pool, a }) => {
      const { document } = await reserveDocument(pool, { tripId: a, digest: DIGEST, byteSize: VOUCHER.length });
      // A Mac path in a filename is ordinary. In `provenance` it would trip the
      // canonical-safety CHECK — which is exactly why the filename has its own
      // column, and why unsafe provenance is dropped rather than inserted.
      const out = await recordDelivery(pool, {
        tripId: a,
        documentId: document.id,
        digest: DIGEST,
        provider: "telegram",
        sourceRef: "chat:830000001:msg:99",
        filename: "/Users/dror/Downloads/ Solomon- Yapan Tours.pdf",
        reviewStatus: "approved",
        provenance: { note: "Authorization: Bearer abc123", path: "/Users/dror/secret" },
      });
      const row = await pool.query("SELECT filename, provenance FROM control_plane.source_artifacts WHERE id = $1", [out.artifactId]);
      assert.equal(row.rows[0].filename, "/Users/dror/Downloads/ Solomon- Yapan Tours.pdf");
      assert.deepEqual(row.rows[0].provenance, {});
    });
  });

  test("filenames lose markup and bidi overrides, and nothing else", () => {
    assert.equal(cleanFilename("  תוכנית טיול.docx "), "תוכנית טיול.docx");
    assert.equal(cleanFilename("<script>x</script>.pdf"), "scriptx/script.pdf");
    assert.equal(cleanFilename("invoice‮fdp.exe"), "invoicefdp.exe");
    assert.equal(cleanFilename(""), null);
    assert.equal(cleanFilename(undefined), null);
  });

  test("one extraction per processing configuration; a new configuration is a new reading", async () => {
    await withTwoTrips(async ({ pool, a, b }) => {
      const { document } = await reserveDocument(pool, { tripId: a, digest: DIGEST, byteSize: VOUCHER.length });
      // Real document text carries exactly what the canonical CHECK refuses.
      const hostileText = "Saved from /Users/dror/Downloads — Authorization: Bearer abc — 192.168.0.45";

      const first = await saveExtraction(pool, {
        tripId: a, documentId: document.id, config: CONFIG, status: "ok",
        text: hostileText, coverage: [{ unit: "page", index: 1, chars: hostileText.length, usable: true }],
        result: { proposals: [] },
      });
      const retried = await saveExtraction(pool, {
        tripId: a, documentId: document.id, config: CONFIG, status: "failed", failureReason: "TIMED_OUT",
      });
      const improved = await saveExtraction(pool, {
        tripId: a, documentId: document.id, config: { ...CONFIG, extractorVersion: "extract-intake-2" }, status: "empty",
      });

      assert.equal(first.created, true);
      assert.equal(first.extraction.text, hostileText);
      assert.equal(first.extraction.textChars, hostileText.length);
      assert.equal(retried.created, false, "a retry finds the stored reading");
      assert.equal(retried.extraction.id, first.extraction.id);
      assert.equal(retried.extraction.status, "ok", "and never overwrites it");
      assert.equal(improved.created, true);
      assert.notEqual(improved.extraction.id, first.extraction.id);

      const found = await findExtraction(pool, { tripId: a, documentId: document.id, processingKey: processingKey(CONFIG) });
      assert.equal(found?.id, first.extraction.id);
      assert.equal(await findExtraction(pool, { tripId: b, documentId: document.id, processingKey: processingKey(CONFIG) }), null);

      await assert.rejects(
        saveExtraction(pool, { tripId: b, documentId: document.id, config: CONFIG, status: "ok" }),
        /does not belong to this trip/,
      );
    });
  });

  test("the processing key moves with every input that could change the answer", () => {
    const base = processingKey(CONFIG);
    assert.equal(processingKey({ ...CONFIG }), base);
    for (const change of [
      { readerVersion: "reader-2" },
      { extractorVersion: "extract-intake-2" },
      { task: "extract_itinerary" },
      { provider: "codex" },
      { model: "claude-haiku-4-5" },
    ]) {
      assert.notEqual(processingKey({ ...CONFIG, ...change }), base, JSON.stringify(change));
    }
  });
});
