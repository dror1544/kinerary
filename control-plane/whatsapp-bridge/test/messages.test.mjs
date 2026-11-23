import assert from "node:assert/strict";
import { test } from "node:test";
import { ALICE, BOB, CAROL, NEW_GROUP, OLD_GROUP, OWN, group, groupText, privateText, startBridge, upsertOf } from "./helpers.mjs";

async function events(bridge, after = 0) {
  const out = await bridge.poll({ after, epoch: "epoch-test", waitMs: 0 });
  return out.body.events;
}

test("a private message: chat and sender are the linked-identity id, the phone's last four digits are a separate optional field", async () => {
  const { bridge, sock } = await startBridge();
  await sock.emit("messages.upsert", upsertOf([privateText({ text: "where is the hotel?" })]));
  const [event] = await events(bridge);
  assert.equal(event.type, "message");
  assert.equal(event.chatId, ALICE.lid);
  assert.equal(event.senderId, ALICE.lid);
  // Never the full number: only its last four digits leave the bridge.
  assert.equal(event.senderPhoneLast4, "0001");
  assert.equal("senderPhone" in event, false);
  assert.equal(event.senderName, "Alice Fixture");
  assert.equal(event.text, "where is the hotel?");
  assert.equal(event.messageId, "MSGPRIV0001");
  assert.equal(event.fromMe, false);
  assert.deepEqual(event.mentionedIds, []);
  assert.equal(event.media, undefined);
});

test("no /messages item carries a full phone number, in any field: private, group, own, mention and quote cases", async () => {
  const { bridge, sock } = await startBridge();
  await sock.emit("messages.upsert", upsertOf([
    privateText({ id: "N1" }),
    groupText({ id: "N2", from: BOB, ctx: { mentionedJid: [ALICE.phone, OWN.phone], quotedMessage: { conversation: "q" }, stanzaId: "Q1", participant: ALICE.phone } }),
  ]));
  const own = groupText({ id: "N3" });
  own.key.fromMe = true;
  own.key.participant = OWN.lid;
  await sock.emit("messages.upsert", upsertOf([own]));
  const raw = JSON.stringify(await events(bridge));
  for (const digits of ["200000000001", "200000000002", "200000000099", "@s.whatsapp.net"]) assert.ok(!raw.includes(digits), digits);
  assert.ok(raw.includes('"senderPhoneLast4":"0099"'), "the number's own messages carry its last four too");
});

test("a private message whose chat id arrives as a phone id is resolved through the library's mapping", async () => {
  const { bridge, sock } = await startBridge();
  sock.signalRepository.lidMapping.map.set(ALICE.phone, ALICE.lid);
  const msg = privateText({ alt: false });
  msg.key.remoteJid = ALICE.phone;
  await sock.emit("messages.upsert", upsertOf([msg]));
  const [event] = await events(bridge);
  assert.equal(event.chatId, ALICE.lid);
  assert.equal(event.senderId, ALICE.lid);
});

test("a private chat that cannot be resolved to a linked-identity id is not delivered, and is counted", async () => {
  const { bridge, sock } = await startBridge();
  const msg = privateText({ alt: false });
  msg.key.remoteJid = "200000000077@s.whatsapp.net";
  await sock.emit("messages.upsert", upsertOf([msg]));
  assert.deepEqual(await events(bridge), []);
  const health = bridge.health().body;
  assert.equal(health.counters.skipped.unresolved_chat, 1);
});

test("a group message: real group id (new and old), participant canonical, phone beside it", async () => {
  const { bridge, sock } = await startBridge();
  await sock.emit(
    "messages.upsert",
    upsertOf([groupText({ group: NEW_GROUP, from: BOB, id: "G1" }), groupText({ group: OLD_GROUP, from: ALICE, id: "G2" })]),
  );
  const [a, b] = await events(bridge);
  assert.equal(a.chatId, NEW_GROUP);
  assert.equal(a.senderId, BOB.lid);
  assert.equal(a.senderPhoneLast4, "0002");
  assert.equal(b.chatId, OLD_GROUP);
  assert.equal(b.senderId, ALICE.lid);
});

test("a group sender that is a phone id only and unmapped is reported unknown (null), not guessed", async () => {
  const { bridge, sock } = await startBridge();
  const msg = groupText({ alt: false, from: CAROL });
  msg.key.participant = CAROL.phone;
  await sock.emit("messages.upsert", upsertOf([msg]));
  const [event] = await events(bridge);
  assert.equal(event.senderId, null);
  assert.equal(event.senderPhoneLast4, "0003");
});

test("a phone-only sender is resolved once the pair has been seen in other traffic", async () => {
  const { bridge, sock } = await startBridge();
  await sock.emit("messages.upsert", upsertOf([groupText({ from: ALICE, id: "A" })]));
  const later = groupText({ from: ALICE, id: "B", alt: false });
  later.key.participant = ALICE.phone;
  await sock.emit("messages.upsert", upsertOf([later]));
  const batch = await events(bridge);
  assert.equal(batch[1].senderId, ALICE.lid);
});

test("an @mention: text passes through unchanged and mentionedIds are canonical (including the number itself)", async () => {
  const { bridge, sock } = await startBridge();
  const text = `@${OWN.lid.split("@")[0]} what time is dinner @${BOB.lid.split("@")[0]}`;
  const msg = groupText({
    text,
    ctx: { mentionedJid: [`${OWN.lid.replace("@", ":7@")}`, BOB.phone, BOB.lid, "200000000066@s.whatsapp.net"] },
  });
  await sock.emit("messages.upsert", upsertOf([groupText({ from: BOB, id: "SEEN" })])); // teaches Bob's pair
  await sock.emit("messages.upsert", upsertOf([msg]));
  const event = (await events(bridge)).at(-1);
  assert.equal(event.text, text);
  assert.deepEqual(event.mentionedIds, [OWN.lid, BOB.lid]);
});

test("a reply: quoted id, canonical quoted participant and the quoted text", async () => {
  const { bridge, sock } = await startBridge();
  const msg = groupText({
    ctx: {
      stanzaId: "QUOTED01",
      participant: OWN.lid,
      quotedMessage: { conversation: "the earlier line" },
    },
  });
  await sock.emit("messages.upsert", upsertOf([msg]));
  const [event] = await events(bridge);
  assert.equal(event.quotedMessageId, "QUOTED01");
  assert.equal(event.quotedParticipant, OWN.lid);
  assert.equal(event.quotedText, "the earlier line");
});

test("media: metadata only, nothing is downloaded until /media is asked for", async () => {
  const { bridge, sock, fake } = await startBridge();
  let downloads = 0;
  fake.lib.downloadMediaMessage = async () => {
    downloads += 1;
    return Buffer.from("x");
  };
  const msg = groupText({ id: "PHOTO1" });
  msg.message = { imageMessage: { mimetype: "image/jpeg", fileLength: 2048, caption: "look at this" } };
  const doc = groupText({ id: "DOC1" });
  doc.message = { documentMessage: { mimetype: "application/pdf", fileLength: { toString: () => "4096" }, fileName: "ticket.pdf" } };
  await sock.emit("messages.upsert", upsertOf([msg, doc]));
  const [photo, pdf] = await events(bridge);
  assert.deepEqual(photo.media, { kind: "image", mime: "image/jpeg", size: 2048, filename: "" });
  assert.equal(photo.text, "look at this");
  assert.deepEqual(pdf.media, { kind: "document", mime: "application/pdf", size: 4096, filename: "ticket.pdf" });
  assert.equal(pdf.text, "");
  assert.equal(downloads, 0);
});

test("the number's own messages are delivered flagged; the echo of its own /send is not delivered", async () => {
  const { bridge, sock } = await startBridge();
  const typedOnPhone = groupText({ id: "OWN1", text: "typed on the phone" });
  typedOnPhone.key.fromMe = true;
  typedOnPhone.key.participant = OWN.lid;
  delete typedOnPhone.pushName;
  await sock.emit("messages.upsert", upsertOf([typedOnPhone]));
  const sent = await bridge.send({ chatId: NEW_GROUP, text: "from the relay" });
  const echo = groupText({ id: sent.body.messageId, text: "from the relay" });
  echo.key.fromMe = true;
  echo.key.participant = OWN.lid;
  await sock.emit("messages.upsert", upsertOf([echo]));
  const batch = await events(bridge);
  assert.equal(batch.length, 1);
  assert.equal(batch[0].fromMe, true);
  assert.equal(batch[0].senderId, OWN.lid);
  assert.equal(batch[0].senderName, "");
});

test("protocol, history-sync, key-distribution-only, stub, reaction and sticker messages are not messages", async () => {
  const { bridge, sock } = await startBridge();
  const base = (message, extra = {}) => ({ key: { remoteJid: ALICE.lid, fromMe: false, id: `X${Math.random()}` }, message, ...extra });
  await sock.emit(
    "messages.upsert",
    upsertOf([
      base({ protocolMessage: { type: "HISTORY_SYNC_NOTIFICATION", historySyncNotification: { syncType: "INITIAL_BOOTSTRAP" } } }),
      base({ protocolMessage: { type: "APP_STATE_SYNC_KEY_SHARE" } }),
      base({ senderKeyDistributionMessage: { groupId: NEW_GROUP }, protocolMessage: { type: "GROUP_MEMBER_LABEL_CHANGE" } }),
      base({ reactionMessage: { text: "👍" } }),
      base({ stickerMessage: {} }),
      { key: { remoteJid: NEW_GROUP, fromMe: false, id: "STUB", participant: ALICE.lid }, messageStubType: "GROUP_CREATE", message: { conversation: "x" } },
      { key: { remoteJid: "status@broadcast", fromMe: false, id: "ST" }, message: { conversation: "a status" } },
    ]),
  );
  assert.deepEqual(await events(bridge), []);
});

test("a key-distribution wrapper that also carries text IS a message", async () => {
  const { bridge, sock } = await startBridge();
  const msg = groupText({ id: "WITHSKD" });
  msg.message.senderKeyDistributionMessage = { groupId: NEW_GROUP };
  await sock.emit("messages.upsert", upsertOf([msg]));
  assert.equal((await events(bridge)).length, 1);
});

test("offline deliveries (type append) are delivered when recent: a code sent during a reconnect is not lost", async () => {
  const { bridge, sock } = await startBridge();
  const nowS = Math.floor(Date.now() / 1000);
  const fresh = privateText({ id: "OFFLINE1", text: "sent while the bridge was down" });
  fresh.messageTimestamp = nowS - 60;
  const stale = privateText({ id: "OLD1" });
  stale.messageTimestamp = nowS - 3 * 3600;
  const undated = privateText({ id: "UNDATED" });
  delete undated.messageTimestamp;
  await sock.emit("messages.upsert", upsertOf([fresh, stale, undated], "append"));
  // append that carries no content (a stub, a protocol notice) is still not a message
  await sock.emit("messages.upsert", upsertOf([{ key: { remoteJid: NEW_GROUP, id: "STUB2", participant: ALICE.lid }, messageStubType: "GROUP_CREATE", messageTimestamp: nowS, message: { conversation: "x" } }], "append"));
  const batch = await events(bridge);
  assert.deepEqual(batch.map((e) => e.messageId), ["OFFLINE1"]);
  assert.equal(bridge.health().body.counters.skipped.stale_append, 2);
});

test("any other upsert type (history) is not delivered", async () => {
  const { bridge, sock } = await startBridge();
  const msg = privateText();
  msg.messageTimestamp = Math.floor(Date.now() / 1000);
  await sock.emit("messages.upsert", upsertOf([msg], "history"));
  assert.deepEqual(await events(bridge), []);
});

test("a display name that is really a number is delivered as empty", async () => {
  const { bridge, sock } = await startBridge();
  const msg = privateText();
  msg.pushName = "+200 000 000 001";
  await sock.emit("messages.upsert", upsertOf([msg]));
  assert.equal((await events(bridge))[0].senderName, "");
});

test("an ephemeral wrapper is peeled", async () => {
  const { bridge, sock } = await startBridge();
  const msg = privateText();
  msg.message = { ephemeralMessage: { message: { extendedTextMessage: { text: "wrapped" } } } };
  await sock.emit("messages.upsert", upsertOf([msg]));
  assert.equal((await events(bridge))[0].text, "wrapped");
});

test("group events: added (with addedBy from the AUTHOR only), no author, left, title changed", async () => {
  const { bridge, sock } = await startBridge();
  const ownEntry = { lid: OWN.lid, phone: OWN.phone };

  // groups.upsert: the owner/subjectOwner is Alice, the author is Bob — Bob is the adder.
  await sock.emit("groups.upsert", [
    { ...group(NEW_GROUP, [ALICE, ownEntry]), owner: ALICE.lid, subjectOwner: ALICE.lid, author: BOB.lid, authorPn: BOB.phone },
  ]);
  // The old group, with an event that does not say by whom.
  await sock.emit("groups.upsert", [{ ...group(OLD_GROUP, [ALICE, ownEntry]), owner: ALICE.lid, ownerPn: ALICE.phone }]);
  // A group the number is not in is not "added".
  await sock.emit("groups.upsert", [group("120000000000000002@g.us", [ALICE, BOB])]);
  // Left, in both id forms.
  await sock.emit("group-participants.update", {
    id: NEW_GROUP,
    author: ALICE.lid,
    action: "remove",
    participants: [{ id: BOB.lid, phoneNumber: BOB.phone, admin: null }, { id: CAROL.phone }],
  });
  await sock.emit("groups.update", [{ id: NEW_GROUP, subject: "Renamed Fixture" }, { id: ALICE.lid, subject: "ignored" }]);

  const batch = await events(bridge);
  assert.deepEqual(
    batch.map(({ seq, ...rest }) => rest),
    [
      { type: "added_to_group", chatId: NEW_GROUP, addedBy: BOB.lid, title: "Fixture Group" },
      { type: "added_to_group", chatId: OLD_GROUP, title: "Fixture Group" },
      { type: "participant_left", chatId: NEW_GROUP, participantId: BOB.lid },
      { type: "title_changed", chatId: NEW_GROUP, title: "Renamed Fixture" },
    ],
  );
  assert.equal("addedBy" in batch[1], false);
});

test("added through group-participants.update, with the number in either id form, once", async () => {
  const { bridge, sock } = await startBridge();
  await sock.emit("group-participants.update", {
    id: NEW_GROUP,
    author: BOB.lid,
    authorPn: BOB.phone,
    action: "add",
    participants: [{ id: OWN.phone }],
  });
  // The library may also announce the same join as a group upsert: one event, not two.
  await sock.emit("groups.upsert", [{ ...group(NEW_GROUP, [ALICE, { lid: OWN.lid, phone: OWN.phone }]), author: BOB.lid }]);
  // Someone else being added is not news.
  await sock.emit("group-participants.update", { id: OLD_GROUP, author: BOB.lid, action: "add", participants: [{ id: CAROL.lid }] });
  const batch = await events(bridge);
  assert.equal(batch.length, 1);
  assert.equal(batch[0].type, "added_to_group");
  assert.equal(batch[0].addedBy, BOB.lid);
});

test("being removed lets the same group be announced again when the number is re-added", async () => {
  const { bridge, sock } = await startBridge();
  const add = { id: NEW_GROUP, author: BOB.lid, action: "add", participants: [{ id: OWN.lid }] };
  await sock.emit("group-participants.update", add);
  await sock.emit("group-participants.update", { id: NEW_GROUP, author: BOB.lid, action: "remove", participants: [{ id: OWN.lid, phoneNumber: OWN.phone }] });
  await sock.emit("group-participants.update", add);
  const types = (await events(bridge)).map((e) => e.type);
  assert.deepEqual(types, ["added_to_group", "participant_left", "added_to_group"]);
});
