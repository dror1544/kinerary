import assert from "node:assert/strict";
import { request } from "node:http";
import { test } from "node:test";
import { createBridgeServer, LOOPBACK_HOST } from "../src/http.js";
import {
  ALICE,
  BOB,
  CAROL,
  NEW_GROUP,
  OLD_GROUP,
  OWN,
  SECRET,
  group,
  groupText,
  privateText,
  readJson,
  serve,
  startBridge,
  upsertOf,
} from "./helpers.mjs";

const enc = encodeURIComponent;

/** A request whose path is sent exactly as written: `fetch` would collapse `..` before it left the process. */
function rawGet(base, rawPath) {
  const url = new URL(base);
  return new Promise((resolve, reject) => {
    const req = request({ host: url.hostname, port: url.port, path: rawPath, method: "GET", headers: { Authorization: `Bearer ${SECRET}` } }, (res) => {
      res.resume();
      res.on("end", () => resolve(res.statusCode));
    });
    req.on("error", reject);
    req.end();
  });
}

async function withServer(fn, options) {
  const ctx = await startBridge(options);
  const server = await serve(ctx.bridge);
  try {
    await fn({ ...ctx, ...server });
  } finally {
    await server.http.close();
  }
}

test("loopback only: the listener is bound to 127.0.0.1", async () => {
  await withServer(async ({ address }) => {
    assert.equal(LOOPBACK_HOST, "127.0.0.1");
    assert.equal(address.address, "127.0.0.1");
    assert.equal(address.family, "IPv4");
  });
});

test("bearer: no header, wrong secret, wrong scheme and a prefix of the secret are all 401, on every path", async () => {
  await withServer(async ({ call }) => {
    const paths = [
      ["/health"],
      ["/messages?after=0&waitMs=0"],
      [`/media/${enc(ALICE.lid)}/X`],
      [`/chat/${enc(NEW_GROUP)}`],
      [`/chat/${enc(NEW_GROUP)}/participant/${enc(ALICE.lid)}`],
      ["/send", { method: "POST", body: { chatId: ALICE.lid, text: "x" } }],
      ["/edit", { method: "POST", body: { chatId: ALICE.lid, messageId: "x", text: "x" } }],
      ["/typing", { method: "POST", body: { chatId: ALICE.lid } }],
      ["/no-such-path"],
    ];
    for (const [path, options = {}] of paths) {
      for (const token of [null, "wrong-secret-wrong-secret", SECRET.slice(0, -1), `${SECRET}x`]) {
        const res = await call(path, { ...options, token });
        assert.equal(res.status, 401, `${path} with ${token === null ? "no token" : "a wrong token"}`);
        assert.deepEqual(await res.json(), { ok: false, error: "unauthorized" });
      }
      const res = await call(path, { ...options, token: null, headers: { Authorization: `Basic ${SECRET}` } });
      assert.equal(res.status, 401);
    }
  });
});

test("a refused request does nothing: nothing was sent", async () => {
  await withServer(async ({ call, sock }) => {
    await call("/send", { method: "POST", body: { chatId: ALICE.lid, text: "x" }, token: null });
    await call("/send", { method: "POST", body: { chatId: ALICE.lid, text: "x" }, token: "nope-nope-nope-nope" });
    assert.equal(sock.sent.length, 0);
  });
});

test("the server refuses to be built without a real secret", async () => {
  const { bridge } = await startBridge();
  for (const secret of [undefined, "", "short"]) {
    assert.throws(() => createBridgeServer(bridge, { secret, log: () => {} }), /secret/);
  }
});

test("GET /health: state and both of the number's own ids, no device suffix", async () => {
  await withServer(async ({ call }) => {
    const { status, body } = await readJson(await call("/health"));
    assert.equal(status, 200);
    assert.equal(body.state, "connected");
    assert.deepEqual(body.own, { lid: OWN.lid, phone: OWN.phone });
    assert.equal(body.version, 1);
    assert.equal(body.epoch, "epoch-test");
  });
});

test("GET /messages: a cursor, nothing is removed by reading, and a missing cursor means 'from now'", async () => {
  await withServer(async ({ call, sock }) => {
    await sock.emit("messages.upsert", upsertOf([privateText({ id: "M1" })]));
    // No cursor: the tip, no backlog, and no waiting.
    const tip = await readJson(await call("/messages"));
    assert.deepEqual(tip.body.events, []);
    assert.equal(tip.body.lastSeq, 1);
    // From the start: the event is there, and still there when asked again.
    for (let i = 0; i < 2; i += 1) {
      const first = await readJson(await call("/messages?after=0&waitMs=0"));
      assert.equal(first.body.events.length, 1);
      assert.equal(first.body.events[0].seq, 1);
      assert.equal(first.body.events[0].messageId, "M1");
    }
    const after = await readJson(await call("/messages?after=1&waitMs=0"));
    assert.deepEqual(after.body.events, []);
    const bad = await call("/messages?after=-3");
    assert.equal(bad.status, 400);
  });
});

test("GET /messages long-poll: waits for the next event and answers when it arrives", async () => {
  await withServer(async ({ call, sock }) => {
    const waiting = call("/messages?after=0&waitMs=5000");
    setTimeout(() => sock.emit("messages.upsert", upsertOf([privateText({ id: "LATE" })])), 30);
    const started = Date.now();
    const { body } = await readJson(await waiting);
    assert.equal(body.events[0].messageId, "LATE");
    assert.ok(Date.now() - started < 3000);
  });
});

test("GET /messages: a different epoch (the bridge restarted) is read as 'everything is new'; a ring overflow is reported as a count", async () => {
  await withServer(
    async ({ call, sock }) => {
      for (let i = 1; i <= 5; i += 1) await sock.emit("messages.upsert", upsertOf([privateText({ id: `M${i}` })]));
      const restarted = await readJson(await call("/messages?after=99&epoch=some-older-epoch&waitMs=0"));
      assert.equal(restarted.body.events.length, 3); // the ring holds the last 3
      const overflow = await readJson(await call("/messages?after=1&epoch=epoch-test&waitMs=0"));
      assert.equal(overflow.body.lost, 1); // seq 2 fell off before it was asked for
      assert.deepEqual(overflow.body.events.map((e) => e.messageId), ["M3", "M4", "M5"]);
    },
    { limits: { events: 3 } },
  );
});

test("POST /send: text out, one messageId; a replyTo quotes only a message of THE SAME chat", async () => {
  await withServer(async ({ call, sock }) => {
    await sock.emit("messages.upsert", upsertOf([groupText({ group: NEW_GROUP, id: "INNEW" }), groupText({ group: OLD_GROUP, id: "INOLD" })]));

    const same = await readJson(await call("/send", { method: "POST", body: { chatId: NEW_GROUP, text: "hello", replyTo: "INNEW" } }));
    assert.equal(same.status, 200);
    assert.equal(same.body.quoted, true);
    assert.equal(sock.sent[0].options.quoted.key.id, "INNEW");
    assert.equal(sock.sent[0].content.text, "hello");

    // A message of ANOTHER chat is not quoted; the text still goes.
    const other = await readJson(await call("/send", { method: "POST", body: { chatId: NEW_GROUP, text: "again", replyTo: "INOLD" } }));
    assert.equal(other.status, 200);
    assert.equal(other.body.quoted, false);
    assert.equal(sock.sent[1].options.quoted, undefined);

    // An unknown id is not quoted either.
    const unknown = await readJson(await call("/send", { method: "POST", body: { chatId: NEW_GROUP, text: "third", replyTo: "NOPE" } }));
    assert.equal(unknown.body.quoted, false);
    assert.equal(sock.sent.length, 3);

    // A replyTo that is not shaped like a message id is refused outright.
    for (const bad of ["../health", "a-b", "x".repeat(129), "", 12, null, ["INNEW"]]) {
      const res = await readJson(await call("/send", { method: "POST", body: { chatId: NEW_GROUP, text: "x", replyTo: bad } }));
      assert.equal(res.status, 400, JSON.stringify(bad));
      assert.equal(res.body.error, "bad_message");
    }
    assert.equal(sock.sent.length, 3);
  });
});

test("POST /send: bad chat, empty or oversized text, malformed JSON are refused and send nothing", async () => {
  await withServer(async ({ call, sock, base }) => {
    const cases = [
      [{ chatId: "status@broadcast", text: "x" }, 400, "bad_chat"],
      [{ chatId: ALICE.lid, text: "   " }, 400, "bad_text"],
      [{ chatId: ALICE.lid, text: "x".repeat(20_001) }, 400, "bad_text"],
      [{ chatId: ALICE.lid }, 400, "bad_text"],
      // Canonical ids only: a phone-form chat id is not a chat the relay knows.
      [{ chatId: ALICE.phone, text: "x" }, 400, "bad_chat"],
    ];
    for (const [body, status, error] of cases) {
      const res = await readJson(await call("/send", { method: "POST", body }));
      assert.equal(res.status, status);
      assert.equal(res.body.error, error);
    }
    const bad = await fetch(`${base}/send`, { method: "POST", headers: { Authorization: `Bearer ${SECRET}` }, body: "{not json" });
    assert.equal(bad.status, 400);
    const huge = await fetch(`${base}/send`, { method: "POST", headers: { Authorization: `Bearer ${SECRET}` }, body: "x".repeat(70_000) });
    assert.equal(huge.status, 413);
    assert.equal(sock.sent.length, 0);
  });
});

test("GET /messages: a batch cut at 100 returns the cursor of its LAST event, with more=true, so nothing is skipped", async () => {
  await withServer(async ({ call, sock }) => {
    for (let i = 1; i <= 230; i += 1) await sock.emit("messages.upsert", upsertOf([privateText({ id: `B${i}` })]));
    const seen = [];
    let cursor = 0;
    let rounds = 0;
    for (;;) {
      const { body } = await readJson(await call(`/messages?after=${cursor}&waitMs=0`));
      seen.push(...body.events.map((e) => e.messageId));
      rounds += 1;
      assert.equal(body.lastSeq, body.events.at(-1).seq);
      if (!body.more) break;
      cursor = body.lastSeq;
    }
    assert.equal(rounds, 3);
    assert.deepEqual(seen, Array.from({ length: 230 }, (_, i) => `B${i + 1}`));
  }, { limits: { events: 500 } });
});

test("POST /send while the bridge is not connected: 503 unavailable, never a throw", async () => {
  await withServer(async ({ call, sock }) => {
    await sock.emit("connection.update", { connection: "close", lastDisconnect: { error: { output: { statusCode: 428 } } } });
    const res = await readJson(await call("/send", { method: "POST", body: { chatId: ALICE.lid, text: "x" } }));
    assert.equal(res.status, 503);
    assert.equal(res.body.error, "unavailable");
    assert.equal(res.body.state, "disconnected");
  });
});

test("POST /send: a library failure is a 502, and the cause is not echoed", async () => {
  await withServer(async ({ call, sock }) => {
    sock.sendError = new Error(`rejected for ${ALICE.lid}`);
    const res = await call("/send", { method: "POST", body: { chatId: ALICE.lid, text: "x" } });
    assert.equal(res.status, 502);
    const text = await res.text();
    assert.ok(!text.includes("100000000000001"));
  });
});

test("POST /edit: only a message the number sent, in THAT chat", async () => {
  await withServer(async ({ call, sock }) => {
    await sock.emit("messages.upsert", upsertOf([groupText({ group: NEW_GROUP, id: "THEIRS" })]));
    const sent = await readJson(await call("/send", { method: "POST", body: { chatId: NEW_GROUP, text: "first" } }));
    const mine = sent.body.messageId;

    const ok = await readJson(await call("/edit", { method: "POST", body: { chatId: NEW_GROUP, messageId: mine, text: "second" } }));
    assert.equal(ok.status, 200);
    const edit = sock.sent.at(-1);
    assert.deepEqual(edit.content, { text: "second", edit: { remoteJid: NEW_GROUP, fromMe: true, id: mine } });

    // Someone else's message in the same chat: 403, nothing sent.
    const before = sock.sent.length;
    const theirs = await readJson(await call("/edit", { method: "POST", body: { chatId: NEW_GROUP, messageId: "THEIRS", text: "nope" } }));
    assert.equal(theirs.status, 403);
    assert.equal(theirs.body.error, "not_own_message");

    // Typed on the number's own phone: flagged fromMe, but not sent by the bridge, so not its to edit.
    const typed = groupText({ group: NEW_GROUP, id: "TYPEDONPHONE" });
    typed.key.fromMe = true;
    typed.key.participant = OWN.lid;
    await sock.emit("messages.upsert", upsertOf([typed]));
    const phoneTyped = await readJson(await call("/edit", { method: "POST", body: { chatId: NEW_GROUP, messageId: "TYPEDONPHONE", text: "no" } }));
    assert.equal(phoneTyped.status, 403);
    assert.equal(phoneTyped.body.error, "not_own_message");
    assert.equal(sock.sent.length, before);

    // The number's own message, but in a different chat: not found, nothing sent.
    const elsewhere = await readJson(await call("/edit", { method: "POST", body: { chatId: OLD_GROUP, messageId: mine, text: "nope" } }));
    assert.equal(elsewhere.status, 404);
    const unknown = await readJson(await call("/edit", { method: "POST", body: { chatId: NEW_GROUP, messageId: "NOPE", text: "nope" } }));
    assert.equal(unknown.status, 404);
    assert.equal(sock.sent.length, before);
  });
});

test("POST /typing: composing by default, paused on request", async () => {
  await withServer(async ({ call, sock }) => {
    assert.equal((await call("/typing", { method: "POST", body: { chatId: NEW_GROUP } })).status, 200);
    assert.equal((await call("/typing", { method: "POST", body: { chatId: NEW_GROUP, state: "paused" } })).status, 200);
    assert.deepEqual(sock.presence, [
      { state: "composing", chatId: NEW_GROUP },
      { state: "paused", chatId: NEW_GROUP },
    ]);
    assert.equal((await call("/typing", { method: "POST", body: { chatId: "junk" } })).status, 400);
  });
});

test("GET /media: bytes of a recent message, on demand; 404 once the bounded store has dropped it, 404 for another chat", async () => {
  await withServer(
    async ({ call, sock, fake }) => {
      const photo = (id, chat) => {
        const m = groupText({ group: chat, id });
        m.message = { imageMessage: { mimetype: "image/jpeg", fileLength: 10 } };
        return m;
      };
      let downloads = 0;
      fake.lib.downloadMediaMessage = async (m) => {
        downloads += 1;
        return Buffer.from(`bytes:${m.key.id}`);
      };
      await sock.emit("messages.upsert", upsertOf([photo("P1", NEW_GROUP)]));
      assert.equal(downloads, 0);

      const res = await call(`/media/${enc(NEW_GROUP)}/P1`);
      assert.equal(res.status, 200);
      assert.equal(res.headers.get("content-type"), "image/jpeg");
      assert.equal(Buffer.from(await res.arrayBuffer()).toString(), "bytes:P1");
      assert.equal(downloads, 1);

      // The same id asked for under another chat is not that message.
      assert.equal((await call(`/media/${enc(OLD_GROUP)}/P1`)).status, 404);
      // A text message has no media.
      await sock.emit("messages.upsert", upsertOf([groupText({ id: "T1" })]));
      assert.equal((await call(`/media/${enc(NEW_GROUP)}/T1`)).status, 404);
      // Two more messages push P1 out of a store of 2.
      await sock.emit("messages.upsert", upsertOf([photo("P2", NEW_GROUP), photo("P3", NEW_GROUP)]));
      const dropped = await readJson(await call(`/media/${enc(NEW_GROUP)}/P1`));
      assert.equal(dropped.status, 404);
      assert.equal(dropped.body.error, "gone");
    },
    { limits: { messages: 2 } },
  );
});

test("GET /media: a file over the cap is 413 before anything is downloaded; a failed download is 502", async () => {
  await withServer(async ({ call, sock, fake }) => {
    let downloads = 0;
    fake.lib.downloadMediaMessage = async () => {
      downloads += 1;
      throw new Error(`cannot fetch for ${ALICE.lid}`);
    };
    const big = groupText({ id: "BIG" });
    big.message = { documentMessage: { mimetype: "application/pdf", fileLength: 30_000_000 } };
    const small = groupText({ id: "SMALL" });
    small.message = { documentMessage: { mimetype: "application/pdf", fileLength: 100 } };
    await sock.emit("messages.upsert", upsertOf([big, small]));
    assert.equal((await call(`/media/${enc(NEW_GROUP)}/BIG`)).status, 413);
    assert.equal((await call(`/media/${enc(NEW_GROUP)}/SMALL?maxBytes=50`)).status, 413);
    assert.equal(downloads, 0);
    const failed = await call(`/media/${enc(NEW_GROUP)}/SMALL`);
    assert.equal(failed.status, 502);
    assert.ok(!(await failed.text()).includes("100000000000001"));
  });
});

test("GET /chat/:id: a group's title and size, and NO participant ids; a private chat is just 'private'", async () => {
  await withServer(async ({ call, sock }) => {
    sock.groups.set(NEW_GROUP, { ...group(NEW_GROUP, [ALICE, BOB, { lid: OWN.lid, phone: OWN.phone }]), subject: "Family Fixture" });
    const res = await readJson(await call(`/chat/${enc(NEW_GROUP)}`));
    assert.equal(res.status, 200);
    assert.deepEqual(res.body, { ok: true, chatId: NEW_GROUP, kind: "group", title: "Family Fixture", size: 3 });
    const raw = JSON.stringify(res.body);
    for (const id of [ALICE.lid, ALICE.phone, BOB.lid, BOB.phone, OWN.lid, OWN.phone, "100000000000001", "200000000001"]) {
      assert.ok(!raw.includes(id), `no participant id in /chat (${id})`);
    }
    const priv = await readJson(await call(`/chat/${enc(ALICE.lid)}`));
    assert.deepEqual(priv.body, { ok: true, chatId: ALICE.lid, kind: "private" });
    // Not in the group (the library says forbidden), or any lookup failure: 503, not a guess.
    const gone = await readJson(await call(`/chat/${enc(OLD_GROUP)}`));
    assert.equal(gone.status, 503);
    assert.equal((await call(`/chat/${enc("status@broadcast")}`)).status, 400);
  });
});

test("GET /chat/:id/participant/:id: yes, no, and 'could not check' are three different answers", async () => {
  let clock = 1_000_000;
  await withServer(async ({ call, sock }) => {
    sock.groups.set(NEW_GROUP, group(NEW_GROUP, [ALICE, BOB]));
    const ask = async (chat, who) => readJson(await call(`/chat/${enc(chat)}/participant/${enc(who)}`));

    assert.deepEqual((await ask(NEW_GROUP, ALICE.lid)).body, { ok: true, chatId: NEW_GROUP, inGroup: true });
    assert.equal((await ask(NEW_GROUP, BOB.lid)).body.inGroup, true);
    assert.equal((await ask(NEW_GROUP, CAROL.lid)).body.inGroup, false);

    // A participant the group lists under a phone id only is still matched, once its pair is known.
    sock.groups.set(OLD_GROUP, { id: OLD_GROUP, participants: [{ id: CAROL.phone, lid: CAROL.lid }] });
    assert.equal((await ask(OLD_GROUP, CAROL.lid)).body.inGroup, true);

    // Cannot check: metadata unavailable -> 503, which is NOT "inGroup: false".
    clock += 61_000; // past the cache
    sock.metadataError = new Error("timeout");
    const unknown = await ask(NEW_GROUP, ALICE.lid);
    assert.equal(unknown.status, 503);
    assert.equal(unknown.body.error, "unavailable");
    assert.equal("inGroup" in unknown.body, false);
    sock.metadataError = null;
  }, { now: () => clock });
});

test("participant: the linked-identity form only; a phone form, junk and a non-group chat are 400", async () => {
  await withServer(async ({ call, sock, base }) => {
    sock.groups.set(NEW_GROUP, group(NEW_GROUP, [ALICE]));
    const ask = async (chat, who) => readJson(await call(`/chat/${enc(chat)}/participant/${enc(who)}`));
    for (const who of [ALICE.phone, "junk", "100000000000001", `${ALICE.lid}/x`]) {
      const res = await ask(NEW_GROUP, who);
      assert.equal(res.status, 400, who);
      assert.equal(res.body.error, "bad_participant");
    }
    assert.equal((await ask("junk", ALICE.lid)).status, 400);
    assert.equal((await ask(ALICE.lid, ALICE.lid)).status, 400);
    // Dot segments, sent as written (fetch would have collapsed them).
    assert.equal(await rawGet(base, `/chat/${enc(NEW_GROUP)}/participant/..`), 400);
    assert.equal(await rawGet(base, `/chat/../participant/${enc(ALICE.lid)}`), 400);
    assert.equal(sock.metadataCalls ?? 0, 0, "a refused question asks WhatsApp nothing");
  });
});

test("group metadata is cached 60 s per group, and a participant or group event for that group drops it", async () => {
  let clock = 5_000_000;
  await withServer(async ({ call, sock }) => {
    let queries = 0;
    const real = sock.groupMetadata.bind(sock);
    sock.groupMetadata = async (id) => {
      queries += 1;
      return real(id);
    };
    sock.groups.set(NEW_GROUP, { ...group(NEW_GROUP, [ALICE, BOB]), subject: "Cached Fixture" });
    sock.groups.set(OLD_GROUP, group(OLD_GROUP, [ALICE]));
    const ask = (who, chat = NEW_GROUP) => call(`/chat/${enc(chat)}/participant/${enc(who)}`);

    for (let i = 0; i < 5; i += 1) await ask(ALICE.lid);
    await call(`/chat/${enc(NEW_GROUP)}`);
    assert.equal(queries, 1, "six questions about one group, one query to WhatsApp");

    await ask(ALICE.lid, OLD_GROUP);
    assert.equal(queries, 2, "another group is its own entry");

    // Bob leaves: the notification drops that group's entry, so the next answer is fresh.
    sock.groups.get(NEW_GROUP).participants = sock.groups.get(NEW_GROUP).participants.filter((p) => p.id !== BOB.lid);
    await sock.emit("group-participants.update", { id: NEW_GROUP, author: ALICE.lid, action: "remove", participants: [{ id: BOB.lid }] });
    const gone = await readJson(await ask(BOB.lid));
    assert.equal(gone.body.inGroup, false);
    assert.equal(queries, 3);
    await ask(BOB.lid);
    assert.equal(queries, 3);

    // A rename drops it too, so /chat shows the new title.
    sock.groups.get(NEW_GROUP).subject = "Renamed Fixture";
    await sock.emit("groups.update", [{ id: NEW_GROUP, subject: "Renamed Fixture" }]);
    assert.equal((await readJson(await call(`/chat/${enc(NEW_GROUP)}`))).body.title, "Renamed Fixture");
    assert.equal(queries, 4);

    // After 60 s the entry is stale.
    clock += 61_000;
    await ask(ALICE.lid);
    assert.equal(queries, 5);

    // A failed lookup is never cached.
    clock += 61_000;
    sock.metadataError = new Error("timeout");
    assert.equal((await ask(ALICE.lid)).status, 503);
    sock.metadataError = null;
    assert.equal((await ask(ALICE.lid)).status, 200);
  }, { now: () => clock });
});

test("ids are checked before use: a path-shaped, wrong-form or oversized id is 400 on /media, /chat, /edit", async () => {
  await withServer(async ({ call, sock, base }) => {
    const photo = groupText({ id: "PHOTO9" });
    photo.message = { imageMessage: { mimetype: "image/jpeg", fileLength: 1 } };
    await sock.emit("messages.upsert", upsertOf([photo]));
    assert.equal((await call(`/media/${enc(NEW_GROUP)}/PHOTO9`)).status, 200);

    for (const [chat, message] of [[NEW_GROUP, "a-b"], [NEW_GROUP, "x".repeat(129)], [ALICE.phone, "PHOTO9"], ["status@broadcast", "PHOTO9"]]) {
      const res = await call(`/media/${enc(chat)}/${enc(message)}`);
      assert.equal(res.status, 400, `${chat} ${message}`);
    }
    assert.equal((await call(`/chat/${enc(ALICE.phone)}`)).status, 400, "a phone-form chat is not a chat");
    // Dot segments as written: they must be refused by shape, not resolved into another route.
    assert.equal(await rawGet(base, "/media/../health"), 400);
    assert.equal(await rawGet(base, `/media/${enc(NEW_GROUP)}/..`), 400);
    assert.equal(await rawGet(base, "/chat/.."), 400);
    assert.equal(await rawGet(base, "/media/%2e%2e/health"), 400);
    for (const messageId of ["..", "a-b", "", 7]) {
      const res = await call("/edit", { method: "POST", body: { chatId: NEW_GROUP, messageId, text: "x" } });
      assert.equal(res.status, 400, JSON.stringify(messageId));
    }
    assert.equal(sock.sent.length, 0);
  });
});
