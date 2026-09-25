import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { describe, test } from "node:test";
import { fileURLToPath } from "node:url";
import pg from "pg";
import { applyMigrations } from "../src/migrations.js";
import { issueEnrollment } from "../src/enrollment.js";
import {
  startFromDeepLink,
  answerCallbackData,
  CONFIRM_CALLBACK_DATA,
  setCompanionExpectsReply,
} from "../src/chat-router.js";
import { dispatchUpdate, DEFAULT_STRINGS } from "../src/relay/dispatch.js";
import { GroupContext } from "../src/relay/group-context.js";
import { confirmIntakeForChat, getSessionForChat, submitAnswerForChat } from "../src/interview.js";
import { issueGroupBindingToken } from "../src/group-binding.js";
import type { TelegramUpdate } from "../src/relay/normalize.js";
import { testDatabaseUrl } from "./support/test-database.js";
import { agentTextIsInLanguage } from "../src/relay/internal-leak.js";
import { digestTelegramId } from "../src/identity.js";
import { runnerForBinding, type StructuredModelRunner } from "../src/model-runner.js";
import { switchableRunner } from "../src/model-task-settings.js";

const databaseUrl = testDatabaseUrl();
const SKIP = !databaseUrl;
const migrationsDir = fileURLToPath(new URL("../../db/migrations/", import.meta.url));

function testId(prefix: string): string {
  return `${prefix}_${randomBytes(16).toString("hex")}`;
}

interface Fixture {
  pool: pg.Pool;
  tripId: string;
  userId: string;
}

async function withFixture(fn: (fix: Fixture) => Promise<void>): Promise<void> {
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
    await fn({ pool, tripId, userId });
  } finally {
    await pool.end();
  }
}

function msg(chatId: string, text: string, chatType = "private"): TelegramUpdate {
  return {
    update_id: 1,
    message: {
      message_id: 7,
      from: { id: 777, first_name: "Dror" },
      chat: { id: chatId, type: chatType },
      text,
    },
  };
}

function tap(chatId: string | null, data: string, fromId = 777): TelegramUpdate {
  return {
    update_id: 2,
    callback_query: {
      id: "cbq_1",
      data,
      from: { id: fromId },
      ...(chatId === null ? {} : { message: { message_id: 7, chat: { id: chatId, type: "private" } } }),
    },
  };
}

async function bindCompanion(fix: Fixture, chatId: string, profile: string | null): Promise<void> {
  await fix.pool.query(
    "INSERT INTO control_plane.telegram_chat_bindings(id, chat_id, trip_id, hermes_profile) VALUES ('tcb_' || md5(random()::text), $1, $2, $3)",
    [chatId, fix.tripId, profile],
  );
}

describe("dispatchUpdate — the branch table", () => {
  test("a valid deep link starts the interview and replies with the first question", { skip: SKIP }, async () => {
    await withFixture(async (fix) => {
      const issued = await issueEnrollment(fix.pool, fix.userId, fix.tripId, { enrollmentTtlSeconds: 3600 });
      assert.ok(issued.ok);

      const decision = await dispatchUpdate(fix.pool, msg("700000111", `/start ${issued.token}`));
      assert.equal(decision.kind, "reply");
      if (decision.kind !== "reply") return;
      assert.equal(decision.reply.chatId, "700000111");
      // The question comes back on the first tap — no "hold on while I set up".
      assert.ok(decision.reply.text.length > 0);
      assert.ok(decision.reply.replyMarkup, "the first intake question is a choice, so it carries buttons");
    });
  });

  test("a /start is never forwarded to the gateway", { skip: SKIP }, async () => {
    // The entire reason the connector owns the socket: Hermes's gateway
    // discards every /start before an agent sees it.
    await withFixture(async (fix) => {
      await bindCompanion(fix, "700000222", "companion");
      const decision = await dispatchUpdate(fix.pool, msg("700000222", "/start something"));
      assert.notEqual(decision.kind, "to_gateway");
    });
  });

  test("a bound chat's ordinary message goes to the gateway with its profile", { skip: SKIP }, async () => {
    await withFixture(async (fix) => {
      await bindCompanion(fix, "700000333", "companion-japan");
      const decision = await dispatchUpdate(fix.pool, msg("700000333", "what time is our flight?"));
      assert.equal(decision.kind, "to_gateway");
      if (decision.kind !== "to_gateway") return;
      assert.equal(decision.event.source.profile, "companion-japan");
      assert.equal(decision.event.text, "what time is our flight?");
    });
  });

  test("Hermes's own commands never reach the gateway", { skip: SKIP }, async () => {
    // The hole this closes: /help, /model, /reset, /sethome are Hermes's, not
    // the trip's, and under the relay they arrive as ordinary text. Forwarded,
    // they handed a family group the controls of the runtime their assistant
    // runs on — on 2026-09-12 a group's first contact answered "type /help to
    // see the available commands" and the leak guard started catching
    // `sethome` on its way into the room.
    await withFixture(async (fix) => {
      await bindCompanion(fix, "700000555", "companion-japan");
      await fix.pool.query(
        `UPDATE control_plane.trips SET companion_intro = $2::jsonb WHERE id = $1`,
        [fix.tripId, JSON.stringify({
          assistant_name: "Rio", private_url: "https://japan-2026.example", language: "en",
        })],
      );
      for (const command of ["/help", "/model gpt-5", "/reset", "/sethome", "/new"]) {
        const decision = await dispatchUpdate(fix.pool, msg("700000555", command));
        assert.equal(decision.kind, "reply", `${command} must not reach a gateway`);
        if (decision.kind !== "reply") return;
        assert.match(decision.reply.text, /Rio/);
        // The answer is the opposite of a command list: there is nothing here
        // to operate, and saying so is the point.
        assert.match(decision.reply.text, /just talk to me/i);
      }
    });
  });

  test("the super admin switches a task's model from their own DM, and it is recorded", { skip: SKIP }, async () => {
    await withFixture(async (fix) => {
      await bindCompanion(fix, "700000560", "companion-japan");
      const superAdmin = digestTelegramId("777");
      const pinned: StructuredModelRunner = {
        describe: () => ({ provider: "claude", model: "claude-sonnet-5" }),
        run: async () => ({ ok: false, error: "NOT_CONFIGURED", attempts: 0, ms: 0 }) as never,
      };
      const runner = switchableRunner(pinned, (task, b) => runnerForBinding(b.runner, b.model, 90_000, task, {}));
      const options = { superAdminSubjectDigest: superAdmin, modelRunner: runner };

      const listing = await dispatchUpdate(fix.pool, msg("700000560", "/models"), DEFAULT_STRINGS, () => {}, {}, options);
      assert.equal(listing.kind, "reply");
      if (listing.kind !== "reply") return;
      assert.match(listing.reply.text, /extract_intake: claude:claude-sonnet-5 — environment/);

      const set = await dispatchUpdate(
        fix.pool, msg("700000560", "/model extract_intake codex:gpt-5.6-luna"), DEFAULT_STRINGS, () => {}, {}, options,
      );
      assert.equal(set.kind === "reply" && /extract_intake → codex:gpt-5.6-luna \(override\)/.test(set.reply.text), true);
      assert.deepEqual(runner.describe?.("extract_intake"), { provider: "codex", model: "gpt-5.6-luna" }, "applied at once");
      assert.deepEqual(runner.describe?.("interpret"), { provider: "claude", model: "claude-sonnet-5" });

      // Refused bindings change nothing and record nothing.
      for (const refused of ["/model extract_intake openrouter:openrouter/auto", "/model extract_intake openrouter:vendor/model", "/model plan_review codex:x"]) {
        const reply = await dispatchUpdate(fix.pool, msg("700000560", refused), DEFAULT_STRINGS, () => {}, {}, options);
        assert.equal(reply.kind, "reply", refused);
      }
      const cleared = await dispatchUpdate(
        fix.pool, msg("700000560", "/model extract_intake default"), DEFAULT_STRINGS, () => {}, {}, options,
      );
      assert.equal(cleared.kind === "reply" && /\(environment\)/.test(cleared.reply.text), true);

      const settings = await fix.pool.query("SELECT task FROM control_plane.model_task_settings");
      assert.equal(settings.rowCount, 0, "cleared");
      const history = await fix.pool.query<{ task: string; runner: string | null; model: string | null; changed_by: string }>(
        "SELECT task, runner, model, changed_by FROM control_plane.model_task_setting_history ORDER BY changed_at, id",
      );
      assert.deepEqual(history.rows.map((r) => [r.task, r.runner, r.model]).sort((a, b) => String(a[1]).localeCompare(String(b[1]))), [
        ["extract_intake", "codex", "gpt-5.6-luna"],
        ["extract_intake", null, null],
      ]);
      assert.ok(history.rows.every((r) => r.changed_by === superAdmin));
      await assert.rejects(
        fix.pool.query("DELETE FROM control_plane.model_task_setting_history"),
        /append-only/,
      );
    });
  });

  test("/model is nobody else's, and nowhere else: it answers like any unknown command", { skip: SKIP }, async () => {
    await withFixture(async (fix) => {
      await bindCompanion(fix, "700000561", "companion-japan");
      await bindCompanion(fix, "-1002000561", "companion-japan");
      await fix.pool.query(
        `UPDATE control_plane.trips SET companion_intro = $2::jsonb WHERE id = $1`,
        [fix.tripId, JSON.stringify({ assistant_name: "Rio", language: "en" })],
      );
      const runner = switchableRunner(
        { describe: () => ({ provider: "claude", model: "claude-sonnet-5" }), run: async () => ({}) as never },
        () => undefined,
      );
      const notTheAdmin = { superAdminSubjectDigest: digestTelegramId("999"), modelRunner: runner };
      const theAdmin = { superAdminSubjectDigest: digestTelegramId("777"), modelRunner: runner };

      const cases: [TelegramUpdate, typeof theAdmin | Record<string, never>][] = [
        [msg("700000561", "/model extract_intake codex:gpt-5.6-luna"), notTheAdmin],
        [msg("700000561", "/models"), {}],
        [msg("-1002000561", "/model extract_intake codex:gpt-5.6-luna", "supergroup"), theAdmin],
      ];
      for (const [update, options] of cases) {
        const decision = await dispatchUpdate(fix.pool, update, DEFAULT_STRINGS, () => {}, {}, options);
        assert.equal(decision.kind, "reply");
        if (decision.kind !== "reply") return;
        assert.match(decision.reply.text, /Rio/, "the companion's answer to an unknown command");
        assert.doesNotMatch(decision.reply.text, /extract_intake|override|environment/);
      }
      const written = await fix.pool.query("SELECT 1 FROM control_plane.model_task_setting_history");
      assert.equal(written.rowCount, 0);
    });
  });

  test("an unknown command says so; /help simply helps", { skip: SKIP }, async () => {
    await withFixture(async (fix) => {
      await bindCompanion(fix, "700000556", "companion-japan");
      await fix.pool.query(
        `UPDATE control_plane.trips SET companion_intro = $2::jsonb WHERE id = $1`,
        [fix.tripId, JSON.stringify({ assistant_name: "Rio", language: "en" })],
      );
      const unknown = await dispatchUpdate(fix.pool, msg("700000556", "/sethome"));
      assert.equal(unknown.kind === "reply" && /\/sethome isn't one of my commands/.test(unknown.reply.text), true);
      const help = await dispatchUpdate(fix.pool, msg("700000556", "/help"));
      assert.equal(help.kind === "reply" && /isn't one of my commands/.test(help.reply.text), false,
        "asking for help is not an error");
    });
  });

  test("the group is told in its own language, and only the organizer is told about /group", { skip: SKIP }, async () => {
    await withFixture(async (fix) => {
      await bindCompanion(fix, "-1002000999", "companion-japan");
      await fix.pool.query(
        `UPDATE control_plane.trips SET companion_intro = $2::jsonb WHERE id = $1`,
        [fix.tripId, JSON.stringify({ assistant_name: "יפו", language: "he" })],
      );
      const inGroup = await dispatchUpdate(fix.pool, msg("-1002000999", "/help", "supergroup"));
      assert.equal(inGroup.kind, "reply");
      if (inGroup.kind !== "reply") return;
      assert.match(inGroup.reply.text, /יפו/);
      // /group binds a group to a trip and is issued from the organizer's own
      // chat. Naming it inside the group would be an invitation to nothing.
      assert.doesNotMatch(inGroup.reply.text, /\/group/);

      await bindCompanion(fix, "700000557", "companion-japan");
      const inDm = await dispatchUpdate(fix.pool, msg("700000557", "/help"));
      assert.equal(inDm.kind === "reply" && /\/group/.test(inDm.reply.text), true);
    });
  });

  test("a known sender reaches the assistant by their name on the trip", { skip: SKIP }, async () => {
    // Telegram's display name is set by the sender, so it is not identity —
    // and in a family group it was the only thing the assistant had. The trip
    // person link is the control plane's own record, written at provisioning
    // from the interview chat.
    await withFixture(async (fix) => {
      await bindCompanion(fix, "-1002000111", "companion-japan");
      // A group message only reaches the assistant when it addresses it by
      // name — the relevance gate the shared bot depends on.
      await fix.pool.query(
        "UPDATE control_plane.trips SET assistant_names = $2 WHERE id = $1",
        [fix.tripId, ["Rio"]],
      );
      await fix.pool.query(
        `INSERT INTO control_plane.trip_person_links
           (id, trip_id, telegram_user_id, participant_username, display_name, role, verified_via)
         VALUES ('tpl_' || md5(random()::text), $1, '777', 'nirsolomon', $2, 'organizer', 'interview_chat')`,
        [fix.tripId, "ניר סולומון"],
      );

      const update = msg("-1002000111", "Rio, what time do we leave?", "supergroup");
      const decision = await dispatchUpdate(fix.pool, update);
      assert.equal(decision.kind, "to_gateway");
      if (decision.kind !== "to_gateway") return;
      // msg() sends from Telegram user 777 calling themselves "Dror".
      assert.equal(decision.event.source.user_name, "ניר סולומון");
      assert.equal(decision.event.source.user_id, "777");
    });
  });

  test("a sender the trip does not know keeps their Telegram name", { skip: SKIP }, async () => {
    await withFixture(async (fix) => {
      await bindCompanion(fix, "-1002000222", "companion-japan");
      await fix.pool.query(
        "UPDATE control_plane.trips SET assistant_names = $2 WHERE id = $1",
        [fix.tripId, ["Rio"]],
      );
      const decision = await dispatchUpdate(
        fix.pool, msg("-1002000222", "Rio, where are we staying?", "supergroup"),
      );
      assert.equal(decision.kind, "to_gateway");
      if (decision.kind !== "to_gateway") return;
      assert.equal(decision.event.source.user_name, "Dror");
    });
  });

  test("/name renames the assistant — and the router hears the new name", { skip: SKIP }, async () => {
    // 2026-09-13: a family renamed their assistant in the group, it agreed, and
    // every message that used the new name was dropped as NOT_ADDRESSED — the
    // router only listens for `trips.assistant_names`, and nothing could change
    // them after provisioning.
    await withFixture(async (fix) => {
      const group = "-1002000444";
      await bindCompanion(fix, group, "companion-japan");
      await fix.pool.query(
        "UPDATE control_plane.trips SET assistant_names = $2, companion_intro = $3::jsonb WHERE id = $1",
        [fix.tripId, ["סולומון"], JSON.stringify({ assistant_name: "סולומון", language: "he" })],
      );

      const renamed = await dispatchUpdate(fix.pool, msg(group, "/name סולו / Solo", "supergroup"));
      assert.equal(renamed.kind, "reply");
      assert.equal(renamed.kind === "reply" && /סולו/.test(renamed.reply.text), true);

      const { rows } = await fix.pool.query(
        "SELECT assistant_names, companion_intro->>'assistant_name' AS intro FROM control_plane.trips WHERE id = $1",
        [fix.tripId],
      );
      assert.deepEqual(rows[0].assistant_names, ["סולו", "Solo"]);
      assert.equal(rows[0].intro, "סולו", "the next group welcome uses the new name too");

      const byNewName = await dispatchUpdate(fix.pool, msg(group, "סולו, מה התוכנית מחר?", "supergroup"));
      assert.equal(byNewName.kind, "to_gateway", "the new name now reaches the companion");
      const byOldName = await dispatchUpdate(fix.pool, msg(group, "משפחת סולומון יוצאת מחר", "supergroup"));
      assert.equal(byOldName.kind, "ignore", "a rename replaces — the old name no longer wakes it");
    });
  });

  test("/name alone says what the assistant answers to, and how to change it", { skip: SKIP }, async () => {
    await withFixture(async (fix) => {
      await bindCompanion(fix, "700000611", "companion-japan");
      await fix.pool.query(
        "UPDATE control_plane.trips SET assistant_names = $2, companion_intro = $3::jsonb WHERE id = $1",
        [fix.tripId, ["Rio"], JSON.stringify({ assistant_name: "Rio", language: "en" })],
      );
      const decision = await dispatchUpdate(fix.pool, msg("700000611", "/name"));
      assert.equal(decision.kind, "reply");
      if (decision.kind !== "reply") return;
      assert.match(decision.reply.text, /Rio/);
      assert.match(decision.reply.text, /\/name/);
    });
  });

  test("a name nobody could type is refused, and the names stay as they were", { skip: SKIP }, async () => {
    await withFixture(async (fix) => {
      await bindCompanion(fix, "700000612", "companion-japan");
      await fix.pool.query(
        "UPDATE control_plane.trips SET assistant_names = $2, companion_intro = $3::jsonb WHERE id = $1",
        [fix.tripId, ["Rio"], JSON.stringify({ assistant_name: "Rio", language: "en" })],
      );
      const decision = await dispatchUpdate(fix.pool, msg("700000612", "/name @someone_else"));
      assert.equal(decision.kind === "reply" && /won't work/.test(decision.reply.text), true);
      const { rows } = await fix.pool.query("SELECT assistant_names FROM control_plane.trips WHERE id = $1", [fix.tripId]);
      assert.deepEqual(rows[0].assistant_names, ["Rio"]);
    });
  });

  test("/name in a chat with no trip renames nothing", { skip: SKIP }, async () => {
    await withFixture(async (fix) => {
      const decision = await dispatchUpdate(fix.pool, msg("700000613", "/name Rio"));
      assert.equal(decision.kind === "reply" && decision.reply.text, DEFAULT_STRINGS.unbound);
    });
  });

  test("an unknown chat is refused, never routed", { skip: SKIP }, async () => {
    await withFixture(async (fix) => {
      const decision = await dispatchUpdate(fix.pool, msg("700000444", "hello?"));
      assert.equal(decision.kind, "reply");
      assert.equal(decision.kind === "reply" && decision.reply.text, DEFAULT_STRINGS.unbound);
    });
  });

  test("a bound chat with no assistant yet is answered honestly, not told it has no trip", { skip: SKIP }, async () => {
    // The whole point of A4, at the only layer the organizer sees. On
    // 2026-09-06 a trip provisioned perfectly — site up, HTTP 200 — and the
    // organizer messaging the bot was told "I don't have a trip for this
    // chat", because the companion install had failed and routing was gated
    // behind it. Routing now exists independently, so the honest answer is
    // available: we know your trip, the assistant is not ready yet.
    await withFixture(async (fix) => {
      await bindCompanion(fix, "700000666", null);
      const decision = await dispatchUpdate(fix.pool, msg("700000666", "מתי הטיסה שלנו?"));
      assert.equal(decision.kind, "reply");
      assert.equal(
        decision.kind === "reply" && decision.reply.text,
        DEFAULT_STRINGS.companionPending,
      );
      assert.notEqual(
        decision.kind === "reply" && decision.reply.text,
        DEFAULT_STRINGS.unbound,
        "never claim the trip is unknown — it is bound, and the site is already up",
      );
    });
  });

  test("a bare /start explains itself instead of failing silently", { skip: SKIP }, async () => {
    await withFixture(async (fix) => {
      const decision = await dispatchUpdate(fix.pool, msg("700000555", "/start"));
      assert.equal(decision.kind === "reply" && decision.reply.text, DEFAULT_STRINGS.noPayload);
    });
  });

  test("a dead link gets a different sentence from a bare /start", { skip: SKIP }, async () => {
    await withFixture(async (fix) => {
      const decision = await dispatchUpdate(fix.pool, msg("700000666", "/start deadtokenxyz"));
      assert.equal(decision.kind === "reply" && decision.reply.text, DEFAULT_STRINGS.badLink);
    });
  });

  test("a code we could never have issued is refused, not welcomed", { skip: SKIP }, async () => {
    // Dror, 2026-09-18: "I gave it invalid token and got a greeting, it should
    // have said unknown". `deadtokenxyz` above is refused because it LOOKS like
    // a token and misses; anything outside Telegram's payload alphabet never
    // reaches the lookup at all, and that shortcut was answering with the
    // welcome meant for someone who arrived with no link — which reads as if
    // the code had been accepted.
    await withFixture(async (fix) => {
      for (const bad of ["/start not a token", "/start ../../etc/passwd", "/start " + "a".repeat(65)]) {
        const decision = await dispatchUpdate(fix.pool, msg("700000777", bad));
        assert.equal(
          decision.kind === "reply" && decision.reply.text,
          DEFAULT_STRINGS.badLink,
          `${bad} must be refused as a bad link`,
        );
      }
      // And the real case it was being confused with still gets the welcome.
      const bare = await dispatchUpdate(fix.pool, msg("700000777", "/start"));
      assert.equal(bare.kind === "reply" && bare.reply.text, DEFAULT_STRINGS.noPayload);
    });
  });

  test("a deep link opened in a group is redirected to a DM", { skip: SKIP }, async () => {
    await withFixture(async (fix) => {
      const issued = await issueEnrollment(fix.pool, fix.userId, fix.tripId, { enrollmentTtlSeconds: 3600 });
      assert.ok(issued.ok);
      const decision = await dispatchUpdate(
        fix.pool,
        msg("-1005550000", `/start ${issued.token}`, "supergroup"),
      );
      assert.equal(decision.kind === "reply" && decision.reply.text, DEFAULT_STRINGS.notPrivate);

      const state = await fix.pool.query(
        "SELECT state FROM control_plane.interview_enrollments WHERE id = $1",
        [issued.enrollmentId],
      );
      assert.equal(state.rows[0].state, "issued", "the link must survive to be used in a DM");
    });
  });

  test("the bot's own message is ignored, not echoed back into a turn", { skip: SKIP }, async () => {
    await withFixture(async (fix) => {
      await bindCompanion(fix, "700000777", "companion");
      const update = msg("700000777", "an earlier reply of mine");
      update.message!.from = { id: 999, is_bot: true };
      const decision = await dispatchUpdate(fix.pool, update);
      assert.deepEqual(decision, { kind: "ignore", reason: "FROM_BOT" });
    });
  });
});

describe("dispatchUpdate — callback routing", () => {
  test("an interview button is routed to that chat's own session", { skip: SKIP }, async () => {
    await withFixture(async (fix) => {
      const issued = await issueEnrollment(fix.pool, fix.userId, fix.tripId, { enrollmentTtlSeconds: 3600 });
      assert.ok(issued.ok);
      const started = await startFromDeepLink(fix.pool, "700001000", issued.token);
      assert.equal(started.kind, "started");

      const decision = await dispatchUpdate(
        fix.pool,
        tap("700001000", answerCallbackData("trip_type", "family")),
      );
      assert.equal(decision.kind, "interview_callback");
      if (decision.kind !== "interview_callback") return;
      assert.equal(decision.chatId, "700001000");
      assert.equal(
        decision.sessionId,
        started.kind === "started" ? started.sessionId : "",
        "the session must come from the chat, not from the payload",
      );
    });
  });

  test("a replayed interview button cannot reach another organizer's session", { skip: SKIP }, async () => {
    // parseCallbackData yields only WHICH option was tapped. The session comes
    // from the chat the tap arrived in, so a stolen payload lands nowhere.
    await withFixture(async (fix) => {
      const issued = await issueEnrollment(fix.pool, fix.userId, fix.tripId, { enrollmentTtlSeconds: 3600 });
      assert.ok(issued.ok);
      await startFromDeepLink(fix.pool, "700001100", issued.token);

      const decision = await dispatchUpdate(
        fix.pool,
        tap("700001199", answerCallbackData("trip_type", "family")),
      );
      assert.deepEqual(decision, { kind: "ignore", reason: "STALE_INTERVIEW_CALLBACK" });
    });
  });

  test("a confirm tap from a finished session is stale, not an approval token", { skip: SKIP }, async () => {
    // The dangerous confusion would be an interview-shaped callback falling
    // through to the signup-approval path, which acts on a signed token.
    await withFixture(async (fix) => {
      await bindCompanion(fix, "700001200", "companion");
      const decision = await dispatchUpdate(fix.pool, tap("700001200", CONFIRM_CALLBACK_DATA));
      assert.deepEqual(decision, { kind: "ignore", reason: "STALE_INTERVIEW_CALLBACK" });
    });
  });

  // #206: a typed-change button (`pc:<draft>:<digest>:a|c|r:<k>`) is routed by the
  // chat it arrives in, and ANSWERED wherever it lands - an ignored tap leaves the
  // button spinning for whoever pressed it.
  const PC = `pc:pchg_${"0123456789abcdef".repeat(2)}:0a1b2c3d:a`;

  test("a typed-change tap from the owning chat reaches the interview, with the session from the chat", { skip: SKIP }, async () => {
    await withFixture(async (fix) => {
      const issued = await issueEnrollment(fix.pool, fix.userId, fix.tripId, { enrollmentTtlSeconds: 3600 });
      assert.ok(issued.ok);
      const started = await startFromDeepLink(fix.pool, "700001400", issued.token);
      assert.equal(started.kind, "started");
      const decision = await dispatchUpdate(fix.pool, tap("700001400", PC));
      assert.equal(decision.kind, "interview_callback");
      if (decision.kind !== "interview_callback") return;
      assert.equal(decision.data, PC, "the tap is handed to the interview whole, digest included");
      assert.equal(decision.sessionId, started.kind === "started" ? started.sessionId : "");
    });
  });

  test("a typed-change tap from another chat, a group, and a confirmed session is answered, not dropped", { skip: SKIP }, async () => {
    await withFixture(async (fix) => {
      const issued = await issueEnrollment(fix.pool, fix.userId, fix.tripId, { enrollmentTtlSeconds: 3600 });
      assert.ok(issued.ok);
      await startFromDeepLink(fix.pool, "700001500", issued.token);

      const inGroup = (chatId: string): TelegramUpdate => ({
        update_id: 3,
        callback_query: { id: "cbq_g", data: PC, from: { id: 777 }, message: { message_id: 7, chat: { id: chatId, type: "supergroup" } } },
      });
      // Another organizer's chat (no interview of its own).
      const stranger = await dispatchUpdate(fix.pool, tap("700001599", PC));
      assert.equal(stranger.kind, "callback_reply");
      assert.equal((stranger as { text?: string }).text, "That change is no longer waiting.");
      assert.equal((stranger as { chatId?: string }).chatId, "700001599");
      // A group.
      const group = await dispatchUpdate(fix.pool, inGroup("-1001234567890"));
      assert.equal(group.kind, "callback_reply");
      assert.equal((group as { callbackQueryId?: string }).callbackQueryId, "cbq_g");
      // The owning chat once its interview is confirmed.
      await fix.pool.query("UPDATE control_plane.intake_sessions SET state = 'confirmed' WHERE telegram_chat_id = $1", ["700001500"]);
      const confirmed = await dispatchUpdate(fix.pool, tap("700001500", PC));
      assert.equal(confirmed.kind, "callback_reply");
      assert.equal((confirmed as { text?: string }).text, "That change is no longer waiting.");
    });
  });

  test("an approval-shaped callback reaches the approval path with its sender", { skip: SKIP }, async () => {
    await withFixture(async (fix) => {
      const decision = await dispatchUpdate(fix.pool, tap("700001300", "cbk_deadbeefdeadbeef", 12345));
      assert.equal(decision.kind, "approval_callback");
      if (decision.kind !== "approval_callback") return;
      // The sender identity comes off the observed Telegram event, never from
      // the payload — the webhook/callback trust boundary.
      assert.equal(decision.fromId, "12345");
      assert.equal(decision.data, "cbk_deadbeefdeadbeef");
    });
  });

  test("a callback with no sender is dropped", { skip: SKIP }, async () => {
    await withFixture(async (fix) => {
      const update = tap(null, "cbk_deadbeefdeadbeef");
      update.callback_query!.from = undefined;
      assert.deepEqual(await dispatchUpdate(fix.pool, update), {
        kind: "ignore",
        reason: "NO_CALLBACK_SENDER",
      });
    });
  });
});

describe("chat-addressed session writes", () => {
  // The router holds a router-verified chat id and never a session token.
  // These assert that the chat alone is a sufficient AND correctly scoped
  // credential — the reason submitAnswerForChat exists rather than the router
  // storing a token at rest to satisfy submitAnswer's signature.

  test("an answer written by chat id lands in that chat's session", { skip: SKIP }, async () => {
    await withFixture(async (fix) => {
      const issued = await issueEnrollment(fix.pool, fix.userId, fix.tripId, { enrollmentTtlSeconds: 3600 });
      assert.ok(issued.ok);
      const started = await startFromDeepLink(fix.pool, "700002000", issued.token);
      assert.equal(started.kind, "started");

      const result = await submitAnswerForChat(fix.pool, "700002000", "trip_type", "family");
      assert.ok(result.ok);
      assert.equal(result.ok && result.view.sessionId, started.kind === "started" ? started.sessionId : "");
      assert.equal(result.ok && result.view.nextQuestion?.id, "destination");
    });
  });

  test("a chat with no interview can write nothing", { skip: SKIP }, async () => {
    // Fail closed. The chat id is a routing fact; where it resolves to no
    // session it must grant nothing, not fall back to any default.
    await withFixture(async (fix) => {
      const result = await submitAnswerForChat(fix.pool, "700002001", "trip_type", "family");
      assert.equal(result.ok, false);
      assert.equal(result.ok === false && result.reason, "NOT_FOUND");
    });
  });

  test("one organizer's chat cannot write into another's session", { skip: SKIP }, async () => {
    await withFixture(async (fix) => {
      const first = await issueEnrollment(fix.pool, fix.userId, fix.tripId, { enrollmentTtlSeconds: 3600 });
      assert.ok(first.ok);
      await startFromDeepLink(fix.pool, "700002002", first.token);

      // A second chat, no session of its own, submitting the same payload.
      const result = await submitAnswerForChat(fix.pool, "700002003", "trip_type", "couple");
      assert.equal(result.ok, false);

      const victim = await getSessionForChat(fix.pool, "700002002");
      assert.ok(victim.ok);
      assert.equal(victim.ok && victim.view.nextQuestion?.id, "trip_type", "untouched");
    });
  });

  test("a confirmed session refuses further answers but still confirms idempotently", { skip: SKIP }, async () => {
    await withFixture(async (fix) => {
      const issued = await issueEnrollment(fix.pool, fix.userId, fix.tripId, { enrollmentTtlSeconds: 3600 });
      assert.ok(issued.ok);
      await startFromDeepLink(fix.pool, "700002004", issued.token);
      await fix.pool.query(
        `UPDATE control_plane.intake_sessions
         SET answers = $1, state = 'awaiting_confirmation'
         WHERE telegram_chat_id = $2`,
        [
          JSON.stringify({
            trip_type: { kind: "choice", option_id: "family", schema_version: 2, other_text: null },
            destination: { kind: "text", schema_version: 2, text: "Japan" },
            group_size: { kind: "choice", option_id: "3_to_5", schema_version: 2, other_text: null },
            trip_duration: { kind: "choice", option_id: "week", schema_version: 2, other_text: null },
            departure_date: { kind: "text", schema_version: 2, text: "2026-09-06" },
            return_date: { kind: "text", schema_version: 2, text: "2026-09-13" },
            travelers: { kind: "structured", schema_version: 2, data: [{ name: "Dror" }] },
            phases: { kind: "structured", schema_version: 2, data: [{ name: "Tokyo" }] },
            bot_name: { kind: "text", schema_version: 2, text: "Rio" },
            bot_gender: { kind: "choice", option_id: "neutral", schema_version: 2, other_text: null },
            bot_tone: { kind: "choice", option_id: "warm", schema_version: 2, other_text: null },
            // Required as of 2026-09-11: without it no companion is built.
            organizer_identity: { kind: "text", schema_version: 2, text: "Dror" },
            // The assistant's identity became required on 2026-09-07, so a
            // session that can confirm has to carry it.
            bot_name: { kind: "text", schema_version: 2, text: "Rio" },
            bot_gender: { kind: "choice", option_id: "neutral", schema_version: 2, other_text: null },
            bot_tone: { kind: "choice", option_id: "warm", schema_version: 2, other_text: null },
            // Required as of 2026-09-11: without it no companion is built.
            organizer_identity: { kind: "text", schema_version: 2, text: "Dror" },
          }),
          "700002004",
        ],
      );

      const first = await confirmIntakeForChat(fix.pool, "700002004");
      assert.ok(first.ok);

      // Locating by chat must NOT exclude confirmed sessions, or this second
      // call — an organizer double-tapping Confirm — would report NOT_FOUND
      // for a confirmation that in fact succeeded.
      const second = await confirmIntakeForChat(fix.pool, "700002004");
      assert.ok(second.ok);
      assert.equal(
        second.ok && second.intakeVersionId,
        first.ok ? first.intakeVersionId : "",
        "the same version, not a second one",
      );

      const late = await submitAnswerForChat(fix.pool, "700002004", "trip_type", "couple");
      assert.equal(late.ok === false && late.reason, "SESSION_CONFIRMED");
    });
  });

  test("a second interview in the same chat is the one that gets written", { skip: SKIP }, async () => {
    // An organizer who finished one trip must be able to start another from
    // the same DM (Sprint 5's "re-enter interview mode for a new trip"). The
    // chat then owns two sessions, so lockSession's ordering — live first — is
    // what decides where the answer goes, and it is load-bearing rather than
    // cosmetic.
    await withFixture(async (fix) => {
      const chatId = "700002005";

      // The first trip, taken all the way to confirmed through the real path
      // so the row has the shape the schema actually requires.
      const firstIssued = await issueEnrollment(fix.pool, fix.userId, fix.tripId, { enrollmentTtlSeconds: 3600 });
      assert.ok(firstIssued.ok);
      const firstStarted = await startFromDeepLink(fix.pool, chatId, firstIssued.token);
      assert.equal(firstStarted.kind, "started");
      const firstSessionId = firstStarted.kind === "started" ? firstStarted.sessionId : "";
      await fix.pool.query(
        `UPDATE control_plane.intake_sessions
         SET state = 'confirmed', updated_at = now() - interval '1 day'
         WHERE id = $1`,
        [firstSessionId],
      );

      // A second trip — a new interview is for a new trip, not a rerun of the
      // confirmed one.
      const secondTripId = testId("trip");
      await fix.pool.query(
        "INSERT INTO control_plane.trips(id, slug, lifecycle_state) VALUES ($1, $2, 'draft')",
        [secondTripId, secondTripId.replace(/_/g, "-")],
      );
      await fix.pool.query(
        "INSERT INTO control_plane.trip_memberships(id, trip_id, user_id, role, status) VALUES ($1, $2, $3, 'owner', 'active')",
        [testId("memb"), secondTripId, fix.userId],
      );

      const secondIssued = await issueEnrollment(fix.pool, fix.userId, secondTripId, { enrollmentTtlSeconds: 3600 });
      assert.ok(secondIssued.ok);
      const secondStarted = await startFromDeepLink(fix.pool, chatId, secondIssued.token);
      assert.equal(secondStarted.kind, "started", "a confirmed session does not block a new one");

      const result = await submitAnswerForChat(fix.pool, chatId, "trip_type", "couple");
      assert.ok(result.ok);
      assert.equal(
        result.ok && result.view.sessionId,
        secondStarted.kind === "started" ? secondStarted.sessionId : "",
        "the LIVE session, not the old confirmed one",
      );
      assert.equal(result.ok && result.view.tripId, secondTripId);
    });
  });
});

describe("the companion arriving in a group", { skip: SKIP }, () => {
  const joinUpdate = (chatId: string, status = "member", botId = "8463178587") => ({
    update_id: 90,
    my_chat_member: {
      chat: { id: chatId, type: "supergroup" },
      from: { id: 77, is_bot: false, first_name: "Dror" },
      old_chat_member: { user: { id: Number(botId), is_bot: true }, status: "left" },
      new_chat_member: { user: { id: Number(botId), is_bot: true }, status },
    },
  }) as never;

  test("introduces itself in a group that is bound to a trip", async () => {
    await withFixture(async (fix) => {
      const chatId = "-1002000777";
      await fix.pool.query(
        `INSERT INTO control_plane.telegram_chat_bindings(id, chat_id, trip_id, hermes_profile)
         VALUES ('tcb_' || md5(random()::text), $1, $2, 'companion-japan')`,
        [chatId, fix.tripId],
      );
      await fix.pool.query(
        `UPDATE control_plane.trips SET companion_intro = $2::jsonb WHERE id = $1`,
        [fix.tripId, JSON.stringify({
          assistant_name: "Rio",
          trip_title: "Japan 2026",
          private_url: "https://japan-2026.example",
          language: "en",
          login_password: "seed-pw",
          proactive: { morning_briefing: "07:30" },
        })],
      );

      const decision = await dispatchUpdate(
        fix.pool, joinUpdate(chatId), undefined, undefined, { id: "8463178587", username: "Kinerary_bot" },
      );
      assert.equal(decision.kind, "group_intro");
      if (decision.kind !== "group_intro") return;
      assert.equal(decision.chatId, chatId);
      assert.match(decision.text, /Rio/);
      assert.match(decision.text, /https:\/\/japan-2026\.example/);
      assert.match(decision.text, /seed-pw/);
      assert.match(decision.text, /07:30/);
      // It is already in the group; offering an add-to-group link would be absurd.
      assert.doesNotMatch(decision.text, /startgroup/);
      // Reported live, 2026-09-14: this call site read companion_intro but never
      // passed botUsername or login_usernames through to groupIntroText, so the
      // real message silently lost the @mention trigger and fell back to the
      // "log in with your name" line even though per-person usernames existed.
      assert.match(decision.text, /@Kinerary_bot/);
    });
  });

  test("the group message names botUsername and every traveller's login, not just the password", async () => {
    // Same gap as above, the OTHER call site: a `/group <token>` command
    // posted in a not-yet-bound group, which is the path a real organizer
    // actually uses (they add the bot, then paste the token). No test at all
    // exercised this rendering before; companionIntroFacts's data was correct,
    // dispatch.ts's group_bound branch just never read botUsername/
    // login_usernames off it.
    await withFixture(async (fix) => {
      const chatId = "-1002000999";
      await fix.pool.query(
        `UPDATE control_plane.trips SET companion_intro = $2::jsonb WHERE id = $1`,
        [fix.tripId, JSON.stringify({
          assistant_name: "Rio",
          trip_title: "Japan 2026",
          private_url: "https://japan-2026.example",
          language: "en",
          login_password: "seed-pw",
          login_usernames: [{ name: "Dana", username: "dana" }, { name: "Omri", username: "omri" }],
        })],
      );
      const issued = await issueGroupBindingToken(fix.pool, fix.tripId, "77", { ttlSeconds: 3600 });
      assert.equal(issued.ok, true);
      if (!issued.ok) return;
      const tokenMessage = {
        update_id: 92,
        message: {
          message_id: 8,
          chat: { id: chatId, type: "supergroup" },
          from: { id: 77, is_bot: false, first_name: "Dror" },
          text: `/group ${issued.token}`,
        },
      } as never;

      const decision = await dispatchUpdate(
        fix.pool, tokenMessage, undefined, undefined, { id: "8463178587", username: "Kinerary_bot" },
      );
      assert.equal(decision.kind, "group_intro");
      if (decision.kind !== "group_intro") return;
      assert.match(decision.text, /@Kinerary_bot/);
      assert.match(decision.text, /Dana .+ dana/);
      assert.match(decision.text, /Omri .+ omri/);
    });
  });

  test("a group code pasted in the organizer's own chat says where it goes", { skip: SKIP }, async () => {
    // Dror, 2026-09-18. Pasted as bare text it was not a command, so it fell
    // through to routing and reached the COMPANION, which answered it as
    // conversation — "I gave it invalid token and got a greeting, it should
    // have said unknown". With `/group` in front it hit the issuance branch,
    // whose argument is ignored, and minted a NEW token: a wrong code produced
    // a working one, and a right code was silently replaced.
    await withFixture(async (fix) => {
      const dm = "700000901";
      await bindCompanion(fix, dm, "companion-japan");
      const issued = await issueGroupBindingToken(fix.pool, fix.tripId, "777", { ttlSeconds: 3600 });
      assert.equal(issued.ok, true);
      if (!issued.ok) return;

      // Their own live code, both ways it gets typed. Neither mints anything.
      for (const text of [issued.token, `/group ${issued.token}`]) {
        const decision = await dispatchUpdate(fix.pool, msg(dm, text));
        assert.equal(
          decision.kind === "reply" && decision.reply.text,
          DEFAULT_STRINGS.groupTokenBelongsInGroup,
          `${text} must be told where it belongs`,
        );
      }

      // A code we never issued is refused, not greeted and not answered by the
      // assistant — the same flat sentence a group would give.
      for (const text of ["KIN-ZZZZZZZZ", "/group KIN-ZZZZZZZZ"]) {
        const decision = await dispatchUpdate(fix.pool, msg(dm, text));
        assert.equal(
          decision.kind === "reply" && decision.reply.text,
          DEFAULT_STRINGS.groupTokenRefused,
          `${text} must be refused`,
        );
      }

      // And a bare /group still issues one — that is what it is for.
      const bare = await dispatchUpdate(fix.pool, msg(dm, "/group"));
      assert.equal(bare.kind, "group_intro", "a bare /group still hands over a code");
    });
  });

  test("the password can be withheld from the group by one option", async () => {
    await withFixture(async (fix) => {
      const chatId = "-1002000888";
      await fix.pool.query(
        `INSERT INTO control_plane.telegram_chat_bindings(id, chat_id, trip_id, hermes_profile)
         VALUES ('tcb_' || md5(random()::text), $1, $2, 'companion-japan')`,
        [chatId, fix.tripId],
      );
      await fix.pool.query(
        `UPDATE control_plane.trips SET companion_intro = $2::jsonb WHERE id = $1`,
        [fix.tripId, JSON.stringify({
          assistant_name: "Rio", private_url: "https://japan-2026.example",
          language: "en", login_password: "seed-pw", organizer: "Dror",
        })],
      );

      const decision = await dispatchUpdate(
        fix.pool, joinUpdate(chatId), undefined, undefined, { id: "8463178587" },
        { groupIntroIncludesPassword: false },
      );
      assert.equal(decision.kind, "group_intro");
      if (decision.kind !== "group_intro") return;
      assert.doesNotMatch(decision.text, /seed-pw/);
      assert.match(decision.text, /Dror/);
    });
  });

  test("an unbound group is told so, not left in silence", async () => {
    // People just invited it into a room. Saying nothing reads as broken.
    await withFixture(async (fix) => {
      const decision = await dispatchUpdate(
        fix.pool, joinUpdate("-1002000999"), undefined, undefined, { id: "8463178587" },
      );
      assert.equal(decision.kind, "reply");
    });
  });

  test("a promotion to admin is not a second arrival", async () => {
    // Re-introducing on every permissions change would be noise in a live
    // family group.
    await withFixture(async (fix) => {
      const chatId = "-1002000111";
      await fix.pool.query(
        `INSERT INTO control_plane.telegram_chat_bindings(id, chat_id, trip_id, hermes_profile)
         VALUES ('tcb_' || md5(random()::text), $1, $2, 'companion-japan')`,
        [chatId, fix.tripId],
      );
      const promoted = {
        update_id: 91,
        my_chat_member: {
          chat: { id: chatId, type: "supergroup" },
          old_chat_member: { user: { id: 8463178587, is_bot: true }, status: "member" },
          new_chat_member: { user: { id: 8463178587, is_bot: true }, status: "administrator" },
        },
      } as never;
      const decision = await dispatchUpdate(
        fix.pool, promoted, undefined, undefined, { id: "8463178587" },
      );
      assert.notEqual(decision.kind, "group_intro");
    });
  });

  test("a trip with no stored intro facts stays quiet rather than inventing a name", async () => {
    await withFixture(async (fix) => {
      const chatId = "-1002000222";
      await fix.pool.query(
        `INSERT INTO control_plane.telegram_chat_bindings(id, chat_id, trip_id, hermes_profile)
         VALUES ('tcb_' || md5(random()::text), $1, $2, 'companion-japan')`,
        [chatId, fix.tripId],
      );
      const decision = await dispatchUpdate(
        fix.pool, joinUpdate(chatId), undefined, undefined, { id: "8463178587" },
      );
      assert.equal(decision.kind, "ignore");
    });
  });
});

describe("companion reply-capture through dispatchUpdate (migration 0053)", { skip: SKIP }, () => {
  test("an open window lets the very next unaddressed group message through, once", async () => {
    await withFixture(async (fix) => {
      const chatId = "-1002001000";
      await bindCompanion(fix, chatId, "companion-japan");
      await setCompanionExpectsReply(fix.pool, chatId, true);

      const first = await dispatchUpdate(fix.pool, msg(chatId, "Friday works for us", "group"));
      assert.equal(first.kind, "to_gateway", "the window captures the very next message, whoever sends it");

      const second = await dispatchUpdate(fix.pool, msg(chatId, "anyway, who's driving?", "group"));
      assert.deepEqual(
        second,
        { kind: "ignore", reason: "NOT_ADDRESSED" },
        "one-shot: the window was already spent by the first message",
      );
    });
  });

  test("an unaddressed group message with no open window is ignored, as today", async () => {
    await withFixture(async (fix) => {
      const chatId = "-1002001001";
      await bindCompanion(fix, chatId, "companion-japan");
      const decision = await dispatchUpdate(fix.pool, msg(chatId, "just chatting amongst ourselves", "group"));
      assert.deepEqual(decision, { kind: "ignore", reason: "NOT_ADDRESSED" });
    });
  });

  test("a window past its floor lapses instead of capturing", async () => {
    await withFixture(async (fix) => {
      const chatId = "-1002001002";
      await bindCompanion(fix, chatId, "companion-japan");
      await fix.pool.query(
        `UPDATE control_plane.telegram_chat_bindings
            SET awaiting_reply_since = now() - interval '1 hour', awaiting_reply_floor_seconds = 150
          WHERE chat_id = $1`,
        [chatId],
      );
      const decision = await dispatchUpdate(fix.pool, msg(chatId, "Friday works", "group"));
      assert.deepEqual(decision, { kind: "ignore", reason: "NOT_ADDRESSED" });
    });
  });

  test("a per-trip opt-out defeats capture even with a fresh window", async () => {
    await withFixture(async (fix) => {
      const chatId = "-1002001003";
      await bindCompanion(fix, chatId, "companion-japan");
      await fix.pool.query(
        "UPDATE control_plane.trips SET companion_reply_capture_enabled = false WHERE id = $1",
        [fix.tripId],
      );
      await setCompanionExpectsReply(fix.pool, chatId, true);
      const decision = await dispatchUpdate(fix.pool, msg(chatId, "Friday works", "group"));
      assert.deepEqual(decision, { kind: "ignore", reason: "NOT_ADDRESSED" });
    });
  });

  test("an @mention still addresses the assistant normally, independent of any window", async () => {
    // Guards against the new `capturedAsReply ||` short-circuit having broken
    // the ordinary gate it sits beside.
    await withFixture(async (fix) => {
      const chatId = "-1002001004";
      await bindCompanion(fix, chatId, "companion-japan");
      const decision = await dispatchUpdate(
        fix.pool,
        msg(chatId, "@kinerary_bot what time is our flight?", "group"),
        DEFAULT_STRINGS,
        () => {},
        { id: "8463178587", username: "kinerary_bot" },
      );
      assert.equal(decision.kind, "to_gateway");
    });
  });
});

describe("the agent answering in the wrong language", () => {
  test("Hebrew interview, Hebrew agent text — kept", () => {
    assert.equal(agentTextIsInLanguage("רשמתי, ממשיכים", "he"), true);
  });

  test("Hebrew interview, all-English agent text — rejected", () => {
    // Run 15: "some of the messages from the bot came in English", in an
    // interview held entirely in Hebrew, after a rate-limit swapped the model
    // mid-conversation. The router's own copy is fully localised, so falling
    // back to it beats passing through a sentence the organizer cannot read.
    assert.equal(agentTextIsInLanguage("Got it — what pace suits you?", "he"), false);
  });

  test("a Hebrew sentence carrying English words is still Hebrew", () => {
    // Place names, confirmation numbers and the odd English word are normal.
    // The test is whether ANY Hebrew is present, not whether all of it is.
    assert.equal(agentTextIsInLanguage("רשמתי את OMO3 Asakusa ל-19/9", "he"), true);
  });

  test("an English interview is never second-guessed", () => {
    // The reverse direction is not checked: Hebrew inside an English interview
    // is far more likely to be a traveller's name than a language slip.
    assert.equal(agentTextIsInLanguage("משפחת סולומון is confirmed", "en"), true);
    assert.equal(agentTextIsInLanguage("plain english", "en"), true);
  });

  test("empty text is not a language failure", () => {
    assert.equal(agentTextIsInLanguage("", "he"), true);
    assert.equal(agentTextIsInLanguage("   ", "he"), true);
  });
});

/**
 * Overheard group context (R11) — and what it must NOT touch.
 *
 * The rule, stated by Dror on 2026-09-20 and asserted here so it cannot drift:
 *
 *   - explicitly addressed            -> respond, exactly as today
 *   - not addressed                   -> DO NOT respond; retain as context
 *   - later explicitly addressed      -> respond, with the retained context
 *   - the reply-capture window (#122) -> the ONE separate exception where an
 *                                        unaddressed message is still routed
 *
 * The danger this block exists to catch is a subtle one: that holding a
 * message for context quietly becomes a reason to answer it. Every test here
 * pairs "what was retained" with "what the gate decided", because the second
 * is the part that must not move.
 */
describe("overheard group context (R11)", { skip: SKIP }, () => {
  const NAMED = ["פאם", "Pam"];

  async function bindNamedCompanion(fix: Fixture, chatId: string): Promise<void> {
    await bindCompanion(fix, chatId, "companion-japan");
    await fix.pool.query(
      "UPDATE control_plane.trips SET assistant_names = $2 WHERE id = $1",
      [fix.tripId, NAMED],
    );
  }

  test("an unaddressed group message is still NOT answered — it is only remembered", async () => {
    await withFixture(async (fix) => {
      const chatId = "-1002100000";
      await bindNamedCompanion(fix, chatId);
      const ctx = new GroupContext();

      const decision = await dispatchUpdate(
        fix.pool, msg(chatId, "אני חושבת שעדיף יומיים בהוי אן", "group"),
        undefined, undefined, {}, { groupContext: ctx },
      );

      assert.deepEqual(decision, { kind: "ignore", reason: "NOT_ADDRESSED" },
        "retaining context must never become a reason to answer");
      assert.equal(ctx.take(chatId).length, 1, "and it was retained");
    });
  });

  test("being named still routes, and carries what was overheard since", async () => {
    await withFixture(async (fix) => {
      const chatId = "-1002100001";
      await bindNamedCompanion(fix, chatId);
      const ctx = new GroupContext();

      await dispatchUpdate(fix.pool, msg(chatId, "אני רוצה יום חופש בים", "group"),
        undefined, undefined, {}, { groupContext: ctx });
      const decision = await dispatchUpdate(fix.pool, msg(chatId, "פאם, מה דעתך?", "group"),
        undefined, undefined, {}, { groupContext: ctx });

      assert.equal(decision.kind, "to_gateway", "naming it routes, exactly as before");
      const text = JSON.stringify(decision);
      assert.ok(text.includes("יום חופש בים"), "the overheard turn rode along");
      assert.ok(text.includes("מה דעתך"), "and so did what was actually said to it");
    });
  });

  test("a @mention routes with the same context, by the same rule", async () => {
    await withFixture(async (fix) => {
      const chatId = "-1002100002";
      await bindNamedCompanion(fix, chatId);
      const ctx = new GroupContext();

      await dispatchUpdate(fix.pool, msg(chatId, "מישהו בדק מחירים?", "group"),
        undefined, undefined, {}, { groupContext: ctx });
      const decision = await dispatchUpdate(
        fix.pool, msg(chatId, "@Kinerary_bot what do you think?", "group"),
        undefined, undefined, { username: "Kinerary_bot" }, { groupContext: ctx },
      );

      assert.equal(decision.kind, "to_gateway");
      assert.ok(JSON.stringify(decision).includes("מחירים"), "the overheard turn rode along");
    });
  });

  test("the context is spent once, not attached to every later question", async () => {
    await withFixture(async (fix) => {
      const chatId = "-1002100003";
      await bindNamedCompanion(fix, chatId);
      const ctx = new GroupContext();

      await dispatchUpdate(fix.pool, msg(chatId, "נועם רוצה מסעדה צמחונית", "group"),
        undefined, undefined, {}, { groupContext: ctx });
      const first = await dispatchUpdate(fix.pool, msg(chatId, "פאם, יש רעיון?", "group"),
        undefined, undefined, {}, { groupContext: ctx });
      const second = await dispatchUpdate(fix.pool, msg(chatId, "פאם, ומה עם מחר?", "group"),
        undefined, undefined, {}, { groupContext: ctx });

      assert.ok(JSON.stringify(first).includes("צמחונית"));
      assert.ok(!JSON.stringify(second).includes("צמחונית"),
        "the same small talk must not follow every question for the rest of the trip");
    });
  });

  test("a DM is untouched: nothing is retained and nothing is prefixed", async () => {
    await withFixture(async (fix) => {
      const chatId = "998877";
      await bindNamedCompanion(fix, chatId);
      const ctx = new GroupContext();

      const decision = await dispatchUpdate(fix.pool, msg(chatId, "מה התוכנית למחר?"),
        undefined, undefined, {}, { groupContext: ctx });

      assert.equal(decision.kind, "to_gateway", "a DM is addressed by construction");
      assert.ok(!JSON.stringify(decision).includes("overheard"),
        "a DM has no unaddressed traffic, so it must gain no banner");
      assert.equal(ctx.take(chatId).length, 0);
    });
  });

  test("with no context to carry, an addressed message is byte-for-byte what it was", async () => {
    // The regression that would be easiest to ship unnoticed: a banner, or an
    // empty fence, on every message in a quiet group.
    await withFixture(async (fix) => {
      const chatId = "-1002100004";
      await bindNamedCompanion(fix, chatId);

      const withCtx = await dispatchUpdate(fix.pool, msg(chatId, "פאם, מה השעה?", "group"),
        undefined, undefined, {}, { groupContext: new GroupContext() });
      const without = await dispatchUpdate(fix.pool, msg(chatId, "פאם, מה השעה?", "group"));

      assert.equal(withCtx.kind, "to_gateway");
      assert.deepEqual(
        (withCtx as { event?: { text?: string } }).event?.text,
        (without as { event?: { text?: string } }).event?.text,
        "no context means no change at all",
      );
    });
  });

  test("the reply-capture window stays the ONE exception, and does not become two", async () => {
    // #122's window is the only path by which an unaddressed message is
    // answered. R11 must not create a second one, and must not disable this.
    await withFixture(async (fix) => {
      const chatId = "-1002100005";
      await bindNamedCompanion(fix, chatId);
      await setCompanionExpectsReply(fix.pool, chatId, true);
      const ctx = new GroupContext();

      const captured = await dispatchUpdate(fix.pool, msg(chatId, "יום שישי מתאים לנו", "group"),
        undefined, undefined, {}, { groupContext: ctx });
      assert.equal(captured.kind, "to_gateway", "the open window still captures, as before");

      const next = await dispatchUpdate(fix.pool, msg(chatId, "ומי נוהג?", "group"),
        undefined, undefined, {}, { groupContext: ctx });
      assert.deepEqual(next, { kind: "ignore", reason: "NOT_ADDRESSED" },
        "one-shot still means one-shot — context does not extend it");
      assert.equal(ctx.take(chatId).length, 1, "the ignored one was retained instead");
    });
  });
});
