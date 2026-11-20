/**
 * Group sign-in's site binding, control-plane half (docs/specs/sprint-9/x-member-sign-in.md, slice S1, rework 1).
 *
 * A claim writes control-plane rows; the trip site must ALSO bind the new account to the existing participant, or the
 * session exchange answers IDENTITY_MISMATCH. These tests pin the ORDER and the COMPENSATION on the control-plane side,
 * against a fake site that keeps bindings the way the real one does. The real site and the real gateway run in
 * tests/control-plane-claim-binding.test.js (adopt -> exchange -> release -> exchange -> re-claim); the adapter's wire
 * shape is runtime-account-adapter-list.test.ts. Cross-process is impractical here (the site needs its own node_modules
 * and a sqlite database), which is why it is split this way.
 */
import assert from "node:assert/strict";
import { after, before, describe, test } from "node:test";
import { ORIGIN, asCookie, claim, cookieOf, initDataFor, launch, startHarness, tg, type Harness, type SitePerson } from "./support/group-sign-in-harness.js";
import { testDatabaseUrl } from "./support/test-database.js";

const skip = !testDatabaseUrl();
let h: Harness;
before(async () => { if (!skip) h = await startHarness(); });
after(async () => { if (!skip) await h.stop(); });

const PEOPLE: SitePerson[] = [
  { username: "dl17", displayName: "Dana Levi", role: "member" },
  { username: "nl23", displayName: "Noam Levi", role: "member" },
];
async function trip() {
  const tripId = await h.mkTrip("Bound trip");
  const owner = await h.mkUser("Owner");
  await h.mkMember(tripId, owner, "owner");
  const chatId = await h.bindGroup(tripId);
  await h.switchOn(tripId);
  h.site.set(tripId, PEOPLE.map((p) => ({ ...p })));
  const ownerSession = await h.webSession(owner, "owner");
  return { tripId, chatId, ownerSession };
}
type App = ReturnType<Harness["newApp"]>;
async function offer(app: App, tripId: string, chatId: string, person: number) {
  await h.telegram.member(chatId, person, "member");
  const body = (await launch(app, initDataFor(person, { tripId }))).json() as { travellers: { claimId: string; name: string }[] };
  return (name: string) => body.travellers.find((t) => t.name === name)!.claimId;
}
const keyOf = (tripId: string, username: string) => `${tripId}:${username}`;
const boundUser = async (tripId: string, tripUser: string) => (await h.pool.query("SELECT user_id FROM control_plane.trip_participant_claims WHERE trip_id = $1 AND runtime_username = $2 AND released_at IS NULL", [tripId, tripUser])).rows[0]?.user_id as string | undefined;

describe("a claim binds the trip site, and is not final until it has", { skip }, () => {
  test("the site binds the NEW account to the existing participant before the claim commits; the session then opens the trip", async () => {
    const { tripId, chatId } = await trip();
    const person = tg(); const app = h.newApp();
    try {
      const id = await offer(app, tripId, chatId, person);
      h.siteCalls.adopt.length = 0;
      const response = await claim(app, initDataFor(person, { tripId }), tripId, id("Dana Levi"));
      assert.equal(response.statusCode, 200, response.body);
      assert.equal(h.siteCalls.adopt.length, 1);
      const userId = (await boundUser(tripId, "dl17"))!;
      assert.deepEqual(h.siteCalls.adopt[0], { tripId, userId, runtimeUsername: "dl17" });
      assert.equal(h.siteBindings.get(keyOf(tripId, "dl17")), userId, "the site holds the binding of the account the claim created");
      // and the launch exchange names the same participant the site was told
      const launched = await app.inject({ method: "POST", url: `/v1/trips/${tripId}/launch`, headers: { origin: ORIGIN, cookie: asCookie(response), "x-csrf-token": cookieOf(response, "kit_csrf")! } });
      const grant = await app.inject({ method: "POST", url: "/internal/runtime-launch/consume", headers: { "x-api-key": "exchange-key", "content-type": "application/json" }, payload: JSON.stringify({ token: launched.json().launchToken }) });
      assert.deepEqual({ u: grant.json().userId, n: grant.json().runtimeUsername, r: grant.json().role }, { u: userId, n: "dl17", r: "member" });
    } finally { await app.close(); }
  });

  test("a site that cannot be reached: no claim, no account, no session, a retryable 503 that names nothing, and the next try works", async () => {
    const { tripId, chatId } = await trip();
    const person = tg(); const app = h.newApp();
    try {
      const id = await offer(app, tripId, chatId, person);
      const snapshot = await h.snapshot();
      h.siteFail.adopt = "unavailable";
      const response = await claim(app, initDataFor(person, { tripId }), tripId, id("Dana Levi"));
      assert.equal(response.statusCode, 503);
      assert.deepEqual(response.json(), { error: "MEMBERSHIP_CHECK_UNAVAILABLE", retryable: true });
      assert.ok(!response.body.includes(tripId) && !response.body.includes("dl17") && !response.body.includes("Dana"));
      assert.equal(cookieOf(response, "kit_session"), null);
      assert.deepEqual(await h.snapshot(), snapshot, "nothing at all was written");
      assert.equal(h.siteBindings.has(keyOf(tripId, "dl17")), false);
      const retry = await claim(app, initDataFor(person, { tripId }), tripId, id("Dana Levi"));
      assert.equal(retry.statusCode, 200, retry.body);
    } finally { await app.close(); }
  });

  test("the site binds but its answer never arrives: the claim rolls back, and the leftover binding does not stick the participant", async () => {
    const { tripId, chatId } = await trip();
    const first = tg(), second = tg(); const app = h.newApp();
    try {
      const idFirst = await offer(app, tripId, chatId, first);
      const idSecond = await offer(app, tripId, chatId, second);
      const snapshot = await h.snapshot();
      h.siteFail.adopt = "bind_then_fail";
      const lost = await claim(app, initDataFor(first, { tripId }), tripId, idFirst("Dana Levi"));
      assert.equal(lost.statusCode, 503);
      assert.deepEqual(await h.snapshot(), snapshot, "control plane: rolled back whole");
      assert.ok(h.siteBindings.has(keyOf(tripId, "dl17")), "(the leftover the test planted: the site did bind)");
      // someone else claims the same traveller: the site REPLACES the leftover, so there is no IDENTITY_CONFLICT
      const won = await claim(app, initDataFor(second, { tripId }), tripId, idSecond("Dana Levi"));
      assert.equal(won.statusCode, 200, won.body);
      assert.equal(h.siteBindings.get(keyOf(tripId, "dl17")), await boundUser(tripId, "dl17"), "now the live claim's account holds it");
    } finally { await app.close(); }
  });

  test("the site refuses (not a plain member there) or an invite holds the name: no claim, and the answers every refusal gets", async () => {
    const { tripId, chatId } = await trip();
    const person = tg(); const app = h.newApp();
    try {
      const id = await offer(app, tripId, chatId, person);
      const snapshot = await h.snapshot();
      h.siteFail.adopt = "refused";
      const refused = await claim(app, initDataFor(person, { tripId }), tripId, id("Dana Levi"));
      assert.equal(refused.statusCode, 404); assert.deepEqual(refused.json(), { error: "NOT_FOUND" });
      h.siteHeld.add(keyOf(tripId, "nl23"));
      const held = await claim(app, initDataFor(person, { tripId }), tripId, id("Noam Levi"));
      assert.equal(held.statusCode, 409); assert.deepEqual(held.json(), { error: "ALREADY_CLAIMED" });
      assert.deepEqual(await h.snapshot(), snapshot);
      assert.equal(h.siteBindings.has(keyOf(tripId, "nl23")), false, "an invite-bound name is never displaced");
    } finally { await app.close(); }
  });
});

describe("every way a claim ends takes the site binding with it, so another account can claim the traveller", { skip }, () => {
  async function claimed() {
    const ctx = await trip(); const person = tg(); const app = h.newApp();
    const id = await offer(app, ctx.tripId, ctx.chatId, person);
    const session = await claim(app, initDataFor(person, { tripId: ctx.tripId }), ctx.tripId, id("Dana Levi"));
    assert.equal(session.statusCode, 200, session.body);
    const userId = (await boundUser(ctx.tripId, "dl17"))!;
    h.siteCalls.release.length = 0;
    return { ...ctx, person, app, session, userId };
  }
  const reclaim = async (c: { app: App; tripId: string; chatId: string }) => {
    const next = tg(); const id = await offer(c.app, c.tripId, c.chatId, next);
    const response = await claim(c.app, initDataFor(next, { tripId: c.tripId }), c.tripId, id("Dana Levi"));
    assert.equal(response.statusCode, 200, response.body);
    assert.notEqual(h.siteBindings.get(keyOf(c.tripId, "dl17")), undefined);
    return (await boundUser(c.tripId, "dl17"))!;
  };

  test("an organizer's Release", async () => {
    const c = await claimed();
    try {
      const claimId = ((await c.app.inject({ method: "GET", url: `/v1/trips/${c.tripId}/member-claims`, headers: { cookie: c.ownerSession.cookie } })).json() as { claims: { claimId: string }[] }).claims[0]!.claimId;
      const released = await c.app.inject({ method: "DELETE", url: `/v1/trips/${c.tripId}/member-claims/${claimId}`, headers: { origin: ORIGIN, cookie: c.ownerSession.cookie, "x-csrf-token": c.ownerSession.csrf } });
      assert.equal(released.statusCode, 200);
      assert.deepEqual(h.siteCalls.release, [{ tripId: c.tripId, userId: c.userId, runtimeUsername: "dl17" }]);
      assert.equal(h.siteBindings.has(keyOf(c.tripId, "dl17")), false);
      assert.notEqual(await reclaim(c), c.userId);
    } finally { await c.app.close(); }
  });

  test("the person leaving the group", async () => {
    const c = await claimed();
    try {
      await h.telegram.member(c.chatId, c.person, "left");
      const gone = await launch(c.app, initDataFor(c.person, { tripId: c.tripId }));
      assert.equal(gone.statusCode, 401);
      assert.deepEqual(h.siteCalls.release, [{ tripId: c.tripId, userId: c.userId, runtimeUsername: "dl17" }]);
      assert.equal(h.siteBindings.has(keyOf(c.tripId, "dl17")), false);
      assert.notEqual(await reclaim(c), c.userId);
    } finally { await c.app.close(); }
  });

  test("the person's own Unlink", async () => {
    const c = await claimed();
    try {
      const linkId = (await h.pool.query("SELECT id FROM control_plane.telegram_member_links WHERE trip_id = $1", [c.tripId])).rows[0].id;
      const unlinked = await c.app.inject({ method: "DELETE", url: `/v1/account/telegram-links/${linkId}`, headers: { origin: ORIGIN, cookie: asCookie(c.session), "x-csrf-token": cookieOf(c.session, "kit_csrf")! } });
      assert.equal(unlinked.statusCode, 200, unlinked.body);
      assert.deepEqual(h.siteCalls.release, [{ tripId: c.tripId, userId: c.userId, runtimeUsername: "dl17" }]);
      assert.notEqual(await reclaim(c), c.userId);
    } finally { await c.app.close(); }
  });

  test("an organizer removing the member the ordinary way", async () => {
    const c = await claimed();
    try {
      const membershipId = (await h.pool.query("SELECT id FROM control_plane.trip_memberships WHERE trip_id = $1 AND user_id = $2", [c.tripId, c.userId])).rows[0].id;
      const removed = await c.app.inject({ method: "DELETE", url: `/v1/trips/${c.tripId}/members/${membershipId}`, headers: { origin: ORIGIN, cookie: c.ownerSession.cookie, "x-csrf-token": c.ownerSession.csrf } });
      assert.equal(removed.statusCode, 200, removed.body);
      assert.deepEqual(h.siteCalls.release, [{ tripId: c.tripId, userId: c.userId, runtimeUsername: "dl17" }]);
      assert.notEqual(await reclaim(c), c.userId);
    } finally { await c.app.close(); }
  });

  test("a release that never reaches the site changes nothing for the control plane, and the NEXT claim still works (the leftover is replaced)", async () => {
    const c = await claimed();
    try {
      await h.telegram.member(c.chatId, c.person, "left");
      h.siteFail.release = "unavailable";
      const gone = await launch(c.app, initDataFor(c.person, { tripId: c.tripId }));
      assert.equal(gone.statusCode, 401, "the person is turned away as ever; a site outage costs the launch nothing");
      assert.equal(h.siteBindings.get(keyOf(c.tripId, "dl17")), c.userId, "the leftover is still on the site");
      assert.ok(h.logs.some((line) => line.includes("member_claim.site_release_failed")), "and it is said, by kind only");
      assert.ok(!h.logs.join("\n").includes(c.userId));
      const newUser = await reclaim(c);
      assert.notEqual(newUser, c.userId);
      assert.equal(h.siteBindings.get(keyOf(c.tripId, "dl17")), newUser);
    } finally { await c.app.close(); }
  });
});
