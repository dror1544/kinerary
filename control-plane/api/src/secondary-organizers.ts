/**
 * SECONDARY ORGANIZERS (#523): a second person who organizes ONE trip from Telegram, added by the trip's main organizer
 * with a one-time trip link.
 *
 * WHAT A SECONDARY ORGANIZER IS. A Telegram account bound to one trip with the role of organizer. Not a second owner, not a
 * Kinerary account the person signs up for, and nothing on the dashboard: they organize the trip from the bot, open its
 * organizer view on the trip site, and see no other trip. Concretely the binding is four rows made in one transaction
 * (`redeemSecondaryOrganizerToken`):
 *
 *   - `trip_secondary_organizers`  the binding itself, keyed by the Telegram account's digest;
 *   - a hidden `users` row         no email, no credential: the same kind of row a site-invite member already gets;
 *   - a `trip_memberships` row     role 'organizer', dashboard_access = false, runtime_access = true. The false is what makes
 *                                  every dashboard route refuse them (portal.ts answers 404 to a membership without it) and
 *                                  the true is what lets the runtime gateway launch them into the trip;
 *   - a `telegram_member_links`    row, so the Telegram Mini App signs the account in as that hidden user, scoped to this one
 *                                  trip (portal-scope.ts), exactly as it does for a member who linked their Telegram.
 *
 * WHO MAY ADD ONE. Only the trip's MAIN organizer: its active OWNER with dashboard access (`tripOfMainOrganizer`). Not an
 * 'organizer'-role membership, not a secondary organizer, not a member. The check runs at issue time AND again, under a lock,
 * at redemption, so a link whose issuer has since lost the trip is spent and worthless.
 *
 * WHAT DECIDES WHO THE OPENER IS. The update's private-chat sender id, read off the bot's own authenticated connection by the
 * router (dispatch.ts) and handed in here. Never the message text, never the token. The token proves only that the main
 * organizer chose to hand this link out; whoever holds it for its few minutes becomes the secondary organizer, which is why it
 * is single use, short lived, bound to one trip, and why the main organizer is told who joined (first name and @username) and
 * can remove them at once.
 *
 * REFUSALS ARE UNIFORM, as for `lk_`: expired, used, revoked, unknown, the issuer no longer the owner, a retired trip are all
 * `INVALID`, so a failure confirms nothing about a guess. The two answers that are NOT refusals of the link are "you already
 * organize this trip" (the opener is the main organizer's own Telegram, or one that already organizes it): said to the opener,
 * who holds the link, and the link is left unspent.
 *
 * REMOVAL (`removeSecondaryOrganizer`) is the main organizer's and takes effect at once: the binding is revoked, the
 * membership ends (a database trigger then revokes the member link and the sessions it minted), launch grants are spent and the
 * Telegram account's hold on the trip (its companion DM route) is closed. The trip site's own session ends at the runtime
 * gateway's next liveness check against the membership (runtime-gateway/server.js `sessionLive`).
 */
import { createHash, randomBytes } from "node:crypto";
import type pg from "pg";
import { digestTelegramId, isPrivateChatId, type TelegramName } from "./identity.js";
import { LIVE_INTAKE_SESSION_PREDICATE, boundTelegramAccounts, privateChatForDigest } from "./organizer-trips.js";
import { NOT_RETIRED_SQL } from "./trip-retirement.js";

/** How long an issued trip link works. Short on purpose; issuing another is one click. */
export const SECONDARY_ORGANIZER_TOKEN_TTL_SECONDS = 15 * 60;

/**
 * `so_` + 32 base64url characters = 35, inside Telegram's 64-character `start` alphabet. Not `lk_` (the account link) and not
 * an enrollment token (43), so the three can never be confused by prefix or length.
 */
export const SECONDARY_TOKEN_PATTERN = /^so_[A-Za-z0-9_-]{32}$/;

const sha = (raw: string) => `sha256:${createHash("sha256").update(raw).digest("hex")}`;
const opaque = (prefix: string) => `${prefix}_${randomBytes(16).toString("hex")}`;

/** The token a `/start` payload carries, or null when it is not a trip link. */
export function secondaryOrganizerTokenFromStartPayload(payload: string | null): string | null {
  return payload !== null && SECONDARY_TOKEN_PATTERN.test(payload) ? payload : null;
}

/**
 * The ONE answer to "is this user the MAIN organizer of this trip today": an active OWNER membership with dashboard access, of
 * an active user, on a trip that is not retired or torn down. Issuing, redeeming and removing all ask it, so the three cannot
 * drift apart. Returns the trip's title or null (callers answer "no", "not yours" and "no such trip" the same). `lock` takes the
 * membership row, so a concurrent membership end serialises.
 */
export async function tripOfMainOrganizer(client: Pick<pg.PoolClient, "query">, userId: string, tripId: string, lock: boolean): Promise<string | null> {
  const result = await client.query<{ title: string }>(
    `SELECT COALESCE(t.title, t.destination_label, 'Untitled trip') AS title
       FROM control_plane.trip_memberships m
       JOIN control_plane.trips t ON t.id = m.trip_id
       JOIN control_plane.users u ON u.id = m.user_id AND u.status = 'active'
      WHERE m.trip_id = $1 AND m.user_id = $2 AND m.status = 'active'
        AND m.role = 'owner' AND m.dashboard_access = true
        AND ${NOT_RETIRED_SQL}
        AND NOT EXISTS (
              SELECT 1 FROM control_plane.telegram_chat_bindings d
               WHERE d.trip_id = t.id AND d.closed_reason = 'trip_destroyed')
      ${lock ? "FOR UPDATE OF m" : ""}`,
    [tripId, userId],
  );
  return result.rows[0]?.title ?? null;
}

// ── Issue ────────────────────────────────────────────────────────────────────

export type IssueSecondaryTokenResult =
  | { ok: true; token: string; expiresAt: Date }
  /** Not a trip this user is the main organizer of (including one that does not exist, is retired or torn down). */
  | { ok: false; reason: "NOT_FOUND" };

/**
 * Issues a trip link for `tripId` to its main organizer. At most one live link per (trip, issuer): a new one revokes the
 * previous, so a link sent to the wrong person is replaced by asking again.
 */
export async function issueSecondaryOrganizerToken(
  db: pg.Pool,
  input: { userId: string; tripId: string; ttlSeconds?: number },
): Promise<IssueSecondaryTokenResult> {
  const ttl = input.ttlSeconds ?? SECONDARY_ORGANIZER_TOKEN_TTL_SECONDS;
  const client = await db.connect();
  try {
    await client.query("BEGIN");
    if ((await tripOfMainOrganizer(client, input.userId, input.tripId, true)) === null) {
      await client.query("ROLLBACK");
      return { ok: false, reason: "NOT_FOUND" };
    }
    await client.query("DELETE FROM control_plane.trip_secondary_organizer_tokens WHERE state <> 'issued' AND created_at < now() - interval '1 day'");
    await client.query(
      "UPDATE control_plane.trip_secondary_organizer_tokens SET state = 'revoked' WHERE trip_id = $1 AND issued_by = $2 AND state = 'issued'",
      [input.tripId, input.userId],
    );
    const token = `so_${randomBytes(24).toString("base64url")}`;
    const expiresAt = new Date(Date.now() + ttl * 1000);
    await client.query(
      `INSERT INTO control_plane.trip_secondary_organizer_tokens (id, trip_id, issued_by, token_digest, expires_at)
       VALUES ($1, $2, $3, $4, $5)`,
      [opaque("tsot"), input.tripId, input.userId, sha(token), expiresAt],
    );
    await client.query("COMMIT");
    return { ok: true, token, expiresAt };
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

// ── Redeem ───────────────────────────────────────────────────────────────────

export type RedeemSecondaryResult =
  | {
      ok: true;
      tripId: string;
      tripTitle: string;
      /** The Telegram account already organized this trip as a secondary organizer: the link is spent, nothing else changed. */
      alreadyJoined: boolean;
      /** Who to tell, in their own chat: the main organizer's private chat, or null when none can be reached. */
      toMainOrganizer: { chatId: string; userId: string } | null;
      joined: TelegramName | null;
    }
  /** The opener already organizes this trip (the main organizer's own Telegram, or any live organizer link on it). The link is NOT spent. */
  | { ok: false; reason: "ALREADY_ORGANIZER"; tripTitle: string }
  | { ok: false; reason: "INVALID" };

/**
 * Redeems a trip link for the Telegram account that sent it. `telegramUserId` is the update's verified sender and must be a
 * private-chat id; anything else is refused without touching the token, so a link opened in a group stays usable in the DM.
 *
 * Everything is re-checked at redemption, not trusted from issue time (the issuer must STILL be the trip's main organizer),
 * and consuming the token and making the binding are one transaction, so a link is never left half made.
 */
export async function redeemSecondaryOrganizerToken(
  db: pg.Pool,
  rawToken: string,
  telegramUserId: string,
  /** First name and @username from the update's verified `from`. Display data only, never a decision. */
  telegramName: TelegramName | null = null,
): Promise<RedeemSecondaryResult> {
  if (!SECONDARY_TOKEN_PATTERN.test(rawToken) || !isPrivateChatId(telegramUserId)) return { ok: false, reason: "INVALID" };
  const digest = digestTelegramId(telegramUserId);
  const client = await db.connect();
  try {
    await client.query("BEGIN");
    const row = await client.query<{ id: string; trip_id: string; issued_by: string; state: string; expires_at: Date }>(
      `SELECT id, trip_id, issued_by, state, expires_at
         FROM control_plane.trip_secondary_organizer_tokens WHERE token_digest = $1 FOR UPDATE`,
      [sha(rawToken)],
    );
    const token = row.rows[0];
    if (!token || token.state !== "issued" || token.expires_at.getTime() <= Date.now()) {
      await client.query("ROLLBACK");
      return { ok: false, reason: "INVALID" };
    }
    const tripTitle = await tripOfMainOrganizer(client, token.issued_by, token.trip_id, true);
    if (tripTitle === null) {
      // The issuer is no longer the main organizer: the token is worthless, and now spent.
      await client.query("UPDATE control_plane.trip_secondary_organizer_tokens SET state = 'revoked' WHERE id = $1", [token.id]);
      await client.query("COMMIT");
      return { ok: false, reason: "INVALID" };
    }

    // Already an organizer of this trip? The main organizer's own Telegram (or another bound to the account for this trip), or
    // any live organizer link of this trip. Not a secondary organizer's business: said to the opener, link left for its owner.
    const main = await boundTelegramAccounts(client, token.issued_by, token.trip_id);
    const linked = await client.query(
      `SELECT 1 FROM control_plane.telegram_organizer_trip_links
        WHERE trip_id = $1 AND telegram_subject_digest = $2 AND revoked_at IS NULL LIMIT 1`,
      [token.trip_id, digest],
    );
    if (main.some((account) => account.digest === digest) || linked.rowCount) {
      await client.query("ROLLBACK");
      return { ok: false, reason: "ALREADY_ORGANIZER", tripTitle };
    }

    const existing = await client.query<{ id: string }>(
      `SELECT s.id FROM control_plane.trip_secondary_organizers s
         JOIN control_plane.trip_memberships m ON m.trip_id = s.trip_id AND m.user_id = s.user_id AND m.status = 'active'
        WHERE s.trip_id = $1 AND s.telegram_subject_digest = $2 AND s.revoked_at IS NULL`,
      [token.trip_id, digest],
    );
    let secondaryId = existing.rows[0]?.id ?? null;
    const alreadyJoined = secondaryId !== null;
    if (!secondaryId) {
      secondaryId = opaque("tso");
      const userId = opaque("user");
      const memberLinkId = opaque("tml");
      const name = (telegramName?.firstName ?? "").trim().slice(0, 120) || "Organizer";
      // A previous binding of this account whose membership ended is history; its row stays revoked. Any live row that
      // outlived its membership is closed here so the unique index lets the new one in.
      await client.query(
        `UPDATE control_plane.trip_secondary_organizers SET revoked_at = now(), revoked_reason = 'membership_ended'
          WHERE trip_id = $1 AND telegram_subject_digest = $2 AND revoked_at IS NULL`,
        [token.trip_id, digest],
      );
      await client.query("INSERT INTO control_plane.users(id, status, display_name) VALUES ($1, 'active', $2)", [userId, name]);
      await client.query(
        `INSERT INTO control_plane.trip_memberships(id, trip_id, user_id, role, status, dashboard_access, runtime_access)
         VALUES ($1, $2, $3, 'organizer', 'active', false, true)`,
        [opaque("memb"), token.trip_id, userId],
      );
      await client.query(
        `INSERT INTO control_plane.telegram_member_links
           (id, user_id, trip_id, telegram_subject_digest, verified_via, telegram_first_name, telegram_username)
         VALUES ($1, $2, $3, $4, 'secondary_organizer_link', $5, $6)`,
        [memberLinkId, userId, token.trip_id, digest, telegramName?.firstName ?? null, telegramName?.username ?? null],
      );
      await client.query(
        `INSERT INTO control_plane.trip_secondary_organizers
           (id, trip_id, user_id, member_link_id, telegram_subject_digest, telegram_first_name, telegram_username, added_by)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
        [secondaryId, token.trip_id, userId, memberLinkId, digest, telegramName?.firstName ?? null, telegramName?.username ?? null, token.issued_by],
      );
    }
    await client.query(
      "UPDATE control_plane.trip_secondary_organizer_tokens SET state = 'consumed', consumed_at = now(), consumed_secondary_id = $2 WHERE id = $1",
      [token.id, secondaryId],
    );
    // The main organizer's chat: the first bound Telegram account that can be reached (this trip's own first).
    let toMain: { chatId: string; userId: string } | null = null;
    if (!alreadyJoined) {
      for (const account of main) {
        const chatId = await privateChatForDigest(client, token.issued_by, account.digest);
        if (chatId) { toMain = { chatId, userId: token.issued_by }; break; }
      }
    }
    await client.query("COMMIT");
    return { ok: true, tripId: token.trip_id, tripTitle, alreadyJoined, toMainOrganizer: toMain, joined: telegramName };
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

/**
 * Gives the new secondary organizer's private chat its route to the trip's companion, so organizing starts where they are:
 * a NEW open chat binding with the trip's profile. Best effort and never an error to the redemption that preceded it: only a
 * chat that is FREE (no open binding to any trip, no live interview) is bound. Otherwise `/trips` and `/switch` reach the trip,
 * because the secondary organizer is in that list.
 *
 * Its own transaction, after the redemption's has committed, so the chat-binding lock does not sit inside the redemption's
 * (teardown takes chat bindings, then the trip row; the redemption wrote rows that take a lock on the trip).
 */
export async function bindSecondaryOrganizerChat(db: pg.Pool, chatId: string, tripId: string): Promise<boolean> {
  if (!isPrivateChatId(chatId)) return false;
  const client = await db.connect();
  try {
    await client.query("BEGIN");
    const open = await client.query("SELECT 1 FROM control_plane.telegram_chat_bindings WHERE chat_id = $1 AND closed_at IS NULL FOR UPDATE", [chatId]);
    const interview = await client.query(`SELECT 1 FROM control_plane.intake_sessions WHERE ${LIVE_INTAKE_SESSION_PREDICATE}`, [chatId]);
    if (open.rowCount || interview.rowCount) { await client.query("ROLLBACK"); return false; }
    const inserted = await client.query(
      `INSERT INTO control_plane.telegram_chat_bindings (id, chat_id, trip_id, hermes_profile)
       SELECT $1, $2, t.id,
              coalesce(t.hermes_profile,
                (SELECT b.hermes_profile FROM control_plane.telegram_chat_bindings b
                  WHERE b.trip_id = t.id AND b.hermes_profile IS NOT NULL ORDER BY b.created_at DESC LIMIT 1))
         FROM control_plane.trips t WHERE t.id = $3
       ON CONFLICT DO NOTHING`,
      [opaque("tcb"), chatId, tripId],
    );
    await client.query("COMMIT");
    return (inserted.rowCount ?? 0) > 0;
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

// ── List ─────────────────────────────────────────────────────────────────────

export interface SecondaryOrganizerView {
  /** Opaque handle for Remove; never a user id or a digest. */
  id: string;
  /** Display data from the verified update (never decides anything). */
  name: string | null;
  username: string | null;
  joinedAt: string;
}

/** The trip's live secondary organizers (an ended membership is not live). For the main organizer's page only. */
export async function listSecondaryOrganizers(db: Pick<pg.Pool, "query">, tripId: string): Promise<SecondaryOrganizerView[]> {
  const result = await db.query<{ id: string; telegram_first_name: string | null; telegram_username: string | null; created_at: Date }>(
    `SELECT s.id, s.telegram_first_name, s.telegram_username, s.created_at
       FROM control_plane.trip_secondary_organizers s
       JOIN control_plane.trip_memberships m ON m.trip_id = s.trip_id AND m.user_id = s.user_id AND m.status = 'active'
      WHERE s.trip_id = $1 AND s.revoked_at IS NULL
      ORDER BY s.created_at, s.id`,
    [tripId],
  );
  return result.rows.map((row) => ({
    id: row.id, name: row.telegram_first_name, username: row.telegram_username, joinedAt: row.created_at.toISOString(),
  }));
}

// ── Remove ───────────────────────────────────────────────────────────────────

export type RemoveSecondaryResult =
  | { ok: true; /** The private chat to tell, or null. */ removedChatId: string | null }
  /** Not the trip's main organizer, no such binding, or already gone: one answer. */
  | { ok: false; reason: "NOT_FOUND" };

/**
 * The main organizer removes a secondary organizer from THEIR trip. At once, in one transaction:
 *   - the binding is revoked ('removed_by_organizer', by whom);
 *   - the hidden user's membership ends, which fires the database trigger that revokes the member link and the sessions it
 *     minted (migration 20261020120000), so the Mini App and the dashboard's scoped session are gone;
 *   - every portal session of that hidden user ends (it has no other trip) and an unspent launch grant is spent;
 *   - the Telegram account's hold on THIS trip is closed: its open chat binding to the trip, so the companion stops answering
 *     it as an organizer, and it drops out of `/trips`.
 * The request names the binding by its opaque id and the trip; the Telegram digest is read from the row, never from the request.
 */
export async function removeSecondaryOrganizer(
  db: pg.Pool,
  input: { actorUserId: string; tripId: string; secondaryId: string },
): Promise<RemoveSecondaryResult> {
  const notFound: RemoveSecondaryResult = { ok: false, reason: "NOT_FOUND" };
  if (!/^tso_[A-Za-z0-9]{8,64}$/.test(input.secondaryId)) return notFound;
  const client = await db.connect();
  try {
    await client.query("BEGIN");
    if ((await tripOfMainOrganizer(client, input.actorUserId, input.tripId, true)) === null) {
      await client.query("ROLLBACK");
      return notFound;
    }
    const row = await client.query<{ id: string }>(
      `SELECT id FROM control_plane.trip_secondary_organizers
        WHERE id = $1 AND trip_id = $2 AND revoked_at IS NULL FOR UPDATE`,
      [input.secondaryId, input.tripId],
    );
    if (!row.rows[0]) { await client.query("ROLLBACK"); return notFound; }
    const ended = await endSecondaryBindingInTx(client, { secondaryId: input.secondaryId, reason: "removed_by_organizer", revokedBy: input.actorUserId });
    await client.query("COMMIT");
    return { ok: true, removedChatId: ended?.chatId ?? null };
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

/**
 * Ends one live secondary binding inside the caller's transaction. One body for the two callers that end one - the main
 * organizer's Remove and a Telegram becoming the main organizer's own (telegram-link-token.ts) - so they cannot drift:
 *   - the binding is revoked, with the reason and who did it;
 *   - the hidden user's membership ends, which fires the database trigger that revokes the member link and the sessions it
 *     minted (migration 20261020120000), so the Mini App session is gone;
 *   - every portal session of that hidden user ends (it belongs to no other trip) and an unspent launch grant is spent;
 *   - the Telegram account's open chat binding to THIS trip closes, so the companion stops answering it as an organizer. The
 *     chat id is recovered from the binding by digest, never taken from a request.
 * Returns the chat that was closed (to tell), or null; null too for a binding that is not live.
 */
export async function endSecondaryBindingInTx(
  client: pg.PoolClient,
  input: { secondaryId: string; reason: "removed_by_organizer" | "became_main_organizer"; revokedBy: string },
): Promise<{ chatId: string | null } | null> {
  const revoked = await client.query<{ trip_id: string; user_id: string; telegram_subject_digest: string }>(
    `UPDATE control_plane.trip_secondary_organizers SET revoked_at = now(), revoked_reason = $2, revoked_by = $3
      WHERE id = $1 AND revoked_at IS NULL
      RETURNING trip_id, user_id, telegram_subject_digest`,
    [input.secondaryId, input.reason, input.revokedBy],
  );
  const target = revoked.rows[0];
  if (!target) return null;
  await client.query("UPDATE control_plane.trip_memberships SET status = 'revoked' WHERE trip_id = $1 AND user_id = $2", [target.trip_id, target.user_id]);
  await client.query(
    "UPDATE control_plane.runtime_launch_grants SET consumed_at = now() WHERE trip_id = $1 AND user_id = $2 AND consumed_at IS NULL",
    [target.trip_id, target.user_id],
  );
  await client.query("UPDATE control_plane.web_sessions SET revoked_at = now() WHERE user_id = $1 AND revoked_at IS NULL", [target.user_id]);
  const closed = await client.query<{ chat_id: string }>(
    `UPDATE control_plane.telegram_chat_bindings SET closed_at = now(), closed_reason = 'secondary_organizer_removed'
      WHERE closed_at IS NULL AND trip_id = $2 AND chat_id ~ '^[0-9]{1,20}$'
        AND 'sha256:' || encode(sha256(convert_to(chat_id, 'UTF8')), 'hex') = $1
      RETURNING chat_id`,
    [target.telegram_subject_digest, target.trip_id],
  );
  return { chatId: closed.rows[0]?.chat_id ?? null };
}

/** Ends every live secondary binding of one Telegram account on the given trips (see `endSecondaryBindingInTx`). */
export async function endSecondaryBindingsOfDigestInTx(
  client: pg.PoolClient,
  input: { tripIds: readonly string[]; digest: string; reason: "removed_by_organizer" | "became_main_organizer"; revokedBy: string },
): Promise<number> {
  if (input.tripIds.length === 0) return 0;
  const live = await client.query<{ id: string }>(
    `SELECT id FROM control_plane.trip_secondary_organizers
      WHERE trip_id = ANY($1::text[]) AND telegram_subject_digest = $2 AND revoked_at IS NULL ORDER BY id FOR UPDATE`,
    [[...input.tripIds], input.digest],
  );
  for (const { id } of live.rows) await endSecondaryBindingInTx(client, { secondaryId: id, reason: input.reason, revokedBy: input.revokedBy });
  return live.rowCount ?? 0;
}
