# Agents and run tooling

Moved out of `CLAUDE.md` on 2026-11-22, text unchanged apart from the place
marked *(updated 2026-11-22)*. `CLAUDE.md` keeps the role table and the rules;
this file holds how each tool works and why it is built that way. Where the two
disagree, `CLAUDE.md` wins.

Subagents in `.claude/agents/` — none can commit or deploy:

| Agent | For |
|---|---|
| `verifier` | Works out which suites a change touches, runs them, reports real output. Has no Write/Edit on purpose. |
| `pr-steward` | Branch/PR sweep. Deletes only provably-merged branches, only on confirmation. Doc drift moved to `doc-keeper` (2026-09-20). |
| `sprint-scribe` | Marks plan items `— BUILT (date)` and moves ledger rows. Surfaces unowned gaps as decisions. |
| `run-capture` | Raw live-run notes → triaged ledger rows routed to the owning sprint. |
| `boundary-reviewer` | The three invariants under "Security-sensitive paths", with live request/response evidence. |
| `regression-planner` | Costed regression plan for a change set: blast radius on live trips, migration and compatibility breaks, what to batch onto one run and what must be tested alone. Plans; never runs the deploy. |
| `developer` | One briefed task in its own worktree: test first, suites run, `verifier` report attached, handed back ready to commit. Never commits. |
| `integrator` | One merge decision at a time for the integration branch: merge-tree, same-intent check, resolution on a throwaway branch, verifier, carry-forward. Never merges. |
| `doc-keeper` | Every decision gets a home before the commit; drift swept after merges. Proposes CLAUDE.md diffs, never applies them. |
| `consult` | One judgment call for a Sonnet role, answered from the evidence with its reasoning. Read-only: no Bash, no Write, because the first consult with a full tool surface wrote a probe into the live-served worktree and staged it (#135). |

The last three are the agent team of `docs/agent-team-plan.md` (2026-09-20),
which also says which model each role runs and why: Opus for judgment calls,
Sonnet for everyday work, declared per file. Its queue is GitHub issues:
`sprint-N`, `track:N`, `size:S|M|L`, `blocked`, `agent:ready`,
`agent:in-progress`, and a milestone per sprint.

**Roles load once per session, from the checkout it starts in.** A role
absent from that checkout is not spawnable, and a role that changes on disk
afterwards keeps running its old text silently — the dry run's session had
loaded a `pr-steward` that still owned the doc sweep and still had Edit. Start
a team session from a checkout of the integration branch after the roles it
needs are committed there, and restart it after any role changes; the
session-start line prints `roles as of <commit>` so the transcript says which
version loaded. And an `isolation: worktree` spawn branches from wherever
`worktree.baseRef` says — the default `fresh` is `origin/main`, which is where
every dry-run spawn landed; `.claude/settings.json` sets `head` so a spawn
starts on the session's branch. A developer's first act is still to move its
fresh worktree onto the brief's base commit and prove it, and a failed check
blocks rather than becoming a note.

`.codex/agents/*.toml` are **generated** from these files by
`scripts/sync-codex-agents.py`, and preflight B9 blocks a commit while any
mirror differs from its source or is staged without it. Codex works the same
issue queue as Claude does (`docs/agent-team-plan.md`), so the two sides have
to describe the same role — never edit a `.toml` by hand.

`sprint-scribe` and `run-capture` must never record human approval, and must
never guess which sprint owns an item — see the standing instruction at the top
of `docs/signup-test-execution-capture (Manual).md`.

`regression-planner` also runs itself, in CI:
`.github/workflows/regression-assessment.yml` posts an assessment when a PR or
an issue is opened. The agent file is the single source of truth for what the
assessment says — change the analysis there, not in the workflow. Since #320
(2026-09-30) a PR whose every changed path is docs-only, test-only or a
stylesheet skips the Opus run entirely: the Collect-context step pipes the
PR's file list into `scripts/regression-assessment-scope.sh` before any model
runs, and only its exit 0 sets `relevant=false`; an unreadable or empty list
assesses, and the `regression-assessment` label always overrides it back on.

Three things about that workflow are load-bearing, all because **this repo is
public** and anyone can open an issue:

- **Claude never gets a GitHub token.** `gh` collects the PR/issue context into
  `.assessment-context/` in a step *before* the model runs, and a later step —
  with no model in it — posts the comment. An injection in an issue body has
  nothing to post with. Since #323 (2026-10-21) the model runs as
  `claude -p --restricted --strict-mcp-config --tools "Read,Grep,Glob,Write"`:
  no shell, no repo settings or hooks, no MCP. Checkout keeps no token
  (`persist-credentials: false`), and the post step withholds a comment that
  carries a credential or touched any other file. An allow-list of `Bash(...)`
  prefixes was measured NOT to be a boundary in `-p` mode, so adding any shell
  back undoes the containment. `Workflow guards` in `control-plane.yml` runs the
  tests that pin this.
- **`pull_request`, never `pull_request_target`.** A fork PR gets no secrets
  and the job skips. Switching that one word runs untrusted code with a key.
- **An issue is assessed automatically only for OWNER/MEMBER/COLLABORATOR.**
  For anyone else a maintainer applies the `regression-assessment` label, which
  is the opt-in and also the way to re-run one by hand.

**CI has no production access, on purpose** — no SSH key, no database, no
deploy host. So the agent's live-fleet step is not performed there, and the
comment says so rather than implying the fleet came back clean. That half is
still owed locally, and three other entry points exist to collect it:

- **`/regression-plan [branch | PR | "sprint N"]`** — the local run, which reads
  the live fleet and says which trips must be *redeployed* for a fix to reach
  anyone. Plans land in `$KINERARY_NOTES_DIR/regression-plans/` *(updated
  2026-11-22; older ones are still under `docs/test-reports/`)*.
- **The deploy prompt.** `pretooluse-bash.sh` greps both places for the
  current commit and says, inside the hard-rule-2 prompt, whether this exact
  HEAD was ever assessed — or whether the only plan is for an earlier commit on
  the branch. It does not block; the deploy is the one moment someone is
  already being asked to look.
- **Promoting a release to `available`** now classifies as a deploy
  (`match-command.py`), because that is the pool `generatePlan()` selects from:
  from then on every trip built or rebuilt runs that tree. `candidate ->
  verified` reaches nobody and stays silent.

`.agents/skills/live-run/` drives the 🤖 steps of `docs/setup-test-plan.md` and
stops at every 🧍, resumable by step. It never deploys and never tears down.

`.agents/skills/trip-fleet-monitor/` is the Hermes monitor that watches the
fleet through a **read-only** MCP (`fleet-mcp.mjs`). Since 2026-09-18 it can
also file an issue — through `issue-mcp.mjs`, a **second server**, because the
first one's stated invariant is that even a bug in it cannot write. The second
one creates issues and does nothing else: no comments, no closing, no pull
requests, and it **never falls back to the `gh` CLI's login**, which on this Mac
can push to everything. Its token is a fine-grained PAT scoped to one repo with
Issues: Read and write, named in `issue-target.json` (real values in
`kinerary-deploy`, never here).

Two things that file gets right and are easy to undo by accident:

- **Every call needs a `fingerprint`.** The monitor runs on a cron, so a stuck
  job is stuck on every tick; an open issue already carrying the fingerprint
  means nothing is filed. Remove that and the tracker fills in an afternoon.
- **`kind` distinguishes a person's report from the monitor's own
  observation**, and a traveller's words go in `quote`, rendered blockquoted
  under a banner saying they are untrusted input. `issue-mcp.mjs --render '…'`
  shows exactly what would be filed, without filing it.

## A companion reports; the monitor decides

A trip companion can file a bug report — `report_bug` on `companion-mcp.ts`,
into `companion_bug_reports` (migration 0054). It reaches the monitor through
`alerts` and `bug_reports` on the fleet MCP, and the monitor decides what is
real, tells the operator, and files the ones that are.

**The companion deliberately cannot file the issue itself.** Its context is full
of text travellers typed, which is where an injection arrives; a token that
writes to the tracker must not sit one crafted message away from a stranger. One
agent holds that token and applies judgement — that separation is the feature.

Three things in this path that look incidental and are not:

- **No tool takes a trip id.** The trip comes from the caller's gateway identity
  through its own open chat bindings, exactly as `set_assistant_names` does.
- **There is no state column on the report**, so the monitor stays read-only
  against the control plane. The open issue is the triage record, keyed by
  fingerprint `companion-report:<report id>`. The migration explains it; read
  that before adding `triaged_at`.
- **Free text is folded to one line inside SQL.** psql delimits rows with
  newlines, so a multi-line quote otherwise becomes extra rows — a forgery
  primitive, not a rendering bug: a traveller could type a line that reads as a
  report against another trip. Found 2026-09-18. Any future fleet-MCP query that
  selects a free-text column must fold it the same way (`foldSql`).

`.agents/skills/organizer-invites/` hands somebody an interview link without
their password: `POST /internal/operator/invitations` creates the trip and
issues the same single-use link their own request would have, and prints a
message to forward in English or Hebrew. The routes are **unmounted unless
`CONTROL_PLANE_OPERATOR_KEY` is set**, and a monitoring agent reaches them only
through a forced-command SSH user (`cpinvite`) that accepts two verbs. It
refuses an address that is mid-interview or mid-build, and there is no password
reset anywhere in the control plane — for organizers, no such route exists.

An invitation bypasses the organizer's **login**, never their **identity**.
`resolveOrCreateEmailAccount` (`password-identity.ts`) is the single answer to
"which user is this address?", and every path goes through it: an operator's
invitation, `POST /v1/signup`, and a Google sign-in whose address Google has
verified. One address is one `user_id`. Do not add a path that mints a user for
an email on its own; that is the bug migration 20260922060001 had to go back and merge.

**Every email account holds a credential from birth.** Signup writes the
password the person chose; an invitation and a Google sign-in write one built
from random bytes nobody keeps (`ensureUnknownPasswordCredential`, which never
overwrites an existing one). An invited organizer is therefore a structurally
normal account whose owner has no password *yet* — they use Telegram or Google
until password recovery ships with the landing page, and that flow will just
replace the hash. The invariant is what stops an account being claimed by
whoever signs up with its address first, so a credential-less account can only
be an older row: signup refuses to adopt one that carries another identity,
because asserting an address is a weaker claim than the auth already on it.

`.agents/skills/interview-stack-deploy/` restarts the four services the Trip
Bot interview needs (control-plane API, interview MCP sidecar, trip-intake
gateway, relay) with the checks a 2026-09-05 live run found missing: it reads
the interview-agent key from `provisioning.env` itself rather than trusting
the calling shell, confirms the key landed **inside** the API container rather
than assuming a restart worked, and — the one that actually matters — extracts
the expected `*_for_chat` tool names straight from `interview-mcp.ts` and
greps the **gateway's own** post-restart log line for each one, so "the agent
can speak" is read off the gateway rather than inferred from an upstream
process being alive. It refuses to restart the relay under a live conversation
(`awaiting = 'machine'`, updated recently) unless told to anyway.
