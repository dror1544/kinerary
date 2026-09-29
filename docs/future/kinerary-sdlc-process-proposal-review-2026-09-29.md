# Review — Kinerary SDLC process proposal, and `agency-agents` measured against it

**Written 2026-09-29**, the day after the proposal
(`kinerary-sdlc-process-proposal-2026-09-28.md`, prepared by Codex). This is
the review its §8 asked for, plus a second question Dror asked alongside it:
whether `msitarzewski/agency-agents` — a much broader public agent-process
repo — fits a solo developer better than what either document describes. This
is a review, not a decision. The proposal stays the authoritative statement of
Codex's case; §7 here lists what is actually his to decide.

**Bottom line first:** most of the proposal is sound and matches what I
actually see costing coordination and review time in this repo, not what it
merely estimates. Two of its eleven levers are worth adopting now, narrowly,
as direct CLAUDE.md/workflow amendments rather than a scheduled two-week
pilot. The rest should wait — some because they're genuinely unproven, one
(conditional doc-keeper) because I think the estimate is already mostly true
under the current design. `agency-agents` solves a different problem than the
one in front of us; I would not import any part of it here.

## 1. Verdict per suggestion

| Lever | Verdict | Why |
|---|---|---|
| Risk-sized process (three tiers) | **Adopt**, as the classifier under everything else | Must be mechanical, not judged per task — a path allow-list, default-High on anything unrecognized, the same fail-safe shape `shared/needs-schema.js` already uses for visibility. A soft heuristic here just becomes the "another costly review" the proposal itself worries about. |
| Direct implementation for small tasks | **Modify, then adopt — Small tier only** | §3.1's "it does not write product code... even for a one-liner" is real, verbatim, not a summary error. But its stated reason is "so the verifier and reviewer see it" — an independent check, not proof that a *subagent* has to hold the pen. Let the lead session implement Small-tier changes directly, on a feature branch in a worktree that is not live-served, and still spawn `verifier` exactly as today — it cannot edit, so it cannot pass itself. Cut the developer hop; keep the verifier hop and the isolation. Normal tier keeps the developer (§4, §9). |
| One compact brief | **Adopt** | Already close to true — the manager already posts a brief as the issue's first comment (§3.1). This mostly asks to stop writing a second and third planning document for the same fact, which doc-keeper's "one authoritative home per fact" rule already implies. |
| Smaller always-loaded context | **Defer** | Roles load once per session, not fresh per task (agent-team-plan: "Roles load once per session, from the checkout it starts in"), and CLAUDE.md is prompt-cached across a session's own turns. Line count is reading surface, not token cost — the proposal says so itself. Nothing in this repo currently measures token spend by role (see §5); cutting a well-organized reference document apart on a 5–20% guess, with the real cost of a rule an agent can no longer find, is the wrong order of operations. |
| Reuse valid verification | **Adopt, as already scoped** | This is the Sept 26 rule ("CI as merged-tree evidence... when the merge is clean, no file is touched by both sides and no security path is involved") applied more consistently, not a new rule. Widening it further is a separate, later decision — correctly deferred by the proposal itself. |
| Conditional per-task doc-keeper | **Modify — fold into lever 2** | The first pass said "reject, mostly already true"; that overstated it. Re-reading §3.6, a keeper on a decision-less diff still costs a spawn — a full turn reading the handover, the diff, the PR body and every touched document — not nothing. But the question only arises for Small tier, where lever 2 already removes the developer handover the keeper reads from. So: on Small tier the lead session records any decision itself (usually there is none) and the daily sweep catches drift; Normal and High keep the per-task seat exactly as §3.6 has it. No separate classification step — the tier decides. |
| Filter regression-assessment before model invocation | **Adopt, and move it first** | I read `.github/workflows/regression-assessment.yml` directly. Every `opened`/`ready_for_review` PR event on this repo runs the full pipeline — checkout, context collection, an Opus regression-planner call — **unconditionally**. Only `synchronize` (a later push) has any skip logic, and only for *re*-assessment, not the first one. No size or risk pre-filter exists today. This is the cleanest lever on the list: a diff-path check against the same risk allow-list from lever 1, before the workflow's own "is this configured" step, defaulting to "assess" on anything unrecognized. It touches nothing about delegation or documentation — pure CI cost avoidance, and the savings are visible directly in Actions minutes. |
| Bound concurrency by review capacity | **Adopt — already measured, not hypothesized** | `docs/test-reports/process-baseline-2026-09-26.md`: median PR open→merge is 2.4h, 75th percentile 30h, while first-commit→PR-open is 0.0h. The bottleneck is confirmed to sit after the PR opens — review and merge — not generation speed. More parallel developer sessions against one approver grows the queue in front of that constraint; it doesn't relieve it. |
| Shared Claude/Codex handoff + selective second opinions | **Defer** | Cross-tool consistency already has a demonstrated failure mode here: 2026-09-25's #192, where a test leaning on the Mac's locally installed `codex` binary passed locally and stayed red on the GitHub runner for ~18 hours before #224 fixed it (CLAUDE.md's own "green local ≠ green CI" section). Adding a second model into the loop before that class of problem is solved adds a surface for divergence, not removes one. Sequence after, not alongside, the rest. |
| Measure outcomes and costs | **Adopt, and it's cheaper than estimated — with one real gap** | `scripts/process-metrics.py` and the hook-decision log already exist and already run (both dated 2026-09-26, confirmed on disk). But read what they actually measure: PR open→merge time and hook prompt/allow/deny counts — **not tokens**. There is no existing instrumentation for token or model-usage totals by role anywhere in this repo. That's the real missing piece the proposal's §5 target needs, not a new weekly ritual — the habit of reading existing output belongs in doc-keeper's existing sweep cadence, not a new one. |
| Representative agent-configuration evals | **Defer**, as the proposal itself argues | "Setup cost; later unknown" is the right call at this scale. Agreed without reservation. |

## 2. Assumption corrections

- **Assumption 1** (coordination/review cost for small tasks is unknown) —
  mostly *confirmed*, not corrected. §3.1's "even for a one-liner" delegation
  requirement is exactly as written; this isn't an overread of the source.
- **Assumption 6** (Sept 26 deserves evaluation before a broader redesign) —
  I agree with the instinct, but the two levers I'm recommending now don't
  compete with that measurement, because they move different numbers. The
  baseline tracks PR open→merge time and review rounds; a lead session
  self-implementing a Small-tier change and running the verifier before
  opening the PR doesn't change either number from what already happens
  today — the PR still opens once, ready. The regression-assessment filter
  moves Actions minutes and model invocations, a metric the baseline doesn't
  track at all. Layering these two doesn't dirty the Sept 26 re-measurement's
  signal.
- **A half-stale citation — and the first pass got the other half wrong.**
  §2 cites the tracks document's claim that nightly e2e is "not scheduled...
  not marked BUILT... waits on Dror." The launchd job on this Mac
  (`~/Library/LaunchAgents/com.kinerary.nightly-e2e.plist`) carries a
  `StartCalendarInterval` of 02:00 daily, and
  `~/Library/Logs/kinerary-nightly/` holds a log for each of 2026-09-27, -28
  and -29 — so "not scheduled" is stale. But every one of those three runs
  ended `[fail] preflight failed — nothing deployed`, each time on the
  trip-site `tests` suite (the 28th also on `scripts tests`), exit 1. So "not
  marked BUILT" still stands: the automation exists and fires, and has never
  once done the thing it is for. The first pass of this review read the plist
  and called the tracks doc "five days stale"; it should have read the logs
  too. Both lessons are the proposal's own point — script existence is not an
  operating automation, and a schedule is not a green run. The failing suite
  is an operational item for Dror (§7), not this review's to diagnose.

## 3. Timing

Start now, not on the proposal's suggested October 5 window — but only for
the two adopt-now levers (risk classifier + direct Small-tier implementation
with the verifier still spawned; regression-assessment pre-filter). Both are
mechanical, reversible, and closer in size to the Sept 26 change itself than
to a new pilot program. Sequence them: the workflow pre-filter first — it
changes one YAML file and no role, so no session restart. The delegation
exception edits `.claude/agents/` and agent-team-plan §3.1, which means a
Codex-mirror regeneration and a restart of every session that loaded the old
role; do that at the first quiet task boundary, which with Release A on
Oct 3 probably means the following week, not this one. Everything else should wait for Release A (Oct 3) and
for the Sept 26 baseline's own re-measurement window (next 10 PRs) to close,
exactly as the proposal recommends — those levers touch review-round counts
and context structure, the things Sept 26 is actively being measured on.

Do not schedule a formal two-week pilot with its own exit criteria for the
two narrow levers. Proposing a process to evaluate a process-shrinking change
is the exact inefficiency this conversation exists to remove. Let
sprint-scribe's existing sprint-end sweep pick up the before/after numbers
alongside the Sept 26 re-measurement already due.

## 4. Minimum pilot

- **Eligible (Small tier) — a positive list, not "everything else."** The
  first pass phrased this as "outside the risk list", which is a deny-list —
  the shape CLAUDE.md's sanitizer history says leaks. Invert it: a diff is
  Small only when every changed path matches an enumerated safe pattern —
  `docs/**` (not policy files), `tests/**` and other test-only files, `site/`
  copy and styling, presentational SPA components — and the change is
  describable in one sentence of intended behavior. Anything else is Normal
  or High by default. The safe list is short on purpose and grows only by a
  recorded decision, the way `.preflight-allow` does.
- **Never Small, whatever the diff size:** migrations, `server/server.js`,
  `shared/`, `model-runner.ts`, any auth route, `mcp/**`, `control-plane/**`,
  anything that spawns a process, and — the two the first pass missed —
  deployed prompts (`.agents/skills/**` SOUL and skill files reach live
  companions; #240 was a template edit) and policy (`CLAUDE.md`, `.claude/`,
  `.github/`, `scripts/`, `.githooks/`). A prompt edit is a production
  behavior change, as the proposal itself says.
- **Evidence still required:** `verifier` spawned as today — it cannot edit,
  so it cannot pass itself; that invariant is the whole reason it is a
  separate agent, and a lead session that edits and then runs the suites
  itself would quietly lose it. Plus the one-sentence brief on the issue and
  the existing merge gate.
- **Isolation still required:** the work happens on a `fix/`/`feat/`/`chore/`
  branch in a worktree that is not live-served. `docker inspect` on this Mac
  today shows the staging API mounting
  `.../worktrees/sprint-6-integration/control-plane/api/dist` and the worker
  mounting that whole worktree at `/repo` — the lead session's own checkout
  *is* the served tree. The developer's "own worktree" was doing two jobs,
  coordination and isolation; dropping the developer must not drop the
  second. `developer.md` already says it ("you were given a worktree for a
  reason"); the exception has to say it too.
- **Rule that changes:** agent-team-plan §3.1's "it does not write product
  code... even for a one-liner" gets a named exception for Small tier only.
  Normal tier keeps the developer — the proposal's own table keeps "fresh
  review" there, and a second pair of eyes on a bounded feature is the plan's
  reason to exist.
- **Controls that stay exactly as strict:** the two-round review cap,
  boundary review on every security path, the regression-plan requirement for
  risky PRs, the integrator's merge-tree check, hard rules 1–6, sprint/
  baseline lock discipline.
- **Why boundary review specifically can't soften:** the Sept 27 handoff
  records it catching, on already-"fixed" PRs, a live account-takeover gap in
  #274 (`POST /api/agent/participants` could still mint a full organizer
  account for an unseeded name, which could reset the real organizer) and a
  PII deny-list bug in #275 (`/v1/admin/failures` served raw traveler data
  because `redact()` was a deny-list, not the allow-list CLAUDE.md's own
  blanket-invariant rule requires). Both real, both on the *second* pass,
  both in the last week. That's the evidence for leaving high-risk tier's
  "applicable specialist reviews" untouched.

## 5. Measurement and economics

**Already available:** `process-metrics.py`'s two numbers (PR open→merge,
hook decisions), the baseline report's `gh`-query method (directly
reproducible), and GitHub Actions minutes for the regression-assessment
workflow (visible in Actions usage, just not yet attributed per-PR).

**Genuinely missing, not merely under-used:** per-task token or model-usage
totals. Nothing in the repo counts these today — not `process-metrics.py`,
not the hook log, nothing. Before adopting a lever whose case rests on a
token percentage (lever 4 above is the clearest example), that number needs a
real source. Cheapest fix, matching assumption 3's "no second tracking
system": have the existing developer/verifier handover note a rough turn or
tool-call count, rather than building new instrumentation.

**One-time setup for the two adopt-now levers:** near zero — a CLAUDE.md diff
and a workflow YAML diff. **Recurring overhead:** doc-keeper reads the
existing output at its existing sweep cadence; no new cost center.

**Net-benefit judgment:** use the proposal's own math against itself — "a 40%
saving on work consuming 20% of tokens saves 8% overall." The two levers
recommended here are the two that don't require guessing that percentage
first: the regression-assessment filter's saving is the workflow's own
Actions minutes, visible per run with no modeling; the direct-implementation
lever's saving is the subagent-spawn overhead, visible by diffing a spawned
developer session's turn count against a lead-session inline edit for a
matched task.

## 6. Counterproposal

If even the two-lever version is more than wanted, cut it to one: the
regression-assessment pre-filter alone. It has no coupling to review gates,
delegation rules, or documentation discipline — a diff-list check ahead of
the workflow's existing "is this configured" step, defaulting to "assess" on
anything not on the safe-path list. It measures itself, in Actions minutes,
with zero interpretation required. If it captures the 80–100% saving the
proposal estimates for a skipped assessment, that alone may be worth more
than the rest of the list combined for a repo opening this many PRs a week.

## 7. Decisions for Dror

- Approve or reject the two adopt-now levers (risk-tiered direct
  implementation with in-session verification; regression-assessment
  pre-filter) as immediate amendments, ahead of Release A.
- Whether the risk allow-list sketched in §4 (migrations, `server/server.js`,
  `shared/`, auth routes, `mcp/provision.js`, `control-plane/**`
  process-spawning, deployment/guardrail policy) is the right default-High
  list, or needs more on it — a security-adjacent judgment call that's his,
  not mine to default.
- Whether to fold this into the existing Sept 26 re-measurement window (next
  10 PRs) or track it separately — I'd default to folding it in (§2), but
  it's his call what a clean signal is worth.
- The nightly e2e has fired three nights running and failed all three at the
  trip-site `tests` suite (§2). Whether that is the known concurrency flake or
  a real regression is not determined here; either way staging has not been
  refreshed by it once, and a Release A dry run that leans on "the nightly is
  green" would be leaning on nothing.

---

## 8. `msitarzewski/agency-agents`, measured against the same goal

You asked me to weigh this against both the existing process and Codex's
proposal, aiming for something that fits one developer, stays precise, cuts
tokens, and speeds delivery. I fetched the repo directly — README, root file
listing, one representative agent file, and GitHub's own stats — rather than
going by name recognition.

**What it actually is.** 230+ Markdown persona files across 16 business
divisions — Engineering, Design, Paid Media, Sales, Marketing, Product,
Project Management, Testing, Security, Support, Spatial Computing,
Specialized, Finance, Game Development, Academic, GIS, Healthcare — each a
few hundred to a few thousand words of identity, "critical rules,"
deliverables and success metrics for one specialist role (Backend Architect,
Reddit Community Builder, Reality Checker, ...). An install script pulls only
the divisions a project wants; a conversion script re-emits the same persona
for 14+ tools (Claude Code, Cursor, Copilot, Codex, Aider, ...). It's
popular — 155k stars, 25k forks, pushed as recently as yesterday — which
measures broad appeal to teams wanting off-the-shelf domain flavor, not fit
for a solo dev's coordination-overhead problem.

**What it is not.** No equivalent of gates, review rounds, verification, or
delegation rules. No analog to `verifier` (an agent that can't edit, so it
can't fake its own pass), `integrator` (merge-tree check, same-intent check,
carry-forward), `boundary-reviewer` (the three security invariants), no
hook-enforced hard rules, no sprint/baseline lock. It's a library of *who to
sound like*, not a description of *what has to be true before code ships*.
Comparing it to Codex's proposal compares two different axes: the proposal is
entirely about process weight (how much coordination and review a change
needs); `agency-agents` is entirely about domain breadth (which specialist
voice writes the code).

**Against Kinerary's actual bottleneck.** The measured cost in this repo
isn't a shortage of domain expertise — `developer`, `boundary-reviewer`,
`regression-planner` are already scoped tightly to Kinerary's own security
paths, provisioning flow and control-plane internals, which a generic
"Backend Architect" or "Reddit Community Builder" persona knows nothing about
and would have to be told from scratch, in tokens, every time it's invoked.
The measured cost (§1, the baseline report) is coordination and review-queue
time for a solo owner. Importing even a handful of `agency-agents` personas
adds context — more always-available role files to keep straight — in the
exact dimension the proposal is trying to shrink, while doing nothing for the
dimension actually expensive here. None of its 16 divisions apply to a
family-trip site built by one person with occasional Codex help.

**Verdict: reject for this repo.** Not for quality — it's a well-executed,
extremely popular library for what it's built for — but because it answers a
question Kinerary isn't asking. Its one arguably transferable idea, the
multi-tool persona-conversion mechanism, is already present here in a leaner
form: `scripts/sync-codex-agents.py`'s Claude→Codex mirror, enforced by
preflight B9 so the two sides can't drift. Nothing to import even there.

## Recommended shape, given all three inputs

Keep agent-team-plan.md's axis — role-per-stage, not role-per-domain —
because that's what matches what actually costs time here: coordination and
review, not missing expertise. Apply Codex's risk-tiering to shrink the
*mandatory* part of that shape at the low end, through the two mechanical,
narrowly-scoped levers in §1 and §6. Leave `agency-agents`'s approach —
breadth of persona coverage — out of it; it solves a problem this repo
doesn't have. The result is the same team of roles Kinerary already built,
doing less coordination on the share of changes that are small and safe, and
exactly as much scrutiny as today on everything else.

## 9. Second pass — same day, a different model

Dror asked for a second, independent read before treating this review as
ratified. This pass re-checked every claim the verdicts lean on against the
tree and the machine, not against the first pass's notes.

**Held, re-verified at source:**

- The regression-assessment workflow, all 270 lines this time: on `opened`
  and `ready_for_review` nothing sets `relevant=false` — only `synchronize`
  has a skip — and the Assess step runs `claude-opus-5` with `--max-turns 40`.
  "Unconditional on open" is exact.
- §3.1's one-liner delegation rule; the baseline's 2.4h / 30h / 0.0h; the
  #274 and #275 boundary-review catches; `process-metrics.py` measuring PR
  timing and hook decisions and nothing about tokens.

**Changed:**

- Lever 2 narrowed from Small/Normal to Small only, and "run the verifier
  itself" replaced with "spawn `verifier` as today". The first wording would
  have let one session edit and grade its own work — the exact failure the
  verifier's no-edit rule exists to prevent.
- §4's eligibility inverted from a deny-list to a positive safe list, with
  deployed prompts and policy files added to never-Small.
- Worktree isolation added as a retained control, on the evidence that the
  lead session's checkout is the Mac's live-served tree.
- Lever 6 (doc-keeper) softened from "reject" to "fold into lever 2".
- The nightly-e2e correction corrected: scheduled and firing, yes; ever
  green, no.

**Unchanged and still recommended:** the two adopt-now levers, the
sequencing in §3, the verdict on `agency-agents`. Nothing found in the second
pass moves those.

## 10. Measurement protocol — what "it worked" will mean

Dror asked, after the second pass, for the switch to be coordinated with the
lead session and for the effect to be measured, not felt. This section is the
protocol; the numbers under "Baseline" were measured on 2026-09-29 with the
tools named, so the comparison has a fixed starting point. Everything here
uses instrumentation that already exists, plus one label — no new tracker.

| # | Metric | Source | Baseline (2026-09-26T07:46Z → 2026-09-29) | Direction wanted |
|---|---|---|---|---|
| M1 | PR open → merge, median / 75th pct / over a day | `scripts/process-metrics.py --since <switch>` | **32 min / 133 min / 1** (41 merged PRs) | tail stays at zero-or-one; median not worse |
| M2 | Hook prompts per merged PR | same script, hook-decisions log | **3.7** — commit ask 82 vs allow 22, merge ask 39, push ask 24 vs allow 25, deploy ask 7 | ≤ 2 (merge, occasionally deploy) |
| M3 | Opus regression assessments per merged PR | `gh run list --workflow "Regression assessment"` | **54 completed / 41 merged ≈ 1.3** (79 runs: 54 success, 18 skipped, 7 cancelled) | halves — Small tier skipped, Normal/High still assessed |
| M4 | Small-tier PRs taken directly vs via a developer | PR body line `Path: direct \| developer`, `size:S` label | not recorded before the switch | recorded on every Small PR; the count is the sample size |
| M5 | Escaped defects on lightened-path PRs | `fix/` PRs or reverts citing a Small-tier PR within 7 days; boundary findings on anything mis-tiered | 0 by construction (no lightened path yet) | 0; one is a stop condition (§7 of the proposal) |
| M6 | Tokens / model usage per PR | none exists | **unknown** — recorded as such, never reconstructed from PR size | unknown until a source exists |
| M7 | Nightly e2e green nights | `~/Library/Logs/kinerary-nightly/*.md` | **0 / 3** (2026-09-27, -28, -29 — same failure, §2) | ≥ 6 of 7 once the fix lands |

**Two things the baseline already says.** M2's 82 commit *asks* against 22
*allows* mean the Sept 26 exemption is not reaching most commits — the hook's
"plain commit" shape is not matching what sessions actually type (a
`chore/hook-heredoc-message` branch is already on it). The cheapest M2 win is
that matcher, not the process. And M3's 1.3 assessments per merged PR is the
number lever 7 acts on directly; it is the one metric with no interpretation
in it.

**Windows and decision rule.** "Before" is the Sept 26 window above, extended
to the switch date. "After" starts at the switch and closes at whichever is
later: ten Small-tier PRs (M4) or two weeks. At close: M2 ≤ 2, M3 at most
half its baseline, M1 median and tail not worse, M5 zero, M7 holding —
adopt. Any M5 event, or follow-up work erasing the M2/M3 gain — pause the
exception and record what failed, per the proposal's own stop condition.
Run `process-metrics.py` twice (`--until <switch>` and `--since <switch>`),
never one window straddling it.
