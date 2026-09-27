# Integration handoff — `integration/sprint-6`, 2026-09-27

**Tip: `7445cad`** (check the real one with `git log --oneline -1 origin/integration/sprint-6`
before trusting this number). Six PRs landed today, three of them security fixes
that a boundary review sent back at least once before merge — none was a rubber
stamp.

This document says what's done, what's pinned, what's still open, and the
process corrections made today that the next session needs to know before it
acts, not after.

---

## Do this before starting the next session

### Both checkouts are already fast-forwarded — verify, don't redo

`sprint-6-integration` (this worktree, what the dev stack bind-mounts — confirmed
via `docker inspect kinerary-control-plane-local-worker-1`) and the primary
checkout `/Users/elul/kinerary` (detached HEAD, no local changes) were both moved
to `7445cad` at the end of this session. If they've drifted again by the time you
read this, someone else moved them — check before assuming staleness.

If the dev stack is running, its containers are still serving whatever `dist/`
was built from before this session's merges. Rebuild before trusting a live
check against it: `(cd control-plane/api && npm run build)`, per CLAUDE.md.

### `release/a` is pinned at `a744c28` — NOT the current tip

This is the one thing that must not be assumed away. `release/a` (a real branch
ref, `git rev-parse origin/release/a`) points at the merge of PR #272 (the
Release A Hebrew-copy fixes) — the fixed commit Saturday 3 Oct's deploy targets.
`integration/sprint-6` has moved 8 commits past it since (the whole batch below).
**That's correct, not drift.** Sprint 6 development is not gated to 3 Oct; only
the one production deploy is, and it deploys the pinned ref, not "whatever
`integration/sprint-6` currently is." See decision 55, `docs/sprint6-tracks.md`.

Do not repoint `release/a` without a reason tied to what Saturday's regression
plan (`docs/test-reports/regression-plan-2026-09-26-release-a-sprint-mode.md`,
gates G1-G9, refreshed in its U8 section) actually needs to cover.

---

## What landed today

| PR | What | Merge commit |
|---|---|---|
| #270 | Fleet-digest formatting captured from the trip-monitor profile (closes #269) | `a812c51` |
| #272 | Release A Hebrew-copy fixes (9 findings, G3) — **this is `release/a`'s target** | `a744c28` |
| #280 | Row-ownership check on `PATCH`/`DELETE /api/budget/:id` (#173) | `79510e1` |
| #274 | Agent key can no longer take over the organizer's account (#184) | `44ad45f` |
| #276 | Quota-only Gemini fallback for document reading (decision 48) — code only, not configured anywhere | `ae63b6a` |
| #275 | Super-admin dashboard slice 1 — read-only `/v1/admin/*` + one operator page (decision 23) | `7445cad` |

### Boundary review actually caught things — read this before trusting either fix blindly

- **#274** (agent-key takeover): first pass PASS, but found a live gap the fix
  hadn't closed — `POST /api/agent/participants` could still mint a full
  organizer account for an unseeded name in `agent.organizers`, which could then
  reset the *real* organizer. Fixed in a second commit, re-reviewed, then merged.
  Two unrelated pre-existing findings from the same review were **not** folded
  in — filed as #278 (an organizer's JWT can reset a co-organizer's password —
  open policy question) and #279 (the agent key can revive a removed member).
- **#275** (admin dashboard): first pass came back CONCERNS — `/v1/admin/failures`
  and `/v1/admin/audit` served raw traveler PII verbatim (`redact()` was a
  deny-list; CLAUDE.md's blanket-invariant rule requires an allow-list). Fixed
  with an allow-list + read-time validation on `actorRef`/`targetRef`. The
  *fix itself* then had two more gaps on re-review — `action` was still raw
  (same bug class), and the allow-list lookup crashed on an action named after a
  JS prototype method (`constructor`, `__proto__`, …) because `audit_events` is
  append-only and one such row broke the unfiltered audit route permanently.
  Both fixed, re-reviewed clean. A third finding (values *inside* an allow-listed
  evidence key aren't shape-checked) is confirmed unreachable today — filed as
  #283, not blocking.
- **#280** (budget ownership): PASS on the first pass, with 4 non-blocking notes
  — the companion (agent key, via `mcp/mcp.js`) can still be asked to edit
  anyone's budget line with no requester-scoping (filed as #281); `GET
  /api/budget` now also returns `created_by` via `SELECT *` (low sensitivity,
  noted not fixed); pre-upgrade lines a member wrote themselves become
  organizer/agent-only after this ships (by design, no backfill); neither web
  client consumes the new `can_edit` field yet (named as follow-up in the PR).
- **#276** (Gemini fallback): no boundary-reviewer pass — `model-runner.ts` isn't
  one of CLAUDE.md's three named auth invariants. It's still a named security
  path, so green PR CI alone wasn't trusted; merged only after a real local
  merge-into-a-throwaway-branch + full suite run against the actual merged tree
  (2031/2033 pass — the 2 "cancelled" are a known fresh-worktree
  `server`/`mcp`-missing-`node_modules` artifact, independently diagnosed twice
  already, unrelated to this diff).

### Six follow-up issues filed, none blocking, none owned yet

#277 (admin key reachable via `web/nginx.conf`'s `/v1/` passthrough, no rate
limit), #278, #279, #281 (above), #282 (a corrected instruction now says an
organizer can link Telegram "through their own site session" — true of the API,
but no page has that button), #283 (above). All are `track:2` or `track:4`,
labeled `sprint-6`, unassigned.

---

## What's still open, not from today's batch

- **Draft PR #266** (`chore: park the uncommitted monitor onboarding skill`,
  against `main`) — an uncommitted `trip-organizer-onboarding` MCP skill found
  on the primary checkout on 2026-09-22, saved per the standing rule below.
  Its own checklist (is `create_trip_link` live on the VM's trip-monitor
  profile? compare against `organizer-invites/SOUL-section.md`?) has not been
  worked yet.
- **#269's own closure** is still owed independent confirmation: the fleet
  digest's first formatted run is 28 Sep 09:00 IDT (tomorrow, relative to this
  document) — check `~/.hermes/profiles/trip-monitor/logs/gateway*.log` for a
  send/MarkdownV2 error, and get Dror's word that it rendered right in
  Telegram, before closing #269 (#270 itself is already merged).
- **Connected Assistants / CA-01 (Codex-led)** — draft PRs #257, #267, #268
  target `integration/sprint-6` directly (docs + fixtures); #271 and #273 stack
  on `feat/connected-assistants-integration`, not `integration/sprint-6`, and
  haven't been asked to merge anywhere yet. Path handover for
  `server/trip-mcp/**` and the confirmation routes was granted on issue #249,
  with conditions (full security path, don't touch `oauth.js`'s tracked
  findings without asking, route to `main` with sprint-6, not separately). The
  original "don't merge until after Release A" condition on #249 was **wrong**
  and was corrected in a comment there on 2026-09-27 — CA-01 PRs can go through
  the normal merge path whenever they're ready, same as anything else now that
  `release/a` is pinned separately.
- **#116** (VM document-store bootstrap) is an old open, non-draft PR against
  `integration/sprint-6` that nobody looked at this session.
- **Admin dashboard slice 2** (suspend/retry, real per-operator authorization)
  is explicitly not started — decision 23 in `docs/sprint6-tracks.md` scoped it
  out of slice 1 on purpose.
- **The Gemini fallback's actual production configuration** (the OpenRouter key,
  `EXTRACT_RUNNER=openrouter EXTRACT_MODEL=google/gemini-3.8-flash
  EXTRACT_FALLBACK_RUNNER=claude`) is a `kinerary-deploy` change, explicitly not
  part of #276, and per decision 49 ships after 3 Oct with its own regression
  plan — don't confuse "the code merged" with "this is live anywhere."
- **~25 open track-4 bug-fix issues** beyond #184/#173 (now fixed) are
  untouched — `gh issue list --milestone "Sprint 6" --state open` filtered to
  `track:4` for the current list.
- **Decision 54**: Dror sends the two live organizers the #240 allergy note
  himself; the lead prepared the wording. Not this session's job to chase.
- **Two agent worktrees are still lock-held** by now-idle agent sessions:
  `.claude/worktrees/agent-a39139b852429a6e7` and
  `.claude/worktrees/agent-a5748c47037216104`. Harmless; `git worktree remove
  -f -f` when convenient, or let them clear on their own.

---

## Standing process corrections from today — read these before repeating the mistakes

1. **Sprint 6 development is not gated to the Release A deploy date.** Only the
   one production upgrade is (`sudo kinerary-cp-release upgrade`, Sat 3 Oct
   morning IDT, deploying the commit `release/a` points at — see above).
   Ordinary merges into `integration/sprint-6` proceed on their own schedule.
   The lead got this wrong twice today (telling #249 and #269 to hold for
   Release A) before Dror corrected it explicitly: *"why is it related to Oct
   3, this is main no? are we stopping to work till Saturday? make no sense to
   me."* Both corrected in-thread; don't reintroduce the conflation.
2. **Don't idle waiting on CI or an agent.** If nothing is blocked, start the
   next piece of work rather than asking "what's next?" — Dror's direct
   correction: *"why not moving to the next thing? why you stopped?"*
3. **Unclear/possibly-stale uncommitted work goes to a branch + PR, not a
   question.** Save it, push it, open a PR (draft if it shouldn't merge)
   explaining what it is and what needs checking before deciding its fate.
   Discarding still needs Dror's explicit word; saving doesn't need anyone's.
   Memory: `[[unowned_uncommitted_work_goes_to_a_pr]]`.
4. **A security-listed path (`server/server.js`, `model-runner.ts`, `shared/`,
   anything spawning a process with an environment, or a new authenticated
   route) never gets the "green CI stands in for local verification" shortcut**
   — CLAUDE.md says so explicitly, and it's not a formality: three of the four
   security-relevant PRs today had a real, live-reproduced defect that a
   plain green CI run would never have shown.

---

## Prerequisites already satisfied, for the record

`.project/sprint.json`: sprint OPEN since 2026-09-20, baseline LOCKED at
`97582b6`; `integration/sprint-6` is 235 commits past baseline as of `7445cad`.
Nothing about lock state changed today.
