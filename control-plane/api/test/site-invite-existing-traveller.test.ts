/**
 * A PERSONAL INVITE FOR AN EXISTING TRAVELLER (docs/specs/sprint-9/x-member-sign-in.md, slice S2: AC-10 and AC-13, plus the
 * invite-versus-claim rules the owner's standing "agree to recommendations" settled). Postgres, the migrations, the Fastify app and
 * every route are real; the trip site is the harness's fake, held to the same case table as the real site
 * (site-binding-cases.test.ts, tests/control-plane-provision-cases.test.js). What the REAL site does with the redeemed binding
 * (an exchange that yields a member token for that existing participant) is tests/control-plane-provision-cases.test.js.
 *
 *   a. a PENDING personal invite reserves its traveller: not offered to the group, not claimable by a hand-built id; revoking or
 *      letting it expire frees the name;
 *   b. creating one for a traveller who is CLAIMED from the group is refused with a named conflict (only an organizer can ever ask);
 *   c. redeeming never answers a raw 500: any site conflict is a clean, non-revealing refusal with nothing half-written, and a
 *      LEFTOVER claim binding (a claim whose site release was lost) does not block the real traveller, while a LIVE claim does.
 */
import assert from "node:assert/strict";
import { after, before, describe, test } from "node:test";
import { createSiteInvite } from "../src/portal.js";
import {
  ORIGIN, claim, id, initDataFor, launch, sha256, startHarness, tg, type Harness, type SitePerson,
} from "./support/group-sign-in-harness.js";
import { testDatabaseUrl } from "./support/test-database.js";

const skip = !testDatabaseUrl();
let h: Harness;
before(async () => { if (!skip) h = await startHarness(); });
after(async () => { if (!skip) await h.stop(); });

const PEOPLE: SitePerson[] = [
  { username: "dl17", displayName: "Dana Levi", role: "member" },
  { username: "nl23", displayName: "Noam Levi", role: "member" },
  { username: "og01", displayName: "Olga Organizer", role: "organizer" },
];
type App = ReturnType<Harness["newApp"]>;

async function fixture() {
  const tripId = await h.mkTrip("Alsace in December");
  const owner = await h.mkUser("The Owner");
  await h.mkMember(tripId, owner, "owner");
  const groupChat = await h.bindGroup(tripId);
  await h.bindPrivate(tripId, tg());
  await h.switchOn(tripId);
  h.site.set(tripId, PEOPLE.map((p) => ({ ...p })));
  const ownerSession = await h.webSession(owner, "owner");
  const app = h.newApp();
  return { tripId, owner, ownerSession, app, groupChat };
}
type Fixture = Awaited<ReturnType<typeof fixture>>;

const createInvite = (f: Fixture, body: Record<string, unknown>, who: { cookie: string; csrf: string } = f.ownerSession, app: App = f.app) =>
  app.inject({ method: "POST", url: `/v1/trips/${f.tripId}/site-invites`, headers: { cookie: who.cookie, "x-csrf-token": who.csrf }, payload: body });
const tokenOf = (joinUrl: string) => new URL(joinUrl).hash.slice("#token=".length);
const redeemPassword = (app: App, token: string) =>
  app.inject({ method: "POST", url: "/v1/site-invites/redeem", payload: { token, method: "password", password: "a-long-enough-secret" } });
const inviteRow = async (inviteId: string) => (await h.pool.query("SELECT state, redeemed_by FROM control_plane.site_invites WHERE id = $1", [inviteId])).rows[0] as { state: string; redeemed_by: string | null };
const siteKey = (tripId: string, username: string) => `${tripId}:${username}`;
const invitesOf = async (tripId: string, username: string) =>
  (await h.pool.query("SELECT id, state FROM control_plane.site_invites WHERE trip_id = $1 AND runtime_username = $2 ORDER BY created_at", [tripId, username])).rows as { id: string; state: string }[];

/** A person in the trip's Telegram group; what the Mini App offers them. */
async function offeredTo(f: Fixture, person: number): Promise<{ kind: string; travellers?: { claimId: string; name: string }[] }> {
  await h.telegram.member(f.groupChat, person, "member");
  return (await launch(f.app, initDataFor(person, { tripId: f.tripId }))).json();
}

describe("a personal invite for an existing traveller (AC-10)", { skip }, () => {
  test("an organizer creates one through the portal route: it names the existing participant, and the name on it is the site's own", async () => {
    const f = await fixture();
    try {
      const response = await createInvite(f, { displayName: "Dana", runtimeUsername: "dl17" });
      assert.equal(response.statusCode, 201, response.body);
      const body = response.json() as { id: string; status: string; joinUrl: string };
      assert.equal(body.status, "unused");
      assert.match(body.joinUrl, new RegExp(`^${ORIGIN}/join#token=`));
      assert.deepEqual((await invitesOf(f.tripId, "dl17")).map((r) => r.state), ["unused"]);
    } finally { await f.app.close(); }
  });

  test("the exported createSiteInvite (what the companion's tool will call) takes only the trip, the actor and the username, and re-decides everything", async () => {
    const f = await fixture();
    try {
      const deps = h.deps();
      const made = await createSiteInvite(deps, { tripId: f.tripId, actorUserId: f.owner, runtimeUsername: "dl17" });
      assert.equal(made.ok, true);
      if (!made.ok) return;
      assert.equal(made.displayName, "Dana Levi", "the name comes from the trip site, not from the caller");
      assert.match(made.joinUrl, new RegExp(`^${ORIGIN}/join#token=`));
      assert.ok(Number.isFinite(Date.parse(made.expiresAt)));
      // a member of the trip, a stranger and an organizer without the dashboard are the same answer: not found
      const plain = await h.mkUser("Plain"); await h.mkMember(f.tripId, plain, "member");
      const stranger = await h.mkUser("Stranger");
      const secondary = await h.mkUser("Secondary"); await h.mkMember(f.tripId, secondary, "organizer", { dashboard: false });
      for (const actorUserId of [plain, stranger, secondary]) {
        const refused = await createSiteInvite(deps, { tripId: f.tripId, actorUserId, runtimeUsername: "nl23" });
        assert.deepEqual(refused, { ok: false, status: 404, error: "NOT_FOUND" });
      }
      assert.deepEqual((await invitesOf(f.tripId, "nl23")), [], "nothing was written for any of them");
      // a username that is not shaped like one never reaches the site
      assert.deepEqual(await createSiteInvite(deps, { tripId: f.tripId, actorUserId: f.owner, runtimeUsername: "Not A Name" }), { ok: false, status: 400, error: "INVALID_REQUEST" });
    } finally { await f.app.close(); }
  });

  test("redeeming adopts that participant: an invite-bound binding on the site (so NOT a claimed session), a plain member account, and nothing else is made", async () => {
    const f = await fixture();
    try {
      const created = (await createInvite(f, { displayName: "Dana", runtimeUsername: "dl17" })).json() as { id: string; joinUrl: string };
      const before = await h.snapshot();
      const response = await redeemPassword(f.app, tokenOf(created.joinUrl));
      assert.equal(response.statusCode, 200, response.body);
      const row = await inviteRow(created.id);
      assert.equal(row.state, "redeemed");
      const userId = row.redeemed_by!;
      // the trip site was asked to bind THIS account to THAT participant, with the invite's id
      assert.deepEqual(h.siteCalls.provision.filter((c) => c.tripId === f.tripId), [{ tripId: f.tripId, userId, runtimeUsername: "dl17", inviteId: created.id }]);
      assert.equal(h.siteBindings.get(siteKey(f.tripId, "dl17")), userId);
      assert.ok(h.siteHeld.has(siteKey(f.tripId, "dl17")), "invite-bound: it can set a password, link Google and so on as invite-bound members can today");
      // one new account, one membership: a member that opens the trip and has no dashboard
      const after = await h.snapshot();
      assert.equal(after.users, before.users! + 1);
      assert.equal(after.trip_memberships, before.trip_memberships! + 1);
      assert.equal(after.trip_participant_claims, before.trip_participant_claims, "an invite is not a claim");
      const member = (await h.pool.query("SELECT role, dashboard_access, runtime_access FROM control_plane.trip_memberships WHERE trip_id = $1 AND user_id = $2", [f.tripId, userId])).rows[0];
      assert.deepEqual(member, { role: "member", dashboard_access: false, runtime_access: true });
      // and the launch exchange names the participant the invite named
      const set = await redeemedSession(response);
      const launched = await f.app.inject({ method: "POST", url: `/v1/trips/${f.tripId}/launch`, headers: { cookie: set.cookie, "x-csrf-token": set.csrf } });
      assert.equal(launched.statusCode, 200, launched.body);
      const consumed = await f.app.inject({ method: "POST", url: "/internal/runtime-launch/consume", headers: { "x-api-key": "exchange-key" }, payload: { token: launched.json().launchToken } });
      assert.equal(consumed.statusCode, 200, consumed.body);
      assert.equal(consumed.json().runtimeUsername, "dl17");
      assert.equal(consumed.json().role, "member");
      assert.equal(consumed.json().dashboardUrl, null);
    } finally { await f.app.close(); }
  });

  test("a redeemed invite makes the traveller a mapped account: the group is never offered the name (AC-4)", async () => {
    const f = await fixture();
    try {
      const created = (await createInvite(f, { displayName: "Dana", runtimeUsername: "dl17" })).json() as { joinUrl: string };
      assert.equal((await redeemPassword(f.app, tokenOf(created.joinUrl))).statusCode, 200);
      const offer = await offeredTo(f, tg());
      assert.equal(offer.kind, "claim");
      assert.deepEqual(offer.travellers!.map((t) => t.name), ["Noam Levi"]);
    } finally { await f.app.close(); }
  });

  test("an invite is never created for an organizer, a name that is not a participant, or a name an organizer's account holds; a site that cannot be asked says so; nothing is written", async () => {
    const f = await fixture();
    try {
      const held = await h.mkUser("Held by an organizer account");
      await h.mkMember(f.tripId, held, "organizer", { dashboard: false });
      await h.pool.query("INSERT INTO control_plane.web_password_credentials(user_id, trip_id, runtime_username, password_hash) VALUES ($1, $2, 'nl23', $3)", [held, f.tripId, "x".repeat(40)]);
      const before = await h.snapshot();
      const cases: Array<[string, string, number, string]> = [
        ["an organizer's name", "og01", 409, "RUNTIME_PARTICIPANT_NOT_ELIGIBLE"],
        ["a name that is not a participant", "nobody1", 409, "RUNTIME_PARTICIPANT_NOT_FOUND"],
        ["a name an organizer's account holds", "nl23", 409, "RUNTIME_PARTICIPANT_NOT_ELIGIBLE"],
      ];
      for (const [label, name, status, error] of cases) {
        const r = await createInvite(f, { displayName: "X", runtimeUsername: name });
        assert.equal(r.statusCode, status, label);
        assert.deepEqual(r.json(), { error }, label);
        assert.deepEqual(await invitesOf(f.tripId, name), [], `${label}: nothing written`);
      }
      h.site.set(f.tripId, "unreachable");
      const down = await createInvite(f, { displayName: "X", runtimeUsername: "dl17" });
      assert.equal(down.statusCode, 409);
      assert.deepEqual(down.json(), { error: "RUNTIME_NOT_READY" });
      assert.deepEqual(await h.snapshot(), before);
    } finally { await f.app.close(); }
  });

  test("an unused invite that has expired by the clock no longer blocks a fresh one; a live one still answers INVITE_ALREADY_EXISTS", async () => {
    const f = await fixture();
    try {
      const first = (await createInvite(f, { displayName: "Dana", runtimeUsername: "dl17" })).json() as { id: string };
      const again = await createInvite(f, { displayName: "Dana", runtimeUsername: "dl17" });
      assert.equal(again.statusCode, 409);
      assert.deepEqual(again.json(), { error: "INVITE_ALREADY_EXISTS" });
      await h.pool.query("UPDATE control_plane.site_invites SET expires_at = now() - interval '1 minute' WHERE id = $1", [first.id]);
      const fresh = await createInvite(f, { displayName: "Dana", runtimeUsername: "dl17" });
      assert.equal(fresh.statusCode, 201, fresh.body);
      assert.deepEqual((await invitesOf(f.tripId, "dl17")).map((r) => r.state).sort(), ["expired", "unused"]);
    } finally { await f.app.close(); }
  });

  test("replacePending (the organizer's \"send it again\") revokes the old pending invite and issues a new one in one step; the old link then opens nothing", async () => {
    const f = await fixture();
    try {
      const deps = h.deps();
      const first = await createSiteInvite(deps, { tripId: f.tripId, actorUserId: f.owner, runtimeUsername: "dl17" });
      assert.ok(first.ok);
      const refused = await createSiteInvite(deps, { tripId: f.tripId, actorUserId: f.owner, runtimeUsername: "dl17" });
      assert.deepEqual(refused, { ok: false, status: 409, error: "INVITE_ALREADY_EXISTS" });
      const second = await createSiteInvite(deps, { tripId: f.tripId, actorUserId: f.owner, runtimeUsername: "dl17", replacePending: true });
      assert.ok(second.ok);
      if (!first.ok || !second.ok) return;
      assert.deepEqual((await invitesOf(f.tripId, "dl17")).map((r) => r.state).sort(), ["revoked", "unused"]);
      assert.equal((await redeemPassword(f.app, tokenOf(first.joinUrl))).statusCode, 404, "the old link is dead");
      assert.equal((await redeemPassword(f.app, tokenOf(second.joinUrl))).statusCode, 200);
      // a REDEEMED invite is never replaced: the traveller already has a way in of their own
      const third = await createSiteInvite(deps, { tripId: f.tripId, actorUserId: f.owner, runtimeUsername: "dl17", replacePending: true });
      assert.deepEqual(third, { ok: false, status: 409, error: "INVITE_ALREADY_EXISTS" });
    } finally { await f.app.close(); }
  });
});

describe("invite versus claim (the settled forks)", { skip }, () => {
  test("a PENDING invite reserves its traveller: not in the Mini App offer, and a hand-built claim id for it claims nothing", async () => {
    const f = await fixture();
    try {
      const someone = tg();
      const before = await offeredTo(f, someone);
      assert.deepEqual(before.travellers!.map((t) => t.name), ["Dana Levi", "Noam Levi"]);
      const danaId = before.travellers!.find((t) => t.name === "Dana Levi")!.claimId;
      assert.equal((await createInvite(f, { displayName: "Dana", runtimeUsername: "dl17" })).statusCode, 201);
      const offer = await offeredTo(f, someone);
      assert.deepEqual(offer.travellers!.map((t) => t.name), ["Noam Levi"], "Dana is spoken for");
      const snapshot = await h.snapshot();
      const handBuilt = await claim(f.app, initDataFor(someone, { tripId: f.tripId }), f.tripId, danaId);
      assert.equal(handBuilt.statusCode, 409, handBuilt.body);
      assert.deepEqual(handBuilt.json(), { error: "ALREADY_CLAIMED" });
      assert.deepEqual(await h.snapshot(), snapshot, "nothing was written");
    } finally { await f.app.close(); }
  });

  test("revoking the pending invite, or letting it expire, frees the name again", async () => {
    const f = await fixture();
    try {
      const someone = tg();
      const created = (await createInvite(f, { displayName: "Dana", runtimeUsername: "dl17" })).json() as { id: string };
      assert.deepEqual((await offeredTo(f, someone)).travellers!.map((t) => t.name), ["Noam Levi"]);
      const revoked = await f.app.inject({ method: "DELETE", url: `/v1/trips/${f.tripId}/site-invites/${created.id}`, headers: { cookie: f.ownerSession.cookie, "x-csrf-token": f.ownerSession.csrf } });
      assert.equal(revoked.statusCode, 200);
      assert.deepEqual((await offeredTo(f, someone)).travellers!.map((t) => t.name), ["Dana Levi", "Noam Levi"]);
      const again = (await createInvite(f, { displayName: "Dana", runtimeUsername: "dl17" })).json() as { id: string };
      assert.deepEqual((await offeredTo(f, someone)).travellers!.map((t) => t.name), ["Noam Levi"]);
      // expired by the clock, state still 'unused': the offer reads the clock too
      await h.pool.query("UPDATE control_plane.site_invites SET expires_at = now() - interval '1 minute' WHERE id = $1", [again.id]);
      assert.deepEqual((await offeredTo(f, someone)).travellers!.map((t) => t.name), ["Dana Levi", "Noam Levi"]);
    } finally { await f.app.close(); }
  });

  test("an organizer cannot invite a traveller who is CLAIMED from the group: a named conflict, only to the organizer, and nothing is written; releasing the claim lifts it", async () => {
    const f = await fixture();
    try {
      const person = tg();
      const offer = await offeredTo(f, person);
      const danaId = offer.travellers!.find((t) => t.name === "Dana Levi")!.claimId;
      const claimed = await claim(f.app, initDataFor(person, { tripId: f.tripId, firstName: "Maya" }), f.tripId, danaId);
      assert.equal(claimed.statusCode, 200, claimed.body);
      const before = await h.snapshot();
      const r = await createInvite(f, { displayName: "Dana", runtimeUsername: "dl17" });
      assert.equal(r.statusCode, 409, r.body);
      assert.deepEqual(r.json(), { error: "TRAVELLER_CLAIMED_FROM_GROUP" });
      assert.deepEqual(await invitesOf(f.tripId, "dl17"), []);
      assert.deepEqual(await h.snapshot(), before);
      // the answer is for an organizer only: a plain member, a stranger and a claimed member get the one 404 every refusal gets
      const plain = await h.mkUser("Plain"); await h.mkMember(f.tripId, plain, "member");
      const stranger = await h.mkUser("Stranger");
      for (const who of [await h.webSession(plain, "plain"), await h.webSession(stranger, "stranger")]) {
        const refused = await createInvite(f, { displayName: "Dana", runtimeUsername: "dl17" }, who);
        assert.equal(refused.statusCode, 404);
        assert.deepEqual(refused.json(), { error: "NOT_FOUND" });
      }
      // release the claim; now the invite can be made
      const claimRow = (await h.pool.query("SELECT id FROM control_plane.trip_participant_claims WHERE trip_id = $1 AND released_at IS NULL", [f.tripId])).rows[0] as { id: string };
      const released = await f.app.inject({ method: "DELETE", url: `/v1/trips/${f.tripId}/member-claims/${claimRow.id}`, headers: { cookie: f.ownerSession.cookie, "x-csrf-token": f.ownerSession.csrf } });
      assert.equal(released.statusCode, 200, released.body);
      assert.equal((await createInvite(f, { displayName: "Dana", runtimeUsername: "dl17" })).statusCode, 201);
    } finally { await f.app.close(); }
  });

  test("a LIVE claim on the name at redeem time (an invite made before the claim existed) is a clean refusal, never a 500: the invite stays unused and nothing is written", async () => {
    const f = await fixture();
    try {
      const person = tg();
      const offer = await offeredTo(f, person);
      const danaId = offer.travellers!.find((t) => t.name === "Dana Levi")!.claimId;
      assert.equal((await claim(f.app, initDataFor(person, { tripId: f.tripId }), f.tripId, danaId)).statusCode, 200);
      // an invite that predates the claim (the portal now refuses to make one; a row from before this release, or a race, still can exist)
      const token = `legacy-${id("tok")}`, inviteId = id("invite");
      await h.pool.query(
        `INSERT INTO control_plane.site_invites(id, trip_id, created_by, intended_display_name, runtime_username, token_digest, state, expires_at)
         VALUES ($1, $2, $3, 'Dana', 'dl17', $4, 'unused', now() + interval '7 days')`, [inviteId, f.tripId, f.owner, sha256(token)]);
      const before = await h.snapshot();
      const provisioned = h.siteCalls.provision.length;
      const response = await redeemPassword(f.app, token);
      assert.equal(response.statusCode, 409, response.body);
      assert.deepEqual(response.json(), { error: "INVITE_UNAVAILABLE" }, "says nothing about who holds the name");
      assert.equal((await inviteRow(inviteId)).state, "unused");
      assert.deepEqual(await h.snapshot(), before, "no account, no membership, no session");
      assert.equal(h.siteCalls.provision.length, provisioned, "the site was not asked to bind anything");
      assert.ok(!h.logs.join("\n").includes(inviteId) && !h.logs.join("\n").includes(token));
    } finally { await f.app.close(); }
  });

  test("a LEFTOVER claim binding on the site (the claim ended, its release was lost) does not block the real traveller: the invite displaces it", async () => {
    const f = await fixture();
    try {
      const person = tg();
      const offer = await offeredTo(f, person);
      const danaId = offer.travellers!.find((t) => t.name === "Dana Levi")!.claimId;
      assert.equal((await claim(f.app, initDataFor(person, { tripId: f.tripId }), f.tripId, danaId)).statusCode, 200);
      const claimRow = (await h.pool.query("SELECT id, user_id FROM control_plane.trip_participant_claims WHERE trip_id = $1 AND released_at IS NULL", [f.tripId])).rows[0] as { id: string; user_id: string };
      assert.equal(h.siteBindings.get(siteKey(f.tripId, "dl17")), claimRow.user_id);
      h.siteFail.release = "unavailable"; // the site never hears that the claim ended
      const released = await f.app.inject({ method: "DELETE", url: `/v1/trips/${f.tripId}/member-claims/${claimRow.id}`, headers: { cookie: f.ownerSession.cookie, "x-csrf-token": f.ownerSession.csrf } });
      assert.equal(released.statusCode, 200);
      assert.equal(h.siteBindings.get(siteKey(f.tripId, "dl17")), claimRow.user_id, "the leftover is still on the site");
      const created = (await createInvite(f, { displayName: "Dana", runtimeUsername: "dl17" })).json() as { id: string; joinUrl: string };
      const response = await redeemPassword(f.app, tokenOf(created.joinUrl));
      assert.equal(response.statusCode, 200, response.body);
      const userId = (await inviteRow(created.id)).redeemed_by!;
      assert.equal(h.siteBindings.get(siteKey(f.tripId, "dl17")), userId, "the real traveller holds the name now");
      assert.ok(h.siteHeld.has(siteKey(f.tripId, "dl17")));
    } finally { await f.app.close(); }
  });

  test("any other site refusal at redeem is the same clean refusal; a site that cannot be asked is a retryable 503; neither leaves anything behind, and the retry works", async () => {
    const f = await fixture();
    try {
      const created = (await createInvite(f, { displayName: "Dana", runtimeUsername: "dl17" })).json() as { id: string; joinUrl: string };
      const token = tokenOf(created.joinUrl);
      const before = await h.snapshot();
      // the site now says this person is an organizer: it refuses to bind them
      h.site.set(f.tripId, PEOPLE.map((p) => (p.username === "dl17" ? { ...p, role: "organizer" } : { ...p })));
      const refused = await redeemPassword(f.app, token);
      assert.equal(refused.statusCode, 409, refused.body);
      assert.deepEqual(refused.json(), { error: "INVITE_UNAVAILABLE" });
      assert.deepEqual(await h.snapshot(), before);
      assert.equal((await inviteRow(created.id)).state, "unused");
      // the site is down
      h.site.set(f.tripId, PEOPLE.map((p) => ({ ...p })));
      h.siteFail.provision = "unavailable";
      const down = await redeemPassword(f.app, token);
      assert.equal(down.statusCode, 503, down.body);
      assert.deepEqual(down.json(), { error: "RUNTIME_NOT_READY", retryable: true });
      assert.deepEqual(await h.snapshot(), before);
      assert.equal((await inviteRow(created.id)).state, "unused");
      // and the same link works once the site answers
      assert.equal((await redeemPassword(f.app, token)).statusCode, 200);
    } finally { await f.app.close(); }
  });
});

describe("redeeming with Google goes through the dashboard origin's own client (AC-13)", { skip }, () => {
  test("a Google session of the dashboard origin redeems an existing-traveller invite; no per-trip Google configuration is read, and no ID token is verified here", async () => {
    const f = await fixture();
    let verified = 0;
    const app = h.newApp({ google: { clientId: "dashboard-client.apps.googleusercontent.com", verify: async () => { verified++; return { subject: "unused", displayName: "Unused", emailVerified: false }; } } } as never);
    try {
      const created = (await createInvite(f, { displayName: "Dana", runtimeUsername: "dl17" }, f.ownerSession, app)).json() as { id: string; joinUrl: string };
      const guest = await h.mkUser("Dana's own Google account");
      await h.pool.query(
        "INSERT INTO control_plane.user_identities(id,user_id,provider,provider_subject_digest,verified_at) VALUES ($1,$2,'google',$3,now())",
        [id("idnt"), guest, sha256(`google:${guest}`)]);
      const session = await h.webSession(guest, "google-guest");
      // without a Google session: the page is told to sign in with Google first (the dashboard's button), nothing is consumed
      const anonymous = await app.inject({ method: "POST", url: "/v1/site-invites/redeem", payload: { token: tokenOf(created.joinUrl), method: "google" } });
      assert.ok([401, 403].includes(anonymous.statusCode), anonymous.body);
      assert.equal((await inviteRow(created.id)).state, "unused");
      const response = await app.inject({
        method: "POST", url: "/v1/site-invites/redeem", headers: { cookie: session.cookie, "x-csrf-token": session.csrf, origin: ORIGIN },
        payload: { token: tokenOf(created.joinUrl), method: "google" },
      });
      assert.equal(response.statusCode, 200, response.body);
      assert.equal((await inviteRow(created.id)).redeemed_by, guest, "the Google account is the traveller's account: no second user was made");
      assert.equal(h.siteBindings.get(siteKey(f.tripId, "dl17")), guest);
      assert.equal(verified, 0, "redeeming reads the session the dashboard's Google client already made; it verifies no token itself");
      const capabilities = (await app.inject({ method: "GET", url: "/v1/auth/capabilities" })).json() as { google?: boolean; googleClientId?: string };
      assert.equal(capabilities.googleClientId, "dashboard-client.apps.googleusercontent.com", "the one client id is the dashboard origin's, whatever the trip");
    } finally { await app.close(); await f.app.close(); }
  });
});

/** The cookie pair a password redemption set, for a call that rides the new session. */
async function redeemedSession(response: { headers: Record<string, unknown> }): Promise<{ cookie: string; csrf: string }> {
  const raw = response.headers["set-cookie"];
  const lines = (Array.isArray(raw) ? raw : [String(raw)]).map((line) => line.split(";", 1)[0]!);
  const value = (name: string) => decodeURIComponent(lines.find((l) => l.startsWith(`${name}=`))!.slice(name.length + 1));
  return { cookie: `kit_session=${value("kit_session")}; kit_csrf=${value("kit_csrf")}`, csrf: value("kit_csrf") };
}
