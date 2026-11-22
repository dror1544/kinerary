/**
 * `/invite <traveller>`: an organizer asks the bot, in their own private chat, for a traveller's personal invite
 * (docs/specs/sprint-9/x-member-sign-in.md, slice S2b, replacing AC-12's companion tool).
 *
 * Postgres, the migrations and `createSiteInvite` are real; the trip site is a stub that answers `listParticipants` (the same
 * stand-in `site-invite-existing-traveller` uses through its harness). Every dispatch goes through the real `dispatchUpdate`, and the
 * "what the bot sent" half goes through the real `applyDecision` with a recording Telegram client, so "reply sent to THAT chat id"
 * and "nothing stored" are read off what was sent and what the database holds, not off a decision's shape.
 *
 * The one rule behind every case: WHO and WHERE come from the Telegram update's own fields and the database, never from the text.
 * Whatever is not a verified organizer, in their own private chat, falls through to the answer any unknown command gets.
 */
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { appendFileSync } from "node:fs";
import { after, before, describe, test } from "node:test";
import { fileURLToPath } from "node:url";
import type pg from "pg";
import { applyMigrations } from "../src/migrations.js";
import { DEFAULT_STRINGS, dispatchUpdate, type DispatchDecision, type DispatchOptions, type DirectReply } from "../src/relay/dispatch.js";
import { applyDecision, type TripBotPollerDeps } from "../src/relay/poller.js";
import { digestTelegramId } from "../src/identity.js";
import { normalizeTravellerName } from "../src/relay/invite-command.js";
import type { RuntimeAccountAdapter } from "../src/portal.js";
import type { TelegramUpdate } from "../src/relay/normalize.js";
import { testDatabaseUrl, testPool } from "./support/test-database.js";

const SKIP = !testDatabaseUrl();
const migrationsDir = fileURLToPath(new URL("../../db/migrations/", import.meta.url));
const ORIGIN = "http://portal.example.test";

let pool: pg.Pool;
before(async () => {
  if (SKIP) return;
  pool = testPool({ max: 6 });
  const client = await pool.connect();
  try {
    await client.query("DROP SCHEMA IF EXISTS control_plane CASCADE");
    await client.query("DROP TABLE IF EXISTS public.control_plane_schema_migrations");
    await applyMigrations(client, migrationsDir);
  } finally { client.release(); }
});
after(async () => { if (!SKIP) await pool.end(); });

const hex = () => randomBytes(8).toString("hex");
const id = (prefix: string) => `${prefix}_${hex()}`;
let nextTg = 8_100_000_000;
const tg = () => ++nextTg;
let nextGroup = 4_000_000_000;
const newGroupChat = () => String(-(++nextGroup));

interface Person { username: string; displayName: string; role: string }
const PEOPLE: Person[] = [
  { username: "dl17", displayName: "Dana Levi", role: "member" },
  { username: "nl23", displayName: "Noam Levi", role: "member" },
  { username: "yk04", displayName: "יעל כהן", role: "member" },
  { username: "mk05", displayName: "Maya Katz", role: "member" },
  { username: "og01", displayName: "Olga Organizer", role: "organizer" },
];

interface World {
  tripId: string;
  title: string;
  owner: string;
  ownerTg: number;
  ownerChat: string;
  site: { people: Person[] | "unreachable" };
  options: DispatchOptions;
  logs: string[];
  log: (line: string) => void;
}

async function mkUser(name: string): Promise<string> {
  const userId = id("user");
  await pool.query("INSERT INTO control_plane.users(id, status, display_name) VALUES ($1, 'active', $2)", [userId, name]);
  return userId;
}
async function mkTrip(title: string, language?: "he" | "en"): Promise<string> {
  const tripId = id("trip");
  await pool.query("INSERT INTO control_plane.trips(id, slug, lifecycle_state, title) VALUES ($1, $2, 'draft', $3)", [tripId, `inv-${tripId.replace(/_/g, "-")}`, title]);
  if (language) await pool.query("UPDATE control_plane.trips SET companion_intro = jsonb_build_object('language', $2::text) WHERE id = $1", [tripId, language]);
  return tripId;
}
async function mkMember(tripId: string, userId: string, role: string, dashboard = role !== "member"): Promise<void> {
  await pool.query(
    "INSERT INTO control_plane.trip_memberships(id, trip_id, user_id, role, status, dashboard_access, runtime_access) VALUES ($1, $2, $3, $4, 'active', $5, true)",
    [id("memb"), tripId, userId, role, dashboard]);
}
async function linkOrganizer(tripId: string, userId: string, telegramId: number, revoked = false): Promise<void> {
  await pool.query(
    `INSERT INTO control_plane.telegram_organizer_trip_links(id, user_id, trip_id, telegram_subject_digest, verified_via, revoked_at, revoked_reason)
     VALUES ($1, $2, $3, $4, 'enrollment_redemption', ${revoked ? "now()" : "NULL"}, ${revoked ? "'owner_unlinked'" : "NULL"})`,
    [id("tol"), userId, tripId, digestTelegramId(String(telegramId))]);
}
async function linkMember(tripId: string, userId: string, telegramId: number): Promise<void> {
  await pool.query(
    "INSERT INTO control_plane.telegram_member_links(id, user_id, trip_id, telegram_subject_digest, verified_via) VALUES ($1, $2, $3, $4, 'mini_app_trip_password')",
    [id("tml"), userId, tripId, digestTelegramId(String(telegramId))]);
}
async function bind(tripId: string, chatId: string): Promise<void> {
  await pool.query("INSERT INTO control_plane.telegram_chat_bindings(id, chat_id, trip_id, hermes_profile) VALUES ($1, $2, $3, 'companion-test')", [id("tcb"), chatId, tripId]);
}

async function world(opts: { title?: string; language?: "he" | "en"; people?: Person[] } = {}): Promise<World> {
  const title = opts.title ?? "Alsace in December";
  const tripId = await mkTrip(title, opts.language ?? "en");
  const owner = await mkUser("The Owner");
  await mkMember(tripId, owner, "owner");
  const ownerTg = tg();
  await linkOrganizer(tripId, owner, ownerTg);
  const ownerChat = String(ownerTg);
  await bind(tripId, ownerChat);
  const site = { people: (opts.people ?? PEOPLE).map((p) => ({ ...p })) as Person[] | "unreachable" };
  const runtimeAccounts = {
    listParticipants: async () => {
      if (site.people === "unreachable") throw new Error("RUNTIME_PARTICIPANT_LIST_FAILED");
      return site.people.map((p) => ({ ...p }));
    },
  } as unknown as RuntimeAccountAdapter;
  const logs: string[] = [];
  return { tripId, title, owner, ownerTg, ownerChat, site, options: { siteInvites: { runtimeAccounts, publicOrigin: ORIGIN } }, logs, log: (line) => { logs.push(line); } };
}

function say(fromId: number, chatId: string, text: string, chatType = "private", extra: Record<string, unknown> = {}): TelegramUpdate {
  return { update_id: 1, message: { message_id: 7, from: { id: fromId, first_name: "Someone", language_code: "en" }, chat: { id: chatId, type: chatType }, text, ...extra } as never };
}
const asOwner = (w: World, text: string) => say(w.ownerTg, w.ownerChat, text);

async function run(w: World, update: TelegramUpdate, options: DispatchOptions = w.options): Promise<DispatchDecision> {
  const decision = await dispatchUpdate(pool, update, DEFAULT_STRINGS, w.log, {}, options);
  // `INVITE_TRACE=<file> npm test ...` appends each update that went in and every message the bot sent out, one JSON line each.
  if (process.env.INVITE_TRACE) {
    const out = decision.kind === "reply" ? [decision.reply] : decision.kind === "multi_reply" ? decision.replies : [];
    appendFileSync(process.env.INVITE_TRACE, `${JSON.stringify({ update: update.message ?? update.edited_message, decision: decision.kind, sends: out.map((r) => ({ chat_id: r.chatId, text: r.text })) })}\n`);
  }
  return decision;
}
function repliesOf(decision: DispatchDecision): DirectReply[] {
  if (decision.kind === "reply") return [decision.reply];
  if (decision.kind === "multi_reply") return decision.replies;
  return [];
}
const textOf = (decision: DispatchDecision) => repliesOf(decision).map((r) => r.text).join("\n---\n");
const invites = async (tripId: string) =>
  (await pool.query("SELECT id, created_by, runtime_username, state, intended_display_name FROM control_plane.site_invites WHERE trip_id = $1 ORDER BY created_at, id", [tripId])).rows as
    { id: string; created_by: string; runtime_username: string; state: string; intended_display_name: string }[];
const outboxCount = async () => Number((await pool.query("SELECT count(*)::int AS n FROM control_plane.notification_outbox")).rows[0].n);
const linkIn = (text: string) => /http:\/\/portal\.example\.test\/join#token=[A-Za-z0-9_-]+/.exec(text)?.[0] ?? null;

/** What the poller does with a decision, against a Telegram client that records every send. */
async function sentBy(w: World, decision: DispatchDecision): Promise<{ chatId: string; text: string }[]> {
  const sent: { chatId: string; text: string }[] = [];
  const deps = {
    db: pool,
    telegram: { sendMessage: async (p: { chatId: string; text: string }) => { sent.push({ chatId: p.chatId, text: p.text }); return { ok: true }; } },
    connector: { pushInbound: () => true },
    log: w.log,
  } as unknown as TripBotPollerDeps;
  await applyDecision(decision, deps);
  return sent;
}

/** The answer an unknown command gets in that chat today: the same update with a command that does not exist, name put back. */
async function unknownCommandAnswer(w: World, update: TelegramUpdate, command = "invite"): Promise<string> {
  const text = (update.message as { text: string }).text;
  const probe = structuredClone(update);
  (probe.message as { text: string }).text = text.replace(/^\/invite/, "/zzprobe");
  const decision = await run(w, probe);
  return textOf(decision).replaceAll("zzprobe", command);
}

describe("name normalisation: exact after normalising, nothing fuzzy", () => {
  test("case, whitespace, Unicode form, Hebrew points, bidi marks and smart quotes are folded; letters are not", () => {
    assert.equal(normalizeTravellerName("  Dana   LEVI "), "dana levi");
    assert.equal(normalizeTravellerName("‫יעל‬   כהן"), normalizeTravellerName("יעל כהן"));
    assert.equal(normalizeTravellerName("יָעֵל כהן"), normalizeTravellerName("יעל כהן"), "niqqud is not part of the name");
    assert.equal(normalizeTravellerName("Ｄana"), "dana", "full-width forms fold (NFKC)");
    assert.equal(normalizeTravellerName("Rémi"), normalizeTravellerName("Rémi"), "NFC and NFD spell the same name");
    assert.equal(normalizeTravellerName("O’Neil"), normalizeTravellerName("O'Neil"));
    assert.notEqual(normalizeTravellerName("Dan"), normalizeTravellerName("Dana"), "no prefix matching");
    assert.notEqual(normalizeTravellerName("Rémi"), normalizeTravellerName("Remi"), "accents are letters");
  });
});

describe("/invite: an organizer, in their own private chat, with dashboard access", { skip: SKIP }, () => {
  test("success: the invite is created for THAT organizer, the reply goes to THAT chat, the link is in it, and nothing else holds it", async () => {
    const w = await world();
    const before = await outboxCount();
    const decision = await run(w, asOwner(w, "/invite Dana Levi"));
    assert.ok(decision.kind === "reply" || decision.kind === "multi_reply", `answered by the relay itself, not the gateway: ${decision.kind}`);
    assert.ok(repliesOf(decision).every((r) => r.chatId === w.ownerChat), "every message goes to the organizer's private chat");
    const rows = await invites(w.tripId);
    assert.equal(rows.length, 1);
    assert.equal(rows[0]!.created_by, w.owner, "created_by is the organizer's control-plane user, found from the Telegram sender");
    assert.equal(rows[0]!.runtime_username, "dl17");
    assert.equal(rows[0]!.state, "unused");
    const text = textOf(decision);
    const link = linkIn(text);
    assert.ok(link, `the join link is in the reply: ${text}`);
    assert.match(text, /Alsace in December/, "the trip is named");
    assert.match(text, /Dana Levi/, "the traveller is named, as the trip site spells it");
    assert.match(text, /7 days|until \d{1,2} \w+ \d{4}/i, "the expiry is in words");
    assert.match(text, /[֐-׿]/, "the forwardable message carries Hebrew");
    assert.match(text, /personal link to our trip/, "and English");
    assert.equal(await outboxCount(), before, "nothing went through the outbox");
    // What was SENT: the same text, to that chat only.
    const sent = await sentBy(w, decision);
    assert.ok(sent.length >= 2 && sent.every((s) => s.chatId === w.ownerChat));
    assert.ok(sent.some((s) => s.text.includes(link!)));
    // The token is held as a digest only.
    const token = link!.split("#token=")[1]!;
    const stored = await pool.query("SELECT count(*)::int AS n FROM control_plane.site_invites WHERE token_digest LIKE '%' || $1 || '%'", [token]);
    assert.equal(stored.rows[0].n, 0, "the plain token is stored nowhere in the invite row");
  });

  test("the log lines of the success carry no link, token, chat id, user id or name", async () => {
    const w = await world();
    const decision = await run(w, asOwner(w, "/invite Dana Levi"));
    const link = linkIn(textOf(decision))!;
    const token = link.split("#token=")[1]!;
    assert.ok(w.logs.length > 0, "the command logs its outcome");
    const all = w.logs.join("\n");
    for (const secret of [link, token, "#token", w.ownerChat, String(w.ownerTg), w.owner, w.tripId, "Dana", "Levi", "dl17", "Alsace", digestTelegramId(String(w.ownerTg))]) {
      assert.ok(!all.includes(secret), `a log line contains ${secret.slice(0, 12)}…`);
    }
    assert.match(all, /trip_bot\.invite_command/);
    console.log("LOG LINES (success):", w.logs);
  });

  test("it is consumed by the relay: never handed to the gateway, and the same words inside a sentence are ordinary text", async () => {
    const w = await world();
    for (const text of ["/invite Dana Levi", "/INVITE   dana levi", "/invite@kinerary_bot Dana Levi"]) {
      const d = await run(w, asOwner(w, text));
      assert.notEqual(d.kind, "to_gateway", text);
      assert.match(textOf(d), /http:\/\/portal\.example\.test\/join#token=/, text);
    }
    const before = (await invites(w.tripId)).length;
    const sentence = await run(w, asOwner(w, "please /invite Dana Levi for me"));
    assert.equal(sentence.kind, "to_gateway", "a command inside a longer message is the companion's to read, as for every other command");
    assert.equal((await invites(w.tripId)).length, before, "and writes nothing");
  });

  test("an edit, a forward, a caption and a bot are not a command: nothing is written and nothing is issued", async () => {
    const w = await world();
    const edited = await run(w, { update_id: 2, edited_message: asOwner(w, "/invite Dana Levi").message });
    const forwarded = await run(w, say(w.ownerTg, w.ownerChat, "/invite Dana Levi", "private", { forward_origin: { type: "user" }, forward_date: 1 }));
    const caption = await run(w, { update_id: 3, message: { message_id: 8, from: { id: w.ownerTg }, chat: { id: w.ownerChat, type: "private" }, caption: "/invite Dana Levi", photo: [{ file_id: "x" }] } as never });
    const bot = await run(w, say(w.ownerTg, w.ownerChat, "/invite Dana Levi", "private", { from: { id: w.ownerTg, is_bot: true } }));
    for (const d of [edited, forwarded, caption, bot]) assert.doesNotMatch(textOf(d), /join#token/);
    assert.deepEqual(await invites(w.tripId), []);
  });

  test("a private chat whose from.id is not its chat id is not a private chat of that person", async () => {
    const w = await world();
    const elsewhere = String(tg());
    await bind(w.tripId, elsewhere);
    const d = await run(w, say(w.ownerTg, elsewhere, "/invite Dana Levi"));
    assert.doesNotMatch(textOf(d), /join#token/);
    assert.deepEqual(await invites(w.tripId), []);
  });

  test("it is not gated by member_group_sign_in (decision D1): works with the switch off, and with no switch row at all", async () => {
    const w = await world();
    const rows = await pool.query("SELECT 1 FROM control_plane.feature_switch_settings WHERE switch = 'member_group_sign_in' AND trip_id = $1", [w.tripId]);
    assert.equal(rows.rowCount, 0);
    assert.match(textOf(await run(w, asOwner(w, "/invite Dana Levi"))), /join#token/);
  });

  test("the language is the relay's own choice for that chat: a Hebrew trip is answered in Hebrew", async () => {
    const w = await world({ language: "he", title: "אלזס בדצמבר" });
    const d = await run(w, asOwner(w, "/invite Dana Levi"));
    const first = repliesOf(d)[0]!.text;
    assert.match(first, /[֐-׿]/);
    assert.match(first, /אלזס בדצמבר/);
    assert.match(first, /Dana Levi/);
    const claimed = await run(w, asOwner(w, "/invite Noam Levi"));
    await pool.query("INSERT INTO control_plane.trip_participant_claims(id, trip_id, user_id, runtime_username, via, telegram_user_id) VALUES ($1, $2, $3, 'yk04', 'group_membership', '123')", [id("tpc"), w.tripId, await mkUser("Yael")]);
    const refused = await run(w, asOwner(w, "/invite יעל כהן"));
    assert.match(textOf(refused), /[֐-׿]/);
    assert.doesNotMatch(textOf(refused), /signed in as/);
    assert.ok(claimed);
  });
});

describe("/invite: who is refused, and where", { skip: SKIP }, () => {
  test("the trip's own group, even when the sender IS the owner: one short reply naming nothing, nothing written", async () => {
    const w = await world();
    const group = newGroupChat();
    await bind(w.tripId, group);
    for (const type of ["group", "supergroup"]) {
      const d = await run(w, say(w.ownerTg, group, "/invite Dana Levi", type));
      assert.equal(d.kind, "reply");
      const text = textOf(d);
      assert.equal(repliesOf(d)[0]!.chatId, group);
      assert.match(text, /private chat/i);
      for (const leak of ["Dana", "Levi", "Alsace", "join", "token", "http", "organizer", "dl17"]) assert.ok(!text.toLowerCase().includes(leak.toLowerCase()), `the group reply names ${leak}`);
      assert.ok(text.length < 140, "short");
    }
    // The same reply for anybody else in the group, so it says nothing about who is an organizer.
    const other = await run(w, say(tg(), group, "/invite Dana Levi", "group"));
    assert.equal(textOf(other), textOf(await run(w, say(w.ownerTg, group, "/invite Dana Levi", "group"))));
    assert.deepEqual(await invites(w.tripId), []);
    console.log("GROUP reply:", textOf(other));
  });

  test("a plain member, an invited or claimed member and a stranger in a private chat bound to the trip get the unknown-command answer, and nothing is written", async () => {
    const w = await world();
    const kinds: [string, (telegramId: number) => Promise<void>][] = [
      ["plain member", async (n) => { const u = await mkUser("M"); await mkMember(w.tripId, u, "member"); await linkMember(w.tripId, u, n); }],
      ["claimed member", async (n) => { const u = await mkUser("C"); await mkMember(w.tripId, u, "member"); await linkMember(w.tripId, u, n); await pool.query("INSERT INTO control_plane.trip_participant_claims(id, trip_id, user_id, runtime_username, via, telegram_user_id) VALUES ($1, $2, $3, 'mk05', 'group_membership', $4)", [id("tpc"), w.tripId, u, String(n)]); }],
      ["stranger", async () => undefined],
      ["former organizer", async (n) => { const u = await mkUser("F"); await mkMember(w.tripId, u, "organizer"); await linkOrganizer(w.tripId, u, n, true); }],
      ["secondary organizer without the dashboard", async (n) => { const u = await mkUser("S"); await mkMember(w.tripId, u, "organizer", false); await linkOrganizer(w.tripId, u, n); }],
      ["organizer whose membership ended", async (n) => { const u = await mkUser("E"); await pool.query("INSERT INTO control_plane.trip_memberships(id, trip_id, user_id, role, status, dashboard_access, runtime_access) VALUES ($1, $2, $3, 'owner', 'revoked', true, true)", [id("memb"), w.tripId, u]); await linkOrganizer(w.tripId, u, n); }],
    ];
    for (const [label, make] of kinds) {
      const telegramId = tg();
      await make(telegramId);
      await bind(w.tripId, String(telegramId));
      const update = say(telegramId, String(telegramId), "/invite Dana Levi");
      const d = await run(w, update);
      assert.equal(d.kind, "reply", label);
      const expected = await unknownCommandAnswer(w, update);
      assert.equal(textOf(d), expected, `${label}: exactly the unknown-command answer`);
      assert.match(textOf(d), /isn't one of my commands/, label);
      assert.doesNotMatch(textOf(d), /organizer|dashboard|private chat|Dana|Levi/i, `${label}: nothing that says the command exists for anyone`);
      assert.ok(!(await sentBy(w, d)).some((s) => /join#token/.test(s.text)));
    }
    assert.deepEqual(await invites(w.tripId), [], "nothing written for any of them");
    // And the owner's own chat did not change.
    assert.match(textOf(await run(w, asOwner(w, "/invite Dana Levi"))), /join#token/);
  });

  test("an organizer of a DIFFERENT trip, in a chat bound to this one, is refused like a stranger", async () => {
    const w = await world();
    const other = await world({ title: "Elsewhere" });
    const chat = String(other.ownerTg);
    // Their own chat is (also) bound... to THIS trip only; they organize the other one.
    await pool.query("DELETE FROM control_plane.telegram_chat_bindings WHERE chat_id = $1", [chat]);
    await bind(w.tripId, chat);
    const update = say(other.ownerTg, chat, "/invite Dana Levi");
    const d = await run(w, update);
    assert.equal(textOf(d), await unknownCommandAnswer(w, update));
    assert.deepEqual(await invites(w.tripId), []);
    assert.deepEqual(await invites(other.tripId), []);
  });

  test("an organizer of several trips invites for the trip THIS chat is on (the /switch rule), and the reply names that trip", async () => {
    const a = await world({ title: "Trip A" });
    const b = await world({ title: "Trip B", people: PEOPLE });
    // One person organizes both; their chat is bound to B.
    const shared = tg();
    await linkOrganizer(a.tripId, a.owner, shared);
    await linkOrganizer(b.tripId, b.owner, shared);
    await pool.query("DELETE FROM control_plane.telegram_chat_bindings WHERE chat_id = $1", [String(shared)]);
    await bind(b.tripId, String(shared));
    const d = await run(b, say(shared, String(shared), "/invite Dana Levi"));
    assert.match(textOf(d), /Trip B/);
    assert.doesNotMatch(textOf(d), /Trip A/);
    assert.equal((await invites(b.tripId)).length, 1);
    assert.equal((await invites(a.tripId)).length, 0);
    // Pointing the chat at A (what /switch does) moves the command with it.
    await pool.query("UPDATE control_plane.telegram_chat_bindings SET trip_id = $2 WHERE chat_id = $1", [String(shared), a.tripId]);
    const d2 = await run(a, say(shared, String(shared), "/invite Noam Levi"));
    assert.match(textOf(d2), /Trip A/);
    assert.equal((await invites(a.tripId)).length, 1);
  });

  test("an organizer whose chat has no trip, or is mid-interview, gets what any command gets there (this block does not answer)", async () => {
    const w = await world();
    const loose = tg();
    const u = await mkUser("Loose");
    await mkMember(w.tripId, u, "owner");
    await linkOrganizer(w.tripId, u, loose);
    const d = await run(w, say(loose, String(loose), "/invite Dana Levi"));
    assert.doesNotMatch(textOf(d), /join#token/);
    assert.deepEqual(await invites(w.tripId), []);
  });
});

describe("/invite: which traveller", { skip: SKIP }, () => {
  test("Hebrew and English names, whatever the spacing, case or Unicode form", async () => {
    const w = await world();
    for (const [typed, username] of [["יעל כהן", "yk04"], ["  יעל    כהן ", "yk04"], ["יָעֵל כהן", "yk04"], ["dana LEVI", "dl17"], ["Maya Katz", "mk05"], ["MAYA", "mk05"]] as const) {
      await run(w, asOwner(w, `/invite ${typed}`));
      assert.ok((await invites(w.tripId)).some((r) => r.runtime_username === username && r.state === "unused"), typed);
    }
  });

  test("no such traveller: 'no traveller by that name' plus the invitable display names only", async () => {
    const w = await world();
    const d = await run(w, asOwner(w, "/invite Nobody Here"));
    const text = textOf(d);
    assert.match(text, /no traveller/i);
    for (const name of ["Dana Levi", "Noam Levi", "יעל כהן", "Maya Katz"]) assert.ok(text.includes(name), name);
    assert.ok(!text.includes("Olga"), "an organizer is not invitable and is not listed");
    for (const username of ["dl17", "nl23", "yk04", "mk05", "og01"]) assert.ok(!text.includes(username), "no usernames");
    assert.ok(!text.includes("Nobody Here"), "the typed name is not echoed");
    assert.deepEqual(await invites(w.tripId), []);
    // Same shape for an organizer's own name: they are not a traveller to invite.
    const organizerName = await run(w, asOwner(w, "/invite Olga Organizer"));
    assert.equal(textOf(organizerName), text);
    assert.deepEqual(await invites(w.tripId), []);
  });

  test("several travellers fit: 'which one?' and their display names, and nothing is created", async () => {
    const w = await world();
    const d = await run(w, asOwner(w, "/invite Levi"));
    assert.match(textOf(d), /which one/i);
    assert.ok(textOf(d).includes("Dana Levi") && textOf(d).includes("Noam Levi"));
    assert.ok(!textOf(d).includes("Maya Katz"), "only the ones that fit");
    assert.deepEqual(await invites(w.tripId), []);
    // A whole name beats a word of other names.
    const w2 = await world({ people: [...PEOPLE, { username: "dn30", displayName: "Dan", role: "member" }, { username: "dn31", displayName: "Dan Cohen", role: "member" }] });
    await run(w2, asOwner(w2, "/invite Dan"));
    assert.deepEqual((await invites(w2.tripId)).map((r) => r.runtime_username), ["dn30"]);
    // Two travellers with the very same display name cannot be told apart by a name: said so, nothing created.
    const w3 = await world({ people: [{ username: "aa01", displayName: "Sam Same", role: "member" }, { username: "aa02", displayName: "Sam Same", role: "member" }] });
    const same = await run(w3, asOwner(w3, "/invite Sam Same"));
    assert.match(textOf(same), /same name|more than one/i);
    assert.deepEqual(await invites(w3.tripId), []);
  });

  test("no name: the usage and the invitable display names", async () => {
    const w = await world();
    for (const text of ["/invite", "/invite   "]) {
      const d = await run(w, asOwner(w, text));
      assert.match(textOf(d), /\/invite <?[^\n]*name/i);
      assert.ok(textOf(d).includes("Dana Levi") && textOf(d).includes("יעל כהן"));
      assert.ok(!textOf(d).includes("Olga"));
    }
    assert.deepEqual(await invites(w.tripId), []);
  });

  test("the typed name is compared, never echoed, never formatted and never used in SQL", async () => {
    const w = await world();
    const hostile = "<b>x</b> `y` *z* _w_ [a](http://evil.example) '); DROP TABLE control_plane.site_invites; --";
    const d = await run(w, asOwner(w, `/invite ${hostile}`));
    for (const piece of ["<b>", "evil.example", "DROP", "`y`", "*z*"]) assert.ok(!textOf(d).includes(piece), piece);
    assert.ok(repliesOf(d).every((r) => r.replyMarkup === undefined));
    // Plain text on the wire: the poller sends a DirectReply with no parse mode.
    const calls: Record<string, unknown>[] = [];
    await applyDecision(d, { db: pool, telegram: { sendMessage: async (p: Record<string, unknown>) => { calls.push(p); return { ok: true }; } }, connector: {}, log: w.log } as unknown as TripBotPollerDeps);
    assert.ok(calls.length > 0 && calls.every((c) => c.parseMode === undefined));
    await pool.query("SELECT 1 FROM control_plane.site_invites LIMIT 1");
  });
});

describe("/invite: what createSiteInvite answers, in plain words", { skip: SKIP }, () => {
  test("a repeat for the same traveller replaces the pending invite and says the earlier link no longer works", async () => {
    const w = await world();
    const first = linkIn(textOf(await run(w, asOwner(w, "/invite Dana Levi"))))!;
    assert.doesNotMatch(textOf(await run(w, asOwner(w, "/invite Noam Levi"))), /no longer works|stopped working|replac/i, "a first invite replaces nothing");
    const again = await run(w, asOwner(w, "/invite Dana Levi"));
    const second = linkIn(textOf(again))!;
    assert.notEqual(second, first);
    assert.match(textOf(again), /earlier link for Dana Levi no longer works/);
    const rows = (await invites(w.tripId)).filter((r) => r.runtime_username === "dl17");
    assert.deepEqual(rows.map((r) => r.state).sort(), ["revoked", "unused"]);
  });

  test("somebody signed in as that traveller from the group: release it in Organizer settings first", async () => {
    const w = await world();
    await pool.query("INSERT INTO control_plane.trip_participant_claims(id, trip_id, user_id, runtime_username, via, telegram_user_id) VALUES ($1, $2, $3, 'dl17', 'group_membership', '555')", [id("tpc"), w.tripId, await mkUser("Dana")]);
    const d = await run(w, asOwner(w, "/invite Dana Levi"));
    assert.match(textOf(d), /signed in as Dana Levi from the group/);
    assert.match(textOf(d), /Organizer settings/);
    assert.doesNotMatch(textOf(d), /join#token/);
    assert.deepEqual(await invites(w.tripId), []);
  });

  test("a traveller who already redeemed a personal invite: said plainly, and the redeemed one is never replaced", async () => {
    const w = await world();
    const redeemer = await mkUser("Dana");
    await pool.query(
      `INSERT INTO control_plane.site_invites(id, trip_id, created_by, intended_display_name, runtime_username, token_digest, state, expires_at, redeemed_by, redeemed_at)
       VALUES ($1, $2, $3, 'Dana Levi', 'dl17', $4, 'redeemed', now() + interval '1 day', $5, now())`,
      [id("invite"), w.tripId, w.owner, `sha256:${hex().padEnd(64, "0")}`, redeemer]);
    const d = await run(w, asOwner(w, "/invite Dana Levi"));
    assert.match(textOf(d), /Dana Levi already signed in with a personal invite/);
    assert.equal((await invites(w.tripId)).length, 1);
    assert.equal((await invites(w.tripId))[0]!.state, "redeemed");
  });

  test("the trip site cannot be asked: try again, with nothing created", async () => {
    const w = await world();
    w.site.people = "unreachable";
    const d = await run(w, asOwner(w, "/invite Dana Levi"));
    assert.equal(d.kind, "reply");
    assert.match(textOf(d), /try again/i);
    assert.deepEqual(await invites(w.tripId), []);
  });

  test("anything else is a generic failure that names nothing", async () => {
    const w = await world();
    const broken = { ...w.options, siteInvites: { ...w.options.siteInvites!, publicOrigin: ORIGIN } };
    const real = w.options.siteInvites!.runtimeAccounts;
    let calls = 0;
    broken.siteInvites.runtimeAccounts = { ...real, listParticipants: async (tripId: string) => { calls += 1; if (calls === 1) return real.listParticipants(tripId); return [{ username: "dl17", displayName: "Dana Levi", role: "organizer" }]; } } as RuntimeAccountAdapter;
    const d = await run(w, asOwner(w, "/invite Dana Levi"), broken);
    assert.equal(d.kind, "reply");
    assert.match(textOf(d), /couldn't|could not|didn't work/i);
    assert.doesNotMatch(textOf(d), /RUNTIME|NOT_ELIGIBLE|dl17/);
    assert.deepEqual(await invites(w.tripId), []);
  });

  test("a relay not wired for invites says so to the organizer, loudly in the log, and writes nothing; non-organizers still get the unknown-command answer", async () => {
    const w = await world();
    const d = await run(w, asOwner(w, "/invite Dana Levi"), {});
    assert.equal(d.kind, "reply");
    assert.match(textOf(d), /not available|isn't available|unavailable/i);
    assert.ok(w.logs.some((l) => /trip_bot\.invite_command_unconfigured/.test(l)));
    assert.deepEqual(await invites(w.tripId), []);
    const stranger = tg();
    await bind(w.tripId, String(stranger));
    const update = say(stranger, String(stranger), "/invite Dana Levi");
    assert.equal(textOf(await run(w, update, {})), await unknownCommandAnswer(w, update));
  });
});

describe("/invite: rate limit", { skip: SKIP }, () => {
  test("30 invites per organizer per trip per hour; the 31st is refused, nothing written; another organizer's allowance is their own", async () => {
    const w = await world();
    for (let i = 0; i < 30; i += 1) {
      await pool.query(
        `INSERT INTO control_plane.site_invites(id, trip_id, created_by, intended_display_name, runtime_username, token_digest, state, expires_at)
         VALUES ($1, $2, $3, 'X', $4, $5, 'revoked', now() + interval '1 day')`,
        [id("invite"), w.tripId, w.owner, `xx${String(i).padStart(2, "0")}`, `sha256:${hex().padEnd(64, "0")}`]);
    }
    const d = await run(w, asOwner(w, "/invite Dana Levi"));
    assert.match(textOf(d), /too many|later/i);
    assert.doesNotMatch(textOf(d), /join#token/);
    assert.equal((await invites(w.tripId)).length, 30);
    assert.ok(w.logs.some((l) => /"outcome":"rate_limited"/.test(l)));
    // A second organizer of the same trip is not held back by the first's count.
    const second = await mkUser("Second"); await mkMember(w.tripId, second, "organizer", true);
    const secondTg = tg(); await linkOrganizer(w.tripId, second, secondTg); await bind(w.tripId, String(secondTg));
    assert.match(textOf(await run(w, say(secondTg, String(secondTg), "/invite Dana Levi"))), /join#token/);
  });
});
