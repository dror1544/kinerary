# Regression plan: the trip-mcp connector (#220) carried onto `integration/sprint-6` (refresh)

**Verdict: the suite is sufficient to merge.** This holds once `verifier` reports
the results in section 5, run A, on the staged tree. The merge here means the
carry lands on `integration/sprint-6`, and that reaches **no production trip**.
It needs no migration and touches no `control-plane/` path. Every connector file
is byte-identical to what `main` already has (`fbf3899`), and to what Orlando
already runs.

Two things are **not** settled by this verdict:

- **Decision 18's other gates.** The recorded gates in `docs/sprint6-tracks.md`
  are integrator, boundary-reviewer on the sprint-6 tree, then gate 1 and gate 2.
  Decision 18 also orders this carry *after* #199, and it is now going *before*
  #199. They share no path, so the order is harmless to test. It is still a
  change to a recorded decision (D3).
- **Promotion, VM upgrade and any trip redeploy.** None of these is approved or
  assessed here. Nothing that carries this code may become `available` before
  Orlando ends (1 Oct) and Japan ends (3 Oct). **Never run `retryProvision` on
  Orlando.** It would downgrade the trip (section 4).

One finding needs the owner, and it is not caused by this carry. The connector's
`get_config` gives any connected assistant, a read-only member's included, every
participant's `age`. The owner's recorded access decision (18.2) says "only
Telegram id, age and email of others are stripped". The code and the decision
disagree, on `main`, on Orlando now, and on this carry (D1).

Assessed 2026-09-26 by `regression-planner`, in branch mode. Worktree
`agent-aebd479de7fcdfe35`, HEAD `5a92aae` = `origin/integration/sprint-6`, carry
staged and uncommitted. This refreshes the 2026-09-25 plan, which was made on the
older base `dcea47d`. That plan is not in the repo; it is kept in the lead's
session store. I ran no DB suite, used no SSH and deployed nothing. The
live-fleet facts below are **carried** from the reads of 2026-09-25, not re-read
today (section 4).

---

## 1. Change set

**Base.** `5a92aae`. Since the old base `dcea47d`, sprint-6 has gained #218
(`2216d25`, claude child env keeps `USER`), #224 (`7531ec6`, the `/model codex`
test is host-independent) and docs (`b10344d`). `git diff --stat dcea47d 5a92aae`
shows that together they touch only `control-plane/api/src/model-runner.ts`, two
`control-plane/api/test/*` files and two docs. None of those overlaps the carry.

**Carry.** It brings #220 from `main` (merge `fbf3899`; commits `4434121 1942ed5
413c02f e68ab63 62d37e0 1c89be9`). `git diff --cached --stat` shows 27 paths,
+3353/−101.

| Group | Paths | Compared with `main` `fbf3899` (staged blob vs `ls-tree`) |
|---|---|---|
| Connector runtime | `server/trip-mcp/{index,oauth,tools,authorize-page}.js` (new); `server/server.js` (+17: `try { require('./trip-mcp').registerTripMcp(...) } catch`); `server/package.json` (+`@modelcontextprotocol/sdk ^1.30.1`, +`zod ^3.25.76`); `server/package-lock.json` | new files, `package.json` and lock: **identical**. `server.js`: differs only by sprint-6's own changes |
| Connector UI | `trip-web/src/assistant-connect.tsx` + test (new), `styles.css`, `member-logins.test.tsx`: identical. `App.tsx`: +3 lines (import, and the card after `MemberLogins` in `MoreView`) | identical except `App.tsx` context |
| Built bundle | `site/modern/index.html`; `index-Cu050onY.js` → `index-BjZpAv9m.js`; `index-ekEX2UwU.css` → `index-DoOF_Ucu.css` | CSS identical to main's. JS differs, because sprint-6's `App.tsx`/`api.ts`/`App.test.tsx` differ from main |
| Ingress | `nginx.conf` (compose), `provisioning/adapters.py` (+29: the same three `location` blocks), `tests/provisioning/test_adapters.py` (+11 assertions in an existing test) | `nginx.conf` identical. `adapters.py`: the carry hunk is those 29 lines; the file differs from main only by sprint-6's own changes |
| Tests | `tests/trip-mcp.test.js` (32 `it`), `tests/helpers/without-mcp-sdk.cjs`: identical. `tests/package.json` (appends `trip-mcp.test.js`). `tests/helpers/ports.js` (+4 keys, 38304–38307) | |
| Config/docs | `.env.example`, `mcp/README.md`, `docs/test-reports/regression-plan-2026-09-25-orlando-trip-mcp.md`: identical. `FRAMEWORK.md`: +10 on sprint-6's text | |

**Checked absent:** `control-plane/**` (so no `control-plane/api` and no
migration), `shared/**`, `mcp/*.js`, `profile-templates/`, `.agents/skills/`. A
path listing of `git diff --cached --stat` returns nothing under those roots.

**Changed since yesterday's candidate.** I compared the patch file by file with
the saved `carry-onto-sprint6-staged.patch`, index lines normalised. **Only
`tests/helpers/ports.js` differs.** Yesterday's *staged* hunk put `tripMcpEnabled`
on 38300, which collides with `mcpExtractEmpty`. Today's staged hunk uses
38304–38307. I searched the repo for those four numbers (all `*.js/ts/mjs/py/json`
outside `node_modules`) and they appear only in `ports.js`. Item 1 of yesterday's
plan is therefore **resolved**. `git status --porcelain --untracked-files=all`
shows **no unstaged or untracked path**, so the index is the whole carry. That
resolves yesterday's site/modern half as well.

**PR #199** (`origin/fix/114-return-leg-marker` = `c9b86ea`, the round-4 commit,
now pushed) touches 24 paths under `control-plane/api/**` plus the migration
`20260925180000_intake_pending_changes.sql`. That comes from
`git diff --stat HEAD...origin/fix/114-return-leg-marker`. It has **zero** paths
in common with the carry.

## 2. Risk table

| Change | Surface (§2 row) | Blast radius of *this merge* | Migration | Compatibility break | Risk | Test | Min | Batched? |
|---|---|---|---|---|---|---|---|---|
| Connector runtime (`server/trip-mcp`, `server.js` hook) | `server/` → a **release** → provision or redeploy | none in production. On Mac staging, none until a Mac trip is built from a sprint-6 release | none. The trip-SQLite `mcp_oauth_*` tables are created only when enabled | off unless `TRIP_MCP_ENABLED` ∈ {1,true} **and** `PUBLIC_ORIGIN` is a valid https origin **and** `JWT_SECRET` is non-default (off-loopback). No provisioning path sets the flag: I searched `provisioning/`, the worker and `create-trip` | low. Security path, reviewed on #220 (3 boundary rounds, carried from the #220 body, not re-verified) | `tests/trip-mcp.test.js`, 32 tests | ~1 | same run as the suite |
| Connector over sprint-6's #211 routes | trip runtime | same as above | none | Sprint-6 put `authRequired` on `/api/ratings`, `/api/comments/venue/:id`, `/api/rsvps/:id`, the three connector-called routes that #211 changed. The connector calls them with a person JWT (`index.js:321`). `authRequired` itself is unchanged between main and sprint-6. `publicUser()` ⊇ connector `PERSON_FIELDS` | low | pinned for `get_rsvps`, `get_venue_comments` (test l.288). **`get_ratings` is exercised by no test** | 0 | suite |
| Dependencies (+54 packages) | release payload → `npm install --production` on the trip | none now | – | lock root deps == `package.json` (parsed). 54 added, 0 removed, **0 version changes**, **0 new install scripts** (only pre-existing `better-sqlite3`). SDK `engines.node >=18`; new LXCs get Node 20 (`adapters.py:301`); CI uses 22 | low | `npm ci` in `server/` (CI does it) | 0 | suite |
| `site/modern` rebuilt | `trip-web` → tracked output → release | none now | – | renders `null` when `enabled:false` (`assistant-connect.tsx:47`). Silent if stale | low: **measured fresh** | `vite build --outDir <scratch>` from this tree, then `diff -rq` against staged `site/modern`: **identical** (2026-09-26, 0.68 s wall) | done | isolated check, done |
| `provisioning/adapters.py` nginx blocks | worker/provisioning | **new or half-built containers only**, created by a worker that loaded this file. See section 4 for Mac vs VM | – | Express 404s these paths when the flag is off. An existing, fully bootstrapped container is never rewritten (`engine.py:102`, `needs_bootstrap` → false) | low | `tests/provisioning`: 39 `def test_` (3+6+30). The carry adds assertions to an existing test, so the count stays 39 | ~0.5 | suite |
| `nginx.conf` (compose) | self-hosted compose deployments | none in this fleet (the LXCs use the adapter template) | – | same as above | low | none (a config file) | 0 | – |
| Pre-existing: `get_config` serves `participants[].age` (and family, family-visible needs); `get_lost_found` serves reporter `phone` | trip runtime | **Orlando now** (connector on, carried). Any trip that enables it later | – | contradicts decision 18.2 and `tools.js:22-25` | **decision (D1)**, security path | none. The test at l.288 checks two tools only | – | isolated: `boundary-reviewer` |

## 3. Migration and compatibility findings

- **Migrations: none.** No path under `control-plane/db/migrations/`, and nothing
  under `control-plane/` at all. The `migrations.test.ts` expected-list noise does
  **not** apply to this carry. It does apply to #199, which adds
  `20260925180000_intake_pending_changes.sql`.
- **Release seal.** There are new files under `server/` and `site/`, so any
  release built from sprint-6 after this commit gets a new `artifactDigest`. That
  is expected and loud, and nothing is built now. The same connector files already
  passed a release build and scan as `release_58b8e3b2…` (source `fbf3899`,
  `verified`). That is carried from the brief, not re-read.
- **Intake schema, `trip.config.json` producers, two-producer shapes:** untouched.
- **Allow-list.** `get_config` and the MCP server `instructions` read
  `sanitizeConfig()` → `shared/config-visibility.js`. `shared/` is identical on
  main and sprint-6 (0 differing paths, from `ls-tree`), so the connector serves
  the same config on either branch. That config includes `age: scalar` for
  participants (`config-visibility.js:187`). This is **D1**, not a compatibility
  break.
- **#211 interaction.** The connector is registered after `companion-control`,
  and sprint-6 has no catch-all ahead of it. The only `app.use` is `express.json`
  at l.28 and the error handler at l.4056. On the sprint-6 tree, the three #211
  routes the connector reads now require auth. The connector passes it by
  construction, because every call carries a 120-second person JWT. #211's
  `publicUser()` projection gives `username, name, name_en, color, avatar_file`.
  The connector's `person()` keeps `username, name, name_en, color`. So after
  #211, what the assistant receives from those routes is **the same** as without
  #211. #211 only narrows what the route itself returns. Orlando does not have
  #211 (decision 18.3), so there the connector's own `person()` does the
  stripping. The output is identical either way, for the two tools the test pins.
- **Doc claims on sprint-6 that the carry leaves incomplete** (yesterday's item 4,
  still owed, because the carry's `FRAMEWORK.md` hunk is unchanged since
  yesterday):
  - The "Guest endpoints (no login)" list omits `/.well-known/oauth-*`,
    `/oauth/register|authorize|token|revoke`, `POST /mcp` (a 401 challenge) and
    `GET /mcp` (an HTML explainer). These exist only when the flag is on.
  - "Rotating `JWT_SECRET` … logs every member out" is true, but it does **not**
    disconnect an assistant. MCP tokens are opaque, hashed and not derived from
    the secret. Revoke per grant; turning the flag off only leaves grants dormant.
- **Commit hook.** `scripts/preflight-checks.sh --staged` → **exit 0**, 1.5 s,
  2026-09-26. It printed three `warn` lines, all Hermes-profile drift that
  predates the carry.

## 4. Live-fleet impact

**Not re-read today.** The brief forbids SSH, so every row is carried from the
read-only reads of 2026-09-25 (the VM's Postgres in a read-only transaction,
CT101/CT104 via `pct exec`, the public hostname), as recorded in
`regression-plan-2026-09-25-orlando-trip-mcp.md` and yesterday's carry plan.

| Trip | State (09-25) | Running | Ends | What *this carry* does to it |
|---|---|---|---|---|
| `orlando-florida-2026` (CT101) | ready_private, **mid-trip** | main-built `fbf3899` code (`release_58b8e3b2…`, **verified, not available**); connector **on**, nginx hand-edited | 2026-10-01 | **nothing.** Its connector bytes are identical to the carry's |
| `japan-tokyo-hakone-kyoto-osaka-2026` (CT104) | ready_private, **mid-trip** | `8f4d4e1`, no connector, no nginx blocks | 2026-10-03 | nothing |
| 2 × `draft-sreq-…` | intake_in_progress | – | – | nothing. A confirmation today builds on the newest `available` release, `130924b` (no connector) |

**When the carry is felt, by whom:**

1. **Merge onto `integration/sprint-6`.** No production trip. The VM control
   plane was on `130924b` (09-25). **Mac staging:** the Mac worker bind-mounts
   `.claude/worktrees/sprint-6-integration` as `/repo`, with
   `PROVISIONER_COMPUTE_ENABLED=1` (read today by local `docker inspect`; started
   2026-09-20). `compute.py` imports `provisioning.adapters` at module load, so the
   running worker keeps the old template. Only after that worktree holds the
   commit **and** the worker restarts will Mac-created containers, on the shared
   Proxmox, get the three nginx blocks. With the flag off that is harmless.
2. **`integration/sprint-6` → `main`.** Still nobody.
3. **VM control-plane upgrade** (`kinerary-cp-release upgrade`) to a revision with
   this `adapters.py`. Containers **created** afterwards get the nginx blocks.
   Orlando and Japan do not: bootstrap runs only on create or on a half-built
   container.
4. **A release from that tree, promoted `verified → available`.** This is
   deploy-class and needs the person's approval. **New trips** built after it get
   the connector code **off**: no `.env` key, the card renders nothing, and
   `/api/mcp/connection` answers `{enabled:false}` to a signed-in user. They also
   get every other sprint-6 trip-runtime change (#211 and more), which needs its
   own plan. Promotion also changes what a `retryProvision` of any existing trip
   builds (the next point).
5. **Existing trips** get it only by a hand redeploy. The owner has ruled that
   out before 1 Oct (Orlando) and 3 Oct (Japan).

**`retryProvision` on Orlando: never, and the plan forbids it.** The control
plane records Orlando's plan on an older release. The newest `available` release
is `130924b`. A retry would rebuild Orlando on `130924b`, which removes the
connector code (grants go dormant in `trip.db`). It would also overwrite the
live config through `--sync-config`, re-run enrichment and flip lifecycle
mid-holiday. The mechanism was verified in code on 2026-09-25
(`planner.ts:108-119,166-172`, `provisioner.py:730-744`). If a sprint-6 release
were promoted while the trips are running, a retry would instead deliver #211 and
the rest of sprint-6 mid-trip, which is what decision 18.3 declined. Japan's
retry has the same shape.

## 5. The plan

**Run A: the gate for this merge. `verifier`, about 5 min. No production, no DB.**
Do not run two `tests/` suites on one host at once: the ports are fixed.

| # | Command (in the worktree) | Required result |
|---|---|---|
| A1 | `cd server && npm ci` | exits 0. It proves the lock installs as committed |
| A2 | `cd tests && npm test` | `# fail 0`, `# cancelled 0`. The spec output shows all five `trip MCP —` describe blocks with **32** passing tests. The total is HEAD's count + 32 (the brief says "600ish", which I have not measured; the verifier reports both numbers). **Expected noise:** the suite is flaky at concurrency 4. One red file → rerun the full suite, then run that file alone. Only a failure that survives isolation blocks. Never raise a timeout as the fix |
| A3 | `cd trip-web && npm test && npm run typecheck && npm run build && git status --porcelain -- ../site/modern` | all vitest files green, including `assistant-connect.test.tsx` (5) and `member-logins.test.tsx`. Typecheck clean. **The status output must be empty**: my scratch build already matched the staged bundle byte for byte, so any change here means the tree moved |
| A4 | `python3 -m unittest discover -s tests/provisioning` (the preflight venv, which has PyYAML) | **39/39** |
| A5 | `scripts/preflight-checks.sh --staged` | exit 0 (measured today: 0) |

Not needed for this merge: control-plane unit, DB, migration and worker suites.
None of their paths changed, and `compute.py`'s only link to the carry is a string
template that A4 covers.

**CI after the push.** The `Control plane` workflow runs on `integration/**`.
`Kinerary suite` and `Modern trip SPA` exercise the carry. An `EADDRINUSE` on a
38xxx port there is the **known open cause 2 of #223** (decision 15), not this
carry. The carry does add four more ports inside the Linux ephemeral range. Rerun
before triaging. CI does **not** check that `site/modern` is fresh: A3's last step
is the only check that does.

**Run B: `boundary-reviewer` on the sprint-6 tree. Required by decision 18; its own pass, not timed.**
Scope: the connector on top of #211 (the three routes above), and D1. This review
is recorded as a gate. The suite verdict does not replace it.

**Run C: later, at `integration/sprint-6` → `main`. `integrator`.**
Re-run `git merge-tree` on the real commits. Yesterday's prediction (before the
carry) named conflicts in `server/server.js`, `site/modern/index.html`,
`tests/{config-allow-list.test.js, helpers/ports.js, helpers/provisioned-config.py, package.json}`
and `control-plane/api/src/interview.ts`. #199 will add more there. The connector
hunks are identical on both sides. For `ports.js`, take sprint-6's values. For
`site/modern`, rebuild from the merge commit and delete main's orphaned
`index-DJTKQGoN.js`.

**Run D: the first redeploy of a sprint-6 release to Orlando (after 1 Oct). Its own plan.**
The connector rides that redeploy as checklist items:
- Discovery 200 with the same issuer.
- `POST /mcp` → 401 with the challenge.
- The count of unrevoked `mcp_oauth_grants`, before and after (count only).
- One read tool call.

#211 and any D1 fix are security paths and are isolated from that run.

## 6. Budget

| Tier | Contents | Minutes | Buys |
|---|---|---|---|
| **Minimum gate for the merge** | Run A | ~5. The tests suite took 55.8 s at 533 tests (2026-09-25); A2–A4 are otherwise estimates; the build took 0.68 s (2026-09-26) | the carry lands verified, bundle proven fresh |
| Recorded gate (decision 18) | Run B | its own pass | the gate the owner wrote down |
| + `get_ratings`/`get_config`/`get_lost_found` in the l.288 test | developer | ~10 (estimate) | turns D1 from "read in the code" into a red or green test, and covers the one #211 route no test calls |
| + D1 fix, if the owner picks (b) | `tools.js` + test + `boundary-reviewer` | ~20 dev + review (estimate) | code matches decision 18.2. Reaches Orlando only by a redeploy after 1 Oct |
| + FRAMEWORK lines | `doc-keeper` | ~5 | the guest-route and JWT-rotation claims become true |
| Not recommended | 80-min e2e, `preflight-deploy.sh --deploy` | – | interview, planner and worker are untouched |

## 7. Go / no-go and the way back

**No-go for the merge if:**
- A2 has a failure that survives rerun and isolation;
- any `trip-mcp.test.js` test is absent from the output (it was not listed or did not load);
- A3 changes `site/modern`;
- A4 is not 39/39;
- A1 fails;
- `git status` shows anything other than the staged set plus this plan.

**Way back:** `git revert` of the carry commit on `integration/sprint-6`. Nothing
is deployed, there is no data and no migration, so no snapshot is needed.

**The one-way doors are later, and outside this plan:**
- Promotion to `available`: it reaches every new trip, and it retargets retries.
- A VM upgrade: it changes new containers' nginx.

Each needs the person's approval. Neither should happen while Orlando or Japan
is running.

## 8. What would reduce the risk

Ranked by risk removed per minute.

1. **Keep `retryProvision` away from Orlando and Japan until they end. 0 min.**
   Say it to whoever holds the owner login. A retry is the one action that reaches
   a live trip from this line of work, and today it would downgrade Orlando.
2. **Hold promotion of any release containing this carry until after 3 Oct, or
   state in writing that retries are frozen. 0 min.**
3. **Extend the l.288 test to `get_config`, `get_lost_found` and `get_ratings`
   before Run B. ~10 min.** Today the test's title promises "never a Telegram id,
   age or email", but it checks two of the seven read tools. The extension either
   pins D1 as accepted behaviour or turns it red. Either result gives the reviewer
   evidence instead of a code reading.
4. **Answer D1. 0 min for the decision.** Then either correct the `tools.js:22-25`
   comment and #220's claim, or strip `age` (and `phone`) in `tools.js`.
5. **Hand the two FRAMEWORK lines to `doc-keeper`. ~5 min.**

Nothing else. The carry is byte-identical to reviewed code that is already
running, and the bundle is proven fresh.

## 9. Decisions needed

- **D1 (Dror, with `boundary-reviewer`).** Decision 18.2 says a member's assistant
  sees what the site shows that member, "only Telegram id, age and email of others
  are stripped". The code gives every connected assistant `participants[].age`
  through `get_config`: `tools.js:57-59` returns `/api/config` as is, and the
  allow-list names `age`. It also gives `get_lost_found`'s reporter `phone`. This
  is live on Orlando.
  - (a) Accept, and correct the decision text, the `tools.js` comment and #220's
    claim.
  - (b) Strip it in `tools.js`; it reaches Orlando only at its post-trip redeploy.

  **Unchecked:** whether Orlando's live config has `participants[].age` values.
  The 2026-09-25 path projection recorded Orlando's top-level keys and a leaf
  count (72), not the participant leaves. A path-only probe would settle it.
- **D2.** Apply the two FRAMEWORK lines in this carry or in the post-merge sweep?
- **D3.** Decision 18 orders this carry *after* #199. It is landing before.
  Technically this is independent: there are no shared paths, and #199's
  verification will simply run on a tree that includes the carry. Confirm the
  reorder, so the recorded decision and the branch history agree.
- **Carried, not verified today:**
  - Orlando's and Japan's state, release and dates;
  - `release_58b8e3b2…` being `verified` and not `available`;
  - `130924b` being the newest `available`;
  - the VM control plane being on `130924b`;
  - VM provisioning being on.

  All were read on 2026-09-25 and none is re-read here, because this run has no
  SSH. Re-read them before any promotion or deploy.
