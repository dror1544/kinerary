/**
 * Is this Telegram person live in this group? One question, asked of Telegram itself.
 *
 * Group sign-in (telegram-mini-app.ts, docs/specs/sprint-9/x-member-sign-in.md) lets a person open a trip because they
 * are in the trip's Telegram group. Nothing the person sends can say so: initData names WHO they are, and the group is
 * theirs to pick only in the sense of `start_param`, which only SELECTS. The answer comes from `getChatMember`, asked
 * with a bot that is in that group, about the chat the trip's own open binding names.
 *
 * It mirrors `isActiveMemberReply` (server/server.js), the rule the trip site already uses for its own Telegram
 * sign-in: `creator`, `administrator` and `member` are in; `left` and `kicked` are out; `restricted` is in only while
 * `is_member` says so. Two deliberate differences, both toward the fail-safe direction (an answer that is not clearly
 * yes is never yes):
 *
 *   - `restricted` with NO `is_member` is "unknown", not in: Telegram always sends it, so its absence is a malformed
 *     answer, and the site's `!== false` would read the malformed answer as membership.
 *   - Everything that is not a clear answer — an error reply (Telegram says the same "chat not found" for a bot that was
 *     removed as for a chat that never existed), a status this code has not heard of, a timeout, a dead network, an
 *     unreadable body — is "unknown". It NEVER throws: a Telegram outage must cost a sign-in, not an exception.
 *
 * Callers treat "unknown" as the restrictive answer for a person who has no link yet (nobody is let in on a doubt) and
 * as "do not mint a session, do not revoke anything" for a person who has one (a Telegram outage must neither sign
 * someone in nor throw them out).
 *
 * WHICH BOT. The one that is in the group, which is the relay's bot (the companion lives in the group through it).
 * `server.ts` hands this module that token, never the Mini App's, because a Mini App bot that is a different bot would
 * not be a member of the group and Telegram would answer "chat not found" for every trip. The base URL is the same
 * `TELEGRAM_API_ROOT` the relay uses, so tools/fake-telegram.ts can stand in for Telegram.
 *
 * NOTHING HERE LOGS A CHAT ID, A TELEGRAM ID, OR A URL (the URL carries the bot token): a failure is logged by kind
 * alone. The same rule as the header of telegram-mini-app.ts.
 */
import { structuredLog } from "./redaction.js";
import { TELEGRAM_API_ROOT } from "./relay/telegram-api.js";

export type GroupMembership = true | false | "unknown";

export interface GroupMembershipConfig {
  /** The token of a bot that is a member of the trip groups. Sent to `apiRoot` in the request path. */
  botToken: string;
  /** Defaults to Telegram's own root. Already validated by `telegramApiRoot` when it comes from the environment. */
  apiRoot?: string;
  /** How long one answer may take. Default 4 seconds: a launch is a person waiting on a phone. */
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
  log?: (line: string) => void;
}

/** What callers hold: the question, with the bot and the wait already decided. */
export type GroupMembershipCheck = (chatId: string, telegramUserId: string, options?: { timeoutMs?: number }) => Promise<GroupMembership>;

const IN_STATUSES = new Set(["creator", "administrator", "member"]);
const OUT_STATUSES = new Set(["left", "kicked"]);
const CHAT_ID_SHAPE = /^-[0-9]{1,20}$/;
const USER_ID_SHAPE = /^[0-9]{1,20}$/;

export async function activeGroupMember(chatId: string, telegramUserId: string, config: GroupMembershipConfig): Promise<GroupMembership> {
  const log = config.log ?? (() => {});
  const failed = (kind: string): "unknown" => {
    // The kind only. Not the error's message (a fetch failure can quote the URL, and the URL carries the token), not the ids.
    try { log(structuredLog("warn", "group_membership.check_failed", { kind })); } catch { /* a log line is never the reason a check throws */ }
    return "unknown";
  };
  try {
    // A group's id is negative; a private chat's is the person's own id, and asking about one is not asking about a group.
    if (!CHAT_ID_SHAPE.test(chatId) || !USER_ID_SHAPE.test(telegramUserId) || !config.botToken) return false;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), config.timeoutMs ?? 4000);
    try {
      const url = `${config.apiRoot ?? TELEGRAM_API_ROOT}/bot${config.botToken}/getChatMember?chat_id=${encodeURIComponent(chatId)}&user_id=${encodeURIComponent(telegramUserId)}`;
      const response = await (config.fetchImpl ?? fetch)(url, { signal: controller.signal });
      const reply = (await response.json()) as { ok?: unknown; result?: { status?: unknown; is_member?: unknown } } | null;
      if (reply?.ok !== true) return failed(response.ok ? "telegram_refused" : `http_${Math.floor(response.status / 100)}xx`);
      const status = reply.result?.status;
      if (typeof status !== "string") return failed("no_status");
      if (IN_STATUSES.has(status)) return true;
      if (OUT_STATUSES.has(status)) return false;
      if (status === "restricted") {
        if (reply.result?.is_member === true) return true;
        if (reply.result?.is_member === false) return false;
        return failed("restricted_without_is_member");
      }
      return failed("unknown_status");
    } finally {
      clearTimeout(timer);
    }
  } catch (error) {
    return failed(error instanceof Error && error.name === "AbortError" ? "timeout" : "unreachable");
  }
}

/** `activeGroupMember` with the bot, root and timeout fixed once, at boot. */
export function groupMembershipChecker(config: GroupMembershipConfig): GroupMembershipCheck {
  // A caller may only SHORTEN the wait (the gateway's liveness path does), never lengthen what the deployment set.
  return (chatId, telegramUserId, options) =>
    activeGroupMember(chatId, telegramUserId, options?.timeoutMs === undefined ? config : { ...config, timeoutMs: Math.min(options.timeoutMs, config.timeoutMs ?? 4000) });
}
