/**
 * The per-person group conversation window, end to end (PR #406).
 *
 * The unit suites prove each piece: chat-router.test.ts the three SQL
 * functions, relay-dispatch.test.ts the gate, relay-connector.test.ts the
 * sentinel. None of them proves the pieces are WIRED to one another - that the
 * forward opens the window, that the companion's send over the real socket
 * renews it, that a sentinel dropped by the connector leaves the deadline where
 * it was, that an untagged message from Telegram's own update shape is judged
 * by the sender's id. This runs a family group through all of them.
 *
 * What is real: the Telegram update loop (startTripBotPoller), the router and
 * its gate (dispatchUpdate), the connector's WebSocket wire (RelayConnector),
 * the HTTP Telegram client, tools/fake-telegram.ts as a CHILD PROCESS spoken to
 * over HTTP exactly as the relay speaks to Telegram, and the control-plane
 * database with every migration applied.
 *
 * What is played: the people (fake-telegram's /_control API) and the companion
 * (`Companion` below - a WebSocket client doing what the Hermes gateway does on
 * the wire: take `inbound` frames, send `outbound` actions). What a companion's
 * MODEL decides to say, and whether it honours the silence rule, is verified
 * live, not here.
 *
 * Wiring note: relay/server.ts runs `main()` on import, so it cannot be loaded
 * by a test. The connector options below are copied from it (interviewChat,
 * setExpectsReply, renewConversation). If server.ts stops passing one of them
 * the production relay loses the feature and this test stays green - the
 * hand-back names that gap.
 *
 * Time: the window is judged by the database's now(). There is no clock to
 * inject without a source change, so expiry is played by ageing the row in SQL
 * (conversation_until into the past) - the same thing five real minutes do to
 * it.
 *
 * Needs the control-plane test database.
 */
import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { createServer } from "node:net";
import { fileURLToPath } from "node:url";
import { after, before, beforeEach, describe, test } from "node:test";
import pg from "pg";
import { WebSocket } from "ws";
import { renewCompanionConversation, resolveChatRoute, setCompanionExpectsReply } from "../src/chat-router.js";
import { applyMigrations } from "../src/migrations.js";
import { RelayConnector } from "../src/relay/connector.js";
import { GroupContext } from "../src/relay/group-context.js";
import { startTripBotPoller } from "../src/relay/poller.js";
import { makeUpgradeToken, type WireMessageEvent } from "../src/relay/protocol.js";
import { addressedMark, conversationMark, reactionAnswerMark, SILENCE_SENTINEL } from "../src/relay/stay-silent.js";
import { HttpTelegramClient } from "../src/relay/telegram-api.js";
import { testDatabaseUrl, testPool } from "./support/test-database.js";

const databaseUrl = testDatabaseUrl();
const SKIP = !databaseUrl;
const migrationsDir = fileURLToPath(new URL("../../db/migrations/", import.meta.url));
const apiDir = fileURLToPath(new URL("../", import.meta.url));

const GROUP = "-1003000777";
const PROFILE = "companion-colmar";
const SECRET = "group-window-e2e-secret";
const BOT_TOKEN = "123456:e2e-not-a-real-token";
const ANN = { id: "101", name: "Ann" };
const BEN = { id: "102", name: "Ben" };
const CLEO = { id: "103", name: "Cleo" };
const DAN = { id: "104", name: "Dan" };
type Person = typeof ANN;

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

async function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address() as { port: number };
      server.close(() => resolve(port));
    });
  });
}

async function waitFor<T>(get: () => T | undefined | Promise<T | undefined>, what: string, timeoutMs = 10_000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await get();
    if (value !== undefined) return value;
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await sleep(15);
  }
}

interface SentMessage {
  seq: number;
  kind: "send" | "edit";
  chatId: string;
  messageId: number;
  text: string;
}

/**
 * The companion's gateway, on the wire. Connects with a gateway token whose
 * identity IS the Hermes profile (the connector's exact-routing rule), records
 * every `inbound` frame, and sends `outbound` actions awaiting their result.
 */
class Companion {
  readonly inbound: WireMessageEvent[] = [];
  private readonly results = new Map<string, Record<string, unknown>>();
  private ws!: WebSocket;
  private n = 0;

  async connect(port: number): Promise<void> {
    this.ws = new WebSocket(`ws://127.0.0.1:${port}/relay`, {
      headers: { authorization: `Bearer ${makeUpgradeToken(PROFILE, SECRET, 3600)}` },
    });
    this.ws.on("message", (raw) => {
      for (const line of String(raw).split("\n")) {
        if (!line.trim()) continue;
        const frame = JSON.parse(line) as { type: string; event?: WireMessageEvent; requestId?: string; result?: Record<string, unknown> };
        if (frame.type === "inbound" && frame.event) this.inbound.push(frame.event);
        if (frame.type === "outbound_result" && frame.requestId) this.results.set(frame.requestId, frame.result ?? {});
      }
    });
    await new Promise<void>((resolve, reject) => {
      this.ws.once("open", () => resolve());
      this.ws.once("error", reject);
    });
  }

  close(): void {
    this.ws?.close();
  }

  /** One outbound action; resolves with the connector's result for it. */
  async act(action: Record<string, unknown>): Promise<Record<string, unknown>> {
    const requestId = `req_${++this.n}`;
    this.ws.send(JSON.stringify({ type: "outbound", requestId, action }) + "\n");
    return waitFor(() => this.results.get(requestId), `outbound result ${requestId}`);
  }

  say(content: string, extra: Record<string, unknown> = {}): Promise<Record<string, unknown>> {
    return this.act({ op: "send", chat_id: GROUP, content, ...extra });
  }

  /**
   * Everything the connector sent BEFORE this call has been received. Frames
   * on one socket arrive in order, so an `inbound` the relay pushed earlier is
   * already in `inbound` once this answer is back - which is what lets a test
   * assert that something did NOT arrive without sleeping and hoping.
   */
  barrier(): Promise<unknown> {
    return this.act({ op: "typing", chat_id: GROUP });
  }
}

describe("group conversation window - the real relay, a fake Telegram and a scripted companion", { skip: SKIP }, () => {
  let pool: pg.Pool;
  let telegramChild: ChildProcess;
  let telegramBase = "";
  let connector: RelayConnector;
  let stopPolling: () => void;
  const companion = new Companion();
  const groupContext = new GroupContext();
  const logs: string[] = [];
  let tripId = "";
  let botUsername = "";
  // The stand-in's record of what the bot sent outlives a test; each test reads from here.
  let sentFloor = 0;

  const count = (event: string) => logs.filter((l) => l.includes(`"event":"${event}"`)).length;
  /** The relay's own record of a group message it dropped: `trip_bot.ignored`, reason NOT_ADDRESSED. */
  const notAddressed = () => logs.filter((l) => l.includes('"event":"trip_bot.ignored"') && l.includes('"reason":"NOT_ADDRESSED"')).length;

  async function control(path: string, body?: unknown): Promise<any> {
    const res = await fetch(`${telegramBase}${path}`, body === undefined ? {} : {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body),
    });
    const json = (await res.json()) as { ok: boolean; result: unknown; description?: string };
    assert.equal(json.ok, true, `${path}: ${json.description ?? ""}`);
    return json.result;
  }

  /** Telegram's side of the group: what the relay has sent into it so far. */
  async function sent(chatId = GROUP): Promise<SentMessage[]> {
    const { messages } = await control(`/_control/sent?chatId=${encodeURIComponent(chatId)}&after=${sentFloor}`);
    return messages as SentMessage[];
  }

  /**
   * A member types in the group; resolves once the relay has FINISHED with the
   * update. Telegram drops an update only when the next getUpdates confirms it,
   * and the poller makes that call after handling the whole batch - so an empty
   * queue means dispatch and its forward are done. Then a barrier on the
   * companion's socket, so the forward (if any) has arrived.
   */
  async function type(person: Person, text: string, extra: Record<string, unknown> = {}, chatId = GROUP): Promise<void> {
    await control("/_control/message", { chatId, fromId: person.id, fromName: person.name, text, ...extra });
    await waitFor(async () => ((await control("/_control/health")).updatesQueued === 0 ? true : undefined), "the relay to finish the update");
    await companion.barrier();
  }

  /** What `type` just did to the companion: the inbound events it was handed. */
  function inboundAfter(mark: number): WireMessageEvent[] {
    return companion.inbound.slice(mark);
  }

  async function window(): Promise<{ ids: string[]; until: Date | null }> {
    const { rows } = await pool.query(
      "SELECT conversation_user_ids AS ids, conversation_until AS until FROM control_plane.telegram_chat_bindings WHERE chat_id = $1 AND closed_at IS NULL",
      [GROUP],
    );
    return { ids: rows[0].ids ?? [], until: rows[0].until };
  }

  async function secondsUntilClose(): Promise<number> {
    const { rows } = await pool.query(
      "SELECT EXTRACT(EPOCH FROM (conversation_until - now()))::float AS s FROM control_plane.telegram_chat_bindings WHERE chat_id = $1 AND closed_at IS NULL",
      [GROUP],
    );
    return rows[0].s ?? -Infinity;
  }

  /** Five real minutes pass: the same thing to the row as waiting would be. */
  async function ageWindow(secondsAgo: number): Promise<void> {
    await pool.query(
      "UPDATE control_plane.telegram_chat_bindings SET conversation_until = now() - make_interval(secs => $2::integer) WHERE chat_id = $1 AND closed_at IS NULL",
      [GROUP, secondsAgo],
    );
  }

  async function setWindowLeft(seconds: number): Promise<void> {
    await pool.query(
      "UPDATE control_plane.telegram_chat_bindings SET conversation_until = now() + make_interval(secs => $2::integer) WHERE chat_id = $1 AND closed_at IS NULL",
      [GROUP, seconds],
    );
  }

  before(async () => {
    pool = testPool();
    const client = await pool.connect();
    try {
      await client.query("DROP SCHEMA IF EXISTS control_plane CASCADE");
      await client.query("DROP TABLE IF EXISTS public.control_plane_schema_migrations");
      await applyMigrations(client, migrationsDir);
    } finally {
      client.release();
    }
    tripId = "trip_groupwindow0001";
    await pool.query(
      "INSERT INTO control_plane.trips(id, slug, lifecycle_state, assistant_names) VALUES ($1, 'colmar-window-e2e', 'draft', $2)",
      [tripId, ["ליב", "Liv"]],
    );
    // The group, and Ann's private chat with the same companion - a separate
    // binding row, so the group's window can be shown not to touch it.
    for (const chatId of [GROUP, ANN.id]) {
      await pool.query(
        "INSERT INTO control_plane.telegram_chat_bindings(id, chat_id, trip_id, hermes_profile) VALUES ('tcb_' || md5(random()::text), $1, $2, $3)",
        [chatId, tripId, PROFILE],
      );
    }

    // The Bot API stand-in, as its own process, on a free port.
    const port = await freePort();
    telegramBase = `http://127.0.0.1:${port}`;
    telegramChild = spawn(process.execPath, ["--import", "tsx", "tools/fake-telegram.ts", "--port", String(port)], {
      cwd: apiDir, stdio: ["ignore", "pipe", "inherit"],
    });
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("fake-telegram did not start")), 15_000);
      telegramChild.once("exit", (code) => reject(new Error(`fake-telegram exited ${code}`)));
      telegramChild.stdout!.on("data", (chunk) => {
        if (String(chunk).includes("fake_telegram.listening")) { clearTimeout(timer); resolve(); }
      });
    });

    const log = (line: string) => { logs.push(line); };
    const telegram = new HttpTelegramClient(BOT_TOKEN, log, telegramBase);
    // Copied from relay/server.ts - see the header.
    connector = new RelayConnector({
      gatewaySecrets: [SECRET],
      telegram,
      port: 0,
      log,
      interviewChat: async (chatId) => (await resolveChatRoute(pool, chatId)).kind === "interview",
      setExpectsReply: async (chatId, expects) => { await setCompanionExpectsReply(pool, chatId, expects); },
      renewConversation: async (chatId) => { await renewCompanionConversation(pool, chatId); },
    });
    await connector.listen();
    await companion.connect(connector.address!);
    await waitFor(() => (connector.canReachProfile(PROFILE) ? true : undefined), "the companion's gateway to register");

    const me = await telegram.getMe();
    assert.ok(me, "the stand-in answers getMe");
    botUsername = me!.username;
    stopPolling = startTripBotPoller({
      db: pool,
      telegram,
      connector,
      botIdentity: { username: me!.username, id: me!.id },
      groupContext,
      log,
    }, { longPollSeconds: 1, deliverIntervalMs: 250 });
  });

  after(async () => {
    stopPolling?.();
    companion.close();
    telegramChild?.kill();
    await connector?.close();
    await sleep(400); // let the poll loop observe `stopped` before its pool goes
    await pool?.end();
  });

  beforeEach(async () => {
    // Each test starts from a quiet group: no window, no pending "?", no overheard talk.
    await pool.query(
      `UPDATE control_plane.telegram_chat_bindings
          SET conversation_user_ids = NULL, conversation_until = NULL,
              awaiting_reply_since = NULL, awaiting_reply_floor_seconds = NULL
        WHERE chat_id = $1`,
      [GROUP],
    );
    await pool.query("UPDATE control_plane.trips SET companion_reply_capture_enabled = true WHERE id = $1", [tripId]);
    groupContext.take(GROUP);
    logs.length = 0;
    const { messages } = await control("/_control/sent");
    sentFloor = Math.max(0, ...(messages as SentMessage[]).map((m) => m.seq));
  });

  test("the harness itself: a named message is forwarded to the companion, in the right chat, from the right person", async () => {
    const mark = companion.inbound.length;
    await type(ANN, "Liv what time does the museum open");
    const [event, ...rest] = inboundAfter(mark);
    assert.ok(event, "the companion was handed the message");
    assert.equal(rest.length, 0);
    assert.equal(event.source.chat_id, GROUP);
    assert.equal(event.source.user_id, ANN.id);
    assert.equal(event.source.profile, PROFILE);
    assert.equal(
      event.text,
      `${addressedMark(botUsername)}\n\nLiv what time does the museum open`,
      "a message that named the companion carries the addressed mark (with the bot's handle) and nothing else",
    );
    assert.equal(count("trip_bot.conversation_window_hit"), 0, "and it did not come in through the window");
    assert.deepEqual((await window()).ids, [ANN.id], "the forward put Ann in the conversation");
  });

  test("1. named -> statement -> Ann's untagged follow-ups are forwarded, marked; the statement renewed the window", async () => {
    await type(ANN, "Liv what time does the museum open");

    // The companion answers with a STATEMENT (no question mark). Make the
    // window nearly closed first, so a renewal is visible as a jump.
    await setWindowLeft(20);
    const result = await companion.say("The museum opens at nine");
    assert.equal(result.success, true);
    assert.ok(typeof result.message_id === "string", "Telegram took it");
    const said = await sent();
    assert.equal(said.length, 1);
    assert.equal(said[0]!.text, "The museum opens at nine");
    assert.ok(await secondsUntilClose() > 280, "a delivered statement pushed the deadline back to about five minutes");

    for (const text of ["and is it far from the hotel", "also is it free for kids"]) {
      const mark = companion.inbound.length;
      await type(ANN, text);
      const [event] = inboundAfter(mark);
      assert.ok(event, `"${text}" reached the companion with no name`);
      assert.ok(event.text.startsWith(conversationMark()), "and carries the not-addressed-by-name mark");
      assert.ok(event.text.endsWith(text), "followed by what she said");
    }
    assert.equal(count("trip_bot.conversation_window_hit"), 2);
    assert.equal(count("trip_bot.reply_window_hit"), 0, "a statement leaves no question window behind");
  });

  test("2. Ben is not heard until he names the companion; then Ann and Ben both are; Cleo never is", async () => {
    await type(ANN, "Liv suggest a dinner place");
    await companion.say("There is a good winstub near the cathedral");

    let mark = companion.inbound.length;
    await type(BEN, "sounds nice to me");
    assert.equal(inboundAfter(mark).length, 0, "Ben talking inside Ann's window is the family talking: NOT_ADDRESSED");
    assert.equal(notAddressed(), 1, "and the relay logged it as dropped, not lost");
    assert.equal(count("trip_bot.conversation_window_hit"), 0);
    assert.deepEqual((await window()).ids, [ANN.id], "and it did not add him");

    mark = companion.inbound.length;
    await type(BEN, "Liv can you book it for six");
    const [named] = inboundAfter(mark);
    assert.ok(named, "naming the companion gets Ben through");
    assert.ok(named.text.includes("Liv can you book it for six"));
    assert.ok(!named.text.includes(conversationMark()), "and that message is not window-marked (it carries the addressed mark instead)");
    assert.ok(named.text.includes("Ben: sounds nice to me"), "the line he said before is carried as overheard background");
    assert.deepEqual((await window()).ids, [ANN.id, BEN.id], "Ben joined; nobody was displaced");

    await companion.say("Booked for six at seven");

    for (const person of [ANN, BEN]) {
      mark = companion.inbound.length;
      await type(person, `thanks from ${person.name}`);
      const [event] = inboundAfter(mark);
      assert.ok(event, `${person.name} is heard without the name now`);
      assert.ok(event.text.startsWith(conversationMark()));
      assert.equal(event.source.user_id, person.id);
    }

    mark = companion.inbound.length;
    const hitsBefore = count("trip_bot.conversation_window_hit");
    await type(CLEO, "can someone pass the bread");
    assert.equal(inboundAfter(mark).length, 0, "Cleo was never in the conversation");
    assert.equal(notAddressed(), 2);
    assert.equal(count("trip_bot.conversation_window_hit"), hitsBefore);
    assert.deepEqual((await window()).ids, [ANN.id, BEN.id]);
  });

  test("3. silence: the sentinel reaches no one and renews nothing; a sentinel inside a real answer is stripped", async () => {
    await type(ANN, "Liv how far is Strasbourg");
    await companion.say("About fifty minutes by train");
    const before = (await sent()).length;

    let mark = companion.inbound.length;
    await type(ANN, "ok so we will probably take the early one");
    assert.equal(inboundAfter(mark).length, 1, "forwarded, marked - the companion may judge it is not for it");

    // The companion decides it was not spoken to. Leave the window nearly
    // closed, so any renewal would be visible.
    await setWindowLeft(20);
    const idsBefore = (await window()).ids;
    const untilBefore = (await window()).until!.getTime();
    for (const reply of [SILENCE_SENTINEL, `  ${SILENCE_SENTINEL}\n`]) {
      const result = await companion.say(reply);
      assert.equal(result.success, true, "the companion's request still resolves");
    }
    assert.equal((await sent()).length, before, "nothing reached the group");
    assert.equal((await window()).until!.getTime(), untilBefore, "the deadline did not move");
    assert.deepEqual((await window()).ids, idsBefore, "nor the members");
    assert.equal(count("trip_bot.companion_stayed_silent"), 2);
    assert.equal(count("relay.reply_window_opened"), 0);

    // Silence did not close the conversation either: Ann is still heard.
    mark = companion.inbound.length;
    await type(ANN, "Liv actually what is the first train");
    assert.equal(inboundAfter(mark).length, 1);

    // The token mixed into a real answer is control syntax, not words.
    await companion.say(`The first train is at seven ${SILENCE_SENTINEL}`);
    const afterMixed = await sent();
    assert.equal(afterMixed.length, before + 1);
    assert.equal(afterMixed.at(-1)!.text, "The first train is at seven");
    assert.ok(afterMixed.every((m) => !m.text.includes("KINERARY_STAY_SILENT")), "the token never appeared in the chat");

    // ...and through an edit (a streamed reply edits a message into its end).
    const draft = await companion.say("Checking the timetable");
    await companion.act({ op: "edit", chat_id: GROUP, message_id: draft.message_id, content: SILENCE_SENTINEL });
    const all = await sent();
    assert.equal(all.filter((m) => m.kind === "edit").length, 0, "a sentinel edit is dropped too");
  });

  test("4. expiry: after five minutes untagged talk is ignored; a proactive post does not revive it; naming starts a fresh set", async () => {
    await type(ANN, "Liv hello");
    await type(BEN, "Liv hello from me too");
    assert.deepEqual((await window()).ids, [ANN.id, BEN.id]);
    await companion.say("Welcome both of you");

    await ageWindow(1); // one second past the deadline
    let mark = companion.inbound.length;
    await type(ANN, "one more thing about the museum");
    assert.equal(inboundAfter(mark).length, 0, "an expired window hears no one");
    assert.equal(notAddressed(), 1);
    assert.equal(count("trip_bot.conversation_window_hit"), 0);

    // The companion posts on its own hours later (a reminder): that must not
    // bring the old conversation back to life.
    await companion.say("Reminder - the train leaves at nine tomorrow");
    mark = companion.inbound.length;
    await type(BEN, "got it thanks");
    assert.equal(inboundAfter(mark).length, 0, "a send into a dead window does not renew it");
    assert.ok(await secondsUntilClose() < 0);

    // Ann addresses it again: a FRESH conversation, with only her in it.
    mark = companion.inbound.length;
    await type(ANN, "Liv what time is the train again");
    assert.equal(inboundAfter(mark).length, 1);
    assert.deepEqual((await window()).ids, [ANN.id], "Ben's stale membership did not survive the expiry");
    await companion.say("At nine");
    mark = companion.inbound.length;
    await type(BEN, "and the platform");
    assert.equal(inboundAfter(mark).length, 0, "Ben has to name it again");
  });

  test("5. a question opens the one-shot window for anyone; it is consumed by the first message; a statement closes it", async () => {
    // No conversation is open: the companion asks the group something on its own.
    await companion.say("Which restaurant do you prefer?");
    assert.deepEqual((await window()).ids, [], "a proactive send opens no conversation");
    assert.equal(count("relay.reply_window_opened"), 1);

    let mark = companion.inbound.length;
    await type(DAN, "the pizza place please");
    const [answer] = inboundAfter(mark);
    assert.ok(answer, "Dan, never addressed to it, answered its question and was heard");
    assert.ok(!answer.text.includes(conversationMark()), "an answer to its question is not marked");
    assert.equal(count("trip_bot.reply_window_hit"), 1);
    assert.equal(count("trip_bot.conversation_window_hit"), 0);

    mark = companion.inbound.length;
    await type(CLEO, "I would rather have tacos");
    assert.equal(inboundAfter(mark).length, 0, "one shot: the very next message took it");
    assert.equal(notAddressed(), 1);

    // (Carry-forward 3 of the PR: Dan answered, so Dan is now the partner.)
    mark = companion.inbound.length;
    await type(DAN, "and a salad for me");
    const [follow] = inboundAfter(mark);
    assert.ok(follow && follow.text.includes(conversationMark()), "Dan's next message rides his own window, marked");
    // Cleo's ignored remark rides along as overheard background, and that block leads the mark.
    assert.ok(follow.text.startsWith("[overheard in the group"));
    assert.ok(follow.text.includes("Cleo: I would rather have tacos"));
    assert.ok(follow.text.indexOf("[end of overheard]") < follow.text.indexOf(conversationMark()));

    // A question followed by a STATEMENT: the statement clears the question window.
    await companion.say("Is Friday good?");
    await companion.say("Never mind, I will check myself");
    mark = companion.inbound.length;
    await type(CLEO, "Friday is fine");
    assert.equal(inboundAfter(mark).length, 0, "the question was withdrawn");
  });

  test("6. a message sent while the companion is still working is forwarded: the window opened on the forward, not the answer", async () => {
    await type(ANN, "Liv plan Saturday for us");
    // The companion has said nothing yet.
    assert.deepEqual(await sent(), []);
    const mark = companion.inbound.length;
    await type(ANN, "we like old towns");
    const [event] = inboundAfter(mark);
    assert.ok(event, "the follow-up reached the companion while it was still on the first one");
    assert.ok(event.text.startsWith(conversationMark()));
    assert.ok(await secondsUntilClose() > 280, "and each forward re-opens the full window");
  });

  test("7. /help inside the window is the router's; Ann's private chat is its own conversation", async () => {
    await type(ANN, "Liv hi");
    await companion.say("Hello Ann");
    const before = (await sent()).length;

    let mark = companion.inbound.length;
    await type(ANN, "/help");
    assert.equal(inboundAfter(mark).length, 0, "a command is not handed to the companion");
    const after = await sent();
    assert.equal(after.length, before + 1, "the router answered in the group");
    assert.ok(after.at(-1)!.text.length > 0);

    // A direct message needs no window and is never marked; it does not
    // touch the group's conversation either.
    const groupBefore = await window();
    mark = companion.inbound.length;
    await control("/_control/message", { chatId: ANN.id, text: "hello from my phone" });
    await waitFor(async () => ((await control("/_control/health")).updatesQueued === 0 ? true : undefined), "the DM to be handled");
    await companion.barrier();
    const [dm] = inboundAfter(mark);
    assert.ok(dm, "the DM reached the companion");
    assert.equal(dm.source.chat_type, "dm");
    assert.equal(dm.text, "hello from my phone", "unmarked");
    assert.deepEqual(await window(), groupBefore, "the group's window is untouched by it");
    assert.equal(count("trip_bot.conversation_window_hit"), 0);
  });

  test("8. a trip that opted out of reply capture gets no window at all", async () => {
    await pool.query("UPDATE control_plane.trips SET companion_reply_capture_enabled = false WHERE id = $1", [tripId]);
    await type(ANN, "Liv hello");
    await companion.say("Hi");
    const mark = companion.inbound.length;
    await type(ANN, "and one more thing");
    assert.equal(inboundAfter(mark).length, 0, "the opt-out covers the conversation window too");
  });

  test("9. A3 of the staging run: an @mention of the bot reaches the companion marked explicit, with its handle; a sentinel back is dropped AND counted", async () => {
    const mark = companion.inbound.length;
    await type(ANN, `@${botUsername} איפה המלון ביחס למרכז העיר?`);
    const [event] = inboundAfter(mark);
    assert.ok(event, "the mention was forwarded");
    assert.ok(event.text.startsWith(addressedMark(botUsername)), "explicit marker first");
    assert.ok(event.text.includes(`@${botUsername}`), "the companion is told its own handle");
    assert.ok(event.text.endsWith("איפה המלון ביחס למרכז העיר?"));
    assert.ok(!event.text.includes(conversationMark()), "and it is not a window forward");

    // The defect itself: the companion answers the addressed turn with the sentinel.
    const before = (await sent()).length;
    const result = await companion.say(SILENCE_SENTINEL, { reply_to: event.message_id });
    assert.equal(result.success, true);
    assert.equal((await sent()).length, before, "still nothing is sent - there is no answer to invent");
    assert.equal(count("trip_bot.silence_on_addressed_turn"), 1, "but it is logged as a defect");
    assert.equal(count("trip_bot.companion_stayed_silent"), 1);

    // The same sentinel on a window forward is the ordinary, legitimate silence.
    await type(ANN, "ok so we will probably take the early one");
    const windowTurn = companion.inbound.at(-1)!;
    assert.ok(windowTurn.text.startsWith(conversationMark()));
    await companion.say(SILENCE_SENTINEL, { reply_to: windowTurn.message_id });
    assert.equal(count("trip_bot.silence_on_addressed_turn"), 1, "no new defect");
    assert.equal(count("trip_bot.companion_stayed_silent"), 2);
  });

  test("10. emoji: a laugh in the window is not forwarded; a thumbs-up to the companion's question is the answer; after a statement it is not", async () => {
    await type(ANN, "Liv suggest a dinner place");
    await companion.say("There is a good winstub near the cathedral");

    let mark = companion.inbound.length;
    await type(ANN, "😂");
    assert.equal(inboundAfter(mark).length, 0, "a bare laugh is a reaction: NOT_ADDRESSED");
    assert.equal(notAddressed(), 1);
    assert.equal(count("trip_bot.reaction_not_forwarded"), 1);

    mark = companion.inbound.length;
    await type(ANN, "👍");
    assert.equal(inboundAfter(mark).length, 0, "a thumbs-up to a statement is a reaction");

    // The companion asks a question: the "?" window is open, and a 👍 is consent.
    await companion.say("לעדכן את האתר?");
    mark = companion.inbound.length;
    await type(BEN, "👍");
    const [yes] = inboundAfter(mark);
    assert.ok(yes, "the thumbs-up reached the companion");
    assert.ok(yes.text.startsWith(reactionAnswerMark()), "told it answers the question");
    assert.ok(yes.text.endsWith("👍"));
    assert.equal(count("trip_bot.reply_window_hit"), 1);

    // One shot: the next 👍 finds no question pending.
    mark = companion.inbound.length;
    await type(CLEO, "👍");
    assert.equal(inboundAfter(mark).length, 0);
  });

  test("11. emoji-only Telegram reply to a companion question is addressed explicitly; to a statement it is not", async () => {
    let mark = companion.inbound.length;
    await type(DAN, "👍", { replyToMessageId: 5, replyToText: "Should I update the website?" });
    const [yes] = inboundAfter(mark);
    assert.ok(yes, "a thumbs-up replying to a question reached the companion");
    assert.ok(yes.text.startsWith(addressedMark(botUsername)));
    mark = companion.inbound.length;
    await type(DAN, "👍", { replyToMessageId: 6, replyToText: "Done, the website is updated." });
    assert.equal(inboundAfter(mark).length, 0, "a thumbs-up replying to a statement is a reaction");
  });
});
