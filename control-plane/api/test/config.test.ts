import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { validateArchitectureProfile, validateBeforeProvider } from "../src/config.js";

const examplePath = fileURLToPath(new URL("../../config/architecture.example.json", import.meta.url));

test("the committed architecture example is valid and contains references, not credentials", async () => {
  const raw = JSON.parse(await readFile(examplePath, "utf8"));
  const profile = validateArchitectureProfile(raw);
  assert.equal(profile.database.connection_secret_ref, "env://CONTROL_PLANE_DATABASE_URL");
  assert.doesNotMatch(JSON.stringify(raw), /(?:token|password|api[_-]?key)\s*[":=]+\s*(?!ref)/i);
});

test("missing or invalid architecture fails before a provider is constructed", () => {
  let providerCalls = 0;
  assert.throws(() => validateBeforeProvider({ version: 1 }, () => {
    providerCalls += 1;
    return {};
  }));
  assert.equal(providerCalls, 0);
});

test("a secret reference cannot traverse out of its allocation", async () => {
  const raw = JSON.parse(await readFile(examplePath, "utf8"));
  for (const traversal of [
    "file://../../etc/passwd",
    "file:///run/secrets/../../etc/shadow",
    "vault://kv/../../root",
  ]) {
    assert.throws(
      () => validateArchitectureProfile({ ...raw, database: { connection_secret_ref: traversal } }),
      `expected rejection: ${traversal}`,
    );
  }
  assert.doesNotThrow(() => validateArchitectureProfile({
    ...raw,
    database: { connection_secret_ref: "file:///run/secrets/control_plane_database_url" },
  }));
});

test("worker health is private and production cannot select the test allocation", async () => {
  const raw = JSON.parse(await readFile(examplePath, "utf8"));
  assert.throws(() => validateArchitectureProfile({
    ...raw,
    worker: { ...raw.worker, health_bind_host: "0.0.0.0" },
  }));
  assert.throws(() => validateArchitectureProfile({ ...raw, environment: "production" }));
  assert.doesNotThrow(() => validateArchitectureProfile({
    ...raw,
    environment: "production",
    test_resources: { enabled: false },
    adapters: { ...raw.adapters, messaging: "telegram" },
  }));
});

test("a production profile with signup configured cannot select the fake messaging adapter", async () => {
  const raw = JSON.parse(await readFile(examplePath, "utf8"));
  // The example fixture's adapters.messaging is "fake" and it has a signup
  // block — both true at once in production must fail, since the
  // super-admin would never receive a real approval notification.
  assert.throws(() => validateArchitectureProfile({
    ...raw,
    environment: "production",
    test_resources: { enabled: false },
  }));
  // Selecting a non-fake messaging adapter clears the block, at the schema
  // level — whether that adapter is actually implemented yet is a runtime
  // concern (createNotificationAdapter), not a profile-shape concern.
  assert.doesNotThrow(() => validateArchitectureProfile({
    ...raw,
    environment: "production",
    test_resources: { enabled: false },
    adapters: { ...raw.adapters, messaging: "telegram" },
  }));
  // A production profile with no signup block at all is unaffected by this
  // rule regardless of the messaging adapter it selects.
  const { signup: _signup, ...withoutSignup } = raw;
  assert.doesNotThrow(() => validateArchitectureProfile({
    ...withoutSignup,
    environment: "production",
    test_resources: { enabled: false },
  }));
});
