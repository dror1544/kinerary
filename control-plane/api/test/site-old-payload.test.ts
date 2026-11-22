/**
 * MIXED VERSIONS: the control plane runs this release while a trip site still runs the OLD payload (the two deploy on different clocks).
 *
 * On `main`, `POST /v1/trips/:id/site-invites` asked the site `participantExists` (`GET …/participants/:username`, which every deployed
 * site has). This branch's `createSiteInvite` asks `listParticipants` (`GET …/participants`, a NEW route) for the role and the name. An
 * old payload answers that with Express's default 404 (an HTML page), so every organizer's existing "invite a traveller" would have
 * answered RUNTIME_NOT_READY on every trip not yet redeployed. Now an HTML 404 on the list (not the site's own JSON error) falls back to
 * `participantExists`, exactly as `main`; a real outage still answers RUNTIME_NOT_READY; every other caller of the list fails safe.
 *
 * The site is a real HTTP server (test/support/old-payload-site.ts) reached through the REAL `HttpRuntimeAccountAdapter`.
 */
import assert from "node:assert/strict";
import { after, before, beforeEach, describe, test } from "node:test";
import { handleInvite } from "../src/relay/invite-command.js";
import { runSiteReleasePass } from "../src/site-release-outbox.js";
import { ORIGIN, id, initDataFor, launch, sha256, startHarness, tg, type Harness } from "./support/group-sign-in-harness.js";
import { startOldPayloadSite, type OldPayloadSite } from "./support/old-payload-site.js";
import { testDatabaseUrl } from "./support/test-database.js";

const skip = !testDatabaseUrl();
let h: Harness;
before(async () => { if (!skip) h = await startHarness(); });
after(async () => { if (!skip) await h.stop(); });

let logs: string[];
beforeEach(() => { logs = []; });
const tokenOf = (joinUrl: string) => new URL(joinUrl).hash.slice("#token=".length);

async function fixture() {
  const site = await startOldPayloadSite(["dl17", "nl23", "og01"]);
  const tripId = await h.mkTrip("Old payload trip");
  const owner = await h.mkUser("The Owner");
  await h.mkMember(tripId, owner, "owner");
  const session = await h.webSession(owner, "owner");
  const app = h.newApp({ runtimeAccounts: site.adapter, emailAuthLog: (line) => logs.push(line) });
  const headers = { origin: ORIGIN, cookie: session.cookie, "x-csrf-token": session.csrf };
  const create = (runtimeUsername: string, displayName = "Dana Levi") =>
    app.inject({ method: "POST", url: `/v1/trips/${tripId}/site-invites`, headers, payload: { runtimeUsername, displayName } });
  const stop = async () => { await app.close(); await site.close(); };
  return { site, tripId, owner, app, create, stop };
}
const listCalls = (site: OldPayloadSite, tripId: string) => site.calls.filter((c) => c === `GET /internal/t/${tripId}/participants`).length;
const existsCalls = (site: OldPayloadSite, tripId: string, username: string) => site.calls.filter((c) => c === `GET /internal/t/${tripId}/participants/${username}`).length;
const inviteRows = async (tripId: string) => (await h.pool.query("SELECT state, runtime_username FROM control_plane.site_invites WHERE trip_id = $1", [tripId])).rows as { state: string; runtime_username: string }[];

describe("1. an OLD-payload site: the organizer's existing invite works as it did on main", { skip }, () => {
  test("an existing traveller: 201, the same body main gave, and the redeem works (provision is a route the old payload has)", async () => {
    const f = await fixture();
    try {
      const made = await f.create("dl17");
      assert.equal(made.statusCode, 201, made.body);
      const body = made.json() as { id: string; status: string; joinUrl: string };
      assert.deepEqual(Object.keys(body).sort(), ["id", "joinUrl", "status"]);
      assert.equal(body.status, "unused");
      assert.equal(listCalls(f.site, f.tripId), 1, "the list was tried first");
      assert.equal(existsCalls(f.site, f.tripId, "dl17"), 1, "then the per-participant route main used");
      const [row] = await inviteRows(f.tripId);
      assert.deepEqual(row, { state: "unused", runtime_username: "dl17" });
      assert.equal((await h.pool.query("SELECT intended_display_name FROM control_plane.site_invites WHERE id = $1", [body.id])).rows[0].intended_display_name, "Dana Levi", "the name is what the organizer typed");
      // the one line that makes the rollout window visible: the event, no id, no name
      const fallbackLines = logs.filter((line) => line.includes("site_invite.old_site_fallback"));
      assert.equal(fallbackLines.length, 1);
      assert.equal(JSON.parse(fallbackLines[0]!).level, "info");
      assert.ok(!fallbackLines[0]!.includes(f.tripId) && !fallbackLines[0]!.includes("dl17"), fallbackLines[0]);
      // and the person redeems, exactly as on main
      const redeemed = await f.app.inject({ method: "POST", url: "/v1/site-invites/redeem", payload: { token: tokenOf(body.joinUrl), method: "password", password: "a-long-enough-secret" } });
      assert.equal(redeemed.statusCode, 200, redeemed.body);
      assert.ok(f.site.calls.includes(`POST /internal/t/${f.tripId}/participants`), "the old payload's provision route was called");
      assert.equal((await inviteRows(f.tripId))[0]!.state, "redeemed");
    } finally { await f.stop(); }
  });

  test("a traveller that does not exist is the refusal main gave (409 RUNTIME_PARTICIPANT_NOT_FOUND), and nothing is written", async () => {
    const f = await fixture();
    try {
      const r = await f.create("zz99", "Nobody Here");
      assert.equal(r.statusCode, 409);
      assert.deepEqual(r.json(), { error: "RUNTIME_PARTICIPANT_NOT_FOUND" });
      assert.deepEqual(await inviteRows(f.tripId), []);
    } finally { await f.stop(); }
  });

  test("what the control plane knows is still enforced: a traveller claimed from the group, and a name an organizer-side account holds, are refused", async () => {
    const f = await fixture();
    try {
      const claimant = await h.mkUser("Claimant");
      await h.mkMember(f.tripId, claimant, "member", { dashboard: false });
      await h.pool.query(
        "INSERT INTO control_plane.trip_participant_claims(id, trip_id, user_id, runtime_username, via, telegram_user_id) VALUES ($1, $2, $3, 'nl23', 'group_membership', $4)",
        [id("tpc"), f.tripId, claimant, String(tg())]);
      const claimed = await f.create("nl23", "Noam Levi");
      assert.equal(claimed.statusCode, 409);
      assert.deepEqual(claimed.json(), { error: "TRAVELLER_CLAIMED_FROM_GROUP" });
      // the owner's own account holds the name og01 (a redeemed invite maps the name to an organizer-side account)
      await h.pool.query(
        `INSERT INTO control_plane.site_invites(id, trip_id, created_by, intended_display_name, runtime_username, token_digest, state, expires_at, redeemed_by, redeemed_at)
         VALUES ($1, $2, $3, 'Olga', 'og01', $4, 'redeemed', now() + interval '1 day', $3, now())`, [id("invite"), f.tripId, f.owner, sha256(id("digest"))]);
      const organizer = await f.create("og01", "Olga Organizer");
      assert.equal(organizer.statusCode, 409);
      assert.deepEqual(organizer.json(), { error: "RUNTIME_PARTICIPANT_NOT_ELIGIBLE" });
      assert.deepEqual((await inviteRows(f.tripId)).filter((r) => r.state === "unused"), []);
    } finally { await f.stop(); }
  });

  test("the caller's name is required, as on main (the list could have supplied one; an old site cannot): 400 INVALID_REQUEST from createSiteInvite itself", async () => {
    const f = await fixture();
    try {
      const { createSiteInvite } = await import("../src/portal.js");
      const made = await createSiteInvite({ db: h.pool, runtimeAccounts: f.site.adapter, publicOrigin: ORIGIN }, { tripId: f.tripId, actorUserId: f.owner, runtimeUsername: "dl17" });
      assert.deepEqual(made, { ok: false, status: 400, error: "INVALID_REQUEST" });
      assert.deepEqual(await inviteRows(f.tripId), []);
    } finally { await f.stop(); }
  });
});

describe("2. a genuine outage is still RUNTIME_NOT_READY: the fallback is for a missing route only", { skip }, () => {
  test("5xx on every route, a refused connection, and the list answering the gateway's OWN JSON 404", async () => {
    const f = await fixture();
    try {
      f.site.mode = "outage";
      const down = await f.create("dl17");
      assert.equal(down.statusCode, 409);
      assert.deepEqual(down.json(), { error: "RUNTIME_NOT_READY" });
      assert.equal(existsCalls(f.site, f.tripId, "dl17"), 0, "a 503 is not a missing route: no fallback was tried");
      assert.ok(!logs.some((line) => line.includes("site_invite.old_site_fallback")));
      await f.site.close();
      const refused = await f.create("dl17");
      assert.deepEqual(refused.json(), { error: "RUNTIME_NOT_READY" }, "connection refused");
      assert.deepEqual(await inviteRows(f.tripId), []);
    } finally { await f.app.close(); }
  });

  test("an OLD GATEWAY (the list route answered with the gateway's own JSON NOT_FOUND) is not a missing site route: RUNTIME_NOT_READY, no fallback", async () => {
    const f = await fixture();
    try {
      f.site.mode = "old_gateway";
      const r = await f.create("dl17");
      assert.equal(r.statusCode, 409);
      assert.deepEqual(r.json(), { error: "RUNTIME_NOT_READY" });
      assert.equal(existsCalls(f.site, f.tripId, "dl17"), 0, "no per-participant fallback");
      assert.ok(!logs.some((line) => line.includes("site_invite.old_site_fallback")));
      assert.deepEqual(await inviteRows(f.tripId), []);
    } finally { await f.stop(); }
  });

  test("the list's missing route, then the per-participant route itself failing (503): still RUNTIME_NOT_READY", async () => {
    const f = await fixture();
    try {
      const app = h.newApp({ runtimeAccounts: { listParticipants: (tripId: string) => f.site.adapter.listParticipants(tripId), participantExists: async () => { throw new Error("RUNTIME_PARTICIPANT_LOOKUP_FAILED"); } } as never });
      const session = await h.webSession(f.owner, "owner2");
      const r = await app.inject({ method: "POST", url: `/v1/trips/${f.tripId}/site-invites`, headers: { origin: ORIGIN, cookie: session.cookie, "x-csrf-token": session.csrf }, payload: { runtimeUsername: "dl17", displayName: "Dana Levi" } });
      assert.deepEqual(r.json(), { error: "RUNTIME_NOT_READY" });
      await app.close();
    } finally { await f.stop(); }
  });
});

describe("3. every other caller of the list fails SAFE on an old site (none falls back)", { skip }, () => {
  test("the Mini App claim offer: someone proven to be in the group gets today's retryable 503 and nothing is written", async () => {
    const f = await fixture();
    try {
      const chatId = await h.bindGroup(f.tripId);
      await h.bindPrivate(f.tripId, tg());
      await h.switchOn(f.tripId);
      const person = tg();
      await h.telegram.member(chatId, person, "member");
      const snapshot = await h.snapshot();
      const response = await launch(f.app, initDataFor(person, { tripId: f.tripId }));
      assert.equal(response.statusCode, 503, response.body);
      assert.deepEqual(response.json(), { error: "MEMBERSHIP_CHECK_UNAVAILABLE", retryable: true });
      assert.deepEqual(await h.snapshot(), snapshot);
      assert.equal(existsCalls(f.site, f.tripId, "dl17"), 0, "no per-participant fallback");
    } finally { await f.stop(); }
  });

  test("/invite: 'I can't reach the trip site', and no invite is made", async () => {
    const f = await fixture();
    try {
      const outcome = await handleInvite(h.pool, { runtimeAccounts: f.site.adapter, publicOrigin: ORIGIN },
        { chatId: "1", tripId: f.tripId, organizerUserId: f.owner, argument: "Dana Levi", language: "en" }, (line) => logs.push(line));
      assert.equal(outcome.kind, "replies");
      assert.match(outcome.kind === "replies" ? outcome.replies[0]!.text : "", /can't reach the trip site/);
      assert.deepEqual(await inviteRows(f.tripId), []);
      assert.equal(existsCalls(f.site, f.tripId, "dl17"), 0);
    } finally { await f.stop(); }
  });
});

describe("4. a release on an old-payload site is retried, never given up", { skip }, () => {
  test("the release route does not exist there (an HTML 404): five passes later the record is still pending, and says so", async () => {
    const f = await fixture();
    try {
      await h.pool.query("DELETE FROM control_plane.site_release_outbox");
      const user = await h.mkUser("Someone");
      await h.pool.query("INSERT INTO control_plane.site_release_outbox(trip_id, user_id, runtime_username, reason) VALUES ($1, $2, 'dl17', 'organizer_released')", [f.tripId, user]);
      for (let lap = 1; lap <= 5; lap += 1) await runSiteReleasePass({ db: h.pool, releaser: f.site.adapter, log: (line) => logs.push(line), now: () => new Date(Date.now() + lap * 3_600_000) });
      const [row] = (await h.pool.query("SELECT state, attempts, outcome FROM control_plane.site_release_outbox WHERE trip_id = $1", [f.tripId])).rows;
      assert.deepEqual(row, { state: "pending", attempts: 5, outcome: null });
      assert.equal(f.site.calls.filter((c) => c === `POST /internal/t/${f.tripId}/participants/release`).length, 5);
      assert.ok(!logs.some((line) => line.includes("site_release.given_up")));
      assert.ok(logs.some((line) => line.includes("site_release.backlog")), "and the backlog line says it is waiting");
    } finally { await f.stop(); }
  });
});
