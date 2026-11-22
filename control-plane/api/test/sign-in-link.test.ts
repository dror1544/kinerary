/**
 * Slice S3 of docs/specs/sprint-9/x-member-sign-in.md, "Send me a sign-in link" (#614): AC-14 (one answer for every case),
 * AC-15 (where the link goes, and what opening it does) and AC-16 (silent limits).
 *
 * Postgres and the Fastify routes are real; the trip site's participants are the harness's map; the mailer is the log
 * mailer; Telegram's side is a recording NotificationAdapter handed to the outbox dispatcher. Every test names its AC.
 */
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { after, before, beforeEach, describe, test } from "node:test";
import { digestTelegramId } from "../src/identity.js";
import { LogMailer } from "../src/mailer.js";
import { dispatchPendingTripNotifications } from "../src/outbox-dispatcher.js";
import { digestEmail, hashPassword } from "../src/password-identity.js";
import { portalMailIdle } from "../src/portal-email-auth.js";
import { PORTAL_SCOPE_POLICY, scopedSessionDigest } from "../src/portal-scope.js";
import { GROUP_VERIFIED_VIA } from "../src/telegram-mini-app.js";
import { ORIGIN, asCookie, cookieOf, id, sha256, startHarness, tg, type Harness, type SitePerson } from "./support/group-sign-in-harness.js";
import { testDatabaseUrl } from "./support/test-database.js";

const skip = !testDatabaseUrl();
let h: Harness;
let mailer: LogMailer;
let logs: string[];
const PASSWORD = "correct horse battery";
const NEW_PASSWORD = "a brand new passphrase";
const GENERIC = JSON.stringify({ status: "request_received" });
let ipCounter = 0;
/** A fresh client address per request unless a test is about the per-IP limit: the limiter is in memory, keyed on it. */
const freshIp = () => `10.${(++ipCounter >> 16) & 255}.${(ipCounter >> 8) & 255}.${ipCounter & 255}`;

before(async () => {
  if (skip) return;
  h = await startHarness();
  // The feature ships OFF; every test below that is not about the switch runs with it on at the "every trip" level (the email door's level).
  await setSwitch(null, true);
});

/** `member_sign_in_link` for one trip, or (tripId null) at the "every trip" level. */
async function setSwitch(tripId: string | null, on: boolean) {
  await h.pool.query("DELETE FROM control_plane.feature_switch_settings WHERE switch = 'member_sign_in_link' AND scope = $1 AND trip_id IS NOT DISTINCT FROM $2", [tripId ? "trip" : "all_trips", tripId]);
  await h.pool.query(
    "INSERT INTO control_plane.feature_switch_settings(switch, scope, trip_id, enabled, changed_by) VALUES ('member_sign_in_link', $1, $2, $3, $4)",
    [tripId ? "trip" : "all_trips", tripId, on, `sha256:${"0".repeat(64)}`]);
}
/** The group a trip's claims are checked against: tripId -> its open group chat. */
const groupOf = new Map<string, string>();
after(async () => { if (!skip) { await portalMailIdle(); await h.stop(); } });
beforeEach(() => { mailer = new LogMailer({ log: () => {} }); logs = []; });

const newApp = () => h.newApp({ mailer, emailAuthLog: (line) => logs.push(line) });
type App = ReturnType<typeof newApp>;

const ask = (app: App, body: unknown, ip: string = freshIp(), headers: Record<string, string> = {}) => app.inject({
  method: "POST", url: "/v1/auth/sign-in-link", remoteAddress: ip, payload: JSON.stringify(body),
  headers: { "content-type": "application/json", origin: ORIGIN, ...headers },
});
const redeem = (app: App, token: unknown, ip: string = freshIp()) => app.inject({
  method: "POST", url: "/v1/auth/sign-in-link/redeem", remoteAddress: ip, payload: JSON.stringify({ token }),
  headers: { "content-type": "application/json", origin: ORIGIN },
});
const setPassword = (app: App, session: { cookie: string; csrf: string }, password: unknown) => app.inject({
  method: "POST", url: "/v1/auth/sign-in-link/password", payload: JSON.stringify({ password }),
  headers: { "content-type": "application/json", origin: ORIGIN, cookie: session.cookie, "x-csrf-token": session.csrf },
});
const emailPasswordLogin = (app: App, email: string, password: string) => app.inject({
  method: "POST", url: "/v1/auth/email-password", remoteAddress: freshIp(), payload: JSON.stringify({ email, password }),
  headers: { "content-type": "application/json", origin: ORIGIN },
});
const sessionOf = (response: { headers: Record<string, unknown> }) => ({ cookie: asCookie(response), csrf: cookieOf(response, "kit_csrf")! });

/** The database outlives a run, and a telegram identity's digest is unique: every run needs ids of its own. */
const uniqueChat = () => String(800_000_000 + Math.floor(Math.random() * 100_000_000));
const addr = (label: string) => `${label}-${id("x").toLowerCase()}@mail.example.test`;

// ── fixtures ────────────────────────────────────────────────────────────────

const PEOPLE: SitePerson[] = [
  { username: "dl17", displayName: "Dana Levi", role: "member" },
  { username: "nl23", displayName: "Noam Levi", role: "member" },
  { username: "tl31", displayName: "Tamar Levi", role: "member" },
  { username: "tw1", displayName: "Twin Person", role: "member" },
  { username: "tw2", displayName: "twin   person", role: "member" },
  { username: "org1", displayName: "The Organizer", role: "organizer" },
  { username: "ghost", displayName: "Ghost Member", role: "member" },
];

async function mkTrip() {
  const tripId = await h.mkTrip("Sign-in trip");
  const owner = await h.mkUser("Owner");
  await h.mkMember(tripId, owner, "owner");
  h.site.set(tripId, PEOPLE.map((p) => ({ ...p })));
  // What a claim's trip needs to be usable at all: one open group, `member_group_sign_in` on, and this feature on for the trip.
  groupOf.set(tripId, await h.bindGroup(tripId));
  await h.switchOn(tripId);
  await setSwitch(tripId, true);
  return { tripId, owner };
}

/** An account a GROUP CLAIM made (spec S1): no email, no credential, a live claim holding the raw Telegram id, and its link. */
async function mkClaimAccount(tripId: string, username: string, name: string, telegramId: number = tg()) {
  const userId = await h.mkUser(name);
  await h.mkMember(tripId, userId, "member", { dashboard: false, runtime: true });
  await h.pool.query(
    `INSERT INTO control_plane.trip_participant_claims(id, trip_id, user_id, runtime_username, via, telegram_user_id, last_group_check_at)
     VALUES ($1, $2, $3, $4, 'group_membership', $5, now())`, [id("tpc"), tripId, userId, username, String(telegramId)]);
  const linkId = id("tml");
  await h.pool.query(
    `INSERT INTO control_plane.telegram_member_links(id, user_id, trip_id, telegram_subject_digest, verified_via, first_signed_in_at, last_signed_in_at)
     VALUES ($1, $2, $3, $4, $5, now(), now())`, [linkId, userId, tripId, digestTelegramId(String(telegramId)), GROUP_VERIFIED_VIA]);
  // And Telegram agrees: the person is in the trip's group.
  const group = groupOf.get(tripId);
  if (group) await h.telegram.member(group, telegramId, "member");
  return { userId, linkId, telegramId };
}

/** An account a REDEEMED SITE INVITE made: a member, mapped to a traveller through the invite. Optionally an email, a verified one (Google), a trip password. */
async function mkInviteAccount(
  tripId: string, username: string, name: string,
  opts: { email?: string; google?: boolean; password?: boolean; telegramIdentity?: string } = {},
) {
  const owner = (await h.pool.query("SELECT user_id FROM control_plane.trip_memberships WHERE trip_id = $1 AND role = 'owner'", [tripId])).rows[0].user_id as string;
  const userId = await h.mkUser(name);
  await h.mkMember(tripId, userId, "member", { dashboard: false, runtime: true });
  await h.pool.query(
    `INSERT INTO control_plane.site_invites(id, trip_id, created_by, intended_display_name, runtime_username, token_digest, state, expires_at, redeemed_by, redeemed_at)
     VALUES ($1, $2, $3, $4, $5, $6, 'redeemed', now() + interval '1 day', $7, now())`,
    [id("invite"), tripId, owner, name, username, sha256(randomBytes(16).toString("hex")), userId]);
  if (opts.email) {
    await h.pool.query(
      "INSERT INTO control_plane.user_identities(id, user_id, provider, provider_subject_digest, verified_at) VALUES ($1,$2,'password',$3,now())",
      [id("idnt"), userId, digestEmail(opts.email)]);
    await h.pool.query(
      "INSERT INTO control_plane.password_credentials(user_id, email_digest, password_hash) VALUES ($1,$2,$3)",
      [userId, digestEmail(opts.email), await hashPassword(PASSWORD)]);
  }
  if (opts.google) {
    await h.pool.query(
      "INSERT INTO control_plane.user_identities(id, user_id, provider, provider_subject_digest, verified_at) VALUES ($1,$2,'google',$3,now())",
      [id("idnt"), userId, sha256(`google:${id("sub")}`)]);
  }
  if (opts.telegramIdentity) {
    await h.pool.query(
      "INSERT INTO control_plane.user_identities(id, user_id, provider, provider_subject_digest, provider_subject_id, verified_at) VALUES ($1,$2,'telegram',$3,$4,now())",
      [id("idnt"), userId, digestTelegramId(opts.telegramIdentity), opts.telegramIdentity]);
  }
  if (opts.password) {
    await h.pool.query(
      "INSERT INTO control_plane.web_password_credentials(user_id, trip_id, runtime_username, password_hash) VALUES ($1,$2,$3,$4)",
      [userId, tripId, username, await hashPassword(PASSWORD)]);
  }
  return { userId };
}

/** An organizer's own account: an owner membership, an email, and a Google identity (the strongest evidence an address can have). */
async function mkOrganizerWithEmail(email: string) {
  const tripId = await h.mkTrip("Organizer's trip");
  const userId = await h.mkUser("Olive Organizer");
  await h.mkMember(tripId, userId, "owner");
  await h.pool.query("INSERT INTO control_plane.user_identities(id, user_id, provider, provider_subject_digest, verified_at) VALUES ($1,$2,'password',$3,now())", [id("idnt"), userId, digestEmail(email)]);
  await h.pool.query("INSERT INTO control_plane.user_identities(id, user_id, provider, provider_subject_digest, verified_at) VALUES ($1,$2,'google',$3,now())", [id("idnt"), userId, sha256(`google:${id("sub")}`)]);
  await h.pool.query("INSERT INTO control_plane.password_credentials(user_id, email_digest, password_hash) VALUES ($1,$2,$3)", [userId, digestEmail(email), await hashPassword(PASSWORD)]);
  return { userId, tripId };
}

const linkRows = async (userId: string) => (await h.pool.query(
  "SELECT id, token_digest, channel, telegram_link_id, expires_at, used_at, session_id, password_set_at FROM control_plane.sign_in_links WHERE user_id = $1 ORDER BY created_at", [userId])).rows;
const allLinkRows = async () => Number((await h.pool.query("SELECT count(*)::int AS n FROM control_plane.sign_in_links")).rows[0].n);
const pendingNotices = async () => (await h.pool.query(
  "SELECT id, recipient, payload, state FROM control_plane.notification_outbox WHERE notification_type = 'sign_in_link_notice' ORDER BY created_at")).rows;

/** Runs the outbox dispatcher against a recording adapter; returns what it would have said to whom. */
async function dispatch(options: { fail?: boolean; origin?: string | null } = {}) {
  const sent: { chatId: string; text: string }[] = [];
  const adapter = {
    sendApprovalRequest: async () => {},
    sendMessage: async (m: { chatId: string; text: string }) => { if (options.fail) throw new Error("telegram down"); sent.push({ chatId: m.chatId, text: m.text }); },
  };
  await dispatchPendingTripNotifications(h.pool, adapter as never, (line) => logs.push(line), { publicOrigin: options.origin === undefined ? ORIGIN : options.origin });
  // The ordinary dispatcher also sends whatever other pending rows an earlier suite left in this database: only ours are the subject here.
  return sent.filter((message) => message.text.includes("/sign-in-link#token="));
}
const tokenIn = (text: string) => {
  const found = text.match(/#token=(sl_[A-Za-z0-9_-]{43})/);
  assert.ok(found, "the link is in the message");
  return found[1]!;
};
const settle = async () => { await portalMailIdle(); };
const dropEverything = async () => {
  await h.pool.query("DELETE FROM control_plane.notification_outbox WHERE notification_type = 'sign_in_link_notice'");
  await h.pool.query("DELETE FROM control_plane.sign_in_links");
  await h.pool.query("DELETE FROM control_plane.sign_in_link_requests");
};
const slotCount = async (channel: "telegram" | "email") => Number((await h.pool.query("SELECT count(*)::int AS n FROM control_plane.sign_in_link_requests WHERE channel = $1 AND created_at > now() - interval '1 minute'", [channel])).rows[0].n);
const fillSlots = async (channel: "telegram" | "email", n: number) => {
  for (let i = 0; i < n; i++) await h.pool.query("INSERT INTO control_plane.sign_in_link_requests(channel) VALUES ($1)", [channel]);
};

describe("the migration", { skip }, () => {
  test("a link row holds a digest and nothing that can be presented; the digest is unique and shaped", async () => {
    const columns = (await h.pool.query(
      "SELECT column_name FROM information_schema.columns WHERE table_schema = 'control_plane' AND table_name = 'sign_in_links' ORDER BY ordinal_position")).rows.map((r) => r.column_name as string);
    assert.deepEqual(columns, ["id", "token_digest", "user_id", "channel", "telegram_link_id", "expires_at", "used_at", "session_id", "password_set_at", "created_at"]);
    const userId = await h.mkUser("Digest check");
    await assert.rejects(
      h.pool.query("INSERT INTO control_plane.sign_in_links(id, token_digest, user_id, channel, expires_at) VALUES ($1, 'plaintext-token', $2, 'telegram', now())", [id("sil"), userId]),
      /sign_in_links_token_digest_shape/);
    await assert.rejects(
      h.pool.query("INSERT INTO control_plane.sign_in_links(id, token_digest, user_id, channel, expires_at) VALUES ($1, $2, $3, 'sms', now())", [id("sil"), sha256("x"), userId]),
      /sign_in_links_channel_check/);
  });
});

describe("AC-14: one answer, whatever happened", { skip }, () => {
  test("found with Telegram, found with email, found with no channel, unknown email, unknown trip, ambiguous name, organizer, malformed address, rate-limited: byte-identical 202", async () => {
    await dropEverything();
    const app = newApp();
    try {
      const { tripId } = await mkTrip();
      const telegramMember = await mkClaimAccount(tripId, "dl17", "Dana Levi");
      const emailAddress = addr("noam");
      await mkInviteAccount(tripId, "nl23", "Noam Levi", { email: emailAddress, google: true });
      await mkInviteAccount(tripId, "tl31", "Tamar Levi", { password: true });
      const organizerAddress = addr("olive");
      await mkOrganizerWithEmail(organizerAddress);
      const limited = freshIp();
      for (let i = 0; i < 12; i++) await ask(app, { email: addr("burn") }, limited);

      const cases: Record<string, { body: unknown; ip?: string }> = {
        "found + Telegram (traveller name)": { body: { tripId, travellerName: "Dana Levi" } },
        "found + verified email": { body: { email: emailAddress } },
        "found, no channel": { body: { tripId, travellerName: "Tamar Levi" } },
        "unknown email": { body: { email: addr("nobody") } },
        "unknown trip": { body: { tripId: "trip_doesnotexist01", travellerName: "Dana Levi" } },
        "trip id of the wrong shape": { body: { tripId: "../../x", travellerName: "Dana Levi" } },
        "traveller not on the trip": { body: { tripId, travellerName: "Nobody Here" } },
        "ambiguous traveller name": { body: { tripId, travellerName: "Twin Person" } },
        "organizer's email": { body: { email: organizerAddress } },
        "organizer by traveller name": { body: { tripId, travellerName: "The Organizer" } },
        "an address that is not one": { body: { email: "not an address" } },
        "a site that has the person but no account": { body: { tripId, travellerName: "Ghost Member" } },
        "rate-limited (this IP has asked too often)": { body: { email: emailAddress }, ip: limited },
      };
      const seen: { name: string; status: number; body: string; headers: Record<string, unknown> }[] = [];
      for (const [name, c] of Object.entries(cases)) {
        const response = await ask(app, c.body, c.ip);
        const { date: _date, ...headers } = response.headers;
        void _date;
        seen.push({ name, status: response.statusCode, body: response.body, headers });
      }
      await settle();
      for (const one of seen) {
        assert.equal(one.status, 202, one.name);
        assert.equal(one.body, GENERIC, `${one.name}: the same body`);
        assert.deepEqual(one.headers, seen[0]!.headers, `${one.name}: the same headers (no set-cookie, no retry-after, same cache-control)`);
      }
      assert.match(String(seen[0]!.headers["cache-control"]), /no-store/);
      assert.equal(seen[0]!.headers["set-cookie"], undefined);
      // ...and the work that DID follow, follows only in the right cases.
      const notices = await pendingNotices();
      assert.equal(notices.length, 1, "one Telegram notice: the group-claim account");
      assert.equal(notices[0].recipient, String(telegramMember.telegramId));
      assert.equal(mailer.outbox.length, 1, "one email: the Google-verified address");
      assert.equal(mailer.outbox[0]!.to, emailAddress);
      assert.equal(await allLinkRows(), 2, "two links exist; nothing was made for any other case");
    } finally { await app.close(); }
  });

  test("a body that is neither { email } nor { tripId, travellerName } is refused 400 before anything runs, and a foreign Origin 403: neither depends on any account", async () => {
    const app = newApp();
    try {
      assert.equal((await ask(app, {})).statusCode, 400);
      assert.equal((await ask(app, { email: 5 })).statusCode, 400);
      assert.equal((await ask(app, { tripId: "trip_abcdefgh12" })).statusCode, 400);
      assert.equal((await ask(app, { email: "a@b.test", tripId: "trip_abcdefgh12", travellerName: "X" })).statusCode, 400, "both doors at once is not a request");
      assert.equal((await ask(app, { email: "a@b.test" }, freshIp(), { origin: "https://evil.example" })).statusCode, 403);
      assert.equal((await app.inject({ method: "POST", url: "/v1/auth/sign-in-link", payload: JSON.stringify({ email: "a@b.test" }), headers: { "content-type": "application/json" } })).statusCode, 403, "no Origin at all");
    } finally { await app.close(); }
  });

  test("the lookup, the check with the trip site and the send all happen AFTER the answer: the 202 does not wait for the site", async () => {
    await dropEverything();
    const { tripId } = await mkTrip();
    await mkClaimAccount(tripId, "dl17", "Dana Levi");
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    let asked = false;
    const app = h.newApp({
      mailer, emailAuthLog: (line) => logs.push(line),
      runtimeAccounts: { ...h.deps().runtimeAccounts, listParticipants: async () => { asked = true; await gate; return PEOPLE; } },
    });
    try {
      const response = await ask(app, { tripId, travellerName: "Dana Levi" });
      assert.equal(response.statusCode, 202, "answered while the site's participant list is still pending");
      assert.equal(response.body, GENERIC);
      assert.equal(await allLinkRows(), 0, "nothing has been written yet: the work is behind the answer");
      release();
      await settle();
      assert.ok(asked, "the site was asked, after the answer");
      assert.equal(await allLinkRows(), 1);
    } finally { release(); await app.close(); }
  });

  test("a failure behind the answer (the trip site is down, the mailer throws) changes nothing the caller sees", async () => {
    await dropEverything();
    const { tripId } = await mkTrip();
    await mkClaimAccount(tripId, "dl17", "Dana Levi");
    const emailAddress = addr("brokenmail");
    await mkInviteAccount(tripId, "nl23", "Noam Levi", { email: emailAddress, google: true });
    h.site.set(tripId, "unreachable");
    const broken: LogMailer = Object.assign(new LogMailer({ log: () => {} }), { send: async () => { throw new Error("provider down"); } });
    const app = h.newApp({ mailer: broken, emailAuthLog: (line) => logs.push(line) });
    try {
      const a = await ask(app, { tripId, travellerName: "Dana Levi" });
      const b = await ask(app, { email: emailAddress });
      await settle();
      assert.equal(a.statusCode, 202); assert.equal(a.body, GENERIC);
      assert.equal(b.statusCode, 202); assert.equal(b.body, GENERIC);
      assert.ok(logs.some((l) => l.includes("sign_in_link")), "and the failure is LOUD in the log (a code, not a name)");
    } finally { await app.close(); h.site.set(tripId, PEOPLE.map((p) => ({ ...p }))); }
  });
});

describe("AC-15: which account, which channel", { skip }, () => {
  test("a group-claim account: the link goes to the claim's private chat, as a notice that carries the link; the row holds only a digest", async () => {
    await dropEverything();
    const app = newApp();
    try {
      const { tripId } = await mkTrip();
      const person = await mkClaimAccount(tripId, "dl17", "Dana Levi", 700_000_001);
      assert.equal((await ask(app, { tripId, travellerName: "  dana   LEVI " })).statusCode, 202, "the name is matched normalised: case, spacing");
      await settle();
      const sent = await dispatch();
      assert.equal(sent.length, 1);
      assert.equal(sent[0]!.chatId, "700000001", "the private chat: a positive id, never a group");
      const token = tokenIn(sent[0]!.text);
      assert.ok(sent[0]!.text.includes(`${ORIGIN}/sign-in-link#token=`), "the link is the portal's own landing page, token in the fragment");
      assert.match(sent[0]!.text, /30 (minutes|דקות)|30/, "it says how long it lasts");
      const rows = await linkRows(person.userId);
      assert.equal(rows.length, 1);
      assert.equal(rows[0].token_digest, sha256(token));
      assert.equal(rows[0].channel, "telegram");
      assert.equal(rows[0].telegram_link_id, person.linkId, "the link remembers the group-claim link that scopes the session it will mint");
      const ttl = (rows[0].expires_at.getTime() - Date.now()) / 1000;
      assert.ok(ttl > 1800 - 60 && ttl <= 1800, `30 minutes (1800 s), got ${ttl}s`);
      // Nothing keeps the token at rest once it is sent: not the outbox row, not the table.
      const notice = (await pendingNotices())[0];
      assert.equal(notice.state, "sent");
      assert.equal(notice.recipient, null, "the chat id is blanked once sent");
      assert.equal(notice.payload, null, "and so is the payload that carried the token");
      assert.ok(!JSON.stringify(rows).includes(token));
    } finally { await app.close(); }
  });

  test("a failed send ends with the row's recipient and token blanked too, never kept for a retry that will not come", async () => {
    await dropEverything();
    const app = newApp();
    try {
      const { tripId } = await mkTrip();
      const person = await mkClaimAccount(tripId, "dl17", "Dana Levi");
      await ask(app, { tripId, travellerName: "Dana Levi" });
      await settle();
      for (let i = 0; i < 4; i++) await dispatch({ fail: true });
      const notice = (await pendingNotices())[0];
      assert.equal(notice.state, "failed");
      assert.equal(notice.recipient, null);
      assert.equal(notice.payload, null);
      // The same ending as a mail that could not be sent: nobody holds the link, so it does not stay alive for 30 minutes.
      assert.ok((await linkRows(person.userId))[0].expires_at.getTime() <= Date.now(), "the link of a message that never arrived is ended");
    } finally { await app.close(); }
  });

  test("a deployment with no public origin cannot build the link: the notices are dropped unsent, and that is said loudly", async () => {
    await dropEverything();
    const app = newApp();
    try {
      const { tripId } = await mkTrip();
      await mkClaimAccount(tripId, "dl17", "Dana Levi");
      await ask(app, { tripId, travellerName: "Dana Levi" });
      await settle();
      assert.equal((await dispatch({ origin: null })).length, 0);
      assert.ok(logs.some((line) => line.includes("sign_in_link.no_public_origin")), "the misconfiguration is in the log");
      const notice = (await pendingNotices())[0];
      assert.equal(notice.state, "skipped");
      assert.equal(notice.payload, null, "and the token is not kept");
    } finally { await app.close(); }
  });

  test("a notice nobody sent in time is not sent late: past the link's own life it is skipped and blanked", async () => {
    await dropEverything();
    const app = newApp();
    try {
      const { tripId } = await mkTrip();
      await mkClaimAccount(tripId, "dl17", "Dana Levi");
      await ask(app, { tripId, travellerName: "Dana Levi" });
      await settle();
      await h.pool.query("UPDATE control_plane.notification_outbox SET created_at = now() - interval '31 minutes' WHERE notification_type = 'sign_in_link_notice'");
      assert.equal((await dispatch()).length, 0);
      const notice = (await pendingNotices())[0];
      assert.equal(notice.state, "skipped");
      assert.equal(notice.payload, null);
    } finally { await app.close(); }
  });

  test("by email: a Google-verified address gets the mail, to the address that was typed; an unverified one (asserted at sign-up) gets nothing", async () => {
    await dropEverything();
    const app = newApp();
    try {
      const { tripId } = await mkTrip();
      const verified = addr("verified"), asserted = addr("asserted");
      const a = await mkInviteAccount(tripId, "nl23", "Noam Levi", { email: verified, google: true });
      const b = await mkInviteAccount(tripId, "tl31", "Tamar Levi", { email: asserted });
      await ask(app, { email: `  ${verified.toUpperCase()} `, language: "he" });
      await ask(app, { email: asserted });
      await settle();
      assert.equal(mailer.outbox.length, 1);
      const mail = mailer.outbox[0]!;
      assert.equal(mail.to, verified, "normalised, the way the rest of the portal's mail is");
      const token = tokenIn(mail.text);
      assert.match(mail.html, /dir="rtl"/, "Hebrew when asked for");
      assert.equal((await linkRows(a.userId))[0].token_digest, sha256(token));
      assert.equal((await linkRows(a.userId))[0].channel, "email");
      assert.equal((await linkRows(b.userId)).length, 0, "no proof the address is theirs: no link, no mail");
      assert.equal((await pendingNotices()).length, 0, "no Telegram row either");
    } finally { await app.close(); }
  });

  test("Telegram beats email when the account has both; a telegram identity's chat counts only when it is a private chat the digest proves", async () => {
    await dropEverything();
    const app = newApp();
    try {
      const { tripId } = await mkTrip();
      const both = addr("both");
      const chat = uniqueChat();
      const a = await mkInviteAccount(tripId, "nl23", "Noam Levi", { email: both, google: true, telegramIdentity: chat });
      await ask(app, { email: both });
      await settle();
      assert.equal(mailer.outbox.length, 0, "not both channels: the first that exists");
      assert.equal((await pendingNotices())[0].recipient, chat);
      assert.equal((await linkRows(a.userId))[0].channel, "telegram");

      // A group chat id in that column, or one that does not match its own digest, is no chat at all.
      await dropEverything();
      const second = addr("grp");
      const groupish = `-100${uniqueChat()}`;
      await mkInviteAccount(tripId, "tl31", "Tamar Levi", { email: second, google: true, telegramIdentity: groupish });
      await h.pool.query("UPDATE control_plane.user_identities SET provider_subject_digest = $1 WHERE provider = 'telegram' AND provider_subject_id = $2", [sha256(`somebody-else-${groupish}`), groupish]);
      await ask(app, { email: second });
      await settle();
      assert.equal((await pendingNotices()).length, 0, "never a group chat");
      assert.equal(mailer.outbox.length, 1, "so the verified email is the channel");
    } finally { await app.close(); }
  });

  test("no channel, no link: a member with no raw chat id and no verified address gets nothing, and no row is made", async () => {
    await dropEverything();
    const app = newApp();
    try {
      const { tripId } = await mkTrip();
      const person = await mkInviteAccount(tripId, "tl31", "Tamar Levi", { password: true });
      await ask(app, { tripId, travellerName: "Tamar Levi" });
      await settle();
      assert.equal((await linkRows(person.userId)).length, 0);
      assert.equal((await pendingNotices()).length, 0);
      assert.equal(mailer.outbox.length, 0);
    } finally { await app.close(); }
  });

  test("a released claim holds no chat id, so it has no channel", async () => {
    await dropEverything();
    const app = newApp();
    try {
      const { tripId } = await mkTrip();
      const person = await mkClaimAccount(tripId, "dl17", "Dana Levi");
      await h.pool.query("UPDATE control_plane.trip_participant_claims SET released_at = now(), released_reason = 'organizer_released', telegram_user_id = NULL WHERE user_id = $1", [person.userId]);
      await ask(app, { tripId, travellerName: "Dana Levi" });
      await settle();
      assert.equal(await allLinkRows(), 0);
    } finally { await app.close(); }
  });

  test("never an organizer: not through the traveller-name door, not through the email door, not an account with an organizer seat anywhere", async () => {
    await dropEverything();
    const app = newApp();
    try {
      const { tripId } = await mkTrip();
      // An organizer elsewhere who also redeemed a member invite here, with every channel an account can have.
      const mixedAddress = addr("mixed");
      const mixed = await mkInviteAccount(tripId, "nl23", "Noam Levi", { email: mixedAddress, google: true, telegramIdentity: uniqueChat() });
      const otherTrip = await h.mkTrip("Their own trip");
      await h.mkMember(otherTrip, mixed.userId, "organizer", { dashboard: false });
      // A portal account that has no trip at all is not a member either.
      const bareAddress = addr("bare");
      const bare = await h.mkUser("Bare Account");
      await h.pool.query("INSERT INTO control_plane.user_identities(id, user_id, provider, provider_subject_digest, verified_at) VALUES ($1,$2,'google',$3,now())", [id("idnt"), bare, sha256(`google:${id("s")}`)]);
      await h.pool.query("INSERT INTO control_plane.user_identities(id, user_id, provider, provider_subject_digest, verified_at) VALUES ($1,$2,'password',$3,now())", [id("idnt"), bare, digestEmail(bareAddress)]);
      // The site's own organizer and a name the site calls an organizer.
      const olive = addr("olive2");
      await mkOrganizerWithEmail(olive);
      for (const body of [{ tripId, travellerName: "Noam Levi" }, { email: mixedAddress }, { email: bareAddress }, { email: olive }, { tripId, travellerName: "The Organizer" }]) {
        const response = await ask(app, body);
        assert.equal(response.statusCode, 202);
        assert.equal(response.body, GENERIC);
      }
      await settle();
      assert.equal(await allLinkRows(), 0);
      assert.equal((await pendingNotices()).length, 0);
      assert.equal(mailer.outbox.length, 0);
    } finally { await app.close(); }
  });

  test("ambiguous or unmatched names, and a site that cannot be asked, send nothing", async () => {
    await dropEverything();
    const app = newApp();
    try {
      const { tripId } = await mkTrip();
      await mkClaimAccount(tripId, "tw1", "Twin Person");
      await mkClaimAccount(tripId, "tw2", "twin   person");
      await ask(app, { tripId, travellerName: "Twin Person" });
      await ask(app, { tripId, travellerName: "Twin" });
      await settle();
      assert.equal(await allLinkRows(), 0, "two travellers answer to that name: nobody is chosen");
      h.site.set(tripId, "unreachable");
      await mkClaimAccount(tripId, "dl17", "Dana Levi");
      await ask(app, { tripId, travellerName: "Dana Levi" });
      await settle();
      assert.equal(await allLinkRows(), 0, "an unreadable site is no answer");
      h.site.set(tripId, PEOPLE.map((p) => ({ ...p })));
    } finally { await app.close(); }
  });

  test("a retired trip, and a trip the person has no account on, send nothing", async () => {
    await dropEverything();
    const app = newApp();
    try {
      const retired = await h.mkTrip("Retired trip", { retired: true });
      const owner = await h.mkUser("Retired owner");
      await h.mkMember(retired, owner, "owner");
      h.site.set(retired, PEOPLE.map((p) => ({ ...p })));
      await mkClaimAccount(retired, "dl17", "Dana Levi");
      await ask(app, { tripId: retired, travellerName: "Dana Levi" });
      await settle();
      assert.equal(await allLinkRows(), 0);
    } finally { await app.close(); }
  });

  test("asking again ends the older link: only the newest works", async () => {
    await dropEverything();
    const app = newApp();
    try {
      const { tripId } = await mkTrip();
      const person = await mkClaimAccount(tripId, "dl17", "Dana Levi");
      await ask(app, { tripId, travellerName: "Dana Levi" });
      await settle();
      const first = tokenIn((await dispatch())[0]!.text);
      await ask(app, { tripId, travellerName: "Dana Levi" });
      await settle();
      const second = tokenIn((await dispatch())[0]!.text);
      assert.notEqual(first, second);
      assert.equal((await redeem(app, first)).statusCode, 400, "the superseded link is dead");
      assert.equal((await redeem(app, second)).statusCode, 200);
      void person;
    } finally { await app.close(); }
  });
});

describe("AC-15: opening the link", { skip }, () => {
  test("redeeming signs the person in once; the same link, an expired one, an unknown one and a malformed one are the same refusal", async () => {
    await dropEverything();
    const app = newApp();
    try {
      const { tripId } = await mkTrip();
      const address = addr("redeem");
      const person = await mkInviteAccount(tripId, "nl23", "Noam Levi", { email: address, google: true });
      await ask(app, { email: address });
      await settle();
      const token = tokenIn(mailer.outbox[0]!.text);

      // A GET, from a link previewer or a mail scanner, consumes nothing and is not a route at all.
      assert.equal((await app.inject({ method: "GET", url: `/v1/auth/sign-in-link/redeem?token=${token}` })).statusCode, 404);
      assert.equal((await linkRows(person.userId))[0].used_at, null);
      // A cross-site POST cannot sign a visitor into a chosen account.
      const foreign = await app.inject({ method: "POST", url: "/v1/auth/sign-in-link/redeem", payload: JSON.stringify({ token }), headers: { "content-type": "application/json", origin: "https://evil.example" } });
      assert.equal(foreign.statusCode, 403);
      assert.equal((await linkRows(person.userId))[0].used_at, null, "and it did not spend the link");

      const ok = await redeem(app, token);
      assert.equal(ok.statusCode, 200, ok.body);
      assert.deepEqual(Object.keys(ok.json()).sort(), ["appPath", "canSetPassword"]);
      assert.equal(ok.json().appPath, "/trips");
      assert.equal(ok.json().canSetPassword, true);
      const session = sessionOf(ok);
      const me = await app.inject({ method: "GET", url: "/v1/me", headers: { cookie: session.cookie } });
      assert.equal(me.statusCode, 200);
      assert.equal(me.json().id, person.userId);
      assert.equal(me.json().scope, "full", "an email account's link signs in like its password does");

      // The cookies are the password sign-in's, attribute for attribute.
      const password = await emailPasswordLogin(app, address, PASSWORD);
      assert.equal(password.statusCode, 200);
      const shape = (r: { headers: Record<string, unknown> }) => ([] as string[]).concat(r.headers["set-cookie"] as string[]).map((c) => c.replace(/=[^;]*/, "=…")).sort();
      assert.deepEqual(shape(ok), shape(password));

      const used = (await linkRows(person.userId))[0];
      assert.ok(used.used_at);
      assert.ok(used.session_id);

      await h.pool.query("INSERT INTO control_plane.sign_in_links(id, token_digest, user_id, channel, expires_at) VALUES ($1, $2, $3, 'email', now() - interval '1 second')", [id("sil"), sha256("sl_expired0000000000000000000000000000000000000"), person.userId]);
      const refusals = [
        await redeem(app, token),                                                          // used
        await redeem(app, "sl_expired0000000000000000000000000000000000000"),               // expired
        await redeem(app, `sl_${randomBytes(32).toString("base64url")}`),                  // unknown, well formed
        await redeem(app, "garbage"), await redeem(app, ""), await redeem(app, 42), await redeem(app, `sl_${"A".repeat(500)}`),
      ];
      for (const r of refusals) {
        assert.equal(r.statusCode, 400);
        assert.equal(r.body, refusals[0]!.body, "the same words for every reason");
        assert.equal(r.headers["set-cookie"], undefined);
      }
      assert.equal(refusals[0]!.json().error, "TOKEN_INVALID");
    } finally { await app.close(); }
  });

  test("two redemptions at once: exactly one wins", async () => {
    await dropEverything();
    const app = newApp();
    try {
      const { tripId } = await mkTrip();
      await mkClaimAccount(tripId, "dl17", "Dana Levi");
      await ask(app, { tripId, travellerName: "Dana Levi" });
      await settle();
      const token = tokenIn((await dispatch())[0]!.text);
      const both = await Promise.all([redeem(app, token), redeem(app, token)]);
      assert.deepEqual(both.map((r) => r.statusCode).sort(), [200, 400]);
    } finally { await app.close(); }
  });

  test("a group-claim account's session is the claim's own SCOPED session: not full, not able to set a password, ended with the claim", async () => {
    await dropEverything();
    const app = newApp();
    try {
      const { tripId } = await mkTrip();
      const person = await mkClaimAccount(tripId, "dl17", "Dana Levi");
      await ask(app, { tripId, travellerName: "Dana Levi" });
      await settle();
      const token = tokenIn((await dispatch())[0]!.text);
      const ok = await redeem(app, token);
      assert.equal(ok.statusCode, 200, ok.body);
      assert.equal(ok.json().canSetPassword, false, "a claimed account has no credential, and none is created: that is what the personal invite is for");
      const session = sessionOf(ok);
      const stored = (await h.pool.query("SELECT token_digest, telegram_link_id FROM control_plane.web_sessions WHERE user_id = $1 AND revoked_at IS NULL", [person.userId])).rows;
      assert.equal(stored.length, 1);
      assert.equal(stored[0].telegram_link_id, person.linkId);
      assert.equal(stored[0].token_digest, scopedSessionDigest(cookieOf(ok, "kit_session")!), "stored under the scoped digest, which no older release can match");
      const me = await app.inject({ method: "GET", url: "/v1/me", headers: { cookie: session.cookie } });
      assert.equal(me.json().scope, "telegram");
      const trips = await app.inject({ method: "GET", url: "/v1/trips", headers: { cookie: session.cookie } });
      assert.deepEqual((trips.json() as { trips?: { id: string }[] }).trips?.map((t) => t.id) ?? (trips.json() as { id: string }[]).map((t) => t.id), [tripId]);
      const refused = await setPassword(app, session, NEW_PASSWORD);
      assert.equal(refused.statusCode, 403, "a scoped session may not set a password");
      assert.equal(Number((await h.pool.query("SELECT count(*)::int AS n FROM control_plane.web_password_credentials WHERE user_id = $1", [person.userId])).rows[0].n), 0, "no credential was created");
      assert.equal(Number((await h.pool.query("SELECT count(*)::int AS n FROM control_plane.password_credentials WHERE user_id = $1", [person.userId])).rows[0].n), 0);
    } finally { await app.close(); }
  });

  test("a link whose group claim ended before it was opened is refused like any dead link", async () => {
    await dropEverything();
    const app = newApp();
    try {
      const { tripId } = await mkTrip();
      const person = await mkClaimAccount(tripId, "dl17", "Dana Levi");
      await ask(app, { tripId, travellerName: "Dana Levi" });
      await settle();
      const token = tokenIn((await dispatch())[0]!.text);
      await h.pool.query("UPDATE control_plane.telegram_member_links SET revoked_at = now(), revoked_reason = 'left_group' WHERE id = $1", [person.linkId]);
      const response = await redeem(app, token);
      assert.equal(response.statusCode, 400);
      assert.equal(response.json().error, "TOKEN_INVALID");
      assert.equal(Number((await h.pool.query("SELECT count(*)::int AS n FROM control_plane.web_sessions WHERE user_id = $1", [person.userId])).rows[0].n), 0, "no session was minted");
    } finally { await app.close(); }
  });

  test("an account that became an organizer after the link was sent, or was disabled, is refused", async () => {
    await dropEverything();
    const app = newApp();
    try {
      const { tripId } = await mkTrip();
      const a = await mkClaimAccount(tripId, "dl17", "Dana Levi");
      const b = await mkClaimAccount(tripId, "nl23", "Noam Levi");
      await ask(app, { tripId, travellerName: "Dana Levi" });
      await ask(app, { tripId, travellerName: "Noam Levi" });
      await settle();
      const sent = await dispatch();
      assert.equal(sent.length, 2);
      const tokens = new Map(sent.map((s) => [s.chatId, tokenIn(s.text)]));
      const elsewhere = await h.mkTrip("Elsewhere");
      await h.mkMember(elsewhere, a.userId, "organizer", { dashboard: false });
      await h.pool.query("UPDATE control_plane.users SET status = 'suspended' WHERE id = $1", [b.userId]);
      assert.equal((await redeem(app, tokens.get(String(a.telegramId))!)).statusCode, 400);
      assert.equal((await redeem(app, tokens.get(String(b.telegramId))!)).statusCode, 400);
      // A refusal spends the link: lifting the suspension within the 30 minutes does not bring it back to life.
      assert.ok((await linkRows(b.userId))[0].used_at, "the suspended account's link is spent");
      await h.pool.query("UPDATE control_plane.users SET status = 'active' WHERE id = $1", [b.userId]);
      assert.equal((await redeem(app, tokens.get(String(b.telegramId))!)).statusCode, 400, "and stays refused once the account is active again");
    } finally { await app.close(); }
  });

  test("setting a new password: once, only for the session the link minted, replacing the credential the account already has, and ending its other sessions", async () => {
    await dropEverything();
    const app = newApp();
    try {
      const { tripId } = await mkTrip();
      const address = addr("pw");
      const person = await mkInviteAccount(tripId, "nl23", "Noam Levi", { email: address, google: true, password: true });
      const elsewhere = await h.webSession(person.userId, "other-device");
      await ask(app, { email: address });
      await settle();
      const ok = await redeem(app, tokenIn(mailer.outbox[0]!.text));
      assert.equal(ok.statusCode, 200);
      const session = sessionOf(ok);
      const credentialRowsBefore = Number((await h.pool.query("SELECT (SELECT count(*) FROM control_plane.password_credentials WHERE user_id = $1) + (SELECT count(*) FROM control_plane.web_password_credentials WHERE user_id = $1) AS n", [person.userId])).rows[0].n);

      assert.equal((await setPassword(app, session, "short")).statusCode, 400, "too short, refused before anything is spent");
      assert.equal((await setPassword(app, session, 12345)).statusCode, 400);
      assert.equal((await setPassword(app, { cookie: elsewhere.cookie, csrf: elsewhere.csrf }, NEW_PASSWORD)).statusCode, 403, "a session the link did not mint cannot use the link's one password step");
      assert.equal((await setPassword(app, { cookie: session.cookie, csrf: "wrong" }, NEW_PASSWORD)).statusCode, 403, "CSRF is checked");

      const done = await setPassword(app, session, NEW_PASSWORD);
      assert.equal(done.statusCode, 200, done.body);
      assert.equal((await emailPasswordLogin(app, address, PASSWORD)).statusCode, 401, "the old password is gone");
      assert.equal((await emailPasswordLogin(app, address, NEW_PASSWORD)).statusCode, 200, "the new one works on the email account's credential");
      const trip = await app.inject({
        method: "POST", url: "/v1/auth/password", remoteAddress: freshIp(), payload: JSON.stringify({ tripId, runtimeUsername: "nl23", password: NEW_PASSWORD }),
        headers: { "content-type": "application/json", origin: ORIGIN },
      });
      assert.equal(trip.statusCode, 200, "and on the trip password the member signs in with: both are replaced, neither is created");
      const credentialRowsAfter = Number((await h.pool.query("SELECT (SELECT count(*) FROM control_plane.password_credentials WHERE user_id = $1) + (SELECT count(*) FROM control_plane.web_password_credentials WHERE user_id = $1) AS n", [person.userId])).rows[0].n);
      assert.equal(credentialRowsAfter, credentialRowsBefore, "no second credential path");
      assert.equal((await app.inject({ method: "GET", url: "/v1/me", headers: { cookie: elsewhere.cookie } })).statusCode, 401, "the other device was signed out");
      assert.equal((await app.inject({ method: "GET", url: "/v1/me", headers: { cookie: session.cookie } })).statusCode, 200, "this one was not");
      assert.equal((await setPassword(app, session, "yet another passphrase")).statusCode, 409, "the step is once only");
      assert.equal((await emailPasswordLogin(app, address, NEW_PASSWORD)).statusCode, 200, "and the second attempt changed nothing");
    } finally { await app.close(); }
  });

  test("an account with no credential of its own is told so, and is never given one", async () => {
    await dropEverything();
    const app = newApp();
    try {
      const { tripId } = await mkTrip();
      const address = addr("nocred");
      const person = await mkInviteAccount(tripId, "nl23", "Noam Levi", { google: true });
      await h.pool.query("INSERT INTO control_plane.user_identities(id, user_id, provider, provider_subject_digest, verified_at) VALUES ($1,$2,'password',$3,now())", [id("idnt"), person.userId, digestEmail(address)]);
      await ask(app, { email: address });
      await settle();
      const ok = await redeem(app, tokenIn(mailer.outbox[0]!.text));
      assert.equal(ok.statusCode, 200);
      assert.equal(ok.json().canSetPassword, false);
      assert.equal((await setPassword(app, sessionOf(ok), NEW_PASSWORD)).statusCode, 409);
      assert.equal(Number((await h.pool.query("SELECT count(*)::int AS n FROM control_plane.password_credentials WHERE user_id = $1", [person.userId])).rows[0].n), 0);
    } finally { await app.close(); }
  });
});

describe("AC-16: limits are silent", { skip }, () => {
  test("per account: three links an hour; past that the answer is the same 202 and nothing more is sent", async () => {
    await dropEverything();
    const app = newApp();
    try {
      const { tripId } = await mkTrip();
      const person = await mkClaimAccount(tripId, "dl17", "Dana Levi");
      const answers: string[] = [];
      for (let i = 0; i < 6; i++) {
        const response = await ask(app, { tripId, travellerName: "Dana Levi" });
        answers.push(`${response.statusCode} ${response.body}`);
        await settle();
      }
      assert.equal(new Set(answers).size, 1, "every answer identical");
      assert.equal((await linkRows(person.userId)).length, 3);
      assert.equal((await pendingNotices()).length, 3);
    } finally { await app.close(); }
  });

  test("per IP: the 10th admitted request from one address is served and the 11th is not; unknown accounts spend the allowance exactly as real ones do", async () => {
    await dropEverything();
    const app = newApp();
    try {
      const { tripId } = await mkTrip();
      const first = await mkClaimAccount(tripId, "dl17", "Dana Levi");
      const second = await mkClaimAccount(tripId, "nl23", "Noam Levi");
      const ip = freshIp();
      const answers: string[] = [];
      for (let i = 0; i < 9; i++) { const r = await ask(app, { email: addr(`ghost${i}`) }, ip); answers.push(`${r.statusCode} ${r.body}`); }
      const tenth = await ask(app, { tripId, travellerName: "Dana Levi" }, ip);
      const eleventh = await ask(app, { tripId, travellerName: "Noam Levi" }, ip);
      answers.push(`${tenth.statusCode} ${tenth.body}`, `${eleventh.statusCode} ${eleventh.body}`);
      await settle();
      assert.equal(new Set(answers).size, 1, "all eleven answers identical");
      assert.equal((await linkRows(first.userId)).length, 1, "the 10th request was served");
      assert.equal((await linkRows(second.userId)).length, 0, "the 11th was not: nothing sent");
      assert.equal((await ask(app, { tripId, travellerName: "Noam Levi" }, freshIp())).body, GENERIC);
      await settle();
      assert.equal((await linkRows(second.userId)).length, 1, "another address is not affected");
    } finally { await app.close(); }
  });

  test("per channel, Telegram: a ceiling of 30 requests a minute: the 30th is served, the 31st is not, and the email channel is a count of its own", async () => {
    await dropEverything();
    const app = newApp();
    try {
      const { tripId } = await mkTrip();
      await fillSlots("telegram", 28);
      const a = await mkClaimAccount(tripId, "dl17", "Dana Levi");
      const b = await mkClaimAccount(tripId, "nl23", "Noam Levi");
      const c = await mkClaimAccount(tripId, "tl31", "Tamar Levi");
      const answers = [];
      for (const name of ["Dana Levi", "Noam Levi", "Tamar Levi"]) { const r = await ask(app, { tripId, travellerName: name }); answers.push(`${r.statusCode} ${r.body}`); await settle(); }
      assert.equal(new Set(answers).size, 1);
      assert.equal((await linkRows(a.userId)).length, 1, "slot 29");
      assert.equal((await linkRows(b.userId)).length, 1, "slot 30");
      assert.equal((await linkRows(c.userId)).length, 0, "the ceiling is full: silent, nothing sent");
      assert.equal(await slotCount("telegram"), 30, "a refused request takes no slot of its own");
      assert.equal(await slotCount("email"), 0, "a name-door request is never an email");
    } finally { await app.close(); }
  });

  test("per channel, email: a ceiling of 20 requests a minute: the 20th is served, the 21st is not", async () => {
    await dropEverything();
    const app = newApp();
    try {
      const { tripId } = await mkTrip();
      await fillSlots("email", 19);
      const one = addr("e1"), two = addr("e2");
      const a = await mkInviteAccount(tripId, "nl23", "Noam Levi", { email: one, google: true });
      const b = await mkInviteAccount(tripId, "tl31", "Tamar Levi", { email: two, google: true });
      const answers = [];
      for (const email of [one, two]) { const r = await ask(app, { email }); answers.push(`${r.statusCode} ${r.body}`); await settle(); }
      assert.equal(new Set(answers).size, 1);
      assert.equal((await linkRows(a.userId)).length, 1, "the 20th");
      assert.equal((await linkRows(b.userId)).length, 0, "the 21st: the ceiling is full");
      assert.equal(mailer.outbox.length, 1);
    } finally { await app.close(); }
  });

  test("which ceilings a request takes does not depend on the account: a name-door request takes one Telegram slot, an email-door request one Telegram and one email slot, found or not, with or without a channel, organizer or not", async () => {
    await dropEverything();
    const app = newApp();
    try {
      const { tripId } = await mkTrip();
      await mkClaimAccount(tripId, "dl17", "Dana Levi");
      await mkInviteAccount(tripId, "tl31", "Tamar Levi", { password: true });
      const google = addr("g"), asserted = addr("a"), organizer = addr("o");
      await mkInviteAccount(tripId, "nl23", "Noam Levi", { email: google, google: true });
      await mkInviteAccount(tripId, "ghost", "Ghost Member", { email: asserted });
      await mkOrganizerWithEmail(organizer);
      const nameDoor = [{ tripId, travellerName: "Dana Levi" }, { tripId, travellerName: "Tamar Levi" }, { tripId, travellerName: "Nobody Here" }, { tripId, travellerName: "The Organizer" }, { tripId: "trip_doesnotexist01", travellerName: "Dana Levi" }];
      const emailDoor = [{ email: google }, { email: asserted }, { email: addr("nobody") }, { email: organizer }];
      for (const [door, bodies, perRequest] of [["name", nameDoor, { telegram: 1, email: 0 }], ["email", emailDoor, { telegram: 1, email: 1 }]] as const) {
        for (const body of bodies) {
          await h.pool.query("DELETE FROM control_plane.sign_in_link_requests");
          await h.pool.query("DELETE FROM control_plane.sign_in_links");
          await ask(app, body);
          await settle();
          assert.deepEqual({ telegram: await slotCount("telegram"), email: await slotCount("email") }, perRequest, `${door} door, ${JSON.stringify(body).slice(0, 50)}`);
        }
      }
    } finally { await app.close(); }
  });
});

describe("AC-16: the ceilings are not an account-existence oracle (the boundary reviewer's probe)", { skip }, () => {
  // The probe: fill a ceiling to N-1, send a GUESS, then ask for the attacker's OWN link. Before the fix the guess took the last slot
  // only if it qualified, so the attacker's own link arrived only when the guess did NOT. Now every admitted request takes its slot
  // whatever it finds, so the attacker's own outcome is the same for every candidate.
  const KINDS = ["member with a channel", "member without a channel", "no account", "organizer"] as const;
  type Door = "name" | "email";

  async function probe(door: Door, kind: (typeof KINDS)[number], fillTo: number): Promise<number> {
    await dropEverything();
    const app = newApp();
    try {
      const { tripId } = await mkTrip();
      const ownAddress = addr("attacker");
      // The attacker's own account: reachable on the very channel whose ceiling is being probed.
      const own = door === "name"
        ? await mkClaimAccount(tripId, "ghost", "Ghost Member")
        : await mkInviteAccount(tripId, "ghost", "Ghost Member", { email: ownAddress, google: true });
      let guess: Record<string, unknown>;
      if (door === "name") {
        if (kind === "member with a channel") { await mkClaimAccount(tripId, "dl17", "Dana Levi"); guess = { tripId, travellerName: "Dana Levi" }; }
        else if (kind === "member without a channel") { await mkInviteAccount(tripId, "tl31", "Tamar Levi", { password: true }); guess = { tripId, travellerName: "Tamar Levi" }; }
        else if (kind === "no account") guess = { tripId, travellerName: "Nobody At All" };
        else guess = { tripId, travellerName: "The Organizer" };
      } else if (kind === "member with a channel") { const a = addr("w"); await mkInviteAccount(tripId, "nl23", "Noam Levi", { email: a, google: true }); guess = { email: a }; }
      else if (kind === "member without a channel") { const a = addr("x"); await mkInviteAccount(tripId, "tl31", "Tamar Levi", { email: a }); guess = { email: a }; }
      else if (kind === "no account") guess = { email: addr("nobody") };
      else { const a = addr("org"); await mkOrganizerWithEmail(a); guess = { email: a }; }
      // The ceiling the attacker's own channel runs on: Telegram for the name door, email for the email door.
      await fillSlots(door === "name" ? "telegram" : "email", fillTo);
      await ask(app, guess);
      await settle();
      await ask(app, door === "name" ? { tripId, travellerName: "Ghost Member" } : { email: ownAddress });
      await settle();
      return (await linkRows(own.userId)).length;
    } finally { await app.close(); }
  }

  for (const door of ["name", "email"] as const) {
    test(`${door} door: with the ceiling one short of full, the attacker's own request ends the same way whatever the guess was`, async () => {
      const ceiling = door === "name" ? 30 : 20;
      const outcomes = new Map<string, number>();
      for (const kind of KINDS) outcomes.set(kind, await probe(door, kind, ceiling - 1));
      assert.deepEqual([...outcomes.values()], [0, 0, 0, 0], `the guess used the last slot in every case, so the attacker's own link never arrives: ${JSON.stringify([...outcomes])}`);
    });
    test(`${door} door, control: with two slots left both requests are served for every guess (the probe measures the ceiling, not something else)`, async () => {
      const ceiling = door === "name" ? 30 : 20;
      const outcomes = new Map<string, number>();
      for (const kind of KINDS) outcomes.set(kind, await probe(door, kind, ceiling - 2));
      assert.deepEqual([...outcomes.values()], [1, 1, 1, 1], JSON.stringify([...outcomes]));
    });
  }

  test("the per-account allowance is keyed on the target and shared with nobody: asking for a victim's link three times changes nothing about another account's", async () => {
    await dropEverything();
    const app = newApp();
    try {
      const { tripId } = await mkTrip();
      const victim = await mkClaimAccount(tripId, "dl17", "Dana Levi");
      const own = await mkClaimAccount(tripId, "ghost", "Ghost Member");
      for (let i = 0; i < 3; i++) { await ask(app, { tripId, travellerName: "Dana Levi" }); await settle(); }
      assert.equal((await linkRows(victim.userId)).length, 3);
      await ask(app, { tripId, travellerName: "Ghost Member" });
      await settle();
      assert.equal((await linkRows(own.userId)).length, 1, "the attacker's own request is served as if the victim did not exist");
    } finally { await app.close(); }
  });
});

describe("nothing identifies a person, a chat or a link in a log", { skip }, () => {
  test("across every case above and the dispatcher, no log line holds an address, a name, a token, a chat id or a link", async () => {
    await dropEverything();
    logs.length = 0;
    const app = newApp();
    try {
      const { tripId } = await mkTrip();
      const address = addr("quiet");
      await mkClaimAccount(tripId, "dl17", "Dana Levi", 710_000_123);
      await mkInviteAccount(tripId, "nl23", "Noam Levi", { email: address, google: true });
      await ask(app, { tripId, travellerName: "Dana Levi" });
      await ask(app, { email: address });
      await ask(app, { email: addr("nobody") });
      await settle();
      const sent = await dispatch();
      const token = tokenIn(sent[0]!.text);
      await redeem(app, token);
      await redeem(app, token);
      const everything = [...logs, ...h.logs].join("\n");
      for (const secret of [address, "Dana Levi", "Noam Levi", token, "710000123", "sign-in-link#token", tripId]) {
        assert.ok(!everything.includes(secret), `the logs do not contain ${secret.slice(0, 6)}…`);
      }
    } finally { await app.close(); }
  });
});

describe("the routes are classified", { skip }, () => {
  test("portal-scope names all three: the request and the redemption read no session, the password step is account-level", () => {
    assert.equal(PORTAL_SCOPE_POLICY["POST /v1/auth/sign-in-link"], "open");
    assert.equal(PORTAL_SCOPE_POLICY["POST /v1/auth/sign-in-link/redeem"], "open");
    assert.equal(PORTAL_SCOPE_POLICY["POST /v1/auth/sign-in-link/password"], "account");
  });
});

// ── Rework round 1 ──────────────────────────────────────────────────────────

describe("a group claimant's link is held to the Mini App's own gate (the switch, and a live seat in the group)", { skip }, () => {
  async function issued() {
    await dropEverything();
    const app = newApp();
    const { tripId } = await mkTrip();
    const person = await mkClaimAccount(tripId, "dl17", "Dana Levi");
    await ask(app, { tripId, travellerName: "Dana Levi" });
    await settle();
    const token = tokenIn((await dispatch())[0]!.text);
    return { app, tripId, person, token, group: groupOf.get(tripId)! };
  }
  const claimLive = async (userId: string) => Number((await h.pool.query("SELECT count(*)::int AS n FROM control_plane.trip_participant_claims WHERE user_id = $1 AND released_at IS NULL", [userId])).rows[0].n) === 1;
  const liveSessions = async (userId: string) => Number((await h.pool.query("SELECT count(*)::int AS n FROM control_plane.web_sessions WHERE user_id = $1 AND revoked_at IS NULL", [userId])).rows[0].n);

  test("`member_group_sign_in` OFF: redemption is the one refusal, no Telegram call, no session left, nothing revoked, the link NOT spent (it works when the switch is back on)", async () => {
    const { app, tripId, person, token } = await issued();
    try {
      await h.switchOn(tripId, false);
      const before = await h.telegram.calls("getChatMember");
      const refused = await redeem(app, token);
      assert.equal(refused.statusCode, 400);
      assert.equal(refused.body, JSON.stringify({ error: "TOKEN_INVALID" }));
      assert.equal(refused.headers["set-cookie"], undefined);
      assert.equal(await h.telegram.calls("getChatMember"), before, "no getChatMember while the group switch is off");
      assert.equal(await liveSessions(person.userId), 0, "the session minted for the check is ended");
      assert.ok(await claimLive(person.userId), "nothing was revoked");
      assert.equal((await linkRows(person.userId))[0].used_at, null, "the link is not spent");
      await h.switchOn(tripId, true);
      assert.equal((await redeem(app, token)).statusCode, 200, "and opens once the switch is back on");
    } finally { await app.close(); }
  });

  test("the person LEFT the group: refused, and the claim, its link, sessions and membership end exactly as at a Mini App launch; Telegram was asked once", async () => {
    const { app, person, token, group } = await issued();
    try {
      await h.telegram.member(group, person.telegramId, "left");
      const before = await h.telegram.calls("getChatMember");
      const refused = await redeem(app, token);
      assert.equal(refused.statusCode, 400);
      assert.equal(refused.body, JSON.stringify({ error: "TOKEN_INVALID" }));
      assert.equal(refused.headers["set-cookie"], undefined);
      assert.equal(await h.telegram.calls("getChatMember"), before + 1);
      assert.ok(!(await claimLive(person.userId)), "the claim ended");
      const link = (await h.pool.query("SELECT revoked_reason FROM control_plane.telegram_member_links WHERE id = $1", [person.linkId])).rows[0];
      assert.equal(link.revoked_reason, "left_group");
      assert.equal(await liveSessions(person.userId), 0);
      assert.equal((await h.pool.query("SELECT status FROM control_plane.trip_memberships WHERE user_id = $1", [person.userId])).rows[0].status, "revoked");
    } finally { await app.close(); }
  });

  test("Telegram UNREACHABLE: no session, nothing revoked, the link is not spent, and the answer is the retryable one the Mini App launch gives", async () => {
    const { app, person, token, group } = await issued();
    try {
      await h.telegram.member(group, person.telegramId, "member", { mode: "error" });
      const down = await redeem(app, token);
      assert.equal(down.statusCode, 503);
      assert.deepEqual(down.json(), { error: "MEMBERSHIP_CHECK_UNAVAILABLE", retryable: true });
      assert.equal(down.headers["retry-after"], "5");
      assert.equal(down.headers["set-cookie"], undefined);
      assert.equal(await liveSessions(person.userId), 0);
      assert.ok(await claimLive(person.userId));
      assert.equal((await linkRows(person.userId))[0].used_at, null);
      await h.telegram.member(group, person.telegramId, "member");
      const ok = await redeem(app, token);
      assert.equal(ok.statusCode, 200, "the same link works once Telegram answers");
      assert.equal((await app.inject({ method: "GET", url: "/v1/me", headers: { cookie: asCookie(ok) } })).json().scope, "telegram");
    } finally { await app.close(); }
  });

  test("a live seat and the switch on: the session is minted, and it is the claim's scoped one (the control for the three refusals above)", async () => {
    const { app, person, token } = await issued();
    try {
      const ok = await redeem(app, token);
      assert.equal(ok.statusCode, 200);
      assert.equal(await liveSessions(person.userId), 1);
    } finally { await app.close(); }
  });

  test("at ISSUE time too: a claimant whose group switch is off, or who is not in the group, is sent nothing (the same 202), and nothing is revoked by asking", async () => {
    await dropEverything();
    const app = newApp();
    try {
      const { tripId } = await mkTrip();
      const off = await mkClaimAccount(tripId, "dl17", "Dana Levi");
      const gone = await mkClaimAccount(tripId, "nl23", "Noam Levi");
      await h.telegram.member(groupOf.get(tripId)!, gone.telegramId, "left");
      await h.switchOn(tripId, false);
      const a = await ask(app, { tripId, travellerName: "Dana Levi" });
      await settle();
      await h.switchOn(tripId, true);
      const b = await ask(app, { tripId, travellerName: "Noam Levi" });
      await settle();
      assert.equal(a.body, GENERIC); assert.equal(b.body, GENERIC);
      assert.equal(await allLinkRows(), 0);
      assert.equal((await pendingNotices()).length, 0);
      assert.ok(await claimLive(gone.userId) && await claimLive(off.userId), "issuing is not a launch: nothing was ended");
    } finally { await app.close(); }
  });
});

describe("the switch `member_sign_in_link` (ships OFF)", { skip }, () => {
  test("the name door works only when the switch is on for THAT trip; off, unset and another trip's setting give the same 202, nothing done, and take the same ceiling slot", async () => {
    await dropEverything();
    const app = newApp();
    try {
      const { tripId } = await mkTrip();
      const other = await mkTrip();
      const person = await mkClaimAccount(tripId, "dl17", "Dana Levi");
      const slotsBefore = await slotCount("telegram");
      await setSwitch(tripId, false);
      const off = await ask(app, { tripId, travellerName: "Dana Levi" });
      await settle();
      assert.equal(off.statusCode, 202); assert.equal(off.body, GENERIC);
      assert.equal((await linkRows(person.userId)).length, 0, "off: nothing done");
      assert.equal(await slotCount("telegram"), slotsBefore + 1, "and it took its slot like any request");
      await h.pool.query("DELETE FROM control_plane.feature_switch_settings WHERE switch = 'member_sign_in_link' AND trip_id = $1", [tripId]);
      await setSwitch(null, false);
      await setSwitch(other.tripId, true);
      const unset = await ask(app, { tripId, travellerName: "Dana Levi" });
      await settle();
      assert.equal(unset.body, GENERIC);
      assert.equal((await linkRows(person.userId)).length, 0, "unset for this trip (another trip being on does not count): off");
      assert.equal(await slotCount("telegram"), slotsBefore + 2);
      await setSwitch(tripId, true);
      await ask(app, { tripId, travellerName: "Dana Levi" });
      await settle();
      assert.equal((await linkRows(person.userId)).length, 1, "on for the trip: served");
    } finally { await setSwitch(null, true); await app.close(); }
  });

  test("the email door has no trip, so it works only at the \"every trip\" level: a trip's own setting does not open it", async () => {
    await dropEverything();
    const app = newApp();
    try {
      const { tripId } = await mkTrip();
      const address = addr("gated");
      const person = await mkInviteAccount(tripId, "nl23", "Noam Levi", { email: address, google: true });
      await setSwitch(null, false);
      await setSwitch(tripId, true);
      const off = await ask(app, { email: address });
      await settle();
      assert.equal(off.body, GENERIC);
      assert.equal((await linkRows(person.userId)).length, 0);
      assert.equal(mailer.outbox.length, 0);
      assert.equal(await slotCount("email"), 1, "it still took its email slot");
      await setSwitch(null, true);
      await ask(app, { email: address });
      await settle();
      assert.equal((await linkRows(person.userId)).length, 1);
    } finally { await setSwitch(null, true); await app.close(); }
  });

  test("capabilities says whether the feature is available at the \"every trip\" level, to anyone, and says nothing about a single trip", async () => {
    await dropEverything();
    const app = newApp();
    try {
      const { tripId } = await mkTrip();
      const caps = async () => (await app.inject({ method: "GET", url: "/v1/auth/capabilities" })).json() as { signInLink?: boolean };
      assert.equal((await caps()).signInLink, true, "on at the every-trip level");
      await setSwitch(null, false);
      assert.equal((await caps()).signInLink, false, "off");
      await setSwitch(tripId, true);
      assert.equal((await caps()).signInLink, false, "one trip being on is not 'available at all': it does not leak, and does not show");
      await h.pool.query("DELETE FROM control_plane.feature_switch_settings WHERE switch = 'member_sign_in_link'");
      assert.equal((await caps()).signInLink, false, "unset is off");
    } finally { await setSwitch(null, true); await app.close(); }
  });

  test("a link issued while the switch was on stays redeemable for its 30 minutes after it goes off, and so does its one password step (only a claimant's follows the group gate)", async () => {
    await dropEverything();
    const app = newApp();
    try {
      const { tripId } = await mkTrip();
      const address = addr("later");
      const person = await mkInviteAccount(tripId, "nl23", "Noam Levi", { email: address, google: true, password: true });
      await ask(app, { email: address });
      await settle();
      const token = tokenIn(mailer.outbox[0]!.text);
      await setSwitch(null, false);
      await setSwitch(tripId, false);
      const ok = await redeem(app, token);
      assert.equal(ok.statusCode, 200, ok.body);
      assert.equal((await setPassword(app, sessionOf(ok), NEW_PASSWORD)).statusCode, 200);
      void person;
    } finally { await setSwitch(null, true); await app.close(); }
  });
});

describe("housekeeping", { skip }, () => {
  test("every admitted request purges what has outlived its use: links and slots, and a pending notice that nobody sent in 30 minutes is blanked (a deployment with no dispatcher keeps no token)", async () => {
    await dropEverything();
    const app = newApp();
    try {
      const { tripId } = await mkTrip();
      const old = await mkClaimAccount(tripId, "dl17", "Dana Levi");
      await ask(app, { tripId, travellerName: "Dana Levi" });
      await settle();
      await h.pool.query("UPDATE control_plane.notification_outbox SET created_at = now() - interval '31 minutes' WHERE notification_type = 'sign_in_link_notice'");
      await h.pool.query("UPDATE control_plane.sign_in_links SET created_at = now() - interval '3 days'");
      await h.pool.query("INSERT INTO control_plane.sign_in_link_requests(channel, created_at) VALUES ('telegram', now() - interval '3 hours')");
      await ask(app, { email: addr("anyone") });
      await settle();
      const notice = (await pendingNotices())[0];
      assert.equal(notice.state, "skipped");
      assert.equal(notice.payload, null, "the plaintext token is gone though no dispatcher ran");
      assert.equal(notice.recipient, null);
      assert.equal((await linkRows(old.userId)).length, 0, "rows older than two days are deleted");
      assert.equal(Number((await h.pool.query("SELECT count(*)::int AS n FROM control_plane.sign_in_link_requests WHERE created_at < now() - interval '1 hour'")).rows[0].n), 0, "and so are slots older than an hour");
    } finally { await app.close(); }
  });
});

describe("cookies under an https origin", { skip }, () => {
  test("the redemption's cookies and the password sign-in's are attribute-for-attribute the same, Secure included", async () => {
    await dropEverything();
    const origin = "https://portal.example.test";
    const app = h.newApp({ mailer, emailAuthLog: (line) => logs.push(line), publicOrigin: origin });
    try {
      const { tripId } = await mkTrip();
      const address = addr("https");
      await mkInviteAccount(tripId, "nl23", "Noam Levi", { email: address, google: true });
      await app.inject({ method: "POST", url: "/v1/auth/sign-in-link", remoteAddress: freshIp(), payload: JSON.stringify({ email: address }), headers: { "content-type": "application/json", origin } });
      await settle();
      const token = tokenIn(mailer.outbox[0]!.text);
      assert.ok(mailer.outbox[0]!.text.includes(`${origin}/sign-in-link#token=`), "the link uses the https origin");
      const post = (url: string, body: unknown) => app.inject({ method: "POST", url, remoteAddress: freshIp(), payload: JSON.stringify(body), headers: { "content-type": "application/json", origin } });
      const link = await post("/v1/auth/sign-in-link/redeem", { token });
      const password = await post("/v1/auth/email-password", { email: address, password: PASSWORD });
      assert.equal(link.statusCode, 200); assert.equal(password.statusCode, 200);
      const shape = (r: { headers: Record<string, unknown> }) => ([] as string[]).concat(r.headers["set-cookie"] as string[]).map((c) => c.replace(/=[^;]*/, "=…")).sort();
      assert.deepEqual(shape(link), shape(password));
      assert.ok(shape(link).every((c) => /; Secure/.test(c)), `Secure: ${JSON.stringify(shape(link))}`);
      assert.ok(shape(link).some((c) => /^kit_session=…; .*HttpOnly/.test(c)));
    } finally { await app.close(); }
  });
});
