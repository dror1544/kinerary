/**
 * The daily control-plan report — issue #326, Track 2's second slice.
 *
 * Renders the five sections (plus the group judge's, once) `control-plan-metrics.md` ("Suggested Daily
 * Control Plan Report") names — Usage, Value Delivered, Information Quality,
 * Learning and Enrichment, Organizer Enablement — from `DayRates`
 * (analytics/rates.ts) alone, as JSON and as Markdown built from the SAME
 * object, so the two can never disagree (Done-when item 4).
 *
 * Most of the five sections ask questions the relay cannot answer: whether an
 * answer was grounded in verified data, whether a record was written, whether
 * a preference was learned. Those lines say "no data recorded" — never a
 * guess, never a zero standing in for "unknown". A trip with no traffic that
 * day (`rollup` built by `emptyDayRollup`) renders every line "no data
 * recorded" or a rate of `null` — the acceptance test's own words: an EMPTY
 * report, no divide-by-zero, no fabricated rate.
 *
 * **No identifier rides in this report.** Every value below is a count, a
 * rate, or a string from a fixed vocabulary (`channel_type`, `requester_role`,
 * `relay_tool_completed` outcomes) — never free text, a chat id, a user id, or
 * a uuid. The one identifier that IS in the report on purpose is the
 * requested `trip_id`, once, in the header — `test/assistant-events-report.test.ts`
 * greps for exactly that.
 */
import { deriveRates, type DayRates, type NotMeasurable, type Rate } from "./rates.js";
import type { DayRollup } from "./store.js";

export interface ReportLine {
  label: string;
  /** Formatted for display — a count, a percentage with its numerator/denominator, or "no data recorded". */
  value: string;
  /** True when this line has nothing behind it — no relay fact reaches this question. */
  no_data: boolean;
}

export interface ReportSection {
  title: string;
  lines: ReportLine[];
}

export interface DailyReport {
  trip_id: string;
  local_day: string;
  /** Caveats attached to the numbers above (`DayRates.known_limits`), carried forward rather than hidden. */
  notes: string[];
  sections: ReportSection[];
}

const NO_DATA = "no data recorded";

function line(label: string, value: string, noData = false): ReportLine {
  return { label, value, no_data: noData };
}

function noDataLine(label: string): ReportLine {
  return line(label, NO_DATA, true);
}

function fmtCount(n: number): string {
  return String(n);
}

function fmtPercent(r: Rate): string {
  if (r.value === null) return NO_DATA;
  return `${(r.value * 100).toFixed(1)}% (${r.numerator}/${r.denominator})`;
}

function fmtLatency(r: Rate): string {
  if (r.value === null) return NO_DATA;
  return `${r.value} ms (n=${r.denominator})`;
}

function fmtNotMeasurable(nm: NotMeasurable): string {
  return `not measurable — ${nm.reason}`;
}

/** Per-`channel_type` totals across every requester role, from the one split the rollup carries. */
function totalsByChannel(rollup: DayRollup): Map<string, number> {
  const totals = new Map<string, number>();
  for (const cell of rollup.by_channel_role) {
    const total = cell.not_addressed + cell.forwarded + cell.to_relay + cell.lost;
    totals.set(cell.channel_type, (totals.get(cell.channel_type) ?? 0) + total);
  }
  return totals;
}

function usageSection(rollup: DayRollup, rates: DayRates): ReportSection {
  const byChannel = totalsByChannel(rollup);
  const totalInbound = [...byChannel.values()].reduce((sum, n) => sum + n, 0);
  const channelLine = byChannel.size === 0
    ? noDataLine("Group vs. private usage")
    : line(
        "Group vs. private usage",
        [...byChannel.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([ch, n]) => `${ch}: ${n}`).join(", "),
      );
  return {
    title: "Usage",
    lines: [
      line("Inbound messages to the bot", fmtCount(totalInbound), totalInbound === 0),
      noDataLine("Unique travelers who used it"),
      channelLine,
      line("Response rate", fmtPercent(rates.response_rate), rates.response_rate.value === null),
      line("Reply latency p50", fmtLatency(rates.reply_latency_p50_ms), rates.reply_latency_p50_ms.value === null),
      line("Reply latency p95", fmtLatency(rates.reply_latency_p95_ms), rates.reply_latency_p95_ms.value === null),
      line("Unanswered rate", fmtPercent(rates.unanswered_rate), rates.unanswered_rate.value === null),
      line(
        "Failed deliveries",
        fmtCount(rollup.replies.failed),
        rollup.replies.delivered + rollup.replies.failed + rollup.replies.suppressed === 0,
      ),
      // A defect count (target 0): the companion answered a message that named
      // it with the silence sentinel, so the family got nothing.
      line(
        "Silent on a message that named the assistant",
        fmtCount(rollup.replies.silent_on_addressed),
        rollup.replies.delivered + rollup.replies.failed + rollup.replies.suppressed === 0,
      ),
    ],
  };
}

/**
 * The group judge (relay/group-judge.ts): what it was asked, what it said, how
 * fast, and the two live accuracy PROXIES. Targets (owner, 2026-10-16):
 * precision >= 90% and recall >= 75% - which only the labelled benchmark
 * (tools/judge-benchmark.ts) can measure; the proxies here move in the same
 * direction as the misses and the false alarms but undercount both, and are
 * labelled so. p95 <= 1.5 s, hard timeout 3 s. With no judge decisions that day
 * every line says so - a trip whose judge is off or whose group was quiet has no
 * rate, not a rate of zero.
 */
function judgeSection(rollup: DayRollup, rates: DayRates): ReportSection {
  const j = rates.judge;
  const none = j.decisions === 0;
  const fallbackReasons = Object.entries(j.fallback_by_reason)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([reason, n]) => `${reason} ${n}`)
    .join(", ");
  const models = Object.entries(j.by_model)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([model, n]) => `${model} (${n})`)
    .join(", ");
  return {
    title: "Group Judge",
    lines: [
      none ? noDataLine("Messages judged") : line("Messages judged", fmtCount(j.decisions)),
      line("Judged for the assistant (yes rate)", fmtPercent(j.yes_rate), j.yes_rate.value === null),
      line(
        "Missed proxy - judge said no, same sender then addressed the assistant within 3 min",
        fmtPercent(j.missed_proxy),
        j.missed_proxy.value === null,
      ),
      line(
        "Over-eager proxy - judge said yes, companion replied with silence",
        fmtPercent(j.over_eager_proxy),
        j.over_eager_proxy.value === null,
      ),
      line("Judge latency p50 (target p95 <= 1500 ms, hard timeout 3000 ms)", fmtLatency(j.latency_p50_ms), j.latency_p50_ms.value === null),
      line("Judge latency p95", fmtLatency(j.latency_p95_ms), j.latency_p95_ms.value === null),
      line(
        "Fallbacks (timeout, error, unparseable, rate limited)",
        j.fallback_rate.value === null
          ? NO_DATA
          : `${fmtPercent(j.fallback_rate)}${fallbackReasons ? ` - ${fallbackReasons}` : ""}`,
        j.fallback_rate.value === null,
      ),
      none
        ? noDataLine("Yes below the confidence threshold, handled as no")
        : line("Yes below the confidence threshold, handled as no", fmtCount(rollup.judge?.below_threshold ?? 0)),
      none ? noDataLine("Model") : line("Model", models || "unknown"),
      ...proactiveLines(rollup),
    ],
  };
}

/**
 * The proactive level (`/proactive`): where the groups stand now, and how many
 * were moved up or down that day. A group turning the assistant down is the
 * signal that it is not welcome; a quiet day with no events says "no data", not
 * zero changes, as everywhere in this report. The distribution is a snapshot of
 * the open group bindings when the report was read (DayRollup.proactive).
 */
function proactiveLines(rollup: DayRollup): ReportLine[] {
  const p = rollup.proactive;
  const groups = Object.entries(p?.groups_by_level ?? {}).sort(([a], [b]) => a.localeCompare(b));
  const changes = (p?.raised ?? 0) + (p?.lowered ?? 0);
  return [
    groups.length === 0
      ? noDataLine("Groups by proactive level, now (1 only when called, 2 follows the conversation, 3 joins in)")
      : line(
          "Groups by proactive level, now (1 only when called, 2 follows the conversation, 3 joins in)",
          groups.map(([level, n]) => `${level}: ${n}`).join(", "),
        ),
    changes === 0
      ? noDataLine("Proactive level changes")
      : line("Proactive level changes", `raised ${p.raised}, lowered ${p.lowered}`),
  ];
}

/** Every OTHER line here still needs an assistant-side judgement this slice has no source for. */
function valueDeliveredSection(rollup: DayRollup, rates: DayRates): ReportSection {
  const toolCalls = rollup.assistant_tool_outcomes;
  const noToolCalls = toolCalls.grounded_answer + toolCalls.failed_tool + toolCalls.missing_data === 0;
  return {
    title: "Value Delivered",
    lines: [
      line(
        "Questions answered from verified website data",
        fmtPercent(rates.grounded_answer_rate),
        noToolCalls,
      ),
      noDataLine("Questions answered with partial data"),
      noDataLine("Questions that required organizer intervention"),
      noDataLine("Repeated questions that the assistant handled"),
      noDataLine("Operational reminders or decisions supported"),
    ],
  };
}

function informationQualitySection(rollup: DayRollup, rates: DayRates): ReportSection {
  const noReads = rates.relay_read_outcomes.total === 0;
  const outcomesLine = noReads
    ? noDataLine("Documents uploaded and parsed")
    : line(
        "Documents uploaded and parsed",
        `${rollup.documents.forwarded} forwarded; relay reads by outcome: ${
          Object.entries(rates.relay_read_outcomes.by_outcome)
            .sort(([a], [b]) => a.localeCompare(b))
            .map(([outcome, r]) => `${outcome} ${fmtPercent(r)}`)
            .join(", ")
        }`,
      );
  return {
    title: "Information Quality",
    lines: [
      noDataLine("New website records added"),
      outcomesLine,
      noDataLine("Missing fields that blocked better answers"),
      noDataLine("Stale or inconsistent website areas"),
      noDataLine("Private data risks detected"),
    ],
  };
}

/** Every line here needs an assistant-side judgement the relay does not make — no source in this slice. */
function learningSection(): ReportSection {
  return {
    title: "Learning and Enrichment",
    lines: [
      noDataLine("New preferences learned"),
      noDataLine("New itinerary decisions captured"),
      noDataLine("Follow-up questions asked"),
      noDataLine("Follow-ups answered"),
      noDataLine("Unstructured inputs converted into structured records"),
    ],
  };
}

/**
 * "Top 3 missing items" is now real — the missing-information control loop
 * (Sprint 6 build list, decision 22: "detect a missing fact, record it,
 * show the top missing items in the daily report"). Grouped by tool name
 * (the closed, bounded dimension `missing_data` events carry — see
 * contract.ts's `TOOL_NAMES`), descending by count, capped at 3; empty when
 * no Hermes plugin reported a missing-data fact that day. The other two
 * lines are decision 22's explicitly deferred two-thirds — generating the
 * organizer-facing request text, and tracking whether it was fulfilled —
 * next sprint's work, not this one's.
 */
function organizerEnablementSection(rollup: DayRollup): ReportSection {
  const byTool = rollup.assistant_tool_outcomes.missing_data_by_tool;
  const top3 = Object.entries(byTool).sort(([, a], [, b]) => b - a).slice(0, 3);
  const topMissingLine = top3.length === 0
    ? noDataLine("Top 3 missing items to request from the organizer")
    : line("Top 3 missing items to request from the organizer", top3.map(([tool, n]) => `${tool}: ${n}`).join(", "));
  return {
    title: "Organizer Enablement",
    lines: [
      topMissingLine,
      noDataLine("The traveler value unlocked by each item"),
      noDataLine("Suggested message to ask for those items"),
    ],
  };
}

/**
 * The daily control-plan report for one trip's one local day, from a
 * `DayRollup` alone (`emptyDayRollup` for a day with no rows). Returns both
 * renderings of the same `DailyReport`, so they cannot disagree.
 */
export function renderDailyReport(rollup: DayRollup): { json: DailyReport; markdown: string } {
  const rates = deriveRates(rollup);
  const json: DailyReport = {
    trip_id: rollup.trip_id,
    local_day: rollup.local_day,
    notes: [
      ...rates.known_limits,
      `two rates are not measurable this slice: traveller self-service rate, post-write trust rate — ${rates.not_measurable.traveller_self_service_rate.reason}`,
    ],
    sections: [
      usageSection(rollup, rates),
      judgeSection(rollup, rates),
      valueDeliveredSection(rollup, rates),
      informationQualitySection(rollup, rates),
      learningSection(),
      organizerEnablementSection(rollup),
    ],
  };
  return { json, markdown: toMarkdown(json) };
}

function toMarkdown(report: DailyReport): string {
  const lines: string[] = [];
  lines.push(`# Daily control-plan report — trip ${report.trip_id}, ${report.local_day}`);
  lines.push("");
  for (const note of report.notes) lines.push(`> ${note}`);
  if (report.notes.length > 0) lines.push("");
  for (const section of report.sections) {
    lines.push(`## ${section.title}`);
    lines.push("");
    for (const item of section.lines) lines.push(`- **${item.label}:** ${item.value}`);
    lines.push("");
  }
  return lines.join("\n").replace(/\n+$/, "\n");
}
