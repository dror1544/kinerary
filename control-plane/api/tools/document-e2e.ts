/**
 * A document through the WHOLE interview path, end to end.
 *
 *   CONTROL_PLANE_TEST_DATABASE_URL=... INTERPRET_RUNNER=codex EXTRACT_RUNNER=codex \
 *     node --import tsx tools/document-e2e.ts <file-or-folder>
 *
 * The difference from `extract-intake-check.ts`, and the reason both exist:
 * that one calls the extractor and the gate directly, which proves the
 * extractor reads your documents. This one drives `flushSettledInboundBursts`
 * against a real database, so it exercises everything the other one skips —
 * the burst claim, `runDocumentPath`'s ordering, the acknowledgement, the
 * actual WRITE through `submitAnswerForChat` with its validation and phase
 * advance, the report-back, and which question the router asks next.
 *
 * Two live bugs today were in exactly that gap: the router asking for a
 * destination while the answer was being read out of the file, and a failed
 * extraction telling the organizer their document was empty. Neither could
 * have shown up in a harness that stops at the gate.
 *
 * Only Telegram is faked. The media store hands back the same bytes the relay
 * would have re-hosted, and the client records what would have been sent — so
 * the transcript printed at the end is what the organizer would have seen.
 *
 * A HARNESS, not a test: it calls a live model, takes minutes, and DESTROYS the
 * database it is given.
 */
import { randomBytes } from "node:crypto";
import { readFile, readdir, stat } from "node:fs/promises";
import { basename, join } from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";
import { applyMigrations } from "../src/migrations.js";
import { issueEnrollment } from "../src/enrollment.js";
import { startFromDeepLink } from "../src/chat-router.js";
import { getSessionForChat, queueInboundMessage, questionStateForChat } from "../src/interview.js";
import { setInterpretPath } from "../src/interpret.js";
import { flushSettledInboundBursts } from "../src/relay/poller.js";
import { modelRunnerFromEnv } from "../src/model-runner.js";

const path = process.argv[2];
const databaseUrl = process.env.CONTROL_PLANE_TEST_DATABASE_URL;
if (!path || !databaseUrl) {
  console.error("usage: CONTROL_PLANE_TEST_DATABASE_URL=... document-e2e.ts <file-or-folder>");
  process.exit(2);
}

const CHAT = "870000001";
const id = (p: string) => `${p}_${randomBytes(16).toString("hex")}`;

/** Stands in for the relay's re-host plane: the bytes, by id, as `put` stored them. */
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
  async sendMessage(p: { text: string; replyMarkup?: { inline_keyboard: { text: string }[][] } }) {
    const buttons = (p.replyMarkup?.inline_keyboard ?? []).flat().map((b) => b.text);
    this.sent.push(p.text + (buttons.length ? `\n   [${buttons.join(" | ")}]` : ""));
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

// ── The documents, as Telegram would have delivered them ─────────────────────

const info = await stat(path);
const entries = info.isDirectory()
  ? (await readdir(path)).filter((f) => !f.startsWith(".")).sort().map((f) => join(path, f))
  : [path];

const store = new FakeMediaStore();
const mediaUrls: string[] = [];
for (const entry of entries) {
  if (!(await stat(entry)).isFile()) continue;
  const key = store.put({ bytes: await readFile(entry), mime: "application/octet-stream", filename: basename(entry) });
  mediaUrls.push(`http://127.0.0.1:4312/relay/media/${key}`);
  console.log(`  attached ${basename(entry)}`);
}
if (mediaUrls.length === 0) {
  console.error("nothing to attach");
  process.exit(1);
}

// ── A real session on a real database ────────────────────────────────────────

const pool = new pg.Pool({ connectionString: databaseUrl });
const client = await pool.connect();
await client.query("DROP SCHEMA IF EXISTS control_plane CASCADE");
await client.query("DROP TABLE IF EXISTS public.control_plane_schema_migrations");
await applyMigrations(client, fileURLToPath(new URL("../../db/migrations/", import.meta.url)));
client.release();

const userId = id("user"), tripId = id("trip");
await pool.query("INSERT INTO control_plane.users(id,status,display_name) VALUES ($1,'active','Owner')", [userId]);
await pool.query("INSERT INTO control_plane.trips(id,slug,lifecycle_state) VALUES ($1,$2,'draft')", [tripId, "doc-e2e"]);
await pool.query(
  "INSERT INTO control_plane.trip_memberships(id,trip_id,user_id,role,status) VALUES ($1,$2,$3,'owner','active')",
  [id("memb"), tripId, userId],
);
const enrollment = await issueEnrollment(pool, userId, tripId, { enrollmentTtlSeconds: 3600 });
if (!enrollment.ok) throw new Error("enrollment failed");
const started = await startFromDeepLink(pool, CHAT, enrollment.token);
if (started.kind !== "started") throw new Error(`start failed: ${started.kind}`);

await setInterpretPath(pool, CHAT, true);
await pool.query("UPDATE control_plane.intake_sessions SET language='he' WHERE telegram_chat_id=$1", [CHAT]);

const telegram = new Recorder();
const runner = modelRunnerFromEnv();
const logs: string[] = [];
const deps = {
  db: pool,
  telegram,
  connector: { pushInbound: () => true },
  modelRunner: runner,
  media: { telegram, store, baseUrl: "http://127.0.0.1:4312", log: () => {} },
  log: (line: string) => logs.push(line),
} as never;

console.log(`\nsession ${started.sessionId} | runner ${runner ? "configured" : "ABSENT"} | ${mediaUrls.length} file(s)\n`);

// ── The upload, exactly as a settled burst ───────────────────────────────────

const before = await questionStateForChat(pool, CHAT);
await queueInboundMessage(pool, CHAT, { text: "", message_id: "9001", media_urls: mediaUrls } as never);

const started_at = Date.now();
await flushSettledInboundBursts(deps, deps.log, 0);
const ms = Date.now() - started_at;

const after = await questionStateForChat(pool, CHAT);
const view = await getSessionForChat(pool, CHAT);

console.log("=== what the organizer would have seen ===\n");
for (const message of telegram.sent) console.log(`  ${message.replace(/\n/g, "\n  ")}\n`);

console.log(`=== ${ms}ms ===`);
const learned = (after?.answered ?? []).filter((q) => !(before?.answered ?? []).includes(q));
console.log(`answered by the document (${learned.length}): ${learned.join(", ") || "(none)"}`);
console.log(`still outstanding (${after?.outstanding.length}): ${(after?.outstanding ?? []).join(", ")}`);
console.log(`asks next: ${view.ok ? view.view.nextQuestion?.id ?? "(nothing)" : "?"}`);
console.log(`phase: ${view.ok ? view.view.phase : "?"} | awaiting: ${view.ok ? view.view.awaiting : "?"}`);

const interesting = logs.filter((l) => /document_|interpret_|required_/.test(l));
console.log(`\n=== events ===`);
for (const line of interesting) console.log(`  ${line.slice(0, 200)}`);

await pool.end();
