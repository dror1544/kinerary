/**
 * The Hermes tool-outcome ingest path: turns a batch of `{event_id, outcome,
 * tool_name, occurred_at?}` entries from a companion's Hermes plugin into
 * `control_plane.assistant_events` rows with `source_service: "hermes"`,
 * `event_type: "tool_call_completed"`.
 *
 * SCOPE — FROM THE PROFILE NAME, NEVER FROM A TRIP ID. Exactly the invariant
 * `companion-mcp.ts` states for its own tools ("no tool takes a trip id, so
 * no argument can reach another family's trip"): the request names the
 * Hermes profile that is reporting, this module resolves the ONE trip that
 * profile belongs to, and nothing else in the payload can point anywhere
 * else. `control_plane.trips.hermes_profile` (migration 20260922060000) is
 * the source used here rather than `telegram_chat_bindings` — it is the
 * trip's own fact ("the companion profile installed for THIS trip"),
 * independent of whether any chat is currently bound to it, which matters
 * because a tool call can happen in a DM-only conversation with no open
 * group binding at all.
 *
 * Authentication is the caller's job (`app.ts`'s route, a single shared
 * `ASSISTANT_EVENTS_INGEST_KEY` — see that file for why a shared key here is
 * the right size, not the per-profile gateway token `companion-mcp.ts`
 * reuses). This module never sees a key; it only resolves identity and
 * writes, so it is exercised directly in tests without an HTTP layer.
 *
 * The writer underneath (`analytics/store.ts#writeAssistantEvents`) is
 * exactly the one the relay's own emitter flushes to — "the function a later
 * authenticated ingest route will wrap", by that file's own module doc.
 * Nothing here invents a second table or a second vocabulary.
 */
import type pg from "pg";
import { TOOL_NAMES, type Outcome, type ToolName } from "./analytics/contract.js";
import { writeAssistantEvents, type WriteResult } from "./analytics/store.js";

const EVENT_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
/** Matches trips.hermes_profile's own CHECK (migration 20260922060000). */
const PROFILE = /^.{1,64}$/s;
const OCCURRED_AT =
  /^\d{4}-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])T([01]\d|2[0-3]):[0-5]\d:[0-5]\d(\.\d{1,6})?(Z|[+-]([01]\d|2[0-3]):[0-5]\d)$/;

/** The only outcomes this ingest path ever writes — never `answered`; see contract.ts. */
const HERMES_TOOL_OUTCOMES: readonly Outcome[] = ["grounded_answer", "failed_tool", "missing_data"];

/** A batch any larger than this is almost certainly a bug upstream, not a burst of real tool calls in one flush. */
export const MAX_BATCH_SIZE = 50;

export type ResolveProfileTripResult =
  | { ok: true; tripId: string }
  | { ok: false; reason: "NO_TRIP" | "AMBIGUOUS_TRIP" };

/**
 * The one trip a Hermes profile's `tool_call_completed` facts belong to, or
 * why there is none. Mirrors `companion-mcp.ts#tripForCompanion`'s shape
 * (same two failure reasons) but reads `trips.hermes_profile` directly —
 * the trip's own record of its companion, not a chat binding's.
 */
export async function tripForHermesProfile(db: pg.Pool, profile: string): Promise<ResolveProfileTripResult> {
  const { rows } = await db.query<{ id: string }>(
    "SELECT id FROM control_plane.trips WHERE hermes_profile = $1",
    [profile],
  );
  if (rows.length === 0) return { ok: false, reason: "NO_TRIP" };
  if (rows.length > 1) return { ok: false, reason: "AMBIGUOUS_TRIP" };
  return { ok: true, tripId: rows[0]!.id };
}

export interface RawToolOutcome {
  event_id?: unknown;
  occurred_at?: unknown;
  outcome?: unknown;
  tool_name?: unknown;
}

export interface ParsedToolOutcome {
  eventId: string;
  occurredAt: string;
  outcome: Outcome;
  toolName: ToolName;
}

/**
 * Parses and bounds-checks one entry of the request body's `events` array.
 * Never throws; a bad entry is a `reason` string, same shape as the
 * contract's own `ValidationResult` so a caller can report it the same way.
 *
 * `tool_name` is required here the same way the contract requires it for
 * `tool_call_completed` — the missing-information control loop's "which
 * fact" dimension (decision 22) needs it on every event, not only
 * `missing_data` ones, so "top missing items" can be computed from the same
 * rollup that also counts grounded_answer/failed_tool per tool.
 */
export function parseToolOutcome(raw: unknown, now: () => string = () => new Date().toISOString()): { ok: true; event: ParsedToolOutcome } | { ok: false; reason: string } {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return { ok: false, reason: "INVALID_EVENT" };
  const input = raw as RawToolOutcome;
  if (typeof input.event_id !== "string" || !EVENT_ID.test(input.event_id)) return { ok: false, reason: "BAD:event_id" };
  if (typeof input.outcome !== "string" || !(HERMES_TOOL_OUTCOMES as readonly string[]).includes(input.outcome)) {
    return { ok: false, reason: "BAD:outcome" };
  }
  if (typeof input.tool_name !== "string" || !(TOOL_NAMES as readonly string[]).includes(input.tool_name)) {
    return { ok: false, reason: "BAD:tool_name" };
  }
  let occurredAt = now();
  if (input.occurred_at !== undefined) {
    if (typeof input.occurred_at !== "string" || !OCCURRED_AT.test(input.occurred_at)) return { ok: false, reason: "BAD:occurred_at" };
    occurredAt = input.occurred_at;
  }
  return {
    ok: true,
    event: { eventId: input.event_id, occurredAt, outcome: input.outcome as Outcome, toolName: input.tool_name as ToolName },
  };
}

export type IngestResult =
  | { ok: true; write: WriteResult }
  | {
      ok: false;
      reason: "NO_TRIP" | "AMBIGUOUS_TRIP" | "INVALID_PROFILE" | "INVALID_BATCH" | "EMPTY_BATCH"
        | "BATCH_TOO_LARGE" | "INVALID_EVENT";
      /** Set only for INVALID_EVENT: which index, and the contract-shaped reason for it. */
      detail?: { index: number; reason: string };
    };

/**
 * Resolves `profile` to its one trip, builds a full `AssistantEvent` for each
 * entry in `events`, and writes the batch.
 *
 * The WHOLE request is refused — nothing written, trip not even resolved —
 * when `profile`, the batch shape, or ANY single event in it fails to parse.
 * Unlike the relay's own emitter (which never rejects a batch for one bad
 * row, because it is feeding itself from its own code), this path takes a
 * batch from a process outside this one; a shape it does not recognise is
 * treated as a caller bug worth a loud 400, not a partial write with a
 * `rejected` entry a cron-run plugin is unlikely to ever read. Once every
 * entry parses, the write still goes through `writeAssistantEvents`'s own
 * contract check and idempotent insert — the double-check design that file
 * documents for every caller, this one included.
 */
export async function ingestHermesToolOutcomes(
  db: pg.Pool,
  profile: unknown,
  events: unknown,
): Promise<IngestResult> {
  if (typeof profile !== "string" || !PROFILE.test(profile)) return { ok: false, reason: "INVALID_PROFILE" };
  if (!Array.isArray(events)) return { ok: false, reason: "INVALID_BATCH" };
  if (events.length === 0) return { ok: false, reason: "EMPTY_BATCH" };
  if (events.length > MAX_BATCH_SIZE) return { ok: false, reason: "BATCH_TOO_LARGE" };

  const now = () => new Date().toISOString();
  const parsed: ParsedToolOutcome[] = [];
  for (let index = 0; index < events.length; index += 1) {
    const result = parseToolOutcome(events[index], now);
    if (!result.ok) return { ok: false, reason: "INVALID_EVENT", detail: { index, reason: result.reason } };
    parsed.push(result.event);
  }

  const trip = await tripForHermesProfile(db, profile);
  if (!trip.ok) return trip;

  const rows = parsed.map((event) => ({
    event_id: event.eventId,
    trip_id: trip.tripId,
    occurred_at: event.occurredAt,
    source_service: "hermes",
    event_type: "tool_call_completed",
    turn_id: null,
    channel_type: null,
    trigger_type: null,
    requester_role: null,
    outcome: event.outcome,
    response_latency_ms: null,
    message_length_bucket: null,
    media_kind: null,
    metadata: {},
    tool_name: event.toolName,
  }));

  const write = await writeAssistantEvents(db, rows);
  return { ok: true, write };
}
