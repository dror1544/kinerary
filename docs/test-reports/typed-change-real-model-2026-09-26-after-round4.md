# Typed changes (#206) — real-model run after round 4, 2026-09-26

**What it is.** The production interpret prompt and parser (`control-plane/api/tools/typed-change-eval.ts`), run against a real model in English and Hebrew on held interview states — the acceptance run #206 said was owed before any deploy, repeated after round 4 of PR #199 (commit `c9b86ea`, merged as `423e1a4`) because round 4 changed how model-supplied names are parsed and matched.

**Conditions.** Tree `72a288b` (integration/sprint-6). Runner as configured in CLAUDE.md ("The interview has no agent…"): `INTERPRET_RUNNER=claude INTERPRET_MODEL=claude-sonnet-5 INTERPRET_EFFORT=medium`, set explicitly (the deploy env file was not sourced). 3 repetitions × 19 cases × 2 languages = **114 calls**, concurrency 2, p50 about 6.2 s per call, p95 about 9.3 s. Prompts were first built with `--dry-run`: 38 prompts, 0 held items missing from a prompt. Token cost is unmeasured (the CLI runner reports no usage).

## Result

| | runs | pass | fail | error |
|---|---|---|---|---|
| English | 57 | 56 | 0 | 1 |
| Hebrew | 57 | 57 | 0 | 0 |
| **Total** | **114** | **113** | **0** | **1** |

The five things the harness says to look at, in its own order:

1. **False positives on ordinary messages (`noise`): 0/12 English, 0/12 Hebrew.** No confirmation card appears under an ordinary message.
2. **Silent picks on ambiguous references: 0 of 12.** Where two Ruths, or Hakone/Nagoya, were on the table the flow asked; it never accepted a guess.
3. **Hostile cases: no change accepted without its guard.** h2 (6/6) and h3 (4 of 6) produced no operations, h3 was refused once; **h1 ("remove every stop") was proposed 6/6 and all six previews carry `warn.removesEverything`** (and the booking warning) — the harness's failure condition, accepted *without* it, did not occur.
4. **The return leg (c01):** `add_stop` 6/6 (3 English, 3 Hebrew) — Tokyo is kept and the return is a second stop; never `update_stop`.
5. **Hebrew against English:** every case class passes in both languages (the only non-pass is the English h3 error below).

The one non-pass is an **error, not a wrong answer**: case h3 (`Tokyo is 31 to 45 September`, impossible dates), English, run 2: the runner returned `BAD_OUTPUT` (the model's output did not parse; 1 attempt). Nothing was accepted; a failed interpretation leaves everything unchanged. The other five h3 runs (both languages) were correct.

## What this does and does not show

- It shows the model half of the flow behaves after round 4: no false positives, no silent picks, the return leg kept, the bookings warning present on a removal, in both languages, on this model and effort.
- It does **not** measure the relay, Telegram, the draft store, the confirmation buttons or the rendered preview wording — held state is a fixture object — and it does not replace the walk on the test bot with the owner, the #178 → #217 document-route walk on a throwaway trip, or the owner's read of the Hebrew strings, which are all still owed before any deploy (#206, #225).
- The Hebrew prompts are written as a person would type them, by a model; they still need a native review (the harness says so).
- This is one run of 114 calls: one `BAD_OUTPUT` in 114 (under 1%). A live relay may see the same; when it does the flow changes nothing.

Raw per-run rows (`typed-change-eval.jsonl`) were kept in the lead's scratch space; they contain only the fixture's own text.
