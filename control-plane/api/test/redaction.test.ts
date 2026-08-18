import assert from "node:assert/strict";
import { test } from "node:test";
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

test("structured logs redact connection-string userinfo", () => {
  const line = structuredLog("error", "database.connect_failed", {
    detail: "could not connect to postgresql://kinerary:SUPERSECRET@db.internal:5432/kinerary",
  });
  assert.doesNotMatch(line, /SUPERSECRET/);
  assert.match(line, /postgresql:\/\/\[REDACTED\]@db\.internal/);
});

test("caller fields cannot forge the level or event of a line", () => {
  const line = structuredLog("error", "adapter.failed", {
    level: "info",
    event: "adapter.succeeded",
    detail: "visible",
  });
  assert.deepEqual(JSON.parse(line), {
    level: "error",
    event: "adapter.failed",
    detail: "visible",
  });
});

test("structured logs redact keys regardless of case style", () => {
  const line = structuredLog("info", "adapter.call", {
    accessToken: "ghp_RAWSECRET123",
    userCredential: "RAWVALUE",
    passphrase: "RAWVALUE2",
    keep: "visible",
  });
  assert.doesNotMatch(line, /RAWSECRET123|RAWVALUE/);
  assert.match(line, /visible/);
});
