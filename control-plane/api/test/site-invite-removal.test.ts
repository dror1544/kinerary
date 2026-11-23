/**
 * S2a rework 2: removing an invite-bound member ends their trip-site binding too (spec amendment A1: "member removal removes the
 * binding", which was true for claims only), and a lost release cannot strand the name.
 *
 * Both doors reach `removeMember`: DELETE /v1/trips/:id/members/:membershipId and DELETE .../site-invites/:inviteId on a REDEEMED invite.
 * After the COMMIT the control plane makes a prompt attempt, like a claim's release, to tell the site to end THAT binding (account + name +
 * invite id); a lost attempt is retried from the durable record the database wrote in the removal's transaction (site-release-outbox.test.ts
 * holds that). Independently of the retry, `deadInviteIdsFor` names the removed member's revoked invite for the next redemption or claim, because a
 * redeemed invite whose state is `revoked` and whose redeemer has NO active membership on the trip can only be a removal's, and its
 * binding opens nothing (a launch needs an active membership).
 */
import assert from "node:assert/strict";
import { after, before, describe, test } from "node:test";
import { createSiteInvite, deadInviteIdsFor } from "../src/portal.js";
import { claim, id, initDataFor, launch, sha256, startHarness, tg, type Harness, type SitePerson } from "./support/group-sign-in-harness.js";
import { testDatabaseUrl } from "./support/test-database.js";

const skip = !testDatabaseUrl();
let h: Harness;
before(async () => { if (!skip) h = await startHarness(); });
after(async () => { if (!skip) await h.stop(); });

const PEOPLE: SitePerson[] = [{ username: "dl17", displayName: "Dana Levi", role: "member" }, { username: "nl23", displayName: "Noam Levi", role: "member" }];
const siteKey = (tripId: string, username: string) => `${tripId}:${username}`;

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
const redeem = (f: Fixture, token: string) => f.app.inject({ method: "POST", url: "/v1/site-invites/redeem", payload: { token, method: "password", password: "a-long-enough-secret" } });
async function invite(f: Fixture, username = "dl17", replacePending = false) {
  const made = await createSiteInvite(h.deps(), { tripId: f.tripId, actorUserId: f.owner, runtimeUsername: username, replacePending });
  assert.ok(made.ok, JSON.stringify(made));
  return made as Extract<typeof made, { ok: true }>;
}
/** Redeems an invite for `username`; returns the invite id and the account the redemption made. */
async function member(f: Fixture, username = "dl17") {
  const made = await invite(f, username);
  const response = await redeem(f, tokenOf(made.joinUrl));
  assert.equal(response.statusCode, 200, response.body);
  const row = (await h.pool.query("SELECT redeemed_by FROM control_plane.site_invites WHERE id = $1", [made.id])).rows[0] as { redeemed_by: string };
  return { inviteId: made.id, userId: row.redeemed_by };
}
const removeViaMembers = async (f: Fixture, userId: string) => {
  const m = (await h.pool.query("SELECT id FROM control_plane.trip_memberships WHERE trip_id = $1 AND user_id = $2", [f.tripId, userId])).rows[0] as { id: string };
  return f.app.inject({ method: "DELETE", url: `/v1/trips/${f.tripId}/members/${m.id}`, headers: { cookie: f.ownerSession.cookie, "x-csrf-token": f.ownerSession.csrf } });
};
const removeViaInvite = (f: Fixture, inviteId: string) =>
  f.app.inject({ method: "DELETE", url: `/v1/trips/${f.tripId}/site-invites/${inviteId}`, headers: { cookie: f.ownerSession.cookie, "x-csrf-token": f.ownerSession.csrf } });
const dead = (f: Fixture, username = "dl17") => deadInviteIdsFor(h.pool, f.tripId, username);

describe("removing an invite-bound member ends their trip-site binding", { skip }, () => {
  for (const door of ["the member-removal route", "revoking the redeemed invite"] as const) {
    test(`via ${door}: the site is told, once, to end THAT binding (account, name and invite id); a new invite and a group claim then work`, async () => {
      const f = await fixture();
      try {
        const m = await member(f);
        assert.equal(h.siteBindings.get(siteKey(f.tripId, "dl17")), m.userId);
        const released = h.siteCalls.release.length;
        const response = door === "the member-removal route" ? await removeViaMembers(f, m.userId) : await removeViaInvite(f, m.inviteId);
        assert.equal(response.statusCode, 200, response.body);
        // (`reason` is only the audit line's word, passed through the adapter and never sent to the site)
        assert.deepEqual(h.siteCalls.release.slice(released).map(({ reason: _reason, ...call }: { reason?: string }) => call), [{ tripId: f.tripId, userId: m.userId, runtimeUsername: "dl17", inviteId: m.inviteId }]);
        assert.equal(h.siteBindings.has(siteKey(f.tripId, "dl17")), false, "the binding is gone");
        assert.equal(h.siteHeld.has(siteKey(f.tripId, "dl17")), false);
        // a new invite for the traveller redeems (no dead list needed: nothing stale is there)
        const again = await invite(f);
        const second = await redeem(f, tokenOf(again.joinUrl));
        assert.equal(second.statusCode, 200, second.body);
        assert.equal(h.siteCalls.provision.filter((c) => c.inviteId === again.id).every((c) => c.deadInviteIds === undefined || c.deadInviteIds.includes(m.inviteId)), true);
      } finally { await f.app.close(); }
    });
  }

  test("a group claim of the freed name works after the removal", async () => {
    const f = await fixture();
    try {
      const m = await member(f);
      assert.equal((await removeViaMembers(f, m.userId)).statusCode, 200);
      const person = tg();
      await h.telegram.member(f.groupChat, person, "member");
      const offer = (await launch(f.app, initDataFor(person, { tripId: f.tripId }))).json() as { travellers: { claimId: string; name: string }[] };
      assert.ok(offer.travellers.some((t) => t.name === "Dana Levi"), "the name is offered again");
      const claimed = await claim(f.app, initDataFor(person, { tripId: f.tripId }), f.tripId, offer.travellers.find((t) => t.name === "Dana Levi")!.claimId);
      assert.equal(claimed.statusCode, 200, claimed.body);
    } finally { await f.app.close(); }
  });

  test("a LOST release does not strand the name: the removal still succeeds, and the next invite and the next group claim both go through (the dead list names the removed member's invite)", async () => {
    const f = await fixture();
    try {
      const m = await member(f);
      h.siteFail.release = "unavailable";
      assert.equal((await removeViaMembers(f, m.userId)).statusCode, 200);
      assert.equal(h.siteBindings.get(siteKey(f.tripId, "dl17")), m.userId, "the site still holds the removed member's binding");
      assert.deepEqual(await dead(f), [m.inviteId]);
      const again = await invite(f);
      const second = await redeem(f, tokenOf(again.joinUrl));
      assert.equal(second.statusCode, 200, second.body);
      assert.deepEqual(h.siteCalls.provision.filter((c) => c.inviteId === again.id).at(-1)!.deadInviteIds, [m.inviteId]);
      // the claim route, on a second traveller, the same way
      const n = await member(f, "nl23");
      h.siteFail.release = "unavailable";
      assert.equal((await removeViaInvite(f, n.inviteId)).statusCode, 200);
      const person = tg();
      await h.telegram.member(f.groupChat, person, "member");
      const offer = (await launch(f.app, initDataFor(person, { tripId: f.tripId }))).json() as { travellers: { claimId: string; name: string }[] };
      const claimed = await claim(f.app, initDataFor(person, { tripId: f.tripId }), f.tripId, offer.travellers.find((t) => t.name === "Noam Levi")!.claimId);
      assert.equal(claimed.statusCode, 200, claimed.body);
      assert.deepEqual(h.siteCalls.adopt.at(-1)!.deadInviteIds, [n.inviteId]);
    } finally { await f.app.close(); }
  });

  test("a removed group CLAIM still releases without an invite id (unchanged), and a removed member with no site binding of their own is not an error", async () => {
    const f = await fixture();
    try {
      const person = tg();
      await h.telegram.member(f.groupChat, person, "member");
      const offer = (await launch(f.app, initDataFor(person, { tripId: f.tripId }))).json() as { travellers: { claimId: string; name: string }[] };
      assert.equal((await claim(f.app, initDataFor(person, { tripId: f.tripId }), f.tripId, offer.travellers[0]!.claimId)).statusCode, 200);
      const claimant = (await h.pool.query("SELECT user_id FROM control_plane.trip_participant_claims WHERE trip_id = $1 AND released_at IS NULL", [f.tripId])).rows[0].user_id as string;
      const released = h.siteCalls.release.length;
      assert.equal((await removeViaMembers(f, claimant)).statusCode, 200);
      const calls = h.siteCalls.release.slice(released);
      assert.equal(calls.length, 1);
      assert.equal("inviteId" in calls[0]!, false, "a claim's release names no invite");
    } finally { await f.app.close(); }
  });
});

describe("the audit lines and the refused removals", { skip }, () => {
  const events = () => h.logs.map((line) => { try { return JSON.parse(line) as Record<string, unknown>; } catch { return null; } }).filter((x): x is Record<string, unknown> => x !== null);

  test("removing an INVITE member logs member_invite.binding_released (reason only), never a group-claim end; removing a CLAIM logs the group-claim line and no invite line; no id is in either", async () => {
    const f = await fixture();
    try {
      const m = await member(f);
      const start = h.logs.length;
      assert.equal((await removeViaMembers(f, m.userId)).statusCode, 200);
      const lines = h.logs.slice(start);
      const mine = events().filter((e) => lines.some((line) => line.includes(String(e.event))));
      assert.ok(lines.some((line) => line.includes("member_invite.binding_released")), "the invite release has its own event");
      assert.deepEqual(events().filter((e) => e.event === "member_invite.binding_released").at(-1), { ...events().filter((e) => e.event === "member_invite.binding_released").at(-1)!, reason: "membership_ended" });
      assert.equal(lines.some((line) => line.includes("mini_app.group_claim")), false, "no group claim ended, so no group-claim line");
      for (const secret of [m.inviteId, m.userId, "dl17", f.tripId]) assert.equal(lines.join("\n").includes(secret), false, "no id in the audit line");
      void mine;
      // revoking the redeemed invite: the same event, its own reason
      const n = await member(f, "nl23");
      const before = h.logs.length;
      assert.equal((await removeViaInvite(f, n.inviteId)).statusCode, 200);
      const revoked = h.logs.slice(before);
      assert.ok(revoked.some((line) => line.includes("member_invite.binding_released") && line.includes("invite_revoked")));
      assert.equal(revoked.some((line) => line.includes("mini_app.group_claim")), false);
      // a removed group claim: the group-claim line stays, and there is no invite line
      const person = tg();
      await h.telegram.member(f.groupChat, person, "member");
      const offer = (await launch(f.app, initDataFor(person, { tripId: f.tripId }))).json() as { travellers: { claimId: string; name: string }[] };
      assert.equal((await claim(f.app, initDataFor(person, { tripId: f.tripId }), f.tripId, offer.travellers[0]!.claimId)).statusCode, 200);
      const claimant = (await h.pool.query("SELECT user_id FROM control_plane.trip_participant_claims WHERE trip_id = $1 AND released_at IS NULL", [f.tripId])).rows[0].user_id as string;
      const mark = h.logs.length;
      assert.equal((await removeViaMembers(f, claimant)).statusCode, 200);
      const claimLines = h.logs.slice(mark);
      assert.ok(claimLines.some((line) => line.includes("mini_app.group_claim") && line.includes("membership_ended")));
      assert.equal(claimLines.some((line) => line.includes("member_invite.binding_released")), false);
    } finally { await f.app.close(); }
  });

  test("a REFUSED removal sends no release to the site: an unknown membership (404), an owner removing themselves (409), and an organizer removing an owner (409 OWNER_ONLY), by the members route and by revoking the redeemed invite", async () => {
    const f = await fixture();
    try {
      // the invite member is an OWNER too (promoted), so the removal rules refuse in each way below
      const m = await member(f);
      await h.pool.query("UPDATE control_plane.trip_memberships SET role = 'owner', dashboard_access = true WHERE trip_id = $1 AND user_id = $2", [f.tripId, m.userId]);
      const ownerSelf = await h.webSession(m.userId, "owner-self");
      const organizerUser = await h.mkUser("Organizer"); await h.mkMember(f.tripId, organizerUser, "organizer");
      const organizer = await h.webSession(organizerUser, "organizer");
      const membershipId = (await h.pool.query("SELECT id FROM control_plane.trip_memberships WHERE trip_id = $1 AND user_id = $2", [f.tripId, m.userId])).rows[0].id as string;
      const releases = h.siteCalls.release.length;
      const as = (who: { cookie: string; csrf: string }, method: "DELETE", url: string) => f.app.inject({ method, url, headers: { cookie: who.cookie, "x-csrf-token": who.csrf } });
      const unknown = await as(f.ownerSession, "DELETE", `/v1/trips/${f.tripId}/members/memb_doesnotexist`);
      assert.equal(unknown.statusCode, 404);
      const self = await as(ownerSelf, "DELETE", `/v1/trips/${f.tripId}/members/${membershipId}`);
      assert.equal(self.statusCode, 409, self.body);
      assert.equal((self.json() as { error: string }).error, "CANNOT_REMOVE_SELF");
      const ownerOnly = await as(organizer, "DELETE", `/v1/trips/${f.tripId}/members/${membershipId}`);
      assert.equal(ownerOnly.statusCode, 409, ownerOnly.body);
      assert.equal((ownerOnly.json() as { error: string }).error, "OWNER_ONLY");
      assert.equal((await as(ownerSelf, "DELETE", `/v1/trips/${f.tripId}/site-invites/${m.inviteId}`)).statusCode, 409, "revoking the redeemed invite is refused the same way");
      assert.equal((await as(organizer, "DELETE", `/v1/trips/${f.tripId}/site-invites/${m.inviteId}`)).statusCode, 409);
      assert.equal(h.siteCalls.release.length, releases, "no release was sent for any refused removal");
      assert.equal(h.siteBindings.get(siteKey(f.tripId, "dl17")), m.userId, "the binding is intact");
      assert.equal((await h.pool.query("SELECT status FROM control_plane.trip_memberships WHERE id = $1", [membershipId])).rows[0].status, "active");
      assert.equal((await h.pool.query("SELECT state FROM control_plane.site_invites WHERE id = $1", [m.inviteId])).rows[0].state, "redeemed");
    } finally { await f.app.close(); }
  });
});

describe("deadInviteIdsFor: what it returns for each state, and why it can never name a live member's invite", { skip }, () => {
  test("a redeemed ACTIVE member's invite is never listed, however the row is tampered with; once they are removed it is, and only then", async () => {
    const f = await fixture();
    try {
      const m = await member(f);
      assert.deepEqual(await dead(f), [], "redeemed, member active");
      for (const state of ["revoked", "expired", "unused"]) {
        await h.pool.query("UPDATE control_plane.site_invites SET state = $2, redeemed_at = redeemed_at WHERE id = $1", [m.inviteId, state]);
        if (state === "unused") await h.pool.query("UPDATE control_plane.site_invites SET expires_at = now() - interval '1 day' WHERE id = $1", [m.inviteId]);
        assert.deepEqual(await dead(f), [], `an active member's invite tampered to '${state}'`);
      }
      await h.pool.query("UPDATE control_plane.site_invites SET state = 'redeemed', expires_at = now() + interval '7 days' WHERE id = $1", [m.inviteId]);
      assert.deepEqual(await dead(f), []);
      assert.equal((await removeViaMembers(f, m.userId)).statusCode, 200);
      assert.deepEqual(await dead(f), [m.inviteId], "revoked, redeemer has no active membership");
      // 'expired' or 'unused' with a redeemer is still never listed (only a removal's own 'revoked' counts)
      for (const state of ["expired", "unused"]) {
        await h.pool.query("UPDATE control_plane.site_invites SET state = $2 WHERE id = $1", [m.inviteId, state]);
        assert.deepEqual(await dead(f), [], `a redeemer's invite in state '${state}' is not a removal's`);
      }
      await h.pool.query("UPDATE control_plane.site_invites SET state = 'revoked' WHERE id = $1", [m.inviteId]);
      assert.deepEqual(await dead(f), [m.inviteId]);
    } finally { await f.app.close(); }
  });

  test("the widening can never name the invite of someone who is a member again: membership revived by any path, a new invite redeemed by the same account, an owner or organizer", async () => {
    const f = await fixture();
    try {
      const m = await member(f);
      assert.equal((await removeViaMembers(f, m.userId)).statusCode, 200);
      assert.deepEqual(await dead(f), [m.inviteId]);
      // revived by another path: an active membership of ANY role
      for (const role of ["member", "organizer", "owner"]) {
        await h.pool.query("UPDATE control_plane.trip_memberships SET status = 'active', role = $3 WHERE trip_id = $1 AND user_id = $2", [f.tripId, m.userId, role]);
        assert.deepEqual(await dead(f), [], `membership active again as ${role}`);
        await h.pool.query("UPDATE control_plane.trip_memberships SET status = 'revoked' WHERE trip_id = $1 AND user_id = $2", [f.tripId, m.userId]);
        assert.deepEqual(await dead(f), [m.inviteId]);
      }
      await h.pool.query("UPDATE control_plane.trip_memberships SET role = 'member' WHERE trip_id = $1 AND user_id = $2", [f.tripId, m.userId]);
      // the same account re-invited: signed in, it redeems a NEW invite (its membership is revived by that redemption)
      const session = await h.webSession(m.userId, "reinvited");
      const again = await invite(f);
      const response = await f.app.inject({ method: "POST", url: "/v1/site-invites/redeem", headers: { cookie: session.cookie }, payload: { token: tokenOf(again.joinUrl), method: "password", password: "a-long-enough-secret" } });
      assert.equal(response.statusCode, 200, response.body);
      assert.deepEqual(await dead(f), [], "re-invited and redeemed: the old invite is not named (the account is a member again) and the new one is redeemed");
      assert.equal(h.siteBindings.get(siteKey(f.tripId, "dl17")), m.userId, "the re-invited account holds the name again, under the new invite");
      assert.deepEqual(h.siteCalls.provision.filter((c) => c.inviteId === again.id).at(-1)!.deadInviteIds, [m.inviteId], "at the moment of redemption the old binding was stale and was named");
    } finally { await f.app.close(); }
  });

  test("another traveller's, another trip's and a pending invite are never named for this name", async () => {
    const f = await fixture();
    try {
      const m = await member(f);
      const n = await member(f, "nl23");
      assert.equal((await removeViaMembers(f, m.userId)).statusCode, 200);
      assert.deepEqual(await dead(f, "nl23"), [], "Noam is a live member");
      assert.deepEqual(await dead(f, "dl17"), [m.inviteId]);
      const other = await fixture();
      try { assert.deepEqual(await deadInviteIdsFor(h.pool, other.tripId, "dl17"), [], "another trip"); } finally { await other.app.close(); }
      const pending = await invite(f, "dl17");
      assert.deepEqual((await dead(f)).sort(), [m.inviteId].sort(), "a pending invite is alive and not listed");
      void n; void pending;
      void sha256; void id;
    } finally { await f.app.close(); }
  });
});
