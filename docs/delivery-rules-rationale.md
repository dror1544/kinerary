# Delivery rules: the reasoning and the hook mechanics

The full text of five `CLAUDE.md` sections as they stood on 2026-11-22, before
that file was cut down to the rules themselves. It is kept for the measurements,
the incidents and the exact shapes the hooks accept. It is a record, not policy:
**where this file and `CLAUDE.md` disagree, `CLAUDE.md` wins**, and a rule change
is made there.

## MVP phase — lighter rules (owner's decision, 2026-09-25; item 3 and the last paragraph, 2026-09-26)

For as long as the product is an MVP running family-and-friends trips, three
kinds of friction are removed. They remove a prompt, not a protection: the
approval for code moves to the merge, and every hard rule above still holds
for deploys, binaries and this deployment's names.

Two branch roles carry names in this document. The **leading branch** is
where work lands; the **production branch** is what a release is cut from.
**Since 2026-11-15 both are `main`** ("Faster delivery" below, item 3): a PR
targets `main`, and no further `integration/sprint-N` is cut. Until then the
leading branch was `integration/sprint-N`, and the items below were written
with that name: wherever one says the merge into `integration/sprint-*` is the
one prompt, that prompt is now the merge into `main`. Nothing below exempts
`main`: a merge onto it always asks, and nothing is committed to it directly —
docs-only work goes through a `docs/*` branch and a PR like everything else.

1. **Docs-only work needs no per-commit approval.** A commit whose every staged
   path is documentation (`docs/**/*.md`, `CHANGELOG.md`, `FRAMEWORK.md`,
   `README.md`), and the push of commits that are only that, on an
   `integration/sprint-*` or `docs/*` branch, from the lead session, is not
   prompted. `scripts/claude-hooks/pretooluse-bash.sh` implements it and
   vouches only for one plain `git commit` (message from `-F <file>` or
   `-m '<text>'`) or one plain `git push` to the branch's own upstream — never
   `git add … && git commit`, `-a`, `--amend`, `--no-verify`, another directory,
   a force, or a merge commit. `CLAUDE.md`, `AGENTS.md`, `.claude/`,
   `.githooks/`, `.github/` and `scripts/` are policy, not documentation, and
   always ask. Merges, deploys, and commits or pushes outside items 1 and 3
   still ask (rules 1 and 2). A subagent is still refused for all of them.
2. **Read-only production probes need no per-probe approval.** Health checks,
   versions, trip dates, dropped-config paths and similar reads against the
   control-plane VM and the live trips. A probe may read a trip's key inside the
   command to authenticate; it never prints, logs or writes the key, never puts
   it on a command line (feed it to `curl --config -` on stdin, as
   `companion-install-host.sh` does), and reports only the verdict. Anything
   that writes, restarts, deploys or changes a config still needs approval, and
   reading what travellers wrote is not a probe: the alpha-tester data policy
   applies. The harness's own permission classifier is separate from this rule
   and can still ask; a Bash permission rule in the *user's* settings, not in
   this repo, is how to quiet it.
3. **Feature-branch work needs no per-commit or per-push approval; the merge
   into the leading branch is the approval (owner's decision, 2026-09-26).**
   Before this, one change cost three prompts — commit, push, merge; across
   Sprint 6's first 43 PRs that was 96 commit prompts plus their pushes. Those
   prompts were friction more than delay: a PR opened a median of 0.0 hours
   after its first commit, and the wait is after it opens — median 2.4 hours
   open-to-merge, 30 hours at the 75th percentile. The baseline and what is
   re-measured are in
   `docs/test-reports/process-baseline-2026-09-26.md`. A commit on a `fix/`, `feat/`, `carry/`
   or `chore/` branch from the lead session, and the push of that branch to its
   own name on origin, are not prompted: nothing reaches anyone until the branch
   is merged. `pretooluse-bash.sh` vouches only for one plain `git commit`
   (message from `-F <file>` or `-m '<text>'`) or one plain
   `git push [-u] origin <that branch>`, in this repository's own worktrees
   (`cd <dir> &&` or `git -C <dir>` is read; another repository is not vouched
   for) — never for a staged policy path (`CLAUDE.md`, `AGENTS.md`, `.claude/`,
   `.githooks/`, `.github/`, `scripts/`, `.preflight-allow`), `-a`, `--amend`,
   `--no-verify`, a force, another branch, or `main`. Three inert shapes are
   read as the plain form first, for this item and item 1 alike (2026-09-26: the
   decision log showed 8 of 9 prompts in 90 minutes were for commits meant to
   pass): a message written as a heredoc with a QUOTED delimiter
   (`-m "$(cat <<'EOF' … EOF)"`, Claude Code's own style), rewritten only when
   the delimiter's FIRST terminator line is followed by nothing but the closing
   `)"` (the shell ends the heredoc there and would run anything after it), `-q`,
   and a trailing
   `2>&1`, `| tail -N`, `| head -N` or `| grep -v '<text>'`. Any other pipe,
   chain or substitution still asks (`match-command.py --normalize`). The mechanical checks run
   first, from that worktree's own copy of `scripts/preflight-checks.sh`,
   against that worktree's index. **The merge into `integration/sprint-*` is the
   one prompt**, and its text carries the PR's base branch and its check
   results (`gh pr view`, best effort — an unreadable GitHub says so and still
   asks). A merge onto `main`, a deploy, and every commit, push or merge by a
   subagent are unchanged.

4. **Small-tier work may be implemented by the lead session directly, instead
   of briefed to a developer (owner's decision, 2026-09-30).** "Small" is
   mechanical, not judged: `git diff --name-only <base>...HEAD | scripts/
   regression-assessment-scope.sh` exits 0 — the SAME script and the SAME
   never-safe-first path list #320 already uses to skip the CI regression
   assessment, one list for both callers, never copied into prose here or
   anywhere else. `verifier` is still spawned exactly as for a developer's
   work — it cannot edit, so it cannot pass itself, and a lead session that
   edits and then grades its own change quietly loses that invariant. The work
   still happens on a `fix/`/`feat/`/`chore/` branch, in a worktree that is
   **not** the tree currently served to staging or production (`docker
   inspect` says which; the nightly redeploys staging from
   `~/kinerary-nightly` every night at 02:00, so "not live-served" moves —
   check, never assume). The PR body carries `Path: direct` (vs `developer`)
   and `size:S`; Normal and High tiers are unaffected and keep the developer
   hop unchanged. Full shape: `docs/agent-team-plan.md` §3.1 and §3.6.

What stays a gate: the integrator, boundary review for security paths, a
regression plan before a release that carries a risk-class change (narrowed
2026-11-14, see "Faster delivery" below), and every merge to `main`
and deploy. What is narrower since 2026-09-26, by the owner's decision:

- the per-PR regression plan is for PRs that add a migration, touch auth or a
  boundary path, or change relay behaviour; a site-only, test-only, tooling or
  docs PR is recorded as "assessment: not needed (why)". The deploy prompt only
  reads back a plan for the exact HEAD being deployed, which a per-PR plan is
  not;
- green CI on the PR's merge ref stands in for the integrator's local
  merged-tree verifier when the merge is clean, no file is touched by both
  sides and no security path is involved (`model-runner.ts`, `server/server.js`,
  `shared/`, anything spawning a process with an environment). On any overlap
  or security path the full path applies: a clean merge is not evidence there;
- the documentation and branch sweeps run once a day and at sprint end, not
  after every merge;
- a PR gets at most two review rounds. A finding after the second that is not a
  correctness or security defect becomes a follow-up issue, named in the PR's
  carry-forward; a third round is the owner's call.

Rules 2–6 are untouched.

## Faster delivery (owner's decision, 2026-11-14)

Between 2 October and 14 November 2026 a PR reached the leading branch a
median 1.9 hours after it opened (101 PRs), and then waited: the leading
branch reached `main` four times in six weeks, the last time as one batch of
about 33,000 changed lines, and a merged change reached a running trip only
through three hand-run steps per trip, each with its own prompt. Nothing let
anyone choose *which* trips a feature reached. Dror's decision: deliver
faster, and make "one trip, every trip, or future trips" a choice.

**The method, in build order** (each has, or gets, a spec under `docs/specs/`
before it is briefed):

1. **Per-trip feature switches.** A new feature ships switched off and its
   code goes to every trip. Switching it on is a data change: for one trip,
   for every trip, or as the default for trips created from then on. A switch
   nobody recognises is **off** — the same fail-safe direction as the
   visibility rules under "Security-sensitive paths".
2. **One rollout command per trip.** Site payload, bridge restart, health
   check and prompt refresh, in that order, with the version recorded on the
   trip and the previous one kept as the way back. A rollout goes to a staging
   trip first, then one trip, then the rest.
3. **`main` is the leading branch — in force since 2026-11-15**, when item 1's
   first slice reached `main` (#582). PRs target `main` and
   `integration/sprint-N` stops being cut; `integration/sprint-8` is kept, not
   used. `.project/sprint.json` still names it until the next sprint is opened
   with `scripts/project-state.py set-sprint`, which is the owner's call. A
   feature that is not ready ships switched off instead of waiting on a branch.
4. **Control-plane images are built in CI and pulled by the VM**
   (`docs/future/control-plane-ota-upgrades.md`).

**Rules that changed on 2026-11-14:**

- **A regression plan, and the owner's manual test, before a merge to `main`
  are for a change set that carries a risk-class change**: a migration, an auth
  or boundary path, or relay behaviour — the same list the per-PR plan already
  uses. For any other change set, green CI on the merge ref and the last green
  nightly are the evidence, and the PR records "assessment: not needed (why)".
  The merge to `main` itself still asks.
- **A deploy is approved per rollout, not per step.** One approval names the
  commit, the trips and the steps, and covers exactly those. A step that fails
  stops the rollout; anything outside the named set asks again. Until the
  rollout command of item 2 exists the hooks cannot tell that several commands
  are one rollout and still prompt for each: ask once in words, with the whole
  list, and do not re-argue it at every prompt.
- **Switching a feature on or off for a test trip needs no approval.** A test
  trip is one still being built: a lifecycle state before `ready_private`.
  A trip at `ready_private` or later is treated as in use, whatever
  `scripts/teardown-trip.py` would accept, and a switch on it is a deploy
  under hard rule 2 (Dror, 2026-11-14: both production families' trips sat at
  `ready_private` that day, so "not past `ready_private`" would have let a
  switch reach them unasked). The command enforces it with `--live`. On
  staging a trip at `ready_private` or later still gets the prompt, because
  the hook cannot tell which stack a command reaches; approving it there is
  routine.

**What did not change:** hard rules 3–7; boundary review with live
request/response evidence for security paths; migration naming and the
`-- rollback:` header; `kinerary-cp-release` with its snapshot before any VM
upgrade; and the owner's own approval for a production deploy that carries a
`breaking` migration, which a rollout approval never implies (narrowed on
2026-11-20 from "any migration" — see below).

## Standing deploy approval (owner's decision, 2026-11-20)

Dror, after a day of per-step questions on the VM: *"Do not hold back anymore,
I want fast deployment."* Every VM and trip change already has a way back — the
release snapshot, the previous release kept on the trip, a switch turned off,
the same command run again — so a question per step cost more than it guarded.

**The lead session deploys without asking first, then verifies and reports**:
a trip's deploy wrapper, a site or bridge restart, a rollout, promoting a
release to `available`, a feature switch on one trip or on future trips, a VM
upgrade whose `--dry-run` reports no `breaking` migration, a bot's settings.
The report names what changed, what was checked and how to undo it.

**It still asks first**, by the owner's same decision:

- deleting a real trip or travellers' data (`teardown-trip.py --execute` on a
  trip in use, anything that drops rows a person wrote);
- a VM upgrade that carries a `breaking` migration, and a rollback that would
  discard the database;
- removing, stopping or recreating a shared container (hard rule 7, unchanged);
- a feature switch for **every** trip (`--all`), which reaches the families'
  trips in use at once.

**A subagent still deploys nothing**, and Codex is not covered: the approval is
the owner's to his lead session.

**How the hook knows.** The grant is the owner's own, so it is set in *his*
user settings, never in this repository: `KINERARY_STANDING_DEPLOY_APPROVAL=1`
in the `env` of his `~/.claude/settings.json`. A second Kinerary does not
inherit it, `codex-adapter.py` drops it, and unset every deploy asks exactly as
before. Set, `pretooluse-bash.sh` gives **no decision** on a deploy that
`match-command.py --deploy-class` calls `routine`, so the harness's own
permission rules still judge the command; it never vouches for one. `routine`
is an allow-list (`ROUTINE_DEPLOY`): a deploy verb not named there, any verb in
`ASKING_DEPLOY`, and any command that also commits, merges or pushes still
asks. `kinerary-cp-release upgrade` stays on the asking side, because only its
dry run can see a `breaking` migration (a missing header reads as breaking):
that is one click per VM release, after the dry run has said what it carries.
Quiet deploys are logged as `standing` in the decision log.

## Two repositories — `kinerary` is the product, `kinerary-deploy` is where it runs

**`kinerary` says what and how. `kinerary-deploy` says where.** That is the
whole rule, and hard rule 6 is the test for it.

**The reason is portability, not secrecy.** It is tempting to think the split
exists because this repo has been public — which would make it negotiable the
moment it goes private. It is not. The product has to be deployable on k3s, on
a different Proxmox, on hardware nobody here owns; anything that assumes *this*
house is a thing the second deployment has to find and undo. Secrecy is a
side-effect of the split, never its justification.

**What it looks like in practice** — the mechanism is generic and refuses to
guess; a thin private wrapper supplies the values:

| | |
|---|---|
| `scripts/bootstrap-fleet-monitor.sh` | knows no host, container, uid or path; **refuses** if they are unset |
| `kinerary-deploy/bootstrap-monitor.sh` | knows this VM, and is the only half that had to be private |

`deploy.sh`, `bring-up.sh` and `setup-mcp.sh` are the same split, one level
down. `bring-up.sh` says it in its own header: *"Deliberately NOT part of the
kinerary git repo … this is operator/deployment concern for real
infrastructure, and it names real hosts and checkouts."*

**A default that names this house is the failure mode**, not a convenience.
`compute.py` still defaults `proxmox_host` to `192.168.0.40`, `rpi_host` to a
machine that was decommissioned when ingress moved to CT120, and
`proxmox_ssh_key` to a key name from this laptop. All three are overridden by
`provisioning.env` here, so nothing is broken *here* — which is exactly why
nobody notices. The second deployment that forgets one env var does not get an
error; it quietly points at somebody else's home lab.

**The escape hatch is a recorded decision, not a habit.** Pre-existing
offenders are enumerated in `.preflight-allow`, each with its reason. That list
is the migration backlog — entries come off it, they do not accumulate.

## The hard rules are enforced, not just written

Every rule in "Hard Rules" above is now checked by
`scripts/preflight-checks.sh`, which has two callers so no commit path escapes:

- **`.githooks/pre-commit`** — every commit, whoever makes it (Codex, Hermes,
  a plain `git commit`). Enable once per clone: `git config core.hooksPath .githooks`.
- **`.githooks/pre-merge-commit`** — the same checks on the path that skips
  them. `git merge` does **not** run `pre-commit`; git fires this instead. Until
  2026-09-19 only the former existed, so every blocking rule had a hole shaped
  like an integration branch — work is written on a feature branch and arrives
  by merge, and a merge can also carry content committed nowhere else: conflict
  resolution.
- **`.claude/settings.json` hooks** — Claude Code, early enough to steer rather
  than refuse. `git commit` and deploy verbs additionally become a *prompt*
  every time (bar the MVP-phase exemptions above: docs-only work and
  feature-branch commits and pushes; and routine deploys under the owner's
  standing approval, 2026-11-20), because rules 1 and 2 are about intent
  and no script can check intent. Command classification lives in `scripts/claude-hooks/match-command.py`,
  which strips heredocs and quotes first — matching the bare words "git" and
  "commit" refuses any command that merely *writes documentation about* them.
  Since 2026-11-09 it also covers `docker rm|stop|kill` and `docker compose
  down|rm|stop|kill|restart` (rule 7); `docker exec … psql` stays silent.
  Since 2026-09-20 the same prompt covers the routes that create commits
  without the word: `git merge`, `cherry-pick`, `revert`, `rebase`, `am` and
  `gh pr merge` (all classified `none` until then — an integrator agent could
  have landed work on the integration branch unprompted), and `git push`. A
  tool call carrying an `agent_type` — any subagent — is **refused** rather
  than asked, for all of these and for deploy verbs: no agent can commit or
  deploy, so it hands back the change, the verifier report and a proposed
  commit message, and the lead session runs the command after the person
  approves. `merge-tree`, `merge-base`, `--abort` and `gh pr view` stay silent.

```bash
scripts/preflight-checks.sh --staged   # what the commit hook runs
scripts/preflight-checks.sh --all      # audit the whole tree
```

Blocking: binaries (rule 3), writes to `trip/` (rule 4), **code that names this
deployment (rule 6)**, a broken create-trip symlink, a date-shifted trip,
repo↔Hermes-profile drift, a `.project/sprint.json` that disagrees with the
tree (B8), and a Codex agent mirror that differs from its source (B9). Reviewed exceptions live in `.preflight-allow` — an
entry there is a recorded decision with a reason, not a silent exemption.

Rule 6's check is scoped to **code, not prose, and not tests**: a runbook that
names the VM it is a runbook *for* is doing its job, and a fixture using
`192.168.1.10` to prove the canonical guardrail rejects private addresses needs
that literal. Blocking those would make the check mostly exceptions, and a
check that is mostly exceptions teaches people to add one.

Its allow-list carries two kinds of entry and the difference is the point:
**PERMANENT** (the rule genuinely cannot apply — the detector has to contain
the literals it searches for) and **BACKLOG** (the rule applies and the file
has not caught up). The backlog only shrinks. Today it holds the
`control-plane/deployment/` VM scripts — the five `vm-*.sh`, plus
`vm-release.py`, `vm-restore-snapshot.sh` and `build-hermes-image.sh`, which
arrived on main (#84) while this rule was being written here and so are the
first code it never saw — all of which want the same split
`bootstrap-monitor.sh` already got, and the provisioner defaults that point at
this house.

`.agents/hermes-sync.tsv` maps repo content that also lives in a profile.
`install-hermes-skill.sh` cannot express every pairing (it requires a
`SKILL.md` and only manages `skills/travel/`), so profile SOULs are listed
there instead. Profile skills with **no** repo copy are warned about, not
blocked — that is a capture backlog, not a reason nobody can commit.

## Merged work cleans up after itself (owner's decision, 2026-11-09)

When a branch is merged — a PR, or a local `git merge` into another branch —
its branch (local and remote) and its worktree are deleted then, not at a
later sweep. On 2026-11-09 the repository held 39 worktrees and ~300 branches,
nearly all for work merged weeks before; pr-steward's Sweep 4 was right but
ran only when asked. Three mechanisms, so nobody has to remember:

- **GitHub** deletes a merged PR's head branch (`delete_branch_on_merge`). The
  ruleset "long-lived branches survive merges" protects `integration/**` and
  `release/**` from deletion; `main` was already protected.
- **`scripts/sweep-merged.py --execute`** removes the rest: merged worktrees
  under `.claude/worktrees/`, local branches, and remote branches merged
  locally. `scripts/claude-hooks/posttooluse-bash.sh` runs it after every
  successful merge in the lead session; the session-start line counts what is
  left over (a merge made on GitHub's page) and names the command.
- **What it never touches** is in the script's docstring and its tests: an
  open PR, a dirty worktree, one a running container mounts or a process works
  in, a detached HEAD, `codex/*`, anything outside `.claude/worktrees/`, and a
  branch whose tip sits on a mainline's first-parent line (just created, not
  merged). Unmerged work is reported, never deleted.
