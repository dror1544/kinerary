/**
 * WhatsApp S2: the `relay.whatsapp` profile block. (Configuration, spec 625.)
 * The fixture number below is a test value; the real one comes from the deployment's profile.
 */
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { validateArchitectureProfile } from "../src/config.js";

const examplePath = fileURLToPath(new URL("../../config/architecture.example.json", import.meta.url));
const base = JSON.parse(await readFile(examplePath, "utf8")) as Record<string, unknown>;

const withWhatsapp = (whatsapp: unknown) => ({
  ...base,
  relay: {
    bind_host: "127.0.0.1", port: 4318, gateway_secret_refs: ["env://RELAY_GATEWAY_SECRET"],
    telegram_bot_token_secret_ref: "env://TELEGRAM_BOT_TOKEN", ...(whatsapp === undefined ? {} : { whatsapp }),
  },
});
const block = (over: Record<string, unknown> = {}) => ({
  bridge_url: "http://127.0.0.1:4390", bridge_secret_ref: "env://WA_BRIDGE_SECRET", sender_id_secret_ref: "env://WA_SENDER_KEY",
  number: "15550100123", ...over,
});

test("Configuration: no relay.whatsapp block means the feature is not present, and defaults apply when it is", () => {
  assert.equal(validateArchitectureProfile(withWhatsapp(undefined)).relay?.whatsapp, undefined);
  const parsed = validateArchitectureProfile(withWhatsapp(block()));
  assert.equal(parsed.relay?.whatsapp?.code_ttl_seconds, 900);
  assert.equal(parsed.relay?.whatsapp?.code_attempts_per_hour, 5);
  assert.equal(parsed.relay?.whatsapp?.number, "15550100123");
});

test("Configuration: bridge_url accepts loopback addresses only", () => {
  for (const ok of ["http://127.0.0.1:4390", "http://[::1]:4390", "http://localhost:4390"]) {
    assert.doesNotThrow(() => validateArchitectureProfile(withWhatsapp(block({ bridge_url: ok }))), ok);
  }
  for (const bad of ["https://127.0.0.1:4390", "http://192.168.1.5:4390", "http://example.com", "http://127.0.0.1.evil.example:4390",
    "http://127.0.0.1:4390/x", "http://user:pw@127.0.0.1:4390", "ftp://127.0.0.1", "not a url", "http://0.0.0.0:4390"]) {
    assert.throws(() => validateArchitectureProfile(withWhatsapp(block({ bridge_url: bad }))), bad);
  }
});

test("Configuration: the number is digits only; secrets are references; unknown keys are refused", () => {
  for (const bad of ["+15550100123", "1555 010 0123", "12345", "1".repeat(16), ""]) {
    assert.throws(() => validateArchitectureProfile(withWhatsapp(block({ number: bad }))), `number ${bad}`);
  }
  assert.throws(() => validateArchitectureProfile(withWhatsapp(block({ bridge_secret_ref: "literal-secret" }))));
  assert.throws(() => validateArchitectureProfile(withWhatsapp(block({ sender_id_secret_ref: "file://../x" }))));
  assert.throws(() => validateArchitectureProfile(withWhatsapp(block({ extra: 1 }))));
});
