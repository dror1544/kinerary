import { afterEach, describe, test } from "node:test";
import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import {
  createHttpWhatsAppClient,
  MAX_POLL_WAIT_MS,
  whatsappBridgeUrl,
  type WhatsAppClient,
} from "../src/relay/whatsapp/client.js";
import { FAKE_OWN, startFakeWhatsApp, type FakeWhatsApp } from "../tools/fake-whatsapp.js";

const SECRET = "client-test-secret-0123456789-abcdefgh";
const ALICE = "100000000000001@lid";
const GROUP = "120000000000000001@g.us";
const OLD_GROUP = "200000000001-1466483396@g.us";

const open: { close(): Promise<void> }[] = [];
afterEach(async () => {
  while (open.length) await open.pop()!.close();
});

async function withStandIn(options: { ring?: number; store?: number } = {}): Promise<{ fake: FakeWhatsApp; client: WhatsAppClient }> {
  const fake = await startFakeWhatsApp({ secret: SECRET, ringLimit: options.ring, storeLimit: options.store });
  open.push(fake);
  return { fake, client: createHttpWhatsAppClient({ baseUrl: fake.url, secret: SECRET, requestTimeoutMs: 2000 }) };
}

function jsonServer(handler: (url: string, auth: string | undefined) => { status: number; body: unknown; headers?: Record<string, string> }): Promise<{ url: string; hits: string[]; close(): Promise<void> }> {
  const hits: string[] = [];
  const server: Server = createServer((req, res) => {
    hits.push(`${req.url} auth=${req.headers.authorization ?? "none"}`);
    const out = handler(req.url ?? "", req.headers.authorization);
    res.writeHead(out.status, { "Content-Type": "application/json", ...(out.headers ?? {}) });
    res.end(JSON.stringify(out.body));
  });
  return new Promise((resolve) =>
    server.listen(0, "127.0.0.1", () => {
      const handle = {
        url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
        hits,
        close: () => new Promise<void>((r) => { server.closeAllConnections?.(); server.close(() => r()); }),
      };
      open.push(handle);
      resolve(handle);
    }),
  );
}

describe("whatsappBridgeUrl: loopback only", () => {
  // The bridge binds the literal 127.0.0.1. Anything that merely resolves or normalises to a loopback is a
  // different socket (`localhost` is ::1 first on some systems) and would receive the bearer secret.
  for (const ok of ["http://127.0.0.1:4320", "http://127.0.0.1:4320/", "http://127.0.0.1", "http://127.0.0.1:65535"]) {
    test(`accepts ${ok}`, () => assert.ok(whatsappBridgeUrl(ok).startsWith("http://127.0.0.1")));
  }
  const bad: [string, RegExp][] = [
    ["", /required/],
    ["   ", /required/],
    ["not a url", /not a URL/],
    ["https://127.0.0.1:4320", /http:\/\/127\.0\.0\.1/],
    ["http://localhost:4320", /http:\/\/127\.0\.0\.1/],
    ["http://[::1]:4320", /http:\/\/127\.0\.0\.1/],
    ["http://2130706433:4320", /http:\/\/127\.0\.0\.1/],
    ["http://127.1:4320", /http:\/\/127\.0\.0\.1/],
    ["http://0x7f.1:4320", /http:\/\/127\.0\.0\.1/],
    ["http://0x7f000001:4320", /http:\/\/127\.0\.0\.1/],
    ["http://127.0.0.01:4320", /http:\/\/127\.0\.0\.1/],
    ["http://127.000.000.001:4320", /http:\/\/127\.0\.0\.1/],
    ["http://017700000001:4320", /http:\/\/127\.0\.0\.1/],
    ["http://127.0.0.1.:4320", /http:\/\/127\.0\.0\.1/],
    ["http://[::ffff:127.0.0.1]:4320", /http:\/\/127\.0\.0\.1/],
    ["http://127.0.0.1:0", /http:\/\/127\.0\.0\.1/],
    ["http://127.0.0.1:99999", /(http:\/\/127\.0\.0\.1|not a URL)/],
    ["http://192.0.2.10:4320", /http:\/\/127\.0\.0\.1/],
    ["http://example.org:4320", /http:\/\/127\.0\.0\.1/],
    ["http://127.0.0.1.example.org:4320", /http:\/\/127\.0\.0\.1/],
    ["http://127.0.0.2:4320", /http:\/\/127\.0\.0\.1/],
    ["http://0.0.0.0:4320", /http:\/\/127\.0\.0\.1/],
    ["http://[::]:4320", /http:\/\/127\.0\.0\.1/],
    ["http://localhost.evil.example:4320", /http:\/\/127\.0\.0\.1/],
    ["http://user:pass@127.0.0.1:4320", /credentials/],
    ["http://127.0.0.1:4320/api", /bare origin/],
    ["http://127.0.0.1:4320/?x=1", /bare origin/],
    ["http://127.0.0.1:4320/#frag", /bare origin/],
  ];
  for (const [url, pattern] of bad) test(`refuses ${JSON.stringify(url)}`, () => assert.throws(() => whatsappBridgeUrl(url), pattern));

  test("the client refuses a non-loopback URL or a short secret at construction, not at first use", () => {
    assert.throws(() => createHttpWhatsAppClient({ baseUrl: "http://192.0.2.10:1", secret: SECRET }), /127\.0\.0\.1/);
    assert.throws(() => createHttpWhatsAppClient({ baseUrl: "http://localhost:1", secret: SECRET }), /127\.0\.0\.1/);
    assert.throws(() => createHttpWhatsAppClient({ baseUrl: "http://127.0.0.1:1", secret: "short" }), /32 characters/);
    assert.throws(() => createHttpWhatsAppClient({ baseUrl: "http://127.0.0.1:1", secret: `${SECRET} with space` }), /whitespace/);
  });
});

describe("the client against the stand-in", () => {
  test("health: state and the number's own ids in both forms", async () => {
    const { client } = await withStandIn();
    const out = await client.health();
    assert.ok(out.ok);
    assert.equal(out.value.state, "connected");
    assert.deepEqual(out.value.own, FAKE_OWN);
  });

  test("poll: no cursor means 'from now'; then events arrive in order with the cursor to ask next", async () => {
    const { fake, client } = await withStandIn();
    fake.control.message({ chatId: ALICE, text: "before the relay asked" });
    const first = await client.poll({}, { waitMs: 0 });
    assert.ok(first.ok);
    assert.deepEqual(first.value.events, []);
    assert.equal(first.value.lastSeq, 1);

    fake.control.message({ chatId: GROUP, senderId: ALICE, senderName: "Alice Fixture", text: "hello", mentionedIds: [FAKE_OWN.lid] });
    fake.control.added({ chatId: OLD_GROUP, addedBy: ALICE, title: "Old Fixture Group" });
    fake.control.left({ chatId: GROUP, participantId: ALICE });
    fake.control.title({ chatId: GROUP, title: "Renamed" });
    const next = await client.poll({ after: first.value.lastSeq, epoch: first.value.epoch }, { waitMs: 0 });
    assert.ok(next.ok);
    assert.equal(next.value.malformed, 0);
    assert.equal(next.value.ignored, 0);
    assert.deepEqual(next.value.events.map((e) => e.type), ["message", "added_to_group", "participant_left", "title_changed"]);
    const [msg, added] = next.value.events;
    assert.equal(msg!.type === "message" && msg.senderName, "Alice Fixture");
    assert.equal(msg!.type === "message" && msg.mentionedIds[0], FAKE_OWN.lid);
    assert.equal(added!.type === "added_to_group" && added.chatId, OLD_GROUP);
    assert.equal(added!.type === "added_to_group" && added.addedBy, ALICE);
    // Reading removes nothing: the same cursor returns the same batch.
    const again = await client.poll({ after: first.value.lastSeq, epoch: first.value.epoch }, { waitMs: 0 });
    assert.ok(again.ok && again.value.events.length === 4);
  });

  test("poll: an added_to_group with no addedBy parses, and addedBy stays absent", async () => {
    const { fake, client } = await withStandIn();
    fake.control.added({ chatId: GROUP });
    const out = await client.poll({ after: 0 }, { waitMs: 0 });
    assert.ok(out.ok);
    const [event] = out.value.events;
    assert.equal(event!.type, "added_to_group");
    assert.equal("addedBy" in event!, false);
  });

  test("poll: a batch cut at 100 hands back the cursor of its last event and more=true, so following lastSeq skips nothing", async () => {
    const { fake, client } = await withStandIn({ ring: 500 });
    for (let i = 1; i <= 230; i += 1) fake.control.message({ chatId: ALICE, text: `m${i}`, messageId: `B${i}` });
    const seen: string[] = [];
    let cursor = 0;
    let rounds = 0;
    for (;;) {
      const out = await client.poll({ after: cursor }, { waitMs: 0 });
      assert.ok(out.ok);
      seen.push(...out.value.events.flatMap((e) => (e.type === "message" ? [e.messageId] : [])));
      rounds += 1;
      if (!out.value.more) break;
      cursor = out.value.lastSeq;
    }
    assert.equal(rounds, 3);
    assert.deepEqual(seen, Array.from({ length: 230 }, (_, i) => `B${i + 1}`));
  });

  test("poll: a ring overflow is a count, a restarted bridge (new epoch) is read as 'everything is new'", async () => {
    const { fake, client } = await withStandIn({ ring: 2 });
    for (let i = 0; i < 4; i += 1) fake.control.message({ chatId: ALICE, text: `m${i}` });
    const overflow = await client.poll({ after: 1 }, { waitMs: 0 });
    assert.ok(overflow.ok);
    assert.equal(overflow.value.lost, 1);
    const restarted = await client.poll({ after: 99, epoch: "an-older-epoch" }, { waitMs: 0 });
    assert.ok(restarted.ok);
    assert.equal(restarted.value.events.length, 2);
  });

  test("poll: the request outlives the long-poll wait, so an idle poll is not an outage", async () => {
    const fake = await startFakeWhatsApp({ secret: SECRET });
    open.push(fake);
    // The per-request timeout is far shorter than the wait; a poll must not use it.
    const client = createHttpWhatsAppClient({ baseUrl: fake.url, secret: SECRET, requestTimeoutMs: 100 });
    const out = await client.poll({ after: 0 }, { waitMs: 400 });
    assert.ok(out.ok, "an empty long-poll is a success");
    assert.deepEqual(out.value.events, []);
  });

  test("poll: the wait is clamped to what the bridge allows", async () => {
    const seen: string[] = [];
    const client = createHttpWhatsAppClient({
      baseUrl: "http://127.0.0.1:1",
      secret: SECRET,
      fetchImpl: (async (url: string) => {
        seen.push(url);
        return new Response(JSON.stringify({ epoch: "e", lastSeq: 0, lost: 0, events: [] }), { status: 200 });
      }) as unknown as typeof fetch,
    });
    await client.poll({ after: 0 }, { waitMs: 9_999_999 });
    assert.match(seen[0]!, new RegExp(`waitMs=${MAX_POLL_WAIT_MS}`));
  });

  test("poll: unknown event types are ignored and malformed ones are counted, never silently dropped", async () => {
    const good = { type: "title_changed", seq: 3, chatId: GROUP, title: "ok" };
    const events = [
      { type: "reaction", seq: 1 },
      { type: "message", seq: 2, chatId: "junk", senderId: ALICE, senderName: "", messageId: "m", text: "", timestamp: 1, fromMe: false, mentionedIds: [] },
      good,
      { type: "participant_left", seq: 4, chatId: GROUP, participantId: "200000000001@s.whatsapp.net" },
    ];
    const client = createHttpWhatsAppClient({
      baseUrl: "http://127.0.0.1:1",
      secret: SECRET,
      fetchImpl: (async () => new Response(JSON.stringify({ epoch: "e", lastSeq: 4, lost: 0, events }), { status: 200 })) as unknown as typeof fetch,
    });
    const out = await client.poll({ after: 0 }, { waitMs: 0 });
    assert.ok(out.ok);
    assert.deepEqual(out.value.events, [good]);
    assert.equal(out.value.ignored, 1);
    assert.equal(out.value.malformed, 2);
  });

  test("a sender the bridge could not resolve arrives as senderId null (unknown, not guessed)", async () => {
    const { fake, client } = await withStandIn();
    fake.control.message({ chatId: GROUP, senderId: null, text: "who said this", senderPhoneLast4: "0007" });
    const out = await client.poll({ after: 0 }, { waitMs: 0 });
    assert.ok(out.ok);
    const [event] = out.value.events;
    assert.equal(event!.type === "message" && event.senderId, null);
    assert.equal(event!.type === "message" && event.senderPhoneLast4, "0007");
  });

  test("media: bytes on demand for an old-format group id too; gone is not_found; over the cap is too_large", async () => {
    const { fake, client } = await withStandIn({ store: 2 });
    const bytes = Buffer.from("fake-pdf-bytes");
    const id = fake.control.message({ chatId: OLD_GROUP, senderId: ALICE, media: { kind: "document", mime: "application/pdf", filename: "t.pdf", base64: bytes.toString("base64") } });
    const got = await client.fetchMedia(OLD_GROUP, id);
    assert.ok(got.ok);
    assert.equal(got.value.mime, "application/pdf");
    assert.deepEqual(got.value.bytes, bytes);

    const small = await client.fetchMedia(OLD_GROUP, id, { maxBytes: 3 });
    assert.deepEqual(small, { ok: false, reason: "too_large", status: 413, detail: "too_large" });

    // Not that chat's message.
    const wrongChat = await client.fetchMedia(GROUP, id);
    assert.ok(!wrongChat.ok && wrongChat.reason === "not_found");
    // Pushed out of a store of 2.
    fake.control.message({ chatId: GROUP, senderId: ALICE, text: "a" });
    fake.control.message({ chatId: GROUP, senderId: ALICE, text: "b" });
    const dropped = await client.fetchMedia(OLD_GROUP, id);
    assert.ok(!dropped.ok && dropped.reason === "not_found" && dropped.detail === "gone");
  });

  test("media: a body larger than the cap is refused even when Content-Length lies", async () => {
    const client = createHttpWhatsAppClient({
      baseUrl: "http://127.0.0.1:1",
      secret: SECRET,
      fetchImpl: (async () => new Response(Buffer.alloc(50), { status: 200, headers: { "Content-Type": "image/png", "Content-Length": "5" } })) as unknown as typeof fetch,
    });
    const out = await client.fetchMedia(GROUP, "m", { maxBytes: 10 });
    assert.ok(!out.ok && out.reason === "too_large");
  });

  test("send: one messageId; a replyTo is quoted only in the same chat", async () => {
    const { fake, client } = await withStandIn();
    const inbound = fake.control.message({ chatId: GROUP, senderId: ALICE, text: "question" });
    const other = fake.control.message({ chatId: OLD_GROUP, senderId: ALICE, text: "elsewhere" });
    const quoted = await client.send({ chatId: GROUP, text: "answer", replyTo: inbound });
    assert.ok(quoted.ok && quoted.value.quoted === true && quoted.value.messageId.length > 0);
    const crossChat = await client.send({ chatId: GROUP, text: "answer 2", replyTo: other });
    assert.ok(crossChat.ok && crossChat.value.quoted === false);
    const plain = await client.send({ chatId: ALICE, text: "private answer" });
    assert.ok(plain.ok);
    assert.deepEqual(fake.control.sent().map((c) => [c.kind, c.chatId, c.quoted]), [
      ["send", GROUP, true],
      ["send", GROUP, false],
      ["send", ALICE, false],
    ]);
  });

  test("edit: only a message the number sent in that chat; a message of someone else is refused, an unknown one is not_found", async () => {
    const { fake, client } = await withStandIn();
    const theirs = fake.control.message({ chatId: GROUP, senderId: ALICE, text: "theirs" });
    const sent = await client.send({ chatId: GROUP, text: "mine" });
    assert.ok(sent.ok);
    assert.ok((await client.edit({ chatId: GROUP, messageId: sent.value.messageId, text: "mine, edited" })).ok);
    const refused = await client.edit({ chatId: GROUP, messageId: theirs, text: "no" });
    assert.ok(!refused.ok && refused.reason === "refused" && refused.detail === "not_own_message");
    const elsewhere = await client.edit({ chatId: OLD_GROUP, messageId: sent.value.messageId, text: "no" });
    assert.ok(!elsewhere.ok && elsewhere.reason === "not_found");
  });

  test("typing, chatInfo (title and size only) and isParticipant (yes, no, could-not-check)", async () => {
    const { fake, client } = await withStandIn();
    fake.control.group({ chatId: GROUP, title: "Family Fixture", participants: [ALICE, FAKE_OWN.lid] });

    assert.ok((await client.typing({ chatId: GROUP })).ok);
    assert.deepEqual(fake.control.sent().at(-1), { seq: 1, kind: "typing", chatId: GROUP, state: "composing" });

    const info = await client.chatInfo(GROUP);
    assert.deepEqual(info, { ok: true, value: { kind: "group", chatId: GROUP, title: "Family Fixture", size: 2 } });
    assert.deepEqual(await client.chatInfo(ALICE), { ok: true, value: { kind: "private", chatId: ALICE } });

    assert.deepEqual(await client.isParticipant(GROUP, ALICE), { ok: true, value: true });
    // The phone form is not a question the relay may ask: refused before any request is made.
    const phone = await client.isParticipant(GROUP, "200000000001@s.whatsapp.net");
    assert.ok(!phone.ok && phone.reason === "refused" && phone.detail === "bad_id");
    assert.deepEqual(await client.isParticipant(GROUP, "100000000000002@lid"), { ok: true, value: false });

    fake.control.membershipUnavailable(true);
    const unknown = await client.isParticipant(GROUP, ALICE);
    assert.ok(!unknown.ok && unknown.reason === "unavailable", "could not check is NOT 'false'");
  });
});

describe("ids are checked before any path or body is built from them", () => {
  const seen: string[] = [];
  const client = createHttpWhatsAppClient({
    baseUrl: "http://127.0.0.1:4320",
    secret: SECRET,
    fetchImpl: (async (url: string) => {
      seen.push(url);
      return new Response("{}", { status: 200 });
    }) as unknown as typeof fetch,
  });
  const refused = (out: { ok: boolean; reason?: string; detail?: string }) => out.ok === false && out.reason === "refused" && out.detail === "bad_id";

  test("a `..` or otherwise path-shaped id never becomes a URL: fetchMedia('..', 'health') makes no request", async () => {
    seen.length = 0;
    for (const [chat, message] of [["..", "health"], [GROUP, ".."], [GROUP, "a/b"], [GROUP, "a-b"], [GROUP, "x".repeat(129)], [GROUP, ""], ["status@broadcast", "M1"], ["200000000001@s.whatsapp.net", "M1"], [`${ALICE}/x`, "M1"]] as const) {
      assert.ok(refused(await client.fetchMedia(chat, message)), `${chat} ${message}`);
    }
    assert.deepEqual(seen, [], "no request was made for any of them");
  });

  test("every method refuses a bad id the same way, before any request", async () => {
    seen.length = 0;
    assert.ok(refused(await client.send({ chatId: "..", text: "x" })));
    assert.ok(refused(await client.send({ chatId: GROUP, text: "x", replyTo: "../health" })));
    assert.ok(refused(await client.send({ chatId: GROUP, text: "x", mentions: ["200000000001@s.whatsapp.net"] })));
    assert.ok(refused(await client.edit({ chatId: GROUP, messageId: "..", text: "x" })));
    assert.ok(refused(await client.edit({ chatId: "junk", messageId: "M1", text: "x" })));
    assert.ok(refused(await client.typing({ chatId: "../chat" })));
    assert.ok(refused(await client.chatInfo("..")));
    assert.ok(refused(await client.chatInfo("200000000001@s.whatsapp.net")));
    assert.ok(refused(await client.isParticipant("..", ALICE)));
    assert.ok(refused(await client.isParticipant(ALICE, ALICE)), "a participant question is about a group");
    assert.ok(refused(await client.isParticipant(GROUP, "..")));
    assert.ok(refused(await client.isParticipant(GROUP, "200000000001@s.whatsapp.net")));
    assert.deepEqual(seen, []);
  });

  test("well-formed ids still go through, percent-encoded", async () => {
    seen.length = 0;
    await client.fetchMedia(OLD_GROUP, "ABC123def");
    await client.isParticipant(GROUP, ALICE);
    assert.deepEqual(seen, [
      `http://127.0.0.1:4320/media/${encodeURIComponent(OLD_GROUP)}/ABC123def?maxBytes=20971520`,
      `http://127.0.0.1:4320/chat/${encodeURIComponent(GROUP)}/participant/${encodeURIComponent(ALICE)}`,
    ]);
  });
});

describe("the client never throws, and says which kind of failure it is", () => {
  test("nothing listening: unavailable (network)", async () => {
    const holder = await jsonServer(() => ({ status: 200, body: {} }));
    const url = holder.url;
    await holder.close();
    const client = createHttpWhatsAppClient({ baseUrl: url, secret: SECRET, requestTimeoutMs: 500 });
    for (const call of [
      () => client.health(),
      () => client.poll({ after: 0 }, { waitMs: 0 }),
      () => client.fetchMedia(GROUP, "m"),
      () => client.send({ chatId: GROUP, text: "x" }),
      () => client.edit({ chatId: GROUP, messageId: "m", text: "x" }),
      () => client.typing({ chatId: GROUP }),
      () => client.chatInfo(GROUP),
      () => client.isParticipant(GROUP, ALICE),
    ]) {
      const out = await call();
      assert.ok(!out.ok && out.reason === "unavailable" && out.detail === "network");
    }
  });

  test("a hung bridge: unavailable (timeout), promptly", async () => {
    const { fake } = await withStandIn();
    const client = createHttpWhatsAppClient({ baseUrl: fake.url, secret: SECRET, requestTimeoutMs: 150 });
    fake.control.failNext({ path: "/send", hang: true });
    const started = Date.now();
    const out = await client.send({ chatId: GROUP, text: "x" });
    assert.ok(!out.ok && out.reason === "unavailable" && out.detail === "timeout");
    assert.ok(Date.now() - started < 1500);
  });

  test("a 5xx is unavailable; a bridge that is not connected is unavailable and says its state", async () => {
    const { fake, client } = await withStandIn();
    fake.control.failNext({ path: "/send", status: 500 });
    const failed = await client.send({ chatId: GROUP, text: "x" });
    assert.ok(!failed.ok && failed.reason === "unavailable" && failed.status === 500);

    fake.control.setState("logged_out");
    const out = await client.send({ chatId: GROUP, text: "x" });
    assert.ok(!out.ok && out.reason === "unavailable" && out.status === 503 && out.detail === "unavailable");
    assert.equal(out.state, "logged_out", "the bridge's state is kept, not dropped");
    const health = await client.health();
    assert.ok(health.ok && health.value.state === "logged_out");
  });

  test("a wrong secret is unavailable (a configuration fault, loud in the detail) and the secret is never in a result", async () => {
    const { fake } = await withStandIn();
    const wrong = createHttpWhatsAppClient({ baseUrl: fake.url, secret: "a-different-secret-0123456789-abcdefgh", requestTimeoutMs: 1000 });
    const out = await wrong.health();
    assert.ok(!out.ok);
    assert.equal(out.reason, "unavailable");
    assert.equal(out.status, 401);
    assert.equal(out.detail, "unauthorized");
    assert.ok(!JSON.stringify(out).includes("a-different-secret"));
    assert.ok(fake.control.requests().every((r) => r.authorised === false));
  });

  test("a body of the wrong shape, or not JSON, is unavailable (bad_response), never a throw", async () => {
    for (const body of ['{"state":"connected"}', "not json", "[]", '{"state":"weird","epoch":"e","own":{"lid":null,"phone":null},"lastSeq":0,"buffered":0}']) {
      const client = createHttpWhatsAppClient({
        baseUrl: "http://127.0.0.1:1",
        secret: SECRET,
        fetchImpl: (async () => new Response(body, { status: 200 })) as unknown as typeof fetch,
      });
      const out = await client.health();
      assert.ok(!out.ok && out.reason === "unavailable" && out.detail === "bad_response", body);
    }
  });

  test("a fetch that throws anything is unavailable", async () => {
    const client = createHttpWhatsAppClient({
      baseUrl: "http://127.0.0.1:1",
      secret: SECRET,
      fetchImpl: (async () => {
        throw new Error(`boom with ${SECRET}`);
      }) as unknown as typeof fetch,
    });
    const out = await client.send({ chatId: GROUP, text: "x" });
    assert.ok(!out.ok && out.reason === "unavailable");
    assert.ok(!JSON.stringify(out).includes(SECRET));
  });

  test("the bridge's error text is never echoed: only a short token survives", async () => {
    const client = createHttpWhatsAppClient({
      baseUrl: "http://127.0.0.1:1",
      secret: SECRET,
      fetchImpl: (async () => new Response(JSON.stringify({ ok: false, error: `failed for ${ALICE} Alice Fixture`, state: "connected" }), { status: 502 })) as unknown as typeof fetch,
    });
    const out = await client.send({ chatId: GROUP, text: "x" });
    assert.ok(!out.ok);
    assert.equal(out.detail, "connected", "the free-text error is dropped; the state token is kept");
    assert.ok(!JSON.stringify(out).includes("100000000000001"));
  });

  test("a redirect is refused, so the bearer secret cannot follow it", async () => {
    const target = await jsonServer(() => ({ status: 200, body: { state: "connected" } }));
    const origin = await jsonServer(() => ({ status: 302, body: {}, headers: { Location: `${target.url}/health` } }));
    const client = createHttpWhatsAppClient({ baseUrl: origin.url, secret: SECRET, requestTimeoutMs: 1000 });
    const out = await client.health();
    assert.ok(!out.ok && out.reason === "unavailable");
    assert.deepEqual(target.hits, [], "the redirect target never saw the secret");
  });

  test("every request carries the bearer and goes only to the configured base", async () => {
    const calls: { url: string; auth: string | null }[] = [];
    const client = createHttpWhatsAppClient({
      baseUrl: "http://127.0.0.1:4320",
      secret: SECRET,
      fetchImpl: (async (url: string, init: RequestInit) => {
        calls.push({ url, auth: new Headers(init.headers).get("authorization") });
        return new Response("{}", { status: 200 });
      }) as unknown as typeof fetch,
    });
    await client.health();
    await client.send({ chatId: GROUP, text: "x" });
    await client.isParticipant(OLD_GROUP, ALICE);
    assert.ok(calls.every((c) => c.url.startsWith("http://127.0.0.1:4320/") && c.auth === `Bearer ${SECRET}`));
    // Ids contain @ and -, and travel percent-encoded.
    assert.equal(calls[2]!.url, `http://127.0.0.1:4320/chat/${encodeURIComponent(OLD_GROUP)}/participant/${encodeURIComponent(ALICE)}`);
  });
});
