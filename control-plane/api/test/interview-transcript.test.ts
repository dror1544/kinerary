/**
 * The transcript harness — Track 4's first piece, and the reason it comes
 * first.
 *
 * Six live runs on 2026-09-04 produced six regressions, every one of them
 * found by a person on a phone rather than by CI, while 568 tests passed
 * throughout. The reason is structural: the suite asserts units, and every
 * defect an organizer actually hit lives in the CONVERSATION —
 *
 *   - the recap landing on top of a live question (run 2)
 *   - the same question arriving five times (runs 5 and 6)
 *   - English strings inside a Hebrew interview (runs 2, 3, 4)
 *   - an option question arriving as a numbered list (runs 2, 6)
 *   - a session with no reachable path to confirmation (run 6)
 *   - the agent reading its own field ids aloud (run 5)
 *
 * None of those is visible to a unit test of the function that caused it.
 * All six are visible in the sequence of messages the organizer received.
 *
 * So this file asserts on the transcript. `Transcript` records what the
 * organizer would have seen, and `check()` runs every standing assertion at
 * once — each one is a past run, named in its failure message, so a
 * reintroduction says which run it is bringing back.
 *
 * Standing assertions live in one place ON PURPOSE. A conversation-level
 * invariant that is spot-checked in the one test that thought of it is how
 * these defects kept returning through a different route: buttons came back
 * as numbered lists twice, in different code paths, months apart.
 */
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { describe, test } from "node:test";
import { fileURLToPath } from "node:url";
import pg from "pg";
import { applyMigrations } from "../src/migrations.js";
import { askText, uiString, type Language } from "../src/intake-copy.js";
import {
  INTAKE_QUESTIONS,
  getSessionForChat,
  AGENT_FLOOR_SECONDS,
  applyDerivationsForChat,
  markAwaitingMachine,
  nextPhase,
  nominateQuestionForChat,
  setFinishRequestedForChat,
  openAgentTurn,
  sayForChat,
  submitAnswerForAgent,
  submitAnswerForChat,
  type IntakeQuestion,
} from "../src/interview.js";
import { issueEnrollment } from "../src/enrollment.js";
import { startFromDeepLink } from "../src/chat-router.js";
import { dispatchUpdate, DEFAULT_STRINGS } from "../src/relay/dispatch.js";
import {
  applyDecision,
  recoverStalledInterviews,
  renderDueRouterPrompts,
} from "../src/relay/poller.js";
import { detectInternalLeak } from "../src/relay/internal-leak.js";
import type { TelegramUpdate } from "../src/relay/normalize.js";
import type { WireMessageEvent } from "../src/relay/protocol.js";
import type { BotSelf, ChatInfo, SendResult, TelegramClient } from "../src/relay/telegram-api.js";

const databaseUrl = process.env.CONTROL_PLANE_TEST_DATABASE_URL;
const SKIP = !databaseUrl;
const migrationsDir = fileURLToPath(new URL("../../db/migrations/", import.meta.url));

function testId(prefix: string): string {
  return `${prefix}_${randomBytes(16).toString("hex")}`;
}

// ── What the organizer saw ───────────────────────────────────────────────────

interface Line {
  text: string;
  buttons: string[];
  /**
   * The dialect the message was sent in.
   *
   * Asserted because run 7 shipped raw asterisks: the connector always sent
   * agent text as MarkdownV2, and routing the same text through the router
   * instead passed no parse mode at all. A harness that only reads text cannot
   * see that — the words are identical, the rendering is not.
   */
  parseMode: string | null;
  /** Which intake question this message put, if it is recognisably one. */
  questionId: string | null;
  /**
   * Which language's copy table this text was drawn from.
   *
   * Recorded rather than checked at classification time, and that distinction
   * matters: an earlier version of this harness classified against the
   * session's language only, so a question drawn in the WRONG language matched
   * nothing, came back as "not a question", and sailed past the very assertion
   * written to catch it. Recognise first, judge second.
   */
  drawnIn: Language | null;
}

/**
 * Reads a message back the way the organizer's thumb would.
 *
 * Button payloads are the reliable signal — `a:<id>:<opt>` answers a choice,
 * `t:<id>:<opt>` toggles a multi-select — so a message carrying them is
 * unambiguously that question. Text questions have no payload to read, so they
 * are matched against the copy table in EITHER language.
 */
function classify(text: string, buttons: string[], parseMode: string | null): Line {
  let questionId: string | null = null;
  for (const data of buttons) {
    const m = /^[at]:([a-z_]+):/.exec(data);
    if (m) { questionId = m[1] ?? null; break; }
  }
  for (const q of INTAKE_QUESTIONS) {
    for (const lang of ["en", "he"] as const) {
      if (text.includes(askText(q, lang))) {
        return { text, buttons, parseMode, questionId: questionId ?? q.id, drawnIn: lang };
      }
    }
  }
  return { text, buttons, parseMode, questionId, drawnIn: null };
}

class Transcript implements TelegramClient {
  readonly lines: Line[] = [];
  readonly answered: { callbackQueryId: string; text?: string }[] = [];
  language: Language = "en";
  queued: unknown[][] = [];
  /**
   * Where in the transcript each question became answered.
   *
   * Populated by the test driver rather than read from the database, because
   * what matters is the ORDER relative to the messages: "was this already
   * answered when it was asked?" is a question about the transcript, and the
   * database only knows the end state.
   */
  readonly answeredAt = new Map<string, number>();

  async sendMessage(params: {
    chatId: string;
    text: string;
    replyMarkup?: { inline_keyboard: { text: string; callback_data: string }[][] };
    parseMode?: string;
  }): Promise<SendResult> {
    const buttons = (params.replyMarkup?.inline_keyboard ?? []).flat().map((b) => b.callback_data);
    this.lines.push(classify(params.text, buttons, params.parseMode ?? null));
    return { ok: true, messageId: String(this.lines.length) };
  }
  async editMessageText(): Promise<SendResult> { return { ok: true }; }
  async sendChatAction(): Promise<void> { /* no-op */ }
  async answerCallbackQuery(p: { callbackQueryId: string; text?: string }): Promise<void> {
    this.answered.push(p);
  }
  async getChatInfo(): Promise<ChatInfo | null> { return null; }
  async getMe(): Promise<BotSelf | null> { return { id: "7000000001", username: "KineraryTestBot" }; }
  async getUpdates(): Promise<unknown[]> { return this.queued.shift() ?? []; }
  async deleteWebhookIfPresent(): Promise<void> { /* no-op */ }

  get last(): Line | undefined { return this.lines[this.lines.length - 1]; }

  /** Called by the driver the moment an answer is recorded, tap or extraction. */
  noteAnswered(questionId: string): void {
    if (!this.answeredAt.has(questionId)) this.answeredAt.set(questionId, this.lines.length);
  }

  /** Every message that put a given question. More than one is the bug. */
  asking(questionId: string): Line[] {
    return this.lines.filter((l) => l.questionId === questionId);
  }

  // ── Standing assertions ───────────────────────────────────────────────────
  //
  // Each names the run it comes from. Run them all with check().

  /** Runs 5 and 6: "Again it bombarding me with messages". */
  assertNoRepeatedMessage(): void {
    const seen = new Map<string, number>();
    for (const line of this.lines) {
      const n = (seen.get(line.text) ?? 0) + 1;
      seen.set(line.text, n);
      assert.equal(n, 1, `run 5/6 regression — the organizer got this twice:\n  ${line.text.slice(0, 120)}`);
    }
  }

  /** Runs 2 and 6: an option question that degraded to "reply with a number". */
  assertOptionQuestionsAreTappable(): void {
    const byId = new Map(INTAKE_QUESTIONS.map((q) => [q.id, q] as const));
    for (const line of this.lines) {
      if (!line.questionId) continue;
      const q = byId.get(line.questionId) as IntakeQuestion | undefined;
      if (!q || (q.type !== "choice" && q.type !== "multi_choice")) continue;
      assert.ok(
        line.buttons.length > 0,
        `run 2/6 regression — "${q.id}" is a ${q.type} question and arrived with no keyboard, ` +
          `which is what makes it degrade to a numbered list:\n  ${line.text.slice(0, 120)}`,
      );
    }
  }

  /**
   * Runs 2, 3 and 4: "still mix of hebrew and english".
   *
   * Checks the half we can check mechanically and completely — anything the
   * ROUTER drew has to come from the copy table for this session's language.
   * A question rendered from the other language's table is caught exactly,
   * with no guessing about scripts or proper nouns.
   */
  assertRouterTextIsInSessionLanguage(): void {
    for (const line of this.lines) {
      if (!line.drawnIn) continue;
      assert.equal(
        line.drawnIn,
        this.language,
        `run 2/3/4 regression — "${line.questionId}" was drawn in ${line.drawnIn} ` +
          `inside a ${this.language} interview:\n  ${line.text.slice(0, 120)}`,
      );
    }
  }

  /**
   * Run 6: it asked "לאן נוסעים?" after the document had already answered it.
   *
   * Stated as "never ask what the record already answers", not "never ask
   * twice" — a distinction the watchdog forced, and the sharper rule for it.
   * Re-asking an UNANSWERED question after the interviewer stalls is the
   * recovery working; asking one the organizer has already answered is the
   * defect, whether it happens once or five times.
   */
  assertNeverAsksAnsweredQuestion(): void {
    this.lines.forEach((line, index) => {
      if (!line.questionId) return;
      const answeredAt = this.answeredAt.get(line.questionId);
      assert.ok(
        answeredAt === undefined || answeredAt > index,
        `run 6 regression — "${line.questionId}" was put to the organizer after it was already ` +
          `recorded (answered at line ${answeredAt}, asked again at line ${index})`,
      );
    });
  }

  /** Run 5: the agent read its own field ids and tool names aloud. */
  assertNoInternalLeak(): void {
    for (const line of this.lines) {
      const verdict = detectInternalLeak(line.text);
      assert.equal(
        verdict.leaks,
        false,
        `run 5 regression — internal vocabulary reached the organizer (${verdict.term}):\n  ${line.text.slice(0, 120)}`,
      );
    }
  }

  /** Everything except termination, which needs the session and so is separate. */
  check(): void {
    this.assertNoRepeatedMessage();
    this.assertOptionQuestionsAreTappable();
    this.assertRouterTextIsInSessionLanguage();
    this.assertNeverAsksAnsweredQuestion();
    this.assertNoInternalLeak();
  }
}

class FakeConnector {
  readonly pushed: WireMessageEvent[] = [];
  pushInbound(event: WireMessageEvent): boolean {
    this.pushed.push(event);
    return true;
  }
}

// ── Driving a conversation ───────────────────────────────────────────────────

interface Fixture {
  pool: pg.Pool;
  tripId: string;
  userId: string;
  chat: string;
  script: Transcript;
  connector: FakeConnector;
}

/**
 * Serializes conversations across this file.
 *
 * Each one drops and recreates the whole schema, and the runner is free to
 * interleave suites — which it does now that there are four. Two tests
 * migrating the same database at once fails with "relation
 * control_plane_schema_migrations does not exist", a confusing error that has
 * nothing to do with what is being tested. One at a time, so a failure here
 * always means the interview did something wrong.
 */
let conversations: Promise<unknown> = Promise.resolve();
function serialized<T>(fn: () => Promise<T>): Promise<T> {
  const next = conversations.then(fn, fn);
  conversations = next.catch(() => undefined);
  return next;
}

async function withConversation(fn: (fix: Fixture) => Promise<void>): Promise<void> {
  return serialized(() => runConversation(fn));
}

async function runConversation(fn: (fix: Fixture) => Promise<void>): Promise<void> {
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
    const userId = testId("user");
    const tripId = testId("trip");
    await pool.query(
      "INSERT INTO control_plane.users(id, status, display_name) VALUES ($1, 'active', 'Owner')",
      [userId],
    );
    await pool.query("INSERT INTO control_plane.trips(id, slug, lifecycle_state) VALUES ($1, $2, 'draft')", [
      tripId,
      tripId.replace(/_/g, "-"),
    ]);
    await pool.query(
      "INSERT INTO control_plane.trip_memberships(id, trip_id, user_id, role, status) VALUES ($1, $2, $3, 'owner', 'active')",
      [testId("memb"), tripId, userId],
    );
    await fn({
      pool,
      tripId,
      userId,
      chat: "770000001",
      script: new Transcript(),
      connector: new FakeConnector(),
    });
  } finally {
    await pool.end();
  }
}

/**
 * Runs the router's side of a turn: whatever the agent has written is now
 * delivered.
 *
 * Deliberately the real `renderDueRouterPrompts` rather than a stand-in — a
 * harness that reimplements the router would assert on the harness. Settle
 * window 0 because the test controls the writes exactly; production waits, and
 * that wait is the run-6 flood fix.
 */
async function deliverPendingRouterPrompt(fix: Fixture): Promise<void> {
  await renderDueRouterPrompts(
    { db: fix.pool, telegram: fix.script, connector: fix.connector },
    DEFAULT_STRINGS,
    () => {},
    0,
  );
}

/**
 * One full iteration of the real poll loop: dispatch decides, applyDecision
 * acts, then anything owed to the router is delivered.
 *
 * The last step is not optional. Phase transitions schedule a router prompt of
 * their own, and a harness that skipped the delivery left the session in a
 * state production never reaches — which made the watchdog look broken when it
 * was the test that was wrong.
 */
async function turn(fix: Fixture, update: TelegramUpdate): Promise<void> {
  const decision = await dispatchUpdate(fix.pool, update);
  await applyDecision(decision, { db: fix.pool, telegram: fix.script, connector: fix.connector });
  await deliverPendingRouterPrompt(fix);
}

/**
 * The stubbed interviewer: records an answer the way the agent does, without a
 * model.
 *
 * Two of the six required questions — `travelers` and `phases` — are
 * `structured`, and the router cannot parse free text into an array. So a
 * router-only interview CANNOT be completed by tapping and typing; it needs
 * something that extracts. That is not a limitation of this harness, it is the
 * shape of the product, and it is exactly why Track 4 keeps the agent rather
 * than replacing it with a script.
 */
async function agentRecords(
  fix: Fixture,
  questionId: string,
  value: string | unknown[],
): Promise<void> {
  const result = Array.isArray(value)
    ? await submitAnswerForChat(fix.pool, fix.chat, questionId, null, undefined, value)
    : await submitAnswerForChat(fix.pool, fix.chat, questionId, null, value);
  assert.ok(result.ok, `the stubbed agent could not record ${questionId}: ${JSON.stringify(result)}`);
  fix.script.noteAnswered(questionId);
}

/**
 * Answers everything still outstanding, thumb-first: taps a button when one is
 * offered, hands structured questions to the stubbed agent, types otherwise.
 *
 * Returns when no required question remains, or throws if it stops making
 * progress — a loop that silently gives up would turn "the interview dead-ends"
 * into a passing test, which is the run-6 defect wearing a disguise.
 */
async function answerEverythingRequired(fix: Fixture): Promise<void> {
  // What the organizer would have typed, and the stubbed agent extracts. The
  // router refuses typed answers outright when no interviewer is configured
  // ("that part of me is still being connected"), so a written answer has no
  // path to the record except through the agent — which is the division Track 4
  // formalises rather than changes.
  const written: Record<string, string | unknown[]> = {
    destination: "Japan",
    departure_date: "2026-09-19",
    return_date: "2026-10-03",
    travelers: [{ name: "Dror", age: 44, household: "Elul" }, { name: "Noa", age: 12, household: "Elul" }],
    phases: [{ name: "Tokyo", start: "2026-09-19", end: "2026-09-26" }],
  };

  for (let guard = 0; guard < 40; guard += 1) {
    const view = await getSessionForChat(fix.pool, fix.chat);
    assert.ok(view.ok, "the session exists throughout");
    const next = view.view.nextQuestion;
    if (!next) return;

    const line = fix.script.last;
    const button = line?.questionId === next.id ? line.buttons.find((b) => b.startsWith("a:")) : undefined;
    if (button) {
      await turn(fix, taps(fix, button));
      fix.script.noteAnswered(next.id);
      continue;
    }
    const value = written[next.id];
    assert.ok(value !== undefined, `the harness has no answer scripted for required question "${next.id}"`);
    await agentRecords(fix, next.id, value);
  }
  const stuck = await getSessionForChat(fix.pool, fix.chat);
  const on = stuck.ok ? stuck.view.nextQuestion : null;
  assert.fail(
    `the interview never ran out of required questions — it is looping on ` +
      `"${on?.id ?? "?"}" (${on?.type ?? "?"}). Last line: ${fix.script.last?.text.slice(0, 90)}`,
  );
}

function says(fix: Fixture, text: string): TelegramUpdate {
  return {
    update_id: 1,
    message: {
      message_id: Math.floor(Math.random() * 1e6),
      from: { id: 777, first_name: "Dror" },
      chat: { id: fix.chat, type: "private" },
      text,
    },
  };
}

function taps(fix: Fixture, data: string): TelegramUpdate {
  return {
    update_id: 2,
    callback_query: {
      id: `cbq_${Math.floor(Math.random() * 1e6)}`,
      data,
      from: { id: 777 },
      message: { message_id: 7, chat: { id: fix.chat, type: "private" } },
    },
  };
}

/**
 * Opens the interview the way an organizer does — by tapping the deep link.
 *
 * Deliberately through `dispatchUpdate` rather than by calling
 * `startFromDeepLink` directly: the opening message is a routing decision, and
 * a helper that skips the router would test a path no organizer ever takes.
 */
async function open(fix: Fixture): Promise<void> {
  const issued = await issueEnrollment(fix.pool, fix.userId, fix.tripId, { enrollmentTtlSeconds: 3600 });
  assert.ok(issued.ok);
  await turn(fix, says(fix, `/start ${issued.token}`));
}

// ── The tests ────────────────────────────────────────────────────────────────

describe("the interview transcript holds its standing invariants", () => {
  test("the router-only tap-through path satisfies every standing assertion", { skip: SKIP }, async () => {
    // The baseline. This is the ONE path run 1 walked and the only one that has
    // ever worked end to end, so it is the floor: whatever Track 4 changes,
    // this must keep passing.
    await withConversation(async (fix) => {
      await open(fix);
      await turn(fix, taps(fix, "c:nodoc"));

      await answerEverythingRequired(fix);

      fix.script.check();
      assert.ok(fix.script.lines.length > 1, "the organizer was actually spoken to");
    });
  });

  test("the opening offers a document before it asks anyone to type", { skip: SKIP }, async () => {
    // Run 5: "Now it asked the date of the trip without suggesting adding
    // documents". Asking someone to type out a trip they already have written
    // down is the single biggest waste of their patience the interview can
    // commit, and it regressed the moment the router took over the opening.
    await withConversation(async (fix) => {
      await open(fix);
      const first = fix.script.lines[0];
      assert.ok(first, "a deep link produces an immediate reply");
      assert.equal(first.questionId, null, "the first thing said is not a question");
      assert.deepEqual(first.buttons, ["c:nodoc"], "one way past the offer");
      fix.script.check();
    });
  });

  test("a repeated message fails the harness", { skip: SKIP }, async () => {
    // Mutation check: the bombardment assertion has to actually fire, or it is
    // decoration. Runs 5 and 6 both got past a check that existed.
    const script = new Transcript();
    await script.sendMessage({ chatId: "1", text: "What day does the trip start?" });
    await script.sendMessage({ chatId: "1", text: "What day does the trip start?" });
    assert.throws(() => script.assertNoRepeatedMessage(), /run 5\/6 regression/);
  });

  test("an option question with no keyboard fails the harness", { skip: SKIP }, async () => {
    // Mutation check for runs 2 and 6: the agent asking `trip_type` in prose,
    // which degrades to "reply with the numbers separated by commas".
    const script = new Transcript();
    const tripType = INTAKE_QUESTIONS.find((q) => q.id === "trip_type");
    assert.ok(tripType);
    await script.sendMessage({ chatId: "1", text: askText(tripType, "en") });
    assert.throws(() => script.assertOptionQuestionsAreTappable(), /run 2\/6 regression/);
  });

  test("a question drawn in the wrong language fails the harness", { skip: SKIP }, async () => {
    // Mutation check for runs 2/3/4: the router drew English into a Hebrew
    // interview because its strings had no language at all.
    const script = new Transcript();
    script.language = "he";
    const destination = INTAKE_QUESTIONS.find((q) => q.id === "destination");
    assert.ok(destination);
    await script.sendMessage({ chatId: "1", text: askText(destination, "en") });
    assert.throws(() => script.assertRouterTextIsInSessionLanguage(), /run 2\/3\/4 regression/);
  });

  test("asking a question the record already answers fails the harness", { skip: SKIP }, async () => {
    // Mutation check for run 6's sharpest defect: it asked where they were
    // going after the document had told it. Re-asking something still
    // UNANSWERED is not this, and must stay allowed — that is the watchdog.
    const script = new Transcript();
    const destination = INTAKE_QUESTIONS.find((q) => q.id === "destination");
    assert.ok(destination);
    script.noteAnswered("destination");
    await script.sendMessage({ chatId: "1", text: askText(destination, "en") });
    assert.throws(() => script.assertNeverAsksAnsweredQuestion(), /run 6 regression/);

    const fine = new Transcript();
    await fine.sendMessage({ chatId: "1", text: askText(destination, "en") });
    await fine.sendMessage({ chatId: "1", text: `Let's pick this back up.\n\n${askText(destination, "en")}` });
    fine.assertNeverAsksAnsweredQuestion();
  });

  test("internal vocabulary in a message fails the harness", { skip: SKIP }, async () => {
    // Mutation check for run 5, using the exact wording that prompted the
    // filter: field ids and "the router" read aloud to someone asking about a
    // family holiday.
    const script = new Transcript();
    await script.sendMessage({
      chatId: "1",
      text: "`bot_gender` ו-`bot_tone` עדיין ב-optionalRemaining — ואת השאר ישאל הראוטר.",
    });
    assert.throws(() => script.assertNoInternalLeak(), /run 5 regression/);
  });
});

describe("the interview always has a way to finish", () => {
  test("/done reaches the recap without a button or an agent tool call", { skip: SKIP }, async () => {
    // Run 6, verbatim: "Eventually got to the end of the interview no buttons
    // only open questions asked for approval I approved but nothing happened."
    //
    // The session was `interviewing` with every required question answered.
    // Reaching confirmation needed either all sixteen optional questions
    // answered or the finish flag, which only exists on a router-drawn
    // question — and the agent was doing the asking, so no button was on
    // screen. This asserts the escape hatch works; Track 4's phase column is
    // what removes the need for one.
    await withConversation(async (fix) => {
      await open(fix);
      await turn(fix, taps(fix, "c:nodoc"));

      await answerEverythingRequired(fix);

      await turn(fix, says(fix, "/done"));
      const recap = fix.script.last;
      assert.ok(recap, "the organizer got something back");
      assert.ok(
        recap.buttons.includes("c:confirm"),
        "/done puts a real Confirm button on screen, not a sentence asking for approval",
      );
      assert.ok(
        recap.text.includes(uiString("recapHeader", fix.script.language)),
        "and shows what is being confirmed",
      );
      fix.script.check();
    });
  });

  test("/done with required questions outstanding asks, it does not pretend", { skip: SKIP }, async () => {
    // The other half of the escape hatch, and the more important one: a
    // command that confirms an incomplete intake would write a record nobody
    // agreed to. It asks the next required question instead.
    await withConversation(async (fix) => {
      await open(fix);
      await turn(fix, taps(fix, "c:nodoc"));
      await turn(fix, says(fix, "/done"));

      const reply = fix.script.last;
      assert.ok(reply, "the organizer got something back");
      assert.ok(
        !reply.buttons.includes("c:confirm"),
        "no Confirm button while required questions are outstanding",
      );

      const view = await getSessionForChat(fix.pool, fix.chat);
      assert.ok(view.ok);
      assert.equal(view.view.state, "interviewing", "and the session did not jump to confirmation");
      fix.script.check();
    });
  });
});

describe("one voice, one writer", () => {
  test("the interviewer's words reach the organizer only through say", { skip: SKIP }, async () => {
    // Track 4's central guarantee. The agent writes; the router delivers. What
    // makes this worth a test rather than a comment is that the same rule
    // existed as a SOUL sentence through runs 2 to 6 and failed every time.
    await withConversation(async (fix) => {
      await open(fix);
      await turn(fix, taps(fix, "c:nodoc"));
      const before = fix.script.lines.length;

      // The agent only ever writes because the organizer said something, so the
      // floor has to be ours before it speaks. Production gets this from
      // applyDecision; a test calling sayForChat directly must say so too.
      await markAwaitingMachine(fix.pool, fix.chat);
      await sayForChat(fix.pool, fix.chat, "יופי, ראיתי את המסמך — נשאר רק תאריך החזרה.");
      await deliverPendingRouterPrompt(fix);

      const said = fix.script.last;
      assert.equal(fix.script.lines.length, before + 1, "exactly one message, not a burst");
      assert.equal(said?.text, "יופי, ראיתי את המסמך — נשאר רק תאריך החזרה.", "delivered verbatim");
      assert.deepEqual(said?.buttons, [], "prose carries no keyboard of its own");
    });
  });

  test("a delivered message is never sent twice, however often the router is prompted",
    { skip: SKIP }, async () => {
    // Both bombardments were the same shape: something scheduled the router to
    // speak once per agent write. A single slot that clears on delivery cannot
    // produce that, which is why it is a slot and not a queue.
    await withConversation(async (fix) => {
      await open(fix);
      await turn(fix, taps(fix, "c:nodoc"));

      await markAwaitingMachine(fix.pool, fix.chat);
      await sayForChat(fix.pool, fix.chat, "רגע, אני קורא את הקובץ.");
      await deliverPendingRouterPrompt(fix);
      const after = fix.script.lines.length;

      await deliverPendingRouterPrompt(fix);
      await deliverPendingRouterPrompt(fix);
      assert.equal(fix.script.lines.length, after, "prompting again says nothing new");
      fix.script.check();
    });
  });

  test("the agent phrases the question and the router attaches the buttons", { skip: SKIP }, async () => {
    // Run 3, verbatim: "It completely driftted" — every question arriving in
    // the same flat voice regardless of what had just been said. The sentence
    // is the agent's; the affordance stays deterministic.
    await withConversation(async (fix) => {
      await open(fix);
      await turn(fix, taps(fix, "c:nodoc"));
      await answerEverythingRequired(fix);

      const mine = "שאלה אחרונה ואני נותן לך לנוח: יש מישהו בקבוצה שלא אוכל משהו?";
      const nominated = await nominateQuestionForChat(fix.pool, fix.chat, "dietary", mine);
      assert.ok(nominated.ok);
      await deliverPendingRouterPrompt(fix);

      const asked = fix.script.last;
      assert.equal(asked?.text, mine, "the organizer reads the interviewer's sentence, not the copy table");
      assert.equal(asked?.questionId, "dietary", "and it is still recognisably that question");
      assert.ok(asked!.buttons.length > 0, "with real buttons the agent could never have drawn");
      assert.ok(
        asked!.buttons.some((b) => b.startsWith("t:dietary:")),
        "the multi-select toggles belong to the nominated question",
      );
      fix.script.check();
    });
  });

  test("wording belongs to the question it was written for", { skip: SKIP }, async () => {
    // The failure this prevents is specific and would be baffling to receive:
    // a sentence written for `dietary` sitting above a date question, because
    // the phrasing outlived the nomination.
    await withConversation(async (fix) => {
      await open(fix);
      await turn(fix, taps(fix, "c:nodoc"));
      await answerEverythingRequired(fix);

      await nominateQuestionForChat(fix.pool, fix.chat, "dietary", "יש הגבלות אכילה?");
      await deliverPendingRouterPrompt(fix);
      await turn(fix, taps(fix, `k:dietary`));

      const view = await getSessionForChat(fix.pool, fix.chat);
      assert.ok(view.ok);
      assert.equal(view.view.pendingAskText, null, "the wording went with the nomination");
      fix.script.check();
    });
  });
});

describe("the interview never goes silent", () => {
  /** Runs the watchdog with an explicit floor, so tests need not wait real seconds. */
  async function runWatchdog(fix: Fixture, floorSeconds: number): Promise<void> {
    await recoverStalledInterviews(
      { db: fix.pool, telegram: fix.script, connector: fix.connector },
      DEFAULT_STRINGS,
      () => {},
      floorSeconds,
    );
  }

  test("a stalled interviewer loses the floor and the router asks", { skip: SKIP }, async () => {
    // The one failure Track 4 introduced. With the agent as the only voice, an
    // agent that stalls leaves the organizer looking at nothing — which is what
    // runs 4 and 6 both did, once while announcing it was "fixing" a fault it
    // cannot fix. The router's own copy is flat next to the agent's phrasing
    // and infinitely better than a conversation that stops.
    await withConversation(async (fix) => {
      await open(fix);
      await turn(fix, taps(fix, "c:nodoc"));
      const view = await getSessionForChat(fix.pool, fix.chat);
      assert.ok(view.ok);

      // A real stall: the organizer wrote an answer, the agent RECORDED it and
      // then said nothing. The next question is now different from what is on
      // screen, which is the only case where speaking for the agent helps —
      // re-sending a question already in front of them is suppressed, and
      // rightly.
      const tripType = fix.script.last?.buttons.find((b) => b.startsWith("a:trip_type:"));
      assert.ok(tripType, "the first question is on screen with its buttons");
      await turn(fix, taps(fix, tripType));

      await markAwaitingMachine(fix.pool, fix.chat);
      await agentRecords(fix, "destination", "Japan");
      await openAgentTurn(fix.pool, fix.chat, view.view.sessionId);
      const before = fix.script.lines.length;

      await runWatchdog(fix, 0);

      const asked = fix.script.last;
      assert.equal(fix.script.lines.length, before + 1, "the router speaks once, not repeatedly");
      assert.ok(asked?.questionId, "and what it says is the next question");
      assert.equal(asked!.drawnIn, fix.script.language, "drawn from its own copy, in the interview's language");
      fix.script.check();
    });
  });

  test("an interviewer that has written is not treated as stalled", { skip: SKIP }, async () => {
    // The distinction the whole watchdog turns on. An agent that recorded an
    // answer owes a router prompt; speaking over it would recreate run 2's
    // "it talks over the agent" defect while claiming to fix silence.
    await withConversation(async (fix) => {
      await open(fix);
      await turn(fix, taps(fix, "c:nodoc"));
      const view = await getSessionForChat(fix.pool, fix.chat);
      assert.ok(view.ok);

      await markAwaitingMachine(fix.pool, fix.chat);
      await openAgentTurn(fix.pool, fix.chat, view.view.sessionId);
      await sayForChat(fix.pool, fix.chat, "רגע, אני קורא את הקובץ.");
      const before = fix.script.lines.length;

      await runWatchdog(fix, 0);
      assert.equal(fix.script.lines.length, before, "the watchdog stayed out of it");

      // And the agent's own words still arrive, unaffected.
      await deliverPendingRouterPrompt(fix);
      assert.equal(fix.script.last?.text, "רגע, אני קורא את הקובץ.");
      fix.script.check();
    });
  });

  test("the floor is not taken before the deadline", { skip: SKIP }, async () => {
    // Thirty seconds exists so a model reading a shared PDF is not interrupted
    // mid-thought. A watchdog that fires immediately would be the run-2 defect
    // wearing a different name.
    await withConversation(async (fix) => {
      await open(fix);
      await turn(fix, taps(fix, "c:nodoc"));
      const view = await getSessionForChat(fix.pool, fix.chat);
      assert.ok(view.ok);
      await markAwaitingMachine(fix.pool, fix.chat);
      await openAgentTurn(fix.pool, fix.chat, view.view.sessionId);
      const before = fix.script.lines.length;

      await runWatchdog(fix, AGENT_FLOOR_SECONDS);
      assert.equal(fix.script.lines.length, before, "a turn one second old still holds the floor");
    });
  });

  test("two poll ticks cannot both speak for one silent agent", { skip: SKIP }, async () => {
    // The claim is atomic for a reason: a watchdog that double-fires would
    // produce, of all things, the bombardment this whole design exists to
    // prevent.
    await withConversation(async (fix) => {
      await open(fix);
      await turn(fix, taps(fix, "c:nodoc"));
      const view = await getSessionForChat(fix.pool, fix.chat);
      assert.ok(view.ok);
      await markAwaitingMachine(fix.pool, fix.chat);
      await openAgentTurn(fix.pool, fix.chat, view.view.sessionId);

      await Promise.all([runWatchdog(fix, 0), runWatchdog(fix, 0)]);
      await runWatchdog(fix, 0);

      fix.script.assertNoRepeatedMessage();
      fix.script.check();
    });
  });
});

describe("the agent can speak more than once per organizer turn", () => {
  test("a second, later say_for_chat is delivered, not stuck behind the first", { skip: SKIP }, async () => {
    // The exact live bug: an upload got "Now let me read the PDF document:"
    // (delivered correctly, floor released to the organizer) and then,
    // ~100 seconds later, once extraction had genuinely finished, the agent's
    // OWN completion message sat undelivered in ui_state for the rest of the
    // session — nearly ten minutes, measured live. sendNextStep's very first
    // check is `awaiting === "person"`, and nothing was ever going to flip it
    // back except the organizer's NEXT message, which might be arbitrarily
    // far away. The floor exists to stop the ROUTER inserting itself
    // uninvited once someone has replied; it must never silence the agent's
    // own second, deliberate word about a turn it is still working through.
    await withConversation(async (fix) => {
      await open(fix);
      await turn(fix, taps(fix, "c:nodoc"));

      await markAwaitingMachine(fix.pool, fix.chat);
      await sayForChat(fix.pool, fix.chat, "רגע, אני קורא את הקובץ.");
      await deliverPendingRouterPrompt(fix);
      assert.equal(fix.script.last?.text, "רגע, אני קורא את הקובץ.");

      // Time passes. The agent is still processing the SAME organizer turn —
      // no new inbound message has arrived — and now wants to say something
      // else.
      await sayForChat(fix.pool, fix.chat, "הכל נרשם בהצלחה.");
      await deliverPendingRouterPrompt(fix);

      assert.equal(
        fix.script.last?.text,
        "הכל נרשם בהצלחה.",
        "the second message must reach the organizer, not sit stuck forever",
      );
      fix.script.check();
    });
  });

  test("an agent-recorded answer after the floor released still hands back the buttons",
    { skip: SKIP }, async () => {
    // submitAnswerForAgent carries the same exposure as sayForChat: its own
    // comment says losing the next-question prompt here is exactly the
    // 2026-09-04 "buttons silently gone for good" defect. Recording an answer
    // well after the agent's first reply already released the floor — a
    // document with several answers in it does this routinely — must not
    // let that guarantee quietly break again.
    await withConversation(async (fix) => {
      await open(fix);
      await turn(fix, taps(fix, "c:nodoc"));

      // Answer the first (choice) question by tap, as normal.
      const tripType = fix.script.last?.buttons.find((b) => b.startsWith("a:trip_type:"));
      assert.ok(tripType, "the first required question is on screen");
      await turn(fix, taps(fix, tripType));

      // The organizer sends a document; the agent acknowledges it first —
      // this releases the floor back to "person".
      await markAwaitingMachine(fix.pool, fix.chat);
      await sayForChat(fix.pool, fix.chat, "קורא את המסמך…");
      await deliverPendingRouterPrompt(fix);
      assert.equal(fix.script.last?.text, "קורא את המסמך…");

      // Still processing the SAME turn, well after that release, the agent
      // records what the document said — through the REAL production path
      // (submitAnswerForAgent, what record_answers_for_chat actually calls),
      // not the test harness's button-tap stand-in. Addressed by the open
      // turn, same as in production.
      const view = await getSessionForChat(fix.pool, fix.chat);
      assert.ok(view.ok);
      await openAgentTurn(fix.pool, fix.chat, view.view.sessionId);
      const recorded = await submitAnswerForAgent(fix.pool, fix.chat, "destination", null, "Japan");
      assert.ok(recorded.ok, `could not record: ${JSON.stringify(recorded)}`);
      const before = fix.script.lines.length;
      await deliverPendingRouterPrompt(fix);

      assert.equal(fix.script.lines.length, before + 1, "the next question was not silently dropped");
      assert.ok(fix.script.last?.buttons.length || fix.script.last?.questionId, "and the interview kept moving");
      fix.script.check();
    });
  });
});

describe("the interview is somewhere, not merely computable", () => {
  test("the recap is entered once, not re-sent on every later write", { skip: SKIP }, async () => {
    // Run 2, verbatim: the confirm recap arrived on top of a live question, and
    // then again, and again. `awaiting_confirmation` was a PROPERTY of the
    // answers, so once true it was true forever and every agent write re-fired
    // the whole thing. A phase is entered once.
    await withConversation(async (fix) => {
      await open(fix);
      await turn(fix, taps(fix, "c:nodoc"));
      await answerEverythingRequired(fix);
      await turn(fix, says(fix, "/done"));

      const recaps = fix.script.lines.filter((l) => l.buttons.includes("c:confirm"));
      assert.equal(recaps.length, 1, "the recap arrived once");

      // An optional answer recorded afterwards must not bring it back.
      await sayForChat(fix.pool, fix.chat, "עוד דבר אחד קטן.");
      await deliverPendingRouterPrompt(fix);
      await deliverPendingRouterPrompt(fix);

      const after = fix.script.lines.filter((l) => l.buttons.includes("c:confirm"));
      assert.equal(after.length, 1, "run 2 regression — the recap re-fired");
      fix.script.check();
    });
  });

  test("an agent-recorded answer can finish the interview, not just a tap", { skip: SKIP }, async () => {
    // The precise shape of run 6. Every required question was answered and the
    // session still had no path to confirmation, because only a router-drawn
    // button could set the finish flag and the agent was doing the asking.
    // The phase advances on every write, whoever made it.
    await withConversation(async (fix) => {
      await open(fix);
      await turn(fix, taps(fix, "c:nodoc"));
      await answerEverythingRequired(fix);

      const view = await getSessionForChat(fix.pool, fix.chat);
      assert.ok(view.ok);
      assert.equal(view.view.phase, "optional", "required done moves the machine on by itself");
      assert.equal(view.view.state, "interviewing", "and state agrees, because it is derived from phase");
    });
  });

  test("the phase machine only goes forward, except Keep planning", { skip: SKIP }, async () => {
    // A late answer must never drag a confirmed interview backwards. The one
    // two-way door is the organizer changing their mind at the recap.
    const answered: Record<string, never> = {};
    assert.equal(nextPhase("confirmed", answered, INTAKE_QUESTIONS, {}), "confirmed");
    assert.equal(nextPhase("opening", answered, INTAKE_QUESTIONS, {}), "opening");
    assert.equal(
      nextPhase("opening", answered, INTAKE_QUESTIONS, { openingDone: true }),
      "essentials",
      "any signal at all ends the opening — a document, a tap, or just typing",
    );
    assert.equal(
      nextPhase("recap", answered, INTAKE_QUESTIONS, {}),
      "optional",
      "Keep planning reopens the questions",
    );
    assert.equal(
      nextPhase("recap", answered, INTAKE_QUESTIONS, { finishRequested: true }),
      "recap",
      "and staying finished keeps the recap",
    );
  });

  test("one event may cross two boundaries", { skip: SKIP }, async () => {
    // The bug the real assertions finally showed, after four false alarms:
    // the machine advanced ONE step per event, so recording the last required
    // answer and asking to finish landed on `optional` instead of `recap`.
    // "That's everything" then reported `interviewing` with no recap to show —
    // a dead end reintroduced by the very change meant to remove dead ends.
    await withConversation(async (fix) => {
      await open(fix);
      await turn(fix, taps(fix, "c:nodoc"));
      await answerEverythingRequired(fix);

      // Finish while sitting in `essentials`-adjacent state: the transition has
      // to carry through optional and on to recap in one move.
      const finished = await setFinishRequestedForChat(fix.pool, fix.chat, true, { schedulePrompt: true });
      assert.ok(finished.ok);
      assert.equal(finished.view.phase, "recap", "crossed both boundaries in one event");
      assert.equal(finished.view.state, "awaiting_confirmation", "and state followed the phase");

      await deliverPendingRouterPrompt(fix);
      assert.ok(
        fix.script.last?.buttons.includes("c:confirm"),
        "the organizer actually gets the Confirm button, not a dead end",
      );
      fix.script.check();
    });
  });

  test("declining the document offer moves the interview on", { skip: SKIP }, async () => {
    // Without a marker, an organizer who taps past the offer and then says
    // nothing would sit in `opening` forever: no answer exists to move them.
    await withConversation(async (fix) => {
      await open(fix);
      const before = await getSessionForChat(fix.pool, fix.chat);
      assert.ok(before.ok);
      assert.equal(before.view.phase, "opening");

      await turn(fix, taps(fix, "c:nodoc"));

      const after = await getSessionForChat(fix.pool, fix.chat);
      assert.ok(after.ok);
      assert.equal(after.view.phase, "essentials", "the questions have started");
      fix.script.check();
    });
  });
});

describe("one organizer message gets one reply", () => {
  /** The organizer has just spoken: the machine owes the next message. */
  async function organizerSpoke(fix: Fixture): Promise<void> {
    await markAwaitingMachine(fix.pool, fix.chat);
  }

  test("the router says nothing while it is the organizer's turn", { skip: SKIP }, async () => {
    // Run 7: "almost every question I get at least twice, seems like one from
    // the router and one from the agent". Both halves decided independently
    // that something was owed. Silence while waiting on a person is correct
    // behaviour, not a stall.
    await withConversation(async (fix) => {
      await open(fix);
      await turn(fix, taps(fix, "c:nodoc"));
      const after = fix.script.lines.length;

      // No organizer message since the last reply — the floor is theirs.
      await deliverPendingRouterPrompt(fix);
      await deliverPendingRouterPrompt(fix);
      assert.equal(fix.script.lines.length, after, "nothing was sent into a conversation waiting on a person");
      fix.script.check();
    });
  });

  test("the interviewer and the router cannot both answer one message", { skip: SKIP }, async () => {
    // The arbitration. The agent writes AND the router has a question owed;
    // exactly one of them reaches the organizer, because claiming the floor is
    // a single atomic update.
    await withConversation(async (fix) => {
      await open(fix);
      await turn(fix, taps(fix, "c:nodoc"));

      await organizerSpoke(fix);
      await sayForChat(fix.pool, fix.chat, "רגע, אני קורא את הקובץ.");
      const before = fix.script.lines.length;

      await deliverPendingRouterPrompt(fix);
      await deliverPendingRouterPrompt(fix);
      await deliverPendingRouterPrompt(fix);

      assert.equal(
        fix.script.lines.length,
        before + 1,
        "run 7 regression — one organizer message produced more than one reply",
      );
      assert.equal(fix.script.last?.text, "רגע, אני קורא את הקובץ.", "and the agent's words won, not the copy table");
      fix.script.check();
    });
  });

  test("the deadline measures us, never the organizer", { skip: SKIP }, async () => {
    // "waiting to a person response need to be handled from the session
    // perspective not by one question". While the floor is theirs the clock is
    // not running at all, so a watchdog cannot fire against someone reading.
    await withConversation(async (fix) => {
      await open(fix);
      await turn(fix, taps(fix, "c:nodoc"));
      const before = fix.script.lines.length;

      // Floor is the organizer's. Even at a zero deadline, nothing fires.
      await recoverStalledInterviews(
        { db: fix.pool, telegram: fix.script, connector: fix.connector },
        DEFAULT_STRINGS,
        () => {},
        0,
      );
      assert.equal(fix.script.lines.length, before, "the watchdog did not count against a person");

      // Once they speak and we go quiet, it does fire. The agent records the
      // answer and says nothing, so the next question differs from what is on
      // screen — re-sending the SAME question is suppressed, and rightly.
      const view = await getSessionForChat(fix.pool, fix.chat);
      assert.ok(view.ok);
      const tripType = fix.script.last?.buttons.find((b) => b.startsWith("a:trip_type:"));
      assert.ok(tripType);
      await turn(fix, taps(fix, tripType));
      const beforeStall = fix.script.lines.length;
      await organizerSpoke(fix);
      await agentRecords(fix, "destination", "Japan");
      await openAgentTurn(fix.pool, fix.chat, view.view.sessionId);
      await recoverStalledInterviews(
        { db: fix.pool, telegram: fix.script, connector: fix.connector },
        DEFAULT_STRINGS,
        () => {},
        0,
      );
      assert.equal(
        fix.script.lines.length,
        beforeStall + 1,
        "and it does fire when we are the ones who owe a message",
      );
      fix.script.check();
    });
  });

  test("the recap cannot be buried by the interviewer", { skip: SKIP }, async () => {
    // Run 7 ended `awaiting_confirmation` with 14 answers and no confirmation:
    // the Confirm keyboard was sent and then talked over, so the last thing on
    // screen was prose asking for approval that no tool acts on.
    await withConversation(async (fix) => {
      await open(fix);
      await turn(fix, taps(fix, "c:nodoc"));
      await answerEverythingRequired(fix);
      await turn(fix, says(fix, "/done"));

      const recapAt = fix.script.lines.findIndex((l) => l.buttons.includes("c:confirm"));
      assert.ok(recapAt >= 0, "the recap reached the organizer");

      // The agent tries to talk after it. The floor is the organizer's now.
      await sayForChat(fix.pool, fix.chat, "אז מה אתה אומר?");
      await deliverPendingRouterPrompt(fix);

      assert.equal(
        fix.script.lines.length - 1,
        recapAt,
        "run 7 regression — something was sent after the Confirm keyboard",
      );
      fix.script.check();
    });
  });
});

describe("the agent's words are delivered in the dialect they were written in", () => {
  test("routed agent text keeps its parse mode", { skip: SKIP }, async () => {
    // Run 7, verbatim: "There is a regression on the markdown formatting not
    // applied and show raw." The connector always sent agent-authored text as
    // MarkdownV2, because that is what TELEGRAM_DESCRIPTOR advertises. Routing
    // the same text through the router dropped it, so every converted message
    // arrived as literal asterisks. Whoever delivers the agent's words owes
    // them the same dialect.
    await withConversation(async (fix) => {
      await open(fix);
      await turn(fix, taps(fix, "c:nodoc"));
      await markAwaitingMachine(fix.pool, fix.chat);
      await sayForChat(fix.pool, fix.chat, "*יפן* נרשמה — נשאר רק תאריך החזרה.");
      await deliverPendingRouterPrompt(fix);

      assert.equal(fix.script.last?.text, "*יפן* נרשמה — נשאר רק תאריך החזרה.");
      assert.equal(fix.script.last?.parseMode, "MarkdownV2", "sent in the dialect it was written in");
    });
  });
});

describe("the interview never asks what it already knows", () => {
  test("a derivable question is answered, never asked", { skip: SKIP }, async () => {
    // Run 3: the router asked someone who had just said "Japan" what timezone
    // to show times in — and the prompt itself says the answer can be worked
    // out. A question with a derivation leaves the outstanding set without
    // ever reaching a person.
    await withConversation(async (fix) => {
      await open(fix);
      await turn(fix, taps(fix, "c:nodoc"));
      await answerEverythingRequired(fix);

      const view = await getSessionForChat(fix.pool, fix.chat);
      assert.ok(view.ok);
      assert.equal(
        view.view.optionalRemaining.some((q) => q.id === "timezone"),
        false,
        "timezone was derived from the destination, so it is not outstanding",
      );
      assert.deepEqual(fix.script.asking("timezone"), [], "and it was never put to the organizer");
      fix.script.check();
    });
  });

  test("a derivation never overwrites what the organizer said", { skip: SKIP }, async () => {
    // Something a person actually told us always outranks something we
    // inferred, however confident the inference.
    await withConversation(async (fix) => {
      await open(fix);
      await turn(fix, taps(fix, "c:nodoc"));
      await answerEverythingRequired(fix);
      await agentRecords(fix, "timezone", "Asia/Osaka");

      const derived = await applyDerivationsForChat(fix.pool, fix.chat);
      assert.deepEqual(derived, [], "nothing was derived over an existing answer");

      const stored = await fix.pool.query<{ text: string }>(
        "SELECT answers->'timezone'->>'text' AS text FROM control_plane.intake_sessions WHERE telegram_chat_id = $1 AND state <> 'confirmed'",
        [fix.chat],
      );
      assert.equal(stored.rows[0]?.text, "Asia/Osaka", "the organizer's own answer survived");
    });
  });

  test("nominating an answered question is refused, not drawn", { skip: SKIP }, async () => {
    // Run 7: a tapped `bot_gender` was asked again in prose, and a destination
    // the document had supplied was asked for outright. The router cannot make
    // that mistake; this stops the agent making it through the router.
    await withConversation(async (fix) => {
      await open(fix);
      await turn(fix, taps(fix, "c:nodoc"));
      await answerEverythingRequired(fix);
      await agentRecords(fix, "bot_name", "יפנוטו");

      const refused = await nominateQuestionForChat(fix.pool, fix.chat, "bot_name", "איך לקרוא לי?");
      assert.equal(refused.ok, false);
      assert.equal(refused.ok === false && refused.reason, "ALREADY_ANSWERED");

      await deliverPendingRouterPrompt(fix);
      assert.deepEqual(fix.script.asking("bot_name"), [], "and nothing about it reached the organizer");
      fix.script.check();
    });
  });
});

describe("starting a new interview never resumes someone else's abandoned one", () => {
  test("a stale, unconfirmed session from a DIFFERENT trip is superseded", { skip: SKIP }, async () => {
    // The exact shape of the 2026-09-05 bug. Run 7 left chat 391627336 bound to
    // an unconfirmed, abandoned session for its own trip. Run 8 approved a
    // BRAND NEW signup, reset it, and tapped a freshly-minted, valid deep
    // link for that new trip on the SAME chat — and got run 7's leftover
    // recap-adjacent state instead of the document offer. The chat had never
    // been told to forget the old trip because nothing routes by trip; it
    // routes by chat alone.
    await withConversation(async (fix) => {
      // An abandoned interview for an EARLIER, unrelated trip on this chat.
      const staleTripId = testId("trip");
      await fix.pool.query("INSERT INTO control_plane.trips(id, slug, lifecycle_state) VALUES ($1, $2, 'draft')", [staleTripId, staleTripId.replace(/_/g, "-")]);
      await fix.pool.query(
        "INSERT INTO control_plane.trip_memberships(id, trip_id, user_id, role, status) VALUES ($1, $2, $3, 'owner', 'active')",
        [testId("memb"), staleTripId, fix.userId],
      );
      const staleIssued = await issueEnrollment(fix.pool, fix.userId, staleTripId, { enrollmentTtlSeconds: 3600 });
      assert.ok(staleIssued.ok);
      await turn(fix, says(fix, `/start ${staleIssued.token}`));
      const before = await getSessionForChat(fix.pool, fix.chat);
      assert.ok(before.ok);
      assert.equal(before.view.tripId, staleTripId, "the stale interview is the one currently bound to this chat");

      // Backdated to simulate genuine abandonment. A freshly-started session
      // is never stale by design — that is exactly what protects a live
      // interview from run 7's fate happening to IT: the two existing tests
      // this staleness gate had to keep passing both start a second session
      // milliseconds after the first and expect it refused, not superseded.
      await fix.pool.query(
        "UPDATE control_plane.intake_sessions SET awaiting_since = now() - interval '1 hour' WHERE id = $1",
        [before.view.sessionId],
      );

      // A brand-new, valid enrollment for fix.tripId — a DIFFERENT trip.
      const freshIssued = await issueEnrollment(fix.pool, fix.userId, fix.tripId, { enrollmentTtlSeconds: 3600 });
      assert.ok(freshIssued.ok);
      const outcome = await startFromDeepLink(fix.pool, fix.chat, freshIssued.token);

      assert.equal(outcome.kind, "started", "the fresh, valid link must start the NEW trip's interview");
      assert.equal(outcome.kind === "started" ? outcome.tripId : null, fix.tripId);

      const stale = await fix.pool.query(
        "SELECT 1 FROM control_plane.intake_sessions WHERE trip_id = $1",
        [staleTripId],
      );
      assert.equal(stale.rowCount, 0, "the stale session was removed, not left to be found again");
    });
  });

  test("a recently-active session for a different trip is NOT superseded", { skip: SKIP }, async () => {
    // The other half of the staleness gate, and the one the two pre-existing
    // tests (chat-router.test.ts, two-trip-isolation.test.ts) already covered
    // for a session with NO gap at all. This is the middle case: an organizer
    // genuinely mid-interview, paused a few minutes to go find a document,
    // must not have that interview pulled out from under them because an
    // unrelated token for another trip happens to be presented on their chat
    // in that window.
    await withConversation(async (fix) => {
      const otherTripId = testId("trip");
      await fix.pool.query("INSERT INTO control_plane.trips(id, slug, lifecycle_state) VALUES ($1, $2, 'draft')", [otherTripId, otherTripId.replace(/_/g, "-")]);
      await fix.pool.query(
        "INSERT INTO control_plane.trip_memberships(id, trip_id, user_id, role, status) VALUES ($1, $2, $3, 'owner', 'active')",
        [testId("memb"), otherTripId, fix.userId],
      );
      const active = await issueEnrollment(fix.pool, fix.userId, otherTripId, { enrollmentTtlSeconds: 3600 });
      assert.ok(active.ok);
      await turn(fix, says(fix, `/start ${active.token}`));
      const view = await getSessionForChat(fix.pool, fix.chat);
      assert.ok(view.ok);

      // Five minutes of silence — well under STALE_SESSION_MINUTES.
      await fix.pool.query(
        "UPDATE control_plane.intake_sessions SET awaiting_since = now() - interval '5 minutes' WHERE id = $1",
        [view.view.sessionId],
      );

      const fresh = await issueEnrollment(fix.pool, fix.userId, fix.tripId, { enrollmentTtlSeconds: 3600 });
      assert.ok(fresh.ok);
      const outcome = await startFromDeepLink(fix.pool, fix.chat, fresh.token);

      assert.equal(outcome.kind, "already_in_interview", "a five-minute pause must not read as abandonment");
      const survives = await fix.pool.query("SELECT 1 FROM control_plane.intake_sessions WHERE id = $1", [view.view.sessionId]);
      assert.equal(survives.rowCount, 1, "the paused interview was not deleted");
    });
  });

  test("a repeated link for the SAME trip is still refused, and the token stays unconsumed",
    { skip: SKIP }, async () => {
    // The behaviour this must NOT change: tapping a link a second time for an
    // interview genuinely still in progress must not restart it from zero.
    await withConversation(async (fix) => {
      const issued = await issueEnrollment(fix.pool, fix.userId, fix.tripId, { enrollmentTtlSeconds: 3600 });
      assert.ok(issued.ok);
      const first = await startFromDeepLink(fix.pool, fix.chat, issued.token);
      assert.equal(first.kind, "started");

      // Starting the trip moved it out of 'draft', so a second real enrollment
      // cannot even be issued for it — tapping the SAME link again is the
      // realistic repeat here, and the interview must not restart from zero.
      const outcome = await startFromDeepLink(fix.pool, fix.chat, issued.token);
      assert.equal(outcome.kind, "already_in_interview", "same trip, still in progress — refused, not restarted");
      assert.equal(outcome.kind === "already_in_interview" ? outcome.tripId : null, fix.tripId);
    });
  });
});
