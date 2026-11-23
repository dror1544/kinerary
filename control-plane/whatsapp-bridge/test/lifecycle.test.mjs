import assert from "node:assert/strict";
import { test } from "node:test";
import { createBridge, SUBSCRIBED_EVENTS } from "../src/core.js";
import { pair } from "../src/pairing.js";
import { DISCONNECT, makeFakeLib, makeTimers, startBridge, tempDir } from "./helpers.mjs";

const closeWith = (code) => ({ connection: "close", lastDisconnect: { error: { output: { statusCode: code } } } });

test("restart-required (515) reconnects after a second, with a fresh socket", async () => {
  const timers = makeTimers();
  const { bridge, fake, sock } = await startBridge({ timers });
  assert.equal(fake.sockets.length, 1);
  await sock.emit("connection.update", closeWith(DISCONNECT.restartRequired));
  assert.equal(bridge.state, "disconnected");
  assert.equal(await timers.fireNext(), 1000);
  assert.equal(fake.sockets.length, 2);
  await fake.sock.emit("connection.update", { connection: "open" });
  assert.equal(bridge.health().body.state, "connected");
});

test("other closes reconnect with a growing, capped backoff that resets when connected", async () => {
  const timers = makeTimers();
  const { bridge, fake, sock } = await startBridge({ timers });
  await sock.emit("connection.update", closeWith(DISCONNECT.connectionClosed));
  assert.equal(await timers.fireNext(), 3000);
  await fake.sock.emit("connection.update", closeWith(DISCONNECT.connectionClosed));
  assert.equal(await timers.fireNext(), 6000);
  for (let i = 0; i < 6; i += 1) {
    await fake.sock.emit("connection.update", closeWith(DISCONNECT.connectionClosed));
    await timers.fireNext();
  }
  await fake.sock.emit("connection.update", closeWith(DISCONNECT.connectionClosed));
  assert.equal(await timers.fireNext(), 48000);
  await fake.sock.emit("connection.update", { connection: "open" });
  await fake.sock.emit("connection.update", closeWith(DISCONNECT.connectionClosed));
  assert.equal(await timers.fireNext(), 3000);
  assert.equal(bridge.state, "connecting");
});

test("logged out: reported on /health, and the bridge does NOT try again", async () => {
  const timers = makeTimers();
  const { bridge, fake, sock, logs } = await startBridge({ timers });
  await sock.emit("connection.update", closeWith(DISCONNECT.loggedOut));
  assert.equal(bridge.health().body.state, "logged_out");
  assert.deepEqual(timers.pending, []);
  assert.equal(fake.sockets.length, 1);
  assert.ok(logs.some((l) => l.event === "logged_out"));
  const send = await bridge.send({ chatId: "100000000000001@lid", text: "x" });
  assert.equal(send.status, 503);
  assert.equal(send.body.state, "logged_out");
});

test("replaced by another session: reported, and no reconnect fight", async () => {
  const timers = makeTimers();
  const { bridge, fake, sock } = await startBridge({ timers });
  await sock.emit("connection.update", closeWith(DISCONNECT.connectionReplaced));
  assert.equal(bridge.health().body.state, "replaced");
  assert.deepEqual(timers.pending, []);
  assert.equal(fake.sockets.length, 1);
});

test("a reconnect that throws is retried, not fatal", async () => {
  const timers = makeTimers();
  const { bridge, fake, sock, logs } = await startBridge({ timers });
  let fail = true;
  const original = fake.lib.useMultiFileAuthState;
  fake.lib.useMultiFileAuthState = async (dir) => {
    if (fail) throw new Error("disk unavailable for 100000000000001@lid");
    return original(dir);
  };
  await sock.emit("connection.update", closeWith(DISCONNECT.restartRequired));
  await timers.fireNext();
  assert.ok(logs.some((l) => l.event === "reconnect_failed"));
  fail = false;
  await timers.fireNext();
  assert.equal(fake.sockets.length, 2);
  assert.ok(!JSON.stringify(logs).includes("100000000000001"));
  assert.equal(bridge.state, "connecting");
});

test("stop() ends the socket without logging out and cancels a pending reconnect", async () => {
  const timers = makeTimers();
  const { bridge, sock } = await startBridge({ timers });
  await sock.emit("connection.update", closeWith(DISCONNECT.connectionClosed));
  assert.equal(timers.pending.length, 1);
  bridge.stop();
  assert.deepEqual(timers.pending, []);
  const live = await startBridge({ timers });
  live.bridge.stop();
  assert.equal(live.sock.ended, true);
  assert.equal(typeof live.sock.logout, "undefined");
});

test("a late event from a replaced socket is ignored and cannot tear down its replacement", async () => {
  const timers = makeTimers();
  const { bridge, fake, sock: first } = await startBridge({ timers });
  await first.emit("connection.update", closeWith(DISCONNECT.restartRequired));
  await timers.fireNext();
  const second = fake.sock;
  assert.notEqual(second, first);
  await second.emit("connection.update", { connection: "open" });
  await first.emit("connection.update", closeWith(DISCONNECT.loggedOut));
  assert.equal(bridge.state, "connected");
  await first.emit("messages.upsert", { type: "notify", messages: [{ key: { remoteJid: "100000000000001@lid", id: "STALE", fromMe: false }, message: { conversation: "late" } }] });
  assert.deepEqual((await bridge.poll({ after: 0, waitMs: 0, epoch: "epoch-test" })).body.events, []);
});

test("the socket is built with history sync refused, and with a silent library logger", async () => {
  const { sock } = await startBridge();
  const options = sock.options;
  assert.equal(options.syncFullHistory, false);
  assert.equal(options.shouldSyncHistoryMessage({ syncType: "INITIAL_BOOTSTRAP" }), false);
  assert.equal(options.shouldSyncHistoryMessage({ syncType: "RECENT" }), false);
  assert.equal(options.markOnlineOnConnect, false);
  for (const level of ["trace", "debug", "info", "warn", "error"]) assert.equal(options.logger[level]("anything with 100000000000001@lid"), undefined);
  assert.equal(options.logger.child({}), options.logger);
});

test("the bridge subscribes to exactly its listed events and no others", async () => {
  const { sock } = await startBridge();
  assert.deepEqual(sock.subscribed, [...SUBSCRIBED_EVENTS].sort());
  for (const never of ["contacts.upsert", "contacts.update", "contacts.set", "chats.upsert", "chats.update", "messaging-history.set", "lid-mapping.update", "presence.update"]) {
    assert.ok(!sock.subscribed.includes(never), never);
  }
});

test("a handler that throws is logged by code and does not stop later events", async () => {
  const { bridge, sock, logs } = await startBridge();
  await sock.emit("messages.upsert", {
    type: "notify",
    messages: [
      { key: { remoteJid: "100000000000001@lid", id: "BOOM" }, get message() { throw new Error("explodes with 100000000000001@lid"); } },
      { key: { remoteJid: "100000000000001@lid", id: "OK", fromMe: false }, message: { conversation: "fine" }, pushName: "Alice Fixture" },
    ],
  });
  const batch = (await bridge.poll({ after: 0, waitMs: 0, epoch: "epoch-test" })).body.events;
  assert.deepEqual(batch.map((e) => e.messageId), ["OK"]);
  assert.ok(logs.some((l) => l.event === "extract_error"));
  assert.ok(!JSON.stringify(logs).includes("100000000000001"));
});

test("pairing: shows the QR, survives the one restart-required close, finishes when open", async () => {
  const fake = makeFakeLib();
  const qrs = [];
  const done = pair({ lib: fake.lib, sessionDir: tempDir(), onQr: (q) => qrs.push(q), log: () => {}, settleMs: 1 });
  await new Promise((r) => setImmediate(r));
  await fake.sock.emit("connection.update", { qr: "QR-FIXTURE-1" });
  await fake.sock.emit("connection.update", closeWith(DISCONNECT.restartRequired));
  await new Promise((r) => setImmediate(r));
  assert.equal(fake.sockets.length, 2);
  await fake.sock.emit("connection.update", { connection: "open" });
  await done;
  assert.deepEqual(qrs, ["QR-FIXTURE-1"]);
});

test("pairing: a close that is not restart-required fails it, and a successful run resolves", async () => {
  const fake = makeFakeLib();
  const failing = pair({ lib: fake.lib, sessionDir: tempDir(), onQr: () => {}, log: () => {} });
  await new Promise((r) => setImmediate(r));
  await fake.sock.emit("connection.update", closeWith(DISCONNECT.loggedOut));
  await assert.rejects(failing, /closed before pairing/);

  const ok = makeFakeLib();
  const paired = pair({ lib: ok.lib, sessionDir: tempDir(), onQr: () => {}, log: () => {}, settleMs: 1 });
  await new Promise((r) => setImmediate(r));
  await ok.sock.emit("connection.update", { connection: "open" });
  await paired;
});

test("createBridge never touches a real library: it only knows the object it is given", async () => {
  const fake = makeFakeLib();
  const bridge = createBridge({ lib: fake.lib, sessionDir: tempDir(), log: () => {} });
  assert.equal(bridge.state, "starting");
  assert.equal(bridge.health().body.state, "starting");
});
