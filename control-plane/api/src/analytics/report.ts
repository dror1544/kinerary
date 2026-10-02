/**
 * The daily control-plan report — issue #326, Track 2's second slice.
 *
 * Renders the five sections `control-plan-metrics.md` ("Suggested Daily
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
    ],
  };
}

/** Every line here needs an assistant-side judgement the relay does not make — no source in this slice. */
function valueDeliveredSection(): ReportSection {
  return {
    title: "Value Delivered",
    lines: [
      noDataLine("Questions answered from verified website data"),
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

/** Every line here needs an assistant-side judgement the relay does not make — no source in this slice. */
function organizerEnablementSection(): ReportSection {
  return {
    title: "Organizer Enablement",
    lines: [
      noDataLine("Top 3 missing items to request from the organizer"),
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
      `four rates are not measurable this slice: grounded-answer rate, missing-data rate, traveller self-service rate, post-write trust rate — ${rates.not_measurable.grounded_answer_rate.reason}`,
    ],
    sections: [
      usageSection(rollup, rates),
      valueDeliveredSection(),
      informationQualitySection(rollup, rates),
      learningSection(),
      organizerEnablementSection(),
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
