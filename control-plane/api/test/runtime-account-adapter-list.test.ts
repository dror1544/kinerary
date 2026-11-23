import assert from "node:assert/strict";
import { createServer, type IncomingMessage, type Server } from "node:http";
import { after, before, test } from "node:test";
import { HttpRuntimeAccountAdapter } from "../src/portal.js";

// HttpRuntimeAccountAdapter.listParticipants: the control plane's side of GET /internal/t/:tripId/participants
// (slice S1 of docs/specs/sprint-9/x-member-sign-in.md). No database.

let server: Server;
let origin = "";
let reply: { status: number; body: string } = { status: 200, body: "{}" };
let seen: { url?: string; key?: string | string[] | undefined } = {};

before(async () => {
  server = createServer((request: IncomingMessage, response) => {
    seen = { url: request.url, key: request.headers["x-api-key"] };
    response.writeHead(reply.status, { "content-type": "application/json" });
    response.end(reply.body);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  origin = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
});
after(async () => { await new Promise((resolve) => server.close(resolve)); });

test("it asks the gateway's list route with the exchange key and returns the three fields", async () => {
  reply = { status: 200, body: JSON.stringify({ participants: [{ username: "dl17", displayName: "Dana", role: "member", telegram_id: "999" }] }) };
  const list = await new HttpRuntimeAccountAdapter(origin, "the-key").listParticipants("trip_abcdefgh");
  assert.deepEqual(list, [{ username: "dl17", displayName: "Dana", role: "member" }], "only the three fields, nothing else the site might add");
  assert.equal(seen.url, "/internal/t/trip_abcdefgh/participants");
  assert.equal(seen.key, "the-key");
});

test("entries that are not three strings are dropped, never offered and never a crash", async () => {
  reply = { status: 200, body: JSON.stringify({ participants: [null, 7, { username: "a1" }, { username: 5, displayName: "x", role: "member" }, { username: "ok1", displayName: "Okay", role: "member" }] }) };
  assert.deepEqual(await new HttpRuntimeAccountAdapter(origin, "k").listParticipants("trip_abcdefgh"), [{ username: "ok1", displayName: "Okay", role: "member" }]);
});

test("a failure, or an answer that is not a list, THROWS: an unreadable site is never an empty list", async () => {
  const adapter = new HttpRuntimeAccountAdapter(origin, "k");
  for (const answer of [{ status: 503, body: "{}" }, { status: 401, body: "{}" }, { status: 200, body: "{}" }, { status: 200, body: "null" }, { status: 200, body: JSON.stringify({ participants: "bob" }) }]) {
    reply = answer;
    await assert.rejects(adapter.listParticipants("trip_abcdefgh"), /RUNTIME_PARTICIPANT_LIST_FAILED/, JSON.stringify(answer));
  }
});
