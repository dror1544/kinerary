/**
 * A redirecting gateway, through the callers that matter (docs/specs/sprint-9/x-member-sign-in.md, amendment A28).
 *
 * runtime-account-adapter-redirects.test.ts shows the adapter never follows a redirect. This file shows what each caller then does
 * with the refusal, against the real Postgres, the real routes and the REAL `HttpRuntimeAccountAdapter` pointed at a gateway
 * stand-in that answers 302/307 to a second server that counts every request it gets (the assertion is zero, not "no key"):
 *
 *   - a group claim's adopt     -> nothing written, the retryable 503, the next try (a sound gateway) works;
 *   - an invite redemption's provision -> the invite stays unused, no account, the retryable 503;
 *   - a durable release         -> the outbox row stays `pending`, attempts counted, retried by the pass, and `done` only when
 *                                  a sound gateway answers. It is never `done` on a redirect and never given up.
 *
 * The rest of the site (the participant list a claim offers, the invite's own creation) is the harness's fake: only the call
 * under test goes to the redirecting stand-in.
 */
import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import { after, before, beforeEach, describe, test } from "node:test";
import { HttpRuntimeAccountAdapter, createSiteInvite } from "../src/portal.js";
import { attemptSiteRelease, runSiteReleasePass } from "../src/site-release-outbox.js";
import { endClaimLeftGroup } from "../src/sign-in-link.js";
import { claim, initDataFor, launch, startHarness, tg, type Harness, type SitePerson } from "./support/group-sign-in-harness.js";
import { testDatabaseUrl } from "./support/test-database.js";

const skip = !testDatabaseUrl();
let h: Harness;
before(async () => { if (!skip) h = await startHarness(); });
after(async () => { if (!skip) await h.stop(); });
beforeEach(async () => { if (!skip) await h.pool.query("DELETE FROM control_plane.site_release_outbox"); });

const PEOPLE: SitePerson[] = [{ username: "dl17", displayName: "Dana Levi", role: "member" }, { username: "nl23", displayName: "Noam Levi", role: "member" }];

interface Stand { server: Server; base: string; seen: Array<{ method?: string | undefined; url?: string | undefined; key?: string | string[] | undefined }> }
async function listen(handler: (request: import("node:http").IncomingMessage, response: import("node:http").ServerResponse) => void): Promise<Stand> {
  const seen: Stand["seen"] = [];
  const server = createServer((request, response) => { seen.push({ method: request.method, url: request.url, key: request.headers["x-api-key"] }); request.resume(); handler(request, response); });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  return { server, base: `http://127.0.0.1:${(server.address() as { port: number }).port}`, seen };
}
const stop = (stand: Stand) => new Promise((resolve) => { stand.server.closeAllConnections(); stand.server.close(resolve); });

/** A gateway that redirects every call (302 or 307, to the other origin) and a target that would answer "ok" to anything. `sound()` turns it into an honest gateway. */
async function redirecting(status: 302 | 307) {
  const target = await listen((_req, res) => { res.writeHead(200, { "content-type": "application/json" }); res.end(JSON.stringify({ ok: true, released: true })); });
  let honest = false;
  const gateway = await listen((req, res) => {
    if (honest) { res.writeHead(200, { "content-type": "application/json" }); res.end(JSON.stringify({ ok: true, released: true })); return; }
    res.writeHead(status, { location: `${target.base}${req.url}` });
    res.end();
  });
  return { target, gateway, adapter: new HttpRuntimeAccountAdapter(gateway.base, "exchange-key"), sound: () => { honest = true; }, close: async () => { await stop(gateway); await stop(target); } };
}

async function trip() {
  const tripId = await h.mkTrip("Redirect trip");
  const owner = await h.mkUser("Owner");
  await h.mkMember(tripId, owner, "owner");
  const chatId = await h.bindGroup(tripId);
  await h.bindPrivate(tripId, tg());
  await h.switchOn(tripId);
  h.site.set(tripId, PEOPLE.map((p) => ({ ...p })));
  return { tripId, owner, chatId };
}
const outboxRows = async (tripId: string) => (await h.pool.query("SELECT state, attempts, outcome FROM control_plane.site_release_outbox WHERE trip_id = $1", [tripId])).rows as { state: string; attempts: number; outcome: string | null }[];

for (const status of [302, 307] as const) {
  describe(`a gateway answering ${status} to another origin`, { skip }, () => {
    test("adopt during a claim: nothing is written, the answer is the retryable 503, and the target is never asked",async () => {
      const { tripId, chatId } = await trip();
      const r = await redirecting(status);
      const person = tg();
      const app = h.newApp({ runtimeAccounts: { ...h.deps().runtimeAccounts, adoptParticipant: (input) => r.adapter.adoptParticipant(input) } });
      try {
        await h.telegram.member(chatId, person, "member");
        const offered = (await launch(app, initDataFor(person, { tripId }))).json() as { travellers: { claimId: string; name: string }[] };
        const claimId = offered.travellers.find((t) => t.name === "Dana Levi")!.claimId;
        const snapshot = await h.snapshot();
        const response = await claim(app, initDataFor(person, { tripId }), tripId, claimId);
        assert.equal(response.statusCode, 503, response.body);
        assert.deepEqual(response.json(), { error: "MEMBERSHIP_CHECK_UNAVAILABLE", retryable: true });
        assert.deepEqual(await h.snapshot(), snapshot, "nothing at all was written");
        assert.equal(r.gateway.seen.length, 1, "the gateway was asked once");
        assert.equal(r.target.seen.length, 0, `the redirect target got ${JSON.stringify(r.target.seen)}`);
        if (process.env.REDIRECT_EVIDENCE) console.log(`adopt ${status}: ${response.statusCode} ${response.body}; gateway ${JSON.stringify(r.gateway.seen)}; target hits ${r.target.seen.length}`);
      } finally { await app.close(); await r.close(); }
    });

    test("provision during an invite redemption: the invite stays unused, no account, the retryable 503, and the target is never asked", async () => {
      const t = await trip();
      const r = await redirecting(status);
      const made = await createSiteInvite(h.deps(), { tripId: t.tripId, actorUserId: t.owner, runtimeUsername: "dl17", replacePending: false });
      assert.ok(made.ok, JSON.stringify(made));
      const app = h.newApp({ runtimeAccounts: { ...h.deps().runtimeAccounts, provisionParticipant: (input) => r.adapter.provisionParticipant(input) } });
      try {
        const snapshot = await h.snapshot();
        const redeemed = await app.inject({ method: "POST", url: "/v1/site-invites/redeem", payload: { token: new URL((made as { joinUrl: string }).joinUrl).hash.slice("#token=".length), method: "password", password: "a-long-enough-secret" } });
        assert.equal(redeemed.statusCode, 503, redeemed.body);
        assert.deepEqual(redeemed.json(), { error: "RUNTIME_NOT_READY", retryable: true });
        assert.equal(redeemed.headers["retry-after"], "5");
        assert.deepEqual(await h.snapshot(), snapshot, "no account, no membership, no session");
        assert.equal((await h.pool.query("SELECT state FROM control_plane.site_invites WHERE id = $1", [(made as { id: string }).id])).rows[0].state, "unused");
        assert.equal(r.gateway.seen.length, 1);
        assert.equal(r.target.seen.length, 0, `the redirect target got ${JSON.stringify(r.target.seen)}`);
        if (process.env.REDIRECT_EVIDENCE) console.log(`provision ${status}: ${redeemed.statusCode} ${redeemed.body}; gateway ${JSON.stringify(r.gateway.seen)}; target hits ${r.target.seen.length}`);
      } finally { await app.close(); await r.close(); }
    });

    test("a durable release: the row stays pending with attempts counted and is retried; it is done only when a sound gateway answers; the target is never asked", async () => {
      const t = await trip();
      const r = await redirecting(status);
      const log: string[] = [];
      const app = h.newApp();
      try {
        const person = tg();
        await h.telegram.member(t.chatId, person, "member");
        const offered = (await launch(app, initDataFor(person, { tripId: t.tripId }))).json() as { travellers: { claimId: string; name: string }[] };
        const claimed = await claim(app, initDataFor(person, { tripId: t.tripId }), t.tripId, offered.travellers.find((x) => x.name === "Dana Levi")!.claimId);
        assert.equal(claimed.statusCode, 200, claimed.body);
        const userId = (await h.pool.query("SELECT user_id FROM control_plane.trip_participant_claims WHERE trip_id = $1 AND released_at IS NULL", [t.tripId])).rows[0].user_id as string;
        // The claim ends (the database writes the record in the same transaction), and the prompt attempt goes to the redirecting gateway.
        await endClaimLeftGroup(h.pool, userId, t.tripId);
        assert.deepEqual(await outboxRows(t.tripId), [{ state: "pending", attempts: 0, outcome: null }]);
        const options = { db: h.pool, releaser: r.adapter, log: (line: string) => log.push(line) };
        await attemptSiteRelease(options, { tripId: t.tripId, userId, runtimeUsername: "dl17" });
        assert.deepEqual(await outboxRows(t.tripId), [{ state: "pending", attempts: 1, outcome: null }], "a redirect is not success");
        // The background pass retries, again and again, never giving up on it (the give-up is for the site's own 400/403 only).
        for (let lap = 1; lap <= 5; lap += 1) {
          await runSiteReleasePass({ ...options, now: () => new Date(Date.now() + lap * 3_600_000) });
          assert.deepEqual(await outboxRows(t.tripId), [{ state: "pending", attempts: 1 + lap, outcome: null }], `lap ${lap}: still pending, attempts counted`);
        }
        assert.equal(r.gateway.seen.length, 6, "one prompt attempt and five retries all reached the gateway");
        assert.equal(r.target.seen.length, 0, `the redirect target got ${JSON.stringify(r.target.seen)}`);
        if (process.env.REDIRECT_EVIDENCE) console.log(`release ${status}: row ${JSON.stringify(await outboxRows(t.tripId))}; gateway hits ${r.gateway.seen.length}; target hits ${r.target.seen.length}`);
        // The gateway is sound again: the next pass lands it.
        r.sound();
        await runSiteReleasePass({ ...options, now: () => new Date(Date.now() + 6 * 3_600_000) });
        assert.deepEqual(await outboxRows(t.tripId), [{ state: "done", attempts: 7, outcome: "released" }]);
        assert.equal(r.target.seen.length, 0);
      } finally { await app.close(); await r.close(); }
    });
  });
}
