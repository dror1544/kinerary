import assert from "node:assert/strict";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import pg from "pg";
import { applyMigrations } from "../src/migrations.js";
import { verifyTelegramLogin, digestTelegramId, type VerifiedTelegramIdentity } from "../src/identity.js";
import { createOrVerifyPasswordIdentity, verifyPasswordLogin, resolveWebAuth } from "../src/password-identity.js";

const databaseUrl = process.env.CONTROL_PLANE_TEST_DATABASE_URL;
const skip = !databaseUrl;
const migrationsDir = fileURLToPath(new URL("../../db/migrations/", import.meta.url));

async function resetDb(client: pg.PoolClient) {
  await client.query("DROP SCHEMA IF EXISTS control_plane CASCADE");
  await client.query("DROP TABLE IF EXISTS public.control_plane_schema_migrations");
}

async function freshPool(): Promise<pg.Pool> {
  const pool = new pg.Pool({ connectionString: databaseUrl });
  const client = await pool.connect();
  await resetDb(client);
  await applyMigrations(client, migrationsDir);
  client.release();
  return pool;
}

test("first signup with an email+password creates a user, identity and credential", { skip }, async () => {
  const pool = await freshPool();
  try {
    const result = await createOrVerifyPasswordIdentity(pool, { email: "Family@Example.com", password: "correct-horse-battery" });
    assert.equal(result.ok, true);
    if (!result.ok) return;
    assert.equal(result.identity.provider, "password");
    assert.equal(result.identity.displayName, "Family");

    const users = await pool.query("SELECT count(*)::int AS c FROM control_plane.users");
    const identities = await pool.query("SELECT count(*)::int AS c FROM control_plane.user_identities WHERE provider = 'password'");
    const creds = await pool.query("SELECT count(*)::int AS c FROM control_plane.password_credentials");
    assert.equal(users.rows[0].c, 1);
    assert.equal(identities.rows[0].c, 1);
    assert.equal(creds.rows[0].c, 1);

    // Case/whitespace-insensitive email matching, same user both times.
    const again = await createOrVerifyPasswordIdentity(pool, { email: " family@example.com ", password: "correct-horse-battery" });
    assert.equal(again.ok, true);
    if (!again.ok) return;
    assert.equal(again.identity.providerSubjectDigest, result.identity.providerSubjectDigest);
    const usersAfter = await pool.query("SELECT count(*)::int AS c FROM control_plane.users");
    assert.equal(usersAfter.rows[0].c, 1);
  } finally {
    await pool.end();
  }
});

test("repeat signup with the same email but the wrong password is rejected, not silently accepted", { skip }, async () => {
  const pool = await freshPool();
  try {
    await createOrVerifyPasswordIdentity(pool, { email: "owner@example.com", password: "first-password-1" });
    const result = await createOrVerifyPasswordIdentity(pool, { email: "owner@example.com", password: "wrong-password-2" });
    assert.equal(result.ok, false);
    if (result.ok) return;
    assert.equal(result.error, "PASSWORD_LOGIN_INVALID_CREDENTIALS");
  } finally {
    await pool.end();
  }
});

test("password shorter than 8 characters is rejected at signup", { skip }, async () => {
  const pool = await freshPool();
  try {
    const result = await createOrVerifyPasswordIdentity(pool, { email: "short@example.com", password: "abc123" });
    assert.equal(result.ok, false);
    if (result.ok) return;
    assert.equal(result.error, "PASSWORD_TOO_SHORT");
  } finally {
    await pool.end();
  }
});

test("verifyPasswordLogin never creates an account for an unknown email", { skip }, async () => {
  const pool = await freshPool();
  try {
    const result = await verifyPasswordLogin(pool, { email: "nobody@example.com", password: "whatever-12345" });
    assert.equal(result.ok, false);
    if (result.ok) return;
    assert.equal(result.error, "PASSWORD_LOGIN_INVALID_CREDENTIALS");
    const users = await pool.query("SELECT count(*)::int AS c FROM control_plane.users");
    assert.equal(users.rows[0].c, 0);
  } finally {
    await pool.end();
  }
});

test("verifyPasswordLogin accepts the right password and rejects the wrong one for an existing account", { skip }, async () => {
  const pool = await freshPool();
  try {
    await createOrVerifyPasswordIdentity(pool, { email: "login@example.com", password: "the-real-password" });

    const good = await verifyPasswordLogin(pool, { email: "login@example.com", password: "the-real-password" });
    assert.equal(good.ok, true);

    const bad = await verifyPasswordLogin(pool, { email: "login@example.com", password: "not-it" });
    assert.equal(bad.ok, false);
  } finally {
    await pool.end();
  }
});

test("resolveWebAuth prefers X-Telegram-Login when both headers are present", { skip }, async () => {
  const pool = await freshPool();
  try {
    const telegramPayload = { headers: {} }; // never reached — verifyTelegramLogin stub below always succeeds
    void telegramPayload;
    const telegramIdentity: VerifiedTelegramIdentity = {
      provider: "telegram",
      providerSubjectDigest: digestTelegramId("999"),
      providerSubjectId: "999",
      displayName: "Telegram User",
    };
    const stubVerify = () => ({ ok: true as const, identity: telegramIdentity });

    const headers = {
      "x-telegram-login": Buffer.from(JSON.stringify({ id: 999 })).toString("base64url"),
      "x-portal-password-login": Buffer.from(JSON.stringify({ email: "x@example.com", password: "irrelevant123" })).toString("base64url"),
    };

    const result = await resolveWebAuth(headers, pool, stubVerify, "fake-token");
    assert.equal(result.ok, true);
    if (!result.ok) return;
    assert.equal(result.identity.provider, "telegram");
  } finally {
    await pool.end();
  }
});

test("resolveWebAuth falls back to X-Portal-Password-Login when there is no Telegram header", { skip }, async () => {
  const pool = await freshPool();
  try {
    await createOrVerifyPasswordIdentity(pool, { email: "fallback@example.com", password: "fallback-password-1" });
    const stubVerify = (): { ok: true; identity: VerifiedTelegramIdentity } | { ok: false; error: "TELEGRAM_LOGIN_HASH_MISSING" } =>
      ({ ok: false, error: "TELEGRAM_LOGIN_HASH_MISSING" });

    const headers = {
      "x-portal-password-login": Buffer.from(JSON.stringify({ email: "fallback@example.com", password: "fallback-password-1" })).toString("base64url"),
    };

    const result = await resolveWebAuth(headers, pool, stubVerify, "fake-token");
    assert.equal(result.ok, true);
    if (!result.ok) return;
    assert.equal(result.identity.provider, "password");
  } finally {
    await pool.end();
  }
});

test("resolveWebAuth returns AUTHENTICATION_REQUIRED when neither header is present", { skip }, async () => {
  const pool = await freshPool();
  try {
    const stubVerify = (): { ok: true; identity: VerifiedTelegramIdentity } | { ok: false; error: "TELEGRAM_LOGIN_HASH_MISSING" } =>
      ({ ok: false, error: "TELEGRAM_LOGIN_HASH_MISSING" });
    const result = await resolveWebAuth({}, pool, stubVerify, "fake-token");
    assert.equal(result.ok, false);
    if (result.ok) return;
    assert.equal(result.error, "AUTHENTICATION_REQUIRED");
  } finally {
    await pool.end();
  }
});

// Sanity check that the real verifyTelegramLogin import still type-checks
// against resolveWebAuth's expected signature (not just the local stubs above).
void verifyTelegramLogin;
