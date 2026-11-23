/**
 * Spec 625 AC-27 and the Security notes: pairing hands the linked device the
 * phone's address book and history-sync notices. The bridge discards both, writes
 * no log line that carries a name, number, id or message text, and writes no file
 * outside its session directory.
 */
import assert from "node:assert/strict";
import { mkdtempSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { createBridge } from "../src/core.js";
import { createSafeLogger } from "../src/safe-log.js";
import { ALICE, BOB, CAROL, NEW_GROUP, OWN, group, groupText, makeFakeLib, privateText, serve, tempDir, upsertOf } from "./helpers.mjs";

const SECRET_TEXT = "the-private-sentence-xyzzy";
const FIXTURE_NEEDLES = [
  "100000000000001", "100000000000002", "100000000000003", "100000000000099",
  "200000000001", "200000000002", "200000000003", "200000000099", "120000000000000001",
  "Alice Fixture", "Bob Fixture", "Carol Fixture", SECRET_TEXT, "Contact Book Name",
];

/** Capture everything the process writes to stdout and stderr while `fn` runs. */
async function captureStreams(fn) {
  const written = [];
  const out = process.stdout.write.bind(process.stdout);
  const err = process.stderr.write.bind(process.stderr);
  process.stdout.write = (chunk, ...rest) => {
    written.push(String(chunk));
    return typeof rest.at(-1) === "function" ? (rest.at(-1)(), true) : true;
  };
  process.stderr.write = (chunk, ...rest) => {
    written.push(String(chunk));
    return typeof rest.at(-1) === "function" ? (rest.at(-1)(), true) : true;
  };
  try {
    await fn();
  } finally {
    process.stdout.write = out;
    process.stderr.write = err;
  }
  return written.join("");
}

function listAll(dir) {
  return readdirSync(dir, { recursive: true }).sort();
}

async function scenario() {
  const fake = makeFakeLib();
  const rawLogCalls = [];
  const lines = [];
  const safe = createSafeLogger((line) => lines.push(line));
  const log = (event, fields) => {
    rawLogCalls.push({ event, ...fields });
    safe.log(event, fields);
  };
  const sessionDir = tempDir("wa-session-");
  const bridge = createBridge({ lib: fake.lib, sessionDir, log, epoch: "e" });
  await bridge.start();
  const sock = fake.sock;
  await sock.emit("connection.update", { connection: "open" });
  return { fake, sock, bridge, rawLogCalls, lines, sessionDir };
}

test("pairing's address book and history sync are discarded: no message, no log line, no file outside the session directory", async () => {
  const cwd = process.cwd();
  const work = mkdtempSync(path.join(tmpdir(), "wa-cwd-"));
  const home = mkdtempSync(path.join(tmpdir(), "wa-home-"));
  const oldHome = process.env.HOME;
  process.chdir(work);
  process.env.HOME = home;
  try {
    const { sock, bridge, rawLogCalls, lines, sessionDir } = await scenario();
    const before = { work: listAll(work), home: listAll(home), session: listAll(sessionDir) };

    const streams = await captureStreams(async () => {
      // The address book: names with numbers, in every event shape the capture showed.
      await sock.emit("contacts.upsert", [{ id: ALICE.lid, name: "Contact Book Name", notify: "Contact Book Name", phoneNumber: ALICE.phone }]);
      await sock.emit("contacts.update", [{ id: BOB.lid, notify: "Contact Book Name" }]);
      await sock.emit("contacts.set", { contacts: [{ id: CAROL.lid, name: "Contact Book Name" }] });
      await sock.emit("lid-mapping.update", { lid: ALICE.lid, pn: ALICE.phone });
      await sock.emit("chats.upsert", [{ id: ALICE.lid, name: "Contact Book Name" }]);
      await sock.emit("chats.update", [{ id: ALICE.lid, messages: [{ message: { key: { remoteJid: ALICE.lid }, message: { conversation: SECRET_TEXT } } }] }]);
      await sock.emit("messaging-history.set", { chats: [{ id: ALICE.lid, name: "Contact Book Name" }], contacts: [], messages: [{ key: { remoteJid: ALICE.lid }, message: { conversation: SECRET_TEXT } }] });
      // The history-sync notices that arrive as ordinary-looking upserts.
      for (const syncType of ["INITIAL_BOOTSTRAP", "NON_BLOCKING_DATA", "PUSH_NAME", "RECENT"]) {
        await sock.emit(
          "messages.upsert",
          upsertOf([
            {
              key: { remoteJid: OWN.lid, fromMe: false, id: `HS-${syncType}`, participant: "" },
              category: "peer",
              message: { protocolMessage: { type: "HISTORY_SYNC_NOTIFICATION", historySyncNotification: { syncType, initialHistBootstrapInlinePayload: "AAAA" } } },
            },
          ]),
        );
      }
      await sock.emit("messages.upsert", upsertOf([privateText({ text: SECRET_TEXT })], "append"));
    });

    const polled = await bridge.poll({ after: 0, waitMs: 0, epoch: "e" });
    assert.deepEqual(polled.body.events, [], "no /messages item from a contacts or history event");
    assert.equal(bridge.health().body.counters.delivered, 0);

    for (const needle of FIXTURE_NEEDLES) {
      assert.ok(!streams.includes(needle), `stdout/stderr: ${needle}`);
      assert.ok(!JSON.stringify(rawLogCalls).includes(needle), `log calls: ${needle}`);
      assert.ok(!lines.join("\n").includes(needle), `log lines: ${needle}`);
    }
    assert.deepEqual(listAll(work), before.work, "nothing written to the working directory");
    assert.deepEqual(listAll(home), before.home, "nothing written to HOME");
    assert.deepEqual(listAll(sessionDir), before.session, "the bridge itself writes nothing into the session directory");
  } finally {
    process.chdir(cwd);
    process.env.HOME = oldHome;
  }
});

test("no participant id, number, name or message text reaches a log line or either stream, on every path including failures", async () => {
  const { sock, bridge, rawLogCalls, lines, fake } = await scenario();
  const streams = await captureStreams(async () => {
    const own = { lid: OWN.lid, phone: OWN.phone };
    // The happy paths, with ids, names, text and mentions in play.
    await sock.emit("messages.upsert", upsertOf([
      privateText({ text: SECRET_TEXT }),
      groupText({ text: `@${BOB.lid.split("@")[0]} ${SECRET_TEXT}`, ctx: { mentionedJid: [BOB.lid], stanzaId: "Q", participant: ALICE.lid, quotedMessage: { conversation: SECRET_TEXT } } }),
    ]));
    await sock.emit("groups.upsert", [{ ...group(NEW_GROUP, [ALICE, own]), author: ALICE.lid }]);
    await sock.emit("group-participants.update", { id: NEW_GROUP, action: "remove", author: ALICE.lid, participants: [{ id: BOB.lid, phoneNumber: BOB.phone }] });
    sock.groups.set(NEW_GROUP, group(NEW_GROUP, [ALICE, BOB]));
    await bridge.chatInfo(NEW_GROUP);
    await bridge.participant(NEW_GROUP, ALICE.lid);
    await bridge.send({ chatId: NEW_GROUP, text: SECRET_TEXT, replyTo: "MSGGRP0001" });

    // The failure paths: every error message below quotes a fixture id and a name.
    const poison = () => new Error(`failed for ${ALICE.lid} ${ALICE.phone} Alice Fixture ${SECRET_TEXT}`);
    sock.sendError = poison();
    await bridge.send({ chatId: NEW_GROUP, text: SECRET_TEXT });
    sock.sendError = null;
    sock.metadataError = poison();
    await bridge.chatInfo(NEW_GROUP);
    await bridge.participant(NEW_GROUP, ALICE.lid);
    sock.metadataError = null;
    fake.lib.downloadError = poison();
    const photo = groupText({ id: "PHOTO" });
    photo.message = { imageMessage: { mimetype: "image/jpeg", fileLength: 5 } };
    await sock.emit("messages.upsert", upsertOf([photo]));
    await bridge.media(NEW_GROUP, "PHOTO");
    await sock.emit("messages.upsert", upsertOf([{ key: { remoteJid: ALICE.lid, id: "BAD" }, get message() { throw poison(); } }]));
    sock.sendPresenceUpdate = async () => { throw poison(); };
    await bridge.typing({ chatId: NEW_GROUP });
    await sock.emit("connection.update", { connection: "close", lastDisconnect: { error: Object.assign(poison(), { output: { statusCode: 428 } }) } });
  });

  assert.ok(rawLogCalls.length > 0, "the failure paths do log (states and codes)");
  const joined = `${streams}\n${JSON.stringify(rawLogCalls)}\n${lines.join("\n")}`;
  for (const needle of FIXTURE_NEEDLES) assert.ok(!joined.includes(needle), `leaked: ${needle}`);
  // Nothing in a log line is an id-shaped digit run.
  assert.ok(!/[0-9]{5,}/.test(lines.join("\n")), "no long digit run in any log line");
});
