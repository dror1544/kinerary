/**
 * A REQUIRED QUESTION ASKED AGAIN SAYS WHAT IS STILL MISSING.
 *
 * Live, in Hebrew, 2026-10-10: the organizer answered the stops question with
 * "we sleep in X and day-trip to the villages, no plan yet". The reader said
 * `unclear` for `phases`, and the router answered with the IDENTICAL question,
 * twice more — "לאן אתם הולכים, ומתי? …". The organizer had followed the
 * conversation and was told nothing about what was wrong.
 *
 * What these pin:
 *  - after an `unclear` (or a refused proposal) for the required question on
 *    screen, the NEXT message re-asks that question with a line naming the
 *    missing piece, in the organizer's language, buttons intact;
 *  - a second miss is said differently again, and no two consecutive
 *    messages are ever identical however long it goes on;
 *  - the line is drawn from a closed table keyed by question id and gap, never
 *    from the model's `why` (model output never addresses the organizer);
 *  - an optional question is unaffected: it is still passed over.
 *
 * No model is called: the runner is a stand-in returning exactly the reading
 * the live run produced.
 */
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { describe, test } from "node:test";
import { fileURLToPath } from "node:url";
import pg from "pg";
import { applyMigrations } from "../src/migrations.js";
import { issueEnrollment } from "../src/enrollment.js";
import { renderQuestion, startFromDeepLink } from "../src/chat-router.js";
import {
  INTAKE_QUESTIONS,
  REASK_GAP_PHRASES,
  getSessionForChat,
  queueInboundMessage,
  reaskLead,
} from "../src/interview.js";
import {
  MAX_CONSECUTIVE_REASKS,
  advanceRouterOwnedQuestions,
  flushSettledInboundBursts,
  reaskAttempt,
  reaskGap,
  stripReask,
} from "../src/relay/poller.js";
import { DEFAULT_STRINGS } from "../src/relay/dispatch.js";
import { uiString, type Language } from "../src/intake-copy.js";
import { setInterpretPath, type RejectedProposal } from "../src/interpret.js";
import { testDatabaseUrl, testPool } from "./support/test-database.js";

const HEBREW = /[א-ת]/u;
const LATIN = /[A-Za-z]/;

// ── The table and the selection: pure ───────────────────────────────────────

describe("re-ask phrases — the closed table", () => {
  test("every required question has its own two phrasings, in both languages, all different", () => {
    for (const q of INTAKE_QUESTIONS.filter((x) => x.required)) {
      for (const language of ["en", "he"] as const) {
        const first = reaskLead(q.id, 1, language);
        const second = reaskLead(q.id, 2, language);
        assert.ok(first.trim() && second.trim(), `${q.id}/${language}: no blank line`);
        assert.notEqual(first, second, `${q.id}/${language}: the second miss is said differently`);
        assert.notEqual(first, reaskLead("*", 1, language), `${q.id}/${language}: not the generic fallback`);
        if (language === "he") {
          assert.ok(HEBREW.test(first) && HEBREW.test(second), `${q.id}: Hebrew copy is Hebrew`);
          assert.ok(!LATIN.test(first) && !LATIN.test(second), `${q.id}: no English in the Hebrew copy`);
        } else {
          assert.ok(!HEBREW.test(first) && !HEBREW.test(second), `${q.id}: English copy is English`);
        }
      }
    }
  });

  test("no phrase is shared between two gaps, so a change of gap is a change of text", () => {
    for (const language of ["en", "he"] as const) {
      const seen = new Map<string, string>();
      for (const [gap, byLanguage] of Object.entries(REASK_GAP_PHRASES)) {
        for (const phrase of byLanguage[language]) {
          assert.ok(!seen.has(phrase), `${language}: "${phrase}" used by both ${seen.get(phrase)} and ${gap}`);
          seen.set(phrase, gap);
        }
      }
    }
  });

  test("the phrasings alternate, so consecutive attempts never match", () => {
    for (const language of ["en", "he"] as const) {
      for (let n = 1; n < 8; n += 1) {
        assert.notEqual(reaskLead("phases.dates", n, language), reaskLead("phases.dates", n + 1, language));
      }
    }
  });

  test("an unknown sub-gap falls back to its question's own phrasing, a choice to the choice phrasing", () => {
    assert.equal(reaskLead("phases.nonsense", 1, "en"), reaskLead("phases", 1, "en"));
    assert.equal(reaskLead("bot_tone", 1, "he"), reaskLead("choice", 1, "he"));
    assert.equal(reaskLead("no_such_question", 1, "en"), reaskLead("*", 1, "en"));
  });
});

describe("re-ask gap — which missing piece is named", () => {
  const unclear = (questionId: string, why: string) => [{ questionId, why }];
  const rejected = (questionId: string, reason: RejectedProposal["reason"], detail?: string): RejectedProposal[] => [{
    questionId, reason, detail,
    proposal: { questionId, value: { kind: "text", text: "x" }, confidence: 0.9, evidence: "x", sourceMessageId: "1" },
  }];

  test("the live reading — no date range — names the dates", () => {
    assert.equal(reaskGap("phases", unclear("phases", "gives no date range or accommodation details"), []), "phases.dates");
    assert.equal(reaskGap("phases", unclear("phases", "אין תאריכים"), []), "phases.dates");
  });

  test("a reading about the places names the places; one about both asks for both", () => {
    assert.equal(reaskGap("phases", unclear("phases", "does not say which city they stay in"), []), "phases.places");
    assert.equal(reaskGap("phases", unclear("phases", "no stops and no dates"), []), "phases");
    assert.equal(reaskGap("phases", unclear("phases", ""), []), "phases");
  });

  test("accommodation alone is not a gap — it is asked only if already booked", () => {
    assert.equal(reaskGap("phases", unclear("phases", "accommodation not mentioned"), []), "phases");
  });

  test("a refused proposal names the gap the validator found", () => {
    assert.equal(reaskGap("phases", [], rejected("phases", "INCOMPLETE_ANSWER", "phases[0].start must be YYYY-MM-DD")), "phases.dates");
    assert.equal(reaskGap("travelers", [], rejected("travelers", "INCOMPLETE_ANSWER", "travelers must include a name")), "travelers");
    assert.equal(reaskGap("trip_type", [], rejected("trip_type", "UNKNOWN_OPTION")), "trip_type");
    assert.equal(reaskGap("destination", [], rejected("destination", "LOW_CONFIDENCE")), "destination");
  });

  test("a message that did not try to answer it is not a gap — the question steps aside as before", () => {
    assert.equal(reaskGap("phases", [], []), null);
    assert.equal(reaskGap("phases", unclear("destination", "which country?"), []), null);
    assert.equal(reaskGap("phases", [], rejected("phases", "EVIDENCE_NOT_IN_SOURCE")), null);
    assert.equal(reaskGap("phases", [], rejected("phases", "EXAMPLE_ECHO")), null);
  });
});

describe("re-ask prompt keys", () => {
  test("the attempt rides on the key, and stripping it gives back the question's own key", () => {
    assert.equal(reaskAttempt("q:phases", "phases"), 0);
    assert.equal(reaskAttempt("q:phases:reask:2", "phases"), 2);
    assert.equal(reaskAttempt("q:phases:reask:2", "destination"), 0);
    assert.equal(reaskAttempt(null, "phases"), 0);
    assert.equal(reaskAttempt("q:organizer_identity:unsettled:Dana:none:reask:1", "organizer_identity"), 1);
    assert.equal(stripReask("q:phases:reask:2"), "q:phases");
    assert.equal(stripReask("q:organizer_identity:unsettled:Dana:none:reask:1"), "q:organizer_identity:unsettled:Dana:none");
    assert.equal(stripReask("optional_offer"), "optional_offer");
    assert.equal(stripReask(null), "");
  });
});

// ── Through the real router: DB ─────────────────────────────────────────────

const databaseUrl = testDatabaseUrl();
const SKIP = !databaseUrl;
const migrationsDir = fileURLToPath(new URL("../../db/migrations/", import.meta.url));

function testId(prefix: string): string {
  return `${prefix}_${randomBytes(16).toString("hex")}`;
}

async function seedInterview(pool: pg.Pool, chatId: string): Promise<{ chatId: string; sessionId: string }> {
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
  return { chatId, sessionId: started.kind === "started" ? started.sessionId : "" };
}

async function withInterview(fn: (pool: pg.Pool, chatId: string) => Promise<void>): Promise<void> {
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
    const a = await seedInterview(pool, "840000001");
    // A second chat, untouched: a re-ask that leaked across chats would show here.
    await seedInterview(pool, "840000002");
    await setInterpretPath(pool, a.chatId, true);
    await fn(pool, a.chatId);
    const other = await getSessionForChat(pool, "840000002");
    assert.ok(other.ok);
    assert.equal(other.view.lastPrompt, null, "the other chat was never spoken to");
  } finally {
    await pool.end();
  }
}

const ROSTER = { kind: "structured", schema_version: 3, data: [{ name: "Dana" }] };

/** Answers every required question but `except`, the way a real interview would have. */
async function answerRequiredExcept(pool: pg.Pool, chatId: string, except: readonly string[]): Promise<void> {
  for (const q of INTAKE_QUESTIONS.filter((x) => x.required && !except.includes(x.id))) {
    const answer = q.id === "travelers" ? ROSTER
      : q.id === "organizer_identity" ? { kind: "text", schema_version: 3, text: "Dana" }
      : q.type === "choice" ? { kind: "choice", option_id: q.options![0]!.id, schema_version: 3, other_text: null }
      : { kind: "text", schema_version: 3, text: "x" };
    await pool.query(
      `UPDATE control_plane.intake_sessions SET answers = answers || jsonb_build_object($2::text, $3::jsonb)
        WHERE telegram_chat_id = $1`,
      [chatId, q.id, JSON.stringify(answer)],
    );
  }
}

async function putOnScreen(pool: pg.Pool, chatId: string, language: Language, prompt: string, phase = "essentials"): Promise<void> {
  await pool.query(
    `UPDATE control_plane.intake_sessions
        SET language = $2, awaiting = 'person', phase = $4,
            ui_state = jsonb_build_object('last_prompt', $3::text)
      WHERE telegram_chat_id = $1`,
    [chatId, language, prompt, phase],
  );
}

class Recorder {
  readonly sent: { text: string; buttons: string[] }[] = [];
  async sendMessage(p: { text: string; replyMarkup?: { inline_keyboard: { callback_data?: string }[][] } }) {
    this.sent.push({ text: p.text, buttons: (p.replyMarkup?.inline_keyboard ?? []).flat().map((b) => b.callback_data ?? "") });
    return { ok: true as const, messageId: String(this.sent.length) };
  }
  async editMessageText() { return { ok: true as const }; }
  async sendChatAction() {}
  async answerCallbackQuery() {}
  async getChatInfo() { return null; }
  async getMe() { return { id: "7000000001", username: "T" }; }
  async getUpdates() { return []; }
  async deleteWebhookIfPresent() {}
}

/** The reader as the live run had it: nothing settled, `questionId` unclear, for `why`. */
function unclearRunner(questionId: string, why: string) {
  return {
    async run() {
      return { ok: true as const, value: { proposals: [], unclear: [{ questionId, why }], malformed: 0 }, attempts: 1, ms: 1 };
    },
  };
}

let seq = 0;
async function say(pool: pg.Pool, chatId: string, text: string, telegram: Recorder, modelRunner: unknown, logs: string[] = []) {
  seq += 1;
  const log = (line: string) => { logs.push(line); };
  await queueInboundMessage(pool, chatId, { text, message_id: `r${seq}` } as never);
  await flushSettledInboundBursts({ db: pool, telegram, connector: { pushInbound: () => true }, modelRunner, log } as never, log, 0);
}

function plainQuestion(id: string, language: Language) {
  const question = INTAKE_QUESTIONS.find((q) => q.id === id)!;
  const rendered = renderQuestion(question, [], language);
  return { text: rendered.text, buttons: (rendered.replyMarkup?.inline_keyboard ?? []).flat().map((b) => b.callback_data ?? "") };
}

const LIVE_WHY = "gives no date range or accommodation details";
const LIVE_REPLY_HE = "אנחנו ישנים בעיירה אחת ועושים טיולי יום לכפרים, עוד אין תוכנית";
const LIVE_REPLY_EN = "We sleep in one town and day-trip to the villages, no plan yet";

describe("a required question asked again names what is missing", { skip: SKIP ? "no CONTROL_PLANE_TEST_DATABASE_URL" : false }, () => {
  for (const [language, reply] of [["en", LIVE_REPLY_EN], ["he", LIVE_REPLY_HE]] as const) {
    test(`${language}: the live case — stops raised at the boundary, read as unclear for the dates`, async () => {
      await withInterview(async (pool, chatId) => {
        // The live state: everything else answered, the stops brought back as
        // the last thing before the summary, on screen.
        await answerRequiredExcept(pool, chatId, ["phases"]);
        await putOnScreen(pool, chatId, language, "q:phases");
        const telegram = new Recorder();
        const runner = unclearRunner("phases", LIVE_WHY);
        const original = plainQuestion("phases", language);
        const asked = `${uiString("beforeWeFinish", language)}\n\n${original.text}`;

        const logs: string[] = [];
        await say(pool, chatId, reply, telegram, runner, logs);
        assert.equal(telegram.sent.length, 1, `one reply — sent: ${JSON.stringify(telegram.sent)}`);
        const first = telegram.sent[0]!;
        assert.notEqual(first.text, asked, "never the identical question again");
        assert.notEqual(first.text, original.text);
        assert.equal(first.text, `${reaskLead("phases.dates", 1, language)}\n\n${original.text}`,
          "the gap line, then the same question");
        assert.ok(language === "en" ? /dates/.test(first.text) : first.text.includes("התאריכים"), "names the missing piece");
        assert.ok(!first.text.includes(LIVE_WHY), "the model's own words never reach the organizer");
        assert.deepEqual(first.buttons, original.buttons, "the question's shortcuts are intact");
        assert.ok(logs.some((l) => l.includes("interview.required_reasked") && l.includes("phases.dates")),
          "and the re-ask is in the log, with its gap");

        // Nothing else follows it on a tick: the re-ask IS the question on screen.
        await pool.query("UPDATE control_plane.intake_sessions SET awaiting = 'machine' WHERE telegram_chat_id = $1", [chatId]);
        await advanceRouterOwnedQuestions(
          { db: pool, telegram, connector: { pushInbound: () => true }, modelRunner: runner } as never, DEFAULT_STRINGS, () => {},
        );
        assert.equal(telegram.sent.length, 1, `a tick does not re-send the plain question on top — sent: ${JSON.stringify(telegram.sent)}`);
        await pool.query("UPDATE control_plane.intake_sessions SET awaiting = 'person' WHERE telegram_chat_id = $1", [chatId]);

        // A second miss: said differently again.
        await say(pool, chatId, reply, telegram, runner);
        assert.equal(telegram.sent.length, 2);
        const second = telegram.sent[1]!;
        assert.equal(second.text, `${reaskLead("phases.dates", 2, language)}\n\n${original.text}`);
        assert.notEqual(second.text, first.text, "a further-different message");
        assert.notEqual(second.text, asked);
        assert.deepEqual(second.buttons, original.buttons);

        // And it never loops on one message, however long it goes on.
        for (let i = 0; i < 4; i += 1) await say(pool, chatId, reply, telegram, runner);
        assert.equal(telegram.sent.length, 6, `one reply per message — sent: ${JSON.stringify(telegram.sent.map((m) => m.text.slice(0, 40)))}`);
        for (let i = 1; i < telegram.sent.length; i += 1) {
          assert.notEqual(telegram.sent[i]!.text, telegram.sent[i - 1]!.text, `message ${i + 1} repeats message ${i}`);
          assert.ok(telegram.sent[i]!.text.endsWith(original.text), `message ${i + 1} still asks the stops`);
          assert.deepEqual(telegram.sent[i]!.buttons, original.buttons);
        }
        const view = await getSessionForChat(pool, chatId);
        assert.ok(view.ok);
        assert.equal(view.view.nextQuestion?.id, "phases", "still owed — nothing was recorded or dropped");
      });
    });
  }

  test("mid-interview: the re-ask comes first, and after the cap the question steps aside", async () => {
    await withInterview(async (pool, chatId) => {
      // The stops on screen with the assistant questions still to come.
      await answerRequiredExcept(pool, chatId, ["phases", "bot_name", "bot_gender", "bot_tone"]);
      await putOnScreen(pool, chatId, "en", "q:phases");
      const telegram = new Recorder();
      const runner = unclearRunner("phases", LIVE_WHY);

      for (let n = 1; n <= MAX_CONSECUTIVE_REASKS; n += 1) {
        await say(pool, chatId, LIVE_REPLY_EN, telegram, runner);
        const view = await getSessionForChat(pool, chatId);
        assert.ok(view.ok);
        assert.equal(view.view.lastPrompt, `q:phases:reask:${n}`, `attempt ${n} re-asks the stops`);
        assert.ok(telegram.sent.at(-1)!.text.startsWith(reaskLead("phases.dates", n, "en")));
      }

      // One more miss: the interview moves on rather than pressing a third time.
      await say(pool, chatId, LIVE_REPLY_EN, telegram, runner);
      const after = await getSessionForChat(pool, chatId);
      assert.ok(after.ok);
      assert.equal(after.view.lastPrompt?.split(":")[1], "bot_name", `it moved on — on screen: ${after.view.lastPrompt}`);
      assert.notEqual(telegram.sent.at(-1)!.text, telegram.sent.at(-2)!.text);
    });
  });

  test("a required CHOICE asked again keeps every button — buttons are shortcuts, not syntax", async () => {
    await withInterview(async (pool, chatId) => {
      await putOnScreen(pool, chatId, "he", "q:trip_type", "opening");
      const telegram = new Recorder();
      const original = plainQuestion("trip_type", "he");

      await say(pool, chatId, "משהו כזה, לא ממש", telegram, unclearRunner("trip_type", "not clear which"));

      const last = telegram.sent.at(-1)!;
      assert.notEqual(last.text, original.text);
      assert.equal(last.text, `${reaskLead("trip_type", 1, "he")}\n\n${original.text}`);
      assert.deepEqual(last.buttons, original.buttons, "every option, and Other, still tappable");
      assert.ok(last.buttons.length >= 3);
    });
  });

  test("a message that did not try to answer it still steps aside — no gap line", async () => {
    await withInterview(async (pool, chatId) => {
      await answerRequiredExcept(pool, chatId, ["phases", "bot_name"]);
      await putOnScreen(pool, chatId, "en", "q:phases");
      const telegram = new Recorder();
      const nothing = { async run() { return { ok: true as const, value: { proposals: [], unclear: [], malformed: 0 }, attempts: 1, ms: 1 }; } };

      await say(pool, chatId, "look at the document I uploaded", telegram, nothing);

      const view = await getSessionForChat(pool, chatId);
      assert.ok(view.ok);
      assert.equal(view.view.lastPrompt, "q:bot_name", "moved on, as before");
      for (const gap of Object.keys(REASK_GAP_PHRASES)) {
        assert.ok(!telegram.sent.at(-1)!.text.startsWith(reaskLead(gap, 1, "en")), "no gap line for a question nobody answered");
      }
    });
  });

  test("an unrelated message at the boundary is not answered with the identical blocker twice", async () => {
    await withInterview(async (pool, chatId) => {
      await answerRequiredExcept(pool, chatId, ["phases"]);
      await putOnScreen(pool, chatId, "en", "q:phases");
      const telegram = new Recorder();
      const nothing = { async run() { return { ok: true as const, value: { proposals: [], unclear: [], malformed: 0 }, attempts: 1, ms: 1 }; } };

      await say(pool, chatId, "thanks!", telegram, nothing);
      await say(pool, chatId, "ok", telegram, nothing);
      await say(pool, chatId, "sure", telegram, nothing);

      assert.equal(telegram.sent.length, 3, `one reply each — sent: ${JSON.stringify(telegram.sent)}`);
      const original = plainQuestion("phases", "en");
      for (let i = 0; i < telegram.sent.length; i += 1) {
        assert.ok(telegram.sent[i]!.text.endsWith(original.text), "each one asks the stops");
        if (i > 0) assert.notEqual(telegram.sent[i]!.text, telegram.sent[i - 1]!.text, `message ${i + 1} repeats message ${i}`);
      }
    });
  });

  test("an OPTIONAL question read as unclear is still passed over, not re-asked", async () => {
    await withInterview(async (pool, chatId) => {
      await answerRequiredExcept(pool, chatId, []);
      await pool.query(
        `UPDATE control_plane.intake_sessions
            SET language = 'en', awaiting = 'person', phase = 'optional',
                ui_state = jsonb_build_object('last_prompt', 'q:trip_interests', 'offered_more', true)
          WHERE telegram_chat_id = $1`,
        [chatId],
      );
      const telegram = new Recorder();

      await say(pool, chatId, "maybe some things", telegram, unclearRunner("trip_interests", "too vague"));

      const view = await getSessionForChat(pool, chatId);
      assert.ok(view.ok);
      assert.equal(view.view.optionalRemaining.some((q) => q.id === "trip_interests"), false, "passed over");
      assert.ok(!(view.view.lastPrompt ?? "").includes(":reask:"), `not re-asked — on screen: ${view.view.lastPrompt}`);
      for (const m of telegram.sent) {
        assert.ok(!m.text.startsWith(reaskLead("trip_interests", 1, "en")) && !m.text.startsWith(reaskLead("*", 1, "en")));
      }
    });
  });
});
