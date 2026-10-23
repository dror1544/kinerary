/**
 * The portal's own email sign-up, verification and password reset
 * (portal-email-auth.ts; owner decision 2026-10-23). DB-backed: the migration,
 * the token table, the account functions and the HTTP routes run together, with
 * the log mailer standing in for the provider.
 */
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { after, before, test } from "node:test";
import { fileURLToPath } from "node:url";
import pg from "pg";
import { buildApp } from "../src/app.js";
import { validateArchitectureProfile } from "../src/config.js";
import { LogMailer, MailSendError, ResendMailer, type MailMessage, type Mailer } from "../src/mailer.js";
import { applyMigrations } from "../src/migrations.js";
import { ensureUnknownPasswordCredential, resolveOrCreateEmailAccount, digestEmail } from "../src/password-identity.js";
import { sha256, type GoogleIdentity, type PortalDependencies } from "../src/portal.js";
import { portalMailIdle, ADDRESS_HOURLY_SEND_CAP } from "../src/portal-email-auth.js";
import { PORTAL_SCOPE_POLICY, scopedSessionDigest } from "../src/portal-scope.js";
import { testDatabaseUrl, testPool } from "./support/test-database.js";

const skip = !testDatabaseUrl();
const migrationsDir = fileURLToPath(new URL("../../db/migrations/", import.meta.url));
const ORIGIN = "http://portal.example.test";
const suffix = `${Date.now().toString(36)}${randomBytes(3).toString("hex")}`;
let counter = 0;
const addr = (label: string) => `${label}-${suffix}-${++counter}@mail.example.test`;
const PASSWORD = "correct horse battery";

let pool: pg.Pool;
const profile = validateArchitectureProfile({
  version: 1, environment: "test", public_api: { bind_host: "127.0.0.1", port: 4310 },
  worker: { queue: "postgres", health_bind_host: "127.0.0.1", health_port: 4311 },
  database: { connection_secret_ref: "env://CONTROL_PLANE_DATABASE_URL" },
  adapters: { compute: "fake", ingress: "fake", agent_runtime: "fake", messaging: "fake", secrets: "fake" },
  test_resources: { enabled: false },
});

interface Harness {
  app: ReturnType<typeof buildApp>;
  mailer: LogMailer;
  logs: string[];
  google: { next: GoogleIdentity };
}
function harness(options: { mailer?: Mailer | null; loud?: boolean } = {}): Harness {
  const mailer = new LogMailer(options.loud ? {} : { log: () => {} });
  const logs: string[] = [];
  const google = { next: { subject: "g-unset", displayName: "G", emailVerified: false } as GoogleIdentity };
  const portal: PortalDependencies = {
    db: pool,
    google: { authorizationUrl: ({ state }) => `https://accounts.example.test/auth?state=${state}`, exchange: async () => google.next },
    runtimeAccounts: { participantExists: async () => true, provisionParticipant: async () => {} },
    publicOrigin: ORIGIN, runtimeOrigin: "http://runtime.example.test", runtimeExchangeKey: "exchange-key",
    runtimeUpstreamHostSuffixes: ["internal"], telegramBotUsername: "kinerary_bot", sessionTtlSeconds: 3600,
    enrollmentTtlSeconds: 3600, approvalTtlSeconds: 3600,
    ...(options.mailer === null ? {} : { mailer: options.mailer ?? mailer }),
    emailAuthLog: (line) => logs.push(line),
  };
  return { app: buildApp(profile, { portal }), mailer, logs, google };
}
type App = Harness["app"];

const post = (app: App, url: string, payload: unknown, headers: Record<string, string> = {}) => app.inject({
  method: "POST", url, payload: JSON.stringify(payload), headers: { "content-type": "application/json", origin: ORIGIN, ...headers },
});
const signUp = (app: App, email: string, extra: Record<string, unknown> = {}) =>
  post(app, "/v1/auth/sign-up", { email, ...extra });
/** The page the emailed link opens sends the token with the password and the name the person chose there. */
const verify = (app: App, token: unknown, password: unknown = PASSWORD, headers: Record<string, string> = {}, displayName: unknown = "Dana Organizer") =>
  post(app, "/v1/auth/verify-email", { token, password, displayName }, headers);
const tokenIn = (message: MailMessage | undefined, prefix: "ev" | "pr") => {
  assert.ok(message, "a message was sent");
  const found = message.text.match(new RegExp(`#token=(${prefix}_[A-Za-z0-9_-]{43})`));
  assert.ok(found, `the ${prefix} link is in the message`);
  return found[1]!;
};
const lastTo = (mailer: LogMailer, email: string) => [...mailer.outbox].reverse().find((m) => m.to === email);
const cookiesOf = (response: { headers: Record<string, unknown> }) => {
  const set = ([] as string[]).concat((response.headers["set-cookie"] as string[] | string | undefined) ?? []);
  const pick = (name: string) => {
    const hit = set.find((c) => c.startsWith(`${name}=`));
    return hit ? decodeURIComponent(hit.split(";")[0]!.slice(name.length + 1)) : undefined;
  };
  const session = pick("kit_session"), csrf = pick("kit_csrf");
  return session && csrf ? { cookie: `kit_session=${session}; kit_csrf=${csrf}`, csrf, session } : undefined;
};
const signIn = (app: App, email: string, password: string) => post(app, "/v1/auth/email-password", { email, password });
const me = (app: App, cookie: string) => app.inject({ method: "GET", url: "/v1/me", headers: { cookie } });
const userCount = async (email: string) =>
  (await pool.query("SELECT count(*)::int AS n FROM control_plane.user_identities WHERE provider = 'password' AND provider_subject_digest = $1", [digestEmail(email)])).rows[0].n as number;
const tokenRows = async (email: string) =>
  (await pool.query("SELECT purpose, consumed_at FROM control_plane.email_action_tokens WHERE email_digest = $1 ORDER BY created_at", [digestEmail(email)])).rows;

/** Sign up and verify (choosing `password` on the verify page); returns the signed-in session. */
async function newAccount(h: Harness, email: string, extra: Record<string, unknown> = {}, password = PASSWORD) {
  assert.equal((await signUp(h.app, email, extra)).statusCode, 202);
  await portalMailIdle();
  const verified = await verify(h.app, tokenIn(lastTo(h.mailer, email), "ev"), password);
  assert.equal(verified.statusCode, 200, verified.body);
  return { session: cookiesOf(verified)!, response: verified };
}

before(async () => {
  if (skip) return;
  pool = testPool({ max: 6 });
  const client = await pool.connect();
  try { await applyMigrations(client, migrationsDir); } finally { client.release(); }
});
after(async () => { if (!skip) { await portalMailIdle(); await pool.end(); } });

// ── Sign-up and verification ────────────────────────────────────────────────

test("sign-up creates NO account until the emailed link is used; then it signs the person in and honours returnTo", { skip }, async () => {
  const h = harness();
  try {
    const email = addr("new");
    const before = await signUp(h.app, email, { returnTo: "/trips/new" });
    assert.equal(before.statusCode, 202);
    assert.deepEqual(before.json(), { status: "check_your_email" });
    await portalMailIdle();

    // Unverified: a pending row and a mail, and nothing an account is made of.
    assert.equal(await userCount(email), 0, "no identity before verification");
    assert.equal((await pool.query("SELECT 1 FROM control_plane.password_credentials WHERE email_digest = $1", [digestEmail(email)])).rowCount, 0, "no credential before verification");
    assert.equal((await signIn(h.app, email, PASSWORD)).statusCode, 401, "an unverified address cannot sign in");
    assert.equal(h.mailer.outbox.length, 1);
    const mail = h.mailer.outbox[0]!;
    assert.equal(mail.to, email);
    assert.match(mail.text, new RegExp(`${ORIGIN}/verify-email#token=ev_`), "the link is built from public_origin and keeps the token in the fragment");
    assert.match(mail.html, /<a href="http:\/\/portal\.example\.test\/verify-email#token=ev_/);
    const token = tokenIn(mail, "ev");

    // Only the digest of the token is stored; there is no password in the row at all.
    const stored = await pool.query("SELECT * FROM control_plane.email_action_tokens WHERE email_digest = $1", [digestEmail(email)]);
    assert.equal(stored.rowCount, 1);
    assert.equal(stored.rows[0].token_digest, sha256(token));
    assert.equal("password_hash" in stored.rows[0], false, "the table has no password column");
    assert.doesNotMatch(JSON.stringify(stored.rows), new RegExp(`${token}|${PASSWORD}|scrypt`));
    assert.equal(stored.rows[0].return_to, "/trips/new");
    assert.match(mail.subject, /^Finish creating your Kinerary account/);
    assert.match(mail.text, /Choose your password to finish/);

    // Opening the page spends nothing; only a request that carries the password does (page tests cover the UI).
    assert.equal((await tokenRows(email))[0].consumed_at, null);
    const verified = await verify(h.app, token);
    assert.equal(verified.statusCode, 200, verified.body);
    assert.deepEqual(verified.json(), { appPath: "/trips/new" });
    assert.equal(verified.headers["cache-control"], "private, no-store");
    const session = cookiesOf(verified);
    assert.ok(session, "session cookies are set");
    const who = await me(h.app, session.cookie);
    assert.equal(who.statusCode, 200);
    assert.deepEqual({ name: who.json().displayName, scope: who.json().scope }, { name: "Dana Organizer", scope: "full" });

    assert.equal(await userCount(email), 1);
    const afterRows = await tokenRows(email);
    assert.ok(afterRows[0].consumed_at, "the token is spent");
    // And the password chosen at verification is the one that signs in from now on.
    assert.equal((await signIn(h.app, email, PASSWORD)).statusCode, 200);
    assert.equal((await signIn(h.app, email, "not the password")).statusCode, 401);
  } finally { await h.app.close(); }
});

test("the same answer for a new address and one that already has an account; the owner of the existing one is told by mail", { skip }, async () => {
  const h = harness();
  try {
    const email = addr("dupe");
    await newAccount(h, email);
    h.mailer.outbox.length = 0;
    const again = await signUp(h.app, email);
    const fresh = await signUp(h.app, addr("brandnew"));
    assert.equal(again.statusCode, 202);
    assert.equal(again.statusCode, fresh.statusCode);
    assert.equal(again.body, fresh.body, "byte-identical bodies");
    assert.deepEqual(Object.keys(again.headers).sort(), Object.keys(fresh.headers).sort(), "and the same headers");
    await portalMailIdle();

    const notice = lastTo(h.mailer, email)!;
    assert.match(notice.subject, /already have a Kinerary account/i);
    assert.match(notice.text, new RegExp(`${ORIGIN}/sign-in`));
    assert.match(notice.text, new RegExp(`${ORIGIN}/forgot-password`));
    assert.doesNotMatch(notice.text, /#token=/, "the notice carries no token");
    assert.equal(await userCount(email), 1, "no second account");
    assert.equal((await signIn(h.app, email, PASSWORD)).statusCode, 200, "their password is untouched");
    assert.equal((await tokenRows(email)).filter((r) => r.purpose === "sign_up").length, 1, "the duplicate left no verifiable token");
  } finally { await h.app.close(); }
});

test("a reused, expired, superseded, malformed or unknown token is refused with one answer", { skip }, async () => {
  const h = harness();
  try {
    const email = addr("tokens");
    await signUp(h.app, email); await portalMailIdle();
    const first = tokenIn(lastTo(h.mailer, email), "ev");
    // A second request supersedes the first: only the newest link works.
    await signUp(h.app, email); await portalMailIdle();
    const second = tokenIn(lastTo(h.mailer, email), "ev");
    assert.notEqual(first, second);
    const superseded = await verify(h.app, first);
    assert.equal(superseded.statusCode, 400);
    assert.deepEqual(superseded.json(), { error: "TOKEN_INVALID" });

    // Expired.
    await pool.query("UPDATE control_plane.email_action_tokens SET expires_at = now() - interval '1 second' WHERE token_digest = $1", [sha256(second)]);
    const expired = await verify(h.app, second);
    assert.deepEqual([expired.statusCode, expired.body], [superseded.statusCode, superseded.body], "expired looks like superseded");
    assert.equal(await userCount(email), 0);

    // Unknown, malformed and wrong-purpose tokens are the same answer.
    for (const token of [`ev_${randomBytes(32).toString("base64url")}`, "garbage", "", 42, null, `pr_${randomBytes(32).toString("base64url")}`]) {
      const refused = await verify(h.app, token);
      assert.deepEqual([refused.statusCode, refused.body], [400, superseded.body], String(token));
    }

    // Reused: a good token works once.
    const e2 = addr("reuse");
    await signUp(h.app, e2); await portalMailIdle();
    const token = tokenIn(lastTo(h.mailer, e2), "ev");
    assert.equal((await verify(h.app, token)).statusCode, 200);
    const reused = await verify(h.app, token);
    assert.deepEqual([reused.statusCode, reused.body], [400, superseded.body]);
    // A sign-up token cannot be used as a reset token.
    assert.equal((await post(h.app, "/v1/auth/password/reset", { token, password: PASSWORD })).statusCode, 400);
  } finally { await h.app.close(); }
});

test("sign-up validates the address, and takes no password and no name", { skip }, async () => {
  const h = harness();
  try {
    assert.equal((await post(h.app, "/v1/auth/sign-up", { email: "not-an-email" })).statusCode, 400);
    assert.equal((await post(h.app, "/v1/auth/sign-up", [])).statusCode, 400);
    // No password is asked for, and a client that still sends one gets nothing stored and no say in the account.
    const sneaky = addr("sneaky");
    assert.equal((await post(h.app, "/v1/auth/sign-up", { email: sneaky, password: "attacker chosen pw" })).statusCode, 202);
    await portalMailIdle();
    assert.equal(h.mailer.outbox.length, 1, "only the valid request sent anything");
    const row = (await pool.query("SELECT * FROM control_plane.email_action_tokens WHERE email_digest = $1", [digestEmail(sneaky)])).rows[0];
    assert.doesNotMatch(JSON.stringify(row), /attacker chosen pw|scrypt/);
    assert.equal("display_name" in row, false, "the pending row has no name column either");
    const verified = await verify(h.app, tokenIn(lastTo(h.mailer, sneaky), "ev"), "the owner chose this");
    assert.equal((await me(h.app, cookiesOf(verified)!.cookie)).statusCode, 200);
    assert.equal((await signIn(h.app, sneaky, "the owner chose this")).statusCode, 200);
    assert.equal((await signIn(h.app, sneaky, "attacker chosen pw")).statusCode, 401);
  } finally { await h.app.close(); }
});

test("PRE-HIJACK: whoever starts a sign-up for an address never knows a password for it; the owner who clicks the link chooses their own", { skip }, async () => {
  const h = harness();
  try {
    const victim = addr("hijack");
    // The attacker asks for an account on the victim's address. Nothing they can send carries a password or a name.
    const phish = "Not the owner <b>click here</b>";
    assert.equal((await post(h.app, "/v1/auth/sign-up", { email: victim, displayName: phish, password: "attacker password!" })).statusCode, 202);
    await portalMailIdle();
    const mail = lastTo(h.mailer, victim)!;   // goes to the VICTIM's mailbox, not the attacker
    assert.doesNotMatch(mail.text + mail.html + mail.subject, /Not the owner|click here|attacker password/, "the attacker's words are not in the mail");
    assert.match(mail.text, /^Hi,\n/, "the greeting is generic");
    assert.equal(JSON.stringify((await pool.query("SELECT * FROM control_plane.email_action_tokens WHERE email_digest = $1", [digestEmail(victim)])).rows).includes("Not the owner"), false, "and not stored");
    const token = tokenIn(mail, "ev");
    assert.equal((await signIn(h.app, victim, "attacker password!")).statusCode, 401, "nothing to sign in to yet");
    // The owner opens the link and chooses a password of their own.
    const verified = await verify(h.app, token, "the owner's own passphrase", {}, "Dror Elul");
    assert.equal(verified.statusCode, 200, verified.body);
    assert.equal((await me(h.app, cookiesOf(verified)!.cookie)).json().displayName, "Dror Elul", "the account carries the name the owner typed, not the attacker's");
    // The attacker cannot sign in with anything they chose or guessed from the sign-up.
    for (const guess of ["attacker password!", PASSWORD, "password", "12345678"]) {
      assert.equal((await signIn(h.app, victim, guess)).statusCode, 401, guess);
    }
    assert.equal((await signIn(h.app, victim, "the owner's own passphrase")).statusCode, 200);
  } finally { await h.app.close(); }
});

test("the name is chosen at verification: cleaned (control and bidi characters out), 1 to 80 characters, and refused BEFORE the token is touched", { skip }, async () => {
  const h = harness();
  try {
    const email = addr("name");
    await signUp(h.app, email); await portalMailIdle();
    const token = tokenIn(lastTo(h.mailer, email), "ev");
    for (const bad of ["", "   ", "\u202e\u200b\u0007", "n".repeat(81), 42, null, { a: 1 }]) {
      const refused = await verify(h.app, token, PASSWORD, {}, bad);
      assert.deepEqual([refused.statusCode, refused.json()], [400, { error: "INVALID_NAME" }], String(JSON.stringify(bad)).slice(0, 20));
    }
    assert.deepEqual((await post(h.app, "/v1/auth/verify-email", { token, password: PASSWORD })).json(), { error: "INVALID_NAME" }, "no name at all");
    assert.equal((await tokenRows(email))[0].consumed_at, null, "every refusal left the link unspent");
    assert.equal(await userCount(email), 0);
    // 80 characters is allowed; a right-to-left override, a zero-width space and a newline are stripped; whitespace is collapsed.
    const good = await verify(h.app, token, PASSWORD, {}, "  \u202eדנה\u200b  \n  כהן  ");
    assert.equal(good.statusCode, 200, good.body);
    assert.equal((await me(h.app, cookiesOf(good)!.cookie)).json().displayName, "דנה כהן");
    const e80 = addr("name80");
    await signUp(h.app, e80); await portalMailIdle();
    const ok80 = await verify(h.app, tokenIn(lastTo(h.mailer, e80), "ev"), PASSWORD, {}, "n".repeat(80));
    assert.equal(ok80.statusCode, 200, "exactly 80 characters");
  } finally { await h.app.close(); }
});

test("the password is validated BEFORE the token is touched: a too-short or missing one does not burn the link", { skip }, async () => {
  const h = harness();
  try {
    const email = addr("pwfirst");
    await signUp(h.app, email); await portalMailIdle();
    const token = tokenIn(lastTo(h.mailer, email), "ev");
    for (const bad of ["1234567", "", "p".repeat(1025)]) {
      const refused = await verify(h.app, token, bad);
      assert.equal(refused.statusCode, 400, bad.slice(0, 8));
      assert.equal(cookiesOf(refused), undefined);
    }
    assert.deepEqual((await verify(h.app, token, "1234567")).json(), { error: "PASSWORD_TOO_SHORT" });
    assert.equal((await post(h.app, "/v1/auth/verify-email", { token })).statusCode, 400, "no password at all");
    assert.equal((await post(h.app, "/v1/auth/verify-email", { token, password: 12345678 })).statusCode, 400, "not a string");
    assert.equal((await tokenRows(email))[0].consumed_at, null, "still unspent after every refusal");
    assert.equal(await userCount(email), 0);
    assert.equal((await verify(h.app, token, "12345678")).statusCode, 200, "8 characters is the minimum, as at login, and the same link then works");
    assert.equal((await signIn(h.app, email, "12345678")).statusCode, 200);
  } finally { await h.app.close(); }
});

test("emails go out in Hebrew when asked (body or Accept-Language), as plain text and simple HTML", { skip }, async () => {
  const h = harness();
  try {
    const he = addr("he"), accept = addr("accept"), en = addr("en");
    await signUp(h.app, he, { language: "he" });
    await post(h.app, "/v1/auth/sign-up", { email: accept }, { "accept-language": "he-IL,he;q=0.9,en;q=0.8" });
    await signUp(h.app, en);
    await portalMailIdle();
    const hebrew = lastTo(h.mailer, he)!;
    assert.match(hebrew.subject, /[֐-׿]/);
    assert.match(hebrew.html, /<html lang="he" dir="rtl">/);
    assert.match(hebrew.text, /#token=ev_/);
    assert.match(lastTo(h.mailer, accept)!.subject, /[֐-׿]/);
    const english = lastTo(h.mailer, en)!;
    assert.match(english.subject, /^Finish creating your Kinerary/);
    assert.match(english.html, /<html lang="en" dir="ltr">/);
    assert.match(english.html, /<a href=/);
  } finally { await h.app.close(); }
});

// ── Forgot and reset ────────────────────────────────────────────────────────

test("forgot answers the same for a known and an unknown address, and sends only for the known one", { skip }, async () => {
  const h = harness();
  try {
    const known = addr("known");
    await newAccount(h, known);
    h.mailer.outbox.length = 0;
    const a = await post(h.app, "/v1/auth/password/forgot", { email: known });
    const b = await post(h.app, "/v1/auth/password/forgot", { email: addr("nobody") });
    assert.equal(a.statusCode, 202);
    assert.equal(a.body, b.body);
    assert.deepEqual(a.json(), { status: "check_your_email" });
    await portalMailIdle();
    assert.equal(h.mailer.outbox.length, 1);
    assert.equal(h.mailer.outbox[0]!.to, known);
    assert.match(h.mailer.outbox[0]!.text, new RegExp(`${ORIGIN}/reset-password#token=pr_`));
  } finally { await h.app.close(); }
});

test("reset sets the password, ends every other session, signs in, and the link works once", { skip }, async () => {
  const h = harness();
  try {
    const email = addr("reset");
    const { session: old } = await newAccount(h, email);
    const second = cookiesOf(await signIn(h.app, email, PASSWORD))!;
    assert.equal((await me(h.app, old.cookie)).statusCode, 200);
    assert.equal((await me(h.app, second.cookie)).statusCode, 200);

    await post(h.app, "/v1/auth/password/forgot", { email }); await portalMailIdle();
    const token = tokenIn(lastTo(h.mailer, email), "pr");
    assert.match((await pool.query("SELECT token_digest FROM control_plane.email_action_tokens WHERE token_digest = $1", [sha256(token)])).rows[0].token_digest, /^sha256:/);

    // A typo in the new password must not burn the link.
    const short = await post(h.app, "/v1/auth/password/reset", { token, password: "short" });
    assert.deepEqual([short.statusCode, short.json()], [400, { error: "PASSWORD_TOO_SHORT" }]);

    const NEW = "a brand new passphrase";
    const reset = await post(h.app, "/v1/auth/password/reset", { token, password: NEW });
    assert.equal(reset.statusCode, 200, reset.body);
    assert.deepEqual(reset.json(), { appPath: "/trips" });
    const fresh = cookiesOf(reset);
    assert.ok(fresh);
    assert.equal((await me(h.app, fresh.cookie)).statusCode, 200, "signed in with the reset");
    assert.equal((await me(h.app, old.cookie)).statusCode, 401, "the other sessions are revoked");
    assert.equal((await me(h.app, second.cookie)).statusCode, 401);
    assert.equal((await signIn(h.app, email, PASSWORD)).statusCode, 401, "the old password is gone");
    assert.equal((await signIn(h.app, email, NEW)).statusCode, 200);

    const again = await post(h.app, "/v1/auth/password/reset", { token, password: "yet another one" });
    assert.deepEqual([again.statusCode, again.json()], [400, { error: "TOKEN_INVALID" }]);
    assert.equal((await signIn(h.app, email, NEW)).statusCode, 200, "the reuse changed nothing");
  } finally { await h.app.close(); }
});

test("an expired or superseded reset link is refused, and an unknown one gets the same answer", { skip }, async () => {
  const h = harness();
  try {
    const email = addr("expire");
    await newAccount(h, email);
    await post(h.app, "/v1/auth/password/forgot", { email }); await portalMailIdle();
    const first = tokenIn(lastTo(h.mailer, email), "pr");
    await pool.query("UPDATE control_plane.email_action_tokens SET expires_at = now() - interval '1 second' WHERE token_digest = $1", [sha256(first)]);
    const expired = await post(h.app, "/v1/auth/password/reset", { token: first, password: PASSWORD });
    const unknown = await post(h.app, "/v1/auth/password/reset", { token: `pr_${randomBytes(32).toString("base64url")}`, password: PASSWORD });
    assert.deepEqual([expired.statusCode, expired.body], [400, '{"error":"TOKEN_INVALID"}']);
    assert.equal(unknown.body, expired.body);
    assert.equal((await signIn(h.app, email, PASSWORD)).statusCode, 200, "nothing changed");

    // Newest wins: asking again (even with the address typed in capitals) retires the earlier link.
    await post(h.app, "/v1/auth/password/forgot", { email }); await portalMailIdle();
    const older = tokenIn(lastTo(h.mailer, email), "pr");
    await post(h.app, "/v1/auth/password/forgot", { email: email.toUpperCase() }); await portalMailIdle();
    const newer = tokenIn(lastTo(h.mailer, email.toUpperCase()), "pr");
    assert.notEqual(older, newer);
    assert.equal((await post(h.app, "/v1/auth/password/reset", { token: older, password: PASSWORD })).statusCode, 400);
    assert.equal((await post(h.app, "/v1/auth/password/reset", { token: newer, password: PASSWORD })).statusCode, 200);
  } finally { await h.app.close(); }
});

test("an invited or Google-created account, which never chose a password, can set one by email", { skip }, async () => {
  const h = harness();
  try {
    const email = addr("invited");
    const client = await pool.connect();
    let userId: string;
    try {
      await client.query("BEGIN");
      userId = await resolveOrCreateEmailAccount(client, email, "Invited Organizer");
      await ensureUnknownPasswordCredential(client, userId, email);
      await client.query("COMMIT");
    } finally { client.release(); }
    assert.equal((await signIn(h.app, email, PASSWORD)).statusCode, 401, "nobody knows the invited account's password");

    await post(h.app, "/v1/auth/password/forgot", { email }); await portalMailIdle();
    const reset = await post(h.app, "/v1/auth/password/reset", { token: tokenIn(lastTo(h.mailer, email), "pr"), password: PASSWORD });
    assert.equal(reset.statusCode, 200, reset.body);
    const who = await me(h.app, cookiesOf(reset)!.cookie);
    assert.equal(who.json().id, userId, "the same account, not a new one");
    assert.equal((await signIn(h.app, email, PASSWORD)).statusCode, 200);
  } finally { await h.app.close(); }
});

// ── Coexistence with invitations and Google ─────────────────────────────────

test("a stale unverified sign-up does not block an invitation, and verifying it afterwards changes nothing", { skip }, async () => {
  const h = harness();
  try {
    const email = addr("race");
    await signUp(h.app, email); await portalMailIdle();
    const token = tokenIn(lastTo(h.mailer, email), "ev");

    // The operator invites the same address: the account is minted exactly as always.
    const client = await pool.connect();
    let userId: string;
    try {
      await client.query("BEGIN");
      userId = await resolveOrCreateEmailAccount(client, email, "Invited");
      assert.equal(await ensureUnknownPasswordCredential(client, userId, email), true, "the invitation wrote its credential, nothing was in the way");
      await client.query("COMMIT");
    } finally { client.release(); }
    const before = (await pool.query("SELECT password_hash FROM control_plane.password_credentials WHERE user_id = $1", [userId])).rows[0].password_hash;

    const attempt = await verify(h.app, token, "the typed password");
    assert.deepEqual([attempt.statusCode, attempt.json()], [409, { error: "ACCOUNT_EXISTS" }]);
    assert.equal(cookiesOf(attempt), undefined, "no session");
    assert.equal((await pool.query("SELECT password_hash FROM control_plane.password_credentials WHERE user_id = $1", [userId])).rows[0].password_hash, before, "the invited credential is untouched");
    assert.equal((await signIn(h.app, email, "the typed password")).statusCode, 401, "the password typed on the stale link never became a login");
    assert.equal(await userCount(email), 1);
    assert.equal((await verify(h.app, token)).statusCode, 400, "and the spent token is spent");
  } finally { await h.app.close(); }
});

test("Google sign-in for the same verified address works with a pending sign-up, and after a verified one lands on the same account", { skip }, async () => {
  const h = harness();
  const googleSignIn = async () => {
    const start = await h.app.inject({ url: "/v1/auth/google/start" });
    const state = new URL(String(start.headers.location)).searchParams.get("state")!;
    return h.app.inject({ url: `/v1/auth/google/callback?state=${state}&code=c` });
  };
  try {
    const pending = addr("gpending");
    await signUp(h.app, pending); await portalMailIdle();
    h.google.next = { subject: `g-${suffix}-1`, displayName: "Gina", email: pending, emailVerified: true };
    const callback = await googleSignIn();
    assert.equal(callback.statusCode, 302, callback.body);
    const session = cookiesOf(callback)!;
    assert.equal((await me(h.app, session.cookie)).statusCode, 200);
    // The pending sign-up now finds an account: the link is refused and does not replace Google's credential.
    const attempt = await verify(h.app, tokenIn(lastTo(h.mailer, pending), "ev"));
    assert.equal(attempt.statusCode, 409);

    // The other order: sign up and verify, then Google for that address attaches to the same user.
    const verified = addr("gverified");
    const { session: own } = await newAccount(h, verified);
    const ownId = (await me(h.app, own.cookie)).json().id;
    h.google.next = { subject: `g-${suffix}-2`, displayName: "Gina", email: verified, emailVerified: true };
    const viaGoogle = await googleSignIn();
    assert.equal(viaGoogle.statusCode, 302);
    assert.equal((await me(h.app, cookiesOf(viaGoogle)!.cookie)).json().id, ownId, "one address, one user_id");
    assert.equal((await signIn(h.app, verified, PASSWORD)).statusCode, 200, "the password still works");
  } finally { await h.app.close(); }
});

// ── Rate limits, send budget, Origin, availability ─────────────────────────

test("sign-up and forgot are limited per address and per IP, and the answer for a limited address does not depend on whether it exists", { skip }, async () => {
  const h = harness();
  try {
    const email = addr("limited");
    for (let i = 0; i < 3; i++) assert.equal((await signUp(h.app, email)).statusCode, 202);
    const limited = await signUp(h.app, email);
    assert.equal(limited.statusCode, 429);
    assert.deepEqual(limited.json(), { error: "SIGN_UP_RATE_LIMITED" });
    assert.equal(limited.headers["retry-after"], "60");
    // The forgot route has its own allowance.
    const forgot = addr("limited-forgot");
    for (let i = 0; i < 3; i++) assert.equal((await post(h.app, "/v1/auth/password/forgot", { email: forgot })).statusCode, 202);
    assert.equal((await post(h.app, "/v1/auth/password/forgot", { email: forgot })).statusCode, 429);
    assert.equal((await signUp(h.app, addr("elsewhere"))).statusCode, 202, "another address is unaffected");
  } finally { await h.app.close(); }

  const ip = harness();
  try {
    let refused = 0;
    for (let i = 0; i < 25; i++) {
      const response = await post(ip.app, "/v1/auth/sign-up", { email: addr("ip") });
      if (response.statusCode === 429) refused++; else assert.equal(response.statusCode, 202);
    }
    assert.equal(refused, 5, "20 per minute per IP, and a forwarded header does not buy another allowance");
    assert.equal((await post(ip.app, "/v1/auth/sign-up", { email: addr("ip") }, { "x-forwarded-for": "198.51.100.77" })).statusCode, 429);
    // The IP budget is spent before any password is hashed or any mail sent.
    await portalMailIdle();
    assert.equal(ip.mailer.outbox.length, 20);
  } finally { await ip.app.close(); }

  const tokens = harness();
  try {
    for (let i = 0; i < 30; i++) assert.equal((await verify(tokens.app, "nope")).statusCode, 400);
    assert.equal((await verify(tokens.app, "nope")).statusCode, 429);
    assert.equal((await post(tokens.app, "/v1/auth/password/reset", { token: "nope", password: PASSWORD })).statusCode, 429, "verify and reset share one IP budget");
  } finally { await tokens.app.close(); }
});

test("one address cannot be mailed without limit: past the hourly budget the request is answered and nothing is sent", { skip }, async () => {
  const h = harness();
  try {
    const email = addr("budget");
    await newAccount(h, email);   // one row
    const client = await pool.connect();
    try {
      for (let i = 1; i < ADDRESS_HOURLY_SEND_CAP; i++) {
        await client.query(
          `INSERT INTO control_plane.email_action_tokens(id, purpose, token_digest, email_digest, expires_at, consumed_at)
           VALUES ($1, 'existing_notice', $2, $3, now(), now())`,
          [`eat_${randomBytes(12).toString("hex")}`, sha256(randomBytes(8).toString("hex")), digestEmail(email)]);
      }
    } finally { client.release(); }
    h.mailer.outbox.length = 0;
    const forgot = await post(h.app, "/v1/auth/password/forgot", { email });
    const dupe = await signUp(h.app, email);
    assert.equal(forgot.statusCode, 202);
    assert.equal(dupe.statusCode, 202);
    await portalMailIdle();
    assert.equal(h.mailer.outbox.length, 0, "nothing was sent");
    assert.equal(h.logs.filter((l) => l.includes("email_auth.address_send_budget_exhausted")).length, 2, "and the log says why");
  } finally { await h.app.close(); }
});

test("every email route needs our own Origin: missing, foreign and \"null\" are refused before anything is read or sent", { skip }, async () => {
  const h = harness();
  try {
    const email = addr("origin");
    const bodies: Record<string, unknown> = {
      "/v1/auth/sign-up": { email },
      "/v1/auth/verify-email": { token: "x", password: PASSWORD },
      "/v1/auth/password/forgot": { email },
      "/v1/auth/password/reset": { token: "x", password: PASSWORD },
    };
    for (const [url, payload] of Object.entries(bodies)) {
      for (const origin of [undefined, "https://evil.example.test", "null", `${ORIGIN}.evil.test`]) {
        const response = await h.app.inject({
          method: "POST", url, payload: JSON.stringify(payload),
          headers: { "content-type": "application/json", ...(origin === undefined ? {} : { origin }) },
        });
        assert.equal(response.statusCode, 403, `${url} origin=${origin}`);
        assert.deepEqual(response.json(), { error: "ORIGIN_INVALID" });
      }
    }
    await portalMailIdle();
    assert.equal(h.mailer.outbox.length, 0);
    assert.deepEqual(await tokenRows(email), []);
  } finally { await h.app.close(); }
});

test("with email unconfigured, sign-up and forgot answer 503 SIGN_UP_UNAVAILABLE and the capability says so; nothing is queued", { skip }, async () => {
  const h = harness({ mailer: null });
  try {
    const email = addr("nomail");
    const up = await signUp(h.app, email);
    const forgot = await post(h.app, "/v1/auth/password/forgot", { email });
    for (const response of [up, forgot]) {
      assert.equal(response.statusCode, 503);
      assert.deepEqual(response.json(), { error: "SIGN_UP_UNAVAILABLE" });
    }
    assert.equal((await h.app.inject({ url: "/v1/auth/capabilities" })).json().emailSignUp, false);
    await portalMailIdle();
    assert.deepEqual(await tokenRows(email), [], "no token was created for a message that cannot be sent");
    // Tokens already in people's inboxes keep working: only sending is off.
    assert.equal((await verify(h.app, "nope")).statusCode, 400);
  } finally { await h.app.close(); }
  const on = harness();
  try { assert.equal((await on.app.inject({ url: "/v1/auth/capabilities" })).json().emailSignUp, true); } finally { await on.app.close(); }
});

// ── Logs, the provider, scoped sessions ─────────────────────────────────────

test("no token, password, password hash, API key or address reaches a log line, on success or when the provider fails", { skip }, async () => {
  const captured: string[] = [];
  const realErr = process.stderr.write.bind(process.stderr), realOut = process.stdout.write.bind(process.stdout);
  const tap = (chunk: unknown) => { captured.push(String(chunk)); return true; };
  const API_KEY = `re_key_${randomBytes(12).toString("hex")}`;
  const failing = new ResendMailer(API_KEY, "from@mail.example.test", (async () => new Response(`{"error":"boom ${API_KEY}"}`, { status: 500 })) as typeof fetch);
  const ok = harness({ loud: true });
  const bad = harness({ mailer: failing });
  const secrets: string[] = [PASSWORD];
  try {
    (process.stderr as { write: unknown }).write = tap; (process.stdout as { write: unknown }).write = tap;
    const email = addr("logs");
    const { session } = await newAccount(ok, email);
    secrets.push(tokenIn(lastTo(ok.mailer, email), "ev"));
    await post(ok.app, "/v1/auth/password/forgot", { email }); await portalMailIdle();
    const resetToken = tokenIn(lastTo(ok.mailer, email), "pr");
    secrets.push(resetToken);
    await post(ok.app, "/v1/auth/password/reset", { token: resetToken, password: "the new secret phrase" });
    secrets.push("the new secret phrase", session.session, email, email.split("@")[0]!);

    // The provider failing: the person has already been told to check their inbox, so this is the one place it is visible.
    const victim = addr("provider-down");
    secrets.push(victim);
    assert.equal((await signUp(bad.app, victim)).statusCode, 202);
    await portalMailIdle();
    secrets.push((await pool.query("SELECT password_hash FROM control_plane.password_credentials WHERE email_digest = $1", [digestEmail(email)])).rows[0].password_hash);
  } finally {
    (process.stderr as { write: unknown }).write = realErr; (process.stdout as { write: unknown }).write = realOut;
    await ok.app.close(); await bad.app.close();
  }
  assert.match(captured.join(""), /"event":"mailer\.log_only"/, "the tap saw the mailer's own log lines, so an empty result is not an unattached tap");
  const everything = [...captured, ...ok.logs, ...bad.logs].join("\n");
  for (const secret of [...secrets, API_KEY]) assert.equal(everything.includes(secret), false, `a secret leaked into a log: ${secret.slice(0, 6)}…`);
  const failure = bad.logs.find((l) => l.includes("email_auth.send_failed"));
  assert.ok(failure, "a failed send is logged loudly");
  assert.deepEqual({ purpose: JSON.parse(failure).purpose, status: JSON.parse(failure).provider_status }, { purpose: "sign_up", status: 500 });
});

test("the Resend mailer posts to the API with a bearer key and the configured sender, and a refusal is an error", { skip: false }, async () => {
  const seen: { url: string; init: RequestInit }[] = [];
  const mailer = new ResendMailer("re_test_key", "Sender <noreply@mail.example.test>", (async (url: string, init: RequestInit) => {
    seen.push({ url, init }); return new Response("{}", { status: 200 });
  }) as unknown as typeof fetch);
  await mailer.send({ to: "a@b.example.test", subject: "S", text: "T", html: "<p>H</p>" });
  assert.equal(seen[0]!.url, "https://api.resend.com/emails");
  assert.equal(seen[0]!.init.method, "POST");
  assert.equal((seen[0]!.init.headers as Record<string, string>).authorization, "Bearer re_test_key");
  assert.deepEqual(JSON.parse(String(seen[0]!.init.body)), { from: "Sender <noreply@mail.example.test>", to: ["a@b.example.test"], subject: "S", text: "T", html: "<p>H</p>" });
  const refusing = new ResendMailer("k", "f@b.example.test", (async () => new Response("no", { status: 422 })) as typeof fetch);
  await assert.rejects(refusing.send({ to: "a@b.example.test", subject: "S", text: "T", html: "H" }), (error: unknown) => error instanceof MailSendError && error.status === 422);
  const unreachable = new ResendMailer("k", "f@b.example.test", (async () => { throw new Error("ECONNREFUSED"); }) as typeof fetch);
  await assert.rejects(unreachable.send({ to: "a@b.example.test", subject: "S", text: "T", html: "H" }), (error: unknown) => error instanceof MailSendError && error.status === null);
});

test("the four routes are open: a Telegram-scoped session neither helps nor hinders, and cannot reach another address's account", { skip }, async () => {
  for (const route of ["POST /v1/auth/sign-up", "POST /v1/auth/verify-email", "POST /v1/auth/password/forgot", "POST /v1/auth/password/reset"]) {
    assert.equal(PORTAL_SCOPE_POLICY[route], "open", route);
  }
  const h = harness();
  try {
    // A scoped session: stored under the scoped digest, exactly as a Telegram launch stores one.
    const scopedUserEmail = addr("scoped"), victimEmail = addr("victim");
    await newAccount(h, scopedUserEmail);
    const scopedUser = (await pool.query("SELECT user_id FROM control_plane.user_identities WHERE provider_subject_digest = $1", [digestEmail(scopedUserEmail)])).rows[0].user_id as string;
    const raw = `scoped-${suffix}-${randomBytes(6).toString("hex")}`, csrf = `csrf-${randomBytes(6).toString("hex")}`;
    await pool.query(
      "INSERT INTO control_plane.web_sessions(id,user_id,token_digest,csrf_digest,expires_at) VALUES ($1,$2,$3,$4,now() + interval '1 hour')",
      [`wsess_${suffix}${randomBytes(6).toString("hex")}`, scopedUser, scopedSessionDigest(raw), sha256(csrf)]);
    const scoped = { cookie: `kit_session=${raw}; kit_csrf=${csrf}`, csrf };
    assert.equal((await me(h.app, scoped.cookie)).json().scope, "telegram");

    const { session: victim } = await newAccount(h, victimEmail);
    const withCookie = { cookie: scoped.cookie, "x-csrf-token": scoped.csrf };

    // Asking for the victim's reset with the scoped session sends the mail to the VICTIM, not the session's user, and the answer is the stranger's.
    h.mailer.outbox.length = 0;
    const asked = await post(h.app, "/v1/auth/password/forgot", { email: victimEmail }, withCookie);
    const stranger = await post(h.app, "/v1/auth/password/forgot", { email: addr("stranger") });
    assert.equal(asked.body, stranger.body);
    await portalMailIdle();
    assert.deepEqual(h.mailer.outbox.map((m) => m.to), [victimEmail]);

    // Without the emailed token the session buys nothing: same refusal as with no session at all.
    const guess = { token: `pr_${randomBytes(32).toString("base64url")}`, password: PASSWORD };
    const viaScoped = await post(h.app, "/v1/auth/password/reset", guess, withCookie);
    const viaNothing = await post(h.app, "/v1/auth/password/reset", guess);
    assert.deepEqual([viaScoped.statusCode, viaScoped.body], [viaNothing.statusCode, viaNothing.body]);
    assert.equal(cookiesOf(viaScoped), undefined);
    assert.equal((await me(h.app, scoped.cookie)).statusCode, 200, "its own session is untouched");

    // With the real token the victim's sessions end - and only the victim's.
    const token = tokenIn(lastTo(h.mailer, victimEmail), "pr");
    const reset = await post(h.app, "/v1/auth/password/reset", { token, password: "victim chose this" }, withCookie);
    assert.equal(reset.statusCode, 200);
    assert.equal((await me(h.app, victim.cookie)).statusCode, 401);
    assert.equal((await me(h.app, scoped.cookie)).statusCode, 200, "the scoped user's session is not the victim's");
    const issued = await me(h.app, cookiesOf(reset)!.cookie);
    assert.equal(issued.json().scope, "full");
    assert.equal(issued.json().displayName, "Dana Organizer");
    assert.notEqual(issued.json().id, scopedUser, "the session issued belongs to the token's account, never to the scoped session's user");
  } finally { await h.app.close(); }
});
