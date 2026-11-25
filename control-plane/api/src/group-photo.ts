import type pg from "pg";
import { structuredLog } from "./redaction.js";
import type { ChatMemberInfo } from "./adapters/telegram.js";

/**
 * The trip group's photo (docs/specs/sprint-9/x-trip-group-photo.md), the parts the poller and the dispatcher share:
 * the decision the bot's rights make, the folding of one outcome per group into the ONE answer a request has, and the
 * report back to the trip's site through the runtime gateway.
 *
 * THE ROAD. The site holds the request and the logo. group-photo-poller.ts claims it through the gateway and enqueues ONE
 * targeted outbox row per bound group (`target = trip_group`, the chat never named by anyone). The dispatcher
 * (outbox-dispatcher.ts) re-resolves the chat from the binding at send time, asks Telegram what the bot is in it, and only
 * then calls setChatPhoto. Each row ends with an OUTCOME written onto the row itself, and the request's answer is
 * reported to the site once every row has one. The row is therefore the record: a report that was lost is made again from
 * it, and a request that is claimed again is never sent a second time.
 */

export const GROUP_PHOTO_SWITCH = "trip_group_photo";
export const GROUP_PHOTO_TYPE = "trip_group_photo";

/** What the site can be told. `expired` is the site's own word, never reported to it. */
export type GroupPhotoStatus = "done" | "bot_lacks_rights" | "no_group" | "no_logo" | "failed";

export interface GroupPhotoOutcome {
  status: GroupPhotoStatus;
  /** A person-readable reason, at most 300 characters, never a chat id or a token. */
  detail: string | null;
}

export interface GroupPhotoReport extends GroupPhotoOutcome {
  request_id: number;
}

export type GroupPhotoReporter = (tripId: string, report: GroupPhotoReport) => Promise<void>;

const MAX_DETAIL = 300;
const REPORT_TIMEOUT_MS = 5_000;

export function clip(text: string, max = MAX_DETAIL): string {
  const clean = text.replace(/[\u0000-\u001f\u007f]/g, " ").replace(/\s+/g, " ").trim();
  return clean.length <= max ? clean : `${clean.slice(0, max - 1)}…`;
}

/**
 * May the bot change the group's photo? Only for the group's creator, or an administrator whose `can_change_info` is the
 * literal `true`. Everything else (a plain member, a restricted member, left, kicked, a question Telegram would not answer,
 * a field that is absent or not a boolean) is no, and nothing is sent. This is the line AC-2 draws.
 */
export function mayChangeGroupPhoto(member: ChatMemberInfo): boolean {
  if (member.status === "creator") return true;
  return member.status === "administrator" && member.can_change_info === true;
}

/** The reason the bot may not, in words an organizer can act on (the site adds the instruction). */
export function whyNotAllowed(member: ChatMemberInfo): string {
  switch (member.status) {
    case "administrator": return "The bot is an administrator of the group without the \"Change group info\" right.";
    case "member": case "restricted": return "The bot is in the group but is not an administrator.";
    case "left": case "kicked": return "The bot is no longer in the group.";
    default: return clip(`The bot cannot see its own rights in the group${member.description ? ` (${member.description})` : ""}.`);
  }
}

/** Telegram's words for a failed call, or a fixed phrase: never the error's message (it can carry a URL). */
export function describeTelegramFailure(error: unknown): string {
  const description = typeof (error as { description?: unknown } | null)?.description === "string" ? (error as { description: string }).description : null;
  return clip(description ? `Telegram said: ${description}` : "Telegram did not accept the request.");
}

/**
 * Posts the answer to the gateway, which hands it to the trip's site with that trip's key. 404 and 409 mean the site has
 * already settled this request (finished, or no longer there): nothing more to do, not an error. Anything else throws a
 * code, never an address or a key, and the caller records that the report is still owed.
 */
export function createGroupPhotoReporter(options: {
  exchangeKey: string;
  runtimeOrigin: string;
  fetchImpl?: typeof fetch;
}): GroupPhotoReporter {
  const doFetch = options.fetchImpl ?? fetch;
  const origin = options.runtimeOrigin.replace(/\/$/, "");
  return async (tripId, report) => {
    let response: Response;
    try {
      response = await doFetch(`${origin}/internal/t/${encodeURIComponent(tripId)}/group-photo/result`, {
        method: "POST",
        headers: { "x-api-key": options.exchangeKey, "content-type": "application/json", accept: "application/json" },
        body: JSON.stringify({ request_id: report.request_id, status: report.status, detail: report.detail }),
        // The control-plane key rides this request: it is never forwarded to wherever a redirect points.
        redirect: "manual",
        signal: AbortSignal.timeout(REPORT_TIMEOUT_MS),
      });
    } catch {
      throw new Error("GROUP_PHOTO_REPORT_UNREACHABLE");
    }
    await response.body?.cancel().catch(() => {});
    if (response.ok || response.status === 404 || response.status === 409) return;
    throw new Error(`GROUP_PHOTO_REPORT_HTTP_${response.status}`);
  };
}

interface OutcomeRow {
  state: string;
  result: unknown;
}

function readOutcome(value: unknown): GroupPhotoOutcome | null {
  if (!value || typeof value !== "object") return null;
  const { status, detail } = value as { status?: unknown; detail?: unknown };
  if (status !== "done" && status !== "bot_lacks_rights" && status !== "no_group" && status !== "no_logo" && status !== "failed") return null;
  return { status, detail: typeof detail === "string" ? detail : null };
}

/**
 * ONE answer from the outcomes of every row of a request (one row per bound group). `null` while any row has none yet.
 * All done is done. Anything else is the most actionable failure (a failure to send, then missing rights, then no group),
 * saying how many groups did get the photo, because "done" for a trip whose second group refused would be a lie.
 */
export function foldOutcomes(outcomes: readonly (GroupPhotoOutcome | null)[]): GroupPhotoOutcome | null {
  if (outcomes.length === 0 || outcomes.some((o) => o === null)) return null;
  const all = outcomes as GroupPhotoOutcome[];
  const done = all.filter((o) => o.status === "done").length;
  if (done === all.length) return { status: "done", detail: null };
  for (const status of ["failed", "bot_lacks_rights", "no_group", "no_logo"] as const) {
    const worst = all.find((o) => o.status === status);
    if (worst) {
      const prefix = all.length > 1 ? `The photo was set in ${done} of ${all.length} groups. ` : "";
      return { status, detail: worst.detail || prefix ? clip(`${prefix}${worst.detail ?? ""}`) : null };
    }
  }
  return { status: "failed", detail: null };
}

/**
 * Reports a request's answer, once every one of its rows has an outcome. Returns `waiting` while a row has none (the
 * dispatcher will call this again when it finishes it), `reported` when the site has the answer, and `unreported` when the
 * report failed (logged by code; the site puts the request back after ten minutes, the poller claims it again, finds the
 * rows already decided, and calls this again: nothing is sent twice).
 */
export async function settleGroupPhoto(
  db: Pick<pg.Pool, "query">,
  report: GroupPhotoReporter,
  tripId: string,
  requestKey: string,
  requestId: number,
  log: (line: string) => void = () => {},
): Promise<"waiting" | "reported" | "unreported"> {
  const rows = await db.query<OutcomeRow>(
    `SELECT state, payload->'result' AS result FROM control_plane.notification_outbox
     WHERE trip_id = $1 AND notification_type = $2 AND payload->>'request_key' = $3`,
    [tripId, GROUP_PHOTO_TYPE, requestKey],
  );
  const folded = foldOutcomes(rows.rows.map((row) => readOutcome(row.result)));
  if (!folded) return "waiting";
  try {
    await report(tripId, { request_id: requestId, status: folded.status, detail: folded.detail });
    log(structuredLog("info", "group_photo.reported", { trip_id: tripId, request_id: requestId, status: folded.status }));
    return "reported";
  } catch (error) {
    log(structuredLog("warn", "group_photo.report_failed", {
      trip_id: tripId,
      request_id: requestId,
      safe_error_code: error instanceof Error ? error.message : "UNKNOWN",
    }));
    return "unreported";
  }
}
