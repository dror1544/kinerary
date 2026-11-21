/**
 * The runtime gateway's hop for an organizer's "Send a personal invite" (docs/specs/sprint-9/x-member-sign-in.md, AC-11):
 *
 *   POST /internal/member-invites/available  { tripId, userId, sessionId }                    -> 200 { available: true }
 *   POST /internal/member-invites/create     { tripId, userId, sessionId, runtimeUsername }   -> 201 { id, joinUrl, displayName, expiresAt }
 *
 * The gateway says who it heard from (a sealed trip-site session) and which traveller; this service decides everything again, from
 * the database: the key, a live session that is that user's, owner/organizer of THIS trip with dashboard access, and, for the
 * create, the session's scope by the portal route's own policy row. Everyone else gets one byte-identical 404.
 *
 * NOT gated by `member_group_sign_in`: a personal invite is a full way in for people who are not on Telegram (spec D1), so it works
 * with the switch off and with group sign-in not wired at all.
 */
import assert from "node:assert/strict";
import { after, before, describe, test } from "node:test";
import { scopedSessionDigest } from "../src/portal-scope.js";
import {
  asCookie, claim, cookieOf, digestTelegramId, id, initDataFor, launch, sha256, startHarness, tg, type Harness, type SitePerson,
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
  { username: "og01", displayName: "Olga Organizer", role: "organizer" },
];
type App = ReturnType<Harness["newApp"]>;
interface Who { userId: string; sessionId: string }

const sessionIdOf = async (raw: string) => (await h.pool.query("SELECT id FROM control_plane.web_sessions WHERE token_digest = $1", [sha256(raw)])).rows[0].id as string;
async function fullSession(userId: string, label: string): Promise<Who & { raw: string }> {
  const s = await h.webSession(userId, label);
  return { userId, sessionId: await sessionIdOf(s.raw), raw: s.raw };
}
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

async function fixture(options: { switchOn?: boolean } = {}) {
  const tripId = await h.mkTrip("Alsace in December");
  const owner = await h.mkUser("The Owner");
  await h.mkMember(tripId, owner, "owner");
  const groupChat = await h.bindGroup(tripId);
  await h.bindPrivate(tripId, tg());
  if (options.switchOn !== false) await h.switchOn(tripId);
  h.site.set(tripId, PEOPLE.map((p) => ({ ...p })));
  const ownerSession = await fullSession(owner, "owner");
  return { tripId, owner, ownerSession, app: h.newApp(), groupChat };
}
type Fixture = Awaited<ReturnType<typeof fixture>>;

const post = (app: App, path: string, body: unknown, headers: Record<string, string> = { "x-api-key": KEY }) =>
  app.inject({ method: "POST", url: path, headers: { "content-type": "application/json", ...headers }, payload: JSON.stringify(body) });
const create = (app: App, tripId: string, who: Who, runtimeUsername: string, headers?: Record<string, string>) => post(app, "/internal/member-invites/create", { tripId, ...who, runtimeUsername }, headers);
const available = (app: App, tripId: string, who: Who, headers?: Record<string, string>) => post(app, "/internal/member-invites/available", { tripId, ...who }, headers);
const invitesOf = async (tripId: string) => (await h.pool.query("SELECT id, runtime_username, state FROM control_plane.site_invites WHERE trip_id = $1 ORDER BY created_at", [tripId])).rows as { id: string; runtime_username: string; state: string }[];
const tokenOf = (joinUrl: string) => new URL(joinUrl).hash.slice("#token=".length);

/** Dana claims her own name from the group: she is now a claimed member (with a scoped session) and the traveller is held. */
async function claimDana(f: Fixture) {
  const person = tg();
  await h.telegram.member(f.groupChat, person, "member");
  const offer = (await launch(f.app, initDataFor(person, { tripId: f.tripId }))).json() as { travellers: { claimId: string; name: string }[] };
  const claimed = await claim(f.app, initDataFor(person, { tripId: f.tripId, firstName: "Maya" }), f.tripId, offer.travellers.find((t) => t.name === "Dana Levi")!.claimId);
  assert.equal(claimed.statusCode, 200, claimed.body);
  const sessionId = (await h.pool.query("SELECT id FROM control_plane.web_sessions WHERE token_digest = $1", [scopedSessionDigest(cookieOf(claimed, "kit_session")!)])).rows[0].id as string;
  const userId = (await h.pool.query("SELECT user_id FROM control_plane.web_sessions WHERE id = $1", [sessionId])).rows[0].user_id as string;
  void asCookie;
  return { member: { userId, sessionId } as Who, person };
}

describe("the gateway's personal-invite hop", { skip }, () => {
  test("an organizer's trip-site session creates one, and it is the SAME invite the portal route makes: redeemable, bound to the existing participant", async () => {
    const f = await fixture();
    try {
      const response = await create(f.app, f.tripId, f.ownerSession, "dl17");
      assert.equal(response.statusCode, 201, response.body);
      assert.equal(response.headers["cache-control"], "no-store");
      const body = response.json() as { id: string; joinUrl: string; displayName: string; expiresAt: string };
      assert.deepEqual(Object.keys(body).sort(), ["displayName", "expiresAt", "id", "joinUrl"]);
      assert.equal(body.displayName, "Dana Levi");
      assert.match(body.joinUrl, /\/join#token=/);
      assert.deepEqual((await invitesOf(f.tripId)).map((r) => [r.runtime_username, r.state]), [["dl17", "unused"]]);
      const redeemed = await f.app.inject({ method: "POST", url: "/v1/site-invites/redeem", payload: { token: tokenOf(body.joinUrl), method: "password", password: "a-long-enough-secret" } });
      assert.equal(redeemed.statusCode, 200, redeemed.body);
      assert.equal(h.siteBindings.get(`${f.tripId}:dl17`) !== undefined, true);
    } finally { await f.app.close(); }
  });

  test("it is NOT gated by member_group_sign_in: switch off, switch never set, and group sign-in not wired at all all work", async () => {
    const off = await fixture({ switchOn: false });
    const bare = h.newApp({ memberGroupSignIn: undefined } as never);
    try {
      assert.equal((await create(off.app, off.tripId, off.ownerSession, "dl17")).statusCode, 201);
      assert.equal((await available(off.app, off.tripId, off.ownerSession)).statusCode, 200);
      const f = await fixture();
      assert.equal((await create(bare, f.tripId, f.ownerSession, "nl23")).statusCode, 201, "no group sign-in wired");
      assert.equal((await available(bare, f.tripId, f.ownerSession)).statusCode, 200);
      await f.app.close();
    } finally { await bare.close(); await off.app.close(); }
  });

  test("\"send it again\": a second create revokes the pending invite and issues a fresh one", async () => {
    const f = await fixture();
    try {
      const first = (await create(f.app, f.tripId, f.ownerSession, "dl17")).json() as { joinUrl: string };
      const second = await create(f.app, f.tripId, f.ownerSession, "dl17");
      assert.equal(second.statusCode, 201, second.body);
      assert.deepEqual((await invitesOf(f.tripId)).map((r) => r.state).sort(), ["revoked", "unused"]);
      assert.equal((await f.app.inject({ method: "POST", url: "/v1/site-invites/redeem", payload: { token: tokenOf(first.joinUrl), method: "password", password: "a-long-enough-secret" } })).statusCode, 404);
    } finally { await f.app.close(); }
  });

  test("a member, a claimed member, a stranger, another trip's owner, an organizer without the dashboard, a dead, expired or foreign session and a disabled organizer are one byte-identical 404, and nothing is written", async () => {
    const f = await fixture();
    try {
      const { member: claimed } = await claimDana(f);
      const stranger = await fullSession(await h.mkUser("Stranger"), "stranger");
      const otherTrip = await h.mkTrip("Other trip");
      const otherOwnerUser = await h.mkUser("Other owner"); await h.mkMember(otherTrip, otherOwnerUser, "owner");
      const otherOwner = await fullSession(otherOwnerUser, "other-owner");
      const plainUser = await h.mkUser("Plain member"); await h.mkMember(f.tripId, plainUser, "member");
      const plain = await fullSession(plainUser, "plain-member");
      const secondaryUser = await h.mkUser("Secondary"); await h.mkMember(f.tripId, secondaryUser, "organizer", { dashboard: false });
      const secondary = await fullSession(secondaryUser, "secondary");
      const deadOwner = await fullSession(f.owner, "dead-owner");
      await h.pool.query("UPDATE control_plane.web_sessions SET revoked_at = now() WHERE id = $1", [deadOwner.sessionId]);
      const expiredOwner = await fullSession(f.owner, "expired-owner");
      await h.pool.query("UPDATE control_plane.web_sessions SET expires_at = now() - interval '1 minute' WHERE id = $1", [expiredOwner.sessionId]);
      const disabledUser = await h.mkUser("Disabled"); await h.mkMember(f.tripId, disabledUser, "organizer");
      const disabled = await fullSession(disabledUser, "disabled");
      await h.pool.query("UPDATE control_plane.users SET status = 'suspended' WHERE id = $1", [disabledUser]);
      const callers: Array<[string, Who]> = [
        ["the claimed member (the session the claim minted)", claimed], ["a plain member", plain], ["a stranger", stranger], ["another trip's owner", otherOwner],
        ["an organizer without the dashboard", secondary], ["the owner's revoked session", deadOwner], ["the owner's expired session", expiredOwner],
        ["the owner's user id with a stranger's session", { userId: f.owner, sessionId: stranger.sessionId }],
        ["a stranger's user id with the owner's session", { userId: stranger.userId, sessionId: f.ownerSession.sessionId }],
        ["a disabled organizer", disabled], ["a session id that does not exist", { userId: f.owner, sessionId: "wsess_doesnotexist" }],
      ];
      const ghost = await create(f.app, "trip_doesnotexist0000", f.ownerSession, "nl23");
      assert.equal(ghost.statusCode, 404);
      assert.equal(ghost.body, '{"error":"NOT_FOUND"}');
      const before = await h.snapshot();
      const invites = (await invitesOf(f.tripId)).length;
      for (const [name, who] of callers) {
        for (const username of ["nl23", "og01", "nobody1"]) {
          const r = await create(f.app, f.tripId, who, username);
          assert.equal(r.statusCode, 404, `${name} / ${username}`);
          assert.equal(r.body, ghost.body, `${name} / ${username}`);
        }
        const a = await available(f.app, f.tripId, who);
        assert.equal(a.statusCode, 404, `available: ${name}`);
        assert.equal(a.body, ghost.body, `available: ${name}`);
        // naming ANOTHER trip: never allowed (the other trip's own owner naming their own trip is simply their trip)
        if (who !== otherOwner) assert.equal((await create(f.app, otherTrip, who, "nl23")).statusCode, 404, `on another trip: ${name}`);
      }
      assert.deepEqual(await h.snapshot(), before);
      assert.equal((await invitesOf(f.tripId)).length, invites, "no invite was written for any of them");
    } finally { await f.app.close(); }
  });

  test("the key: none, a wrong one and the portal's own cookie are 401 and write nothing", async () => {
    const f = await fixture();
    try {
      for (const headers of [{}, { "x-api-key": "wrong" }, { "x-api-key": "" }, { cookie: `kit_session=${f.ownerSession.raw}` }]) {
        const r = await create(f.app, f.tripId, f.ownerSession, "dl17", headers);
        assert.equal(r.statusCode, 401, JSON.stringify(headers));
        assert.deepEqual(r.json(), { error: "AUTHENTICATION_REQUIRED" });
        assert.equal((await available(f.app, f.tripId, f.ownerSession, headers)).statusCode, 401);
      }
      assert.deepEqual(await invitesOf(f.tripId), []);
    } finally { await f.app.close(); }
  });

  test("a body that says it is an owner changes nothing, and a body that is not shaped like the gateway's is a 400 that names nothing", async () => {
    const f = await fixture();
    try {
      const plainUser = await h.mkUser("Plain member"); await h.mkMember(f.tripId, plainUser, "member");
      const plain = await fullSession(plainUser, "plain-member");
      assert.equal((await post(f.app, "/internal/member-invites/create", { tripId: f.tripId, ...plain, runtimeUsername: "dl17", role: "owner", dashboard_access: true, displayName: "Forged" })).statusCode, 404);
      for (const body of [{}, { tripId: f.tripId }, { tripId: f.tripId, userId: f.owner }, { tripId: "not-a-trip", ...f.ownerSession, runtimeUsername: "dl17" },
        { tripId: f.tripId, ...f.ownerSession }, { tripId: f.tripId, ...f.ownerSession, runtimeUsername: 7 }, { tripId: f.tripId, ...f.ownerSession, runtimeUsername: "Not A Name" }]) {
        const r = await post(f.app, "/internal/member-invites/create", body);
        assert.equal(r.statusCode, 400, JSON.stringify(body));
        assert.deepEqual(r.json(), { error: "INVALID_REQUEST" });
      }
      assert.deepEqual(await invitesOf(f.tripId), []);
    } finally { await f.app.close(); }
  });

  test("the organizer sees the named answers: an organizer's name, a name that is not a participant, a traveller CLAIMED from the group, a site that cannot be asked", async () => {
    const f = await fixture();
    try {
      const expected: Array<[string, number, string]> = [["og01", 409, "RUNTIME_PARTICIPANT_NOT_ELIGIBLE"], ["nobody1", 409, "RUNTIME_PARTICIPANT_NOT_FOUND"]];
      for (const [name, status, error] of expected) {
        const r = await create(f.app, f.tripId, f.ownerSession, name);
        assert.equal(r.statusCode, status, name);
        assert.deepEqual(r.json(), { error });
      }
      await claimDana(f);
      const conflict = await create(f.app, f.tripId, f.ownerSession, "dl17");
      assert.equal(conflict.statusCode, 409, conflict.body);
      assert.deepEqual(conflict.json(), { error: "TRAVELLER_CLAIMED_FROM_GROUP" });
      h.site.set(f.tripId, "unreachable");
      const down = await create(f.app, f.tripId, f.ownerSession, "nl23");
      assert.equal(down.statusCode, 409);
      assert.deepEqual(down.json(), { error: "RUNTIME_NOT_READY" });
      assert.deepEqual(await invitesOf(f.tripId), []);
    } finally { await f.app.close(); }
  });

  test("an organizer in the Mini App (a Telegram-minted session) is told to use the dashboard, by the portal route's own scope row; the probe still answers, and nothing is written", async () => {
    const f = await fixture();
    try {
      const scoped = await scopedOrganizerSession(f.owner, f.tripId, "owner-miniapp");
      const r = await create(f.app, f.tripId, scoped, "dl17");
      assert.equal(r.statusCode, 403);
      assert.deepEqual(r.json(), { error: "ACCOUNT_SIGN_IN_REQUIRED", message: "Sign in with your password to do this." });
      assert.deepEqual(await invitesOf(f.tripId), []);
      assert.equal((await available(f.app, f.tripId, scoped)).statusCode, 200, "the button is shown; the click says why it cannot be used");
      // a scoped session whose link is for ANOTHER trip is out of scope: the trip does not exist for it
      const elsewhere = await scopedOrganizerSession(f.owner, await h.mkTrip("Elsewhere"), "owner-elsewhere");
      const out = await create(f.app, f.tripId, elsewhere, "dl17");
      assert.ok([403, 404].includes(out.statusCode));
      assert.deepEqual(await invitesOf(f.tripId), []);
    } finally { await f.app.close(); }
  });

  test("nothing the routes log carries an invite id, a token, a link, a user id, a session id or a Telegram id", async () => {
    const f = await fixture();
    try {
      const made = (await create(f.app, f.tripId, f.ownerSession, "dl17")).json() as { id: string; joinUrl: string };
      await available(f.app, f.tripId, f.ownerSession);
      const text = h.logs.join("\n");
      for (const secret of [made.id, tokenOf(made.joinUrl), made.joinUrl, f.owner, f.ownerSession.sessionId]) assert.ok(!text.includes(secret), "a log line carries an identifier");
    } finally { await f.app.close(); }
  });
});
