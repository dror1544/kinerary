/**
 * A whole interview on the interpret path, end to end.
 *
 * Real database, real model, real router. Telegram is a recorder, so the
 * transcript it prints is literally what the organizer would have seen. The
 * interviewer agent is never started — and on this path the guard means it
 * could not write even if it were.
 *
 * This is a HARNESS, not a test: it calls a live model, takes minutes, and
 * DESTROYS the database it is given. It is here rather than in `test/` for
 * exactly those reasons, and it is here rather than in a scratch directory
 * because the numbers it prints — per-question latency, what the gate accepted,
 * whether the interview terminates — are the measurement §8 of
 * docs/interview-without-an-agent.md asks for, and they should be reproducible
 * by whoever asks the question next.
 *
 *   CONTROL_PLANE_TEST_DATABASE_URL="postgres://postgres:test@127.0.0.1:5434/cptest" \
 *   INTERPRET_RUNNER=codex INTERPRET_TIMEOUT_MS=120000 \
 *     node --import tsx tools/interview-e2e.ts
 *
 * It stops where a person would have to tap a button: the "that is everything"
 * boundary offers a keyboard, and this harness only writes text.
 */
import { randomBytes } from "node:crypto";
import { fileURLToPath } from "node:url";
import pg from "pg";

const API = "./src";
const { applyMigrations } = await import(`../src/migrations.js`);
const { issueEnrollment } = await import(`../src/enrollment.js`);
const { startFromDeepLink } = await import(`../src/chat-router.js`);
const { queueInboundMessage, getSessionForChat, questionStateForChat } = await import(`../src/interview.js`);
const { setInterpretPath, findInterpretation, burstKey } = await import(`../src/interpret.js`);
const { flushSettledInboundBursts } = await import(`../src/relay/poller.js`);
const { modelRunnerFromEnv } = await import(`../src/model-runner.js`);

const databaseUrl = process.env.CONTROL_PLANE_TEST_DATABASE_URL!;
const migrationsDir = fileURLToPath(new URL("../../db/migrations/", import.meta.url));
const id = (p: string) => `${p}_${randomBytes(16).toString("hex")}`;
const CHAT = "850000001";

class FakeTelegram {
  readonly sent: { text: string; buttons: string[] }[] = [];
  async sendMessage(p: { text: string; replyMarkup?: { inline_keyboard: { text: string }[][] } }) {
    this.sent.push({ text: p.text, buttons: (p.replyMarkup?.inline_keyboard ?? []).flat().map((b) => b.text) });
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
class FakeConnector {
  readonly pushed: unknown[] = [];
  pushInbound(e: unknown) { this.pushed.push(e); return true; }
}

// What the organizer says, keyed by the question the router has on screen.
// Hebrew throughout, and several of these answer more than one question at
// once — the case the design claims to handle better than the agent did.
const ANSWERS: Record<string, string> = {
  trip_type: "טיול משפחתי, אנחנו וההורים",
  destination: "יפן — טוקיו, האקונה, קיוטו ואוסקה",
  departure_date: "יוצאים ב-19 בספטמבר 2026 וחוזרים ב-3 באוקטובר",
  return_date: "ה-3 באוקטובר 2026",
  travelers: "דרור אלול, שירן אלול, נועם אלול ויעל אלול",
  phases: "טוקיו 19-23 בספטמבר, האקונה 23-24, קיוטו 24-27, אוסקה 27-30, ואז חזרה לטוקיו עד ה-3 באוקטובר",
  bot_name: "קורא לו יומי",
  bot_gender: "זכר",
  bot_tone: "חמים ונעים",
  trip_interests: "אוכל, מקדשים, וטיולים רגליים",
  timezone: "שעון יפן",
  trip_pace: "מאוזן, לא רוצים לרוץ",
  dietary: "כשר סטייל, ואחד מאיתנו רגיש ללקטוז",
  organizer_identity: "דרור, אבא של המשפחה",
  home_country: "ישראל",
  planning_help: "בעיקר לסדר את הימים",
};
const FALLBACK = "בוא נמשיך";

const pool = new pg.Pool({ connectionString: databaseUrl });
const client = await pool.connect();
await client.query("DROP SCHEMA IF EXISTS control_plane CASCADE");
await client.query("DROP TABLE IF EXISTS public.control_plane_schema_migrations");
await applyMigrations(client, migrationsDir);
client.release();

const userId = id("user"), tripId = id("trip");
await pool.query("INSERT INTO control_plane.users(id,status,display_name) VALUES ($1,'active','Dror')", [userId]);
await pool.query("INSERT INTO control_plane.trips(id,slug,lifecycle_state) VALUES ($1,$2,'draft')", [tripId, "japan-e2e"]);
await pool.query("INSERT INTO control_plane.trip_memberships(id,trip_id,user_id,role,status) VALUES ($1,$2,$3,'owner','active')", [id("memb"), tripId, userId]);
const enrollment = await issueEnrollment(pool, userId, tripId, { enrollmentTtlSeconds: 3600 });
const started = await startFromDeepLink(pool, CHAT, enrollment.token);
if (started.kind !== "started") throw new Error(`start failed: ${started.kind}`);

await setInterpretPath(pool, CHAT, true);
await pool.query("UPDATE control_plane.intake_sessions SET language='he' WHERE telegram_chat_id=$1", [CHAT]);

const runner = modelRunnerFromEnv();
const telegram = new FakeTelegram();
const connector = new FakeConnector();
const logs: string[] = [];
const deps = { db: pool, telegram, connector, modelRunner: runner, log: (l: string) => logs.push(l) } as never;

console.log(`interpret path: on   |  model runner: ${runner ? "configured" : "ABSENT"}`);
console.log(`session ${started.sessionId}\n`);

let messageId = 1000;
let sentSeen = 0;
const turns: { asked: string; said: string; ms: number; accepted: number; rejected: string[]; reason?: string }[] = [];

// Kick the router into asking its first question.
await flushSettledInboundBursts(deps, deps.log, 0);

for (let turn = 1; turn <= 24; turn += 1) {
  const before = await getSessionForChat(pool, CHAT);
  if (!before.ok) { console.log("session gone"); break; }
  const view = before.view;

  // What is on screen right now?
  for (const m of telegram.sent.slice(sentSeen)) {
    console.log(`  BOT: ${m.text.replace(/\n/g, " ⏎ ")}${m.buttons.length ? `  [${m.buttons.join(" | ")}]` : ""}`);
  }
  sentSeen = telegram.sent.length;

  if (view.state === "awaiting_confirmation") { console.log("\n>>> reached the recap <<<"); break; }
  const question = view.nextQuestion ?? view.pendingAsk ?? view.optionalRemaining[0] ?? null;
  if (!question) { console.log("\n>>> nothing left to ask <<<"); break; }

  const say = ANSWERS[question.id] ?? FALLBACK;
  console.log(`  YOU: ${say}`);

  messageId += 1;
  const mid = String(messageId);
  await queueInboundMessage(pool, CHAT, { text: say, message_id: mid } as never);
  const t0 = Date.now();
  await flushSettledInboundBursts(deps, deps.log, 0);
  const ms = Date.now() - t0;

  const row = await findInterpretation(pool, CHAT, burstKey([mid], say));
  const accepted = row?.outcomes.accepted?.length ?? 0;
  const rejected = (row?.outcomes.rejected ?? []).map((r: { questionId: string; reason: string }) => `${r.questionId}:${r.reason}`);
  turns.push({ asked: question.id, said: say, ms, accepted, rejected, reason: row?.failureReason ?? undefined });
  const acc = (row?.outcomes.accepted ?? []).map((a: { questionId: string }) => a.questionId).join(",");
  console.log(`       [${ms}ms  accepted: ${acc || "—"}${rejected.length ? `  rejected: ${rejected.join(" ")}` : ""}${row?.failureReason ? `  FAILED: ${row.failureReason}` : ""}]\n`);
}

const state = await questionStateForChat(pool, CHAT);
const final = await getSessionForChat(pool, CHAT);

console.log("\n=== per turn ===");
console.log(`${"asked".padEnd(20)} ${"ms".padStart(7)} ${"acc".padStart(4)}  rejected`);
for (const t of turns) console.log(`${t.asked.padEnd(20)} ${String(t.ms).padStart(7)} ${String(t.accepted).padStart(4)}  ${t.rejected.join(" ")}${t.reason ? ` FAILED:${t.reason}` : ""}`);

const times = turns.map((t) => t.ms).sort((a, b) => a - b);
const pct = (p: number) => times.length ? times[Math.min(times.length - 1, Math.floor(times.length * p))] : 0;
console.log(`\nturns ${turns.length} | p50 ${pct(0.5)}ms | p95 ${pct(0.95)}ms | max ${times[times.length - 1] ?? 0}ms`);
console.log(`accepted total ${turns.reduce((n, t) => n + t.accepted, 0)} | model failures ${turns.filter((t) => t.reason).length}`);
console.log(`\nanswered (${state?.answered.length}): ${state?.answered.join(", ")}`);
console.log(`outstanding (${state?.outstanding.length}): ${state?.outstanding.join(", ")}`);
console.log(`state: ${final.ok ? final.view.state : "?"} | phase: ${final.ok ? final.view.phase : "?"}`);
const agentTurns: number = (await pool.query("SELECT count(*)::int c FROM control_plane.interview_agent_turns")).rows[0].c;
console.log(`agent turns opened: ${agentTurns}`);
console.log(`pushed to gateway: ${connector.pushed.length}`);

// A VERDICT, so a preflight can run this unattended. The interpret path works
// when the interview reaches the recap, the model never failed a turn, and the
// agent was never in the loop — the third is the one that silently regresses.
const problems: string[] = [];
if (!final.ok || final.view.state !== "awaiting_confirmation") problems.push("did not reach the recap");
const failures = turns.filter((t) => t.reason).length;
if (failures > 0) problems.push(`${failures} model failure(s)`);
if (agentTurns > 0) problems.push(`${agentTurns} agent turn(s) opened`);
console.log(problems.length ? `\nVERDICT: FAIL — ${problems.join("; ")}` : "\nVERDICT: PASS");
process.exitCode = problems.length ? 1 : 0;

await pool.end();
