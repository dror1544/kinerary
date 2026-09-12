/**
 * "Which trips are mine, and which one is this chat wired to?"
 *
 * Two questions an organizer on a SHARED bot cannot otherwise answer. The bot
 * serves every trip from one Telegram account, so a DM that silently routes to
 * last month's trip looks identical to one routing to this month's — and the
 * provisioner deliberately REFUSES to retarget a chat already bound elsewhere
 * (`bind_chat_to_trip`'s BindingRefused), so a second provisioned trip leaves
 * the organizer's DM pointing at the first with nothing in the conversation
 * saying so. That state is not hypothetical: it is the state this deployment
 * was in when these commands were asked for.
 *
 * THE RULE THIS MODULE INHERITS, from chat-router.ts's header: the model and
 * the message never choose the trip. A command LOOKS like it carries its own
 * authority, so the discipline is stated once here and enforced in every
 * function below:
 *
 *   - Identity is the Telegram sender id from the update Telegram delivered on
 *     the bot's own authenticated connection — never a body field.
 *   - The set of trips a command may touch is derived server-side from that
 *     identity, through telegram_organizer_links (migration 0050) joined to
 *     active memberships. An argument or a tapped button SELECTS WITHIN that
 *     set; it can never widen it.
 *   - Refusals are uniform. "That trip isn't yours" and "no such trip" are the
 *     same sentence, for the reason group-binding already gives: a
 *     distinguishable refusal confirms a guess to whoever is guessing.
 */
import { randomBytes } from "node:crypto";
import type pg from "pg";
import { digestTelegramId, isPrivateChatId } from "./identity.js";

/** Closed-binding reason for a switch the organizer asked for themselves. */
export const SWITCH_CLOSED_REASON = "organizer_switch";

function bindingId(): string {
  return `tcb_${randomBytes(16).toString("hex")}`;
}

/**
 * Records that a Telegram person owns a control-plane user.
 *
 * Called inside the transaction that consumes an enrollment, because that is
 * the one moment both halves are proven at once: `consumeEnrollmentInTx`
 * returns the user the enrollment was ISSUED to, and the chat id was read by
 * the router off its own Telegram connection. Neither came from a message.
 *
 * Idempotent, and deliberately not read-before-write: redeeming another link
 * from the same chat is the ordinary case, not a conflict.
 */
export async function linkTelegramOrganizerInTx(
  client: pg.PoolClient,
  telegramUserId: string,
  userId: string,
  verifiedVia: "enrollment_redemption" | "backfill_intake_session" = "enrollment_redemption",
): Promise<void> {
  if (!isPrivateChatId(telegramUserId)) return;
  await client.query(
    `INSERT INTO control_plane.telegram_organizer_links
       (id, user_id, telegram_subject_digest, verified_via)
     VALUES ($1, $2, $3, $4)
     ON CONFLICT DO NOTHING`,
    [`tol_${randomBytes(16).toString("hex")}`, userId, digestTelegramId(telegramUserId), verifiedVia],
  );
}

export interface OrganizerTrip {
  tripId: string;
  slug: string;
  title: string | null;
  lifecycleState: string;
  reachability: string;
  /** The trip THIS chat routes to right now. At most one is true. */
  current: boolean;
  /**
   * Whether any binding for this trip carries a companion profile.
   *
   * Shown because a trip can be perfectly provisioned and still have no
   * assistant reachable from a new chat (migration 0043) — switching to it
   * succeeds and then answers `companionPending`, and an organizer who was not
   * told that reads it as the switch having failed.
   */
  hasCompanion: boolean;
}

/**
 * Every trip this Telegram person can act on, newest first, with the one this
 * chat is bound to marked.
 *
 * `chatId` is a ROUTING input only — it decides which row gets `current`, and
 * never which rows appear. That is why an organizer reading their list in one
 * chat sees the same trips as in any other.
 */
export async function listOrganizerTrips(
  db: pg.Pool,
  telegramUserId: string,
  chatId: string,
): Promise<OrganizerTrip[]> {
  if (!isPrivateChatId(telegramUserId)) return [];
  const { rows } = await db.query<{
    id: string;
    slug: string;
    title: string | null;
    lifecycle_state: string;
    reachability: string;
    current: boolean;
    has_companion: boolean;
  }>(
    `SELECT DISTINCT t.id, t.slug, t.title, t.lifecycle_state, t.reachability, t.created_at,
            EXISTS (SELECT 1 FROM control_plane.telegram_chat_bindings b
                     WHERE b.trip_id = t.id AND b.chat_id = $2 AND b.closed_at IS NULL) AS current,
            EXISTS (SELECT 1 FROM control_plane.telegram_chat_bindings hb
                     WHERE hb.trip_id = t.id AND hb.hermes_profile IS NOT NULL) AS has_companion
       FROM control_plane.trips t
       JOIN control_plane.trip_memberships m
         ON m.trip_id = t.id AND m.status = 'active'
      WHERE m.user_id IN (
              SELECT user_id FROM control_plane.telegram_organizer_links
               WHERE telegram_subject_digest = $1)
      ORDER BY t.created_at DESC`,
    [digestTelegramId(telegramUserId), chatId],
  );
  return rows.map((row) => ({
    tripId: row.id,
    slug: row.slug,
    title: row.title,
    lifecycleState: row.lifecycle_state,
    reachability: row.reachability,
    current: row.current,
    hasCompanion: row.has_companion,
  }));
}

export type SwitchOutcome =
  | {
      kind: "switched";
      tripId: string;
      previousTripId: string | null;
      /** NULL when no binding for this trip has ever carried a companion. */
      hermesProfile: string | null;
    }
  /** Already routed here. Reported separately so the reply can say so plainly. */
  | { kind: "unchanged"; tripId: string }
  | {
      kind: "refused";
      reason:
        /** Asked in a group. A group's binding belongs to the family, not to whoever typed. */
        | "NOT_PRIVATE_CHAT"
        /** Not a trip this verified sender may act on — INCLUDING one that does not exist. */
        | "NOT_YOURS"
        /** A live interview outranks a binding, so switching would appear to do nothing. */
        | "IN_INTERVIEW";
    };

/**
 * Points one chat at a different trip the sender already owns.
 *
 * PRIVATE CHATS ONLY, and that restriction is load-bearing rather than
 * cautious. On a shared bot, letting `/switch` run in a family group would let
 * any member move the whole room to another trip — possibly another
 * organizer's. The sprint plan says the same thing from the other side:
 * private selection "changes only the DM context; neither group binding
 * changes".
 *
 * A reassignment CLOSES the previous binding rather than overwriting it, which
 * is the entire point of migration 0029 — bindings are append-only and "in
 * force" is a partial unique index over the open rows. The close carries its
 * own reason, so history distinguishes an organizer's own switch from a
 * provisioner move.
 *
 * The new row inherits the trip's companion profile the same way
 * `redeemGroupBindingToken` does: from the most recent binding that has one.
 * When the trip has never had a binding with a profile, the row is written
 * with NULL rather than refused — migration 0043's rule is that routing and
 * the assistant behind it are separate, separately retryable components, and
 * the provisioner's `attach_profile_to_orphan_bindings` fills exactly this gap
 * on the next provision. Refusing instead would leave an organizer with a
 * provisioned trip they can never point their DM at.
 */
export async function switchChatToTrip(
  db: pg.Pool,
  telegramUserId: string,
  chatId: string,
  tripId: string,
): Promise<SwitchOutcome> {
  // Both halves must be the private shape: the chat because a group binding is
  // not one person's to move, and the sender because a digest of anything else
  // is not an identity.
  if (!isPrivateChatId(chatId) || !isPrivateChatId(telegramUserId)) {
    return { kind: "refused", reason: "NOT_PRIVATE_CHAT" };
  }

  const client = await db.connect();
  try {
    await client.query("BEGIN");

    // A live interview outranks a binding in `resolveChatRoute`, so a switch
    // applied underneath one would look like it did nothing at all. Checked
    // before anything is written, and reported rather than silently applied.
    const live = await client.query(
      `SELECT 1 FROM control_plane.intake_sessions
        WHERE telegram_chat_id = $1 AND state <> 'confirmed'`,
      [chatId],
    );
    if (live.rowCount) {
      await client.query("ROLLBACK");
      return { kind: "refused", reason: "IN_INTERVIEW" };
    }

    // The authorization, and the only one. Derived from the digest of the id
    // Telegram delivered — never from the argument, which is being checked
    // AGAINST this set rather than trusted to name it.
    const owned = await client.query(
      `SELECT 1
         FROM control_plane.trip_memberships m
        WHERE m.trip_id = $1
          AND m.status = 'active'
          AND m.user_id IN (
                SELECT user_id FROM control_plane.telegram_organizer_links
                 WHERE telegram_subject_digest = $2)
        LIMIT 1`,
      [tripId, digestTelegramId(telegramUserId)],
    );
    if (!owned.rowCount) {
      await client.query("ROLLBACK");
      // Same answer a non-existent trip gets. See the header.
      return { kind: "refused", reason: "NOT_YOURS" };
    }

    // FOR UPDATE so two taps of the same button serialise here rather than
    // both believing they closed the incumbent. 0029's partial unique index is
    // the backstop if they somehow don't.
    const openRow = await client.query<{ id: string; trip_id: string; hermes_profile: string | null }>(
      `SELECT id, trip_id, hermes_profile
         FROM control_plane.telegram_chat_bindings
        WHERE chat_id = $1 AND closed_at IS NULL
        FOR UPDATE`,
      [chatId],
    );
    const existing = openRow.rows[0];
    if (existing && existing.trip_id === tripId) {
      await client.query("ROLLBACK");
      return { kind: "unchanged", tripId };
    }

    if (existing) {
      await client.query(
        `UPDATE control_plane.telegram_chat_bindings
            SET closed_at = now(), closed_reason = $2
          WHERE id = $1`,
        [existing.id, SWITCH_CLOSED_REASON],
      );
    }

    const profileRow = await client.query<{ hermes_profile: string }>(
      `SELECT hermes_profile
         FROM control_plane.telegram_chat_bindings
        WHERE trip_id = $1 AND hermes_profile IS NOT NULL
        ORDER BY created_at DESC
        LIMIT 1`,
      [tripId],
    );
    const hermesProfile = profileRow.rows[0]?.hermes_profile ?? null;

    await client.query(
      `INSERT INTO control_plane.telegram_chat_bindings (id, chat_id, trip_id, hermes_profile)
       VALUES ($1, $2, $3, $4)`,
      [bindingId(), chatId, tripId, hermesProfile],
    );

    await client.query("COMMIT");
    return {
      kind: "switched",
      tripId,
      previousTripId: existing?.trip_id ?? null,
      hermesProfile,
    };
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}
