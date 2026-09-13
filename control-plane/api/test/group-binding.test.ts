import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { describe, test } from "node:test";
import { fileURLToPath } from "node:url";
import pg from "pg";
import { applyMigrations } from "../src/migrations.js";
import {
  GROUP_BINDING_TOKEN_PATTERN,
  extractGroupBindingToken,
  issueGroupBindingToken,
  redeemGroupBindingToken,
} from "../src/group-binding.js";
import { resolveChatRoute } from "../src/chat-router.js";
import { testDatabaseUrl } from "./support/test-database.js";

const databaseUrl = testDatabaseUrl();
const SKIP = !databaseUrl;
const migrationsDir = fileURLToPath(new URL("../../db/migrations/", import.meta.url));

const testId = (p: string) => `${p}_${randomBytes(16).toString("hex")}`;

interface Fixture { pool: pg.Pool; tripId: string; otherTripId: string }

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
    const tripId = testId("trip");
    const otherTripId = testId("trip");
    for (const id of [tripId, otherTripId]) {
      await pool.query(
        "INSERT INTO control_plane.trips(id, slug, lifecycle_state) VALUES ($1, $2, 'ready_private')",
        [id, id.replace(/_/g, "-")],
      );
    }
    await fn({ pool, tripId, otherTripId });
  } finally {
    await pool.end();
  }
}

describe("extractGroupBindingToken", () => {
  test("finds the token in a message the organizer pasted with other words", () => {
    // People paste. The token has to survive "here you go: KIN-ABCD2345 👍".
    const token = "KIN-ABCD2345";
    assert.equal(extractGroupBindingToken(`here you go: ${token} 👍`), token);
    assert.equal(extractGroupBindingToken(token), token);
    assert.equal(extractGroupBindingToken(`${token}\n`), token);
  });

  test("is case-insensitive on the way in, canonical on the way out", () => {
    // Phone keyboards autocapitalise and autocorrect. Refusing a lowercase
    // paste would be a support request, not a security boundary — the secret
    // is the random part, and it is matched against a digest either way.
    assert.equal(extractGroupBindingToken("kin-abcd2345"), "KIN-ABCD2345");
  });

  test("the ambiguous characters are not in the alphabet at all", () => {
    // I, O, 0 and 1 are excluded because this gets read off one screen and
    // typed into another, sometimes from a photo of a phone. A token
    // containing them was never issued, so it should not match either.
    assert.equal(extractGroupBindingToken("KIN-ABCD1234"), null, "1 is excluded");
    assert.equal(extractGroupBindingToken("KIN-ABCD0234"), null, "0 is excluded");
    assert.equal(extractGroupBindingToken("KIN-ABCDI234"), null, "I is excluded");
    assert.equal(extractGroupBindingToken("KIN-ABCDO234"), null, "O is excluded");
  });

  test("ignores ordinary conversation", () => {
    assert.equal(extractGroupBindingToken("what time is dinner?"), null);
    assert.equal(extractGroupBindingToken("KIN-"), null);
    assert.equal(extractGroupBindingToken("KIN-SHORT"), null);
    assert.equal(extractGroupBindingToken(""), null);
  });

  test("the pattern is anchored enough not to match a URL fragment", () => {
    assert.equal(GROUP_BINDING_TOKEN_PATTERN.test("https://x.example/KIN-ABCD2345"), false);
  });
});

describe("group binding tokens", { skip: SKIP }, () => {
  test("a token binds the group it is posted in", async () => {
    await withFixture(async ({ pool, tripId }) => {
      const issued = await issueGroupBindingToken(pool, tripId, "777", { ttlSeconds: 3600 });
      assert.ok(issued.ok);
      if (!issued.ok) return;

      const result = await redeemGroupBindingToken(pool, issued.token, "-1002000111", "777");
      assert.equal(result.ok, true);
      if (!result.ok) return;
      assert.equal(result.tripId, tripId);

      const route = await resolveChatRoute(pool, "-1002000111");
      assert.equal(route.kind, "companion");
      if (route.kind !== "companion") return;
      assert.equal(route.tripId, tripId);
    });
  });

  test("a token posted by anyone other than the organizer binds nothing", async () => {
    // The property that makes a leaked or forwarded token harmless. The token
    // is issued into the organizer's own DM, so the sender is always known —
    // there is no case where this check has to be skipped.
    await withFixture(async ({ pool, tripId }) => {
      const issued = await issueGroupBindingToken(pool, tripId, "777", { ttlSeconds: 3600 });
      assert.ok(issued.ok);
      if (!issued.ok) return;

      const result = await redeemGroupBindingToken(pool, issued.token, "-1002000222", "999");
      assert.equal(result.ok, false);
      if (result.ok) return;
      assert.equal(result.reason, "WRONG_SENDER");
      assert.equal((await resolveChatRoute(pool, "-1002000222")).kind, "unbound");
    });
  });

  test("posting it again re-runs the binding rather than failing", async () => {
    // The organizer is told to make the bot an admin BEFORE posting. They will
    // sometimes forget, and the recovery has to be "post it again" — a
    // single-use token would turn a forgotten step into a support request.
    await withFixture(async ({ pool, tripId }) => {
      const issued = await issueGroupBindingToken(pool, tripId, "777", { ttlSeconds: 3600 });
      assert.ok(issued.ok);
      if (!issued.ok) return;

      const first = await redeemGroupBindingToken(pool, issued.token, "-1002000333", "777");
      assert.equal(first.ok, true);
      const second = await redeemGroupBindingToken(pool, issued.token, "-1002000333", "777");
      assert.equal(second.ok, true);
      if (!second.ok) return;
      assert.equal(second.rebound, true, "the second says it was already bound");
      assert.equal((await resolveChatRoute(pool, "-1002000333")).kind, "companion");
    });
  });

  test("it will not steal a group that belongs to another trip", async () => {
    // Fail closed. On a shared bot the group being taken belongs to a real
    // family, and a token is not authority over a binding somebody else made.
    await withFixture(async ({ pool, tripId, otherTripId }) => {
      const chatId = "-1002000444";
      await pool.query(
        `INSERT INTO control_plane.telegram_chat_bindings(id, chat_id, trip_id, hermes_profile)
         VALUES ('tcb_' || md5(random()::text), $1, $2, 'companion-other')`,
        [chatId, otherTripId],
      );

      const issued = await issueGroupBindingToken(pool, tripId, "777", { ttlSeconds: 3600 });
      assert.ok(issued.ok);
      if (!issued.ok) return;

      const result = await redeemGroupBindingToken(pool, issued.token, chatId, "777");
      assert.equal(result.ok, false);
      if (result.ok) return;
      assert.equal(result.reason, "CHAT_BOUND_ELSEWHERE");

      const route = await resolveChatRoute(pool, chatId);
      assert.equal(route.kind === "companion" && route.tripId, otherTripId, "the other trip keeps it");
    });
  });

  test("an expired token binds nothing", async () => {
    await withFixture(async ({ pool, tripId }) => {
      const issued = await issueGroupBindingToken(pool, tripId, "777", { ttlSeconds: 3600 });
      assert.ok(issued.ok);
      if (!issued.ok) return;
      // Age the whole row, not just its expiry: the table's own CHECK forbids
      // a token that expires before it was created, which is the right
      // constraint and means "expired" has to be modelled as "issued a while
      // ago" rather than as an impossible row.
      await pool.query(
        `UPDATE control_plane.telegram_group_binding_tokens
            SET created_at = now() - interval '2 hours',
                expires_at = now() - interval '1 hour'`,
      );

      const result = await redeemGroupBindingToken(pool, issued.token, "-1002000555", "777");
      assert.equal(result.ok, false);
      if (result.ok) return;
      assert.equal(result.reason, "EXPIRED");
    });
  });

  test("an unknown token is refused without saying why it is unknown", async () => {
    await withFixture(async ({ pool }) => {
      const result = await redeemGroupBindingToken(pool, "KIN-ZZZZ9999", "-1002000666", "777");
      assert.equal(result.ok, false);
      if (result.ok) return;
      assert.equal(result.reason, "NOT_FOUND");
    });
  });

  test("asking again supersedes the previous token rather than adding one", async () => {
    // An organizer who lost the message should not end up with several valid
    // tokens in circulation and no idea which is current.
    await withFixture(async ({ pool, tripId }) => {
      const first = await issueGroupBindingToken(pool, tripId, "777", { ttlSeconds: 3600 });
      const second = await issueGroupBindingToken(pool, tripId, "777", { ttlSeconds: 3600 });
      assert.ok(first.ok && second.ok);
      if (!first.ok || !second.ok) return;
      assert.notEqual(first.token, second.token);

      const { rowCount } = await pool.query(
        "SELECT 1 FROM control_plane.telegram_group_binding_tokens WHERE trip_id = $1",
        [tripId],
      );
      assert.equal(rowCount, 1, "one live token per trip");

      const stale = await redeemGroupBindingToken(pool, first.token, "-1002000777", "777");
      assert.equal(stale.ok, false, "the superseded one stops working");
      const live = await redeemGroupBindingToken(pool, second.token, "-1002000777", "777");
      assert.equal(live.ok, true);
    });
  });

  test("a token is not redeemable in a private chat", async () => {
    // Binding the organizer's own DM to their trip is provisioning's job and
    // already done. A token redeemed in a DM would at best be a no-op and at
    // worst rebind the channel the token itself arrived on.
    await withFixture(async ({ pool, tripId }) => {
      const issued = await issueGroupBindingToken(pool, tripId, "777", { ttlSeconds: 3600 });
      assert.ok(issued.ok);
      if (!issued.ok) return;
      const result = await redeemGroupBindingToken(pool, issued.token, "777", "777");
      assert.equal(result.ok, false);
      if (result.ok) return;
      assert.equal(result.reason, "NOT_A_GROUP");
    });
  });
});
