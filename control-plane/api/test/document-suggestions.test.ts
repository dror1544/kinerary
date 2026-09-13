/**
 * A document's unsure reading, end to end: an upload read on the interpret
 * path, a model unsure of one answer, and what the organizer sees.
 *
 * The gate's half is unit-tested in interpret.test.ts and the buttons' half in
 * relay-poller.test.ts. What only this can show is that the document path
 * actually KEEPS the reading, says so instead of "found nothing", and that the
 * next question the router draws is the one carrying it.
 *
 * Two chats, for the reason interpret-db.test.ts gives: a test with one chat
 * passes just as happily against code that ignores the chat id.
 */
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { describe, test } from "node:test";
import { fileURLToPath } from "node:url";
import pg from "pg";
import { applyMigrations } from "../src/migrations.js";
import { issueEnrollment } from "../src/enrollment.js";
import { startFromDeepLink } from "../src/chat-router.js";
import { answersForChat, getSessionForChat, queueInboundMessage } from "../src/interview.js";
import { setInterpretPath } from "../src/interpret.js";
import { fakeRunner } from "../src/model-runner.js";
import { MediaStore } from "../src/relay/media-store.js";
import { advanceRouterOwnedQuestions, flushSettledInboundBursts, renderDueRouterPrompts } from "../src/relay/poller.js";
import { DEFAULT_STRINGS } from "../src/relay/dispatch.js";
import { uiString } from "../src/intake-copy.js";
import { testDatabaseUrl } from "./support/test-database.js";

const databaseUrl = testDatabaseUrl();
const SKIP = !databaseUrl;
const migrationsDir = fileURLToPath(new URL("../../db/migrations/", import.meta.url));

const testId = (prefix: string) => `${prefix}_${randomBytes(16).toString("hex")}`;

class Recorder {
  readonly sent: { chatId: string; text: string; buttonData: string[] }[] = [];
  async sendMessage(params: { chatId: string; text: string; replyMarkup?: { inline_keyboard: { callback_data: string }[][] } }) {
    this.sent.push({
      chatId: params.chatId,
      text: params.text,
      buttonData: (params.replyMarkup?.inline_keyboard ?? []).flat().map((b) => b.callback_data),
    });
    return { ok: true, messageId: String(this.sent.length) };
  }
  async editMessageText() { return { ok: true }; }
  async sendChatAction() {}
  async answerCallbackQuery() {}
}

async function seed(pool: pg.Pool, chatId: string): Promise<void> {
  const userId = testId("user");
  const tripId = testId("trip");
  await pool.query("INSERT INTO control_plane.users(id, status, display_name) VALUES ($1, 'active', 'Owner')", [userId]);
  await pool.query("INSERT INTO control_plane.trips(id, slug, lifecycle_state) VALUES ($1, $2, 'draft')", [tripId, tripId.replace(/_/g, "-")]);
  await pool.query(
    "INSERT INTO control_plane.trip_memberships(id, trip_id, user_id, role, status) VALUES ($1, $2, $3, 'owner', 'active')",
    [testId("memb"), tripId, userId],
  );
  const enrollment = await issueEnrollment(pool, userId, tripId, { enrollmentTtlSeconds: 3600 });
  assert.ok(enrollment.ok);
  const started = await startFromDeepLink(pool, chatId, enrollment.token);
  assert.equal(started.kind, "started");
  await setInterpretPath(pool, chatId, true);
}

async function withTwoChats(fn: (pool: pg.Pool, a: string, b: string) => Promise<void>): Promise<void> {
  const pool = new pg.Pool({ connectionString: databaseUrl });
  const client = await pool.connect();
  try {
    await client.query("DROP SCHEMA IF EXISTS control_plane CASCADE");
    await client.query("DROP TABLE IF EXISTS public.control_plane_schema_migrations");
    await applyMigrations(client, migrationsDir);
  } finally {
    client.release();
  }
  try {
    await seed(pool, "840000001");
    await seed(pool, "840000002");
    await fn(pool, "840000001", "840000002");
  } finally {
    await pool.end();
  }
}

const BOOKING = [
  "Family trip booking",
  "Hotel Aurora Lisbon",
  "Rua Augusta 100, Lisbon",
  "Your group: 2 adults",
].join("\n");

/** Uploads BOOKING into `chatId` and lets the relay read it with `reply` as the model's answer. */
async function upload(pool: pg.Pool, chatId: string, reply: object, telegram: Recorder): Promise<void> {
  const store = new MediaStore();
  const id = store.put({ bytes: Buffer.from(BOOKING), mime: "text/plain", filename: "booking.txt" } as never);
  assert.ok(id);
  await queueInboundMessage(pool, chatId, { message_id: "m1", text: "", media_urls: [`http://127.0.0.1:4312/relay/media/${id}`] } as never);
  const deps = {
    db: pool,
    telegram,
    connector: { pushInbound: () => true },
    modelRunner: fakeRunner([JSON.stringify(reply)]),
    media: { store },
    extractItinerary: async () => ({ ok: false, reason: "EXTRACTION_FAILED" }),
  } as never;
  await flushSettledInboundBursts(deps, () => {}, 0);
  // Then the loop's next tick, as production runs it: what the router says
  // after a document is read is decided there, once the read has let go.
  await advanceRouterOwnedQuestions(deps, DEFAULT_STRINGS, () => {});
  await renderDueRouterPrompts(deps, DEFAULT_STRINGS, () => {}, 0);
}

const unsureTripType = { questionId: "trip_type", value: { kind: "choice", optionId: "family" }, confidence: 0.4, evidence: "Family trip booking" };

describe("an unsure reading from a document is kept, said, and asked about", () => {
  test("nothing certain: it is not recorded, the organizer is not told 'nothing found', and the question comes with Yes / No", { skip: SKIP }, async () => {
    await withTwoChats(async (pool, a, b) => {
      const telegram = new Recorder();
      await upload(pool, a, { proposals: [unsureTripType], unclear: [] }, telegram);

      const store = await answersForChat(pool, a);
      assert.equal(store?.answers.trip_type, undefined, "an unsure reading is never written on its own");
      const view = await getSessionForChat(pool, a);
      assert.ok(view.ok && view.view.suggestions.trip_type, "but it is kept for the question");

      const texts = telegram.sent.map((m) => m.text);
      assert.ok(texts.includes(uiString("documentUnsure", "en")), `said it found something to check — sent: ${JSON.stringify(texts)}`);
      assert.ok(!texts.includes(uiString("documentNothing", "en")), "and never that it found nothing");
      const asked = telegram.sent.find((m) => m.buttonData.includes("y:trip_type"));
      assert.ok(asked, `the trip type is asked with the reading — sent: ${JSON.stringify(telegram.sent.map((m) => m.buttonData))}`);
      assert.deepEqual(asked.buttonData, ["y:trip_type", "x:trip_type"]);

      const other = await getSessionForChat(pool, b);
      assert.deepEqual(other.ok && other.view.suggestions, {}, "the other chat's interview is untouched");
    });
  });

  test("beside a confident answer: the recap says what it took and names what it will check", { skip: SKIP }, async () => {
    await withTwoChats(async (pool, a) => {
      const telegram = new Recorder();
      await upload(pool, a, {
        proposals: [
          { questionId: "destination", value: { kind: "text", text: "Lisbon" }, confidence: 0.9, evidence: "Hotel Aurora Lisbon" },
          unsureTripType,
        ],
        unclear: [],
      }, telegram);

      const store = await answersForChat(pool, a);
      assert.ok(JSON.stringify(store?.answers.destination).includes("Lisbon"), "the confident answer is recorded");
      const recap = telegram.sent.find((m) => m.text.startsWith(uiString("documentRead", "en")));
      assert.ok(recap, `a recap was sent — sent: ${JSON.stringify(telegram.sent.map((m) => m.text))}`);
      assert.ok(recap.text.includes(uiString("documentWillCheck", "en")), `and it names what will be checked — got: ${recap.text}`);
    });
  });

  test("a document that yields nothing: the interview carries on with its first question", { skip: SKIP }, async () => {
    await withTwoChats(async (pool, a) => {
      const telegram = new Recorder();
      await upload(pool, a, { proposals: [], unclear: [] }, telegram);
      const texts = telegram.sent.map((m) => m.text);
      assert.ok(texts.includes(uiString("documentNothing", "en")), `sent: ${JSON.stringify(texts)}`);
      assert.ok(telegram.sent.some((m) => m.buttonData.some((d) => d.startsWith("a:trip_type:"))),
        `and the interview moves on to its first question — buttons sent: ${JSON.stringify(telegram.sent.map((m) => m.buttonData))}`);
    });
  });
});
