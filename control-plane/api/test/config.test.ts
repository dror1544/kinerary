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
  }));
});
