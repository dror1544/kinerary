/**
 * `/invite <traveller>` — an organizer asks the bot, in their OWN private chat, for a traveller's personal invite
 * (docs/specs/sprint-9/x-member-sign-in.md, slice S2b; the owner's decision of 2026-11-22 replaced AC-12's companion tool with this).
 *
 * WHY THE RELAY AND NOT THE COMPANION. The companion's control MCP knows only its profile: never who typed, never whether the turn was a
 * group or a private chat, so a tool there cannot prove an organizer asked. The relay reads the sender off Telegram's own update, and
 * that is the proof. Everything below decides WHO and WHERE from the update's fields and the database, never from the message text:
 *
 *   - the chat must be PRIVATE, and the sender (`message.from.id`) must be that chat's own person (`chat.id`);
 *   - the trip is the one THIS chat is bound to (`resolveChatRoute`: the rule /trips and /switch use, `/switch` repoints the binding);
 *   - the sender must be an organizer of that trip WITH DASHBOARD ACCESS, found as `telegram_organizer_trip_links` (live) joined to an
 *     active owner/organizer membership with `dashboard_access`: the very account `createSiteInvite` accepts as `actorUserId`.
 *
 * THE RECORDED EXCEPTION (owner's decision, Dror, 2026-11-22). `portal-scope.ts` classifies `POST /v1/trips/:id/site-invites` as `account`:
 * a site invite makes an account that outlives the session that minted it, so a Telegram-minted (scoped) session may not create one.
 * This command deliberately lets a Telegram-proven organizer do exactly that, as a named exception to that rule, and it is bounded:
 *   - the PRIVATE chat of the organizer only (never a group, never a forward, an edit, a caption, `via_bot` or a business message);
 *   - an organizer of the chat's trip WITH dashboard access (a secondary organizer without it, a member, a former organizer: refused);
 *   - 5 invites per organizer per trip per hour (`INVITES_PER_HOUR`), counted in `site_invites`;
 *   - EXISTING travellers only: it binds a participant the trip site already lists as `member`, it never creates one;
 *   - the link goes ONLY to that private chat: not a log, not the outbox, not a stored row; if it cannot be delivered the invite is
 *     revoked (`revokeUnsentInvite`) so nothing unreachable stays pending.
 * Anyone changing either side (this file or the `site-invites` row of `PORTAL_SCOPE_POLICY`) changes the other.
 *
 * That is STRICTER than `isTripOrganizer` (chat-router.ts), which also counts a trip person link of role 'organizer' (no account behind
 * it) and a secondary organizer (an 'organizer' membership WITHOUT dashboard access). Either could be a real organizer for /proactive;
 * neither can mint a way into the trip site, and `createSiteInvite` would answer them 404 anyway. Asking the same question here keeps
 * the refusal in one place and the unknown-command answer identical.
 *
 * Anyone else (a member, a claimed or invited member, a stranger, an organizer of another trip, a former organizer) is NOT answered by
 * this module: `handleInvite` is never reached for them and the update falls through to the answer any unknown command gets, so asking
 * confirms nothing, and the list of travellers' names reaches no one but a verified organizer. Only a group gets a short sentence of its
 * own, and it is the same for everybody in it.
 *
 * What is written, and where it can leak. The link is created by `createSiteInvite` (the one place the invite rules live) and goes
 * into the reply to the organizer's private chat and nowhere else: not a log line, not the outbox, not a stored row (the plain token is
 * never stored; the invite holds its digest). Replies are PLAIN TEXT (a `DirectReply` is sent with no parse mode), and the name the
 * organizer typed is only ever compared: no reply echoes it. A traveller's name comes from the trip site and is text a traveller may
 * have chosen, so EVERY name printed goes through `shown()`; one that looks like a link is never printed in the forwardable message.
 */
import type pg from "pg";
import { createSiteInvite, HttpRuntimeAccountAdapter, type RuntimeAccountAdapter } from "../portal.js";
import { structuredLog } from "../redaction.js";
import { tripDisplayName } from "../chat-router.js";
import { digestTelegramId, isPrivateChatId } from "../identity.js";
import { siteInviteForwardMessage } from "../site-invite-message.js";
import type { Language } from "../intake-copy.js";
import type { DirectReply } from "./dispatch.js";

/** What the relay needs to make an invite: the trip site's participant list, and the origin the join link is built on. */
export interface SiteInviteDeps {
  runtimeAccounts: Pick<RuntimeAccountAdapter, "listParticipants">;
  publicOrigin: string;
}

/** The part of the architecture profile's `web` block `/invite` reads (config.ts `web`): nothing is defaulted here. */
export interface SiteInviteProfile {
  public_origin: string;
  runtime_origin: string;
  runtime_exchange_key_secret_ref: string;
}

/**
 * Builds `SiteInviteDeps` for the relay from the profile's `web` block, the way the api builds its own (`server.ts`: the same adapter, the
 * same two origins, the same secret ref). `resolveSecret` is the relay's own resolver, injected so a test never depends on the
 * environment. Anything that stops it, no `web` block, a secret that cannot be resolved or one that is blank, leaves the relay UP with
 * `/invite` unset (an organizer is then told it is not available) and says so as `relay.site_invites_unconfigured`: a reason code and
 * the error's class name only, never the resolver's message (it can carry the reference or the value) and never the key.
 */
export async function siteInviteDepsFromProfile(
  web: SiteInviteProfile | undefined,
  resolveSecret: (ref: string) => Promise<string>,
  log: (line: string) => void,
): Promise<SiteInviteDeps | undefined> {
  const unconfigured = (level: "info" | "warn", reason: string, extra: Record<string, unknown> = {}): undefined => {
    log(structuredLog(level, "relay.site_invites_unconfigured", { reason, effect: "/invite answers 'not available' to organizers", ...extra }));
    return undefined;
  };
  if (!web) return unconfigured("info", "NO_WEB_BLOCK");
  let key: string;
  try {
    key = (await resolveSecret(web.runtime_exchange_key_secret_ref)).trim();
  } catch (error) {
    return unconfigured("warn", "SECRET_UNRESOLVED", { safe_error_code: error instanceof Error ? error.name : "UNKNOWN" });
  }
  if (!key) return unconfigured("warn", "SECRET_EMPTY");
  log(structuredLog("info", "relay.site_invites_ready", {}));
  return { runtimeAccounts: new HttpRuntimeAccountAdapter(web.runtime_origin, key), publicOrigin: web.public_origin };
}

/**
 * One organizer may make this many personal invites per trip per hour through any door (this command, the dashboard): counted from
 * `site_invites` itself, like `BUG_REPORT_LIMIT_PER_HOUR` (companion-mcp.ts) is from its own table, so it needs no state in the relay
 * and survives a restart. Five (owner's decision, 2026-11-22, with the recorded exception above): a chat command is the narrow door; a
 * whole family at once is Organizer settings.
 */
export const INVITES_PER_HOUR = 5;

/** How many names a reply lists before it says "and N more". */
const LIST_LIMIT = 30;
const NAME_LIMIT = 60;

// ── Names ─────────────────────────────────────────────────────────────────────

// TWIN of the trip site's own rule for participant names (server/text-rules.js: ALLOWED_MARKS, INVISIBLE_SRC; the site REFUSES these at
// the write, but a name stored before that rule, or written by another producer, can still carry them). Duplicated, not imported: this is
// a different package. Every Default_Ignorable_Code_Point (bidi embeddings, overrides and isolates, zero-width space, word joiner, soft
// hyphen, BOM, variation selectors, tag characters) plus the ones that draw as nothing (U+070F, line/paragraph separators, U+2800,
// U+FFF9-U+FFFC, U+16FE4), minus the marks people type with (LRM, RLM, ALM, ZWNJ, ZWJ, VS16: ALLOWED_MARKS on the site).
const ALLOWED_MARKS = String.raw`‌-‏؜️`;
const SITE_INVISIBLE_SRC = String.raw`(?![${ALLOWED_MARKS}])[\p{Default_Ignorable_Code_Point}܏  ⠀￹-￼\u{16FE4}]`;
const SITE_INVISIBLE = new RegExp(SITE_INVISIBLE_SRC, "gu");
// What is printed ALSO loses the bidi marks the site allows (LRM, RLM, ALM): a reversing mark in a list or a forwarded line is a display
// trick, and an organizer reads the name, not its direction mark. ZWNJ, ZWJ and VS16 stay (Persian words, emoji).
const BIDI_MARKS = /[‎‏؜]/g;
// What is COMPARED loses every one of them, and the Hebrew points.
const COMPARE_INVISIBLE = new RegExp(`${SITE_INVISIBLE_SRC}|[${ALLOWED_MARKS}]`, "gu");
const HEBREW_POINTS = /[֑-ׇֽֿׁׂׅׄ]/g;
const CONTROL = /[\u0000-\u001f\u007f-\u009f]/g;

/**
 * Letters that LOOK like a Latin letter, folded onto it for COMPARISON only (a skeleton, after NFKC and lower-casing). Covered: the
 * Cyrillic and Greek lower-case letters that are drawn like a Latin one in ordinary fonts, and dotless ı. NOT covered: the full Unicode
 * confusables table (UTS #39), Armenian, Cherokee, Arabic or Hebrew look-alikes, digits for letters (0/o, 1/l), I/l, and any look-alike
 * across two letters ("rn"/"m"). A pair outside this list is still two travellers the organizer sees spelled differently.
 */
const CONFUSABLE_PAIRS: readonly (readonly [string, string])[] = [
  // Cyrillic
  ["а", "a"], ["е", "e"], ["о", "o"], ["р", "p"], ["с", "c"], ["у", "y"], ["х", "x"], ["і", "i"], ["ј", "j"], ["ѕ", "s"], ["ԁ", "d"],
  ["һ", "h"], ["ԛ", "q"], ["ԝ", "w"], ["ӏ", "l"], ["ё", "e"], ["ө", "o"],
  // Greek
  ["ο", "o"], ["ν", "v"], ["ρ", "p"], ["υ", "u"], ["ι", "i"], ["κ", "k"], ["χ", "x"], ["ς", "c"],
  // Latin
  ["ı", "i"],
];
const CONFUSABLES = new Map(CONFUSABLE_PAIRS);

/**
 * Folds a name for comparison, and only for that: NFKC (so NFC and NFD spell the same, and full-width letters are plain), invisible
 * marks and Hebrew points gone, smart quotes plain, whitespace collapsed, case folded. Exact after this; nothing fuzzy.
 */
export function normalizeTravellerName(raw: string): string {
  return raw
    .normalize("NFKC")
    .replace(COMPARE_INVISIBLE, "")
    .replace(HEBREW_POINTS, "")
    .replace(/[‘’‛ʼ׳]/g, "'")
    .replace(/[“”„״]/g, '"')
    .replace(CONTROL, " ")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
}

/** `normalizeTravellerName` plus the look-alike fold: two names with the same skeleton cannot be told apart by eye, so by no name. */
export function travellerSkeleton(raw: string): string {
  let out = "";
  for (const ch of normalizeTravellerName(raw)) out += CONFUSABLES.get(ch) ?? ch;
  return out;
}

/**
 * A name as it is printed, EVERYWHERE the relay prints one (lists, the summary line, the forwardable message): control characters,
 * invisible and bidi characters gone, one line, bounded to NAME_LIMIT characters. Never rendered with any markup.
 */
export function shown(name: string): string {
  const clean = name.replace(CONTROL, " ").replace(SITE_INVISIBLE, "").replace(BIDI_MARKS, "").replace(/\s+/g, " ").trim();
  const chars = Array.from(clean);
  return chars.length > NAME_LIMIT ? `${chars.slice(0, NAME_LIMIT - 1).join("")}…` : clean;
}

// A scheme, `www.`, a Telegram link, or a domain followed by a slash: what a client turns into a tappable link. A bare `name.tld` with
// no slash is NOT caught (names such as "Dr.Cohen" would be refused for nothing).
const LINK_LIKE = /(?:[a-z][a-z0-9+.-]*:\/\/|\bwww\.|\bt\.me\/|\btelegram\.(?:me|dog)\/|[\p{L}\p{N}-]+(?:\.[\p{L}\p{N}-]+)+\/)/iu;
export function looksLikeALink(name: string): boolean {
  return LINK_LIKE.test(name.normalize("NFKC")) || LINK_LIKE.test(name.normalize("NFKC").replace(COMPARE_INVISIBLE, ""));
}

interface Traveller { username: string; displayName: string; linkLike: boolean; skeleton: string; words: string[] }

type Match =
  | { kind: "none" }
  | { kind: "one"; person: Traveller }
  | { kind: "many"; people: Traveller[] }
  /** Several travellers whose names are the same (or confusable) after folding: a name cannot tell them apart. */
  | { kind: "same"; people: Traveller[] };

const containsRun = (haystack: string[], needle: string[]): boolean => {
  for (let at = 0; at + needle.length <= haystack.length; at += 1) {
    if (needle.every((word, i) => haystack[at + i] === word)) return true;
  }
  return false;
};

const hasTwinSkeleton = (people: readonly Traveller[]): boolean => new Set(people.map((p) => p.skeleton)).size < people.length;

/**
 * Which traveller was meant. EXACT, in two steps: the whole name, folded, equals one traveller's whole name; otherwise the typed words are
 * a run of WHOLE words of the name ("Dana" and "Levi" each fit "Dana Levi"; "Dan" does not fit "Dana"). A whole-name match wins over a
 * word match, so a traveller called "Dan" is not shadowed by "Dan Cohen". No prefixes, no edit distance, no guessing. Folding is the
 * SKELETON (look-alike letters included): when two candidates share one, the answer is `same`, never a silent pick.
 */
export function matchTraveller(argument: string, people: readonly Traveller[]): Match {
  const folded = travellerSkeleton(argument);
  if (!folded) return { kind: "none" };
  const whole = people.filter((p) => p.skeleton === folded);
  if (whole.length === 1) return { kind: "one", person: whole[0]! };
  if (whole.length > 1) return { kind: "same", people: whole };
  const words = folded.split(" ");
  const fits = people.filter((p) => containsRun(p.words, words));
  if (fits.length === 1) return { kind: "one", person: fits[0]! };
  if (fits.length > 1) return { kind: hasTwinSkeleton(fits) ? "same" : "many", people: fits };
  return { kind: "none" };
}

// ── Who is asking ─────────────────────────────────────────────────────────────

/**
 * The control-plane user behind this Telegram sender, when they are an organizer of THIS trip with dashboard access; null otherwise.
 * See the header for why this is not `isTripOrganizer`. Revoked links and ended memberships do not count, and neither does a trip
 * the sender organizes but this chat is not on.
 */
export async function inviteOrganizerFor(db: pg.Pool, tripId: string, telegramUserId: string): Promise<string | null> {
  if (!tripId || !isPrivateChatId(telegramUserId)) return null;
  const result = await db.query<{ user_id: string }>(
    `SELECT m.user_id
       FROM control_plane.telegram_organizer_trip_links l
       JOIN control_plane.trip_memberships m ON m.user_id = l.user_id AND m.trip_id = l.trip_id
      WHERE l.trip_id = $1 AND l.telegram_subject_digest = $2 AND l.revoked_at IS NULL
        AND m.status = 'active' AND m.role IN ('owner', 'organizer') AND m.dashboard_access
      ORDER BY (m.role = 'owner') DESC, m.user_id
      LIMIT 1`,
    [tripId, digestTelegramId(telegramUserId)],
  );
  return result.rows[0]?.user_id ?? null;
}

// ── Words ─────────────────────────────────────────────────────────────────────

type Words = Record<Language, string>;
const W = {
  inGroup: {
    en: "That works in our private chat — message me there.",
    he: "את זה אפשר לעשות בצ׳אט הפרטי שלנו — כתבו לי שם.",
  },
  unavailable: {
    en: "Personal invites from this chat are not available right now. Use Organizer settings → Signing in instead.",
    he: "הזמנות אישיות מהצ׳אט הזה לא זמינות כרגע. אפשר להשתמש ב״הגדרות מארגן״ ← ״כניסה לאתר״.",
  },
  notReady: {
    en: "I can't reach the trip site right now — please try again in a minute.",
    he: "אני לא מצליח להגיע לאתר הטיול כרגע — נסו שוב בעוד דקה.",
  },
  rateLimited: {
    en: "Too many personal invites in the last hour. Please try again later.",
    he: "יותר מדי הזמנות אישיות בשעה האחרונה. נסו שוב מאוחר יותר.",
  },
  failed: {
    en: "That didn't work, so no invite was made. Please try again, or use Organizer settings → Signing in.",
    he: "זה לא הצליח, ולא נוצרה הזמנה. נסו שוב, או השתמשו ב״הגדרות מארגן״ ← ״כניסה לאתר״.",
  },
  nameUnusable: {
    en: "That traveller's name can't be used here — use Organizer settings → Signing in.",
    he: "אי אפשר להשתמש כאן בשם של הנוסע הזה — השתמשו ב״הגדרות מארגן״ ← ״כניסה לאתר״.",
  },
  nameHidden: {
    en: "(a name that can't be shown here)",
    he: "(שם שאי אפשר להציג כאן)",
  },
} satisfies Record<string, Words>;

const list = (names: readonly string[], language: Language): string => {
  const shownNames = names.slice(0, LIST_LIMIT).map((n) => `• ${n}`);
  if (names.length > LIST_LIMIT) shownNames.push(language === "he" ? `• ועוד ${names.length - LIST_LIMIT}` : `• and ${names.length - LIST_LIMIT} more`);
  return shownNames.join("\n");
};

const namesBlock = (names: readonly string[], language: Language): string =>
  names.length === 0
    ? (language === "he" ? "אין עדיין נוסעים באתר הטיול שאפשר להזמין." : "There are no travellers on the trip site to invite yet.")
    : `${language === "he" ? "נוסעים שאפשר להזמין:" : "Travellers you can invite:"}\n${list(names, language)}`;

const usage = (names: readonly string[], language: Language): string =>
  `${language === "he" ? "להזמנה אישית לנוסע: /invite <שם>\nהשם כפי שהוא מופיע באתר הטיול." : "For a traveller's personal invite: /invite <name>\nThe name is how it appears on the trip site."}\n\n${namesBlock(names, language)}`;

const noTraveller = (names: readonly string[], language: Language): string =>
  `${language === "he" ? "אין נוסע בשם הזה בטיול." : "There is no traveller by that name on this trip."}\n\n${namesBlock(names, language)}`;

const whichOne = (names: readonly string[], language: Language): string =>
  `${language === "he" ? "למי התכוונת? יש יותר מנוסע אחד שמתאים:" : "Which one did you mean? More than one traveller fits:"}\n${list(names, language)}\n\n${language === "he" ? "שלחו /invite עם השם המלא." : "Send /invite again with the full name."}`;

const sameName = (names: readonly string[], language: Language): string =>
  `${language === "he" ? "יותר מנוסע אחד נקרא בדיוק כך, ושם לא יכול להבדיל ביניהם. אפשר להזמין אותם ב״הגדרות מארגן״ ← ״כניסה לאתר״:" : "More than one traveller has exactly that name, so a name cannot tell them apart. Invite them from Organizer settings → Signing in:"}\n${list(names, language)}`;

const claimed = (name: string, language: Language): string =>
  language === "he"
    ? `מישהו נכנס בתור ${name} מהקבוצה — קודם צריך לשחרר את הכניסה הזו ב״הגדרות מארגן״.`
    : `Someone signed in as ${name} from the group — release it in Organizer settings first.`;

const alreadySignedIn = (name: string, language: Language): string =>
  language === "he" ? `${name} כבר נכנס/ה עם הזמנה אישית.` : `${name} already signed in with a personal invite.`;

const created = (input: { trip: string; name: string; days: number; replaced: boolean; language: Language }): string => {
  const { trip, name, days, replaced, language } = input;
  if (language === "he") {
    return [
      `הזמנה אישית עבור ${name} לטיול ״${trip}״.`,
      `הקישור תקף ל־${days} ימים, ורק עבורם. את ההודעה הבאה אפשר להעביר אל ${name} כמו שהיא. אם ההודעה הבאה לא מגיעה, שלחו /invite שוב.`,
      ...(replaced ? [`הקישור הקודם של ${name} כבר לא עובד.`] : []),
    ].join("\n");
  }
  return [
    `Personal invite for ${name} on ${trip}.`,
    `The link works for ${days} days, and only for them. Forward the next message to ${name} as it is. If the next message doesn't arrive, send /invite again.`,
    ...(replaced ? [`The earlier link for ${name} no longer works.`] : []),
  ].join("\n");
};

/** Said when the link message could not be delivered and the invite was revoked. The earlier link, if one was replaced, stays dead. */
const deliveryFailed = (name: string, replaced: boolean, language: Language): string =>
  language === "he"
    ? `לא הצלחתי לשלוח לך את הקישור, אז לא נשארה הזמנה חדשה.${replaced ? ` הקישור הקודם של ${name} כבר לא עובד.` : ""} שלחו /invite שוב.`
    : `I couldn't send you the link, so no new invite was left open.${replaced ? ` The earlier link for ${name} no longer works.` : ""} Send /invite again.`;

// ── The command ───────────────────────────────────────────────────────────────

/** The one sentence a group gets, for everyone in it: no trip, no name, no organizer. */
export function inviteInGroupReply(chatId: string, language: Language): DirectReply {
  return { chatId, text: W.inGroup[language] };
}

/**
 * A message that is not a person typing a command to the bot right now: forwarded (Telegram says so, or a channel's automatic forward),
 * sent through another bot (`via_bot`), or relayed by a business bot on someone's behalf (`sender_business_bot`,
 * `business_connection_id`). Read from the raw fields (the relay's message type does not carry them): `forward_origin` (Bot API 7+) and
 * the older `forward_*` set. None of these is ever a command here; the update falls through to the unknown-command answer.
 */
export function isIndirectMessage(message: object): boolean {
  const m = message as Record<string, unknown>;
  return ["forward_origin", "forward_date", "forward_from", "forward_from_chat", "forward_sender_name", "forward_signature", "via_bot", "sender_business_bot", "business_connection_id"]
    .some((key) => m[key] !== undefined && m[key] !== null)
    || m.is_automatic_forward === true;
}

/** `/invite` where the relay has no way to make an invite: said to the verified organizer, and loud in the log. */
export function inviteUnconfiguredReply(chatId: string, language: Language, log: (line: string) => void): DirectReply {
  log(structuredLog("warn", "trip_bot.invite_command_unconfigured", { effect: "/invite answers 'not available' to organizers; no site invite deps on this relay" }));
  return { chatId, text: W.unavailable[language] };
}

/**
 * Revokes an invite that was just made but whose link could not be delivered, so nothing unreachable stays pending. Only an `unused`
 * invite is touched. It does NOT bring back the earlier link `createSiteInvite` revoked when it replaced a pending one.
 */
export async function revokeUnsentInvite(db: pg.Pool, inviteId: string): Promise<void> {
  await db.query("UPDATE control_plane.site_invites SET state = 'revoked', updated_at = now() WHERE id = $1 AND state = 'unused'", [inviteId]);
}

/** What `handleInvite` hands back: plain replies, or a created invite whose two messages the poller must DELIVER (and undo if it cannot). */
export type InviteOutcome =
  | { kind: "replies"; replies: DirectReply[] }
  | { kind: "created"; chatId: string; inviteId: string; summary: string; link: string; failed: string };

/**
 * Answers `/invite` for a VERIFIED organizer in their own private chat (the caller has proved all three: private chat, own id, organizer
 * with dashboard access of the chat's trip; `organizerUserId` is that account). Logs outcome codes only: never a name, a link, an id or
 * a trip.
 */
export async function handleInvite(
  db: pg.Pool,
  deps: SiteInviteDeps,
  input: { chatId: string; tripId: string; organizerUserId: string; argument: string | null; language: Language },
  log: (line: string) => void,
): Promise<InviteOutcome> {
  const { chatId, tripId, organizerUserId, argument, language } = input;
  const say = (text: string): InviteOutcome => ({ kind: "replies", replies: [{ chatId, text }] });
  const outcome = (name: string, reason?: string): void =>
    log(structuredLog("info", "trip_bot.invite_command", { outcome: name, ...(reason ? { reason } : {}) }));

  let people;
  try { people = await deps.runtimeAccounts.listParticipants(tripId); } catch {
    outcome("runtime_not_ready");
    return say(W.notReady[language]);
  }
  // Only a plain member is invitable: an organizer, an owner or anything the site does not call `member` is not a traveller to invite
  // (createSiteInvite refuses the same, and the answer for such a name is the same as for a name that does not exist).
  const travellers: Traveller[] = people
    .filter((p) => p.role === "member")
    .flatMap((p) => {
      const name = shown(p.displayName);
      const skeleton = travellerSkeleton(name);
      return name && skeleton ? [{ username: p.username, displayName: name, linkLike: looksLikeALink(p.displayName) || looksLikeALink(name), skeleton, words: skeleton.split(" ") }] : [];
    });
  // A name that looks like a link is matched like any other but never printed: Telegram would make it tappable in this chat.
  const label = (t: Traveller): string => (t.linkLike ? W.nameHidden[language] : t.displayName);
  const names = travellers.map(label);

  if (!argument || !argument.trim()) {
    outcome("usage");
    return say(usage(names, language));
  }
  const match = matchTraveller(argument, travellers);
  if (match.kind === "none") { outcome("no_match"); return say(noTraveller(names, language)); }
  if (match.kind === "many") { outcome("ambiguous"); return say(whichOne(match.people.map(label), language)); }
  if (match.kind === "same") { outcome("same_name"); return say(sameName(match.people.map(label), language)); }
  const person = match.person;
  if (person.linkLike) { outcome("name_unusable"); return say(W.nameUnusable[language]); }

  const recent = await db.query<{ n: number }>(
    "SELECT count(*)::int AS n FROM control_plane.site_invites WHERE trip_id = $1 AND created_by = $2 AND created_at > now() - interval '1 hour'",
    [tripId, organizerUserId],
  );
  if ((recent.rows[0]?.n ?? 0) >= INVITES_PER_HOUR) { outcome("rate_limited"); return say(W.rateLimited[language]); }

  // Only for the words of the answer: whether a live link is about to stop working. createSiteInvite does the replacing.
  const pending = await db.query(
    "SELECT 1 FROM control_plane.site_invites WHERE trip_id = $1 AND runtime_username = $2 AND state = 'unused' AND expires_at > now() LIMIT 1",
    [tripId, person.username],
  );

  const made = await createSiteInvite(
    { db, runtimeAccounts: deps.runtimeAccounts as RuntimeAccountAdapter, publicOrigin: deps.publicOrigin },
    { tripId, actorUserId: organizerUserId, runtimeUsername: person.username, replacePending: true },
  ).catch((error: unknown) => {
    log(structuredLog("error", "trip_bot.invite_command", { outcome: "error", safe_error_code: error instanceof Error ? error.name : "UNKNOWN" }));
    return null;
  });
  if (!made) return say(W.failed[language]);
  if (!made.ok) {
    outcome("refused", made.error);
    if (made.error === "TRAVELLER_CLAIMED_FROM_GROUP") return say(claimed(person.displayName, language));
    if (made.error === "INVITE_ALREADY_EXISTS") return say(alreadySignedIn(person.displayName, language));
    if (made.error === "RUNTIME_NOT_READY") return say(W.notReady[language]);
    return say(W.failed[language]);
  }

  // The name the invite carries is the site's, cleaned only of control characters by createSiteInvite: the same filter as above runs on
  // it, and a name that is empty or link-like after it is never forwarded. The invite just made is revoked: nothing is left pending.
  const printable = shown(made.displayName);
  if (!printable || looksLikeALink(made.displayName) || looksLikeALink(printable)) {
    await revokeUnsentInvite(db, made.id);
    outcome("name_unusable");
    return say(W.nameUnusable[language]);
  }
  const replaced = (pending.rowCount ?? 0) > 0;
  outcome(replaced ? "replaced" : "created");
  const trip = await db.query<{ title: string | null; slug: string }>("SELECT title, slug FROM control_plane.trips WHERE id = $1", [tripId]);
  const days = Math.max(1, Math.round((Date.parse(made.expiresAt) - Date.now()) / 86_400_000));
  return {
    kind: "created",
    chatId,
    inviteId: made.id,
    summary: created({ trip: trip.rows[0] ? tripDisplayName(trip.rows[0]) : "", name: printable, days, replaced, language }),
    link: siteInviteForwardMessage(printable, made.joinUrl, made.expiresAt),
    failed: deliveryFailed(printable, replaced, language),
  };
}
