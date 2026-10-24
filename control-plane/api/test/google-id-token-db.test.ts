/**
 * POST /v1/auth/google: "Sign in with Google" by Google Identity Services ID token (owner decision 2026-10-23;
 * no client secret, no redirect). DB-backed, and offline: tokens are signed here with a local RSA key and the
 * library's certificate fetch is replaced by that key's public half, so everything else is the real thing:
 * the library's signature, audience, issuer and expiry checks, the route, the account functions, the sessions.
 */
import assert from "node:assert/strict";
import { createHash, createSign, generateKeyPairSync, randomBytes } from "node:crypto";
import { readFile } from "node:fs/promises";
import { after, before, test } from "node:test";
import { fileURLToPath } from "node:url";
import { OAuth2Client } from "google-auth-library";
import pg from "pg";
import { buildApp } from "../src/app.js";
import { validateArchitectureProfile } from "../src/config.js";
import { applyMigrations } from "../src/migrations.js";
import { createOrVerifyPasswordIdentity, digestEmail } from "../src/password-identity.js";
import { GoogleIdTokenClient, googleIsAuthoritativeFor, sha256, type PortalDependencies } from "../src/portal.js";
import { PORTAL_SCOPE_POLICY } from "../src/portal-scope.js";
import { testDatabaseUrl, testPool } from "./support/test-database.js";

const skip = !testDatabaseUrl();
const migrationsDir = fileURLToPath(new URL("../../db/migrations/", import.meta.url));
const ORIGIN = "http://portal.example.test";
const CLIENT_ID = "123456789012-testclient.apps.googleusercontent.com";
const suffix = `${Date.now().toString(36)}${randomBytes(3).toString("hex")}`;
let counter = 0;
// gmail.com: the one domain Google is always authoritative for (the other domains are tested on their own below).
const addr = (label: string) => `${label}-${suffix}-${++counter}@gmail.com`;
const addrAt = (label: string, domain: string) => `${label}-${suffix}-${++counter}@${domain}`;

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
/** The Set-Cookie lines of a response. */
const setCookies = (response: { headers: Record<string, unknown> }) => ([] as string[]).concat((response.headers["set-cookie"] as string[] | string | undefined) ?? []);
/**
 * What the page does before it draws Google's button: asks for a nonce (the server sets the secret in a cookie and
 * returns only its hash), then has Google sign a token carrying that nonce. Returns the token and the cookie to post it with.
 */
async function bound(app: App, claims: Record<string, unknown> = {}, key: { privateKey: ReturnType<typeof generateKeyPairSync>["privateKey"] } = signingKey) {
  const response = await app.inject({ method: "GET", url: "/v1/auth/google/nonce" });
  assert.equal(response.statusCode, 200, response.body);
  const cookie = setCookies(response).find((line) => line.startsWith("kit_gnonce="))!.split(";")[0]!;
  return { credential: idToken({ nonce: response.json().nonce, ...claims }, key), cookie };
}
/** A complete sign-in the way the page does it. */
async function signInAs(app: App, claims: Record<string, unknown> = {}, extra: { returnTo?: unknown; headers?: Record<string, string> } = {}) {
  const token = await bound(app, claims);
  return google(app, { credential: token.credential, ...(extra.returnTo === undefined ? {} : { returnTo: extra.returnTo }) }, { origin: ORIGIN, cookie: token.cookie, ...extra.headers });
}
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
    const first = await signInAs(app, { email, sub }, { returnTo: "/trips/new" });
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

    const again = await signInAs(app, { email, sub });
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

    const response = await signInAs(app, { email: email.toUpperCase(), sub });
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
      const response = await signInAs(app, { email, sub, ...claims });
      assert.equal(response.statusCode, 401, JSON.stringify(claims));
      assert.deepEqual(response.json(), { error: "GOOGLE_SIGN_IN_FAILED" });
      assert.equal(cookieOf(response), undefined, "no session");
      assert.equal((await accountsFor(email)).length, 0, "no account");
      assert.equal((await googleRows(sub)).length, 0, "no identity");
    }
  } finally { await app.close(); }
});

test("wrong audience, wrong issuer, wrong azp, expired, bad signature, wrong key, unknown kid and garbage all get the SAME 401", { skip }, async () => {
  const { app, logs } = harness();
  try {
    const now = Math.floor(Date.now() / 1000);
    const forgedHeader = `${b64({ alg: "RS256", kid: "other-kid", typ: "JWT" })}.${idToken().split(".")[1]}.sig`;
    const tampered = (() => { const [h, , s] = idToken().split("."); return `${h}.${b64({ iss: "https://accounts.google.com", aud: CLIENT_ID, sub: "x", email: "tamper@mail.example.test", email_verified: true, iat: now, exp: now + 600 })}.${s}`; })();
    // Tokens that carry a VALID nonce (the cookie is posted with them), so the claim named is the only thing wrong.
    const claimCases: Record<string, [Record<string, unknown>, typeof signingKey?]> = {
      "wrong audience": [{ aud: "999999999999-someoneelse.apps.googleusercontent.com" }],
      "wrong issuer": [{ iss: "https://accounts.evil.example.test" }],
      "wrong azp (issued to another client)": [{ azp: "999999999999-someoneelse.apps.googleusercontent.com" }],
      "expired": [{ iat: now - 7200, exp: now - 3600 }],
      "not yet valid": [{ iat: now + 3600, exp: now + 7200 }],
      "signed by another key": [{}, otherKey],
    };
    const rawCases: Record<string, string> = {
      "payload altered after signing": tampered,
      "unknown kid": forgedHeader,
      "not a JWT": "garbage",
      "two segments": "aaa.bbb",
      "undecodable segments": "!!!.???.***",
    };
    const bodies = new Set<string>();
    for (const [name, [claims, key]] of Object.entries(claimCases)) {
      const token = await bound(app, claims, key);
      const response = await google(app, { credential: token.credential }, { origin: ORIGIN, cookie: token.cookie });
      assert.equal(response.statusCode, 401, name);
      bodies.add(response.body);
      assert.equal(cookieOf(response), undefined, name);
    }
    for (const [name, credential] of Object.entries(rawCases)) {
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
    for (const code of ["AUDIENCE_MISMATCH", "ISSUER_MISMATCH", "AZP_MISMATCH", "TOKEN_EXPIRED", "SIGNATURE_INVALID", "TOKEN_MALFORMED", "CREDENTIAL_MISSING"]) {
      assert.ok(reasons.includes(code), `${code} was logged (${[...new Set(reasons)].join(",")})`);
    }
  } finally { await app.close(); }
});

test("azp: absent is accepted (Google omits it when it equals aud), equal to our client ID is accepted, anything else is refused", { skip }, async () => {
  const { app, logs } = harness();
  try {
    const noAzp = await bound(app, { email: addr("azp"), sub: `g-azp-${suffix}`, azp: undefined });
    assert.equal((await google(app, { credential: noAzp.credential }, { origin: ORIGIN, cookie: noAzp.cookie })).statusCode, 200);
    assert.equal((await signInAs(app, { email: addr("azp2"), sub: `g-azp2-${suffix}`, azp: CLIENT_ID })).statusCode, 200);
    logs.length = 0;
    const other = await signInAs(app, { email: addr("azp3"), sub: `g-azp3-${suffix}`, azp: "999999999999-someoneelse.apps.googleusercontent.com" });
    assert.equal(other.statusCode, 401);
    assert.deepEqual(other.json(), { error: "GOOGLE_SIGN_IN_FAILED" });
    assert.deepEqual(logs.map((l) => JSON.parse(l).reason), ["AZP_MISMATCH"]);
  } finally { await app.close(); }
});

test("SINGLE USE: the nonce cookie is HttpOnly, scoped and short-lived; a token is accepted once, and never without its own cookie", { skip }, async () => {
  const { app, logs } = harness();
  try {
    const issued = await app.inject({ method: "GET", url: "/v1/auth/google/nonce" });
    assert.equal(issued.statusCode, 200);
    assert.equal(issued.headers["cache-control"], "private, no-store");
    const line = setCookies(issued).find((c) => c.startsWith("kit_gnonce="))!;
    assert.match(line, /; Path=\/v1\/auth\/google;/, "scoped to the Google routes");
    assert.match(line, /HttpOnly/);
    assert.match(line, /SameSite=Lax/);
    assert.match(line, /Max-Age=300/);
    const nonce = issued.json().nonce as string;
    const secret = decodeURIComponent(line.split(";")[0]!.slice("kit_gnonce=".length));
    assert.match(nonce, /^[0-9a-f]{64}$/);
    assert.notEqual(nonce, secret, "the page and the token see only the hash, never the cookie's secret");
    assert.equal(createHash("sha256").update(secret).digest("hex"), nonce);
    assert.notEqual((await app.inject({ method: "GET", url: "/v1/auth/google/nonce" })).json().nonce, nonce, "a new one every time");

    const claims = { email: addr("single"), sub: `g-single-${suffix}`, nonce };
    const credential = idToken(claims);
    const cookie = `kit_gnonce=${encodeURIComponent(secret)}`;

    // Without the cookie: refused. With a different browser's cookie: refused. A token with no nonce at all: refused.
    logs.length = 0;
    assert.equal((await google(app, { credential })).statusCode, 401, "no cookie");
    assert.equal((await google(app, { credential }, { origin: ORIGIN, cookie: "kit_gnonce=someone-elses-secret" })).statusCode, 401, "wrong cookie");
    assert.equal((await google(app, { credential }, { origin: ORIGIN, cookie: `kit_gnonce=${nonce}` })).statusCode, 401, "the nonce (all a leaked token shows) is not the secret");
    const bare = idToken({ email: claims.email, sub: claims.sub, nonce: undefined });
    assert.equal((await google(app, { credential: bare }, { origin: ORIGIN, cookie })).statusCode, 401, "token without a nonce");
    assert.deepEqual(logs.map((l) => JSON.parse(l).reason), ["NONCE_MISSING", "NONCE_MISMATCH", "NONCE_MISMATCH", "NONCE_MISMATCH"]);
    assert.equal((await accountsFor(claims.email)).length, 0, "nothing was created by the refusals");

    // The right cookie works once, and clears the cookie in the same response.
    const ok = await google(app, { credential }, { origin: ORIGIN, cookie });
    assert.equal(ok.statusCode, 200, ok.body);
    const cleared = setCookies(ok).find((c) => c.startsWith("kit_gnonce="))!;
    assert.match(cleared, /Max-Age=0/);
    assert.match(cleared, /Path=\/v1\/auth\/google;/);
    assert.ok(cookieOf(ok), "and the session cookies are set alongside it");
    // Replaying the identical token with the identical cookie (the browser having kept a copy): the secret is spent
    // only on the browser side, so this is what the token's own `exp` and the rate limit are for - but a replay from
    // anywhere without the cookie, which is every replay by someone who merely saw the token, is refused (above).
    const replayWithoutCookie = await google(app, { credential });
    assert.equal(replayWithoutCookie.statusCode, 401);

    // Every outcome clears it, a refusal included.
    const failed = await bound(app, { aud: "999999999999-x.apps.googleusercontent.com" });
    const failedResponse = await google(app, { credential: failed.credential }, { origin: ORIGIN, cookie: failed.cookie });
    assert.equal(failedResponse.statusCode, 401);
    assert.match(setCookies(failedResponse).find((c) => c.startsWith("kit_gnonce="))!, /Max-Age=0/);
    // And a refused Origin does not spend a legitimate page's nonce.
    const keep = await bound(app, { email: addr("keep"), sub: `g-keep-${suffix}` });
    const foreign = await google(app, { credential: keep.credential }, { origin: "http://attacker.example.test", cookie: keep.cookie });
    assert.equal(foreign.statusCode, 403);
    assert.equal(setCookies(foreign).some((c) => c.startsWith("kit_gnonce=")), false);
    assert.equal((await google(app, { credential: keep.credential }, { origin: ORIGIN, cookie: keep.cookie })).statusCode, 200);
  } finally { await app.close(); }
});

test("the nonce route is rate-limited per IP, open, and unavailable (503) without Google configured", { skip }, async () => {
  const { app } = harness();
  try {
    for (let i = 0; i < 60; i++) assert.equal((await app.inject({ method: "GET", url: "/v1/auth/google/nonce" })).statusCode, 200);
    const limited = await app.inject({ method: "GET", url: "/v1/auth/google/nonce" });
    assert.equal(limited.statusCode, 429);
    assert.equal(setCookies(limited).length, 0, "a limited call mints nothing");
  } finally { await app.close(); }
  assert.equal(PORTAL_SCOPE_POLICY["GET /v1/auth/google/nonce"], "open");
  const off = buildApp(profile, { portal: { db: pool, runtimeAccounts: { participantExists: async () => true, provisionParticipant: async () => {} },
    publicOrigin: ORIGIN, runtimeOrigin: "http://runtime.example.test", runtimeExchangeKey: "k", runtimeUpstreamHostSuffixes: ["internal"],
    telegramBotUsername: "kinerary_bot", sessionTtlSeconds: 3600, enrollmentTtlSeconds: 3600, approvalTtlSeconds: 3600 } });
  try {
    const response = await off.inject({ method: "GET", url: "/v1/auth/google/nonce" });
    assert.equal(response.statusCode, 503);
    assert.equal(setCookies(response).length, 0);
  } finally { await off.close(); }
});

test("nothing secret reaches the logs: not the token, not its parts, not the address, not the person's name, not the nonce secret", { skip }, async () => {
  const { app, logs } = harness();
  try {
    const email = addr("secretlog");
    const good = await bound(app, { email, sub: `g-log-${suffix}`, name: "Distinctive Personname" });
    const bad = await bound(app, { email, name: "Distinctive Personname", aud: "999999999999-x.apps.googleusercontent.com" });
    assert.equal((await google(app, { credential: good.credential }, { origin: ORIGIN, cookie: good.cookie })).statusCode, 200);
    assert.equal((await google(app, { credential: bad.credential }, { origin: ORIGIN, cookie: bad.cookie })).statusCode, 401);
    assert.equal((await google(app, { credential: "tokenlike.garbage.value" })).statusCode, 401);
    assert.ok(logs.length >= 2, "the failures were logged");
    const everything = logs.join("\n");
    const secrets = [good.cookie.split("=")[1]!, bad.cookie.split("=")[1]!];
    for (const secret of [good.credential, bad.credential, ...good.credential.split("."), ...bad.credential.split("."), "tokenlike.garbage.value", email, email.split("@")[0]!, "Distinctive", `g-log-${suffix}`, ...secrets]) {
      assert.ok(!everything.includes(secret), `the log does not contain ${secret.slice(0, 24)}…`);
    }
    for (const line of logs) assert.deepEqual(Object.keys(JSON.parse(line)).sort(), ["event", "level", "reason"], "reason code only");
  } finally { await app.close(); }
});

test("Origin must be ours: another site's, the literal null and a missing one are refused before the token is looked at", { skip }, async () => {
  const { app } = harness();
  try {
    const email = addr("origin");
    const token = await bound(app, { email, sub: `g-origin-${suffix}` });
    for (const headers of [{ origin: "http://attacker.example.test" }, { origin: "null" }, {}, { origin: `${ORIGIN}.attacker.example.test` }]) {
      const response = await google(app, { credential: token.credential }, { ...headers, cookie: token.cookie });
      assert.equal(response.statusCode, 403, JSON.stringify(headers));
      assert.deepEqual(response.json(), { error: "ORIGIN_INVALID" });
      assert.equal(cookieOf(response), undefined);
    }
    assert.equal((await accountsFor(email)).length, 0, "a refused origin created nothing");
    assert.equal((await google(app, { credential: token.credential }, { origin: ORIGIN, cookie: token.cookie })).statusCode, 200, "and our own origin works");
  } finally { await app.close(); }
});

/** Everything an account is made of, counted: a refusal must change none of it. */
async function accountTables() {
  const count = async (sql: string) => (await pool.query(sql)).rows[0].n as number;
  return {
    users: await count("SELECT count(*)::int AS n FROM control_plane.users"),
    identities: await count("SELECT count(*)::int AS n FROM control_plane.user_identities"),
    credentials: await count("SELECT count(*)::int AS n FROM control_plane.password_credentials"),
    sessions: await count("SELECT count(*)::int AS n FROM control_plane.web_sessions"),
    funnel: await count("SELECT count(*)::int AS n FROM control_plane.funnel_events"),
  };
}

test("Google is authoritative only for gmail.com / googlemail.com, or for the Workspace domain its hd claim names (exact match)", () => {
  for (const [email, hd, expected] of [
    ["a@gmail.com", undefined, true], ["a@googlemail.com", undefined, true], ["A@GMAIL.COM", undefined, true],
    ["a@workspace.example.test", "workspace.example.test", true], ["a@Workspace.Example.test", "workspace.example.test", true],
    ["a@workspace.example.test", "other.example.test", false], ["a@sub.workspace.example.test", "workspace.example.test", false],
    ["a@workspace.example.test", undefined, false], ["a@workspace.example.test", "", false],
    ["a@outlook.com", undefined, false], ["a@gmail.com.evil.test", undefined, false], ["a@notgmail.com", undefined, false],
    ["a@evilgmail.com", undefined, false], ["a@gmail.co", undefined, false], ["gmail.com", undefined, false], ["a@", "", false], ["@gmail.com", undefined, false],
    ["a@gmail.com@evil.test", undefined, false],
  ] as const) assert.equal(googleIsAuthoritativeFor(email, hd), expected, `${email} hd=${hd}`);
});

test("a gmail.com and a googlemail.com address sign up and sign in again", { skip }, async () => {
  const { app } = harness();
  try {
    for (const domain of ["gmail.com", "googlemail.com"]) {
      const email = addrAt("consumer", domain), sub = `g-consumer-${suffix}-${domain}`;
      const first = await signInAs(app, { email, sub });
      assert.equal(first.statusCode, 200, first.body);
      const again = await signInAs(app, { email, sub });
      assert.equal(again.statusCode, 200);
      assert.equal((await me(app, cookieOf(again)!.cookie)).json().id, (await me(app, cookieOf(first)!.cookie)).json().id);
    }
  } finally { await app.close(); }
});

test("a Workspace address whose hd matches its domain signs in; a mismatched or missing hd is refused with GOOGLE_USE_EMAIL_SIGN_UP", { skip }, async () => {
  const { app, logs } = harness();
  try {
    const email = addrAt("staff", "workspace.example.test"), sub = `g-ws-${suffix}`;
    const first = await signInAs(app, { email, sub, hd: "workspace.example.test" });
    assert.equal(first.statusCode, 200, first.body);
    const again = await signInAs(app, { email, sub, hd: "workspace.example.test" });
    assert.equal(again.statusCode, 200);
    assert.equal((await me(app, cookieOf(again)!.cookie)).json().id, (await me(app, cookieOf(first)!.cookie)).json().id);

    const before = await accountTables();
    logs.length = 0;
    for (const claims of [
      { email: addrAt("mismatch", "workspace.example.test"), hd: "other.example.test" },
      { email: addrAt("nohd", "workspace.example.test") },
      { email: addrAt("subdomain", "team.workspace.example.test"), hd: "workspace.example.test" },
      { email: addrAt("empty", "workspace.example.test"), hd: "" },
    ]) {
      const response = await signInAs(app, { sub: `g-ws-${suffix}-${++counter}`, ...claims });
      assert.equal(response.statusCode, 401, JSON.stringify(claims));
      assert.deepEqual(response.json(), { error: "GOOGLE_USE_EMAIL_SIGN_UP" }, JSON.stringify(claims));
      assert.equal(cookieOf(response), undefined);
    }
    assert.deepEqual(await accountTables(), before, "nothing was written");
    assert.deepEqual(logs.map((l) => JSON.parse(l)), Array(4).fill({ level: "warn", event: "google_sign_in.refused", reason: "EMAIL_NOT_GOOGLE_AUTHORITATIVE" }), "a reason code only");
  } finally { await app.close(); }
});

test("an outlook.com address with email_verified is refused whether or not it has an account, with the identical answer, and nothing is written", { skip }, async () => {
  const { app, logs } = harness();
  try {
    const existing = addrAt("hasaccount", "outlook.com"), fresh = addrAt("noaccount", "outlook.com");
    assert.ok((await createOrVerifyPasswordIdentity(pool, { email: existing, password: "existing-organizer-secret" })).ok);
    const before = await accountTables();
    logs.length = 0;
    const answers: string[] = [];
    for (const [email, sub] of [[existing, `g-out-a-${suffix}`], [fresh, `g-out-b-${suffix}`], [existing, `g-out-a-${suffix}`]] as const) {
      const response = await signInAs(app, { email, sub, email_verified: true });
      assert.equal(response.statusCode, 401);
      assert.equal(cookieOf(response), undefined, "no session");
      answers.push(`${response.statusCode} ${response.body} ${response.headers["cache-control"]}`);
    }
    assert.equal(new Set(answers).size, 1, `one answer, with or without an account: ${answers.join(" | ")}`);
    assert.equal(answers[0], '401 {"error":"GOOGLE_USE_EMAIL_SIGN_UP"} private, no-store');
    assert.deepEqual(await accountTables(), before, "no user, identity, credential, session or funnel row was written");
    assert.equal((await googleRows(`g-out-a-${suffix}`)).length, 0, "the existing account was not linked");
    assert.equal((await accountsFor(fresh)).length, 0);
    assert.equal(logs.length, 3);
    assert.ok(logs.every((l) => JSON.parse(l).reason === "EMAIL_NOT_GOOGLE_AUTHORITATIVE"));
    assert.ok(!logs.join("\n").includes("outlook"), "the address is not logged");
  } finally { await app.close(); }
});

test("the 'use email sign-up' answer is given only for a genuine, correctly bound token: anything else is the ordinary GOOGLE_SIGN_IN_FAILED", { skip }, async () => {
  const { app } = harness();
  try {
    const email = addrAt("oracle", "outlook.com");
    // Wrong audience, unverified, no nonce cookie, a nonce that is not this browser's: none may learn that the domain is the problem.
    const wrongAudience = await signInAs(app, { email, aud: "999-x.apps.googleusercontent.com" });
    const unverified = await signInAs(app, { email, email_verified: false });
    const bound1 = await bound(app, { email });
    const noCookie = await google(app, { credential: bound1.credential });
    const bound2 = await bound(app, { email });
    const wrongCookie = await google(app, { credential: bound2.credential }, { origin: ORIGIN, cookie: "kit_gnonce=another-browsers-secret" });
    for (const response of [wrongAudience, unverified, noCookie, wrongCookie]) {
      assert.equal(response.statusCode, 401);
      assert.deepEqual(response.json(), { error: "GOOGLE_SIGN_IN_FAILED" });
    }
  } finally { await app.close(); }
});


test("returnTo is honoured only as a same-origin path, including after normalisation (/.//host is //host)", { skip }, async () => {
  const { app } = harness();
  try {
    const email = addr("return"), sub = `g-return-${suffix}`;
    for (const [returnTo, expected] of [
      ["/trips/new", "/trips/new"], ["//attacker.example.test", "/trips"], ["https://attacker.example.test/x", "/trips"], ["/\\attacker", "/trips"], [42, "/trips"],
      ["/.//evil.example", "/trips"], ["/trips/../..//evil.example", "/trips"], ["/a/..//evil.example/x?y=1#z", "/trips"], ["/./evil.example", "/evil.example"],
    ] as const) {
      const response = await signInAs(app, { email, sub }, { returnTo });
      assert.equal(response.json().appPath, expected, String(returnTo));
    }
  } finally { await app.close(); }
});

test("the email-password route shares the same returnTo rule: the normalised //host cases land on /trips there too", { skip }, async () => {
  const { app } = harness();
  try {
    const email = addr("pwreturn"), password = "existing-organizer-secret";
    assert.ok((await createOrVerifyPasswordIdentity(pool, { email, password })).ok);
    for (const [returnTo, expected] of [["/trips/new", "/trips/new"], ["//attacker.example.test", "/trips"], ["/.//evil.example", "/trips"], ["/trips/../..//evil.example", "/trips"]] as const) {
      const response = await app.inject({ method: "POST", url: "/v1/auth/email-password", headers: { origin: ORIGIN, "content-type": "application/json" }, payload: JSON.stringify({ email, password, returnTo }) });
      assert.equal(response.statusCode, 200, response.body);
      assert.equal(response.json().appPath, expected, returnTo);
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
    const first = await signInAs(app, { email, sub });
    const id = (await me(app, cookieOf(first)!.cookie)).json().id as string;
    await pool.query("UPDATE control_plane.users SET status = 'suspended' WHERE id = $1", [id]);
    const response = await signInAs(app, { email, sub });
    assert.equal(response.statusCode, 401);
    assert.deepEqual(response.json(), { error: "GOOGLE_SIGN_IN_FAILED" });
    assert.equal(cookieOf(response), undefined);
  } finally { await app.close(); }
});
