/**
 * AC-7 of docs/specs/sprint-9/x-member-sign-in.md: the organizers' side of a group claim.
 *
 *   - a claim queues ONE notice per organizer chat, in the trip's language, through the outbox the other sign-in
 *     notices use;
 *   - GET /v1/trips/:id/member-claims lists every live claim, for an organizer only;
 *   - DELETE /v1/trips/:id/member-claims/:claimId releases one: the claim ends, the link is revoked, the sessions it
 *     minted end, and the traveller can be claimed again. For a member or a stranger both routes answer exactly what
 *     they answer for a trip that does not exist.
 */
import assert from "node:assert/strict";
import { after, before, describe, test } from "node:test";
import type { NotificationAdapter } from "../src/adapters/notification.js";
import { dispatchPendingTripNotifications } from "../src/outbox-dispatcher.js";
import {
  ORIGIN, asCookie, claim, cookieOf, initDataFor, launch, startHarness, tg, type Harness, type SitePerson,
} from "./support/group-sign-in-harness.js";
import { testDatabaseUrl } from "./support/test-database.js";

const skip = !testDatabaseUrl();
let h: Harness;
before(async () => { if (!skip) h = await startHarness(); });
after(async () => { if (!skip) await h.stop(); });

const PEOPLE: SitePerson[] = [
  { username: "dl17", displayName: "Dana Levi", role: "member" },
  { username: "nl23", displayName: "Noam Levi", role: "member" },
];

async function tripWithOrganizer(opts: { language?: string; extraOrganizerChats?: number } = {}) {
  const tripId = await h.mkTrip("Alsace in December");
  const owner = await h.mkUser("The Owner");
  await h.mkMember(tripId, owner, "owner");
  const groupChat = await h.bindGroup(tripId);
  const ownerChat = tg();
  await h.bindPrivate(tripId, ownerChat);
  const moreChats: number[] = [];
  for (let i = 0; i < (opts.extraOrganizerChats ?? 0); i++) { const chat = tg(); await h.bindPrivate(tripId, chat); moreChats.push(chat); }
  await h.switchOn(tripId);
  if (opts.language) await h.setLanguage(tripId, opts.language);
  h.site.set(tripId, PEOPLE.map((p) => ({ ...p })));
  const ownerSession = await h.webSession(owner, "owner");
  return { tripId, owner, groupChat, ownerChat, moreChats, ownerSession };
}

type App = ReturnType<Harness["newApp"]>;
async function claimDana(app: App, ctx: { tripId: string; groupChat: string }, who: { id?: number; firstName?: string; username?: string; name?: string } = {}) {
  const person = who.id ?? tg();
  await h.telegram.member(ctx.groupChat, person, "member");
  const offer = (await launch(app, initDataFor(person, { tripId: ctx.tripId }))).json() as { travellers: { claimId: string; name: string }[] };
  const claimId = offer.travellers.find((t) => t.name === (who.name ?? "Dana Levi"))!.claimId;
  const response = await claim(app, initDataFor(person, { tripId: ctx.tripId, ...(who.firstName ? { firstName: who.firstName } : {}), ...(who.username ? { username: who.username } : {}) }), ctx.tripId, claimId);
  assert.equal(response.statusCode, 200, response.body);
  return { person, response, offer };
}

const noticeRows = async (tripId?: string) => (await h.pool.query(
  `SELECT recipient, state, trip_id, payload FROM control_plane.notification_outbox
    WHERE notification_type = 'mini_app_sign_in_notice' AND payload ->> 'link_kind' = 'group_claim'
      ${tripId ? "AND payload ->> 'trip_id' = $1" : ""} ORDER BY recipient`, tripId ? [tripId] : [])).rows as
  Array<{ recipient: string | null; state: string; trip_id: string | null; payload: Record<string, unknown> }>;

function capture() {
  const sent: { chatId: string; text: string }[] = [];
  const adapter = { sendMessage: async (m: { chatId: string; text: string }) => { sent.push({ chatId: m.chatId, text: m.text }); }, sendOperatorMessage: async () => {} } as unknown as NotificationAdapter;
  return { sent, adapter };
}

describe("AC-7: the notice", { skip }, () => {
  test("a claim queues one notice per organizer chat (not the group, not the claimer), in the trip's language, and it is sent through the shared outbox", async () => {
    const ctx = await tripWithOrganizer({ language: "he", extraOrganizerChats: 1 });
    const app = h.newApp();
    try {
      await h.pool.query("DELETE FROM control_plane.notification_outbox");
      const { person } = await claimDana(app, ctx, { firstName: "Maya", username: "maya_tg" });
      const rows = await noticeRows();
      assert.deepEqual(rows.map((r) => r.recipient).sort(), [String(ctx.ownerChat), String(ctx.moreChats[0])].sort(), "the organizers' own chats, once each");
      assert.ok(rows.every((r) => r.state === "pending"));
      assert.ok(rows.every((r) => r.recipient !== ctx.groupChat && r.recipient !== String(person)));
      for (const row of rows) {
        assert.equal(row.payload.language, "he");
        assert.equal(row.payload.traveller_name, "Dana Levi");
        assert.equal(row.payload.telegram_first_name, "Maya");
      }

      const { sent, adapter } = capture();
      await dispatchPendingTripNotifications(h.pool, adapter, () => {}, { publicOrigin: ORIGIN });
      const mine = sent.filter((m) => [String(ctx.ownerChat), String(ctx.moreChats[0])].includes(m.chatId));
      assert.equal(mine.length, 2);
      for (const message of mine) {
        assert.match(message.text, /Maya/);
        assert.match(message.text, /Dana Levi/);
        assert.match(message.text, /[֐-׿]/, "Hebrew for a Hebrew trip");
        assert.doesNotMatch(message.text, /signed in as/i, "and only Hebrew: the notice is in the trip's language");
      }
      const done = (await noticeRows()).map((r) => r.recipient);
      assert.ok(done.every((r) => r === null), "the raw Telegram chat ids do not stay at rest after sending");
    } finally { await app.close(); }
  });

  test("an English trip gets the English sentence: \"<first name> signed in as <traveller> from the trip group\"", async () => {
    const ctx = await tripWithOrganizer({ language: "en" });
    const app = h.newApp();
    try {
      await h.pool.query("DELETE FROM control_plane.notification_outbox");
      await claimDana(app, ctx, { firstName: "Maya" });
      const { sent, adapter } = capture();
      await dispatchPendingTripNotifications(h.pool, adapter, () => {}, { publicOrigin: ORIGIN });
      const text = sent.find((m) => m.chatId === String(ctx.ownerChat))?.text ?? "";
      assert.match(text, /Maya signed in as Dana Levi from the trip group/);
      assert.doesNotMatch(text, /[֐-׿]/);
    } finally { await app.close(); }
  });

  test("no language on file reads as English, and a refused second claim queues no notice", async () => {
    const ctx = await tripWithOrganizer();
    const app = h.newApp();
    try {
      await h.pool.query("DELETE FROM control_plane.notification_outbox");
      await claimDana(app, ctx, { firstName: "Maya" });
      const rows = await noticeRows();
      assert.equal(rows.length, 1);
      assert.equal(rows[0]!.payload.language, "en");
      // a second person claiming the same name is refused and says nothing to anyone
      const second = tg();
      await h.telegram.member(ctx.groupChat, second, "member");
      const offer = (await launch(app, initDataFor(second, { tripId: ctx.tripId }))).json() as { travellers: { claimId: string; name: string }[] };
      assert.deepEqual(offer.travellers.map((t) => t.name), ["Noam Levi"], "dana is gone from the list");
      assert.equal((await noticeRows()).length, 1);
    } finally { await app.close(); }
  });
});

describe("AC-7: listing claims is for organizers only", { skip }, () => {
  test("an organizer sees every live claim: the traveller, the Telegram first name and @username, and when", async () => {
    const ctx = await tripWithOrganizer();
    const app = h.newApp();
    try {
      const empty = await app.inject({ method: "GET", url: `/v1/trips/${ctx.tripId}/member-claims`, headers: { cookie: ctx.ownerSession.cookie } });
      assert.equal(empty.statusCode, 200);
      assert.deepEqual(empty.json(), { claims: [] });
      await claimDana(app, ctx, { firstName: "Maya", username: "maya_tg" });
      await claimDana(app, ctx, { name: "Noam Levi", firstName: "Avi" });
      const list = await app.inject({ method: "GET", url: `/v1/trips/${ctx.tripId}/member-claims`, headers: { cookie: ctx.ownerSession.cookie } });
      assert.equal(list.statusCode, 200, list.body);
      assert.equal(list.headers["cache-control"], "private, no-store");
      const { claims } = list.json() as { claims: Array<Record<string, unknown>> };
      assert.equal(claims.length, 2);
      const dana = claims.find((c) => c.travellerName === "Dana Levi")!;
      assert.deepEqual(Object.keys(dana).sort(), ["claimId", "claimedAt", "lastSignedInAt", "telegramFirstName", "telegramUsername", "travellerName", "via"].sort());
      assert.match(String(dana.claimId), /^tpc_[0-9a-f]{32}$/);
      assert.equal(dana.via, "group_membership");
      assert.equal(dana.telegramFirstName, "Maya");
      assert.equal(dana.telegramUsername, "maya_tg");
      assert.ok(!Number.isNaN(Date.parse(String(dana.claimedAt))));
      assert.ok(!list.body.includes("dl17") && !list.body.includes("sha256:"), "no site username, no digest");
      const noam = claims.find((c) => c.travellerName === "Noam Levi")!;
      assert.equal(noam.telegramFirstName, "Avi");
      assert.equal(noam.telegramUsername, null);
    } finally { await app.close(); }
  });

  test("a member of the trip, a stranger, someone with no session and an unknown trip all get the same refusal an unknown trip gets", async () => {
    const ctx = await tripWithOrganizer();
    const app = h.newApp();
    try {
      const { response: memberSession } = await claimDana(app, ctx);
      const memberCookie = asCookie(memberSession);
      const stranger = await h.webSession(await h.mkUser("Stranger"), "stranger");
      const otherOwner = await h.webSession(await (async () => { const u = await h.mkUser("Other owner"); const t = await h.mkTrip("Other trip"); await h.mkMember(t, u, "owner"); return u; })(), "other-owner");
      const secondary = await (async () => { const u = await h.mkUser("Secondary"); await h.mkMember(ctx.tripId, u, "organizer", { dashboard: false }); return h.webSession(u, "secondary"); })();
      const get = (id: string, cookie?: string) => app.inject({ method: "GET", url: `/v1/trips/${id}/member-claims`, headers: cookie ? { cookie } : {} });
      // Each caller is held to what THAT caller is told about a trip that does not exist.
      for (const [name, cookie] of [["the claimed member", memberCookie], ["a stranger", stranger.cookie], ["another trip's owner", otherOwner.cookie], ["an organizer without the dashboard", secondary.cookie]] as const) {
        const unknown = await get("trip_doesnotexist0000", cookie);
        assert.equal(unknown.statusCode, 404, name);
        const response = await get(ctx.tripId, cookie);
        assert.equal(response.statusCode, unknown.statusCode, name);
        assert.equal(response.body, unknown.body, name);
      }
      assert.equal((await get(ctx.tripId)).statusCode, 401, "no session at all");
    } finally { await app.close(); }
  });
});

describe("AC-7: release", { skip }, () => {
  async function claimedTrip() {
    const ctx = await tripWithOrganizer();
    const app = h.newApp();
    const first = await claimDana(app, ctx, { firstName: "Maya" });
    const list = (await app.inject({ method: "GET", url: `/v1/trips/${ctx.tripId}/member-claims`, headers: { cookie: ctx.ownerSession.cookie } })).json() as { claims: { claimId: string }[] };
    const link = (await h.pool.query("SELECT id, user_id FROM control_plane.telegram_member_links WHERE trip_id = $1", [ctx.tripId])).rows[0] as { id: string; user_id: string };
    return { ...ctx, app, ...first, claimId: list.claims[0]!.claimId, link };
  }
  const release = (app: App, tripId: string, claimId: string, session: { cookie: string; csrf: string }, extra: Record<string, string> = {}) =>
    app.inject({ method: "DELETE", url: `/v1/trips/${tripId}/member-claims/${claimId}`, headers: { origin: ORIGIN, cookie: session.cookie, "x-csrf-token": session.csrf, ...extra } });

  test("an organizer's release ends the claim, revokes the link, ends the sessions it minted, and makes the traveller claimable again", async () => {
    const c = await claimedTrip();
    try {
      // an open trip session of the claimed person, to prove it ends
      const launched = await c.app.inject({ method: "POST", url: `/v1/trips/${c.tripId}/launch`, headers: { origin: ORIGIN, cookie: asCookie(c.response), "x-csrf-token": cookieOf(c.response, "kit_csrf")! } });
      const grant = (await c.app.inject({ method: "POST", url: "/internal/runtime-launch/consume", headers: { "x-api-key": "exchange-key", "content-type": "application/json" }, payload: JSON.stringify({ token: launched.json().launchToken }) })).json();
      const check = () => c.app.inject({ method: "POST", url: "/internal/runtime-sessions/check", headers: { "x-api-key": "exchange-key", "content-type": "application/json" }, payload: JSON.stringify({ tripId: c.tripId, userId: grant.userId, sessionId: grant.sessionId, role: "member" }) });
      assert.equal((await check()).statusCode, 200);

      const response = await release(c.app, c.tripId, c.claimId, c.ownerSession);
      assert.equal(response.statusCode, 200, response.body);
      assert.deepEqual(response.json(), { status: "released" });

      const claimRow = (await h.pool.query("SELECT released_at, released_reason FROM control_plane.trip_participant_claims WHERE id = $1", [c.claimId])).rows[0];
      assert.ok(claimRow.released_at); assert.equal(claimRow.released_reason, "organizer_released");
      const link = (await h.pool.query("SELECT revoked_at, revoked_reason FROM control_plane.telegram_member_links WHERE id = $1", [c.link.id])).rows[0];
      assert.ok(link.revoked_at); assert.equal(link.revoked_reason, "claim_released");
      assert.equal((await h.pool.query("SELECT count(*)::int AS n FROM control_plane.web_sessions WHERE user_id = $1 AND revoked_at IS NULL", [c.link.user_id])).rows[0].n, 0);
      assert.equal((await c.app.inject({ method: "GET", url: "/v1/me", headers: { cookie: asCookie(c.response) } })).statusCode, 401, "the cookie the claim minted is dead");
      const ended = await check();
      assert.equal(ended.statusCode, 401);
      assert.deepEqual(ended.json(), { error: "SESSION_REVOKED" });

      // gone from the list, and claimable again — by the same person or another
      const list = (await c.app.inject({ method: "GET", url: `/v1/trips/${c.tripId}/member-claims`, headers: { cookie: c.ownerSession.cookie } })).json();
      assert.deepEqual(list, { claims: [] });
      const again = await launch(c.app, initDataFor(c.person, { tripId: c.tripId }));
      assert.equal(again.statusCode, 200);
      assert.equal(again.json().kind, "claim", "the released person is offered the list again, not signed in");
      assert.ok(again.json().travellers.some((t: { name: string }) => t.name === "Dana Levi"));
      const next = tg();
      await h.telegram.member(c.groupChat, next, "member");
      const offer = (await launch(c.app, initDataFor(next, { tripId: c.tripId }))).json() as { travellers: { claimId: string; name: string }[] };
      const reclaimed = await claim(c.app, initDataFor(next, { tripId: c.tripId }), c.tripId, offer.travellers.find((t) => t.name === "Dana Levi")!.claimId);
      assert.equal(reclaimed.statusCode, 200, reclaimed.body);
      assert.equal((await h.pool.query("SELECT count(*)::int AS n FROM control_plane.trip_participant_claims WHERE trip_id = $1 AND runtime_username = 'dl17' AND released_at IS NULL", [c.tripId])).rows[0].n, 1);

      // releasing it twice is the refusal an unknown claim gets
      const twice = await release(c.app, c.tripId, c.claimId, c.ownerSession);
      assert.equal(twice.statusCode, 404);
      assert.deepEqual(twice.json(), { error: "NOT_FOUND" });
    } finally { await c.app.close(); }
  });

  test("a member, a stranger, another trip's owner, a missing CSRF token, a foreign claim id and an unknown id are all refused, and nothing changes", async () => {
    const c = await claimedTrip();
    try {
      const stranger = await h.webSession(await h.mkUser("Stranger"), "stranger-r");
      const otherTrip = await h.mkTrip("Another");
      const otherOwner = await h.mkUser("Other owner"); await h.mkMember(otherTrip, otherOwner, "owner");
      const otherSession = await h.webSession(otherOwner, "other-owner-r");
      const memberSession = { cookie: asCookie(c.response), csrf: cookieOf(c.response, "kit_csrf")! };
      const none = "tpc_00000000000000000000000000000000", noTrip = "trip_doesnotexist0000";
      assert.equal((await release(c.app, c.tripId, none, c.ownerSession)).statusCode, 404, "the owner naming a claim that does not exist");
      // Each caller is held to what THAT caller is told about a trip and a claim that do not exist: the refusal reveals nothing.
      for (const [name, caller, tripId] of [
        ["the claimed member", memberSession, c.tripId],
        ["a stranger", stranger, c.tripId],
        ["another trip's owner, aiming at this trip", otherSession, c.tripId],
        ["another trip's owner, with this trip's claim on their own trip", otherSession, otherTrip],
      ] as const) {
        const unknown = await release(c.app, noTrip, none, caller);
        assert.ok([403, 404].includes(unknown.statusCode), name);
        const real = await release(c.app, tripId, c.claimId, caller);
        assert.equal(real.statusCode, unknown.statusCode, name);
        assert.equal(real.body, unknown.body, name);
      }
      const noCsrf = await release(c.app, c.tripId, c.claimId, { cookie: c.ownerSession.cookie, csrf: "wrong" });
      assert.equal(noCsrf.statusCode, 403);
      assert.deepEqual(noCsrf.json(), { error: "CSRF_INVALID" });
      const badOrigin = await release(c.app, c.tripId, c.claimId, c.ownerSession, { origin: "https://evil.example" });
      assert.equal(badOrigin.statusCode, 403);
      const after = (await h.pool.query("SELECT released_at FROM control_plane.trip_participant_claims WHERE id = $1", [c.claimId])).rows[0];
      assert.equal(after.released_at, null, "still claimed");
      const link = (await h.pool.query("SELECT revoked_at FROM control_plane.telegram_member_links WHERE id = $1", [c.link.id])).rows[0];
      assert.equal(link.revoked_at, null);
    } finally { await c.app.close(); }
  });

  test("an organizer removing the member in the ordinary way frees the traveller too (the claim follows the membership)", async () => {
    const c = await claimedTrip();
    try {
      const membershipId = (await h.pool.query("SELECT id FROM control_plane.trip_memberships WHERE trip_id = $1 AND user_id = $2", [c.tripId, c.link.user_id])).rows[0].id;
      const removed = await c.app.inject({ method: "DELETE", url: `/v1/trips/${c.tripId}/members/${membershipId}`, headers: { origin: ORIGIN, cookie: c.ownerSession.cookie, "x-csrf-token": c.ownerSession.csrf } });
      assert.equal(removed.statusCode, 200, removed.body);
      const claimRow = (await h.pool.query("SELECT released_at, released_reason FROM control_plane.trip_participant_claims WHERE id = $1", [c.claimId])).rows[0];
      assert.ok(claimRow.released_at);
      assert.equal(claimRow.released_reason, "membership_ended");
    } finally { await c.app.close(); }
  });
});
