/**
 * AC-11 (#438): the interview greets the organizer by the name they gave the product, so every way into an
 * account has to ask for it or take it from Google -- and the route that stores it must store it for the caller's
 * own account, cleaned, and nothing else.
 *
 *   - a password sign-up (email-verified) asks for a name on its page and stores it;
 *   - a Google sign-in stores the name in the token Google signed, never the email's local part;
 *   - an account with no name is asked once on the dashboard (`GET /v1/me` -> `needsName`), answers or says
 *     "not now" through `POST /v1/account/name`, and is not asked again.
 *
 * DB-backed and offline, like google-id-token-db.test.ts: Google tokens are signed here with a local RSA key.
 */
import assert from "node:assert/strict";
import { createSign, generateKeyPairSync, randomBytes } from "node:crypto";
import { after, before, test } from "node:test";
import { fileURLToPath } from "node:url";
import { OAuth2Client } from "google-auth-library";
import pg from "pg";
import { buildApp } from "../src/app.js";
import { validateArchitectureProfile } from "../src/config.js";
import { LogMailer } from "../src/mailer.js";
import { applyMigrations } from "../src/migrations.js";
import { GoogleIdTokenClient, sha256, type PortalDependencies } from "../src/portal.js";
import { portalMailIdle } from "../src/portal-email-auth.js";
import { PORTAL_SCOPE_POLICY, scopedSessionDigest } from "../src/portal-scope.js";
import { testDatabaseUrl, testPool } from "./support/test-database.js";

const skip = !testDatabaseUrl();
const migrationsDir = fileURLToPath(new URL("../../db/migrations/", import.meta.url));
const ORIGIN = "http://portal.example.test";
const CLIENT_ID = "123456789012-givenname.apps.googleusercontent.com";
const suffix = `${Date.now().toString(36)}${randomBytes(3).toString("hex")}`;
let counter = 0;
const gmail = (label: string) => `${label}-${suffix}-${++counter}@gmail.com`;
const PASSWORD = "correct horse battery";

const KID = "given-name-key";
const signingKey = generateKeyPairSync("rsa", { modulusLength: 2048 });
const b64 = (value: unknown) => Buffer.from(JSON.stringify(value)).toString("base64url");
function idToken(claims: Record<string, unknown>): string {
  const now = Math.floor(Date.now() / 1000);
  const payload = {
    iss: "https://accounts.google.com", aud: CLIENT_ID, azp: CLIENT_ID, email_verified: true, iat: now - 5, exp: now + 3600, ...claims,
  };
  const signed = `${b64({ alg: "RS256", kid: KID, typ: "JWT" })}.${b64(payload)}`;
  return `${signed}.${createSign("RSA-SHA256").update(signed).sign(signingKey.privateKey).toString("base64url")}`;
}
function stubbedOAuthClient(): OAuth2Client {
  const client = new OAuth2Client(CLIENT_ID);
  (client as unknown as { getFederatedSignonCertsAsync: () => Promise<unknown> }).getFederatedSignonCertsAsync =
    async () => ({ certs: { [KID]: signingKey.publicKey.export({ type: "spki", format: "pem" }).toString() }, res: undefined });
  return client;
}

let pool: pg.Pool;
const profile = validateArchitectureProfile({
  version: 1, environment: "test", public_api: { bind_host: "127.0.0.1", port: 4310 },
  worker: { queue: "postgres", health_bind_host: "127.0.0.1", health_port: 4311 },
  database: { connection_secret_ref: "env://CONTROL_PLANE_DATABASE_URL" },
  adapters: { compute: "fake", ingress: "fake", agent_runtime: "fake", messaging: "fake", secrets: "fake" },
  test_resources: { enabled: false },
});

function harness() {
  const mailer = new LogMailer({ log: () => {} });
  const portal: PortalDependencies = {
    db: pool,
    google: new GoogleIdTokenClient(CLIENT_ID, stubbedOAuthClient()),
    runtimeAccounts: { participantExists: async () => true, provisionParticipant: async () => {} },
    publicOrigin: ORIGIN, runtimeOrigin: "http://runtime.example.test", runtimeExchangeKey: "exchange-key",
    runtimeUpstreamHostSuffixes: ["internal"], telegramBotUsername: "kinerary_bot", sessionTtlSeconds: 3600,
    enrollmentTtlSeconds: 3600, approvalTtlSeconds: 3600, mailer, emailAuthLog: () => {},
  };
  return { app: buildApp(profile, { portal }), mailer };
}
type App = ReturnType<typeof harness>["app"];

before(async () => {
  if (skip) return;
  pool = testPool({ max: 6 });
  const client = await pool.connect();
  try {
    await client.query("DROP SCHEMA IF EXISTS control_plane CASCADE");
    await client.query("DROP TABLE IF EXISTS public.control_plane_schema_migrations");
    await applyMigrations(client, migrationsDir);
  } finally { client.release(); }
});
after(async () => { if (!skip) await pool.end(); });

const post = (app: App, url: string, payload: unknown, headers: Record<string, string> = {}) => app.inject({
  method: "POST", url, payload: JSON.stringify(payload), headers: { "content-type": "application/json", origin: ORIGIN, ...headers },
});
const cookiesOf = (response: { headers: Record<string, unknown> }) => {
  const set = ([] as string[]).concat((response.headers["set-cookie"] as string[] | string | undefined) ?? []);
  const pick = (name: string) => {
    const hit = set.find((c) => c.startsWith(`${name}=`));
    return hit ? decodeURIComponent(hit.split(";")[0]!.slice(name.length + 1)) : undefined;
  };
  const session = pick("kit_session"), csrf = pick("kit_csrf");
  return session && csrf ? { cookie: `kit_session=${session}; kit_csrf=${csrf}`, csrf } : undefined;
};
const me = (app: App, cookie: string) => app.inject({ method: "GET", url: "/v1/me", headers: { cookie } });
const givenName = async (userId: string) =>
  (await pool.query("SELECT given_name, display_name FROM control_plane.users WHERE id = $1", [userId])).rows[0] as { given_name: string | null; display_name: string };

async function googleSignIn(app: App, claims: Record<string, unknown>) {
  const nonce = await app.inject({ method: "GET", url: "/v1/auth/google/nonce" });
  const cookie = ([] as string[]).concat(nonce.headers["set-cookie"] as string[]).find((l) => l.startsWith("kit_gnonce="))!.split(";")[0]!;
  const credential = idToken({ nonce: nonce.json().nonce, ...claims });
  return app.inject({
    method: "POST", url: "/v1/auth/google", payload: JSON.stringify({ credential }),
    headers: { "content-type": "application/json", origin: ORIGIN, cookie },
  });
}

/** An account made another way (an invitation, a Telegram signup): a display name that is a label, and no name of its own. */
async function unnamedAccount(label: string) {
  const userId = `user_${randomBytes(16).toString("hex")}`;
  await pool.query("INSERT INTO control_plane.users(id, status, display_name) VALUES ($1, 'active', $2)", [userId, `${label}.local+part`]);
  const raw = `session-${userId}`, csrf = `csrf-${userId}`;
  await pool.query(
    `INSERT INTO control_plane.web_sessions(id, user_id, token_digest, csrf_digest, expires_at) VALUES ($1, $2, $3, $4, now() + interval '1 hour')`,
    [`wsess_${randomBytes(8).toString("hex")}`, userId, sha256(raw), sha256(csrf)]);
  return { userId, cookie: `kit_session=${raw}; kit_csrf=${csrf}`, csrf };
}

test("AC-11 a password sign-up asks for a name on its page and stores it as the account's given name", { skip }, async () => {
  const { app, mailer } = harness();
  try {
    const email = `signup-${suffix}@mail.example.test`;
    assert.equal((await post(app, "/v1/auth/sign-up", { email })).statusCode, 202);
    await portalMailIdle();
    const mail = [...mailer.outbox].reverse().find((m) => m.to === email)!;
    const token = mail.text.match(/#token=(ev_[A-Za-z0-9_-]{43})/)![1]!;

    // The name is required: a request without one is refused before the token is touched.
    assert.deepEqual((await post(app, "/v1/auth/verify-email", { token, password: PASSWORD })).json(), { error: "INVALID_NAME" });
    const verified = await post(app, "/v1/auth/verify-email", { token, password: PASSWORD, displayName: "  Dana   Levi " });
    assert.equal(verified.statusCode, 200, verified.body);
    const session = cookiesOf(verified)!;
    const who = (await me(app, session.cookie)).json();
    assert.equal((await givenName(who.id)).given_name, "Dana Levi", "cleaned, and stored as the name they gave");
    assert.equal(who.needsName, undefined, "someone who has just given their name is not asked again");
  } finally { await app.close(); }
});

test("AC-11 a Google sign-in stores the name Google signed -- given_name first, then name -- never the email's local part", { skip }, async () => {
  const { app } = harness();
  try {
    const first = await googleSignIn(app, { sub: `g-a-${suffix}`, email: gmail("ga"), given_name: "Gina", name: "Gina Googler" });
    assert.equal(first.statusCode, 200, first.body);
    const a = (await me(app, cookiesOf(first)!.cookie)).json();
    assert.equal((await givenName(a.id)).given_name, "Gina");
    assert.equal(a.needsName, undefined);

    const second = await googleSignIn(app, { sub: `g-b-${suffix}`, email: gmail("gb"), name: "Gil Googler" });
    const b = (await me(app, cookiesOf(second)!.cookie)).json();
    assert.equal((await givenName(b.id)).given_name, "Gil Googler", "no given_name claim: the name claim");

    const third = await googleSignIn(app, { sub: `g-c-${suffix}`, email: gmail("gc") });
    assert.equal(third.statusCode, 200, third.body);
    const c = (await me(app, cookiesOf(third)!.cookie)).json();
    const row = await givenName(c.id);
    assert.equal(row.given_name, null, "Google sent no name: the local part of the address is not a name");
    assert.equal(c.needsName, true, "so the dashboard asks");
  } finally { await app.close(); }
});

test("AC-11 a Google sign-in never overwrites the name the account already has", { skip }, async () => {
  const { app } = harness();
  try {
    const email = gmail("keep");
    const first = await googleSignIn(app, { sub: `g-k-${suffix}`, email, given_name: "Kim" });
    const user = (await me(app, cookiesOf(first)!.cookie)).json();
    await pool.query("UPDATE control_plane.users SET given_name = 'Kimberly' WHERE id = $1", [user.id]);
    const again = await googleSignIn(app, { sub: `g-k-${suffix}`, email, given_name: "Kim" });
    assert.equal(again.statusCode, 200, again.body);
    assert.equal((await givenName(user.id)).given_name, "Kimberly");
  } finally { await app.close(); }
});

test("AC-11 an existing account with no name is asked once: it answers, or says not now, and is not asked again", { skip }, async () => {
  const { app } = harness();
  try {
    const answering = await unnamedAccount("answers");
    assert.equal((await me(app, answering.cookie)).json().needsName, true, "asked on its next visit");
    const stored = await post(app, "/v1/account/name", { displayName: "Dana" }, { cookie: answering.cookie, "x-csrf-token": answering.csrf });
    assert.equal(stored.statusCode, 200, stored.body);
    assert.equal((await givenName(answering.userId)).given_name, "Dana");
    assert.equal((await me(app, answering.cookie)).json().needsName, undefined);

    const declining = await unnamedAccount("declines");
    const dismissed = await post(app, "/v1/account/name", { dismiss: true }, { cookie: declining.cookie, "x-csrf-token": declining.csrf });
    assert.equal(dismissed.statusCode, 200, dismissed.body);
    assert.equal((await givenName(declining.userId)).given_name, null, "not now stores no name");
    assert.equal((await me(app, declining.cookie)).json().needsName, undefined, "and is not asked again");
  } finally { await app.close(); }
});

test("AC-11 security: the name is stored for the caller's own account only, from exactly the allow-listed fields", { skip }, async () => {
  const { app } = harness();
  try {
    const caller = await unnamedAccount("caller");
    const victim = await unnamedAccount("victim");
    const headers = { cookie: caller.cookie, "x-csrf-token": caller.csrf };

    // A body naming another account, or carrying any field beyond the two shapes, is refused and writes nothing.
    for (const body of [
      { displayName: "Mallory", userId: victim.userId },
      { displayName: "Mallory", user_id: victim.userId },
      { displayName: "Mallory", givenName: "x" },
      { displayName: "Mallory", dismiss: true },
      { dismiss: true, id: victim.userId },
      { dismiss: "yes" },
      { userId: victim.userId },
      {},
    ]) {
      const refused = await post(app, "/v1/account/name", body, headers);
      assert.equal(refused.statusCode, 400, JSON.stringify(body));
      assert.deepEqual(refused.json(), { error: "INVALID_REQUEST" });
    }
    assert.equal((await givenName(victim.userId)).given_name, null, "nobody else's account was touched");
    assert.equal((await givenName(caller.userId)).given_name, null, "and a refused request wrote nothing to the caller's either");

    // A name that cannot be stored is refused, not clipped; control and bidi characters are cleaned, not kept.
    assert.deepEqual((await post(app, "/v1/account/name", { displayName: "x".repeat(81) }, headers)).json(), { error: "INVALID_NAME" });
    assert.deepEqual((await post(app, "/v1/account/name", { displayName: "   " }, headers)).json(), { error: "INVALID_NAME" });
    assert.deepEqual((await post(app, "/v1/account/name", { displayName: 42 }, headers)).json(), { error: "INVALID_NAME" });
    const ok = await post(app, "/v1/account/name", { displayName: "Dana‮\n\u0000Levi" }, headers);
    assert.equal(ok.statusCode, 200, ok.body);
    assert.equal((await givenName(caller.userId)).given_name, "Dana Levi");
    assert.equal((await givenName(victim.userId)).given_name, null);

    // Not signed in, no CSRF token, another origin: refused as every other portal mutation is.
    assert.equal((await post(app, "/v1/account/name", { displayName: "Eve" })).statusCode, 401);
    assert.equal((await post(app, "/v1/account/name", { displayName: "Eve" }, { cookie: caller.cookie })).statusCode, 403);
    assert.equal((await post(app, "/v1/account/name", { displayName: "Eve" }, { ...headers, origin: "http://evil.example.test" })).statusCode, 403);
    assert.equal((await givenName(caller.userId)).given_name, "Dana Levi");
  } finally { await app.close(); }
});

test("AC-11 security: a Telegram-minted (scoped) session cannot rename the account, and is not asked to", { skip }, async () => {
  const { app } = harness();
  try {
    const account = await unnamedAccount("scoped");
    const raw = `scoped-${account.userId}`, csrf = `scopedcsrf-${account.userId}`;
    await pool.query(
      `INSERT INTO control_plane.web_sessions(id, user_id, token_digest, csrf_digest, expires_at) VALUES ($1, $2, $3, $4, now() + interval '1 hour')`,
      [`wsess_${randomBytes(8).toString("hex")}`, account.userId, scopedSessionDigest(raw), sha256(csrf)]);
    const cookie = `kit_session=${raw}; kit_csrf=${csrf}`;
    const refused = await post(app, "/v1/account/name", { displayName: "Eve" }, { cookie, "x-csrf-token": csrf });
    assert.equal(refused.statusCode, 403, refused.body);
    assert.equal((await givenName(account.userId)).given_name, null);
    const who = (await me(app, cookie)).json();
    assert.equal(who.scope, "telegram");
    assert.equal(who.needsName, undefined, "a session that cannot answer is not asked");
    assert.equal(PORTAL_SCOPE_POLICY["POST /v1/account/name"], "account");
  } finally { await app.close(); }
});
