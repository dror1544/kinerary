/**
 * #655 boundary review, round 1 (spec 625, S3b): the findings F1 to F5 and the gap G, each pinned by the reviewer's own
 * probe turned into a test. Bridge stand-in, real loop, real connector, fake gateway; never real WhatsApp. Fixture ids
 * are test values.
 */
import assert from "node:assert/strict";
import { after, before, describe, test } from "node:test";
import type pg from "pg";
import { issueChatBindingCode } from "../src/chat-binding-codes.js";
import { addressedMark, conversationMark, whatsappMark } from "../src/relay/stay-silent.js";
import { whatsappChatTitle, whatsappFilename, whatsappSenderName } from "../src/relay/whatsapp/text.js";
import { FAKE_OWN } from "../tools/fake-whatsapp.js";
import { minimalPdf } from "./support/minimal-pdf.js";
import { testDatabaseUrl } from "./support/test-database.js";
import { freshDatabase, openBinding } from "./support/whatsapp-fixture.js";
import { alias, bindGroup, bindPrivate, dialGateway, startRelay, waTrip, waitFor, type RelayOptions } from "./support/whatsapp-relay-harness.js";

const SKIP = !testDatabaseUrl();
const ALICE = "731852946107733@lid";
const BOB = "731852946107744@lid";
const GROUP = "120363098765432101@g.us";
const CODE_SHAPE = /KWA-[A-Z0-9]{8}/i;

describe("F4: free text never carries a number, in any script", () => {
  test("a display name made of non-ASCII digits is empty", () => {
    assert.equal(whatsappSenderName("٩٧٢٥٤٩٨٧٦٥٤٣"), null, "Arabic-Indic digits");
    assert.equal(whatsappSenderName("９７２５４９８７６５４３"), null, "full-width digits");
    assert.equal(whatsappSenderName("۹۷۲ ۵۴ ۹۸۷ ۶۵۴۳"), null, "Extended Arabic-Indic digits, spaced");
    assert.equal(whatsappSenderName("Dana"), "Dana");
  });
  test("a file name with a number in it is replaced by a neutral one with the same extension", () => {
    assert.equal(whatsappFilename("+972549876543.pdf", "document"), "document.pdf");
    assert.equal(whatsappFilename("IMG-20261124-WA0007.jpg", "image"), "photo.jpg");
    assert.equal(whatsappFilename("٩٧٢٥٤٩٨٧٦٥٤٣.pdf", "document"), "document.pdf");
    assert.equal(whatsappFilename("plan.pdf", "document"), "plan.pdf");
    assert.equal(whatsappFilename("9725498765431", "document"), "document");
  });
  test("a group title that is a number is no title", () => {
    assert.equal(whatsappChatTitle("+972 54 987 6543"), null);
    assert.equal(whatsappChatTitle("９７２５４９８７６５４３"), null);
    assert.equal(whatsappChatTitle("Cousins 2026"), "Cousins 2026");
  });
});

describe("#655 review findings, end to end on the stand-in", { skip: SKIP }, () => {
  let pool: pg.Pool;
  before(async () => { pool = await freshDatabase(); });
  after(async () => { await pool?.end(); });

  async function scene(options: RelayOptions & { gateway?: boolean } = {}) {
    await pool.query("UPDATE control_plane.telegram_chat_bindings SET closed_at = now(), closed_reason = 'test_reset', transport_address = NULL, phone_last4 = NULL WHERE closed_at IS NULL");
    await pool.query("DELETE FROM control_plane.trip_person_links WHERE platform = 'whatsapp'");
    await pool.query("DELETE FROM control_plane.chat_binding_codes");
    const relay = await startRelay(pool, options);
    const trip = await waTrip(pool);
    const gateway = await dialGateway(relay.connector.address!, trip.profile);
    await waitFor(() => relay.connector.canReachProfile(trip.profile), 3000, "gateway connected");
    return { relay, trip, gateway, done: async () => { gateway.close(); await relay.stop(); } };
  }

  // ── F1 ──

  test("F1 (reviewer's Q1): a live `me` code posted as a document caption in a bound group never reaches the companion, not even through a later reply to that document", async () => {
    const { relay, trip, gateway, done } = await scene();
    try {
      await bindGroup(pool, trip, GROUP);
      const me = await issueChatBindingCode(pool, { tripId: trip.tripId, userId: trip.ownerId, kind: "me" });
      assert.ok(me.ok);
      relay.fake.control.message({ chatId: GROUP, senderId: ALICE, senderName: "Dana", text: `connect me ${me.code}`, messageId: "LIVEDOC1", media: { kind: "document", mime: "application/pdf", filename: "plan.pdf", base64: minimalPdf(["x"]).toString("base64") } });
      await relay.until("whatsapp.code_attempt", { ok: false, reason: "WRONG_KIND" });
      relay.fake.control.message({ chatId: GROUP, senderId: ALICE, senderName: "Dana", text: "Liv what is in this file?", messageId: "LIVEREP1", quotedMessageId: "LIVEDOC1", quotedParticipant: ALICE, quotedText: `connect me ${me.code}` });
      const [frame] = await waitFor(() => gateway.inbound().length >= 1 && gateway.inbound(), 6000, "the reply's frame");
      const code = (await pool.query("SELECT state, expires_at > now() AS live FROM control_plane.chat_binding_codes WHERE kind = 'me'")).rows[0];
      console.log(`EVIDENCE F1 Q1 after the fix: frame=${JSON.stringify(frame)}; code row=${JSON.stringify(code)}; /media requests=${relay.fake.control.requests().filter((r) => r.path.startsWith("/media/")).length}`);
      assert.deepEqual(code, { state: "issued", live: true }, "the code is still live (WRONG_KIND does not spend it), which is why it must not travel");
      assert.ok(!CODE_SHAPE.test(JSON.stringify(gateway.frames)), "no frame carries the code");
      assert.equal((frame!.event as { media?: unknown }).media, undefined, "the code message's document is not remembered, so it never joins");
      assert.equal(relay.fake.control.requests().filter((r) => r.path.startsWith("/media/")).length, 0, "and it is never downloaded");
    } finally { await done(); }
  });

  test("F1: a code in plain text in a bound group never becomes overheard context, and a held document of the code's sender is untouched", async () => {
    const { relay, trip, gateway, done } = await scene();
    try {
      await bindGroup(pool, trip, GROUP);
      relay.fake.control.message({ chatId: GROUP, senderId: BOB, text: "my cousin said this works: KWA-ABCDEFGH", messageId: "PLAIN1" });
      await relay.until("whatsapp.code_attempt", { ok: false });
      relay.fake.control.message({ chatId: GROUP, senderId: BOB, text: "Let's go to Colmar tomorrow", messageId: "CHAT1" });
      await relay.until("whatsapp.inbound_dropped", { reason: "NOT_ADDRESSED" });
      relay.fake.control.message({ chatId: GROUP, senderId: ALICE, text: "Liv, what time does the market open? the code KWA-ZZZZZZZZ is for you", messageId: "ADDR0" });
      await relay.until("whatsapp.code_attempt", { ok: false }, 2);
      relay.fake.control.message({ chatId: GROUP, senderId: ALICE, text: "Liv, what time does the market open?", messageId: "ADDR1" });
      const [frame] = await waitFor(() => gateway.inbound().length >= 1 && gateway.inbound(), 6000, "the addressed frame");
      const text = (frame!.event as { text: string }).text;
      console.log(`EVIDENCE F1 plain-text code then an addressed turn: frame text=${JSON.stringify(text)}`);
      assert.ok(text.includes("Let's go to Colmar tomorrow"), "ordinary chatter is still overheard");
      assert.ok(!CODE_SHAPE.test(JSON.stringify(gateway.frames)), "no code in any frame, overheard block included");
      assert.equal(relay.judge.inputs.filter((i) => CODE_SHAPE.test(i.text)).length, 0, "and the judge never read one");
    } finally { await done(); }
  });

  test("F1: a reply that QUOTES a code (an addressed turn whose quoted text holds one) reaches the companion without it", async () => {
    const { relay, trip, gateway, done } = await scene();
    try {
      await bindGroup(pool, trip, GROUP);
      relay.fake.control.message({ chatId: GROUP, senderId: ALICE, text: "Liv is this right?", messageId: "QQ1", quotedMessageId: "SOMEOLD1", quotedParticipant: BOB, quotedText: "use KWA-QQQQQQQQ" });
      await waitFor(() => gateway.inbound().length >= 1, 6000, "frame");
      assert.ok(!CODE_SHAPE.test(JSON.stringify(gateway.frames)));
    } finally { await done(); }
  });

  // ── F2 ──

  test("F2 (reviewer's P1): a chat rebound to another trip between the scope check and the send gets nothing from the first trip's gateway", async () => {
    const chat = alias.private(ALICE);
    let fired = false;
    let tripB: { tripId: string; profile: string } | null = null;
    const { relay, trip, gateway, done } = await scene({
      wrapResolve: (orig) => async (id) => {
        const route = await orig(id);
        if (!fired && id === chat && tripB) {
          fired = true;
          await pool.query("UPDATE control_plane.telegram_chat_bindings SET closed_at = now(), closed_reason = 'rebound_by_code', transport_address = NULL, phone_last4 = NULL WHERE chat_id = $1 AND closed_at IS NULL", [chat]);
          await openBinding(pool, { tripId: tripB.tripId, chatId: chat, platform: "whatsapp", profile: tripB.profile, transportAddress: ALICE });
        }
        return route;
      },
    });
    try {
      tripB = await waTrip(pool, { title: "TripB" });
      await bindPrivate(pool, trip, ALICE);
      const result = await gateway.act({ op: "send", chat_id: chat, content: "trip A private content" });
      console.log(`EVIDENCE F2 P1 after the fix: send -> ${JSON.stringify(result)}; bridge sends=${JSON.stringify(relay.fake.control.sent())}`);
      assert.deepEqual(result, { success: false, error: "CHAT_NOT_IN_SCOPE" });
      assert.deepEqual(relay.fake.control.sent(), []);
      assert.deepEqual(await gateway.act({ op: "send", chat_id: chat, content: "again" }), { success: false, error: "CHAT_NOT_IN_SCOPE" }, "and in the steady state");
    } finally { await done(); }
  });

  // ── F3 ──

  test("F3 (reviewer's P3): while /health names no own id, no inbound event is handled, and that is said once", async () => {
    const { relay, trip, gateway, done } = await scene({
      waitReady: false,
      wrapClient: (c) => ({ ...c, health: async () => { const h = await c.health(); if (h.ok) h.value = { ...h.value, own: { lid: null, phone: null } }; return h; } }),
    });
    try {
      await bindGroup(pool, trip, GROUP);
      relay.fake.control.message({ chatId: GROUP, senderId: FAKE_OWN.lid, fromMe: false, text: "Liv says: the hotel is at 3pm", messageId: "OWN1" });
      relay.fake.control.message({ chatId: GROUP, senderId: ALICE, text: "Liv hello", messageId: "ALI1" });
      await new Promise((r) => setTimeout(r, 1500));
      await relay.loop.settled();
      const states = relay.events("whatsapp.bridge_state").map((e) => e.state);
      console.log(`EVIDENCE F3 P3 after the fix: frames=${gateway.inbound().length}; /messages requests=${relay.fake.control.requests().filter((r) => r.path === "/messages").length}; state lines=${JSON.stringify(states)}`);
      assert.equal(gateway.inbound().length, 0, "the number's own message is never read as someone else's");
      assert.equal(relay.fake.control.requests().filter((r) => r.path === "/messages").length, 0, "nothing is polled");
      assert.deepEqual(states, ["own_ids_unknown"], "one line, however many attempts");
    } finally { await done(); }
  });

  // ── F4 ──

  test("F4 (reviewer's P6): non-ASCII-digit names, a numeric file name and a numeric group title never reach the companion or the database", async () => {
    const { relay, trip, gateway, done } = await scene();
    try {
      await bindPrivate(pool, trip, ALICE);
      await bindGroup(pool, trip, GROUP, "Family");
      relay.fake.control.message({ chatId: ALICE, senderId: ALICE, senderName: "٩٧٢٥٤٩٨٧٦٥٤٣", text: "hi", messageId: "P6A" });
      relay.fake.control.message({ chatId: ALICE, senderId: ALICE, senderName: "９７２５４９８７６５４３", text: "hi2", messageId: "P6B" });
      relay.fake.control.message({ chatId: ALICE, senderId: ALICE, senderName: "Alice", text: "see file", messageId: "P6C", media: { kind: "document", mime: "application/pdf", filename: "+972549876543.pdf", base64: minimalPdf(["Day 1 Colmar"]).toString("base64") } });
      await waitFor(() => gateway.inbound().length >= 3, 8000, "3 frames");
      relay.fake.control.title({ chatId: GROUP, title: "+972 54 987 6543" });
      await relay.until("whatsapp.group_title_changed", {});
      relay.fake.control.group({ chatId: GROUP, title: "+972 54 987 6543", participants: [ALICE] });
      const info = await gateway.act({ op: "get_chat_info", chat_id: alias.group(GROUP) });
      const title = (await pool.query("SELECT chat_title FROM control_plane.telegram_chat_bindings WHERE chat_id = $1 AND closed_at IS NULL", [alias.group(GROUP)])).rows[0];
      const names = gateway.inbound().map((f) => (f.event as { source: { user_name: string | null } }).source.user_name);
      const media = gateway.inbound().map((f) => (f.event as { media?: { filename?: string }[] }).media?.map((m) => m.filename) ?? null);
      console.log(`EVIDENCE F4 P6 after the fix: user_names=${JSON.stringify(names)}; media filenames=${JSON.stringify(media)}; chat_title=${JSON.stringify(title)}; get_chat_info -> ${JSON.stringify(info)}`);
      assert.deepEqual(names, [null, null, "Alice"]);
      assert.deepEqual(media[2], ["document.pdf"]);
      assert.deepEqual(title, { chat_title: null });
      assert.deepEqual(info, { success: true, name: "", type: "group" });
    } finally { await done(); }
  });

  test("F4: a numeric title is not stored when a group binds, by adding the number or by a code", async () => {
    const { relay, trip, done } = await scene();
    try {
      const OWNER = "731852946108811@lid";
      await bindPrivate(pool, trip, OWNER, { account: trip.ownerId });
      relay.fake.control.added({ chatId: GROUP, addedBy: OWNER, title: "+972 54 987 6543" });
      await relay.until("whatsapp.added_to_group", { bound: true });
      const second = "120363098765400077@g.us";
      relay.fake.control.group({ chatId: second, title: "٩٧٢٥٤٩٨٧٦٥٤٣", participants: [OWNER, FAKE_OWN.lid] });
      const code = await issueChatBindingCode(pool, { tripId: trip.tripId, userId: trip.ownerId, kind: "group" });
      assert.ok(code.ok);
      relay.fake.control.message({ chatId: second, senderId: OWNER, text: code.code, messageId: "GC1" });
      await relay.until("whatsapp.code_attempt", { ok: true, kind: "group" });
      const titles = (await pool.query("SELECT chat_title FROM control_plane.telegram_chat_bindings WHERE chat_id = ANY($1) AND closed_at IS NULL", [[alias.group(GROUP), alias.group(second)]])).rows;
      assert.deepEqual(titles, [{ chat_title: null }, { chat_title: null }]);
      assert.ok(!JSON.stringify(relay.fake.control.sent()).includes("972"), "nor is one said back in the owner's notice");
    } finally { await done(); }
  });

  // ── F5 ──

  test("F5 (reviewer's P5): a hanging media fetch in chat A does not hold chat B", async () => {
    const { relay, trip, gateway, done } = await scene({ mediaTimeoutMs: 30_000 });
    try {
      await bindPrivate(pool, trip, ALICE);
      await bindPrivate(pool, trip, BOB);
      relay.fake.control.failNext({ path: "/media", hang: true });
      relay.fake.control.message({ chatId: ALICE, senderId: ALICE, text: "read this", messageId: "MEDA1", media: { kind: "document", mime: "application/pdf", filename: "a.pdf", base64: minimalPdf(["Day 1 Colmar"]).toString("base64") } });
      await waitFor(() => relay.fake.control.requests().some((r) => r.path.startsWith("/media/")), 5000, "chat A's fetch started");
      const t0 = Date.now();
      relay.fake.control.message({ chatId: BOB, senderId: BOB, text: "hello from bob", messageId: "BOB1" });
      await waitFor(() => gateway.inbound().some((f) => (f.event as { message_id: string }).message_id === "BOB1"), 5000, "chat B's frame");
      const ms = Date.now() - t0;
      console.log(`EVIDENCE F5 P5 after the fix: chat B reached the gateway ${ms}ms after it was sent, while chat A's media fetch hangs (fetch timeout 30000ms); chat A frames=${gateway.inbound().filter((f) => (f.event as { message_id: string }).message_id === "MEDA1").length}`);
      assert.ok(ms < 3000);
      assert.equal(gateway.inbound().filter((f) => (f.event as { message_id: string }).message_id === "MEDA1").length, 0, "chat A is still waiting on its fetch");
    } finally { await done(); }
  });

  test("F5: one chat's events stay in order", async () => {
    const { relay, trip, gateway, done } = await scene();
    try {
      await bindPrivate(pool, trip, ALICE);
      for (let i = 1; i <= 6; i += 1) relay.fake.control.message({ chatId: ALICE, senderId: ALICE, text: `message ${i}`, messageId: `ORD${i}` });
      await waitFor(() => gateway.inbound().length >= 6, 8000, "six frames");
      assert.deepEqual(gateway.inbound().map((f) => (f.event as { message_id: string }).message_id), ["ORD1", "ORD2", "ORD3", "ORD4", "ORD5", "ORD6"]);
    } finally { await done(); }
  });

  test("F5: once a chat is silenced for failed codes, more code-shaped messages cost no bridge call", async () => {
    const { relay, trip, done } = await scene({ codeAttemptsPerHour: 1 });
    try {
      await bindGroup(pool, trip, GROUP);
      for (let i = 0; i < 5; i += 1) relay.fake.control.message({ chatId: GROUP, senderId: BOB, text: `KWA-${"ABCDEFG"}${"HJKMN"[i]}`, messageId: `FLOOD${i}` });
      await relay.until("whatsapp.code_silenced", {}, 3);
      const chatCalls = relay.fake.control.requests().filter((r) => r.path.startsWith("/chat/")).length;
      console.log(`EVIDENCE F5 code flood: attempts=5, failures before silence=2, /chat requests=${chatCalls}, sends=${relay.fake.control.sent().length}`);
      assert.equal(chatCalls, 2, "only the two attempts before the chat was silenced asked the bridge");
    } finally { await done(); }
  });

  // ── G ──

  test("G: every turn forwarded from a WhatsApp chat says WhatsApp and plain text, once: a private turn, a judged group turn, an addressed one", async () => {
    const { relay, trip, gateway, done } = await scene();
    try {
      await bindPrivate(pool, trip, ALICE);
      await bindGroup(pool, trip, GROUP);
      relay.fake.control.message({ chatId: ALICE, senderId: ALICE, text: "where is the hotel?", messageId: "G1" });
      await waitFor(() => gateway.inbound().length >= 1, 6000, "private frame");
      relay.judge.verdict = "yes";
      relay.fake.control.message({ chatId: GROUP, senderId: BOB, text: "what time is check in tomorrow", messageId: "G2" });
      await waitFor(() => gateway.inbound().length >= 2, 6000, "judged frame");
      relay.fake.control.message({ chatId: GROUP, senderId: ALICE, text: "Liv, and check out?", messageId: "G3" });
      await waitFor(() => gateway.inbound().length >= 3, 6000, "addressed frame");
      const texts = gateway.inbound().map((f) => (f.event as { text: string }).text);
      console.log(`EVIDENCE G frame texts=${JSON.stringify(texts)}`);
      assert.equal(texts[0], `${whatsappMark()}\n\nwhere is the hotel?`);
      assert.equal(texts[1], `${conversationMark()}\n\n${whatsappMark()}\n\nwhat time is check in tomorrow`, "the conversation mark keeps its place at the front");
      assert.ok(texts[2]!.endsWith(`${addressedMark(undefined, "whatsapp")}\n\nLiv, and check out?`), "the addressed mark already says WhatsApp");
      for (const t of texts) assert.equal(t.split("WhatsApp").length - 1, 1, "said once per turn");
    } finally { await done(); }
  });
});
