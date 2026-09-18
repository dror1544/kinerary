/**
 * The recovery sweep, against a real database and a real temporary store: an
 * interrupted write and an interrupted claim are cleared once old, and nothing
 * complete or still in progress is touched.
 */
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { mkdtemp, readdir, rm, utimes, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, test } from "node:test";
import { fileURLToPath } from "node:url";
import pg from "pg";
import { applyMigrations } from "../src/migrations.js";
import { contentDigest, filesystemDocumentStore, storageKeyFor } from "../src/document-store.js";
import { getTripDocument, markDocumentStored, reserveDocument } from "../src/document-registry.js";
import { sweepDocumentStore } from "../src/document-sweeper.js";
import { testDatabaseUrl } from "./support/test-database.js";

const databaseUrl = testDatabaseUrl();
const SKIP = !databaseUrl;
const migrationsDir = fileURLToPath(new URL("../../db/migrations/", import.meta.url));

describe("the document sweep", { skip: SKIP ? "no CONTROL_PLANE_TEST_DATABASE_URL" : false }, () => {
  test("clears old interrupted writes and claims, and leaves complete and recent work alone", async () => {
    const pool = new pg.Pool({ connectionString: databaseUrl });
    const root = await mkdtemp(path.join(tmpdir(), "doc-sweep-"));
    const client = await pool.connect();
    try {
      await client.query("DROP SCHEMA IF EXISTS control_plane CASCADE");
      await client.query("DROP TABLE IF EXISTS public.control_plane_schema_migrations");
      await applyMigrations(client, migrationsDir);
    } finally {
      client.release();
    }
    try {
      const tripId = `trip_${randomBytes(16).toString("hex")}`;
      await pool.query("INSERT INTO control_plane.trips(id, slug, lifecycle_state) VALUES ($1, $2, 'draft')", [
        tripId,
        tripId.replace(/_/g, "-"),
      ]);
      const store = filesystemDocumentStore(root);
      const reserve = (text: string) => {
        const bytes = new TextEncoder().encode(text);
        return reserveDocument(pool, { tripId, digest: contentDigest(bytes), byteSize: bytes.length });
      };
      const age = (id: string) =>
        pool.query("UPDATE control_plane.trip_documents SET created_at = now() - interval '2 hours' WHERE id = $1", [id]);

      // A claim whose bytes never landed, long ago.
      const abandoned = (await reserve("abandoned")).document;
      await age(abandoned.id);
      // A claim still in progress.
      const inProgress = (await reserve("in progress")).document;
      // A document that completed long ago.
      const keptBytes = new TextEncoder().encode("kept");
      const kept = (await reserve("kept")).document;
      const key = storageKeyFor(tripId, contentDigest(keptBytes), "txt");
      await store.put(key, keptBytes);
      await markDocumentStored(pool, { tripId, documentId: kept.id, storageKey: key });
      await age(kept.id);

      // An interrupted write, long ago, and one a second old.
      const dir = path.join(root, tripId);
      await mkdir(dir, { recursive: true });
      const stale = path.join(dir, ".abc.txt.0011223344556677.tmp");
      const fresh = path.join(dir, ".def.txt.8899aabbccddeeff.tmp");
      await writeFile(stale, "half");
      await writeFile(fresh, "half");
      const twoHoursAgo = new Date(Date.now() - 2 * 3_600_000);
      await utimes(stale, twoHoursAgo, twoHoursAgo);

      const swept = await sweepDocumentStore(pool, store);

      assert.deepEqual(swept, { temporaryRemoved: 1, reservationsReleased: 1 });
      assert.equal(await getTripDocument(pool, tripId, abandoned.id), null, "the abandoned claim is released");
      assert.ok(await getTripDocument(pool, tripId, inProgress.id), "a claim still in progress is not");
      assert.equal((await getTripDocument(pool, tripId, kept.id))?.ingestState, "stored", "a stored document is never touched");
      assert.equal(await store.exists(key), true);
      assert.deepEqual((await readdir(dir)).filter((n) => n.endsWith(".tmp")), [path.basename(fresh)]);

      assert.deepEqual(await sweepDocumentStore(pool, store), { temporaryRemoved: 0, reservationsReleased: 0 }, "and a second sweep finds nothing");
    } finally {
      await pool.end();
      await rm(root, { recursive: true, force: true });
    }
  });
});
