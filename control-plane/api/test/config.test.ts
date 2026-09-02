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
    // With a #field selector the reference satisfies the vault:// pattern, so
    // the traversal refinement is the only thing rejecting it.
    "vault://secret/data/../../sys/mounts#token",
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
  assert.doesNotThrow(() => validateArchitectureProfile({
    ...raw,
    database: { connection_secret_ref: "vault://secret/data/kinerary/database#url" },
  }));
});

test("a vault reference must name the field it means", async () => {
  const raw = JSON.parse(await readFile(examplePath, "utf8"));
  // A KV secret holds several pairs, so a bare path does not identify a value.
  assert.throws(() => validateArchitectureProfile({
    ...raw,
    database: { connection_secret_ref: "vault://secret/data/kinerary/database" },
  }));
  assert.throws(() => validateArchitectureProfile({
    ...raw,
    database: { connection_secret_ref: "vault://secret/data/kinerary/database#" },
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
    // A generic stand-in for "not fake" — deliberately not "telegram",
    // which since Sprint 5 carries its own schema requirement
    // (super_admin_chat_id_secret_ref) unrelated to what this test checks.
    adapters: { ...raw.adapters, messaging: "not-fake" },
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
  // concern (createNotificationAdapter), not a profile-shape concern. Uses
  // the same generic stand-in as the test above, for the same reason.
  assert.doesNotThrow(() => validateArchitectureProfile({
    ...raw,
    environment: "production",
    test_resources: { enabled: false },
    adapters: { ...raw.adapters, messaging: "not-fake" },
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

test("the telegram messaging adapter needs super_admin_chat_id_secret_ref", async () => {
  const raw = JSON.parse(await readFile(examplePath, "utf8"));
  // The digest in super_admin_subject_digest cannot be reversed to find
  // where to send the outbound approval DM — a separate raw-ID reference is
  // required whenever "telegram" is actually selected.
  assert.throws(() => validateArchitectureProfile({
    ...raw,
    adapters: { ...raw.adapters, messaging: "telegram" },
  }));
  assert.doesNotThrow(() => validateArchitectureProfile({
    ...raw,
    adapters: { ...raw.adapters, messaging: "telegram" },
    signup: { ...raw.signup, super_admin_chat_id_secret_ref: "env://CONTROL_PLANE_SUPER_ADMIN_CHAT_ID" },
  }));
  // Not required for adapters other than "telegram" — including "fake",
  // which never sends anything and so never needs a destination.
  assert.doesNotThrow(() => validateArchitectureProfile(raw));
});

test("the relay block binds its secrets through secret_ref, like every other secret", async () => {
  const raw = JSON.parse(await readFile(examplePath, "utf8"));
  assert.doesNotThrow(() => validateArchitectureProfile(raw));
  assert.equal(validateArchitectureProfile(raw).relay?.port, 4312);

  // A LIST, so a rotation can overlap: the gateway may still be presenting a
  // token signed with the previous secret when this side restarts.
  assert.doesNotThrow(() => validateArchitectureProfile({
    ...raw,
    relay: {
      ...raw.relay,
      gateway_secret_refs: [
        "env://CONTROL_PLANE_RELAY_GATEWAY_SECRET",
        "env://CONTROL_PLANE_RELAY_GATEWAY_SECRET_PREVIOUS",
      ],
    },
  }));
  // An empty list would serve a connector that accepts no upgrade token at
  // all while looking perfectly healthy.
  assert.throws(() => validateArchitectureProfile({
    ...raw,
    relay: { ...raw.relay, gateway_secret_refs: [] },
  }));
  // A raw secret where a reference belongs is exactly what this indirection
  // exists to prevent — it would put the gateway secret in the profile itself.
  assert.throws(() => validateArchitectureProfile({
    ...raw,
    relay: { ...raw.relay, gateway_secret_refs: ["s3cr3t-value"] },
  }));
});

test("the relay socket cannot be bound to a public interface", async () => {
  const raw = JSON.parse(await readFile(examplePath, "utf8"));
  // The connector holds the bot token and sends as the trip bot. Anything that
  // can reach this port can talk to the gateway side of that.
  assert.throws(() => validateArchitectureProfile({
    ...raw,
    relay: { ...raw.relay, bind_host: "0.0.0.0" },
  }));
  assert.doesNotThrow(() => validateArchitectureProfile({
    ...raw,
    relay: { ...raw.relay, bind_host: "::1" },
  }));
});

test("the relay port cannot collide with the api or worker port", async () => {
  const raw = JSON.parse(await readFile(examplePath, "utf8"));
  // All three default into the same 431x range; a collision surfaces as
  // EADDRINUSE on whichever service loses the race at boot.
  assert.throws(() => validateArchitectureProfile({
    ...raw,
    relay: { ...raw.relay, port: raw.public_api.port },
  }));
  assert.throws(() => validateArchitectureProfile({
    ...raw,
    relay: { ...raw.relay, port: raw.worker.health_port },
  }));
});

test("the relay block is optional — an api-only deployment omits it", async () => {
  const raw = JSON.parse(await readFile(examplePath, "utf8"));
  const { relay: _relay, ...withoutRelay } = raw;
  // Absence keeps the bot dark, which is a supported state rather than a
  // broken one.
  assert.doesNotThrow(() => validateArchitectureProfile(withoutRelay));
  assert.equal(validateArchitectureProfile(withoutRelay).relay, undefined);
});
