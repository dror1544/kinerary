/**
 * ONE ORGANIZER, ONE TELEGRAM (#519): what happens when an interview link is opened by a Telegram account that is not
 * the one the organizer's account is bound to.
 *
 * The rule itself -- "is this account bound, and is it this one?" -- is `organizerBindingVerdict` (organizer-trips.ts),
 * asked inside `startSession`'s own transaction. This module is what follows a "no":
 *
 *   - the interview had already started: the stranger is refused, the bound organizer is told once (`refused`);
 *   - it had not: the bound organizer is asked (`pending`), and only their answer moves anything.
 *
 * WHAT DECIDES. Only facts the bot read off updates Telegram delivered on its own authenticated connection:
 *   - who OPENED the link: the update's private chat id, passed in by the router and stored on the request;
 *   - who ANSWERS: `callback_query.from.id` (or the sender of a typed message), required to be the request's stored
 *     approver chat AND to hash to the stored approver digest AND to still be bound to the account. The callback payload
 *     carries only a request id and a choice; the request row says whose question it is, and the sender must be that
 *     person. A tap from any other chat, a second tap, or a tap after the link expired changes nothing.
 * Nothing a message says -- no name, no text -- is ever compared; names are display data.
 *
 * WHAT T1 LEARNS. Nothing about the trip, at any point: every sentence sent to the stranger is a fixed string with no
 * destination, no dates, no title and no name (intake-copy.ts `linkOther*`). The trip's title goes only to the bound
 * organizer, who owns it.
 *
 * THE LINK IS NOT SPENT BY A REFUSAL. `startSession` rolls the whole transaction back when the verdict is "other account",
 * so the enrollment is still `issued` and the organizer can use it. A retry by the stranger runs the same check against
 * the same rows and gets the same answer: nothing the stranger does between attempts can turn it into a "yes". The only
 * way in is the organizer's approval, below, which consumes the enrollment itself.
 */
import { randomBytes } from "node:crypto";
import type pg from "pg";
import { consumeEnrollmentByIdInTx } from "./enrollment.js";
import { digestTelegramId, isPrivateChatId, type TelegramName } from "./identity.js";
import { coerceLanguage, type Language } from "./intake-copy.js";
import { startSessionInTx, type SessionView } from "./interview.js";
import { boundTelegramAccounts, hasEarlierBuiltTrip, organizerBindingVerdict, privateChatForDigest } from "./organizer-trips.js";
import { structuredLog } from "./redaction.js";
import { revokeOrganizerLinkInTx } from "./telegram-mini-app.js";

const opaque = (prefix: string) => `${prefix}_${randomBytes(16).toString("hex")}`;

// ── Opening a link that belongs to someone else ──────────────────────────────

/** What the organizer's own chat is sent, built by the caller (dispatch) in that chat's language. */
export interface ApproverNotice {
  /** `ask`: an Approve/Decline question. `refused`: a plain "someone else opened your link". */
  kind: "ask" | "refused";
  chatId: string;
  requestId: string;
  /** Said only to the organizer, who owns the trip. */
  tripTitle: string | null;
  requester: TelegramName | null;
}

export interface ForeignLinkResult {
  /**
   * What the stranger is told. Three fixed sentences, none of which names the trip:
   *   belongs_elsewhere  "this link belongs to another organizer, ask them"
   *   asked              "the organizer has been asked to approve"
   *   not_approved       "the organizer did not approve this"
   */
  toRequester: "belongs_elsewhere" | "asked" | "not_approved";
  /** Present only the FIRST time (the request row is what dedupes it), so a retry never repeats a message to the organizer. */
  toApprover?: ApproverNotice;
}

/**
 * The link was valid and the redeemer is the wrong Telegram account (`startSession` said `OTHER_TELEGRAM_ACCOUNT`, having
 * rolled everything back). Records the fact, once per (link, account), and says what to send.
 *
 * Null when the link is no longer open or the answer changed meanwhile (the account became the bound one, say): the caller
 * answers "bad link", and a retry runs the ordinary path afresh.
 */
export async function recordForeignLinkOpen(
  db: pg.Pool,
  input: {
    enrollmentId: string;
    tripId: string;
    userId: string;
    started: boolean;
    requesterChatId: string;
    requesterName: TelegramName | null;
    requesterLanguage: string | undefined;
  },
  log: (line: string) => void = () => {},
): Promise<ForeignLinkResult | null> {
  if (!isPrivateChatId(input.requesterChatId)) return null;
  const requesterDigest = digestTelegramId(input.requesterChatId);
  const client = await db.connect();
  try {
    await client.query("BEGIN");
    // The same lock `startSession` and an approval take first: one writer per link at a time.
    const enrollment = await client.query<{ state: string; expires_at: Date }>(
      "SELECT state, expires_at FROM control_plane.interview_enrollments WHERE id = $1 FOR UPDATE",
      [input.enrollmentId],
    );
    const link = enrollment.rows[0];
    if (!link || link.state !== "issued" || link.expires_at.getTime() <= Date.now()) {
      await client.query("ROLLBACK");
      return null;
    }
    // Re-asked under the lock: the world may have moved since `startSession` rolled back.
    const verdict = await organizerBindingVerdict(client, { userId: input.userId, tripId: input.tripId, telegramUserId: input.requesterChatId });
    if (verdict.kind !== "other_account") {
      await client.query("ROLLBACK");
      return null;
    }

    const prior = await client.query<{ id: string; state: string }>(
      "SELECT id, state FROM control_plane.organizer_link_requests WHERE enrollment_id = $1 AND requester_digest = $2 FOR UPDATE",
      [input.enrollmentId, requesterDigest],
    );
    const seen = prior.rows[0];
    if (seen) {
      let toRequester: ForeignLinkResult["toRequester"];
      if (seen.state === "pending" && verdict.started) {
        // The interview started while the question was open: there is nothing left to approve.
        await client.query("UPDATE control_plane.organizer_link_requests SET state = 'refused', decided_at = now() WHERE id = $1", [seen.id]);
        toRequester = "belongs_elsewhere";
      } else {
        toRequester = seen.state === "pending" ? "asked" : seen.state === "refused" ? "belongs_elsewhere" : "not_approved";
      }
      await client.query("COMMIT");
      log(structuredLog("info", "organizer_link.repeat_open", { request_state: seen.state }));
      return { toRequester };
    }

    // Who can be asked: the first bound account whose private chat is on record. None: nobody is asked, fail closed.
    let approver: { digest: string; chatId: string } | null = null;
    for (const account of verdict.bound) {
      const chatId = await privateChatForDigest(client, input.userId, account.digest);
      if (chatId) { approver = { digest: account.digest, chatId }; break; }
    }
    // AC-10: a pair the owner Unlinked from this trip is never re-bound, approved or not, so there is nothing to ask.
    const unlinkedPair = (await client.query(
      `SELECT 1 FROM control_plane.telegram_organizer_trip_links
        WHERE telegram_subject_digest = $1 AND user_id = $2 AND trip_id = $3 AND revoked_at IS NOT NULL LIMIT 1`,
      [requesterDigest, input.userId, input.tripId],
    )).rowCount ?? 0;
    const otherPending = (await client.query(
      "SELECT 1 FROM control_plane.organizer_link_requests WHERE enrollment_id = $1 AND state = 'pending' LIMIT 1",
      [input.enrollmentId],
    )).rowCount ?? 0;
    const asking = !verdict.started && approver !== null && unlinkedPair === 0 && otherPending === 0;

    const requestId = opaque("olr");
    await client.query(
      `INSERT INTO control_plane.organizer_link_requests
         (id, enrollment_id, trip_id, user_id, requester_digest, requester_chat_id, requester_first_name, requester_username,
          requester_language, approver_digest, approver_chat_id, state)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)`,
      [
        requestId, input.enrollmentId, input.tripId, input.userId, requesterDigest, input.requesterChatId,
        input.requesterName?.firstName ?? null, input.requesterName?.username ?? null, coerceLanguage(input.requesterLanguage) ?? null,
        approver?.digest ?? null, approver?.chatId ?? null, asking ? "pending" : "refused",
      ],
    );
    // The organizer hears about a refusal only when there is no question already open in front of them.
    const notify = approver !== null && otherPending === 0;
    const title = notify ? await tripTitle(client, input.tripId) : null;
    await client.query("COMMIT");
    log(structuredLog("info", "organizer_link.foreign_open", {
      outcome: asking ? "asked" : "refused", started: verdict.started, approver_reachable: approver !== null,
    }));
    if (!notify) return { toRequester: asking ? "asked" : "belongs_elsewhere" };
    return {
      toRequester: asking ? "asked" : "belongs_elsewhere",
      toApprover: { kind: asking ? "ask" : "refused", chatId: approver!.chatId, requestId, tripTitle: title, requester: input.requesterName },
    };
  } catch (error) {
    try { await client.query("ROLLBACK"); } catch { /* ignore */ }
    throw error;
  } finally {
    client.release();
  }
}

async function tripTitle(client: Pick<pg.PoolClient, "query">, tripId: string): Promise<string | null> {
  const row = await client.query<{ title: string | null }>("SELECT title FROM control_plane.trips WHERE id = $1", [tripId]);
  const title = row.rows[0]?.title?.trim();
  return title ? title : null;
}

// ── The organizer's answer ───────────────────────────────────────────────────

export type LinkChoice = "approve" | "decline";

export type LinkDecisionResult =
  /** Not theirs, not open, already answered, or the link has expired. Nothing changed. */
  | { kind: "not_pending" }
  /** Declined. `requester` is who to tell. */
  | { kind: "declined"; requester: { chatId: string; language: Language | null } }
  /** Approved and applied: the requester is the trip's organizer and has a session. */
  | {
      kind: "approved";
      requester: { chatId: string; language: Language | null };
      tripId: string;
      tripTitle: string | null;
      requesterName: TelegramName | null;
      sessionId: string;
      view: SessionView;
      returning: boolean;
      seeded?: Extract<Awaited<ReturnType<typeof startSessionInTx>>["result"], { ok: true }>["seeded"];
    }
  /** Approval could not be applied (an interview started meanwhile, or the requester was Unlinked): nothing changed, the request is closed. */
  | { kind: "not_applicable" }
  /** The requester is mid-interview in their own chat right now; nothing changed and the question stays open. */
  | { kind: "requester_busy" };

interface RequestRow {
  id: string;
  enrollment_id: string;
  trip_id: string;
  user_id: string;
  requester_digest: string;
  requester_chat_id: string;
  requester_first_name: string | null;
  requester_username: string | null;
  requester_language: string | null;
  approver_digest: string | null;
  approver_chat_id: string | null;
  state: string;
}

/** Pending questions waiting on this chat whose link is still open. Newest first. */
export async function pendingRequestIdsForChat(db: pg.Pool, chatId: string): Promise<string[]> {
  if (!isPrivateChatId(chatId)) return [];
  const rows = await db.query<{ id: string }>(
    `SELECT r.id
       FROM control_plane.organizer_link_requests r
       JOIN control_plane.interview_enrollments e ON e.id = r.enrollment_id
      WHERE r.approver_chat_id = $1 AND r.state = 'pending' AND e.state = 'issued' AND e.expires_at > now()
      ORDER BY r.created_at DESC`,
    [chatId],
  );
  return rows.rows.map((row) => row.id);
}

/**
 * The organizer answers a question. `chatId` and `fromId` are the update's own: the chat the tap came from and the person
 * who tapped. Both must be the request's approver, who must still be bound to the account.
 */
export async function answerLinkRequest(
  db: pg.Pool,
  input: { requestId: string; choice: LinkChoice; chatId: string; fromId: string },
  log: (line: string) => void = () => {},
): Promise<LinkDecisionResult> {
  // A private chat of the tapper's own: a button forwarded or copied into any other chat does nothing.
  if (!isPrivateChatId(input.chatId) || input.fromId !== input.chatId) return { kind: "not_pending" };
  const approverDigest = digestTelegramId(input.fromId);

  const client = await db.connect();
  try {
    await client.query("BEGIN");
    // Lock order = recordForeignLinkOpen's: the enrollment, then the request.
    const peek = await client.query<{ enrollment_id: string }>(
      "SELECT enrollment_id FROM control_plane.organizer_link_requests WHERE id = $1",
      [input.requestId],
    );
    if (!peek.rows[0]) { await client.query("ROLLBACK"); return { kind: "not_pending" }; }
    const enrollmentId = peek.rows[0].enrollment_id;
    const enrollment = await client.query<{ state: string; expires_at: Date }>(
      "SELECT state, expires_at FROM control_plane.interview_enrollments WHERE id = $1 FOR UPDATE",
      [enrollmentId],
    );
    const request = (await client.query<RequestRow>(
      "SELECT * FROM control_plane.organizer_link_requests WHERE id = $1 FOR UPDATE",
      [input.requestId],
    )).rows[0];
    const link = enrollment.rows[0];
    if (!request || request.state !== "pending" || request.approver_chat_id !== input.chatId || request.approver_digest !== approverDigest) {
      await client.query("ROLLBACK");
      return { kind: "not_pending" };
    }
    // The link has gone (expired, used by its owner, replaced): the question is moot, and says so from now on.
    if (!link || link.state !== "issued" || link.expires_at.getTime() <= Date.now()) {
      await client.query("UPDATE control_plane.organizer_link_requests SET state = 'expired', decided_at = now() WHERE id = $1", [request.id]);
      await client.query("COMMIT");
      return { kind: "not_pending" };
    }
    // Still the account's Telegram? One Unlinked since the question was asked is no longer entitled to answer it.
    const stillBound = (await boundTelegramAccounts(client, request.user_id, request.trip_id)).some((account) => account.digest === approverDigest);
    if (!stillBound) {
      await client.query("UPDATE control_plane.organizer_link_requests SET state = 'expired', decided_at = now() WHERE id = $1", [request.id]);
      await client.query("COMMIT");
      return { kind: "not_pending" };
    }
    const requesterLanguage = coerceLanguage(request.requester_language) ?? null;
    const requester = { chatId: request.requester_chat_id, language: requesterLanguage };

    if (input.choice === "decline") {
      await client.query("UPDATE control_plane.organizer_link_requests SET state = 'declined', decided_at = now() WHERE id = $1", [request.id]);
      await client.query("COMMIT");
      log(structuredLog("info", "organizer_link.declined", { trip_id: request.trip_id }));
      return { kind: "declined", requester };
    }

    // ── Approve ──────────────────────────────────────────────────────────────
    // The requester cannot be put into an interview while one is running in their own chat.
    const busy = await client.query(
      "SELECT 1 FROM control_plane.intake_sessions WHERE telegram_chat_id = $1 AND state <> 'confirmed' AND expired_at IS NULL LIMIT 1",
      [request.requester_chat_id],
    );
    if (busy.rowCount) { await client.query("ROLLBACK"); return { kind: "requester_busy" }; }

    const consumed = await consumeEnrollmentByIdInTx(client, enrollmentId);
    if (!consumed) { await client.query("ROLLBACK"); return { kind: "not_pending" }; }

    // The old Telegram account leaves THIS trip: its live link(s) are revoked exactly as an Unlink revokes them (the
    // chat's hold on the trip, the bot's organizer fact and its web sessions go with them). Done BEFORE `startSessionInTx`
    // takes the trip lock, so the chat bindings are locked before the trip row, which is teardown's own order. Its links to
    // OTHER trips are not touched. A rollback below undoes all of it.
    const old = await client.query<{ id: string }>(
      `SELECT id FROM control_plane.telegram_organizer_trip_links
        WHERE user_id = $1 AND trip_id = $2 AND telegram_subject_digest = $3 AND revoked_at IS NULL FOR UPDATE`,
      [request.user_id, request.trip_id, approverDigest],
    );
    for (const row of old.rows) await revokeOrganizerLinkInTx(client, request.user_id, row.id);

    const requesterName: TelegramName | null = request.requester_first_name || request.requester_username
      ? { firstName: request.requester_first_name, username: request.requester_username }
      : null;
    const started = await startSessionInTx(client, consumed, {
      verifiedTelegramChatId: request.requester_chat_id,
      languageHint: request.requester_language ?? undefined,
      telegramName: requesterName,
      approvedReplacement: true,
    });
    if (!started.result.ok) {
      await client.query("ROLLBACK");
      // Closed on its own, so the organizer's next tap says "no longer open" rather than failing the same way again.
      await db.query("UPDATE control_plane.organizer_link_requests SET state = 'expired', decided_at = now() WHERE id = $1 AND state = 'pending'", [request.id]);
      log(structuredLog("warn", "organizer_link.approval_not_applicable", { reason: started.result.reason }));
      return { kind: "not_applicable" };
    }
    await client.query("UPDATE control_plane.organizer_link_requests SET state = 'approved', decided_at = now() WHERE id = $1", [request.id]);
    const title = await tripTitle(client, request.trip_id);
    await client.query("COMMIT");
    for (const line of started.logs) log(line);
    log(structuredLog("info", "organizer_link.approved", { trip_id: request.trip_id, session_id: started.result.sessionId }));

    // Which opening they meet; a failure here must not cost them the interview, which is already started.
    let returning = false;
    try { returning = await hasEarlierBuiltTrip(db, request.trip_id, request.requester_chat_id); } catch { returning = false; }
    return {
      kind: "approved",
      requester,
      tripId: request.trip_id,
      tripTitle: title,
      requesterName,
      sessionId: started.result.sessionId,
      view: started.result.view,
      returning,
      ...(started.result.seeded ? { seeded: started.result.seeded } : {}),
    };
  } catch (error) {
    try { await client.query("ROLLBACK"); } catch { /* ignore */ }
    throw error;
  } finally {
    client.release();
  }
}

// ── The typed form of the two buttons ────────────────────────────────────────

/**
 * "approve" / "decline" typed, as the buttons' words (AC-7: buttons are shortcuts, not syntax).
 *
 * Deliberately narrow: the WHOLE message, and only words that mean nothing else. "yes", "no", "ok", כן and לא are not
 * here, because the same chat may be answering something else (an interview's confirmation), and a bare "yes" must never
 * hand a trip to a stranger. A message that is not exactly one of these is somebody talking, not answering.
 */
const APPROVE_WORDS = new Set(["approve", "approved", "i approve", "אישור", "מאשר", "מאשרת", "מאשרים", "אשר", "אשרו"]);
const DECLINE_WORDS = new Set(["decline", "declined", "deny", "reject", "i decline", "דחייה", "דחיה", "דוחה", "דוחים", "דחה", "דחו", "לא מאשר", "לא מאשרת", "לא מאשרים"]);

export function linkAnswerFromText(text: string): LinkChoice | null {
  const word = text.normalize("NFKC").trim().toLowerCase().replace(/[\s.!,;:…]+$/u, "").replace(/\s+/gu, " ");
  if (APPROVE_WORDS.has(word)) return "approve";
  if (DECLINE_WORDS.has(word)) return "decline";
  return null;
}
