/**
 * Real-document acceptance: files through the relay's ACTUAL document path, with
 * a real model, against a disposable test database — and everything needed to
 * compare the outcome with a label written by hand.
 *
 *   CONTROL_PLANE_TEST_DATABASE_URL=postgres://postgres:test@127.0.0.1:5434/cptest \
 *   node --import tsx tools/document-acceptance.ts \
 *     --provider codex:gpt-5.6-luna --file "/path/first.pdf" [--file second.pdf] \
 *     --out /somewhere/outside/git/result.json [--language he]
 *
 * Production code does the work: `applyDecision`, the settled-burst claim,
 * `ingestDocument` into the registry and a directory store, per-document
 * extraction, the gate, `submitAnswerForChat`, provenance and conflicts, and the
 * day-by-day fold. Only the edges are stand-ins: Telegram (a recorder) and the
 * relay's media store (the same bytes it would have re-hosted).
 *
 * THE DATABASE IS WIPED. `testDatabaseUrl()` refuses any database whose name
 * does not say it is for tests, exactly as the test suites do. Real documents
 * and results stay wherever --file and --out point: keep both outside git.
 */
import { randomBytes } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";
import { startFromDeepLink } from "../src/chat-router.js";
import { filesystemDocumentStore } from "../src/document-store.js";
import { issueEnrollment } from "../src/enrollment.js";
import { setInterpretPath } from "../src/interpret.js";
import { answersForChat } from "../src/interview.js";
import { applyMigrations } from "../src/migrations.js";
import { composeRunners, runnerForBinding, type StructuredModelRunner } from "../src/model-runner.js";
import { DEFAULT_STRINGS } from "../src/relay/dispatch.js";
import { advanceRouterOwnedQuestions, applyDecision, flushSettledInboundBursts } from "../src/relay/poller.js";
import { testDatabaseUrl } from "../test/support/test-database.js";

const MIGRATIONS = fileURLToPath(new URL("../../db/migrations/", import.meta.url));
const CHAT = "880000777";
const TIMEOUT_MS = 240_000;

function args() {
  const argv = process.argv.slice(2);
  const all = (flag: string) => argv.flatMap((a, i) => (a === flag && argv[i + 1] ? [argv[i + 1]!] : []));
  const provider = all("--provider")[0];
  const files = all("--file");
  const out = all("--out")[0];
  if (!provider || files.length === 0 || !out) {
    console.error("usage: document-acceptance.ts --provider <runner:model> --file <path>… --out <result.json> [--language he|en] [--burst] [--vision <runner:model>]");
    process.exit(2);
  }
  return {
    provider,
    files,
    out,
    language: all("--language")[0] ?? "he",
    // All files as ONE upload — the way an organizer forwards a folder — rather
    // than one message, and one read, at a time.
    burst: argv.includes("--burst"),
    // A separate runner for photos and scans, for a text provider that cannot take files.
    vision: all("--vision")[0],
  };
}

/** One provider for every document task it can serve. Vision only where the runner can take files. */
function runnerFor(provider: string, vision?: string): StructuredModelRunner {
  const binding = (spec: string) => {
    const [kind, ...rest] = spec.split(":");
    return { kind: kind!, model: rest.join(":") };
  };
  const text = binding(provider);
  const byTask: Record<string, StructuredModelRunner> = {};
  for (const task of ["extract_intake", "extract_itinerary", "read_image"]) {
    const use = task === "read_image" && vision ? binding(vision) : text;
    const runner = runnerForBinding(use.kind, use.model, TIMEOUT_MS, task);
    if (runner) byTask[task] = runner;
  }
  if (!byTask.extract_intake) throw new Error(`${provider} cannot serve extract_intake here (unknown runner, or no key)`);
  return composeRunners(byTask);
}

function mimeFor(file: string): string {
  const ext = path.extname(file).toLowerCase();
  return ({
    ".pdf": "application/pdf",
    ".jpg": "image/jpeg",
    ".jpeg": "image/jpeg",
    ".png": "image/png",
    ".docx": "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    ".xlsx": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  } as Record<string, string>)[ext] ?? "application/octet-stream";
}

class MediaStore {
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

class Telegram {
  readonly sent: { at: number; text: string; buttons: string[] }[] = [];
  async sendMessage(p: { text: string; replyMarkup?: { inline_keyboard: { callback_data: string }[][] } }) {
    this.sent.push({ at: Date.now(), text: p.text, buttons: (p.replyMarkup?.inline_keyboard ?? []).flat().map((b) => b.callback_data) });
    return { ok: true as const, messageId: String(this.sent.length) };
  }
  async editMessageText() { return { ok: true as const }; }
  async sendChatAction() {}
  async answerCallbackQuery() {}
  async getChatInfo() { return null; }
  async getMe() { return { id: "7000000001", username: "KineraryAcceptanceBot" }; }
  async getUpdates() { return []; }
  async deleteWebhookIfPresent() {}
}

const id = (prefix: string) => `${prefix}_${randomBytes(16).toString("hex")}`;

async function main(): Promise<void> {
  const { provider, files, out, language, burst, vision } = args();
  const url = testDatabaseUrl();
  if (!url) throw new Error("CONTROL_PLANE_TEST_DATABASE_URL is not set");
  const runner = runnerFor(provider, vision);

  const pool = new pg.Pool({ connectionString: url });
  const root = await mkdtemp(path.join(tmpdir(), "doc-acceptance-"));
  try {
    const client = await pool.connect();
    try {
      await client.query("DROP SCHEMA IF EXISTS control_plane CASCADE");
      await client.query("DROP TABLE IF EXISTS public.control_plane_schema_migrations");
      await applyMigrations(client, MIGRATIONS);
    } finally {
      client.release();
    }

    const userId = id("user");
    const tripId = id("trip");
    await pool.query("INSERT INTO control_plane.users(id, status, display_name) VALUES ($1, 'active', 'Organizer')", [userId]);
    await pool.query("INSERT INTO control_plane.trips(id, slug, lifecycle_state) VALUES ($1, $2, 'draft')", [tripId, tripId.replace(/_/g, "-")]);
    await pool.query(
      "INSERT INTO control_plane.trip_memberships(id, trip_id, user_id, role, status) VALUES ($1, $2, $3, 'owner', 'active')",
      [id("memb"), tripId, userId],
    );
    const enrollment = await issueEnrollment(pool, userId, tripId, { enrollmentTtlSeconds: 3600 });
    if (!enrollment.ok) throw new Error("enrollment failed");
    const started = await startFromDeepLink(pool, CHAT, enrollment.token, () => {}, language);
    if (started.kind !== "started") throw new Error(`session did not start: ${started.kind}`);
    await setInterpretPath(pool, CHAT, true);

    const media = new MediaStore();
    const telegram = new Telegram();
    const logs: string[] = [];
    const log = (line: string) => logs.push(line);
    const deps = {
      db: pool,
      telegram,
      connector: { pushInbound: () => true },
      modelRunner: runner,
      documentStore: filesystemDocumentStore(root),
      media: { telegram, store: media, baseUrl: "http://127.0.0.1:4312", log: () => {} },
      log,
    } as never;

    const uploads: Record<string, unknown>[] = [];
    for (const [index, file] of files.entries()) {
      const bytes = await readFile(file);
      const mime = mimeFor(file);
      const kind = mime.startsWith("image/") ? "image" : "document";
      const key = media.put({ bytes, mime, filename: path.basename(file) });
      const sentBefore = telegram.sent.length;
      const t0 = Date.now();
      await applyDecision({
        kind: "interview_to_gateway",
        chatId: CHAT,
        sessionId: started.sessionId,
        hadAttachment: true,
        event: {
          text: "",
          message_id: String(900 + index),
          message_type: kind,
          source: { chat_id: CHAT },
          media_urls: [`http://127.0.0.1:4312/relay/media/${key}`],
          media: [{ kind, mime, size: bytes.byteLength, filename: path.basename(file) }],
        },
      } as never, deps);
      // In a burst, every file lands first and the burst is read once, after the last.
      if (burst && index < files.length - 1) continue;
      await flushSettledInboundBursts(deps, log, 0);
      await advanceRouterOwnedQuestions(deps, DEFAULT_STRINGS, log);
      uploads.push({
        file: path.basename(file),
        ms: Date.now() - t0,
        messages: telegram.sent.slice(sentBefore).map((m) => ({ text: m.text, buttons: m.buttons })),
      });
    }

    const store = await answersForChat(pool, CHAT);
    const q = async (sql: string) => (await pool.query(sql, [tripId])).rows;
    const result = {
      provider,
      language,
      files: files.map((f) => path.basename(f)),
      uploads,
      answers: store?.answers ?? null,
      documents: await q(
        `SELECT d.id, d.content_digest, d.byte_size, d.mime, d.ingest_state,
                (SELECT array_agg(DISTINCT a.filename) FROM control_plane.source_artifacts a WHERE a.document_id = d.id) AS filenames,
                (SELECT count(*)::int FROM control_plane.source_artifacts a WHERE a.document_id = d.id) AS deliveries
           FROM control_plane.trip_documents d WHERE d.trip_id = $1 ORDER BY d.created_at`,
      ),
      extractions: await q(
        `SELECT document_id, reader_version, extractor_version, provider, model, status, text_chars, truncated, coverage,
                jsonb_array_length(COALESCE(result->'proposals', '[]'::jsonb)) AS proposals
           FROM control_plane.trip_document_extractions WHERE trip_id = $1 ORDER BY created_at`,
      ),
      provenance: await q(
        `SELECT question_id, entry_key, document_id, disposition, paths
           FROM control_plane.trip_answer_sources WHERE trip_id = $1 ORDER BY question_id, entry_key, disposition`,
      ),
      conflicts: await q(
        `SELECT question_id, entry_key, path, held, incoming, document_id, status
           FROM control_plane.trip_answer_conflicts WHERE trip_id = $1`,
      ),
      warnings: logs.filter((line) => /"level":"(warn|error)"/.test(line)),
      // Every document and itinerary event, whatever its level: an itinerary
      // extraction that fails is logged at info, and is exactly what explains
      // a day-by-day that never arrived.
      document_events: logs.filter((line) => /"event":"(interview\.(document|itinerary|interpret)|document\.)/.test(line)),
    };
    await writeFile(out, `${JSON.stringify(result, null, 2)}\n`);
    console.log(JSON.stringify({ out, provider, uploads: uploads.map((u) => ({ file: u.file, ms: u.ms })) }));
  } finally {
    await pool.end();
    await rm(root, { recursive: true, force: true });
  }
}

await main();
