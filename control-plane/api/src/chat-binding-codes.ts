/**
 * Binding a WhatsApp chat to a trip with a one-time code from the dashboard
 * (docs/specs/sprint-9/625-whatsapp-via-relay.md, slice S2).
 *
 * THE TRUST MODEL. A WhatsApp sender is not a verified identity; a portal session is. A `me` code is minted in the
 * session of an active member of the trip and binds WHOEVER SENDS IT as that account, once, within minutes. It is sent
 * from the person's own phone seconds after it is minted and is never meant to be forwarded (the same model as the
 * dashboard's Telegram link). A `group` code is minted in the owner's session and binds the group it is sent in; it is
 * visible to the whole group once sent and is already spent by then.
 *
 * NO TRANSPORT HERE. There is no WhatsApp client in this slice. Everything below is a function of a chat id, an opaque
 * sender id and a message text passed in as plain arguments; the relay (S3) calls them and sends what they return. The
 * only thing injected is the sink an owner notice is sent through (`WhatsAppSink`).
 *
 * WHAT NEVER APPEARS HERE: a phone number or a real WhatsApp id. EVERY chat id is an alias (`wa_<32 hex>@p` for a person,
 * `wa_<32 hex>@g` for a group, computed by the relay with `whatsappChatAlias`); a sender id is the person's alias without
 * the suffix. The one place a real address rests is `transport_address` of an OPEN binding, group or private (for an old
 * group the real id contains its creator's number), written from a parameter the relay passes in and cleared whenever the
 * binding closes. For a group, the real id is the one thing the accepted-shape rule is judged on. Nothing in this file
 * logs it, and exactly ONE thing returns it: a `me` redemption by an owner that closed that owner's earlier connection
 * hands back the earlier chat's alias and address (`replacedOwnerChat`), read under the same lock that closes the row, so
 * the relay can tell the owner in that chat (owner's decision 2026-11-23) after the row has forgotten it. It goes back to
 * the process that passed it in, in memory, for one send; it is non-enumerable, so a logged or serialised result does not
 * carry it, and it is never written anywhere (not to the outbox, not to a retry). The last four digits the dashboard shows
 * (AC-16) are an OPTIONAL value passed in at binding time (`phone_last4`), null when the bridge reported no phone number.
 *
 * OLD SCHEMA. Functions that run on a Telegram-only path in a deployment that has not applied the S2 migration yet
 * (`closeEndedMembershipBindings`, called from `removeMember`) ask `whatsappSchemaPresent` first and do nothing when the
 * schema is the old one.
 *
 * LOCK ORDER (spec "Lock order"). Redemption: the code row FOR UPDATE, then the issuing account's own active membership
 * FOR SHARE (so `removeMember`, which locks the trip's memberships FOR UPDATE before it closes bindings, cannot commit
 * between the entitlement check and the binding), then the open binding(s) for the chat FOR UPDATE, in `chat_id` order
 * where more than one is closed, then the insert (whose foreign key touches `trips`). Teardown and
 * clear expire the trip's codes FIRST, the order REVOKE_GROUP_TOKENS documents (issue #175). Issuance expires the
 * oldest live codes BEFORE its INSERT for the same reason.
 */
import { createHash, randomBytes } from "node:crypto";
import type pg from "pg";
import { companionIntroFacts, companionIntroLoginUsernames } from "./chat-router.js";
import { groupIntroText, type CompanionIntroFacts } from "./companion-intro.js";
import { featureEnabled } from "./feature-switches.js";
import { TOKEN_ALPHABET, openBinding } from "./group-binding.js";
import { WHATSAPP_GROUP_CHAT_ID, WHATSAPP_PRIVATE_CHAT_ID, WHATSAPP_SENDER_ID, chatKind, isAcceptedWhatsAppGroupId } from "./identity.js";
import { structuredLog } from "./redaction.js";
import { SECONDARY_ORGANIZER_ROLE } from "./organizer-trips.js";
import { NOT_RETIRED_SQL } from "./trip-retirement.js";

type Queryable = Pick<pg.Pool, "query">;

/** The feature switch every WhatsApp path reads. An unknown or unreadable switch is OFF (feature-switches.ts). */
export const WHATSAPP_SWITCH = "whatsapp";
export const MAX_LIVE_CODES_PER_TRIP = 10;
export const DEFAULT_CODE_TTL_SECONDS = 900;
export const DEFAULT_CODE_ATTEMPTS_PER_HOUR = 5;
export const GLOBAL_FAILURES_PER_HOUR_ALERT = 50;

/** Why a binding was closed (free text in `closed_reason`, 0029; no enum, and no existing reader branches on these). */
export const CLOSE_REASONS = {
  dashboardRemoved: "dashboard_removed",
  reboundByCode: "rebound_by_code",
  leftGroup: "left_group",
  membershipEnded: "membership_ended",
} as const;

// ── The code ────────────────────────────────────────────────────────────────────────────────────────────────────────

const CODE_LENGTH = 8;
/** `KWA-` plus eight characters of the group tokens' alphabet, standing alone as a word (the lookarounds keep it out of URLs). */
export const CHAT_BINDING_CODE_PATTERN = new RegExp(
  `(?<![A-Za-z0-9/_-])KWA-([${TOKEN_ALPHABET}]{${CODE_LENGTH}})(?![A-Za-z0-9-])`,
  "i",
);

/** The code in a message, canonicalised to upper case, or null. Only a token of exactly the code shape is a code attempt. */
export function extractChatBindingCode(text: string | null | undefined): string | null {
  const match = CHAT_BINDING_CODE_PATTERN.exec(text ?? "");
  return match ? `KWA-${match[1]!.toUpperCase()}` : null;
}

export function chatBindingCodeDigest(code: string): string {
  return `sha256:${createHash("sha256").update(code.toUpperCase()).digest("hex")}`;
}

function newCode(): string {
  const bytes = randomBytes(CODE_LENGTH);
  let out = "";
  for (let i = 0; i < CODE_LENGTH; i += 1) out += TOKEN_ALPHABET[bytes[i]! % TOKEN_ALPHABET.length];
  return `KWA-${out}`;
}

const opaque = (prefix: string) => `${prefix}_${randomBytes(16).toString("hex")}`;

/** Does this database have the S2 schema? (The codes table exists iff the migration ran.) */
export async function whatsappSchemaPresent(db: Queryable): Promise<boolean> {
  try {
    const r = await db.query<{ present: boolean }>("SELECT to_regclass('control_plane.chat_binding_codes') IS NOT NULL AS present");
    return r.rows[0]?.present === true;
  } catch {
    return false;
  }
}

/** Free text from WhatsApp (a group's title, a display name) reduced to something safe to store and show: one line, no controls. */
export function cleanChatText(value: unknown, max = 100): string | null {
  if (typeof value !== "string") return null;
  const cleaned = value
    .replace(/[\p{Cc}\p{Cf}\p{Cs}\p{Co}\p{Zl}\p{Zp}]/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
  const clipped = Array.from(cleaned).slice(0, max).join("").trim();
  return clipped.length > 0 ? clipped : null;
}

const cleanLast4 = (value: unknown): string | null => (typeof value === "string" && /^[0-9]{4}$/.test(value) ? value : null);

// ── Who may do what ─────────────────────────────────────────────────────────────────────────────────────────────────

export interface TripEntitlement { exists: boolean; member: boolean; owner: boolean }

/**
 * What a user is to a trip, for the WhatsApp routes: any ACTIVE membership is a member; the OWNER is an active
 * `owner` membership with dashboard access (the same test the dashboard's other owner-only routes make). A retired trip
 * is no trip at all.
 */
export async function tripEntitlement(db: Queryable, tripId: string, userId: string): Promise<TripEntitlement> {
  const r = await db.query<{ role: string; dashboard_access: boolean }>(
    `SELECT m.role, m.dashboard_access
       FROM control_plane.trips t
       JOIN control_plane.trip_memberships m ON m.trip_id = t.id
      WHERE t.id = $1 AND m.user_id = $2 AND m.status = 'active' AND ${NOT_RETIRED_SQL}`,
    [tripId, userId],
  );
  const row = r.rows[0];
  if (!row) return { exists: false, member: false, owner: false };
  return { exists: true, member: true, owner: row.role === "owner" && row.dashboard_access === true };
}

// ── Issuing ─────────────────────────────────────────────────────────────────────────────────────────────────────────

export type IssueResult =
  | { ok: true; code: string; kind: "me" | "group"; expiresAt: Date }
  | { ok: false; reason: "NOT_FOUND" | "INVALID_KIND" };

/**
 * Mints a code for the trip, as `userId`. `me`: any active member, for itself only (the code binds whoever sends it AS
 * this account). `group`: the trip's owner only. One refusal, NOT_FOUND, for every way of not being entitled: not a
 * member, not the owner where the owner is required, not a trip, retired, the switch off. The kind is checked only
 * after that, so a caller who is not entitled learns nothing from a malformed request.
 *
 * Earlier codes stay valid. At most ten are live per trip: the oldest are expired to make room, BEFORE the insert.
 */
export async function issueChatBindingCode(
  db: pg.Pool,
  input: { tripId: string; userId: string; kind: unknown; ttlSeconds?: number; log?: (line: string) => void },
): Promise<IssueResult> {
  const entitlement = await tripEntitlement(db, input.tripId, input.userId);
  if (!entitlement.member) return { ok: false, reason: "NOT_FOUND" };
  if (!(await featureEnabled(db, input.tripId, WHATSAPP_SWITCH, input.log))) return { ok: false, reason: "NOT_FOUND" };
  if (input.kind !== "me" && input.kind !== "group") return { ok: false, reason: "INVALID_KIND" };
  if (input.kind === "group" && !entitlement.owner) return { ok: false, reason: "NOT_FOUND" };

  const kind = input.kind;
  const ttl = input.ttlSeconds ?? DEFAULT_CODE_TTL_SECONDS;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const code = newCode();
    const client = await db.connect();
    try {
      await client.query("BEGIN");
      // Issuers of one trip take turns (an advisory lock, which teardown never takes, so it adds no edge to the lock order):
      // FOR UPDATE alone would let two of them count the same nine, because the second's read cannot see the first's insert.
      await client.query("SELECT pg_advisory_xact_lock(hashtext($1))", [`chat_binding_codes:${input.tripId}`]);
      // The trip's live codes, locked in a stable order.
      const live = await client.query<{ id: string }>(
        `SELECT id FROM control_plane.chat_binding_codes
          WHERE trip_id = $1 AND state = 'issued' AND expires_at > now()
          ORDER BY created_at, id FOR UPDATE`,
        [input.tripId],
      );
      const surplus = live.rows.length - (MAX_LIVE_CODES_PER_TRIP - 1);
      if (surplus > 0) {
        await client.query(
          "UPDATE control_plane.chat_binding_codes SET state = 'expired' WHERE id = ANY($1::text[])",
          [live.rows.slice(0, surplus).map((row) => row.id)],
        );
      }
      const expiresAt = new Date(Date.now() + ttl * 1000);
      await client.query(
        `INSERT INTO control_plane.chat_binding_codes (id, trip_id, platform, kind, issued_by_user_id, code_digest, expires_at)
         VALUES ($1, $2, 'whatsapp', $3, $4, $5, $6)`,
        [opaque("cbc"), input.tripId, kind, input.userId, chatBindingCodeDigest(code), expiresAt],
      );
      await client.query("COMMIT");
      return { ok: true, code, kind, expiresAt };
    } catch (error) {
      await client.query("ROLLBACK").catch(() => undefined);
      // The same digest already live (a collision in 32^8): draw again. Anything else is not ours to swallow.
      if ((error as { code?: string }).code === "23505" && attempt < 2) continue;
      throw error;
    } finally {
      client.release();
    }
  }
  throw new Error("issueChatBindingCode: could not draw an unused code");
}

// ── Redeeming ───────────────────────────────────────────────────────────────────────────────────────────────────────

export interface RedeemInput {
  /** The message text. Any token of the code shape anywhere in it is a code attempt. */
  text?: string | null;
  /** Or the code itself, already extracted. */
  code?: string | null;
  /** The WhatsApp chat's ALIAS: `wa_<32 hex>@g` for a group, `wa_<32 hex>@p` for a private chat. Never a real WhatsApp id. */
  chatId: string;
  /** The sender's opaque id (`wa_<32 hex>`). For a private chat, `chatId` must be this plus `@p`. */
  senderId: string;
  /**
   * The chat's REAL address, written to `transport_address` (the relay needs it to send), for a group as well as a private
   * chat. REQUIRED. For a group it must be a real group id of an accepted shape (`isAcceptedWhatsAppGroupId`, old
   * groups included): the accepted-shape rule is judged on THIS, not on the alias. For a private chat it is whatever
   * address the bridge reports, an opaque string that is never parsed.
   */
  transportAddress?: string | null;
  /** The last four digits of the sender's phone number when the bridge reported one (AC-16). Optional. */
  phoneLast4?: string | null;
  /** A group's title when the bridge can read it. */
  chatTitle?: string | null;
  log?: (line: string) => void;
}

export type RedeemFailure =
  | "NOT_A_CODE"
  | "BAD_CHAT_ID"
  | "NOT_FOUND"
  | "EXPIRED"
  | "WRONG_KIND"
  | "TRIP_UNAVAILABLE"
  | "ISSUER_NOT_ENTITLED"
  | "GROUP_BOUND_ELSEWHERE"
  | "CONFLICT";

export interface Traveller { username: string; displayName: string | null }

/**
 * The owner's earlier WhatsApp private chat on the trip, which a `me` redemption just closed: its alias, and its real
 * address as it was on the row the moment before the close cleared it. `transportAddress` is NON-ENUMERABLE: reading it
 * works, but `JSON.stringify`, `util.inspect` and a spread leave it out, so a result that is logged carries no address.
 * Hand it to `notifyOwnersOfNewBinding` and drop it.
 */
export interface ReplacedConnection { readonly chatId: string; readonly transportAddress: string }

function replacedConnection(chatId: string, transportAddress: string): ReplacedConnection {
  const value = { chatId } as { chatId: string; transportAddress: string };
  Object.defineProperty(value, "transportAddress", { value: transportAddress, enumerable: false, writable: false });
  return Object.freeze(value);
}

export type RedeemResult =
  | {
      ok: true; kind: "me"; tripId: string; tripTitle: string | null; bindingId: string; accountUserId: string;
      traveller: Traveller | null; closedBindingIds: string[];
      /**
       * Set ONLY when the issuing account holds an active `owner` membership of the trip and this redemption closed that
       * account's earlier WhatsApp connection to it (AC-9's `rebound_by_code`, from another chat or the same one). Null
       * for a first connection, and always null for a member or a secondary organizer, whose replacement is announced
       * the ordinary way. The owner is told in the chat it names (owner's decision 2026-11-23).
       */
      replacedOwnerChat: ReplacedConnection | null;
    }
  | { ok: true; kind: "group"; tripId: string; tripTitle: string | null; bindingId: string; alreadyConnected: boolean }
  | {
      ok: false; reason: RedeemFailure;
      /** True when the code was of the right kind for the chat and has been used up with nothing bound (AC-11). */
      spent: boolean;
    };

function isUniqueViolation(error: unknown): boolean {
  return (error as { code?: string } | null)?.code === "23505";
}

/** The account's traveller on the trip, when its redeemed site invite or web credential maps it to one (Contracts, "Travellers"). */
async function travellerOf(client: Queryable, tripId: string, userId: string): Promise<Traveller | null> {
  const invite = await client.query<{ runtime_username: string; intended_display_name: string }>(
    `SELECT runtime_username, intended_display_name FROM control_plane.site_invites
      WHERE trip_id = $1 AND redeemed_by = $2 AND state = 'redeemed'
      ORDER BY redeemed_at DESC LIMIT 1`,
    [tripId, userId],
  );
  if (invite.rows[0]) return { username: invite.rows[0].runtime_username, displayName: invite.rows[0].intended_display_name };
  const credential = await client.query<{ runtime_username: string }>(
    "SELECT runtime_username FROM control_plane.web_password_credentials WHERE trip_id = $1 AND user_id = $2",
    [tripId, userId],
  );
  return credential.rows[0] ? { username: credential.rows[0].runtime_username, displayName: null } : null;
}

/** Closes the listed OPEN bindings, clearing everything that rests a number on a row (the CHECKs refuse a closed row that holds one). */
async function closeBindings(client: pg.PoolClient, ids: string[], reason: string): Promise<void> {
  if (ids.length === 0) return;
  await client.query(
    `UPDATE control_plane.telegram_chat_bindings
        SET closed_at = now(), closed_reason = $2, transport_address = NULL, phone_last4 = NULL
      WHERE id = ANY($1::text[]) AND closed_at IS NULL`,
    [ids, reason],
  );
}

/**
 * Redeems a code found in a message, in ONE transaction. Never throws for an ordinary refusal; a database fault does.
 *
 * Spent or not (AC-11): a code of the WRONG kind for the chat is not spent; a wrong, expired or already-used code has
 * nothing to spend. A code of the RIGHT kind that cannot bind (the group is bound to a different trip, the trip is
 * retired or switched off at this moment, the issuing account is no longer entitled) is spent, with nothing bound. A
 * `group` code in a group already bound to the same trip is spent and answered "already connected".
 */
export async function redeemChatBindingCode(db: pg.Pool, input: RedeemInput): Promise<RedeemResult> {
  const code = input.code ? extractChatBindingCode(input.code) : extractChatBindingCode(input.text);
  if (!code) return { ok: false, reason: "NOT_A_CODE", spent: false };

  const kindOfChat = chatKind(input.chatId);
  const isGroup = WHATSAPP_GROUP_CHAT_ID.test(input.chatId);
  const isPrivate = WHATSAPP_PRIVATE_CHAT_ID.test(input.chatId);
  // A chat id that is not an alias of an accepted WhatsApp shape (a real group id, a Telegram id) binds nothing and spends
  // nothing: we cannot even say which kind of code would fit it. The same for a group whose REAL id (the address the relay
  // passes in) is not of an accepted shape, old style included, and for any chat with no address to send to.
  if ((!isGroup && !isPrivate) || kindOfChat === "unknown") return { ok: false, reason: "BAD_CHAT_ID", spent: false };
  const address = typeof input.transportAddress === "string" && input.transportAddress.length > 0 && input.transportAddress.length <= 256 ? input.transportAddress : null;
  if (address === null || (isGroup && !isAcceptedWhatsAppGroupId(address))) return { ok: false, reason: "BAD_CHAT_ID", spent: false };
  if (isPrivate && (!WHATSAPP_SENDER_ID.test(input.senderId) || input.chatId !== `${input.senderId}@p`)) {
    return { ok: false, reason: "BAD_CHAT_ID", spent: false };
  }

  const client = await db.connect();
  const rollback = async () => { await client.query("ROLLBACK").catch(() => undefined); };
  try {
    await client.query("BEGIN");
    const found = await client.query<{
      id: string; trip_id: string; kind: "me" | "group"; issued_by_user_id: string; expired: boolean; platform: string;
      trip_retired: boolean; trip_title: string | null;
    }>(
      `SELECT c.id, c.trip_id, c.kind, c.issued_by_user_id, c.platform, c.expires_at <= now() AS expired,
              NOT EXISTS (SELECT 1 FROM control_plane.trips t WHERE t.id = c.trip_id AND ${NOT_RETIRED_SQL}) AS trip_retired,
              (SELECT coalesce(t2.title, t2.destination_label) FROM control_plane.trips t2 WHERE t2.id = c.trip_id) AS trip_title
         FROM control_plane.chat_binding_codes c
        WHERE c.code_digest = $1 AND c.state = 'issued'
        FOR UPDATE OF c`,
      [chatBindingCodeDigest(code)],
    );
    const row = found.rows[0];
    if (!row || row.platform !== "whatsapp") { await rollback(); return { ok: false, reason: "NOT_FOUND", spent: false }; }
    if (row.expired) { await rollback(); return { ok: false, reason: "EXPIRED", spent: false }; }
    if ((row.kind === "me") !== isPrivate) { await rollback(); return { ok: false, reason: "WRONG_KIND", spent: false }; }

    // From here the code is of the right kind for the chat: a refusal uses it up.
    const burn = async (reason: RedeemFailure): Promise<RedeemResult> => {
      await client.query("UPDATE control_plane.chat_binding_codes SET state = 'expired' WHERE id = $1", [row.id]);
      await client.query("COMMIT");
      return { ok: false, reason, spent: true };
    };
    if (row.trip_retired || !(await featureEnabled(client, row.trip_id, WHATSAPP_SWITCH, input.log))) return await burn("TRIP_UNAVAILABLE");
    // The issuing account must still be entitled: a member removed since the code was minted binds nothing (fail closed).
    // THE READ IS LOCKED: `removeMember` takes the trip's memberships FOR UPDATE and then closes the member's WhatsApp
    // bindings, so an unlocked check here could pass, `removeMember` commit, and this transaction then commit a new binding for
    // a revoked member. FOR SHARE makes the two take turns: either this transaction already holds the row (removeMember waits,
    // then sees and closes the binding this one opened) or removeMember committed first (the re-read finds the row no longer
    // 'active' and the lock query returns nothing). Lock order: code row, then this membership, then the bindings below,
    // which is the direction removeMember takes (memberships, then bindings), and teardown never locks a membership.
    const held = await client.query<{ role: string }>(
      "SELECT role FROM control_plane.trip_memberships WHERE trip_id = $1 AND user_id = $2 AND status = 'active' FOR SHARE",
      [row.trip_id, row.issued_by_user_id],
    );
    // An active `owner` membership: the role AC-13 turns into `organizer` in the chat, and the set `notifyOwnersOfNewBinding`
    // tells. Read under the same lock, so it is the role the binding below is made with.
    const issuerIsOwner = held.rows.some((r) => r.role === "owner");
    const issuer = await tripEntitlement(client, row.trip_id, row.issued_by_user_id);
    if (!issuer.member || (row.kind === "group" && !issuer.owner)) return await burn("ISSUER_NOT_ENTITLED");

    const spend = (bindingId: string) => client.query(
      "UPDATE control_plane.chat_binding_codes SET state = 'redeemed', binding_id = $2, redeemed_at = now() WHERE id = $1",
      [row.id, bindingId],
    );

    if (row.kind === "group") {
      const readOpen = async () => (await client.query<{ id: string; trip_id: string }>(
        "SELECT id, trip_id FROM control_plane.telegram_chat_bindings WHERE chat_id = $1 AND closed_at IS NULL FOR UPDATE",
        [input.chatId],
      )).rows[0];
      const bound = (await readOpen()) ?? (await readOpen());
      if (bound) {
        if (bound.trip_id !== row.trip_id) return await burn("GROUP_BOUND_ELSEWHERE");
        await spend(bound.id);
        await client.query("COMMIT");
        return { ok: true, kind: "group", tripId: row.trip_id, tripTitle: row.trip_title, bindingId: bound.id, alreadyConnected: true };
      }
      const bindingId = await openBinding(client, input.chatId, row.trip_id, { chatTitle: cleanChatText(input.chatTitle), transportAddress: address });
      await spend(bindingId);
      await client.query("COMMIT");
      return { ok: true, kind: "group", tripId: row.trip_id, tripTitle: row.trip_title, bindingId, alreadyConnected: false };
    }

    // A `me` code: this private chat becomes the issuing account's connection to the trip.
    const traveller = await travellerOf(client, row.trip_id, row.issued_by_user_id);
    // Any other WhatsApp link of the trip that names the same account, or the same traveller (AC-9). A `me` connection
    // outranks a claim made from the group: it replaces a `group_membership` link naming the same traveller.
    const others = await client.query<{ telegram_user_id: string }>(
      `SELECT telegram_user_id FROM control_plane.trip_person_links
        WHERE trip_id = $1 AND platform = 'whatsapp' AND telegram_user_id <> $2
          AND (account_user_id = $3 OR ($4::text IS NOT NULL AND participant_username = $4))`,
      [row.trip_id, input.senderId, row.issued_by_user_id, traveller?.username ?? null],
    );
    const chatsToLock = [input.chatId, ...others.rows.map((r) => `${r.telegram_user_id}@p`)];
    // One statement, `chat_id` order: the chat's own open binding (whatever trip it was for) and the replaced ones.
    const open = await client.query<{ id: string; chat_id: string; trip_id: string; transport_address: string | null }>(
      `SELECT id, chat_id, trip_id, transport_address FROM control_plane.telegram_chat_bindings
        WHERE chat_id = ANY($1::text[]) AND closed_at IS NULL
        ORDER BY chat_id FOR UPDATE`,
      [chatsToLock],
    );
    // AN OWNER'S EARLIER CONNECTION (owner's decision 2026-11-23): a stolen owner code would otherwise give organizer role
    // with no notice, so when the account replacing its connection is an owner, the chat it replaces is captured here,
    // under the lock and before the close below clears its address, for the notice. Only the binding of THIS trip whose
    // person link names THIS account counts; the chat's own binding to another trip, or a group claim of the same
    // traveller (both also closed here), is not the owner's earlier connection.
    let replacedOwnerChat: ReplacedConnection | null = null;
    if (issuerIsOwner) {
      const mine = await client.query<{ telegram_user_id: string }>(
        `SELECT telegram_user_id FROM control_plane.trip_person_links
          WHERE trip_id = $1 AND platform = 'whatsapp' AND account_user_id = $2`,
        [row.trip_id, row.issued_by_user_id],
      );
      const senders = new Set(mine.rows.map((r) => r.telegram_user_id));
      const earlier = open.rows.find((b) => b.trip_id === row.trip_id && senders.has(b.chat_id.slice(0, -2)) && b.transport_address);
      if (earlier) replacedOwnerChat = replacedConnection(earlier.chat_id, earlier.transport_address!);
    }
    await closeBindings(client, open.rows.map((r) => r.id), CLOSE_REASONS.reboundByCode);
    // Their person links go with them: the old binding's link (whatever trip), the sender's link on this trip, and the
    // conflicting ones found above (even when no open binding is left for them).
    const linkKeys = new Map<string, { tripId: string; sender: string }>();
    const keep = (tripId: string, sender: string) => linkKeys.set(`${tripId}\u0000${sender}`, { tripId, sender });
    for (const b of open.rows) keep(b.trip_id, b.chat_id.slice(0, -2));
    keep(row.trip_id, input.senderId);
    for (const o of others.rows) keep(row.trip_id, o.telegram_user_id);
    for (const { tripId, sender } of linkKeys.values()) {
      await client.query(
        "DELETE FROM control_plane.trip_person_links WHERE trip_id = $1 AND telegram_user_id = $2 AND platform = 'whatsapp'",
        [tripId, sender],
      );
    }

    const bindingId = await openBinding(client, input.chatId, row.trip_id, {
      transportAddress: address,
      phoneLast4: cleanLast4(input.phoneLast4),
    });
    await client.query(
      `INSERT INTO control_plane.trip_person_links
         (id, trip_id, telegram_user_id, participant_username, display_name, role, verified_via, platform, account_user_id)
       VALUES ($1, $2, $3, $4, $5, 'participant', 'dashboard_code', 'whatsapp', $6)`,
      [opaque("tpl"), row.trip_id, input.senderId, traveller?.username ?? null, traveller?.displayName ?? null, row.issued_by_user_id],
    );
    await spend(bindingId);
    await client.query("COMMIT");
    return {
      ok: true, kind: "me", tripId: row.trip_id, tripTitle: row.trip_title, bindingId, accountUserId: row.issued_by_user_id,
      traveller, closedBindingIds: open.rows.map((r) => r.id), replacedOwnerChat,
    };
  } catch (error) {
    await rollback();
    // A concurrent redemption won the chat, the account or the traveller (the partial unique indexes): nothing was
    // bound and the code is still unspent, so the person can send it again.
    if (isUniqueViolation(error)) return { ok: false, reason: "CONFLICT", spent: false };
    throw error;
  } finally {
    client.release();
  }
}

// ── What the chat is told ───────────────────────────────────────────────────────────────────────────────────────────

/**
 * The one fixed line for a redemption outcome, or null when nothing is said (not a code). The trip's title is the only
 * variable, one line of text. Never a number, never a code.
 */
export function redeemReplyLine(result: RedeemResult): string | null {
  if (result.ok) {
    const title = cleanChatText(result.tripTitle, 80) ?? "your trip";
    if (result.kind === "group") return result.alreadyConnected ? `This group is already connected to ${title}.` : null;
    return `Connected to ${title}. You can ask me about the trip here.`;
  }
  switch (result.reason) {
    case "NOT_A_CODE": return null;
    case "WRONG_KIND": return "That code is for a different kind of chat. Make a new one from the trip's WhatsApp page.";
    case "GROUP_BOUND_ELSEWHERE":
    case "CONFLICT":
    case "TRIP_UNAVAILABLE":
    case "ISSUER_NOT_ENTITLED":
    case "BAD_CHAT_ID":
    case "NOT_FOUND":
    case "EXPIRED":
    default: return "That code did not work. Make a new one from the trip's WhatsApp page.";
  }
}

/**
 * The introduction a newly bound group is sent (AC-10, AC-28). The group's own arrival message, with the site password
 * NEVER included whatever `groupIntroIncludesPassword` says, plus one line saying the companion reads the group's
 * messages to know when it is addressed. Null when the trip has no stored introduction facts (nothing to introduce).
 */
export async function composeWhatsAppGroupIntroduction(db: Queryable, tripId: string): Promise<string | null> {
  const facts = await companionIntroFacts(db as pg.Pool, tripId);
  const assistantName = typeof facts?.assistant_name === "string" ? facts.assistant_name : null;
  if (!facts || !assistantName) return null;
  const language: "he" | "en" = facts.language === "he" ? "he" : "en";
  const introFacts: CompanionIntroFacts = {
    assistantName,
    tripTitle: typeof facts.trip_title === "string" ? facts.trip_title : null,
    siteUrl: typeof facts.private_url === "string" ? facts.private_url : "",
    language,
    // The password is dropped here, before the text builder is asked: two walls, not one.
    loginPassword: null,
    loginUsernames: companionIntroLoginUsernames(facts),
    botUsername: null,
    organizerName: typeof facts.organizer === "string" ? facts.organizer : null,
    proactive: (facts.proactive as never) ?? null,
  };
  const disclosure = language === "he"
    ? "אני קורא את ההודעות בקבוצה הזו רק כדי לדעת מתי פונים אליי."
    : "I read this group's messages only to know when someone is talking to me.";
  return `${groupIntroText(introFacts, { includePassword: false })}\n\n${disclosure}`;
}

// ── Who a sender is, and when a chat must end ──────────────────────────────────────────────────────────────────────

export interface WhatsAppPerson { username: string; displayName: string | null; role: string }

/**
 * Who this WhatsApp sender is ON THIS TRIP: only through a WhatsApp person link of the trip, keyed by the sender's opaque
 * id. The role is DERIVED NOW from the link's account and never read from the stored column (which is always
 * 'participant'): an active `owner` membership is `organizer`; an active `organizer` membership is
 * `secondary_organizer`; anything else, and every link with no account, is `participant`. A sender with no link is nobody.
 */
export async function resolveWhatsAppPerson(db: Queryable, tripId: string, senderId: string): Promise<WhatsAppPerson | null> {
  if (!tripId || !WHATSAPP_SENDER_ID.test(senderId ?? "")) return null;
  const r = await db.query<{ participant_username: string | null; display_name: string | null; membership_role: string | null }>(
    `SELECT l.participant_username, l.display_name,
            (SELECT m.role FROM control_plane.trip_memberships m
              WHERE m.trip_id = l.trip_id AND m.user_id = l.account_user_id AND m.status = 'active'
              ORDER BY (m.role = 'owner') DESC, (m.role = 'organizer') DESC LIMIT 1) AS membership_role
       FROM control_plane.trip_person_links l
      WHERE l.trip_id = $1 AND l.telegram_user_id = $2 AND l.platform = 'whatsapp'
      LIMIT 1`,
    [tripId, senderId],
  );
  const row = r.rows[0];
  if (!row) return null;
  const role = row.membership_role === "owner" ? "organizer" : row.membership_role === "organizer" ? SECONDARY_ORGANIZER_ROLE : "participant";
  return { username: row.participant_username ?? "", displayName: row.display_name, role };
}

/**
 * Ends every open WhatsApp private binding of this trip whose person link names `userId` (AC-14): the binding closes
 * `membership_ended` and the link is deleted. Runs on the CALLER's client, inside `removeMember`'s transaction. A no-op on
 * a database without the S2 schema. Returns the closed binding ids.
 */
export async function closeEndedMembershipBindings(client: pg.PoolClient, tripId: string, userId: string): Promise<string[]> {
  if (!(await whatsappSchemaPresent(client))) return [];
  const links = await client.query<{ telegram_user_id: string }>(
    `SELECT telegram_user_id FROM control_plane.trip_person_links
      WHERE trip_id = $1 AND platform = 'whatsapp' AND account_user_id = $2`,
    [tripId, userId],
  );
  if (links.rows.length === 0) return [];
  const bindings = await client.query<{ id: string }>(
    `SELECT id FROM control_plane.telegram_chat_bindings
      WHERE trip_id = $1 AND platform = 'whatsapp' AND closed_at IS NULL AND chat_id = ANY($2::text[])
      ORDER BY chat_id FOR UPDATE`,
    [tripId, links.rows.map((l) => `${l.telegram_user_id}@p`)],
  );
  const ids = bindings.rows.map((b) => b.id);
  await closeBindings(client, ids, CLOSE_REASONS.membershipEnded);
  await client.query(
    "DELETE FROM control_plane.trip_person_links WHERE trip_id = $1 AND platform = 'whatsapp' AND account_user_id = $2",
    [tripId, userId],
  );
  return ids;
}

/**
 * The check that precedes EACH private WhatsApp turn, for every way a membership can end other than `removeMember`
 * (SQL, an admin tool, a trigger): when the open private binding's person link names an account that no longer has an
 * active membership of the trip, the binding closes (`membership_ended`) and the link is deleted. Returns whether the
 * chat was closed; the relay then does not forward the turn.
 */
export async function closeIfMembershipEnded(db: pg.Pool, chatId: string): Promise<{ closed: boolean }> {
  if (!WHATSAPP_PRIVATE_CHAT_ID.test(chatId)) return { closed: false };
  const client = await db.connect();
  try {
    await client.query("BEGIN");
    const binding = await client.query<{ id: string; trip_id: string }>(
      `SELECT id, trip_id FROM control_plane.telegram_chat_bindings
        WHERE chat_id = $1 AND platform = 'whatsapp' AND closed_at IS NULL FOR UPDATE`,
      [chatId],
    );
    const b = binding.rows[0];
    if (!b) { await client.query("ROLLBACK"); return { closed: false }; }
    const senderId = chatId.slice(0, -2);
    const link = await client.query<{ account_user_id: string | null; active: boolean }>(
      `SELECT l.account_user_id,
              EXISTS (SELECT 1 FROM control_plane.trip_memberships m
                       WHERE m.trip_id = l.trip_id AND m.user_id = l.account_user_id AND m.status = 'active') AS active
         FROM control_plane.trip_person_links l
        WHERE l.trip_id = $1 AND l.telegram_user_id = $2 AND l.platform = 'whatsapp'`,
      [b.trip_id, senderId],
    );
    const l = link.rows[0];
    if (!l || l.account_user_id === null || l.active) { await client.query("ROLLBACK"); return { closed: false }; }
    await closeBindings(client, [b.id], CLOSE_REASONS.membershipEnded);
    await client.query(
      "DELETE FROM control_plane.trip_person_links WHERE trip_id = $1 AND telegram_user_id = $2 AND platform = 'whatsapp'",
      [b.trip_id, senderId],
    );
    await client.query("COMMIT");
    return { closed: true };
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

// ── The dashboard's list, and Remove ────────────────────────────────────────────────────────────────────────────────

export type ConnectionVia = "group_code" | "added_to_group" | "dashboard_code" | "group_membership";

export interface WhatsAppConnection {
  bindingId: string;
  kind: "group" | "person";
  /** The group's title, or the traveller's name. Free text a person chose: shown, never acted on. */
  name: string | null;
  via: ConnectionVia;
  connectedAt: string;
  /** For a person only, and only when a phone number was reported at binding time. Never the whole number. */
  lastFour?: string;
}

/**
 * The trip's open WhatsApp connections, for the owner. Each row carries only: the binding id, the kind, the group's title
 * or the traveller's name, how it was made, when, and for a person the last four digits when known (AC-16). No chat id,
 * no address, no code, no sender id.
 */
export async function listWhatsAppConnections(db: Queryable, tripId: string): Promise<WhatsAppConnection[]> {
  const r = await db.query<{
    id: string; chat_id: string; chat_title: string | null; phone_last4: string | null; created_at: Date;
    redeemed_code: boolean; verified_via: string | null; person_name: string | null;
  }>(
    `SELECT b.id, b.chat_id, b.chat_title, b.phone_last4, b.created_at,
            EXISTS (SELECT 1 FROM control_plane.chat_binding_codes c WHERE c.binding_id = b.id AND c.state = 'redeemed') AS redeemed_code,
            l.verified_via,
            coalesce(l.display_name, l.participant_username, u.display_name) AS person_name
       FROM control_plane.telegram_chat_bindings b
       LEFT JOIN control_plane.trip_person_links l
              ON l.trip_id = b.trip_id AND l.platform = 'whatsapp' AND b.chat_id = l.telegram_user_id || '@p'
       LEFT JOIN control_plane.users u ON u.id = l.account_user_id
      WHERE b.trip_id = $1 AND b.platform = 'whatsapp' AND b.closed_at IS NULL
      ORDER BY b.created_at, b.id`,
    [tripId],
  );
  return r.rows.map((row): WhatsAppConnection => {
    const isGroup = WHATSAPP_GROUP_CHAT_ID.test(row.chat_id);
    if (isGroup) {
      return {
        bindingId: row.id, kind: "group", name: cleanChatText(row.chat_title),
        via: row.redeemed_code ? "group_code" : "added_to_group", connectedAt: row.created_at.toISOString(),
      };
    }
    return {
      bindingId: row.id, kind: "person", name: cleanChatText(row.person_name),
      via: row.verified_via === "group_membership" ? "group_membership" : "dashboard_code",
      connectedAt: row.created_at.toISOString(),
      ...(row.phone_last4 ? { lastFour: row.phone_last4 } : {}),
    };
  });
}

/**
 * Remove, from the dashboard (AC-15): the binding closes `dashboard_removed`, its `transport_address` is cleared, a
 * private chat's person link is deleted, and NOTHING is sent to the chat. A later message from it is handled as from any
 * unbound chat. Only the trip's own WhatsApp binding can be named: any other id is not found.
 */
export async function removeWhatsAppConnection(
  db: pg.Pool,
  input: { tripId: string; bindingId: string },
): Promise<{ ok: true } | { ok: false; reason: "NOT_FOUND" }> {
  if (!/^[a-z]{2,12}_[A-Za-z0-9]{8,64}$/.test(input.bindingId ?? "")) return { ok: false, reason: "NOT_FOUND" };
  const client = await db.connect();
  try {
    await client.query("BEGIN");
    const found = await client.query<{ id: string; chat_id: string }>(
      `SELECT id, chat_id FROM control_plane.telegram_chat_bindings
        WHERE id = $1 AND trip_id = $2 AND platform = 'whatsapp' AND closed_at IS NULL FOR UPDATE`,
      [input.bindingId, input.tripId],
    );
    const b = found.rows[0];
    if (!b) { await client.query("ROLLBACK"); return { ok: false, reason: "NOT_FOUND" }; }
    await closeBindings(client, [b.id], CLOSE_REASONS.dashboardRemoved);
    if (WHATSAPP_PRIVATE_CHAT_ID.test(b.chat_id)) {
      await client.query(
        "DELETE FROM control_plane.trip_person_links WHERE trip_id = $1 AND telegram_user_id = $2 AND platform = 'whatsapp'",
        [input.tripId, b.chat_id.slice(0, -2)],
      );
    }
    await client.query("COMMIT");
    return { ok: true };
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

// ── Telling the owner (AC-18) ───────────────────────────────────────────────────────────────────────────────────────

/** Sends one text to a WhatsApp private chat (its alias). Supplied by the relay (S3); this slice has no transport. */
export type WhatsAppSink = (chatId: string, text: string) => Promise<void>;

/**
 * Sends one text to a WhatsApp private chat whose binding has ALREADY CLOSED, so the alias alone no longer resolves to an
 * address: the target carries the address `redeemChatBindingCode` captured before the close (`ReplacedConnection`). It must
 * not log or keep the address. Supplied by the relay (S3); optional, and when it is absent or fails the notice falls
 * through to Telegram, then to the dashboard.
 */
export type WhatsAppAddressedSink = (target: { chatId: string; transportAddress: string }, text: string) => Promise<void>;

/** The outbox type of the Telegram fallback; its wording is `whatsappConnectionNoticeText`. */
export const CONNECTION_NOTICE_TYPE = "whatsapp_connection_notice";

export function whatsappConnectionNoticeText(payload: { kind?: unknown; name?: unknown; trip_title?: unknown; language?: unknown; last4?: unknown }): string | null {
  const name = cleanChatText(payload.name, 80);
  const trip = cleanChatText(payload.trip_title, 80);
  const he = payload.language === "he";
  if (payload.kind === "replaced") {
    // An owner's own connection replaced by a new one: the trip and, when the bridge reported it, the new number's last
    // four digits. Never a number, an address, an alias or a code.
    const last4 = cleanLast4(payload.last4);
    return he
      ? `החיבור שלך בוואטסאפ ל${trip ? `-"${trip}"` : "טיול"} הוחלף בחיבור חדש${last4 ? ` (המספר החדש מסתיים ב-${last4})` : ""}. אם לא את/ה חיברת אותו, אפשר להסיר אותו בעמוד הוואטסאפ של הטיול.`
      : `Your WhatsApp connection to ${trip ? `"${trip}"` : "your trip"} was replaced by a new one${last4 ? ` (the new number ends in ${last4})` : ""}. If that was not you, remove it on the trip's WhatsApp page.`;
  }
  if (payload.kind === "group") {
    const group = name ? `"${name}"` : (he ? "קבוצת וואטסאפ" : "A WhatsApp group");
    return he
      ? `${group} חוברה ל${trip ? `-"${trip}"` : "טיול"} בוואטסאפ. אפשר להסיר אותה בעמוד הוואטסאפ של הטיול.`
      : `${group} was connected to ${trip ? `"${trip}"` : "your trip"} on WhatsApp. You can remove it on the trip's WhatsApp page.`;
  }
  if (payload.kind === "person") {
    const who = name ?? (he ? "מישהו" : "Someone");
    return he
      ? `${who} חיבר/ה את הוואטסאפ ל${trip ? `-"${trip}"` : "טיול"}. אפשר להסיר את החיבור בעמוד הוואטסאפ של הטיול.`
      : `${who} connected their WhatsApp to ${trip ? `"${trip}"` : "your trip"}. You can remove the connection on the trip's WhatsApp page.`;
  }
  return null;
}

export type OwnerNotice = { userId: string; channel: "whatsapp" | "telegram" | "dashboard_only" };

/**
 * Tells the trip's owner(s) that a group or a person was connected, ONCE, however the binding was made (AC-18). The
 * notice names the group's title or the traveller and never a number. It goes to the owner's connected WhatsApp private
 * chat (through `sendWhatsApp`) when there is one; otherwise through the existing outbox to the owner's Telegram private
 * chat when there is one; otherwise nowhere (the dashboard list shows it). Everything is derived from the binding row, so a
 * binding made by adding the number (AC-28) or by a traveller from the group (AC-29) is announced by the same call.
 *
 * THE OWNER'S OWN `me` CONNECTION is not announced to them when it is their first. When it REPLACED an earlier connection of
 * theirs to the trip (`input.replaced`, the redemption's `replacedOwnerChat`), it is (owner's decision 2026-11-23: a stolen
 * owner code otherwise gives organizer role with no notice): "your connection was replaced", with the new number's last
 * four when known, sent to the PREVIOUS chat through `sendWhatsAppToAddress`, else through the outbox to Telegram, else
 * the dashboard only. NEVER to the owner's currently connected WhatsApp chat: that is the new one, the chat a stolen code's
 * holder is in. A member's or a secondary organizer's replacement is announced to the owner the ordinary way.
 *
 * A failed WhatsApp send falls through to Telegram, never to a second WhatsApp attempt.
 */
export async function notifyOwnersOfNewBinding(
  db: pg.Pool,
  deps: { sendWhatsApp: WhatsAppSink; sendWhatsAppToAddress?: WhatsAppAddressedSink; log?: (line: string) => void },
  input: { bindingId: string; replaced?: ReplacedConnection | null },
): Promise<OwnerNotice[]> {
  const log = deps.log ?? (() => {});
  const b = await db.query<{
    trip_id: string; chat_id: string; chat_title: string | null; person_name: string | null; person_account: string | null; trip_title: string | null;
    phone_last4: string | null;
  }>(
    `SELECT b.trip_id, b.chat_id, b.chat_title, b.phone_last4, l.account_user_id AS person_account,
            coalesce(l.display_name, l.participant_username, u.display_name) AS person_name,
            coalesce(t.title, t.destination_label) AS trip_title
       FROM control_plane.telegram_chat_bindings b
       JOIN control_plane.trips t ON t.id = b.trip_id
       LEFT JOIN control_plane.trip_person_links l
              ON l.trip_id = b.trip_id AND l.platform = 'whatsapp' AND b.chat_id = l.telegram_user_id || '@p'
       LEFT JOIN control_plane.users u ON u.id = l.account_user_id
      WHERE b.id = $1 AND b.platform = 'whatsapp' AND b.closed_at IS NULL`,
    [input.bindingId],
  );
  const row = b.rows[0];
  if (!row) return [];
  const isGroup = WHATSAPP_GROUP_CHAT_ID.test(row.chat_id);
  const facts = await companionIntroFacts(db, row.trip_id).catch(() => null);
  const language = facts?.language === "he" ? "he" : "en";
  const payload = { kind: isGroup ? "group" : "person", name: isGroup ? row.chat_title : row.person_name, trip_title: row.trip_title, language };
  const text = whatsappConnectionNoticeText(payload);
  if (!text) return [];

  const owners = await db.query<{ user_id: string }>(
    `SELECT DISTINCT m.user_id FROM control_plane.trip_memberships m
      WHERE m.trip_id = $1 AND m.role = 'owner' AND m.status = 'active'`,
    [row.trip_id],
  );
  /** The Telegram fallback through the existing outbox, else the dashboard only. */
  const viaTelegramOrDashboard = async (ownerId: string, notice: Record<string, unknown>): Promise<OwnerNotice> => {
    const tg = await db.query<{ chat_id: string }>(
      `SELECT b3.chat_id FROM control_plane.telegram_chat_bindings b3
         JOIN control_plane.telegram_organizer_links o
           ON o.user_id = $2 AND o.telegram_subject_digest = 'sha256:' || encode(sha256(convert_to(b3.chat_id, 'UTF8')), 'hex')
        WHERE b3.trip_id = $1 AND b3.closed_at IS NULL AND b3.chat_id ~ '^[0-9]{1,20}$'
        ORDER BY b3.created_at DESC LIMIT 1`,
      [row.trip_id, ownerId],
    );
    if (!tg.rows[0]) return { userId: ownerId, channel: "dashboard_only" };
    await db.query(
      `INSERT INTO control_plane.notification_outbox
         (id, trip_id, kind, recipient, payload, signup_request_id, notification_type, adapter, state)
       VALUES ($1, $2, $3, $4, $5::jsonb, NULL, $3, 'control-plane', 'pending')`,
      [opaque("notif"), row.trip_id, CONNECTION_NOTICE_TYPE, tg.rows[0].chat_id, JSON.stringify(notice)],
    );
    return { userId: ownerId, channel: "telegram" };
  };

  const notices: OwnerNotice[] = [];
  for (const { user_id: ownerId } of owners.rows) {
    if (!isGroup && row.person_account === ownerId) {
      // The owner's own FIRST connection is not announced to them.
      if (!input.replaced) continue;
      // It replaced an earlier one: tell them in the PREVIOUS chat, never in this new one. The payload (which the outbox
      // stores for the Telegram fallback) carries the trip, the language and the last four; the address stays in memory.
      const replacedNotice = { kind: "replaced", last4: cleanLast4(row.phone_last4), trip_title: row.trip_title, language };
      const replacedText = whatsappConnectionNoticeText(replacedNotice);
      if (!replacedText) continue;
      if (deps.sendWhatsAppToAddress) {
        try {
          await deps.sendWhatsAppToAddress({ chatId: input.replaced.chatId, transportAddress: input.replaced.transportAddress }, replacedText);
          notices.push({ userId: ownerId, channel: "whatsapp" });
          continue;
        } catch (error) {
          log(structuredLog("warn", "whatsapp.owner_notice_failed", { safe_error_code: error instanceof Error ? error.name : "UNKNOWN", notice: "replaced", fallback: "telegram" }));
        }
      }
      notices.push(await viaTelegramOrDashboard(ownerId, replacedNotice));
      continue;
    }
    const wa = await db.query<{ chat_id: string }>(
      `SELECT b2.chat_id FROM control_plane.telegram_chat_bindings b2
         JOIN control_plane.trip_person_links l2
           ON l2.trip_id = b2.trip_id AND l2.platform = 'whatsapp' AND b2.chat_id = l2.telegram_user_id || '@p'
        WHERE b2.trip_id = $1 AND b2.platform = 'whatsapp' AND b2.closed_at IS NULL AND l2.account_user_id = $2
        ORDER BY b2.created_at DESC LIMIT 1`,
      [row.trip_id, ownerId],
    );
    if (wa.rows[0]) {
      try {
        await deps.sendWhatsApp(wa.rows[0].chat_id, text);
        notices.push({ userId: ownerId, channel: "whatsapp" });
        continue;
      } catch (error) {
        log(structuredLog("warn", "whatsapp.owner_notice_failed", { safe_error_code: error instanceof Error ? error.name : "UNKNOWN", fallback: "telegram" }));
      }
    }
    notices.push(await viaTelegramOrDashboard(ownerId, payload));
  }
  return notices;
}

// ── Failed-attempt limits (AC-12) ───────────────────────────────────────────────────────────────────────────────────

/**
 * Failed code attempts, kept in the relay's MEMORY (a restart resets them). More than `perChatPerHour` failures from one
 * chat silence code handling for that chat for the rest of that hour. More than 50 failures across all chats in an hour
 * raise ONE alert log line and silence nothing: one global cut-off would let anyone who can message the number stop every
 * family from connecting.
 */
export class CodeAttemptLimiter {
  private readonly perChat = new Map<string, { windowStart: number; failures: number }>();
  private global = { windowStart: 0, failures: 0, alerted: false };

  constructor(
    private readonly options: { perChatPerHour?: number; now?: () => number; log?: (line: string) => void } = {},
  ) {}

  private get limit(): number { return this.options.perChatPerHour ?? DEFAULT_CODE_ATTEMPTS_PER_HOUR; }
  private now(): number { return (this.options.now ?? Date.now)(); }
  private static readonly HOUR = 3_600_000;

  /** Is code handling silenced for this chat right now? */
  silenced(chatId: string): boolean {
    const entry = this.perChat.get(chatId);
    if (!entry) return false;
    if (this.now() - entry.windowStart >= CodeAttemptLimiter.HOUR) { this.perChat.delete(chatId); return false; }
    return entry.failures > this.limit;
  }

  recordFailure(chatId: string): void {
    const now = this.now();
    let entry = this.perChat.get(chatId);
    if (!entry || now - entry.windowStart >= CodeAttemptLimiter.HOUR) entry = { windowStart: now, failures: 0 };
    entry.failures += 1;
    this.perChat.set(chatId, entry);
    if (now - this.global.windowStart >= CodeAttemptLimiter.HOUR) this.global = { windowStart: now, failures: 0, alerted: false };
    this.global.failures += 1;
    if (this.global.failures > GLOBAL_FAILURES_PER_HOUR_ALERT && !this.global.alerted) {
      this.global.alerted = true;
      (this.options.log ?? (() => {}))(structuredLog("warn", "whatsapp.code_failures_high", {
        failures_last_hour: this.global.failures, effect: "alert only; code handling is not silenced for other chats",
      }));
    }
    // Bound the map: drop windows that ended.
    if (this.perChat.size > 5000) {
      for (const [key, value] of this.perChat) if (now - value.windowStart >= CodeAttemptLimiter.HOUR) this.perChat.delete(key);
    }
  }
}

export type CodeMessageOutcome =
  | { handled: false }
  | { handled: true; silenced: true; reply: null }
  | { handled: true; silenced: false; result: RedeemResult; reply: string | null };

/**
 * The relay's whole code step for one inbound message, called with plain arguments: no token of the code shape in the text
 * is `handled: false` and nothing is said; a silenced chat is `handled: true` with no reply and no database read; otherwise
 * the code is redeemed and its one fixed reply returned. A failure counts against the chat; a success or an
 * already-connected group does not.
 */
export async function handleCodeMessage(
  db: pg.Pool,
  limiter: CodeAttemptLimiter,
  input: RedeemInput,
): Promise<CodeMessageOutcome> {
  if (extractChatBindingCode(input.text) === null && !input.code) return { handled: false };
  if (limiter.silenced(input.chatId)) return { handled: true, silenced: true, reply: null };
  const result = await redeemChatBindingCode(db, input);
  if (!result.ok && result.reason !== "NOT_A_CODE") limiter.recordFailure(input.chatId);
  return { handled: true, silenced: false, result, reply: redeemReplyLine(result) };
}

