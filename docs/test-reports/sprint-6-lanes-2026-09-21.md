# Sprint 6 — the PR lanes, and the rules they run under

**Decided by Dror, 2026-09-21.** Written down so a session that was not in the
conversation can pick the queue up without re-deriving it. Status lines are as
of `f02997b`; the standing rules outlive them.

---

## 1. The standing rules Dror set

**`main` is production, and it stays that way.** The sprint→main merge happens
**at sprint end, or when Dror says so** — not when the integration branch looks
ready. `main` is kept as the lane for special fixes to a running deployment.
Any proposal to change this has to keep one property: *a current version, with
controlled sessions, in production.*

**The consequence, and it is live.** A hotfix on `main` does not reach
`integration/sprint-6` by itself. On 2026-09-21 `b451ee7` (#109, "retain
ticketed attraction confirmations") had been on `main` since 2026-09-20 and was
absent from the integration branch — so every trip built from sprint work
carried a bug production had already fixed. **A hotfix is cherry-picked forward
in the same sitting it lands**, or this recurs silently. Suggested and not yet
decided: tag production (`prod-YYYYMMDD`) at each `main` commit, so "what is in
production" is a name rather than a branch tip that moves.

**PR triage.** Per PR, assess what regression testing it actually needs:

- **small, and CI green** → resolve conflicts and merge;
- **big** → an e2e run on the Mac before it merges.

**CI results must be current.** On 2026-09-21 every open PR's head predated the
base by up to 67 commits, and a docs-only PR showed "TypeScript API" failing
while the branch itself was green. A stale red is not a signal and a stale
green is worse. **Update the branch, let CI re-run, then read it.**

**E2E on the integration branch from time to time**, not only at sprint end.
And **when a branch adds a capability the e2e does not cover, or fixes an
important bug, adapt or extend the e2e to cover it** — the suite follows the
product rather than lagging it.

---

## 2. The lanes

### Lane A — docs only, no code

Merge on green. No rebase risk, no regression surface.

| PR | State |
|---|---|
| #140 — the two wrong citations in `sprint6-tracks.md` | **merged** `208bcff` |
| #139 — the agent-team dry-run report | **merged** `e31d8fc` |
| #141 — the PR #92 regression assessment | open |

### Lane B — small code, low blast radius

Update the branch → CI re-runs → read it → merge.

| PR | What | State |
|---|---|---|
| #108 | teardown carries no IP pool, because it never allocates | branch updated, CI re-running |
| #91 | isolate Codex from untrusted document text (#58) | branch updated, reviewed — see §4 |

### Lane C — small, but needs a security read before merging

| PR | Why it is not lane B |
|---|---|
| #90 | binds chats only from a verified identity — the webhook/callback trust boundary. Evidence must be a request and a response, not a description |
| #116 | gives a control-plane VM the document store a trip inherits; its failing check is the *Kinerary suite*, a different signal from lane B's |

### Lane D — big; an e2e on the Mac before merge

| PR | Size | Note |
|---|---|---|
| #136 | 93 files | Slice A of #92 — **merges first**, see §3 |
| #92 | 79 files | the rest of the feature: 4 migrations, worker, VM compose |
| #95 | 29 files | operator-issued invite links; carries migrations |
| #89 | 9 files | a trip's data directory named by trip id — provisioning depends on it |

---

## 3. #136 before #92 — decided, with the measurement behind it

#136 is not a competing PR. It is a deliberate extraction from #92, made on the
advice of a regression assessment that concluded **"unbundle it, do not land it
whole"** (`docs/test-reports/pr92-regression-assessment-2026-09-19.md`, §6 —
which existed only as an untracked file on one machine until PR #141).

Measured against the tree rather than taken on trust:

| | |
|---|---|
| Shared commits | **0** — independent branches carrying the same work |
| Files in common | **24** |
| Byte-identical | **17** — including `answer-merge.ts`, `document-dates.ts`, `document-text.ts` |
| Differing | **7** — exactly the wiring #136 leaves out |
| #92 only | 4 migrations, `provisioner.py`, `document_handoff.py`, `transformer.py`, `compose.vm.yml` |

**#136 first** lands the 17 identical files; #92 rebased then sees them as
no-ops and only the wiring plus infrastructure remains — **the conflict surface
drops from 24 files to 7.** #92 first makes #136 redundant and lands the
one-way, VM-dependent half in a single step, which is what the assessment said
not to do. #136's own framing is the argument: *"No schema, no new surface, no
VM work — so nothing here is one-way."*

---

## 4. The `0054` collision — timestamps, not a renumber

`0054` was claimed three ways: `0054_companion_bug_reports.sql` already on the
branch, `0054_document_registry.sql` in #92, `0054_organizer_invitations.sql`
in #95.

**Renumbering is not available.** Preflight **B7** grandfathers migrations
already in HEAD and requires `YYYYMMDDHHMMSS_description.sql` for anything new
— so a renumbered `0057_document_registry.sql` is still a hand-allocated number
and the pre-commit hook refuses it. B7's own comment gives the reason: *"0054
existed three different ways at once on 2026-09-19, and the repo had already
renumbered twice before that."*

**Ordering is preserved anyway**, which was the concern: `version` is the whole
filename and the sort is lexicographic, so every legacy `00xx_` still sorts
before any timestamp.

**Note for whoever reads the assessment:** its §4 recommends a contiguous
renumber. That section is **superseded** by B7 and should not be followed. The
text is left intact rather than edited, because it is a dated assessment.

---

## 5. E2E

**Scenario: `vietnam`.** It is the baseline scenario and was green at the
locked baseline `97582b6`.

```bash
~/.cache/kinerary-preflight/venv/bin/python scripts/e2e-full-cycle.py \
  --scenario vietnam --auto --teardown
```

**Not `japan`** — that fixture collides with a live trip on both cities and
dates, and slug derivation is not deterministic.

**When:** after each lane-D merge, and once before sprint end. A VM run and a
Mac run must never overlap — both provision onto the same Proxmox, NPM and
Cloudflare, and derive the same slug from the same scenario.

### Coverage the e2e does not have yet

Per Dror's rule that a new capability gets e2e coverage:

| PR | Capability with no assertion today |
|---|---|
| #95 | an operator-issued invite link producing an organizer account |
| #92 / #136 | document upload surviving as a durable, reconcilable source |
| #90 | a chat binding **refused** from an unverified identity — a *negative* assertion, and the one that matters most: the bug class is "it silently accepts" |
| #89 | a trip's data directory named by trip id |
| #116 | a trip inheriting the VM's document store |

---

## 6. Forward-port of #109 — done, and what it proves

`b451ee7` adds three rows to `_ANCHOR_TYPE_MAP` in `transformer.py`:
`"event"`, `"shuttle"`, `"parking"` → `"attraction"`. Its own comment: *"The
question invites these three by name, so the model emits them; without a row
here they fall to 'other' and a booked visit stops reading as one."*

Cherry-picked to `fix/forward-port-109` (`a58ac96`). Verified:

- worker suite **436 tests, 0 failures** (87 skips, all self-declared DB-gated);
- control-plane API **1374 tests, 1366 pass, 0 fail**, on a private database;
- the new assertion was proven **non-vacuous** — the three map keys were deleted
  in memory and the test failed with `'other' != 'attraction'`;
- **same-intent check:** all five sprint-6 commits touching `transformer.py`
  were read. None handles `event`/`shuttle`/`parking` by another route, and the
  merged result types them exactly once. A clean textual apply is not the same
  as semantically correct, and this was checked rather than assumed.

---

## 7. Where a session should start

1. Read `.project/sprint.json` (`scripts/project-state.py show`) — the locks
   are a file, not a memory.
2. Read this document and `docs/sprint6-tracks.md`.
3. **Start in a session whose checkout already has the roles committed.** Roles
   resolve once per session from the starting checkout: a role absent there is
   not spawnable, and a role that changes on disk afterwards keeps running its
   old text silently. Restart after any role change.
4. The queue is GitHub issues with `sprint-6`, `track:N`, `size:S|M|L`,
   `agent:ready`, `agent:in-progress`. **As of 2026-09-21 only one of 56 open
   issues carries any of them** — building the queue is unstarted work, not a
   solved problem.
