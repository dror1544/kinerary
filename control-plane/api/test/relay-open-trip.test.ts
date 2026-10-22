import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { describe, test } from "node:test";
import { fileURLToPath } from "node:url";
import type pg from "pg";
import { applyMigrations } from "../src/migrations.js";
import { issueEnrollment } from "../src/enrollment.js";
import { startFromDeepLink } from "../src/chat-router.js";
import { issueGroupBindingToken } from "../src/group-binding.js";
import { digestTelegramId } from "../src/identity.js";
import { uiString } from "../src/intake-copy.js";
import { applyDecision } from "../src/relay/poller.js";
import { dispatchUpdate, DEFAULT_STRINGS, type DispatchDecision } from "../src/relay/dispatch.js";
import type { TelegramUpdate } from "../src/relay/normalize.js";
import type { PinnedMessage, SendResult, TelegramClient } from "../src/relay/telegram-api.js";
import { testDatabaseUrl, testPool } from "./support/test-database.js";

const SKIP = !testDatabaseUrl();
const migrationsDir = fileURLToPath(new URL("../../db/migrations/", import.meta.url));
const BOT = { id: "8463178587", username: "Kinerary_bot" };
const ORGANIZER = "777";

const id = (prefix: string) => `${prefix}_${randomBytes(16).toString("hex")}`;

interface Fixture {
  pool: pg.Pool;
  tripId: string;
  userId: string;
}

async function withFixture(fn: (fix: Fixture) => Promise<void>): Promise<void> {
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
    const userId = id("user");
    const tripId = id("trip");
    await pool.query("INSERT INTO control_plane.users(id, status, display_name) VALUES ($1, 'active', 'Owner')", [userId]);
    await pool.query("INSERT INTO control_plane.trips(id, slug, lifecycle_state) VALUES ($1, $2, 'ready_private')", [tripId, tripId.replace(/_/g, "-")]);
    await pool.query(
      "INSERT INTO control_plane.trip_memberships(id, trip_id, user_id, role, status) VALUES ($1, $2, $3, 'owner', 'active')",
      [id("memb"), tripId, userId],
    );
    await fn({ pool, tripId, userId });
  } finally {
    await pool.end();
  }
}

async function setIntro(pool: pg.Pool, tripId: string, language: "en" | "he", names: string[] = ["Rio"]): Promise<void> {
  await pool.query(
    "UPDATE control_plane.trips SET companion_intro = $2::jsonb, assistant_names = $3 WHERE id = $1",
    [tripId, JSON.stringify({
      assistant_name: names[0] ?? "Rio", trip_title: "Japan 2026", private_url: "https://japan-2026.example",
      language, login_password: "seed-pw",
    }), names],
  );
}

async function addTrip(pool: pg.Pool, userId: string, language: "en" | "he"): Promise<string> {
  const tripId = id("trip");
  await pool.query("INSERT INTO control_plane.trips(id, slug, lifecycle_state) VALUES ($1, $2, 'ready_private')", [tripId, tripId.replace(/_/g, "-")]);
  await pool.query(
    "INSERT INTO control_plane.trip_memberships(id, trip_id, user_id, role, status) VALUES ($1, $2, $3, 'owner', 'active')",
    [id("memb"), tripId, userId],
  );
  await setIntro(pool, tripId, language);
  return tripId;
}

async function bind(pool: pg.Pool, chatId: string, tripId: string): Promise<void> {
  await pool.query(
    "INSERT INTO control_plane.telegram_chat_bindings(id, chat_id, trip_id, hermes_profile) VALUES ($1, $2, $3, 'companion-x')",
    [id("tcb"), chatId, tripId],
  );
}

function say(chatId: string, text: string, opts: { type?: string; fromId?: number; replyToBot?: boolean } = {}): TelegramUpdate {
  return {
    update_id: 5,
    message: {
      message_id: 12,
      from: { id: opts.fromId ?? 778, first_name: "Dana" },
      chat: { id: chatId, type: opts.type ?? "supergroup" },
      text,
      ...(opts.replyToBot ? { reply_to_message: { message_id: 3, from: { id: Number(BOT.id), is_bot: true }, text: "hi" } } : {}),
    },
  } as TelegramUpdate;
}

const startappOf = (decision: DispatchDecision): string | null => {
  const markup = decision.kind === "reply" ? decision.reply.replyMarkup
    : decision.kind === "group_intro" ? decision.openTrip?.replyMarkup : undefined;
  const button = markup?.inline_keyboard.flat()[0];
  return button && "url" in button ? button.url : null;
};

// The Mini App is READY for the bot (owner decision 2026-10-20) unless a test says otherwise.
const READY = { tripAppReady: () => true, tripAppBotUsername: "Kinerary_bot" };

const dispatch = (pool: pg.Pool, update: TelegramUpdate, options = {}, log: (line: string) => void = () => {}) =>
  dispatchUpdate(pool, update, DEFAULT_STRINGS, log, BOT, { ...READY, ...options });

describe("binding a group posts the Open trip message (#443)", { skip: SKIP }, () => {
  const redeem = async (fix: Fixture, chatId: string, tripId = fix.tripId, options = {}, log?: (line: string) => void) => {
    const issued = await issueGroupBindingToken(fix.pool, tripId, ORGANIZER, { ttlSeconds: 3600 });
    if (!issued.ok) throw new Error("issue failed");
    return dispatch(fix.pool, say(chatId, `/group ${issued.token}`, { fromId: Number(ORGANIZER) }), options, log);
  };

  test("the binding decision carries a URL button to the trip's Mini App and nothing else", async () => {
    await withFixture(async (fix) => {
      await setIntro(fix.pool, fix.tripId, "en");
      const decision = await redeem(fix, "-1002000801");
      assert.equal(decision.kind, "group_intro");
      if (decision.kind !== "group_intro") return;
      assert.equal(startappOf(decision), `https://t.me/Kinerary_bot?startapp=${fix.tripId}`);
      assert.equal(decision.openTrip?.replyMarkup.inline_keyboard[0]![0]!.text, "Open trip");
      // Only the trip id selects. No password, token or user id is anywhere in what is sent.
      const sent = JSON.stringify(decision.openTrip);
      assert.equal(sent.includes("seed-pw"), false);
      assert.equal(sent.includes("KIN-"), false);
      assert.equal(sent.includes(ORGANIZER), false);
    });
  });

  test("the link points at the configured Mini App bot - never at the relay's own getMe handle", async () => {
    await withFixture(async (fix) => {
      await setIntro(fix.pool, fix.tripId, "en");
      const decision = await redeem(fix, "-1002000802", fix.tripId, { tripAppBotUsername: "Portal_Bot" });
      assert.equal(startappOf(decision), `https://t.me/Portal_Bot?startapp=${fix.tripId}`);
    });
  });

  test("the button speaks the trip's language", async () => {
    await withFixture(async (fix) => {
      await setIntro(fix.pool, fix.tripId, "he");
      const decision = await redeem(fix, "-1002000803");
      assert.equal(decision.kind, "group_intro");
      if (decision.kind !== "group_intro") return;
      assert.equal(decision.openTrip?.replyMarkup.inline_keyboard[0]![0]!.text, uiString("openTripButton", "he"));
      assert.match(decision.openTrip!.pinFailedText, /[֐-׿]/);
    });
  });

  test("no known bot handle: the introduction still goes out, with no button, and the log says why", async () => {
    await withFixture(async (fix) => {
      await setIntro(fix.pool, fix.tripId, "en");
      const lines: string[] = [];
      const issued = await issueGroupBindingToken(fix.pool, fix.tripId, ORGANIZER, { ttlSeconds: 3600 });
      if (!issued.ok) throw new Error("issue failed");
      const decision = await dispatchUpdate(
        fix.pool, say("-1002000804", `/group ${issued.token}`, { fromId: Number(ORGANIZER) }),
        DEFAULT_STRINGS, (line) => lines.push(line), BOT, { tripAppReady: () => true },
      );
      assert.equal(decision.kind, "group_intro");
      if (decision.kind !== "group_intro") return;
      assert.equal(decision.openTrip, undefined);
      assert.ok(lines.some((l) => l.includes("trip_bot.open_trip_unavailable") && l.includes("NO_BOT_USERNAME")), lines.join("\n"));
    });
  });

  test("a group re-bound to ANOTHER trip gets that trip's button", async () => {
    await withFixture(async (fix) => {
      await setIntro(fix.pool, fix.tripId, "en");
      const chatId = "-1002000805";
      const first = await redeem(fix, chatId);
      assert.equal(startappOf(first), `https://t.me/Kinerary_bot?startapp=${fix.tripId}`);

      // The first trip's binding ends (teardown closes it), then the organizer binds the group to the next one.
      await fix.pool.query("UPDATE control_plane.telegram_chat_bindings SET closed_at = now(), closed_reason = 'trip_retired' WHERE chat_id = $1", [chatId]);
      const secondTrip = await addTrip(fix.pool, fix.userId, "en");
      const second = await redeem(fix, chatId, secondTrip);
      assert.equal(startappOf(second), `https://t.me/Kinerary_bot?startapp=${secondTrip}`);
      assert.notEqual(secondTrip, fix.tripId);
    });
  });

  test("re-posting the same trip's code posts the button again (the supported recovery path)", async () => {
    await withFixture(async (fix) => {
      await setIntro(fix.pool, fix.tripId, "en");
      const chatId = "-1002000806";
      await redeem(fix, chatId);
      const again = await redeem(fix, chatId);
      assert.equal(startappOf(again), `https://t.me/Kinerary_bot?startapp=${fix.tripId}`);
    });
  });

  test("a code someone else holds binds nothing and offers no button", async () => {
    await withFixture(async (fix) => {
      await setIntro(fix.pool, fix.tripId, "en");
      const issued = await issueGroupBindingToken(fix.pool, fix.tripId, ORGANIZER, { ttlSeconds: 3600 });
      if (!issued.ok) throw new Error("issue failed");
      const decision = await dispatch(fix.pool, say("-1002000807", `/group ${issued.token}`, { fromId: 999 }));
      assert.equal(decision.kind, "reply");
      if (decision.kind !== "reply") return;
      assert.equal(decision.reply.text, DEFAULT_STRINGS.groupTokenRefused);
      assert.equal(decision.reply.replyMarkup, undefined);
    });
  });

  test("a code hand-over in the organizer's DM carries no button (nothing is bound yet)", async () => {
    await withFixture(async (fix) => {
      await setIntro(fix.pool, fix.tripId, "en");
      await bind(fix.pool, "700000801", fix.tripId);
      const decision = await dispatch(fix.pool, say("700000801", "/group", { type: "private", fromId: Number(ORGANIZER) }));
      assert.equal(decision.kind, "group_intro");
      if (decision.kind !== "group_intro") return;
      assert.equal(decision.openTrip, undefined);
    });
  });

  test("the bot joining an already-bound group posts it too", async () => {
    await withFixture(async (fix) => {
      await setIntro(fix.pool, fix.tripId, "en");
      const chatId = "-1002000808";
      await bind(fix.pool, chatId, fix.tripId);
      const decision = await dispatch(fix.pool, {
        update_id: 90,
        my_chat_member: {
          chat: { id: chatId, type: "supergroup" },
          from: { id: 77, is_bot: false, first_name: "Dror" },
          old_chat_member: { user: { id: Number(BOT.id), is_bot: true }, status: "left" },
          new_chat_member: { user: { id: Number(BOT.id), is_bot: true }, status: "member" },
        },
      } as never);
      assert.equal(startappOf(decision), `https://t.me/Kinerary_bot?startapp=${fix.tripId}`);
    });
  });
});

describe("/app (#443)", { skip: SKIP }, () => {
  test("in a bound group it replies with the button for THAT group's trip, in the trip's language", async () => {
    await withFixture(async (fix) => {
      await setIntro(fix.pool, fix.tripId, "he");
      await bind(fix.pool, "-1002000811", fix.tripId);
      for (const text of ["/app", "/app@Kinerary_bot"]) {
        const decision = await dispatch(fix.pool, say("-1002000811", text));
        assert.equal(decision.kind, "reply", text);
        if (decision.kind !== "reply") return;
        assert.equal(startappOf(decision), `https://t.me/Kinerary_bot?startapp=${fix.tripId}`);
        assert.equal(decision.reply.text, uiString("openTripText", "he"));
      }
    });
  });

  test("the trip comes from the chat's binding - an argument cannot pick another", async () => {
    await withFixture(async (fix) => {
      await setIntro(fix.pool, fix.tripId, "en");
      const other = await addTrip(fix.pool, fix.userId, "en");
      await bind(fix.pool, "-1002000812", fix.tripId);
      const decision = await dispatch(fix.pool, say("-1002000812", `/app ${other}`));
      assert.equal(startappOf(decision), `https://t.me/Kinerary_bot?startapp=${fix.tripId}`);
    });
  });

  test("in an unbound group it gives the same 'not bound' answer as any other command there", async () => {
    await withFixture(async (fix) => {
      const decision = await dispatch(fix.pool, say("-1002000813", "/app"));
      assert.equal(decision.kind === "reply" && decision.reply.text, DEFAULT_STRINGS.unbound);
      assert.equal(decision.kind === "reply" && decision.reply.replyMarkup, undefined);
    });
  });

  test("in a private chat bound to a trip it replies with that trip's button", async () => {
    await withFixture(async (fix) => {
      await setIntro(fix.pool, fix.tripId, "en");
      await bind(fix.pool, "700000811", fix.tripId);
      const decision = await dispatch(fix.pool, say("700000811", "/app", { type: "private" }));
      assert.equal(startappOf(decision), `https://t.me/Kinerary_bot?startapp=${fix.tripId}`);
    });
  });

  test("in a private chat with no trip it offers the sender's own trips to choose from (the /trips chooser)", async () => {
    await withFixture(async (fix) => {
      await setIntro(fix.pool, fix.tripId, "en");
      await fix.pool.query(
        // Telegram links are per trip (#442): the chooser lists the trips this account holds a live link to.
        "INSERT INTO control_plane.telegram_organizer_trip_links(id, user_id, trip_id, telegram_subject_digest, verified_via) VALUES ($1,$2,$3,$4,'enrollment_redemption')",
        [id("otl"), fix.userId, fix.tripId, digestTelegramId("778")],
      );
      const decision = await dispatch(fix.pool, say("700000812", "/app", { type: "private", fromId: 778 }));
      assert.equal(decision.kind, "reply");
      if (decision.kind !== "reply") return;
      const buttons = decision.reply.replyMarkup?.inline_keyboard.flat() ?? [];
      assert.deepEqual(buttons.map((b) => ("callback_data" in b ? b.callback_data : null)), [`s:${fix.tripId}`]);
      // A stranger with no trips gets the plain 'nothing yet' answer, not someone else's list.
      const stranger = await dispatch(fix.pool, say("700000813", "/app", { type: "private", fromId: 4242 }));
      assert.equal(stranger.kind === "reply" && stranger.reply.text, uiString("tripsEmpty", "en"));
    });
  });

  test("ready but with no bot handle it says so, in words, instead of staying silent", async () => {
    await withFixture(async (fix) => {
      await setIntro(fix.pool, fix.tripId, "en");
      await bind(fix.pool, "-1002000814", fix.tripId);
      const lines: string[] = [];
      const decision = await dispatchUpdate(fix.pool, say("-1002000814", "/app"), DEFAULT_STRINGS, (l) => lines.push(l), BOT, { tripAppReady: () => true });
      assert.equal(decision.kind === "reply" && decision.reply.text, uiString("openTripUnavailable", "en"));
      assert.ok(lines.some((l) => l.includes("trip_bot.open_trip_unavailable")));
    });
  });

  test("in the middle of an interview it is not served (the interview outranks the binding)", async () => {
    await withFixture(async (fix) => {
      await setIntro(fix.pool, fix.tripId, "en");
      await fix.pool.query("UPDATE control_plane.trips SET lifecycle_state = 'draft' WHERE id = $1", [fix.tripId]);
      const issued = await issueEnrollment(fix.pool, fix.userId, fix.tripId, { enrollmentTtlSeconds: 3600 });
      if (!issued.ok) throw new Error("issue failed");
      const started = await startFromDeepLink(fix.pool, "700000814", issued.token);
      assert.equal(started.kind, "started");
      const decision = await dispatch(fix.pool, say("700000814", "/app", { type: "private" }));
      assert.equal(decision.kind === "reply" && decision.reply.text, uiString("notMyCommand", "en"));
    });
  });
});

describe("asking for the app in plain words (#443)", { skip: SKIP }, () => {
  test("a DM needs no name; a group message must address the assistant", async () => {
    await withFixture(async (fix) => {
      await setIntro(fix.pool, fix.tripId, "en", ["Rio", "ריו"]);
      await bind(fix.pool, "-1002000821", fix.tripId);
      await bind(fix.pool, "700000821", fix.tripId);
      const url = `https://t.me/Kinerary_bot?startapp=${fix.tripId}`;

      // DM: addressed by construction.
      assert.equal(startappOf(await dispatch(fix.pool, say("700000821", "open the app", { type: "private" }))), url);
      // Group: by name, by @mention, in Hebrew, and as a reply to the assistant.
      for (const text of ["Rio open the app", "@Kinerary_bot app", "ריו פתח את האפליקציה", "Rio, send me the app please"]) {
        assert.equal(startappOf(await dispatch(fix.pool, say("-1002000821", text))), url, text);
      }
      assert.equal(startappOf(await dispatch(fix.pool, say("-1002000821", "the app", { replyToBot: true }))), url);

      // Group chatter that merely contains the words is the family's, not a request.
      for (const text of ["open the app", "app", "anyone tried the app?", "Rio what is the app for"]) {
        const decision = await dispatch(fix.pool, say("-1002000821", text));
        assert.equal(startappOf(decision), null, text);
      }
    });
  });

  test("words in an unbound chat or in an interview are left alone", async () => {
    await withFixture(async (fix) => {
      await setIntro(fix.pool, fix.tripId, "en");
      const unbound = await dispatch(fix.pool, say("700000822", "open the app", { type: "private" }));
      assert.equal(startappOf(unbound), null);

      await fix.pool.query("UPDATE control_plane.trips SET lifecycle_state = 'draft' WHERE id = $1", [fix.tripId]);
      const issued = await issueEnrollment(fix.pool, fix.userId, fix.tripId, { enrollmentTtlSeconds: 3600 });
      if (!issued.ok) throw new Error("issue failed");
      assert.equal((await startFromDeepLink(fix.pool, "700000823", issued.token)).kind, "started");
      const interviewing = await dispatch(fix.pool, say("700000823", "open the app", { type: "private" }));
      assert.equal(startappOf(interviewing), null, "an interview's words belong to the interview");
    });
  });
});

// ── The Mini App is not ready: owner decision 2026-10-20 ─────────────────────
// No Open trip message or pin on a binding (the introduction is exactly as before
// #443), /app says "not available yet", the plain words are left to the companion.
// Unknown is not ready: no readiness function at all, one that says false, and one
// that throws are all the same.

describe("when the Mini App is NOT ready (#443)", { skip: SKIP }, () => {
  const notReadyVariants: [string, Record<string, unknown>][] = [
    ["no readiness known at all", {}],
    ["readiness says false", { tripAppReady: () => false }],
    ["readiness check throws", { tripAppReady: () => { throw new Error("boom"); } }],
    ["readiness says something other than true", { tripAppReady: () => "yes" as never }],
  ];
  const asNotReady = (pool: pg.Pool, update: TelegramUpdate, variant: Record<string, unknown>) =>
    dispatchUpdate(pool, update, DEFAULT_STRINGS, () => {}, BOT, { tripAppBotUsername: "Kinerary_bot", ...variant });

  test("binding a group: the introduction is exactly what it was, with no Open trip message to post or pin", async () => {
    await withFixture(async (fix) => {
      await setIntro(fix.pool, fix.tripId, "en");
      const issued = await issueGroupBindingToken(fix.pool, fix.tripId, ORGANIZER, { ttlSeconds: 3600 });
      if (!issued.ok) throw new Error("issue failed");
      const bindIn = (chatId: string, variant: Record<string, unknown> | null) => {
        const update = say(chatId, `/group ${issued.token}`, { fromId: Number(ORGANIZER) });
        return variant === null ? dispatch(fix.pool, update) : asNotReady(fix.pool, update, variant);
      };
      const ready = await bindIn("-1002000900", null);
      assert.equal(ready.kind === "group_intro" && ready.openTrip !== undefined, true, "sanity: ready posts it");
      let n = 1;
      for (const [name, variant] of notReadyVariants) {
        const decision = await bindIn(`-100200090${n++}`, variant);
        assert.equal(decision.kind, "group_intro", name);
        if (decision.kind !== "group_intro" || ready.kind !== "group_intro") return;
        assert.equal(decision.openTrip, undefined, name);
        assert.equal(decision.text, ready.text, `${name}: the introduction itself is unchanged`);
        assert.equal(decision.pin, ready.pin, name);
      }
    });
  });

  test("the bot joining an already-bound group posts no Open trip message either", async () => {
    await withFixture(async (fix) => {
      await setIntro(fix.pool, fix.tripId, "en");
      await bind(fix.pool, "-1002000910", fix.tripId);
      for (const [name, variant] of notReadyVariants) {
        const decision = await asNotReady(fix.pool, {
          update_id: 90,
          my_chat_member: {
            chat: { id: "-1002000910", type: "supergroup" },
            from: { id: 77, is_bot: false, first_name: "Dror" },
            old_chat_member: { user: { id: Number(BOT.id), is_bot: true }, status: "left" },
            new_chat_member: { user: { id: Number(BOT.id), is_bot: true }, status: "member" },
          },
        } as never, variant);
        assert.equal(decision.kind, "group_intro", name);
        assert.equal(decision.kind === "group_intro" && decision.openTrip, undefined, name);
      }
    });
  });

  test("/app typed anyway gets a plain 'not available yet', in every kind of chat", async () => {
    await withFixture(async (fix) => {
      await setIntro(fix.pool, fix.tripId, "en");
      await bind(fix.pool, "-1002000920", fix.tripId);
      await bind(fix.pool, "700000920", fix.tripId);
      const chats: [string, string, string][] = [
        ["bound group", "-1002000920", "supergroup"],
        ["unbound group", "-1002000921", "supergroup"],
        ["bound DM", "700000920", "private"],
        ["unbound DM", "700000921", "private"],
      ];
      for (const [name, variant] of notReadyVariants) {
        for (const [chatName, chatId, type] of chats) {
          const decision = await asNotReady(fix.pool, say(chatId, "/app", { type }), variant);
          assert.equal(decision.kind, "reply", `${name} / ${chatName}`);
          if (decision.kind !== "reply") return;
          assert.equal(decision.reply.text, uiString("openTripUnavailable", "en"), `${name} / ${chatName}`);
          assert.equal(decision.reply.replyMarkup, undefined, `${name} / ${chatName}: no button`);
        }
      }
    });
  });

  test("the plain words are not answered: they go on to the companion like any other sentence", async () => {
    await withFixture(async (fix) => {
      await setIntro(fix.pool, fix.tripId, "en", ["Rio"]);
      await bind(fix.pool, "-1002000930", fix.tripId);
      await bind(fix.pool, "700000930", fix.tripId);
      for (const [name, variant] of notReadyVariants) {
        const dm = await asNotReady(fix.pool, say("700000930", "open the app", { type: "private" }), variant);
        assert.equal(dm.kind, "to_gateway", `${name}: a DM's words reach the companion`);
        const group = await asNotReady(fix.pool, say("-1002000930", "Rio open the app"), variant);
        assert.equal(group.kind, "to_gateway", `${name}: so does an addressed group message`);
        assert.equal(startappOf(dm), null);
        assert.equal(startappOf(group), null);
      }
    });
  });

  test("no web block, no button: a ready flag without the Mini App's own bot handle falls back to nothing (never the relay's getMe handle)", async () => {
    await withFixture(async (fix) => {
      await setIntro(fix.pool, fix.tripId, "en");
      await bind(fix.pool, "-1002000940", fix.tripId);
      // BOT.username is "Kinerary_bot"; the Mini App's handle is absent. /app must not reuse the relay's own.
      const decision = await dispatchUpdate(fix.pool, say("-1002000940", "/app"), DEFAULT_STRINGS, () => {}, BOT, { tripAppReady: () => true });
      assert.equal(startappOf(decision), null);
      assert.equal(decision.kind === "reply" && decision.reply.text, uiString("openTripUnavailable", "en"));
    });
  });

  test("readiness is asked per update, so it turns on - and off - without a restart", async () => {
    await withFixture(async (fix) => {
      await setIntro(fix.pool, fix.tripId, "en");
      await bind(fix.pool, "-1002000950", fix.tripId);
      let ready = false;
      // ONE options object for the whole test: only the flag the function reads changes.
      const options = { tripAppBotUsername: "Kinerary_bot", tripAppReady: () => ready };
      const ask = () => dispatchUpdate(fix.pool, say("-1002000950", "/app"), DEFAULT_STRINGS, () => {}, BOT, options);
      const bindAgain = async (chatId: string) => {
        const issued = await issueGroupBindingToken(fix.pool, fix.tripId, ORGANIZER, { ttlSeconds: 3600 });
        if (!issued.ok) throw new Error("issue failed");
        return dispatchUpdate(
          fix.pool, say(chatId, `/group ${issued.token}`, { fromId: Number(ORGANIZER) }), DEFAULT_STRINGS, () => {}, BOT, options,
        );
      };

      assert.equal(startappOf(await ask()), null, "not ready: no button");
      const before = await bindAgain("-1002000951");
      assert.equal(before.kind === "group_intro" && before.openTrip, undefined);

      ready = true; // the BotFather step was done; the readiness check noticed
      assert.equal(startappOf(await ask()), `https://t.me/Kinerary_bot?startapp=${fix.tripId}`);
      const after = await bindAgain("-1002000952");
      assert.equal(after.kind === "group_intro" && after.openTrip !== undefined, true);

      ready = false;
      assert.equal(startappOf(await ask()), null, "and back off again");
    });
  });
});

// ── What the poller does with the decision ──────────────────────────────────

class RecordingTelegram {
  calls: string[] = [];
  sent: { chatId: string; text: string; replyMarkup?: unknown }[] = [];
  pinned: string[] = [];
  unpinned: string[] = [];
  pinResult = true;
  top: PinnedMessage | null = null;
  async sendMessage(params: { chatId: string; text: string; replyMarkup?: unknown }): Promise<SendResult> {
    this.sent.push(params);
    this.calls.push(`send:${this.sent.length}`);
    return { ok: true, messageId: String(this.sent.length) };
  }
  async pinChatMessage(params: { messageId: string }): Promise<boolean> {
    this.calls.push(`pin:${params.messageId}`);
    if (this.pinResult) this.pinned.push(params.messageId);
    return this.pinResult;
  }
  async getPinnedMessage(): Promise<PinnedMessage | null> {
    this.calls.push("getPinned");
    return this.top;
  }
  async unpinChatMessage(params: { messageId: string }): Promise<boolean> {
    this.calls.push(`unpin:${params.messageId}`);
    this.unpinned.push(params.messageId);
    return true;
  }
}

const intro = (tripId: string): DispatchDecision => ({
  kind: "group_intro",
  chatId: "-1002000831",
  text: "Hello everyone",
  openTrip: {
    text: uiString("openTripText", "en"),
    pinFailedText: uiString("openTripPinFailed", "en"),
    replyMarkup: { inline_keyboard: [[{ text: "Open trip", url: `https://t.me/Kinerary_bot?startapp=${tripId}` }]] },
  },
});

const deps = (telegram: RecordingTelegram, lines: string[] = []) => ({
  db: {} as pg.Pool,
  telegram: telegram as unknown as TelegramClient,
  connector: { pushInbound: () => true },
  botIdentity: BOT,
  log: (line: string) => { lines.push(line); },
});

describe("applying the group_intro decision with an Open trip message (#443)", () => {
  const TRIP_A = "trip_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";

  test("the introduction, then the button, and both are pinned - the button last, so it is on top", async () => {
    const telegram = new RecordingTelegram();
    await applyDecision(intro(TRIP_A), deps(telegram));
    assert.deepEqual(telegram.sent.map((m) => m.text), ["Hello everyone", uiString("openTripText", "en")]);
    assert.deepEqual(telegram.pinned, ["1", "2"]);
    assert.deepEqual(telegram.sent[1]!.replyMarkup, { inline_keyboard: [[{ text: "Open trip", url: `https://t.me/Kinerary_bot?startapp=${TRIP_A}` }]] });
  });

  test("when pinning is refused the group is told ONCE what to do - no loop, no retry", async () => {
    const telegram = new RecordingTelegram();
    telegram.pinResult = false;
    const lines: string[] = [];
    await applyDecision(intro(TRIP_A), deps(telegram, lines));
    assert.deepEqual(telegram.sent.map((m) => m.text), [
      "Hello everyone",
      uiString("openTripText", "en"),
      uiString("openTripPinFailed", "en"),
    ]);
    // Two pin attempts (the introduction's and the button's), neither repeated.
    assert.equal(telegram.calls.filter((c) => c.startsWith("pin:")).length, 2);
    assert.equal(telegram.sent.filter((m) => m.text === uiString("openTripPinFailed", "en")).length, 1);
  });

  test("a successful pin says nothing about pinning", async () => {
    const telegram = new RecordingTelegram();
    await applyDecision(intro(TRIP_A), deps(telegram));
    assert.equal(telegram.sent.some((m) => m.text === uiString("openTripPinFailed", "en")), false);
  });

  test("a previous Open trip of OURS is unpinned first, before anything new is sent", async () => {
    const telegram = new RecordingTelegram();
    telegram.top = { messageId: "41", fromId: BOT.id, text: "x", buttonUrls: ["https://t.me/Kinerary_bot?startapp=trip_bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"] };
    await applyDecision(intro(TRIP_A), deps(telegram));
    assert.deepEqual(telegram.unpinned, ["41"]);
    assert.equal(telegram.calls.indexOf("unpin:41") < telegram.calls.indexOf("send:1"), true, telegram.calls.join(","));
  });

  test("a pinned message that is not ours is never unpinned", async () => {
    const telegram = new RecordingTelegram();
    telegram.top = { messageId: "41", fromId: "99", text: "x", buttonUrls: [`https://t.me/Kinerary_bot?startapp=${TRIP_A}`] };
    await applyDecision(intro(TRIP_A), deps(telegram));
    assert.deepEqual(telegram.unpinned, []);
    telegram.top = { messageId: "42", fromId: BOT.id, text: "Hello everyone, I'm Rio", buttonUrls: [] };
    await applyDecision(intro(TRIP_A), deps(telegram));
    assert.deepEqual(telegram.unpinned, [], "the introduction itself is not an Open trip message");
  });

  test("a plain introduction with no Open trip message behaves exactly as before", async () => {
    const telegram = new RecordingTelegram();
    await applyDecision({ kind: "group_intro", chatId: "-1002000831", text: "Hello everyone" }, deps(telegram));
    assert.deepEqual(telegram.sent.map((m) => m.text), ["Hello everyone"]);
    assert.deepEqual(telegram.calls, ["send:1", "pin:1"]);
  });
});
