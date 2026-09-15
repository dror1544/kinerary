/**
 * The document store refuses to be ephemeral.
 *
 * Originals cannot be rebuilt, so a deployment that requires the store must not
 * start with it on a container's own filesystem, on an empty directory Docker
 * created for a missing mount, or on a path it cannot write.
 */
import assert from "node:assert/strict";
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, test } from "node:test";
import { checkDocumentStore, DOCUMENT_STORE_MARKER, mountPointFor } from "../src/document-store.js";

const mountinfo = (points: string[]) =>
  points.map((p, i) => `${i + 20} 1 0:${i} / ${p} rw,relatime - fs src rw`).join("\n");

describe("mountPointFor", () => {
  test("the longest mount point containing the path, with octal escapes decoded", () => {
    const info = mountinfo(["/", "/var/lib/kinerary/document-store", "/var/lib", "/mnt/with\\040space"]);
    assert.equal(mountPointFor("/var/lib/kinerary/document-store", info), "/var/lib/kinerary/document-store");
    assert.equal(mountPointFor("/var/lib/kinerary/document-store/trip_1", info), "/var/lib/kinerary/document-store");
    assert.equal(mountPointFor("/var/lib/other", info), "/var/lib");
    assert.equal(mountPointFor("/opt/app", info), "/");
    assert.equal(mountPointFor("/mnt/with space/x", info), "/mnt/with space");
    assert.equal(mountPointFor("/var/library", info), "/", "a prefix that is not a path segment does not count");
  });
});

describe("checkDocumentStore", () => {
  test("each way a store is not ready is named", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "doc-store-ready-"));
    try {
      assert.deepEqual(await checkDocumentStore({}), { ok: false, reason: "NOT_CONFIGURED", detail: "DOCUMENT_STORE_DIR is not set" });
      assert.equal((await checkDocumentStore({ DOCUMENT_STORE_DIR: path.join(dir, "nope") })).ok, false);
      const file = path.join(dir, "file");
      await writeFile(file, "x");
      const notDir = await checkDocumentStore({ DOCUMENT_STORE_DIR: file });
      assert.equal(!notDir.ok && notDir.reason, "NOT_A_DIRECTORY");

      const unmarked = await checkDocumentStore({ DOCUMENT_STORE_DIR: dir }, { mountinfo: async () => null });
      assert.equal(!unmarked.ok && unmarked.reason, "NO_MARKER", "an empty directory is not the store");

      await writeFile(path.join(dir, DOCUMENT_STORE_MARKER), "");
      const onRoot = await checkDocumentStore({ DOCUMENT_STORE_DIR: dir }, { mountinfo: async () => mountinfo(["/"]) });
      assert.equal(!onRoot.ok && onRoot.reason, "NOT_A_MOUNT", "the container's own filesystem is refused");

      const mounted = await checkDocumentStore({ DOCUMENT_STORE_DIR: dir }, { mountinfo: async () => mountinfo(["/", path.resolve(dir)]) });
      assert.deepEqual(mounted, { ok: true, root: path.resolve(dir) });

      const noProc = await checkDocumentStore({ DOCUMENT_STORE_DIR: dir }, { mountinfo: async () => null });
      assert.equal(noProc.ok, true, "without /proc (a Mac) the marker and the write probe decide");

      if (process.getuid?.() !== 0) {
        await chmod(dir, 0o555);
        const readOnly = await checkDocumentStore({ DOCUMENT_STORE_DIR: dir }, { mountinfo: async () => null });
        assert.equal(!readOnly.ok && readOnly.reason, "NOT_WRITABLE");
        await chmod(dir, 0o755);
      }
    } finally {
      await chmod(dir, 0o755).catch(() => {});
      await rm(dir, { recursive: true, force: true });
    }
  });
});
