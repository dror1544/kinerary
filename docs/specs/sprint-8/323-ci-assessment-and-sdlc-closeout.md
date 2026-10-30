# CI regression assessment credentials, and the SDLC switch close-out

Status: draft (2026-10-19) · Issue: #323 · Track: Housekeeping · Size: S · Tier: Small (no repo code; one repository secret, one notes-folder report)
Security path: no · Migration: no · Live-trip behaviour: no

> **Unscheduled (2026-10-30):** the CI half was reworked in Sprint 7 (#470); the secret and the SDLC close-out remain.

Short form (`docs/specs/README.md`, item 6).

## Problem

**A. The CI assessment has never run.** `.github/workflows/regression-assessment.yml`
needs a `CLAUDE_CODE_OAUTH_TOKEN` or `ANTHROPIC_API_KEY` repository secret.
Neither exists (`gh secret list` is still empty on 2026-10-19). Since #324
(2026-09-30) an unconfigured run fails **red** instead of reporting a false
green, so the signal is now honest — but no PR has had an Opus assessment
in CI at all. The 2026-10-18 runs show exactly that: `failure` on every
non-draft PR and issue, `skipped` on drafts (#357, #359). Only Dror can mint
the token (`claude setup-token`) and set the secret. The workflow half is done
(#324).

**B. The SDLC switch was never closed out.** `docs/kinerary-sdlc-process-proposal-review-2026-09-29.md`
§10 defines seven metrics (M1–M7), a baseline, the windows and a decision rule
for the Small-tier switch (#322, merged 2026-09-30T09:30Z, `2b34997`). The
"after" window could close no earlier than 2026-10-14. Nothing has been
measured since; the close-out is five days overdue.

## Acceptance criteria

**A — assessment credentials**
- AC-1 The repository secret `CLAUDE_CODE_OAUTH_TOKEN` (or `ANTHROPIC_API_KEY`)
  exists. *(Dror's step; not delegable.)*
- AC-2 On the next non-draft, same-repo PR whose paths are not all
  docs/test/stylesheet, `Assess deployment risk` is green **and** its run's
  `Assess` step concluded `success` (not `skipped`), and the assessment comment
  was posted. Checked with `gh run view <id> --json jobs` — the step
  conclusions, never the check colour alone. That run's id closes #323.
- AC-3 A docs-only PR in the same period still skips the model (`relevant=false`
  from `scripts/regression-assessment-scope.sh`) and the
  `regression-assessment` label still forces a run.

**B — close-out report**
- AC-4 A report exists at
  `$KINERARY_NOTES_DIR/test-reports/<yyyy-mm-dd>-sdlc-switch-closeout.md`
  (notes folder — never the repo; fail loud if the folder is unset, missing or
  locked, and hand the report back in the conversation instead).
- AC-5 It gives every metric M1–M7 for **both** windows, "before" = baseline
  start 2026-09-26T07:46Z → switch 2026-09-30T09:30Z, "after" = switch → close
  date, each from the source below, with the command that produced it. No window
  straddles the switch. A metric that cannot be measured says **unmeasured, and
  why** — it is never reconstructed or estimated (M6's rule).
- AC-6 It applies §10's decision rule verbatim and states the outcome:
  **adopt** (M2 ≤ 2, M3 ≤ half its baseline, M1 median and tail not worse, M5
  zero, M7 holding), or **pause** the Small-tier exception and record what
  failed (any M5 event, or the M2/M3 gain erased). M3 is unmeasurable while A is
  open — the report says so and decides on the rest, or recommends extending
  the window; Dror chooses (open question 1).
- AC-7 The repository review doc gets one line under §10 pointing to the
  report's notes-folder filename and its outcome — no metrics copied into the
  public repo.

## Metrics and sources

| # | Metric | Source (commands run by the report author) |
|---|---|---|
| M1 | PR open → merge: median / p75 / count over 24 h | `scripts/process-metrics.py --until 2026-09-30T09:30Z --base integration/sprint-6` and `--since 2026-09-30T09:30Z` run **twice**, `--base integration/sprint-6` and `--base main` (sprint 6 merged to `main` on 2026-10-18; later PRs target `main`). Report each base and the combined set. |
| M2 | Hook prompts per merged PR | Same script — the local hook-decisions log (`KINERARY_HOOK_LOG`, else the default state path in the script). Per machine; say which machine. Ask/allow/deny by kind ÷ merged PRs in the window. |
| M3 | Opus assessments actually run per merged PR | `gh run list --workflow "Regression assessment" --created <window> --json databaseId,conclusion,event`, then for each `gh run view <id> --json jobs` and count runs whose `Assess` step concluded `success`. Baseline is **0 / 41**. |
| M4 | Small-tier PRs, direct vs developer | `gh pr list --state merged --search '"Path: direct" in:body merged:<window>'`, same for `"Path: developer"`, and `label:size:S`. Pre-count on 2026-10-19 since the switch: 6 direct, 10 developer, 3 labelled `size:S`, of 63 merged — labels are clearly not applied consistently; report all three. |
| M5 | Escaped defects on lightened-path PRs | For each `Path: direct` PR: merged `fix/` PRs or reverts within 7 days that cite it (`gh pr list --search "<n> in:body"`), plus any boundary finding on a mis-tiered PR. |
| M6 | Model usage per PR | `tool_uses` / `duration_ms` recorded in developer/verifier handovers since the switch (notes folder `handovers/`, PR bodies). Before window: **unknown**, stated as such. |
| M7 | Nightly e2e green nights | The nightly's own run logs (location set by the kinerary-deploy nightly wrapper); count green / red-with-cause / red-without-cause per night. Note: the nightly has run a stale `integration/sprint-6` since sprint state moved to `main` (#422) and was unloaded for staging on 2026-10-18 — nights it did not run are "not run", not red. |

## Test plan

- A: AC-2/AC-3 are read off real runs (`gh run view`), no test code. The
  existing text-level test in `tests/scripts/` that pins the workflow's fail-red
  guard (#324) stays green.
- B: the report is reviewed by Dror; each figure carries its command so it can be
  re-run.

## Open questions

1. With M3 still unmeasurable, close the switch now on M1/M2/M4/M5/M7 and
   re-check M3 later, or extend the window until the secret has produced two
   weeks of assessments?
2. M4's close condition says "ten Small-tier PRs". Which count is the sample:
   `Path: direct` (6), all Small-tier PRs whichever path, or `size:S` labels (3)?
3. Should the nightly be repointed to `main` before M7's window is judged?
   (Outside this spec, but it decides whether M7 can "hold".)
