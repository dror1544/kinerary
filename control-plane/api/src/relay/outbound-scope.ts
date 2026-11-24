/**
 * Which chats a gateway may act in.
 *
 * Outbound actions (`send`, `edit`, `typing`, `get_chat_info`) are scoped to
 * the caller's own chats, by the same identity rule inbound routing follows:
 * a gateway's authenticated id (the upgrade token, never a frame field) IS the
 * Hermes profile it serves, and a chat belongs to the profile its open binding
 * names. Spec: docs/specs/sprint-9/x-relay-chat-scope.md.
 *
 * `outboundChatAllowed` is the whole table and does no I/O. The connector
 * resolves the chat's route once per action (`resolveChatRoute`, no cache, so a
 * closed or switched binding takes effect on the next action) and asks it.
 * Everything unrecognised, missing or failed resolves to refusal.
 */
import type pg from "pg";
import { resolveChatRoute, type ChatRoute } from "../chat-router.js";
import { featureEnabled } from "../feature-switches.js";
import { whatsappAddressOf } from "./whatsapp/bindings.js";

/** The refusal words. Neither is a timeout or retryable to the gateway's classifier (hermes-mirror.test.ts). */
export const CHAT_NOT_IN_SCOPE = "CHAT_NOT_IN_SCOPE";
export const SCOPE_CHECK_FAILED = "SCOPE_CHECK_FAILED";

export type OutboundRouteKind = "companion" | "companion_no_profile" | "interview" | "unbound";

/**
 * What the scope check is handed: a chat router route, or the one extra case the
 * router cannot name - the interviewer's own private chat after its interview was
 * confirmed and before the trip's companion is bound there (the chat resolves
 * `unbound` in that window). See `resolveOutboundRoute`.
 */
export type ScopeRoute =
  | ChatRoute
  | { kind: "interview_handover" }
  /**
   * A WhatsApp chat whose trip has the `whatsapp` switch off, or whose switch could not
   * be read (spec 625, AC-22: refused as CHAT_NOT_IN_SCOPE). Never produced for a
   * Telegram route: the switch is read only when the binding row says WhatsApp.
   */
  | { kind: "platform_switched_off" };

export type OutboundScope =
  | { allowed: true }
  | { allowed: false; routeKind: OutboundRouteKind; reason: string };

export interface OutboundRoles {
  /** `relay.interviewer_profile`: the id the interviewer's gateway may authenticate under. */
  interviewerProfile?: string;
  /** `relay.multiplex_gateway_id` (the connector's `fallbackGatewayId`): the declared multiplex exception. */
  multiplexGatewayId?: string;
}

/**
 * Whether `gatewayId` may act in a chat whose route is `route`.
 *
 * | route                              | allowed for                                   |
 * | companion, profile P               | P, or the declared multiplex gateway          |
 * | companion, no profile              | nobody                                        |
 * | interview                          | the interviewer profile, or the multiplex id  |
 * | interview handover (see ScopeRoute)| the interviewer profile, or the multiplex id  |
 * | unbound                            | nobody                                        |
 *
 * The refusal `reason` is a fixed word: it never names the route's own profile.
 */
export function outboundChatAllowed(
  route: ScopeRoute,
  gatewayId: string,
  roles: OutboundRoles,
): OutboundScope {
  const multiplex = roles.multiplexGatewayId;
  const isMultiplex = Boolean(multiplex) && gatewayId === multiplex;
  const isInterviewer = Boolean(roles.interviewerProfile) && gatewayId === roles.interviewerProfile;
  switch (route.kind) {
    case "companion": {
      if (!route.hermesProfile) {
        return { allowed: false, routeKind: "companion_no_profile", reason: "companion_not_installed" };
      }
      if (gatewayId === route.hermesProfile || isMultiplex) return { allowed: true };
      return { allowed: false, routeKind: "companion", reason: "chat_belongs_to_another_gateway" };
    }
    case "interview": {
      if (isInterviewer || isMultiplex) return { allowed: true };
      return { allowed: false, routeKind: "interview", reason: "interview_chat" };
    }
    case "interview_handover": {
      // The same identity as the interview row, in one place: whatever names the
      // interviewer's gateway there names it here.
      if (isInterviewer || isMultiplex) return { allowed: true };
      return { allowed: false, routeKind: "unbound", reason: "interview_handover_chat" };
    }
    case "unbound":
      return { allowed: false, routeKind: "unbound", reason: "chat_not_bound" };
    case "platform_switched_off":
      return { allowed: false, routeKind: "companion", reason: "platform_switched_off" };
    default:
      // A route kind this function was not written for is refused, not allowed.
      return { allowed: false, routeKind: "unbound", reason: "unrecognised_route" };
  }
}

/** How long after confirmation the interviewer keeps its own private chat while the companion is not yet bound there. */
export const INTERVIEW_HANDOVER_HOURS = 24;

/**
 * `resolveChatRoute`, plus the one case it cannot name. A chat that resolves
 * `unbound` is the interviewer's own when it is a PRIVATE chat (a Telegram
 * private chat id is all digits; a group's starts with "-") whose interview
 * session was confirmed within the last `INTERVIEW_HANDOVER_HOURS` hours and has
 * not been expired: the provisioner has not bound the organizer's DM to the trip
 * yet. Once a binding opens the chat resolves `companion` and the table applies
 * as usual. `updated_at` is the confirmation time (the confirm statement sets it,
 * and a confirmed session accepts no further writes).
 */
export async function resolveOutboundRoute(
  db: pg.Pool,
  chatId: string,
  log?: (line: string) => void,
): Promise<ScopeRoute> {
  const route = await resolveChatRoute(db, chatId);
  // A WhatsApp chat acts only while its trip's `whatsapp` switch is on (AC-22). Read
  // ONLY for a WhatsApp row: a Telegram route never touches the switch, so an
  // unreadable switch can never refuse a Telegram send. Unreadable is off.
  if (route.kind === "companion" && route.platform === "whatsapp") {
    return (await featureEnabled(db, route.tripId, "whatsapp", log)) ? route : { kind: "platform_switched_off" };
  }
  if (route.kind !== "unbound" || !/^[0-9]+$/.test(chatId)) return route;
  const recent = await db.query(
    `SELECT 1
       FROM control_plane.intake_sessions
      WHERE telegram_chat_id = $1
        AND state = 'confirmed'
        AND expired_at IS NULL
        AND updated_at > now() - make_interval(hours => $2::int)
      LIMIT 1`,
    [chatId, INTERVIEW_HANDOVER_HOURS],
  );
  return recent.rowCount ? { kind: "interview_handover" } : route;
}

/**
 * The connector options the relay server wires when it has a database: the one
 * route lookup the scope check uses. Without a database nothing is returned,
 * the connector has no resolver, and every outbound action is refused.
 * Kept here, not inline in server.ts, so a test can drive the real wiring.
 */
export function outboundScopeOptions(
  db: pg.Pool | undefined,
  interviewerProfile: string | undefined,
  log?: (line: string) => void,
): {
  resolveRoute?: (chatId: string) => Promise<ScopeRoute>;
  interviewerProfile?: string;
  profileHasOpenBinding?: (profile: string) => Promise<boolean>;
  whatsappAddressOf?: (alias: string, tripId: string) => Promise<string | null>;
} {
  if (!db) return {};
  return {
    profileHasOpenBinding: async (profile: string) => {
      const found = await db.query(
        "SELECT 1 FROM control_plane.telegram_chat_bindings WHERE hermes_profile = $1 AND closed_at IS NULL LIMIT 1",
        [profile],
      );
      return Boolean(found.rowCount);
    },
    resolveRoute: (chatId: string) => resolveOutboundRoute(db, chatId, log),
    // The real address of a WhatsApp chat, read off its OPEN binding for each action and
    // asked only for a WhatsApp route (the connector's transport choice). Never logged.
    whatsappAddressOf: (alias: string, tripId: string) => whatsappAddressOf(db, alias, tripId),
    ...(interviewerProfile ? { interviewerProfile } : {}),
  };
}
