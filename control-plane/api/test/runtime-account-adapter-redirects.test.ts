/**
 * HttpRuntimeAccountAdapter never follows a redirect (docs/specs/sprint-9/x-member-sign-in.md, amendment A28).
 *
 * Every call carries the control-plane key in `x-api-key`. Node's fetch follows redirects by default and drops only
 * `authorization` and `cookie` across origins, so a gateway origin that answered 302/307 to another origin made the adapter send
 * that key there, and BELIEVE the answer (adopt "ok", provision success, exists true, list [], release success: the durable
 * release record then went `done` while the trip site still held the removed person's binding). Here the adapter is the real one,
 * the gateway is a local HTTP server that redirects, and the "other origin" is a second server that counts every request it gets:
 * the assertion is ZERO requests, not merely "no key". No database.
 *
 * Node 20 (CI) and 22 (local) both return the 3xx itself for `redirect: "manual"`; the adapter checks the status range and never
 * relies on `response.type`, which is where the two differ for a browser-style opaque redirect.
 */
import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import { test } from "node:test";
import { HttpRuntimeAccountAdapter, RuntimeRedirectRefusedError, SiteRouteMissingError } from "../src/portal.js";
import { SiteReleaseError } from "../src/site-release-outbox.js";

interface Seen { method: string | undefined; url: string | undefined; key: string | string[] | undefined }
async function listen(handler: Parameters<typeof createServer>[1]): Promise<{ server: Server; base: string; seen: Seen[] }> {
  const seen: Seen[] = [];
  const server = createServer((request, response) => {
    seen.push({ method: request.method, url: request.url, key: request.headers["x-api-key"] });
    request.resume();
    handler!(request, response);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  return { server, base: `http://127.0.0.1:${(server.address() as { port: number }).port}`, seen };
}
const close = (server: Server) => new Promise((resolve) => { server.closeAllConnections(); server.close(resolve); });

const TRIP = "trip_abcdefgh";
const input = { tripId: TRIP, userId: "user_abcdefgh", runtimeUsername: "bob" };
const SUCCESS_LOOKING = JSON.stringify({ ok: true, released: true, participants: [] });

type Call = "listParticipants" | "participantExists" | "provisionParticipant" | "adoptParticipant" | "releaseParticipant";
const CALLS: Call[] = ["listParticipants", "participantExists", "provisionParticipant", "adoptParticipant", "releaseParticipant"];
function run(adapter: HttpRuntimeAccountAdapter, call: Call): Promise<unknown> {
  switch (call) {
    case "listParticipants": return adapter.listParticipants(TRIP);
    case "participantExists": return adapter.participantExists(input);
    case "provisionParticipant": return adapter.provisionParticipant({ ...input, inviteId: "invite_abcdefgh", displayName: "Bob" });
    case "adoptParticipant": return adapter.adoptParticipant(input);
    case "releaseParticipant": return adapter.releaseParticipant(input);
  }
}

for (const status of [302, 307]) {
  for (const where of ["cross-origin", "same-origin"] as const) {
    test(`a gateway answering ${status} to a ${where} Location: all five calls fail closed, the key goes nowhere, and the target gets no request at all`, async () => {
      // The place the Location points at answers what a believing adapter would have taken for the gateway's own answer.
      const target = await listen((_req, res) => { res.writeHead(200, { "content-type": "application/json" }); res.end(SUCCESS_LOOKING); });
      const gateway = await listen((req, res) => {
        const location = where === "cross-origin" ? `${target.base}${req.url}` : "/somewhere-else";
        res.writeHead(status, { location });
        res.end();
      });
      try {
        const adapter = new HttpRuntimeAccountAdapter(gateway.base, "control-plane-key");
        const log: string[] = [];
        for (const call of CALLS) {
          const before = gateway.seen.length;
          let outcome: unknown = "resolved";
          try { outcome = await run(adapter, call); } catch (error) { outcome = error; }
          assert.ok(outcome instanceof Error, `${call}: must reject on a ${status}, got ${JSON.stringify(outcome)}`);
          if (call === "releaseParticipant") {
            // Retryable by the outbox's own rule: a SiteReleaseError that is not the site's OWN refusal (400 INVALID_REQUEST, 403 TRIP_MISMATCH).
            assert.ok(outcome instanceof SiteReleaseError, "release throws the retryable SiteReleaseError");
            assert.equal(outcome.code, null);
            assert.ok(outcome.status === null || (outcome.status >= 300 && outcome.status < 400), `the status says redirect, never a refusal: ${outcome.status}`);
          } else if (call === "listParticipants") {
            assert.ok(!(outcome instanceof SiteRouteMissingError), "list: an ordinary failure, not the 'route missing' class that falls back to the per-name lookup");
            assert.ok(outcome instanceof RuntimeRedirectRefusedError);
          }
          assert.equal(gateway.seen.length - before, 1, `${call}: exactly the one request to the gateway, no second hop`);
          log.push(`${call} -> ${status} ${where}: rejected ${outcome.name}:${outcome.message}; gateway saw ${gateway.seen.at(-1)!.method} ${gateway.seen.at(-1)!.url}; target hits ${target.seen.length}`);
        }
        assert.equal(target.seen.length, 0, `the redirect target received ${target.seen.length} request(s); log: ${JSON.stringify(target.seen)}`);
        if (process.env.REDIRECT_EVIDENCE) console.log(log.join("\n"));
      } finally { await close(gateway.server); await close(target.server); }
    });
  }
}

test("an ordinary answer still works: the wrapper changes redirects and nothing else", async () => {
  const gateway = await listen((req, res) => {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(req.method === "GET" && req.url?.endsWith("/participants") ? JSON.stringify({ participants: [{ username: "bob", displayName: "Bob", role: "member" }] }) : JSON.stringify({ ok: true, released: true }));
  });
  try {
    const adapter = new HttpRuntimeAccountAdapter(gateway.base, "control-plane-key");
    assert.deepEqual(await adapter.listParticipants(TRIP), [{ username: "bob", displayName: "Bob", role: "member" }]);
    assert.equal(await adapter.participantExists(input), true);
    assert.equal(await adapter.adoptParticipant(input), "ok");
    await adapter.provisionParticipant({ ...input, inviteId: "invite_abcdefgh", displayName: "Bob" });
    await adapter.releaseParticipant(input);
    assert.ok(gateway.seen.every((s) => s.key === "control-plane-key"));
  } finally { await close(gateway.server); }
});
