/**
 * Documents through the REAL interview path, end to end, with only the edges
 * faked: Telegram (a recorder), the relay's media store (the same bytes it would
 * have re-hosted), and the model (a scripted runner that answers per document).
 *
 * Everything between is production code: `applyDecision`, the settled-burst
 * claim, the interpretation row, `ingestDocument` into the registry and the
 * content-addressed store, per-document extraction with its stored readings,
 * the gate across documents, `submitAnswerForChat`, and the message the
 * organizer is sent. A test that called the new modules directly would prove
 * the modules work; this one proves the interview uses them.
 *
 * The scripted runner answers by WHICH DOCUMENT is in the prompt, not by call
 * order. Documents are read two at a time, and a fake that replied in queue
 * order would hand one document's answer to another — which the evidence gate
 * would then, correctly, refuse.
 */
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, test } from "node:test";
import { fileURLToPath } from "node:url";
import pg from "pg";
import { applyMigrations } from "../src/migrations.js";
import { issueEnrollment } from "../src/enrollment.js";
import { startFromDeepLink } from "../src/chat-router.js";
import {
  answersForChat,
  confirmIntakeForChat,
  getSessionForChat,
  INTAKE_QUESTIONS,
  INTAKE_SCHEMA_VERSION,
  submitAnswerForChat,
} from "../src/interview.js";
import { dispatchUpdate } from "../src/relay/dispatch.js";
import { setInterpretPath } from "../src/interpret.js";
import { advanceRouterOwnedQuestions, applyDecision, flushSettledInboundBursts } from "../src/relay/poller.js";
import { DEFAULT_STRINGS } from "../src/relay/dispatch.js";
import { filesystemDocumentStore, type DocumentBlobStore } from "../src/document-store.js";
import { uiString, type Language } from "../src/intake-copy.js";
import type { RunnerResult, StructuredModelRequest, StructuredModelRunner } from "../src/model-runner.js";
import { testDatabaseUrl } from "./support/test-database.js";

const databaseUrl = testDatabaseUrl();
const SKIP = !databaseUrl;
const migrationsDir = fileURLToPath(new URL("../../db/migrations/", import.meta.url));
const CHAT = "880000001";

function testId(prefix: string): string {
  return `${prefix}_${randomBytes(16).toString("hex")}`;
}

// ── The documents, and what a model reads out of each ────────────────────────

interface Upload {
  name: string;
  body: string;
  messageId: string;
  /** Defaults to text/plain. An image type makes it a photo, read by looking. */
  mime?: string;
}

const PLAN: Upload = {
  name: "Yapan Tours itinerary.txt",
  body: "Yapan Tours itinerary\nTokyo 2026-09-19 to 2026-09-23\nKyoto 2026-09-23 to 2026-09-26\n",
  messageId: "501",
};

const HOTEL: Upload = {
  name: "Gracery confirmation.txt",
  body: "Booking confirmation\nHotel Gracery Shinjuku\nCheck-in 2026-09-19\nConfirmation GR-4471\n",
  messageId: "502",
};

const PASSPORT: Upload = {
  name: "scan.txt",
  body: "PASSPORT\nP<ISRCOHEN<<DANA<<<<<<<<<<<<<<<<<<<<<<<<<<<<\n",
  messageId: "503",
};

const VOUCHER: Upload = {
  name: "Gracery voucher.txt",
  body: "Gracery accommodation voucher\nTokyo 2026-09-19 to 2026-09-23\nHotel Gracery Shinjuku\nConfirmation GR-4471\n",
  messageId: "601",
};

/** One page of the same booking: nothing in it that the plan did not already give. */
const EXCERPT: Upload = {
  name: "Yapan Tours excerpt.txt",
  body: "Yapan Tours itinerary excerpt\nTokyo 2026-09-19 to 2026-09-23\n",
  messageId: "603",
};

/** The voucher, photographed: the same words, reaching a model only as a picture. */
const PHOTO_VOUCHER: Upload = { name: "IMG_0231.jpg", body: VOUCHER.body, messageId: "701", mime: "image/jpeg" };

const REVISED: Upload = {
  name: "Revised itinerary.txt",
  body: "Revised Yapan itinerary\nTokyo 2026-09-19 to 2026-09-24\n",
  messageId: "602",
};

/** Side effects to run while a given document is being "read" — an organizer acting mid-read. */
const DURING_READ = new Map<string, () => Promise<void>>();

// More specific needles first: the voucher also names the hotel the HOTEL
// document is found by.
const SCRIPT = [
  {
    needle: "Gracery accommodation voucher",
    reply: {
      proposals: [{
        questionId: "phases",
        confidence: 0.92,
        value: {
          kind: "structured",
          dataJson: JSON.stringify([{
            name: "Tokyo", start: "2026-09-19", end: "2026-09-23",
            accommodation: { name: "Hotel Gracery Shinjuku", confirmation: "GR-4471" },
          }]),
        },
        evidence: "Tokyo 2026-09-19 to 2026-09-23\nHotel Gracery Shinjuku\nConfirmation GR-4471",
      }],
      unclear: [],
    },
  },
  {
    needle: "Revised Yapan itinerary",
    reply: {
      proposals: [{
        questionId: "phases",
        confidence: 0.9,
        value: { kind: "structured", dataJson: JSON.stringify([{ name: "Tokyo", start: "2026-09-19", end: "2026-09-24" }]) },
        evidence: "Tokyo 2026-09-19 to 2026-09-24",
      }],
      unclear: [],
    },
  },
  {
    // Before the plain itinerary needle: this body contains that one too.
    needle: "Yapan Tours itinerary excerpt",
    reply: {
      proposals: [{
        questionId: "phases",
        confidence: 0.95,
        value: { kind: "structured", dataJson: JSON.stringify([{ name: "Tokyo", start: "2026-09-19", end: "2026-09-23" }]) },
        evidence: "Tokyo 2026-09-19 to 2026-09-23",
      }],
      unclear: [],
    },
  },
  {
    needle: "Yapan Tours itinerary",
    reply: {
      proposals: [{
        questionId: "phases",
        confidence: 0.95,
        value: {
          kind: "structured",
          dataJson: JSON.stringify([
            { name: "Tokyo", start: "2026-09-19", end: "2026-09-23" },
            { name: "Kyoto", start: "2026-09-23", end: "2026-09-26" },
          ]),
        },
        evidence: "Tokyo 2026-09-19 to 2026-09-23\nKyoto 2026-09-23 to 2026-09-26",
      }],
      unclear: [],
    },
  },
  {
    needle: "Hotel Gracery Shinjuku",
    reply: {
      proposals: [{
        questionId: "travel_anchors",
        confidence: 0.93,
        value: {
          kind: "structured",
          dataJson: JSON.stringify([{ type: "hotel", name: "Hotel Gracery Shinjuku", date: "2026-09-19", confirmation: "GR-4471" }]),
        },
        evidence: "Hotel Gracery Shinjuku\nConfirmation GR-4471",
      }],
      unclear: [],
    },
  },
] as const;

// ── Fakes at the edges ───────────────────────────────────────────────────────

class FakeMediaStore {
  private readonly items = new Map<string, { bytes: Buffer; mime: string; filename?: string }>();
  put(input: { bytes: Buffer; mime: string; filename?: string }): string {
    const key = randomBytes(8).toString("hex");
    this.items.set(key, input);
    return key;
  }
  get(key: string) {
    return this.items.get(key) ?? null;
  }
}

class Recorder {
  readonly sent: string[] = [];
  /** The callback data of every button sent, per message. */
  readonly buttons: string[][] = [];
  async sendMessage(p: { text: string; replyMarkup?: { inline_keyboard: { callback_data: string }[][] } }) {
    this.sent.push(p.text);
    this.buttons.push((p.replyMarkup?.inline_keyboard ?? []).flat().map((b) => b.callback_data));
    return { ok: true as const, messageId: String(this.sent.length) };
  }
  async editMessageText() { return { ok: true as const }; }
  async sendChatAction() {}
  async answerCallbackQuery() {}
  async getChatInfo() { return null; }
  async getMe() { return { id: "7000000001", username: "KineraryTestBot" }; }
  async getUpdates() { return []; }
  async deleteWebhookIfPresent() {}
}

/** Answers by which document is in the prompt; records every call it gets. */
function scriptedRunner(): { runner: StructuredModelRunner; calls: string[] } {
  const calls: string[] = [];
  const runner: StructuredModelRunner = {
    describe: () => ({ provider: "scripted", model: "fixture-1" }),
    async run<T>(req: StructuredModelRequest<T>): Promise<RunnerResult<T>> {
      if (req.task === "read_image") {
        // A "photo" here is its words as bytes, so looking at it reads them back.
        calls.push("read_image");
        const lines = (req.attachments ?? []).flatMap((file) =>
          Buffer.from(file.bytes).toString("utf8").split("\n").filter(Boolean));
        const parsed = req.parse({ legible: lines.length > 0, identity_document: false, lines });
        if (parsed === null) return { ok: false, reason: "BAD_OUTPUT", attempts: 1, ms: 0 };
        return { ok: true, value: parsed, attempts: 1, ms: 0 };
      }
      const hit = SCRIPT.find((s) => req.prompt.includes(s.needle));
      calls.push(hit ? hit.needle : "(unscripted)");
      if (!hit) return { ok: false, reason: "FAILED", detail: "no scripted reply", attempts: 1, ms: 0 };
      await DURING_READ.get(hit.needle)?.();
      const parsed = req.parse(JSON.parse(JSON.stringify(hit.reply)));
      if (parsed === null) return { ok: false, reason: "BAD_OUTPUT", attempts: 1, ms: 0 };
      return { ok: true, value: parsed, attempts: 1, ms: 0 };
    },
  };
  return { runner, calls };
}

// ── A real session on a real database ────────────────────────────────────────

interface Flow {
  pool: pg.Pool;
  tripId: string;
  sessionId: string;
  media: FakeMediaStore;
  telegram: Recorder;
  calls: string[];
  store: DocumentBlobStore | undefined;
  logs: string[];
  deps: never;
}

async function withFlow(options: { store: boolean }, fn: (flow: Flow) => Promise<void>): Promise<void> {
  const pool = new pg.Pool({ connectionString: databaseUrl });
  const client = await pool.connect();
  try {
    await client.query("DROP SCHEMA IF EXISTS control_plane CASCADE");
    await client.query("DROP TABLE IF EXISTS public.control_plane_schema_migrations");
    await applyMigrations(client, migrationsDir);
  } finally {
    client.release();
  }
  const root = await mkdtemp(path.join(tmpdir(), "doc-intake-flow-"));
  try {
    const userId = testId("user");
    const tripId = testId("trip");
    await pool.query("INSERT INTO control_plane.users(id, status, display_name) VALUES ($1, 'active', 'Owner')", [userId]);
    await pool.query("INSERT INTO control_plane.trips(id, slug, lifecycle_state) VALUES ($1, $2, 'draft')", [
      tripId,
      tripId.replace(/_/g, "-"),
    ]);
    await pool.query(
      "INSERT INTO control_plane.trip_memberships(id, trip_id, user_id, role, status) VALUES ($1, $2, $3, 'owner', 'active')",
      [testId("memb"), tripId, userId],
    );
    const enrollment = await issueEnrollment(pool, userId, tripId, { enrollmentTtlSeconds: 3600 });
    assert.ok(enrollment.ok);
    const started = await startFromDeepLink(pool, CHAT, enrollment.token);
    assert.equal(started.kind, "started");
    await setInterpretPath(pool, CHAT, true);

    const media = new FakeMediaStore();
    const telegram = new Recorder();
    const { runner, calls } = scriptedRunner();
    const store = options.store ? filesystemDocumentStore(root) : undefined;
    const logs: string[] = [];
    const deps = {
      db: pool,
      telegram,
      connector: { pushInbound: () => true },
      modelRunner: runner,
      documentStore: store,
      media: { telegram, store: media, baseUrl: "http://127.0.0.1:4312", log: () => {} },
      // The day-by-day pass is its own model call with its own tests; here it
      // stays out of the way.
      extractItinerary: async () => ({ ok: false as const, reason: "EXTRACT_NOT_CONFIGURED" as const }),
      log: (line: string) => logs.push(line),
    } as never;

    await fn({
      pool,
      tripId,
      sessionId: started.kind === "started" ? started.sessionId : "",
      media,
      telegram,
      calls,
      store,
      logs,
      deps,
    });
  } finally {
    await pool.end();
    await rm(root, { recursive: true, force: true });
  }
}

/** Sends files the way Telegram does — one message each — then lets the burst settle. */
async function upload(flow: Flow, files: readonly Upload[]): Promise<void> {
  for (const file of files) {
    const mime = file.mime ?? "text/plain";
    const kind = mime.startsWith("image/") ? "image" : "document";
    const key = flow.media.put({ bytes: Buffer.from(file.body, "utf8"), mime, filename: file.name });
    await applyDecision(
      {
        kind: "interview_to_gateway",
        chatId: CHAT,
        sessionId: flow.sessionId,
        hadAttachment: true,
        event: {
          text: "",
          message_id: file.messageId,
          message_type: kind,
          source: { chat_id: CHAT },
          media_urls: [`http://127.0.0.1:4312/relay/media/${key}`],
          media: [{ kind, mime, size: Buffer.byteLength(file.body), filename: file.name }],
        },
      } as never,
      flow.deps,
    );
  }
  const log = (line: string) => flow.logs.push(line);
  await flushSettledInboundBursts(flow.deps, log, 0);
  // The rest of one real poll tick. The document path holds the router silent
  // for the length of the read, so what comes after it — the next question, or
  // a disagreement to settle — is said by the tick that follows, as it is live.
  await advanceRouterOwnedQuestions(flow.deps, DEFAULT_STRINGS, log);
}

async function scalar(pool: pg.Pool, sql: string, params: unknown[]): Promise<number> {
  const res = await pool.query<{ n: number }>(sql, params);
  return Number(res.rows[0]?.n ?? 0);
}

async function languageOf(pool: pg.Pool): Promise<Language> {
  const view = await getSessionForChat(pool, CHAT);
  return view.ok ? view.view.language : "en";
}

function structured(answers: Record<string, unknown> | undefined, questionId: string): unknown[] {
  const answer = answers?.[questionId] as { kind?: string; data?: unknown } | undefined;
  return answer?.kind === "structured" && Array.isArray(answer.data) ? answer.data : [];
}

// ── The flow ─────────────────────────────────────────────────────────────────

describe("document intake through the interview", { skip: SKIP ? "no CONTROL_PLANE_TEST_DATABASE_URL" : false }, () => {
  test("two files in one upload become two kept documents, each read once, and both answers land", async () => {
    await withFlow({ store: true }, async (flow) => {
      await upload(flow, [PLAN, HOTEL]);

      assert.deepEqual([...flow.calls].sort(), ["Hotel Gracery Shinjuku", "Yapan Tours itinerary"], "one model call per document");

      const documents = await flow.pool.query(
        "SELECT ingest_state, storage_key FROM control_plane.trip_documents WHERE trip_id = $1",
        [flow.tripId],
      );
      assert.equal(documents.rowCount, 2);
      assert.ok(documents.rows.every((d) => d.ingest_state === "stored" && d.storage_key), "both originals kept");
      assert.equal((await flow.store!.list(flow.tripId)).length, 2, "and the bytes are really on disk");

      const deliveries = await flow.pool.query(
        "SELECT source_ref FROM control_plane.source_artifacts WHERE trip_id = $1 ORDER BY source_ref",
        [flow.tripId],
      );
      assert.deepEqual(deliveries.rows.map((r) => r.source_ref), [`chat:${CHAT}:msg:501`, `chat:${CHAT}:msg:502`]);

      const readings = await flow.pool.query(
        "SELECT provider, model, status FROM control_plane.trip_document_extractions WHERE trip_id = $1",
        [flow.tripId],
      );
      assert.equal(readings.rowCount, 2);
      assert.ok(readings.rows.every((r) => r.provider === "scripted" && r.model === "fixture-1" && r.status === "ok"));

      const store = await answersForChat(flow.pool, CHAT);
      assert.equal(structured(store?.answers, "phases").length, 2, "the plan answered phases");
      assert.equal(
        (structured(store?.answers, "travel_anchors")[0] as { confirmation?: string } | undefined)?.confirmation,
        "GR-4471",
        "the confirmation answered travel_anchors",
      );

      assert.equal(
        await scalar(flow.pool, "SELECT count(*)::int AS n FROM control_plane.interview_interpretations WHERE committed_at IS NULL", []),
        0,
        "the document burst's interpretation row is closed",
      );
      const language = await languageOf(flow.pool);
      assert.ok(flow.telegram.sent.some((m) => m.startsWith(uiString("documentRead", language))), "the organizer is shown what was taken");
    });
  });

  test("a redelivered upload costs nothing and says nothing new", async () => {
    await withFlow({ store: true }, async (flow) => {
      await upload(flow, [PLAN, HOTEL]);
      const sentBefore = flow.telegram.sent.length;

      await upload(flow, [PLAN, HOTEL]);

      assert.equal(flow.calls.length, 2, "no second model call for either document");
      assert.equal(await scalar(flow.pool, "SELECT count(*)::int AS n FROM control_plane.trip_documents WHERE trip_id = $1", [flow.tripId]), 2);
      assert.equal(await scalar(flow.pool, "SELECT count(*)::int AS n FROM control_plane.source_artifacts WHERE trip_id = $1", [flow.tripId]), 2);
      const language = await languageOf(flow.pool);
      assert.ok(
        !flow.telegram.sent.slice(sentBefore).includes(uiString("documentAlreadyRead", language)),
        "a redelivery the organizer did not send is not answered as if they had",
      );
    });
  });

  test("the same file sent again in a new message is one document with a second delivery, and the organizer is told", async () => {
    await withFlow({ store: true }, async (flow) => {
      await upload(flow, [PLAN, HOTEL]);
      await upload(flow, [{ ...PLAN, name: "Yapan Tours itinerary (1).txt", messageId: "777" }]);

      assert.equal(flow.calls.length, 2, "read from the stored reading, not the model");
      assert.equal(await scalar(flow.pool, "SELECT count(*)::int AS n FROM control_plane.trip_documents WHERE trip_id = $1", [flow.tripId]), 2);
      assert.equal(await scalar(flow.pool, "SELECT count(*)::int AS n FROM control_plane.source_artifacts WHERE trip_id = $1", [flow.tripId]), 3);
      const language = await languageOf(flow.pool);
      assert.ok(flow.telegram.sent.includes(uiString("documentAlreadyRead", language)));
      assert.ok(!flow.telegram.sent.includes(uiString("documentNothing", language)), "never 'nothing about the trip in it'");
    });
  });

  test("a photographed voucher is read by looking, kept as the photo, and its answer lands", async () => {
    await withFlow({ store: true }, async (flow) => {
      await upload(flow, [PHOTO_VOUCHER]);

      assert.deepEqual(flow.calls, ["read_image", "Gracery accommodation voucher"], "looked at once, then read like any document");
      const documents = await flow.pool.query(
        "SELECT ingest_state, storage_key FROM control_plane.trip_documents WHERE trip_id = $1",
        [flow.tripId],
      );
      assert.equal(documents.rowCount, 1);
      assert.equal(documents.rows[0]?.ingest_state, "stored");
      assert.match(String(documents.rows[0]?.storage_key), /\.jpg$/, "kept as the photo it was");

      const readings = await flow.pool.query(
        "SELECT reader_version, status FROM control_plane.trip_document_extractions WHERE trip_id = $1",
        [flow.tripId],
      );
      assert.equal(readings.rowCount, 2, "the transcript, and what was read out of it");
      assert.ok(readings.rows.every((r) => String(r.reader_version).startsWith("vision-") && r.status === "ok"));

      const store = await answersForChat(flow.pool, CHAT);
      const tokyo = structured(store?.answers, "phases")[0] as { accommodation?: { confirmation?: string } } | undefined;
      assert.equal(tokyo?.accommodation?.confirmation, "GR-4471", "the photo's answer landed");

      // The same photo in a new message: no second look, no second reading.
      await upload(flow, [{ ...PHOTO_VOUCHER, messageId: "702" }]);
      assert.equal(flow.calls.length, 2);
    });
  });

  test("a document that only repeats what is held says so, not that it found nothing", async () => {
    await withFlow({ store: true }, async (flow) => {
      await upload(flow, [PLAN]);
      const sentBefore = flow.telegram.sent.length;
      await upload(flow, [EXCERPT]);

      const language = await languageOf(flow.pool);
      const after = flow.telegram.sent.slice(sentBefore);
      assert.ok(after.includes(uiString("documentNothingNew", language)), `got: ${JSON.stringify(after)}`);
      assert.ok(!after.includes(uiString("documentNothing", language)), "never 'nothing about the trip' about a booking that agrees");
    });
  });

  test("a passport is refused and nothing of it is kept", async () => {
    await withFlow({ store: true }, async (flow) => {
      await upload(flow, [PASSPORT]);

      assert.equal(flow.calls.length, 0, "its text reaches no model");
      assert.equal(await scalar(flow.pool, "SELECT count(*)::int AS n FROM control_plane.trip_documents WHERE trip_id = $1", [flow.tripId]), 0);
      assert.equal(await scalar(flow.pool, "SELECT count(*)::int AS n FROM control_plane.source_artifacts WHERE trip_id = $1", [flow.tripId]), 0);
      assert.deepEqual(await flow.store!.list(flow.tripId), [], "and no bytes were written");
      const language = await languageOf(flow.pool);
      assert.ok(flow.telegram.sent.includes(uiString("documentIdentity", language)));
    });
  });

  test("with no store configured, a document is still read and answers, and its row says the bytes were not kept", async () => {
    await withFlow({ store: false }, async (flow) => {
      await upload(flow, [HOTEL]);

      const documents = await flow.pool.query(
        "SELECT ingest_state, storage_key FROM control_plane.trip_documents WHERE trip_id = $1",
        [flow.tripId],
      );
      assert.deepEqual(documents.rows, [{ ingest_state: "unstored", storage_key: null }]);
      const store = await answersForChat(flow.pool, CHAT);
      assert.equal(structured(store?.answers, "travel_anchors").length, 1);
    });
  });

  test("a crash between reading and committing resumes from the stored reading", async () => {
    await withFlow({ store: true }, async (flow) => {
      await upload(flow, [PLAN]);
      assert.equal(flow.calls.length, 1);

      // The crash: the reading was kept, the answers never landed, and the
      // interpretation row was left open.
      await flow.pool.query("UPDATE control_plane.interview_interpretations SET committed_at = NULL");
      await flow.pool.query("UPDATE control_plane.intake_sessions SET answers = answers - 'phases' WHERE telegram_chat_id = $1", [CHAT]);

      await upload(flow, [PLAN]);

      assert.equal(flow.calls.length, 1, "resumed without paying for the reading again");
      const store = await answersForChat(flow.pool, CHAT);
      assert.equal(structured(store?.answers, "phases").length, 2, "and the answers it holds were written");
      assert.equal(
        await scalar(flow.pool, "SELECT count(*)::int AS n FROM control_plane.interview_interpretations WHERE committed_at IS NULL", []),
        0,
      );
    });
  });

  test("confirming records which documents the version was built from, and none of their text", async () => {
    await withFlow({ store: true }, async (flow) => {
      await upload(flow, [PLAN, HOTEL]);

      // Confirmation needs every required question answered. The rest of the
      // interview is not what this test is about, so the gaps are filled
      // directly rather than walked.
      const current = await answersForChat(flow.pool, CHAT);
      const answers: Record<string, unknown> = { ...(current?.answers ?? {}) };
      for (const question of INTAKE_QUESTIONS.filter((q) => q.required)) {
        answers[question.id] ??= { kind: "text", schema_version: INTAKE_SCHEMA_VERSION, text: "filler" };
      }
      await flow.pool.query(
        "UPDATE control_plane.intake_sessions SET answers = $2::jsonb WHERE telegram_chat_id = $1",
        [CHAT, JSON.stringify(answers)],
      );

      const confirmed = await confirmIntakeForChat(flow.pool, CHAT);
      assert.ok(confirmed.ok, JSON.stringify(confirmed));

      const version = await flow.pool.query(
        "SELECT source_document FROM control_plane.intake_versions WHERE trip_id = $1",
        [flow.tripId],
      );
      const manifest = version.rows[0]?.source_document as
        | { documents?: { filename: string | null; stored: boolean; digest: string }[] }
        | null;
      assert.deepEqual(
        manifest?.documents?.map((d) => d.filename).sort(),
        [HOTEL.name, PLAN.name].sort(),
        "every document, not the last one read",
      );
      assert.ok(manifest?.documents?.every((d) => d.stored && /^sha256:[a-f0-9]{64}$/.test(d.digest)));
      assert.ok(!JSON.stringify(manifest).includes("GR-4471"), "a manifest names documents; their text stays on the reading rows");
    });
  });
});

// ── Across documents ─────────────────────────────────────────────────────────

/** A tap on a button, through the same dispatch a real callback query takes. */
async function tap(flow: Flow, data: string): Promise<void> {
  const decision = await dispatchUpdate(flow.pool, {
    update_id: 9,
    callback_query: {
      id: `cbq_${randomBytes(4).toString("hex")}`,
      data,
      from: { id: 777 },
      message: { message_id: 77, chat: { id: CHAT, type: "private" } },
    },
  } as never);
  await applyDecision(decision, flow.deps);
}

function conflictButtons(flow: Flow, choice: "k" | "r"): string[] {
  return flow.telegram.buttons.flat().filter((d) => d.startsWith("x:") && d.endsWith(`:${choice}`));
}

function stops(answers: Record<string, unknown> | undefined): Record<string, unknown>[] {
  return structured(answers, "phases") as Record<string, unknown>[];
}

async function openConflicts(pool: pg.Pool, tripId: string): Promise<number> {
  return scalar(pool, "SELECT count(*)::int AS n FROM control_plane.trip_answer_conflicts WHERE trip_id = $1 AND status = 'open'", [tripId]);
}

describe("documents that build on each other", { skip: SKIP ? "no CONTROL_PLANE_TEST_DATABASE_URL" : false }, () => {
  test("a voucher sent after the plan fills the stay the plan named, and is recorded as its source", async () => {
    await withFlow({ store: true }, async (flow) => {
      await upload(flow, [PLAN]);
      await upload(flow, [VOUCHER]);

      const phases = stops((await answersForChat(flow.pool, CHAT))?.answers);
      assert.equal(phases.length, 2, "Kyoto is still there; nothing was replaced");
      assert.deepEqual(phases[0]?.accommodation, { name: "Hotel Gracery Shinjuku", confirmation: "GR-4471" });
      assert.equal(await openConflicts(flow.pool, flow.tripId), 0, "filling a gap is not a disagreement");

      const sources = await flow.pool.query(
        `SELECT s.disposition, s.paths FROM control_plane.trip_answer_sources s
           JOIN control_plane.source_artifacts a ON a.document_id = s.document_id
          WHERE s.trip_id = $1 AND s.question_id = 'phases' AND a.filename = $2`,
        [flow.tripId, VOUCHER.name],
      );
      assert.deepEqual(sources.rows, [{ disposition: "filled", paths: ["accommodation"] }]);
    });
  });

  test("a document that disagrees opens one question, and 'use the document's' changes that field alone", async () => {
    await withFlow({ store: true }, async (flow) => {
      await upload(flow, [PLAN]);
      await upload(flow, [REVISED]);

      assert.equal(await openConflicts(flow.pool, flow.tripId), 1);
      assert.equal(stops((await answersForChat(flow.pool, CHAT))?.answers)[0]?.end, "2026-09-23", "held until the organizer decides");
      const [replace] = conflictButtons(flow, "r");
      assert.ok(replace, "the question was asked, with buttons");

      await tap(flow, replace);
      const phases = stops((await answersForChat(flow.pool, CHAT))?.answers);
      assert.equal(phases[0]?.end, "2026-09-24");
      assert.deepEqual(phases[1], { name: "Kyoto", start: "2026-09-23", end: "2026-09-26" }, "the rest of the answer is untouched");
      assert.equal(await openConflicts(flow.pool, flow.tripId), 0);

      await tap(flow, replace);
      assert.equal(stops((await answersForChat(flow.pool, CHAT))?.answers)[0]?.end, "2026-09-24", "a double tap applies once");
    });
  });

  test("keeping what is held settles it, and re-sending the document does not ask again", async () => {
    await withFlow({ store: true }, async (flow) => {
      await upload(flow, [PLAN]);
      await upload(flow, [REVISED]);
      const [keep] = conflictButtons(flow, "k");
      assert.ok(keep);

      await tap(flow, keep);
      assert.equal(stops((await answersForChat(flow.pool, CHAT))?.answers)[0]?.end, "2026-09-23");
      const asked = conflictButtons(flow, "k").length;

      await upload(flow, [{ ...REVISED, messageId: "700" }]);
      assert.equal(await openConflicts(flow.pool, flow.tripId), 0, "a settled disagreement stays settled");
      assert.equal(conflictButtons(flow, "k").length, asked, "and is not put to the organizer again");
    });
  });

  test("a write computed against an answer that has since changed is refused", async () => {
    await withFlow({ store: true }, async (flow) => {
      const first = [{ name: "Tokyo", start: "2026-09-19", end: "2026-09-23" }];
      assert.ok((await submitAnswerForChat(flow.pool, CHAT, "phases", null, undefined, first)).ok);
      const readBefore = (await answersForChat(flow.pool, CHAT))?.answers.phases;

      // The organizer corrects it by hand.
      assert.ok((await submitAnswerForChat(flow.pool, CHAT, "phases", null, undefined, [{ ...first[0], end: "2026-09-25" }])).ok);

      const late = await submitAnswerForChat(
        flow.pool, CHAT, "phases", null, undefined, [{ ...first[0], accommodation: { name: "OMO3" } }], undefined,
        { held: readBefore },
      );
      assert.equal(late.ok ? "ok" : late.reason, "STALE_ANSWER");
      assert.equal(stops((await answersForChat(flow.pool, CHAT))?.answers)[0]?.end, "2026-09-25", "the correction survives");
    });
  });

  test("a correction made while a document is being read is what the document is merged into", async () => {
    await withFlow({ store: true }, async (flow) => {
      await upload(flow, [PLAN]);
      DURING_READ.set(VOUCHER.body.split("\n")[0]!, async () => {
        await submitAnswerForChat(flow.pool, CHAT, "phases", null, undefined, [
          { name: "Tokyo", start: "2026-09-19", end: "2026-09-25" },
          { name: "Kyoto", start: "2026-09-25", end: "2026-09-28" },
        ]);
      });
      try {
        await upload(flow, [VOUCHER]);
      } finally {
        DURING_READ.clear();
      }

      const phases = stops((await answersForChat(flow.pool, CHAT))?.answers);
      assert.equal(phases[0]?.end, "2026-09-25", "the organizer's dates stand");
      assert.equal(phases[1]?.start, "2026-09-25");
      assert.deepEqual(phases[0]?.accommodation, { name: "Hotel Gracery Shinjuku", confirmation: "GR-4471" }, "and the voucher still filled the stay");
      assert.equal(await openConflicts(flow.pool, flow.tripId), 1, "the voucher's own dates disagree, so that is a question — not an overwrite");
    });
  });
});
