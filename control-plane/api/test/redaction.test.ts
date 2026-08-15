import assert from "node:assert/strict";
import { test } from "node:test";
import { assertCanonicalRecordSafe, UnsafeCanonicalRecordError } from "../src/canonical.js";
import { structuredLog } from "../src/redaction.js";

test("structured logs recursively redact credentials and messaging identities", () => {
  const line = structuredLog("info", "adapter.call", {
    authorization: "Bearer secret-value",
    nested: { telegram_id: 123456, ok: "visible" },
    message: "PVEAPIToken=operator=secret",
  });
  assert.doesNotMatch(line, /secret-value|123456|operator=secret/);
  assert.match(line, /visible/);
});

test("canonical records reject secret-bearing keys, host paths, private IPs and OAuth material", () => {
  const unsafe = [
    { refresh_token: "opaque" },
    { path: "/Users/example/private-trip" },
    { upstream: "192.168.1.10" },
    { note: "Bearer credential" },
  ];
  for (const value of unsafe) {
    assert.throws(() => assertCanonicalRecordSafe(value), UnsafeCanonicalRecordError);
  }
});

test("portable identifiers and secret references are safe canonical values", () => {
  assert.doesNotThrow(() => assertCanonicalRecordSafe({
    trip_id: "trip_abcdefgh",
    provider_resource_ref: "prv_abcdefgh",
    connection_secret_ref: "env://CONTROL_PLANE_DATABASE_URL",
  }));
});
