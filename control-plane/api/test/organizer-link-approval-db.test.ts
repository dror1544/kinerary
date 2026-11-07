/**
 * #519: one organizer, one Telegram. A link opened by a different Telegram account is refused, or needs the organizer's
 * approval. Each test is named after the acceptance criterion in docs/specs/sprint-8/519-one-organizer-telegram.md that it
 * proves.
 *
 * Everything goes through the real thing: `/start <token>` and the Approve / Decline taps through `dispatchUpdate`, the
 * decisions through `applyDecision` against a recording Telegram client, a real Postgres. The organizer is "T0", the
 * stranger "T1". The only fixtures written by hand are the rows a dashboard would write (a trip, its link) and the clock.
 */
import assert from "node:assert/strict";
import { createHash, randomBytes } from "node:crypto";
import { after, before, describe, test } from "node:test";
import { fileURLToPath } from "node:url";
import pg from "pg";
import { issueEnrollment } from "../src/enrollment.js";
import { digestTelegramId } from "../src/identity.js";
import { UI_STRINGS, uiString } from "../src/intake-copy.js";
import { claimExpiredSessions } from "../src/interview.js";
import { applyMigrations } from "../src/migrations.js";
import { linkAnswerFromText } from "../src/organizer-link-approval.js";
import { DEFAULT_STRINGS, dispatchUpdate, type DispatchDecision } from "../src/relay/dispatch.js";
import type { TelegramUpdate } from "../src/relay/normalize.js";
import { applyDecision } from "../src/relay/poller.js";
import { issueTelegramLinkToken, redeemTelegramLinkToken } from "../src/telegram-link-token.js";
import { testDatabaseUrl, testPool } from "./support/test-database.js";

const skip = !testDatabaseUrl();
const migrationsDir = fileURLToPath(new URL("../../db/migrations/", import.meta.url));
const id = (prefix: string) => `${prefix}_${randomBytes(16).toString("hex")}`;

let pool: pg.Pool;
let chatSeq = 880000000;
const nextChat = () => String(++chatSeq);
const digestOf = (chat: string) => digestTelegramId(chat);

before(async () => {
  if (skip) return;
  pool = testPool({ max: 6 });
  const client = await pool.connect();
  try {
    await client.query("DROP SCHEMA IF EXISTS control_plane CASCADE");
    await client.query("DROP TABLE IF EXISTS public.control_plane_schema_migrations");
    await applyMigrations(client, migrationsDir);
  } finally { client.release(); }
});
after(async () => { if (!skip) await pool.end(); });

// ── fixtures ────────────────────────────────────────────────────────────────

async function organizer(): Promise<string> {
  const userId = id("user");
  await pool.query("INSERT INTO control_plane.users(id, status, display_name) VALUES ($1, 'active', 'kin.test+local')", [userId]);
  return userId;
}

/** A trip as the dashboard leaves it: a draft owned by `userId`, with a title and a destination only its organizer may hear. */
async function draftTrip(userId: string, title = "Secret Kyoto Honeymoon") {
  const tripId = id("trip");
  await pool.query(
    "INSERT INTO control_plane.trips(id, slug, title, destination_label, lifecycle_state) VALUES ($1, $2, $3, 'Kyoto', 'draft')",
    [tripId, tripId.replace(/_/g, "-"), title]);
  await pool.query("INSERT INTO control_plane.trip_memberships(id, trip_id, user_id, role, status, dashboard_access) VALUES ($1, $2, $3, 'owner', 'active', true)", [id("memb"), tripId, userId]);
  const issued = await issueEnrollment(pool, userId, tripId, { enrollmentTtlSeconds: 3600 });
  assert.ok(issued.ok);
  return { tripId, token: issued.token, userId, title };
}

const tokenDigest = (token: string) => `sha256:${createHash("sha256").update(token).digest("hex")}`;
const enrollmentState = async (token: string) =>
  (await pool.query("SELECT state FROM control_plane.interview_enrollments WHERE token_digest = $1", [tokenDigest(token)])).rows[0]?.state as string;

function from(chat: string, firstName = "Telegram-User", username?: string, languageCode?: string) {
  return { id: Number(chat), first_name: firstName, ...(username ? { username } : {}), ...(languageCode ? { language_code: languageCode } : {}) };
}
function startUpdate(chat: string, token: string, who = from(chat), chatType = "private"): TelegramUpdate {
  return { update_id: 1, message: { message_id: 7, from: who, chat: { id: chat, type: chatType }, text: `/start ${token}` } } as unknown as TelegramUpdate;
}
function textUpdate(chat: string, text: string, who = from(chat)): TelegramUpdate {
  return { update_id: 2, message: { message_id: 8, from: who, chat: { id: chat, type: "private" }, text } } as unknown as TelegramUpdate;
}
function tapUpdate(chat: string, data: string, who = from(chat)): TelegramUpdate {
  return { update_id: 3, callback_query: { id: `cbq-${randomBytes(4).toString("hex")}`, data, from: who, message: { message_id: 9, chat: { id: chat, type: "private" } } } } as unknown as TelegramUpdate;
}

/** T0 opens the first trip's link: the way an organizer becomes bound at all, and the way the bot learns T0's chat. */
async function boundOrganizer(language?: string, options: { leaveInterviewRunning?: boolean } = {}) {
  const user = await organizer();
  const first = await draftTrip(user, "First Trip");
  const t0 = nextChat();
  const opened = await dispatchUpdate(pool, startUpdate(t0, first.token, from(t0, "Dana", "dana_k", language)));
  assert.equal(opened.kind, "reply");
  // The first interview is over by the time the next link is opened (a chat already in an interview is told so and its
  // link is left alone); one test keeps it running to show the approval buttons still work from inside another interview.
  if (!options.leaveInterviewRunning) {
    await pool.query("UPDATE control_plane.intake_sessions SET expired_at = now() WHERE telegram_chat_id = $1 AND expired_at IS NULL", [t0]);
  }
  return { user, t0, firstTripId: first.tripId };
}

/** Telegram, recorded: every message sent and every tap answered, in order. */
function recorder() {
  const sent: Array<{ chatId: string; text: string; replyMarkup?: unknown }> = [];
  const answered: Array<{ text?: string }> = [];
  const deps = {
    db: pool, connector: { pushInbound: () => true }, log: () => {},
    telegram: {
      sendMessage: async (p: { chatId: string; text: string; replyMarkup?: unknown }) => { sent.push(p); return { ok: true as const, messageId: "1" }; },
      answerCallbackQuery: async (p: { text?: string }) => { answered.push(p); },
    },
  } as never;
  return { sent, answered, deps };
}

type Multi = Extract<DispatchDecision, { kind: "multi_reply" }>;
function multi(decision: DispatchDecision): Multi {
  assert.equal(decision.kind, "multi_reply", JSON.stringify(decision).slice(0, 300));
  return decision as Multi;
}
const buttons = (reply: { replyMarkup?: { inline_keyboard: Array<Array<{ text: string; callback_data?: string }>> } }) =>
  (reply.replyMarkup?.inline_keyboard ?? []).flat();
const approveData = (reply: Parameters<typeof buttons>[0]) => buttons(reply).find((b) => b.callback_data?.endsWith(":a"))!.callback_data!;
const declineData = (reply: Parameters<typeof buttons>[0]) => buttons(reply).find((b) => b.callback_data?.endsWith(":d"))!.callback_data!;

const sessionsFor = async (chat: string) =>
  (await pool.query("SELECT * FROM control_plane.intake_sessions WHERE telegram_chat_id = $1", [chat])).rows;
const liveLinks = async (tripId: string, chat: string) =>
  (await pool.query(
    "SELECT * FROM control_plane.telegram_organizer_trip_links WHERE trip_id = $1 AND telegram_subject_digest = $2 AND revoked_at IS NULL", [tripId, digestOf(chat)])).rows;
const requestsFor = async (tripId: string) =>
  (await pool.query("SELECT * FROM control_plane.organizer_link_requests WHERE trip_id = $1 ORDER BY created_at", [tripId])).rows;

/** A bound organizer, and a draft trip of theirs that nobody has started, with T0 linked to it as a dashboard link would. */
async function askScenario(options: { linkedToTrip?: boolean; language?: string; leaveInterviewRunning?: boolean } = {}) {
  const base = await boundOrganizer(options.language, { leaveInterviewRunning: options.leaveInterviewRunning });
  const trip = await draftTrip(base.user);
  if (options.linkedToTrip) {
    await pool.query(
      `INSERT INTO control_plane.telegram_organizer_trip_links(id, user_id, trip_id, telegram_subject_digest, verified_via)
       VALUES ($1, $2, $3, $4, 'dashboard_link_token')`, [id("otl"), base.user, trip.tripId, digestOf(base.t0)]);
  }
  const t1 = nextChat();
  return { ...base, trip, t1, t1Who: from(t1, "Mallory", "mal_lory") };
}

/** A trip whose interview exists and is not running: the trip a stranger holding a forwarded link would try. Returns a fresh link. */
async function pausedTripWithLink() {
  const base = await boundOrganizer();
  const trip = await draftTrip(base.user, "Paused Trip Title");
  const t0 = base.t0;
  // T0 runs the interview on this trip, then the sweep closes it: paused, with a new link issued for it.
  await pool.query("UPDATE control_plane.intake_sessions SET expires_at = now() - interval '1 minute' WHERE trip_id = $1 AND expired_at IS NULL", [base.firstTripId]);
  await claimExpiredSessions(pool, 100);
  const opened = await dispatchUpdate(pool, startUpdate(t0, trip.token));
  assert.equal(opened.kind, "reply");
  await pool.query("UPDATE control_plane.intake_sessions SET expires_at = now() - interval '1 minute' WHERE trip_id = $1 AND expired_at IS NULL", [trip.tripId]);
  assert.ok((await claimExpiredSessions(pool, 100)).length >= 1);
  const reissued = await issueEnrollment(pool, base.user, trip.tripId, { enrollmentTtlSeconds: 3600 });
  assert.ok(reissued.ok, "a paused trip is handed a new link (#513)");
  return { ...base, trip: { ...trip, token: reissued.ok ? reissued.token : "" }, t1: nextChat() };
}

// ── AC-1, AC-2 ──────────────────────────────────────────────────────────────

describe("AC-1 and AC-2: the bound account, and the first one", { skip }, () => {
  test("AC-1 an account with no Telegram bound: whoever opens the link is bound as the organizer, and the interview starts", async () => {
    const user = await organizer();
    const trip = await draftTrip(user);
    const t = nextChat();
    const decision = await dispatchUpdate(pool, startUpdate(t, trip.token));
    assert.equal(decision.kind, "reply", "the ordinary opening, not a refusal");
    assert.equal((await liveLinks(trip.tripId, t)).length, 1, "bound as the trip's organizer");
    assert.equal((await sessionsFor(t)).length, 1, "the interview started");
    assert.equal(await enrollmentState(trip.token), "consumed");
    assert.equal((await requestsFor(trip.tripId)).length, 0, "nothing was asked of anyone");
  });

  test("AC-2 the bound account opens a link for another of its trips: unchanged, no question, no refusal", async () => {
    const { user, t0 } = await boundOrganizer();
    const second = await draftTrip(user, "Second Trip");
    const decision = await dispatchUpdate(pool, startUpdate(t0, second.token));
    assert.equal(decision.kind, "reply");
    assert.equal((await sessionsFor(t0)).filter((s) => s.trip_id === second.tripId).length, 1);
    assert.equal((await requestsFor(second.tripId)).length, 0);
  });

  test("AC-2 the bound account resumes its own paused interview (#517 rules unchanged)", async () => {
    const { t0, trip } = await pausedTripWithLink();
    const decision = await dispatchUpdate(pool, startUpdate(t0, trip.token));
    assert.equal(decision.kind, "reply");
    if (decision.kind !== "reply") return;
    assert.equal(decision.reply.text, uiString("resumedOpening", "en"));
    assert.equal((await requestsFor(trip.tripId)).length, 0);
  });

  test("the account's Telegram SIGN-UP identity counts as bound too (one definition: links or identity)", async () => {
    const user = await organizer();
    const signupChat = nextChat();
    await pool.query(
      "INSERT INTO control_plane.user_identities(id, user_id, provider, provider_subject_digest, provider_subject_id, verified_at) VALUES ($1, $2, 'telegram', $3, $4, now())",
      [id("idnt"), user, digestOf(signupChat), signupChat]);
    const trip = await draftTrip(user);
    const stranger = nextChat();
    const asked = multi(await dispatchUpdate(pool, startUpdate(stranger, trip.token)));
    assert.equal(asked.replies[1]?.chatId, signupChat, "the account's own Telegram is the one asked, found from its sign-up identity");
    assert.equal((await liveLinks(trip.tripId, stranger)).length, 0);
  });
});

// ── AC-3 ────────────────────────────────────────────────────────────────────

describe("AC-3: a forwarded link on a trip whose interview has started", { skip }, () => {
  test("T1 is refused with a sentence that names nothing, T0 is told once, nothing is created, and the link is NOT consumed", async () => {
    const { t0, t1, trip } = await pausedTripWithLink();
    const decision = multi(await dispatchUpdate(pool, startUpdate(t1, trip.token, from(t1, "Mallory", "mal_lory"))));
    assert.equal(decision.replies.length, 2);
    const [toStranger, toOrganizer] = decision.replies;
    assert.equal(toStranger!.chatId, t1);
    assert.equal(toStranger!.text, uiString("linkOtherBelongs", "en"));
    assert.equal(toStranger!.replyMarkup, undefined);
    for (const secret of [trip.title, "Kyoto", "Paused", "Dana", "dana_k"]) {
      assert.ok(!toStranger!.text.includes(secret), `T1 learns nothing: ${secret}`);
    }
    assert.equal(toOrganizer!.chatId, t0);
    assert.ok(toOrganizer!.text.includes(trip.title), "the organizer is told which trip");
    assert.equal(toOrganizer!.replyMarkup, undefined, "a refusal asks nothing: no buttons");
    assert.equal((await sessionsFor(t1)).length, 0, "no session for T1");
    assert.equal((await liveLinks(trip.tripId, t1)).length, 0, "T1 is not linked");
    assert.equal(await enrollmentState(trip.token), "issued", "the link is not spent by a refusal");
    const requests = await requestsFor(trip.tripId);
    assert.equal(requests.length, 1);
    assert.equal(requests[0].state, "refused");
  });

  test("the real organizer can still use the very link afterwards", async () => {
    const { t0, t1, trip } = await pausedTripWithLink();
    multi(await dispatchUpdate(pool, startUpdate(t1, trip.token)));
    const resumed = await dispatchUpdate(pool, startUpdate(t0, trip.token));
    assert.equal(resumed.kind, "reply");
    assert.equal(await enrollmentState(trip.token), "consumed");
    assert.equal((await sessionsFor(t0)).filter((s) => s.trip_id === trip.tripId && s.expired_at === null).length, 1);
  });

  test("T1 trying again gets the same refusal and the organizer is NOT messaged a second time (one message, not one per attempt)", async () => {
    const { t1, trip } = await pausedTripWithLink();
    const first = multi(await dispatchUpdate(pool, startUpdate(t1, trip.token)));
    assert.equal(first.replies.length, 2);
    for (let attempt = 0; attempt < 3; attempt++) {
      const again = multi(await dispatchUpdate(pool, startUpdate(t1, trip.token)));
      assert.equal(again.replies.length, 1, "only the stranger is answered");
      assert.equal(again.replies[0]!.text, uiString("linkOtherBelongs", "en"));
    }
    assert.equal((await requestsFor(trip.tripId)).length, 1);
    assert.equal(await enrollmentState(trip.token), "issued");
  });

  test("a LIVE session and a CONFIRMED one count as started too: no approval is offered for either", async () => {
    for (const state of ["interviewing", "confirmed"] as const) {
      const base = await boundOrganizer();
      const trip = await draftTrip(base.user);
      await pool.query(
        `INSERT INTO control_plane.intake_sessions(id, trip_id, user_id, enrollment_id, session_token_digest, state, answers, telegram_chat_id)
         SELECT $1, $2, $3, e.id, $4, $5, '{}'::jsonb, NULL FROM control_plane.interview_enrollments e WHERE e.trip_id = $2`,
        [id("sess"), trip.tripId, base.user, tokenDigest(randomBytes(8).toString("hex")), state]);
      const t1 = nextChat();
      const decision = multi(await dispatchUpdate(pool, startUpdate(t1, trip.token)));
      assert.equal(decision.replies[0]!.text, uiString("linkOtherBelongs", "en"), state);
      assert.equal(buttons(decision.replies[1]!).length, 0, `${state}: nothing to approve`);
      assert.equal((await sessionsFor(t1)).length, 0);
    }
  });

  test("applyDecision sends the stranger's sentence to the stranger and the organizer's to the organizer", async () => {
    const { t0, t1, trip } = await pausedTripWithLink();
    const decision = await dispatchUpdate(pool, startUpdate(t1, trip.token));
    const { sent, deps } = recorder();
    await applyDecision(decision, deps);
    assert.deepEqual(sent.map((m) => m.chatId), [t1, t0]);
  });
});

// ── AC-4 ────────────────────────────────────────────────────────────────────

describe("AC-4: a different account opens a link on a trip with no interview", { skip }, () => {
  test("T1 is told the organizer was asked (nothing about the trip); T0 gets Approve/Decline naming the trip, T1's first name and @username; nothing is bound or started", async () => {
    const { t0, t1, t1Who, trip } = await askScenario();
    const decision = multi(await dispatchUpdate(pool, startUpdate(t1, trip.token, t1Who)));
    assert.equal(decision.replies.length, 2);
    const [toStranger, toOrganizer] = decision.replies;
    assert.equal(toStranger!.chatId, t1);
    assert.equal(toStranger!.text, uiString("linkOtherAsked", "en"));
    for (const secret of [trip.title, "Kyoto", "Dana"]) assert.ok(!toStranger!.text.includes(secret), `T1 learns nothing: ${secret}`);
    assert.equal(toOrganizer!.chatId, t0);
    assert.ok(toOrganizer!.text.includes(trip.title));
    assert.ok(toOrganizer!.text.includes("Mallory"));
    assert.ok(toOrganizer!.text.includes("@mal_lory"));
    assert.deepEqual(buttons(toOrganizer!).map((b) => b.text), [uiString("linkApproveButton", "en"), uiString("linkDeclineButton", "en")]);
    for (const button of buttons(toOrganizer!)) assert.ok(Buffer.byteLength(button.callback_data!, "utf8") <= 64);
    // Only those: not the stranger's numeric id, not their chat.
    assert.ok(!toOrganizer!.text.includes(t1), "the stranger's id is not shown");
    assert.equal((await liveLinks(trip.tripId, t1)).length, 0);
    assert.equal((await sessionsFor(t1)).length, 0);
    assert.equal(await enrollmentState(trip.token), "issued");
    const [request] = await requestsFor(trip.tripId);
    assert.equal(request.state, "pending");
    assert.equal(request.approver_digest, digestOf(t0));
    assert.equal(request.requester_digest, digestOf(t1));
  });

  test("the organizer's prompt is in the language of THEIR chat, Hebrew in the plural voice", async () => {
    const { t0, t1, trip } = await askScenario({ language: "he" });
    const toOrganizer = multi(await dispatchUpdate(pool, startUpdate(t1, trip.token))).replies[1]!;
    assert.equal(toOrganizer.chatId, t0);
    assert.match(toOrganizer.text, /קישור הראיון שלכם/);
    assert.deepEqual(buttons(toOrganizer).map((b) => b.text), [uiString("linkApproveButton", "he"), uiString("linkDeclineButton", "he")]);
  });

  test("T1 opening the link again while the question is open does not put a second question in front of the organizer", async () => {
    const { t1, trip } = await askScenario();
    multi(await dispatchUpdate(pool, startUpdate(t1, trip.token)));
    const again = multi(await dispatchUpdate(pool, startUpdate(t1, trip.token)));
    assert.equal(again.replies.length, 1);
    assert.equal(again.replies[0]!.text, uiString("linkOtherAsked", "en"));
    assert.equal((await requestsFor(trip.tripId)).length, 1);
  });

  test("a SECOND stranger while a question is open is refused without a second question to the organizer", async () => {
    const { t1, trip } = await askScenario();
    multi(await dispatchUpdate(pool, startUpdate(t1, trip.token)));
    const t2 = nextChat();
    const other = multi(await dispatchUpdate(pool, startUpdate(t2, trip.token)));
    assert.equal(other.replies.length, 1, "the organizer is not asked about two people at once");
    assert.equal(other.replies[0]!.text, uiString("linkOtherBelongs", "en"));
    assert.equal((await requestsFor(trip.tripId)).filter((r) => r.state === "pending").length, 1);
  });

  test("a bound account nobody can reach (no chat on record) is not asked, and the stranger is refused: fail closed", async () => {
    const user = await organizer();
    const trip = await draftTrip(user);
    await pool.query(
      `INSERT INTO control_plane.telegram_organizer_trip_links(id, user_id, trip_id, telegram_subject_digest, verified_via)
       VALUES ($1, $2, $3, $4, 'dashboard_link_token')`, [id("otl"), user, trip.tripId, digestOf("424242424")]);
    const t1 = nextChat();
    const decision = multi(await dispatchUpdate(pool, startUpdate(t1, trip.token)));
    assert.equal(decision.replies.length, 1);
    assert.equal(decision.replies[0]!.text, uiString("linkOtherBelongs", "en"));
    assert.equal((await requestsFor(trip.tripId))[0].state, "refused");
    assert.equal((await liveLinks(trip.tripId, t1)).length, 0);
  });
});

// ── AC-5 ────────────────────────────────────────────────────────────────────

describe("AC-5: the organizer approves", { skip }, () => {
  test("T1 replaces T0 for THIS trip: T0's link to it is revoked, T1's is created, the link is consumed, T1's interview starts and T1 is told; T0's other trips are untouched", async () => {
    const { t0, t1, t1Who, trip, firstTripId } = await askScenario({ linkedToTrip: true });
    const asked = multi(await dispatchUpdate(pool, startUpdate(t1, trip.token, t1Who)));
    const tap = tapUpdate(t0, approveData(asked.replies[1]!), from(t0, "Dana"));
    const approved = multi(await dispatchUpdate(pool, tap));
    assert.ok(approved.callbackQueryId, "the tap is answered");
    assert.deepEqual(approved.replies.map((r) => r.chatId), [t0, t1, t1]);
    assert.equal(approved.replies[1]!.text, uiString("linkOtherApproved", "en"));
    assert.ok(approved.replies[2]!.replyMarkup, "T1 gets the ordinary opening, with its buttons");
    assert.ok(approved.replies[0]!.text.includes(trip.title) && approved.replies[0]!.text.includes("Mallory"));

    assert.equal((await liveLinks(trip.tripId, t0)).length, 0, "T0's link to this trip is revoked");
    const revoked = await pool.query("SELECT revoked_reason FROM control_plane.telegram_organizer_trip_links WHERE trip_id = $1 AND telegram_subject_digest = $2", [trip.tripId, digestOf(t0)]);
    assert.equal(revoked.rows[0].revoked_reason, "owner_unlinked");
    const t1Link = await liveLinks(trip.tripId, t1);
    assert.equal(t1Link.length, 1, "T1's link is created");
    assert.equal(t1Link[0].user_id, trip.userId, "as the same account, not a new one");
    assert.equal(t1Link[0].telegram_first_name, "Mallory");
    assert.equal(await enrollmentState(trip.token), "consumed");
    assert.equal((await sessionsFor(t1)).filter((s) => s.trip_id === trip.tripId).length, 1, "T1's interview started");
    assert.equal((await requestsFor(trip.tripId))[0].state, "approved");
    assert.equal((await liveLinks(firstTripId, t0)).length, 1, "T0's binding for another trip is unchanged");
  });

  test("approval with no link of T0's to the trip (bound through another trip) still moves the trip to T1 and leaves T0's other trip alone", async () => {
    const { t0, t1, trip, firstTripId } = await askScenario();
    const asked = multi(await dispatchUpdate(pool, startUpdate(t1, trip.token)));
    multi(await dispatchUpdate(pool, tapUpdate(t0, approveData(asked.replies[1]!))));
    assert.equal((await liveLinks(trip.tripId, t1)).length, 1);
    assert.equal((await liveLinks(firstTripId, t0)).length, 1);
  });

  test("applyDecision answers the tap, and sends T0's confirmation, T1's approval and T1's opening, in that order", async () => {
    const { t0, t1, trip } = await askScenario();
    const asked = multi(await dispatchUpdate(pool, startUpdate(t1, trip.token)));
    const decision = await dispatchUpdate(pool, tapUpdate(t0, approveData(asked.replies[1]!)));
    const { sent, answered, deps } = recorder();
    await applyDecision(decision, deps);
    assert.equal(answered.length, 1);
    assert.deepEqual(sent.map((m) => m.chatId), [t0, t1, t1]);
  });

  test("the buttons work while the organizer is in the middle of ANOTHER trip's interview (they are not swallowed as a stale interview button)", async () => {
    const { t0, t1, trip } = await askScenario({ leaveInterviewRunning: true });
    const asked = multi(await dispatchUpdate(pool, startUpdate(t1, trip.token)));
    const approved = multi(await dispatchUpdate(pool, tapUpdate(t0, approveData(asked.replies[1]!))));
    assert.equal(approved.replies.length, 3);
    assert.equal((await liveLinks(trip.tripId, t1)).length, 1);
    assert.equal((await sessionsFor(t0)).filter((s) => s.expired_at === null).length, 1, "the organizer's own interview was not disturbed");
  });

  test("T1 is then the organizer: its next link on this account is the ordinary case, and T0 is now the 'other' account on this trip", async () => {
    const { user, t0, t1, trip } = await askScenario();
    const asked = multi(await dispatchUpdate(pool, startUpdate(t1, trip.token)));
    multi(await dispatchUpdate(pool, tapUpdate(t0, approveData(asked.replies[1]!))));
    // T0 is still bound through its first trip, T1 through this one: both are the account's Telegram, per the one definition.
    const more = await draftTrip(user);
    assert.equal((await dispatchUpdate(pool, startUpdate(t1, more.token))).kind, "reply");
  });
});

// ── AC-6 ────────────────────────────────────────────────────────────────────

describe("AC-6: the organizer declines, or does not answer", { skip }, () => {
  test("Decline leaves everything as it was, tells T1 it was not approved, and the link stays usable by T0", async () => {
    const { t0, t1, trip } = await askScenario({ linkedToTrip: true });
    const asked = multi(await dispatchUpdate(pool, startUpdate(t1, trip.token)));
    const declined = multi(await dispatchUpdate(pool, tapUpdate(t0, declineData(asked.replies[1]!))));
    assert.ok(declined.replies.some((r) => r.chatId === t1 && r.text === uiString("linkOtherNotApproved", "en")));
    assert.equal((await liveLinks(trip.tripId, t1)).length, 0);
    assert.equal((await liveLinks(trip.tripId, t0)).length, 1, "T0 keeps its link");
    assert.equal((await sessionsFor(t1)).length, 0);
    assert.equal(await enrollmentState(trip.token), "issued");
    assert.equal((await requestsFor(trip.tripId))[0].state, "declined");
    assert.equal((await dispatchUpdate(pool, startUpdate(t0, trip.token))).kind, "reply", "T0 can still use the link");
    assert.equal(await enrollmentState(trip.token), "consumed");
  });

  test("T1 re-opening after a decline is told 'not approved' and the organizer is NOT asked again", async () => {
    const { t0, t1, trip } = await askScenario();
    const asked = multi(await dispatchUpdate(pool, startUpdate(t1, trip.token)));
    await dispatchUpdate(pool, tapUpdate(t0, declineData(asked.replies[1]!)));
    const again = multi(await dispatchUpdate(pool, startUpdate(t1, trip.token)));
    assert.equal(again.replies.length, 1);
    assert.equal(again.replies[0]!.text, uiString("linkOtherNotApproved", "en"));
    assert.equal((await requestsFor(trip.tripId)).length, 1);
  });

  test("no answer before the link expires: a late tap changes nothing and says so, and T1 cannot use an expired link", async () => {
    const { t0, t1, trip } = await askScenario();
    const asked = multi(await dispatchUpdate(pool, startUpdate(t1, trip.token)));
    await pool.query("UPDATE control_plane.interview_enrollments SET expires_at = now() - interval '1 second' WHERE token_digest = $1", [tokenDigest(trip.token)]);
    const late = await dispatchUpdate(pool, tapUpdate(t0, approveData(asked.replies[1]!)));
    assert.equal(late.kind, "callback_ack");
    if (late.kind === "callback_ack") assert.equal(late.text, uiString("linkApproverGone", "en"));
    assert.equal((await liveLinks(trip.tripId, t1)).length, 0);
    assert.equal((await sessionsFor(t1)).length, 0);
    assert.equal((await requestsFor(trip.tripId))[0].state, "expired");
    const retry = await dispatchUpdate(pool, startUpdate(t1, trip.token));
    assert.equal(retry.kind, "reply", "an expired link is a bad link, with nothing said about whose it is");
    if (retry.kind === "reply") assert.equal(retry.reply.text, DEFAULT_STRINGS.badLink);
  });
});

// ── AC-7 ────────────────────────────────────────────────────────────────────

describe("AC-7: only T0, once, only while pending; buttons are shortcuts", { skip }, () => {
  test("a second tap does nothing but say so", async () => {
    const { t0, t1, trip } = await askScenario();
    const asked = multi(await dispatchUpdate(pool, startUpdate(t1, trip.token)));
    const data = approveData(asked.replies[1]!);
    multi(await dispatchUpdate(pool, tapUpdate(t0, data)));
    const links = (await pool.query("SELECT count(*)::int AS n FROM control_plane.telegram_organizer_trip_links WHERE trip_id = $1", [trip.tripId])).rows[0].n;
    const again = await dispatchUpdate(pool, tapUpdate(t0, data));
    assert.equal(again.kind, "callback_ack");
    assert.equal((await pool.query("SELECT count(*)::int AS n FROM control_plane.telegram_organizer_trip_links WHERE trip_id = $1", [trip.tripId])).rows[0].n, links);
    assert.equal((await sessionsFor(t1)).length, 1, "still exactly one session");
  });

  test("a tap from ANOTHER chat does nothing, and the question stays open", async () => {
    const { t0, t1, trip } = await askScenario();
    const asked = multi(await dispatchUpdate(pool, startUpdate(t1, trip.token)));
    const stranger = nextChat();
    const forged = await dispatchUpdate(pool, tapUpdate(stranger, approveData(asked.replies[1]!)));
    assert.equal(forged.kind, "callback_ack");
    // The stranger cannot approve themselves either, even holding the request id (they are never shown it).
    const self = await dispatchUpdate(pool, tapUpdate(t1, approveData(asked.replies[1]!)));
    assert.equal(self.kind, "callback_ack");
    assert.equal((await requestsFor(trip.tripId))[0].state, "pending");
    assert.equal((await liveLinks(trip.tripId, t1)).length, 0);
    // A tap in T0's chat but from a different person (a group-style mismatch of chat and sender) is refused too.
    const mismatched = await dispatchUpdate(pool, tapUpdate(t0, approveData(asked.replies[1]!), from(stranger)));
    assert.equal(mismatched.kind, "callback_ack");
    assert.equal((await requestsFor(trip.tripId))[0].state, "pending");
    assert.equal(await enrollmentState(trip.token), "issued");
  });

  test("typed 'approve' in T0's chat does what the button does", async () => {
    const { t0, t1, trip } = await askScenario({ linkedToTrip: true });
    multi(await dispatchUpdate(pool, startUpdate(t1, trip.token)));
    const typed = multi(await dispatchUpdate(pool, textUpdate(t0, "Approve")));
    assert.equal(typed.callbackQueryId, undefined, "there is no tap to answer");
    assert.deepEqual(typed.replies.map((r) => r.chatId), [t0, t1, t1]);
    assert.equal((await liveLinks(trip.tripId, t1)).length, 1);
    assert.equal((await liveLinks(trip.tripId, t0)).length, 0);
    assert.equal((await requestsFor(trip.tripId))[0].state, "approved");
  });

  test("typed 'decline', and the Hebrew words, work the same", async () => {
    for (const [word, outcome] of [["decline", "declined"], ["דחייה", "declined"], ["מאשרים", "approved"]] as const) {
      const { t0, t1, trip } = await askScenario();
      multi(await dispatchUpdate(pool, startUpdate(t1, trip.token)));
      multi(await dispatchUpdate(pool, textUpdate(t0, word)));
      assert.equal((await requestsFor(trip.tripId))[0].state, outcome, word);
    }
  });

  test("typed words that are not exactly one of the unambiguous words (including 'yes') change nothing and fall through", async () => {
    const { t0, t1, trip } = await askScenario();
    multi(await dispatchUpdate(pool, startUpdate(t1, trip.token)));
    for (const text of ["yes", "no", "כן", "approve it please", "I approve of kyoto", "ok"]) {
      const decision = await dispatchUpdate(pool, textUpdate(t0, text));
      assert.notEqual(decision.kind, "multi_reply", text);
    }
    assert.equal((await requestsFor(trip.tripId))[0].state, "pending");
    assert.equal(linkAnswerFromText("  APPROVE! "), "approve");
    assert.equal(linkAnswerFromText("לא מאשרים"), "decline");
    assert.equal(linkAnswerFromText("yes"), null);
  });

  test("F1: T0 in a LIVE interview types every approve word: the request stays pending and the words reach the interview", async () => {
    const { t0, t1, trip } = await askScenario({ linkedToTrip: true, leaveInterviewRunning: true });
    multi(await dispatchUpdate(pool, startUpdate(t1, trip.token)));
    for (const word of ["approve", "approved", "i approve", "אישור", "מאשר", "מאשרת", "מאשרים", "אשר", "אשרו", "decline", "דחייה", "לא מאשרים"]) {
      const decision = await dispatchUpdate(pool, textUpdate(t0, word));
      assert.notEqual(decision.kind, "multi_reply", word);
      assert.ok(["interview_text", "interview_to_gateway"].includes(decision.kind), `${word}: handed to the interview, got ${decision.kind}`);
    }
    assert.equal((await requestsFor(trip.tripId))[0].state, "pending");
    assert.equal((await liveLinks(trip.tripId, t1)).length, 0);
    assert.equal((await liveLinks(trip.tripId, t0)).length, 1);
    assert.equal(await enrollmentState(trip.token), "issued");
  });

  test("F1: once the interview is over, the same typed word answers the question again", async () => {
    const { t0, t1, trip } = await askScenario({ leaveInterviewRunning: true });
    multi(await dispatchUpdate(pool, startUpdate(t1, trip.token)));
    await pool.query("UPDATE control_plane.intake_sessions SET expired_at = now() WHERE telegram_chat_id = $1 AND expired_at IS NULL", [t0]);
    multi(await dispatchUpdate(pool, textUpdate(t0, "approve")));
    assert.equal((await requestsFor(trip.tripId))[0].state, "approved");
  });

  test("F1: the Hebrew word on the recap's own confirm button is not an approve word", () => {
    assert.equal(linkAnswerFromText("אישור"), null);
    assert.equal(linkAnswerFromText("מאשרים"), "approve");
  });

  test("typed 'approve' with nothing pending is ordinary text: no effect, no multi_reply", async () => {
    const { t0 } = await boundOrganizer();
    const decision = await dispatchUpdate(pool, textUpdate(t0, "approve"));
    assert.notEqual(decision.kind, "multi_reply");
  });

  test("typed 'approve' from a person who is not the organizer does nothing", async () => {
    const { t1, trip } = await askScenario();
    multi(await dispatchUpdate(pool, startUpdate(t1, trip.token)));
    const decision = await dispatchUpdate(pool, textUpdate(t1, "approve"));
    assert.notEqual(decision.kind, "multi_reply");
    assert.equal((await requestsFor(trip.tripId))[0].state, "pending");
    assert.equal((await liveLinks(trip.tripId, t1)).length, 0);
  });

  test("two questions waiting: a typed word does not guess, it points at the buttons", async () => {
    const base = await boundOrganizer();
    const a = await draftTrip(base.user, "Alpha Trip");
    const b = await draftTrip(base.user, "Beta Trip");
    multi(await dispatchUpdate(pool, startUpdate(nextChat(), a.token)));
    multi(await dispatchUpdate(pool, startUpdate(nextChat(), b.token)));
    const decision = await dispatchUpdate(pool, textUpdate(base.t0, "approve"));
    assert.equal(decision.kind, "reply");
    if (decision.kind === "reply") assert.equal(decision.reply.text, uiString("linkApproverMany", "en"));
    assert.deepEqual((await requestsFor(a.tripId)).map((r) => r.state), ["pending"]);
    assert.deepEqual((await requestsFor(b.tripId)).map((r) => r.state), ["pending"]);
  });

  test("the link used by its owner first: a later Approve is moot and T1 is never linked", async () => {
    const { t0, t1, trip } = await askScenario();
    const asked = multi(await dispatchUpdate(pool, startUpdate(t1, trip.token)));
    assert.equal((await dispatchUpdate(pool, startUpdate(t0, trip.token))).kind, "reply");
    const late = await dispatchUpdate(pool, tapUpdate(t0, approveData(asked.replies[1]!)));
    assert.equal(late.kind, "callback_ack");
    assert.equal((await liveLinks(trip.tripId, t1)).length, 0);
    assert.equal((await sessionsFor(t1)).length, 0);
  });

  test("an interview that started since the question was asked: approving applies nothing, T0 keeps its link, T1 is not linked", async () => {
    const { t0, t1, trip } = await askScenario({ linkedToTrip: true });
    const asked = multi(await dispatchUpdate(pool, startUpdate(t1, trip.token)));
    await pool.query(
      `INSERT INTO control_plane.intake_sessions(id, trip_id, user_id, enrollment_id, session_token_digest, state, answers, telegram_chat_id)
       SELECT $1, $2, $3, e.id, $4, 'interviewing', '{}'::jsonb, NULL FROM control_plane.interview_enrollments e WHERE e.trip_id = $2`,
      [id("sess"), trip.tripId, trip.userId, tokenDigest(randomBytes(8).toString("hex"))]);
    const tap = await dispatchUpdate(pool, tapUpdate(t0, approveData(asked.replies[1]!)));
    assert.equal(tap.kind, "callback_ack");
    assert.equal((await liveLinks(trip.tripId, t1)).length, 0);
    assert.equal((await liveLinks(trip.tripId, t0)).length, 1, "the rolled-back approval did not revoke T0");
    assert.equal((await sessionsFor(t1)).length, 0);
    assert.equal(await enrollmentState(trip.token), "issued");
    assert.equal((await requestsFor(trip.tripId))[0].state, "expired");
  });

  test("two taps at once: one approval, one session", async () => {
    const { t0, t1, trip } = await askScenario();
    const asked = multi(await dispatchUpdate(pool, startUpdate(t1, trip.token)));
    const data = approveData(asked.replies[1]!);
    const results = await Promise.all([dispatchUpdate(pool, tapUpdate(t0, data)), dispatchUpdate(pool, tapUpdate(t0, data))]);
    assert.equal(results.filter((r) => r.kind === "multi_reply").length, 1);
    assert.equal((await sessionsFor(t1)).length, 1);
    assert.equal((await liveLinks(trip.tripId, t1)).length, 1);
  });

  test("T0 and T1 open the same link at once: T1 never becomes the organizer", async () => {
    const { t0, t1, trip } = await askScenario();
    await Promise.all([dispatchUpdate(pool, startUpdate(t0, trip.token)), dispatchUpdate(pool, startUpdate(t1, trip.token))]);
    assert.equal((await liveLinks(trip.tripId, t1)).length, 0);
    assert.equal((await sessionsFor(t1)).length, 0);
    assert.equal((await sessionsFor(t0)).filter((s) => s.trip_id === trip.tripId).length, 1);
  });
});

// ── AC-8 ────────────────────────────────────────────────────────────────────

describe("AC-8: groups", { skip }, () => {
  test("a group never redeems an organizer link, binds no one, asks no one, and the link is not consumed", async () => {
    const { t1, trip } = await askScenario();
    const group = "-1001234567890";
    const decision = await dispatchUpdate(pool, startUpdate(group, trip.token, from(t1), "supergroup"));
    assert.notEqual(decision.kind, "multi_reply");
    assert.equal((await requestsFor(trip.tripId)).length, 0);
    assert.equal(await enrollmentState(trip.token), "issued");
    assert.equal((await liveLinks(trip.tripId, t1)).length, 0);
  });

  test("a tap on the approval buttons in a group does nothing", async () => {
    const { t0, t1, trip } = await askScenario();
    const asked = multi(await dispatchUpdate(pool, startUpdate(t1, trip.token)));
    const groupTap: TelegramUpdate = { update_id: 5, callback_query: { id: "g1", data: approveData(asked.replies[1]!), from: from(t0), message: { message_id: 1, chat: { id: "-100999", type: "supergroup" } } } } as unknown as TelegramUpdate;
    const decision = await dispatchUpdate(pool, groupTap);
    assert.equal(decision.kind, "callback_ack");
    assert.equal((await requestsFor(trip.tripId))[0].state, "pending");
  });
});

// ── AC-9 ────────────────────────────────────────────────────────────────────

describe("AC-9: copy", { skip: false }, () => {
  const keys = Object.keys(UI_STRINGS.en).filter((key) => key.startsWith("link") && key !== "linkedTo");
  test("every new message exists in English and Hebrew", () => {
    assert.ok(keys.length >= 14);
    for (const key of keys) {
      assert.ok(UI_STRINGS.en[key], `en ${key}`);
      assert.ok(UI_STRINGS.he[key], `he ${key}`);
      assert.match(UI_STRINGS.he[key]!, /[֐-׿]/, `he ${key} is Hebrew`);
    }
  });

  test("what the stranger is told has no placeholder for a trip, a name or a date, in either language", () => {
    for (const language of ["en", "he"] as const) {
      for (const key of ["linkOtherBelongs", "linkOtherAsked", "linkOtherNotApproved", "linkOtherApproved"]) {
        const text = UI_STRINGS[language][key]!;
        assert.doesNotMatch(text, /\{[a-z]+\}/, `${language} ${key}: no placeholder at all`);
        assert.doesNotMatch(text, /\d/, `${language} ${key}: no date or number`);
      }
    }
  });

  test("Hebrew is in the plural voice (אתם / שלכם / נסו), not the singular", () => {
    const he = UI_STRINGS.he;
    assert.match(he.linkOtherBelongs!, /עבורכם|שלכם/);
    assert.match(he.linkForeignOpened!, /שלכם/);
    assert.match(he.linkForeignOpened!, /קבלו/);
    assert.match(he.linkApprovePrompt!, /אשרו/);
    assert.match(he.linkApprovePrompt!, /דחו/);
    assert.match(he.linkApproverNotNow!, /נסו/);
    for (const text of Object.entries(he).filter(([key]) => key.startsWith("link")).map(([, value]) => value)) {
      assert.doesNotMatch(text, /אתה |תאשר|תדחה|קבל /, "no singular imperative");
    }
  });
});

// ── AC-10 ───────────────────────────────────────────────────────────────────

describe("AC-10: an Unlinked pair is never re-bound by a link, approval or not", { skip }, () => {
  async function unlinkedPair(tripId: string, userId: string, chat: string) {
    await pool.query(
      `INSERT INTO control_plane.telegram_organizer_trip_links(id, user_id, trip_id, telegram_subject_digest, verified_via, revoked_at, revoked_reason)
       VALUES ($1, $2, $3, $4, 'enrollment_redemption', now(), 'owner_unlinked')`, [id("otl"), userId, tripId, digestOf(chat)]);
  }

  test("with an organizer bound, an Unlinked stranger is not even asked: refused, and T0 told", async () => {
    const { t1, trip, user } = await askScenario();
    await unlinkedPair(trip.tripId, user, t1);
    const decision = multi(await dispatchUpdate(pool, startUpdate(t1, trip.token)));
    assert.equal(decision.replies[0]!.text, uiString("linkOtherBelongs", "en"));
    assert.equal(buttons(decision.replies[1]!).length, 0, "no question to answer");
    assert.equal((await liveLinks(trip.tripId, t1)).length, 0);
    assert.equal(await enrollmentState(trip.token), "issued");
  });

  test("an approval that finds the pair Unlinked since the question was asked applies nothing: T0 keeps its link, nobody is linked", async () => {
    const { t0, t1, trip, user } = await askScenario({ linkedToTrip: true });
    const asked = multi(await dispatchUpdate(pool, startUpdate(t1, trip.token)));
    await unlinkedPair(trip.tripId, user, t1);
    const tap = await dispatchUpdate(pool, tapUpdate(t0, approveData(asked.replies[1]!)));
    assert.equal(tap.kind, "callback_ack");
    assert.equal((await liveLinks(trip.tripId, t1)).length, 0, "never re-bound");
    assert.equal((await liveLinks(trip.tripId, t0)).length, 1, "the rolled-back approval did not revoke T0");
    assert.equal((await sessionsFor(t1)).length, 0);
    assert.equal(await enrollmentState(trip.token), "issued", "and the link is still the organizer's");
  });

  test("an Unlinked pair opening the trip it was Unlinked from is refused even when nobody else is bound: the link stays revoked, no interview starts", async () => {
    const user = await organizer();
    const trip = await draftTrip(user);
    const t = nextChat();
    await unlinkedPair(trip.tripId, user, t);
    const decision = multi(await dispatchUpdate(pool, startUpdate(t, trip.token)));
    assert.equal(decision.replies[0]!.text, uiString("linkOtherBelongs", "en"));
    assert.equal((await liveLinks(trip.tripId, t)).length, 0, "not re-bound");
    assert.equal((await sessionsFor(t)).length, 0);
    assert.equal(await enrollmentState(trip.token), "issued");
  });
});

// ── An Unlink or a trip-only link must not make the account "unbound" (re-review R1, R2) ────

describe("a narrowed set never reads as 'nobody is bound'", { skip }, () => {
  const rowsFor = async (tripId: string, chat: string) =>
    (await pool.query("SELECT * FROM control_plane.organizer_link_requests WHERE trip_id = $1 AND requester_digest = $2", [tripId, digestOf(chat)])).rows;

  test("R1 lost phone: the owner Unlinks the old phone and adds the new one with the one-time link; a stranger opening the account's next trip is refused, never bound", async () => {
    const { unlinkTelegramLink } = await import("../src/telegram-mini-app.js");
    const { user, t0, firstTripId } = await boundOrganizer();
    const row = (await pool.query("SELECT id FROM control_plane.telegram_organizer_trip_links WHERE trip_id = $1 AND telegram_subject_digest = $2 AND revoked_at IS NULL", [firstTripId, digestOf(t0)])).rows[0];
    assert.equal(await unlinkTelegramLink(pool, user, row.id), true);
    const a = await draftTrip(user, "Trip A");
    const phone = nextChat();
    const issued = await issueTelegramLinkToken(pool, { userId: user, tripId: a.tripId });
    assert.ok(issued.ok);
    if (!issued.ok) return;
    assert.equal((await redeemTelegramLinkToken(pool, issued.token, phone, null)).ok, true);

    const c = await draftTrip(user, "Trip C");
    const stranger = nextChat();
    const decision = multi(await dispatchUpdate(pool, startUpdate(stranger, c.token)));
    assert.equal(decision.replies[0]!.text, uiString("linkOtherBelongs", "en"), "refused, with nothing about the trip");
    assert.equal(decision.replies.length, 1, "and nobody is asked: the trip-only Telegram may not approve for another trip, so it fails closed");
    assert.equal((await liveLinks(c.tripId, stranger)).length, 0, "the stranger is not bound");
    assert.equal((await sessionsFor(stranger)).length, 0);
    assert.equal(await enrollmentState(c.token), "issued");
    assert.equal((await rowsFor(c.tripId, stranger))[0].state, "refused");
    assert.equal((await pool.query("SELECT count(*)::int AS n FROM control_plane.telegram_organizer_trip_links WHERE telegram_subject_digest = $1", [digestOf(stranger)])).rows[0].n, 0, "bound nowhere");
  });

  test("R3: the owner Unlinked every Telegram from every trip they had; a stranger opening a FRESH trip's link is refused, never bound account-wide", async () => {
    const { unlinkTelegramLink } = await import("../src/telegram-mini-app.js");
    const { user, t0, firstTripId } = await boundOrganizer();
    const row = (await pool.query("SELECT id FROM control_plane.telegram_organizer_trip_links WHERE trip_id = $1 AND telegram_subject_digest = $2 AND revoked_at IS NULL", [firstTripId, digestOf(t0)])).rows[0];
    assert.equal(await unlinkTelegramLink(pool, user, row.id), true);
    assert.equal((await pool.query("SELECT count(*)::int AS n FROM control_plane.telegram_organizer_trip_links WHERE user_id = $1 AND revoked_at IS NULL", [user])).rows[0].n, 0, "nothing live is left");
    const c = await draftTrip(user, "Fresh Trip");
    const stranger = nextChat();
    const refused = multi(await dispatchUpdate(pool, startUpdate(stranger, c.token)));
    assert.equal(refused.replies[0]!.text, uiString("linkOtherBelongs", "en"));
    assert.equal(refused.replies.length, 1, "nobody can be asked");
    assert.equal((await liveLinks(c.tripId, stranger)).length, 0);
    assert.equal((await sessionsFor(stranger)).length, 0);
    assert.equal(await enrollmentState(c.token), "issued");
    assert.equal((await pool.query("SELECT count(*)::int AS n FROM control_plane.telegram_organizer_trip_links WHERE telegram_subject_digest = $1", [digestOf(stranger)])).rows[0].n, 0, "bound nowhere");
  });

  test("R3: an account whose Telegram sign-up identity is its only Telegram is never 'fresh' either", async () => {
    const user = await organizer();
    const signup = nextChat();
    await pool.query(
      "INSERT INTO control_plane.user_identities(id, user_id, provider, provider_subject_digest, provider_subject_id, verified_at) VALUES ($1, $2, 'telegram', $3, $4, now())",
      [id("idnt"), user, digestOf(signup), signup]);
    const c = await draftTrip(user, "Fresh Trip");
    const stranger = nextChat();
    const decision = multi(await dispatchUpdate(pool, startUpdate(stranger, c.token)));
    assert.equal(decision.replies[0]!.text, uiString("linkOtherAsked", "en"));
    assert.equal((await liveLinks(c.tripId, stranger)).length, 0);
  });

  test("R1 continued: the owner's new phone still opens its OWN trip, and is refused on the account's other trips (the dashboard link is their way in there)", async () => {
    const { unlinkTelegramLink } = await import("../src/telegram-mini-app.js");
    const { user, t0, firstTripId } = await boundOrganizer();
    const row = (await pool.query("SELECT id FROM control_plane.telegram_organizer_trip_links WHERE trip_id = $1 AND telegram_subject_digest = $2 AND revoked_at IS NULL", [firstTripId, digestOf(t0)])).rows[0];
    await unlinkTelegramLink(pool, user, row.id);
    const a = await draftTrip(user, "Trip A");
    const c = await draftTrip(user, "Trip C");
    const phone = nextChat();
    const issued = await issueTelegramLinkToken(pool, { userId: user, tripId: a.tripId });
    assert.ok(issued.ok);
    if (!issued.ok) return;
    await redeemTelegramLinkToken(pool, issued.token, phone, null);
    assert.equal((await dispatchUpdate(pool, startUpdate(phone, a.token))).kind, "reply", "its own trip works");
    await pool.query("UPDATE control_plane.intake_sessions SET expired_at = now() WHERE telegram_chat_id = $1 AND expired_at IS NULL", [phone]);
    multi(await dispatchUpdate(pool, startUpdate(phone, c.token)));
    assert.equal((await liveLinks(c.tripId, phone)).length, 0);
  });

  test("R2: the owner Unlinks T0 from one paused trip; a stranger opening that trip's link is refused, never bound account-wide (T0 bound elsewhere)", async () => {
    const { t0, t1, trip, user } = await pausedTripWithLink();
    const row = (await pool.query("SELECT id FROM control_plane.telegram_organizer_trip_links WHERE trip_id = $1 AND telegram_subject_digest = $2 AND revoked_at IS NULL", [trip.tripId, digestOf(t0)])).rows[0];
    const { unlinkTelegramLink } = await import("../src/telegram-mini-app.js");
    assert.equal(await unlinkTelegramLink(pool, user, row.id), true);
    const decision = multi(await dispatchUpdate(pool, startUpdate(t1, trip.token)));
    assert.equal(decision.replies[0]!.text, uiString("linkOtherBelongs", "en"));
    assert.equal((await liveLinks(trip.tripId, t1)).length, 0);
    assert.equal((await sessionsFor(t1)).length, 0);
    assert.equal(await enrollmentState(trip.token), "issued");
  });

  test("R2 with T0's ONLY link being on that trip: still refused, because the trip holds a revoked link of an account that was bound", async () => {
    const { unlinkTelegramLink } = await import("../src/telegram-mini-app.js");
    const user = await organizer();
    const trip = await draftTrip(user, "Only Trip");
    const t0 = nextChat();
    assert.equal((await dispatchUpdate(pool, startUpdate(t0, trip.token))).kind, "reply");
    await pool.query("UPDATE control_plane.intake_sessions SET expires_at = now() - interval '1 minute' WHERE trip_id = $1 AND expired_at IS NULL", [trip.tripId]);
    await claimExpiredSessions(pool, 100);
    const next = await issueEnrollment(pool, user, trip.tripId, { enrollmentTtlSeconds: 3600 });
    assert.ok(next.ok);
    if (!next.ok) return;
    const row = (await pool.query("SELECT id FROM control_plane.telegram_organizer_trip_links WHERE trip_id = $1 AND revoked_at IS NULL", [trip.tripId])).rows[0];
    await unlinkTelegramLink(pool, user, row.id);
    const stranger = nextChat();
    const decision = multi(await dispatchUpdate(pool, startUpdate(stranger, next.token)));
    assert.equal(decision.replies[0]!.text, uiString("linkOtherBelongs", "en"));
    assert.equal((await liveLinks(trip.tripId, stranger)).length, 0);
  });

  test("AC-1 still holds: an account with truly nothing bound (no sign-up identity, no link of any scope, nothing revoked here) binds the first opener", async () => {
    const user = await organizer();
    const trip = await draftTrip(user);
    const t = nextChat();
    assert.equal((await dispatchUpdate(pool, startUpdate(t, trip.token))).kind, "reply");
    assert.equal((await liveLinks(trip.tripId, t)).length, 1);
    assert.equal((await pool.query("SELECT binding_scope FROM control_plane.telegram_organizer_trip_links WHERE trip_id = $1", [trip.tripId])).rows[0].binding_scope, "account");
  });
});

// ── The other places that link a Telegram identity ──────────────────────────

describe("every other path that links a Telegram account to a trip", { skip }, () => {
  test("the dashboard's one-time link is the signed-in organizer's own act, so it is NOT subject to the question: it adds a second Telegram", async () => {
    const { user, t0 } = await boundOrganizer();
    const trip = await draftTrip(user);
    const second = nextChat();
    const issued = await issueTelegramLinkToken(pool, { userId: user, tripId: trip.tripId });
    assert.ok(issued.ok);
    if (!issued.ok) return;
    const redeemed = await redeemTelegramLinkToken(pool, issued.token, second, null);
    assert.equal(redeemed.ok, true, "the owner chose this account from a signed-in session: nobody is asked");
    assert.equal((await liveLinks(trip.tripId, second)).length, 1);
    assert.notEqual(second, t0);
  });

  test("the HTTP/MCP start has no Telegram identity, so there is nothing to compare and no organizer link is written", async () => {
    const { startSession } = await import("../src/interview.js");
    const { user } = await boundOrganizer();
    const trip = await draftTrip(user);
    const started = await startSession(pool, trip.token);
    assert.equal(started.ok, true);
    assert.equal((await pool.query("SELECT count(*)::int AS n FROM control_plane.telegram_organizer_trip_links WHERE trip_id = $1", [trip.tripId])).rows[0].n, 0);
  });
});

// ── How far a link reaches (owner decision 2026-11-06, F2 and F3) ──────────

describe("a Telegram bound for ONE trip does not speak for the account's other trips", { skip }, () => {
  const endInterview = (chat: string) =>
    pool.query("UPDATE control_plane.intake_sessions SET expired_at = now() WHERE telegram_chat_id = $1 AND expired_at IS NULL", [chat]);
  const scopeOf = async (tripId: string, chat: string) =>
    (await pool.query("SELECT binding_scope FROM control_plane.telegram_organizer_trip_links WHERE trip_id = $1 AND telegram_subject_digest = $2 AND revoked_at IS NULL", [tripId, digestOf(chat)])).rows[0]?.binding_scope as string | undefined;

  test("P8a: approving T1 for trip A makes T1 the organizer of A only; T1 opening trip C is asked about, not silently let in", async () => {
    const { user, t0, t1, trip } = await askScenario({ linkedToTrip: true });
    const asked = multi(await dispatchUpdate(pool, startUpdate(t1, trip.token)));
    multi(await dispatchUpdate(pool, tapUpdate(t0, approveData(asked.replies[1]!))));
    assert.equal(await scopeOf(trip.tripId, t1), "trip", "the approved link is recorded as this trip's alone");
    await endInterview(t1);

    const c = await draftTrip(user, "Trip C");
    const decision = multi(await dispatchUpdate(pool, startUpdate(t1, c.token)));
    assert.equal(decision.replies[0]!.text, uiString("linkOtherAsked", "en"), "T1 is a different account for C");
    assert.equal(decision.replies[1]!.chatId, t0, "and the account's real Telegram is asked");
    assert.equal((await liveLinks(c.tripId, t1)).length, 0);
    assert.equal((await sessionsFor(t1)).filter((s) => s.trip_id === c.tripId).length, 0);
    assert.equal(await enrollmentState(c.token), "issued");
  });

  test("P8b: a Telegram added to trip A with the dashboard's one-time link cannot open the account's other trip's interview link", async () => {
    const { user, t0 } = await boundOrganizer();
    const a = await draftTrip(user, "Trip A");
    const b = await draftTrip(user, "Trip B");
    const stranger = nextChat();
    const issued = await issueTelegramLinkToken(pool, { userId: user, tripId: a.tripId });
    assert.ok(issued.ok);
    if (!issued.ok) return;
    assert.equal((await redeemTelegramLinkToken(pool, issued.token, stranger, null)).ok, true);
    assert.equal(await scopeOf(a.tripId, stranger), "trip");
    const decision = multi(await dispatchUpdate(pool, startUpdate(stranger, b.token)));
    assert.equal(decision.replies[0]!.text, uiString("linkOtherAsked", "en"));
    assert.equal(decision.replies[1]!.chatId, t0);
    assert.equal((await liveLinks(b.tripId, stranger)).length, 0);
    assert.equal(await enrollmentState(b.token), "issued");
  });

  test("a Telegram added with the one-time link to trip A is the same account FOR A: A's own interview link works for it", async () => {
    const { user } = await boundOrganizer();
    const a = await draftTrip(user, "Trip A");
    const added = nextChat();
    const issued = await issueTelegramLinkToken(pool, { userId: user, tripId: a.tripId });
    assert.ok(issued.ok);
    if (!issued.ok) return;
    await redeemTelegramLinkToken(pool, issued.token, added, null);
    const decision = await dispatchUpdate(pool, startUpdate(added, a.token));
    assert.equal(decision.kind, "reply", "no refusal, no question");
    assert.equal((await sessionsFor(added)).filter((s) => s.trip_id === a.tripId).length, 1);
  });

  test("on trip A after the approval: T1's next link is the same account, T0's is a different one", async () => {
    const { user, t0, t1, trip } = await askScenario({ linkedToTrip: true });
    const asked = multi(await dispatchUpdate(pool, startUpdate(t1, trip.token)));
    multi(await dispatchUpdate(pool, tapUpdate(t0, approveData(asked.replies[1]!))));
    // T1's interview on A is paused, and A is handed a new link.
    await pool.query("UPDATE control_plane.intake_sessions SET expires_at = now() - interval '1 minute' WHERE trip_id = $1 AND expired_at IS NULL", [trip.tripId]);
    await claimExpiredSessions(pool, 100);
    const next = await issueEnrollment(pool, user, trip.tripId, { enrollmentTtlSeconds: 3600 });
    assert.ok(next.ok);
    if (!next.ok) return;

    // T0, revoked for A, is a different account for A even though it is still bound to the account's other trip.
    const fromT0 = multi(await dispatchUpdate(pool, startUpdate(t0, next.token)));
    assert.equal(fromT0.replies[0]!.text, uiString("linkOtherBelongs", "en"), "A has an interview, so nothing to approve");
    assert.equal((await liveLinks(trip.tripId, t0)).length, 0, "and T0 was not re-bound");
    assert.equal(await enrollmentState(next.token), "issued");

    const fromT1 = await dispatchUpdate(pool, startUpdate(t1, next.token));
    assert.equal(fromT1.kind, "reply", "T1 resumes its own interview");
    assert.equal(await enrollmentState(next.token), "consumed");
  });

  test("an ordinary redemption's link still stands for the whole account (it is how the account becomes bound at all)", async () => {
    const { t0, firstTripId } = await boundOrganizer();
    assert.equal(await scopeOf(firstTripId, t0), "account");
  });

  test("Unlink then Restore keeps how far a link reaches", async () => {
    const { unlinkTelegramLink } = await import("../src/telegram-mini-app.js");
    const { restoreTelegramLink } = await import("../src/telegram-link-token.js");
    const { user, t0, firstTripId } = await boundOrganizer();
    const row = (await pool.query("SELECT id FROM control_plane.telegram_organizer_trip_links WHERE trip_id = $1 AND telegram_subject_digest = $2 AND revoked_at IS NULL", [firstTripId, digestOf(t0)])).rows[0];
    assert.equal(await unlinkTelegramLink(pool, user, row.id), true);
    const restored = await restoreTelegramLink(pool, { userId: user, linkId: row.id });
    assert.equal(restored.ok, true);
    assert.equal(await scopeOf(firstTripId, t0), "account");
    // And a trip-scoped link restores as trip-scoped.
    const a = await draftTrip(user, "Trip A");
    const added = nextChat();
    const issued = await issueTelegramLinkToken(pool, { userId: user, tripId: a.tripId });
    assert.ok(issued.ok);
    if (!issued.ok) return;
    await redeemTelegramLinkToken(pool, issued.token, added, null);
    const linkRow = (await pool.query("SELECT id FROM control_plane.telegram_organizer_trip_links WHERE trip_id = $1 AND telegram_subject_digest = $2 AND revoked_at IS NULL", [a.tripId, digestOf(added)])).rows[0];
    await unlinkTelegramLink(pool, user, linkRow.id);
    assert.equal((await restoreTelegramLink(pool, { userId: user, linkId: linkRow.id })).ok, true);
    assert.equal(await scopeOf(a.tripId, added), "trip");
  });

  test("the approval prompt says what Approve grants: this trip only, in both languages, Hebrew in the plural voice", () => {
    assert.match(UI_STRINGS.en.linkApprovePrompt!, /this trip only/i);
    assert.match(UI_STRINGS.he.linkApprovePrompt!, /לטיול הזה בלבד/);
    assert.match(UI_STRINGS.he.linkApprovePrompt!, /אשרו/);
  });
});
