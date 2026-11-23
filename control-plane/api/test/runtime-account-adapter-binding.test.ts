import assert from "node:assert/strict";
import { createServer } from "node:http";
import { test } from "node:test";
import { HttpRuntimeAccountAdapter } from "../src/portal.js";

// HttpRuntimeAccountAdapter.adoptParticipant / releaseParticipant: the claim's site binding, and the time limit on every
// call made while a person's launch is open (docs/specs/sprint-9/x-member-sign-in.md, slice S1, rework 1). No database.

test("adopt and release POST the gateway's binding routes with the exchange key and exactly {tripId, userId, runtimeUsername}", async () => {
  let reply = { status: 200, body: '{"ok":true}' };
  let seen: { method?: string; url?: string; key?: string | string[] | undefined; body: string } = { body: "" };
  const recorder = createServer((request, response) => {
    const chunks: Buffer[] = [];
    request.on("data", (c) => chunks.push(c));
    request.on("end", () => {
      seen = { method: request.method, url: request.url, key: request.headers["x-api-key"], body: Buffer.concat(chunks).toString() };
      response.writeHead(reply.status, { "content-type": "application/json" });
      response.end(reply.body);
    });
  });
  await new Promise<void>((resolve) => recorder.listen(0, "127.0.0.1", resolve));
  const base = `http://127.0.0.1:${(recorder.address() as { port: number }).port}`;
  try {
    const adapter = new HttpRuntimeAccountAdapter(base, "the-key");
    const input = { tripId: "trip_abcdefgh", userId: "user_abcdefgh", runtimeUsername: "bob", extra: "never sent" } as { tripId: string; userId: string; runtimeUsername: string };
    assert.equal(await adapter.adoptParticipant(input), "ok");
    assert.equal(seen.method, "POST");
    assert.equal(seen.url, "/internal/t/trip_abcdefgh/participants/adopt");
    assert.equal(seen.key, "the-key");
    assert.deepEqual(JSON.parse(seen.body), { tripId: "trip_abcdefgh", userId: "user_abcdefgh", runtimeUsername: "bob" });
    for (const [status, answer] of [[404, "refused"], [403, "refused"], [409, "conflict"]] as const) {
      reply = { status, body: "{}" };
      assert.equal(await adapter.adoptParticipant(input), answer, String(status));
    }
    for (const status of [400, 401, 500, 503]) {
      reply = { status, body: "{}" };
      await assert.rejects(adapter.adoptParticipant(input), /RUNTIME_PARTICIPANT_ADOPT_FAILED/, `${status} is "could not ask", never an answer`);
    }
    reply = { status: 200, body: '{"ok":true,"released":true}' };
    await adapter.releaseParticipant(input);
    assert.equal(seen.url, "/internal/t/trip_abcdefgh/participants/release");
    assert.deepEqual(JSON.parse(seen.body), { tripId: "trip_abcdefgh", userId: "user_abcdefgh", runtimeUsername: "bob" });
    reply = { status: 502, body: "{}" };
    await assert.rejects(adapter.releaseParticipant(input), /RUNTIME_PARTICIPANT_RELEASE_FAILED/);
  } finally { await new Promise((resolve) => recorder.close(resolve)); }
});

test("a trip site that never answers is given up on: the list, adopt and release all time out instead of hanging a launch", async () => {
  const hung = createServer(() => { /* never answers */ });
  await new Promise<void>((resolve) => hung.listen(0, "127.0.0.1", resolve));
  const base = `http://127.0.0.1:${(hung.address() as { port: number }).port}`;
  try {
    const adapter = new HttpRuntimeAccountAdapter(base, "k", 250);
    const input = { tripId: "trip_abcdefgh", userId: "user_abcdefgh", runtimeUsername: "bob" };
    const started = Date.now();
    await assert.rejects(adapter.listParticipants("trip_abcdefgh"));
    await assert.rejects(adapter.adoptParticipant(input));
    await assert.rejects(adapter.releaseParticipant(input));
    assert.ok(Date.now() - started < 3000, "three timeouts of 250ms");
  } finally { hung.closeAllConnections(); await new Promise((resolve) => hung.close(resolve)); }
});
