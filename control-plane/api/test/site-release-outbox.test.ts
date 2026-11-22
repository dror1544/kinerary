/**
 * Durable site releases (docs/specs/sprint-9/x-member-sign-in.md, amendment A21; owner's decision 2026-11-22).
 *
 * When a member's way into a trip ends, the control plane tells the trip site to release that person's binding. It used to
 * tell it ONCE, after the commit, and a lost call was never retried: the removed person's assistant (MCP) grants, which talk
 * to the trip site directly, kept answering. The record of what must be released is now written by the database inside the
 * transaction that ends the claim or the invite (migration 20261122110000), attempted at once after the commit as before,
 * and retried by a background pass (site-release-outbox.ts) until the site confirms.
 *
 * Postgres, the migrations and the Fastify routes are real. The trip site is the harness's fake (held to the shared case table
 * of tests/fixtures/site-binding-cases.json) wrapped so a test can take it down, make it answer 4xx/5xx/garbage, or slow it.
 * Nothing sleeps: the retry schedule is data and the pass takes the clock it should believe, so a test drives it directly.
 */
import assert from "node:assert/strict";
import { createHash, randomBytes } from "node:crypto";
import { createServer } from "node:http";
import { after, before, beforeEach, describe, test } from "node:test";
import { HttpRuntimeAccountAdapter, createSiteInvite } from "../src/portal.js";
import {
  PENDING_OLDER_THAN_15_MINUTES_SQL, SITE_RELEASE_BACKOFF_MS, SiteReleaseError, attemptSiteRelease, compensateSiteBinding, runSiteReleasePass,
  startSiteReleasePass, type SiteReleaseOptions, type SiteReleaser,
} from "../src/site-release-outbox.js";
import { endClaimLeftGroup } from "../src/sign-in-link.js";
import { ORIGIN, asCookie, claim, cookieOf, id, initDataFor, launch, startHarness, tg, type Harness, type SitePerson } from "./support/group-sign-in-harness.js";
import { testDatabaseUrl } from "./support/test-database.js";

const skip = !testDatabaseUrl();
let h: Harness;
before(async () => { if (!skip) h = await startHarness(); });
after(async () => { if (!skip) await h.stop(); });
// The pass takes every due row in the database, so each test starts with an empty outbox: what a test counts is its own.
beforeEach(async () => { if (!skip) await h.pool.query("DELETE FROM control_plane.site_release_outbox"); });

const PEOPLE: SitePerson[] = [{ username: "dl17", displayName: "Dana Levi", role: "member" }, { username: "nl23", displayName: "Noam Levi", role: "member" }];
const siteKey = (tripId: string, username: string) => `${tripId}:${username}`;
/** What the trip site (server/control-plane-auth.js) and the runtime gateway answer, as JSON `error`, for the 4xx a release can get. */
const OWN_REFUSAL_CODE: Record<number, string> = { 400: "INVALID_REQUEST", 403: "TRIP_MISMATCH" };
/** The trip site never answers 404 on the release path; the only JSON {error:"NOT_FOUND"} there is a gateway with no such route (an OLD gateway). */
const GATEWAY_NOT_FOUND = '{"error":"NOT_FOUND"}';

// ── a trip site that can be taken down ──────────────────────────────────────────────────────────────────────────────────
interface Control {
  /**
   * "up": the fake site answers. "down": a lost call (timeout, refused). A number: that HTTP status WITH the trip site's own JSON error
   * code for it (the codes the site and the gateway really send, OWN_REFUSAL_CODE below). `{ status, code: null }`: that status with a
   * body that is not the site's (a proxy's HTML, an empty body). "malformed": a 200 whose body is not the site's.
   */
  mode: "up" | "down" | "malformed" | number | { status: number; code: string | null };
  /** Every call that reached the site's door, whatever it answered. */
  calls: Array<{ tripId: string; userId: string; runtimeUsername: string; inviteId?: string }>;
  /** Makes each call take this long (a pass racing another one). */
  delayMs: number;
  releaser: SiteReleaser;
  app: ReturnType<Harness["newApp"]>;
}
function control(): Control {
  const base = h.deps().runtimeAccounts;
  const ctl = { mode: "up", calls: [], delayMs: 0 } as unknown as Control;
  ctl.releaser = {
    releaseParticipant: async (input) => {
      ctl.calls.push({ tripId: input.tripId, userId: input.userId, runtimeUsername: input.runtimeUsername, ...(input.inviteId ? { inviteId: input.inviteId } : {}) });
      if (ctl.delayMs) await new Promise((resolve) => setTimeout(resolve, ctl.delayMs));
      if (ctl.mode === "down") throw new Error("RUNTIME_PARTICIPANT_RELEASE_FAILED");
      if (ctl.mode === "malformed") throw new SiteReleaseError(null);
      if (typeof ctl.mode === "number") throw new SiteReleaseError(ctl.mode, OWN_REFUSAL_CODE[ctl.mode] ?? null);
      if (typeof ctl.mode === "object") throw new SiteReleaseError(ctl.mode.status, ctl.mode.code);
      await base.releaseParticipant(input);
    },
  };
  ctl.app = h.newApp({ runtimeAccounts: { ...base, releaseParticipant: ctl.releaser.releaseParticipant } });
  return ctl;
}
const clockAt = (offsetMs: number) => () => new Date(Date.now() + offsetMs);
const pass = (ctl: Control, offsetMs: number, extra: Partial<Parameters<typeof runSiteReleasePass>[0]> = {}) =>
  runSiteReleasePass({ db: h.pool, releaser: ctl.releaser, log: (line) => h.logs.push(line), now: clockAt(offsetMs), ...extra });
interface Row { id: string; trip_id: string; user_id: string; runtime_username: string; invite_id: string | null; reason: string; state: string; attempts: number; outcome: string | null; next_attempt_at: Date; created_at: Date }
const rowsOf = async (tripId: string): Promise<Row[]> => (await h.pool.query("SELECT * FROM control_plane.site_release_outbox WHERE trip_id = $1 ORDER BY id", [tripId])).rows as Row[];
const events = () => h.logs.map((line) => { try { return JSON.parse(line) as Record<string, unknown>; } catch { return null; } }).filter((x): x is Record<string, unknown> => x !== null);
const eventsNamed = (name: string) => events().filter((e) => e.event === name);
const MINUTE = 60_000, HOUR = 60 * MINUTE;

// ── fixtures ────────────────────────────────────────────────────────────────────────────────────────────────────────────
async function trip() {
  const tripId = await h.mkTrip("Release trip");
  const owner = await h.mkUser("Owner");
  await h.mkMember(tripId, owner, "owner");
  const chatId = await h.bindGroup(tripId);
  await h.bindPrivate(tripId, tg());
  await h.switchOn(tripId);
  h.site.set(tripId, PEOPLE.map((p) => ({ ...p })));
  return { tripId, owner, chatId, ownerSession: await h.webSession(owner, "owner") };
}
/** A group CLAIM through the real claim route: account, membership, claim row, link, scoped session, and the site's binding. */
async function claimed(ctl: Control, name = "Dana Levi", username = "dl17") {
  const t = await trip();
  const person = tg();
  await h.telegram.member(t.chatId, person, "member");
  const offer = (await launch(ctl.app, initDataFor(person, { tripId: t.tripId }))).json() as { travellers: { claimId: string; name: string }[] };
  const session = await claim(ctl.app, initDataFor(person, { tripId: t.tripId }), t.tripId, offer.travellers.find((x) => x.name === name)!.claimId);
  assert.equal(session.statusCode, 200, session.body);
  const userId = (await h.pool.query("SELECT user_id FROM control_plane.trip_participant_claims WHERE trip_id = $1 AND released_at IS NULL", [t.tripId])).rows[0].user_id as string;
  assert.equal(h.siteBindings.get(siteKey(t.tripId, username)), userId, "the site holds the claim's binding");
  const row = (await h.pool.query("SELECT l.id AS link_id FROM control_plane.telegram_member_links l WHERE l.trip_id = $1", [t.tripId])).rows[0] as { link_id: string };
  const sessionId = (await h.pool.query("SELECT id FROM control_plane.web_sessions WHERE user_id = $1 AND revoked_at IS NULL", [userId])).rows[0].id as string;
  return { ...t, username, person, userId, session, linkId: row.link_id, sessionId, ctl };
}
type Claimed = Awaited<ReturnType<typeof claimed>>;
const ownerHeaders = (c: { ownerSession: { cookie: string; csrf: string } }) => ({ origin: ORIGIN, cookie: c.ownerSession.cookie, "x-csrf-token": c.ownerSession.csrf });
const runtimeLaunch = (c: Claimed) => c.ctl.app.inject({ method: "POST", url: `/v1/trips/${c.tripId}/launch`, headers: { origin: ORIGIN, cookie: asCookie(c.session), "x-csrf-token": cookieOf(c.session, "kit_csrf")! } });
const livenessCheck = (c: Claimed) => c.ctl.app.inject({ method: "POST", url: "/internal/runtime-sessions/check", headers: { "x-api-key": "exchange-key", "content-type": "application/json" }, payload: JSON.stringify({ tripId: c.tripId, userId: c.userId, sessionId: c.sessionId, role: "member" }) });
const claimTriple = (c: Claimed) => ({ tripId: c.tripId, userId: c.userId, runtimeUsername: c.username });

/** A member who redeemed a personal site invite (the invite's binding on the site). */
const tokenOf = (joinUrl: string) => new URL(joinUrl).hash.slice("#token=".length);
async function inviteMember(ctl: Control, username = "dl17") {
  const t = await trip();
  const made = await createSiteInvite({ ...h.deps(), runtimeAccounts: { ...h.deps().runtimeAccounts, releaseParticipant: ctl.releaser.releaseParticipant } }, { tripId: t.tripId, actorUserId: t.owner, runtimeUsername: username, replacePending: false });
  assert.ok(made.ok, JSON.stringify(made));
  const redeemed = await ctl.app.inject({ method: "POST", url: "/v1/site-invites/redeem", payload: { token: tokenOf((made as { joinUrl: string }).joinUrl), method: "password", password: "a-long-enough-secret" } });
  assert.equal(redeemed.statusCode, 200, redeemed.body);
  const inviteId = (made as { id: string }).id;
  const userId = (await h.pool.query("SELECT redeemed_by FROM control_plane.site_invites WHERE id = $1", [inviteId])).rows[0].redeemed_by as string;
  assert.equal(h.siteBindings.get(siteKey(t.tripId, username)), userId);
  return { ...t, username, inviteId, userId, ctl };
}
type Invited = Awaited<ReturnType<typeof inviteMember>>;
const membershipId = async (tripId: string, userId: string) => (await h.pool.query("SELECT id FROM control_plane.trip_memberships WHERE trip_id = $1 AND user_id = $2", [tripId, userId])).rows[0].id as string;

/** The prompt attempt (`attemptSiteRelease`) for a claimed member's removal, on the given pool. */
const attemptSiteReleaseFor = (db: SiteReleaseOptions["db"], ctl: Control, c: { tripId: string; userId: string; username: string }, log: (line: string) => void) =>
  attemptSiteRelease({ db, releaser: ctl.releaser, log }, { tripId: c.tripId, userId: c.userId, runtimeUsername: c.username });

// ═══ 1. every caller that ends a way in leaves a pending release behind, inside the transaction that ended it ═══════════════════

/** What every caller's test asserts: the request was answered as before, ONE pending record names exactly what to release, the first attempt was made. */
async function assertPending(c: { tripId: string; ctl: Control }, expected: { userId: string; username: string; inviteId: string | null; reason: string }) {
  const rows = await rowsOf(c.tripId);
  assert.equal(rows.length, 1, JSON.stringify(rows));
  const row = rows[0]!;
  assert.deepEqual({ user: row.user_id, name: row.runtime_username, invite: row.invite_id, reason: row.reason, state: row.state }, { user: expected.userId, name: expected.username, invite: expected.inviteId, reason: expected.reason, state: "pending" });
  assert.equal(row.attempts, 1, "the prompt attempt after the commit was made, and failed");
  assert.equal(c.ctl.calls.length, 1, "and reached the site's door once");
  assert.equal(h.siteBindings.get(siteKey(c.tripId, expected.username)), expected.userId, "the stale binding is still on the site: this is the window");
  return row;
}

describe("1. a pending release is written in the transaction that ends the claim, the membership or the invite, for every caller", { skip }, () => {
  test("an organizer's Release of a group claim (DELETE /v1/trips/:id/member-claims/:claimId)", async () => {
    const ctl = control(); const c = await claimed(ctl);
    try {
      const claimId = ((await ctl.app.inject({ method: "GET", url: `/v1/trips/${c.tripId}/member-claims`, headers: { cookie: c.ownerSession.cookie } })).json() as { claims: { claimId: string }[] }).claims[0]!.claimId;
      ctl.mode = "down";
      const released = await ctl.app.inject({ method: "DELETE", url: `/v1/trips/${c.tripId}/member-claims/${claimId}`, headers: ownerHeaders(c) });
      assert.equal(released.statusCode, 200, "the removal is answered exactly as when the site is up");
      await assertPending(c, { userId: c.userId, username: "dl17", inviteId: null, reason: "organizer_released" });
    } finally { await ctl.app.close(); }
  });

  test("the person leaving the group, found at a Mini App launch", async () => {
    const ctl = control(); const c = await claimed(ctl);
    try {
      await h.telegram.member(c.chatId, c.person, "left");
      ctl.mode = "down";
      assert.equal((await launch(ctl.app, initDataFor(c.person, { tripId: c.tripId }))).statusCode, 401, "the person is turned away as ever");
      await assertPending(c, { userId: c.userId, username: "dl17", inviteId: null, reason: "left_group" });
    } finally { await ctl.app.close(); }
  });

  test("the person leaving the group, found at the runtime launch (POST /v1/trips/:id/launch)", async () => {
    const ctl = control(); const c = await claimed(ctl);
    try {
      await h.telegram.member(c.chatId, c.person, "kicked");
      ctl.mode = "down";
      assert.equal((await runtimeLaunch(c)).statusCode, 401);
      await assertPending(c, { userId: c.userId, username: "dl17", inviteId: null, reason: "left_group" });
    } finally { await ctl.app.close(); }
  });

  test("the person leaving the group, found by the gateway's liveness check", async () => {
    const ctl = control(); const c = await claimed(ctl);
    try {
      await h.telegram.member(c.chatId, c.person, "left");
      await h.pool.query("UPDATE control_plane.trip_participant_claims SET last_group_check_at = now() - interval '11 minutes' WHERE trip_id = $1 AND released_at IS NULL", [c.tripId]);
      ctl.mode = "down";
      const r = await livenessCheck(c);
      assert.equal(r.statusCode, 401); assert.deepEqual(r.json(), { error: "SESSION_REVOKED" });
      await assertPending(c, { userId: c.userId, username: "dl17", inviteId: null, reason: "left_group" });
    } finally { await ctl.app.close(); }
  });

  test("the person leaving the group, found at sign-in-link redemption (the route, with a real claimant's link)", async () => {
    const ctl = control(); const c = await claimed(ctl);
    try {
      const token = `sl_${randomBytes(32).toString("base64url")}`;
      await h.pool.query(
        "INSERT INTO control_plane.sign_in_links(id, token_digest, user_id, channel, telegram_link_id, expires_at) VALUES ($1, $2, $3, 'telegram', $4, now() + interval '20 minutes')",
        [id("sil"), `sha256:${createHash("sha256").update(token).digest("hex")}`, c.userId, c.linkId]);
      await h.telegram.member(c.chatId, c.person, "left");
      ctl.mode = "down";
      const r = await ctl.app.inject({ method: "POST", url: "/v1/auth/sign-in-link/redeem", headers: { origin: ORIGIN, "content-type": "application/json" }, payload: JSON.stringify({ token }) });
      assert.equal(r.statusCode, 400); assert.deepEqual(r.json(), { error: "TOKEN_INVALID" });
      await assertPending(c, { userId: c.userId, username: "dl17", inviteId: null, reason: "left_group" });
    } finally { await ctl.app.close(); }
  });

  test("the claim-ending function the redemption route calls, run with no release attempt after it (a crash between COMMIT and the call), still leaves the record", async () => {
    const ctl = control(); const c = await claimed(ctl);
    try {
      const ended = await endClaimLeftGroup(h.pool, c.userId, c.tripId);
      assert.equal(ended.length, 1);
      const [row] = await rowsOf(c.tripId);
      assert.deepEqual({ user: row!.user_id, name: row!.runtime_username, invite: row!.invite_id, state: row!.state, attempts: row!.attempts }, { user: c.userId, name: "dl17", invite: null, state: "pending", attempts: 0 });
      assert.equal(ctl.calls.length, 0, "no call was made: the record is all that survives");
    } finally { await ctl.app.close(); }
  });

  test("the person's own Unlink (DELETE /v1/account/telegram-links/:linkId)", async () => {
    const ctl = control(); const c = await claimed(ctl);
    try {
      ctl.mode = "down";
      const r = await ctl.app.inject({ method: "DELETE", url: `/v1/account/telegram-links/${c.linkId}`, headers: { origin: ORIGIN, cookie: asCookie(c.session), "x-csrf-token": cookieOf(c.session, "kit_csrf")! } });
      assert.equal(r.statusCode, 200, r.body);
      await assertPending(c, { userId: c.userId, username: "dl17", inviteId: null, reason: "unlinked" });
    } finally { await ctl.app.close(); }
  });

  test("member removal of a group claimant (DELETE /v1/trips/:id/members/:membershipId): the membership trigger releases the claim, and the record follows", async () => {
    const ctl = control(); const c = await claimed(ctl);
    try {
      ctl.mode = "down";
      const r = await ctl.app.inject({ method: "DELETE", url: `/v1/trips/${c.tripId}/members/${await membershipId(c.tripId, c.userId)}`, headers: ownerHeaders(c) });
      assert.equal(r.statusCode, 200, r.body);
      await assertPending(c, { userId: c.userId, username: "dl17", inviteId: null, reason: "membership_ended" });
    } finally { await ctl.app.close(); }
  });

  test("member removal of an INVITED member (DELETE /v1/trips/:id/members/:membershipId): the record names the invite id", async () => {
    const ctl = control(); const m = await inviteMember(ctl);
    try {
      ctl.mode = "down";
      const r = await ctl.app.inject({ method: "DELETE", url: `/v1/trips/${m.tripId}/members/${await membershipId(m.tripId, m.userId)}`, headers: ownerHeaders(m) });
      assert.equal(r.statusCode, 200, r.body);
      await assertPending(m, { userId: m.userId, username: "dl17", inviteId: m.inviteId, reason: "invite_revoked" });
    } finally { await ctl.app.close(); }
  });

  test("revoking a REDEEMED invite (DELETE /v1/trips/:id/site-invites/:inviteId)", async () => {
    const ctl = control(); const m = await inviteMember(ctl);
    try {
      ctl.mode = "down";
      const r = await ctl.app.inject({ method: "DELETE", url: `/v1/trips/${m.tripId}/site-invites/${m.inviteId}`, headers: ownerHeaders(m) });
      assert.equal(r.statusCode, 200, r.body);
      await assertPending(m, { userId: m.userId, username: "dl17", inviteId: m.inviteId, reason: "invite_revoked" });
    } finally { await ctl.app.close(); }
  });

  test("revoking an UNUSED invite leaves nothing pending: nothing was ever bound", async () => {
    const ctl = control(); const t = await trip();
    try {
      const made = await createSiteInvite(h.deps(), { tripId: t.tripId, actorUserId: t.owner, runtimeUsername: "dl17", replacePending: false });
      assert.ok(made.ok);
      const r = await ctl.app.inject({ method: "DELETE", url: `/v1/trips/${t.tripId}/site-invites/${(made as { id: string }).id}`, headers: ownerHeaders(t) });
      assert.equal(r.statusCode, 200, r.body);
      assert.deepEqual(await rowsOf(t.tripId), []);
    } finally { await ctl.app.close(); }
  });

  test("a membership ended OUTSIDE the portal routes (SQL, an admin tool): the database still records the release, so the binding does not outlive it", async () => {
    const ctl = control(); const c = await claimed(ctl);
    try {
      await h.pool.query("UPDATE control_plane.trip_memberships SET status = 'revoked' WHERE trip_id = $1 AND user_id = $2", [c.tripId, c.userId]);
      const [row] = await rowsOf(c.tripId);
      assert.deepEqual({ user: row!.user_id, name: row!.runtime_username, invite: row!.invite_id, reason: row!.reason, state: row!.state }, { user: c.userId, name: "dl17", invite: null, reason: "membership_ended", state: "pending" });
      await pass(ctl, HOUR);
      assert.equal(h.siteBindings.has(siteKey(c.tripId, "dl17")), false, "and the background pass takes the binding off the site");
    } finally { await ctl.app.close(); }
  });

  test("a redeemed invite updated redeemed -> redeemed (a touch, a repeat write) records nothing: only LEAVING `redeemed` is a removal", async () => {
    const ctl = control(); const m = await inviteMember(ctl);
    try {
      assert.deepEqual(await rowsOf(m.tripId), [], "redeeming recorded nothing");
      await h.pool.query("UPDATE control_plane.site_invites SET state = 'redeemed', updated_at = now() WHERE id = $1", [m.inviteId]);
      await h.pool.query("UPDATE control_plane.site_invites SET state = 'redeemed', redeemed_by = redeemed_by WHERE id = $1", [m.inviteId]);
      assert.deepEqual(await rowsOf(m.tripId), [], "redeemed -> redeemed writes no record");
      assert.equal(h.siteBindings.get(siteKey(m.tripId, m.username)), m.userId, "and the binding is untouched");
      // the control: leaving `redeemed` does
      await h.pool.query("UPDATE control_plane.site_invites SET state = 'revoked' WHERE id = $1", [m.inviteId]);
      assert.equal((await rowsOf(m.tripId)).length, 1);
    } finally { await ctl.app.close(); }
  });

  test("ending the same claim twice leaves ONE pending record (the unique index on what is pending)", async () => {
    const ctl = control(); const c = await claimed(ctl);
    try {
      await endClaimLeftGroup(h.pool, c.userId, c.tripId);
      await h.pool.query("UPDATE control_plane.trip_participant_claims SET released_at = NULL, released_reason = NULL WHERE trip_id = $1", [c.tripId]);
      await h.pool.query("UPDATE control_plane.trip_participant_claims SET released_at = now(), released_reason = 'unlinked' WHERE trip_id = $1", [c.tripId]);
      assert.equal((await rowsOf(c.tripId)).length, 1);
    } finally { await ctl.app.close(); }
  });

  test("the compensating release after a claim's COMMIT fails has no committed transaction to ride on: it writes its own record, then attempts", async () => {
    const ctl = control();
    const t = await trip();
    const person = tg(); await h.telegram.member(t.chatId, person, "member");
    const failing = new Proxy(h.pool, {
      get(target, prop, receiver) {
        if (prop === "connect") {
          return async () => {
            const client = await target.connect();
            const original = { query: client.query, release: client.release };
            const query = client.query.bind(client) as (...a: unknown[]) => unknown;
            (client as unknown as { query: unknown }).query = (sql: unknown, ...rest: unknown[]) =>
              sql === "COMMIT" ? Promise.reject(Object.assign(new Error("commit failed"), { code: "XX000" })) : query(sql, ...rest);
            (client as unknown as { release: unknown }).release = (...args: unknown[]) => { Object.assign(client, original); return (original.release as (...a: unknown[]) => void).apply(client, args); };
            return client;
          };
        }
        const value = Reflect.get(target, prop, receiver);
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
    const failingApp = h.newApp({ db: failing, runtimeAccounts: { ...h.deps().runtimeAccounts, releaseParticipant: ctl.releaser.releaseParticipant } });
    try {
      const offer = (await launch(ctl.app, initDataFor(person, { tripId: t.tripId }))).json() as { travellers: { claimId: string; name: string }[] };
      ctl.mode = "down";
      const r = await claim(failingApp, initDataFor(person, { tripId: t.tripId }), t.tripId, offer.travellers.find((x) => x.name === "Dana Levi")!.claimId);
      assert.equal(r.statusCode, 500, "answered as today");
      const rows = await rowsOf(t.tripId);
      assert.equal(rows.length, 1);
      assert.deepEqual({ name: rows[0]!.runtime_username, invite: rows[0]!.invite_id, reason: rows[0]!.reason, state: rows[0]!.state, attempts: rows[0]!.attempts }, { name: "dl17", invite: null, reason: "claim_commit_failed", state: "pending", attempts: 1 });
      assert.equal(h.siteBindings.get(siteKey(t.tripId, "dl17")) !== undefined, true, "the site holds a binding for an account that was never committed");
      ctl.mode = "up";
      await pass(ctl, HOUR);
      assert.equal(h.siteBindings.has(siteKey(t.tripId, "dl17")), false, "the retry removes it");
      assert.equal((await rowsOf(t.tripId))[0]!.state, "done");
    } finally { await failingApp.close(); await ctl.app.close(); }
  });

  test("the claim's COMMIT answer is lost but the commit LANDED: the compensating release finds the live claim and does not undo it (superseded: the site is not asked)", async () => {
    const ctl = control();
    const t = await trip();
    const person = tg(); await h.telegram.member(t.chatId, person, "member");
    const lostAnswer = new Proxy(h.pool, {
      get(target, prop, receiver) {
        if (prop === "connect") {
          return async () => {
            const client = await target.connect();
            const original = { query: client.query, release: client.release };
            const query = client.query.bind(client) as (...a: unknown[]) => Promise<unknown>;
            // COMMIT really runs, and its answer is lost
            (client as unknown as { query: unknown }).query = (sql: unknown, ...rest: unknown[]) =>
              sql === "COMMIT" ? query(sql).then(() => Promise.reject(Object.assign(new Error("connection reset after commit"), { code: "08006" }))) : query(sql, ...rest);
            (client as unknown as { release: unknown }).release = (...args: unknown[]) => { Object.assign(client, original); return (original.release as (...a: unknown[]) => void).apply(client, args); };
            return client;
          };
        }
        const value = Reflect.get(target, prop, receiver);
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
    const app = h.newApp({ db: lostAnswer, runtimeAccounts: { ...h.deps().runtimeAccounts, releaseParticipant: ctl.releaser.releaseParticipant } });
    try {
      const offer = (await launch(ctl.app, initDataFor(person, { tripId: t.tripId }))).json() as { travellers: { claimId: string; name: string }[] };
      h.logs.length = 0;
      const r = await claim(app, initDataFor(person, { tripId: t.tripId }), t.tripId, offer.travellers.find((x) => x.name === "Dana Levi")!.claimId);
      assert.equal(r.statusCode, 500, "answered as for any commit failure");
      const live = (await h.pool.query("SELECT user_id FROM control_plane.trip_participant_claims WHERE trip_id = $1 AND released_at IS NULL", [t.tripId])).rows;
      assert.equal(live.length, 1, "the claim that committed is still live: the compensation did not undo it");
      const userId = live[0].user_id as string;
      assert.equal(h.siteBindings.get(siteKey(t.tripId, "dl17")), userId, "the site still binds the committed claimant");
      assert.deepEqual(ctl.calls, [], "the site was never asked to release");
      const [row] = await rowsOf(t.tripId);
      assert.deepEqual({ reason: row!.reason, state: row!.state, outcome: row!.outcome }, { reason: "claim_commit_failed", state: "done", outcome: "superseded" });
      assert.equal((await h.pool.query("SELECT status FROM control_plane.trip_memberships WHERE trip_id = $1 AND user_id = $2", [t.tripId, userId])).rows[0].status, "active");
      // and the person's launch works: nothing about them was undone
      const again = await launch(ctl.app, initDataFor(person, { tripId: t.tripId }));
      assert.deepEqual(again.json(), { kind: "session", appPath: `/mini-app/trips/${t.tripId}` });
    } finally { await app.close(); await ctl.app.close(); }
  });

  test("the compensating release when the record cannot be written either (the database is down) still tries the site once, as before, and never throws", async () => {
    const ctl = control();
    const t = await trip();
    const brokenDb = { query: async () => { throw new Error("database is down"); } } as unknown as Parameters<typeof compensateSiteBinding>[0]["db"];
    await compensateSiteBinding({ db: brokenDb, releaser: ctl.releaser, log: (line) => h.logs.push(line) }, { tripId: t.tripId, userId: "user_neverbound001", runtimeUsername: "dl17" });
    assert.equal(ctl.calls.length, 1, "one direct attempt");
    await ctl.app.close();
  });
});

// ═══ 2. the prompt attempt, and what happens when it works ═══════════════════════════════════════════════════════════════════════

describe("2. the prompt attempt after the commit is the fast path; success marks the record done", { skip }, () => {
  test("site up: the site is called once with the exact triple, the binding goes, the record is done, nothing says 'pending'", async () => {
    const ctl = control(); const c = await claimed(ctl);
    try {
      h.logs.length = 0;
      const claimId = ((await ctl.app.inject({ method: "GET", url: `/v1/trips/${c.tripId}/member-claims`, headers: { cookie: c.ownerSession.cookie } })).json() as { claims: { claimId: string }[] }).claims[0]!.claimId;
      assert.equal((await ctl.app.inject({ method: "DELETE", url: `/v1/trips/${c.tripId}/member-claims/${claimId}`, headers: ownerHeaders(c) })).statusCode, 200);
      assert.deepEqual(ctl.calls, [claimTriple(c)]);
      assert.equal(h.siteBindings.has(siteKey(c.tripId, "dl17")), false);
      const [row] = await rowsOf(c.tripId);
      assert.deepEqual({ state: row!.state, attempts: row!.attempts }, { state: "done", attempts: 1 });
      assert.equal(eventsNamed("site_release.pending").length, 0);
    } finally { await ctl.app.close(); }
  });

  test("site down, then up: the record is pending, the pass releases it, the site is called with the exact triple, the record is done, and the landing is logged with the attempt count", async () => {
    const ctl = control(); const c = await claimed(ctl);
    try {
      h.logs.length = 0;
      ctl.mode = "down";
      await h.pool.query("SELECT 1");
      await ctl.app.inject({ method: "DELETE", url: `/v1/trips/${c.tripId}/members/${await membershipId(c.tripId, c.userId)}`, headers: ownerHeaders(c) });
      assert.equal(eventsNamed("site_release.pending").length, 1, "one line when it goes pending");
      assert.deepEqual(eventsNamed("site_release.pending")[0], { ...eventsNamed("site_release.pending")[0], level: "warn", reason: "membership_ended" });
      ctl.mode = "up";
      ctl.calls.length = 0;
      const early = await pass(ctl, 5_000);
      assert.equal(early.attempted, 0, "not due yet: the first retry waits its 30 seconds");
      assert.deepEqual(ctl.calls, []);
      const result = await pass(ctl, MINUTE);
      assert.deepEqual({ attempted: result.attempted, released: result.released }, { attempted: 1, released: 1 });
      assert.deepEqual(ctl.calls, [claimTriple(c)], "once, with the exact triple");
      assert.equal(h.siteBindings.has(siteKey(c.tripId, "dl17")), false);
      const [row] = await rowsOf(c.tripId);
      assert.deepEqual({ state: row!.state, attempts: row!.attempts, outcome: row!.outcome }, { state: "done", attempts: 2, outcome: "released" });
      const landed = eventsNamed("site_release.landed");
      assert.equal(landed.length, 1);
      assert.equal(landed[0]!.attempts, 2);
      assert.equal((await pass(ctl, 2 * MINUTE)).attempted, 0, "and a done record is never attempted again");
    } finally { await ctl.app.close(); }
  });

  test("an INVITED member's release names the invite id, and lands the same way", async () => {
    const ctl = control(); const m = await inviteMember(ctl);
    try {
      ctl.mode = "down";
      await ctl.app.inject({ method: "DELETE", url: `/v1/trips/${m.tripId}/site-invites/${m.inviteId}`, headers: ownerHeaders(m) });
      ctl.mode = "up"; ctl.calls.length = 0;
      await pass(ctl, MINUTE);
      assert.deepEqual(ctl.calls, [{ tripId: m.tripId, userId: m.userId, runtimeUsername: "dl17", inviteId: m.inviteId }]);
      assert.equal(h.siteBindings.has(siteKey(m.tripId, "dl17")), false);
      assert.equal(h.siteHeld.has(siteKey(m.tripId, "dl17")), false);
    } finally { await ctl.app.close(); }
  });

  test("CRASH between COMMIT and the call: the claim ended in a transaction and no attempt was ever made; the background pass still releases it", async () => {
    const ctl = control(); const c = await claimed(ctl);
    try {
      const client = await h.pool.connect();
      try {
        const { endGroupClaimInTx } = await import("../src/telegram-mini-app.js");
        await client.query("BEGIN");
        await endGroupClaimInTx(client, { tripId: c.tripId, userId: c.userId, linkReason: "claim_released", claimReason: "organizer_released" });
        await client.query("COMMIT");
      } finally { client.release(); }
      // (the process dies here: the fast path never runs)
      assert.equal(ctl.calls.length, 0);
      assert.equal(h.siteBindings.get(siteKey(c.tripId, "dl17")), c.userId);
      await pass(ctl, MINUTE);
      assert.deepEqual(ctl.calls, [claimTriple(c)]);
      assert.equal(h.siteBindings.has(siteKey(c.tripId, "dl17")), false);
    } finally { await ctl.app.close(); }
  });
});

// ═══ 3. the background pass: backoff, no double work, no lock across the call ════════════════════════════════════════════════════

describe("3. the background pass", { skip }, () => {
  test("retries with the backoff schedule 30 s, 2 min, 10 min, then every 30 min, and never stops while the site keeps failing transiently (a timeout, a refusal, a 5xx, a 429, a 401, a 404 even in the gateway's own JSON, a malformed answer)", async () => {
    assert.deepEqual([...SITE_RELEASE_BACKOFF_MS], [30_000, 120_000, 600_000, 1_800_000]);
    const ctl = control(); const c = await claimed(ctl);
    try {
      ctl.mode = "down";
      await ctl.app.inject({ method: "DELETE", url: `/v1/trips/${c.tripId}/members/${await membershipId(c.tripId, c.userId)}`, headers: ownerHeaders(c) });
      const fixed = new Date(Date.now() + 10 * HOUR);
      const modes: Control["mode"][] = ["down", 503, "malformed", 500, 429, 401, { status: 404, code: "NOT_FOUND" }, "down"];
      const seen: number[] = [];
      for (const mode of modes) {
        ctl.mode = mode;
        const result = await runSiteReleasePass({ db: h.pool, releaser: ctl.releaser, log: (line) => h.logs.push(line), now: () => fixed });
        assert.equal(result.attempted, 1, `${String(mode)}: due, so attempted`);
        const [row] = await rowsOf(c.tripId);
        assert.equal(row!.state, "pending", `${String(mode)} is never a reason to stop`);
        seen.push(row!.next_attempt_at.getTime() - fixed.getTime());
        // make it due again for the next lap
        await h.pool.query("UPDATE control_plane.site_release_outbox SET next_attempt_at = $2 WHERE trip_id = $1", [c.tripId, new Date(fixed.getTime() - 1000)]);
      }
      // attempts so far: 1 (fast path) + the laps; the delay after attempt n is the schedule's nth entry, the last one repeating
      assert.deepEqual(seen, [120_000, 600_000, 1_800_000, 1_800_000, 1_800_000, 1_800_000, 1_800_000, 1_800_000]);
    } finally { await ctl.app.close(); }
  });

  test("only the FIRST failed attempt logs `site_release.pending`: three failures in a row, one line", async () => {
    const ctl = control(); const c = await claimed(ctl);
    try {
      ctl.mode = "down";
      h.logs.length = 0;
      await ctl.app.inject({ method: "DELETE", url: `/v1/trips/${c.tripId}/members/${await membershipId(c.tripId, c.userId)}`, headers: ownerHeaders(c) });
      await pass(ctl, HOUR);
      await pass(ctl, 2 * HOUR);
      const [row] = await rowsOf(c.tripId);
      assert.equal(row!.attempts, 3, "the prompt attempt and two passes all failed");
      assert.equal(ctl.calls.length, 3);
      assert.equal(eventsNamed("site_release.pending").length, 1, "one line when it went pending, none for the retries");
      assert.equal(eventsNamed("site_release.pending")[0]!.level, "warn");
    } finally { await ctl.app.close(); }
  });

  test("a row that is not due, or is leased by another pass, is not attempted", async () => {
    const ctl = control(); const c = await claimed(ctl);
    try {
      ctl.mode = "down";
      await ctl.app.inject({ method: "DELETE", url: `/v1/trips/${c.tripId}/members/${await membershipId(c.tripId, c.userId)}`, headers: ownerHeaders(c) });
      ctl.calls.length = 0; ctl.mode = "up";
      await h.pool.query("UPDATE control_plane.site_release_outbox SET claimed_until = now() + interval '2 hours' WHERE trip_id = $1", [c.tripId]);
      assert.equal((await pass(ctl, HOUR / 2)).attempted, 0, "leased by a pass that is mid-call");
      await h.pool.query("UPDATE control_plane.site_release_outbox SET claimed_until = now() - interval '1 minute' WHERE trip_id = $1", [c.tripId]);
      assert.equal((await pass(ctl, HOUR / 2)).attempted, 1, "a lease that expired (a pass that died mid-call) is taken over");
    } finally { await ctl.app.close(); }
  });

  test("TWO passes at once release once: the row is claimed atomically, so the second finds nothing to do", async () => {
    const ctl = control(); const c = await claimed(ctl);
    try {
      ctl.mode = "down";
      await ctl.app.inject({ method: "DELETE", url: `/v1/trips/${c.tripId}/members/${await membershipId(c.tripId, c.userId)}`, headers: ownerHeaders(c) });
      ctl.calls.length = 0; ctl.mode = "up"; ctl.delayMs = 150;
      const [a, b] = await Promise.all([pass(ctl, HOUR), pass(ctl, HOUR)]);
      assert.equal(a.attempted + b.attempted, 1, JSON.stringify({ a, b }));
      assert.deepEqual(ctl.calls, [claimTriple(c)], "the site was called exactly once");
      const rows = await rowsOf(c.tripId);
      assert.deepEqual(rows.map((r) => [r.state, r.attempts]), [["done", 2]]);
    } finally { await ctl.app.close(); }
  });

  test("no row lock and no transaction is held across the HTTP call: while the site is slow, the record can be read AND updated by another connection", async () => {
    const ctl = control(); const c = await claimed(ctl);
    try {
      ctl.mode = "down";
      await ctl.app.inject({ method: "DELETE", url: `/v1/trips/${c.tripId}/members/${await membershipId(c.tripId, c.userId)}`, headers: ownerHeaders(c) });
      ctl.mode = "up"; ctl.delayMs = 400;
      const running = pass(ctl, HOUR);
      await new Promise((resolve) => setTimeout(resolve, 100));
      const idle = await h.pool.query("SELECT count(*)::int AS n FROM pg_stat_activity WHERE datname = current_database() AND state = 'idle in transaction'");
      assert.equal(idle.rows[0].n, 0, "no connection is parked inside a transaction while the call is out");
      const touched = await h.pool.query("UPDATE control_plane.site_release_outbox SET reason = reason WHERE trip_id = $1 RETURNING id", [c.tripId]);
      assert.equal(touched.rowCount, 1, "and the row is not locked");
      await running;
    } finally { await ctl.app.close(); }
  });

  test("the pass never runs inside a request: a removal answered while the site is down does not wait for any pass", async () => {
    const ctl = control(); const c = await claimed(ctl);
    try {
      ctl.mode = "down";
      const r = await ctl.app.inject({ method: "DELETE", url: `/v1/trips/${c.tripId}/members/${await membershipId(c.tripId, c.userId)}`, headers: ownerHeaders(c) });
      assert.equal(r.statusCode, 200);
      assert.equal(ctl.calls.length, 1, "one attempt (the prompt one), not a retry loop");
    } finally { await ctl.app.close(); }
  });
});

// ═══ 4. a permanent answer is not retried forever ═════════════════════════════════════════════════════════════════════════════════

describe("4. permanent answers", { skip }, () => {
  for (const status of [400, 403]) {
    test(`the site answering ${status} (it can never succeed) is given up after 3 attempts, with ONE warn naming the reason and no id`, async () => {
      const ctl = control(); const c = await claimed(ctl);
      try {
        ctl.mode = status;
        h.logs.length = 0;
        await ctl.app.inject({ method: "DELETE", url: `/v1/trips/${c.tripId}/members/${await membershipId(c.tripId, c.userId)}`, headers: ownerHeaders(c) });
        for (let lap = 0; lap < 6; lap += 1) await pass(ctl, (lap + 1) * HOUR);
        const [row] = await rowsOf(c.tripId);
        assert.deepEqual({ state: row!.state, attempts: row!.attempts, outcome: row!.outcome }, { state: "given_up", attempts: 3, outcome: `refused_${status}` });
        assert.equal(ctl.calls.length, 3, "the fast path and two passes, then no more");
        const given = eventsNamed("site_release.given_up");
        assert.equal(given.length, 1);
        assert.deepEqual({ level: given[0]!.level, why: given[0]!.why, reason: given[0]!.reason }, { level: "warn", why: `refused_${status}`, reason: "membership_ended" });
        const everything = h.logs.join("\n");
        for (const secret of [c.tripId, c.userId, "dl17"]) assert.ok(!everything.includes(secret), "no id, name or trip in the log");
      } finally { await ctl.app.close(); }
    });
  }

  test("the site answering 200 {ok:true, released:false} (nothing to release: already gone, or replaced) is SUCCESS", async () => {
    const seen: string[] = [];
    const site = createServer((request, response) => { seen.push(`${request.method} ${request.url}`); response.writeHead(200, { "content-type": "application/json" }); response.end('{"ok":true,"released":false}'); });
    await new Promise<void>((resolve) => site.listen(0, "127.0.0.1", resolve));
    const adapter = new HttpRuntimeAccountAdapter(`http://127.0.0.1:${(site.address() as { port: number }).port}`, "k");
    const ctl = control(); const c = await claimed(ctl);
    try {
      ctl.mode = "down";
      await ctl.app.inject({ method: "DELETE", url: `/v1/trips/${c.tripId}/members/${await membershipId(c.tripId, c.userId)}`, headers: ownerHeaders(c) });
      const result = await runSiteReleasePass({ db: h.pool, releaser: adapter, log: (line) => h.logs.push(line), now: clockAt(HOUR) });
      assert.equal(result.released, 1);
      assert.equal((await rowsOf(c.tripId))[0]!.state, "done");
      assert.deepEqual(seen, [`POST /internal/t/${c.tripId}/participants/release`]);
    } finally { await ctl.app.close(); await new Promise((resolve) => site.close(resolve)); }
  });

  /** The real adapter against a stand-in for whatever answers at the public hostname, driven by passes; returns what the passes left. */
  async function liveRemovalAgainst(reply: { status: number; contentType: string; body: string }, laps: number) {
    const door: string[] = [];
    const site = createServer((request, response) => { request.resume(); request.on("end", () => { door.push(`${request.method} ${request.url}`); response.writeHead(reply.status, { "content-type": reply.contentType }); response.end(reply.body); }); });
    await new Promise<void>((resolve) => site.listen(0, "127.0.0.1", resolve));
    const adapter = new HttpRuntimeAccountAdapter(`http://127.0.0.1:${(site.address() as { port: number }).port}`, "k");
    const ctl = control(); const c = await claimed(ctl);
    try {
      ctl.mode = "down"; // the prompt attempt is lost (it never reaches the stand-in), so the record starts pending with attempts = 1
      await ctl.app.inject({ method: "DELETE", url: `/v1/trips/${c.tripId}/members/${await membershipId(c.tripId, c.userId)}`, headers: ownerHeaders(c) });
      h.logs.length = 0;
      for (let lap = 0; lap < laps; lap += 1) await runSiteReleasePass({ db: h.pool, releaser: adapter, log: (line) => h.logs.push(line), now: clockAt((lap + 1) * HOUR) });
      const [row] = await rowsOf(c.tripId);
      return { row: row!, door };
    } finally { await ctl.app.close(); await new Promise((resolve) => site.close(resolve)); }
  }

  for (const [status, code] of Object.entries(OWN_REFUSAL_CODE)) {
    test(`the real adapter: the site's own JSON refusal (${status} ${code}) is given up at the third attempt, with ONE warn`, async () => {
      const { row, door } = await liveRemovalAgainst({ status: Number(status), contentType: "application/json", body: JSON.stringify({ error: code }) }, 6);
      assert.deepEqual({ state: row.state, attempts: row.attempts, outcome: row.outcome }, { state: "given_up", attempts: 3, outcome: `refused_${status}` });
      assert.equal(door.length, 2, "two passes reached the site after the lost prompt attempt, then no more");
      assert.deepEqual(eventsNamed("site_release.given_up").map((e) => [e.level, e.why]), [["warn", `refused_${status}`]]);
    });
  }

  const NOT_THE_SITES: Array<[string, number, string, string]> = [
    ["the gateway's own JSON 404 NOT_FOUND: a gateway with no release route yet (version skew), so it is retried and lands when the gateway is new", 404, "application/json", GATEWAY_NOT_FOUND],
    ["a proxy's HTML 404 (an ingress with no route during a rollout)", 404, "text/html", "<html><body><h1>404 Not Found</h1>nginx</body></html>"],
    ["a WAF's HTML 403", 403, "text/html", "<html><title>Access denied</title></html>"],
    ["an empty 400", 400, "text/plain", ""],
    ["a proxy's JSON 403 with a different code", 403, "application/json", '{"error":"FORBIDDEN"}'],
    ["a proxy's JSON 404 naming a message, not an error code", 404, "application/json", '{"message":"no such route"}'],
    ["a 404 whose `error` is not a string", 404, "application/json", '{"error":{"code":"NOT_FOUND"}}'],
    ["the right code on the wrong status (INVALID_REQUEST on a 404)", 404, "application/json", '{"error":"INVALID_REQUEST"}'],
  ];
  for (const [label, status, contentType, body] of NOT_THE_SITES) {
    test(`the real adapter: ${label} is NOT the site's refusal: retried, still pending after 6 attempts, never given up`, async () => {
      const { row, door } = await liveRemovalAgainst({ status, contentType, body }, 5);
      assert.deepEqual({ state: row.state, attempts: row.attempts, outcome: row.outcome }, { state: "pending", attempts: 6, outcome: null });
      assert.equal(door.length, 5, "every pass reached the door and asked again");
      assert.deepEqual(eventsNamed("site_release.given_up"), []);
    });
  }

  test("a trip that is retired, or gone, is given up on cleanly without asking the site", async () => {
    const ctl = control();
    const retired = await h.mkTrip("Gone", { retired: true });
    const user = await h.mkUser("Someone");
    const missing = `trip_missing${randomBytes(4).toString("hex")}`;
    try {
      for (const tripId of [retired, missing]) {
        await h.pool.query("INSERT INTO control_plane.site_release_outbox(trip_id, user_id, runtime_username, reason) VALUES ($1, $2, 'dl17', 'organizer_released')", [tripId, user]);
      }
      h.logs.length = 0;
      await pass(ctl, HOUR);
      assert.equal(ctl.calls.length, 0, "no call to a site that is gone");
      for (const tripId of [retired, missing]) {
        const [row] = await rowsOf(tripId);
        assert.deepEqual({ state: row!.state, outcome: row!.outcome }, { state: "given_up", outcome: "trip_gone" });
      }
      assert.deepEqual(eventsNamed("site_release.given_up").map((e) => [e.level, e.why]), [["info", "trip_gone"], ["info", "trip_gone"]]);
    } finally { await ctl.app.close(); }
  });

  test("the real adapter: 200 with the site's body succeeds; 4xx carries its status; a lost or garbled answer carries none (so it is retried, never given up)", async () => {
    let reply: { status: number; body: string } = { status: 200, body: '{"ok":true,"released":true}' };
    const site = createServer((request, response) => { request.resume(); request.on("end", () => { response.writeHead(reply.status, { "content-type": "application/json" }); response.end(reply.body); }); });
    await new Promise<void>((resolve) => site.listen(0, "127.0.0.1", resolve));
    const adapter = new HttpRuntimeAccountAdapter(`http://127.0.0.1:${(site.address() as { port: number }).port}`, "k");
    const input = { tripId: "trip_abcdefgh", userId: "user_abcdefgh", runtimeUsername: "bob" };
    const statusOf = async () => { try { await adapter.releaseParticipant(input); return "ok"; } catch (error) { return error instanceof SiteReleaseError ? error.status : `plain:${(error as Error).message}`; } };
    const codeOf = async () => { try { await adapter.releaseParticipant(input); return "ok"; } catch (error) { return error instanceof SiteReleaseError ? error.code : `plain:${(error as Error).message}`; } };
    try {
      assert.equal(await statusOf(), "ok");
      reply = { status: 200, body: '{"ok":true,"released":false}' }; assert.equal(await statusOf(), "ok");
      for (const status of [400, 403, 404, 401, 429, 500, 502, 503]) { reply = { status, body: "{}" }; assert.equal(await statusOf(), status); assert.equal(await codeOf(), null, "a 4xx whose body names no error code carries none"); }
      // the error code travels with the status only when the body is a JSON object with a string `error`
      reply = { status: 403, body: '{"error":"TRIP_MISMATCH"}' }; assert.equal(await codeOf(), "TRIP_MISMATCH");
      for (const body of ["<html>forbidden</html>", "", "[]", "null", '{"error":42}', '{"error":{"code":"NOT_FOUND"}}', '{"message":"blocked"}', `{"error":"${"X".repeat(200)}"}`]) {
        reply = { status: 403, body }; assert.equal(await codeOf(), null, `403 with ${JSON.stringify(body.slice(0, 30))} carries no code`);
      }
      for (const body of ["", "not json", "{}", '{"ok":false}', "[]", "null", "<html>gateway</html>"]) { reply = { status: 200, body }; assert.equal(await statusOf(), null, `200 with ${JSON.stringify(body)} is not the site's answer`); }
    } finally { await new Promise((resolve) => site.close(resolve)); }
  });
});

// ═══ 5. ordering and supersession ═════════════════════════════════════════════════════════════════════════════════════════════

describe("5. a late release cannot remove a binding that is not the one it was written for", { skip }, () => {
  test("another account claims the same traveller before the retry lands: the late release of the OLD account leaves the NEW account's binding alone", async () => {
    const ctl = control(); const c = await claimed(ctl);
    try {
      ctl.mode = "down";
      await ctl.app.inject({ method: "DELETE", url: `/v1/trips/${c.tripId}/members/${await membershipId(c.tripId, c.userId)}`, headers: ownerHeaders(c) });
      ctl.mode = "up";
      assert.equal(h.siteBindings.get(siteKey(c.tripId, "dl17")), c.userId, "stale binding still there");
      // someone else is now Dana: the site's adopt REPLACES the leftover
      const next = tg(); await h.telegram.member(c.chatId, next, "member");
      const offer = (await launch(ctl.app, initDataFor(next, { tripId: c.tripId }))).json() as { travellers: { claimId: string; name: string }[] };
      const won = await claim(ctl.app, initDataFor(next, { tripId: c.tripId }), c.tripId, offer.travellers.find((x) => x.name === "Dana Levi")!.claimId);
      assert.equal(won.statusCode, 200, won.body);
      const newUser = (await h.pool.query("SELECT user_id FROM control_plane.trip_participant_claims WHERE trip_id = $1 AND released_at IS NULL", [c.tripId])).rows[0].user_id as string;
      assert.notEqual(newUser, c.userId);
      ctl.calls.length = 0;
      await pass(ctl, HOUR);
      assert.deepEqual(ctl.calls, [claimTriple(c)], "the late release is sent, for the old account");
      assert.equal(h.siteBindings.get(siteKey(c.tripId, "dl17")), newUser, "and the new binding survives it (the site matches account + name)");
      assert.equal((await rowsOf(c.tripId)).find((r) => r.user_id === c.userId)!.state, "done");
    } finally { await ctl.app.close(); }
  });

  test("a removed invited member re-invited before the retry lands: the late release names the OLD invite id and cannot remove the new invite's binding", async () => {
    const ctl = control(); const m = await inviteMember(ctl);
    try {
      ctl.mode = "down";
      await ctl.app.inject({ method: "DELETE", url: `/v1/trips/${m.tripId}/members/${await membershipId(m.tripId, m.userId)}`, headers: ownerHeaders(m) });
      ctl.mode = "up";
      const again = await createSiteInvite({ ...h.deps(), runtimeAccounts: { ...h.deps().runtimeAccounts, releaseParticipant: ctl.releaser.releaseParticipant } }, { tripId: m.tripId, actorUserId: m.owner, runtimeUsername: "dl17", replacePending: false });
      assert.ok(again.ok);
      const redeemed = await ctl.app.inject({ method: "POST", url: "/v1/site-invites/redeem", payload: { token: tokenOf((again as { joinUrl: string }).joinUrl), method: "password", password: "another-long-secret" } });
      assert.equal(redeemed.statusCode, 200, redeemed.body);
      const newUser = h.siteBindings.get(siteKey(m.tripId, "dl17"))!;
      ctl.calls.length = 0;
      await pass(ctl, HOUR);
      assert.deepEqual(ctl.calls, [{ tripId: m.tripId, userId: m.userId, runtimeUsername: "dl17", inviteId: m.inviteId }]);
      assert.equal(h.siteBindings.get(siteKey(m.tripId, "dl17")), newUser, "the new invite's binding is still there");
      assert.equal(h.siteHeld.has(siteKey(m.tripId, "dl17")), true);
    } finally { await ctl.app.close(); }
  });

  test("the SAME account bound to the same traveller again before the retry lands (a live claim of that account on that name): the pending claim release is superseded, not sent", async () => {
    const ctl = control(); const c = await claimed(ctl);
    try {
      ctl.mode = "down";
      await ctl.app.inject({ method: "DELETE", url: `/v1/trips/${c.tripId}/members/${await membershipId(c.tripId, c.userId)}`, headers: ownerHeaders(c) });
      ctl.mode = "up"; ctl.calls.length = 0;
      // the same account holds the traveller again (a path this code base does not have today: a claim mints a fresh account)
      await h.pool.query("UPDATE control_plane.trip_memberships SET status = 'active' WHERE trip_id = $1 AND user_id = $2", [c.tripId, c.userId]);
      await h.pool.query(
        "INSERT INTO control_plane.trip_participant_claims(id, trip_id, user_id, runtime_username, via, telegram_user_id) VALUES ($1, $2, $3, 'dl17', 'group_membership', $4)",
        [id("tpc"), c.tripId, c.userId, String(tg())]);
      await pass(ctl, HOUR);
      assert.deepEqual(ctl.calls, [], "the control plane holds that binding again: nothing is sent");
      assert.equal(h.siteBindings.get(siteKey(c.tripId, "dl17")), c.userId, "the binding stays");
      const [row] = await rowsOf(c.tripId);
      assert.deepEqual({ state: row!.state, outcome: row!.outcome }, { state: "done", outcome: "superseded" });
    } finally { await ctl.app.close(); }
  });

  test("the site's own rules the above lean on are in the shared case table both sides run: another account's release changes nothing, an invite binding is never released without its invite id", async () => {
    const { readFileSync } = await import("node:fs");
    const table = JSON.parse(readFileSync(new URL("../../../tests/fixtures/site-binding-cases.json", import.meta.url), "utf8")) as { release: { name: string }[] };
    const names = table.release.map((c) => c.name);
    assert.ok(names.includes("another account's release changes nothing"));
    assert.ok(names.includes("an invite-bound binding is never released through this path"));
    assert.ok(names.includes("...but not when the invite id named is another"));
  });
});

// ═══ 6. what the control plane guarantees while a release is pending ═════════════════════════════════════════════════════════════

describe("6. the window: what is closed and what is still reachable while a release is pending", { skip }, () => {
  test("a removed claimant is refused by the liveness check, the runtime launch, the Mini App and the session exchange; the pending record does not change that", async () => {
    const ctl = control(); const c = await claimed(ctl);
    try {
      const launched = await runtimeLaunch(c);
      assert.equal(launched.statusCode, 200);
      const unspent = launched.json().launchToken as string;
      ctl.mode = "down";
      assert.equal((await ctl.app.inject({ method: "DELETE", url: `/v1/trips/${c.tripId}/members/${await membershipId(c.tripId, c.userId)}`, headers: ownerHeaders(c) })).statusCode, 200);
      assert.equal((await rowsOf(c.tripId))[0]!.state, "pending", "the release is pending");
      const dead = await livenessCheck(c);
      assert.equal(dead.statusCode, 401); assert.deepEqual(dead.json(), { error: "SESSION_REVOKED" });
      assert.equal((await runtimeLaunch(c)).statusCode, 401, "no new launch");
      const again = await launch(ctl.app, initDataFor(c.person, { tripId: c.tripId }));
      assert.notEqual(again.json().kind, "session", "no Mini App sign-in: the person is offered the unclaimed names again, as any stranger in the group is");
      assert.equal(cookieOf(again, "kit_session"), null);
      const consumed = await ctl.app.inject({ method: "POST", url: "/internal/runtime-launch/consume", headers: { "x-api-key": "exchange-key", "content-type": "application/json" }, payload: JSON.stringify({ token: unspent }) });
      assert.notEqual(consumed.statusCode, 200, "a launch grant issued before the removal is spent with it");
      // What is NOT closed until the retry lands, stated as an observation of this tree: the trip site still holds the binding.
      assert.equal(h.siteBindings.get(siteKey(c.tripId, "dl17")), c.userId);
    } finally { await ctl.app.close(); }
  });
});

// ═══ 7. observability and retention ═══════════════════════════════════════════════════════════════════════════════════════════════

describe("7. observability and retention", { skip }, () => {
  test("the operator query counts pending releases older than 15 minutes, and only those", async () => {
    const t = await trip();
    const user = await h.mkUser("Someone");
    const before = Number((await h.pool.query(PENDING_OLDER_THAN_15_MINUTES_SQL)).rows[0].n);
    await h.pool.query("INSERT INTO control_plane.site_release_outbox(trip_id, user_id, runtime_username, reason, created_at) VALUES ($1, $2, 'dl17', 'organizer_released', now() - interval '20 minutes')", [t.tripId, user]);
    await h.pool.query("INSERT INTO control_plane.site_release_outbox(trip_id, user_id, runtime_username, reason, created_at) VALUES ($1, $2, 'nl23', 'organizer_released', now() - interval '5 minutes')", [t.tripId, user]);
    await h.pool.query("INSERT INTO control_plane.site_release_outbox(trip_id, user_id, runtime_username, reason, created_at, state, completed_at) VALUES ($1, $2, 'xx99', 'organizer_released', now() - interval '3 hours', 'done', now())", [t.tripId, user]);
    assert.equal(Number((await h.pool.query(PENDING_OLDER_THAN_15_MINUTES_SQL)).rows[0].n) - before, 1);
  });

  test("a release that is stuck is never silent: ONE `site_release.backlog` line per hour while a pending record is over 15 minutes old or a given-up one is under 30 days old, counts only, and nothing when there is none", async () => {
    const ctl = control();
    const t = await trip();
    const user = await h.mkUser("Someone");
    const T0 = Date.now();
    let believed = T0;
    const options: SiteReleaseOptions = { db: h.pool, releaser: ctl.releaser, log: (line) => h.logs.push(line), now: () => new Date(believed) };
    const lap = async (minutesAfterStart: number) => { believed = T0 + minutesAfterStart * MINUTE; h.logs.length = 0; await runSiteReleasePass(options); return eventsNamed("site_release.backlog"); };
    try {
      assert.deepEqual(await lap(0), [], "an empty outbox says nothing");
      // a pending record 5 minutes old (under the line), parked so no pass attempts it
      await h.pool.query("INSERT INTO control_plane.site_release_outbox(trip_id, user_id, runtime_username, reason, created_at, next_attempt_at) VALUES ($1, $2, 'dl17', 'organizer_released', $3, now() + interval '1000 days')", [t.tripId, user, new Date(T0 - 5 * MINUTE)]);
      assert.deepEqual(await lap(1), [], "pending for 6 minutes: not yet");
      assert.deepEqual(await lap(11), [{ level: "warn", event: "site_release.backlog", pending_over_15m: 1, given_up: 0 }], "16 minutes: the first line, counts only");
      assert.deepEqual(await lap(30), [], "the same backlog, inside the hour: silent");
      assert.deepEqual(await lap(70), [], "59 minutes after the line: silent");
      assert.equal((await lap(72)).length, 1, "an hour after the first line: again");
      assert.equal((await lap(100)).length, 0);
      assert.equal((await lap(133)).length, 1, "and the hour after that");
      // the pending one lands; a given-up one (a rotated key, a refusal) keeps the line coming for 30 days
      await h.pool.query("UPDATE control_plane.site_release_outbox SET state = 'done', outcome = 'released', completed_at = now() WHERE trip_id = $1", [t.tripId]);
      await h.pool.query("INSERT INTO control_plane.site_release_outbox(trip_id, user_id, runtime_username, reason, state, outcome, completed_at) VALUES ($1, $2, 'nl23', 'organizer_released', 'given_up', 'refused_403', $3)", [t.tripId, user, new Date(T0)]);
      assert.deepEqual(await lap(200), [{ level: "warn", event: "site_release.backlog", pending_over_15m: 0, given_up: 1 }]);
      assert.equal((await lap(230)).length, 0);
      assert.equal((await lap(262)).length, 1);
      // 31 days on, the given-up record is older than the line is for, and it stops
      assert.deepEqual(await lap(31 * 24 * 60), [], "past 30 days a given-up record is no longer young enough to report (the pass purges it by the database clock), so the line stops");
      assert.equal(h.logs.join("\n").includes("dl17") || h.logs.join("\n").includes(t.tripId), false);
    } finally { await ctl.app.close(); }
  });

  test("retention: a done record is purged after a day, a given-up one after 30 days, a pending one never", async () => {
    const ctl = control();
    const t = await trip();
    const user = await h.mkUser("Someone");
    try {
      const insert = (name: string, state: string, completedAgo: string | null) => h.pool.query(
        `INSERT INTO control_plane.site_release_outbox(trip_id, user_id, runtime_username, reason, state, completed_at, outcome)
         VALUES ($1, $2, $3, 'organizer_released', $4, ${completedAgo ? `now() - interval '${completedAgo}'` : "NULL"}, ${state === "pending" ? "NULL" : "'released'"})`, [t.tripId, user, name, state]);
      await insert("a1", "done", "2 hours"); await insert("a2", "done", "25 hours");
      await insert("a3", "given_up", "10 days"); await insert("a4", "given_up", "31 days");
      await insert("a5", "pending", null);
      await h.pool.query("UPDATE control_plane.site_release_outbox SET created_at = now() - interval '90 days', next_attempt_at = now() + interval '1000 days' WHERE runtime_username = 'a5'");
      await pass(ctl, 0);
      assert.deepEqual((await rowsOf(t.tripId)).map((r) => r.runtime_username).sort(), ["a1", "a3", "a5"]);
    } finally { await ctl.app.close(); }
  });

  test("no username, user id, invite id or trip id in the `superseded`, `attempt_error`, `record_failed` and `pass_error` lines either (each is provoked here, so none is vacuous)", async () => {
    const lines: string[] = [];
    const log = (line: string) => { lines.push(line); };
    const names = (e: string) => lines.map((l) => JSON.parse(l) as Record<string, unknown>).filter((x) => x.event === e);
    const ctl = control();
    const failing = (pattern: RegExp) => new Proxy(h.pool, {
      get(target, prop, receiver) {
        if (prop === "query") return (sql: unknown, ...rest: unknown[]) => (typeof sql === "string" && pattern.test(sql) ? Promise.reject(Object.assign(new Error("boom dl17"), { code: "XX000" })) : (target.query as (...a: unknown[]) => unknown)(sql, ...rest));
        const value = Reflect.get(target, prop, receiver);
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
    const secrets: string[] = ["dl17"];
    try {
      // superseded: the control plane holds that binding again
      const c = await claimed(ctl);
      secrets.push(c.tripId, c.userId);
      ctl.mode = "down";
      await ctl.app.inject({ method: "DELETE", url: `/v1/trips/${c.tripId}/members/${await membershipId(c.tripId, c.userId)}`, headers: ownerHeaders(c) });
      ctl.mode = "up";
      await h.pool.query("UPDATE control_plane.trip_memberships SET status = 'active' WHERE trip_id = $1 AND user_id = $2", [c.tripId, c.userId]);
      await h.pool.query("INSERT INTO control_plane.trip_participant_claims(id, trip_id, user_id, runtime_username, via, telegram_user_id) VALUES ($1, $2, $3, 'dl17', 'group_membership', $4)", [id("tpc"), c.tripId, c.userId, String(tg())]);
      await runSiteReleasePass({ db: h.pool, releaser: ctl.releaser, log, now: clockAt(HOUR) });
      assert.equal(names("site_release.superseded").length, 1);
      // attempt_error: the database fails while a row is being settled (the pass, then the prompt attempt)
      const d = await claimed(ctl);
      secrets.push(d.tripId, d.userId);
      ctl.mode = "down";
      await ctl.app.inject({ method: "DELETE", url: `/v1/trips/${d.tripId}/members/${await membershipId(d.tripId, d.userId)}`, headers: ownerHeaders(d) });
      await runSiteReleasePass({ db: failing(/SELECT 1 FROM control_plane\.trips t/), releaser: ctl.releaser, log, now: clockAt(2 * HOUR) });
      await h.pool.query("UPDATE control_plane.site_release_outbox SET claimed_until = NULL WHERE trip_id = $1", [d.tripId]);
      await attemptSiteReleaseFor(failing(/SELECT 1 FROM control_plane\.trips t/), ctl, d, log);
      assert.ok(names("site_release.attempt_error").length >= 2, "the pass and the prompt attempt each logged one");
      // record_failed: the record cannot be written
      await compensateSiteBinding({ db: failing(/INSERT INTO control_plane\.site_release_outbox/), releaser: ctl.releaser, log }, { tripId: d.tripId, userId: d.userId, runtimeUsername: "dl17" });
      assert.equal(names("site_release.record_failed").length, 1);
      // pass_error: the loop's pass itself fails
      let stop!: () => void;
      const seen = new Promise<void>((resolve) => {
        const loop = startSiteReleasePass({ db: failing(/DELETE FROM control_plane\.site_release_outbox/), releaser: ctl.releaser, intervalMs: 5, log: (line) => { log(line); if (line.includes("site_release.pass_error")) resolve(); } });
        stop = () => loop.stop();
      });
      await seen; stop();
      assert.ok(names("site_release.pass_error").length >= 1);
      for (const event of ["site_release.superseded", "site_release.attempt_error", "site_release.record_failed", "site_release.pass_error"]) {
        for (const line of lines.filter((l) => l.includes(event))) {
          for (const secret of secrets) assert.ok(!line.includes(secret), `${event} carries an identifier: ${line}`);
          assert.ok(!/dl17|user_|trip_|invite_/.test(line), `${event}: ${line}`);
        }
      }
    } finally { await ctl.app.close(); }
  });

  test("nothing in a log line from the whole run carries a user id, a username, an invite id, a trip id or a token", async () => {
    const everything = h.logs.join("\n");
    assert.ok(!/user_[A-Za-z0-9]{8,}|invite_[A-Za-z0-9]{8,}|trip_[A-Za-z0-9]{8,}|sl_[A-Za-z0-9_-]{20,}/.test(everything.split("\n").filter((line) => line.includes("site_release.")).join("\n")), "site_release.* lines name no id");
  });
});

