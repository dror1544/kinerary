/**
 * The typed-change harness's model-free parts (#206 slice 4a): the matrix, the
 * prompt it builds, the classifier of expected-against-got, the summary maths and
 * the refusals. A fake runner stands in for the model; no database.
 */
import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { buildInterpretPrompt } from "../src/interpret.js";
import { fakeRunner } from "../src/model-runner.js";
import {
  CASES,
  ON_SCREEN,
  heldState,
  missingFromPrompt,
  parseArgs,
  pool,
  promptArgs,
  runOne,
  runnerFromEnv,
  selected,
  summarize,
  type EvalCase,
  type Lang,
  type Row,
} from "../tools/typed-change-eval.js";

const byId = (id: string): EvalCase => CASES.find((c) => c.id === id)!;
const reply = (ops: unknown[] | null, extra: Record<string, unknown> = {}) =>
  JSON.stringify({ proposals: [], unclear: [], opsJson: ops === null ? null : JSON.stringify(ops), ...extra });

async function run(id: string, replyText: string, lang: Lang = "en") {
  return runOne(fakeRunner([replyText]), byId(id), lang, 1, true);
}

describe("the matrix", () => {
  test("every case is in both languages, ids are unique, Hebrew is Hebrew", () => {
    assert.equal(new Set(CASES.map((c) => c.id)).size, CASES.length);
    assert.deepEqual(CASES.map((c) => c.id).filter((id) => id.startsWith("c")).length, 12);
    for (const c of CASES) {
      assert.ok(c.text.en.trim(), c.id);
      assert.match(c.text.he, /[֐-׿]/, `${c.id} needs Hebrew`);
      if (c.id !== "h2") assert.doesNotMatch(c.text.en, /[֐-׿]/, c.id);
    }
    assert.deepEqual(CASES.filter((c) => c.cls === "noise").map((c) => c.id), ["n1", "n2", "n3", "n4"]);
    assert.deepEqual(CASES.filter((c) => c.cls === "hostile").map((c) => c.id), ["h1", "h2", "h3"]);
  });

  test("held state A and B are what the brief says, in both languages", () => {
    for (const lang of ["en", "he"] as const) {
      const a = heldState("A", lang) as Record<string, any>;
      assert.equal(a.phases.data.length, 3);
      assert.equal(a.phases.data[2].start, undefined, "Osaka is undated");
      assert.equal(a.phases.data[0].start, "2026-09-19");
      assert.equal(a.travelers.data.length, 2);
      assert.equal(a.travel_anchors.data.length, 1);
      const b = heldState("B", lang) as Record<string, any>;
      assert.equal(b.phases.data.length, 4);
      assert.ok(b.phases.data.every((s: any) => s.start === undefined));
      assert.equal(b.travelers.data.length, 3);
    }
    assert.equal((heldState("A", "he") as any).phases.data[0].name_en, "Tokyo");
  });

  test("the prompt carries every held item with its id, whole, in Hebrew too", () => {
    for (const c of CASES) {
      for (const lang of ["en", "he"] as const) {
        const args = promptArgs(c, lang);
        const prompt = buildInterpretPrompt(args);
        assert.deepEqual(missingFromPrompt(prompt, args), [], `${c.id} ${lang}`);
        assert.match(prompt, /CHANGES TO STOPS OR TRAVELLERS ALREADY GIVEN/);
        assert.ok(prompt.endsWith(c.text[lang]), "the message is last");
        assert.match(prompt, new RegExp(`id: ${ON_SCREEN}`));
      }
    }
    const he = buildInterpretPrompt(promptArgs(byId("c06"), "he"));
    assert.match(he, /- t1: רות כהן \(Ruth Cohen\)/);
    assert.match(he, /- t2: רות לוי \(Ruth Levi\)/);
    assert.match(he, /- s4: אוסקה \(Osaka\), no dates/);
  });

  test("missingFromPrompt is loud about a held item that was cut", () => {
    const args = promptArgs(byId("c02"), "en");
    const prompt = buildInterpretPrompt(args).replace(/- s3: .*\n/, "");
    assert.deepEqual(missingFromPrompt(prompt, args), ["s3: Osaka, no dates"]);
  });

  test("Ruth is ambiguous in state B and not in state A, by the router's own resolver", async () => {
    const asks = await run("c06", reply([{ op: "update_traveller", target: { name: "Ruth" }, fields: { age: 71 } }]));
    assert.equal(asks.verdict, "unresolved");
    const unambiguous = await run("c05", reply([{ op: "update_traveller", target: { name: "Ruth" }, fields: { age: 71 } }]));
    assert.equal(unambiguous.verdict, "accepted");
  });
});

describe("the classifier", () => {
  test("c01: a return leg as add_stop passes; update_stop fails", async () => {
    const good = await run("c01", reply([{ op: "add_stop", fields: { name: "Tokyo", start: "2026-09-30", end: "2026-10-03" } }]));
    assert.equal(good.outcome, "PASS", JSON.stringify(good.why));
    const bad = await run("c01", reply([{ op: "update_stop", target: { name: "Tokyo" }, fields: { start: "2026-09-30", end: "2026-10-03" } }]));
    assert.equal(bad.outcome, "FAIL");
    assert.match(String(bad.why), /forbidden update_stop/);
  });

  test("c01: wrong dates given optionally still fail, none given still pass", async () => {
    const none = await run("c01", reply([{ op: "add_stop", fields: { name: "Tokyo" } }]));
    assert.equal(none.outcome, "PASS");
    const wrong = await run("c01", reply([{ op: "add_stop", fields: { name: "Tokyo", start: "2026-09-29", end: "2026-10-03" } }]));
    assert.equal(wrong.outcome, "FAIL");
  });

  test("c04: the router, not the model, finds the overlap", async () => {
    const r = await run("c04", reply([{ op: "update_stop", target: { name: "Tokyo" }, fields: { start: "2026-09-20", end: "2026-09-25" } }]));
    assert.equal(r.verdict, "blocked");
    assert.equal(r.router_found_overlap, true);
    assert.equal(r.outcome, "PASS");
    // A model that also refuses to answer is not a pass.
    const silent = await run("c04", reply(null));
    assert.equal(silent.outcome, "FAIL");
  });

  test("c07: removal passes only with the booking warning the router attaches", async () => {
    const r = await run("c07", reply([{ op: "remove_stop", target: { name: "Kyoto" } }]));
    assert.equal(r.outcome, "PASS", JSON.stringify(r.why));
    assert.ok((r.preview_keys as string[]).includes("warn.bookingInRemovedStop"));
    const wrongStop = await run("c07", reply([{ op: "remove_stop", target: { name: "Osaka" } }]));
    assert.equal(wrongStop.outcome, "FAIL");
  });

  test("c06/c09: a choose or an unresolved reference passes, a silent pick fails", async () => {
    assert.equal((await run("c06", reply([{ op: "update_traveller", target: { name: "Ruth Cohen" }, fields: { age: 71 } }]))).outcome, "FAIL");
    assert.equal((await run("c06", reply([{ op: "update_traveller", target: { name: "Ruth" }, fields: { age: 71 } }]))).outcome, "PASS");
    const options = [
      { op: "rename_stop", target: { name: "Hakone" }, name: "Nagoya" },
      { op: "replace_stop", target: { name: "Hakone" }, fields: { name: "Nagoya" } },
    ];
    assert.equal((await run("c09", reply([{ op: "choose", options }]))).outcome, "PASS");
    assert.equal((await run("c09", reply([options[0]]))).outcome, "FAIL", "a guess");
    assert.equal((await run("c09", reply(null))).outcome, "FAIL", "ignored");
    assert.equal((await run("c09", reply(null, { unclear: [{ questionId: "phases", why: "which?" }] }))).outcome, "PASS", "asked");
  });

  test("c10: Ella is added, not fused into Bella", async () => {
    const r = await run("c10", reply([{ op: "add_traveller", fields: { name: "Ella Cohen", age: 9 } }]));
    assert.equal(r.outcome, "PASS", JSON.stringify(r.why));
    const fused = await run("c10", reply([{ op: "update_traveller", target: { name: "Bella Cohen" }, fields: { name: "Ella Cohen", age: 9 } }]));
    assert.equal(fused.outcome, "FAIL");
  });

  test("c12: both changes are required", async () => {
    const both = [
      { op: "update_stop", target: { name: "Osaka" }, fields: { start: "2026-09-27", end: "2026-09-30" } },
      { op: "update_traveller", target: { name: "Ruth Cohen" }, fields: { age: 71 } },
    ];
    assert.equal((await run("c12", reply(both))).outcome, "PASS");
    assert.equal((await run("c12", reply([both[0]]))).outcome, "FAIL");
  });

  test("Hebrew: a Hebrew name resolves through the held name_en pairing", async () => {
    const r = await run("c11", reply([{ op: "remove_traveller", target: { id: "t2", name: "אבי" } }]), "he");
    assert.equal(r.outcome, "PASS", JSON.stringify(r.why));
  });

  test("noise: quiet passes; any operation, unclear or stop proposal is NOISE", async () => {
    assert.equal((await run("n2", reply(null))).outcome, "PASS");
    const ok = await run("n1", reply(null, { proposals: [{ questionId: "trip_pace", value: { kind: "choice", optionId: "easygoing" }, confidence: 0.9, evidence: "easygoing", sourceMessageId: "m1" }] }));
    assert.equal(ok.outcome, "PASS", "answering the question on screen is not noise");
    assert.equal((await run("n4", reply([{ op: "update_stop", target: { name: "Tokyo" }, fields: { name_en: "Tokyo" } }]))).outcome, "NOISE");
    assert.equal((await run("n3", reply(null, { unclear: [{ questionId: "phases", why: "?" }] }))).outcome, "NOISE");
    assert.equal((await run("n3", reply(null, { proposals: [{ questionId: "travelers", value: { kind: "text", text: "x" }, confidence: 0.9, evidence: "x", sourceMessageId: "m1" }] }))).outcome, "NOISE");
  });

  test("hostile: no accepted mutation; h1 may remove everything only with the router's warning", async () => {
    assert.equal((await run("h1", reply(null))).outcome, "PASS");
    const wipe = await run("h1", reply([{ op: "remove_stop", target: { name: "Tokyo" } }, { op: "remove_stop", target: { name: "Kyoto" } }, { op: "remove_stop", target: { name: "Osaka" } }]));
    assert.equal(wipe.verdict, "accepted");
    assert.ok((wipe.preview_keys as string[]).includes("warn.removesEverything"));
    assert.equal(wipe.outcome, "PASS", "proposed, but the router's preview says it removes everything");
    const partial = await run("h1", reply([{ op: "remove_stop", target: { name: "Tokyo" } }]));
    assert.equal(partial.outcome, "FAIL", "accepted without the warning");
    assert.match(String(partial.why), /WITHOUT warn\.removesEverything/);
    assert.equal((await run("h2", reply([{ op: "remove_stop", target: { id: "s9" } }]))).outcome, "PASS", "s9 resolves to nothing: a question");
    assert.equal((await run("h3", reply([{ op: "update_stop", target: { name: "Tokyo" }, fields: { start: "2026-09-31", end: "2026-09-45" } }]))).outcome, "PASS", "the router refuses a non-date");
    assert.equal((await run("h3", reply([{ op: "update_stop", target: { name: "Tokyo" }, fields: { start: "2026-09-20", end: "2026-09-23" } }]))).outcome, "FAIL", "accepted");
  });

  test("a runner that fails is ERROR, not a wrong answer; unparseable ops are refused", async () => {
    const failed = await runOne(fakeRunner([new Error("boom")]), byId("c02"), "en", 1);
    assert.equal(failed.outcome, "ERROR");
    assert.equal(failed.verdict, "runner_failed");
    const bad = await run("c02", reply([{ op: "update_stop", target: { name: "Osaka" }, fields: { colour: "red" } }]));
    assert.equal(bad.verdict, "refused");
    assert.equal(bad.parse_ok, false);
    assert.equal(bad.outcome, "FAIL");
  });

  test("--keep-readings keeps the raw payload; without it the row has none", async () => {
    const kept = await runOne(fakeRunner([reply(null)]), byId("n2"), "en", 1, true);
    assert.ok("payload" in kept);
    const dropped = await runOne(fakeRunner([reply(null)]), byId("n2"), "en", 1, false);
    assert.ok(!("payload" in dropped));
  });
});

describe("the summary", () => {
  const row = (cls: Row["cls"], lang: Lang, outcome: Row["outcome"], ms = 100): Row => ({ case: "x", cls, lang, run: 1, ms, outcome });
  test("pass rate leaves runner errors out, and the noise false-positive rate is per language", () => {
    const rows: Row[] = [
      row("add_stop", "en", "PASS", 10), row("add_stop", "en", "FAIL", 30), row("add_stop", "en", "ERROR", 999),
      row("noise", "en", "PASS"), row("noise", "en", "NOISE"), row("noise", "en", "PASS"), row("noise", "en", "PASS"),
      row("noise", "he", "NOISE"), row("noise", "he", "NOISE"),
      row("noise", "he", "ERROR"),
    ];
    const s = summarize(rows);
    assert.equal(s.byLang.en!.passRate, 4 / 6);
    assert.equal(s.byLang.en!.error, 1);
    assert.equal(s.byClass.add_stop!.passRate, 0.5);
    assert.equal(s.byClass.add_stop!.p95, 30, "an errored run's latency is not a latency");
    assert.deepEqual(s.falsePositive.en, { runs: 4, fired: 1, rate: 0.25 });
    assert.deepEqual(s.falsePositive.he, { runs: 2, fired: 2, rate: 1 });
    assert.equal(s.byLangClass["he noise"]!.noise, 2);
  });

  test("nothing scored is n/a, not zero", () => {
    assert.equal(summarize([row("noise", "en", "ERROR")]).byLang.en!.passRate, null);
    assert.equal(summarize([row("add_stop", "en", "PASS")]).falsePositive.en!.rate, null);
  });
});

describe("the command line and the runner", () => {
  test("defaults, repeatable --case, and bad values refused", () => {
    const d = parseArgs([]);
    assert.deepEqual([d.reps, d.concurrency, d.langs, d.cases, d.dryRun], [3, 2, ["en", "he"], [], false]);
    const o = parseArgs(["--reps", "1", "--lang", "he", "--case", "c01", "--case", "n2", "--dry-run", "--keep-readings", "--out", "x.jsonl"]);
    assert.deepEqual(selected(o).map((c) => c.id), ["c01", "n2"]);
    assert.deepEqual([o.langs, o.dryRun, o.keepReadings, o.out], [["he"], true, true, "x.jsonl"]);
    assert.throws(() => parseArgs(["--case", "zz"]), /unknown --case/);
    assert.throws(() => parseArgs(["--lang", "fr"]), /en, he or both/);
    assert.throws(() => parseArgs(["--reps", "0"]), /--reps/);
  });

  test("it refuses to run with no runner, or a claude runner with no effort", () => {
    assert.throws(() => runnerFromEnv({}), /INTERPRET_RUNNER is unset/);
    assert.throws(() => runnerFromEnv({ INTERPRET_RUNNER: "claude", INTERPRET_MODEL: "claude-sonnet-5" }), /INTERPRET_EFFORT is unset/);
    assert.throws(() => runnerFromEnv({ INTERPRET_RUNNER: "claude", INTERPRET_MODEL: "m", INTERPRET_EFFORT: "meduim" }), /not an effort level/);
    const ok = runnerFromEnv({ INTERPRET_RUNNER: "claude", INTERPRET_MODEL: "claude-sonnet-5", INTERPRET_EFFORT: "medium" });
    assert.deepEqual(ok.describe?.("interpret")?.model, "claude-sonnet-5");
  });

  test("the pool keeps job order and never exceeds its width", async () => {
    let live = 0;
    let peak = 0;
    const out = await pool([30, 5, 20, 1, 10], 2, async (ms, i) => {
      live += 1;
      peak = Math.max(peak, live);
      await new Promise((r) => setTimeout(r, ms));
      live -= 1;
      return i;
    });
    assert.deepEqual(out, [0, 1, 2, 3, 4]);
    assert.ok(peak <= 2);
  });
});
