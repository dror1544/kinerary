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

/**
 * A present block the schema refuses disables WHATSAPP ONLY (owner's decision 2026-11-24, spec 625 Configuration): the
 * profile still loads, `relay.whatsapp` is absent, and `relay.whatsapp_invalid` names the field and the rule (never a
 * value) for the relay's one `relay.whatsapp_disabled` line. Until 2026-11-25 these blocks made the whole profile fail,
 * which stopped the relay and Telegram with it (boundary review of #655, F1).
 */
const refusedAs = (whatsapp: unknown, field: string, label: string) => {
  const parsed = validateArchitectureProfile(withWhatsapp(whatsapp));
  assert.equal(parsed.relay?.whatsapp, undefined, `${label}: block dropped`);
  assert.equal(parsed.relay?.whatsapp_invalid?.field, field, `${label}: field named`);
  assert.equal(parsed.relay?.port, 4318, `${label}: the rest of the relay block is intact`);
  assert.equal(parsed.relay?.telegram_bot_token_secret_ref, "env://TELEGRAM_BOT_TOKEN", `${label}: Telegram intact`);
  return parsed.relay!.whatsapp_invalid!;
};

test("Configuration: bridge_url accepts loopback addresses only; anything else disables WhatsApp, not the profile", () => {
  for (const ok of ["http://127.0.0.1:4390", "http://[::1]:4390", "http://localhost:4390"]) {
    const parsed = validateArchitectureProfile(withWhatsapp(block({ bridge_url: ok })));
    assert.ok(parsed.relay?.whatsapp, ok);
    assert.equal(parsed.relay?.whatsapp_invalid, undefined, ok);
  }
  for (const bad of ["https://127.0.0.1:4390", "http://192.168.1.5:4390", "http://example.com", "http://127.0.0.1.evil.example:4390",
    "http://127.0.0.1:4390/x", "http://user:pw@127.0.0.1:4390", "ftp://127.0.0.1", "not a url", "http://0.0.0.0:4390"]) {
    const invalid = refusedAs(block({ bridge_url: bad }), "relay.whatsapp.bridge_url", bad);
    assert.ok(!invalid.reason.includes(bad) && !invalid.reason.includes("192.168"), `${bad}: the reason never quotes the value`);
  }
});

test("Configuration: a bad number, a literal secret, an unknown key or a missing field disables WhatsApp, not the profile", () => {
  for (const bad of ["+15550100123", "1555 010 0123", "12345", "1".repeat(16), ""]) {
    const invalid = refusedAs(block({ number: bad }), "relay.whatsapp.number", `number ${bad}`);
    assert.ok(!bad || !invalid.reason.includes(bad), `number ${bad}: the reason never quotes the value`);
  }
  refusedAs(block({ bridge_secret_ref: "literal-secret" }), "relay.whatsapp.bridge_secret_ref", "literal secret");
  refusedAs(block({ sender_id_secret_ref: "file://../x" }), "relay.whatsapp.sender_id_secret_ref", "relative ref");
  const extra = refusedAs(block({ bridge_secret: "hunter2-value" }), "relay.whatsapp", "unknown key");
  assert.ok(!extra.reason.includes("hunter2"), "the reason never quotes a value");
  const { number: _number, ...noNumber } = block();
  refusedAs(noNumber, "relay.whatsapp.number", "missing number");
  refusedAs(block({ code_ttl_seconds: 5 }), "relay.whatsapp.code_ttl_seconds", "ttl out of range");
  refusedAs("not an object", "relay.whatsapp", "not an object");
});

test("Configuration: whatsapp_invalid is the loader's output, never a profile key", () => {
  assert.throws(() => validateArchitectureProfile({
    ...withWhatsapp(undefined),
    relay: { ...(withWhatsapp(undefined).relay as object), whatsapp_invalid: { field: "x", reason: "y" } },
  }));
});
