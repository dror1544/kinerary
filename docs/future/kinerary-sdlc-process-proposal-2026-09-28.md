# Kinerary SDLC improvement proposal — request for Claude's opinion

Prepared by Codex for Dror and Claude, 2026-09-28.

**Status: discussion proposal, not an approved policy or implementation instruction.**
Dror asked for a plan explaining the assumptions, strategy, likely benefits,
tradeoffs, timing, and relationship to Anthropic's AI-native SDLC playbook.
This document does not change the standing rules, roles, release gates, or
sprint ownership. Existing instructions remain authoritative until amended
through the normal process.

Claude: I want your independent opinion on these suggestions. Please challenge
the assumptions and estimates, identify protections I have undervalued, and
recommend what to adopt, modify, defer, or reject. Do not treat my conclusions
as agreed decisions. Your experience of the actual Kinerary development loop
is especially valuable here. First produce the review described at the end;
implementation is a subsequent decision for Dror.

## 1. Objective and assumptions

Kinerary is a solo-owner project, built primarily with Claude and occasionally
with Codex. It also has multiple concurrent AI work streams, live trips, user
data, infrastructure, and security-sensitive behavior. One human does not
mean a simple system or low consequences from failure.

The objective is **less owner attention and model usage per accepted, useful
change, without weakening correctness, privacy, or release safety**. Faster
code generation, more agents, more PRs, and fewer approval clicks are not
sufficient measures of success.

Assumptions to validate:

1. Coordination and review are substantial costs for small tasks. The actual
   share of tokens and active human time is currently unknown.
2. Some work qualifies for a smaller process; security and operational changes
   continue to need independent evidence and specialist judgment.
3. Existing briefs, GitHub issues, designs, skills, and checks can carry most
   of the proposed workflow. A second tracking system would add overhead.
4. Dror's ability to review work limits useful concurrency. This is a working
   hypothesis, not a measured diagnosis of every delay.
5. Subscription usage, metered API spend, and elapsed time are different costs.
   Cached input tokens and output tokens must not be valued identically.
6. September 26's simplifications deserve evaluation before another broad
   redesign. Their early timing results do not prove causation or quality.
7. Claude and Codex should share durable task context and policy. Different
   models may provide useful scrutiny, but agreement is not verification.

## 2. Evidence and limits

Repository inspected at `ae544d9`, on `integration/sprint-6`; dates and status
claims below are observations as of September 28, not continuing guarantees.

### Current strengths and costs

- [CLAUDE.md](../../CLAUDE.md) already defines mechanical guardrails,
  verification, security boundaries, and merge/deploy authority. Its MVP rules
  already narrow regression planning and permit CI evidence in defined cases.
- [Agent-team plan](../agent-team-plan.md), section 3.1, requires delegation
  even for a one-line product change. Section 3.6 gives the doc keeper a
  per-task seat as well as a daily sweep. These are candidates for adjustment,
  not permissions this proposal grants.
- `CLAUDE.md` has 866 lines/about 7,742 words; the team plan has 954 lines/about
  9,139 words. File size is evidence of reading surface, not proof that every
  task loads both files or that every token is billed at an uncached rate.
- [Regression assessment workflow](../../.github/workflows/regression-assessment.yml)
  invokes its configured Opus model on eligible PR-opening and issue events.
  Narrowing a report's contents does not itself prevent that invocation.
- [September 27 handoff](../test-reports/sprint-6-integration-handoff-2026-09-27.md)
  records boundary reviews finding an account bypass in #274 and sensitive
  data/validation defects in #275. These checks have demonstrated value.
- [Process metrics](../../scripts/process-metrics.py) and hook-decision logging
  already exist. The earlier baseline's statement that logging is only proposed
  is historical. [Nightly e2e](../../scripts/nightly-e2e.sh) exists too, but the
  tracks document says it is not scheduled; script existence is not proof of
  an operating automation.

### Early timing comparison

Read-only GitHub queries in this conversation returned:

| Measure | Before #226 | Opened and merged after #226 |
|---|---:|---:|
| Merged PR count | 43 | 23 |
| Median open-to-merge | 143.9 minutes | 65.05 minutes |
| 75th percentile | 1,805.12 minutes | 132.98 minutes |
| Open-to-merge over 24 hours | 13 | 0 |

The [baseline report](../test-reports/process-baseline-2026-09-26.md) explains
the original sample. The cutoff is #226's merge at
`2026-09-26T07:46:12Z`. The before cohort merged before that timestamp; the
after cohort opened after it and had merged when queried. #226 is excluded.
The latter cohort is #228, #230–#237, #239, #241–#245, #258, #260, #270, #272,
#274–#276, and #280. Percentile uses the existing script's convention: sorted
durations at zero-based index `floor(3*n/4)`.

Reproduce with `gh pr list --state merged --base integration/sprint-6 --limit
200 --json number,createdAt,mergedAt` and the cohort filters above; paginate
if the result reaches the limit. Also inspect open PRs. At this read six were
open: #257, #267, #268 (drafts), #285, #286, #290. Do not silently include
#226 when using the existing metrics script's merge-date window.

The result is encouraging but not causal evidence: the after window is short,
task sizes/types differ, still-open work is excluded, and availability may
explain some waiting. Neither active human effort, token savings, escaped
defects, nor time to production was measured by this comparison.

## 3. Anthropic SDLC references and our interpretation

Primary reference: Anthropic, [The AI-native SDLC playbook](https://claude.com/blog/the-ai-native-sdlc-playbook),
Louis Claxton, dated August 21, 2026; read September 28. Section names below
are navigation references within that article. Recheck vendor-specific setup
instructions before implementing them.

| Article section | Relevant idea |
|---|---|
| “Plays” | Modular adoption with dependencies; each practice need not be introduced together. |
| Plan: “Capture as intent.md” | Preserve the problem, outcome, constraints, and questions in a durable record. |
| Design: “Requirements and design”; Build: “Claude Code plan mode…” | Resolve important choices before implementation and retain the accepted plan. |
| Build: “Legacy systems and the source of truth” | Choose authoritative records and link existing systems. |
| Build: CLAUDE.md, skills, hooks, parallel sessions | Maintain usable context, distinguish advisory rules from enforcement, and bound concurrency by review capacity. |
| Test: “Give Claude a feedback loop”; “Continuous evals in CI” | Verify behavior and evaluate changes to agent configuration. |
| Deploy: PR review and approval gates | Automate preparation while preserving human authority at consequential gates. |
| Maintain: “Maintenance and closing the loop” | Feed operational findings back into development. |

The application to Kinerary below is **Codex's proposal**, not an Anthropic
requirement. In particular, the three risk levels, combined brief, savings
estimates, pilot dates, and conditional role involvement are our adaptations.
The article is guidance, not evidence that these changes will save Kinerary a
particular percentage. No additional enterprise product is assumed necessary.

## 4. Proposed strategy: a smaller ordinary path

Use risk and uncertainty to select process depth, with conservative escalation.
Classify by behavior and consequences as well as paths; a one-line auth change
is high risk, and a prompt or configuration edit can change production behavior.

| Level | Examples | Proposed minimum |
|---|---|---|
| Small | Ordinary copy, spacing, non-policy documentation, isolated behavior-preserving cleanup | Brief intent, one implementing session, relevant check/visual proof, concise review, existing merge gate |
| Normal | Bounded feature or bug fix under an established architecture | One brief with acceptance examples, appropriate tests, fresh review, valid integration evidence |
| High risk | Auth/privacy, migrations, provisioning, shared contracts, relay behavior, process environments, deployment or guardrail policy | Explicit design/failure cases, independent verification, applicable specialist reviews, merged-tree evidence, regression/rollback planning |

Unknown risk starts higher until resolved. The existing security definitions
are a minimum, not a list to narrow. Any change in authorization, data exposure,
external side effects, or rollback difficulty triggers reconsideration.

This requires a deliberate amendment to the current mandatory delegation,
integrator and documentation rules where the pilot differs. Until then, follow
the current rules. Do not make the pilot happen through undocumented exceptions.

Use the existing GitHub issue brief as the task record, linked to the PR and any
version-controlled design. Name one authoritative home per fact. Do not add
three planning files for every PR. A normal brief should cover: problem,
observable outcome, acceptance examples, exclusions, risk and rationale,
verification, and release implications. Larger features can have a shared
design that their individual PRs inherit.

The product retains the complete lifecycle. A small PR can reuse accepted
planning; a release still needs assessment of the actual combined revision.
Incident work may compress coordination but retains essential verification,
release authorization, recovery checks, and a subsequent incident record.

## 5. Improvements, estimated benefits, and tradeoffs

**All percentages are low-confidence planning hypotheses.** They refer to
affected work, not the whole project, and overlap. Time means development and
review elapsed time excluding waits for the owner's availability. Human effort
means active minutes. Count tokens across the lead, all agents, reviews, and
retries; distinguish input, cached input, and output where available.

| Improvement | Token reduction | Time reduction | Human-effort reduction | Tradeoff / question for Claude |
|---|---:|---:|---:|---|
| Risk-sized process | 20–40% on low-risk work | 15–35% | 20–40% | Can we classify reliably without making classification another costly review? |
| Direct implementation for small tasks | 15–35% | 15–30% | 10–25% | Which independent checks must remain when manager/developer separation goes? |
| One compact brief | 5–15% | 5–15% | 10–20% | What is the minimum that prevents guessing and preserves design reasoning? |
| Smaller always-loaded context | 5–20% of task tokens | 0–10% | 0–10% | How do agents reliably discover moved guidance? Cash savings depend on caching. |
| Reuse valid verification | 5–15% | 10–30% on test-heavy work | 5–15% | What exact code/environment changes invalidate evidence? Preserve current merge-ref restrictions. |
| Conditional per-task doc keeper | 5–15% | 5–15% | 5–15% | Can the author capture decisions well enough, with daily drift sweeps retained? |
| Filter regression assessment before model invocation | 80–100% of a skipped assessment; whole-task effect unknown | Assessment runtime; possibly zero on critical path | Small, unmeasured | Fail toward assessment on uncertainty; inspect auth/relay changes, not only a narrow path list. |
| Bound concurrency by review capacity | 0–15% | Could improve or worsen elapsed time | 10–25% when overloaded | Start with one stream, add a second when independent; do not cap useful parallelism blindly. |
| Shared Claude/Codex handoff; selective second opinions | 0–15%; extra review can increase usage | 0–10% | 5–15% | Does a second model find consequential defects often enough to justify the cost? |
| Measure outcomes and costs | Initially a small increase | Initially a small increase | Budget 10–15 minutes/week plus brief task records | Use existing telemetry; avoid a new reporting bureaucracy. |
| Representative agent-configuration evals | Initially an increase; later unknown | Initially slower configuration changes | Setup cost; later unknown | Start small, synthetic, isolated, and triggered by relevant changes. |

The combined lightweight path was estimated at 25–45% fewer tokens and 20–40%
less time/owner effort for small changes; normal changes at roughly 10–25%;
high-risk changes at 0–10%. These are overlapping scenario ranges, not a
business case or an expected result. Claude should replace or reject them
where experience contradicts them. A 40% saving on work consuming 20% of
tokens would save only 8% overall, before setup/maintenance cost.

First experiment: risk-sized workflow + direct small-task implementation +
compact brief + conditional doc-keeper involvement, treated as one bundle.
Keep model selection, concurrency, context restructuring, and test policy
stable during that experiment so its results remain interpretable. Afterward,
test regression-invocation filtering, context cleanup, and evidence reuse
separately. Existing allowed CI reuse continues; expanding it is a later change.

Do not remove boundary review, the release regression plan, owner merge/deploy
authority, safe test databases, production isolation, or migration/rollback
protections to meet a token target. Avoid automatic incident-to-production
repair as an initial adoption step.

## 6. Timing and rollout

### What the existing schedule actually says

[Sprint 6 decisions 51 and 55](../sprint6-tracks.md) and the September 27
handoff record Release A for **Saturday, October 3, morning IDT**, with a
separately pinned `release/a` at `a744c28` when recorded. The older Friday
October 2 window is superseded. Ordinary Sprint 6 development continues;
October 3 is not a general merge or development embargo. Revalidate dates,
the pin, and current release obligations with the lead before relying on them.

The proposed timing below is based on owner attention and avoiding simultaneous
changes to release procedure. It is not an existing owner decision, a new
release gate, or a reason to delay ordinary development.

| When | Proposed work | Exit condition |
|---|---|---|
| Now, September 28–October 2 | Claude critiques this proposal; use existing measurements; classify recent tasks on paper; prepare one bounded pilot policy diff in a dedicated process worktree | Concrete pilot scope, preserved controls, measurement method, and rollback ready for Dror's decision |
| During Release A acceptance and deployment | Keep the release's established procedure and evidence stable; collect passive process data | Release work receives the attention it needs; no dependency on adopting this proposal |
| First suitable quiet work session | After approval, enable the pilot for new eligible tasks only; leave in-flight tasks on their original workflow | Shared rules and any mirrors agree; fresh sessions load changed role definitions |
| Suggested window: October 5–18 | Run for two weeks and aim for 10–15 comparable small/normal tasks; extend if too few arrive | Enough observations to decide whether the bundle helps |
| Around October 19, or after the sample completes | Compare effort, usage, elapsed time and rework; inspect escaped defects over subsequent releases | Adopt, revise, extend, or revert with a recorded reason |

October 5 is a planning preference, conditional on release stability and
Dror's availability, not a promise. A narrow approved pilot could begin before
October 3 if it does not compete with release work or alter that release's
procedure. A delayed Release A does not automatically block unrelated process
work. Conversely, unresolved operational problems are a reason to defer changing
the workflow used to address them. Claude should recommend the right balance.

Do not wait for the end of the entire sprint solely for administrative neatness.
Switch at a new-task boundary. If `.claude/agents` changes, regenerate the Codex
mirror and restart affected sessions, per the repository rules. Coordinate
process ownership with the lead; do not switch branches or reset a shared,
live-served checkout. Nothing in this proposal authorizes repointing `release/a`.

## 7. Measurement and stop conditions

Extend the existing measurements only as needed. For each sampled task record:

- Risk level and rough size, fixed before implementation; escalation if needed.
- Start, PR-ready, merge and deployment timestamps where applicable; distinguish
  active work, automated runtime, and waiting for the owner.
- Owner minutes for clarification, supervision, review, and recovery.
- Available token/usage totals across agents and retries, plus actual metered
  charges where available. Mark missing data unknown; do not reconstruct it
  from PR size or assume subscription work costs nothing.
- Review rounds, actionable findings, repeated tests with reasons, corrective
  follow-ups, and whether the requested behavior was accepted.
- Subsequent failed deployments, rollbacks, escaped defects, and recovery time.

Keep fixed subscription fees separate from marginal spend and quota pressure.
Record the one-time implementation cost and continuing process-maintenance
cost. Match task categories when comparing; report open work and exclusions.
Hook counts are per machine and include unrelated operations, so their ratio
to merged PRs is not a precise per-task interruption count.

Suggested decision target: about **25% less median owner effort** for comparable
eligible tasks, lower or unchanged total model usage, and no observed worsening
in consequential defects or corrective work. This target is proposed, not
approved or statistically established. A small sample cannot prove unchanged
reliability; retain follow-up across several releases and report uncertainty.

Stop/escalate an individual task when its risk grows or required evidence is
missing. Pause the experimental exception and return to the previous path if
an omitted check plausibly causes an escaped security/correctness defect, or
if follow-up work erases the apparent savings. Record what failed before
tightening or expanding the policy. Rollback concerns the pilot policy and new
tasks; it does not imply reverting correctly delivered product changes.

## 8. Response requested from Claude

Please return a review before implementation:

1. **Verdict per suggestion:** adopt, modify, defer, or reject; with evidence
   and the failure mode each retained control prevents.
2. **Assumption corrections:** what the current sessions actually spend time
   and tokens on; which figures above are implausible or unmeasurable.
3. **Timing recommendation:** start now, after Release A, or another concrete
   condition; explain owner-attention and technical dependencies separately.
4. **Minimum pilot:** eligible/excluded tasks, required evidence, exact rules
   that would change, and the controls that remain. Identify authoritative
   policy files and generated mirrors; do not implement them yet.
5. **Measurement and economics:** data already available, missing attribution,
   one-time setup effort, recurring overhead, and how to judge net benefit.
6. **Counterproposal:** a simpler or safer experiment if this one removes too
   much independence or adds more process than it saves.
7. **Decisions for Dror:** only the remaining substantive choices, presented
   after the concrete pilot and rollback are prepared.

Please distinguish repository evidence, your experience, vendor guidance, and
your own hypotheses. Specifically challenge whether mandatory delegation and
per-task documentation review are expensive enough to change, whether the
September 26 adjustments should first run longer unchanged, and whether a
smaller initial experiment would yield a clearer result.
