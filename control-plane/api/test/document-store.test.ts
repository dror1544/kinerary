/**
 * The document blob store, against a real temporary directory.
 *
 * No database and no model: the properties here are about bytes on a
 * filesystem — that a final path is always complete and matches its name, that
 * nothing an uploader supplies becomes a path, that concurrent identical writes
 * converge without replacing each other, and that handoff avoids a second copy
 * whenever the filesystem allows it.
 *
 * A local directory is not evidence that an NFS mount behaves the same. These
 * tests pin the logic; the deployed mount needs its own acceptance run.
 */
import assert from "node:assert/strict";
import { mkdtemp, readdir, readFile, rm, stat, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, test } from "node:test";
import {
  contentDigest,
  DocumentStoreError,
  documentStoreFromEnv,
  filesystemDocumentStore,
  parseStorageKey,
  storageKeyFor,
} from "../src/document-store.js";

const TRIP = "trip_0123456789abcdef0123456789abcdef";
const OTHER_TRIP = "trip_fedcba9876543210fedcba9876543210";

async function withRoot(fn: (root: string) => Promise<void>): Promise<void> {
  const root = await mkdtemp(path.join(tmpdir(), "doc-store-"));
  try {
    await fn(root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

function bytesOf(text: string): Uint8Array {
  return new TextEncoder().encode(text);
}

async function tempFilesUnder(dir: string): Promise<string[]> {
  try {
    return (await readdir(dir)).filter((name) => name.endsWith(".tmp"));
  } catch {
    return [];
  }
}

describe("storage keys", () => {
  test("are derived from the trip and the content, never from a filename", () => {
    const bytes = bytesOf("hotel confirmation");
    const key = storageKeyFor(TRIP, contentDigest(bytes), "pdf");
    assert.equal(key, `${TRIP}/${contentDigest(bytes).slice("sha256:".length)}.pdf`);
    assert.deepEqual(parseStorageKey(key), { tripId: TRIP, digest: contentDigest(bytes), ext: "pdf" });
  });

  test("refuse anything that could leave the trip's directory", () => {
    const digest = contentDigest(bytesOf("x"));
    for (const tripId of ["../trip_0123456789abcdef", "trip_01234567/../../etc", "", "TRIP_0123456789"]) {
      assert.throws(() => storageKeyFor(tripId, digest, "pdf"), DocumentStoreError);
    }
    assert.throws(() => storageKeyFor(TRIP, "md5:abc", "pdf"), DocumentStoreError);
    assert.equal(parseStorageKey(`${TRIP}/../passwd.pdf`), null);
    assert.equal(parseStorageKey(`${TRIP}/${"a".repeat(64)}.exe`), null);
  });
});

describe("filesystemDocumentStore", () => {
  test("stores once, reads back exactly, and treats a re-upload as already there", async () => {
    await withRoot(async (root) => {
      const store = filesystemDocumentStore(root);
      const bytes = bytesOf("Yapan Tours — Hotel Gracery Shinjuku, 19–23 Sep");
      const key = storageKeyFor(TRIP, contentDigest(bytes), "pdf");

      assert.deepEqual(await store.put(key, bytes), { created: true });
      assert.deepEqual(await store.put(key, bytes), { created: false });
      assert.deepEqual(await store.read(key), bytes);
      assert.equal(await store.exists(key), true);
      assert.deepEqual(await store.list(TRIP), [key]);
      assert.deepEqual(await tempFilesUnder(path.join(root, TRIP)), [], "no interrupted-write debris");
    });
  });

  test("refuses bytes that do not match the key, and leaves nothing behind", async () => {
    await withRoot(async (root) => {
      const store = filesystemDocumentStore(root);
      const key = storageKeyFor(TRIP, contentDigest(bytesOf("the real voucher")), "pdf");
      await assert.rejects(store.put(key, bytesOf("something else")), { code: "DIGEST_MISMATCH" });
      assert.equal(await store.exists(key), false);
      assert.deepEqual(await tempFilesUnder(path.join(root, TRIP)), []);
    });
  });

  test("concurrent uploads of identical bytes converge on one file without replacing it", async () => {
    await withRoot(async (root) => {
      const store = filesystemDocumentStore(root);
      const bytes = bytesOf("the same confirmation, sent five times at once");
      const key = storageKeyFor(TRIP, contentDigest(bytes), "pdf");

      const results = await Promise.all(Array.from({ length: 5 }, () => store.put(key, bytes)));
      assert.equal(results.filter((r) => r.created).length >= 1, true);
      assert.deepEqual(await store.read(key), bytes);
      assert.deepEqual(await tempFilesUnder(path.join(root, TRIP)), []);
    });
  });

  test("never papers over a stored file that does not match its name", async () => {
    await withRoot(async (root) => {
      const store = filesystemDocumentStore(root);
      const bytes = bytesOf("genuine");
      const key = storageKeyFor(TRIP, contentDigest(bytes), "pdf");
      await store.put(key, bytes);
      // Corruption, or a bug that wrote the wrong bytes under a name.
      await writeFile(path.join(root, key), "corrupted");

      await assert.rejects(store.put(key, bytes), { code: "CONFLICTING_CONTENT" });
      assert.equal(await readFile(path.join(root, key), "utf8"), "corrupted", "left for a person to look at");
    });
  });

  test("keeps one trip's documents out of another trip's listing", async () => {
    await withRoot(async (root) => {
      const store = filesystemDocumentStore(root);
      const bytes = bytesOf("shared voucher");
      const a = storageKeyFor(TRIP, contentDigest(bytes), "pdf");
      const b = storageKeyFor(OTHER_TRIP, contentDigest(bytes), "pdf");
      await store.put(a, bytes);
      await store.put(b, bytes);
      assert.deepEqual(await store.list(TRIP), [a]);
      assert.deepEqual(await store.list(OTHER_TRIP), [b]);
      assert.deepEqual(await store.list("trip_00000000000000000000000000000000"), []);
    });
  });

  test("hands off with a hard link when it can — one set of bytes, two names", async () => {
    await withRoot(async (root) => {
      const store = filesystemDocumentStore(path.join(root, "control-plane"));
      const bytes = bytesOf("voucher for the trip site");
      const key = storageKeyFor(TRIP, contentDigest(bytes), "pdf");
      await store.put(key, bytes);
      const tripDocuments = path.join(root, "trips", "japan-2026", "documents");

      const first = await store.publish(key, tripDocuments);
      assert.equal(first.strategy, "hardlink");
      const original = await stat(path.join(root, "control-plane", key));
      const published = await stat(first.path);
      assert.equal(published.ino, original.ino, "the same inode, not a copy");
      assert.equal(original.nlink, 2);

      // A retried handoff is not a failure and not a second copy.
      const again = await store.publish(key, tripDocuments);
      assert.equal(again.strategy, "existing");
      assert.equal(again.path, first.path);
    });
  });

  test("falls back to a verified copy when links cross filesystems", async () => {
    await withRoot(async (root) => {
      const exdev = async () => {
        throw Object.assign(new Error("cross-device link"), { code: "EXDEV" });
      };
      const store = filesystemDocumentStore(path.join(root, "control-plane"), { link: exdev });
      const bytes = bytesOf("voucher on another filesystem");
      const key = storageKeyFor(TRIP, contentDigest(bytes), "pdf");
      // `put` uses the injected link too, and EXDEV is not a link-refusal code,
      // so seed the original with a store that can link.
      await filesystemDocumentStore(path.join(root, "control-plane")).put(key, bytes);

      const out = await store.publish(key, path.join(root, "trip-documents"));
      assert.equal(out.strategy, "copy");
      assert.deepEqual(new Uint8Array(await readFile(out.path)), bytes);
      assert.notEqual((await stat(out.path)).ino, (await stat(path.join(root, "control-plane", key))).ino);
      assert.deepEqual(await tempFilesUnder(path.join(root, "trip-documents")), []);
    });
  });

  test("stores on a filesystem that refuses hard links", async () => {
    await withRoot(async (root) => {
      const eperm = async () => {
        throw Object.assign(new Error("links not permitted"), { code: "EPERM" });
      };
      const store = filesystemDocumentStore(root, { link: eperm });
      const bytes = bytesOf("no hard links here");
      const key = storageKeyFor(TRIP, contentDigest(bytes), "docx");
      assert.deepEqual(await store.put(key, bytes), { created: true });
      assert.deepEqual(await store.put(key, bytes), { created: false });
      assert.deepEqual(await store.read(key), bytes);
    });
  });

  test("sweeps only interrupted writes that are old enough", async () => {
    await withRoot(async (root) => {
      const store = filesystemDocumentStore(root);
      const bytes = bytesOf("complete");
      const key = storageKeyFor(TRIP, contentDigest(bytes), "pdf");
      await store.put(key, bytes);
      const dir = path.join(root, TRIP);
      const stale = path.join(dir, ".abc.pdf.0011223344556677.tmp");
      const fresh = path.join(dir, ".def.pdf.8899aabbccddeeff.tmp");
      await writeFile(stale, "half");
      await writeFile(fresh, "half");
      const hourAgo = new Date(Date.now() - 3_600_000);
      await utimes(stale, hourAgo, hourAgo);

      assert.equal(await store.sweepTemporary(10 * 60_000), 1);
      assert.deepEqual((await tempFilesUnder(dir)).sort(), [path.basename(fresh)]);
      assert.equal(await store.exists(key), true, "a complete document is never swept");
    });
  });

  test("removes one original and reports a missing one honestly", async () => {
    await withRoot(async (root) => {
      const store = filesystemDocumentStore(root);
      const bytes = bytesOf("to be retired");
      const key = storageKeyFor(TRIP, contentDigest(bytes), "pdf");
      await store.put(key, bytes);
      assert.equal(await store.remove(key), true);
      assert.equal(await store.remove(key), false);
      assert.equal(await store.read(key), null);
    });
  });

  test("requires an absolute root, and an unset root is no store at all", () => {
    assert.throws(() => filesystemDocumentStore("relative/root"), DocumentStoreError);
    assert.equal(documentStoreFromEnv({}), undefined);
    assert.equal(documentStoreFromEnv({ DOCUMENT_STORE_DIR: "  " }), undefined);
    assert.ok(documentStoreFromEnv({ DOCUMENT_STORE_DIR: tmpdir() }));
  });
});
