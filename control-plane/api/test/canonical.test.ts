import assert from "node:assert/strict";
import { test } from "node:test";
import {
  assertCanonicalRecordSafe,
  isCanonicalRecordSafe,
  UnsafeCanonicalRecordError,
} from "../src/canonical.js";
import { loadCanonicalFixtures } from "./canonical-fixtures.js";

function captureUnsafe(build: () => void): UnsafeCanonicalRecordError {
  try {
    build();
  } catch (error) {
    assert.ok(error instanceof UnsafeCanonicalRecordError, `expected UnsafeCanonicalRecordError, got ${error}`);
    return error;
  }
  assert.fail("expected the record to be rejected");
}

test("every shared fixture gets the verdict it claims", async () => {
  const { unsafe, safe } = await loadCanonicalFixtures();
  for (const { label, document } of unsafe) {
    assert.equal(isCanonicalRecordSafe(document), false, `expected rejection: ${label}`);
  }
  for (const { label, document } of safe) {
    assert.equal(isCanonicalRecordSafe(document), true, `expected acceptance: ${label}`);
  }
  assert.ok(unsafe.length >= 30 && safe.length >= 12, "fixture set should not silently shrink");
});

test("the failure names the offending path without quoting the value", () => {
  const error = captureUnsafe(() =>
    assertCanonicalRecordSafe({ runtime: { agent: { accessToken: "ghp_RAWSECRET123" } } }));
  assert.equal(error.path, "$.runtime.agent.accessToken");
  // Naming the field is the whole point of an application-layer check; quoting
  // its value would leak the secret the check exists to stop.
  assert.doesNotMatch(error.message, /ghp_RAWSECRET123/);
});

test("an offending array element is located by index", () => {
  const error = captureUnsafe(() => assertCanonicalRecordSafe({ hosts: ["example.com", "192.168.1.10"] }));
  assert.equal(error.path, "$.hosts[1]");
});

test("a reference key is rejected for its value, not its name", () => {
  assert.doesNotThrow(() => assertCanonicalRecordSafe({ db_secret_ref: "vault://kv/data/x" }));
  const error = captureUnsafe(() => assertCanonicalRecordSafe({ db_secret_ref: "postgresql://u:PASSWORD@h/db" }));
  assert.equal(error.path, "$.db_secret_ref");
  assert.doesNotMatch(error.message, /PASSWORD/);
});
