/**
 * Derived rates over `DayRollup` (analytics/store.ts) — issue #326, Track 2's
 * second slice.
 *
 * `store.ts` says what the relay actually observed, per trip per local day.
 * This file says what that alone can honestly support as a rate: nothing
 * here reaches back into `assistant_events`, and nothing here invents a
 * number the relay cannot see. Four rates the daily control-plan report
 * names (`control-plan-metrics.md`, "Implementation Notes") need an
 * assistant-side outcome — grounded-answer rate, missing-data rate,
 * traveller self-service rate, post-write trust rate — and the relay never
 * writes `answered` at all (design §6.3, contract.ts's own comment): those
 * four are always `not_measurable`, with a reason, never a 0 or a fabricated
 * number. They arrive with a later slice's assistant-side events.
 *
 * **Granularity the rollup actually supports, not the granularity a table
 * header would like.** `DayRollup.by_channel_role` differentiates
 * `not_addressed` / `forwarded` / `to_relay` / `lost` per (channel, role)
 * cell — so a lost-turn rate and an addressed share can honestly be cut that
 * finely. Reply outcome (`turns`), reply latency (`reply_latency_ms`) and a
 * document's fate (`documents`) are recorded once per day, with no
 * channel/role tag on the row that produced them — re-deriving a split the
 * source data does not carry would be exactly the fabrication this module
 * exists to refuse. Those rates are reported once per day, at the top level,
 * never invented per cell. This was a design fork settled here rather than a
 * rollup change, because `store.ts` is out of this slice's paths — see the
 * handover.
 */
import type { ChannelRoleCounts, DayRollup } from "./store.js";

/** A rate honestly computed from the relay's own counts. `value` is `null`,
 * never `0` or `NaN`, when the denominator is zero — a trip with no traffic
 * has no rate, not a rate of zero. */
export interface Rate {
  value: number | null;
  numerator: number;
  denominator: number;
}

/** One of the four rates the relay's facts cannot support at all. */
export interface NotMeasurable {
  not_measurable: true;
  reason: string;
}

/**
 * Reason shared by the two assistant-side rates still not measurable —
 * traveller self-service and post-write trust. Reused so the report and the
 * rates agree word for word.
 *
 * grounded_answer_rate and missing_data_rate moved OFF this list (missing-
 * information control loop, decision 22): the Hermes plugin's
 * `tool_call_completed` events give both a real denominator now
 * (`DayRollup.assistant_tool_outcomes`) — see `deriveRates` below. They are
 * `0`-valued, correctly, for a trip/day with no Hermes plugin reporting yet
 * (no traffic observed, not "cannot be observed") — that distinction is
 * exactly why this file's own rule (`rate()`: a zero denominator is `null`,
 * never a fabricated `0`) still applies to them the same as every other
 * rate here.
 */
export const NOT_MEASURABLE_REASON =
  "requires an assistant-side outcome (self-service resolution, or post-write verification); the relay observes delivery facts only — this arrives with a later slice's assistant-side events";

export interface ChannelRoleRate {
  channel_type: string;
  requester_role: string;
  /** lost / (forwarded + to_relay + lost) — of what this cell handed off. */
  lost_turn_rate: Rate;
  /** (forwarded + to_relay + lost) / (that + not_addressed) — how much of this cell's traffic was addressed at all. */
  addressed_share: Rate;
}

export interface RelayReadOutcomes {
  total: number;
  /** Share of `total` for each outcome the relay's own document reads produced that day. Empty when there were none. */
  by_outcome: Record<string, Rate>;
}

export interface DayRates {
  trip_id: string;
  local_day: string;

  /** reply_delivered_substantive_outcome_unknown / requests_forwarded. Day-level: `turns` carries no channel/role tag. */
  response_rate: Rate;
  /** unanswered / requests_forwarded. */
  unanswered_rate: Rate;
  /** lost / (requests_forwarded + requests_to_relay + lost) — of every addressed hand-off attempted that day. */
  lost_turn_rate: Rate;
  reply_latency_p50_ms: Rate;
  reply_latency_p95_ms: Rate;
  /** group.addressed / (group.addressed + group.not_addressed). */
  group_addressed_share: Rate;
  /** documents.forwarded_reply_delivered_substantive_outcome_unknown / documents.forwarded. */
  document_forwarded_and_replied_rate: Rate;
  relay_read_outcomes: RelayReadOutcomes;

  /** The same lost-turn rate and addressed share, cut by (channel_type, requester_role) — the one split the rollup actually carries. */
  by_channel_role: ChannelRoleRate[];

  /** grounded_answer / (grounded_answer + failed_tool + missing_data) — the assistant's own tool calls, Hermes-reported. */
  grounded_answer_rate: Rate;
  /** missing_data / (grounded_answer + failed_tool + missing_data) — the missing-information control loop's detection rate. */
  missing_data_rate: Rate;

  not_measurable: {
    traveller_self_service_rate: NotMeasurable;
    post_write_trust_rate: NotMeasurable;
  };

  /** Caveats that apply to the numbers above, carried forward rather than hidden (KNOWN LIMIT, store.ts). */
  known_limits: string[];
}

/** `numerator / denominator`, or `null` — never `0`, never `NaN` — when there is nothing to divide. */
export function rate(numerator: number, denominator: number): Rate {
  return { value: denominator > 0 ? numerator / denominator : null, numerator, denominator };
}

function notMeasurable(reason: string = NOT_MEASURABLE_REASON): NotMeasurable {
  return { not_measurable: true, reason };
}

/**
 * Nearest-rank percentile over an ALREADY-sorted-ascending array.
 * `p` in [0, 100]. `null` on an empty array — no fabricated latency for a day
 * with no replies.
 */
function percentile(sortedAsc: readonly number[], p: number): number | null {
  const n = sortedAsc.length;
  if (n === 0) return null;
  const index = Math.min(n - 1, Math.max(0, Math.ceil((p / 100) * n) - 1));
  return sortedAsc[index]!;
}

function percentileRate(sortedAsc: readonly number[], p: number): Rate {
  const value = percentile(sortedAsc, p);
  return { value, numerator: value ?? 0, denominator: sortedAsc.length };
}

function channelRoleRate(cell: ChannelRoleCounts): ChannelRoleRate {
  const addressed = cell.forwarded + cell.to_relay + cell.lost;
  return {
    channel_type: cell.channel_type,
    requester_role: cell.requester_role,
    lost_turn_rate: rate(cell.lost, addressed),
    addressed_share: rate(addressed, addressed + cell.not_addressed),
  };
}

/** The KNOWN LIMIT carried from `rollupAssistantEvents`'s own doc comment (store.ts): a relay restart forgets in-flight attribution, so on a day the relay restarted, `unanswered` (and anything derived from it) is an upper bound. The rollup does not record whether a restart happened, so this caveat is always attached rather than conditioned on a signal that does not exist. */
export const RELAY_RESTART_CAVEAT =
  "a relay restart loses in-memory reply attribution; on a day the relay restarted, unanswered/lost-turn counts (and every rate derived from them) are an upper bound, not an exact count";

/**
 * Every rate the relay's own facts can honestly support, for one trip's one
 * local day — from a `DayRollup` alone, nothing re-queried.
 */
export function deriveRates(rollup: DayRollup): DayRates {
  const sortedLatency = [...rollup.reply_latency_ms].sort((a, b) => a - b);
  const totalAddressed = rollup.requests_forwarded + rollup.requests_to_relay + rollup.turns.lost;
  const relayReadTotal = Object.values(rollup.documents.relay_read).reduce((sum, n) => sum + n, 0);
  const relayReadOutcomes: RelayReadOutcomes = {
    total: relayReadTotal,
    by_outcome: Object.fromEntries(
      Object.entries(rollup.documents.relay_read).map(([outcome, count]) => [outcome, rate(count, relayReadTotal)]),
    ),
  };
  const { grounded_answer, failed_tool, missing_data } = rollup.assistant_tool_outcomes;
  const toolCallsTotal = grounded_answer + failed_tool + missing_data;

  return {
    trip_id: rollup.trip_id,
    local_day: rollup.local_day,
    response_rate: rate(rollup.turns.reply_delivered_substantive_outcome_unknown, rollup.requests_forwarded),
    unanswered_rate: rate(rollup.turns.unanswered, rollup.requests_forwarded),
    lost_turn_rate: rate(rollup.turns.lost, totalAddressed),
    reply_latency_p50_ms: percentileRate(sortedLatency, 50),
    reply_latency_p95_ms: percentileRate(sortedLatency, 95),
    group_addressed_share: rate(rollup.group.addressed, rollup.group.addressed + rollup.group.not_addressed),
    document_forwarded_and_replied_rate: rate(
      rollup.documents.forwarded_reply_delivered_substantive_outcome_unknown,
      rollup.documents.forwarded,
    ),
    relay_read_outcomes: relayReadOutcomes,
    by_channel_role: rollup.by_channel_role.map(channelRoleRate),
    grounded_answer_rate: rate(grounded_answer, toolCallsTotal),
    missing_data_rate: rate(missing_data, toolCallsTotal),
    not_measurable: {
      traveller_self_service_rate: notMeasurable(),
      post_write_trust_rate: notMeasurable(),
    },
    known_limits: [RELAY_RESTART_CAVEAT],
  };
}

/**
 * A `DayRollup` with every count at zero, for a trip/day the table has no
 * rows for. `deriveRates` on this produces every `Rate` with `value: null`
 * (no divide-by-zero) — the empty-trip case is the acceptance test's own
 * words: "a trip with no traffic renders an EMPTY report", never a fabricated
 * rate.
 */
export function emptyDayRollup(tripId: string, localDay: string): DayRollup {
  return {
    trip_id: tripId,
    local_day: localDay,
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
    assistant_tool_outcomes: {
      grounded_answer: 0,
      failed_tool: 0,
      missing_data: 0,
      missing_data_by_tool: {},
    },
  };
}
