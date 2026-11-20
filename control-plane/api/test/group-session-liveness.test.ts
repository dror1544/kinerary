/**
 * Group sign-in, rework 3 (owner's decisions of 2026-11-20): a session a group claim minted is only as good as the
 * person's seat in the group, at every point it is used and not only at the next Mini App launch; and switching the
 * feature off closes it too.
 *
 *   2a  POST /v1/trips/:id/launch   asks the group every time: out -> revoked (left_group); unknown -> no grant, retryable
 *   2b  /internal/runtime-sessions/check   asks at most once per 10 minutes per claim; out -> revoked; unknown -> LIVE,
 *       nothing revoked, asked again at the next check; NEVER a Telegram call for a session that is not a group session
 *   3   switch off / unwired -> no grant, not live, nothing revoked, no Telegram call; on again -> works again
 *   4   a site that cannot list -> the retryable 503; a failed COMMIT answers with no database text; a membership ended
 *       outside the portal routes is still refused by the liveness check and the exchange
 */
import assert from "node:assert/strict";
import { after, before, describe, test } from "node:test";
import { ORIGIN, asCookie, claim, cookieOf, initDataFor, launch, startHarness, tg, type Harness, type SitePerson } from "./support/group-sign-in-harness.js";
import { testDatabaseUrl } from "./support/test-database.js";

const skip = !testDatabaseUrl();
let h: Harness;
before(async () => { if (!skip) h = await startHarness(); });
after(async () => { if (!skip) await h.stop(); });

const PEOPLE: SitePerson[] = [{ username: "dl17", displayName: "Dana Levi", role: "member" }, { username: "nl23", displayName: "Noam Levi", role: "member" }];
type App = ReturnType<Harness["newApp"]>;

async function claimed() {
  const tripId = await h.mkTrip("Liveness trip");
  const owner = await h.mkUser("Owner"); await h.mkMember(tripId, owner, "owner");
  const chatId = await h.bindGroup(tripId); await h.switchOn(tripId);
  h.site.set(tripId, PEOPLE.map((p) => ({ ...p })));
  const ownerSession = await h.webSession(owner, "owner");
  const person = tg(); await h.telegram.member(chatId, person, "member");
  const app = h.newApp();
  const offer = (await launch(app, initDataFor(person, { tripId }))).json() as { travellers: { claimId: string; name: string }[] };
  const session = await claim(app, initDataFor(person, { tripId }), tripId, offer.travellers.find((t) => t.name === "Dana Levi")!.claimId);
  assert.equal(session.statusCode, 200, session.body);
  const row = (await h.pool.query("SELECT l.id AS link_id, l.user_id FROM control_plane.telegram_member_links l WHERE l.trip_id = $1", [tripId])).rows[0] as { link_id: string; user_id: string };
  const sessionId = (await h.pool.query("SELECT id FROM control_plane.web_sessions WHERE user_id = $1 AND revoked_at IS NULL", [row.user_id])).rows[0].id as string;
  h.siteCalls.release.length = 0;
  return { tripId, chatId, owner, ownerSession, person, app, session, ...row, sessionId };
}
const runtimeLaunch = (app: App, c: { tripId: string; session: { headers: Record<string, unknown> } }) =>
  app.inject({ method: "POST", url: `/v1/trips/${c.tripId}/launch`, headers: { origin: ORIGIN, cookie: asCookie(c.session), "x-csrf-token": cookieOf(c.session, "kit_csrf")! } });
const check = (app: App, c: { tripId: string; user_id: string; sessionId: string }) =>
  app.inject({ method: "POST", url: "/internal/runtime-sessions/check", headers: { "x-api-key": "exchange-key", "content-type": "application/json" }, payload: JSON.stringify({ tripId: c.tripId, userId: c.user_id, sessionId: c.sessionId, role: "member" }) });
const age = (tripId: string, minutes: number) => h.pool.query("UPDATE control_plane.trip_participant_claims SET last_group_check_at = now() - ($2 || ' minutes')::interval WHERE trip_id = $1 AND released_at IS NULL", [tripId, String(minutes)]);
const claimState = async (tripId: string) => (await h.pool.query("SELECT released_reason, telegram_user_id, last_group_check_at FROM control_plane.trip_participant_claims WHERE trip_id = $1 ORDER BY created_at DESC LIMIT 1", [tripId])).rows[0] as { released_reason: string | null; telegram_user_id: string | null; last_group_check_at: Date | null };
const linkReason = async (linkId: string) => (await h.pool.query("SELECT revoked_reason FROM control_plane.telegram_member_links WHERE id = $1", [linkId])).rows[0].revoked_reason as string | null;
const grants = async (tripId: string) => Number((await h.pool.query("SELECT count(*)::int AS n FROM control_plane.runtime_launch_grants WHERE trip_id = $1", [tripId])).rows[0].n);

describe("2a: asking for a runtime grant asks the group, every time", { skip }, () => {
  test("still in the group: a grant, and exactly one Telegram question", async () => {
    const c = await claimed();
    try {
      const before = await h.telegram.calls("getChatMember");
      const r = await runtimeLaunch(c.app, c);
      assert.equal(r.statusCode, 200, r.body);
      assert.equal(await h.telegram.calls("getChatMember") - before, 1);
    } finally { await c.app.close(); }
  });

  test("kicked: no grant, 401 like any revoked session, link and claim revoked (left_group), sessions ended, site binding released", async () => {
    const c = await claimed();
    try {
      await h.telegram.member(c.chatId, c.person, "kicked");
      const grantsBefore = await grants(c.tripId);
      const r = await runtimeLaunch(c.app, c);
      assert.equal(r.statusCode, 401);
      assert.deepEqual(r.json(), { error: "AUTHENTICATION_REQUIRED" });
      assert.equal(await grants(c.tripId), grantsBefore, "no grant was minted");
      assert.equal(await linkReason(c.link_id), "left_group");
      const state = await claimState(c.tripId);
      assert.equal(state.released_reason, "left_group");
      assert.equal(state.telegram_user_id, null, "a released claim keeps no Telegram id");
      assert.equal((await c.app.inject({ method: "GET", url: "/v1/me", headers: { cookie: asCookie(c.session) } })).statusCode, 401);
      assert.deepEqual(h.siteCalls.release.map((x) => x.runtimeUsername), ["dl17"]);
    } finally { await c.app.close(); }
  });

  test("Telegram unreachable: no grant, a retryable 503, nothing revoked; back in the group it works again", async () => {
    const c = await claimed();
    try {
      for (const mode of ["error", "timeout"] as const) {
        await h.telegram.member(c.chatId, c.person, "member", { mode });
        const grantsBefore = await grants(c.tripId);
        const r = await runtimeLaunch(c.app, c);
        assert.equal(r.statusCode, 503, mode);
        assert.deepEqual(r.json(), { error: "MEMBERSHIP_CHECK_UNAVAILABLE", retryable: true });
        assert.equal(await grants(c.tripId), grantsBefore);
        assert.equal(await linkReason(c.link_id), null);
        assert.equal((await claimState(c.tripId)).released_reason, null);
      }
      await h.telegram.member(c.chatId, c.person, "member");
      assert.equal((await runtimeLaunch(c.app, c)).statusCode, 200);
    } finally { await c.app.close(); }
  });
});

describe("2b: the gateway's liveness check asks again at most once per 10 minutes, and only for group sessions", { skip }, () => {
  test("inside the window no Telegram call; past it ONE call, then none again", async () => {
    const c = await claimed();
    try {
      const calls = () => h.telegram.calls("getChatMember");
      const start = await calls();
      assert.equal((await check(c.app, c)).statusCode, 200);
      assert.equal(await calls(), start, "the claim itself was the last check: nothing to ask yet");
      await age(c.tripId, 11);
      assert.equal((await check(c.app, c)).statusCode, 200);
      assert.equal(await calls(), start + 1, "past the window: one question");
      assert.equal((await check(c.app, c)).statusCode, 200);
      assert.equal(await calls(), start + 1, "and not again inside the next 10 minutes");
    } finally { await c.app.close(); }
  });

  test("out of the group: revoked at the check (left_group), answered like a revoked session, site binding released", async () => {
    const c = await claimed();
    try {
      await h.telegram.member(c.chatId, c.person, "left");
      assert.equal((await check(c.app, c)).statusCode, 200, "inside the window the answer is still the last one: live");
      await age(c.tripId, 11);
      const r = await check(c.app, c);
      assert.equal(r.statusCode, 401);
      assert.deepEqual(r.json(), { error: "SESSION_REVOKED" });
      assert.equal(await linkReason(c.link_id), "left_group");
      assert.equal((await claimState(c.tripId)).released_reason, "left_group");
      assert.deepEqual(h.siteCalls.release.map((x) => x.runtimeUsername), ["dl17"]);
    } finally { await c.app.close(); }
  });

  test("Telegram down: still LIVE, nothing revoked, the time is not advanced, and the next check asks again", async () => {
    const c = await claimed();
    try {
      await age(c.tripId, 11);
      const stamp = (await claimState(c.tripId)).last_group_check_at!.getTime();
      await h.telegram.member(c.chatId, c.person, "member", { mode: "error" });
      const start = await h.telegram.calls("getChatMember");
      assert.equal((await check(c.app, c)).statusCode, 200);
      assert.equal((await check(c.app, c)).statusCode, 200);
      assert.equal(await h.telegram.calls("getChatMember"), start + 2, "asked at each check while Telegram is down");
      assert.equal(await linkReason(c.link_id), null);
      assert.equal((await claimState(c.tripId)).last_group_check_at!.getTime(), stamp);
      await h.telegram.member(c.chatId, c.person, "member");
      assert.equal((await check(c.app, c)).statusCode, 200);
      assert.ok((await claimState(c.tripId)).last_group_check_at!.getTime() > stamp, "a good answer advances it");
    } finally { await c.app.close(); }
  });

  test("a session that is NOT a group session never costs a Telegram call, whatever its age", async () => {
    const c = await claimed();
    try {
      const ownerCheck = () => c.app.inject({ method: "POST", url: "/internal/runtime-sessions/check", headers: { "x-api-key": "exchange-key", "content-type": "application/json" }, payload: JSON.stringify({ tripId: c.tripId, userId: c.owner, sessionId: null, role: "owner" }) });
      await age(c.tripId, 120);
      const start = await h.telegram.calls("getChatMember");
      assert.equal((await ownerCheck()).statusCode, 200);
      const ownerLaunch = await c.app.inject({ method: "POST", url: `/v1/trips/${c.tripId}/launch`, headers: { origin: ORIGIN, cookie: c.ownerSession.cookie, "x-csrf-token": c.ownerSession.csrf } });
      assert.equal(ownerLaunch.statusCode, 200);
      assert.equal(await h.telegram.calls("getChatMember"), start, "an owner's full session: no Telegram call, ever");
    } finally { await c.app.close(); }
  });
});

describe("3: switching the feature off closes existing access, and on again reopens it", { skip }, () => {
  test("off or unwired: no grant (404), not live (401), nothing revoked, no Telegram call; on again: both work", async () => {
    const c = await claimed();
    try {
      await age(c.tripId, 120);
      await h.switchOn(c.tripId, false);
      const start = await h.telegram.calls("getChatMember");
      const grantsBefore = await grants(c.tripId);
      const refused = await runtimeLaunch(c.app, c);
      assert.equal(refused.statusCode, 404); assert.deepEqual(refused.json(), { error: "NOT_FOUND" });
      const dead = await check(c.app, c);
      assert.equal(dead.statusCode, 401); assert.deepEqual(dead.json(), { error: "SESSION_REVOKED" });
      assert.equal(await grants(c.tripId), grantsBefore);
      assert.equal(await h.telegram.calls("getChatMember"), start);
      assert.equal(await linkReason(c.link_id), null, "dormant, not revoked");
      assert.equal((await claimState(c.tripId)).released_reason, null);
      // a deployment with no group wiring at all is the same
      const unwired = h.newApp({ memberGroupSignIn: undefined });
      try { await h.switchOn(c.tripId, true); assert.equal((await check(unwired, c)).statusCode, 401); } finally { await unwired.close(); }
      assert.equal(await h.telegram.calls("getChatMember"), start);
      // back on
      assert.equal((await runtimeLaunch(c.app, c)).statusCode, 200);
      assert.equal((await check(c.app, c)).statusCode, 200);
    } finally { await c.app.close(); }
  });
});

describe("4: small items", { skip }, () => {
  test("(a) a site that cannot list its participants at claim time is the retryable 503, not a 404", async () => {
    const tripId = await h.mkTrip("List trip"); const owner = await h.mkUser("Owner"); await h.mkMember(tripId, owner, "owner");
    const chatId = await h.bindGroup(tripId); await h.switchOn(tripId); h.site.set(tripId, PEOPLE.map((p) => ({ ...p })));
    const person = tg(); await h.telegram.member(chatId, person, "member"); const app = h.newApp();
    try {
      const offer = (await launch(app, initDataFor(person, { tripId }))).json() as { travellers: { claimId: string; name: string }[] };
      h.site.set(tripId, "unreachable");
      const snapshot = await h.snapshot();
      const r = await claim(app, initDataFor(person, { tripId }), tripId, offer.travellers[0]!.claimId);
      assert.equal(r.statusCode, 503);
      assert.deepEqual(r.json(), { error: "MEMBERSHIP_CHECK_UNAVAILABLE", retryable: true });
      assert.deepEqual(await h.snapshot(), snapshot);
    } finally { await app.close(); }
  });

  test("(b) a COMMIT that fails answers 500 with no database text, undoes the site binding, and writes nothing", async () => {
    const tripId = await h.mkTrip("Commit trip"); const owner = await h.mkUser("Owner"); await h.mkMember(tripId, owner, "owner");
    const chatId = await h.bindGroup(tripId); await h.switchOn(tripId); h.site.set(tripId, PEOPLE.map((p) => ({ ...p })));
    const person = tg(); await h.telegram.member(chatId, person, "member");
    const plain = h.newApp();
    const failing = new Proxy(h.pool, {
      get(target, prop, receiver) {
        if (prop === "connect") {
          return async () => {
            const client = await target.connect();
            const original = { query: client.query, release: client.release };
            const query = client.query.bind(client) as (...a: unknown[]) => unknown;
            (client as unknown as { query: unknown }).query = (sql: unknown, ...rest: unknown[]) =>
              sql === "COMMIT" ? Promise.reject(Object.assign(new Error('duplicate key value violates unique constraint "secret_internal_name"'), { code: "XX000" })) : query(sql, ...rest);
            (client as unknown as { release: unknown }).release = (...args: unknown[]) => { Object.assign(client, original); return (original.release as (...a: unknown[]) => void).apply(client, args); };
            return client;
          };
        }
        const value = Reflect.get(target, prop, receiver);
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
    const app = h.newApp({ db: failing });
    try {
      const offer = (await launch(plain, initDataFor(person, { tripId }))).json() as { travellers: { claimId: string; name: string }[] };
      const snapshot = await h.snapshot();
      h.siteCalls.release.length = 0;
      const r = await claim(app, initDataFor(person, { tripId }), tripId, offer.travellers[0]!.claimId);
      assert.equal(r.statusCode, 500);
      assert.equal(r.body, '{"error":"INTERNAL_ERROR"}');
      assert.ok(!r.body.includes("secret_internal_name") && !r.body.includes("duplicate"));
      assert.ok(!h.logs.join("\n").includes("secret_internal_name"), "and not in the log either");
      assert.deepEqual(await h.snapshot(), snapshot);
      assert.equal(h.siteCalls.release.length, 1, "the site binding made before the commit was undone");
      assert.equal(h.siteBindings.size >= 0, true);
    } finally { await app.close(); await plain.close(); }
  });

  test("(c) a membership ended OUTSIDE the portal routes (SQL, the trigger path): the liveness check, the grant and the exchange all refuse that account; the site binding is carry-forward", async () => {
    const c = await claimed();
    try {
      const launched = await runtimeLaunch(c.app, c);
      assert.equal(launched.statusCode, 200);
      await h.pool.query("UPDATE control_plane.trip_memberships SET status = 'revoked' WHERE trip_id = $1 AND user_id = $2", [c.tripId, c.user_id]);
      const dead = await check(c.app, c);
      assert.equal(dead.statusCode, 401); assert.deepEqual(dead.json(), { error: "SESSION_REVOKED" });
      const consume = await c.app.inject({ method: "POST", url: "/internal/runtime-launch/consume", headers: { "x-api-key": "exchange-key", "content-type": "application/json" }, payload: JSON.stringify({ token: launched.json().launchToken }) });
      assert.equal(consume.statusCode, 401); assert.deepEqual(consume.json(), { error: "LAUNCH_INVALID" });
      assert.equal((await runtimeLaunch(c.app, c)).statusCode, 401, "the session itself ended with the membership");
      assert.equal((await claimState(c.tripId)).released_reason, "membership_ended");
      assert.equal(h.siteBindings.get(`${c.tripId}:dl17`), c.user_id, "(the binding on the site is still there: no reconciler, by decision)");
    } finally { await c.app.close(); }
  });
});
