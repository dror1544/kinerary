/**
 * The runtime gateway's hop for the organizers' claims list and Release
 * (docs/specs/sprint-9/x-member-sign-in.md, AC-7 and amendment A5):
 *
 *   POST /internal/member-claims/list     { tripId, userId, sessionId }
 *   POST /internal/member-claims/release  { tripId, userId, sessionId, claimId }
 *
 * The gateway says who it heard from (a sealed trip-site session); this service decides everything again, from the database:
 * the key, a live session that is that user's, owner/organizer of THIS trip with dashboard access, the feature on, and the
 * session's scope by the portal routes' own policy rows. Everyone else gets one byte-identical 404.
 */
import assert from "node:assert/strict";
import { after, before, describe, test } from "node:test";
import { scopedSessionDigest } from "../src/portal-scope.js";
import {
  ORIGIN, asCookie, claim, cookieOf, digestTelegramId, id, initDataFor, launch, sha256, startHarness, tg, type Harness, type SitePerson,
} from "./support/group-sign-in-harness.js";
import { testDatabaseUrl } from "./support/test-database.js";

const skip = !testDatabaseUrl();
let h: Harness;
before(async () => { if (!skip) h = await startHarness(); });
after(async () => { if (!skip) await h.stop(); });

const KEY = "exchange-key";
const PEOPLE: SitePerson[] = [
  { username: "dl17", displayName: "Dana Levi", role: "member" },
  { username: "nl23", displayName: "Noam Levi", role: "member" },
];
type App = ReturnType<Harness["newApp"]>;

const sessionIdOf = async (raw: string) => (await h.pool.query("SELECT id FROM control_plane.web_sessions WHERE token_digest = $1", [sha256(raw)])).rows[0].id as string;
const userOf = async (sessionId: string) => (await h.pool.query("SELECT user_id FROM control_plane.web_sessions WHERE id = $1", [sessionId])).rows[0].user_id as string;

interface Who { userId: string; sessionId: string }
async function fullSession(userId: string, label: string): Promise<Who & { raw: string }> {
  const s = await h.webSession(userId, label);
  return { userId, sessionId: await sessionIdOf(s.raw), raw: s.raw };
}
/** An organizer's session a Telegram link minted (the Mini App): scoped to the trips that Telegram account is linked to. */
async function scopedOrganizerSession(userId: string, tripId: string, label: string): Promise<Who> {
  const linkId = `otl_${id("x").replace(/[^A-Za-z0-9]/g, "")}`;
  await h.pool.query(
    "INSERT INTO control_plane.telegram_organizer_trip_links(id,user_id,trip_id,telegram_subject_digest,verified_via) VALUES ($1,$2,$3,$4,'enrollment_redemption')",
    [linkId, userId, tripId, digestTelegramId(String(tg()))]);
  const raw = `scoped-${label}-${id("s")}`;
  const sessionId = id("wsess");
  await h.pool.query(
    "INSERT INTO control_plane.web_sessions(id,user_id,token_digest,csrf_digest,expires_at,telegram_link_id) VALUES ($1,$2,$3,$4,now() + interval '1 hour',$5)",
    [sessionId, userId, scopedSessionDigest(raw), sha256("csrf"), linkId]);
  return { userId, sessionId };
}

async function fixture() {
  const tripId = await h.mkTrip("Alsace in December");
  const owner = await h.mkUser("The Owner");
  await h.mkMember(tripId, owner, "owner");
  const groupChat = await h.bindGroup(tripId);
  await h.bindPrivate(tripId, tg());
  await h.switchOn(tripId);
  h.site.set(tripId, PEOPLE.map((p) => ({ ...p })));
  const ownerSession = await fullSession(owner, "owner");
  const app = h.newApp();
  // Dana claims her name from the group (the way the real thing happens).
  const person = tg();
  await h.telegram.member(groupChat, person, "member");
  const offer = (await launch(app, initDataFor(person, { tripId }))).json() as { travellers: { claimId: string; name: string }[] };
  const pickId = offer.travellers.find((t) => t.name === "Dana Levi")!.claimId;
  const claimed = await claim(app, initDataFor(person, { tripId, firstName: "Maya", username: "maya_tg" }), tripId, pickId);
  assert.equal(claimed.statusCode, 200, claimed.body);
  // The id the organizers see is the claim row's own (tpc_...), not the one-time pick id the offer carried.
  const claimId = (await h.pool.query("SELECT id FROM control_plane.trip_participant_claims WHERE trip_id = $1 AND released_at IS NULL", [tripId])).rows[0].id as string;
  // the claim's session is scoped: stored under the scoped digest
  const memberSessionId = (await h.pool.query("SELECT id FROM control_plane.web_sessions WHERE token_digest = $1", [scopedSessionDigest(cookieOf(claimed, "kit_session")!)])).rows[0].id as string;
  const memberUser = await userOf(memberSessionId);
  return { tripId, owner, ownerSession, app, claimId, claimedResponse: claimed, member: { userId: memberUser, sessionId: memberSessionId } as Who, groupChat, person };
}

const post = (app: App, path: string, body: unknown, headers: Record<string, string> = { "x-api-key": KEY }) =>
  app.inject({ method: "POST", url: path, headers: { "content-type": "application/json", ...headers }, payload: JSON.stringify(body) });
const list = (app: App, tripId: string, who: Who, headers?: Record<string, string>) => post(app, "/internal/member-claims/list", { tripId, ...who }, headers);
const release = (app: App, tripId: string, who: Who, claimId: string, headers?: Record<string, string>) => post(app, "/internal/member-claims/release", { tripId, ...who, claimId }, headers);
const claimRow = async (claimId: string) => (await h.pool.query("SELECT released_at, released_reason FROM control_plane.trip_participant_claims WHERE id = $1", [claimId])).rows[0] as { released_at: Date | null; released_reason: string | null };

describe("the gateway's claims list and Release", { skip }, () => {
  test("an organizer's trip-site session lists the claims, and the list is the portal route's own answer", async () => {
    const f = await fixture();
    try {
      const response = await list(f.app, f.tripId, f.ownerSession);
      assert.equal(response.statusCode, 200, response.body);
      assert.equal(response.headers["cache-control"], "no-store");
      const portal = await f.app.inject({ method: "GET", url: `/v1/trips/${f.tripId}/member-claims`, headers: { cookie: `kit_session=${f.ownerSession.raw}` } });
      assert.equal(portal.statusCode, 200, portal.body);
      assert.deepEqual(response.json(), portal.json(), "one implementation, two doors");
      const { claims } = response.json() as { claims: Array<Record<string, unknown>> };
      assert.equal(claims.length, 1);
      assert.equal(claims[0]!.claimId, f.claimId);
      assert.equal(claims[0]!.travellerName, "Dana Levi");
      assert.equal(claims[0]!.telegramFirstName, "Maya");
      assert.equal(claims[0]!.telegramUsername, "maya_tg");
      assert.ok(!response.body.includes("dl17") && !response.body.includes("sha256:"), "no site username, no digest");
    } finally { await f.app.close(); }
  });

  test("Release has the effects of the portal route's: claim ended, link revoked, its sessions ended, the site binding released, the name claimable again", async () => {
    const f = await fixture();
    try {
      const link = (await h.pool.query("SELECT id FROM control_plane.telegram_member_links WHERE trip_id = $1", [f.tripId])).rows[0] as { id: string };
      const releasedBefore = h.siteCalls.release.length;
      const response = await release(f.app, f.tripId, f.ownerSession, f.claimId);
      assert.equal(response.statusCode, 200, response.body);
      assert.deepEqual(response.json(), { status: "released" });
      const row = await claimRow(f.claimId);
      assert.ok(row.released_at); assert.equal(row.released_reason, "organizer_released");
      const linkRow = (await h.pool.query("SELECT revoked_at, revoked_reason FROM control_plane.telegram_member_links WHERE id = $1", [link.id])).rows[0];
      assert.ok(linkRow.revoked_at); assert.equal(linkRow.revoked_reason, "claim_released");
      assert.equal((await h.pool.query("SELECT count(*)::int AS n FROM control_plane.web_sessions WHERE user_id = $1 AND revoked_at IS NULL", [f.member.userId])).rows[0].n, 0);
      assert.equal((await f.app.inject({ method: "GET", url: "/v1/me", headers: { cookie: asCookie(f.claimedResponse) } })).statusCode, 401, "the cookie the claim minted is dead");
      assert.equal(h.siteCalls.release.length, releasedBefore + 1, "the trip site's binding was released");
      assert.deepEqual((await list(f.app, f.tripId, f.ownerSession)).json(), { claims: [] });
      // claimable again, by the same person
      const again = await launch(f.app, initDataFor(f.person, { tripId: f.tripId }));
      assert.equal(again.json().kind, "claim");
      assert.ok(again.json().travellers.some((t: { name: string }) => t.name === "Dana Levi"));
      // twice is the refusal an unknown claim gets
      const twice = await release(f.app, f.tripId, f.ownerSession, f.claimId);
      assert.equal(twice.statusCode, 404);
      assert.deepEqual(twice.json(), { error: "NOT_FOUND" });
    } finally { await f.app.close(); }
  });

  test("a member, a claimed member, a stranger, another trip's owner, a secondary organizer, a dead session and a foreign session are one byte-identical 404, and nothing changes", async () => {
    const f = await fixture();
    try {
      const stranger = await fullSession(await h.mkUser("Stranger"), "stranger");
      const otherTrip = await h.mkTrip("Other trip");
      const otherOwnerUser = await h.mkUser("Other owner"); await h.mkMember(otherTrip, otherOwnerUser, "owner");
      const otherOwner = await fullSession(otherOwnerUser, "other-owner");
      const plainMemberUser = await h.mkUser("Plain member"); await h.mkMember(f.tripId, plainMemberUser, "member");
      const plainMember = await fullSession(plainMemberUser, "plain-member");
      const secondaryUser = await h.mkUser("Secondary"); await h.mkMember(f.tripId, secondaryUser, "organizer", { dashboard: false });
      const secondary = await fullSession(secondaryUser, "secondary");
      const deadOwner = await fullSession(f.owner, "dead-owner");
      await h.pool.query("UPDATE control_plane.web_sessions SET revoked_at = now() WHERE id = $1", [deadOwner.sessionId]);
      const expiredOwner = await fullSession(f.owner, "expired-owner");
      await h.pool.query("UPDATE control_plane.web_sessions SET expires_at = now() - interval '1 minute' WHERE id = $1", [expiredOwner.sessionId]);
      const disabledOwnerUser = await h.mkUser("Disabled"); await h.mkMember(f.tripId, disabledOwnerUser, "organizer");
      const disabledOwner = await fullSession(disabledOwnerUser, "disabled");
      await h.pool.query("UPDATE control_plane.users SET status = 'suspended' WHERE id = $1", [disabledOwnerUser]);
      const callers: Array<[string, Who]> = [
        ["the claimed member (the session the claim minted)", f.member],
        ["a plain member", plainMember],
        ["a stranger", stranger],
        ["another trip's owner", otherOwner],
        ["an organizer without the dashboard", secondary],
        ["the owner's revoked session", deadOwner],
        ["the owner's expired session", expiredOwner],
        ["the owner's user id with a stranger's session", { userId: f.owner, sessionId: stranger.sessionId }],
        ["a stranger's user id with the owner's session", { userId: stranger.userId, sessionId: f.ownerSession.sessionId }],
        ["a disabled organizer", disabledOwner],
        ["a session id that does not exist", { userId: f.owner, sessionId: "wsess_doesnotexist" }],
      ];
      const none = "tpc_00000000000000000000000000000000", ghost = "trip_doesnotexist0000";
      const unknownList = await list(f.app, ghost, f.ownerSession);
      assert.equal(unknownList.statusCode, 404);
      assert.equal(unknownList.body, '{"error":"NOT_FOUND"}');
      for (const [name, who] of callers) {
        const l = await list(f.app, f.tripId, who);
        assert.equal(l.statusCode, 404, `list: ${name}`);
        assert.equal(l.body, unknownList.body, `list: ${name}`);
        const r = await release(f.app, f.tripId, who, f.claimId);
        assert.equal(r.statusCode, 404, `release: ${name}`);
        assert.equal(r.body, unknownList.body, `release: ${name}`);
        // another trip's organizer naming THIS claim on their own trip
        const own = await release(f.app, otherTrip, who, f.claimId);
        assert.equal(own.statusCode, 404, `release on another trip: ${name}`);
      }
      assert.equal((await release(f.app, f.tripId, otherOwner, f.claimId)).body, unknownList.body);
      assert.equal((await claimRow(f.claimId)).released_at, null, "still claimed");
      assert.equal((await h.pool.query("SELECT count(*)::int AS n FROM control_plane.telegram_member_links WHERE trip_id = $1 AND revoked_at IS NULL", [f.tripId])).rows[0].n, 1);
      // the owner naming a claim that is not there, or is not shaped like one, is the same 404
      assert.equal((await release(f.app, f.tripId, f.ownerSession, none)).body, unknownList.body);
      assert.equal((await release(f.app, f.tripId, f.ownerSession, "x")).body, unknownList.body);
    } finally { await f.app.close(); }
  });

  test("the key: none, a wrong one and the portal's own cookie are 401 and reveal and change nothing", async () => {
    const f = await fixture();
    try {
      for (const headers of [{}, { "x-api-key": "wrong" }, { "x-api-key": "" }, { cookie: `kit_session=${f.ownerSession.raw}` }]) {
        const l = await list(f.app, f.tripId, f.ownerSession, headers);
        assert.equal(l.statusCode, 401, JSON.stringify(headers));
        assert.deepEqual(l.json(), { error: "AUTHENTICATION_REQUIRED" });
        const r = await release(f.app, f.tripId, f.ownerSession, f.claimId, headers);
        assert.equal(r.statusCode, 401);
      }
      assert.equal((await claimRow(f.claimId)).released_at, null);
    } finally { await f.app.close(); }
  });

  test("a body that says it is an owner changes nothing: role, dashboard and the like are never read", async () => {
    const f = await fixture();
    try {
      const response = await post(f.app, "/internal/member-claims/list", { tripId: f.tripId, ...f.member, role: "owner", dashboard_access: true, organizer: true });
      assert.equal(response.statusCode, 404);
      const release2 = await post(f.app, "/internal/member-claims/release", { tripId: f.tripId, ...f.member, claimId: f.claimId, role: "owner" });
      assert.equal(release2.statusCode, 404);
      assert.equal((await claimRow(f.claimId)).released_at, null);
    } finally { await f.app.close(); }
  });

  test("a body that is not shaped like the gateway's is a 400 that names nothing", async () => {
    const f = await fixture();
    try {
      for (const body of [{}, { tripId: f.tripId }, { tripId: f.tripId, userId: f.owner }, { tripId: "not-a-trip", userId: f.owner, sessionId: f.ownerSession.sessionId }, { tripId: f.tripId, userId: 7, sessionId: "s" }]) {
        const l = await post(f.app, "/internal/member-claims/list", body);
        assert.equal(l.statusCode, 400, JSON.stringify(body));
        assert.deepEqual(l.json(), { error: "INVALID_REQUEST" });
      }
      assert.equal((await post(f.app, "/internal/member-claims/release", { tripId: f.tripId, ...f.ownerSession })).statusCode, 400, "no claim id");
    } finally { await f.app.close(); }
  });

  test("the switch: off (or never set) answers as an unknown trip, on again works, and nothing is released while off", async () => {
    const f = await fixture();
    try {
      await h.switchOn(f.tripId, false);
      const off = await list(f.app, f.tripId, f.ownerSession);
      assert.equal(off.statusCode, 404);
      assert.equal(off.body, '{"error":"NOT_FOUND"}');
      assert.equal((await release(f.app, f.tripId, f.ownerSession, f.claimId)).statusCode, 404);
      assert.equal((await claimRow(f.claimId)).released_at, null, "still claimed; the portal route can still release it");
      await h.pool.query("DELETE FROM control_plane.feature_switch_settings WHERE switch = 'member_group_sign_in' AND trip_id = $1", [f.tripId]);
      assert.equal((await list(f.app, f.tripId, f.ownerSession)).statusCode, 404, "an unset switch is off");
      await h.switchOn(f.tripId, true);
      assert.equal((await list(f.app, f.tripId, f.ownerSession)).statusCode, 200);
    } finally { await f.app.close(); }
  });

  test("a deployment that never wired group sign-in has no such route behind the key: the same 404", async () => {
    const f = await fixture();
    const bare = h.newApp({ memberGroupSignIn: undefined } as never);
    try {
      const response = await list(bare, f.tripId, f.ownerSession);
      assert.equal(response.statusCode, 404);
      assert.equal(response.body, '{"error":"NOT_FOUND"}');
    } finally { await bare.close(); await f.app.close(); }
  });

  test("an organizer in the Mini App (a Telegram-minted session) may LIST a trip in its scope, but Release needs the dashboard: the portal's rule for removing a member", async () => {
    const f = await fixture();
    try {
      const scoped = await scopedOrganizerSession(f.owner, f.tripId, "owner-miniapp");
      const l = await list(f.app, f.tripId, scoped);
      assert.equal(l.statusCode, 200, l.body);
      assert.equal(l.json().claims.length, 1);
      const r = await release(f.app, f.tripId, scoped, f.claimId);
      assert.equal(r.statusCode, 403);
      assert.deepEqual(r.json(), { error: "ACCOUNT_SIGN_IN_REQUIRED", message: "Sign in with your password to do this." });
      assert.equal((await claimRow(f.claimId)).released_at, null, "nothing was released");
      // a scoped session whose link is for ANOTHER trip is out of scope: the trip does not exist for it
      const otherTrip = await h.mkTrip("Elsewhere");
      const elsewhere = await scopedOrganizerSession(f.owner, otherTrip, "owner-elsewhere");
      const out = await list(f.app, f.tripId, elsewhere);
      assert.equal(out.statusCode, 404);
      assert.equal(out.body, '{"error":"NOT_FOUND"}');
      // and a scope that cannot be read (a link id that is not a link) is the empty scope
      const bogus = await scopedOrganizerSession(f.owner, f.tripId, "owner-bogus");
      await h.pool.query("UPDATE control_plane.web_sessions SET telegram_link_id = 'bogus' WHERE id = $1", [bogus.sessionId]);
      assert.equal((await list(f.app, f.tripId, bogus)).statusCode, 404);
      // a revoked link is no scope at all
      const revoked = await scopedOrganizerSession(f.owner, f.tripId, "owner-revoked");
      await h.pool.query("UPDATE control_plane.telegram_organizer_trip_links SET revoked_at = now(), revoked_reason = 'owner_unlinked' WHERE id = (SELECT telegram_link_id FROM control_plane.web_sessions WHERE id = $1)", [revoked.sessionId]);
      assert.equal((await list(f.app, f.tripId, revoked)).statusCode, 404);
    } finally { await f.app.close(); }
  });

  test("nothing the routes log carries a claim id, a user id, a session id or a Telegram id", async () => {
    const f = await fixture();
    try {
      await list(f.app, f.tripId, f.ownerSession);
      await release(f.app, f.tripId, f.ownerSession, f.claimId);
      const text = h.logs.join("\n");
      for (const secret of [f.claimId, f.owner, f.ownerSession.sessionId, f.member.userId, String(f.person)]) assert.ok(!text.includes(secret), "a log line carries an identifier");
    } finally { await f.app.close(); }
  });
});
