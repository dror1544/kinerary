# Regression plan — `main` → production (VM 110 `kinerary-cp`)

- **Date:** 2026-09-20
- **Commit assessed:** `b451ee7` — `fix(intake): retain ticketed attraction confirmations (#109)`, squash-merged to `main` 2026-09-20 04:12 UTC
- **Production is at:** `810795a` — verified read-only on the VM, 2026-09-20
- **Status: MERGED, DELIBERATELY NOT DEPLOYED.** Deploying is a separate
  decision and has not been taken. Hard rule 2 stands.
- **Supersedes:** `regression-plan-2026-09-19-main-to-production.md`, which
  assessed `810795a` when it was already live and found the NFS blocker (now
  resolved). Read that one for the fleet detail this plan does not repeat.

---

## 0 — Verdict

**Ship it with the next deploy that has its own reason to restart the relay.
Do not deploy it on its own.**

The delta is one squashed commit, 4 files, +35/−7, entirely inside
`control-plane/`. No migration. Nothing under `site/`, `server/` or `shared/`,
so **no release candidate, no promotion, no trip redeploy** — the trip runtime
is untouched. Nobody currently has the bug it fixes: it changes what a *future*
interview extracts, and there is no interview in progress.

Against that, landing it costs a relay restart, because `INTAKE_QUESTIONS` is
imported by `relay/poller.ts` and `interpret.ts`. A restart is a bot pause for
the one family currently mid-trip. That is a poor trade for a change that
reaches nobody today, and a fine one bundled into a deploy that was restarting
the relay anyway.

---

## 1 — The change set

```
control-plane/api/src/interview.ts                    |  4 ++--
control-plane/api/test/extract-intake-prompt.test.ts  | 10 +++++++---
control-plane/worker/control_plane_worker/transformer.py |  5 +++++
control-plane/worker/tests/test_transformer.py        | 23 ++++++++++++++++++--
4 files changed, 35 insertions(+), 7 deletions(-)
```

Two things, one commit:

1. **The extraction contract (#62).** The `travel_anchors` question now asks for
   ticketed attractions, tours, activities, events, shuttles and parking
   alongside flights/hotels/cars, and its `dataExample` types the sample as
   canonical `attraction` rather than `activity`. The point is that a booked
   visit keeps its **confirmation code**, which is what #62 reported missing.
2. **`_ANCHOR_TYPE_MAP` caught up with it.** The new prompt invited `event`,
   `shuttle` and `parking` by name and the map knew none of them, so
   `.get(anchor_type, "other")` filed them as booking type `other`. Added, with
   a test that drives every kind the prompt names through the transformer.

---

## 2 — Where it lands, and therefore who feels it

| Surface | In this delta? | Reaches whom, when |
|---|---|---|
| `control-plane/api` (`interview.ts`) | **yes** | everyone, at the next API+relay restart |
| `control-plane/worker` (`transformer.py`) | **yes** | applies when a trip is next provisioned or re-provisioned |
| `site/`, `server/`, `shared/` | **no** | n/a — no release, no trip redeploy |
| migrations | **no** | n/a — schema stays at `0051` |

**Nothing retroactive.** Existing `intake_versions` rows are immutable and keep
transforming exactly as before — `_ANCHOR_TYPE_MAP` still carries `activity`,
so a re-provision of any existing trip produces identical bookings. The change
only alters what a *new* extraction produces.

---

## 3 — Migration story

**There is none.** Production is at `0051_trip_person_links.sql`; `main` ends at
`0051`. Nothing pending, nothing to rehearse against restored data.

Rollback is therefore the cheapest tier: code-only `kinerary-cp-release
rollback`, no `--restore-db`, no data at risk. Because nothing is pending, **any
failure in `migrations.test.ts` on this delta is a real failure**, not the
expected list-mismatch.

---

## 4 — Live fleet, read 2026-09-20

| | |
|---|---|
| Production revision | `810795a` in `vm.env` and in the checkout |
| Storage guard | all ✓ — **no network filesystem mounted**; `status` exits 0 |
| Trips past draft | **one**: `japan-tokyo-hakone-kyoto-osaka-2026`, `ready_private`, `reachable` |
| That trip's dates | 2026-09-18 → 2026-10-03 → **day 3 of 16, a family is on it now** |
| Other non-retired | 3 × `draft-sreq-…` (2 `intake_confirmed`, 1 `intake_in_progress`) |
| Jobs in flight | **0** |
| Interview sessions | 6 `interviewing`, **all `awaiting='person'`**, newest touched 2026-09-13 |
| `awaiting='machine'` in last 30 min | **0** |

**The upgrade path is open again.** The `/srv/kinerary-nfs` mount that blocked
`guard_storage()` on 2026-09-19 has been removed; `upgrade` and `--dry-run` both
run. That removes the *blocker* but not the *reason to wait*.

**No interview would be interrupted.** `interview-stack-deploy` refuses to
restart the relay under a live conversation (`awaiting='machine'`, recently
updated). Nothing matches that today, so the refusal would not fire — but
re-check immediately before, not from this document.

---

## 5 — What deploying would require, when it is authorised

Not today's task; recorded so the next window does not have to rediscover it.

1. `sudo kinerary-cp-release status` — expect every storage line ✓, no
   `switching` row.
2. `sudo kinerary-cp-release plan b451ee7` — expect verdict `compatible`, no new
   migrations.
3. `sudo kinerary-cp-release upgrade b451ee7 --dry-run` — every guard for real,
   changes nothing.
4. `sudo kinerary-cp-release upgrade b451ee7` — snapshot, dump-restore proof,
   then checkout → `vm.env` → `migrate` (no-op) → api/worker/sidecars → relay.
5. `sudo kinerary-cp-release verify`.

Preconditions to re-read at the time, all of which can change without notice:
`PROVISIONER_COMPUTE_ENABLED` is **on** for a real organizer; one `getUpdates`
loop per bot token (VM owns `@Kinerary_bot`); no job in flight; no interview
awaiting the machine. On the VM the relay restarts via
`control-plane/deployment/vm-relay-restart.sh`, never `scripts/relay-restart.sh`.

---

## 6 — Effect on the live trip

| Window | What the family would notice |
|---|---|
| During the upgrade | **The website: nothing.** The site is its own LXC and is not touched by a control-plane upgrade. **The bot pauses** for the relay restart; the relay waits for companions to reconnect before polling, so messages wait at Telegram rather than erroring. |
| After it | **Nothing.** Their intake is confirmed and immutable; this changes only future extractions. |
| If it fails mid-trip | The failure that reaches them is **the companion going quiet**, not the site going down — Hermes restarts and a gateway does not return, or the relay comes up and the companion never reconnects. Rollback is code-only and ~1 minute of bot pause. |
| Never | Their site, their data, their bookings. |

**The standing risk this delta does not address:** that trip is still pinned to
`release_ee61…`, which predates the `POST /api/upload` auth fix. That is
unchanged by this plan and remains the biggest open item on the fleet — see the
2026-09-19 plan, section 8 item 2.

---

## 7 — Test evidence (measured, not estimated)

Run 2026-09-20 in the PR's own worktree at its merge head, before merging:

| Suite | Result | Duration |
|---|---|---|
| `control-plane/api` full (no DB) | **1132 tests: 746 pass, 386 skipped, 0 fail** | 17.2 s |
| `extract-intake-prompt.test.ts` | **31 pass, 0 fail** | 0.33 s |
| `test_transformer.py` | **163 tests OK** (162 before the new case) | 0.02 s |
| GitHub CI on `bdd5e55` | **6/6 SUCCESS** — TypeScript API, Python worker, Web SPA, Kinerary suite, Modern trip SPA, Runtime gateway | — |

**The new transformer test was proven to fail without the fix**, not merely to
pass with it: removing the three map rows fails it with `'event' should type as
a booked attraction`.

**Deliberately not run, with reasons:**
- **DB-backed API suites (the 386 skipped).** No migration and no DB path in the
  delta. `cptest` is shared between sessions and every DB suite opens
  `DROP SCHEMA ... CASCADE`, so running them risks another session's run for no
  coverage of this change.
- **The trip-site suite.** Nothing under `site/`/`server/`/`shared/`; it is also
  the suite known to be flaky at concurrency 4, so running it here would only
  manufacture ambiguity.

---

## 8 — What is still owed, and when

**Owed before this is believed in production, not before it is merged:**

- **One live interview walk, isolated.** This is a *prompt* change, and a prompt
  is not proven by a unit test — one green run is one sample of a
  non-deterministic model. It cannot be folded into an unrelated e2e run,
  because the observable is "what did the model put in `travel_anchors`" and a
  second interview-touching change makes a green run ambiguous. Assert on the
  column, not the UI:
  ```sql
  SELECT id, interpret_path, language FROM control_plane.intake_sessions ORDER BY created_at DESC LIMIT 3;
  SELECT version, data->'travel_anchors' FROM control_plane.intake_versions ORDER BY created_at DESC LIMIT 1;
  ```
  Check `interpret_path = 1` — on the agent path this prompt was never used and
  the run measured nothing. Then: an anchor exists, its **`confirmation`
  survives into the site's bookings row** (the whole point of #62), a dated
  anchor lands on its day at `HH:MM`, and note whether the model actually emits
  any `event`/`shuttle`/`parking` now that it is invited to.
- **Scenario choice:** `manual` (typed answers → `interpret`) and `multi`
  (document → `extract`). **Not `japan`** — that fixture collides with the live
  trip on cities and dates.
- **Not on the VM while a family is mid-trip** unless there is a reason to be
  there. The Mac stack on `@Tripinterviewer_bot` is the right home for this, and
  the Mac currently runs no relay, so there is no `getUpdates` conflict.

**Not owed:** a full ~80-minute e2e. Nothing in this delta justifies it, and the
fixture/provisioning/live-trip constraints all argue against one this week.

---

## 9 — Decisions needed

1. **When to deploy `b451ee7`.** Recommendation: bundle it with the next change
   that restarts the relay for its own reasons. If it must go sooner, it is a
   deliberate bot pause for a family mid-trip, for a fix nobody is waiting on.
2. **The live trip's upload-auth exposure** — unchanged by this plan, still the
   biggest open fleet item, still needs a person and the organizer told first.
3. **Who runs the interview walk, and on which stack.** It needs a person to
   type; `--auto` on the Mac is the alternative.
