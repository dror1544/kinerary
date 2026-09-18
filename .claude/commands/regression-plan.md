---
description: Risk-assess a change set and produce a costed regression plan — a branch, a PR, or a whole sprint
argument-hint: [branch | PR number | "sprint N"]
allowed-tools: Bash, Read, Grep, Glob, Write, Agent
---

Produce a deployment-risk assessment and a costed regression plan for:
**$ARGUMENTS** (default: the current branch against `main`).

Hand this to the `regression-planner` agent — it carries the whole method, and
this file deliberately does not restate it. Use the Agent tool with
`subagent_type: regression-planner`.

Which change set to give it:

| `$ARGUMENTS` | The set |
|---|---|
| empty | `git diff main...HEAD` on the current branch |
| a number, or `#123` | that PR — `gh pr view` / `gh pr diff` |
| a branch name | that branch against `main` |
| `sprint N` | every PR merged since the last sprint gate, plus the open ones queued for it |

## The two things a local run must do that CI cannot

The CI assessment
(`.github/workflows/regression-assessment.yml`) runs on every PR and issue, but
it has **no production access** — so two of the agent's steps only ever happen
here. If you skip them, this run adds nothing CI has not already posted:

1. **Read the live fleet.** Which trips are at `ready_private` or beyond, which
   are running *right now*, and which release each one is pinned to. That is
   what turns "this changes the trip runtime" into "this reaches nobody until
   these three trips are redeployed".
2. **Say what has to be redeployed** for the fix to actually reach the people
   who have the bug. A control-plane fix lands on everyone at restart; a
   trip-runtime fix lands on nobody until someone acts.

## For `sprint N`

Read that sprint's section of `docs/onboarding-mvp-sprint-plan.md` first. The
deliverable is section 8 of the agent's report — the gate, the one batched
acceptance run, the entrypoint debt, the regression ring, and what to *stop*
testing. Recommendations only: `sprint-scribe` owns the plan document and the
ledger, and this never edits either.

## Afterwards

The plan lands in `docs/test-reports/regression-plan-<date>-<topic>.md`. The
deploy hook greps that directory for the current commit, so a plan filed here
is what a later `--deploy` prompt reports back — write the commit SHA into it.

Do not run the deploy, and do not approve it. Hard rules 1 and 2 stand.
