/**
 * One contract, two implementations: the real bridge core (control-plane/
 * whatsapp-bridge, on a faked library socket) and the stand-in
 * (tools/fake-whatsapp.ts). The relay's WhatsApp path is tested against the
 * stand-in, and the first time it meets the real bridge is the S4 sitting, so any
 * drift between them would surface there. This file is what stops that: the SAME
 * scenarios, driven through the relay's own HTTP client, must give the same
 * answers from both.
 *
 * It needs the sibling package's sources (plain ES modules, no dependencies and no
 * WhatsApp library) and nothing else: the library is replaced by a fake socket
 * before the bridge sees it, so nothing connects anywhere.
 */
import { after, before, describe, test } from "node:test";
import assert from "node:assert/strict";
// The real bridge, as sources. No library is imported by any of these.
// @ts-ignore: plain JS, no declarations
import { startBridge, serve, groupText, privateText, group as libGroup, upsertOf, OWN, SECRET as BRIDGE_SECRET } from "../../whatsapp-bridge/test/helpers.mjs";
import { createHttpWhatsAppClient, type WhatsAppClient } from "../src/relay/whatsapp/client.js";
import { FAKE_OWN, startFakeWhatsApp } from "../tools/fake-whatsapp.js";

const ALICE = { lid: "100000000000001@lid", phone: "200000000001@s.whatsapp.net", name: "Alice Fixture" };
const BOB = { lid: "100000000000002@lid", phone: "200000000002@s.whatsapp.net", name: "Bob Fixture" };
const GROUP = "120000000000000001@g.us";
const OLD_GROUP = "200000000001-1466483396@g.us";

interface Backend {
  name: string;
  url: string;
  secret: string;
  message(input: { chatId: string; fromMe?: boolean; senderId?: string | null; senderName?: string; text?: string; messageId: string; media?: { kind: string; mime: string; filename: string; bytes: Buffer }; mentionedIds?: string[]; quotedMessageId?: string }): Promise<void>;
  added(input: { chatId: string; addedBy?: string; title?: string }): Promise<void>;
  left(input: { chatId: string; participantId: string }): Promise<void>;
  title(input: { chatId: string; title: string }): Promise<void>;
  group(input: { chatId: string; title: string; members: { lid: string; phone: string }[] }): Promise<void>;
  loggedOut(): Promise<void>;
  membershipUnavailable(on: boolean): Promise<void>;
  close(): Promise<void>;
}

async function realBackend(): Promise<Backend> {
  // The bridge caches group metadata for 60 s; the clock is ours so "could not check" can be provoked.
  let clock = Date.now();
  const ctx = await startBridge({ now: () => clock });
  const server = await serve(ctx.bridge);
  const media = new Map<string, Buffer>();
  ctx.fake.lib.downloadMediaMessage = async (m: { key: { id: string } }) => media.get(m.key.id) ?? Buffer.from("");
  const people = new Map<string, string>(); // lid -> phone, for message construction
  return {
    name: "the real bridge core (fake library socket)",
    url: server.base,
    secret: BRIDGE_SECRET,
    async message({ chatId, fromMe, senderId, senderName, text, messageId, media: m, mentionedIds, quotedMessageId }) {
      const isGroup = chatId.endsWith("@g.us");
      const who = senderId ? { lid: senderId, phone: people.get(senderId) ?? ALICE.phone, name: senderName ?? "" } : null;
      const ctx2: Record<string, unknown> = {};
      if (mentionedIds?.length) ctx2.mentionedJid = mentionedIds;
      if (quotedMessageId) ctx2.stanzaId = quotedMessageId;
      const msg = isGroup
        ? groupText({ group: chatId, from: who ?? ALICE, text: text ?? "", id: messageId, ctx: ctx2 })
        : privateText({ from: { lid: chatId, phone: ALICE.phone, name: senderName ?? "" }, text: text ?? "", id: messageId });
      if (m) {
        media.set(messageId, m.bytes);
        msg.message = { [`${m.kind}Message`]: { mimetype: m.mime, fileLength: m.bytes.length, fileName: m.filename, caption: text ?? "" } };
      }
      if (fromMe) {
        msg.key.fromMe = true;
        msg.key.participant = OWN.lid;
      }
      await ctx.sock.emit("messages.upsert", upsertOf([msg]));
    },
    async added({ chatId, addedBy, title }) {
      await ctx.sock.emit("groups.upsert", [{ ...libGroup(chatId, [{ lid: OWN.lid, phone: OWN.phone }]), ...(title ? { subject: title } : {}), ...(addedBy ? { author: addedBy } : {}) }]);
    },
    async left({ chatId, participantId }) {
      // WhatsApp's own metadata changes with the notification; the fake socket's must too.
      const md = ctx.sock.groups.get(chatId);
      if (md) md.participants = md.participants.filter((p: { id: string }) => p.id !== participantId);
      await ctx.sock.emit("group-participants.update", { id: chatId, author: BOB.lid, action: "remove", participants: [{ id: participantId }] });
    },
    async title({ chatId, title }) {
      const md = ctx.sock.groups.get(chatId);
      if (md) md.subject = title;
      await ctx.sock.emit("groups.update", [{ id: chatId, subject: title }]);
    },
    async group({ chatId, title, members }) {
      for (const m of members) people.set(m.lid, m.phone);
      ctx.sock.groups.set(chatId, { ...libGroup(chatId, [...members, { lid: OWN.lid, phone: OWN.phone }]), subject: title });
    },
    async loggedOut() {
      await ctx.sock.emit("connection.update", { connection: "close", lastDisconnect: { error: { output: { statusCode: 401 } } } });
    },
    async membershipUnavailable(on: boolean) {
      clock += 61_000; // past the cache, so the next question really asks
      ctx.sock.metadataError = on ? new Error("timeout") : null;
    },
    close: () => server.http.close(),
  };
}

async function standInBackend(): Promise<Backend> {
  const fake = await startFakeWhatsApp({ secret: "stand-in-secret-0123456789-abcdefgh" });
  return {
    name: "the stand-in (tools/fake-whatsapp.ts)",
    url: fake.url,
    secret: fake.secret,
    async message({ chatId, fromMe, senderId, senderName, text, messageId, media, mentionedIds, quotedMessageId }) {
      fake.control.message({
        chatId,
        ...(fromMe ? { fromMe: true, senderId: OWN.lid } : {}),
        ...(senderId !== undefined ? { senderId } : {}),
        senderName,
        text,
        messageId,
        mentionedIds,
        quotedMessageId,
        ...(media ? { media: { kind: media.kind, mime: media.mime, filename: media.filename, base64: media.bytes.toString("base64") } } : {}),
      });
    },
    async added(input) {
      fake.control.added(input);
    },
    async left(input) {
      fake.control.left(input);
    },
    async title(input) {
      fake.control.title(input);
    },
    async group({ chatId, title, members }) {
      fake.control.group({ chatId, title, participants: [...members.map((m) => m.lid), FAKE_OWN.lid] });
    },
    async loggedOut() {
      fake.control.setState("logged_out");
    },
    async membershipUnavailable(on: boolean) {
      fake.control.membershipUnavailable(on);
    },
    close: () => fake.close(),
  };
}

for (const make of [realBackend, standInBackend]) {
  describe(`bridge contract, as seen by the relay's client`, () => {
    let backend: Backend;
    let client: WhatsAppClient;
    before(async () => {
      backend = await make();
      client = createHttpWhatsAppClient({ baseUrl: backend.url, secret: backend.secret, requestTimeoutMs: 3000 });
    });
    after(async () => {
      await backend.close();
    });
    const t = (name: string, fn: () => Promise<void>) => test(`[${make === realBackend ? "real" : "stand-in"}] ${name}`, fn);

    t("health: connected, with the number's own ids in both forms", async () => {
      const out = await client.health();
      assert.ok(out.ok);
      assert.equal(out.value.state, "connected");
      assert.deepEqual(out.value.own, { lid: OWN.lid, phone: OWN.phone });
      assert.equal(FAKE_OWN.lid, OWN.lid);
    });

    t("unauthenticated and wrong-secret requests are 401 on every path", async () => {
      for (const path of ["/health", "/messages", "/chat/x", "/nope"]) {
        for (const auth of [undefined, "Bearer wrong-secret-wrong-secret"]) {
          const res = await fetch(`${backend.url}${path}`, { headers: auth ? { Authorization: auth } : {} });
          assert.equal(res.status, 401, `${path} ${auth ?? "no auth"}`);
        }
      }
    });

    t("messages: same shapes through the client's parser, old and new group ids, media metadata, mentions", async () => {
      const tip = await client.poll({}, { waitMs: 0 });
      assert.ok(tip.ok);
      await backend.group({ chatId: GROUP, title: "Family Fixture", members: [ALICE, BOB] });
      await backend.message({ chatId: GROUP, senderId: ALICE.lid, senderName: ALICE.name, text: `@${OWN.lid.split("@")[0]} hello`, messageId: "C1", mentionedIds: [OWN.lid] });
      await backend.message({ chatId: OLD_GROUP, senderId: BOB.lid, senderName: BOB.name, text: "old group", messageId: "C2" });
      await backend.message({ chatId: ALICE.lid, senderName: ALICE.name, text: "private", messageId: "C3" });
      await backend.message({ chatId: GROUP, senderId: ALICE.lid, text: "a photo", messageId: "C4", media: { kind: "image", mime: "image/jpeg", filename: "", bytes: Buffer.from("jpeg-bytes") } });
      const out = await client.poll({ after: tip.value.lastSeq, epoch: tip.value.epoch }, { waitMs: 0 });
      assert.ok(out.ok);
      assert.equal(out.value.malformed, 0);
      assert.equal(out.value.ignored, 0);
      const byId = new Map(out.value.events.flatMap((e) => (e.type === "message" ? [[e.messageId, e] as const] : [])));
      assert.equal(byId.size, 4);
      assert.equal(byId.get("C1")!.chatId, GROUP);
      assert.equal(byId.get("C1")!.senderId, ALICE.lid);
      assert.equal(byId.get("C1")!.senderName, ALICE.name);
      assert.deepEqual(byId.get("C1")!.mentionedIds, [OWN.lid]);
      assert.equal(byId.get("C2")!.chatId, OLD_GROUP);
      assert.equal(byId.get("C3")!.chatId, ALICE.lid);
      assert.equal(byId.get("C3")!.senderId, ALICE.lid);
      assert.deepEqual(byId.get("C4")!.media, { kind: "image", mime: "image/jpeg", size: 10, filename: "" });
      for (const e of byId.values()) assert.equal(e.fromMe, false);
    });

    t("/messages never carries a full phone number, only the last four digits", async () => {
      await backend.message({ chatId: GROUP, senderId: ALICE.lid, senderName: ALICE.name, text: "with a number nearby", messageId: "NUM1", mentionedIds: [OWN.lid] });
      const raw = await (await fetch(`${backend.url}/messages?after=0&waitMs=0`, { headers: { Authorization: `Bearer ${backend.secret}` } })).text();
      for (const full of ["200000000002", "200000000099", "@s.whatsapp.net"]) // (the old group id legitimately embeds its creator's number)
       assert.ok(!raw.includes(full), full);
      assert.ok(raw.includes('"senderPhoneLast4":"0001"') || !raw.includes("senderPhone"), "last four digits at most");
    });

    t("a batch is cut at 100: following lastSeq while more is true delivers every event, none twice", async () => {
      const tip = await client.poll({}, { waitMs: 0 });
      assert.ok(tip.ok);
      for (let i = 1; i <= 230; i += 1) await backend.message({ chatId: ALICE.lid, senderName: ALICE.name, text: `bulk ${i}`, messageId: `BULK${i}` });
      const seen: string[] = [];
      let cursor = tip.value.lastSeq;
      let rounds = 0;
      for (;;) {
        const out = await client.poll({ after: cursor, epoch: tip.value.epoch }, { waitMs: 0 });
        assert.ok(out.ok);
        assert.equal(out.value.lost, 0);
        seen.push(...out.value.events.flatMap((e) => (e.type === "message" ? [e.messageId] : [])));
        rounds += 1;
        if (!out.value.more) break;
        cursor = out.value.lastSeq;
      }
      assert.equal(rounds, 3);
      assert.deepEqual(seen, Array.from({ length: 230 }, (_, i) => `BULK${i + 1}`));
    });

    t("media: bytes on demand; unknown id and the wrong chat are not_found", async () => {
      const got = await client.fetchMedia(GROUP, "C4");
      assert.ok(got.ok);
      assert.equal(got.value.mime, "image/jpeg");
      assert.equal(got.value.bytes.toString(), "jpeg-bytes");
      const wrongChat = await client.fetchMedia(OLD_GROUP, "C4");
      assert.ok(!wrongChat.ok && wrongChat.reason === "not_found");
      const unknown = await client.fetchMedia(GROUP, "NOPE");
      assert.ok(!unknown.ok && unknown.reason === "not_found");
      const text = await client.fetchMedia(GROUP, "C1");
      assert.ok(!text.ok && text.reason === "not_found");
    });

    t("group events: added (with and without addedBy), left, title changed", async () => {
      const tip = await client.poll({}, { waitMs: 0 });
      assert.ok(tip.ok);
      await backend.added({ chatId: "120000000000000002@g.us", addedBy: BOB.lid, title: "Added Fixture" });
      await backend.added({ chatId: OLD_GROUP });
      await backend.left({ chatId: GROUP, participantId: BOB.lid });
      await backend.title({ chatId: GROUP, title: "Renamed Fixture" });
      const out = await client.poll({ after: tip.value.lastSeq, epoch: tip.value.epoch }, { waitMs: 0 });
      assert.ok(out.ok);
      assert.equal(out.value.malformed, 0);
      const shapes = out.value.events.map((e) => {
        const { seq: _seq, title: _title, ...rest } = e as Record<string, unknown>;
        return rest;
      });
      assert.deepEqual(shapes, [
        { type: "added_to_group", chatId: "120000000000000002@g.us", addedBy: BOB.lid },
        { type: "added_to_group", chatId: OLD_GROUP },
        { type: "participant_left", chatId: GROUP, participantId: BOB.lid },
        { type: "title_changed", chatId: GROUP },
      ]);
    });

    t("send, reply quoting only within the chat, and edit only of the number's own message", async () => {
      const sameChat = await client.send({ chatId: GROUP, text: "an answer", replyTo: "C1" });
      assert.ok(sameChat.ok && sameChat.value.quoted === true);
      const crossChat = await client.send({ chatId: GROUP, text: "another", replyTo: "C2" });
      assert.ok(crossChat.ok && crossChat.value.quoted === false);

      assert.ok((await client.edit({ chatId: GROUP, messageId: sameChat.value.messageId, text: "an answer, edited" })).ok);
      const theirs = await client.edit({ chatId: GROUP, messageId: "C1", text: "no" });
      assert.ok(!theirs.ok && theirs.reason === "refused" && theirs.detail === "not_own_message");
      const wrongChat = await client.edit({ chatId: OLD_GROUP, messageId: sameChat.value.messageId, text: "no" });
      assert.ok(!wrongChat.ok && wrongChat.reason === "not_found");
      // Typed on the number's own phone: flagged fromMe, but not sent through the bridge, so not editable.
      await backend.message({ chatId: GROUP, fromMe: true, text: "typed on the phone", messageId: "TYPEDONPHONE" });
      const phoneTyped = await client.edit({ chatId: GROUP, messageId: "TYPEDONPHONE", text: "no" });
      assert.ok(!phoneTyped.ok && phoneTyped.reason === "refused" && phoneTyped.detail === "not_own_message");
      assert.ok((await client.typing({ chatId: GROUP })).ok);
    });

    t("chat info: title and size, and no participant id anywhere in the raw response", async () => {
      const info = await client.chatInfo(GROUP);
      assert.ok(info.ok && info.value.kind === "group");
      // After the rename and Bob leaving (the group events test above).
      assert.equal(info.value.title, "Renamed Fixture");
      assert.equal(info.value.size, 2);
      const raw = await (await fetch(`${backend.url}/chat/${encodeURIComponent(GROUP)}`, { headers: { Authorization: `Bearer ${backend.secret}` } })).text();
      assert.deepEqual(Object.keys(JSON.parse(raw)).sort(), ["chatId", "kind", "ok", "size", "title"]);
      for (const id of [ALICE.lid, ALICE.phone, BOB.lid, BOB.phone, OWN.lid, OWN.phone, "100000000000001", "200000000001"]) assert.ok(!raw.includes(id), id);
    });

    t("membership: yes, no and could-not-check; linked-identity form only", async () => {
      assert.deepEqual(await client.isParticipant(GROUP, ALICE.lid), { ok: true, value: true });
      // Bob left in the group events test.
      assert.deepEqual(await client.isParticipant(GROUP, BOB.lid), { ok: true, value: false });
      assert.deepEqual(await client.isParticipant(GROUP, "100000000000003@lid"), { ok: true, value: false });
      // A phone form is refused: by the client before a request, and by the server itself (a 400, same on both backends).
      const refused = await client.isParticipant(GROUP, ALICE.phone);
      assert.ok(!refused.ok && refused.reason === "refused" && refused.detail === "bad_id");
      const raw = await fetch(`${backend.url}/chat/${encodeURIComponent(GROUP)}/participant/${encodeURIComponent(ALICE.phone)}`, { headers: { Authorization: `Bearer ${backend.secret}` } });
      assert.equal(raw.status, 400);
      await backend.membershipUnavailable(true);
      const unknown = await client.isParticipant(GROUP, ALICE.lid);
      assert.ok(!unknown.ok && unknown.reason === "unavailable");
      await backend.membershipUnavailable(false);
    });

    t("logged out: reported on health, and every send is unavailable", async () => {
      await backend.loggedOut();
      const health = await client.health();
      assert.ok(health.ok && health.value.state === "logged_out");
      const out = await client.send({ chatId: GROUP, text: "x" });
      assert.ok(!out.ok && out.reason === "unavailable");
    });
  });
}
