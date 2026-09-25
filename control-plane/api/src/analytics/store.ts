/**
 * The assistant-event store: an idempotent batch writer, the retention purge,
 * and the per-trip, per-local-day rollup — all over
 * `control_plane.assistant_events` (migration 20260925143012).
 *
 * The writer is the function a later authenticated ingest route will wrap, so
 * it validates everything itself rather than trusting its caller: the relay's
 * emitter today, a Hermes plugin's batches tomorrow.
 */
import type pg from "pg";
import { validateAssistantEvent, type AssistantEvent, EVENT_FIELDS } from "./contract.js";

type Db = Pick<pg.Pool, "query">;
/** The writer needs its own connection, so every statement it runs sits under one transaction's timeout. */
type WriterDb = Pick<pg.Pool, "connect">;

export interface WriteResult {
  /** Rows actually inserted. */
  inserted: number;
  /** Valid events whose event_id was already stored — the at-least-once retry case. */
  duplicates: number;
  /** Refused, with a fixed reason code each. Never the refused value itself. */
  rejected: { index: number; reason: string }[];
}

/**
 * Bounds one write on the database side. A hung analytics insert must give its
 * pool connection back, because that pool is the one the relay routes messages
 * with.
 */
const STATEMENT_TIMEOUT_MS = 5_000;

/**
 * Validates and stores a batch. Idempotent on `event_id`: writing the same
 * event twice stores one row, so a batch that timed out and is sent again —
 * or later lands after all — cannot double-count.
 *
 * Everything that touches the database runs on one connection, inside one
 * transaction whose FIRST statement bounds every later one
 * (`statement_timeout`, `lock_timeout`). There is no unbounded query before
 * it. Acquiring the connection is not bounded here — the pool's own setting
 * decides that — which is why the emitter never has more than one write
 * outstanding (analytics/emitter.ts).
 *
 * A `trip_id` that names no trip is refused per row rather than left to the
 * foreign key, which would fail the whole batch for one bad row. The existence
 * check and the insert are ONE statement, joined against `trips` with a key
 * lock, so a trip deleted while the batch is being written is skipped rather
 * than failing the batch on the foreign key.
 */
export async function writeAssistantEvents(db: WriterDb, input: readonly unknown[]): Promise<WriteResult> {
  const rejected: WriteResult["rejected"] = [];
  const valid: { index: number; event: AssistantEvent }[] = [];
  input.forEach((candidate, index) => {
    const checked = validateAssistantEvent(candidate);
    if (checked.ok) valid.push({ index, event: checked.event });
    else rejected.push({ index, reason: checked.reason });
  });
  if (valid.length === 0) return { inserted: 0, duplicates: 0, rejected };

  // One statement for the whole batch, the rows passed as a JSON array and
  // unpacked by jsonb_to_recordset — the column list is EVENT_FIELDS, so the
  // insert cannot name a column the contract does not.
  const columns = EVENT_FIELDS.join(", ");
  const sql = `
    WITH e AS (
      SELECT * FROM jsonb_to_recordset($1::jsonb) AS x(
        event_id uuid, trip_id text, occurred_at timestamptz, source_service text,
        event_type text, turn_id uuid, channel_type text, trigger_type text,
        requester_role text, outcome text, response_latency_ms integer,
        message_length_bucket text, media_kind text, metadata jsonb
      )
    ),
    known AS (
      SELECT t.id FROM control_plane.trips t
       WHERE t.id IN (SELECT trip_id FROM e)
       FOR KEY SHARE OF t
    ),
    ins AS (
      INSERT INTO control_plane.assistant_events (${columns})
      SELECT ${EVENT_FIELDS.map((c) => `e.${c}`).join(", ")}
        FROM e JOIN known ON known.id = e.trip_id
      ON CONFLICT (event_id) DO NOTHING
      RETURNING 1
    )
    SELECT (SELECT count(*)::int FROM ins) AS inserted,
           ARRAY(SELECT id FROM known) AS known`;
  const payload = JSON.stringify(valid.map((v) => v.event));

  const client = await db.connect();
  let result: { inserted: number; known: string[] };
  try {
    await client.query("BEGIN");
    await client.query(`SET LOCAL statement_timeout = ${STATEMENT_TIMEOUT_MS}`);
    await client.query(`SET LOCAL lock_timeout = ${STATEMENT_TIMEOUT_MS}`);
    const res = await client.query<{ inserted: number; known: string[] }>(sql, [payload]);
    await client.query("COMMIT");
    result = res.rows[0] ?? { inserted: 0, known: [] };
  } catch (error) {
    await client.query("ROLLBACK").catch(() => {});
    throw error;
  } finally {
    client.release();
  }

  const known = new Set(result.known);
  let writable = 0;
  for (const v of valid) {
    if (v.event.trip_id !== null && known.has(v.event.trip_id)) writable += 1;
    else rejected.push({ index: v.index, reason: "UNKNOWN_TRIP" });
  }
  rejected.sort((a, b) => a.index - b.index);
  return { inserted: result.inserted, duplicates: writable - result.inserted, rejected };
}

export const DEFAULT_RETENTION_DAYS = 90;

/**
 * Deletes events older than the cutoff (design §10: rows without text or
 * direct identifiers live 90–180 days). Returns how many went.
 *
 * NOT SCHEDULED by this slice. Scheduling it is a precondition for enabling
 * assistant events anywhere real, recorded as carry-forward on #177.
 *
 * Refuses a cutoff under one day: `0` would delete everything, and a purge is
 * not the tool for that.
 */
export async function purgeExpiredEvents(db: Db, olderThanDays: number = DEFAULT_RETENTION_DAYS): Promise<number> {
  if (!Number.isInteger(olderThanDays) || olderThanDays < 1) {
    throw new RangeError("purgeExpiredEvents: olderThanDays must be a whole number of days, at least 1");
  }
  const res = await db.query(
    "DELETE FROM control_plane.assistant_events WHERE occurred_at < now() - make_interval(days => $1)",
    [olderThanDays],
  );
  return res.rowCount ?? 0;
}

// ── The rollup ───────────────────────────────────────────────────────────────

/** Counts for one channel × role pair, over inbound messages. */
export interface ChannelRoleCounts {
  channel_type: string;
  requester_role: string;
  not_addressed: number;
  forwarded: number;
  to_relay: number;
  lost: number;
}

export interface DayRollup {
  trip_id: string;
  /** YYYY-MM-DD in the rollup's time zone. */
  local_day: string;
  /** Group messages, by whether the relevance gate addressed them to the assistant. */
  group: { addressed: number; not_addressed: number };
  by_channel_role: ChannelRoleCounts[];
  /** Requests handed to the assistant (the companion gateway accepted the frame). */
  requests_forwarded: number;
  /** Requests the relay handled itself (post-confirmation document reads). */
  requests_to_relay: number;
  turns: {
    /**
     * Forwarded turns with at least one reply Telegram accepted. Named for
     * what the relay saw, never "answered": whether the reply did the job is a
     * substantive outcome the relay cannot observe (design §6.3).
     */
    reply_delivered_substantive_outcome_unknown: number;
    /** Forwarded turns with no delivered reply at all. */
    unanswered: number;
    /** Addressed turns nothing could take — gateway down or companion unreachable. */
    lost: number;
  };
  /** Time from hand-off to first delivered reply, one per replied turn, in hand-off order. */
  reply_latency_ms: number[];
  replies: { delivered: number; failed: number; suppressed: number; unattributed_delivered: number };
  documents: {
    /** Sent to a group without addressing the assistant; kept for the sender's next addressed message. */
    held: number;
    /** Held (or replied-to) documents an addressed message brought along. */
    joined: number;
    /** Documents handed to the assistant, joined ones included. */
    forwarded: number;
    /** …of which the turn got a delivered reply. Substantive outcome unknown to the relay. */
    forwarded_reply_delivered_substantive_outcome_unknown: number;
    /** …of which the turn got no reply. */
    forwarded_unanswered: number;
    /** The relay's own reads (one per upload burst), by substantive outcome — the relay IS the tool there. */
    relay_read: Record<string, number>;
  };
}

interface EventRow {
  event_type: string;
  turn_id: string | null;
  channel_type: string | null;
  trigger_type: string | null;
  requester_role: string | null;
  outcome: string;
  response_latency_ms: number | null;
  metadata: Record<string, unknown>;
  local_day: string;
  occurred_at: Date;
  trip_id: string;
}

/**
 * The per-trip, per-local-day rollup, from the event table ALONE.
 *
 * `timeZone` is an IANA name; it decides which local day an event falls on.
 * The trip's own phase time zone is not derivable from the control plane yet
 * (design §6.4), so the caller names it. Postgres rejects an unknown zone.
 *
 * A turn is counted on the day it was handed off, with whatever replies it got
 * later — a question asked at 23:58 and answered at 00:03 is one turn of the
 * earlier day, and answered, even when `to` ends the window at midnight: the
 * replies to the window's turns are read with no upper time bound.
 *
 * KNOWN LIMIT — a relay restart forgets which requests are waiting (the
 * emitter's attribution is in memory). A reply to a request made before the
 * restart is then recorded with no turn, or not at all if the chat has not
 * spoken since, and that request shows here as `unanswered`. Until attribution
 * survives a restart, an `unanswered` count on a day the relay restarted is an
 * upper bound.
 */
export async function rollupAssistantEvents(
  db: Db,
  options: { tripId?: string; timeZone?: string; from?: Date; to?: Date } = {},
): Promise<DayRollup[]> {
  const timeZone = options.timeZone ?? "UTC";
  const res = await db.query<EventRow>(
    `SELECT event_type, turn_id::text AS turn_id, channel_type, trigger_type, requester_role,
            outcome, response_latency_ms, metadata, trip_id, occurred_at,
            to_char(occurred_at AT TIME ZONE $1, 'YYYY-MM-DD') AS local_day
       FROM control_plane.assistant_events
      WHERE trip_id IS NOT NULL
        AND ($2::text IS NULL OR trip_id = $2)
        AND ($3::timestamptz IS NULL OR occurred_at >= $3)
        AND ($4::timestamptz IS NULL OR occurred_at < $4)
      ORDER BY occurred_at, event_id`,
    [timeZone, options.tripId ?? null, options.from ?? null, options.to ?? null],
  );

  // Replies to the window's own turns, wherever in time they landed — a reply
  // to a 23:58 question can fall after `to`. Read by turn_id, not by window.
  const handoffs = res.rows.filter((r) => r.event_type === "request_forwarded" && r.turn_id);
  const turnIds = [...new Set(handoffs.map((r) => r.turn_id as string))];
  const repliesByTurn = new Map<string, { outcome: string; response_latency_ms: number | null }[]>();
  if (turnIds.length > 0) {
    // Bounded below by the earliest hand-off and to the window's trips, so the
    // (trip_id, occurred_at) index serves it; unbounded above on purpose.
    const replies = await db.query<{ turn_id: string; outcome: string; response_latency_ms: number | null }>(
      `SELECT turn_id::text AS turn_id, outcome, response_latency_ms
         FROM control_plane.assistant_events
        WHERE trip_id = ANY($1::text[])
          AND occurred_at >= $2
          AND event_type = 'reply_sent'
          AND turn_id = ANY($3::uuid[])`,
      [
        [...new Set(handoffs.map((r) => r.trip_id))],
        new Date(Math.min(...handoffs.map((r) => new Date(r.occurred_at).getTime()))),
        turnIds,
      ],
    );
    for (const row of replies.rows) {
      const list = repliesByTurn.get(row.turn_id) ?? [];
      list.push(row);
      repliesByTurn.set(row.turn_id, list);
    }
  }

  const days = new Map<string, DayRollup>();
  const dayOf = (row: EventRow): DayRollup => {
    const key = `${row.trip_id}\u0000${row.local_day}`;
    let day = days.get(key);
    if (!day) {
      day = {
        trip_id: row.trip_id,
        local_day: row.local_day,
        group: { addressed: 0, not_addressed: 0 },
        by_channel_role: [],
        requests_forwarded: 0,
        requests_to_relay: 0,
        turns: { reply_delivered_substantive_outcome_unknown: 0, unanswered: 0, lost: 0 },
        reply_latency_ms: [],
        replies: { delivered: 0, failed: 0, suppressed: 0, unattributed_delivered: 0 },
        documents: {
          held: 0,
          joined: 0,
          forwarded: 0,
          forwarded_reply_delivered_substantive_outcome_unknown: 0,
          forwarded_unanswered: 0,
          relay_read: {},
        },
      };
      days.set(key, day);
    }
    return day;
  };
  const cell = (day: DayRollup, row: EventRow): ChannelRoleCounts => {
    const channel = row.channel_type ?? "unclassified";
    const role = row.requester_role ?? "unclassified";
    let found = day.by_channel_role.find((c) => c.channel_type === channel && c.requester_role === role);
    if (!found) {
      found = { channel_type: channel, requester_role: role, not_addressed: 0, forwarded: 0, to_relay: 0, lost: 0 };
      day.by_channel_role.push(found);
    }
    return found;
  };
  const count = (value: unknown): number => (typeof value === "number" && Number.isFinite(value) ? value : 0);

  for (const row of res.rows) {
    const day = dayOf(row);
    const isGroup = row.channel_type === "group";
    switch (row.event_type) {
      case "ignored_not_addressed":
        cell(day, row).not_addressed += 1;
        if (isGroup) day.group.not_addressed += 1;
        if (row.metadata?.document_held === true) day.documents.held += 1;
        break;
      case "request_forwarded": {
        cell(day, row).forwarded += 1;
        if (isGroup) day.group.addressed += 1;
        day.requests_forwarded += 1;
        const documents = count(row.metadata?.documents);
        day.documents.joined += count(row.metadata?.attachments_joined);
        day.documents.forwarded += documents;
        const delivered = (repliesByTurn.get(row.turn_id ?? "") ?? []).filter((r) => r.outcome === "reply_delivered");
        if (delivered.length > 0) {
          day.turns.reply_delivered_substantive_outcome_unknown += 1;
          day.documents.forwarded_reply_delivered_substantive_outcome_unknown += documents;
          const latencies = delivered.map((r) => r.response_latency_ms).filter((ms): ms is number => ms !== null);
          if (latencies.length > 0) day.reply_latency_ms.push(Math.min(...latencies));
        } else {
          day.turns.unanswered += 1;
          day.documents.forwarded_unanswered += documents;
        }
        break;
      }
      case "request_to_relay":
        cell(day, row).to_relay += 1;
        if (isGroup) day.group.addressed += 1;
        day.requests_to_relay += 1;
        break;
      case "turn_lost":
        // With the companion unreachable the router answers before the
        // relevance gate runs, so a family's chatter can land here too. Only
        // an ADDRESSED message is a lost turn; chatter stays chatter.
        if (row.trigger_type === "not_addressed") {
          cell(day, row).not_addressed += 1;
          if (isGroup) day.group.not_addressed += 1;
        } else {
          cell(day, row).lost += 1;
          if (isGroup) day.group.addressed += 1;
          day.turns.lost += 1;
        }
        break;
      case "reply_sent":
        if (row.outcome === "reply_delivered") {
          day.replies.delivered += 1;
          if (!row.turn_id) day.replies.unattributed_delivered += 1;
        } else if (row.outcome === "failed_delivery") day.replies.failed += 1;
        else if (row.outcome === "reply_suppressed") day.replies.suppressed += 1;
        break;
      case "relay_tool_completed":
        // One per read the relay ran (one upload burst), by its outcome.
        day.documents.relay_read[row.outcome] = (day.documents.relay_read[row.outcome] ?? 0) + 1;
        break;
      default:
        // An event type this rollup does not know is not silently folded into
        // one it does. The contract refuses unknown types on write, so this is
        // a newer writer ahead of an older reader.
        break;
    }
  }

  for (const day of days.values()) {
    day.by_channel_role.sort((a, b) =>
      a.channel_type.localeCompare(b.channel_type) || a.requester_role.localeCompare(b.requester_role));
  }
  return [...days.values()].sort((a, b) => a.trip_id.localeCompare(b.trip_id) || a.local_day.localeCompare(b.local_day));
}
