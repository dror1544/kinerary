/**
 * A photo or a scan through the real ingest path, against a real database and
 * a real directory store.
 *
 * What is being held: a photo is looked at once per trip and its transcript
 * serves every later delivery; another trip never reuses it; a passport the
 * model recognises leaves nothing behind; and a relay with no vision runner
 * answers exactly as it did before vision existed.
 */
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, test } from "node:test";
import { fileURLToPath } from "node:url";
import pg from "pg";
import { applyMigrations } from "../src/migrations.js";
import { ingestDocument, intakeProcessingConfig, type IngestContext } from "../src/document-intake.js";
import { contentDigest, filesystemDocumentStore } from "../src/document-store.js";
import { findExtraction, listTripDocuments, processingKey } from "../src/document-registry.js";
import { DOCUMENT_READER_VERSION } from "../src/document-text.js";
import { VISION_READER_VERSION, visionProcessingConfig } from "../src/document-vision.js";
import { composeRunners, fakeRunner } from "../src/model-runner.js";
import { makePdf } from "./support/zip.js";
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

interface Fixture {
  pool: pg.Pool;
  a: string;
  b: string;
  root: string;
  ctx: (tripId: string, extra?: Partial<IngestContext>) => IngestContext;
}

async function withFixture(fn: (fix: Fixture) => Promise<void>): Promise<void> {
  const pool = new pg.Pool({ connectionString: databaseUrl });
  const client = await pool.connect();
  try {
    await client.query("DROP SCHEMA IF EXISTS control_plane CASCADE");
    await client.query("DROP TABLE IF EXISTS public.control_plane_schema_migrations");
    await applyMigrations(client, migrationsDir);
  } finally {
    client.release();
  }
  const root = await mkdtemp(path.join(tmpdir(), "doc-vision-"));
  try {
    const a = await seedTrip(pool);
    const b = await seedTrip(pool);
    const store = filesystemDocumentStore(root);
    await fn({
      pool,
      a,
      b,
      root,
      ctx: (tripId, extra = {}) => ({ db: pool, store, tripId, provider: "telegram", reviewStatus: "approved", ...extra }),
    });
  } finally {
    await pool.end();
    await rm(root, { recursive: true, force: true });
  }
}

async function filesIn(dir: string): Promise<string[]> {
  try {
    return await readdir(dir);
  } catch {
    return [];
  }
}

const PHOTO = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, ...randomBytes(64)]);
const BOOKING = [
  "HOTEL BOOKING CONFIRMATION",
  "Guest: Dana Levi",
  "Hotel: Kyoto Riverside Inn",
  "Check-in: 14 October 2026",
  "Check-out: 17 October 2026",
  "Confirmation number: KRI-58213",
];
const transcript = (lines: string[], extra: Record<string, unknown> = {}) =>
  JSON.stringify({ legible: true, identity_document: false, lines, ...extra });

describe("ingest, read by looking", { skip: SKIP ? "no CONTROL_PLANE_TEST_DATABASE_URL" : false }, () => {
  test("a photo is looked at once per trip, kept as itself, and its transcript serves the next delivery", async () => {
    await withFixture(async ({ pool, a, b, root, ctx }) => {
      const looker = fakeRunner([transcript(BOOKING), transcript(BOOKING)]);
      const vision = composeRunners({ read_image: looker });

      const first = await ingestDocument(ctx(a, { vision }), {
        bytes: PHOTO, mime: "image/jpeg", filename: "IMG_2044.jpg", sourceRef: "telegram:700000111:41",
      });
      assert.equal(first.kind, "registered");
      if (first.kind !== "registered") return;
      assert.match(first.document.text, /Kyoto Riverside Inn/);
      assert.ok(first.document.readerVersion.startsWith(VISION_READER_VERSION));
      assert.equal(first.document.coverage[0]?.unit, "image");
      assert.equal(first.document.stored, true);
      const hex = contentDigest(PHOTO).slice("sha256:".length);
      assert.deepEqual(await filesIn(path.join(root, a)), [`${hex}.jpg`]);

      const config = visionProcessingConfig(vision)!;
      const kept = await findExtraction(pool, { tripId: a, documentId: first.document.documentId, processingKey: processingKey(config) });
      assert.equal(kept?.status, "ok");
      assert.match(kept?.text ?? "", /KRI-58213/);

      // The same photo again — a new message, no new look.
      const again = await ingestDocument(ctx(a, { vision }), {
        bytes: PHOTO, mime: "image/jpeg", filename: "IMG_2044.jpg", sourceRef: "telegram:700000111:42",
      });
      assert.equal(again.kind, "registered");
      if (again.kind !== "registered") return;
      assert.equal(again.document.documentId, first.document.documentId);
      assert.equal(again.document.duplicateContent, true);
      assert.equal(again.document.newDelivery, true);
      assert.equal(again.document.text, first.document.text);
      assert.equal(looker.calls.length, 1);

      // Another trip's copy of the same bytes is that trip's to read.
      const elsewhere = await ingestDocument(ctx(b, { vision }), {
        bytes: PHOTO, mime: "image/jpeg", sourceRef: "telegram:700000999:7",
      });
      assert.equal(elsewhere.kind, "registered");
      assert.equal(looker.calls.length, 2);

      // What is read OUT of the transcript is keyed by the model that made it.
      const extractor = fakeRunner([]);
      assert.notEqual(
        processingKey(intakeProcessingConfig(extractor, "en", first.document.readerVersion)!),
        processingKey(intakeProcessingConfig(extractor, "en")!),
      );
    });
  });

  test("a passport the model recognises is refused, and nothing of it is kept", async () => {
    await withFixture(async ({ pool, a, root, ctx }) => {
      const vision = composeRunners({ read_image: fakeRunner([transcript([], { identity_document: true })]) });
      const outcome = await ingestDocument(ctx(a, { vision }), {
        bytes: PHOTO, mime: "image/jpeg", filename: "scan.jpg", sourceRef: "telegram:700000111:43",
      });
      assert.deepEqual(outcome, { kind: "refused", reason: "IDENTITY_DOCUMENT" });
      assert.deepEqual(await listTripDocuments(pool, a), []);
      assert.deepEqual(await filesIn(path.join(root, a)), []);
    });
  });

  test("with no runner reading images, a photo gets the same answer it always did", async () => {
    await withFixture(async ({ pool, a, ctx }) => {
      const input = { bytes: PHOTO, mime: "image/jpeg", filename: "IMG_1.jpg", sourceRef: "telegram:700000111:44" };
      const unconfigured = await ingestDocument(ctx(a), input);
      assert.equal(unconfigured.kind, "unreadable");
      if (unconfigured.kind === "unreadable") assert.equal(unconfigured.reason, "UNSUPPORTED_TYPE");

      const extractOnly = fakeRunner([transcript(BOOKING)]);
      const notForImages = await ingestDocument(ctx(a, { vision: composeRunners({ extract_intake: extractOnly }) }), input);
      assert.equal(notForImages.kind, "unreadable");
      assert.equal(extractOnly.calls.length, 0);
      assert.deepEqual(await listTripDocuments(pool, a), []);
    });
  });

  test("a PDF with no text layer is looked at; a typed PDF is read as before", async () => {
    await withFixture(async ({ a, root, ctx }) => {
      const looker = fakeRunner([transcript(BOOKING)]);
      const vision = composeRunners({ read_image: looker });
      const logs: string[] = [];

      const scanned = await ingestDocument(ctx(a, { vision, log: (line) => logs.push(line) }), {
        bytes: makePdf([""]), mime: "application/pdf", filename: "scan.pdf", sourceRef: "telegram:700000111:45",
      });
      assert.equal(scanned.kind, "registered");
      if (scanned.kind !== "registered") return;
      assert.ok(scanned.document.readerVersion.startsWith(VISION_READER_VERSION));
      assert.deepEqual(looker.calls[0]?.attachments?.map((f) => f.mime), ["application/pdf"]);
      assert.equal(scanned.document.stored, true, logs.join("\n"));
      assert.ok((await filesIn(path.join(root, a))).some((name) => name.endsWith(".pdf")), logs.join("\n"));

      const voucher = makePdf(["Hotel Kyoto Riverside Inn, check-in 14 October 2026, confirmation KRI-58213"]);
      const original = voucher.slice();
      const typed = await ingestDocument(ctx(a, { vision }), {
        bytes: voucher,
        mime: "application/pdf",
        filename: "voucher.pdf",
        sourceRef: "telegram:700000111:46",
      });
      assert.equal(typed.kind, "registered");
      if (typed.kind !== "registered") return;
      assert.equal(typed.document.readerVersion, DOCUMENT_READER_VERSION);
      assert.equal(looker.calls.length, 1, "a readable PDF is never sent to a vision model");
      // The kept original IS the upload, byte for byte, under the upload's digest.
      assert.equal(typed.document.stored, true);
      assert.equal(typed.document.digest, contentDigest(original));
      const kept = await readFile(path.join(root, a, `${contentDigest(original).slice("sha256:".length)}.pdf`));
      assert.deepEqual(new Uint8Array(kept), original);
    });
  });
});
