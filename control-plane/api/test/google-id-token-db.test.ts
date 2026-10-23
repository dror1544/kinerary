/**
 * POST /v1/auth/google: "Sign in with Google" by Google Identity Services ID token (owner decision 2026-10-23;
 * no client secret, no redirect). DB-backed, and offline: tokens are signed here with a local RSA key and the
 * library's certificate fetch is replaced by that key's public half, so everything else is the real thing:
 * the library's signature, audience, issuer and expiry checks, the route, the account functions, the sessions.
 */
import assert from "node:assert/strict";
import { createSign, generateKeyPairSync, randomBytes } from "node:crypto";
import { readFile } from "node:fs/promises";
import { after, before, test } from "node:test";
import { fileURLToPath } from "node:url";
import { OAuth2Client } from "google-auth-library";
import pg from "pg";
import { buildApp } from "../src/app.js";
import { validateArchitectureProfile } from "../src/config.js";
import { applyMigrations } from "../src/migrations.js";
import { createOrVerifyPasswordIdentity, digestEmail } from "../src/password-identity.js";
import { GoogleIdTokenClient, sha256, type PortalDependencies } from "../src/portal.js";
import { PORTAL_SCOPE_POLICY } from "../src/portal-scope.js";
import { testDatabaseUrl, testPool } from "./support/test-database.js";

const skip = !testDatabaseUrl();
const migrationsDir = fileURLToPath(new URL("../../db/migrations/", import.meta.url));
const ORIGIN = "http://portal.example.test";
const CLIENT_ID = "123456789012-testclient.apps.googleusercontent.com";
const suffix = `${Date.now().toString(36)}${randomBytes(3).toString("hex")}`;
let counter = 0;
const addr = (label: string) => `${label}-${suffix}-${++counter}@mail.example.test`;

const KID = "test-key-1";
const signingKey = generateKeyPairSync("rsa", { modulusLength: 2048 });
const otherKey = generateKeyPairSync("rsa", { modulusLength: 2048 });
const pem = (key: ReturnType<typeof generateKeyPairSync>["publicKey"]) => key.export({ type: "spki", format: "pem" }).toString();

const b64 = (value: unknown) => Buffer.from(JSON.stringify(value)).toString("base64url");
/** A Google-shaped ID token signed with `key` (default: the one the stubbed certs serve). */
function idToken(claims: Record<string, unknown> = {}, key: { privateKey: ReturnType<typeof generateKeyPairSync>["privateKey"] } = signingKey): string {
  const now = Math.floor(Date.now() / 1000);
  const payload = {
    iss: "https://accounts.google.com", aud: CLIENT_ID, azp: CLIENT_ID, sub: `g-sub-${suffix}`, email: "who@mail.example.test",
    email_verified: true, name: "Gina Googler", iat: now - 5, exp: now + 3600, ...claims,
  };
  const signed = `${b64({ alg: "RS256", kid: KID, typ: "JWT" })}.${b64(payload)}`;
  return `${signed}.${createSign("RSA-SHA256").update(signed).sign(key.privateKey).toString("base64url")}`;
}

/** The real OAuth2Client with only the network fetch of Google's certificates replaced. */
function stubbedOAuthClient(): OAuth2Client {
  const client = new OAuth2Client(CLIENT_ID);
  (client as unknown as { getFederatedSignonCertsAsync: () => Promise<unknown> }).getFederatedSignonCertsAsync =
    async () => ({ certs: { [KID]: pem(signingKey.publicKey) }, res: undefined });
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
  const logs: string[] = [];
  const portal: PortalDependencies = {
    db: pool,
    google: new GoogleIdTokenClient(CLIENT_ID, stubbedOAuthClient()),
    runtimeAccounts: { participantExists: async () => true, provisionParticipant: async () => {} },
    publicOrigin: ORIGIN, runtimeOrigin: "http://runtime.example.test", runtimeExchangeKey: "exchange-key",
    runtimeUpstreamHostSuffixes: ["internal"], telegramBotUsername: "kinerary_bot", sessionTtlSeconds: 3600,
    enrollmentTtlSeconds: 3600, approvalTtlSeconds: 3600, emailAuthLog: (line) => logs.push(line),
  };
  return { app: buildApp(profile, { portal }), logs };
}
type App = ReturnType<typeof harness>["app"];

const google = (app: App, body: unknown, headers: Record<string, string> = { origin: ORIGIN }) => app.inject({
  method: "POST", url: "/v1/auth/google", payload: JSON.stringify(body), headers: { "content-type": "application/json", ...headers },
});
const cookieOf = (response: { headers: Record<string, unknown> }) => {
  const set = ([] as string[]).concat((response.headers["set-cookie"] as string[] | string | undefined) ?? []);
  const pick = (name: string) => set.find((c) => c.startsWith(`${name}=`))?.split(";")[0]!.slice(name.length + 1);
  const session = pick("kit_session"), csrf = pick("kit_csrf");
  return session && csrf ? { cookie: `kit_session=${session}; kit_csrf=${csrf}`, set } : undefined;
};
const me = (app: App, cookie: string) => app.inject({ method: "GET", url: "/v1/me", headers: { cookie } });
const accountsFor = async (email: string) =>
  (await pool.query("SELECT user_id FROM control_plane.user_identities WHERE provider = 'password' AND provider_subject_digest = $1", [digestEmail(email)])).rows as { user_id: string }[];
const googleRows = async (sub: string) =>
  (await pool.query("SELECT user_id FROM control_plane.user_identities WHERE provider = 'google' AND provider_subject_digest = $1", [sha256(`google:${sub}`)])).rows as { user_id: string }[];

before(async () => {
  if (skip) return;
  pool = testPool({ max: 6 });
  const client = await pool.connect();
  try { await applyMigrations(client, migrationsDir); } finally { client.release(); }
});
after(async () => { if (!skip) await pool.end(); });

test("a valid token creates the account and a session, and the second sign-in reuses both the account and the identity", { skip }, async () => {
  const { app, logs } = harness();
  try {
    const email = addr("new"), sub = `g-new-${suffix}`;
    const first = await google(app, { credential: idToken({ email, sub }), returnTo: "/trips/new" });
    assert.equal(first.statusCode, 200, first.body);
    assert.deepEqual(first.json(), { appPath: "/trips/new" });
    assert.equal(first.headers["cache-control"], "private, no-store");
    const session = cookieOf(first)!;
    assert.ok(session, "session and csrf cookies, as for email-password");
    assert.ok(session.set.every((c) => /HttpOnly|Path=\//.test(c) && /SameSite=Lax/.test(c)), "the ordinary Lax variant");
    const who = (await me(app, session.cookie)).json();
    assert.equal(who.displayName, "Gina Googler");
    assert.equal(who.scope, "full");

    // The account is the canonical one for the address, holds the unknown credential, and has the Google identity.
    const accounts = await accountsFor(email);
    assert.equal(accounts.length, 1);
    assert.equal(accounts[0]!.user_id, who.id);
    assert.equal((await pool.query("SELECT 1 FROM control_plane.password_credentials WHERE user_id = $1 AND email_digest = $2", [who.id, digestEmail(email)])).rowCount, 1, "a credential nobody knows");
    assert.deepEqual((await googleRows(sub)).map((r) => r.user_id), [who.id]);
    assert.equal((await pool.query("SELECT status FROM control_plane.users WHERE id = $1", [who.id])).rows[0].status, "active");

    const again = await google(app, { credential: idToken({ email, sub }) });
    assert.equal(again.statusCode, 200);
    assert.deepEqual(again.json(), { appPath: "/trips" }, "no returnTo: the default");
    assert.equal((await me(app, cookieOf(again)!.cookie)).json().id, who.id, "the same account");
    assert.equal((await googleRows(sub)).length, 1, "one identity row, not two");
    assert.equal((await accountsFor(email)).length, 1);
    assert.deepEqual(logs, [], "a success logs nothing about the person");
  } finally { await app.close(); }
});

test("an existing password account is linked, not duplicated, and its password keeps working", { skip }, async () => {
  const { app } = harness();
  try {
    const email = addr("pw"), sub = `g-pw-${suffix}`, password = "existing-organizer-secret";
    const seeded = await createOrVerifyPasswordIdentity(pool, { email, password });
    assert.ok(seeded.ok);
    const owner = seeded.identity.providerSubjectId;
    const before = (await pool.query("SELECT count(*)::int AS n FROM control_plane.users")).rows[0].n as number;

    const response = await google(app, { credential: idToken({ email: email.toUpperCase(), sub }) });
    assert.equal(response.statusCode, 200, response.body);
    assert.equal((await me(app, cookieOf(response)!.cookie)).json().id, owner, "one address, one user_id");
    assert.deepEqual((await googleRows(sub)).map((r) => r.user_id), [owner], "the Google identity is attached to the existing account");
    assert.equal((await pool.query("SELECT count(*)::int AS n FROM control_plane.users")).rows[0].n, before, "no second user");
    assert.equal((await accountsFor(email)).length, 1);
    const stillThere = await app.inject({ method: "POST", url: "/v1/auth/email-password", headers: { origin: ORIGIN }, payload: { email, password } });
    assert.equal(stillThere.statusCode, 200, "the password credential was not replaced");
  } finally { await app.close(); }
});

test("email_verified false (or missing) is refused, and creates nothing", { skip }, async () => {
  const { app } = harness();
  try {
    for (const claims of [{ email_verified: false }, { email_verified: undefined }, { email_verified: "true" }, { email: undefined }]) {
      const email = addr("unverified"), sub = `g-unv-${suffix}-${++counter}`;
      const response = await google(app, { credential: idToken({ email, sub, ...claims }) });
      assert.equal(response.statusCode, 401, JSON.stringify(claims));
      assert.deepEqual(response.json(), { error: "GOOGLE_SIGN_IN_FAILED" });
      assert.equal(cookieOf(response), undefined, "no session");
      assert.equal((await accountsFor(email)).length, 0, "no account");
      assert.equal((await googleRows(sub)).length, 0, "no identity");
    }
  } finally { await app.close(); }
});

test("wrong audience, wrong issuer, expired, bad signature, wrong key, unknown kid and garbage all get the SAME 401", { skip }, async () => {
  const { app, logs } = harness();
  try {
    const now = Math.floor(Date.now() / 1000);
    const forgedHeader = `${b64({ alg: "RS256", kid: "other-kid", typ: "JWT" })}.${idToken().split(".")[1]}.sig`;
    const tampered = (() => { const [h, , s] = idToken().split("."); return `${h}.${b64({ iss: "https://accounts.google.com", aud: CLIENT_ID, sub: "x", email: "tamper@mail.example.test", email_verified: true, iat: now, exp: now + 600 })}.${s}`; })();
    const cases: Record<string, string> = {
      "wrong audience": idToken({ aud: "999999999999-someoneelse.apps.googleusercontent.com" }),
      "wrong issuer": idToken({ iss: "https://accounts.evil.example.test" }),
      "expired": idToken({ iat: now - 7200, exp: now - 3600 }),
      "not yet valid": idToken({ iat: now + 3600, exp: now + 7200 }),
      "signed by another key": idToken({}, otherKey),
      "payload altered after signing": tampered,
      "unknown kid": forgedHeader,
      "not a JWT": "garbage",
      "two segments": "aaa.bbb",
      "undecodable segments": "!!!.???.***",
    };
    const bodies = new Set<string>();
    for (const [name, credential] of Object.entries(cases)) {
      const response = await google(app, { credential });
      assert.equal(response.statusCode, 401, name);
      bodies.add(response.body);
      assert.equal(cookieOf(response), undefined, name);
    }
    for (const body of [{}, { credential: "" }, { credential: 5 }, { credential: "x".repeat(9000) }, null]) {
      const response = await google(app, body);
      assert.equal(response.statusCode, 401, JSON.stringify(body)?.slice(0, 40));
      bodies.add(response.body);
    }
    assert.deepEqual([...bodies], ['{"error":"GOOGLE_SIGN_IN_FAILED"}'], "one answer, whatever was wrong");
    assert.equal((await pool.query("SELECT 1 FROM control_plane.user_identities WHERE provider = 'google' AND provider_subject_digest = $1", [sha256("google:x")])).rowCount, 0);
    // The log has the REASON CODE of each, and nothing of the token or the address.
    const reasons = logs.map((line) => JSON.parse(line).reason);
    for (const code of ["AUDIENCE_MISMATCH", "ISSUER_MISMATCH", "TOKEN_EXPIRED", "SIGNATURE_INVALID", "TOKEN_MALFORMED", "CREDENTIAL_MISSING"]) {
      assert.ok(reasons.includes(code), `${code} was logged (${[...new Set(reasons)].join(",")})`);
    }
  } finally { await app.close(); }
});

test("nothing secret reaches the logs: not the token, not its parts, not the address, not the person's name", { skip }, async () => {
  const { app, logs } = harness();
  try {
    const email = addr("secretlog");
    const good = idToken({ email, sub: `g-log-${suffix}`, name: "Distinctive Personname" });
    const bad = idToken({ email, name: "Distinctive Personname", aud: "999999999999-x.apps.googleusercontent.com" });
    assert.equal((await google(app, { credential: good })).statusCode, 200);
    assert.equal((await google(app, { credential: bad })).statusCode, 401);
    assert.equal((await google(app, { credential: "tokenlike.garbage.value" })).statusCode, 401);
    assert.ok(logs.length >= 2, "the failures were logged");
    const everything = logs.join("\n");
    for (const secret of [good, bad, ...good.split("."), ...bad.split("."), "tokenlike.garbage.value", email, email.split("@")[0]!, "Distinctive", `g-log-${suffix}`]) {
      assert.ok(!everything.includes(secret), `the log does not contain ${secret.slice(0, 24)}…`);
    }
    for (const line of logs) assert.deepEqual(Object.keys(JSON.parse(line)).sort(), ["event", "level", "reason"], "reason code only");
  } finally { await app.close(); }
});

test("Origin must be ours: another site's, the literal null and a missing one are refused before the token is looked at", { skip }, async () => {
  const { app } = harness();
  try {
    const email = addr("origin");
    const credential = idToken({ email, sub: `g-origin-${suffix}` });
    for (const headers of [{ origin: "http://attacker.example.test" }, { origin: "null" }, {}, { origin: `${ORIGIN}.attacker.example.test` }]) {
      const response = await google(app, { credential }, headers);
      assert.equal(response.statusCode, 403, JSON.stringify(headers));
      assert.deepEqual(response.json(), { error: "ORIGIN_INVALID" });
      assert.equal(cookieOf(response), undefined);
    }
    assert.equal((await accountsFor(email)).length, 0, "a refused origin created nothing");
    assert.equal((await google(app, { credential })).statusCode, 200, "and our own origin works");
  } finally { await app.close(); }
});

test("returnTo is honoured only as a same-origin path", { skip }, async () => {
  const { app } = harness();
  try {
    const credential = idToken({ email: addr("return"), sub: `g-return-${suffix}` });
    for (const [returnTo, expected] of [["/trips/new", "/trips/new"], ["//attacker.example.test", "/trips"], ["https://attacker.example.test/x", "/trips"], ["/\\attacker", "/trips"], [42, "/trips"]] as const) {
      const response = await google(app, { credential, returnTo });
      assert.equal(response.json().appPath, expected, String(returnTo));
    }
  } finally { await app.close(); }
});

test("a per-IP rate limit answers 429 before any verification", { skip }, async () => {
  const { app } = harness();
  try {
    for (let i = 0; i < 30; i++) assert.equal((await google(app, { credential: "garbage" })).statusCode, 401);
    const limited = await google(app, { credential: idToken({ email: addr("limit"), sub: `g-limit-${suffix}` }) });
    assert.equal(limited.statusCode, 429);
    assert.deepEqual(limited.json(), { error: "SIGN_IN_RATE_LIMITED" });
    assert.equal(limited.headers["retry-after"], "60");
    assert.equal(limited.headers["cache-control"], "private, no-store");
  } finally { await app.close(); }
});

test("capabilities carries google:true and the PUBLIC client id exactly when it is configured", { skip }, async () => {
  const { app } = harness();
  try {
    assert.deepEqual((await app.inject({ url: "/v1/auth/capabilities" })).json(), { google: true, googleClientId: CLIENT_ID, emailPassword: true, emailSignUp: false, telegramMiniApp: false });
  } finally { await app.close(); }
  const off = buildApp(profile, { portal: { db: pool, runtimeAccounts: { participantExists: async () => true, provisionParticipant: async () => {} },
    publicOrigin: ORIGIN, runtimeOrigin: "http://runtime.example.test", runtimeExchangeKey: "k", runtimeUpstreamHostSuffixes: ["internal"],
    telegramBotUsername: "kinerary_bot", sessionTtlSeconds: 3600, enrollmentTtlSeconds: 3600, approvalTtlSeconds: 3600 } });
  try {
    assert.deepEqual((await off.inject({ url: "/v1/auth/capabilities" })).json(), { google: false, emailPassword: true, emailSignUp: false, telegramMiniApp: false });
  } finally { await off.close(); }
});

test("the policy sweep: the route is `open`, and the redirect flow's two routes are gone from the table and the app", { skip }, async () => {
  assert.equal(PORTAL_SCOPE_POLICY["POST /v1/auth/google"], "open");
  assert.equal("GET /v1/auth/google/start" in PORTAL_SCOPE_POLICY, false);
  assert.equal("GET /v1/auth/google/callback" in PORTAL_SCOPE_POLICY, false);
  const source = await readFile(fileURLToPath(new URL("../src/portal.ts", import.meta.url)), "utf8");
  assert.match(source, /app\.post\("\/v1\/auth\/google"/, "portal-scope-db.test.ts's scan of portal.ts finds the route and so demands its policy row");
  assert.doesNotMatch(source, /google\/start|google\/callback|GoogleOidc/);
  // A Telegram-scoped session is irrelevant to an open route, but the route must not read it either way:
  // the response to a bad token with a (junk) session cookie is the stranger's 401, not a 403 or a 500.
  const { app } = harness();
  try {
    const response = await google(app, { credential: "garbage" }, { origin: ORIGIN, cookie: "kit_session=whatever; kit_csrf=whatever" });
    assert.equal(response.statusCode, 401);
  } finally { await app.close(); }
});

test("a suspended account cannot sign in with Google, and gets the same 401", { skip }, async () => {
  const { app } = harness();
  try {
    const email = addr("suspended"), sub = `g-susp-${suffix}`;
    const first = await google(app, { credential: idToken({ email, sub }) });
    const id = (await me(app, cookieOf(first)!.cookie)).json().id as string;
    await pool.query("UPDATE control_plane.users SET status = 'suspended' WHERE id = $1", [id]);
    const response = await google(app, { credential: idToken({ email, sub }) });
    assert.equal(response.statusCode, 401);
    assert.deepEqual(response.json(), { error: "GOOGLE_SIGN_IN_FAILED" });
    assert.equal(cookieOf(response), undefined);
  } finally { await app.close(); }
});
