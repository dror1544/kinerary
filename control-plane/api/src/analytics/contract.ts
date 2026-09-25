/**
 * The assistant-event contract, in TypeScript — issue #177, Track 2's first
 * slice of the outcome-event pipeline.
 *
 * The language-neutral source is `analytics/schemas/tripbot-event.v1.json`;
 * this file mirrors it so the relay can validate without reading a file that
 * a deployed container may not carry. `test/assistant-events-contract.test.ts`
 * fails if the two disagree — the property list, every enum, the per-type
 * rules — so a field added to one and not the other cannot ship.
 *
 * **An allow-list, never a deny-list.** Every field that may be stored is named
 * below and anything else is refused. `sanitizeConfig()` is the cautionary tale
 * (#156): a deny-list passes whatever it was never told to remove. Nothing here
 * can carry text, a chat id, a Telegram user id, a name, a filename, a URL, a
 * digest of any of those, or a tool argument/result — there is no field for
 * them, and `metadata` accepts only bounded numbers and one boolean.
 *
 * **The relay never claims `answered`.** It sees whether a reply reached
 * Telegram; it cannot see whether the tool behind that reply worked. Design doc
 * §6.3 (commit 9554da8): `failed_tool` beats `answered`, so an emitter blind to
 * tools must not write `answered` at all. The outcome vocabulary below simply
 * has no such value — a forwarded turn with a delivered reply is "reply
 * delivered, substantive outcome unknown", and the rollup says exactly that.
 */

export const EVENT_TYPES = [
  "ignored_not_addressed",
  "request_forwarded",
  "request_to_relay",
  "turn_lost",
  "reply_sent",
  "relay_tool_completed",
] as const;
export type EventType = (typeof EVENT_TYPES)[number];

export const SOURCE_SERVICES = ["relay"] as const;
export type SourceService = (typeof SOURCE_SERVICES)[number];

export const CHANNEL_TYPES = ["group", "organizer_dm", "other", "unclassified"] as const;
export type ChannelType = (typeof CHANNEL_TYPES)[number];

export const TRIGGER_TYPES = [
  "dm",
  "mention",
  "name",
  "reply_to_bot",
  "reply_window",
  "not_addressed",
  "unclassified",
] as const;
export type TriggerType = (typeof TRIGGER_TYPES)[number];

export const REQUESTER_ROLES = ["organizer", "participant", "unknown", "unclassified"] as const;
export type RequesterRole = (typeof REQUESTER_ROLES)[number];

export const OUTCOMES = [
  "ignored_not_addressed",
  "dispatched",
  "lost_gateway_unavailable",
  "lost_companion_unreachable",
  "reply_delivered",
  "failed_delivery",
  "reply_suppressed",
  "failed_tool",
  "blocked_by_policy",
  "correction_proposed",
  "no_new_information",
] as const;
export type Outcome = (typeof OUTCOMES)[number];

export const LENGTH_BUCKETS = ["none", "1_40", "41_160", "161_640", "641_plus"] as const;
export type LengthBucket = (typeof LENGTH_BUCKETS)[number];

export const MEDIA_KINDS = ["none", "photo", "document", "audio", "other", "unclassified"] as const;
export type MediaKindClass = (typeof MEDIA_KINDS)[number];

/**
 * Every field an event may carry — and every column the table has. The
 * migration, the JSON Schema and this list are held equal by tests; adding a
 * column without adding it here (and there) fails one of them.
 */
export const EVENT_FIELDS = [
  "event_id",
  "trip_id",
  "occurred_at",
  "source_service",
  "event_type",
  "turn_id",
  "channel_type",
  "trigger_type",
  "requester_role",
  "outcome",
  "response_latency_ms",
  "message_length_bucket",
  "media_kind",
  "metadata",
] as const;
export type EventField = (typeof EVENT_FIELDS)[number];

export const REQUIRED_FIELDS = ["event_id", "occurred_at", "source_service", "event_type", "outcome"] as const;

/** The only keys `metadata` may hold, with their bounds. Numbers and a boolean — nothing textual. */
export const METADATA_FIELDS = {
  attachments_joined: { type: "integer", min: 0, max: 20 },
  documents: { type: "integer", min: 0, max: 20 },
  document_held: { type: "boolean" },
} as const;
export type MetadataField = keyof typeof METADATA_FIELDS;

export interface EventMetadata {
  attachments_joined?: number;
  documents?: number;
  document_held?: boolean;
}

export const MAX_LATENCY_MS = 86_400_000;

/** The facts an inbound message contributes: required non-null for these types. */
const INBOUND_DIMENSIONS = [
  "trip_id",
  "channel_type",
  "trigger_type",
  "requester_role",
  "message_length_bucket",
  "media_kind",
] as const;

/**
 * Per event type: which outcomes it may carry and which fields must be present
 * and non-null. Mirrors the JSON Schema's `allOf` if/then blocks.
 */
export const EVENT_RULES: Record<EventType, { outcomes: readonly Outcome[]; required: readonly EventField[] }> = {
  ignored_not_addressed: { outcomes: ["ignored_not_addressed"], required: INBOUND_DIMENSIONS },
  request_forwarded: { outcomes: ["dispatched"], required: [...INBOUND_DIMENSIONS, "turn_id"] },
  request_to_relay: { outcomes: ["dispatched"], required: [...INBOUND_DIMENSIONS, "turn_id"] },
  turn_lost: {
    outcomes: ["lost_gateway_unavailable", "lost_companion_unreachable"],
    required: INBOUND_DIMENSIONS,
  },
  reply_sent: {
    outcomes: ["reply_delivered", "failed_delivery", "reply_suppressed"],
    required: ["trip_id", "message_length_bucket"],
  },
  relay_tool_completed: {
    outcomes: ["failed_tool", "blocked_by_policy", "correction_proposed", "no_new_information"],
    required: ["trip_id", "turn_id"],
  },
};

export interface AssistantEvent {
  event_id: string;
  trip_id: string | null;
  occurred_at: string;
  source_service: SourceService;
  event_type: EventType;
  turn_id: string | null;
  channel_type: ChannelType | null;
  trigger_type: TriggerType | null;
  requester_role: RequesterRole | null;
  outcome: Outcome;
  response_latency_ms: number | null;
  message_length_bucket: LengthBucket | null;
  media_kind: MediaKindClass | null;
  metadata: EventMetadata;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const TRIP_ID = /^trip_[A-Za-z0-9]{8,64}$/;
/**
 * `occurred_at`: RFC 3339 in its strict form — `T`, `Z` or `±hh:mm`, at most six
 * fractional digits (what Postgres keeps). The SAME pattern is the JSON
 * Schema's `occurred_at.pattern`, and the schema's `format: date-time` adds the
 * calendar check `validCalendar` does here; the contract test holds the two
 * equal. The schema is the authoritative side: it was tightened to this
 * pattern rather than this validator loosened to ajv's `date-time`, which
 * also accepts a space separator, `+0900` and `+09` — shapes nothing here
 * emits and that a later non-JS emitter should not be invited to.
 */
export const OCCURRED_AT_PATTERN =
  "^\\d{4}-(0[1-9]|1[0-2])-(0[1-9]|[12]\\d|3[01])T([01]\\d|2[0-3]):[0-5]\\d:[0-5]\\d(\\.\\d{1,6})?(Z|[+-]([01]\\d|2[0-3]):[0-5]\\d)$";
const DATE_TIME = new RegExp(OCCURRED_AT_PATTERN);

/** The day exists in its month (2026-02-30 does not). The pattern has already bounded every other field. */
function validCalendar(value: string): boolean {
  const year = Number(value.slice(0, 4));
  const month = Number(value.slice(5, 7));
  const day = Number(value.slice(8, 10));
  const daysInMonth = new Date(Date.UTC(year, month, 0)).getUTCDate();
  return day >= 1 && day <= daysInMonth;
}

export type ValidationResult =
  | { ok: true; event: AssistantEvent }
  | { ok: false; reason: string };

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    && Object.getPrototypeOf(value) === Object.prototype;
}

function inSet<T extends string>(set: readonly T[], value: unknown): value is T {
  return typeof value === "string" && (set as readonly string[]).includes(value);
}

/**
 * Validates one event against the contract.
 *
 * Refuses rather than repairs: an unknown field, an unknown event type, a value
 * outside its set, a missing required dimension. The reason is a fixed code
 * plus, at most, the name of a field from THIS contract — never the offending
 * value, so a refusal cannot echo whatever a bad caller put in.
 *
 * Whether `trip_id` names a real trip is a database question; the writer
 * answers it (`writeAssistantEvents`).
 *
 * The input is SNAPSHOTTED once, and only the snapshot is checked and
 * returned. An accessor property is read exactly once, so a getter cannot pass
 * the check with one value and hand the writer another.
 */
export function validateAssistantEvent(raw: unknown): ValidationResult {
  if (!isPlainObject(raw)) return { ok: false, reason: "NOT_AN_OBJECT" };
  let input: Record<string, unknown>;
  try {
    input = { ...raw };
  } catch {
    return { ok: false, reason: "INVALID" };
  }
  for (const key of Object.keys(input)) {
    if (!(EVENT_FIELDS as readonly string[]).includes(key)) return { ok: false, reason: "UNKNOWN_FIELD" };
  }
  for (const key of REQUIRED_FIELDS) {
    if (input[key] === undefined || input[key] === null) return { ok: false, reason: `MISSING:${key}` };
  }

  if (typeof input.event_id !== "string" || !UUID.test(input.event_id)) return { ok: false, reason: "BAD:event_id" };
  if (typeof input.occurred_at !== "string" || !DATE_TIME.test(input.occurred_at) || !validCalendar(input.occurred_at)) {
    return { ok: false, reason: "BAD:occurred_at" };
  }
  if (!inSet(SOURCE_SERVICES, input.source_service)) return { ok: false, reason: "BAD:source_service" };
  if (!inSet(EVENT_TYPES, input.event_type)) return { ok: false, reason: "BAD:event_type" };
  if (!inSet(OUTCOMES, input.outcome)) return { ok: false, reason: "BAD:outcome" };

  const nullableString = (field: EventField, check: (v: string) => boolean): string | null => {
    const value = input[field];
    if (value === undefined || value === null) return null;
    if (typeof value !== "string" || !check(value)) throw new ContractError(`BAD:${field}`);
    return value;
  };

  try {
    const event: AssistantEvent = {
      event_id: input.event_id,
      trip_id: nullableString("trip_id", (v) => TRIP_ID.test(v)),
      occurred_at: input.occurred_at,
      source_service: input.source_service,
      event_type: input.event_type,
      turn_id: nullableString("turn_id", (v) => UUID.test(v)),
      channel_type: nullableString("channel_type", (v) => inSet(CHANNEL_TYPES, v)) as ChannelType | null,
      trigger_type: nullableString("trigger_type", (v) => inSet(TRIGGER_TYPES, v)) as TriggerType | null,
      requester_role: nullableString("requester_role", (v) => inSet(REQUESTER_ROLES, v)) as RequesterRole | null,
      outcome: input.outcome,
      response_latency_ms: validLatency(input.response_latency_ms),
      message_length_bucket: nullableString("message_length_bucket", (v) => inSet(LENGTH_BUCKETS, v)) as LengthBucket | null,
      media_kind: nullableString("media_kind", (v) => inSet(MEDIA_KINDS, v)) as MediaKindClass | null,
      metadata: validMetadata(input.metadata),
    };

    const rules = EVENT_RULES[event.event_type];
    if (!rules.outcomes.includes(event.outcome)) return { ok: false, reason: "OUTCOME_NOT_ALLOWED_FOR_TYPE" };
    for (const field of rules.required) {
      if (event[field] === null || event[field] === undefined) return { ok: false, reason: `MISSING:${field}` };
    }
    return { ok: true, event };
  } catch (error) {
    if (error instanceof ContractError) return { ok: false, reason: error.message };
    return { ok: false, reason: "INVALID" };
  }
}

class ContractError extends Error {}

function validLatency(value: unknown): number | null {
  if (value === undefined || value === null) return null;
  if (typeof value !== "number" || !Number.isInteger(value) || value < 0 || value > MAX_LATENCY_MS) {
    throw new ContractError("BAD:response_latency_ms");
  }
  return value;
}

function validMetadata(value: unknown): EventMetadata {
  // Absent is `{}`; present must be an object — `null` included, as the schema says.
  if (value === undefined) return {};
  if (!isPlainObject(value)) throw new ContractError("BAD:metadata");
  const out: EventMetadata = {};
  for (const [key, raw] of Object.entries(value)) {
    if (!Object.hasOwn(METADATA_FIELDS, key)) throw new ContractError("UNKNOWN_METADATA_FIELD");
    const rule = METADATA_FIELDS[key as MetadataField];
    if (rule.type === "boolean") {
      if (typeof raw !== "boolean") throw new ContractError(`BAD:metadata.${key}`);
      out.document_held = raw;
    } else {
      if (typeof raw !== "number" || !Number.isInteger(raw) || raw < rule.min || raw > rule.max) {
        throw new ContractError(`BAD:metadata.${key}`);
      }
      (out as Record<string, number>)[key] = raw;
    }
  }
  return out;
}

// ── Mapping relay facts onto the vocabulary — unknown resolves to `unclassified` ──

/**
 * Every mapper below fails SAFE in the analytics sense: an input it does not
 * recognise becomes `unclassified`, never a real bucket. A new Telegram chat
 * type, a new person-link role, a new attachment kind — each shows up as a
 * visible `unclassified` count rather than being folded silently into
 * "group" or "organizer" and making a number look better than it is.
 */

/**
 * Telegram's OWN `chat.type`, as the update carried it, + the sender's role → channel.
 *
 * Deliberately the raw Telegram value and not `WireSessionSource.chat_type`:
 * normalize.ts's `mapChatType` folds every unrecognised Telegram type into
 * `group` (the safe reading for ROUTING), which would make `unclassified`
 * unreachable here and count a new chat kind as family-group traffic. A forum
 * topic arrives as `supergroup`, so it is `group` either way.
 *
 * `other` covers a DM from anyone the trip has not linked as its organizer,
 * and a channel (which the poll loop does not subscribe to today).
 */
export function channelTypeOf(telegramChatType: string | null | undefined, role: RequesterRole): ChannelType {
  switch (telegramChatType) {
    case "private":
      return role === "organizer" ? "organizer_dm" : "other";
    case "group":
    case "supergroup":
      return "group";
    case "channel":
      return "other";
    default:
      return "unclassified";
  }
}

/**
 * A `trip_person_links.role` (or its absence) → requester role.
 *
 * No link is `unknown`, not `participant`: only organizers are linked today
 * (migration 0051), so an unlinked sender might be a family member or an
 * organizer on an account the trip never linked. Guessing either would be a
 * number that looks better than it is.
 */
export function requesterRoleOf(linkRole: string | null | undefined): RequesterRole {
  if (linkRole === null || linkRole === undefined) return "unknown";
  if (linkRole === "organizer") return "organizer";
  if (linkRole === "participant") return "participant";
  return "unclassified";
}

/** A relay attachment kind (`MediaKind` in media-store.ts), or none. */
export function mediaKindOf(kind: string | null | undefined): MediaKindClass {
  switch (kind) {
    case null:
    case undefined:
      return "none";
    case "image":
      return "photo";
    case "document":
      return "document";
    case "voice":
    case "audio":
      return "audio";
    case "video":
      return "other";
    default:
      return "unclassified";
  }
}

/** Length of what the person wrote, never the text itself. */
export function lengthBucketOf(length: number): LengthBucket {
  if (!Number.isFinite(length) || length <= 0) return "none";
  if (length <= 40) return "1_40";
  if (length <= 160) return "41_160";
  if (length <= 640) return "161_640";
  return "641_plus";
}

/** Clamp a count into metadata's bounds, so a burst of 30 files cannot make an event invalid. */
export function boundedCount(value: number): number {
  if (!Number.isFinite(value) || value <= 0) return 0;
  return Math.min(Math.floor(value), METADATA_FIELDS.documents.max);
}
