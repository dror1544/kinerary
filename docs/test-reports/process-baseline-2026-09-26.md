# Process baseline — Sprint 6, before the lighter gates (2026-09-26)

**Written for:** Dror and the lead session, to judge whether the process change of
2026-09-26 (PR #226, merge `d2958f4`) and the narrowed review gates actually save
time. **By:** the process session (sprint-6-integration-3d), which does not lead
development.

## What was measured

All 43 PRs merged into `integration/sprint-6` before `d2958f4` (#226 excluded),
read from GitHub with `gh pr list --state merged --base integration/sprint-6` and
`gh pr view <n> --json commits`. Times are wall-clock.

| Metric | Median | 25th pct | 75th pct |
|---|---|---|---|
| PR open → merge | **2.4 h** (144 min) | 35 min | **30 h** (1805 min) |
| First commit → merge | **2.6 h** | — | **31 h** |
| First commit → PR open | **0.0 h** | — | — |
| Commits per PR | 1 | — | — (96 in total) |

Prompts under the old rules: one per commit (96), one per push, one per merge.
Prompts are not logged anywhere, so the push count is inferred (at least one
per PR), not measured.

## What it says

1. **The commit prompts were friction, not the delay.** A PR opens a median of
   0.0 hours after its first commit, because the commits come as a batch at the
   end of a task. Removing those prompts saves clicks and interruptions, not
   calendar time.
2. **The delay is after a PR opens.** The median is 2.4 hours, and one PR in four
   waits more than 30 hours. That time is review rounds, the integrator, and
   waiting for the merge approval. That is where the rest of the 2026-09-26
   changes act (two review rounds, CI as merged-tree evidence, a regression plan
   only for risky PRs, daily sweeps), and where re-measurement should look.
3. **A correction.** The case for #226 was first made from five PRs (#192, #196,
   #197, #211, #215) that merged 24–45 minutes after opening. Those were the
   fast ones. CLAUDE.md and the team plan's decision 11 were corrected in the
   same PR as this report.

The long tail, for whoever looks next: #149 (36 h), #150 (33 h), #176 (30 h),
#199 (18 h and four audit rounds).

## What to re-measure, and when

After the next 10 PRs merged into `integration/sprint-6` under the new rules,
re-run the same queries and compare:

- PR open → merge: median and 75th percentile. **The target is the tail**: fewer
  PRs waiting over a day.
- Review rounds per PR: how many hit the two-round cap and how many produced a
  follow-up issue instead.
- How many merges relied on CI instead of a local verifier run, and whether any
  of them had to be reverted or fixed later.
- Prompts per PR: expected to be one (the merge). This is unmeasured today. A
  hook-side count, local and outside the repo, would make it measurable; that
  is a proposal, not built.

A merge that relied on CI and later needed a fix is the signal to tighten that
rule again.
