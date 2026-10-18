/**
 * The group judge's offline benchmark: a labelled set of messages through the
 * configured judge, scored for the targets the owner set on 2026-10-16 -
 * precision >= 90%, recall >= 75%, p95 <= 1.5 s, hard timeout 3 s.
 *
 * Pure with respect to the network: it takes a `StructuredModelRunner`, so the
 * unit test drives it with a fake and the CLI (tools/judge-benchmark.ts) gives
 * it the real one. It is NEVER run against a network model by the test suite.
 *
 * LABELS. `yes`: the message is meant for the trip assistant (a question about
 * the trip, a request for an action, a command in words). `no`: people talking
 * to each other. The starter set is SYNTHETIC - invented family-trip chatter in
 * Hebrew and English, no real traveller's words - and its borderline labels are
 * judgment calls the owner should re-read before trusting a score near a target.
 *
 * WHAT IS SCORED. Positive = "forward to the assistant". A labelled-yes message
 * the judge answered no, or could not answer at all (timeout, error, garbage),
 * is a miss - exactly what the relay does with it - so errors cost recall, as
 * they would in the group, and are also counted on their own. The confidence
 * threshold is swept offline from the raw verdicts (the judge runs with the
 * threshold at zero), so one pass prices every threshold.
 */
import {
  createGroupJudge,
  DEFAULT_MIN_CONFIDENCE,
  JudgeRateLimiter,
  type JudgeOutcome,
} from "./group-judge.js";
import { judgeTimeoutMs, type StructuredModelRunner } from "../model-runner.js";

export interface BenchmarkCase {
  id: string;
  text: string;
  label: "yes" | "no";
  lang: "he" | "en";
  /** Why the label, for a human reading the set. Never sent to the model. */
  note?: string;
}

/** Targets agreed with the owner, 2026-10-16. */
export const TARGETS = { precision: 0.9, recall: 0.75, p95Ms: 1500, hardTimeoutMs: 3000 } as const;

/**
 * Parses a JSONL set. Strict: a line that is not a valid case is an error with
 * its line number, not a silently smaller set (a benchmark that quietly drops
 * rows reports a score for a different test).
 */
export function parseCases(jsonl: string): BenchmarkCase[] {
  const cases: BenchmarkCase[] = [];
  const seen = new Set<string>();
  jsonl.split(/\r?\n/).forEach((raw, index) => {
    const line = raw.trim();
    if (!line || line.startsWith("#")) return;
    let value: unknown;
    try {
      value = JSON.parse(line);
    } catch {
      throw new Error(`line ${index + 1}: not JSON`);
    }
    const c = value as Partial<BenchmarkCase>;
    if (typeof c.id !== "string" || !c.id) throw new Error(`line ${index + 1}: missing id`);
    if (seen.has(c.id)) throw new Error(`line ${index + 1}: duplicate id ${c.id}`);
    if (typeof c.text !== "string" || !c.text.trim()) throw new Error(`line ${index + 1}: missing text`);
    if (c.label !== "yes" && c.label !== "no") throw new Error(`line ${index + 1}: label must be "yes" or "no"`);
    if (c.lang !== "he" && c.lang !== "en") throw new Error(`line ${index + 1}: lang must be "he" or "en"`);
    seen.add(c.id);
    cases.push({ id: c.id, text: c.text, label: c.label, lang: c.lang, ...(typeof c.note === "string" ? { note: c.note } : {}) });
  });
  if (cases.length === 0) throw new Error("the set is empty");
  return cases;
}

export interface CaseResult {
  id: string;
  label: "yes" | "no";
  lang: "he" | "en";
  outcome: JudgeOutcome;
}

export interface ThresholdScore {
  threshold: number;
  tp: number;
  fp: number;
  fn: number;
  tn: number;
  /** null when the judge never said yes (nothing to be precise about). */
  precision: number | null;
  /** null when the set has no labelled yes. */
  recall: number | null;
}

export interface BenchmarkReport {
  cases: number;
  labelledYes: number;
  labelledNo: number;
  /** The score at `minConfidence`, the threshold the relay would run with. */
  at: ThresholdScore;
  sweep: ThresholdScore[];
  errors: { total: number; byReason: Record<string, number> };
  latencyMs: { p50: number | null; p95: number | null; max: number | null };
  /** Misses and false alarms at `minConfidence`, by case id - never the text. */
  falseNegatives: string[];
  falsePositives: string[];
  meetsTargets: { precision: boolean; recall: boolean; p95: boolean; allMet: boolean };
  model: string | null;
  minConfidence: number;
}

function percentile(sortedAsc: readonly number[], p: number): number | null {
  const n = sortedAsc.length;
  if (n === 0) return null;
  return sortedAsc[Math.min(n - 1, Math.max(0, Math.ceil((p / 100) * n) - 1))] ?? null;
}

function scoreAt(results: readonly CaseResult[], threshold: number): ThresholdScore {
  let tp = 0, fp = 0, fn = 0, tn = 0;
  for (const r of results) {
    // The judge ran with its threshold at zero, so "yes" is the model's raw
    // verdict; the threshold is applied here, exactly as the relay applies it.
    const said = r.outcome.kind === "yes" && r.outcome.confidence >= threshold;
    if (r.label === "yes") said ? (tp += 1) : (fn += 1);
    else said ? (fp += 1) : (tn += 1);
  }
  return {
    threshold,
    tp, fp, fn, tn,
    precision: tp + fp > 0 ? tp / (tp + fp) : null,
    recall: tp + fn > 0 ? tp / (tp + fn) : null,
  };
}

export interface BenchmarkOptions {
  runner: StructuredModelRunner;
  cases: readonly BenchmarkCase[];
  assistantNames?: readonly string[];
  minConfidence?: number;
  thresholds?: readonly number[];
  timeoutMs?: number;
  /** Passes over the whole set. Latency and errors are pooled; labels are scored per pass. */
  reps?: number;
  now?: () => number;
  onProgress?: (done: number, total: number) => void;
}

/** Runs the set through the judge one message at a time (latency is the point) and scores it. */
export async function runBenchmark(options: BenchmarkOptions): Promise<BenchmarkReport> {
  const minConfidence = options.minConfidence ?? DEFAULT_MIN_CONFIDENCE;
  const judge = createGroupJudge({
    runner: options.runner,
    // Raw verdicts: the threshold is applied in the scoring so one run prices all of them.
    minConfidence: 0,
    // The per-runner default (3 s for an HTTP call, 8 s for a CLI), as the relay would use.
    timeoutMs: options.timeoutMs ?? ((provider) => judgeTimeoutMs(process.env, provider).ms),
    // Sequential, so latency is the model's; and no circuit breaker: a benchmark that
    // lost its model half way should count the errors, not stop calling.
    concurrency: 1,
    breakerThreshold: Number.MAX_SAFE_INTEGER,
    // The relay's per-chat limit protects a group from a flood; a benchmark is not one.
    rateLimiter: new JudgeRateLimiter(1_000_000, options.now),
    ...(options.now ? { now: options.now } : {}),
  });
  const model = judge.model();
  if (!model) throw new Error("the group_judge task has no binding (set JUDGE_RUNNER and JUDGE_MODEL)");

  const names = options.assistantNames ?? ["Solo", "סולו"];
  const results: CaseResult[] = [];
  const reps = Math.max(1, options.reps ?? 1);
  const total = options.cases.length * reps;
  for (let rep = 0; rep < reps; rep += 1) {
    for (const c of options.cases) {
      const outcome = await judge.judge({ chatId: "benchmark", text: c.text, assistantNames: names, language: c.lang });
      results.push({ id: c.id, label: c.label, lang: c.lang, outcome });
      options.onProgress?.(results.length, total);
    }
  }

  const sweepAt = [...new Set([0.5, 0.6, 0.7, 0.8, 0.9, minConfidence])].sort((a, b) => a - b);
  const sweep = (options.thresholds ?? sweepAt).map((t) => scoreAt(results, t));
  const at = scoreAt(results, minConfidence);

  const byReason: Record<string, number> = {};
  for (const r of results) {
    if (r.outcome.kind === "fallback") byReason[r.outcome.reason] = (byReason[r.outcome.reason] ?? 0) + 1;
  }
  const latencies = results.map((r) => r.outcome.ms).sort((a, b) => a - b);
  const p50 = percentile(latencies, 50);
  const p95 = percentile(latencies, 95);

  const said = (r: CaseResult) => r.outcome.kind === "yes" && r.outcome.confidence >= minConfidence;
  const precisionOk = at.precision !== null && at.precision >= TARGETS.precision;
  const recallOk = at.recall !== null && at.recall >= TARGETS.recall;
  const p95Ok = p95 !== null && p95 <= TARGETS.p95Ms;
  return {
    cases: total,
    labelledYes: results.filter((r) => r.label === "yes").length,
    labelledNo: results.filter((r) => r.label === "no").length,
    at,
    sweep,
    errors: { total: Object.values(byReason).reduce((a, b) => a + b, 0), byReason },
    latencyMs: { p50, p95, max: latencies.length ? latencies[latencies.length - 1]! : null },
    falseNegatives: results.filter((r) => r.label === "yes" && !said(r)).map((r) => r.id),
    falsePositives: results.filter((r) => r.label === "no" && said(r)).map((r) => r.id),
    meetsTargets: { precision: precisionOk, recall: recallOk, p95: p95Ok, allMet: precisionOk && recallOk && p95Ok },
    model,
    minConfidence,
  };
}

const pct = (v: number | null) => (v === null ? "n/a" : `${(v * 100).toFixed(1)}%`);
const ms = (v: number | null) => (v === null ? "n/a" : `${v} ms`);

/** The report as the text the CLI prints. Ids only - no message text. */
export function formatReport(report: BenchmarkReport): string {
  const lines = [
    `group judge benchmark - model ${report.model}, ${report.cases} calls (${report.labelledYes} labelled yes, ${report.labelledNo} labelled no)`,
    "",
    `at confidence >= ${report.minConfidence}:`,
    `  precision ${pct(report.at.precision)} (target >= ${pct(TARGETS.precision)})  ${report.meetsTargets.precision ? "ok" : "MISSED"}`,
    `  recall    ${pct(report.at.recall)} (target >= ${pct(TARGETS.recall)})  ${report.meetsTargets.recall ? "ok" : "MISSED"}`,
    `  tp ${report.at.tp}  fp ${report.at.fp}  fn ${report.at.fn}  tn ${report.at.tn}`,
    `latency p50 ${ms(report.latencyMs.p50)}  p95 ${ms(report.latencyMs.p95)} (target <= ${TARGETS.p95Ms} ms)  ${report.meetsTargets.p95 ? "ok" : "MISSED"}  max ${ms(report.latencyMs.max)}`,
    `errors ${report.errors.total}${report.errors.total ? ` (${Object.entries(report.errors.byReason).map(([k, v]) => `${k} ${v}`).join(", ")})` : ""}`,
    "",
    "threshold sweep (precision / recall):",
    ...report.sweep.map((s) => `  >= ${s.threshold.toFixed(2)}  ${pct(s.precision)} / ${pct(s.recall)}  (fp ${s.fp}, fn ${s.fn})`),
    "",
    `missed (labelled yes, not forwarded): ${report.falseNegatives.join(", ") || "none"}`,
    `false alarms (labelled no, forwarded): ${report.falsePositives.join(", ") || "none"}`,
    "",
    report.meetsTargets.allMet ? "ALL TARGETS MET" : "TARGETS NOT MET",
  ];
  return lines.join("\n");
}
