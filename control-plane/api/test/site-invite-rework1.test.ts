/**
 * S2a rework round 1 (boundary review of the personal invite for an existing traveller), against Postgres with the harness's fake site
 * (held to tests/fixtures/site-binding-cases.json, which the REAL site also runs).
 *
 *   A. An owner or organizer of the trip cannot redeem a MEMBER invite with their own account: it would have bound the organizer's
 *      user to a traveller on the site (their own trip launch then failed, and the traveller became un-invitable and unclaimable).
 *      The answer is the same clean INVITE_UNAVAILABLE as any other refusal, and nothing is written, and the site is not called.
 *   B. A lost provision answer followed by "send it again" must not strand the traveller: the site holds an invite-bound binding for
 *      a user the control plane rolled back. The control plane tells the site which invite ids are DEAD for that name (revoked or
 *      expired and never redeemed, read under the trip lock) and the site replaces an invite-bound binding only when its invite is
 *      on that list. A redeemed member's binding is never on it.
 *   D. After an invite is revoked or expires, a group CLAIM of the freed name succeeds (not just the offer).
 */
import assert from "node:assert/strict";
import { after, before, describe, test } from "node:test";
import { createSiteInvite, deadInviteIdsFor } from "../src/portal.js";
import { ORIGIN, claim, id, initDataFor, launch, sha256, startHarness, tg, type Harness, type SitePerson } from "./support/group-sign-in-harness.js";
import { testDatabaseUrl } from "./support/test-database.js";

const skip = !testDatabaseUrl();
let h: Harness;
before(async () => { if (!skip) h = await startHarness(); });
after(async () => { if (!skip) await h.stop(); });

const PEOPLE: SitePerson[] = [
  { username: "dl17", displayName: "Dana Levi", role: "member" },
  { username: "nl23", displayName: "Noam Levi", role: "member" },
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
  return { tripId, owner, ownerSession: await h.webSession(owner, "owner"), app: h.newApp(), groupChat };
}
type Fixture = Awaited<ReturnType<typeof fixture>>;
const tokenOf = (joinUrl: string) => new URL(joinUrl).hash.slice("#token=".length);
const redeem = (app: App, token: string, extra: { cookie?: string; csrf?: string; method?: "password" | "google" } = {}) =>
  app.inject({
    method: "POST", url: "/v1/site-invites/redeem",
    headers: { ...(extra.cookie ? { cookie: extra.cookie } : {}), ...(extra.csrf ? { "x-csrf-token": extra.csrf, origin: ORIGIN } : {}) },
    payload: extra.method === "google" ? { token, method: "google" } : { token, method: "password", password: "a-long-enough-secret" },
  });
const makeInvite = async (f: Fixture, username = "dl17", replacePending = false) => {
  const made = await createSiteInvite(h.deps(), { tripId: f.tripId, actorUserId: f.owner, runtimeUsername: username, replacePending });
  assert.ok(made.ok, JSON.stringify(made));
  return made as Extract<typeof made, { ok: true }>;
};
const inviteState = async (inviteId: string) => (await h.pool.query("SELECT state, redeemed_by FROM control_plane.site_invites WHERE id = $1", [inviteId])).rows[0] as { state: string; redeemed_by: string | null };
const siteKey = (tripId: string, username: string) => `${tripId}:${username}`;

describe("A. an owner or organizer cannot redeem a member invite", { skip }, () => {
  test("not with a password through their signed-in cookie, not with Google, not as a secondary organizer, not as a former organizer: one clean refusal, nothing written, the site not asked", async () => {
    const f = await fixture();
    try {
      const secondary = await h.mkUser("Secondary"); await h.mkMember(f.tripId, secondary, "organizer", { dashboard: false });
      const former = await h.mkUser("Former organizer"); await h.mkMember(f.tripId, former, "organizer");
      await h.pool.query("UPDATE control_plane.trip_memberships SET status = 'revoked' WHERE trip_id = $1 AND user_id = $2", [f.tripId, former]);
      const googleOwner = await h.mkUser("Owner with Google");
      await h.mkMember(f.tripId, googleOwner, "owner");
      await h.pool.query("INSERT INTO control_plane.user_identities(id,user_id,provider,provider_subject_digest,verified_at) VALUES ($1,$2,'google',$3,now())", [id("idnt"), googleOwner, sha256(`google:${googleOwner}`)]);
      const invite = await makeInvite(f);
      const token = tokenOf(invite.joinUrl);
      const roleOf = async (userId: string) => (await h.pool.query("SELECT role, status FROM control_plane.trip_memberships WHERE trip_id = $1 AND user_id = $2", [f.tripId, userId])).rows[0];
      const cases: Array<[string, string, { cookie: string; csrf: string }, "password" | "google"]> = [
        ["the owner, a password, through their signed-in cookie", f.owner, f.ownerSession, "password"],
        ["a secondary organizer (no dashboard)", secondary, await h.webSession(secondary, "secondary"), "password"],
        ["a former organizer whose membership was ended", former, await h.webSession(former, "former"), "password"],
        ["an owner redeeming with Google", googleOwner, await h.webSession(googleOwner, "google-owner"), "google"],
      ];
      const snapshot = await h.snapshot();
      const provisioned = h.siteCalls.provision.length;
      for (const [label, userId, session, method] of cases) {
        const before = await roleOf(userId);
        const r = await redeem(f.app, token, { cookie: session.cookie, csrf: session.csrf, method });
        assert.equal(r.statusCode, 409, `${label}: ${r.body}`);
        assert.deepEqual(r.json(), { error: "INVITE_UNAVAILABLE" }, label);
        assert.deepEqual(await roleOf(userId), before, `${label}: the membership is untouched`);
      }
      assert.equal((await inviteState(invite.id)).state, "unused");
      assert.deepEqual(await h.snapshot(), snapshot, "nothing written: no user, membership, credential, identity or session");
      assert.equal(h.siteCalls.provision.length, provisioned, "the trip site was never asked to bind anyone");
      assert.equal(h.siteBindings.has(siteKey(f.tripId, "dl17")), false);
      // and the traveller can still use the very same link
      const real = await redeem(f.app, token);
      assert.equal(real.statusCode, 200, real.body);
    } finally { await f.app.close(); }
  });

  test("an organizer of ANOTHER trip, signed in, may redeem this trip's member invite as before (the rule is about this trip)", async () => {
    const f = await fixture();
    try {
      const other = await h.mkTrip("Elsewhere");
      const guest = await h.mkUser("Organizer elsewhere"); await h.mkMember(other, guest, "owner");
      const session = await h.webSession(guest, "elsewhere");
      const invite = await makeInvite(f);
      const r = await redeem(f.app, tokenOf(invite.joinUrl), { cookie: session.cookie, csrf: session.csrf });
      assert.equal(r.statusCode, 200, r.body);
      assert.equal((await inviteState(invite.id)).redeemed_by, guest);
    } finally { await f.app.close(); }
  });
});

describe("B. a lost answer, then \"send it again\", does not strand the traveller", { skip }, () => {
  test("the site bound a user the control plane rolled back; the NEW link redeems, and the stale binding is replaced", async () => {
    const f = await fixture();
    try {
      const first = await makeInvite(f);
      h.siteFail.provision = "bind_then_fail";
      const lost = await redeem(f.app, tokenOf(first.joinUrl));
      assert.equal(lost.statusCode, 503, lost.body);
      assert.deepEqual(lost.json(), { error: "RUNTIME_NOT_READY", retryable: true });
      const strandedUser = h.siteBindings.get(siteKey(f.tripId, "dl17"));
      assert.ok(strandedUser && h.siteHeld.has(siteKey(f.tripId, "dl17")), "the site HAS an invite-bound binding for a user the control plane does not have");
      assert.equal((await inviteState(first.id)).state, "unused");
      // "send it again"
      const second = await makeInvite(f, "dl17", true);
      assert.equal((await inviteState(first.id)).state, "revoked");
      const response = await redeem(f.app, tokenOf(second.joinUrl));
      assert.equal(response.statusCode, 200, response.body);
      const userId = (await inviteState(second.id)).redeemed_by!;
      assert.notEqual(userId, strandedUser);
      assert.equal(h.siteBindings.get(siteKey(f.tripId, "dl17")), userId, "the real traveller holds the name");
      const call = h.siteCalls.provision.filter((c) => c.inviteId === second.id).at(-1)!;
      assert.deepEqual(call.deadInviteIds, [first.id], "the wire change: only the dead invite ids of THIS name");
      assert.equal((await redeem(f.app, tokenOf(first.joinUrl))).statusCode, 404, "the original link is dead");
    } finally { await f.app.close(); }
  });

  test("the same retry of the SAME link after a lost answer still works (the stable user id), and sends no dead list", async () => {
    const f = await fixture();
    try {
      const invite = await makeInvite(f);
      h.siteFail.provision = "bind_then_fail";
      assert.equal((await redeem(f.app, tokenOf(invite.joinUrl))).statusCode, 503);
      const again = await redeem(f.app, tokenOf(invite.joinUrl));
      assert.equal(again.statusCode, 200, again.body);
      assert.equal(h.siteCalls.provision.filter((c) => c.inviteId === invite.id).every((c) => c.deadInviteIds === undefined), true);
    } finally { await f.app.close(); }
  });

  test("after a lost answer the organizer REVOKES: a group claim of the freed name succeeds (the adopt carries the dead invite id)", async () => {
    const f = await fixture();
    try {
      const invite = await makeInvite(f);
      h.siteFail.provision = "bind_then_fail";
      assert.equal((await redeem(f.app, tokenOf(invite.joinUrl))).statusCode, 503);
      const revoked = await f.app.inject({ method: "DELETE", url: `/v1/trips/${f.tripId}/site-invites/${invite.id}`, headers: { cookie: f.ownerSession.cookie, "x-csrf-token": f.ownerSession.csrf } });
      assert.equal(revoked.statusCode, 200);
      const person = tg();
      await h.telegram.member(f.groupChat, person, "member");
      const offer = (await launch(f.app, initDataFor(person, { tripId: f.tripId }))).json() as { travellers: { claimId: string; name: string }[] };
      const danaId = offer.travellers.find((t) => t.name === "Dana Levi")!.claimId;
      const claimed = await claim(f.app, initDataFor(person, { tripId: f.tripId }), f.tripId, danaId);
      assert.equal(claimed.statusCode, 200, claimed.body);
      assert.deepEqual(h.siteCalls.adopt.at(-1)!.deadInviteIds, [invite.id]);
      const claimant = (await h.pool.query("SELECT user_id FROM control_plane.trip_participant_claims WHERE trip_id = $1 AND runtime_username = 'dl17' AND released_at IS NULL", [f.tripId])).rows[0].user_id as string;
      assert.equal(h.siteBindings.get(siteKey(f.tripId, "dl17")), claimant);
      assert.equal(h.siteHeld.has(siteKey(f.tripId, "dl17")), false, "no longer invite-bound: it is a claim now");
    } finally { await f.app.close(); }
  });

  test("a REDEEMED member is never on the dead list, whatever else was revoked for the name; neither is a pending invite", async () => {
    const f = await fixture();
    try {
      const redeemed = await makeInvite(f);
      assert.equal((await redeem(f.app, tokenOf(redeemed.joinUrl))).statusCode, 200);
      // a revoked and an expired-and-never-redeemed invite for the same name (rows from before, e.g. an earlier "send again")
      const revokedId = id("invite"), expiredId = id("invite"), pendingId = id("invite");
      for (const [inviteId, state, expires] of [[revokedId, "revoked", "7 days"], [expiredId, "expired", "-1 day"]] as const) {
        await h.pool.query(
          `INSERT INTO control_plane.site_invites(id, trip_id, created_by, intended_display_name, runtime_username, token_digest, state, expires_at)
           VALUES ($1, $2, $3, 'Dana', 'dl17', $4, $5, now() + $6::interval)`, [inviteId, f.tripId, f.owner, sha256(`t-${inviteId}`), state, expires]);
      }
      const dead = await deadInviteIdsFor(h.pool, f.tripId, "dl17");
      assert.deepEqual([...dead].sort(), [expiredId, revokedId].sort());
      assert.ok(!dead.includes(redeemed.id), "a redeemed invite is a person on the trip");
      // a pending (unused, unexpired) invite on ANOTHER name is not listed for this one, and an unused invite past its expiry is dead
      await h.pool.query(
        `INSERT INTO control_plane.site_invites(id, trip_id, created_by, intended_display_name, runtime_username, token_digest, state, expires_at)
         VALUES ($1, $2, $3, 'Noam', 'nl23', $4, 'unused', now() + interval '7 days')`, [pendingId, f.tripId, f.owner, sha256(`t-${pendingId}`)]);
      assert.deepEqual(await deadInviteIdsFor(h.pool, f.tripId, "nl23"), [], "a pending invite is alive");
      await h.pool.query("UPDATE control_plane.site_invites SET expires_at = now() - interval '1 minute' WHERE id = $1", [pendingId]);
      assert.deepEqual(await deadInviteIdsFor(h.pool, f.tripId, "nl23"), [pendingId], "expired by the clock, never redeemed: dead");
      // and the fake site, given a list that names a different invite, keeps the redeemed member's binding
      assert.equal(h.siteBindings.get(siteKey(f.tripId, "dl17")), (await inviteState(redeemed.id)).redeemed_by);
    } finally { await f.app.close(); }
  });
});

describe("D. a freed name can be CLAIMED, not only offered", { skip }, () => {
  for (const how of ["revoked", "expired"] as const) {
    test(`an invite that was ${how}: the group claim of that name succeeds, and the snapshot gains exactly one account`, async () => {
      const f = await fixture();
      try {
        const invite = await makeInvite(f);
        if (how === "revoked") {
          const r = await f.app.inject({ method: "DELETE", url: `/v1/trips/${f.tripId}/site-invites/${invite.id}`, headers: { cookie: f.ownerSession.cookie, "x-csrf-token": f.ownerSession.csrf } });
          assert.equal(r.statusCode, 200);
        } else await h.pool.query("UPDATE control_plane.site_invites SET expires_at = now() - interval '1 minute' WHERE id = $1", [invite.id]);
        const person = tg();
        await h.telegram.member(f.groupChat, person, "member");
        const offer = (await launch(f.app, initDataFor(person, { tripId: f.tripId }))).json() as { travellers: { claimId: string; name: string }[] };
        assert.deepEqual(offer.travellers.map((t) => t.name), ["Dana Levi", "Noam Levi"]);
        const before = await h.snapshot();
        const claimed = await claim(f.app, initDataFor(person, { tripId: f.tripId }), f.tripId, offer.travellers.find((t) => t.name === "Dana Levi")!.claimId);
        assert.equal(claimed.statusCode, 200, claimed.body);
        const after = await h.snapshot();
        assert.equal(after.trip_participant_claims, before.trip_participant_claims! + 1);
        assert.equal(after.users, before.users! + 1);
      } finally { await f.app.close(); }
    });
  }
});
