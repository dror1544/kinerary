/**
 * The WhatsApp loop in the relay (spec 625, S3: AC-20 to AC-27, AC-32, AC-33), end to end
 * on loopback: the bridge stand-in -> the real loop -> the real gate -> the real connector
 * -> a fake gateway over a real WebSocket -> the connector's real scope check -> the
 * stand-in. Never real WhatsApp (tools/fake-whatsapp.ts). Fixture ids are test values.
 */
import assert from "node:assert/strict";
import { after, before, describe, test } from "node:test";
import type pg from "pg";
import { issueChatBindingCode } from "../src/chat-binding-codes.js";
import { buildJudgePrompt } from "../src/relay/group-judge.js";
import { SILENCE_SENTINEL, addressedMark, whatsappMark } from "../src/relay/stay-silent.js";
import { DEFAULT_STRINGS } from "../src/relay/dispatch.js";
import { WHATSAPP_WIRE_PLATFORM, rewriteMentions, whatsappSenderName } from "../src/relay/whatsapp/poller.js";
import { WhatsAppConfigError, whatsappRuntimeConfig } from "../src/relay/whatsapp/runtime.js";
import { FAKE_OWN } from "../tools/fake-whatsapp.js";
import { EDIT_REFUSED, PLATFORM_UNAVAILABLE, WHATSAPP_REFUSED, WHATSAPP_TIMEOUT, WHATSAPP_UNAVAILABLE } from "../src/relay/whatsapp/outbound.js";
import { hermesIsRetryable, hermesIsTimeout } from "./support/hermes-mirror.js";
import { minimalPdf } from "./support/minimal-pdf.js";
import { testDatabaseUrl } from "./support/test-database.js";
import { freshDatabase, mkMember, mkUser, openBinding as openFixtureBinding, setWhatsappSwitch } from "./support/whatsapp-fixture.js";
import {
  alias,
  bindGroup,
  bindPrivate,
  dialGateway,
  startRelay,
  waTrip,
  waitFor,
  type Relay,
} from "./support/whatsapp-relay-harness.js";

const SKIP = !testDatabaseUrl();

// Fixture participants: distinctive digits, so the AC-27 scan cannot be fooled by chance.
const ALICE = "731852946107733@lid";
const BOB = "731852946107744@lid";
const CAROL = "731852946107755@lid";
const NEW_GROUP = "120363098765432101@g.us";
/** An OLD-style group: its id carries its creator's number (a test value). */
const OLD_GROUP = "972541234987-1478000123@g.us";
/** A number written as an @mention in text, as older clients do. */
const TYPED_NUMBER = "972549876543";

const ALIAS_PRIVATE = /^wa_[0-9a-f]{32}@p$/;
const ALIAS_GROUP = /^wa_[0-9a-f]{32}@g$/;
const OPAQUE = /^wa_[0-9a-f]{32}$/;

// ── Pure pieces ──────────────────────────────────────────────────────────────────────────

describe("WhatsApp text never carries an id (spec 625, Sender ids)", () => {
  const own = new Set([FAKE_OWN.lid, FAKE_OWN.phone]);
  test("the number's own @mention, in either form, becomes the assistant's name; anyone else's becomes \"someone\"", () => {
    assert.equal(rewriteMentions("@100000000000099 where is the hotel?", [FAKE_OWN.lid], own, "Liv"), "Liv where is the hotel?");
    assert.equal(rewriteMentions("@200000000099 hi", [], own, "Liv"), "Liv hi");
    assert.equal(rewriteMentions(`ask @731852946107744 and @${TYPED_NUMBER}`, [BOB], own, "Liv"), "ask someone and someone");
    assert.equal(rewriteMentions("meet @+972549876543 at 10", [], own, "Liv"), "meet someone at 10");
    assert.equal(rewriteMentions("room @12 at 9", [], own, "Liv"), "room @12 at 9", "a short number after @ is not an id");
  });
  test("a display name that is a number is empty, never the number", () => {
    assert.equal(whatsappSenderName("+972 54-123 4987"), null);
    assert.equal(whatsappSenderName("Alice"), "Alice");
    assert.equal(whatsappSenderName("  Dana\n2024 "), "Dana 2024");
    assert.equal(whatsappSenderName(""), null);
  });
});

describe("AC-20: no relay.whatsapp block, no WhatsApp", () => {
  test("absent: nothing is built and no secret is even read", async () => {
    let reads = 0;
    const config = await whatsappRuntimeConfig(undefined, async () => { reads += 1; return "x"; });
    assert.equal(config, null);
    assert.equal(reads, 0);
  });
  const block = { bridge_url: "http://127.0.0.1:4390", bridge_secret_ref: "env://A", sender_id_secret_ref: "env://B", number: "15550100123", code_ttl_seconds: 900, code_attempts_per_hour: 5 };
  const secrets: Record<string, string> = { "env://A": "b".repeat(40), "env://B": "k".repeat(40) };
  test("present and valid: the URL is the bare loopback origin and both secrets are resolved", async () => {
    const config = await whatsappRuntimeConfig(block, async (ref) => secrets[ref]!);
    assert.deepEqual(config, { bridgeUrl: "http://127.0.0.1:4390", bridgeSecret: "b".repeat(40), senderKey: "k".repeat(40), codeAttemptsPerHour: 5 });
  });
  test("present but unusable: refuses to start, naming the field and never its value", async () => {
    const cases: Array<[Partial<typeof block>, Record<string, string>, RegExp]> = [
      [{ bridge_url: "http://localhost:4390" }, secrets, /bridge_url must be http:\/\/127\.0\.0\.1/],
      [{ bridge_url: "http://[::1]:4390" }, secrets, /bridge_url must be http:\/\/127\.0\.0\.1/],
      [{}, { ...secrets, "env://A": "short-secret" }, /bridge_secret_ref must resolve to at least 32 characters/],
      [{}, { ...secrets, "env://B": "short-key" }, /sender_id_secret_ref must resolve to at least 32 bytes/],
      [{}, { "env://A": "s".repeat(40), "env://B": "s".repeat(40) }, /must not resolve to the same value/],
    ];
    for (const [over, values, message] of cases) {
      const error = await whatsappRuntimeConfig({ ...block, ...over }, async (ref) => values[ref]!).then(() => null, (e: unknown) => e);
      assert.ok(error instanceof WhatsAppConfigError, `refused: ${message}`);
      assert.match((error as Error).message, message);
      for (const value of Object.values(values)) assert.ok(!(error as Error).message.includes(value), "the message never carries a secret");
    }
  });
});

describe("Per-platform wording (S3): WhatsApp turns only, Telegram byte-identical", () => {
  test("the addressed mark keeps its pinned prefix and says WhatsApp and plain text; Telegram's is unchanged", () => {
    const wa = addressedMark(undefined, "whatsapp");
    assert.ok(wa.startsWith("[addressed to you directly"));
    assert.match(wa, /WhatsApp/);
    assert.match(wa, /plain text/);
    assert.equal(addressedMark("kinerary_bot"), `[addressed to you directly — this message is for you; answer it. Never reply with ${SILENCE_SENTINEL} to it. In Telegram you are @kinerary_bot.]`);
  });
  test("the judge's prompt names WhatsApp only when told; absent, the Telegram prompt is what it was", () => {
    const base = { text: "hi", assistantNames: ["Liv"], language: "en" as const };
    assert.match(buildJudgePrompt({ ...base, platform: "whatsapp" }), /trip group chat on WhatsApp\./);
    assert.match(buildJudgePrompt(base), /trip group chat on Telegram\./);
    assert.equal(buildJudgePrompt(base), buildJudgePrompt({ ...base, platform: "telegram" }));
  });
});

describe("The WhatsApp error words, as Hermes' own classifier reads them (hermes-mirror)", () => {
  test("no refusal or outage word is one Hermes retries; a bridge timeout reads as a timeout, never re-sent", () => {
    for (const word of [PLATFORM_UNAVAILABLE, WHATSAPP_UNAVAILABLE, WHATSAPP_REFUSED, EDIT_REFUSED]) {
      assert.equal(hermesIsRetryable(word), false, `${word} must not be retryable`);
      assert.equal(hermesIsTimeout(word), false, `${word} is not a timeout`);
    }
    assert.equal(hermesIsTimeout(WHATSAPP_TIMEOUT), true);
    assert.equal(hermesIsRetryable(WHATSAPP_TIMEOUT), false, "a send that may have been delivered is never re-sent");
  });
});

// ── End to end ───────────────────────────────────────────────────────────────────────────

describe("the WhatsApp loop, end to end on the stand-in", { skip: SKIP }, () => {
  let pool: pg.Pool;
  before(async () => { pool = await freshDatabase(); });
  after(async () => { await pool?.end(); });

  /** One relay and one trip's gateway per test. */
  async function scene(options: { switchOn?: boolean; whatsappClient?: boolean } = {}) {
    // The fixture chats are the same in every test: each test starts with none of them bound.
    await pool.query("UPDATE control_plane.telegram_chat_bindings SET closed_at = now(), closed_reason = 'test_reset', transport_address = NULL, phone_last4 = NULL WHERE closed_at IS NULL");
    await pool.query("DELETE FROM control_plane.trip_person_links WHERE platform = 'whatsapp'");
    await pool.query("DELETE FROM control_plane.chat_binding_codes");
    const relay = await startRelay(pool, options.whatsappClient === false ? { whatsappClient: false } : {});
    const trip = await waTrip(pool, options.switchOn === false ? { switchOn: false } : {});
    const gateway = await dialGateway(relay.connector.address!, trip.profile);
    await waitFor(() => relay.connector.canReachProfile(trip.profile), 3000, "gateway connected");
    const done = async () => { gateway.close(); await relay.stop(); };
    return { relay, trip, gateway, done };
  }

  const sends = (relay: Relay) => relay.fake.control.sent().filter((c) => c.kind === "send");

  test("AC-23: a private message reaches the companion stamped with the PRIMARY platform, the alias and an opaque sender; the reply goes back through the bridge, converted", async () => {
    const { relay, trip, gateway, done } = await scene();
    try {
      await bindPrivate(pool, trip, ALICE);
      relay.fake.control.message({ chatId: ALICE, senderId: ALICE, senderName: "Alice", text: "where is the hotel?", messageId: "WAIN1" });
      const [frame] = await waitFor(() => gateway.inbound().length >= 1 && gateway.inbound(), 6000, "inbound frame");
      const event = frame!.event as { text: string; source: Record<string, unknown>; message_id: string };
      console.log(`EVIDENCE AC-23 inbound frame to the gateway: ${JSON.stringify(frame)}`);
      assert.equal(event.source.platform, WHATSAPP_WIRE_PLATFORM);
      assert.equal(event.source.platform, "telegram", "AC-0: a \"whatsapp\" stamp crashes Hermes on the wa_ alias");
      assert.equal(event.source.chat_id, alias.private(ALICE));
      assert.match(String(event.source.chat_id), ALIAS_PRIVATE);
      assert.match(String(event.source.user_id), OPAQUE);
      assert.equal(event.source.user_id, alias.sender(ALICE));
      assert.equal(event.source.user_name, "Alice");
      assert.equal(event.source.chat_type, "dm");
      assert.equal(event.source.profile, trip.profile);
      assert.equal(event.text, `${whatsappMark()}\n\nwhere is the hotel?`, "a private chat is addressed by construction: no addressed mark, only where it is (#655 G)");

      const result = await gateway.act({ op: "send", chat_id: event.source.chat_id, content: "The **hotel** is on rue de la Paix.", reply_to: event.message_id });
      console.log(`EVIDENCE AC-24 outbound send -> ${JSON.stringify(result)}; bridge recorded ${JSON.stringify(sends(relay))}`);
      assert.equal(result.success, true);
      const [sent] = sends(relay);
      assert.equal(sent!.chatId, ALICE, "the address comes from the binding row");
      assert.equal(sent!.text, "The *hotel* is on rue de la Paix.");
      assert.equal(sent!.replyTo, "WAIN1");
      assert.equal(sent!.quoted, true, "a message of the same chat is quoted");
      assert.equal(relay.telegram.calls.length, 0, "no Telegram call for a WhatsApp chat");
    } finally { await done(); }
  });

  test("AC-23: a group message that names the assistant is forwarded with the WhatsApp addressed mark; one that does not is held as overheard context and the judge is asked in WhatsApp's words", async () => {
    const { relay, trip, gateway, done } = await scene();
    try {
      await bindGroup(pool, trip, NEW_GROUP);
      relay.fake.control.message({ chatId: NEW_GROUP, senderId: BOB, senderName: "Bob", text: "I am so tired after the drive", messageId: "WAG1" });
      await relay.until("whatsapp.inbound_dropped", { reason: "NOT_ADDRESSED" });
      assert.equal(gateway.inbound().length, 0, "not addressed: nothing reaches the companion");
      assert.equal(relay.judge.inputs.length, 1);
      assert.equal(relay.judge.inputs[0]!.platform, "whatsapp");
      assert.match(buildJudgePrompt(relay.judge.inputs[0]!), /trip group chat on WhatsApp\./);

      relay.fake.control.message({ chatId: NEW_GROUP, senderId: ALICE, senderName: "Alice", text: "Liv, when is check-in?", messageId: "WAG2" });
      const [frame] = await waitFor(() => gateway.inbound().length >= 1 && gateway.inbound(), 6000, "addressed frame");
      const event = frame!.event as { text: string; source: Record<string, unknown> };
      assert.equal(event.source.chat_id, alias.group(NEW_GROUP));
      assert.match(String(event.source.chat_id), ALIAS_GROUP);
      assert.equal(event.source.chat_type, "group");
      assert.equal(event.source.platform, "telegram");
      assert.ok(event.text.startsWith("[overheard in the group since you last spoke"), "the overheard block leads, as on Telegram");
      assert.ok(event.text.includes("Bob: I am so tired after the drive"));
      assert.ok(event.text.includes(`${addressedMark(undefined, "whatsapp")}\n\nLiv, when is check-in?`));

      const result = await gateway.act({ op: "send", chat_id: alias.group(NEW_GROUP), content: "Check-in is at 15:00." });
      assert.equal(result.success, true);
      assert.equal(sends(relay)[0]!.chatId, NEW_GROUP);
    } finally { await done(); }
  });

  test("AC-23: a mention of the number addresses the companion, and reaches it as the assistant's name with no number in the text", async () => {
    const { relay, trip, gateway, done } = await scene();
    try {
      await bindGroup(pool, trip, NEW_GROUP);
      relay.fake.control.message({
        chatId: NEW_GROUP, senderId: ALICE, senderName: "Alice", messageId: "WAG3",
        text: `@100000000000099 can you ask @731852946107744 and @${TYPED_NUMBER} about dinner?`,
        mentionedIds: [FAKE_OWN.lid, BOB],
      });
      const [frame] = await waitFor(() => gateway.inbound().length >= 1 && gateway.inbound(), 6000, "frame");
      const text = (frame!.event as { text: string }).text;
      assert.ok(text.endsWith("Liv can you ask someone and someone about dinner?"), text);
      assert.ok(!/[0-9]{7,}/.test(text), "no id or number in the text");
    } finally { await done(); }
  });

  test("AC-21: a message in a chat with no binding gets nothing: no reply, no gateway, no model", async () => {
    const { relay, gateway, done } = await scene();
    try {
      relay.fake.control.message({ chatId: CAROL, senderId: CAROL, senderName: "Carol", text: "hello? who is this?", messageId: "WAU1" });
      relay.fake.control.message({ chatId: NEW_GROUP, senderId: CAROL, senderName: "Carol", text: "Liv where are we staying?", messageId: "WAU2" });
      await relay.until("whatsapp.inbound_dropped", { reason: "UNROUTED" }, 2);
      console.log(`EVIDENCE AC-21 unbound chats: frames to gateway=${gateway.inbound().length}, bridge sends=${JSON.stringify(relay.fake.control.sent())}, judge calls=${relay.judge.inputs.length}, drop lines=${JSON.stringify(relay.events("whatsapp.inbound_dropped"))}`);
      assert.equal(gateway.inbound().length, 0);
      assert.deepEqual(relay.fake.control.sent(), []);
      assert.equal(relay.judge.inputs.length, 0);
    } finally { await done(); }
  });

  test("AC-22: a bound chat whose trip has the switch off gets nothing inbound, and every outbound action for it is CHAT_NOT_IN_SCOPE", async () => {
    const { relay, trip, gateway, done } = await scene({ switchOn: false });
    try {
      await bindPrivate(pool, trip, ALICE);
      await bindGroup(pool, trip, NEW_GROUP);
      relay.fake.control.message({ chatId: ALICE, senderId: ALICE, text: "hi Liv", messageId: "WAS1" });
      relay.fake.control.message({ chatId: NEW_GROUP, senderId: ALICE, text: "Liv, hello", messageId: "WAS2" });
      await relay.until("whatsapp.inbound_dropped", { reason: "SWITCHED_OFF" }, 2);
      const results: Record<string, unknown>[] = [];
      for (const chat of [alias.private(ALICE), alias.group(NEW_GROUP)]) {
        for (const action of [
          { op: "send", chat_id: chat, content: "hello" },
          { op: "edit", chat_id: chat, message_id: "WAOUT1", content: "x" },
          { op: "typing", chat_id: chat },
          { op: "get_chat_info", chat_id: chat },
        ]) results.push(await gateway.act(action));
      }
      console.log(`EVIDENCE AC-22 switch off: frames=${gateway.inbound().length}; outbound results=${JSON.stringify(results)}; bridge calls=${JSON.stringify(relay.fake.control.sent())}`);
      assert.equal(gateway.inbound().length, 0);
      for (const r of results) assert.deepEqual(r, { success: false, error: "CHAT_NOT_IN_SCOPE" });
      assert.deepEqual(relay.fake.control.sent(), []);
      const refusal = relay.events("relay.outbound_out_of_scope")[0]!;
      assert.equal(refusal.reason, "platform_switched_off");
      assert.equal(refusal.chat_kind, "private", "chat_kind from chatKind(): a WhatsApp private chat logs as private");

      // On again: the same chat is served.
      await setWhatsappSwitch(pool, trip.tripId, true);
      assert.equal((await gateway.act({ op: "send", chat_id: alias.private(ALICE), content: "back" })).success, true);
    } finally { await done(); }
  });

  test("AC-24: a gateway cannot act in another trip's WhatsApp chat", async () => {
    const { relay, gateway, done } = await scene();
    try {
      const other = await waTrip(pool, { title: "Japan" });
      await bindPrivate(pool, other, BOB);
      const result = await gateway.act({ op: "send", chat_id: alias.private(BOB), content: "hello from the wrong trip" });
      console.log(`EVIDENCE AC-24 another trip's alias: ${JSON.stringify(result)}; bridge calls=${JSON.stringify(relay.fake.control.sent())}`);
      assert.deepEqual(result, { success: false, error: "CHAT_NOT_IN_SCOPE" });
      assert.deepEqual(relay.fake.control.sent(), []);
    } finally { await done(); }
  });

  test("AC-24: the silence verdict and the leak filter apply exactly as on Telegram; edit, typing and get_chat_info go through the bridge under the scope check", async () => {
    const { relay, trip, gateway, done } = await scene();
    try {
      await bindGroup(pool, trip, NEW_GROUP, "Family trip");
      const chat = alias.group(NEW_GROUP);
      assert.equal((await gateway.act({ op: "send", chat_id: chat, content: SILENCE_SENTINEL })).success, true);
      assert.equal((await gateway.act({ op: "send", chat_id: chat, content: "I'll call submit_answer_for_chat now" })).success, true);
      assert.deepEqual(sends(relay), [], "neither the sentinel nor a leak reaches the chat");

      const sent = await gateway.act({ op: "send", chat_id: chat, content: "Draft" });
      const edited = await gateway.act({ op: "edit", chat_id: chat, message_id: sent.message_id, content: "Final **answer**" });
      assert.equal(edited.success, true);
      const edit = relay.fake.control.sent().find((c) => c.kind === "edit")!;
      assert.equal(edit.text, "Final *answer*");
      assert.equal((await gateway.act({ op: "typing", chat_id: chat })).success, true);
      assert.ok(relay.fake.control.sent().some((c) => c.kind === "typing" && c.chatId === NEW_GROUP));
      relay.fake.control.group({ chatId: NEW_GROUP, title: "Family trip", participants: [ALICE, BOB, FAKE_OWN.lid] });
      const info = await gateway.act({ op: "get_chat_info", chat_id: chat });
      assert.deepEqual(info, { success: true, name: "Family trip", type: "group" }, "a title and a type; never an id or a participant");

      relay.fake.control.message({ chatId: NEW_GROUP, senderId: BOB, text: "random chatter", messageId: "WAINBOB" });
      await relay.until("whatsapp.inbound_dropped", { reason: "NOT_ADDRESSED" });
      const notOurs = await gateway.act({ op: "edit", chat_id: chat, message_id: "WAINBOB", content: "rewritten" });
      assert.deepEqual(notOurs, { success: false, error: "EDIT_REFUSED" }, "an edit only of a message the number sent");
      assert.equal(relay.fake.control.sent().filter((c) => c.kind === "edit").length, 1);
    } finally { await done(); }
  });

  test("AC-25: a command is dropped without a reply and never reaches a gateway", async () => {
    const { relay, trip, gateway, done } = await scene();
    try {
      await bindPrivate(pool, trip, ALICE);
      relay.fake.control.message({ chatId: ALICE, senderId: ALICE, text: "/trips", messageId: "WAC1" });
      relay.fake.control.message({ chatId: ALICE, senderId: ALICE, text: "/start abc", messageId: "WAC2" });
      await relay.until("whatsapp.inbound_dropped", { reason: "COMMAND" }, 2);
      assert.equal(gateway.inbound().length, 0);
      assert.deepEqual(relay.fake.control.sent(), []);
    } finally { await done(); }
  });

  test("AC-26: media joins a turn only under the gate's rules, and nothing is downloaded for a message that did not join one", async () => {
    const { relay, trip, gateway, done } = await scene();
    try {
      await bindGroup(pool, trip, NEW_GROUP);
      const pdf = minimalPdf(["Hotel Colmar, check-in 15:00"]).toString("base64");
      const mediaRequests = () => relay.fake.control.requests().filter((r) => r.path.startsWith("/media/"));
      // A photo with no caption, and Bob's document: not addressed. Nothing downloaded.
      relay.fake.control.message({ chatId: NEW_GROUP, senderId: BOB, messageId: "WAPHOTO", media: { kind: "image", mime: "image/jpeg", base64: Buffer.from([0xff, 0xd8, 0xff, 0x00]).toString("base64") } });
      relay.fake.control.message({ chatId: NEW_GROUP, senderId: BOB, messageId: "WABOBDOC", media: { kind: "document", mime: "application/pdf", filename: "bob.pdf", base64: pdf } });
      relay.fake.control.message({ chatId: NEW_GROUP, senderId: ALICE, messageId: "WAALICEDOC", media: { kind: "document", mime: "application/pdf", filename: "plan.pdf", base64: pdf } });
      await relay.until("trip_bot.attachment_held", {}, 2);
      assert.equal(mediaRequests().length, 0, "nothing downloaded for a message that did not join a turn");

      // Alice addresses the companion: HER held document joins, Bob's does not.
      relay.fake.control.message({ chatId: NEW_GROUP, senderId: ALICE, text: "Liv, add this to the plan", messageId: "WAADD" });
      const [frame] = await waitFor(() => gateway.inbound().length >= 1 && gateway.inbound(), 6000, "frame");
      const event = frame!.event as { media?: { filename?: string }[]; media_urls?: string[] };
      assert.deepEqual(event.media?.map((m) => m.filename), ["plan.pdf"]);
      assert.equal(event.media_urls?.length, 1);
      assert.deepEqual(mediaRequests().map((r) => r.path.split("/").at(-1)), ["WAALICEDOC"], "exactly the joined document was fetched");

      // A reply to her own document, addressed, brings it; a reply to Bob's does not.
      relay.fake.control.message({ chatId: NEW_GROUP, senderId: ALICE, text: "Liv what does this say?", messageId: "WAQ1", quotedMessageId: "WAALICEDOC", quotedParticipant: ALICE });
      await waitFor(() => gateway.inbound().length >= 2, 6000, "second frame");
      assert.deepEqual((gateway.inbound()[1]!.event as { media?: { filename?: string }[] }).media?.map((m) => m.filename), ["plan.pdf"]);
      relay.fake.control.message({ chatId: NEW_GROUP, senderId: ALICE, text: "Liv and this one?", messageId: "WAQ2", quotedMessageId: "WABOBDOC", quotedParticipant: BOB });
      await waitFor(() => gateway.inbound().length >= 3, 6000, "third frame");
      assert.equal((gateway.inbound()[2]!.event as { media?: unknown[] }).media, undefined, "another person's document never joins");
      assert.ok(!mediaRequests().some((r) => r.path.endsWith("/WABOBDOC") || r.path.endsWith("/WAPHOTO")));
    } finally { await done(); }
  });

  test("AC-32: a bridge that is logged out or unreachable is one state line each way; WhatsApp actions fail with one result each; Telegram keeps working; WhatsApp resumes when the bridge is connected", async () => {
    const { relay, trip, gateway, done } = await scene();
    try {
      await bindPrivate(pool, trip, ALICE);
      const tgChat = "-1005550001";
      await openFixtureBinding(pool, { tripId: trip.tripId, chatId: tgChat, platform: "telegram", profile: trip.profile });

      relay.fake.control.setState("logged_out");
      const failed = [
        await gateway.act({ op: "send", chat_id: alias.private(ALICE), content: "one" }),
        await gateway.act({ op: "send", chat_id: alias.private(ALICE), content: "two" }),
        await gateway.act({ op: "typing", chat_id: alias.private(ALICE) }),
      ];
      const telegram = await gateway.act({ op: "send", chat_id: tgChat, content: "Telegram is fine" });
      console.log(`EVIDENCE AC-32 bridge logged out: whatsapp results=${JSON.stringify(failed)} telegram=${JSON.stringify(telegram)} state lines=${JSON.stringify(relay.events("whatsapp.bridge_state"))}`);
      for (const r of failed) assert.deepEqual(r, { success: false, error: "WHATSAPP_UNAVAILABLE" });
      assert.equal(telegram.success, true);
      assert.deepEqual(relay.telegram.sent, [{ chatId: tgChat, text: "Telegram is fine" }]);

      // Unreachable for a while, then back.
      relay.fake.control.failNext({ path: "/messages", status: 500, times: 3 });
      relay.fake.control.setState("connected");
      await relay.until("whatsapp.bridge_state", { state: "connected" }, 2);
      relay.fake.control.message({ chatId: ALICE, senderId: ALICE, text: "are you back?", messageId: "WAR1" });
      await waitFor(() => gateway.inbound().length >= 1, 6000, "resumed");
      const states = relay.events("whatsapp.bridge_state").map((e) => e.state);
      console.log(`EVIDENCE AC-32 state changes, in order: ${JSON.stringify(states)}`);
      for (let i = 1; i < states.length; i += 1) assert.notEqual(states[i], states[i - 1], "only CHANGES are logged");
      assert.ok(states.includes("logged_out"));
      assert.equal(states.at(-1), "connected");
      assert.equal(states.filter((s) => s === "logged_out").length, 1, "three failed actions, one line");
      assert.ok(states.filter((s) => s === "unavailable").length <= 1, "three failed polls in a row, at most one line");
    } finally { await done(); }
  });

  test("AC-20: an open WhatsApp binding on a relay with no WhatsApp client: every action PLATFORM_UNAVAILABLE, no Telegram call", async () => {
    const { relay, trip, gateway, done } = await scene({ whatsappClient: false });
    try {
      await bindGroup(pool, trip, NEW_GROUP);
      const chat = alias.group(NEW_GROUP);
      for (const action of [
        { op: "send", chat_id: chat, content: "hello" },
        { op: "edit", chat_id: chat, message_id: "X1", content: "x" },
        { op: "typing", chat_id: chat },
        { op: "get_chat_info", chat_id: chat },
      ]) assert.deepEqual(await gateway.act(action), { success: false, error: "PLATFORM_UNAVAILABLE" });
      assert.deepEqual(relay.telegram.calls, []);
    } finally { await done(); }
  });

  test("AC-8/AC-10 through the loop: a `me` code binds a private chat, an old-style group's code binds the group and introduces the companion, and the next message reaches the companion", async () => {
    const { relay, trip, gateway, done } = await scene();
    try {
      const me = await issueChatBindingCode(pool, { tripId: trip.tripId, userId: trip.ownerId, kind: "me" });
      assert.ok(me.ok);
      relay.fake.control.message({ chatId: ALICE, senderId: ALICE, senderName: "Dana", senderPhoneLast4: "4987", text: `Connect me: ${me.code}`, messageId: "WAK1" });
      await relay.until("whatsapp.code_attempt", { ok: true, kind: "me" });
      assert.deepEqual(sends(relay).map((s) => [s.chatId, s.text]), [[ALICE, "Connected to Alsace. You can ask me about the trip here."]]);
      const row = (await pool.query("SELECT chat_id, transport_address, phone_last4 FROM control_plane.telegram_chat_bindings WHERE chat_id = $1 AND closed_at IS NULL", [alias.private(ALICE)])).rows[0];
      assert.deepEqual(row, { chat_id: alias.private(ALICE), transport_address: ALICE, phone_last4: "4987" });
      assert.equal(gateway.inbound().length, 0, "a code never reaches the companion");

      const group = await issueChatBindingCode(pool, { tripId: trip.tripId, userId: trip.ownerId, kind: "group" });
      assert.ok(group.ok);
      relay.fake.control.group({ chatId: OLD_GROUP, title: "Grandma's group", participants: [ALICE, BOB, FAKE_OWN.lid] });
      relay.fake.control.message({ chatId: OLD_GROUP, senderId: BOB, text: group.code, messageId: "WAK2" });
      await relay.until("whatsapp.code_attempt", { ok: true, kind: "group" });
      const groupRow = (await pool.query("SELECT chat_id, chat_title, transport_address FROM control_plane.telegram_chat_bindings WHERE transport_address = $1 AND closed_at IS NULL", [OLD_GROUP])).rows[0];
      assert.deepEqual(groupRow, { chat_id: alias.group(OLD_GROUP), chat_title: "Grandma's group", transport_address: OLD_GROUP });
      const intro = sends(relay).find((s) => s.chatId === OLD_GROUP)!;
      assert.match(intro.text, /I read this group's messages only to know when someone is talking to me\./);
      assert.ok(!intro.text.includes("hunter2-secret"), "never the site password");

      // The same code again, in the same group: spent already, so a fixed refusal.
      relay.fake.control.message({ chatId: OLD_GROUP, senderId: BOB, text: group.code, messageId: "WAK3" });
      await relay.until("whatsapp.code_attempt", { ok: false }, 1);
      assert.equal(sends(relay).filter((s) => s.chatId === OLD_GROUP).at(-1)!.text, "That code did not work. Make a new one from the trip's WhatsApp page.");

      relay.fake.control.message({ chatId: OLD_GROUP, senderId: BOB, text: "Liv what time is dinner?", messageId: "WAK4" });
      const [frame] = await waitFor(() => gateway.inbound().length >= 1 && gateway.inbound(), 6000, "frame after bind");
      assert.equal((frame!.event as { source: { chat_id: string } }).source.chat_id, alias.group(OLD_GROUP));
    } finally { await done(); }
  });

  test("AC-27: after a scenario full of numbers and mentions, no log line, gateway frame, judge input or database row holds a WhatsApp id or number, except transport_address", async () => {
    const { relay, trip, gateway, done } = await scene();
    try {
      // The owner connects privately; an old-style group (its id carries its creator's number) binds by code.
      const me = await issueChatBindingCode(pool, { tripId: trip.tripId, userId: trip.ownerId, kind: "me" });
      assert.ok(me.ok);
      relay.fake.control.message({ chatId: ALICE, senderId: ALICE, senderName: "Dana", senderPhoneLast4: "4987", text: me.code, messageId: "WAP1" });
      await relay.until("whatsapp.code_attempt", { ok: true, kind: "me" });
      const group = await issueChatBindingCode(pool, { tripId: trip.tripId, userId: trip.ownerId, kind: "group" });
      assert.ok(group.ok);
      relay.fake.control.group({ chatId: OLD_GROUP, title: "Cousins", participants: [ALICE, BOB, CAROL, FAKE_OWN.lid] });
      relay.fake.control.message({ chatId: OLD_GROUP, senderId: BOB, text: `here: ${group.code}`, messageId: "WAP2" });
      await relay.until("whatsapp.code_attempt", { ok: true, kind: "group" });
      // Chatter with mentions (judged, held as overheard), a sender whose name is their number, then an addressed turn.
      relay.fake.control.message({ chatId: OLD_GROUP, senderId: CAROL, senderName: "+972 54 987 6543", text: `@${TYPED_NUMBER} call @731852946107744 please`, mentionedIds: [BOB], messageId: "WAP3" });
      await relay.until("whatsapp.inbound_dropped", { reason: "NOT_ADDRESSED" });
      relay.fake.control.message({ chatId: OLD_GROUP, senderId: CAROL, senderName: "+972 54 987 6543", text: "@100000000000099 ask @731852946107733 for the tickets", mentionedIds: [FAKE_OWN.lid, ALICE], messageId: "WAP4" });
      await waitFor(() => gateway.inbound().length >= 1, 6000, "addressed frame");
      relay.fake.control.message({ chatId: ALICE, senderId: ALICE, senderName: "Dana", text: `what about @${TYPED_NUMBER}?`, mentionedIds: [], messageId: "WAP5" });
      await waitFor(() => gateway.inbound().length >= 2, 6000, "private frame");
      await gateway.act({ op: "send", chat_id: alias.group(OLD_GROUP), content: "On it." });

      // Every WhatsApp id or number in the fixtures, as runs of seven digits (anything beyond phone_last4's four).
      const numbers = [ALICE, BOB, CAROL, OLD_GROUP, NEW_GROUP, FAKE_OWN.lid, FAKE_OWN.phone, TYPED_NUMBER, "972549876543"]
        .flatMap((id) => id.split(/[^0-9]+/).filter((d) => d.length >= 7));
      const windows = [...new Set(numbers.flatMap((d) => Array.from({ length: d.length - 6 }, (_, i) => d.slice(i, i + 7))))];
      const leaks = (haystack: string) => windows.filter((w) => haystack.includes(w));

      const dump = async (maskTransport: boolean) => {
        const tables = (await pool.query<{ table_name: string }>("SELECT table_name FROM information_schema.tables WHERE table_schema = 'control_plane' AND table_type = 'BASE TABLE'")).rows;
        const rows: string[] = [];
        for (const { table_name } of tables) {
          const r = await pool.query(`SELECT to_jsonb(t) AS row FROM control_plane."${table_name}" t`);
          for (const { row } of r.rows) {
            if (maskTransport && table_name === "telegram_chat_bindings") delete (row as Record<string, unknown>).transport_address;
            rows.push(`${table_name} ${JSON.stringify(row)}`);
          }
        }
        return rows.join("\n");
      };
      // The scan can fail: unmasked, it finds the old group's real id and the private chat's address in transport_address.
      const unmasked = await dump(false);
      assert.ok(leaks(unmasked).length > 0, "the scan must see the numbers where they legitimately rest");
      assert.ok(unmasked.includes(OLD_GROUP));

      const surfaces = {
        logs: relay.lines.join("\n"),
        // Every frame the gateway received, outbound_results (get_chat_info and the rest) included.
        frames: JSON.stringify(gateway.frames),
        judge: JSON.stringify(relay.judge.inputs),
        database: await dump(true),
      };
      console.log(`EVIDENCE AC-27 privacy scan over ${relay.lines.length} log lines, ${gateway.inbound().length} gateway frames, ${relay.judge.inputs.length} judge inputs, ${surfaces.database.split("\n").length} database rows (transport_address masked); windows checked=${windows.length}; findings=${JSON.stringify(Object.fromEntries(Object.entries(surfaces).map(([k, v]) => [k, leaks(v)])))}`);
      for (const [surface, text] of Object.entries(surfaces)) {
        assert.deepEqual(leaks(text), [], `${surface} carries a WhatsApp id or number`);
        assert.ok(!text.includes(OLD_GROUP), `${surface} carries the old group's real id`);
      }
      // The frames still carried the conversation.
      assert.ok(surfaces.frames.includes("Liv ask someone for the tickets"));
      assert.ok(surfaces.frames.includes("someone call someone please"), "the overheard chatter, rewritten");
      assert.ok(!surfaces.frames.includes("+972"), "a number-shaped display name is empty");
    } finally { await done(); }
  });

  test("AC-14 through the loop: a private chat whose account's membership has ended is closed before the turn, and the turn is not forwarded", async () => {
    const { relay, trip, gateway, done } = await scene();
    try {
      const member = await mkUser(pool, "Member");
      const membership = await mkMember(pool, trip.tripId, member, "member");
      await bindPrivate(pool, trip, BOB, { account: member });
      await pool.query("UPDATE control_plane.trip_memberships SET status = 'revoked' WHERE id = $1", [membership]);
      relay.fake.control.message({ chatId: BOB, senderId: BOB, text: "hi", messageId: "WAM1" });
      await relay.until("whatsapp.inbound_dropped", { reason: "MEMBERSHIP_ENDED" });
      assert.equal(gateway.inbound().length, 0);
      const closed = (await pool.query("SELECT closed_reason, transport_address FROM control_plane.telegram_chat_bindings WHERE chat_id = $1 ORDER BY created_at DESC LIMIT 1", [alias.private(BOB)])).rows[0];
      assert.deepEqual(closed, { closed_reason: "membership_ended", transport_address: null });
    } finally { await done(); }
  });

  test("owner's decision 2026-11-24: with the companion unreachable, a private message gets the gate's line through the bridge, as plain text (the full matrix is relay-whatsapp-companion-down.test.ts)", async () => {
    const { relay, trip, gateway, done } = await scene();
    try {
      await bindPrivate(pool, trip, ALICE);
      gateway.close();
      await waitFor(() => !relay.connector.canReachProfile(trip.profile), 3000, "gateway gone");
      relay.fake.control.message({ chatId: ALICE, senderId: ALICE, text: "hello, are you there?", messageId: "WAW1" });
      await relay.until("whatsapp.companion_notice", { sent: true });
      console.log(`EVIDENCE companion unreachable (never announced) -> bridge sends=${JSON.stringify(sends(relay).map((s) => ({ to: s.chatId === ALICE ? "<the chat>" : "<other>", text: s.text })))}`);
      assert.deepEqual(sends(relay).map((s) => [s.chatId, s.text]), [[ALICE, DEFAULT_STRINGS.companionPending]]);
    } finally { await done(); }
  });

  test("AC-18 / Build 6: an owner who connects a second number is told in the PREVIOUS chat, through the address captured at the close; when that send fails the notice falls back and nothing is retried on WhatsApp", async () => {
    const { relay, trip, done } = await scene();
    try {
      const first = await issueChatBindingCode(pool, { tripId: trip.tripId, userId: trip.ownerId, kind: "me" });
      assert.ok(first.ok);
      relay.fake.control.message({ chatId: ALICE, senderId: ALICE, text: first.code, messageId: "WAO1" });
      await relay.until("whatsapp.code_attempt", { ok: true, kind: "me" });
      const second = await issueChatBindingCode(pool, { tripId: trip.tripId, userId: trip.ownerId, kind: "me" });
      assert.ok(second.ok);
      relay.fake.control.message({ chatId: BOB, senderId: BOB, senderPhoneLast4: "7744", text: second.code, messageId: "WAO2" });
      await relay.until("whatsapp.code_attempt", { ok: true, kind: "me" }, 2);
      const toAlice = sends(relay).filter((s) => s.chatId === ALICE);
      console.log(`EVIDENCE Build 6 replaced-owner notice: to previous chat=${JSON.stringify(toAlice.map((s) => s.text))}; owner_notice lines=${JSON.stringify(relay.events("whatsapp.owner_notice"))}`);
      assert.equal(toAlice.length, 2, "the first connection's own reply, then the replaced notice");
      assert.match(toAlice[1]!.text!, /Your WhatsApp connection to "Alsace" was replaced by a new one \(the new number ends in 7744\)/);
      assert.deepEqual(relay.events("whatsapp.owner_notice").at(-1)?.channels, "whatsapp");
      const alice = (await pool.query("SELECT closed_reason, transport_address FROM control_plane.telegram_chat_bindings WHERE chat_id = $1 ORDER BY created_at DESC LIMIT 1", [alias.private(ALICE)])).rows[0];
      assert.deepEqual(alice, { closed_reason: "rebound_by_code", transport_address: null }, "the address was used from memory, after the row forgot it");

      // Again from a third number, with the bridge refusing both the reply and the notice.
      const third = await issueChatBindingCode(pool, { tripId: trip.tripId, userId: trip.ownerId, kind: "me" });
      assert.ok(third.ok);
      const before = sends(relay).length;
      relay.fake.control.failNext({ path: "/send", status: 500, times: 2 });
      relay.fake.control.message({ chatId: CAROL, senderId: CAROL, text: third.code, messageId: "WAO3" });
      await relay.until("whatsapp.code_attempt", { ok: true, kind: "me" }, 3);
      await relay.until("whatsapp.owner_notice", {}, 2);
      assert.equal(sends(relay).length, before, "nothing delivered, and nothing re-sent");
      assert.equal(relay.events("whatsapp.owner_notice").at(-1)?.channels, "dashboard_only", "no Telegram chat for this owner: the dashboard list shows it");
      assert.ok(relay.events("whatsapp.owner_notice_failed").some((e) => e.fallback === "telegram"));
      assert.ok(!relay.lines.join("\n").includes(BOB) && !relay.lines.join("\n").includes("731852946107744"), "the captured address is never logged");
    } finally { await done(); }
  });
});
