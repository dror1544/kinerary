/**
 * Moving a Telegram group from one trip to the organizer's next one.
 *
 * Until this, `/group KIN-…` in a group already bound to trip A was refused
 * (CHAT_BOUND_ELSEWHERE) for EVERYONE, including the person who organizes both
 * trips - so the only way to carry a family group from last year's trip to this
 * year's was an operator. The rule now: the sender of the code must be a linked
 * organizer of the trip the group is bound to NOW as well as of the trip the code
 * is for. Anyone else gets one uniform refusal and nothing changes.
 *
 * Every refusal test asserts the DATABASE is unchanged, not just the reply: the
 * property is "nobody else's group moves", and a message proves nothing about that.
 */
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { describe, test } from "node:test";
import { fileURLToPath } from "node:url";
import pg from "pg";
import { applyMigrations } from "../src/migrations.js";
import {
  GROUP_MOVED_CLOSED_REASON,
  issueGroupBindingToken,
  redeemGroupBindingToken,
} from "../src/group-binding.js";
import { resolveChatRoute } from "../src/chat-router.js";
import { digestTelegramId } from "../src/identity.js";
import { issueTelegramLinkToken, redeemTelegramLinkToken } from "../src/telegram-link-token.js";
import { unlinkTelegramLink } from "../src/telegram-mini-app.js";
import { uiString } from "../src/intake-copy.js";
import { applyDecision } from "../src/relay/poller.js";
import { dispatchUpdate, DEFAULT_STRINGS, type DispatchDecision } from "../src/relay/dispatch.js";
import type { TelegramUpdate } from "../src/relay/normalize.js";
import { GroupContext } from "../src/relay/group-context.js";
import { PendingAttachments } from "../src/relay/pending-attachments.js";
import type { PinnedMessage, SendResult, TelegramClient } from "../src/relay/telegram-api.js";
import { testDatabaseUrl, testPool } from "./support/test-database.js";

const SKIP = !testDatabaseUrl();
const migrationsDir = fileURLToPath(new URL("../../db/migrations/", import.meta.url));
const BOT = { id: "8463178587", username: "Kinerary_bot" };

/** Organizes trips A and B, through two different user ids (the live shape). */
const DROR = "777";
/** Organizes trip C only - somebody else's trip. */
const STRANGER_ORGANIZER = "999";
/** A family member: holds no organizer link at all. */
const MEMBER = "555";
const CHAT = "-1002000500";

const id = (prefix: string) => `${prefix}_${randomBytes(16).toString("hex")}`;

interface Fixture {
  pool: pg.Pool;
  tripA: string;
  tripB: string;
  tripC: string;
  /** The owner users of the three trips (each trip's owner membership). */
  uA: string;
  uB: string;
  uC: string;
}

/** A live per-trip organizer link (`telegram_organizer_trip_links`): this Telegram account organizes this trip as this user. */
async function tripLink(pool: pg.Pool, userId: string, tripId: string, telegramId: string): Promise<string> {
  const linkId = id("otl");
  await pool.query(
    `INSERT INTO control_plane.telegram_organizer_trip_links(id, user_id, trip_id, telegram_subject_digest, verified_via)
     VALUES ($1, $2, $3, $4, 'enrollment_redemption')`,
    [linkId, userId, tripId, digestTelegramId(telegramId)],
  );
  return linkId;
}

async function addTrip(pool: pg.Pool, slug: string, language: "en" | "he", owner: string, profile: string): Promise<string> {
  const tripId = id("trip");
  await pool.query(
    `INSERT INTO control_plane.trips(id, slug, lifecycle_state, hermes_profile, companion_intro, assistant_names)
     VALUES ($1, $2, 'ready_private', $3, $4::jsonb, $5)`,
    [tripId, slug, profile, JSON.stringify({
      assistant_name: `Rio-${slug}`, trip_title: `Trip ${slug}`, private_url: `https://${slug}.example`, language, login_password: "seed-pw",
    }), [`Rio-${slug}`]],
  );
  await pool.query(
    "INSERT INTO control_plane.trip_memberships(id, trip_id, user_id, role, status) VALUES ($1, $2, $3, 'owner', 'active')",
    [id("memb"), tripId, owner],
  );
  return tripId;
}

async function withFixture(
  fn: (fix: Fixture) => Promise<void>,
  opts: { languageA?: "en" | "he" } = {},
): Promise<void> {
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
    const [uA, uB, uC] = [id("user"), id("user"), id("user")];
    for (const u of [uA, uB, uC]) {
      await pool.query("INSERT INTO control_plane.users(id, status, display_name) VALUES ($1, 'active', 'U')", [u]);
    }
    const tripA = await addTrip(pool, "japan-2025", opts.languageA ?? "en", uA, "companion-a");
    const tripB = await addTrip(pool, "italy-2026", "en", uB, "companion-b");
    const tripC = await addTrip(pool, "peru-2026", "en", uC, "companion-c");
    // Telegram links are PER TRIP (#442): a mover must hold a live link to the trip the group is on
    // AND to the one it is going to. An account-wide `telegram_organizer_links` row counts for nothing.
    await tripLink(pool, uA, tripA, DROR);
    await tripLink(pool, uB, tripB, DROR);
    await tripLink(pool, uC, tripC, STRANGER_ORGANIZER);
    // The group is Trip A's, with its companion.
    await pool.query(
      "INSERT INTO control_plane.telegram_chat_bindings(id, chat_id, trip_id, hermes_profile) VALUES ($1, $2, $3, 'companion-a')",
      [id("tcb"), CHAT, tripA],
    );
    await fn({ pool, tripA, tripB, tripC, uA, uB, uC });
  } finally {
    await pool.end();
  }
}

interface BindingRow { trip_id: string; hermes_profile: string | null; closed_at: Date | null; closed_reason: string | null }

async function bindings(pool: pg.Pool, chatId = CHAT): Promise<BindingRow[]> {
  const { rows } = await pool.query<BindingRow>(
    `SELECT trip_id, hermes_profile, closed_at, closed_reason
       FROM control_plane.telegram_chat_bindings WHERE chat_id = $1 ORDER BY created_at, id`,
    [chatId],
  );
  return rows;
}

async function tokenUse(pool: pg.Pool, tripId: string): Promise<number> {
  const { rows } = await pool.query<{ use_count: number }>(
    "SELECT use_count FROM control_plane.telegram_group_binding_tokens WHERE trip_id = $1", [tripId]);
  return rows[0]!.use_count;
}

async function issue(pool: pg.Pool, tripId: string, forTelegramId: string): Promise<string> {
  const issued = await issueGroupBindingToken(pool, tripId, forTelegramId, { ttlSeconds: 3600 });
  if (!issued.ok) throw new Error("issue failed");
  return issued.token;
}

describe("moving a group to the organizer's next trip (db)", { skip: SKIP }, () => {
  test("the organizer of both trips moves the group: old binding closed 'group_moved', new one open, routing follows", async () => {
    await withFixture(async ({ pool, tripA, tripB }) => {
      const token = await issue(pool, tripB, DROR);
      const result = await redeemGroupBindingToken(pool, token, CHAT, DROR);
      assert.deepEqual(result, { ok: true, tripId: tripB, rebound: false, movedFromTripId: tripA });

      const rows = await bindings(pool);
      assert.equal(rows.length, 2, "history is kept, nothing is overwritten");
      assert.equal(rows[0]!.trip_id, tripA);
      assert.ok(rows[0]!.closed_at, "the old binding is closed");
      assert.equal(rows[0]!.closed_reason, GROUP_MOVED_CLOSED_REASON);
      assert.equal(GROUP_MOVED_CLOSED_REASON, "group_moved");
      assert.equal(rows[1]!.trip_id, tripB);
      assert.equal(rows[1]!.closed_at, null);
      assert.equal(rows[1]!.closed_reason, null);
      assert.equal(rows[1]!.hermes_profile, "companion-b", "the NEW trip's companion, not the old one's");

      // Companion routing for the chat goes to B, and only B.
      const route = await resolveChatRoute(pool, CHAT);
      assert.equal(route.kind, "companion");
      if (route.kind !== "companion") return;
      assert.equal(route.tripId, tripB);
      assert.equal(route.hermesProfile, "companion-b");
      assert.ok(route.assistantNames.includes("Rio-italy-2026"));
      assert.equal(route.assistantNames.includes("Rio-japan-2025"), false);

      // The code is recorded as used (it stays redeemable until expiry by owner decision 2026-10-16:
      // one trip may bind several groups). Trip A itself is untouched.
      assert.equal(await tokenUse(pool, tripB), 1);
      const a = await pool.query("SELECT lifecycle_state, slug FROM control_plane.trips WHERE id = $1", [tripA]);
      assert.deepEqual(a.rows[0], { lifecycle_state: "ready_private", slug: "japan-2025" });
    });
  });

  test("re-posting the same code after the move is the ordinary re-bind, not a second move", async () => {
    await withFixture(async ({ pool, tripB }) => {
      const token = await issue(pool, tripB, DROR);
      await redeemGroupBindingToken(pool, token, CHAT, DROR);
      const again = await redeemGroupBindingToken(pool, token, CHAT, DROR);
      assert.deepEqual(again, { ok: true, tripId: tripB, rebound: true });
      assert.equal((await bindings(pool)).length, 2);
    });
  });

  test("a member who is not an organizer of the group's trip cannot move it, even with a code issued to them", async () => {
    await withFixture(async ({ pool, tripA, tripB }) => {
      const before = await bindings(pool);
      const token = await issue(pool, tripB, MEMBER);
      const result = await redeemGroupBindingToken(pool, token, CHAT, MEMBER);
      assert.deepEqual(result, { ok: false, reason: "GROUP_MOVE_NOT_ORGANIZER" });
      assert.deepEqual(await bindings(pool), before, "nothing moved");
      assert.equal(await tokenUse(pool, tripB), 0, "and the code was not spent");
      const route = await resolveChatRoute(pool, CHAT);
      assert.equal(route.kind === "companion" && route.tripId, tripA);
    });
  });

  test("the organizer of the NEW trip but not of the group's trip cannot take the group", async () => {
    await withFixture(async ({ pool, tripA, tripC }) => {
      const before = await bindings(pool);
      const token = await issue(pool, tripC, STRANGER_ORGANIZER);
      const result = await redeemGroupBindingToken(pool, token, CHAT, STRANGER_ORGANIZER);
      assert.deepEqual(result, { ok: false, reason: "GROUP_MOVE_NOT_ORGANIZER" });
      assert.deepEqual(await bindings(pool), before);
      const route = await resolveChatRoute(pool, CHAT);
      assert.equal(route.kind === "companion" && route.tripId, tripA);
    });
  });

  test("the organizer of the group's trip cannot move it to a trip they do not organize", async () => {
    await withFixture(async ({ pool, tripA, tripC }) => {
      const before = await bindings(pool);
      // A code for somebody else's trip, issued to Dror (a member's DM can be bound to any trip).
      const token = await issue(pool, tripC, DROR);
      const result = await redeemGroupBindingToken(pool, token, CHAT, DROR);
      assert.deepEqual(result, { ok: false, reason: "GROUP_MOVE_NOT_ORGANIZER" });
      assert.deepEqual(await bindings(pool), before);
      assert.equal(await tokenUse(pool, tripC), 0);
      const route = await resolveChatRoute(pool, CHAT);
      assert.equal(route.kind === "companion" && route.tripId, tripA);
    });
  });

  for (const gone of ["tripA", "tripB"] as const) {
    test(`a Telegram person with no live link to the ${gone === "tripA" ? "group's current" : "target"} trip is not an organizer of it`, async () => {
      await withFixture(async (fix) => {
        const { pool, tripA, tripB } = fix;
        // However "unlinked" is stored, a person with no LIVE per-trip row is "not linked".
        await pool.query(
          "DELETE FROM control_plane.telegram_organizer_trip_links WHERE telegram_subject_digest = $1 AND trip_id = $2",
          [digestTelegramId(DROR), fix[gone]],
        );
        const token = await issue(pool, tripB, DROR);
        const result = await redeemGroupBindingToken(pool, token, CHAT, DROR);
        assert.deepEqual(result, { ok: false, reason: "GROUP_MOVE_NOT_ORGANIZER" });
        assert.equal((await bindings(pool)).length, 1);
        const route = await resolveChatRoute(pool, CHAT);
        assert.equal(route.kind === "companion" && route.tripId, tripA);
      });
    });
  }

  test("an account-wide link (the previous release's model) no longer counts: only a live per-trip link does", async () => {
    await withFixture(async ({ pool, tripA, tripB, uA, uB }) => {
      // The state a rolled-back-and-forward database can hold: account-wide rows for both of DROR's
      // users, and no per-trip row at all.
      await pool.query("DELETE FROM control_plane.telegram_organizer_trip_links WHERE telegram_subject_digest = $1", [digestTelegramId(DROR)]);
      for (const userId of [uA, uB]) {
        await pool.query(
          `INSERT INTO control_plane.telegram_organizer_links(id, user_id, telegram_subject_digest, verified_via)
           VALUES ($1, $2, $3, 'enrollment_redemption')`,
          [id("tol"), userId, digestTelegramId(DROR)],
        );
      }
      const before = await bindings(pool);
      const token = await issue(pool, tripB, DROR);
      assert.deepEqual(await redeemGroupBindingToken(pool, token, CHAT, DROR), { ok: false, reason: "GROUP_MOVE_NOT_ORGANIZER" });
      assert.deepEqual(await bindings(pool), before, "nothing moved");
      const route = await resolveChatRoute(pool, CHAT);
      assert.equal(route.kind === "companion" && route.tripId, tripA);
    });
  });

  // ── R1 (boundary review, 2026-10-21): an Unlink takes the bot's organizer powers ─────────────
  // The interview link can be forwarded: whichever Telegram account redeems it becomes the trip's
  // organizer in the bot (provisioning writes that account's `trip_person_links` row as 'organizer').
  // When the owner Unlinks it, the person link is demoted, and a revoked link overrides an
  // 'organizer' row at read time even if a re-provision wrote the role back. Moving a group is the
  // organizer-only action this must close.
  const FORWARDEE = "888";

  async function forwardeeOrganizesAandB(fix: Fixture): Promise<{ linkA: string; linkB: string }> {
    const { pool, tripA, tripB, uA, uB } = fix;
    const linkA = await tripLink(pool, uA, tripA, FORWARDEE);
    const linkB = await tripLink(pool, uB, tripB, FORWARDEE);
    for (const [tripId, username] of [[tripA, "ronmargolin"], [tripB, "ronmargolin"]] as const) {
      await pool.query(
        `INSERT INTO control_plane.trip_person_links
           (id, trip_id, telegram_user_id, participant_username, display_name, role, verified_via)
         VALUES ($1, $2, $3, $4, 'The forwardee', 'organizer', 'interview_chat')`,
        [id("tpl"), tripId, FORWARDEE, username],
      );
    }
    // The dashboard hands out a relink only to an owner with dashboard access.
    await pool.query("UPDATE control_plane.trip_memberships SET dashboard_access = true WHERE user_id = ANY($1::text[])", [[uA, uB]]);
    return { linkA, linkB };
  }

  async function personRole(pool: pg.Pool, tripId: string): Promise<string> {
    const { rows } = await pool.query<{ role: string }>(
      "SELECT role FROM control_plane.trip_person_links WHERE trip_id = $1 AND telegram_user_id = $2", [tripId, FORWARDEE]);
    return rows[0]!.role;
  }

  test("R1 baseline: a forwardee who holds a live link to both trips CAN move the group", async () => {
    await withFixture(async (fix) => {
      const { pool, tripA, tripB } = fix;
      await forwardeeOrganizesAandB(fix);
      const token = await issue(pool, tripB, FORWARDEE);
      assert.deepEqual(
        await redeemGroupBindingToken(pool, token, CHAT, FORWARDEE),
        { ok: true, tripId: tripB, rebound: false, movedFromTripId: tripA },
      );
    });
  });

  for (const unlinked of ["tripA", "tripB"] as const) {
    test(`R1: a forwardee whose link to the ${unlinked === "tripA" ? "group's current" : "target"} trip was unlinked cannot move the group, and a relink restores it`, async () => {
      await withFixture(async (fix) => {
        const { pool, tripA, tripB, uA, uB } = fix;
        const links = await forwardeeOrganizesAandB(fix);
        const owner = unlinked === "tripA" ? uA : uB;
        const unlinkedTrip = fix[unlinked];

        // The owner's Unlink - the real function, not a hand-written UPDATE.
        assert.equal(await unlinkTelegramLink(pool, owner, unlinked === "tripA" ? links.linkA : links.linkB), true);
        assert.equal(await personRole(pool, unlinkedTrip), "participant", "the Unlink demoted the bot's organizer row");
        assert.equal(await personRole(pool, unlinked === "tripA" ? tripB : tripA), "organizer", "and only on the trip that was unlinked");

        const before = await bindings(pool);
        const refused = async () => {
          const token = await issue(pool, tripB, FORWARDEE);
          assert.deepEqual(await redeemGroupBindingToken(pool, token, CHAT, FORWARDEE), { ok: false, reason: "GROUP_MOVE_NOT_ORGANIZER" });
          assert.deepEqual(await bindings(pool), before, "the group stays exactly as it was");
          assert.equal(await tokenUse(pool, tripB), 0, "and the code was not spent");
          const route = await resolveChatRoute(pool, CHAT);
          assert.equal(route.kind === "companion" && route.tripId, tripA, "the group is still bound to the original trip");
        };
        await refused();

        // A re-provision upserts the person link back to 'organizer'. The revoked link still overrides it.
        await pool.query("UPDATE control_plane.trip_person_links SET role = 'organizer' WHERE trip_id = $1 AND telegram_user_id = $2", [unlinkedTrip, FORWARDEE]);
        assert.equal(await personRole(pool, unlinkedTrip), "organizer");
        await refused();

        // The way back is the owner's dashboard link, redeemed from the forwardee's Telegram account.
        const relink = await issueTelegramLinkToken(pool, { userId: owner, tripId: unlinkedTrip });
        assert.ok(relink.ok);
        const redeemed = await redeemTelegramLinkToken(pool, relink.ok ? relink.token : "", FORWARDEE);
        assert.equal(redeemed.ok, true);
        const token = await issue(pool, tripB, FORWARDEE);
        assert.deepEqual(
          await redeemGroupBindingToken(pool, token, CHAT, FORWARDEE),
          { ok: true, tripId: tripB, rebound: false, movedFromTripId: tripA },
        );
        const route = await resolveChatRoute(pool, CHAT);
        assert.equal(route.kind === "companion" && route.tripId, tripB);
      });
    });
  }

  test("R1: ending the forwardee's membership-backed link (member removed) also stops the move", async () => {
    await withFixture(async (fix) => {
      const { pool, tripA, tripB, uA } = fix;
      await forwardeeOrganizesAandB(fix);
      // The database trigger (20261022120000) revokes the trip's links and demotes the person link.
      await pool.query("UPDATE control_plane.trip_memberships SET status = 'revoked' WHERE trip_id = $1 AND user_id = $2", [tripA, uA]);
      assert.equal(await personRole(pool, tripA), "participant");
      const before = await bindings(pool);
      const token = await issue(pool, tripB, FORWARDEE);
      assert.deepEqual(await redeemGroupBindingToken(pool, token, CHAT, FORWARDEE), { ok: false, reason: "GROUP_MOVE_NOT_ORGANIZER" });
      assert.deepEqual(await bindings(pool), before);
    });
  });

  test("the other refusals come first and are unchanged: wrong sender, expired, unknown, retired trip", async () => {
    await withFixture(async ({ pool, tripA, tripB }) => {
      const token = await issue(pool, tripB, DROR);
      assert.deepEqual(await redeemGroupBindingToken(pool, token, CHAT, MEMBER), { ok: false, reason: "WRONG_SENDER" });
      assert.deepEqual(await redeemGroupBindingToken(pool, "KIN-AAAAAAAA", CHAT, DROR), { ok: false, reason: "NOT_FOUND" });
      await pool.query("UPDATE control_plane.telegram_group_binding_tokens SET created_at = now() - interval '2 hours', expires_at = now() - interval '1 hour' WHERE trip_id = $1", [tripB]);
      assert.deepEqual(await redeemGroupBindingToken(pool, token, CHAT, DROR), { ok: false, reason: "EXPIRED" });
      const fresh = await issue(pool, tripB, DROR);
      await pool.query("UPDATE control_plane.trips SET slug = 'retired-italy-20261001' WHERE id = $1", [tripB]);
      assert.deepEqual(await redeemGroupBindingToken(pool, fresh, CHAT, DROR), { ok: false, reason: "TRIP_RETIRED" });
      const route = await resolveChatRoute(pool, CHAT);
      assert.equal(route.kind === "companion" && route.tripId, tripA);
      assert.equal((await bindings(pool)).length, 1);
    });
  });

  test("a group with no open binding still binds the ordinary way (no move involved)", async () => {
    await withFixture(async ({ pool, tripB }) => {
      const token = await issue(pool, tripB, DROR);
      const result = await redeemGroupBindingToken(pool, token, "-1002000501", DROR);
      assert.deepEqual(result, { ok: true, tripId: tripB, rebound: false });
    });
  });

  // ── Lock order (#175) ─────────────────────────────────────────────────────
  // A move takes: the token row (FOR UPDATE), the old binding row (FOR UPDATE), then
  // `trips` through the new binding's foreign key. teardown-trip.py takes the token
  // row first, then bindings, then trips - the same order, so no cycle. These run the
  // two sides concurrently against a real database; a deadlock surfaces as a thrown 40P01.
  // Each is made deterministic (teardown takes its lock BEFORE the move starts, the move
  // queues, then teardown carries on) so the assertion is about the outcome, not about luck.

  test("a move queued behind teardown of the NEW trip (token revoke, then binding close) does not deadlock", async () => {
    await withFixture(async ({ pool, tripA, tripB }) => {
      const token = await issue(pool, tripB, DROR);
      const teardown = await pool.connect();
      try {
        await teardown.query("BEGIN");
        // teardown-trip.py's REVOKE_GROUP_TOKENS, first: it now holds the new trip's token row.
        await teardown.query(
          "UPDATE control_plane.telegram_group_binding_tokens SET expires_at = now() WHERE trip_id = $1 AND expires_at > now()", [tripB]);
        const move = redeemGroupBindingToken(pool, token, CHAT, DROR);
        await new Promise((resolve) => setTimeout(resolve, 50));
        await teardown.query(
          "UPDATE control_plane.telegram_chat_bindings SET closed_at = now(), closed_reason = 'trip_destroyed' WHERE trip_id = $1 AND closed_at IS NULL", [tripB]);
        await teardown.query("UPDATE control_plane.trips SET slug = 'retired-italy-20261020' WHERE id = $1", [tripB]);
        await teardown.query("COMMIT");
        const result = await move; // a real deadlock is a thrown 40P01 here
        assert.deepEqual(result, { ok: false, reason: "EXPIRED" }, "the revoked code moves nothing");
      } finally {
        teardown.release();
      }
      const open = (await bindings(pool)).filter((b) => b.closed_at === null);
      assert.deepEqual(open.map((b) => b.trip_id), [tripA], "the group stays where it was");
    });
  });

  test("a move queued behind teardown of the OLD trip (binding closed, slug renamed) does not deadlock", async () => {
    await withFixture(async ({ pool, tripA, tripB }) => {
      const token = await issue(pool, tripB, DROR);
      const teardown = await pool.connect();
      try {
        await teardown.query("BEGIN");
        await teardown.query(
          "UPDATE control_plane.telegram_group_binding_tokens SET expires_at = now() WHERE trip_id = $1 AND expires_at > now()", [tripA]);
        // teardown holds the OLD binding row (and, next, the old trips row) ...
        await teardown.query(
          "UPDATE control_plane.telegram_chat_bindings SET closed_at = now(), closed_reason = 'trip_destroyed' WHERE trip_id = $1 AND closed_at IS NULL", [tripA]);
        // ... while the move, holding the NEW trip's token row, queues on that binding row.
        const move = redeemGroupBindingToken(pool, token, CHAT, DROR);
        await new Promise((resolve) => setTimeout(resolve, 50));
        await teardown.query("UPDATE control_plane.trips SET slug = 'retired-japan-20261020' WHERE id = $1", [tripA]);
        await teardown.query("COMMIT");
        const result = await move;
        // Teardown won the row: nothing is left to move, so this is a plain bind of a free group.
        assert.deepEqual(result, { ok: true, tripId: tripB, rebound: false });
      } finally {
        teardown.release();
      }
      const rows = await bindings(pool);
      assert.deepEqual(rows.filter((b) => b.closed_at === null).map((b) => b.trip_id), [tripB]);
      assert.equal(rows.find((b) => b.trip_id === tripA)!.closed_reason, "trip_destroyed", "teardown's reason is not overwritten");
    });
  });

  test("a move that wins the row first leaves teardown of the old trip nothing to close", async () => {
    await withFixture(async ({ pool, tripA, tripB }) => {
      const token = await issue(pool, tripB, DROR);
      assert.ok((await redeemGroupBindingToken(pool, token, CHAT, DROR)).ok);
      const closed = await pool.query(
        "UPDATE control_plane.telegram_chat_bindings SET closed_at = now(), closed_reason = 'trip_destroyed' WHERE trip_id = $1 AND closed_at IS NULL", [tripA]);
      assert.equal(closed.rowCount, 0);
      const rows = await bindings(pool);
      assert.equal(rows.find((b) => b.trip_id === tripA)!.closed_reason, GROUP_MOVED_CLOSED_REASON);
    });
  });

  // ── A redemption queued behind a move must not take the "free group" branch (boundary review S1) ──
  // The waiting statement locks the binding row the move is about to close; once the move commits
  // that row no longer matches and the group LOOKS free - but it was just bound to trip B.

  for (const otherHasBinding of [true, false]) {
    test(`a non-organizer's code queued behind a move is refused, not bound over it (their trip ${otherHasBinding ? "has" : "has no"} other binding)`, async () => {
      await withFixture(async ({ pool, tripA, tripB, tripC }) => {
        if (otherHasBinding) {
          await pool.query(
            "INSERT INTO control_plane.telegram_chat_bindings(id, chat_id, trip_id, hermes_profile) VALUES ($1, '-1009990000', $2, 'companion-c')",
            [id("tcb"), tripC]);
        }
        const strangersCode = await issue(pool, tripC, STRANGER_ORGANIZER);
        // The organizer's move, already holding the group's binding row, as a hand-run transaction.
        const mover = await pool.connect();
        let result: Awaited<ReturnType<typeof redeemGroupBindingToken>> | { threw: unknown };
        try {
          await mover.query("BEGIN");
          await mover.query("SELECT 1 FROM control_plane.telegram_group_binding_tokens WHERE trip_id = $1 FOR UPDATE", [tripB]);
          await mover.query("SELECT id FROM control_plane.telegram_chat_bindings WHERE chat_id = $1 AND closed_at IS NULL FOR UPDATE", [CHAT]);
          const racing = redeemGroupBindingToken(pool, strangersCode, CHAT, STRANGER_ORGANIZER)
            .catch((error: unknown) => ({ threw: error }));
          await new Promise((resolve) => setTimeout(resolve, 150));
          await mover.query("UPDATE control_plane.telegram_chat_bindings SET closed_at = now(), closed_reason = 'group_moved' WHERE chat_id = $1 AND closed_at IS NULL", [CHAT]);
          await mover.query(
            "INSERT INTO control_plane.telegram_chat_bindings(id, chat_id, trip_id, hermes_profile) VALUES ($1, $2, $3, 'companion-b')",
            [id("tcb"), CHAT, tripB]);
          await mover.query("COMMIT");
          result = await racing;
        } finally {
          mover.release();
        }
        assert.deepEqual(result, { ok: false, reason: "GROUP_MOVE_NOT_ORGANIZER" }, "never an ok, never a throw");
        const route = await resolveChatRoute(pool, CHAT);
        assert.equal(route.kind === "companion" && route.tripId, tripB, "routing stays with the move's trip");
        assert.equal((await bindings(pool)).filter((b) => b.closed_at === null).length, 1);
        assert.equal(await tokenUse(pool, tripC), 0, "and the stranger's code was not spent");
        void tripA;
      });
    });
  }

  test("a binding that commits between a redemption's reads and its INSERT is a uniform refusal, not an unhandled error", async () => {
    await withFixture(async ({ pool, tripB, tripC }) => {
      const free = "-1002000777";
      const strangersCode = await issue(pool, tripC, STRANGER_ORGANIZER);
      const other = await pool.connect();
      try {
        await other.query("BEGIN");
        // An uncommitted binding of the free group: invisible to the redemption's reads, and its
        // INSERT then waits on the unique index.
        await other.query(
          "INSERT INTO control_plane.telegram_chat_bindings(id, chat_id, trip_id, hermes_profile) VALUES ($1, $2, $3, 'companion-b')",
          [id("tcb"), free, tripB]);
        const racing = redeemGroupBindingToken(pool, strangersCode, free, STRANGER_ORGANIZER)
          .catch((error: unknown) => ({ threw: error }));
        await new Promise((resolve) => setTimeout(resolve, 150));
        await other.query("COMMIT");
        assert.deepEqual(await racing, { ok: false, reason: "GROUP_MOVE_NOT_ORGANIZER" });
      } finally {
        other.release();
      }
      const rows = await bindings(pool, free);
      assert.deepEqual(rows.map((b) => b.trip_id), [tripB]);
    });
  });

  // ── One rule for the companion profile (boundary review S3) ──

  test("a FREE group gets the trip's own profile (trips.hermes_profile) even when the trip has no binding yet", async () => {
    await withFixture(async ({ pool, tripB }) => {
      const result = await redeemGroupBindingToken(pool, await issue(pool, tripB, DROR), "-1002000601", DROR);
      assert.ok(result.ok);
      assert.equal((await bindings(pool, "-1002000601"))[0]!.hermes_profile, "companion-b");
    });
  });

  test("with no trips.hermes_profile, free-bind and move both fall back to the trip's latest binding that has one", async () => {
    await withFixture(async ({ pool, tripA, tripB }) => {
      await pool.query("UPDATE control_plane.trips SET hermes_profile = NULL WHERE id = $1", [tripB]);
      await pool.query(
        `INSERT INTO control_plane.telegram_chat_bindings(id, chat_id, trip_id, hermes_profile, created_at)
         VALUES ($1, '-1009990001', $2, 'old-b', now() - interval '2 days'),
                ($3, '-1009990002', $2, 'newer-b', now() - interval '1 day')`,
        [id("tcb"), tripB, id("tcb")]);
      const code = await issue(pool, tripB, DROR);
      const free = await redeemGroupBindingToken(pool, code, "-1002000602", DROR);
      assert.ok(free.ok);
      const moved = await redeemGroupBindingToken(pool, code, CHAT, DROR);
      assert.ok(moved.ok && moved.movedFromTripId === tripA);
      const a = (await bindings(pool, "-1002000602"))[0]!.hermes_profile;
      const b = (await bindings(pool)).find((x) => x.closed_at === null)!.hermes_profile;
      assert.equal(a, "newer-b");
      assert.equal(b, "newer-b", "the same rule on both paths");
    });
  });

  test("two posts of the same code at once: one move, one re-bind, one open binding", async () => {
    await withFixture(async ({ pool, tripA, tripB }) => {
      const token = await issue(pool, tripB, DROR);
      const [x, y] = await Promise.all([
        redeemGroupBindingToken(pool, token, CHAT, DROR),
        redeemGroupBindingToken(pool, token, CHAT, DROR),
      ]);
      assert.ok(x.ok && y.ok);
      if (!x.ok || !y.ok) return;
      assert.deepEqual([x.rebound, y.rebound].sort(), [false, true]);
      const rows = await bindings(pool);
      assert.equal(rows.filter((b) => b.closed_at === null).length, 1);
      assert.equal(rows.filter((b) => b.closed_reason === GROUP_MOVED_CLOSED_REASON && b.trip_id === tripA).length, 1);
    });
  });
});

// ── Through the relay ───────────────────────────────────────────────────────

function say(chatId: string, text: string, fromId: number): TelegramUpdate {
  return {
    update_id: 5,
    message: {
      message_id: 12,
      from: { id: fromId, first_name: "Dana" },
      chat: { id: chatId, type: "supergroup" },
      text,
    },
  } as TelegramUpdate;
}

const READY = { tripAppReady: () => true, tripAppBotUsername: "Kinerary_bot" };

const dispatch = (pool: pg.Pool, update: TelegramUpdate, options: object = READY, lines: string[] = []) =>
  dispatchUpdate(pool, update, DEFAULT_STRINGS, (line) => lines.push(line), BOT, options);

class RecordingTelegram {
  calls: string[] = [];
  sent: { chatId: string; text: string; replyMarkup?: unknown }[] = [];
  pinned: string[] = [];
  unpinned: string[] = [];
  top: PinnedMessage | null = null;
  async sendMessage(params: { chatId: string; text: string; replyMarkup?: unknown }): Promise<SendResult> {
    this.sent.push(params);
    this.calls.push(`send:${this.sent.length}`);
    return { ok: true, messageId: String(this.sent.length) };
  }
  async pinChatMessage(params: { messageId: string }): Promise<boolean> {
    this.calls.push(`pin:${params.messageId}`);
    this.pinned.push(params.messageId);
    return true;
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

const deps = (telegram: RecordingTelegram) => ({
  db: {} as pg.Pool,
  telegram: telegram as unknown as TelegramClient,
  connector: { pushInbound: () => true },
  botIdentity: BOT,
  log: () => {},
});

describe("moving a group through the relay", { skip: SKIP }, () => {
  test("the organizer's /group in the old trip's group: the new trip's intro, its button, and our old pin replaced", async () => {
    await withFixture(async ({ pool, tripA, tripB }) => {
      const token = await issue(pool, tripB, DROR);
      const lines: string[] = [];
      const decision: DispatchDecision = await dispatch(pool, say(CHAT, `/group ${token}`, Number(DROR)), READY, lines);
      assert.equal(decision.kind, "group_intro");
      if (decision.kind !== "group_intro") return;
      assert.match(decision.text, /Rio-italy-2026/, "it introduces the NEW trip's assistant");
      assert.match(decision.text, /Trip italy-2026/);
      assert.ok(decision.text.includes(uiString("groupMovedNotice", "en").replace("{trip}", "Trip italy-2026")), "and says the group has moved");
      assert.equal(decision.text.includes("Trip japan-2025"), false);
      const url = decision.openTrip?.replyMarkup.inline_keyboard.flat()[0];
      assert.equal(url && "url" in url ? url.url : null, `https://t.me/Kinerary_bot?startapp=${tripB}`);
      assert.ok(lines.some((l) => l.includes("trip_bot.group_moved")), lines.join("\n"));

      // What the poller does with it: take OUR old Open-trip pin down first, then intro, then the new button.
      const telegram = new RecordingTelegram();
      telegram.top = { messageId: "41", fromId: BOT.id, text: uiString("openTripText", "en"), buttonUrls: [`https://t.me/Kinerary_bot?startapp=${tripA}`] };
      await applyDecision(decision, deps(telegram));
      assert.deepEqual(telegram.unpinned, ["41"]);
      assert.equal(telegram.sent.length, 2, "the intro and the new Open trip message");
      assert.equal(telegram.sent[1]!.text, uiString("openTripText", "en"));
      assert.deepEqual(telegram.pinned, ["1", "2"]);
      assert.ok(telegram.calls.indexOf("unpin:41") < telegram.calls.indexOf("send:1"));
    });
  });

  // ── In-memory, chat-keyed state does not cross the move (boundary review S2) ──
  describe("what the family said before the move", () => {
    const aunt = (text: string): TelegramUpdate => ({
      update_id: 6,
      message: { message_id: 13, from: { id: 31337, first_name: "Aunt" }, chat: { id: CHAT, type: "supergroup" }, text },
    }) as unknown as TelegramUpdate;
    const sayAs = (fromId: number, text: string) => say(CHAT, text, fromId);
    const textOf = (decision: DispatchDecision): string => decision.kind === "to_gateway" ? decision.event.text : `<${decision.kind}>`;

    test("control: bound to trip A, an unaddressed message IS carried onto the next addressed one", async () => {
      await withFixture(async ({ pool }) => {
        const opts = { ...READY, groupContext: new GroupContext() };
        await dispatch(pool, aunt("mum's passport is 12345678"), opts);
        const next = await dispatch(pool, sayAs(Number(DROR), "Rio-japan-2025, anything new?"), opts);
        assert.match(textOf(next), /passport is 12345678/, "sanity: the carrying works, so its absence below means something");
      });
    });

    test("after the move, trip A's overheard messages are NOT handed to trip B's companion", async () => {
      await withFixture(async ({ pool, tripB }) => {
        const groupContext = new GroupContext();
        const pendingAttachments = new PendingAttachments();
        const opts = { ...READY, groupContext, pendingAttachments };
        await dispatch(pool, aunt("mum's passport is 12345678"), opts);
        pendingAttachments.hold(CHAT, "31337", { fileId: "file-from-trip-a", kind: "document", mime: "application/pdf" });
        const moved = await dispatch(pool, sayAs(Number(DROR), `/group ${await issue(pool, tripB, DROR)}`), opts);
        assert.equal(moved.kind, "group_intro");
        const next = await dispatch(pool, sayAs(Number(DROR), "Rio-italy-2026, anything new?"), opts);
        assert.equal(next.kind, "to_gateway");
        assert.equal(textOf(next).includes("passport"), false, textOf(next));
        assert.equal(textOf(next).includes("overheard"), false);
        assert.deepEqual(pendingAttachments.take(CHAT, "31337"), [], "nor are documents held for trip A's family");
        // ...while a message said AFTER the move is carried as ever.
        await dispatch(pool, aunt("we land at 07:40"), opts);
        const later = await dispatch(pool, sayAs(Number(DROR), "Rio-italy-2026, and now?"), opts);
        assert.match(textOf(later), /we land at 07:40/);
      });
    });

    test("a re-bind of the SAME trip keeps what was overheard (nothing moved)", async () => {
      await withFixture(async ({ pool, tripA }) => {
        const opts = { ...READY, groupContext: new GroupContext() };
        await dispatch(pool, aunt("mum's passport is 12345678"), opts);
        const again = await dispatch(pool, sayAs(Number(DROR), `/group ${await issue(pool, tripA, DROR)}`), opts);
        assert.equal(again.kind, "group_intro");
        const next = await dispatch(pool, sayAs(Number(DROR), "Rio-japan-2025, anything new?"), opts);
        assert.match(textOf(next), /passport is 12345678/);
      });
    });
  });

  test("Mini App not ready: the move still happens, and nothing is unpinned or pinned beyond the intro", async () => {
    await withFixture(async ({ pool, tripB }) => {
      const token = await issue(pool, tripB, DROR);
      const decision = await dispatch(pool, say(CHAT, `/group ${token}`, Number(DROR)), { tripAppReady: () => false, tripAppBotUsername: "Kinerary_bot" });
      assert.equal(decision.kind, "group_intro");
      if (decision.kind !== "group_intro") return;
      assert.equal(decision.openTrip, undefined);
      const telegram = new RecordingTelegram();
      telegram.top = { messageId: "41", fromId: BOT.id, text: "x", buttonUrls: ["https://t.me/Kinerary_bot?startapp=trip_x"] };
      await applyDecision(decision, deps(telegram));
      assert.deepEqual(telegram.unpinned, []);
      assert.equal(telegram.calls.includes("getPinned"), false);
      const route = await resolveChatRoute(pool, CHAT);
      assert.equal(route.kind === "companion" && route.tripId, tripB);
    });
  });

  test("a non-organizer gets one uniform refusal in the group's language, the reason is logged, nothing changes", async () => {
    for (const language of ["en", "he"] as const) {
      await withFixture(async ({ pool, tripA, tripB }) => {
        const token = await issue(pool, tripB, MEMBER);
        const lines: string[] = [];
        const before = await bindings(pool);
        const decision = await dispatch(pool, say(CHAT, `/group ${token}`, Number(MEMBER)), READY, lines);
        assert.equal(decision.kind, "reply", language);
        if (decision.kind !== "reply") return;
        assert.equal(decision.reply.text, uiString("groupMoveNotOrganizer", language));
        assert.equal(decision.reply.replyMarkup, undefined);
        assert.ok(lines.some((l) => l.includes("trip_bot.group_binding_refused") && l.includes("GROUP_MOVE_NOT_ORGANIZER")), lines.join("\n"));
        assert.deepEqual(await bindings(pool), before);
        const route = await resolveChatRoute(pool, CHAT);
        assert.equal(route.kind === "companion" && route.tripId, tripA);
      }, { languageA: language });
    }
    assert.equal(uiString("groupMoveNotOrganizer", "en"), "This group belongs to another trip. Only its organizer can move it.");
    assert.match(uiString("groupMoveNotOrganizer", "he"), /[֐-׿]/);
  });

  test("the three kinds of non-move refusal read identically to the group", async () => {
    await withFixture(async ({ pool, tripB, tripC }) => {
      const replies: string[] = [];
      for (const [tripId, issuedTo, sender] of [
        [tripB, MEMBER, MEMBER],                                       // not an organizer of anything
        [tripC, STRANGER_ORGANIZER, STRANGER_ORGANIZER],                // organizer of the new trip only
        [tripC, DROR, DROR],                                            // organizer of the old trip only
      ] as const) {
        const token = await issue(pool, tripId, issuedTo);
        const decision = await dispatch(pool, say(CHAT, `/group ${token}`, Number(sender)));
        assert.equal(decision.kind, "reply");
        if (decision.kind === "reply") replies.push(decision.reply.text);
      }
      assert.deepEqual(new Set(replies).size, 1, replies.join(" | "));
    });
  });
});
