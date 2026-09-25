/**
 * A document after confirmation, through the real relay: read, PROPOSED, and
 * applied only by the organizer's Approve — as a new immutable intake version.
 *
 * Production code does the work — `applyDecision`, the registry, per-document
 * extraction, the reconciling gate against the confirmed version, proposals,
 * the callback, `correctIntake`. Only the edges are fakes: Telegram (a
 * recorder), the media store, and the model (answers by which document it sees).
 */
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, test } from "node:test";
import { fileURLToPath } from "node:url";
import pg from "pg";
import { startFromDeepLink } from "../src/chat-router.js";
import { organizerDocumentRoute } from "../src/document-correction.js";
import { filesystemDocumentStore } from "../src/document-store.js";
import { issueEnrollment } from "../src/enrollment.js";
import { correctIntake } from "../src/intake-correction.js";
import { uiString } from "../src/intake-copy.js";
import { confirmIntakeForChat } from "../src/interview.js";
import { applyMigrations } from "../src/migrations.js";
import type { RunnerResult, StructuredModelRequest, StructuredModelRunner } from "../src/model-runner.js";
import { dispatchUpdate } from "../src/relay/dispatch.js";
import type { TelegramUpdate } from "../src/relay/normalize.js";
import { applyDecision, settleDocumentCorrections } from "../src/relay/poller.js";
import { testDatabaseUrl } from "./support/test-database.js";

const databaseUrl = testDatabaseUrl();
const SKIP = !databaseUrl;
const migrationsDir = fileURLToPath(new URL("../../db/migrations/", import.meta.url));
const CHAT = "880000501";
const id = (prefix: string) => `${prefix}_${randomBytes(16).toString("hex")}`;

const TOKYO = { name: "Tokyo", name_en: "Tokyo", start: "2026-09-19", end: "2026-09-23", accommodation: { name: "Hotel Gracery Shinjuku" } };

const DOCS = {
  voucher: {
    name: "Gracery voucher.txt",
    body: "Gracery accommodation voucher\nTokyo 2026-09-19 to 2026-09-23\nHotel Gracery Shinjuku\nConfirmation GR-4471\n",
  },
  copy: {
    name: "Itinerary copy.txt",
    body: "Itinerary copy\nTokyo 2026-09-19 to 2026-09-23\nHotel Gracery Shinjuku\n",
  },
  revised: {
    name: "Revised stay.txt",
    body: "Revised Tokyo stay\nTokyo 2026-09-19 to 2026-09-24\n",
  },
};

const SCRIPT: { needle: string; phases: unknown[]; evidence: string }[] = [
  {
    needle: "Gracery accommodation voucher",
    phases: [{ ...TOKYO, accommodation: { name: "Hotel Gracery Shinjuku", confirmation: "GR-4471" } }],
    evidence: "Tokyo 2026-09-19 to 2026-09-23\nHotel Gracery Shinjuku\nConfirmation GR-4471",
  },
  { needle: "Itinerary copy", phases: [TOKYO], evidence: "Tokyo 2026-09-19 to 2026-09-23\nHotel Gracery Shinjuku" },
  { needle: "Revised Tokyo stay", phases: [{ name: "Tokyo", name_en: "Tokyo", start: "2026-09-19", end: "2026-09-24" }], evidence: "Tokyo 2026-09-19 to 2026-09-24" },
];

function scriptedRunner(): StructuredModelRunner & { calls: number } {
  const runner = {
    calls: 0,
    describe: () => ({ provider: "scripted", model: "fixture-1" }),
    async run<T>(req: StructuredModelRequest<T>): Promise<RunnerResult<T>> {
      runner.calls += 1;
      const hit = SCRIPT.find((s) => req.prompt.includes(s.needle));
      if (!hit) return { ok: false, reason: "FAILED", detail: "unscripted", attempts: 1, ms: 0 };
      const parsed = req.parse({
        proposals: [{ questionId: "phases", confidence: 0.95, evidence: hit.evidence, value: { kind: "structured", dataJson: JSON.stringify(hit.phases) } }],
        unclear: [],
      });
      return parsed === null ? { ok: false, reason: "BAD_OUTPUT", attempts: 1, ms: 0 } : { ok: true, value: parsed, attempts: 1, ms: 0 };
    },
  };
  return runner;
}

class Recorder {
  readonly sent: { text: string; buttons: string[] }[] = [];
  readonly acks: (string | undefined)[] = [];
  async sendMessage(p: { text: string; replyMarkup?: { inline_keyboard: { callback_data: string }[][] } }) {
    this.sent.push({ text: p.text, buttons: (p.replyMarkup?.inline_keyboard ?? []).flat().map((b) => b.callback_data) });
    return { ok: true as const, messageId: String(this.sent.length) };
  }
  async answerCallbackQuery(p: { text?: string }) { this.acks.push(p.text); }
  async editMessageText() { return { ok: true as const }; }
  async sendChatAction() {}
  async getChatInfo() { return null; }
  async getMe() { return { id: "7000000001", username: "KineraryTestBot" }; }
  async fetchFile(_fileId: string, _max: number) { return { bytes: Buffer.from("Tokyo 2026-09-19 to 2026-09-23\n", "utf8"), mime: "text/plain" }; }
  async getUpdates() { return []; }
  async deleteWebhookIfPresent() {}
}

class MediaStore {
  private readonly items = new Map<string, { bytes: Buffer; mime: string; filename?: string }>();
  put(input: { bytes: Buffer; mime: string; filename?: string }): string {
    const key = randomBytes(8).toString("hex");
    this.items.set(key, input);
    return key;
  }
  get(key: string) { return this.items.get(key) ?? null; }
}

interface Trip {
  pool: pg.Pool;
  tripId: string;
  sessionId: string;
  telegram: Recorder;
  media: MediaStore;
  runner: ReturnType<typeof scriptedRunner>;
  deps: never;
}

async function withConfirmedTrip(fn: (trip: Trip) => Promise<void>): Promise<void> {
  const pool = new pg.Pool({ connectionString: databaseUrl });
  const client = await pool.connect();
  try {
    await client.query("DROP SCHEMA IF EXISTS control_plane CASCADE");
    await client.query("DROP TABLE IF EXISTS public.control_plane_schema_migrations");
    await applyMigrations(client, migrationsDir);
  } finally {
    client.release();
  }
  const root = await mkdtemp(path.join(tmpdir(), "doc-correction-"));
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
    await pool.query(
      `UPDATE control_plane.intake_sessions SET answers = $1, state = 'awaiting_confirmation' WHERE telegram_chat_id = $2`,
      [
        JSON.stringify({
          trip_type: { kind: "choice", option_id: "family", schema_version: 2, other_text: null },
          destination: { kind: "text", schema_version: 2, text: "Japan" },
          departure_date: { kind: "text", schema_version: 2, text: "2026-09-19" },
          return_date: { kind: "text", schema_version: 2, text: "2026-09-23" },
          travelers: { kind: "structured", schema_version: 2, data: [{ name: "Dana" }] },
          phases: { kind: "structured", schema_version: 2, data: [TOKYO] },
          bot_name: { kind: "text", schema_version: 2, text: "Rio" },
          bot_gender: { kind: "choice", option_id: "neutral", schema_version: 2, other_text: null },
          bot_tone: { kind: "choice", option_id: "warm", schema_version: 2, other_text: null },
          organizer_identity: { kind: "text", schema_version: 2, text: "Dana" },
        }),
        CHAT,
      ],
    );
    const confirmed = await confirmIntakeForChat(pool, CHAT);
    assert.ok(confirmed.ok, `confirm failed: ${JSON.stringify(confirmed)}`);
    await pool.query(
      "INSERT INTO control_plane.telegram_chat_bindings(id, chat_id, trip_id, hermes_profile) VALUES ($1, $2, $3, 'companion-test')",
      [id("tcb"), CHAT, tripId],
    );

    const telegram = new Recorder();
    const media = new MediaStore();
    const runner = scriptedRunner();
    const deps = {
      db: pool,
      telegram,
      connector: { pushInbound: () => true },
      modelRunner: runner,
      documentStore: filesystemDocumentStore(root),
      media: { telegram, store: media, baseUrl: "http://127.0.0.1:4312", log: () => {} },
      log: () => {},
    } as never;
    await fn({ pool, tripId, sessionId: started.kind === "started" ? started.sessionId : "", telegram, media, runner, deps });
  } finally {
    await pool.end();
    await rm(root, { recursive: true, force: true });
  }
}

async function upload(trip: Trip, doc: { name: string; body: string }, messageId: string): Promise<void> {
  const key = trip.media.put({ bytes: Buffer.from(doc.body, "utf8"), mime: "text/plain", filename: doc.name });
  await applyDecision({
    kind: "document_correction",
    chatId: CHAT,
    tripId: trip.tripId,
    sessionId: trip.sessionId,
    language: "en",
    event: {
      text: "",
      message_id: messageId,
      message_type: "document",
      source: { chat_id: CHAT },
      media_urls: [`http://127.0.0.1:4312/relay/media/${key}`],
      media: [{ kind: "document", mime: "text/plain", size: Buffer.byteLength(doc.body), filename: doc.name }],
    },
  } as never, trip.deps);
  await settleDocumentCorrections();
}

async function tap(trip: Trip, data: string, fromId = Number(CHAT)): Promise<void> {
  const update: TelegramUpdate = {
    update_id: 9,
    callback_query: { id: `cbq_${randomBytes(4).toString("hex")}`, data, from: { id: fromId }, message: { message_id: 7, chat: { id: CHAT, type: "private" } } },
  };
  const decision = await dispatchUpdate(trip.pool, update);
  assert.equal(decision.kind, "correction_callback");
  await applyDecision(decision, trip.deps);
}

const BOT = { username: "KineraryTestBot", id: "7000000001" };

/** A Telegram document message, as the poller hands it to dispatchUpdate. */
function documentUpdate(chatId: string, chatType: string, fromId: string, caption?: string): TelegramUpdate {
  return {
    update_id: 21,
    message: {
      message_id: 31,
      from: { id: Number(fromId), first_name: "Sender" },
      chat: { id: chatId, type: chatType },
      document: { file_id: "file_synthetic_1", file_name: "voucher.txt", mime_type: "text/plain" },
      ...(caption ? { caption } : {}),
    },
  } as TelegramUpdate;
}

const count = async (pool: pg.Pool, sql: string, params: unknown[]) => Number((await pool.query<{ n: number }>(sql, params)).rows[0]?.n ?? 0);
const lastButtons = (trip: Trip) => [...trip.telegram.sent].reverse().find((m) => m.buttons.length > 0)?.buttons ?? [];

describe("documents after confirmation", { skip: SKIP ? "no CONTROL_PLANE_TEST_DATABASE_URL" : false }, () => {
  test("a voucher is proposed, and only Approve makes a new version — once", async () => {
    await withConfirmedTrip(async (trip) => {
      await upload(trip, DOCS.voucher, "901");

      assert.ok(trip.telegram.sent.some((m) => m.text === uiString("correctionReading", "en")));
      const [approve, reject] = lastButtons(trip);
      assert.match(approve ?? "", /^dc:dcor_[a-f0-9]{32}:a$/);
      assert.match(reject ?? "", /^dc:dcor_[a-f0-9]{32}:r$/);
      assert.equal(await count(trip.pool, "SELECT count(*)::int AS n FROM control_plane.intake_versions WHERE trip_id = $1", [trip.tripId]), 1, "nothing changed yet");
      assert.equal(await count(trip.pool, "SELECT count(*)::int AS n FROM control_plane.source_artifacts WHERE trip_id = $1 AND review_status = 'pending'", [trip.tripId]), 1);

      await tap(trip, approve!);
      const versions = await trip.pool.query<{ version: number; data: { phases: { data: { accommodation?: { confirmation?: string } }[] } } }>(
        "SELECT version, data FROM control_plane.intake_versions WHERE trip_id = $1 ORDER BY version",
        [trip.tripId],
      );
      assert.equal(versions.rowCount, 2, "approval made exactly one new version");
      assert.equal(versions.rows[1]!.data.phases.data[0]!.accommodation?.confirmation, "GR-4471");
      assert.equal(await count(trip.pool, "SELECT count(*)::int AS n FROM control_plane.trip_document_corrections WHERE trip_id = $1 AND status = 'approved' AND result_version_id IS NOT NULL", [trip.tripId]), 1);
      assert.equal(await count(trip.pool, "SELECT count(*)::int AS n FROM control_plane.source_artifacts WHERE trip_id = $1 AND review_status = 'approved'", [trip.tripId]), 1);
      assert.ok(await count(trip.pool, "SELECT count(*)::int AS n FROM control_plane.trip_answer_sources WHERE trip_id = $1", [trip.tripId]) >= 1, "provenance recorded");
      assert.ok(trip.telegram.sent.some((m) => m.text === uiString("correctionApplied", "en") || m.text === uiString("correctionAppliedSiteLater", "en")));

      await tap(trip, approve!);
      assert.equal(await count(trip.pool, "SELECT count(*)::int AS n FROM control_plane.intake_versions WHERE trip_id = $1", [trip.tripId]), 2, "a second tap applies nothing");
      assert.equal(trip.telegram.acks.at(-1), uiString("correctionAlreadyDecided", "en"));
    });
  });

  test("the same voucher sent again is the same proposal, and costs no second reading", async () => {
    await withConfirmedTrip(async (trip) => {
      await upload(trip, DOCS.voucher, "901");
      await upload(trip, DOCS.voucher, "902");
      assert.equal(trip.runner.calls, 1);
      assert.equal(await count(trip.pool, "SELECT count(*)::int AS n FROM control_plane.trip_document_corrections WHERE trip_id = $1", [trip.tripId]), 1);
    });
  });

  test("only the organizer, from their own chat, can decide", async () => {
    await withConfirmedTrip(async (trip) => {
      await upload(trip, DOCS.voucher, "901");
      const [approve] = lastButtons(trip);
      await tap(trip, approve!, 700000999);
      assert.equal(await count(trip.pool, "SELECT count(*)::int AS n FROM control_plane.trip_document_corrections WHERE trip_id = $1 AND status = 'pending'", [trip.tripId]), 1);
      assert.equal(await count(trip.pool, "SELECT count(*)::int AS n FROM control_plane.intake_versions WHERE trip_id = $1", [trip.tripId]), 1);
    });
  });

  test("Keep as it is changes nothing and closes the deliveries as rejected", async () => {
    await withConfirmedTrip(async (trip) => {
      await upload(trip, DOCS.voucher, "901");
      const [, reject] = lastButtons(trip);
      await tap(trip, reject!);
      assert.equal(await count(trip.pool, "SELECT count(*)::int AS n FROM control_plane.trip_document_corrections WHERE trip_id = $1 AND status = 'rejected'", [trip.tripId]), 1);
      assert.equal(await count(trip.pool, "SELECT count(*)::int AS n FROM control_plane.source_artifacts WHERE trip_id = $1 AND review_status = 'rejected'", [trip.tripId]), 1);
      assert.equal(await count(trip.pool, "SELECT count(*)::int AS n FROM control_plane.intake_versions WHERE trip_id = $1", [trip.tripId]), 1);
    });
  });

  test("a proposal computed against an older version is stale, never applied over the newer one", async () => {
    await withConfirmedTrip(async (trip) => {
      await upload(trip, DOCS.voucher, "901");
      const [approve] = lastButtons(trip);
      const latest = await trip.pool.query<{ data: Record<string, unknown> }>(
        "SELECT data FROM control_plane.intake_versions WHERE trip_id = $1 ORDER BY version DESC LIMIT 1", [trip.tripId],
      );
      const edited = { ...latest.rows[0]!.data, destination: { kind: "text", schema_version: 2, text: "Japan and Korea" } };
      const corrected = await correctIntake(trip.pool, trip.tripId, `user:sha256:${"0".repeat(64)}`, edited);
      assert.ok(corrected.ok, JSON.stringify(corrected));

      await tap(trip, approve!);
      assert.equal(await count(trip.pool, "SELECT count(*)::int AS n FROM control_plane.trip_document_corrections WHERE trip_id = $1 AND status = 'stale'", [trip.tripId]), 1);
      assert.equal(await count(trip.pool, "SELECT count(*)::int AS n FROM control_plane.intake_versions WHERE trip_id = $1", [trip.tripId]), 2, "only the organizer's own edit");
      assert.ok(trip.telegram.sent.some((m) => m.text === uiString("correctionStale", "en")));
    });
  });

  test("a document that says nothing new says so, and proposes nothing", async () => {
    await withConfirmedTrip(async (trip) => {
      await upload(trip, DOCS.copy, "901");
      assert.ok(trip.telegram.sent.some((m) => m.text === uiString("correctionNothingNew", "en")));
      assert.equal(await count(trip.pool, "SELECT count(*)::int AS n FROM control_plane.trip_document_corrections WHERE trip_id = $1", [trip.tripId]), 0);
    });
  });

  test("a disagreement is its own proposal: the document's value replaces the held one only on Approve", async () => {
    await withConfirmedTrip(async (trip) => {
      await upload(trip, DOCS.revised, "901");
      const proposal = await trip.pool.query<{ kind: string }>(
        "SELECT kind FROM control_plane.trip_document_corrections WHERE trip_id = $1", [trip.tripId],
      );
      assert.deepEqual(proposal.rows.map((r) => r.kind), ["replace"]);
      const [approve] = lastButtons(trip);
      await tap(trip, approve!);
      const latest = await trip.pool.query<{ data: { phases: { data: { end: string }[] } } }>(
        "SELECT data FROM control_plane.intake_versions WHERE trip_id = $1 ORDER BY version DESC LIMIT 1", [trip.tripId],
      );
      assert.equal(latest.rows[0]!.data.phases.data[0]!.end, "2026-09-24");
    });
  });

  test("routing: only the organizer's private chat, from the organizer, with a readable file", async () => {
    await withConfirmedTrip(async (trip) => {
      const base = { tripId: trip.tripId, chatId: CHAT, chatType: "private", fromId: CHAT, mediaKinds: ["document"], hasMedia: true, hasRunner: true, canReadImages: false };
      assert.equal((await organizerDocumentRoute(trip.pool, base))?.sessionId, trip.sessionId);
      assert.equal(await organizerDocumentRoute(trip.pool, { ...base, chatType: "supergroup" }), null, "a group keeps its route");
      assert.equal(await organizerDocumentRoute(trip.pool, { ...base, fromId: "700000999" }), null, "someone else");
      assert.equal(await organizerDocumentRoute(trip.pool, { ...base, mediaKinds: ["image"] }), null, "a photo, with no vision runner");
      assert.ok(await organizerDocumentRoute(trip.pool, { ...base, mediaKinds: ["image"], canReadImages: true }));
      assert.equal(await organizerDocumentRoute(trip.pool, { ...base, hasRunner: false }), null, "no model: the old route");
      assert.equal(await organizerDocumentRoute(trip.pool, { ...base, chatId: "880000777", fromId: "880000777" }), null, "not the confirmed chat");
    });
  });

  // #178: the hop `organizerDocumentRoute`'s own test above cannot cover. The
  // route decision used to read `event.media_urls`, which nothing has attached
  // yet at that point, so a confirmed organizer's document never took it.
  test("dispatch: the confirmed organizer's private-chat document is read by the relay, with its file attached", async () => {
    await withConfirmedTrip(async (trip) => {
      const decision = await dispatchUpdate(
        trip.pool, documentUpdate(CHAT, "private", CHAT), undefined, () => {}, BOT,
        { modelRunner: trip.runner, media: (trip.deps as { media: never }).media },
      );
      assert.equal(decision.kind, "document_correction");
      if (decision.kind !== "document_correction") return;
      assert.equal(decision.sessionId, trip.sessionId);
      assert.equal(decision.event.media_urls?.length, 1, "the decision carries the re-hosted file the reader needs");
      assert.equal(decision.event.media?.[0]?.kind, "document");
    });
  });

  test("dispatch: a group member's document, and an unconfirmed sender's, keep the companion route", async () => {
    await withConfirmedTrip(async (trip) => {
      const options = { modelRunner: trip.runner, media: (trip.deps as { media: never }).media };
      // A family group bound to the same trip; the organizer's id sends, addressing the assistant.
      await trip.pool.query(
        "INSERT INTO control_plane.telegram_chat_bindings(id, chat_id, trip_id, hermes_profile) VALUES ($1, '-1009990001', $2, 'companion-test')",
        [id("tcb"), trip.tripId],
      );
      const inGroup = await dispatchUpdate(
        trip.pool, documentUpdate("-1009990001", "supergroup", CHAT, "@KineraryTestBot look"), undefined, () => {}, BOT, options,
      );
      assert.equal(inGroup.kind, "to_gateway", "a group's file is never the relay's to read");

      // A private chat bound to the trip that is NOT the confirmed interview chat.
      await trip.pool.query(
        "INSERT INTO control_plane.telegram_chat_bindings(id, chat_id, trip_id, hermes_profile) VALUES ($1, '880000502', $2, 'companion-test')",
        [id("tcb"), trip.tripId],
      );
      const stranger = await dispatchUpdate(
        trip.pool, documentUpdate("880000502", "private", "880000502"), undefined, () => {}, BOT, options,
      );
      assert.equal(stranger.kind, "to_gateway", "an unconfirmed sender keeps the companion route");
    });
  });
});
