# Agent-team dry run — the loop's first pass, 2026-09-20/21

The run `docs/agent-team-plan.md` §10 calls for: **one docs-only item through the
whole loop**, so the brief template and the handover shape are corrected before
anything with a blast radius goes through.

**Item:** issue #137, track 4's "Docs in order and aligned with the code" —
`docs/onboarding-to-active-plan.md` stated the 2026-09-06 deployment in the
present tense. **Shipped:** PR #138, merged `7f742b5` into `integration/sprint-6`.

**Start condition met before anything ran:** baseline LOCKED at `97582b6`,
sprint lock OPEN (`scripts/project-state.py show`).

The loop works. Every gate held, no agent committed or merged, and the change
that shipped is better than the one the first pass produced. What follows is
what it cost and what is wrong with the templates.

---

## 1. What it cost

| Step | Agent | Prompts | Rework | Tokens | Wall |
|---|---|---|---|---|---|
| 0 · read-in | manager | 6 reads | — | — | — |
| judgment calls | 3 × Opus consult | 3 | 1 (bad evidence, mine) | 233k | 11m |
| 1 · issue + brief | manager | 3 `gh` calls | — | — | — |
| 2 · developer | developer | 1 spawn | — | 125k | 6.7m |
| 3 · review | `/code-review high` | 1 | — | — | — |
| 3b · rework | developer (same instance) | 1 message | **1** | 181k | 7.5m |
| 4 · doc-keeper | doc-keeper | 1 spawn | — | 126k | 4.5m |
| 4b · rework | developer (same instance) | 1 message | **2** | 227k | 5.6m |
| — | **GATE 1 — Dror** | **1** | — | — | — |
| 5 · commit/push/PR | manager | 4 | — | — | — |
| 6 · integrator | integrator | 1 spawn | — | 133k | 9m |
| — | **GATE 2 — Dror** | **1** | — | — | — |
| 7 · sweeps | scribe ‖ steward ‖ keeper | 3 spawns | — | 312k | 5.2m |

**Dror: 2 approval prompts, both at a gate, neither wasted.** Roughly 1.34M
subagent tokens and about 50 minutes of agent wall-clock for one markdown file —
the right ratio only because the deliverable was the *findings*, not the file.

**Rework rounds: 2, both productive.** Round 1 fixed seven review findings,
two of them factual errors. Round 2 fixed two residuals neither the review nor
doc-keeper had found. Neither was the developer failing; both were the loop
finding what one reader alone missed.

**Where §3.3 worked exactly as designed:** findings went back to the *same*
developer instance via `SendMessage`, context intact. No re-briefing cost.

---

## 2. The mechanism defects — these matter more than the templates

**M1 · `isolation: worktree` branches from `origin/main`, always.** Root cause
found by `pr-steward` from the reflog, re-verified:

```
worktree-agent-aa16bcb12fa68d1ef@{0}: branch: Created from origin/main
worktree-agent-a14346a359e4fef07@{0}: branch: Created from origin/main
```

Not the session's branch, not the brief's declared base. **Appendix B's
`Base branch:` field is decorative** — nothing reads it and the spawn
contradicts it silently. Two of three spawns this run landed on `b451ee7`
(#109), which is not on `integration/sprint-6`. It cost nothing here only
because the file was the identical blob on every base; a task on a file that
*differs* would have produced a silently wrong diff. The PR was rebuilt on a
fresh branch off `integration/sprint-6` so #109 would not ride along.

**M2 · `origin/integration/sprint-6` was 17 commits behind local, and did not
contain the sprint's own locked baseline.** Found by the integrator.
`git merge-base --is-ancestor 97582b6 origin/integration/sprint-6` → **NO**.
The unpushed commits included the entire agent-team infrastructure (`1dc92de`,
`88c9359`, `280205d`, `ba2189a`) and both lock commits. Every open PR targeted
a branch predating the baseline. Pushed during this run as a fast-forward
(`9016893..a29fdef`) with Dror's approval, before the merge, because merging
first would have ended the fast-forward.

Tested rather than assumed: the push changed no other PR's mergeability.
`#95/#92/#89` were **already** conflicting against the old base; `#136/#116/
#108/#91/#90` were clean before and after.

**M3 · The lead session's agent registry is resolved once, from its working
directory.** `developer`, `doc-keeper` and `integrator` exist only on
`integration/sprint-6`; the session was launched from a checkout on another
branch, so none was spawnable. Moving the working directory did not re-resolve
it. All three ran as `general-purpose` with the role file pasted verbatim
(deviation **D-1**, below). M2 is why: the files were in an unpushed branch.

**M4 · Worse than M3 — a *stale* registered role runs silently.** The
registered `pr-steward` is the pre-2026-09-20 version: it still owns
"Sweep 3 — documentation drift" **and** still has `Edit`. The sprint-6 version
removed both, handing drift to `doc-keeper` so "two agents never fix the same
file twice". Spawning by name would have run an older role with *wider*
permissions. An unregistered name fails loudly; a stale one does not.

**M5 · The consult is not read-only, and §7 does not say it should be.** The
second consult, spawned as `general-purpose` (tools `*`), wrote
`scripts/.tmpcheck/probe.sh` into the live-served worktree, `git add -f`'d it,
and ran a suite there — the exact #135 failure mode. The manager cleaned the
index by hand. §7 says "one question, the evidence, one answer" and nothing
about tools. The third consult was given explicit read-only instructions and
complied.

---

## 3. What the templates got wrong

**B1 · Appendix B is written for a code task.** `Done when: <the test that
proves it>`, `Suites to run`, and `Surface row` have no honest value for prose,
and the template itself warns that a blank field is one the developer fills
with a guess.

**B2 · `Base branch:` is unenforced.** See M1.

**B3 · Line citations are treated as scope, and they arrive wrong.** The
citation that produced this task — `docs/sprint6-tracks.md` → `docs/onboarding-
to-active-plan.md:81-94` — was wrong by a whole section (81-94 is A1/A2), and
it appeared **twice**, at `:207` and `:647`. Every reader then checked the diff
rather than enumerating the claim: a verifier `PASS`, a seven-finding review
and a doc-keeper pass all missed two more structures making the same claim. The
third reader found them, and only because it was asked a scope question.

**C1 · `Preflight: --paths` proves nothing, and not only for docs.** §3.2 and
`developer.md` rule 5 say `--paths` catches "a rule-6 literal or a mis-named
migration". It catches neither: B6 and B7 sit after the early exit at
`scripts/preflight-checks.sh:101`, which runs B3 and B4 only. **This affects
code tasks, where it matters most.** For this file nothing applies in any mode:
B6 filters by extension and skips `.md`; the doc-path warning iterates a
hardcoded five files that does not include it.

**C2 · A verifier `PASS` is necessary and not sufficient on prose.** It checked
that each citation *pointed* at real text; it did not check whether the
sentence built on it was true. Two factual errors survived a PASS. Appendix C
presents that line as the evidence.

**C3 · `Unassertable claims:` does not exist in Appendix C.** The brief invented
it; the developer populated it in all three handovers; nobody noticed until
doc-keeper tried to confirm the field existed.

**C4 · The proposed commit message is per-handover; a commit is per-task.**
After three passes the developer's message described only pass 3. The manager
composed the real one.

**C5 · Role collision — `doc-keeper` was report-only at *both* seats.** Seat 1:
editing the file under task would make it a co-author of what it certifies. On
all of track 4, where every task's owned path *is* a document, that makes it
structurally report-only — and `doc-keeper.md` says the opposite ("write the
paragraph — in the developer's worktree"). Seat 2: its sweep batches into a
`docs:` commit nobody had approved. **Its editing authority was never exercised
once.** It also reported drift without the routing consequence — "here is drift
I did not fix", not "and this costs a developer round before gate 1" — which is
the only reason a third consult was needed.

---

## 4. Proposed edits — Appendix B and C

**Proposed, not applied.** `.claude/` and the plan are the lead's or Dror's.

### Appendix B

Add to the preamble:

> **Line numbers are evidence, not scope.** A brief may cite a line to show
> where a problem was seen; it never means "only this line". For a drift or
> correctness fix the unit is the **claim on a topic across the owned paths** —
> the developer enumerates every place the file makes that claim, and the grep
> belongs in the handover. Citations arrive wrong and go stale the moment the
> file is edited: this template's own first task was filed against
> `docs/onboarding-to-active-plan.md:81-94`, twice, for a claim that lived at
> `:66` and in §3.

Replace three fields and add one:

```
Base branch: integration/sprint-6   <- VERIFY AFTER SPAWN. `isolation: worktree`
             branches from origin/main regardless of what this says. First act
             in the worktree: `git merge-base --is-ancestor <base> HEAD`. If it
             fails, say so in the handover before doing any work.

Unit of work: <for a drift or correctness fix on a document: the CLAIM, not the
             line range. Enumerate every place in the owned paths that makes it;
             correct each, or name the ones deliberately left.>

Surface row:  control-plane | relay | worker | migration | release payload
              (site/server/shared) | trip-web | web | mcp | companion templates
              | scripts   (the two clocks)
              | docs — no runtime, no clock; name who reads it and what they do
                with it. A wrong claim is acted on at the next read, not the
                next restart.

Suites to run: …  (from verifier's path→suite table — for a docs task look up
              the path each corrected CLAIM is about, not the path the diff
              touches; a claim with no assertion is listed as such, never left
              blank)

Done when:    <the test that proves it> · verifier report attached · handover
              block returned. Not "PR opened" — the manager opens it after gate 1.
              Docs task: every status claim the diff changes carries (a) a named
              existing assertion, run and pasted, (b) a pasted command and output
              against a named, dated target, or (c) an explicit restatement as a
              dated observation, listed under "Unassertable claims".
```

### Appendix C

```
Enumeration: <for a drift fix: the grep for the claim across the owned paths,
              and what it returned — the evidence that the claim was checked
              everywhere, not just where it was last pointed at>
Verifier:     <pasted report, verbatim …>  On a docs task the question put to
              verifier is NOT "which suites does this diff touch" (none) but
              "for each claim in this diff, is it true of this tree, and what
              command shows it" — per claim: the claim, the assertion or command,
              the real output, true/false/unassertable. A verifier PASS proves a
              citation points at real text; it does not prove the sentence built
              on it is true.
Preflight:    scripts/preflight-checks.sh --staged (or --all) on the changed
              files: <exit + BLOCK lines + the warn lines for THIS file>.
              `--paths` runs B3 and B4 only and is NOT evidence — B6 (rule 6) and
              B7 (migrations) sit after its early exit. If the changed file is
              outside every check's scope, say so: a clean run that inspected
              nothing is not a pass.
Unassertable claims: <claims restated as dated observations, and why no assertion
              exists>
Base check:   <`git merge-base --is-ancestor <brief's base> HEAD` — pass/fail.
              Fail is not a blocker; an unreported fail is.>
Proposed commit message:   <for the WHOLE task, not this handover. On a rework
              round, revise it rather than describing only what changed since
              the last one.>
```

---

## 5. Open items for Dror

1. **Fix the spawn base (M1)** or make Appendix B's field a checked precondition.
   This is the one defect that will corrupt a real task.
2. **Decide `doc-keeper`'s authority (C5).** Either write the co-authorship
   exception into `doc-keeper.md`, or drop it and let it edit.
3. **Make the consult read-only (M5)** — a tools-restricted agent file, or a
   standing line in §7.
4. **`sprint-scribe`'s citation fix is uncommitted** in
   `.claude/worktrees/sprint6-tracks` on `docs/sprint-6-tracks` — a branch that
   already merged via #111. It needs a fresh branch and PR; it will not arrive
   on its own.
5. **Branch/worktree cleanup proposed, not run** — `docs/137-front-door-claims`
   (and its origin copy), `worktree-agent-aa16bcb12fa68d1ef`,
   `worktree-agent-a14346a359e4fef07`, `integrator/pr138-check`, `pr-138-head`.
   All `ahead=0`; all verified to carry nothing unrepresented in `7f742b5`.
6. **Issue #137 stays open** — `Closes #137` only fires on a merge to the default
   branch. It closes when `integration/sprint-6` reaches `main`.
7. **The file is still not finished**, and doc-keeper's sweep says why: at
   `:93`, immediately after the new note's "not a claim about today", the
   untouched next line reads *"This is much further along than the ledger reads.
   A family could use that site today."* A1–A4 have all shipped since (A1 via
   `transformer.py` full-name matching; A2 by a different mechanism —
   `WORKER_LOG_LEVEL`, `602f450` — than the doc proposes; A3 via the SSH-bridge
   fork rather than the tooled worker `companion-install-plan.md` recommends;
   A4 via migration `0043`, whose header cites this document by name). §6 items
   1, 2 and 4 are stale in the same shape as items 3 and 5. **This is the unit-
   of-work lesson repeating**: the brief bounded the task to one claim, and the
   document has others.
8. **Unrecorded, needs a person:** has the portal→runtime bridge ("Activation
   B3", the 09-10 section) had deployed acceptance since 2026-09-11? No doc
   trail either way. And was `companion-install-plan.md`'s recommendation-vs-
   outcome mismatch a late decision or drift?
9. **Sprint 6's plan section still has zero `— BUILT` markers** and the
   four-track split is not recorded in the plan. `sprint-scribe` confirmed it,
   did not start it, and surfaced it rather than assigning it. Its own pass.

---

## D-1 — deviation, recorded in full

The three new roles were not registered (M3) and ran as `general-purpose` with
the role file pasted verbatim ahead of the brief, plus one bracketed harness
note telling each that its tool surface was wider than its role allows.

**Preserved:** every hook-enforced restriction. `pretooluse-bash.sh` and
`pretooluse-write.sh` branch on the *presence* of `agent_type`, not its value,
so commit/merge/push/deploy denial and the `CLAUDE.md` and `.project/sprint.json`
write denials applied unchanged. `model`, `isolation` and `background` were
supplied per invocation.

**Not in force:** the `tools:` allowlists, `effort: high`, `maxTurns`. The path
"may not" lists were advisory — but they are advisory under a registered
definition too; only `CLAUDE.md` and `.project/sprint.json` are hooked.

**Consequences for this report:** the role text shared a channel with the brief,
so any confusion between standing authority and task instruction is an artifact
of D-1, not a template finding; and the run did not exercise the `tools`
allowlist or `effort: high`, so it is not evidence that either is correctly
sized. Scope compliance was verified by diffing changed paths against the brief
at gate 1 — by inspection, not by construction.

**Retires on:** the agent files reaching a branch every session checks out.
M2's push was the first half of that.

---

## What worked, and should not be changed

- **The gates.** Two prompts, both real decisions, nothing rubber-stamped.
- **Findings to the same developer instance** (§3.3) — no context rebuild.
- **Roles defined by what they may not do.** The developer reported the base
  anomaly instead of working around it. `pr-steward` proposed deletions and
  waited. `sprint-scribe` refused to assign an unowned gap and refused to let a
  drift entry overclaim. The integrator declined to spawn `regression-planner`
  and said what would have changed that, and reported the honest ceiling of a
  verifier run on prose rather than a green line meaning nothing.
- **Agents checking each other rather than deferring.** The developer
  re-derived the review's dating and corrected its own earlier date in the
  process; doc-keeper checked `gh pr view 44 --json mergedAt` and found
  "merged 2026-09-11" right in IL time rather than re-raising it; the verifier
  flagged a sandbox-refused check as a caveat instead of reporting a pass.
- **The consult (§7)** earned its place three times — but see M5.
