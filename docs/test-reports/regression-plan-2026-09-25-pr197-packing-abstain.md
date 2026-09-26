# Regression plan: PR #197, phase packing lists only when place and season are known (issue #167)

**Verdict: OK to merge into `integration/sprint-6`. The change has a small blast radius and is easy to undo.** No live trip changes when this is deployed. Neither production trip has `phase.packing` today, so none can lose it. The suite proves the code does what it says: no hemisphere flip, and no list for a country, a region, a territory, a tropical, arid or Mediterranean place, or a phase that names no place. The suite does **not** prove the climate figures are correct. Every "yes, show a list" verdict comes from monthly means the developer recalled, and no test checks them against a source. Eight table entries sit within 0.7 C of their threshold on the "show a list" side. One 20-minute spot check of those eight is owed before the VM upgrade that ships this, not before this merge (section 8, item 1).

Mode: branch / pre-deploy, run 2026-09-25 on a read-only merged tree: `/Users/elul/kinerary/.claude/worktrees/integ-197-merged`, HEAD `1fedd00` = `origin/integration/sprint-6` `96a2897` + PR #197 head `5c78064`. The live fleet was read through the fleet monitor's read-only MCP (`fleet-mcp.mjs`, profile `trip-monitor`, stacks `prod` and `local`). Nothing was deployed. Nothing was written to production or to the merged tree. Bytecode writing was disabled for the test run.

---

## 1. Change set

| Item | Branch / commit | Files |
|---|---|---|
| PR #197 "fix(sprint6.1): phase packing lists only for named places whose every month is known (#167)" | `fix/167-packing-abstain` @ `5c78064` → base `integration/sprint-6` (OPEN; `gh pr view 197`, 2026-09-25) | `control-plane/worker/control_plane_worker/packing_climate.py` (new, 975 lines); `control-plane/worker/control_plane_worker/transformer.py` (+/-187); `control-plane/worker/tests/test_packing_climate.py` (new, 636); `control-plane/worker/tests/test_transformer.py` (+/-102) |
| Issue #167 | OPEN: "phase.packing's hemisphere lookup has known coarseness gaps" | — |
| Change being corrected | #162 / PR #165, merge `20f7419` (2026-09-23), **on `integration/sprint-6` only**. `git merge-base --is-ancestor 20f7419 origin/main` → not an ancestor. `origin/main` (`e84fd7f`) has no `_derive_phase_packing` at all. | — |

**Correction to the brief.** The brief says the old hemisphere lookup, `_KNOWN_COUNTRY_HEMISPHERE`, `_destination_hemisphere` and `_season_bucket` are gone from `transformer.py`. The first two are gone. **`_season_bucket` is kept** (`transformer.py:1535`), now a thin wrapper that calls `packing_climate.season_bucket`. `_derive_phase_packing` also remains, as the items half of the new `_phase_packing_decision`.

## 2. Risk table

| Change | Surface (§2) | Blast radius | Migration? | Compat break? | Risk | Test | Minutes | Batched / isolated |
|---|---|---|---|---|---|---|---|---|
| `packing_climate.decide()` gates `phase.packing` | `control-plane/worker/`: VM worker image (`Dockerfile:31` COPYs `control_plane_worker/`, which includes the new file) | Only trips provisioned or re-provisioned after a VM upgrade to a revision that contains it. A settled trip does not change. | No | Emits `phase.packing` less often. Absence is the state of every production trip today. | **Low.** It removes output, and every consumer already handles absence (section 3). | Worker suite (carried: 567 OK). I re-ran the two relevant files: 262 OK. | 0 more (measured: 0.79 s wall) | Isolated: it is a pure function, and a walk cannot observe abstention |
| The climate table's figures (recalled, no dataset) | same | Which named-city phases get a list, in which months | No | No | **Unsized** until the borderline entries are checked. The worst case is mild misadvice, not a hemisphere flip (section 4). | None exists. Tests check the table against itself. | ~20 (estimate) | Isolated: a desk check against sources |
| 11 Hebrew aliases removed from `_COUNTRY_ALIASES` | same | Currency and timezone lookups, which share `_country_keys` | No | **None.** Verified: no currency or timezone row uses those keys. | None | `test_the_transformers_hebrew_country_aliases_resolve_to_the_same_country` | 0 | — |

## 3. Migration and compatibility findings

- **Migrations:** none. **Release seal:** nothing changed under `site/`, `server/` or `shared/`, so there is no new release and `artifactDigest` is unchanged. **Intake schema:** unchanged.
- **Two producers (§4):** the gate reads only a phase's name (`full_en`/`full_he`, then `short_en`/`short_he`) and its dates (`transformer.py:1729-1735`). It never reads `venues` or `planned`, so the agent path and the agentless path go through the same code. The interview (model in the loop) supplies the phase name, and that name decides the outcome. "Tokyo" gets a list. "Hakone" does not. A Hebrew name missing from the table abstains, which is the safe direction. Examples with no Hebrew spelling in the table: Nagoya, Yokohama, Kanazawa, Ottawa and Bologna.
- **Merged phases** (consecutive stops that shorten to the same name) are judged on the first entry's full name and the **widened** date range. I probed "Tokyo (boys)" 11-25..11-30 plus "Tokyo (all)" 12-01..12-03: the result was `spans_seasons`, an abstention. Safe.

**Q2: consumers that assume `phase.packing` is present.** I read each one on the merged tree:

| Consumer | What it does with absence | Evidence |
|---|---|---|
| Classic site | `site/app.js:3221` and `:4378` guard on `p.packing?.length`. `renderPacking` (`:1776`) normalises non-arrays, which covers the unguarded `applyLang` call at `:77-83`. | read |
| trip-web | `readiness.tsx:55-59` maps `items: p.packing`, and `:111` filters on `items?.length`. The "No packing list has been added" line (`:122-128`) shows only when **no** pack has items. The general pack has a hardcoded fallback (`:34-52`), so that line cannot appear. `parity-schema.ts:29,82` makes `packing` `.optional()`. | read |
| `mcp/mcp.js` `get_config` (`:154`) | Passes `/api/config` through. No code reads `phase.packing`. | read |
| Companion (`profile-templates/`, `companion-control/`, `companion-mcp.ts`, `companion_profile.py`) | No reference to phase packing. `git grep -i packing` finds only `packing_reminders`, an agent-schema flag unrelated to this key. | grep |
| Provisioning / worker tests | Only `test_transformer.py`'s `PhasePackingTests` and `test_packing_climate.py` touch it. | grep |
| trip-web parity tests | `parity.test.tsx` uses `phases: []`. **No trip-web test renders a phase with or without `packing`.** The absent path is verified by reading the code, not by a test. | read |
| `tests/` (trip-site suite) | Fixtures carry `"packing": []`, and no test asserts presence. `create-trip/driver.mjs:170` writes `p.packing \|\| []` for manual scaffolds, a separate producer this PR does not touch. | grep |

Every consumer handles absence. Absence has also been the state of every control-plane trip in production from the start, because `main` never emitted the key.

**Q3: does anything else read the removed aliases or functions?** No. `git grep` across the whole tree, `scripts/` and `tests/` included, finds `_KNOWN_COUNTRY_HEMISPHERE` and `_destination_hemisphere` only in docs. `_season_bucket` is still defined and used only in `transformer.py`. I also grepped the 11 Hebrew spellings outside the two new files. They appear only in `test_transformer.py:1313-1320`, as test inputs. The "פרו" hits are substring noise inside "ספרו". At `96a2897`, `_KNOWN_COUNTRY_CURRENCY` (`:292`) and `_KNOWN_COUNTRY_TIMEZONE` (`:324`) have **no** southern-country key, so removing the aliases changes no currency or timezone result. That confirms the brief's claim. `_COUNTRY_ALIASES` and `_country_keys` are used only by `transformer.py:394,424,465`. `country_key.py` is an unrelated key for `country_reference`. **Docs still describe the removed design:** `docs/onboarding-mvp-sprint-plan.md:533`, `docs/sprint6-tracks.md:114-132` and `FRAMEWORK.md:272`. That is for `sprint-scribe` and `doc-keeper`.

## 4. Live-fleet impact (read 2026-09-25, `fleet-mcp.mjs --stack prod`, read-only)

- **Production has 2 live trips.** Both are `ready_private` and reachable. Each was provisioned once, by one succeeded job:
  - `japan-tokyo-hakone-kyoto-osaka-2026`, provisioned 09-15, with open group and private bindings.
  - `orlando-florida-2026`, provisioned 09-23, with an open private binding.
- There are 11 prospects and nothing is in flight. The Mac `local` stack has **0** live trips.
- **Production schema is `0051_trip_person_links.sql`**, the same as `origin/main`'s last migration. The sprint-6 migrations (`2026091811…` onward) are not applied. The VM therefore runs a pre-sprint-6 worker, which has no `phase.packing` derivation.
- **Q1: does any existing trip's `phase.packing` change? No.** Neither live trip has the key, so neither can lose it. This is **inferred, not measured**: I read the schema and the code provenance. A direct read of both sites' `/api/config` returned **401**, and I did not try further. One indirect route is not ruled out: a hand hot-patch of the worker container (`docker cp`), which the schema would not show. To measure it, run `docker exec <worker> grep -c _derive_phase_packing /app/control_plane_worker/transformer.py` on the VM. That needs a VM shell and Dror's yes.
- **When they would feel it:** only after (a) `integration/sprint-6` reaches `main` and the VM is upgraded with `kinerary-cp-release upgrade`, and then (b) a trip is re-provisioned. In the normal course that happens only when an organizer corrects an answer or a document on a live private trip (`intake-correction.ts:36`, `document-correction.ts:12`). A companion reconcile (`--reconcile-companion`, `provisioner.py:1603`) runs `transform_intake` but writes only the companion, and no companion code reads packing.
- **What a re-provision would do** (I computed this with the new code on the merged tree):
  - **Japan:** if its phases are Tokyo 09-19..23, Hakone 23..24, Kyoto 24..27 and Osaka 27..30, it would **gain** "A light layer" on Tokyo, Kyoto and Osaka, and Hakone would abstain (`climate_varies_by_area`). That phase list and those dates come from memory (`japan_fixture_collides_with_live_trip`, which says it matches the `japan` fixture) and are **not verified**. That trip is probably running right now, and re-provisioning a running trip is its own hazard, separate from this PR.
  - **Orlando:** nothing. Orlando is `mild_winter`, Florida is `mild_winter`, and Miami is `tropical`. It is the same as today.
- **Can a trip that already has `phase.packing` from the #162 code lose it on re-provision?** Yes, by design. Any phase that is not a named temperate city whose every covered month passes its season test loses the list, for example "Japan", "Hakone", "Rome", or Tokyo in December. That is **the intended abstention, not a regression**: under #162 those lists were guesses, and some were exactly the wrong advice the issue reports. The only such trips would be ones provisioned by sprint-6 code, which means Mac staging, and staging has no live trips. The one real loss of correct output is narrow: a named temperate city in a month now judged too close to call, such as Tokyo in December (7.7 C). That is the owner's stated trade-off ("if not sure, better not to say anything").
- **What must be redeployed for the fix to reach anyone:** only the worker image, through a VM upgrade. No trip needs a redeploy, because no trip carries the bug.

## 5. The plan

| # | Run | Command / action | Checklist | Minutes | Who |
|---|---|---|---|---|---|
| R1 | Worker suite on the merged tree | `cd control-plane/worker && PYTHONPATH=.:../.. python3 -m unittest discover -s tests` (scratch DB) | 567 OK, 0 skipped | carried from the verifier, not re-measured | done |
| R1b | The two relevant files | `PYTHONDONTWRITEBYTECODE=1 PYTHONPATH=.:../.. python3 -m unittest tests.test_packing_climate tests.test_transformer` | 262 OK | **0.79 s wall, measured here** | done |
| R2 | Borderline-entry spot check (desk) | For each entry in section 6, open the 1991-2020 normals for a **named station** (national met service, or the Wikipedia climate box the module cites) and compare the one month | Each value within about 0.3 C of the table, or on the same side of the threshold | ~20 (estimate: ~2-3 per entry) | developer or Dror, with a browser |
| R3 | What the VM's worker runs (read-only) | `docker exec <worker> grep -c _derive_phase_packing …/transformer.py` on the VM | 0 today. That confirms no live trip has `phase.packing`. | ~2 (estimate) | Dror approves the VM shell |
| R4 | Ride along on the sprint-6 acceptance walk, if one runs anyway | Use the `multi` scenario, not `japan`, which collides with the live trip (memory). After the provision, read `trip.config.json` `phases[].packing` on the container. | Venice shows "Umbrella or rain jacket, Waterproof footwear". Rome and Florence have **no** `packing` key. The general list still renders in Classic and in trip-web. | 0 extra, plus ~3 to read the config | whoever runs the walk |

**Why R4 is optional and can't prove anything on its own.** Abstention looks exactly like a bug: the site simply shows no per-phase list. In the `manual`, `vietnam` and `chaos` scenarios every phase abstains. The log line does not help either. Production's worker log cannot say *why* a phase abstained: `transformer.packing_abstained` carries phase and reason in `extra=`, but the worker's formatter is `"%(levelname)s %(name)s %(message)s"` (`__main__.py:150`), which drops `extra`. So the direct assertion is reading the config, not a walk.

The function is deterministic with no model and no network (there is a test that it cannot reach the network), so one run settles it. The only variable input is the phase name the interview writes, and the acceptance table in `test_packing_climate.py` covers that variety.

## 6. Q4: how much the release should rest on recalled climate figures

**What the tests check.** Latitude sign against hemisphere. Twelve months present for every temperate city. No duplicate spellings. Namesakes recorded. No country, region or territory ever yields a hemisphere. And, the one closest to data, `test_every_month_that_gets_a_list_passes_its_buckets_test`. **All of these check the table against itself.** None compares a figure with a source. The docstring says the figures are "recorded per city below so a reviewer can check each one", but **no station or source is recorded per city**. Station choice alone (for example Berlin Tempelhof vs Dahlem, or Christchurch airport vs Gardens) can move a monthly mean by about the size of `MARGIN_C`.

**What rests on which facts.**
- **Hemisphere flip,** the worst error, rests on latitude sign, the Koppen group letter and the 23.5-degree cutoff. These are coarse facts that are hard to misremember, and the tests cross-check them. For every temperate city on the list the second letter is `f`, which I checked from general knowledge, not a source. The release can rest on this.
- **Which months get a list** rests on the recalled means. **Direction matters.**
  - **The three entries the brief names all currently abstain:** Tokyo Dec 7.7 (`mild_winter`, needs ≤7.5), Berlin Mar 4.8 (`shoulder_month`, needs ≥5.0) and Queenstown Dec 14.0 (`cool_summer`, needs ≥14.5). If any of them is wrong, the worst outcome is that the site shows only the generic list where a phase list would have been fine. **They cannot cause wrong advice.** A check on them buys back lists; it does not remove risk. For what it is worth, my own recollection of JMA's 1991-2020 Tokyo December normal is 7.7 C. That is recall too, and it carries no weight as verification.
  - **Wrong advice would come from entries on the passing side.** I computed these from the table: every temperate city's month, sorted by distance from its bucket threshold.

    | Entry | Table | Threshold | Headroom | If wrong, family sees |
    |---|---|---|---|---|
    | **Shanghai Dec** | 7.5 | ≤7.5 | **0.0** | Warm jacket and gloves at up to about 8.5 C. That is defensible. |
    | Berlin Nov | 5.2 | ≥5.0 | 0.2 | Only "A light layer" at about 4 C, which is the `shoulder_month` failure by omission |
    | Kyoto Dec, Nagoya Dec | 7.2 | ≤7.5 | 0.3 | winter list, mild December |
    | Christchurch Aug | 7.2 | ≤7.5 (south) | 0.3 | winter list |
    | Oslo Oct | 5.3 | ≥5.0 | 0.3 | light layer in a near-winter October |
    | Canberra Aug | 7.1 | ≤7.5 (south) | 0.4 | winter list |
    | Helsinki Jun | 14.9 | ≥14.5 | 0.4 | summer list in a cool June |

  The 0.5 C margin already sits between each threshold and the raw criterion (8.0 / 14.0 / 4.5). So a recall error up to 0.5 C plus the headroom still meets the criterion. Beyond that, the harm is mild misadvice, never a flip.

**The smallest check that settles a doubtful entry.** For each doubtful entry, open that one month in the 1991-2020 normals for a named station: JMA for Japanese cities (Tokyo station 47662), DWD for Berlin, MetService/NIWA for Christchurch or Queenstown, BoM for Canberra, the China Meteorological Administration or the Wikipedia box for Shanghai. Record the station next to the figure. That takes about 2-3 minutes per entry and about 20 minutes for the eight above. If a check lands on the other side of its threshold, move the table value. `classify` and the tests re-derive everything else.

**My call.** The release can rest on the structural facts. For the monthly figures it should rest on nothing more than "a borderline error yields mild misadvice". The 20-minute check is cheap enough that the VM upgrade should wait for it. The merge into integration does not need to.

**A related decision** (it is about judgement, not data): the autumn and spring tests have a floor (≥5.0 C) but **no ceiling**. Tokyo 09-19..23 (23.3 C) gets only "A light layer", and Shanghai September (24.6 C) likewise. The module treats "still winter in April" as unreasonable by omission. The mirror case, "still summer in September", is not gated. This is what the live Japan trip would show on a re-provision, and what the `japan` scenario shows. It is incomplete advice, not wrong advice. Section 9.

## 7. Budget

- **Minimum gate for merging into `integration/sprint-6`:** R1 and R1b, both done. **0 more minutes.**
- **Before the VM upgrade that carries sprint-6:** R2 (~20 min, estimate). It is the only thing that turns "the figures are recalled" into "the borderline figures are checked". Without it you are deciding to find out from a family whether Shanghai in December is a gloves month.
- **+R3 (~2 min):** turns "no live trip has `phase.packing`" from an inference into a measurement.
- **+R4 (~3 min, riding on a walk that runs anyway):** one end-to-end confirmation that the provisioner writes what the unit tests say. On its own it proves nothing beyond R1.
- **Not worth buying for this change:** a dedicated 80-minute walk, extra samples (the function is deterministic), or a migration rehearsal (there is no migration).

## 8. Go / no-go and the way back

- **Stop the upgrade if** any of these happens: a provisioned config shows `packing` on a phase whose name is not a temperate city in `CITIES`; a southern temperate city (Canberra, Christchurch, Queenstown) shows winter items in December-February; or the worker fails to import `packing_climate`. The last would be loud, because the table is computed at import time.
- **Snapshot:** none specific to this change. It has no schema and no state. The VM upgrade's own `kinerary-cp-release` snapshot covers it.
- **Way back:** `sudo kinerary-cp-release rollback` to the previous revision. Trips provisioned in between keep whatever lists they got until they are re-provisioned. Because this change only removes output, that residue is at worst a missing per-phase list.
- **Ship #162 and #197 together.** #162 never reached production, so the fix arrives with or before the bug. **If anyone cherry-picks #162 (`20f7419`) to `main` or a hotfix branch without #197, the reported bug ships to families.**

## 9. What would reduce the risk (ranked by risk removed per minute)

1. **Spot-check the eight passing-side borderline entries (section 6) and record the station per city. About 20 min, before the VM upgrade.** This removes the only input nothing checks, and the docstring already promises the station column.
2. **Put the abstention reason into the log message, not only into `extra`. About 5 min plus a one-line test, for the developer.** Example: `logger.info("transformer.packing_abstained phase=%s reason=%s", phase_id, abstained)`. As written, production records that a phase abstained but not why. A family asking "why no list for Rome?" is otherwise answered only by re-running `decide()` offline.
3. **Run R3 on the VM (about 2 min, with Dror's yes).** It confirms that neither live trip carries `phase.packing`.
4. **Keep #162 from travelling alone** (section 8). This costs no time, only a note in the carry-forward.
5. **Doc drift** (`onboarding-mvp-sprint-plan.md:533`, `sprint6-tracks.md:114-132`, `FRAMEWORK.md:272`): these belong to `sprint-scribe` and `doc-keeper`. It is not a risk, but a future reader of those lines would assume every phase gets a list.

If the choice is only "merge into integration or not", the honest answer is that nothing more is needed. The items above belong to the VM upgrade.

## 10. Q5: is the suite sufficient?

> **Sufficiency statement.** The worker suite (567 OK, 0 skipped, carried from the verifier; 262 of those in the two relevant files re-run here in 0.79 s) **is sufficient to merge PR #197 into `integration/sprint-6`**. For the release it is sufficient for a narrower claim than "the advice is right". It proves the gate's logic. A list is emitted only for a named city in the table whose every covered month falls in one season and passes that season's threshold. Countries, regions, territories and unnamed phases never yield one, and nothing is inherited from the destination. There is no hemisphere flip for any table entry, the namesakes recorded so far are enforced, substrings and quote variants do not mis-resolve, and the resolver cannot reach the network. **It does not prove the climate data is correct.** Every temperate verdict is computed from recalled monthly means that no test compares with a source, because the tests check the table against itself. So the suite is **not sufficient** for the claim "every list a family sees is right for that month". That claim rests on eight entries within 0.7 C of a threshold on the emitting side (Shanghai Dec at 0.0 headroom), unverified until the ~20-minute check in section 9, item 1. The suite also does not cover the site's handling of an absent `phase.packing` in trip-web: no test renders a phase with or without it. That behaviour is verified by reading the code, and it is the long-standing production state.

**What remains unverified:**
- The borderline figures, and the source station of every figure.
- Whether the VM's worker is hot-patched (R3).
- The live Japan trip's actual phases and dates, which come from memory.
- The site's rendering of absence, which I read but no test covers.
- The worker log's lack of the reason, which I read in the code and did not observe in a running log.

## 11. Decisions needed (Dror)

1. Does the VM upgrade that carries sprint-6 wait for the ~20-minute borderline check (R2)? My recommendation is yes. The merge into integration does not need to wait.
2. Autumn and spring have no warm ceiling. Tokyo or Shanghai in September at 23-25 C get only "A light layer". Accept it as incomplete-but-not-wrong, or add a ceiling that abstains?
3. May I run R3 (a read-only `docker exec … grep` on the VM worker) to turn "no live trip has `phase.packing`" into a measurement?
4. After the upgrade, if the Japan organizer corrects an answer mid-trip, the site gains "A light layer" on three phases. Is that acceptable? It is additive, and it is what any re-provision does to a running trip anyway.

**Carried, not verified:** the worker suite's 567/0-skipped result, preflight-checks `--all` exit 0, and verifier PASS, all from the brief. The live Japan trip's phases and dates come from memory `japan_fixture_collides_with_live_trip`.
