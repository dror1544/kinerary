// runner-probe.mjs — one structured call through the interview's own
// model-runner (dist/model-runner.js inside the relay image), with the runner
// named on the command line. The same code path the relay's interpret step
// uses, so "this runner works" is read off a real call, not a login file.
//
//   node runner-probe.mjs <claude|codex|openrouter> [model]
const [runnerKind, model = ""] = process.argv.slice(2);
const m = await import("/app/dist/model-runner.js");
const runner = m.modelRunnerFromEnv({ ...process.env, INTERPRET_RUNNER: runnerKind, INTERPRET_MODEL: model });
if (!runner) {
  console.log(JSON.stringify({ runner: runnerKind, ok: false, reason: "NOT_CONFIGURED" }));
  process.exit(1);
}
const res = await runner.run({
  task: "interpret",
  prompt: 'The organizer was asked "What should the trip assistant be called?" and replied "Sol". ' +
    'Reply with ONLY this JSON object: {"questionId": "assistant_name", "value": "<the name>"}',
  parse: (x) => (x && typeof x === "object" && x.questionId === "assistant_name" && typeof x.value === "string" ? x : null),
  schema: { type: "object", properties: { questionId: { type: "string" }, value: { type: "string" } },
            required: ["questionId", "value"], additionalProperties: false },
});
console.log(JSON.stringify({ runner: runnerKind, model: model || "(runner default)", ok: res.ok, value: res.value,
  reason: res.reason, detail: (res.detail || "").slice(0, 160), attempts: res.attempts, ms: res.ms }));
process.exit(res.ok ? 0 : 1);
