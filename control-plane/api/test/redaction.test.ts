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
