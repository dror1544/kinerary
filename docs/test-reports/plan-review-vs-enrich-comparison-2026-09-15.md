# New plan-review worker vs. today's per-item /enrich — 2026-09-15

Compares the new, uncommitted "site live-plan enrichment worker" (`control-plane/api/src/plan-review.ts`,
worktree `agent-a296f6b551bbff059` / branch `live-plan-enrichment-worker`, built 2026-09-12) against the
existing per-item `POST /enrich` in `mcp/mcp.js`, which is what production actually runs today. Both were
run against the Hermes installation on the Mac mini only — no VM involved. No real trip data was read or
written; the fixture trip is `trips/japan-2025`, the repo's own long-standing public test fixture.

**These two features do different jobs** (plan-review judges a whole leg for gaps/ordering/pace; /enrich
adds links+translation to one item), so this is not an apples-to-apples "same task, which wins" test. It
answers two narrower, real questions: what does each cost/take on this Mac today, and is either producing
output good enough to trust.

## Setup

- `kinerary-extract` Hermes profile, unmodified (`~/.hermes/profiles/kinerary-extract/config.yaml`):
  primary `minimax/minimax-m3:free` on OpenRouter, fallback `gpt-5.6-luna-900k` on `openai-codex`.
- **The primary model id does not exist** (same finding as the 2026-09-13 report — OpenRouter has no
  `:free` variant of `minimax/minimax-m3`), so every call below silently fell through to the fallback.
  Confirmed from `~/.hermes/profiles/kinerary-extract/state.db`: all 6 sessions in this test billed as
  `gpt-5.6-luna-900k` / `openai-codex`, none on OpenRouter.
- Plan-review: `control-plane/api/tools/plan-review.ts` (already built by the branch) against
  `trips/japan-2025/trip.config.json`, `--destination Japan`, with a synthetic (non-real) intake-answers
  fixture — `trip_pace: balanced`, 3 travelers incl. one age 9, one flight anchor, one constraints note —
  and `PLAN_REVIEW_RUNNER=hermes PLAN_REVIEW_MODEL=kinerary-extract`.
- /enrich: `mcp/mcp.js` started locally on a spare port (`MCP_PORT=18321`), `HERMES_EXTRACT_PROFILE=kinerary-extract`,
  same profile as above. Sent the same two items the 2026-09-13 report used (Tokyo Skytree, TeamLab Planets),
  both real venues on this fixture trip.

## Efficiency

| | calls | wall time | input tok | output tok | cost |
|---|---|---|---|---|---|
| plan-review (model half) | 4 (one per phase: tokyo, hakone, kyoto, osaka) | 96.8s total, ~24s/call | 8,045 | 2,589 | $0 (Codex subscription, not per-token billed) |
| /enrich (per item) | 2 | 16.7s + 18.3s, ~17.5s/call | 2,106 | 612 | $0 (same) |

Both landed on the same fallback model, so cost is a wash today (Codex subscription, not metered per call
here — see the 2026-09-13 report for what real per-token OpenRouter pricing looks like: ~$0.0002–0.0004
per single-item call there). On raw ground covered, plan-review is far more efficient: 4 calls reviewed 4
whole legs (11 days, dozens of items) in under two minutes; covering the same ground item-by-item through
/enrich would be one ~17s call per item, i.e. tens of calls and several minutes for one trip.

**The free half of plan-review already does most of the work.** `auditPlan` (no model, no cost) produced
**33 evidence-backed proposals** on this fixture with no model involved at all: 24 `attach_link`, 7 `pace`,
2 `question`. That is the headline efficiency finding — most of what an organizer would want out of this
feature costs nothing and takes under a second, before any model is called.

## Effectiveness

**/enrich, today's actual fallback (gpt-5.6-luna-900k), not OpenRouter:** both calls returned real venues'
correct English titles, live Google Maps/Waze links, and for TeamLab Planets a `website_url`
(`https://www.teamlab.art/e/planets/`) and `ticket_url` (`https://teamlabplanets.dmm.com/en`) — checked with
`curl -L` against a normal browser UA, **all three non-map URLs returned live HTTP 200**, plus correct
`needs_tickets`/`advance_booking: true`. This is a real improvement on the 2026-09-13 report, which tested
OpenRouter/minimax-m3 specifically and found 4 of 6 URLs dead (guessed, 404). **Today's actual production
default is meaningfully better at this job than the OpenRouter alternative that report evaluated** — worth
knowing before anyone is tempted to switch this endpoint to OpenRouter for speed.

**plan-review's model half added nothing on this fixture.** All 4 phase calls returned successfully
(`rejected: 0` — nothing was gated out for bad evidence, invented places, or a URL), but none contributed a
single accepted proposal beyond what the free rules pass already found (`modelUsed: false`,
`modelSkipped: null` — the "ran and found nothing" case, not a failure). Two readings, and this run alone
doesn't distinguish them: (a) the rules pass on this fixture is thorough enough that there was genuinely
nothing left for the model to add — plausible, since it already covers headlines, ordering, links and pace;
or (b) the fallback model under-delivers on the harder "is anything missing from this whole day" judgment
task specifically, versus the narrower "give me three links for this one place" job /enrich asks it. Telling
these apart needs a second fixture with real gaps the rules pass can't see (a document mentioning something
config doesn't) — not run here.

## Group chat auto-reply (#64, `feat/group-reply-capture`)

**Not run in this session.** Per plan, this needs the repo's automated fake-Telegram harness
(`scripts/preflight-deploy.sh --auto`), which is itself a deploy (CLAUDE.md hard rule 2) and needs to run
against `integration/sprint-6` (where #64 actually lives — it is not on `main`). Held for explicit go-ahead
before running, and for that branch's working tree to be clean of the uncommitted docs-move from this
session's earlier housekeeping.

## Not covered

- A fixture with a real gap only the model could catch (to separate the two readings above).
- Whether plan-review's proposals, if the model DID contribute, would look right to an organizer reading
  them — none were produced here to judge.
- The actual `minimax/minimax-m3` (paid, not `:free`) was not tried directly on either endpoint — both runs
  used the profile as configured today, which is the point (this is what production actually gets).
- Real per-token cost for the Codex fallback path — `estimated_cost_usd` reads 0 for a subscription-billed
  provider, so "cheaper" could not be answered in dollars for this path; only wall-clock and token counts.
