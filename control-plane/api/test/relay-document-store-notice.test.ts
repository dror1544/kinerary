/**
 * #544: a relay that does not keep the originals of the documents it reads says
 * so at start - including when DOCUMENT_STORE_DIR is simply unset, the case that
 * used to have no line at all.
 */
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, test } from "node:test";
import { checkDocumentStore, DOCUMENT_STORE_MARKER } from "../src/document-store.js";
import { documentStoreNotice } from "../src/relay/document-store-notice.js";

describe("the relay's start-up line about keeping originals (#544)", () => {
  test("unset: a warning that says originals are dropped - not silence", async () => {
    const env = {} as NodeJS.ProcessEnv;
    const notice = documentStoreNotice(await checkDocumentStore(env), env);
    assert.equal(notice.level, "warn");
    assert.equal(notice.event, "relay.document_store_not_ready");
    assert.equal(notice.fields.reason, "NOT_CONFIGURED");
    assert.equal(notice.fields.keeps_originals, false);
    assert.match(String(notice.fields.hint), /dropped/);
    assert.equal(notice.fatal, false, "unset stays a downgrade where the deployment did not require a store");
  });

  test("unset where a store is required: error, and the relay does not start", async () => {
    const env = { DOCUMENT_STORE_REQUIRED: "1" } as NodeJS.ProcessEnv;
    const notice = documentStoreNotice(await checkDocumentStore(env), env);
    assert.equal(notice.level, "error");
    assert.equal(notice.fatal, true);
  });

  test("a ready store is one info line saying originals are kept", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "doc-store-notice-"));
    try {
      await writeFile(path.join(root, DOCUMENT_STORE_MARKER), "");
      const env = { DOCUMENT_STORE_DIR: root } as NodeJS.ProcessEnv;
      const readiness = await checkDocumentStore(env, { mountinfo: async () => null });
      const notice = documentStoreNotice(readiness, env);
      assert.equal(notice.level, "info");
      assert.equal(notice.event, "relay.document_store_ready");
      assert.equal(notice.fields.keeps_originals, true);
      assert.equal(notice.fatal, false);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
