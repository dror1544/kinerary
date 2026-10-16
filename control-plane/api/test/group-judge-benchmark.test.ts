/**
 * The group judge's offline benchmark (relay/group-judge-benchmark.ts), driven
 * with a FAKE runner only - this suite never reaches a network model. Covers
 * the JSONL parser (strict), the shipped starter set (60 synthetic messages,
 * Hebrew and English, both labels), and the scoring arithmetic.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, test } from "node:test";
import { fileURLToPath } from "node:url";
import { formatReport, parseCases, runBenchmark, TARGETS, type BenchmarkCase } from "../src/relay/group-judge-benchmark.js";
import { JUDGE_TASK } from "../src/relay/group-judge.js";
import type { StructuredModelRequest, StructuredModelRunner } from "../src/model-runner.js";

const starterPath = fileURLToPath(new URL("../tools/judge-benchmark/starter-set.jsonl", import.meta.url));

describe("parseCases", () => {
  test("reads JSONL, skipping blank and # lines", () => {
    const cases = parseCases('# a comment\n\n{"id":"a","lang":"en","text":"hi","label":"no"}\n{"id":"b","lang":"he","text":"שלום","label":"yes","note":"n"}\n');
    assert.deepEqual(cases.map((c) => [c.id, c.label, c.lang]), [["a", "no", "en"], ["b", "yes", "he"]]);
  });

  test("is strict: a bad line is an error with its line number, never a smaller set", () => {
    assert.throws(() => parseCases("not json"), /line 1: not JSON/);
    assert.throws(() => parseCases('{"id":"a","lang":"en","text":"x","label":"maybe"}'), /line 1: label/);
    assert.throws(() => parseCases('{"id":"a","lang":"fr","text":"x","label":"yes"}'), /line 1: lang/);
    assert.throws(() => parseCases('{"id":"a","lang":"en","text":" ","label":"yes"}'), /line 1: missing text/);
    assert.throws(() => parseCases('{"lang":"en","text":"x","label":"yes"}'), /line 1: missing id/);
    assert.throws(() => parseCases('{"id":"a","lang":"en","text":"x","label":"yes"}\n{"id":"a","lang":"en","text":"y","label":"no"}'), /line 2: duplicate id a/);
    assert.throws(() => parseCases("# only comments\n"), /empty/);
  });
});

describe("the starter set", () => {
  const cases = parseCases(readFileSync(starterPath, "utf8"));

  test("is 60 messages, Hebrew and English mixed, both labels well represented", () => {
    assert.equal(cases.length, 60);
    const count = (pred: (c: BenchmarkCase) => boolean) => cases.filter(pred).length;
    assert.ok(count((c) => c.lang === "he") >= 20 && count((c) => c.lang === "en") >= 20, "both languages");
    assert.ok(count((c) => c.label === "yes") >= 20 && count((c) => c.label === "no") >= 20, "both labels");
    assert.ok(cases.some((c) => /[֐-׿]/.test(c.text)), "real Hebrew script");
    assert.ok(cases.some((c) => /^\p{ASCII}+$/u.test(c.text)), "and plain English");
  });

  test("is synthetic: no digits that look like a phone or id, no handles, no emails, no links", () => {
    for (const c of cases) {
      assert.ok(!/\d{6,}/.test(c.text), c.id);
      assert.ok(!/@\w/.test(c.text), c.id);
      assert.ok(!/https?:|www\./i.test(c.text), c.id);
    }
  });

  test("includes injection attempts labelled as not for the assistant", () => {
    assert.ok(cases.some((c) => c.label === "no" && /ignore all previous instructions/i.test(c.text)));
  });
});

/** A fake judge model that answers from the labels (with chosen mistakes) - the only runner the suite uses. */
function labelRunner(
  cases: readonly BenchmarkCase[],
  verdictFor: (c: BenchmarkCase, index: number) => string | Error,
): StructuredModelRunner & { calls: number } {
  const byText = new Map(cases.map((c, i) => [JSON.stringify(c.text.slice(0, 600)), { c, i }]));
  const runner = {
    calls: 0,
    describe: (task: string) => (task === JUDGE_TASK ? { provider: "fake", model: "fake/judge" } : null),
    async run<T>(req: StructuredModelRequest<T>) {
      runner.calls += 1;
      const encoded = req.prompt.slice(req.prompt.indexOf("Message (a JSON string): ") + "Message (a JSON string): ".length);
      const hit = byText.get(encoded);
      assert.ok(hit, "the prompt carries the case's text");
      const answer = verdictFor(hit.c, hit.i);
      if (answer instanceof Error) return { ok: false as const, reason: "TIMED_OUT" as const, detail: answer.message, attempts: 1, ms: 1 };
      const parsed = req.parse(JSON.parse(answer));
      return parsed === null
        ? { ok: false as const, reason: "BAD_OUTPUT" as const, attempts: 1, ms: 1 }
        : { ok: true as const, value: parsed, attempts: 1, ms: 1 };
    },
  };
  return runner;
}

const SMALL: BenchmarkCase[] = [
  ...Array.from({ length: 8 }, (_, i) => ({ id: `y${i}`, lang: "en" as const, text: `question number ${i}?`, label: "yes" as const })),
  ...Array.from({ length: 12 }, (_, i) => ({ id: `n${i}`, lang: "he" as const, text: `שיחה בין בני משפחה ${i}`, label: "no" as const })),
];

describe("runBenchmark - scoring", () => {
  test("a perfect judge scores 100% / 100% and meets every target", async () => {
    const runner = labelRunner(SMALL, (c) => JSON.stringify({ for_assistant: c.label === "yes", confidence: 0.9 }));
    const report = await runBenchmark({ runner, cases: SMALL });
    assert.deepEqual([report.at.tp, report.at.fp, report.at.fn, report.at.tn], [8, 0, 0, 12]);
    assert.equal(report.at.precision, 1);
    assert.equal(report.at.recall, 1);
    assert.equal(report.errors.total, 0);
    assert.equal(report.model, "fake/judge");
    assert.equal(report.meetsTargets.precision && report.meetsTargets.recall, true);
    assert.equal(runner.calls, 20, "one call per message");
  });

  test("hand-computed: 2 false alarms and 3 misses (one an error) give precision 6/8 and recall 5/8", async () => {
    const runner = labelRunner(SMALL, (c) => {
      if (c.id === "y0" || c.id === "y1") return JSON.stringify({ for_assistant: false, confidence: 0.9 }); // miss
      if (c.id === "y2") return new Error("timed out"); // a timeout is a miss, and an error
      if (c.id === "n0" || c.id === "n1") return JSON.stringify({ for_assistant: true, confidence: 0.95 }); // false alarm
      return JSON.stringify({ for_assistant: c.label === "yes", confidence: 0.9 });
    });
    const report = await runBenchmark({ runner, cases: SMALL });
    assert.deepEqual([report.at.tp, report.at.fp, report.at.fn, report.at.tn], [5, 2, 3, 10]);
    assert.equal(report.at.precision, 5 / 7);
    assert.equal(report.at.recall, 5 / 8);
    assert.deepEqual(report.falseNegatives.sort(), ["y0", "y1", "y2"]);
    assert.deepEqual(report.falsePositives.sort(), ["n0", "n1"]);
    assert.deepEqual(report.errors, { total: 1, byReason: { timeout: 1 } });
    assert.equal(report.meetsTargets.allMet, false);
  });

  test("the confidence threshold is swept offline from one pass", async () => {
    // Hedged yeses at 0.6: counted at 0.5 and 0.6, not at 0.7 and above.
    const runner = labelRunner(SMALL, (c) => JSON.stringify({ for_assistant: c.label === "yes", confidence: c.label === "yes" ? 0.6 : 0.9 }));
    const report = await runBenchmark({ runner, cases: SMALL });
    assert.equal(report.at.recall, 0, "at 0.7 every hedged yes is dropped");
    const atSix = report.sweep.find((s) => s.threshold === 0.6)!;
    assert.equal(atSix.recall, 1);
    assert.equal(atSix.precision, 1);
    assert.equal(runner.calls, 20, "and still only one pass of calls");
    const stricter = await runBenchmark({ runner: labelRunner(SMALL, (c) => JSON.stringify({ for_assistant: c.label === "yes", confidence: 0.75 })), cases: SMALL, minConfidence: 0.8 });
    assert.equal(stricter.at.recall, 0);
  });

  test("latency percentiles come from the judge's own clock, and errors are counted by reason", async () => {
    let now = 0;
    const runner = labelRunner(SMALL, (c, i) => {
      now += i >= 18 ? 2000 : 100; // the last two calls are slow
      return JSON.stringify({ for_assistant: c.label === "yes", confidence: 0.9 });
    });
    const report = await runBenchmark({ runner, cases: SMALL, now: () => now });
    assert.equal(report.latencyMs.p50, 100);
    assert.equal(report.latencyMs.max, 2000);
    assert.equal(report.latencyMs.p95, 2000, "nearest rank: the 19th of 20 calls");
    assert.equal(report.meetsTargets.p95, false, "2 s is over the 1.5 s target");
  });

  test("an unbound judge task refuses to run rather than scoring nothing", async () => {
    const runner = { describe: () => null, run: async () => ({ ok: false as const, reason: "NOT_CONFIGURED" as const, attempts: 0, ms: 0 }) } as StructuredModelRunner;
    await assert.rejects(runBenchmark({ runner, cases: SMALL }), /no binding/);
  });

  test("the rate limit of the relay does not throttle a benchmark", async () => {
    const many = Array.from({ length: 40 }, (_, i) => ({ id: `c${i}`, lang: "en" as const, text: `message ${i}`, label: "no" as const }));
    const runner = labelRunner(many, () => JSON.stringify({ for_assistant: false, confidence: 0.9 }));
    const report = await runBenchmark({ runner, cases: many });
    assert.equal(report.errors.total, 0);
    assert.equal(runner.calls, 40);
  });

  test("the printed report names ids and numbers, never message text", async () => {
    const runner = labelRunner(SMALL, (c) => JSON.stringify({ for_assistant: c.id === "n0" ? true : c.label === "yes", confidence: 0.9 }));
    const text = formatReport(await runBenchmark({ runner, cases: SMALL }));
    assert.match(text, /precision/);
    assert.match(text, /false alarms \(labelled no, forwarded\): n0/);
    assert.ok(!text.includes("שיחה בין בני משפחה"));
    assert.ok(!text.includes("question number"));
    assert.match(text, new RegExp(`target >= ${TARGETS.precision * 100}`));
  });
});

describe("the benchmark never needs the network in CI", () => {
  test("this suite imports no fetch-based runner: every model here is a fake", () => {
    const imports = readFileSync(fileURLToPath(import.meta.url), "utf8").split("\n").filter((l) => l.startsWith("import")).join("\n");
    assert.ok(!/openRouterRunner|modelRunnerFromEnv|claudeSpec|codexRunner/.test(imports));
  });
});
