# Document extraction — model cost/quality comparison (2026-09-26)

**Written for:** Dror and whoever owns Track 3 (`docs/sprint6-tracks.md`), to choose
which model reads organizers' documents, and at what cost. **By:** the process
session (sprint-6-integration-3d).

## How it was run

`control-plane/api/tools/extract-intake-eval.mjs` against a clean build of
`integration/sprint-6` at `dde2218`: the 12 text scenarios plus the e2e fixture
documents (`make_documents.py` japan and multi), `--runs 2`, `--concurrency 3`,
`--today 2026-09-26`, `EXTRACT_TIMEOUT_MS=180000`. 28 calls per model, all four
models on the same build. Nothing was deployed; no configuration changed.

| Label | Runner | Model | Notes |
|---|---|---|---|
| claude-sonnet-5 | claude CLI | `claude-sonnet-5`, effort medium | what production runs today (decision 13) |
| codex-gpt-5.6-luna | codex CLI | `gpt-5.6-luna` | the 2026-09-13 benchmark's candidate |
| or-gemini-3.8-flash | OpenRouter | `google/gemini-3.8-flash` | $0.75 / $3.75 per M tokens |
| or-gpt-5.4-mini | OpenRouter | `openai/gpt-5.4-mini` | $0.75 / $4.50 per M tokens |

The two OpenRouter ids were confirmed on OpenRouter's model list before the run,
since an unchecked id is what broke `kinerary-extract` before (Track 3 step 0).

## Results

| Model | Checks passed | Clean runs | Median / p90 / max | $ per document | $ per clean run | Cost kind |
|---|---|---|---|---|---|---|
| Claude Sonnet 5 | 270/272 | 27/28 | 11 / 17 / 23 s | 0.023 | 0.024 | API-equivalent (subscription today) |
| Gemini 3.8 Flash | **272/272** | **28/28** | 23 / 47 / **182 s** | 0.020 | **0.020** | billed |
| Codex gpt-5.6-luna | 268/272 | 25/28 | 17 / 23 / 55 s | not reported | — | subscription |
| GPT-5.4 mini | 266/278 | 21/28 | 4 / 5 / 7 s | 0.004 | 0.005 | billed |

A "clean run" has no failed check and no malformed proposal. Cost per clean run
divides the total by clean runs, so a model that needs retries pays for them.

Failures, by scenario:

- **Claude Sonnet 5:** `repeated_city`: Lisbon twice collapsed into one stop.
- **Codex:** `repeated_city` (same); `attractions_and_pass` twice: a value taken
  from the prompt's example.
- **GPT-5.4 mini:** stops lost in `japan_changed_names`; trip start and end
  invented from a hotel stay (`hotel_only_range`, both runs); a quoted hotel
  treated as booked (`confirmed_vs_quote`); an example-only value; 9 malformed
  proposals in `repeated_city`.
- **Gemini 3.8 Flash:** none.

OpenRouter spend for the comparison: $0.67, plus $0.05 for a one-call smoke test.

## Reading it

1. **GPT-5.4 mini is not usable here** despite costing a fifth as much: it
   fabricates trip dates and loses stops, which is the expensive failure for
   this job.
2. **Gemini 3.8 Flash is the most cost-effective on this sample** (the only
   perfect score, at the lowest billed price), **but its latency tail is a
   production problem:** p90 47 s and a 182 s call, while production reads
   documents under a 120 s limit (`ITINERARY_EXTRACT_TIMEOUT_MS`). It spends
   about 7x Claude's output tokens, which is where both its time and its cost go.
3. **Claude Sonnet 5 is within $0.003 per document of Gemini**, the fastest of
   the reliable models, and missed one hard case that Codex also missed.
4. **Codex reports no usage**, so it cannot make this spend visible, which is
   Track 3's stated goal.

**Recommendation:** keep Claude Sonnet 5 for extraction, and meter it rather
than switch: at about $0.023 per document the real cost is known and small.
Re-run Gemini 3.8 Flash with more runs (for example `--runs 5`) and the
production timeout before considering it as the default.

## Limits

One sample: 14 scenarios x 2 runs. A difference of two checks is within noise.
`repeated_city` is a known hard case (#114's return-leg family). Latency depends
on provider load at the time of the run. The Claude cost is an API-equivalent
estimate computed by `model-runner.ts`, not a bill.

Reproduce: in a clean build of `control-plane/api`, set `EXTRACT_RUNNER`,
`EXTRACT_MODEL` (and `EXTRACT_EFFORT` for claude; `OPENROUTER_API_KEY_FILE` for
openrouter), then `node tools/extract-intake-eval.mjs --modules dist --docs
<make_documents output> --label <label> --runs 2 --concurrency 3 --today 2026-09-26`.
