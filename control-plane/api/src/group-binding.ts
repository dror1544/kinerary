/**
 * Binding a family group to a trip, with a token the organizer posts there.
 *
 * THE PROBLEM. A group cannot be bound from the organizer's DM — the control
 * plane has no idea which group they mean. And it cannot be bound from inside
 * the group either, because nothing said in a group proves who the organizer
 * is, and on a shared bot "whoever spoke first" would hand one family's trip to
 * another.
 *
 * The token crosses that gap. It is issued into a channel where the organizer's
 * identity is already established (their own DM), and redeemed in the group,
 * which proves they are in it. Two facts, each learned where it is actually
 * knowable.
 *
 * WHY IT IS REUSABLE. The organizer is told to make the bot an admin BEFORE
 * posting, because pinning and reading an invite link both need that. They will
 * sometimes forget, and the recovery has to be "post it again" — a token that
 * burned itself on first use would turn a forgotten step into a support
 * request. Re-posting re-runs the arrival: bind, greet, pin.
 *
 * WHAT MAKES A LEAKED TOKEN HARMLESS. `issued_to_telegram_user_id`. The token
 * alone would let anyone who saw it bind any group they are in; requiring the
 * sender to be the organizer it was issued to means a forwarded or
 * screenshotted token binds nothing. There is no case where that check has to
 * be skipped, because the token is handed over in the organizer's own DM and so
 * the recipient is always known.
 */
import { createHash, randomBytes } from "node:crypto";
import type pg from "pg";

/**
 * `KIN-` plus eight unambiguous characters.
 *
 * Excludes I, O, 0 and 1: this is read off one screen and typed or pasted into
 * another, sometimes from a photo of a phone. The entropy lost is irrelevant —
 * the token is single-trip, expiring, and only usable by one known sender —
 * next to the cost of a family stuck on a character they cannot tell apart.
 */
const TOKEN_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
const TOKEN_LENGTH = 8;

/**
 * Matches a token as a standalone word.
 *
 * The lookarounds are what stop it matching inside a URL or a longer string:
 * a token is something the organizer pasted, not a fragment of something else.
 */
export const GROUP_BINDING_TOKEN_PATTERN = new RegExp(
  `(?<![A-Za-z0-9/_-])KIN-([${TOKEN_ALPHABET}]{${TOKEN_LENGTH}})(?![A-Za-z0-9-])`,
  "i",
);

function sha256hex(input: string): string {
  return createHash("sha256").update(input).digest("hex");
}

function tokenDigest(token: string): string {
  return `sha256:${sha256hex(token.toUpperCase())}`;
}

function newToken(): string {
  const bytes = randomBytes(TOKEN_LENGTH);
  let out = "";
  for (let i = 0; i < TOKEN_LENGTH; i += 1) {
    out += TOKEN_ALPHABET[bytes[i]! % TOKEN_ALPHABET.length];
  }
  return `KIN-${out}`;
}

/**
 * The binding token in a message, canonicalised, or null if there is none.
 *
 * Case-insensitive on the way in and upper-case on the way out: phone keyboards
 * autocapitalise and autocorrect, and refusing a lowercase paste would be a
 * support request rather than a security boundary. The secret is the random
 * part, and it is matched against a digest either way.
 */
export function extractGroupBindingToken(text: string | null | undefined): string | null {
  const match = GROUP_BINDING_TOKEN_PATTERN.exec(text ?? "");
  return match ? `KIN-${match[1]!.toUpperCase()}` : null;
}

export type GroupBindingIssueResult =
  | { ok: true; token: string; expiresAt: Date }
  | { ok: false; reason: "TRIP_NOT_FOUND" };

export interface GroupBindingConfig {
  ttlSeconds: number;
}

/**
 * Issues (or replaces) the trip's group-binding token.
 *
 * One live token per trip: asking again supersedes rather than accumulates, so
 * an organizer who lost the message cannot end up with several valid tokens in
 * circulation and no way to tell which is current.
 */
export async function issueGroupBindingToken(
  db: pg.Pool,
  tripId: string,
  telegramUserId: string,
  config: GroupBindingConfig,
): Promise<GroupBindingIssueResult> {
  const trip = await db.query("SELECT 1 FROM control_plane.trips WHERE id = $1", [tripId]);
  if (!trip.rowCount) return { ok: false, reason: "TRIP_NOT_FOUND" };

  const token = newToken();
  const expiresAt = new Date(Date.now() + config.ttlSeconds * 1000);
  await db.query(
    `INSERT INTO control_plane.telegram_group_binding_tokens
       (id, trip_id, token_digest, issued_to_telegram_user_id, expires_at)
     VALUES ($1, $2, $3, $4, $5)
     ON CONFLICT (trip_id) DO UPDATE
        SET token_digest = EXCLUDED.token_digest,
            issued_to_telegram_user_id = EXCLUDED.issued_to_telegram_user_id,
            expires_at = EXCLUDED.expires_at,
            created_at = now(),
            last_used_at = NULL,
            use_count = 0`,
    [`gbt_${randomBytes(16).toString("hex")}`, tripId, tokenDigest(token), telegramUserId, expiresAt],
  );
  return { ok: true, token, expiresAt };
}

export type GroupBindingRedeemResult =
  | { ok: true; tripId: string; rebound: boolean }
  | {
      ok: false;
      reason: "NOT_FOUND" | "EXPIRED" | "WRONG_SENDER" | "CHAT_BOUND_ELSEWHERE" | "NOT_A_GROUP";
    };

/**
 * Redeems a token posted in a group, binding that group to the token's trip.
 *
 * Refuses a chat already bound to a DIFFERENT trip. On a shared bot the group
 * being taken belongs to a real family, and a token is not authority over a
 * binding somebody else made — the organizer of the other trip never agreed to
 * lose it. Rebinding the SAME trip is the supported path and reports
 * `rebound: true` so the caller can greet again without claiming it is new.
 */
export async function redeemGroupBindingToken(
  db: pg.Pool,
  token: string,
  chatId: string,
  senderTelegramUserId: string,
): Promise<GroupBindingRedeemResult> {
  // A group chat id is negative on Telegram; a private one is the user's own
  // id. Binding a DM here would at best be a no-op and at worst rebind the very
  // channel the token arrived on.
  if (!chatId.startsWith("-")) return { ok: false, reason: "NOT_A_GROUP" };

  const client = await db.connect();
  try {
    await client.query("BEGIN");
    const { rows } = await client.query<{
      trip_id: string;
      issued_to_telegram_user_id: string;
      expired: boolean;
    }>(
      `SELECT trip_id, issued_to_telegram_user_id, expires_at <= now() AS expired
         FROM control_plane.telegram_group_binding_tokens
        WHERE token_digest = $1
        FOR UPDATE`,
      [tokenDigest(token)],
    );
    const row = rows[0];
    if (!row) {
      await client.query("ROLLBACK");
      return { ok: false, reason: "NOT_FOUND" };
    }
    if (row.issued_to_telegram_user_id !== senderTelegramUserId) {
      await client.query("ROLLBACK");
      return { ok: false, reason: "WRONG_SENDER" };
    }
    if (row.expired) {
      await client.query("ROLLBACK");
      return { ok: false, reason: "EXPIRED" };
    }

    const existing = await client.query<{ trip_id: string }>(
      `SELECT trip_id FROM control_plane.telegram_chat_bindings
        WHERE chat_id = $1 AND closed_at IS NULL`,
      [chatId],
    );
    const bound = existing.rows[0];
    if (bound && bound.trip_id !== row.trip_id) {
      await client.query("ROLLBACK");
      return { ok: false, reason: "CHAT_BOUND_ELSEWHERE" };
    }

    if (!bound) {
      await client.query(
        `INSERT INTO control_plane.telegram_chat_bindings
           (id, chat_id, trip_id, hermes_profile)
         SELECT $1, $2, $3, b.hermes_profile
           FROM control_plane.telegram_chat_bindings b
          WHERE b.trip_id = $3 AND b.hermes_profile IS NOT NULL
          ORDER BY b.created_at DESC
          LIMIT 1`,
        [`tcb_${randomBytes(16).toString("hex")}`, chatId, row.trip_id],
      );
      // The trip may have no companion installed yet (migration 0043). Bind it
      // anyway: routing and the assistant behind it are separate components,
      // separately retryable, and a bound chat with no profile answers
      // COMPANION_PENDING rather than "I don't have a trip for this chat".
      const created = await client.query(
        "SELECT 1 FROM control_plane.telegram_chat_bindings WHERE chat_id = $1 AND closed_at IS NULL",
        [chatId],
      );
      if (!created.rowCount) {
        await client.query(
          `INSERT INTO control_plane.telegram_chat_bindings (id, chat_id, trip_id, hermes_profile)
           VALUES ($1, $2, $3, NULL)`,
          [`tcb_${randomBytes(16).toString("hex")}`, chatId, row.trip_id],
        );
      }
    }

    await client.query(
      `UPDATE control_plane.telegram_group_binding_tokens
          SET last_used_at = now(), use_count = use_count + 1
        WHERE token_digest = $1`,
      [tokenDigest(token)],
    );
    await client.query("COMMIT");
    return { ok: true, tripId: row.trip_id, rebound: Boolean(bound) };
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}
