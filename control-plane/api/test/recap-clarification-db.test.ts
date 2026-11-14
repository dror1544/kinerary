/**
 * #413 — the message right after a document recap is about the recap, not the
 * question that happens to be on screen.
 *
 * Owner's gate-3 run, 2026-10-18 (`france-2026`): two tickets uploaded, the
 * second couple's names not read. "נוסעים אחרים" ("other travellers"), typed to
 * explain that, was saved as the ASSISTANT'S NAME — the recap is sent with
 * `say()`, which records no prompt, so the question on record as on screen was
 * the next one the router put under it, `bot_name`, and the reply to the recap
 * was read as its answer.
 *
 * These drive the REAL path end to end — a document upload, the recap, the
 * next question, then typed messages through `flushSettledInboundBursts` — with
 * only the edges faked: Telegram (a recorder) and the model (a scripted runner;
 * CI has no codex/claude CLI). Messages are short so #51's "read only in part"
 * notice does not fire.
 *
 * Which contract shape this exercises: the travellers are held as
 * `travelers.data` (the first ticket); the AC-2 additions arrive as `ops`
 * (`add_traveller`), the one write path for a held list (#206), so they are
 * previewed and applied on the confirming tap — not as a `phases[].planned` /
 * `phases[].venues` shape, which this change does not touch.
 */
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { describe, test } from "node:test";
import { fileURLToPath } from "node:url";
import pg from "pg";
import { applyMigrations } from "../src/migrations.js";
import { issueEnrollment } from "../src/enrollment.js";
import { answerCallbackData, startFromDeepLink } from "../src/chat-router.js";
import { answersForChat, getSessionForChat, INTAKE_QUESTIONS, queueInboundMessage } from "../src/interview.js";
import { setInterpretPath } from "../src/interpret.js";
import { advanceRouterOwnedQuestions, applyDecision, flushSettledInboundBursts } from "../src/relay/poller.js";
import { DEFAULT_STRINGS } from "../src/relay/dispatch.js";
import { uiString } from "../src/intake-copy.js";
import type { RunnerResult, StructuredModelRequest, StructuredModelRunner } from "../src/model-runner.js";
import { testDatabaseUrl, testPool } from "./support/test-database.js";

const databaseUrl = testDatabaseUrl();
const SKIP = !databaseUrl;
const migrationsDir = fileURLToPath(new URL("../../db/migrations/", import.meta.url));
const CHAT = "890000413";
const opts = { skip: SKIP ? "no CONTROL_PLANE_TEST_DATABASE_URL" : false };

const id = (prefix: string) => `${prefix}_${randomBytes(16).toString("hex")}`;

const TICKET = {
  name: "ticket.txt",
  body: "Flight ticket TLV to CDG\nBooking reference ABC123 departs 2026-12-01 arrives Paris\nPassenger: Dana Cohen\n",
  messageId: "401",
};

type Button = { text: string; callback_data: string };
class Recorder {
  readonly sent: { text: string; buttons: Button[] }[] = [];
  async sendMessage(p: { text: string; replyMarkup?: { inline_keyboard: Button[][] } }) {
    this.sent.push({ text: p.text, buttons: (p.replyMarkup?.inline_keyboard ?? []).flat() });
    return { ok: true as const, messageId: String(this.sent.length) };
  }
  async editMessageText() { return { ok: true as const }; }
  async sendChatAction() {}
  async answerCallbackQuery() {}
  async getChatInfo() { return null; }
  async getMe() { return { id: "7000000001", username: "KineraryTestBot" }; }
  async getUpdates() { return []; }
  async deleteWebhookIfPresent() {}
  get last() { return this.sent[this.sent.length - 1]!; }
}

class FakeMediaStore {
  private readonly items = new Map<string, { bytes: Buffer; mime: string; filename?: string }>();
  put(input: { bytes: Buffer; mime: string; filename?: string }): string {
    const key = randomBytes(8).toString("hex");
    this.items.set(key, input);
    return key;
  }
  get(key: string) { return this.items.get(key) ?? null; }
}

/** What the scripted reader says to the NEXT typed message, and every typed prompt it was shown. */
interface Script {
  typed: { proposals?: unknown[]; unclear?: unknown[]; ops?: unknown[] };
  prompts: string[];
}

function runnerFor(script: Script): StructuredModelRunner {
  return {
    describe: () => ({ provider: "scripted", model: "fixture-1" }),
    async run<T>(req: StructuredModelRequest<T>): Promise<RunnerResult<T>> {
      if (req.task === "interpret") {
        script.prompts.push(req.prompt);
        const value = { proposals: [], unclear: [], malformed: 0, ...script.typed };
        return { ok: true, value: value as never, attempts: 1, ms: 1 };
      }
      // The document: the first ticket, which names one passenger.
      const parsed = req.parse({
        proposals: [{
          questionId: "travelers",
          confidence: 0.95,
          value: { kind: "structured", dataJson: JSON.stringify([{ name: "Dana Cohen" }]) },
          evidence: "Passenger: Dana Cohen",
        }],
        unclear: [],
      });
      return parsed === null
        ? { ok: false, reason: "BAD_OUTPUT", attempts: 1, ms: 0 }
        : { ok: true, value: parsed, attempts: 1, ms: 0 };
    },
  };
}

interface Flow {
  pool: pg.Pool;
  telegram: Recorder;
  script: Script;
  deps: never;
  sessionId: string;
  logs: string[];
}

async function withRecapFlow(fn: (flow: Flow) => Promise<void>): Promise<void> {
  const pool = testPool();
  const client = await pool.connect();
  try {
    await client.query("DROP SCHEMA IF EXISTS control_plane CASCADE");
    await client.query("DROP TABLE IF EXISTS public.control_plane_schema_migrations");
    await applyMigrations(client, migrationsDir);
  } finally {
    client.release();
  }
  try {
    const userId = id("user");
    const tripId = id("trip");
    await pool.query("INSERT INTO control_plane.users(id, status, display_name) VALUES ($1, 'active', 'Owner')", [userId]);
    await pool.query("INSERT INTO control_plane.trips(id, slug, lifecycle_state) VALUES ($1, $2, 'draft')", [tripId, tripId.replace(/_/g, "-")]);
    await pool.query(
      "INSERT INTO control_plane.trip_memberships(id, trip_id, user_id, role, status) VALUES ($1, $2, $3, 'owner', 'active')",
      [id("memb"), tripId, userId],
    );
    const enrollment = await issueEnrollment(pool, userId, tripId, { enrollmentTtlSeconds: 3600 });
    assert.ok(enrollment.ok);
    const started = await startFromDeepLink(pool, CHAT, enrollment.token);
    assert.equal(started.kind, "started");
    await setInterpretPath(pool, CHAT, true);

    // Every required question answered but the travellers (the document gives
    // them) and the assistant's name: after the recap, `bot_name` is what the
    // router puts on screen, exactly as on 2026-10-18.
    for (const q of INTAKE_QUESTIONS.filter((x) => x.required && x.id !== "travelers" && x.id !== "bot_name")) {
      const answer = q.id === "organizer_identity" ? "Dana Cohen" : "x";
      await pool.query(
        `UPDATE control_plane.intake_sessions SET answers = answers || jsonb_build_object($2::text, $3::jsonb) WHERE telegram_chat_id = $1`,
        [CHAT, q.id, JSON.stringify({ kind: "text", schema_version: 3, text: answer })],
      );
    }

    const telegram = new Recorder();
    const script: Script = { typed: {}, prompts: [] };
    const logs: string[] = [];
    const media = new FakeMediaStore();
    const deps = {
      db: pool,
      telegram,
      connector: { pushInbound: () => true },
      modelRunner: runnerFor(script),
      media: { telegram, store: media, baseUrl: "http://127.0.0.1:4312", log: () => {} },
      extractItinerary: async () => ({ ok: false as const, reason: "EXTRACT_NOT_CONFIGURED" as const }),
      log: (line: string) => logs.push(line),
    } as never;
    await fn({ pool, telegram, script, deps, sessionId: started.kind === "started" ? started.sessionId : "", logs });
  } finally {
    await pool.end();
  }
}

/** The first ticket, through the real document path, then the rest of that poll tick. */
async function uploadTicket(flow: Flow): Promise<void> {
  const media = new FakeMediaStore();
  const key = media.put({ bytes: Buffer.from(TICKET.body, "utf8"), mime: "text/plain", filename: TICKET.name });
  // The poller fetches the bytes from its own media store: hand it this one.
  (flow.deps as { media: { store: FakeMediaStore } }).media.store = media;
  await applyDecision(
    {
      kind: "interview_to_gateway",
      chatId: CHAT,
      sessionId: flow.sessionId,
      hadAttachment: true,
      event: {
        text: "",
        message_id: TICKET.messageId,
        message_type: "document",
        source: { chat_id: CHAT },
        media_urls: [`http://127.0.0.1:4312/relay/media/${key}`],
        media: [{ kind: "document", mime: "text/plain", size: Buffer.byteLength(TICKET.body), filename: TICKET.name }],
      },
    } as never,
    flow.deps,
  );
  const log = (line: string) => flow.logs.push(line);
  await flushSettledInboundBursts(flow.deps, log, 0);
  await advanceRouterOwnedQuestions(flow.deps, DEFAULT_STRINGS, log);
}

let seq = 0;
async function say(flow: Flow, text: string): Promise<void> {
  seq += 1;
  await queueInboundMessage(flow.pool, CHAT, { text, message_id: `t${seq}` } as never);
  await flushSettledInboundBursts(flow.deps, (line) => flow.logs.push(line), 0);
}

async function tap(flow: Flow, data: string): Promise<void> {
  seq += 1;
  await applyDecision(
    { kind: "interview_callback", chatId: CHAT, callbackQueryId: `cq${seq}`, data, sessionId: flow.sessionId } as never,
    flow.deps,
  );
}

async function travellerNames(flow: Flow): Promise<string[]> {
  const store = await answersForChat(flow.pool, CHAT);
  const a = store?.answers.travelers as { kind?: string; data?: { name: string }[] } | undefined;
  return a?.kind === "structured" ? (a.data ?? []).map((p) => p.name) : [];
}

async function botName(flow: Flow): Promise<string | undefined> {
  const store = await answersForChat(flow.pool, CHAT);
  const a = store?.answers.bot_name;
  return a?.kind === "text" ? a.text : undefined;
}

const asBotName = (text: string, confidence: number) => ({
  questionId: "bot_name", confidence, value: { kind: "text", text }, evidence: text,
});

describe("the message after a document recap (#413)", opts, () => {
  test("the recap marks itself, and bot_name is what the router put under it", async () => {
    await withRecapFlow(async (flow) => {
      await uploadTicket(flow);
      const recap = flow.telegram.sent.find((m) => m.text.startsWith(uiString("documentRead", "en")));
      assert.ok(recap, `the organizer is shown what was taken — sent: ${JSON.stringify(flow.telegram.sent.map((m) => m.text))}`);
      const view = await getSessionForChat(flow.pool, CHAT);
      assert.ok(view.ok);
      assert.match(view.ok ? view.view.lastPrompt ?? "" : "", /^q:bot_name/, "the setup is the live one: bot_name is on screen");
      assert.match(view.ok ? view.view.recapMarker ?? "" : "", /^recap:doc:interp_/, "and the recap is marked beside it");
      assert.deepEqual(await travellerNames(flow), ["Dana Cohen"]);
    });
  });

  test("after a document recap, \"other travellers\" is not the assistant's name", async () => {
    await withRecapFlow(async (flow) => {
      await uploadTicket(flow);
      // The reader's honest reading: it proposed the on-screen question at 0.4
      // (the exemption's whole reason to exist) and said the travellers are unclear.
      flow.script.typed = {
        proposals: [asBotName("נוסעים אחרים", 0.4)],
        unclear: [{ questionId: "travelers", why: "other travellers, no names" }],
      };
      await say(flow, "נוסעים אחרים");

      assert.equal(await botName(flow), undefined, "bot_name stays unanswered");
      assert.deepEqual(await travellerNames(flow), ["Dana Cohen"], "the held traveller is kept");
      assert.equal(flow.telegram.last.text, uiString("askOtherTravellers", "he"), "the reply asks for the other travellers' names");
      assert.ok(!flow.telegram.sent.some((m) => m.text.includes(uiString("gotIt", "he"))), "no 'got it' for a name that was never given");
      assert.match(flow.script.prompts.at(-1) ?? "", /JUST BEEN SHOWN WHAT THEIR DOCUMENT GAVE/, "the reader was told about the recap");
      const view = await getSessionForChat(flow.pool, CHAT);
      assert.ok(view.ok);
      assert.deepEqual(view.ok ? view.view.suggestions : null, {}, "and 'other travellers' is not kept as a name to confirm");
      assert.match(view.ok ? view.view.recapMarker ?? "" : "", /:asked$/, "the travellers question reopens the recap for one more message");
    });
  });

  test("names sent next are added to the held travellers", async () => {
    await withRecapFlow(async (flow) => {
      await uploadTicket(flow);
      flow.script.typed = {
        proposals: [asBotName("נוסעים אחרים", 0.4)],
        unclear: [{ questionId: "travelers", why: "other travellers, no names" }],
      };
      await say(flow, "נוסעים אחרים");

      flow.script.typed = {
        ops: [
          { op: "add_traveller", fields: { name: "Noa Cohen" } },
          { op: "add_traveller", fields: { name: "Ella Cohen" } },
        ],
      };
      await say(flow, "Noa Cohen, Ella Cohen");
      assert.match(flow.script.prompts.at(-1) ?? "", /JUST BEEN SHOWN WHAT THEIR DOCUMENT GAVE/, "still read as about the recap");
      assert.deepEqual(await travellerNames(flow), ["Dana Cohen"], "nothing is written before the confirming tap");
      assert.equal(await botName(flow), undefined);

      const yes = flow.telegram.last.buttons.find((b) => b.callback_data.startsWith("pc:") && b.callback_data.endsWith(":a"));
      assert.ok(yes, `a preview with a confirm button — sent: ${JSON.stringify(flow.telegram.last)}`);
      await tap(flow, yes!.callback_data);
      assert.deepEqual(await travellerNames(flow), ["Dana Cohen", "Noa Cohen", "Ella Cohen"], "the first ticket's traveller is unchanged, the new two are added");
      assert.equal(await botName(flow), undefined);
    });
  });

  test("after a document recap, a plain name still answers bot_name", async () => {
    await withRecapFlow(async (flow) => {
      await uploadTicket(flow);
      // Below the floor on purpose: the 2026-09-12 re-ask loop fix must hold.
      flow.script.typed = { proposals: [asBotName("Mira", 0.4)] };
      await say(flow, "Mira");
      assert.equal(await botName(flow), "Mira");
      assert.deepEqual(await travellerNames(flow), ["Dana Cohen"]);
      const view = await getSessionForChat(flow.pool, CHAT);
      assert.ok(view.ok);
      assert.equal(view.ok ? view.view.recapMarker : "x", null, "the marker was for one message");
    });
  });

  test("the marker is for ONE message: a later people-word is the second line of defence, not the recap", async () => {
    await withRecapFlow(async (flow) => {
      await uploadTicket(flow);
      flow.script.typed = { proposals: [] };
      await say(flow, "hmm");
      flow.script.typed = { proposals: [asBotName("other travellers", 0.4)] };
      await say(flow, "other travellers");
      assert.doesNotMatch(flow.script.prompts.at(-1) ?? "", /JUST BEEN SHOWN/, "no longer the turn after the recap");
      assert.equal(await botName(flow), undefined, "a people word below the floor is not saved");
      const view = await getSessionForChat(flow.pool, CHAT);
      assert.ok(view.ok);
      assert.deepEqual(Object.keys(view.ok ? view.view.suggestions : {}), ["bot_name"], "it is kept to be confirmed");
      assert.match(flow.telegram.last.text, /other travellers/, "and put back to them as 'is this right?'");
    });
  });

  test("a tap on an answer clears the marker", async () => {
    await withRecapFlow(async (flow) => {
      await uploadTicket(flow);
      const before = await getSessionForChat(flow.pool, CHAT);
      assert.ok(before.ok && before.view.recapMarker);
      await tap(flow, answerCallbackData("bot_gender", "male"));
      const after = await getSessionForChat(flow.pool, CHAT);
      assert.ok(after.ok);
      assert.equal(after.ok ? after.view.recapMarker : "x", null);
    });
  });
});
