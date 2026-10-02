# Regression plan — PR #160 (`feat/156-destination-info`) into `integration/sprint-6`

**Mode:** branch / pre-merge. **Date:** 2026-09-22.
**Assessed tree:** the materialised merge result in worktree
`/Users/elul/kinerary/.claude/worktrees/agent-a7f3dc00f832f90f5`, on
`throwaway/pr160-into-sprint6`, base `342d141` (`integration/sprint-6`).
Nothing here was committed, merged or deployed by this pass.

---

## Verdict, quotable verbatim

> **Yes — the existing test suite is sufficient to merge PR #160 into
> `integration/sprint-6`.** The migration is a metadata-only `ADD COLUMN` that I
> rehearsed against a populated `country_reference` and it left every existing
> row byte-identical; the merged tree is green on every suite that touches it
> (control-plane API 1606 tests / 1600 pass / 0 fail, worker 493 tests / 0 fail,
> `tsc` clean, `preflight-checks.sh --all` exit 0, all measured on this tree
> today); and no file under `site/`, `server/`, `shared/` or `trip-web/` changed,
> so no release is produced and no live trip's pinned code moves. **It is not
> sufficient to *deploy* this to the production VM, and those are different
> decisions:** deploying restarts the control-plane API, which is the moment the
> new hourly refresh timer begins spawning `hermes` web-search processes on the
> box — a behaviour no suite exercises, because every test injects the lookup.
> Before that deploy, one person needs to answer two questions from production
> that I could not reach from here: whether a Hermes search profile is set in the
> VM's environment, and what `destination_country` keys actually exist in
> `country_reference`.

---

## 1 — Change set

One PR, one branch, 19 files (`git diff --stat HEAD`, read on the materialised
merge tree):

| Area | Files |
|---|---|
| Migration | `control-plane/db/migrations/20260922120000_destination_info.sql` (new, 46 lines) |
| Control-plane API (src) | `destination-info.ts`, `destination-info-store.ts`, `hermes-search.ts`, `country-key.ts` (all new); `server.ts`, `interview.ts`, `consular-lookup.ts` (modified) |
| Control-plane API (test) | `destination-info.test.ts` (8), `destination-info-store.test.ts` (11), `country-key.test.ts` (5) new; `migrations.test.ts` +2 lines |
| Worker | `country_key.py` (new), `enrichment.py` (+354), `transformer.py` (+32, docstrings only), `__main__.py` (+59) |
| Worker tests | `test_country_key.py` (7, new), `test_enrichment.py` (+26 test methods) |
| Docs | `docs/sprint6-tracks.md` |

Totals: +2054 / −62.

**Nothing under `site/`, `server/`, `shared/` or `trip-web/`.** Confirmed against
`PAYLOAD_ROOTS = ["site", "server", "shared"]` (`release-artifact.ts:24`). No
`data_schema` / `intake_schema` value appears anywhere in the diff.

Project state, read via `scripts/project-state.py show`: sprint lock **OPEN**
since 2026-09-20, baseline **LOCKED** at `97582b6`, branch now 68 commits past
it. The integration branch may be assessed and merged. (Standing memory said
"Sprint 6 locked; do not assess" — **that memory is stale and is corrected
here**; the ledger's own record supersedes it.)

---

## 2 — Risk table

| # | Change | Surface (§2) | Blast radius | Migration | Compat break | Risk | Test | Min | Batch? |
|---|---|---|---|---|---|---|---|---|---|
| 1 | `20260922120000_destination_info.sql` | `db/migrations/` — applied on API boot, before traffic | everyone, irreversibly | **yes** | none found | **Low.** `ADD COLUMN` ×3, one with a constant default → PG11+ metadata-only, no rewrite, no lock held meaningfully | `migrations.test.ts`, `migration-rollback.test.ts`, **plus a populated-table rehearsal I ran** | 1 (rehearsal: measured 0.14 s) | batched |
| 2 | New hourly refresh timer in `server.ts` | `control-plane/api/src/` — VM redeploy | **every** organizer and bound chat at restart; spawns `hermes` subprocesses on the VM | no | no | **Medium — the only real one.** Untested at the entrypoint: every suite injects `lookup`; nothing exercises the timer actually starting or `hermes` actually being spawned from inside the API container | none exists; needs a boot-level observation | 5 | **isolated** |
| 3 | `destination-info-store.ts` (selection + fan-out SQL) | `control-plane/api/src/` | fills a cache; no traveller-visible effect | no | no | Low — the `bool_or` vs `min()` trap is the interesting part and is directly asserted | `destination-info-store.test.ts` (11, DB-backed) | in the 6 min suite | batched |
| 4 | `country-key.ts` + `interview.ts` refactor | `control-plane/api/src/` | consular writes for every new interview | no | **behaviour-preserving** — verified: extracted function is byte-equivalent to the deleted local | Low | `country-key.test.ts` incl. a "only ONE implementation exists" source scan | in the 6 min suite | batched |
| 5 | `hermes-search.ts` + `consular-lookup.ts` refactor | `control-plane/api/src/` | the live consular web search | no | no; one deliberate improvement (external SIGKILL no longer misreported as a timeout) | Low | `consular-lookup.test.ts` (pre-existing, still green) | in the 6 min suite | batched |
| 6 | `enrichment.py` `_enrich_destination_info` etc. | `control-plane/worker/` | **only trips being provisioned or re-provisioned** — not a settled trip | no | no | Low — wrapped in `try/except` inside `enrich_config`, which "never raises" | `test_enrichment.py` +26 | 2 s | batched |
| 7 | `__main__.py` `_destination_info_lookup` | `control-plane/worker/` | same | no | no | Low-Medium — it is a closure with **no direct test**; its SQL is asserted only by a cross-file string comparison from `destination-info-store.test.ts` | that cross-file assertion | 0 | batched |
| 8 | `transformer.py`, `docs/sprint6-tracks.md` | docstrings / prose | none | no | no | None | n/a | 0 | batched |

---

## 3 — Migration and compatibility findings

### 3.1 The migration is what the header says it is — verified, not taken on trust

The whole of the executable content is:

```sql
ALTER TABLE control_plane.country_reference
  ADD COLUMN destination_info            jsonb       NOT NULL DEFAULT '{}'::jsonb,
  ADD COLUMN destination_info_source     text,
  ADD COLUMN destination_info_fetched_at timestamptz;
```

plus three `COMMENT ON` statements. Against §3's destructive list: no `DROP`, no
`NOT NULL` added to an existing populated column, no narrowed `CHECK`, no
`UNIQUE` index over existing data, no type change, no backfill `UPDATE`. The one
`NOT NULL` is on a **new** column with a **constant** default, which since
PostgreSQL 11 is stored in `pg_attribute.attmissingval` and does **not** rewrite
the table.

**Rehearsed against production-shaped rows** (not just the empty database
`migrations.test.ts` uses). I built `0023_country_reference.sql`'s table in a
private scratch database, inserted three rows across two destinations and three
home countries with varied `fetched_at` values, then applied the migration:

- `ALTER TABLE` + 3 `COMMENT`, **0.14 s wall** including the `docker exec`;
- every pre-existing row's `contacts`, `source` and `fetched_at` unchanged;
- all three new columns present, `destination_info = {}`,
  `destination_info_source` NULL, `destination_info_fetched_at` NULL.

The only caveat production adds is row count, and `country_reference`'s row count
is bounded by "(destination, home) pairs a trip has ever asked about" — a
handful. A metadata-only `ADD COLUMN` is O(1) in rows regardless.

### 3.2 `compatible` is machine-checked here, not just asserted

`migration-rollback.test.ts:130` scans every migration declaring `compatible` for
a breaking statement (`DROP TABLE`, `DROP COLUMN`, `RENAME`,
`ALTER COLUMN … TYPE`, `SET NOT NULL`) and fails on a contradiction. I confirmed
its filename filter `/^\d+_.+\.sql$/` **does** match the timestamped name
`20260922120000_destination_info.sql` — the guard is not silently skipping the
new file. I also ran `vm-release.py`'s own regex
(`^--\s*rollback:\s*(compatible|breaking)\s*[—-]\s*(\S.*)$`, `vm-release.py:128`)
against the file directly: it parses as `compatible`, so a rollback would
**keep** the database rather than discard it.

`scripts/preflight-checks.sh --all` exits 0 on the merged tree (B7 migration
naming, B6 deployment-naming, B8 sprint state all pass).

### 3.3 Expected noise, and there was none left unaccounted for

`migrations.test.ts` asserts the literal ordered file list twice; the PR updates
both. I ran it and it passed, so there is **no "expected failure"** to wave
through — if that file goes red on the integration branch after this merge, it is
real.

### 3.4 Old code on the new schema

Nothing reads the three new columns except code that arrives in this same merge.
`consularContactsFor` selects `contacts, fetched_at` by name; the worker's
`_consular_lookup` selects `contacts` by name. A trip site pinned to an older
release reaches the control plane through routes that do not touch this table.
The worker and API restart separately, and either order is safe: an old worker on
the new schema simply never asks for the columns.

### 3.5 Compatibility breaks other than SQL — none, and one worth naming anyway

- **Release seal:** untouched. No file under `PAYLOAD_ROOTS` changed, so
  `artifactDigest` is unchanged and no new release is needed or produced.
- **Intake schema:** untouched.
- **`trip.config.json` shape:** this *adds* `travel_info.health`,
  `travel_info.money`, `travel_info.communication`. Both renderers already read
  exactly those keys and already tolerate their absence — `site/app.js:3753-3757`
  via `listBlock`, which hides the block when the list is empty, and
  `trip-web/src/readiness.tsx:24-28`. So old sites are unaffected and a new site
  degrades to the current blank-section behaviour. **Verified by reading both
  renderers.**
- **Two producers, one shape:** the merged list has two producers — `api` lines
  derived in the worker and `model` lines from the cache. `_info_plain` and
  `plainText` now normalise identically (angle brackets stripped, whitespace
  collapsed, then bounded), and `test_enrichment.InfoCapConsistencyTests` reads
  `destination-info.ts` from Python and fails if the caps diverge. Same trick for
  the country key (`test_country_key.py` reads `country-key.ts`) and for the
  worker's provision-time SQL (`destination-info-store.test.ts` reads
  `__main__.py`). Three cross-language duplications, all three asserted. This is
  the strongest thing in the change.
- **`sanitizeConfig()` is a deny-list** (`server/server.js:729`), so everything
  in `travel_info` reaches `GET /api/config` for any `authRequired` caller — and
  `authRequired` is not an organizer check. Each Info-tab line now carries
  `source` and `origin` alongside `he`/`en`. `origin` is clamped to the allow-list
  `{"countries.dev", "emergency-numbers", "model"}` in `_info_line`, and the
  earlier version's leak of `hermes:<profile>` onto the wire was found and fixed
  in review before this merge (recorded at HEAD `342d141`). **I read the code and
  agree the leak is closed**, but see §8.4 — an allow-list on a path into
  `sanitizeConfig` is `boundary-reviewer`'s call, not mine.

### 3.6 A finding I did not go looking for: the consular read has a key mismatch

Not introduced by this PR, not a blocker for it, and worth an issue.

`country_reference.destination_country` is written from the interviewer's
`lookup_consular_contacts` argument, whose schema says *"The destination country,
e.g. \"Japan\""* (`interview-mcp.ts:280`) — so rows are keyed on a country name.

At provision time the worker passes `intake_destination(answers)` — the
organizer's **raw destination answer**, e.g. `"Tokyo, Hakone, Kyoto, Osaka,
Japan"` — into `enrich_config`. The two readers then do different things with it:

- `_enrich_consular` (pre-existing) passes the **whole string** through, so
  `_consular_lookup` queries `destination_country = 'tokyo, hakone, kyoto, osaka,
  japan'` — which matches nothing when the row is keyed `japan`.
- `_enrich_destination_info` (**new**) passes `_destination_anchor(destination)`,
  the last comma-separated part → `japan` → matches.

So the new path picked the correct key and the older consular path appears to
have a latent silent miss on every multi-part destination answer. I have not
confirmed it against a production row (see §4), which is exactly why the
production `SELECT` in §8.1 is the highest-value item in this plan: one query
answers both "does the new feature's key work here" and "has the consular cache
ever been hit".

---

## 4 — Live-fleet impact

Read today from production over the fleet monitor's read-only MCP
(`fleet-mcp.mjs --tool list_trips`, `KINERARY_FLEET_CONFIG` pointed at the
monitor profile's `fleet-stacks.json`):

```
Stack: production  [PRODUCTION]  filter: live
  trip_66617c87099572fc766c282a5761d55b | japan-tokyo-hakone-kyoto-osaka-2026
  | live | ready_private | reachable | created 2026-09-14 | idle 165h
```

**One live trip, past `ready_private` — real people are on it.** Both
`teardown-trip.py` and `fresh-interview.py` refuse past that line and so does
every step in this plan.

What this merge does and does not reach:

- **Merging to `integration/sprint-6` reaches nobody.** No release, no deploy.
- **Deploying the control plane to the VM** applies the migration at API boot and
  starts the refresh timer. Nothing a traveller sees changes at that moment: no
  live site reads the new columns at runtime, only at provision time. **The PR
  author's claim (1) is verified and holds** — with the one qualification in §5,
  run 3, that "no traveller-visible change" is not the same as "no change".
- **The live trip's Info tab does not change until that trip is re-provisioned.**
  This is the §2 asymmetry, and the standing precedent is PR #86, where the
  site-upload auth fix reached new trips by release while the two live sites were
  blocked at NPM instead. Here the fix is *not* urgent, so the correct answer is
  probably "leave the live trip alone" — but it should be a decision, not an
  oversight. Re-provisioning a `ready_private` trip is not a step this plan
  proposes.
- **Provisioning is ON on the VM for a real organizer** (since 2026-09-14). Any
  VM-side test run needs a human's explicit yes first.

**What I could not determine, and it is a decision rather than a low risk:**

1. **Is a Hermes search profile set in the VM's environment?** Neither
   `HERMES_SEARCH_PROFILE`, `HERMES_CONSULAR_PROFILE` nor
   `HERMES_DESTINATION_INFO_PROFILE` appears in `~/kinerary-deploy/provisioning.env`
   or `control-plane.env` (the Mac's), and I could not reach the VM's own env. The
   code comment in `enrichment.py` asserts "no deployment sets a search profile
   yet"; I could not confirm that for the VM. It decides whether the timer does
   anything at all after a deploy.
2. **What `destination_country` values exist in production's
   `country_reference`?** The fleet MCP deliberately exposes no SQL tool, and my
   attempt to run a read-only `psql` over the monitor's own SSH connection was
   blocked by this session's command classifier. Not established.

Both are answered by §8.1 and §8.2, each about one minute of a person's time.

**One asymmetry an operator will trip over.** `venueLinkSearchConfigured()` reads
`HERMES_SEARCH_PROFILE || HERMES_CONSULAR_PROFILE` (`itinerary-extract.ts:28`);
the new `destinationInfoSearchConfigured()` reads
`HERMES_DESTINATION_INFO_PROFILE || HERMES_SEARCH_PROFILE`
(`destination-info.ts:36`). **A deployment that sets only `HERMES_CONSULAR_PROFILE`
gets venue links but no destination info.** That downgrade is at least loud — the
`else` branch writes `destination_info.refresh_disabled` at startup, which is
exactly the right instinct for this repo's standing bug class — but the
difference in fallback chains is still a foot-gun. Name it in the runbook or make
the chains match.

---

## 5 — The plan

Everything below was run or can be run on the Mac, in this worktree. Nothing
here deploys.

### Run 1 — the merge gate (batched, already executed)

All measured on the merged tree today, 2026-09-22.

| Command | Result | Wall |
|---|---|---|
| `npx tsc -p tsconfig.json --noEmit` (control-plane/api) | clean | **5.2 s** |
| `npm run build` (control-plane/api) | exit 0; `dist/destination-info.js`, `dist/destination-info-store.js`, `dist/country-key.js`, `dist/hermes-search.js` all emitted; `dist/server.js` imports the store | **~10 s** |
| `npm test --prefix control-plane/api`, `CONTROL_PLANE_TEST_DATABASE_URL` pointed at a **private** scratch DB | **1606 tests / 1600 pass / 0 fail / 6 skipped** | **6 m 15 s** |
| worker: `PYTHONPATH=.:../.. python3 -m unittest discover -s tests` | **493 tests / 0 fail / 93 skipped** | **2.0 s** |
| worker: `test_enrichment` alone, verbose | **93 ok, 0 skipped** | **<1 s** |
| `scripts/preflight-checks.sh --all` | **exit 0** (2 pre-existing Hermes-profile drift warnings, unrelated) | ~20 s |

The 6 API skips are pre-existing and unrelated: one live-extraction fixture and
five Vault tests. **None of the new tests skipped** — the 11 DB-backed
`destination-info-store` tests ran for real.

Two operational notes on that run, because they change what the numbers mean:

- **I did not use `cptest`.** `cptest` is shared between sessions and every
  DB-backed suite here opens with `DROP SCHEMA … CASCADE`. I created
  `cptest_destinfo_regplan` on the existing test Postgres, used it, and dropped
  it. Anyone reproducing this should do the same.
- **One intermediate full run was killed** (exit 137, `SIGTERM` propagated into
  `interpret-db.test.ts`) while a second suite and a build were running
  concurrently on this Mac. That is resource pressure, not a regression; the
  clean isolated re-run is the 1606/1600/0 above. Per the standing rule, a red
  test is not a regression until it survives isolation — this one did not.

**Trip-site suite (`cd tests && npm test`) is not required by this change** and I
did not run it: no file under `site/`, `server/`, `shared/` or `trip-web/` is
touched. Running it would cost ~1 minute and buy nothing here.

### Run 2 — the migration rehearsal against populated rows (isolated, already executed)

Not batched, because §6's rule for a one-way migration is to rehearse it alone.

```bash
# in a private scratch database, NOT cptest:
psql -f control-plane/db/migrations/0023_country_reference.sql
# insert rows across 2 destinations x 3 home countries with varied fetched_at
psql -f control-plane/db/migrations/20260922120000_destination_info.sql
```

Result in §3.1: 0.14 s, no rewrite, existing rows untouched. **1 minute.**

### Run 3 — the one thing no suite covers: the timer at the real entrypoint (isolated, OWED before deploy)

This is the entrypoint debt, and it is the Sprint 1 failure mode exactly: 81
tests green while every route returned 503 in a real deployment. Every test of
`refreshStaleDestinationInfo` injects `lookup`. **Nothing anywhere proves that the
timer starts, that `hermes` is on `PATH` inside the API container, or what
happens hourly if it is not.**

Do it on the **Mac** stack, not the VM, and read the API's own log:

```bash
# from the checkout you mean — the API mount is dist/, not src/
(cd control-plane/api && npm run build)
# bring the local stack up per CLAUDE.md, then, within ~1 minute of boot:
docker logs <local api container> 2>&1 | grep destination_info
```

Checklist, numbered so a green run says which claim it settled:

1. **With no search profile set** — exactly one
   `destination_info.refresh_disabled` line at startup, and no
   `destination_info.*` line thereafter. Proves the gate, and proves the
   downgrade is loud. *(Change 2.)*
2. **With `HERMES_DESTINATION_INFO_PROFILE` set and `country_reference` empty** —
   no `refresh_disabled` line; no lookup attempted; the pass is a no-op. Proves
   the timer runs without spending anything. *(Changes 2, 3.)*
3. **With a profile set and one seeded `country_reference` row** — exactly one
   `destination_info.refreshed` **or** one named failure
   (`lookup_failed` / `rate_limited` / `empty_result`), never silence. If `hermes`
   is absent from the container, this is where you find out, and the log should
   say `hermes CLI not found`. *(Changes 2, 3.)*
4. **Then re-provision one scratch trip** and read the resulting
   `trip.config.json` for `travel_info.health|money|communication`, checking that
   every line carries `source` and an `origin` from the allow-list, and that no
   line carries a `hermes:` string. *(Changes 6, 7, and §3.5's wire check.)*

**Cost: ~30 minutes, a person present, Mac only.** Steps 1-3 need no trip and no
provision. Step 4 rides on any scratch provision you are doing anyway.

**Do not run this on the VM**, and do not point it at real Telegram: VM and Mac
runs must never overlap (same Proxmox / NPM / Cloudflare, same slug derivation),
and provisioning is on there for a real organizer.

### Run 4 — before any VM deploy (isolated, a person, read-only)

The two production reads in §8.1 / §8.2, then the standard
`sudo kinerary-cp-release upgrade --dry-run` path. **~10 minutes.** Note the
standing storage guard: `kinerary-cp-release` refuses any upgrade, `--dry-run`
included, while a network filesystem is mounted on the VM.

### What must NOT be batched, and why

- **The migration rehearsal** — one-way, so it gets its own run against restored
  or populated data (§6).
- **The timer at the entrypoint** — the failure mode is silent. A thin Info tab
  looks exactly like a normal Info tab, and an absent `hermes` binary produces an
  hourly retry loop visible only in a log line. A shared walk would not surface
  it.
- **The `origin` allow-list on a `sanitizeConfig` path** — "it came up in the e2e
  run" is not evidence for a security path. §8.4.

### What can safely be batched

Changes 1, 3, 4, 5, 6, 7 all ride on run 1: they touch disjoint code, none can
mask another's failure, and each has its own direct assertion rather than
depending on a shared observable.

---

## 6 — Budget

| Tier | Contents | Minutes | What it buys |
|---|---|---|---|
| **Minimum gate for the merge** | Run 1 + Run 2 | **~8** (already spent) | Everything the merge itself can break. This is sufficient — see the verdict. |
| **+ deploy gate** | Run 3 | **+30**, a person, Mac | The only untested behaviour in the change: does the timer actually start, and does `hermes` exist where it will be spawned. Without it you are deciding to find out on the VM. |
| **+ production readiness** | Run 4 | **+10**, a person | Whether the feature will do anything at all in production, and whether the key it looks up is the key that is stored. |
| **+ security** | `boundary-reviewer` on the `origin`/`source` fields | its own pass | Independent evidence that nothing internal reaches `GET /api/config`. |
| **Not bought here** | full e2e (`--auto --scenario all`, ~80 min documented) | — | Nothing this change needs. No release, no site change, no interview-router change. Skip it. |

---

## 7 — Go / no-go and the way back

**Go for the merge** into `integration/sprint-6`, on the evidence above.

**Stop conditions for a later VM deploy** (any one):

- `migrations.test.ts` red for a reason other than an added filename;
- `hermes` not present inside the API container **and** a search profile set in
  the VM environment — that combination is an hourly failing subprocess spawn
  forever; fix one or the other first;
- the production `SELECT` in §8.1 shows `destination_country` values that are
  full itinerary strings rather than country names — the feature would write a
  cache nothing reads (§3.6), so fix the key before shipping the timer;
- a live interview in progress at restart time (relay/API restart drops a turn).

**The way back.** `sudo kinerary-cp-release rollback` (always `--dry-run` first).
Because the migration parses as `compatible` (§3.2, verified against
`vm-release.py`'s own regex), a rollback **keeps the database** — the three
columns stay, and the previous release ignores them. That is the whole reason the
header matters, and it is correct here. The upgrade snapshots the VM from the
Proxmox host and dumps the database before touching anything; no extra snapshot
is needed for this change beyond that standard one.

**There is no down migration and there does not need to be one.** Dropping the
columns later would be a new, `breaking` migration and a separate decision.

---

## 8 — What would reduce the risk, ranked by risk removed per minute

### 8.1 Run one read-only query against production — **1 minute, highest value**

```sql
SELECT destination_country, count(*) AS rows,
       count(*) FILTER (WHERE destination_info_fetched_at IS NOT NULL) AS filled
  FROM control_plane.country_reference
 GROUP BY 1 ORDER BY 1;
```

(Run it through the fleet monitor's own read-only connection, or any read-only
psql on the VM. `destination_info_fetched_at` only exists after the deploy — drop
that column from the query to run it before.)

This single result answers three separate open questions: how much work the
timer's first pass faces (at 3 destinations/hour, a backlog of N destinations is
N/3 hours), whether §3.6's key mismatch is real, and whether the whole feature
will hit or miss on the one live trip. **Do this before the deploy, not after.**

### 8.2 Read the VM's environment for a search profile — **1 minute**

`HERMES_DESTINATION_INFO_PROFILE` / `HERMES_SEARCH_PROFILE` / `HERMES_CONSULAR_PROFILE`
in the VM's env file. Unset means the timer never runs and this deploy is a
pure schema change — which is the *safest* outcome and also the one where the
feature does nothing, so either way the answer changes what you expect to see.

### 8.3 Do run 3 (§5) before deploying — **30 minutes**

The entrypoint debt. Every suite injects the lookup; nothing proves the timer
starts or that `hermes` is reachable from the API process. Cheapest possible
version: bring the Mac stack up and grep one minute of API log for
`destination_info`. If you do only one thing from this section beyond §8.1, do
this.

### 8.4 Route the `origin` / `source` fields to `boundary-reviewer` — **its own pass**

Two new fields now ride into `trip.config.json` and out through a deny-list
sanitizer to every authenticated family member. The allow-list looks right to me
and the `hermes:<profile>` leak was caught before merge, but §"Security-sensitive
paths" in CLAUDE.md is explicit that this class gets live request/response
evidence, not a code read. This is not a merge blocker; it is owed before the
fields reach a family.

### 8.5 File the consular key-mismatch finding as an issue — **5 minutes**

§3.6. Pre-existing, silent, and it means embassy contacts may never have reached
a multi-city trip's Info tab. Confirm with §8.1's output first; the fix belongs at
the source (`_enrich_consular` should anchor the same way
`_enrich_destination_info` does) rather than at the call site.

### 8.6 Make the two `*_configured()` fallback chains agree — **10 minutes**

§4's last paragraph. `HERMES_CONSULAR_PROFILE` alone enables venue links and not
destination info. Either add it to the destination-info chain or say so in the
runbook.

### 8.7 Nothing else

The rest of this change is unusually well covered — three cross-language
contracts asserted by reading the other language's source, the `bool_or`/`min()`
trap tested directly, every failure path logged with a distinguishing name, and
the cache read isolated so a database outage costs only the prose. I am not
asking for more tests on it.

---

## 9 — Decisions needed (nothing guessed)

1. **Is a Hermes search profile set on the production VM?** Could not determine
   from here (§4). Decides whether the deploy is a schema-only change or starts a
   model-spending loop.
2. **What keys are in production's `country_reference`?** Could not determine —
   the fleet MCP exposes no SQL tool by design, and my read-only psql attempt was
   blocked by this session's command classifier. §8.1.
3. **Does the live trip `japan-tokyo-hakone-kyoto-osaka-2026` get re-provisioned
   to receive this?** My recommendation is **no** — it is `ready_private` with
   real people on it, and a blank Info-tab section is not worth touching a
   running family's site for. But the asymmetry means "deploy and forget" leaves
   it permanently on the old config, and that should be a recorded choice.
4. **Is `hermes` present inside the control-plane API container on the VM?**
   Unchecked. Run 3 step 3 answers it on the Mac; the VM needs its own look.
5. **Should the `origin`/`source` wire fields go to `boundary-reviewer` before or
   after the deploy?** §8.4. My read: before they reach a family, which given the
   re-provision asymmetry means before the next trip is provisioned, not before
   the merge.

---

*Produced by `regression-planner`, branch mode, 2026-09-22. Every number above
was measured on the merged tree today or read from the file cited; nothing was
carried from an earlier report. This agent ran no deploy, no commit and no merge.*
