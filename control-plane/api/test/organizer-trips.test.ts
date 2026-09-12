/**
 * /trips and /switch — the two questions a shared bot otherwise cannot answer.
 *
 * The assertions here are chosen for what their ABSENCE would allow, not for
 * coverage: every one of them is a way one organizer could have been shown, or
 * handed, another organizer's trip.
 */
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { readFile } from "node:fs/promises";
import { after, describe, test } from "node:test";
import { fileURLToPath } from "node:url";
import pg from "pg";
import { applyMigrations } from "../src/migrations.js";
import { issueEnrollment } from "../src/enrollment.js";
import { startFromDeepLink, switchCallbackData, parseCallbackData, parseInbound } from "../src/chat-router.js";
import { dispatchUpdate, DEFAULT_STRINGS } from "../src/relay/dispatch.js";
import { listOrganizerTrips, switchChatToTrip } from "../src/organizer-trips.js";
import { digestTelegramId } from "../src/identity.js";
import { uiString } from "../src/intake-copy.js";
import type { TelegramUpdate } from "../src/relay/normalize.js";
import { testDatabaseUrl } from "./support/test-database.js";
import { publishCommandMenu } from "../src/relay/command-menu.js";
import type { TelegramClient } from "../src/relay/telegram-api.js";

const databaseUrl = testDatabaseUrl();
const SKIP = !databaseUrl;
const migrationsDir = fileURLToPath(new URL("../../db/migrations/", import.meta.url));

function testId(prefix: string): string {
  return `${prefix}_${randomBytes(16).toString("hex")}`;
}

/** Dror's chat in the live deployment; a private chat id IS the person's id. */
const ORGANIZER_CHAT = "391627336";
const OTHER_CHAT = "884422113";

interface Fixture {
  pool: pg.Pool;
  /** Two trips owned by the SAME telegram person through two different user_ids. */
  italyId: string;
  japanId: string;
  /** A third trip belonging to somebody else entirely. */
  strangerTripId: string;
}

/**
 * One schema, one pool, for the whole file.
 *
 * The sibling suites rebuild the schema per test — DROP SCHEMA plus every
 * migration, thirteen times over in this file. That is seconds of pure setup
 * per suite, and it is what pushed `interview-transcript` past its 60s
 * per-test timeout when this file was added to the run. Isolation here comes
 * from truncating between tests instead, which buys the same guarantee for a
 * fraction of the cost.
 */
let schemaReady: Promise<pg.Pool> | null = null;

function migratedPool(): Promise<pg.Pool> {
  schemaReady ??= (async () => {
    const pool = new pg.Pool({ connectionString: databaseUrl });
    const client = await pool.connect();
    try {
      await client.query("DROP SCHEMA IF EXISTS control_plane CASCADE");
      await client.query("DROP TABLE IF EXISTS public.control_plane_schema_migrations");
      await applyMigrations(client, migrationsDir);
    } finally {
      client.release();
    }
    return pool;
  })();
  return schemaReady;
}

after(async () => {
  if (schemaReady) await (await schemaReady).end();
});

/**
 * Reproduces the shape the live database is actually in: one physical
 * organizer owning several trips through several user_ids, because each test
 * signup used a differently plus-addressed email. A fixture with one user per
 * person would pass while the real deployment failed.
 */
async function withFixture(fn: (fix: Fixture) => Promise<void>): Promise<void> {
  const pool = await migratedPool();
  // CASCADE reaches every table with a path back to these two, so a new
  // dependent table added later is cleaned without this list being updated —
  // the failure mode of an explicit list is a test that passes on residue.
  await pool.query("TRUNCATE control_plane.users, control_plane.trips CASCADE");
  {
    const make = async (slug: string, state: string, chat: string | null) => {
      const userId = testId("user");
      const tripId = testId("trip");
      await pool.query("INSERT INTO control_plane.users(id, status, display_name) VALUES ($1,'active',$2)", [userId, slug]);
      await pool.query("INSERT INTO control_plane.trips(id, slug, lifecycle_state, title) VALUES ($1,$2,$3,$4)", [tripId, slug, state, slug]);
      await pool.query(
        "INSERT INTO control_plane.trip_memberships(id, trip_id, user_id, role, status) VALUES ($1,$2,$3,'owner','active')",
        [testId("memb"), tripId, userId],
      );
      if (chat) {
        await pool.query(
          `INSERT INTO control_plane.telegram_organizer_links(id, user_id, telegram_subject_digest, verified_via)
           VALUES ($1,$2,$3,'enrollment_redemption')`,
          [testId("tol"), userId, digestTelegramId(chat)],
        );
      }
      return tripId;
    };

    const italyId = await make("italy-2026", "ready_private", ORGANIZER_CHAT);
    const japanId = await make("japan-2026", "active", ORGANIZER_CHAT);
    const strangerTripId = await make("stranger-2026", "active", OTHER_CHAT);

    await fn({ pool, italyId, japanId, strangerTripId });
  }
}

async function bind(pool: pg.Pool, chatId: string, tripId: string, profile: string | null): Promise<void> {
  await pool.query(
    "INSERT INTO control_plane.telegram_chat_bindings(id, chat_id, trip_id, hermes_profile) VALUES ($1,$2,$3,$4)",
    [testId("tcb"), chatId, tripId, profile],
  );
}

/** A consumed enrollment, because intake_sessions may not exist without one. */
async function consumedEnrollment(pool: pg.Pool, tripId: string, userId: string): Promise<string> {
  const id = testId("enr");
  await pool.query(
    `INSERT INTO control_plane.interview_enrollments(id, trip_id, user_id, token_digest, state, expires_at, consumed_at)
     VALUES ($1,$2,$3,$4,'consumed', now() + interval '1 hour', now())`,
    [id, tripId, userId, `sha256:${randomBytes(32).toString("hex")}`],
  );
  return id;
}

function msg(chatId: string, text: string, chatType = "private", fromId = chatId): TelegramUpdate {
  return {
    update_id: 1,
    message: {
      message_id: 7,
      from: { id: fromId, first_name: "Dror" },
      chat: { id: chatId, type: chatType },
      text,
    },
  };
}

function tap(chatId: string, data: string, fromId = chatId): TelegramUpdate {
  return {
    update_id: 2,
    callback_query: {
      id: "cbq_1",
      data,
      from: { id: fromId, first_name: "Dror" },
      message: { message_id: 9, chat: { id: chatId, type: "private" } },
    },
  };
}

async function openBinding(pool: pg.Pool, chatId: string): Promise<string | null> {
  const { rows } = await pool.query<{ trip_id: string }>(
    "SELECT trip_id FROM control_plane.telegram_chat_bindings WHERE chat_id = $1 AND closed_at IS NULL",
    [chatId],
  );
  return rows[0]?.trip_id ?? null;
}

describe("the command parser carries an argument", () => {
  test("a command's trailing text survives, because /switch needs it", () => {
    assert.deepEqual(parseInbound("/switch italy-2026"), {
      kind: "command", name: "switch", argument: "italy-2026",
    });
    assert.deepEqual(parseInbound("/switch@kinerary_bot  italy-2026 "), {
      kind: "command", name: "switch", argument: "italy-2026",
    });
    assert.deepEqual(parseInbound("/trips"), { kind: "command", name: "trips", argument: null });
  });

  test("a switch tap parses, and is not confused with an interview button", () => {
    const tripId = "trip_1e35d697ca5dfd1b2a95d32181b8fc18";
    assert.deepEqual(parseCallbackData(switchCallbackData(tripId)), { kind: "switch", tripId });
    // The interview vocabulary is untouched by the new prefix.
    assert.deepEqual(parseCallbackData("a:trip_type:family"), {
      kind: "answer", questionId: "trip_type", optionId: "family",
    });
    // Not a trip id: refused rather than half-parsed.
    assert.deepEqual(parseCallbackData("s:not_a_trip"), { kind: "unknown" });
  });
});

describe("/trips (DB)", { skip: SKIP }, () => {
  test("lists every trip this Telegram person owns, across all their user_ids", async () => {
    await withFixture(async ({ pool, italyId, japanId }) => {
      await bind(pool, ORGANIZER_CHAT, japanId, "japan2026");

      const trips = await listOrganizerTrips(pool, ORGANIZER_CHAT, ORGANIZER_CHAT);
      assert.deepEqual(
        trips.map((t) => t.slug).sort(),
        ["italy-2026", "japan-2026"],
        "both trips, though they hang off two different user_ids",
      );

      // The whole point of the command: which one is this chat on?
      assert.equal(trips.find((t) => t.tripId === japanId)?.current, true);
      assert.equal(trips.find((t) => t.tripId === italyId)?.current, false);
    });
  });

  test("never lists a trip belonging to somebody else", async () => {
    await withFixture(async ({ pool, strangerTripId }) => {
      const trips = await listOrganizerTrips(pool, ORGANIZER_CHAT, ORGANIZER_CHAT);
      assert.equal(trips.some((t) => t.tripId === strangerTripId), false);
    });
  });

  test("a sender with no identity row is answered exactly like one with no trips", async () => {
    await withFixture(async ({ pool }) => {
      // Nothing has ever linked this Telegram id to a user.
      const unknown = await dispatchUpdate(pool, msg("505050505", "/trips"), DEFAULT_STRINGS);
      // A linked person whose trips are all gone.
      await pool.query("DELETE FROM control_plane.trip_memberships");
      const emptied = await dispatchUpdate(pool, msg(ORGANIZER_CHAT, "/trips"), DEFAULT_STRINGS);

      assert.equal(unknown.kind, "reply");
      assert.equal(emptied.kind, "reply");
      assert.equal(
        unknown.kind === "reply" ? unknown.reply.text : "",
        emptied.kind === "reply" ? emptied.reply.text : "",
        "a distinguishable answer would tell a stranger whether an account exists",
      );
    });
  });

  test("refuses to list in a group, where the room has no claim to the answer", async () => {
    await withFixture(async ({ pool, japanId }) => {
      await bind(pool, "-1004305582269", japanId, "japan2026");
      const decision = await dispatchUpdate(pool, msg("-1004305582269", "/trips", "supergroup", ORGANIZER_CHAT), DEFAULT_STRINGS);
      assert.equal(decision.kind, "reply");
      assert.equal(decision.kind === "reply" && decision.reply.text, uiString("tripsInGroup", "en"));
    });
  });

  test("answers in the organizer's language, not in DEFAULT_STRINGS' English", async () => {
    await withFixture(async ({ pool, japanId }) => {
      const { rows } = await pool.query<{ user_id: string }>(
        "SELECT user_id FROM control_plane.trip_memberships WHERE trip_id = $1", [japanId]);
      const enrollmentId = await consumedEnrollment(pool, japanId, rows[0]?.user_id ?? "");
      // The interview recorded what the organizer actually wrote.
      await pool.query(
        `INSERT INTO control_plane.intake_sessions(id, trip_id, user_id, enrollment_id, session_token_digest, state, answers, telegram_chat_id, language)
         VALUES ($1,$2,$3,$4,$5,'confirmed','{}'::jsonb,$6,'he')`,
        [testId("sess"), japanId, rows[0]?.user_id, enrollmentId, `sha256:${"b".repeat(64)}`, ORGANIZER_CHAT],
      );
      await bind(pool, ORGANIZER_CHAT, japanId, "japan2026");

      const listed = await dispatchUpdate(pool, msg(ORGANIZER_CHAT, "/trips"), DEFAULT_STRINGS);
      assert.equal(listed.kind, "reply");
      if (listed.kind !== "reply") return;
      assert.match(listed.reply.text, /[\u0590-\u05FF]/, "a Hebrew interview must not get an English list");
      assert.equal(listed.reply.text.includes(uiString("tripsHeader", "he")), true);

      // And so does a refusal — the path most likely to be left in English.
      const refused = await dispatchUpdate(pool, msg(ORGANIZER_CHAT, "/switch nowhere-9999"), DEFAULT_STRINGS);
      assert.equal(refused.kind === "reply" && refused.reply.text, uiString("switchRefused", "he"));
    });
  });

  test("marks the current trip and offers the rest as buttons", async () => {
    await withFixture(async ({ pool, italyId, japanId }) => {
      await bind(pool, ORGANIZER_CHAT, japanId, "japan2026");
      const decision = await dispatchUpdate(pool, msg(ORGANIZER_CHAT, "/trips"), DEFAULT_STRINGS);
      assert.equal(decision.kind, "reply");
      if (decision.kind !== "reply") return;

      assert.match(decision.reply.text, /japan-2026/);
      assert.match(decision.reply.text, /italy-2026/);
      assert.match(decision.reply.text, /← this chat/);
      // The site is up, so the organizer is told that in words they recognise.
      assert.match(decision.reply.text, /site ready/);
      assert.doesNotMatch(decision.reply.text, /ready_private/, "the raw enum is not organizer-facing");

      const data = decision.reply.replyMarkup?.inline_keyboard.flat().map((b) => b.callback_data);
      assert.deepEqual(data?.sort(), [switchCallbackData(italyId), switchCallbackData(japanId)].sort());
    });
  });
});

describe("/switch (DB)", { skip: SKIP }, () => {
  test("moves this chat, and CLOSES the old binding rather than overwriting it", async () => {
    await withFixture(async ({ pool, italyId, japanId }) => {
      await bind(pool, ORGANIZER_CHAT, japanId, "japan2026");

      const outcome = await switchChatToTrip(pool, ORGANIZER_CHAT, ORGANIZER_CHAT, italyId);
      assert.equal(outcome.kind, "switched");
      assert.equal(await openBinding(pool, ORGANIZER_CHAT), italyId);

      // Migration 0029's entire point: the history stays readable, and says why.
      const { rows } = await pool.query<{ trip_id: string; closed_reason: string | null }>(
        "SELECT trip_id, closed_reason FROM control_plane.telegram_chat_bindings WHERE chat_id = $1 AND closed_at IS NOT NULL",
        [ORGANIZER_CHAT],
      );
      assert.equal(rows.length, 1);
      assert.equal(rows[0]?.trip_id, japanId, "the previous binding is still there to read");
      assert.equal(rows[0]?.closed_reason, "organizer_switch");
    });
  });

  test("a trip that is not yours and a trip that does not exist get the SAME sentence", async () => {
    await withFixture(async ({ pool, strangerTripId }) => {
      const notMine = await switchChatToTrip(pool, ORGANIZER_CHAT, ORGANIZER_CHAT, strangerTripId);
      const noSuch = await switchChatToTrip(pool, ORGANIZER_CHAT, ORGANIZER_CHAT, testId("trip"));
      assert.deepEqual(notMine, { kind: "refused", reason: "NOT_YOURS" });
      assert.deepEqual(noSuch, { kind: "refused", reason: "NOT_YOURS" });

      const typed = await dispatchUpdate(pool, msg(ORGANIZER_CHAT, "/switch stranger-2026"), DEFAULT_STRINGS);
      const invented = await dispatchUpdate(pool, msg(ORGANIZER_CHAT, "/switch nowhere-9999"), DEFAULT_STRINGS);
      assert.equal(
        typed.kind === "reply" ? typed.reply.text : "x",
        invented.kind === "reply" ? invented.reply.text : "y",
      );
      assert.equal(await openBinding(pool, ORGANIZER_CHAT), null, "nothing was bound by a refused switch");
    });
  });

  test("a tapped button from someone else's list is re-checked and refused", async () => {
    await withFixture(async ({ pool, japanId, strangerTripId }) => {
      await bind(pool, ORGANIZER_CHAT, japanId, "japan2026");
      // A forged/replayed payload naming a real trip the tapper does not own.
      const decision = await dispatchUpdate(pool, tap(ORGANIZER_CHAT, switchCallbackData(strangerTripId)), DEFAULT_STRINGS);

      assert.equal(decision.kind, "callback_reply");
      assert.equal(decision.kind === "callback_reply" && decision.text, uiString("switchRefused", "en"));
      assert.equal(await openBinding(pool, ORGANIZER_CHAT), japanId, "the payload could not widen what the tapper may reach");
    });
  });

  test("in a group it changes nothing — neither the group's binding nor the DM's", async () => {
    await withFixture(async ({ pool, italyId, japanId }) => {
      const group = "-1004305582269";
      await bind(pool, group, japanId, "japan2026");
      await bind(pool, ORGANIZER_CHAT, japanId, "japan2026");

      const decision = await dispatchUpdate(pool, msg(group, "/switch italy-2026", "supergroup", ORGANIZER_CHAT), DEFAULT_STRINGS);
      assert.equal(decision.kind, "reply");
      assert.equal(decision.kind === "reply" && decision.reply.text, uiString("switchInGroup", "en"));

      assert.equal(await openBinding(pool, group), japanId, "the family's room did not move");
      assert.equal(await openBinding(pool, ORGANIZER_CHAT), japanId, "and neither did the DM");
      // Even called directly, past the dispatcher.
      assert.deepEqual(
        await switchChatToTrip(pool, ORGANIZER_CHAT, group, italyId),
        { kind: "refused", reason: "NOT_PRIVATE_CHAT" },
      );
    });
  });

  test("during a live interview it is refused, not silently applied", async () => {
    await withFixture(async ({ pool, italyId, japanId }) => {
      await bind(pool, ORGANIZER_CHAT, japanId, "japan2026");
      const { rows } = await pool.query<{ user_id: string }>(
        "SELECT user_id FROM control_plane.trip_memberships WHERE trip_id = $1", [italyId]);
      const enrollmentId = await consumedEnrollment(pool, italyId, rows[0]?.user_id ?? "");
      await pool.query(
        `INSERT INTO control_plane.intake_sessions(id, trip_id, user_id, enrollment_id, session_token_digest, state, answers, telegram_chat_id)
         VALUES ($1,$2,$3,$4,$5,'interviewing','{}'::jsonb,$6)`,
        [testId("sess"), italyId, rows[0]?.user_id, enrollmentId, `sha256:${"a".repeat(64)}`, ORGANIZER_CHAT],
      );

      assert.deepEqual(
        await switchChatToTrip(pool, ORGANIZER_CHAT, ORGANIZER_CHAT, italyId),
        { kind: "refused", reason: "IN_INTERVIEW" },
      );
      assert.equal(await openBinding(pool, ORGANIZER_CHAT), japanId);
    });
  });

  test("switching to the trip you are already on says so, and writes nothing", async () => {
    await withFixture(async ({ pool, japanId }) => {
      await bind(pool, ORGANIZER_CHAT, japanId, "japan2026");
      assert.deepEqual(
        await switchChatToTrip(pool, ORGANIZER_CHAT, ORGANIZER_CHAT, japanId),
        { kind: "unchanged", tripId: japanId },
      );
      const { rows } = await pool.query("SELECT 1 FROM control_plane.telegram_chat_bindings WHERE chat_id = $1", [ORGANIZER_CHAT]);
      assert.equal(rows.length, 1, "no second row, open or closed");
    });
  });

  test("carries the trip's companion, and says so plainly when there is none", async () => {
    await withFixture(async ({ pool, italyId, japanId }) => {
      // japan has a companion recorded on an older binding; italy never had one.
      await bind(pool, "-1004305582269", japanId, "japan2026");
      await bind(pool, ORGANIZER_CHAT, italyId, null);

      const toJapan = await switchChatToTrip(pool, ORGANIZER_CHAT, ORGANIZER_CHAT, japanId);
      assert.equal(toJapan.kind === "switched" && toJapan.hermesProfile, "japan2026",
        "inherited from the trip's most recent binding that had one");

      const back = await dispatchUpdate(pool, msg(ORGANIZER_CHAT, "/switch italy-2026"), DEFAULT_STRINGS);
      assert.equal(back.kind, "reply");
      if (back.kind !== "reply") return;
      // Bound anyway (migration 0043) — but the organizer is told, at the moment
      // of switching, rather than discovering it by asking a question.
      assert.equal(await openBinding(pool, ORGANIZER_CHAT), italyId);
      assert.match(back.reply.text, /still finishing this trip's assistant/);
    });
  });

  test("a typed name must match exactly; an ambiguous one falls back to the list", async () => {
    await withFixture(async ({ pool, italyId }) => {
      // A prefix must not select anything.
      const prefix = await dispatchUpdate(pool, msg(ORGANIZER_CHAT, "/switch italy"), DEFAULT_STRINGS);
      assert.equal(prefix.kind === "reply" && prefix.reply.text, uiString("switchRefused", "en"));
      assert.equal(await openBinding(pool, ORGANIZER_CHAT), null);

      // The exact slug does, and case is not the organizer's problem.
      const exact = await dispatchUpdate(pool, msg(ORGANIZER_CHAT, "/switch ITALY-2026"), DEFAULT_STRINGS);
      assert.equal(exact.kind, "reply");
      assert.equal(await openBinding(pool, ORGANIZER_CHAT), italyId);
    });
  });

  test("bare /switch draws the list rather than guessing", async () => {
    await withFixture(async ({ pool, japanId }) => {
      await bind(pool, ORGANIZER_CHAT, japanId, "japan2026");
      const decision = await dispatchUpdate(pool, msg(ORGANIZER_CHAT, "/switch"), DEFAULT_STRINGS);
      assert.equal(decision.kind, "reply");
      assert.equal(decision.kind === "reply" && Boolean(decision.reply.replyMarkup), true);
      assert.equal(await openBinding(pool, ORGANIZER_CHAT), japanId, "drawing the list changes nothing");
    });
  });
});

describe("the identity link the commands depend on (DB)", { skip: SKIP }, () => {
  test("redeeming an interview link records the Telegram person who redeemed it", async () => {
    await withFixture(async ({ pool, italyId }) => {
      const { rows } = await pool.query<{ user_id: string }>(
        "SELECT user_id FROM control_plane.trip_memberships WHERE trip_id = $1", [italyId]);
      const ownerId = rows[0]?.user_id ?? "";
      await pool.query("UPDATE control_plane.trips SET lifecycle_state = 'draft' WHERE id = $1", [italyId]);
      await pool.query("DELETE FROM control_plane.telegram_organizer_links WHERE user_id = $1", [ownerId]);

      const issued = await issueEnrollment(pool, ownerId, italyId, { enrollmentTtlSeconds: 900 });
      assert.equal(issued.ok, true);
      if (!issued.ok) return;

      const started = await startFromDeepLink(pool, "606060606", issued.token);
      assert.equal(started.kind, "started");

      const link = await pool.query<{ user_id: string; verified_via: string }>(
        "SELECT user_id, verified_via FROM control_plane.telegram_organizer_links WHERE telegram_subject_digest = $1",
        [digestTelegramId("606060606")],
      );
      assert.deepEqual(link.rows, [{ user_id: ownerId, verified_via: "enrollment_redemption" }]);
    });
  });

  test("the backfill recovers links from interviews that already happened", async () => {
    await withFixture(async ({ pool, italyId, japanId }) => {
      const owners = await pool.query<{ user_id: string; trip_id: string }>(
        "SELECT user_id, trip_id FROM control_plane.trip_memberships WHERE trip_id = ANY($1)", [[italyId, japanId]]);
      for (const row of owners.rows) {
        const enrollmentId = await consumedEnrollment(pool, row.trip_id, row.user_id);
        await pool.query(
          `INSERT INTO control_plane.intake_sessions(id, trip_id, user_id, enrollment_id, session_token_digest, state, answers, telegram_chat_id)
           VALUES ($1,$2,$3,$4,$5,'confirmed','{}'::jsonb,$6)`,
          [testId("sess"), row.trip_id, row.user_id, enrollmentId, `sha256:${randomBytes(32).toString("hex")}`, ORGANIZER_CHAT],
        );
      }
      // Erase the links and re-run the migration's OWN backfill statement, so
      // this tests the shipped SQL rather than a paraphrase of it.
      await pool.query("DELETE FROM control_plane.telegram_organizer_links");
      const sql = await readFile(`${migrationsDir}/0050_telegram_organizer_links.sql`, "utf8");
      const backfill = sql.slice(sql.lastIndexOf("INSERT INTO control_plane.telegram_organizer_links"));
      await pool.query(backfill);

      const trips = await listOrganizerTrips(pool, ORGANIZER_CHAT, ORGANIZER_CHAT);
      assert.deepEqual(trips.map((t) => t.slug).sort(), ["italy-2026", "japan-2026"]);

      // Idempotent: the migration is re-runnable and so is its backfill.
      await pool.query(backfill);
      const count = await pool.query<{ c: string }>(
        "SELECT count(*) AS c FROM control_plane.telegram_organizer_links WHERE telegram_subject_digest = $1",
        [digestTelegramId(ORGANIZER_CHAT)],
      );
      assert.equal(count.rows[0]?.c, "2");
    });
  });

  test("a group chat id is never recorded as a person", async () => {
    await withFixture(async ({ pool }) => {
      assert.deepEqual(await listOrganizerTrips(pool, "-1004305582269", "-1004305582269"), []);
    });
  });
});


describe("the ⌘ menu", () => {
  function fakeClient(setMyCommands?: TelegramClient["setMyCommands"]): TelegramClient {
    return {
      async sendMessage() { return { ok: true }; },
      async editMessageText() { return { ok: true }; },
      async sendChatAction() { /* no-op */ },
      async answerCallbackQuery() { /* no-op */ },
      async getChatInfo() { return null; },
      async getMe() { return null; },
      async getUpdates() { return []; },
      async deleteWebhookIfPresent() { /* no-op */ },
      ...(setMyCommands ? { setMyCommands } : {}),
    } as TelegramClient;
  }

  test("offers the commands in private chats only, in every language it draws", async () => {
    const calls: { commands: string[]; scope?: string; languageCode?: string }[] = [];
    const ok = await publishCommandMenu(fakeClient(async (params) => {
      calls.push({
        commands: params.commands.map((c) => c.command),
        scope: params.scope?.type,
        languageCode: params.languageCode,
      });
      return true;
    }));

    assert.equal(ok, true);
    // A default menu plus one per language.
    assert.deepEqual(calls.map((c) => c.languageCode), [undefined, "en", "he"]);
    for (const call of calls) {
      assert.equal(call.scope, "all_private_chats", "a group must not be offered /switch");
      assert.deepEqual(call.commands, ["trips", "switch", "group", "done"]);
    }
    // Telegram surfaces its own Start button; a menu entry for a command that
    // does nothing without a token is a dead end.
    assert.equal(calls.some((c) => c.commands.includes("start")), false);
  });

  test("the descriptions are actually translated, not English twice", async () => {
    const byLanguage = new Map<string, string[]>();
    await publishCommandMenu(fakeClient(async (params) => {
      if (params.languageCode) byLanguage.set(params.languageCode, params.commands.map((c) => c.description));
      return true;
    }));
    assert.notDeepEqual(byLanguage.get("he"), byLanguage.get("en"));
    assert.equal(byLanguage.get("he")?.every((d) => /[\u0590-\u05FF]/.test(d)), true);
  });

  test("a failed publish is reported, never fatal — the commands still work", async () => {
    assert.equal(await publishCommandMenu(fakeClient(async () => false)), false);
    assert.equal(
      await publishCommandMenu(fakeClient(async () => { throw new Error("network"); })),
      false,
      "a throw at boot must not cost the deployment its relay",
    );
    // A client that predates setMyCommands is a TelegramClient too.
    assert.equal(await publishCommandMenu(fakeClient()), false);
  });
});
