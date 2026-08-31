import assert from "node:assert/strict";
import { createHash, createHmac } from "node:crypto";
import { test } from "node:test";
import { verifyTelegramLogin, digestTelegramId, verifyTelegramWebhookSecret } from "../src/identity.js";

// Test fixtures — production bot tokens must never appear here.
const TEST_BOT_TOKEN = "12345678:AAFakeBotTokenForTestingPurposesOnly";
const TEST_TELEGRAM_ID = 987654321;
const TEST_AUTH_DATE_S = Math.floor(Date.now() / 1000);

/** Build a valid Telegram login payload for the given fields. */
function buildValidPayload(
  overrides: Partial<Record<string, unknown>> = {},
  botToken = TEST_BOT_TOKEN,
): Record<string, unknown> {
  const base: Record<string, unknown> = {
    id: TEST_TELEGRAM_ID,
    first_name: "Test",
    last_name: "Organizer",
    username: "test_organizer",
    auth_date: TEST_AUTH_DATE_S,
    ...overrides,
  };
  // Remove hash if present in overrides — we always recompute it
  delete base.hash;
  const dataCheckString = Object.entries(base)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([k, v]) => `${k}=${String(v)}`)
    .join("\n");
  const secretKey = createHash("sha256").update(botToken).digest();
  const hash = createHmac("sha256", secretKey).update(dataCheckString).digest("hex");
  return { ...base, hash };
}

test("valid payload returns verified identity with both a digest and the raw sendable id", () => {
  const payload = buildValidPayload();
  const result = verifyTelegramLogin(payload, TEST_BOT_TOKEN, { nowMs: TEST_AUTH_DATE_S * 1000 + 100 });
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.identity.provider, "telegram");
  assert.match(result.identity.providerSubjectDigest, /^sha256:[a-f0-9]{64}$/);
  assert.equal(result.identity.displayName, "Test Organizer");
  // providerSubjectId exists solely so callers can message the user back —
  // it must equal the raw payload id and must never be used for identity
  // comparisons (that's what providerSubjectDigest is for).
  assert.equal(result.identity.providerSubjectId, String(TEST_TELEGRAM_ID));
});

test("display name is first_name alone when last_name is absent", () => {
  const payload = buildValidPayload({ first_name: "Solo" });
  delete (payload as Record<string, unknown>).last_name;
  // Re-sign without last_name
  const rebuilt = buildValidPayload({ first_name: "Solo", auth_date: TEST_AUTH_DATE_S });
  delete rebuilt.last_name;
  const resigned: Record<string, unknown> = { ...rebuilt };
  // Actually just rebuild completely without last_name:
  const fields: Record<string, unknown> = { id: TEST_TELEGRAM_ID, first_name: "Solo", username: "test_organizer", auth_date: TEST_AUTH_DATE_S };
  const dcs = Object.entries(fields).sort(([a], [b]) => a.localeCompare(b)).map(([k, v]) => `${k}=${String(v)}`).join("\n");
  const sk = createHash("sha256").update(TEST_BOT_TOKEN).digest();
  const h = createHmac("sha256", sk).update(dcs).digest("hex");
  const result = verifyTelegramLogin({ ...fields, hash: h }, TEST_BOT_TOKEN, { nowMs: TEST_AUTH_DATE_S * 1000 + 100 });
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.identity.displayName, "Solo");
});

test("stale auth_date is rejected", () => {
  const staleAuthDate = Math.floor(Date.now() / 1000) - 700; // 700s ago, exceeds 600s default
  const payload = buildValidPayload({ auth_date: staleAuthDate });
  const result = verifyTelegramLogin(payload, TEST_BOT_TOKEN);
  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.equal(result.error, "TELEGRAM_LOGIN_STALE");
});

test("future auth_date beyond tolerance is rejected", () => {
  const futureDate = Math.floor(Date.now() / 1000) + 120; // 2 min in future, > 60s tolerance
  const payload = buildValidPayload({ auth_date: futureDate });
  const result = verifyTelegramLogin(payload, TEST_BOT_TOKEN, { nowMs: Date.now() });
  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.equal(result.error, "TELEGRAM_LOGIN_STALE");
});

test("tampered payload is rejected even with a plausible hash", () => {
  const payload = buildValidPayload();
  (payload as Record<string, unknown>).first_name = "Hacker";
  // The hash was computed for "Test", so this now mismatches
  const result = verifyTelegramLogin(payload, TEST_BOT_TOKEN, { nowMs: TEST_AUTH_DATE_S * 1000 + 100 });
  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.equal(result.error, "TELEGRAM_LOGIN_INVALID_HASH");
});

test("wrong bot token produces invalid hash", () => {
  const payload = buildValidPayload();
  const result = verifyTelegramLogin(payload, "wrong_token", { nowMs: TEST_AUTH_DATE_S * 1000 + 100 });
  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.equal(result.error, "TELEGRAM_LOGIN_INVALID_HASH");
});

test("missing hash field is rejected", () => {
  const payload = buildValidPayload();
  delete (payload as Record<string, unknown>).hash;
  const result = verifyTelegramLogin(payload, TEST_BOT_TOKEN, { nowMs: TEST_AUTH_DATE_S * 1000 + 100 });
  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.equal(result.error, "TELEGRAM_LOGIN_HASH_MISSING");
});

test("missing required fields (id, first_name) are rejected", () => {
  const payload = buildValidPayload();
  const noId = { ...payload };
  delete (noId as Record<string, unknown>).id;
  const r1 = verifyTelegramLogin(noId, TEST_BOT_TOKEN, { nowMs: TEST_AUTH_DATE_S * 1000 + 100 });
  assert.equal(r1.ok, false);

  const noName = { ...payload, first_name: 42 };
  const r2 = verifyTelegramLogin(noName, TEST_BOT_TOKEN, { nowMs: TEST_AUTH_DATE_S * 1000 + 100 });
  assert.equal(r2.ok, false);
});

test("invalid auth_date is rejected", () => {
  const payload = buildValidPayload({ auth_date: "not-a-number" });
  const result = verifyTelegramLogin(payload, TEST_BOT_TOKEN, { nowMs: TEST_AUTH_DATE_S * 1000 + 100 });
  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.equal(result.error, "TELEGRAM_LOGIN_AUTH_DATE_INVALID");
});

test("duplicate payloads from the same user produce the same digest", () => {
  const p1 = buildValidPayload();
  const p2 = buildValidPayload();
  const r1 = verifyTelegramLogin(p1, TEST_BOT_TOKEN, { nowMs: TEST_AUTH_DATE_S * 1000 });
  const r2 = verifyTelegramLogin(p2, TEST_BOT_TOKEN, { nowMs: TEST_AUTH_DATE_S * 1000 });
  assert.equal(r1.ok, true);
  assert.equal(r2.ok, true);
  if (!r1.ok || !r2.ok) return;
  assert.equal(r1.identity.providerSubjectDigest, r2.identity.providerSubjectDigest);
});

test("digestTelegramId is stable and sha256-prefixed", () => {
  const d = digestTelegramId("123456789");
  assert.match(d, /^sha256:[a-f0-9]{64}$/);
  assert.equal(d, digestTelegramId("123456789"));
  assert.notEqual(d, digestTelegramId("987654321"));
});

test("non-hex hash value is rejected cleanly", () => {
  const payload = buildValidPayload();
  (payload as Record<string, unknown>).hash = "not-hex-at-all!!";
  const result = verifyTelegramLogin(payload, TEST_BOT_TOKEN, { nowMs: TEST_AUTH_DATE_S * 1000 + 100 });
  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.equal(result.error, "TELEGRAM_LOGIN_INVALID_HASH");
});

test("verifyTelegramWebhookSecret accepts an exact match", () => {
  assert.equal(verifyTelegramWebhookSecret("correct-secret-value", "correct-secret-value"), true);
});

test("verifyTelegramWebhookSecret rejects a mismatched value", () => {
  assert.equal(verifyTelegramWebhookSecret("wrong-value", "correct-secret-value"), false);
});

test("verifyTelegramWebhookSecret rejects a value that differs only in length", () => {
  assert.equal(verifyTelegramWebhookSecret("correct-secret-value-extra", "correct-secret-value"), false);
});

test("verifyTelegramWebhookSecret fails closed on missing or non-string header", () => {
  assert.equal(verifyTelegramWebhookSecret(undefined, "correct-secret-value"), false);
  assert.equal(verifyTelegramWebhookSecret(null, "correct-secret-value"), false);
  assert.equal(verifyTelegramWebhookSecret(12345, "correct-secret-value"), false);
  assert.equal(verifyTelegramWebhookSecret(["correct-secret-value"], "correct-secret-value"), false);
});

test("verifyTelegramWebhookSecret rejects an empty header even against an empty configured secret", () => {
  assert.equal(verifyTelegramWebhookSecret("", ""), false);
});
