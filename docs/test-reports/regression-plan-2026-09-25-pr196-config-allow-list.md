# Regression plan: PR #196, trip config served through an allow-list (#172)

**Verdict: the existing suite is enough to merge PR #196 into
`integration/sprint-6`. It is not enough to redeploy any site that already
exists.** The suite shows that nothing off the list reaches a member, on every
route the PR names. It also shows that every config the current producers emit
comes back whole. It cannot see the configs on live trips. The one real
hand-authored config I could find on this Mac, `/Users/elul/USA2026/trips/usa-2026`,
loses 40 fields of 12 kinds. It is probably what CT200 was built from.

Scope: branch mode. The change set is PR #196 (`fix/172-config-allow-list`, head
`0bcf763`) merged into `integration/sprint-6` (tip `96a2897`). The merged tree is
`5f1a136`, and I confirmed it with `git write-tree` in the planner worktree.
Assessed 2026-09-25. I deployed nothing, used SSH to nothing, and edited no code.

---

## What would reduce the risk

Ranked by how much risk each removes per minute spent.

1. **Do not redeploy `japan-tokyo-hakone-kyoto-osaka-2026` for this fix
   while the family is travelling.** This costs 0 minutes.
   - Memory (2026-09-19) gives its dates as 19 Sep to 3 Oct 2026, so today is
     mid-trip. The fleet tool does not show dates, so I did not re-check them.
   - Its site was built by main's worker. main's producers emit nothing outside
     the list: I checked 189 configs from main's tip and 179 from main as of
     2026-09-15 (below).
   - So a redeploy now gives this trip almost no security gain. It still costs
     a site restart under a family that is on holiday.
2. **Decide what happens to the 12 hand-authored field kinds before anyone
   redeploys CT200.** Deciding takes about 5 minutes. Extending the list, if
   you choose that, takes about 20 minutes of developer time.
   - The kinds are `phases[].car`, `accommodation.checkin`/`checkout`/`altitude_m`,
     `hotels[].checkin`/`checkout`, `bookings.{flights,hotels,cars}[].pdf`,
     `bookings.cars[].note` (bilingual), `bookings.pending_attractions[].status`,
     and `bookings.pending_attractions[].name`.
   - The last one is on the list, but only as a scalar. The USA config writes
     it as `{he,en}`, so a one-word change (`scalar` → `text`) keeps it.
   - The companion's own skill (`trip-daily-planning/SKILL.md:39`) tells it to
     treat "cars, check-in/out" from `get_config` as verified facts. So these
     fields are read, even though no page renders them.
   - `phases[].car` carries a `confirmation` and a `cost`. Putting it on the
     list is a visibility decision, not a mechanical one.
3. **Make the silent failure loud somewhere a person looks.** About 30 minutes
   of developer time.
   - Today the only signals are one `console.warn` line inside the trip
     container and a count at `GET /api/config/warnings`.
   - I searched the repo: nothing reads that route except `live-run/driver.mjs`.
     No page, no fleet-monitor tool and no provision check reads it.
   - Adding a `scope:'config'` check to the post-provision/redeploy
     verification or to the fleet monitor turns "the site quietly lost a field"
     into a finding.
4. **Add a pre-redeploy check that prints dropped paths only.** About 15 minutes.
   - The check is `projectConfig(cfg).dropped` over a config file or a saved
     old-release `/api/config` response. The scratch version I used is in the
     plan below.
   - The PR asks for this for CT200. It is needed for every existing trip.
5. **Widen the golden test from two hand-built intakes to every output of
   the worker's own suite.** About 30 minutes.
   - I wrapped `transform_intake` and `enrich_config` and ran the worker suite.
     That produced 249 configs in about 1 minute.
   - It would catch a field that only appears on a branch the two wide intakes
     in `provisioned-config.py` never reach.

This is not a request for more testing before the merge. Items 2 to 5 guard
the later step: a live trip picking this up on redeploy.

---

## 1. Change set

| File | Row (§2) | What changed |
|---|---|---|
| `shared/allow-list.js` (new) | release payload | Projection engine: `scalar`, `oneOf`, `withheld`, `object`, `list`, `map`, `byType`, `custom`. Fails safe and reports `dropped` / `withheld` by path. |
| `shared/config-visibility.js` (new) | release payload | `TRIP_CONFIG_PUBLIC` allow-list, plus `projectConfig`, `publicConfig` and `publicPart(phase\|day\|dayItem)` |
| `shared/agent-schema.js` | release payload | `publicAgent` becomes `projectAgent`, which is an allow-list. `agent.profile` and unknown keys are no longer served. |
| `server/server.js` | release payload | `sanitizeConfig` now calls `publicConfig`. Dropped paths are logged at boot and counted in `/api/config/warnings`. `/api/config/roster` now reads projected participants. `promoteConfigDays` loops over the raw lists but takes values from projected elements. `hebrewOf()` is new. |
| `server/living-journey.js` | release payload | `dayContextForPhase` picks the hotel on raw data and serves the projection. `pickup_context` is now always null. New `publicDayContext` on the served itinerary. `rowsFromConfig` projects too. `/api/today` returns the canonical time zone. `/api/hermes/status` drops `identity.profile`. |
| `tests/config-allow-list.test.js` (new), `tests/helpers/provisioned-config.py` (new), `tests/helpers/ports.js`, `tests/package.json` | tests only | 25 tests. The new file is added to `npm test`. |

Every production file is in `PAYLOAD_ROOTS = site, server, shared`
(`control-plane/api/src/release-artifact.ts:24`; `release_source.py:23`).
`server/Dockerfile:7` does `COPY shared /app/shared`. There is no change to the
control plane, worker, relay, migrations, `trip-web/`, `mcp/` or companion
templates.

## 2. Risk table

| Change | Surface | Blast radius | Migration | Compat break | Risk | Test | Min | Batched? |
|---|---|---|---|---|---|---|---|---|
| Allow-list on `/api/config` and `/versions/:v` | release → new trips, and existing trips only on redeploy | Every member and the companion (`get_config`) of any trip running the new release | none | **Yes, for configs carrying unlisted fields.** They are dropped silently. | **Medium**: silent, and reversible by redeploy | `config-allow-list.test.js` (read). Per-trip projection before redeploy. | 1 + 5 per trip | isolated per trip (silent) |
| `publicAgent` allow-list, `/api/hermes/status` without `profile` | same | same | none | `identity.profile` removed. I found no reader in `site/`, `trip-web/src`, `mcp/` or `control-plane/`. | low | test at lines 338–346 | in suite | — |
| `promoteConfigDays` / `rowsFromConfig` project values | same; runs at boot on a **fresh** DB only (`importPlanOnce`), `INSERT OR IGNORE` on `config_ref` | New trips' first active plan | none | `config_ref` is built from the raw index, the scalar phase id and the date. It is unchanged for well-formed configs, so there are no duplicates on redeploy. | low | lines 350–367 and 509–543 | in suite | — |
| Day context: `pickup_context` null, lodging projected | same | Members reading `/api/itinerary/active` | none | `pickup_context` has no producer and no reader. `trip-web` reads only `lodging_context.name` (`App.tsx:985`). | low | lines 372–399 and 535–543 | in suite | — |
| Roster from projected participants | same | Unauthenticated login picker | none | A participant `name` that is not a string is dropped, and the picker shows the username | low | lines 426–436 | in suite | — |
| `/api/today` canonical tz | same | Members | none | Only the spelling changes | negligible | line 530 | in suite | — |
| Security claim (#172 leak closed) | same | — | — | — | Security path. Goes to `boundary-reviewer`. The PR says a third look is running. | HTTP evidence in the test file, plus reviewer | reviewer | **isolated** |

## 3. Migration and compatibility findings

**Migrations: none.** There is no file under `control-plane/db/migrations/`,
and `migrations.test.ts` needs no update.

**Release seal.** The PR adds two files under `shared/` and changes three
payload files. That gives a new `artifactDigest`, so a new release has to be
registered, verified and promoted. A stale digest fails loudly at provision time.

**Intake schema.** No change.

**Two producers, one shape.** Both interview paths go through the allow-list.
`provisioned-config.py` runs `transform_intake` + `enrich_config` on the
agentless path (`planned`) and on the agent/document path (`venues`). I read it.
My own capture covers every intake the worker's tests use, on both paths.

**`trip.config.json` written by older workers.** This is the real question for
this PR, and what I found is below. **Dropped** means the list does not name the
field and it is not served to anyone. **Withheld** means it is kept back on
purpose.

| Source | Checked by | Result |
|---|---|---|
| Sprint-6 worker (merged tree): every `transform_intake`/`enrich_config` return across its unittest suite | me, 2026-09-25 (540 run, 100 DB-backed skipped) | 249 configs, **0 dropped** |
| `origin/main` `e84fd7f` worker, same method (`git archive` into scratch) | me | 189 configs, **0 dropped** |
| main at `aa61f6e` (last main commit before 2026-09-15 18:00, when the Japan trip was provisioned) | me | 179 configs, **0 dropped** |
| create-trip scaffolder `buildConfig(answers.example.json)` (`driver.mjs`, the Mac/`provision.js` path) | me | **0 dropped** |
| Provisioner post-enrich mutation: `accommodation.pdf` (`provisioner.py:1017-1020`) | read | on the list |
| Site runtime writers: `POST /api/agent/participants`, `PATCH .../telegram`, `export-to-config` (`server.js:1040`, `1126`, `3331-3399`) | read | every key they write is on the list |
| `legacy scripts/new-trip.js`, `obsidian-to-config.js` templates | read | every key they write is on the list |
| 15 configs in `~/kinerary-deploy`: 14 are `retired-trips/*` Mac e2e trips from 09-19/20, 1 is `trips/los-angeles-hawaii-vegas-2026`, archived 09-16 | me | **0 dropped**. The developer's "15 real configs" claim is confirmed, but **none of these is a live production trip.** |
| `trips/japan-2025` (tracked hand-authored reference) | me + golden test | 0 dropped |
| **`/Users/elul/USA2026/trips/usa-2026/trip.config.json`**: hand-authored, file mtime 2026-08-28, trip dates 2026-07-05 to 07-30, 17 participants | me (paths only) | **40 dropped, 12 kinds** (listed in "What would reduce the risk", item 2) |

The PR description says "All 15 real trip configs on this machine project with
nothing dropped". That is true of the 15 it enumerated. It is **not** true of
every real config on this machine, and the one exception is the hand-authored
lineage the PR itself names as exposed.

**Readers.**
- `trip-web`'s `configSchema` and `parity-schema.ts`: every key they declare is
  on the list, and I checked each one. The only fields zod requires are
  `phases[].id`, `participants[].username`, `tasks[].id`,
  `emergency_contacts[].phone`, `hospitals[].name` and `rsvp_activities[].id`.
  All of them are scalars the list keeps, so the allow-list cannot newly fail
  `configSchema.parse` on a config zod used to accept.
- Classic `site/app.js` and `trivia.html`: a heuristic scan of property reads
  on config-shaped variables found no config key off the list. The misses were
  DB-row fields (`item.*`, `meta.label_*`) and DOM fields. This is a heuristic,
  not a proof.
- `mcp/mcp.js` reads `meta.title` and `phases[].id/dates`, and returns
  `get_config` whole.

## 4. Live-fleet impact

**Fleet read.** I ran the repo's `fleet-mcp.mjs --tool list_trips|trip_detail
--stack prod` with `KINERARY_FLEET_CONFIG` set to the `trip-monitor` profile's
`fleet-stacks.json`. That tool reaches the VM's psql read-only, over its own
configured transport, which is SSH to the VM. I opened no shell of my own.

| Trip | Class / stage (read today) | Built by | Exposure on its next redeploy |
|---|---|---|---|
| `japan-tokyo-hakone-kyoto-osaka-2026` (`trip_66617c87…`) | live, `ready_private`, group + private bindings open | VM worker 09-15, then a live one-off repair on 09-15 that patched `agent.organizers` and `meta.defaultLang` (memory; both are on the list) | Probably 0 dropped. main's producers emit nothing off the list. The live file itself is unread. **Mid-trip per memory (19 Sep to 3 Oct): do not redeploy.** |
| `orlando-florida-2026` (`trip_72f87b5c…`) | live, `ready_private`, private binding only, created 09-23 | VM worker 09-23 | Probably 0 dropped, same reasoning. Its dates are unknown to me. |
| CT200 `trip-usa2026` | **not in the control-plane DB.** Memory says no control plane tracks it. | hand-authored | Likely lineage: 40 dropped, 12 kinds. Its trip ended 2026-07-30 per the local copy. It is not release-pinned, so it changes only if someone deploys a checkout to it by hand. |
| 2 `intake_in_progress` and several `draft` prospects | prospect | — | They will build from whatever release is `available` when they finish. This PR reaches them only after it is promoted. |

**Q1: what an allow-list does to a live trip on redeploy.**
- Every unlisted field is dropped from `/api/config`, `/versions/:v` and
  the companion's `get_config`. A wrong-shaped value is dropped the same way.
- The failure is silent to members. The only signals are:
  - a `console.warn` in the trip container listing the paths, never the values;
  - one `{scope:'config', issue:'N config field(s)…'}` entry in
    `/api/config/warnings`, a count with no names.
- **Nobody would notice** unless they read that container's log or that route.
  Nothing in the system does.
- For a producer-built trip there is nothing to drop (verified above).
- For a hand-authored trip:
  - The site UI does not visibly change. Neither current nor July-era
    `app.js`/`trip-web` renders the dropped kinds; I grepped `checkin`,
    `.car`, `altitude_m` and `pending_attractions` in both.
  - The companion does lose facts, and its skill tells it to say "I don't have
    that" rather than guess. It may still find some of them in `bookings.json`
    via `get_bookings`; I did not verify that.
- Nothing persistent changes on an existing trip:
  - The boot import is `INSERT OR IGNORE` on an unchanged `config_ref`.
  - Day-context sanitising happens when a response is served.
  - The config file is not rewritten.
  - So redeploying the previous release undoes it completely.

**Q2: the exposed cases.** See the table above. I could not read CT200's or
either VM trip's live `trip.config.json`:
- The fleet tool does not expose configs.
- main's provisioner has no `plan_snapshot`, so the VM DB holds no copy.
- Reading them needs the operator path in `kinerary-deploy`, or an organizer
  login fetching the old release's `/api/config`.

Both are owed before each trip's redeploy. They are not owed before the merge.

**Q3: does a dropped field vanish from the companion?** **Yes.**
- `get_config` is `apiGet('/api/config')` (`mcp/mcp.js:154-155`).
- With the agent key, that route serves the same allow-listed view. The test
  at lines 410–413 covers this.
- `/api/agent/brief` still reads the raw config for organizer-only needs and
  instructions. It does not carry phases, cars or check-in times.

**Q4: what redeploys, on which clock.** Everything in this PR is on the
**release clock**:
1. Merging into `integration/sprint-6` changes nothing anyone sees.
2. It reaches production only after sprint-6 reaches the release pool: a new
   release (new digest), `candidate` → `verified` → `available`. Promotion to
   `available` classifies as a deploy.
3. From then on, **new trips** get it at provision.
4. **Existing trips** keep their pinned release until someone redeploys each
   one: Japan, Orlando, and CT200 by hand, since it is outside the control plane.
5. No control-plane or bridge restart is needed. `mcp.js` is unchanged, and the
   companion's view changes when its site restarts.

## 5. The plan

**Run A: done, gates the merge.** `cd tests && npm test` on tree `5f1a136`:
**515/515 pass, 0 fail/cancelled, 56 s wall**. I measured this on 2026-09-25 on
the Mac. That run includes `config-allow-list.test.js`, which I read in full:
- the hostile config over HTTP as plain member `bob` and as the agent key, on
  `/api/config`, `/versions/:v`, `/roster` (no auth), `/hermes/status`,
  `/itinerary/active`, `/phases/ny/plan`, `/phases/ny/plan/days` and `/today`;
- the boot log names paths and never values;
- `/warnings` carries a count and no names;
- a malformed-import trip keeps `config_ref`/`sort_order`;
- hotel choice on raw dates;
- the golden round-trip for `japan-2025`, the fixture, and both provisioner paths.

It matches the verifier's figure. No flake occurred this run.

**Run B: done, extra evidence (about 10 min).** The producer capture and the
config projection in §3. The scratch scripts are at the session scratchpad:
`capture.py`, `project.cjs` and `driver-check.mjs`. They are recipes, not
committed.

**Run C: per existing trip, before its redeploy (about 5 min each, operator).**
Get that trip's current `trip.config.json` through the `kinerary-deploy`
operator path, or its old-release `/api/config` as the organizer. Then:
```bash
node -e 'const {projectConfig}=require("./shared/config-visibility.js");
const r=projectConfig(JSON.parse(require("fs").readFileSync(process.argv[1],"utf8")));
console.log([...new Set(r.dropped.map(p=>p.replace(/\[\d+\]/g,"[]")))].join("\n")||"0 dropped")' <config.json>
```
- Expect `0 dropped` for Japan and Orlando.
- Anything else stops that trip's redeploy until the list is extended or the
  loss is accepted, in writing.

**Run D: at each trip's redeploy (needs approval and a window).**
1. Before: record the item counts of `/api/itinerary/active` and
   `/api/phases/<id>/plan`.
2. After the restart:
   - (a) the container log has **no** `not on the served allow-list` line;
   - (b) `/api/config/warnings` has no `scope:'config'` entry;
   - (c) the plan item counts are identical to before;
   - (d) the companion answers one hotel/check-in question from `get_config`.
3. Timing:
   - Japan: after 3 Oct (memory dates).
   - Orlando: at its next natural redeploy.
   - CT200: only after decision D1.

**Run E: batched onto sprint-6's release walk, not a separate run.**
- Checks: the D-checks (a)(b) on the freshly provisioned trip, plus the hero,
  map and hotel card rendering.
- Command: `scripts/preflight-deploy.sh --deploy --auto --scenario multi --cleanup`
  (or `manual`).
- **Not `japan` or `all`** while the Japan trip is live. The fixture collides
  with its slug and dates (memory, 2026-09-19).
- Adds about 5 minutes to a walk that is already owed. It needs a deploy
  approval and a window with no VM run.

## 6. Budget

| Tier | Cost | Buys |
|---|---|---|
| **Merge gate (minimum)** | 0 more minutes. Runs A and B are done. The boundary-reviewer's third look is in flight. | Proof that nothing off the list reaches a member on the named routes, for every producer config and known shape |
| + decision D1 and item 2 | 5 min decision, about 20 min dev if extending | CT200 and any future hand-authored trip keep what the companion reads |
| + items 3 and 4 | about 45 min dev | A silent drop becomes a finding, and each redeploy has a one-command check |
| + Run C/D per live trip | about 5 min + redeploy each | The fix actually reaches Orlando, Japan (post-trip) and CT200, with evidence |
| + Run E | about 5 min on the sprint-6 walk | Image, release digest and a real provision exercised with the allow-list |

Without Run C, redeploying a trip means deciding to find out in production
whether that trip loses fields. Only the container log would say so.

## 7. Go / no-go and the way back

**No-go for any existing trip's redeploy** if any of these holds:
- Run C prints a dropped path that has not been decided;
- the trip is running right now (Japan);
- a VM e2e run overlaps.

**No-go for the merge:** a failing `config-allow-list.test.js` that survives
a rerun and an isolated run, or a boundary-reviewer finding.

**Way back:** there is no migration and no persistent change on an existing
trip, so redeploying the trip's previous release is a complete undo. For new
trips, their first imported plan went through the projection. Rolling the
release back keeps those rows, which are a subset of the raw config.

## 8. Is the suite sufficient? (the explicit answer)

**Sufficient to merge #196 into `integration/sprint-6`, as a security fix.**
- It proves fail-safe behaviour with request/response evidence on every member
  route the PR changed.
- It proves the golden round-trip for the tracked reference config and for the
  provisioner on both interview paths.
- My wider capture (617 producer configs across three worker revisions, plus
  the scaffolder and 16 on-disk configs) found nothing the golden tests would
  have missed for producer-built trips.

**Not sufficient to redeploy any existing trip.** The suite cannot see live
configs, and the one hand-authored config I found loses 40 fields.
- "Nothing is lost" is proven for producer output only, not for configs people
  or scripts edited by hand.
- The Japan trip's config was hand-patched on 09-15. Those patches are on the
  list per memory, but the file is unread.

**Not evidence about companion behaviour.** It proves what `get_config`
returns, not what a companion does without the dropped fields.

**It does not settle the security review.** That is `boundary-reviewer`'s job,
and its third look is in flight. I found no member-facing raw-config read outside the
routed ones in a quick pass. The raw `phases[].title` at `server.js:2669/2762/2938`
goes out to enrichment and model context, not to members. That pass was not
exhaustive.

## 9. Decisions needed

- **D1 (Dror): CT200's 12 field kinds.**
  - Option (a): extend the list. `pending_attractions.name` → `text`; add
    `status`, `pdf`, `cars.note` as `text`, `checkin`/`checkout`,
    `altitude_m`, and a `phases[].car` shape. Note that `car.confirmation` and
    `cost` would then reach every member.
  - Option (b): accept the loss.
  - Option (c): record that CT200 is never redeployed with this release.
  - Its trip ended 2026-07-30 per the local copy, which is unverified against
    CT200.
- **D2: Japan redeploy timing.** I recommend after 3 Oct. Please confirm the
  dates; I could not read them via the fleet tool.
- **D3: Orlando's dates**, to decide whether it takes this at its next natural
  redeploy or in a planned window.
- **D4: who reads `/api/config/warnings`**: the worker's post-deploy
  verification or the fleet monitor (item 3). There is no owner today.

For `sprint-scribe`:
- The planner's own reference number "469 tests, ~55 s" is stale. It is now
  515 tests in 56 s, measured 2026-09-25.
- "15 real configs, nothing dropped" should be recorded as "15 in
  kinerary-deploy, none live", not "all real configs".
