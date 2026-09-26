# The agent team — Sprint 6 onwards

> **Status: decided, 2026-09-20.** Dror took the nine decisions in §9 the same
> day; three of them were build instructions and are built (§8 says which).
> The rest of §8 is what still has to exist before the first run.
>
> **Scope and start (Dror, 2026-09-20):** this is the standing operating model
> from **Sprint 6 onwards**, and it **starts only once the Sprint 6 baseline is
> locked down** — the baseline report, its triage and the baseline fixes on
> `integration/sprint-6`. Prerequisites may be built before that; nothing in
> §4 runs against product code until then. §10 has the sequence. Every claim
> about the tree, the hooks or Claude Code was checked on 2026-09-20 (Claude
> Code 2.1.236 on the Mac) and says so where it matters.

Sprint 6 is five tracks meant to run **in parallel** (PR #111,
`docs/sprint6-tracks.md`). Three or more sessions already commit to
`integration/sprint-6`, about fifty issues are open, the fleet monitor files
more, and the tracks document ends with a list of the places where parallel
work collides. The work is parallel; the coordination is not. This document
lays out a team of agents that makes the parallelism safe: who holds which
authority, how work is briefed and allocated, where the human gates stay, and
which model each role runs on.

It builds on two things this repository already got right and should not
re-decide:

- **Roles are defined by what they may *not* do.** `verifier` cannot edit,
  because a verifier that can edit can make itself pass. `sprint-scribe` cannot
  record approval. `regression-planner` cannot deploy. Every role below carries
  the same kind of list.
- **The human holds two gates, merge and deploy** (until 2026-09-26 they were
  commit and deploy — §9 decision 11), and the hooks make each one a prompt
  rather than a rule to remember (`scripts/claude-hooks/`). No agent gets
  either. A feature-branch commit or push is no longer a gate: it reaches
  nobody, and the merge is where the evidence exists. The team's job is to make
  each remaining prompt a well-prepared decision — and, since that date, to
  reduce how often Dror is asked, because three prompts a change had become
  clicks.

---

## 0. The short version

| Role | Exists? | Runs as | Model · effort | May | May not |
|---|---|---|---|---|---|
| **Dev manager** | new | the lead session — the one Dror talks to | Sonnet 5 · high; an Opus 5 consult for a judgment call (§7) | order the queue, write briefs, allocate paths, hold the infrastructure window, surface decisions; run the commit, merge, push or deploy command *after* Dror's word at the gate | write product code; commit, merge, push or deploy without that word; decide an unowned gap |
| **Developer** | new | `developer` subagent, one worktree each, in the background | Sonnet 5 · high; Opus 5 when the brief is marked *design-heavy* (§7) | code and tests inside its owned paths, spawn `verifier`, ask the manager | commit, push, merge, deploy, touch paths outside its brief, edit plan/ledger/agents/hooks |
| **Reviewer** | exists as `/code-review` + `boundary-reviewer` | run by the manager against the developer's worktree, fresh context | Opus 5 · high | read, report | fix |
| **Integrator** | half exists (`pr-steward`, `sprint-scribe`) | `integrator` subagent | Sonnet 5 · high; an Opus 5 consult for the same-intent check and conflict resolution | order the merge queue, `merge-tree`, resolve conflicts on a throwaway branch, verify the merged tree, prepare carry-forward | merge, push, close issues, record approval, promote a release |
| **Regression planner** | exists | as today: CI on PR open; locally before a risk-class merge; sprint mode at sprint end | Opus 5 (CI already pins it) · high | assess, cost, plan | deploy, approve, edit the plan doc |
| `verifier` | exists | spawned by developer and integrator | Sonnet 5 · medium | run the suites, paste real output | edit |
| `sprint-scribe`, `run-capture` | exist | once a day, for the merges since the last run / after every live run | Sonnet 5 · high | mark plan and ledger, route rows | invent an owner, record approval |
| `pr-steward` | exists | once a day; sprint end | Sonnet 5 · medium | sweep branches and PRs (doc drift is `doc-keeper`'s since 2026-09-20) | delete an unmerged branch |
| `boundary-reviewer` | exists | whenever a brief flags a security path | Opus 5 · high | audit with live evidence | fix |
| **Doc keeper** | new (takes over `pr-steward`'s doc-drift sweep) | `doc-keeper` subagent: before gate 1 on the developer's handover; once a day and at sprint end as a sweep | Sonnet 5 · high; judgment calls reported, not decided | edit any document, write design docs, fix unambiguous drift, propose CLAUDE.md wording | edit code, the plan or the ledger; commit; invent a rationale; apply a CLAUDE.md rule change |

**Before the first run** (§8): the hard-rule-1 hook does not fire on
`git merge`, `gh pr merge`, `git push` or `git cherry-pick` — all four classify
as `none` today — so an integrator with Bash could land work on the integration
branch unprompted. That is closed first, and the hook learns to refuse (not
ask) for the roles that must never commit. Both are built (§8), as are the
sprint and baseline locks in `.project/sprint.json`, the generated Codex
mirror, and the refusal of CLAUDE.md edits to every subagent.

**Recommended path** (§6): subagents from a lead session now, on the Claude Code
already installed; Agent Teams once the loop has survived one sprint; saved
Workflows for the two fixed pipelines (integrate, sprint gate).

---

## 1. The concept, mapped onto what already exists

| Concept | What it becomes here | Why |
|---|---|---|
| Dev manager — priorities, distribution, estimation, sync | **The lead session**, not a subagent. Its written outputs are the queue (labelled issues) and the brief per task. | It needs the Agent tool with the most spawn depth, it is who Dror talks to, and its estimate reuses `regression-planner`'s cost model (§7 there) rather than a second one. |
| Developer — code to the team's standards, consults peers, writes and runs tests | **`developer` subagent** in its own worktree. Writes the test first, runs the suites, and spawns **`verifier`** for the report it hands back — it does not certify its own work. | The repository already separates "wrote it" from "proved it" and the reason still holds. |
| Integrator — collapse PRs and issues into the sprint plan | **Three halves.** `pr-steward` (what is merged, stale, drifted) and `sprint-scribe` (mark the plan, move the ledger, surface unowned gaps) exist. The missing half is the **merge queue**: order, mergeability, conflict resolution, verification of the merged tree, carry-forward. That is the new `integrator`. | Two of the three exist and are scoped carefully; adding a third file is cheaper than widening one. |
| Regression agent | `regression-planner`, unchanged. | It already has the three modes (branch, issue, CI) and a defined seat in the deploy hook. |
| *(not in the concept)* Reviewer | `/code-review` at high effort, plus `boundary-reviewer` when a brief flags a security path. **No new agent file.** | Nobody in the four-role concept reads the code for correctness before it merges — the planner assesses risk, the verifier runs suites. A fresh-context read of the diff is the cheapest error catcher in the loop, and the tooling exists. |
| *(not in the concept)* Live acceptance | Dror, from one self-contained script (`docs/setup-test-plan.md`, `live-run` skill). | Standing decision: live runs are driven by a person, from a script, and reviewed afterwards. |
| Documentation agent — documents aligned, drift found, decisions, architecture and considerations explained | **`doc-keeper` subagent** (§3.6). Two seats: before gate 1 it reads the developer's handover and gives every decision a home, so the document lands in the same commit as the code; once a day and at sprint end it sweeps for drift. Takes over `pr-steward`'s third sweep. | Dead paths and stale counts are already swept. The *why* is captured nowhere once a PR merges — the same loss the carry-forward discipline exists for. |

---

## 2. Invariants the team is built around

1. **Authority is per role and written down.** A role's "may not" list is in its
   agent file *and* enforced by a hook where a script can enforce it (§8).
2. **Commit and deploy are human gates.** A developer's task ends at "ready to
   commit" with a handover (Appendix C). The integrator's task ends at "ready to
   merge" with a report. Dror runs — or approves, through the hook prompt — the
   commit, the merge and the deploy.
3. **One writer per path at a time.** A brief names the paths a task owns and
   the paths it must not touch. The manager holds the live claims table and
   refuses to start a task whose paths overlap a running one. A conversation
   between developers never transfers ownership; only the manager reallocates.
4. **Infrastructure is single-threaded and code is not.** Proxmox, NPM,
   Cloudflare and the tunnel are shared by the Mac and the VM; `cptest` is shared
   between sessions; one `getUpdates` loop per bot. The manager grants one
   infrastructure window at a time and every provisioning step waits for it.
5. **The brief is the lever.** A subagent knows only what its brief says. A
   thin brief produces confident wrong work; the template in Appendix B is the
   minimum.
6. **Evidence, not description.** A handover carries the verifier's pasted
   output, and a security path carries a request and a response.
7. **Nobody works in the shared main checkout.** Every developer is in its own
   worktree; the main checkout is where another session's branch switch lands
   on your commit.
8. **The locks are a file, not a memory.** `.project/sprint.json` says which
   sprint is active, what it scopes, which commit its baseline is, and whether
   the sprint or the baseline is locked. Every session reads it at start;
   every commit checks it; only `scripts/project-state.py` changes it, and an
   override is recorded there. `.project/README.md` is the contract.
9. **A decision without a recorded reason is not done.** The developer writes
   its decisions into the handover as it makes them; the doc keeper gives each
   one a home before the commit. A reason that cannot be sourced is marked
   unrecorded, never reconstructed.

---

## 3. The roles

### 3.1 Dev manager — the lead session

**Inputs:** the sprint section of `docs/onboarding-mvp-sprint-plan.md` (what),
`docs/sprint6-tracks.md` (how, cadence, collisions, priority order), open
issues including the fleet monitor's, the Status ledger, and the carry-forward
list on the integration PR.

**Outputs:**

- **The queue.** GitHub issues, labelled and ordered. Labels to add:
  `sprint-6`, `track:1` … `track:5`, `size:S|M|L`, `blocked`, `agent:ready`,
  `agent:in-progress`. A milestone per sprint (none exist today). The tracks
  doc's priority order is the default order: unblockers first, then track 4's
  audit, then track 2's events, then track 1 biggest-blank-first, then track 3,
  then track 5.
- **A brief per task** (Appendix B), posted as the issue's first comment from
  the manager, so it survives the session.
- **An estimate per task**, in the vocabulary the regression planner already
  uses: which surface row it lands on (the two clocks), which suites prove it,
  how many approval rounds it will cost Dror, and whether it needs live minutes
  or an infrastructure window. T-shirt size on top. The number of approval
  rounds — since 2026-09-26 the merge and the deploy, not the commit — is the
  estimate that matters most.
- **The claims table**: task → owned paths → worktree → developer. Held in the
  session and mirrored to the issue as the `agent:in-progress` label plus a
  comment naming the paths, so a second session can read it.
- **Decisions needed**, to Dror, in one place per day: unowned gaps, two tasks
  that both want a path, an item whose only proof is an 80-minute run.

**Rules:** it does not write product code (it briefs a developer, even for a
one-liner, so the verifier and reviewer see it); it does not assign an owner
to a gap the plan does not own (standing instruction — flag it); it never
records approval; it does not touch the infrastructure window itself.

**Model:** Sonnet 5 at high effort for the everyday loop — labelling, briefs
from a settled tracks document, claims, spawning. A hard call — two briefs
contending for a path, an item whose only proof is an 80-minute run, an
estimate on a migration — goes to an Opus 5 consult (§7) or to Dror, and the
manager records the answer. Decision 8: Opus for judgment calls, not for
everyday work.

### 3.2 Developer — `.claude/agents/developer.md`

Spawned by the manager with a brief, in a fresh worktree (`isolation:
worktree`). **Where that worktree branches from is a documented setting,
`worktree.baseRef`** (code.claude.com/docs/en/worktrees): the default `fresh`
branches from the remote's default branch, `origin/main` — which is where two
of the dry run's three spawns landed (M1) and a probe from a second session
on 2026-09-21 landed too — and `head` branches from the session's current
HEAD. This project sets `head` in `.claude/settings.json` (this revision), so
a spawn from a lead session on the integration branch starts there — proven
the same day: a probe spawned before the setting landed on `origin/main`, one
spawned after it landed on the integration branch head. The
developer still proves it: first act, move the fresh branch onto the brief's
base commit and check; a failed check blocks, and the handover carries a pass
as `Base check:`. Runs in the background; several run at once on
path-disjoint briefs.

**Does:** reads the brief and only the parts of CLAUDE.md the brief points at;
writes the test first where practical; changes only its owned paths; runs the
suites the brief names as it goes; spawns `verifier` for the final report;
stages its files in its own worktree and runs `scripts/preflight-checks.sh
--staged` — `--paths` runs only the two fast checks and proves nothing about
rule 6 or migrations (dry run, C1); returns the handover block (Appendix C).

**Asks the manager when:** it needs a path outside its brief, the brief's
acceptance test cannot be written as stated, it finds a second bug (it reports;
it does not fix what it was not asked to), or the design has a fork the brief
did not settle. In subagent mode "asks" means it returns early with a `needs:`
list and the manager re-briefs it (SendMessage resumes it with its context
intact). In teams mode it can message a peer directly — but a peer cannot grant
a path.

**Does not:** commit, push, merge, deploy; edit `CLAUDE.md`, `.claude/`,
`.codex/`, `scripts/claude-hooks/`, `.githooks/`; edit the sprint plan or the
ledger (`sprint-scribe` owns those); run `preflight-deploy.sh` in a worktree
that is live-served (it relinks `node_modules` — memory
`preflight-relinks-worktree-node-modules`); raise a test timeout to make a red
test green; work in `/Users/elul/kinerary` itself.

**Ends with:** the handover. The manager decides whether it goes to review or
back to the developer.

**Model:** Sonnet 5 at high effort by default — a complete brief is everyday
work. Opus 5 when the manager marks the brief *design-heavy*: a fork the brief
could not settle, a contract with two producers, anything under the security
paths. Reasoning in §7.

### 3.3 Reviewer — `/code-review` and `boundary-reviewer`

Run by the manager against the developer's worktree after the handover, with
the diff and the brief — **not** the developer's conclusion. `/code-review
high` for correctness and simplification; `boundary-reviewer` whenever the
brief's security flag is set or the diff touches `server/server.js`,
`shared/needs-schema.js`, `shared/agent-schema.js`, or an authenticated route.
Findings go back to the *same* developer instance, which keeps its context.
**At most two rounds** (2026-09-26): a finding after the second that is not a
correctness or security defect becomes a follow-up issue, named in the PR's
carry-forward; a third round is Dror's call. (#199 ran four audit rounds and
filed #225 for what was left; the cap makes that the default, not a decision
taken each time.)

Read-only by construction. No new file.

### 3.4 Integrator — `.claude/agents/integrator.md`

Runs when the manager says a PR is ready, and at sprint end.

**Per PR:**

1. **Order the queue** by the tracks doc's rule: whatever unblocks another track
   first. Today that is PR #92's assessment, the sprint-6→main merge, and any
   migration-bearing PR.
2. **Prove mergeability without touching anything:**
   `git merge-tree --write-tree <base> <head>`. Clean or conflicted, exit code
   and the conflicted paths.
3. **Detect the same intent arriving twice.** A textual clean merge is not a
   semantic one — the `travel_anchors` prompt and `_ANCHOR_TYPE_MAP` case
   (memory `sprint6-locked-pending-main-merge`) is the model: both sides edit the
   same concept in different regions. For every file both sides touch, read
   both hunks; whether they are the same intent is a judgment call, so it goes
   to `consult` (§7) with both hunks and both PR descriptions, never the
   integrator's own conclusion, and the answer is recorded verbatim.
4. **Resolve on a throwaway branch in its own worktree**, never on the
   integration branch. Reconcile, do not take a side wholesale.
5. **Verify the merged tree.** Green CI on the PR's merge ref *is* that
   verification (2026-09-26) when the merge is clean, no file is touched by both
   sides and no security path is involved (`model-runner.ts`, `server/server.js`,
   `shared/`, anything spawning a process with an environment); the handover
   says which it relied on. On any overlap or security path, or with a required
   suite red or missing, spawn `verifier` on the merged tree. A migration added
   by the PR makes `migrations.test.ts` fail until its list is updated — the
   planner already says so; the integrator checks that the PR updated it.
6. **Re-run `regression-planner` (branch mode) on the merged result** when the
   merge changes the risk class — a migration, `shared/`, the sanitizer, an
   authenticated route, or relay behaviour. A site-only, test-only, tooling or
   docs PR needs no plan: the handover says `not needed (<why>)`. The
   sprint-mode plan before each release is unchanged.
7. **Carry forward.** Unresolved review items from the PR are written into the
   integration PR's "Carried-forward open items" section, grouped under the PR
   number, deliberate-decision rows marked as such (memory
   `sprint-pr-carry-forward`).
8. **Hand Dror one decision:** merge #N — clean / resolved at `<throwaway>`,
   verifier report, plan at `docs/test-reports/…`, carry-forward drafted. Dror
   merges, or approves the merge command.
9. **After the merge:** queue it for the daily sweep — `sprint-scribe` marks the
   plan and the ledger and `pr-steward` sweeps the branches and worktrees once a
   day for the merges since the last run, and at sprint end, not per merge
   (2026-09-26).

**At sprint end:** the same procedure for `integration/sprint-6 → main`, plus
`regression-planner` in sprint mode, plus the deploy hook's plan note (it greps
`docs/test-reports/` for the exact HEAD — so the plan is written *after* the
final commit, or it names an earlier commit and says so).

**Respects the lock.** Sprint 6 is locked as of 2026-09-20 (`.project/sprint.json`,
`locks.sprint`); while it is, the integrator neither assesses nor prepares the
sprint-6→main merge.

**Does not:** merge, push, close issues, record approval, promote a release,
deploy, edit the plan or the ledger, delete a branch.

**Model:** Sonnet 5 at high effort for the queue, `merge-tree`, the verifier
run and the carry-forward. The same-intent check on a file both sides touch,
and any conflict resolution, go to an Opus 5 consult (§7) with both hunks and
the question — a bad merge on a branch three sessions share is the most
expensive mistake in this loop, and that step is the judgment call.

**Reads the locks from the file.** `scripts/project-state.py show --json`:
`locks.sprint.state == "locked"` means neither assess nor prepare the
sprint→main merge; `locks.baseline.state == "open"` means the team has not
started. Not from a memory file, not from a person.

### 3.5 Regression planner — unchanged

Three seats in the flow: CI on PR open (no fleet access, says so); locally,
triggered by the integrator, when a merge changes the risk class; sprint mode
before the VM upgrade. Its plan file is what the deploy hook reads back to Dror.
Model stays Opus 5 — the CI workflow already pins `claude-opus-5`.

### 3.6 Doc keeper — `.claude/agents/doc-keeper.md`

Keeps the documents true to the tree, and makes sure every implementation
decision, architecture change and consideration has a home and reads well to
someone who was not in the room.

**Why it is a role and not a sweep.** `pr-steward`'s third sweep already fixes
dead paths and stale counts. What nothing does today is capture the *why*. The
reasoning in a PR body like #116's — two bugs found before anything depended on
them, what was deliberately not applied to production and why — becomes
invisible the moment the PR merges, which is the same loss the carry-forward
discipline was created for. The keeper harvests it into the document that owns
it, at the moment that is cheapest: before gate 1, so the document change lands
in the same commit as the code.

**Two seats in the flow:**

- **Before gate 1, per task.** It reads the developer's handover (the
  `Decisions made:` block, Appendix C), the diff and the PR body draft. For
  each decision: is it recorded, in the document that owns that kind of content
  (the map below), with the alternative it rejected and why? If not, the keeper
  writes the paragraph in the developer's worktree, so it ships with the code.
  Documents the diff touched are checked for drift right then.
- **Once a day, and at sprint end — the sweep** (2026-09-26; was after each
  merge), over the merges since the last sweep. `scripts/preflight-checks.sh
  --all` warn lines for dead paths first, then a read for: commands and paths
  that no longer work, counts that moved on, architecture claims contradicted
  by the tree, a rule describing a mechanism that has since changed, a design
  superseded by a decision recorded somewhere else (the tracks document's
  "Stale source — do not work from it" box is the shape). Unambiguous drift is
  fixed; the fixes batch into one `docs:` commit at a cadence Dror sets, so a
  sweep costs one prompt rather than one per file. Judgment calls are reported.

**The map — which document owns what.** The keeper carries this table in its
own file and refuses to put content where it does not belong:

| Content | Home |
|---|---|
| A rule an agent must follow | `CLAUDE.md` — rules only; it links out for everything else |
| Architecture, feature inventory, schema | `FRAMEWORK.md` |
| Quick start, hosting options | `README.md` |
| A design and the reasoning behind it | `docs/<topic>-design.md`, or the existing design document it extends |
| How to operate something | the runbook — `docs/control-plane-vm-deployment.md`, `docs/migrations.md`, `mcp/PROVISIONING.md`, … |
| What a sprint builds and where it stands | the sprint plan and the tracks document — `sprint-scribe`'s, not the keeper's |
| Evidence from a run or an assessment | `docs/test-reports/` |
| A decision with no document yet | a new `docs/<topic>-design.md`, never a paragraph in CLAUDE.md |

**When the task's owned path is itself a document, the keeper still edits it**
(decided 2026-09-21, from the §10 dry run's C5). On track 4 nearly every task's
deliverable is a document, so a keeper restricted to reporting there is
structurally report-only for a whole track and every finding becomes a
developer round — the dry run paid exactly one round plus one Opus consult for
it, and the file still shipped unfinished. The objection the restriction rested
on, that a co-author cannot certify, does not apply: the keeper certifies
nothing. "Certify" appears twice in this plan and in `.claude/agents/`, both
times about the developer, both times answered by `verifier` (§3.7, the only
source of "the suites pass") and `/code-review` (§3.3). `verifier` may not edit
because an editing verifier can make itself pass — a named, mechanical failure.
There is no equivalent failure here, and a restriction with no failure behind it
is a tax, not discipline.

**Invariant 3 is kept by sequence, not by silence.** "One writer per path at a
time" bars *concurrent* writers and ownership moving by peer agreement; the
keeper is spawned by the manager after the handover is returned and after
review, into a worktree whose developer has stopped — which is the manager
reallocating, the one sanctioned path. This is not new exposure: the seat has
always written into the developer's worktree so the paragraph ships with the
code. What the manager holds is the order — it does not resume a developer
while the keeper is in its tree, and a keeper finding that needs the developer
back is a re-spawn *after* the keeper finishes, never alongside it.

**What the keeper does not fix, it routes with its cost.** A judgment call, a
finding that needs code, a reason it cannot source: each names who must act and
whether acting costs a round before gate 1. Reporting drift without its
consequence is what made the dry run's third consult necessary.

**The rule it must not break: it never invents a rationale.** When a decision
is visible in the diff but its reason is in nobody's handover, PR body, commit
message or conversation, the keeper records *decided; reason not recorded —
ask <who>* rather than a plausible why. A rationale nobody made is worse than a
gap, because it will be relied on.

**Does:** edit any document, including the one the task under review delivers;
write a new design document; run read-only
inspection; propose CLAUDE.md wording.

**Does not:** edit code or tests; edit the sprint plan or the ledger; commit;
edit CLAUDE.md at all — it is policy, not documentation (decision 9): the
keeper detects drift there and writes the proposed diff into its report, and
a person applies it after explicit approval. The Write hook refuses CLAUDE.md
to every subagent, so this is enforced, not remembered. It does not duplicate
content between CLAUDE.md, FRAMEWORK.md and README.md (fix at the source and
link), and it never records approval.

**`pr-steward`** keeps its first two sweeps, branches and PRs; its third moves
here so two agents never fix the same file twice.

**Model:** Sonnet 5 at high effort. The sweep and the filing are everyday
work; whether a claim is stale or deliberately aspirational is a judgment
call, and the keeper reports those rather than deciding them.

### 3.7 The supporting cast

`verifier` (Sonnet 5, medium) is spawned by the developer for the handover and
by the integrator for the merged tree; it is the only source of "tests pass" in
a report. `sprint-scribe` and `run-capture` (Sonnet 5, high) run rarely; their
characteristic error — routing an item to the wrong sprint, which then looks
handled — is prevented by their rule, which is to flag rather than decide. `pr-steward`
(Sonnet 5, medium) is mechanical sweeping with explicit rules.
`boundary-reviewer` (Opus 5, high) is security.

---

## 4. A task's life

```
tracks doc · issues · monitor reports · ledger
            │
            ▼
   ┌─ dev manager ─────────────────────────────────────────────┐
   │ label + size + order → brief (Appendix B) → claim paths   │
   └────────────┬──────────────────────────────────────────────┘
                │ spawn, background, own worktree
                ▼
   ┌─ developer ──────────────────┐     needs: <path|decision>
   │ test first → code → suites   │ ───────────────────────────► manager re-briefs
   │ → verifier → handover (App C)│
   └────────────┬─────────────────┘
                ▼
   ┌─ review ─────────────────────┐
   │ /code-review high            │  findings → same developer instance
   │ boundary-reviewer if flagged │
   └────────────┬─────────────────┘
                ▼
   ┌─ doc-keeper ─────────────────┐
   │ every decision in the        │  edits land in the same commit
   │ handover gets a home; docs   │  as the code
   │ the diff touched checked     │
   └────────────┬─────────────────┘
                ▼
   ═══ GATE 1: commit — NO PROMPT on a feature branch (2026-09-26) ═══
                │  commit on the feature branch · PR → integration/sprint-6
                │  CI: regression assessment posts on the PR
                ▼
   ┌─ integrator ─────────────────────────────────────────────┐
   │ order → merge-tree → same-intent check → resolve on a    │
   │ throwaway → verifier → planner if risk class changed →   │
   │ carry-forward → one report                               │
   └────────────┬─────────────────────────────────────────────┘
                ▼
   ═══ GATE 2: Dror — merge; the one prompt, with base branch + CI ═══
                │
                ▼
   sprint-scribe marks plan + ledger · pr-steward sweeps branch + worktree
   doc-keeper sweeps the tree for drift → fixes batch into one docs: commit
                │
   ── sprint end ──────────────────────────────────────────────
   integrator: integration → main · regression-planner sprint mode
                ▼
   ═══ GATE 3: Dror — deploy (kinerary-cp-release, hook prompt) ═══
                │
   live run by Dror from one script → run-capture → ledger
```

Three gates; since 2026-09-26 gate 1 is not a prompt — the lead commits and
pushes a feature branch itself — so Dror is asked at gate 2 (merge) and gate 3
(deploy), each already prompted by a hook or a runbook. The team changes what
arrives at each prompt.

---

## 5. Keeping developers off each other's feet

The tracks document already did the analysis; the mechanism is what is missing.

- **Path ownership in the brief, held by the manager.** Two running briefs
  never share a path. The four day-one items in the tracks doc are
  path-disjoint by construction and are the natural first parallel run (§10).
- **One worktree per developer,** created by the spawn (`isolation: worktree`).
  Nobody in the main checkout. **And one lead per worktree:** on 2026-09-21
  two lead sessions edited this plan and `doc-keeper.md` in the same worktree
  within seconds of each other, each applying the same five edits. It was
  found by file timestamps, not by any mechanism, and nothing was lost only
  because both stopped and one took the pen. A lead session works in a
  worktree no other session commits from.
- **The hard serialisations, each a single lock the manager grants:**
  - the **infrastructure window** — a pilot re-provision, the `japan-2026` full
    cycle, a VM ship, a Mac e2e: one at a time, and never overlapping a VM run;
  - **`model-runner.ts` has one owner** (track 3) and track 2 consumes what it
    records;
  - **`cptest`** — a DB-backed suite names its own database; two runs at once
    corrupt each other. Each lane's is `cptest_<lane>` (the brief's `Test
    database:` field), never the bare shared `cptest`;
  - **the companion install path** — the SSH forced command names one checkout
    for every companion built (#127); a task that changes what a companion is
    built from waits for that to be repointed.
- **Migrations no longer need a reservation.** The tracks doc asks for numbers
  to be allocated per track; CLAUDE.md has since moved to
  `YYYYMMDDHHMMSS_description.sql`, which makes the collision impossible. What
  still needs ordering is two in-flight migrations against the *same table*;
  the manager serialises those two briefs.
- **Codex takes part on the same terms.** A Codex session acting as a
  developer claims an issue the same way, works from the same brief, hands
  back the same block, and runs the same hooks (`.codex/hooks.json` mirrors
  `.claude/settings.json`). Its role text is the generated
  `.codex/agents/<role>.toml`, so the two sides cannot describe different
  roles (decision 6).
- **Consultation.** In subagent mode a developer's question goes through the
  manager (return with `needs:`, get re-briefed). In teams mode developers
  message each other, and the manager stays the record: a message can settle
  *where a thing should land*; it cannot move a path from one brief to another.

---

## 6. The mechanism: subagents now, teams later, workflows for the pipelines

Checked against the Claude Code docs on 2026-09-20; installed version 2.1.236.

**Phase 1 — a lead session with subagents. Works today.** Agent files in
`.claude/agents/` support `model`, `effort`, `tools`, `disallowedTools`,
`permissionMode`, `isolation: worktree`, `background`, `memory`, per-agent
`hooks`, and `maxTurns`. Subagents can spawn subagents (three deep) and can
message each other and the lead with SendMessage. That is enough for two to
four developers in parallel with the manager as the hub. Two fields to know
about: `maxTurns` returning a *partial* handover arrived in 2.1.246 and the
documented model-resolution order in 2.1.251, so upgrade before relying on
either.

**Roles load once per session, from the checkout it starts in** (dry run, M3
and M4). A role missing from that checkout is not spawnable — the dry run ran
three roles as `general-purpose` with the file pasted — and a role that changes
on disk after the session started keeps running its *old* text silently: the
session had loaded a `pr-steward` that still owned the doc sweep and still had
Edit. So: a team session starts from a checkout of the integration branch
*after* the roles it needs are committed there, and restarts after any role
changes. `sessionstart.sh` prints `roles as of <commit>` so the transcript
records which version loaded; before spawning, compare it with
`git log -1 --format=%h -- .claude/agents`.

**Phase 2 — Agent Teams, once the loop has run a sprint.** Experimental, behind
`CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS=1`. Teammates get their own context
windows, a shared task list, direct messaging, and the lead names them — the
literal shape of "developers consult each other, the manager synchronises".
Known limits: no `/resume` with in-process teammates, one team per session, the
lead is fixed, no nested teams. The reason to wait is not the flag; it is that
the brief template, the claims table and the hook fixes are the same in both
modes, and they should be proven before adding a preview feature on top.

**Workflows for the two fixed pipelines.** The Workflow tool runs a saved
script that fans agents out deterministically (`agent`, `parallel`,
`pipeline`, `phase`), saved to `.claude/workflows/` and invoked as a command.
It is explicit opt-in per run, which suits the hard rules. Two candidates:

- `/integrate <PR numbers>` — merge-tree → same-intent check → verifier →
  planner-if-risk-class-changed → report. Everything up to gate 2.
- `/sprint-gate` — the sprint-end sequence up to gate 3.

Open-ended development stays with subagents or teams; a workflow is for a
sequence whose steps do not change.

**Routines (cloud, scheduled): not for this.** They clone the default branch,
push only to `claude/` branches, have no SSH and cannot see the fleet. The one
plausible use is a read-only nightly "already-fixed audit" over issues and PRs,
and the fleet monitor already covers the half that matters.

**Codex.** `.codex/agents/*.toml` is generated from `.claude/agents/*.md` by
`scripts/sync-codex-agents.py`; preflight B9 blocks a commit while a mirror
differs or a source is staged without it (built 2026-09-20, decision 6). Until
then the mirror was hand-kept and had drifted: two files said AGENTS.md where
the source said CLAUDE.md, the newest did not, and the newest agent existed on
the Codex side only as an untracked file.

---

## 7. Models and effort

| Role | Model | Effort | Why this tier |
|---|---|---|---|
| Dev manager | Sonnet 5, the lead session | high | labelling, briefing and allocation are everyday work |
| Developer | Sonnet 5 | high | coding against a complete brief is everyday work |
| Developer, brief marked *design-heavy* | Opus 5 | high (xhigh when the brief says so) | a fork the brief could not settle is a judgment call |
| Reviewer (`/code-review`) | Opus 5 | high | whether a diff is correct is a judgment call |
| Integrator | Sonnet 5 | high | queue, merge-tree, verifier, carry-forward are mechanical |
| Regression planner | Opus 5 | high | risk is a judgment call; CI already pins it |
| verifier | Sonnet 5 | medium | runs commands and reports honestly |
| sprint-scribe, run-capture | Sonnet 5 | high | they flag what they cannot route; they do not decide |
| pr-steward | Sonnet 5 | medium | mechanical sweeps with explicit rules |
| boundary-reviewer | Opus 5 | high | security is a judgment call |
| doc-keeper | Sonnet 5 | high | sweeping and filing are everyday; stale-or-aspirational is reported, not decided |
| **The consult** (`consult`) | Opus 5 | high | one question, the evidence, one answer with its reasoning; read-only by construction |

**The consult** is how decision 8 is applied without a second copy of every
role: a Sonnet role that reaches a judgment call — the manager ordering two
briefs that contend for a path, the integrator deciding whether two hunks are
the same intent — spawns `consult`, hands it the question and the evidence
(both hunks, both briefs, never its own conclusion), and records the answer
with its reasoning. It is its own agent file, `.claude/agents/consult.md`, with
Read, Grep and Glob and nothing else, because the dry run's second consult —
spawned as `general-purpose` with every tool — wrote a probe file into the
live-served worktree, staged it into the shared index and ran a suite there
(M5, the #135 failure). A judgment call runs nothing; a command it needs is
returned for the caller to run.

Principles behind the table:

- **Opus for hard decisions and judgment calls, not everyday work** (Dror,
  decision 8). Haiku 4.5 has no seat: nothing here is a bulk transform.
- **The scarce resource is Dror's approval rounds, not tokens.** The `claude`
  CLI here is subscription-authenticated (the CI workflow says so), so cost
  shows up as rate limits and rework, not dollars. A developer that gets it
  right the first time is cheaper than one that costs a second prompt.
- **Lower the effort before lowering the model.** Anthropic's own guidance:
  measure the capable model at lower effort before building a cheaper cascade.
  Opus at medium is the first step down for a developer, Sonnet the second.
- **Definitions win; the environment must not override them.** Leave
  `CLAUDE_CODE_SUBAGENT_MODEL` unset and never set
  `CLAUDE_CODE_SUBAGENT_MODEL_FORCE` — it silently runs every role on one model.
- **Per-agent `effort` protects against the Mac's personal `xhigh`.** The
  user-level `effortLevel: xhigh` is what made a nested `claude -p` take 143s
  against a 60s limit on 2026-09-16. Every agent file sets its own.
- **Measure one sprint, then revisit:** prompts per task, rework rounds,
  verifier-red-after-developer-green, merge conflicts per PR, tokens per role.

---

## 8. Prerequisites — build these before the first task

1. **Close the merge hole in the hard-rule-1 hook — built 2026-09-20.**
   `scripts/claude-hooks/match-command.py` now classifies `git merge`,
   `cherry-pick`, `revert`, `rebase`, `am` and `gh pr merge` as `merge` and
   `git push` as `push`; both prompt like `commit`, and `merge-tree`,
   `merge-base`, `--abort` and `gh pr view` stay silent. Tests in
   `tests/scripts/test_match_command.py`.
2. **Make the hook refuse per role — built 2026-09-20.** `pretooluse-bash.sh`
   reads `agent_type` from the payload; for any subagent a commit, merge, push
   or deploy classification is a **deny with the reason** — hand back the
   change, the verifier report and a proposed commit message — and the lead
   session is asked as before. One script, one place; no per-agent `hooks:`
   block. Tests in `tests/scripts/test_claude_hooks_bash.py`.
3. **Write `developer.md`, `integrator.md` and `doc-keeper.md` — built
   2026-09-20**, with `model:` and `effort:` on all nine files per §7,
   `pr-steward`'s third sweep handed to the keeper, the Codex mirror
   regenerated, and `tests/scripts/test_agent_files.py` holding the tiers.
4. **Labels and a milestone — built 2026-09-20** on GitHub: `sprint-6`,
   `track:1..5`, `size:S|M|L`, `blocked`, `agent:ready`, `agent:in-progress`;
   milestone "Sprint 6".
5. **A readable sprint lock — built 2026-09-20.** `.project/sprint.json`,
   changed only by `scripts/project-state.py`, printed at session start,
   checked on every commit (B8), with overrides recorded and named in the
   commit prompt. `.project/README.md` is the contract. The sprint lock is
   recorded as locked, the baseline as open; the session preparing the
   baseline locks it when the baseline fixes have landed.
6. **CLAUDE.md is closed to subagents — built 2026-09-20.** The Write hook
   refuses it to any tool call carrying an `agent_type`, with the reason; the
   lead session may still write it, and its commit is still hard rule 1.
7. **Upgrade Claude Code — done 2026-09-20**, 2.1.236 → 2.1.267 (Homebrew
   cask), past 2.1.246 for `maxTurns` partial output and 2.1.251 for the
   documented model-resolution order.

---

## 9. Decisions — taken by Dror

1. **Developer commit authority.** Hard rule 1 stays exactly as written: one
   prompt per commit, batched at the end of a task. Count the prompts during
   Sprint 6; the count is the argument either way.
2. **Integrator merge authority.** Never. Dror merges after the integrator's
   report. Prerequisite 1 closes the hook hole regardless.
3. **Phase 1 runs on subagents.** Teams later, once the loop has run a sprint.
4. **The reviewer is `/code-review` plus `boundary-reviewer`.** No new file.
5. **The queue is GitHub issues**, with labels and a milestone per sprint.
6. **Codex gets every role and works the same issue queue.** Its mirror updates
   automatically: `scripts/sync-codex-agents.py` generates
   `.codex/agents/*.toml`, and preflight B9 blocks drift. *Built.*
7. **Both locks are explicit, durable and agent-readable**, with one source of
   truth: `.project/sprint.json`, changed only through
   `scripts/project-state.py`, printed at session start, checked on commit,
   overrides recorded and named in the commit prompt. A fresh session can
   read the active sprint and its scope, the baseline branch and commit, and
   what an override takes, with no prior context. *Built.* The session
   preparing the baseline locks it when done.
8. **Opus for hard decisions and judgment calls, not everyday work.** Applied
   in §7 through the consult.
9. **CLAUDE.md is policy, not documentation.** The doc keeper may detect
   drift and prepare a suggested diff; it never applies one. Any edit to
   CLAUDE.md is a decision and needs explicit approval. Enforced: the Write
   hook refuses CLAUDE.md to every subagent. *Built.*
10. **The keeper edits the document under task** (2026-09-21, from the §10 dry
    run's C5). When a task's owned path is itself a document, the doc keeper
    edits it like any other. It holds no verdict, so co-authorship costs
    nothing; invariant 3 is kept by sequence — the developer has handed over
    and stopped — rather than by making the keeper report-only across a whole
    documentation track. What it does not fix, it routes with its cost.
    Decision 9 is untouched: CLAUDE.md remains the one document it may never
    edit.
11. **Feature-branch commits and pushes are not prompts; the merge into the
    leading branch is** (Dror, 2026-09-26; amends decision 1). Decision 1 said
    to count the prompts during Sprint 6 and that the count is the argument
    either way. The count: #192, #196, #197, #211 and #215 merged 24–45 minutes
    after they opened, so the time went on three prompts a change (commit,
    push, merge), not on review. The merge prompt is where the integrator's
    report and CI exist; its text now carries the PR's base branch and check
    results. Decision 2 stands: Dror merges. *Form:* Dror chose option (b) —
    commit and push of `fix/`, `feat/`, `carry/`, `chore/` branches unprompted,
    one prompt at the merge — over (a), one approval covering all three. `main`
    is the production branch and `integration/sprint-N` the leading branch;
    neither is exempted, and a merge onto `main`, a deploy, and every subagent
    action are unchanged. Narrowed with it, all agreed the same day: the
    per-PR regression plan is for migrations, auth/boundary and relay-behaviour
    PRs; green CI on the merge ref replaces the integrator's local verifier
    when the merge is clean, no file overlaps and no security path is touched;
    the sweeps run daily; a PR gets at most two review rounds; each lane uses
    its own test database. Implemented in CLAUDE.md ("MVP phase", item 3),
    `scripts/claude-hooks/pretooluse-bash.sh` and the integrator, developer and
    doc-keeper roles.

---

## 10. Rollout and what to measure

**Scope: Sprint 6 onwards.** This is the standing operating model, not a
Sprint 6 experiment. What changes per sprint is the input — that sprint's
section of the plan, its tracks document, the issues in its milestone — never
the roles, the gates or the brief.

**Start condition: the Sprint 6 baseline is locked down — it is, at
`97582b6` since 2026-09-20 — and the end-to-end run has passed at that
baseline** (Dror, 2026-09-20: "as soon as the e2e will pass the sprint can
start"). The baseline is `docs/test-reports/sprint-6-baseline-2026-09-20.md`
with its triage and the fixes it sent to `integration/sprint-6`; the team
starts when he locks it — `scripts/project-state.py lock baseline --by "Dror"
--reason …`, which pins the branch head as `baseline.commit` — and every agent
reads that from `.project/sprint.json`, not from a person. Nothing in §4 runs
against product code before it.

**Before the lock — prerequisites only.** §8 touches hooks, agent files,
labels and tooling, none of which is product code or baseline work, so it is
built while the baseline is being closed out; every item is (2026-09-20).

**Day one after the lock — done 2026-09-20/21.** Issue #137 went through
the whole loop as PR #138; the findings are
`docs/test-reports/agent-team-dry-run-2026-09-21.md` (PR #139). Every gate
held and nothing was rubber-stamped. It found five mechanism defects and five
template defects; this revision of the plan carries the fixes — the worktree
base (§3.2 — `worktree.baseRef: head` in `.claude/settings.json`, plus the
developer's check), the read-only consult (§7), the stale-role rule (§6), and
Appendices B and C rewritten from the report's proposed wording. The doc
keeper's editing authority (C5) is settled by decision 10: it edits the
document under task, because it certifies nothing and invariant 3 is kept by
sequence — the restriction the dry run ran under was the one finding that, on
review, turned out to be the manager's own error rather than the plan's.

**Then.** The four day-one items the tracks document names — track 4's audit,
track 2's hand evaluation, track 3's `minimax` pin, track 1's destination-info
pass — as four developers in parallel. They share no file, by that document's
own check, so any collision is a defect in the mechanism, not in the work.

**Sprint end.** The integrator prepares `integration/sprint-6 → main`; the
regression planner runs in sprint mode; the doc keeper sweeps; Dror deploys with
`kinerary-cp-release` (`--dry-run` first); live run from one script;
`run-capture` afterwards. The next sprint starts the same way with its own
inputs.

**Measure across the sprint,** per role: approval prompts per task; rework
rounds (developer → review → developer); verifier red after a developer
reported green; merge conflicts per PR and how many were same-intent;
decisions the keeper found unrecorded; tokens. Those numbers decide §9.1 and
whether phase 2 (teams) is worth its preview status.

---

## Appendix A — draft agent files

These are now the files in `.claude/agents/` (built 2026-09-20); the
frontmatter is reproduced here so the plan reads on its own. Field names were
checked against the sub-agents documentation the same day.

```yaml
---
name: developer
description: Builds one briefed task in its own worktree — test first, code inside its owned paths, suites run, verifier report attached — and hands back ready to commit. Never commits, pushes, merges or deploys. Use with a brief (docs/agent-team-plan.md, Appendix B); never with a bare issue number.
tools: Read, Grep, Glob, Edit, Write, Bash, Agent(verifier)
model: sonnet
effort: high
isolation: worktree
background: true
maxTurns: 150
---
```

```yaml
---
name: integrator
description: Prepares one merge decision at a time for the integration branch — order, merge-tree, same-intent check, conflict resolution on a throwaway branch, verifier on the merged tree, carry-forward — and hands it to a person. Never merges, pushes, closes issues or records approval. Use when a PR is ready for the integration branch, and at sprint end.
tools: Read, Grep, Glob, Edit, Write, Bash, Agent(verifier), Agent(regression-planner), Agent(sprint-scribe), Agent(pr-steward), Agent(consult)
model: sonnet
effort: high
isolation: worktree
---
```

```yaml
---
name: doc-keeper
description: Keeps every document true to the tree and every implementation decision recorded where it belongs, with its reasoning — before a commit, from the developer's handover, so the document lands with the code; after a merge and at sprint end, as a drift sweep. Fixes unambiguous drift, reports judgment calls, never invents a rationale. Never edits code, the sprint plan, the ledger, or CLAUDE.md's rules.
tools: Read, Grep, Glob, Edit, Write, Bash
model: sonnet
effort: high
---
```

```yaml
---
name: consult
description: Answers one judgment call for a Sonnet role from the evidence it is handed, with its reasoning. Read-only by construction: no Bash, no Write. Spawn it with the question and the evidence, never with your own conclusion.
tools: Read, Grep, Glob
model: opus
effort: high
---
```

The manager spawns the developer with `model: opus` on a brief marked
*design-heavy* — a per-invocation override, which is why the file says
`sonnet`. The consult is a file rather than an override because a tool
restriction cannot be passed per invocation, and the dry run showed why it
must be one.

No `hooks:` block: the project's `PreToolUse` hook in `.claude/settings.json`
already fires inside subagents, and its payload carries `agent_type`, which is
what prerequisite 2 branches on. `tools: … Agent(verifier)` is the whole spawn
allowance — a `disallowedTools: Agent(x)` entry would remove the Agent tool
entirely, per the docs, so it is not used.

The existing six files gain two lines each — `model:` and `effort:` — with
the values in §7. Nothing else in them changes.

## Appendix B — the brief template

The manager writes this; the developer receives it and nothing else about the
task. A field left blank is a field the developer will fill with a guess.
Revised after the dry run (`docs/test-reports/agent-team-dry-run-2026-09-21.md`).

**Line numbers are evidence, not scope.** A brief may cite a line to show
where a problem was seen; it never means "only this line". For a drift or
correctness fix the unit is the **claim on a topic across the owned paths**:
the developer enumerates every place the file makes that claim, and the grep
belongs in the handover. Citations arrive wrong and go stale the moment the
file is edited — this template's own first task was filed against
`docs/onboarding-to-active-plan.md:81-94`, twice, for a claim that lived at
`:66` and in §3.

```
Task:        #NNN <title>
Track:       N          Size: S|M|L        Model: opus|sonnet    Effort: …
Base:        integration/sprint-6 @ <commit>     <- VERIFIED BY THE DEVELOPER,
             not by this line: the spawn's worktree may not start here (§3.2).
             Its first act: `git reset --hard <commit>` on the fresh worktree,
             then `git merge-base --is-ancestor <commit> HEAD`. Pass goes in
             the handover as `Base check:`; fail is BLOCKED (needs: worktree
             based on <commit>) with no work done.
Worktree:    (created by the spawn)

Goal (one observable sentence):
Unit of work: <for a drift or correctness fix on a document: the CLAIM, not the
             line range. Enumerate every place in the owned paths that makes
             it; correct each, or name the ones deliberately left.>
Done when:   <the test that proves it> · verifier report attached · handover
             block returned. Not "PR opened" — the manager opens it after gate 1.
             Docs task: every status claim the diff changes carries (a) a named
             existing assertion, run and pasted, (b) a pasted command and output
             against a named, dated target, or (c) an explicit restatement as a
             dated observation, listed under "Unassertable claims".

Owns (paths):        …
Must not touch:      …  (owned by #MMM — say why, so a developer who needs
                         it asks instead of working around it)
Surface row:         control-plane | relay | worker | migration | release
                     payload (site/server/shared) | trip-web | web | mcp |
                     companion templates | scripts   (the two clocks)
                     | docs — no runtime, no clock; name who reads it and what
                       they do with it. A wrong claim is acted on at the next
                       read, not the next restart.
Test database:       cptest_<lane>  (its own database on the test Postgres —
                     never the bare shared `cptest`; n/a if no DB-backed suite)
Suites to run:       …  (from verifier's path→suite table — for a docs task
                     look up the path each corrected CLAIM is about, not the
                     path the diff touches; a claim with no assertion is listed
                     as such, never left blank)
Security path:       no | yes → boundary-reviewer on the handover
Migration:           no | yes → timestamped name, `-- rollback:` header,
                     migrations.test.ts list updated
Infra window:        no | yes → wait for the manager's grant
Known traps:         the CLAUDE.md sections that apply, by name — not the
                     whole file
Ask the manager when: <the forks this brief did not settle>
```

## Appendix C — the developer's handover

Revised after the dry run: `Base check:`, `Enumeration:` and `Unassertable
claims:` are new; `Verifier:` and `Preflight:` say what they prove; the commit
message is per task, not per handover.

```
Task #NNN — READY | BLOCKED (needs: …) | PARTIAL (what is left, and why)

Base check:   git merge-base --is-ancestor <brief's base> HEAD → pass
              (a fail is BLOCKED (needs: worktree based on <base>) with no
               work done — never a handover note)
Changed:      <file: what changed, one line each>
Enumeration:  <drift or correctness fix: the grep for the claim across the
               owned paths and what it returned — the evidence the claim was
               checked everywhere, not just where it was last pointed at>
Tests:        <file::name — what each proves>
Verifier:     <pasted report, verbatim>. On a docs task the question put to
              verifier is NOT "which suites does this diff touch" (none) but
              "for each claim in this diff, is it true of this tree, and what
              command shows it" — per claim: the claim, the assertion or
              command, the real output, true/false/unassertable. A verifier
              PASS proves a citation points at real text; it does not prove
              the sentence built on it is true.
Preflight:    scripts/preflight-checks.sh --staged in the developer's own
              worktree, with `git diff --cached --name-only` pasted first: it
              inspects every staged path, so that list must equal the owned
              paths. Then <exit + BLOCK lines + the warn lines for these
              files>. `--paths` runs B3 and B4 only and is NOT evidence — B6
              (rule 6) and B7 (migrations) sit after its early exit; `--all`
              inspects the whole tree, not the change. If the staged files are
              outside every check's scope, say so: a clean run that inspected
              nothing is not a pass.
Security:     n/a | request/response pasted
Unassertable claims: <claims restated as dated observations, and why no
              assertion exists>
Proposed commit message: <for the WHOLE task, not this handover. On a rework
              round, revise it rather than describing only what changed since
              the last one.>
  <type>(sprintN.M): <subject>

  <body>
PR body draft: <what, why, verification, what was deliberately not done>
Decisions made: <each choice, the alternative rejected, and why — written as
               they were made; the doc keeper files these, and one it cannot
               source is recorded as unrecorded>
Carry-forward: <review items or gaps that are decisions, not fixes>
Unowned gaps:  <anything the plan does not own — for the manager to flag>
Outside brief: <bugs seen, not fixed>
```
