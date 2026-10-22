import assert from "node:assert/strict";
import { test } from "node:test";
import { verifyMiniAppInitData, INIT_DATA_MAX_BYTES } from "../src/telegram-webapp-auth.js";
import { OTHER_BOT_TOKEN, TEST_BOT_TOKEN, launchFields, signedInitData, userField } from "./support/mini-app-init-data.js";

// ── Reference vector ────────────────────────────────────────────────────────
//
// Computed with `openssl`, not with this repository's code:
//
//   secret = printf '%s' "$TOKEN" | openssl dgst -sha256 -hmac WebAppData -binary
//   hash   = openssl dgst -sha256 -mac HMAC -macopt hexkey:<secret hex> <data-check-string file>
//
// over the data-check-string below (every field but `hash`, `signature` kept,
// sorted by key, joined by "\n", values URL-decoded):
//
//   auth_date=1700000000
//   query_id=AAHdF6IQAAAAAN0XohDhrOrc
//   signature=c2lnbmF0dXJlLWZvci11bml0LXRlc3Rz
//   start_param=trip_abcdefgh12
//   user={"id":279058397,"first_name":"Vlad","last_name":"K","username":"vdkfrost","language_code":"ru","is_premium":true}
const VECTOR_TOKEN = "123456789:AAExampleFakeBotTokenForUnitTests_0000";
const VECTOR_SECRET_HEX = "54813b88263eaa9ba42c4f8cfd4c835d722437e69e79d142ad08ee31ac811b62";
const VECTOR_HASH = "9cf08f53ae5d04114fa504c4b525b5755db6729d2fb82c19c938200ea8a1f94e";
const VECTOR_INIT_DATA =
  "query_id=AAHdF6IQAAAAAN0XohDhrOrc&user=%7B%22id%22%3A279058397%2C%22first_name%22%3A%22Vlad%22%2C%22last_name%22%3A%22K%22%2C%22username%22%3A%22vdkfrost%22%2C%22language_code%22%3A%22ru%22%2C%22is_premium%22%3Atrue%7D&auth_date=1700000000&start_param=trip_abcdefgh12&signature=c2lnbmF0dXJlLWZvci11bml0LXRlc3Rz&hash=" + VECTOR_HASH;
const VECTOR_NOW = 1_700_000_000_000 + 10_000;

test("the openssl-computed reference vector verifies, and decodes the fields it should", () => {
  assert.equal(VECTOR_TOKEN, TEST_BOT_TOKEN);
  const result = verifyMiniAppInitData(VECTOR_INIT_DATA, VECTOR_TOKEN, { nowMs: VECTOR_NOW });
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.data.telegramUserId, "279058397");
  assert.equal(result.data.authDate, 1_700_000_000);
  assert.equal(result.data.startParam, "trip_abcdefgh12");
  assert.equal(result.data.chatType, null);
  assert.equal(result.data.replayKey, VECTOR_HASH);
  assert.equal(VECTOR_SECRET_HEX.length, 64);
});

test("the vector is not special: the test-side signer reproduces the same hash", () => {
  const fields = {
    query_id: "AAHdF6IQAAAAAN0XohDhrOrc",
    user: '{"id":279058397,"first_name":"Vlad","last_name":"K","username":"vdkfrost","language_code":"ru","is_premium":true}',
    auth_date: "1700000000",
    start_param: "trip_abcdefgh12",
    signature: "c2lnbmF0dXJlLWZvci11bml0LXRlc3Rz",
  };
  assert.equal(new URLSearchParams(signedInitData(fields)).get("hash"), VECTOR_HASH);
});

test("dropping `signature` from the check string (the classic mistake) does not verify a real initData", () => {
  const fields = {
    query_id: "AAHdF6IQAAAAAN0XohDhrOrc",
    user: '{"id":279058397,"first_name":"Vlad"}',
    auth_date: "1700000000",
    signature: "c2lnbmF0dXJlLWZvci11bml0LXRlc3Rz",
  };
  const withoutSignature = signedInitData(fields, TEST_BOT_TOKEN, { dropFromCheck: ["signature"] });
  const result = verifyMiniAppInitData(withoutSignature, TEST_BOT_TOKEN, { nowMs: VECTOR_NOW });
  assert.deepEqual(result, { ok: false, reason: "HASH_MISMATCH" });
  const correct = signedInitData(fields);
  assert.equal(verifyMiniAppInitData(correct, TEST_BOT_TOKEN, { nowMs: VECTOR_NOW }).ok, true);
});

// ── Forgery ─────────────────────────────────────────────────────────────────

test("forged user.id with the original hash is refused", () => {
  const forged = VECTOR_INIT_DATA.replace("279058397", "100000001");
  assert.notEqual(forged, VECTOR_INIT_DATA);
  assert.deepEqual(verifyMiniAppInitData(forged, VECTOR_TOKEN, { nowMs: VECTOR_NOW }), { ok: false, reason: "HASH_MISMATCH" });
});

test("another bot's initData (valid for that bot) is refused", () => {
  const other = signedInitData(launchFields(42, VECTOR_NOW), OTHER_BOT_TOKEN);
  assert.deepEqual(verifyMiniAppInitData(other, TEST_BOT_TOKEN, { nowMs: VECTOR_NOW }), { ok: false, reason: "HASH_MISMATCH" });
  assert.equal(verifyMiniAppInitData(other, OTHER_BOT_TOKEN, { nowMs: VECTOR_NOW }).ok, true);
});

test("the Login Widget key derivation (SHA256 of the token) does not verify Mini App data", async () => {
  const { createHash, createHmac } = await import("node:crypto");
  const fields = launchFields(42, VECTOR_NOW);
  const checked = Object.entries(fields).sort(([a], [b]) => (a < b ? -1 : 1)).map(([k, v]) => `${k}=${v}`).join("\n");
  const widgetKey = createHash("sha256").update(TEST_BOT_TOKEN).digest();
  const hash = createHmac("sha256", widgetKey).update(checked).digest("hex");
  const query = new URLSearchParams({ ...fields, hash }).toString();
  assert.deepEqual(verifyMiniAppInitData(query, TEST_BOT_TOKEN, { nowMs: VECTOR_NOW }), { ok: false, reason: "HASH_MISMATCH" });
});

// ── Freshness ───────────────────────────────────────────────────────────────

test("auth_date older than the window is refused; exactly the window is accepted", () => {
  const now = 1_800_000_000_000;
  const at = (ageSeconds: number) => signedInitData(launchFields(42, now - ageSeconds * 1000));
  assert.equal(verifyMiniAppInitData(at(300), TEST_BOT_TOKEN, { nowMs: now }).ok, true);
  assert.deepEqual(verifyMiniAppInitData(at(301), TEST_BOT_TOKEN, { nowMs: now }), { ok: false, reason: "STALE" });
  // The window is configurable, and the configured value is what applies.
  assert.deepEqual(verifyMiniAppInitData(at(120), TEST_BOT_TOKEN, { nowMs: now, maxAgeSeconds: 60 }), { ok: false, reason: "STALE" });
});

test("auth_date in the future is accepted only within 60 seconds of clock skew", () => {
  const now = 1_800_000_000_000;
  const ahead = (seconds: number) => signedInitData(launchFields(42, now + seconds * 1000));
  assert.equal(verifyMiniAppInitData(ahead(60), TEST_BOT_TOKEN, { nowMs: now }).ok, true);
  assert.deepEqual(verifyMiniAppInitData(ahead(61), TEST_BOT_TOKEN, { nowMs: now }), { ok: false, reason: "FUTURE" });
});

// ── The hash itself ─────────────────────────────────────────────────────────

test("the received hash must be exactly 64 lowercase hex characters", () => {
  const good = VECTOR_INIT_DATA;
  const variants: Record<string, string> = {
    uppercase: good.replace(VECTOR_HASH, VECTOR_HASH.toUpperCase()),
    "trailing nibble (65 chars)": good.replace(VECTOR_HASH, `${VECTOR_HASH}f`),
    "trailing junk after a full hash": good.replace(VECTOR_HASH, `${VECTOR_HASH}zz`),
    "short (63 chars)": good.replace(VECTOR_HASH, VECTOR_HASH.slice(0, 63)),
    "non-hex": good.replace(VECTOR_HASH, `${VECTOR_HASH.slice(0, 62)}zz`),
    empty: good.replace(`hash=${VECTOR_HASH}`, "hash="),
  };
  for (const [name, initData] of Object.entries(variants)) {
    const result = verifyMiniAppInitData(initData, VECTOR_TOKEN, { nowMs: VECTOR_NOW });
    assert.equal(result.ok, false, name);
    if (!result.ok) assert.equal(result.reason, "HASH_SHAPE", name);
  }
});

test("a missing hash is refused", () => {
  const without = VECTOR_INIT_DATA.replace(`&hash=${VECTOR_HASH}`, "");
  assert.deepEqual(verifyMiniAppInitData(without, VECTOR_TOKEN, { nowMs: VECTOR_NOW }), { ok: false, reason: "HASH_MISSING" });
});

// ── Shape ───────────────────────────────────────────────────────────────────

test("duplicate keys are refused rather than resolved first-wins or last-wins", () => {
  const dupUser = `${VECTOR_INIT_DATA}&user=%7B%22id%22%3A1%7D`;
  assert.deepEqual(verifyMiniAppInitData(dupUser, VECTOR_TOKEN, { nowMs: VECTOR_NOW }), { ok: false, reason: "DUPLICATE_KEY" });
  const dupHash = `${VECTOR_INIT_DATA}&hash=${VECTOR_HASH}`;
  assert.deepEqual(verifyMiniAppInitData(dupHash, VECTOR_TOKEN, { nowMs: VECTOR_NOW }), { ok: false, reason: "DUPLICATE_KEY" });
});

test("oversize input is refused before parsing", () => {
  const padded = signedInitData({ ...launchFields(42, VECTOR_NOW), padding: "x".repeat(INIT_DATA_MAX_BYTES) });
  assert.ok(Buffer.byteLength(padded) > INIT_DATA_MAX_BYTES);
  assert.deepEqual(verifyMiniAppInitData(padded, TEST_BOT_TOKEN, { nowMs: VECTOR_NOW }), { ok: false, reason: "TOO_LARGE" });
});

test("non-string input (an initDataUnsafe-shaped object, null, empty) is refused", () => {
  for (const value of [null, undefined, 42, {}, { user: { id: 1 }, auth_date: 1 }, [], ""]) {
    assert.deepEqual(verifyMiniAppInitData(value, TEST_BOT_TOKEN, { nowMs: VECTOR_NOW }), { ok: false, reason: "NOT_A_STRING" });
  }
});

test("user and auth_date are required, and auth_date must be a plain positive integer", () => {
  const now = 1_800_000_000_000;
  const base = launchFields(42, now);
  const { user: _user, ...noUser } = base;
  const { auth_date: _authDate, ...noAuthDate } = base;
  assert.deepEqual(verifyMiniAppInitData(signedInitData(noUser), TEST_BOT_TOKEN, { nowMs: now }), { ok: false, reason: "FIELDS_MISSING" });
  assert.deepEqual(verifyMiniAppInitData(signedInitData(noAuthDate), TEST_BOT_TOKEN, { nowMs: now }), { ok: false, reason: "FIELDS_MISSING" });
  for (const bad of ["abc", "-5", "1.5", "0", "1e9", " 1700000000", "99999999999999999999"]) {
    const result = verifyMiniAppInitData(signedInitData({ ...base, auth_date: bad }), TEST_BOT_TOKEN, { nowMs: now });
    assert.equal(result.ok, false, bad);
    if (!result.ok) assert.equal(result.reason, "AUTH_DATE_INVALID", bad);
  }
});

test("user.id must be a positive safe integer", () => {
  const now = 1_800_000_000_000;
  const cases: Array<[string, string]> = [
    ["string id", '{"id":"123456","first_name":"x"}'],
    ["negative (group-shaped) id", '{"id":-100123456,"first_name":"x"}'],
    ["zero", '{"id":0,"first_name":"x"}'],
    ["float", '{"id":1.5,"first_name":"x"}'],
    ["beyond 2^53", '{"id":9007199254740993,"first_name":"x"}'],
    ["missing id", '{"first_name":"x"}'],
    ["not an object", "[1,2]"],
    ["not JSON", "not-json"],
    ["null", "null"],
  ];
  for (const [name, user] of cases) {
    const result = verifyMiniAppInitData(signedInitData({ ...launchFields(42, now), user }), TEST_BOT_TOKEN, { nowMs: now });
    assert.deepEqual(result, { ok: false, reason: "USER_INVALID" }, name);
  }
  assert.equal(verifyMiniAppInitData(signedInitData({ ...launchFields(42, now), user: userField(7) }), TEST_BOT_TOKEN, { nowMs: now }).ok, true);
});

// ── Canonicalisation ────────────────────────────────────────────────────────

test("fields are sorted by code unit, not by locale", () => {
  // localeCompare puts "a" before "B"; code-unit order puts "B" (0x42) before "a" (0x61).
  const now = 1_800_000_000_000;
  const fields = { ...launchFields(42, now), B_upper: "1", a_lower: "2", _under: "3" };
  assert.equal(verifyMiniAppInitData(signedInitData(fields), TEST_BOT_TOKEN, { nowMs: now }).ok, true);
});

test("re-encoding the same fields yields the same replay key", () => {
  const now = 1_800_000_000_000;
  const fields = launchFields(42, now, { start_param: "trip_abcdefgh12" });
  const canonical = signedInitData(fields);
  // Same decoded values spelled differently: lower-case percent escapes, "%20"
  // for the space URLSearchParams writes as "+", a different field order.
  const pairs = canonical.split("&").reverse().map((pair) => pair.replace(/%[0-9A-F]{2}/g, (m) => m.toLowerCase()).replaceAll("+", "%20"));
  const respelled = pairs.join("&");
  assert.notEqual(respelled, canonical);
  const a = verifyMiniAppInitData(canonical, TEST_BOT_TOKEN, { nowMs: now });
  const b = verifyMiniAppInitData(respelled, TEST_BOT_TOKEN, { nowMs: now });
  assert.equal(a.ok && b.ok, true);
  if (a.ok && b.ok) assert.equal(a.data.replayKey, b.data.replayKey);
});

test("chat_type and start_param are returned only as Telegram signed them", () => {
  const now = 1_800_000_000_000;
  const result = verifyMiniAppInitData(signedInitData(launchFields(42, now, { chat_type: "supergroup", start_param: "trip_abcdefgh12" })), TEST_BOT_TOKEN, { nowMs: now });
  assert.equal(result.ok && result.data.chatType, "supergroup");
  assert.equal(result.ok && result.data.startParam, "trip_abcdefgh12");
  // An unsigned start_param appended afterwards changes the data-check-string.
  const tampered = `${signedInitData(launchFields(42, now))}&start_param=trip_evilevil99`;
  assert.deepEqual(verifyMiniAppInitData(tampered, TEST_BOT_TOKEN, { nowMs: now }), { ok: false, reason: "HASH_MISMATCH" });
});
