# Regression and rollout plan: allow-list (#172 port) + organizer MCP connector onto `orlando-florida-2026` only

**Verdict.** Do not use a release window with a provision retry. Use a sealed tree
with a targeted deploy (option C below). Build and verify a release from the merged
commit, but never promote it to `available`. Materialize that exact tree on the VM.
Push it to Orlando alone with `/opt/kinerary-deploy/deploy.sh`, without
`--sync-config`, and with B switched off. Once that has soaked, switch B on in a
separate step.

**Read this first: Orlando is mid-trip.** Its `meta.departure` is 2026-09-23 and its
`meta.returnDate` is 2026-10-01, read off CT101 today. That makes today day 3 of 8
of a real family holiday. A (the allow-list) changes **nothing** Orlando serves
today. I proved this byte for byte (section 3). So the only reason to touch Orlando
before 1 October is B, and only if the organizer actually wants to connect an
assistant during the trip. That is decision D1.

Scope: two uncommitted change sets, both on `e84fd7f` (which is also `origin/main`
today). Assessed 2026-09-25 by `regression-planner`. I ran read-only probes on the
VM, on CT101, CT104 and CT120 (through Proxmox `pct exec`), and on the public
hostname. The one extra request I made was an unauthenticated GET that NPM refused
(section 4). I ran one suite on a scratch A+B tree outside the repo. I deployed
nothing, wrote nothing to production, and edited no code.

---

## 8 → first: What would reduce the risk

Ranked by how much risk each item removes per minute spent.

1. **Decide D1 (wait until after 1 October, or go now), 0 min.** A is a no-op for
   Orlando's data today, so waiting costs Orlando nothing on security. Going now
   restarts a site under a family on holiday, and the timing is for B alone.
2. **Before any `.env` step, back up the container's `.env` and guard `sync-env.sh`,
   5 min.** `sync-env.sh` fails open. It runs
   `REMOTE_ENV=$(pmx "pct exec … cat .env" || true)`. If that read fails, it writes a
   `.env` that holds **only** the keys in `trip.env`. `JWT_SECRET`, `TRIP_DIR` and
   `HERMES_API_KEY` would be gone. The site would then boot on the public default JWT
   secret, the site would have no config, and the companion bridge would be locked
   out. The fix in `kinerary-deploy` is one line: refuse when `REMOTE_ENV` is empty
   or lacks `TRIP_DIR=`. At minimum, run `cp -p .env .env.pre-mcp-20260925` first and
   count the keys afterwards.
3. **Capture the baseline fingerprints immediately before the deploy and diff them
   right after, 3 min.** The served `/api/config` must hash the same before and
   after: `dec1ef5b1f6e4bcd` today, 4353 bytes. This one assertion turns A's silent
   failure mode (a field quietly missing) into a loud one. Script and values are in
   section 5, run 3.
4. **Write two cheap tests before merging B, about 20 min developer time.** The
   first proves that with a non-loopback `PUBLIC_ORIGIN` and the built-in JWT secret,
   `/.well-known/oauth-authorization-server` returns 404 and the boot log says
   `not enabled`. The second proves the site still boots with trip-mcp off when
   `@modelcontextprotocol/sdk` is missing. `tests/trip-mcp.test.js` tests neither: it
   only runs with a loopback `PUBLIC_ORIGIN` (line 76). Both are the guards that make
   "B is safe on a live trip" true.
5. **Promote the verified release to `available` after the Orlando soak, not
   never.** Until you do, the control plane still records Orlando on `cea047d`. A
   `retryProvision` on Orlando would then **downgrade** it to `130924b`. That would
   remove trip-mcp, and `--sync-config` would overwrite its live config. Promotion
   closes that gap and gives new trips A. Section 4 covers who it touches.
6. **Count Orlando's seeded bookings immediately before the restart, 1 min.** Every
   boot re-inserts `bookings.json` seeds with `INSERT OR IGNORE`
   (`server/server.js:652-673`). A seed booking the family deleted comes back on
   restart. Today 3 of 3 seeds are present, so the restart would resurrect nothing.
   Re-check this, because the family can delete one at any time.

Not worth it: the ~80-minute end-to-end walk. Neither change touches the interview,
the planner, the worker or companion rendering. B's `provisioning/adapters.py`
reaches only containers **created** after a VM upgrade (section 4), and that upgrade
is not in this plan.

---

## 1. Change set

| Id | Branch / worktree | Files | State |
|---|---|---|---|
| **A** | `fix/172-allow-list-main`, `.claude/worktrees/allow-list-main` | `server/server.js`, `server/living-journey.js`, `shared/agent-schema.js`, **new** `shared/allow-list.js` and `shared/config-visibility.js`, `tests/config-allow-list.test.js`, `tests/helpers/provisioned-config.py`, `tests/helpers/ports.js`, `tests/package.json` | Staged, plus 2 unstaged test edits. Uncommitted. The four `shared/` and `living-journey.js` files are byte-identical to `integration/sprint-6` HEAD's #172 (sha256 compared today). |
| **B** | `feat/trip-site-mcp`, `.claude/worktrees/trip-site-mcp` | **new** `server/trip-mcp/{index,oauth,tools,authorize-page}.js`, `server/server.js` (+16, a `try/catch` require), `server/package.json` + lock (+54 packages, 0 changed versions, 0 install scripts, SDK 1.30.1 `node>=18`, zod 3.25.76), `trip-web/src/assistant-connect.tsx` + `App.tsx` + `styles.css`, rebuilt `site/modern` (new asset names), `provisioning/adapters.py`, `nginx.conf`, `.env.example`, docs, tests | Uncommitted |
| **R** (ride-along) | already on `main`: `6f6b9d9` "align Journey, Today and weather with trip dates" (2026-09-21) | `server/living-journey.js` (`buildTodayContext`), `site/modern` bundle, `trip-web` | Not in either brief. It ships to Orlando anyway, because Orlando runs `cea047d` and this is the **only** payload-root commit in `cea047d..e84fd7f` (`git log -- server site shared trip-web`). `130924b` and `e84fd7f` have identical payload roots. |

A+B merge: B's patch applied on A in a scratch tree, and only `tests/package.json`
was rejected (the known conflict). Resolved by listing both test files.

<details><summary>Brief claims, checked</summary>

| Claim (source: brief) | Status |
|---|---|
| Orlando `ready_private`, provisioned 2026-09-23 from `cea047d` | **Verified.** The plan row is `provision/executed/cea047d`. The running files are identical to `git show cea047d:` for `server.js`, `package.json`, the lock and `site/modern/index.html` (sha256). The service started `2026-09-23 17:40:43 UTC` and has not restarted since. |
| The other live trip is `japan-tokyo-hakone-kyoto-osaka-2026` | **Verified.** CT104, release `8f4d4e1` (older than `cea047d`). Dates 2026-09-18 to 2026-10-03, so it is **also mid-trip**. |
| The newest `available` release is `130924b` | **Verified.** `release_ad97b4bd…`. All 8 listed releases are `available`. |
| Only plan kind `provision` exists; selection is global | **Verified.** `planner.ts:166,172` insert only `provision`. The selection SQL is `status='available' … ORDER BY created_at DESC LIMIT 1` (`planner.ts:108-119`). |
| retryProvision rebuilds the config, runs `--sync-config --restart`, and re-runs companion setup | **Verified**, and it is worse than stated. The retry route needs the **trip owner's** web login (`app.ts:756-783`). The new plan starts `pending_approval` with its job in `waiting_for_user_action` (`planner.ts:166-172`). Lifecycle reverts to `intake_confirmed`. `transform_intake` and live enrichment run again (`provisioner.py:730-744`). The companion is re-attached. |
| CT101's nginx is written at bootstrap only; it 404s `/mcp`, `/oauth/*`, `/.well-known/*` | **Verified.** Bootstrap runs only on container create (`compute.py` → `apply`). Local probe today: 404 from nginx on :8080 and 404 from Express on :3000 for all of them. |
| `.env` is written once; `sync-env.sh` merges | **Verified** (`[ ! -f .env ]` guard in `adapters.py`). The merge is real, but fails open (item 2 above). |
| `deploy.sh` runs `npm install --production` | **Verified.** It also overwrites `bookings.json`, `trivia_questions.json` and `control-plane.identity.json` from the trip dir it is given. The VM copies are identical to CT101's today (sha256). |
| Suites: A 508/508; B tests 508, trip-web 143, provisioning 36 | **Carried, not re-run.** I re-ran the **merged** A+B trip-site suite myself (section 6). |
</details>

---

## 2. Risk table

| Change | Surface (row) | Blast radius | Migration | Compat break | Risk | Test | Min | Batched? |
|---|---|---|---|---|---|---|---|---|
| A: `sanitizeConfig` becomes an allow-list | `server/`, `shared/` → trip runtime, a **release** | Orlando only (targeted deploy) | none | A field Orlando needs could vanish. **Measured: none does** (section 3) | Security path: high rank, low measured impact | Byte-identical `/api/config` + roster hash before and after; boot log has no `not on the served allow-list` line; `boundary-reviewer` | 3 | Rides the one deploy. The observable is a hash, distinct from B's |
| A: `living-journey` day context / `/api/hermes/status` `profile` dropped / `/api/today` `time_zone` canonicalised | trip runtime | Orlando | none | `identity.profile` has no reader (grep of trip-web, site, mcp, scripts). The time zone is unchanged on both trips (checked) | low | same fingerprints | 0 | batched |
| R: `buildTodayContext` date range | trip runtime | Orlando members' Today/Journey | none | **Expected visible change:** `/api/today.first_date` goes from `"2026-09-23T00:00:00+00:00"` to `null`. `phase` stays `active_day` | low | `/api/today` field diff (run 3) | 1 | batched, with a named expected delta |
| B code, **off** | trip runtime | Orlando | trip SQLite tables are created only when **on** | New route `GET /api/mcp/connection`: 401 unauthenticated, `{enabled:false}` for the organizer | low | `/mcp` still 404; `/api/mcp/connection` becomes 401 (404 today) | 2 | batched |
| B deps (+54 packages) | `npm install` on CT101 | Orlando | – | Needs registry access from CT101. A failed install leaves new files on disk with the old process still running; a later reboot boots with trip-mcp off (the `try/catch`) | low-med | deploy.sh exit status; `ls node_modules/@modelcontextprotocol/sdk` | 1 | batched |
| B **on** (`.env` + nginx) | CT101 `.env`, nginx | Orlando's public hostname gets a new unauthenticated surface: registration, the authorize page, token | adds 4 `mcp_oauth_*` tables to the trip DB on NFS (additive) | Consent needs the organizer's **password** on the direct hostname. `GOOGLE_CLIENT_ID` is absent from CT101's `.env` | **Security path** | `boundary-reviewer` + the section 5 run-5 probes + a real connection | 40 + organizer | **isolated**, a separate step after the soak |
| B `provisioning/adapters.py` | worker/provisioning, via a VM redeploy | new containers only | – | none | – | provisioning 36 (carried) | 0 | **out of scope.** Rides a future `kinerary-cp-release upgrade` |

---

## 3. Migration and compatibility findings

**No control-plane migration.** No file under `control-plane/db/migrations/` changes.

**A against Orlando's real config.** I streamed Orlando's live `trip.config.json` from
CT101 into a local process that printed **paths only**. That process ran A's
`projectConfig`. It also ran `cea047d`'s `sanitizeConfig`, rebuilt from `git show`,
and compared the two outputs path by path.

- Orlando: **0 dropped, 0 withheld**, and old output == new output (`IDENTICAL`).
  There are 72 leaf paths. Top-level keys: `agent`, `families`, `map`, `meta`,
  `participants`, `phases` (accommodation, hero, mapStop, note, tabLabel, title,
  venues[] — **no `days`, `dates`, `start` or `end`**), `stats`, `theme`.
- Japan (CT104, for reference only): 0 dropped; `agent.standing_instructions[]` ×2
  withheld. Old output == new output, so the old code withheld the same two.
- Orlando's config sha256 `f3dd2e4f…` is identical on CT101 and in
  `/opt/kinerary-deploy/trips/orlando-florida-2026/`. **Nobody has added
  participants at runtime yet.** Re-check this before deploying: if it has changed,
  run the path projection again.
- Orlando's active itinerary has 0 days and 0 items. A's changes to
  `promoteConfigDays` and `rowsFromConfig` therefore have nothing to act on.

**Release seal.** B adds files under `server/` and `site/`, so the merged commit
needs a new release. Build it (`npm run release -- build --ref <M>`) and promote it
to `verified` only. `verified` reaches nobody. It gives you the sanitation scan and
the artifact digest that Orlando's tree gets checked against.

**Intake schema / `trip.config.json` producers:** unchanged. **Two producers**
(`planned` vs `venues`) are not affected: Orlando's config is the agentless worker's
output, with `venues[]` present.

**The ride-along's delta**, measured. Today `/api/today` on CT101 returns
`time_zone "UTC"`, `phase "active_day"`, `first_date "2026-09-23T00:00:00+00:00"`,
`last_date null`. After R: `first_date null`. The malformed departure fails
`ISO_DATE_RE`, and there are no phase dates or itinerary rows. `phase` stays
`active_day`.
*Out of scope, filed here so it is not lost:* Orlando's clock runs in **UTC**.
`tripTimeZone()` reads `meta.timezone`, `timezone` and `phases[].timezone`, never
`agent.timezone`, which is the only one Orlando has. Also, `meta.departure` is a
datetime and not a date. Neither change is caused by A, B or R.

---

## 4. Live-fleet impact

Fleet read on 2026-09-25 from the VM's Postgres, in a read-only transaction:

| Trip | State | Release | CT | Dates | This plan |
|---|---|---|---|---|---|
| `orlando-florida-2026` | ready_private | `cea047d` | 101, `192.168.0.97` | 09-23 → 10-01 (**running**) | target |
| `japan-tokyo-hakone-kyoto-osaka-2026` | ready_private | `8f4d4e1` | 104 | 09-18 → 10-03 (**running**) | **untouched**. Nothing needs to change there |
| `draft-sreq-96330a34…`, `draft-sreq-a468f035…` | intake_in_progress, sessions `interviewing` (idle since 09-23) | – | – | – | Would build on whatever is newest `available` **if confirmed during an availability window**. VM provisioning is **on**: `vm.env` sets all three `PROVISIONER_*` flags to 1 (read today) |

**The options, compared** (question 1 of the brief):

| | (a) release → available → retry Orlando → deprecate | (b) deploy.sh with `REPO_ROOT` = an ad-hoc checkout, no `--sync-config` | **(c) recommended:** release built → `verified` only; materialize that tree; deploy.sh without `--sync-config` |
|---|---|---|---|
| Orlando's live config | **Overwritten.** Rebuilt from the intake by today's worker, with enrichment re-run live | preserved (excluded) | preserved (excluded) |
| Orlando's runtime data (trip.db on NFS) | preserved (`first_provision=false`) | preserved | preserved |
| Other effects on Orlando | Lifecycle flips to `intake_confirmed` and back; companion re-attached; needs the **owner's** login and plan approval mid-holiday; nginx **still** not rewritten (bootstrap runs only on create) | none beyond the deploy | none beyond the deploy |
| Other trips | Any retry during the window builds on it | none | none |
| New signups | **Any confirmation during the window** (2 sessions open) gets it | none | none until you choose to promote |
| Provenance of the bytes | sealed, digest-verified | whatever that directory held | **sealed and scanned**. Check `tree_digest(M)` == the release's `artifact_digest` before deploying |
| Control-plane record | accurate | drifts (plan says `cea047d`) | drifts until promotion (item 5 at the top) |

**Who feels (c), and when.** Orlando's members and its companion, once, for the few
seconds of a service restart. `deploy.sh` sleeps 3 s before its health check. SSE
streams reconnect. The companion's trip-mcp bridge (VM `hermes` container, `:3101`,
`API_BASE_URL` = the LAN address, **not** the public hostname) sees errors for those
seconds. Its `/health` answered `{"ok":true,"site":"reachable"}` today. The static
bundle changes the moment the tar lands, before `npm install` finishes. For that
window the new bundle talks to the old server: the connector card gets a 404 and
renders nothing. That is harmless.

**Ingress, for B (question 3).** The public path is Cloudflare → cloudflared (CT120)
→ NPM proxy host `92.conf` (`server_name orlando-florida-2026.ara-united.store`) →
`192.168.0.97:8080`. Neither `92.conf` nor `proxy.conf` sets `X-Forwarded-Prefix`
(both read today). The runtime gateway does set it
(`control-plane/runtime-gateway/server.js:147`), and B refuses such requests. So:
**`PUBLIC_ORIGIN=https://orlando-florida-2026.ara-united.store`**, the host named by
`topology.yaml` (npm and cloudflare), `92.conf` and a live `200` on `/api/health`
(`x-served-by` = NPM, `cf-cache-status: DYNAMIC`).
`/.well-known/oauth-authorization-server` and `/mcp` return 404 **from origin**
today. There is no `cf-mitigated` header, so Cloudflare is not challenging them.

**NPM "Block Exploits" is on for this host**, and one of its rules bites.
`if ($query_string ~ "[a-zA-Z0-9_]=http://") return 403`. I confirmed it today:
`/oauth/authorize?redirect_uri=http://localhost:1/cb` → **403**, and it is in
`proxy-host-92_access.log` at 17:30:54Z. The URL-encoded form → 404 (origin), and a
raw `https://` value → 404 (origin). Claude and ChatGPT use https callbacks, so they
are unaffected. A loopback client (Claude Code, MCP Inspector) works only if it
URL-encodes. The POST bodies of `/oauth/token` and `/oauth/register` are not
inspected. I have not checked whether Cloudflare bot rules block the assistants'
servers, because that needs dashboard or API access. The real connection in run 6
is the test: if it fails, look in `proxy-host-92_access.log` for requests that never
arrived.

**Other trips and new trips (question 5).** Nothing must change for Japan. New trips
are unaffected until the release is promoted. After promotion they get A+B with B
off. To enable B on a new trip still takes a hand `.env` edit and, until the VM
control plane is upgraded to a revision containing B's `adapters.py`, a hand nginx
edit too.

---

## 5. The plan

Every write step below is a deploy, so hard rule 2 applies. The lead session runs it
after Dror approves. Run it in Orlando's local night: 06:00–09:00 UTC is 02:00–05:00
EDT. The UTC-4 offset is my assumption for Orlando in late September.

**Run 0: merge gate (Mac, no production). Dror + `boundary-reviewer` + verifier.**
- PR for A to `main`, then PR for B to `main`, resolving `tests/package.json`
  (both files). `boundary-reviewer` on **both**: A is `sanitizeConfig`, B is an
  OAuth authorization server with organizer-only consent. Add the two tests from
  item 4 at the top.
- On merge commit `M`: `cd tests && npm test` (merged scratch tree: **533/533,
  55.8 s**, measured today). `trip-web` and `tests/provisioning` suites (claims
  carried: 143 and 36). Confirm `site/modern` equals a fresh `trip-web` build of `M`.
- Cost: suites about 5 min. Reviewer: its own pass, not measured.

**Run 1: seal (VM, no trip touched). Dror, about 10 min, estimated.**
1. `git -C /opt/kinerary fetch` so `M` is reachable. This does not move HEAD: the
   control plane stays on `130924b`. Verify with `git -C /opt/kinerary log -1`
   afterwards.
2. `npm run release -- build --ref M` → `promote <id> --to verified`. **Never
   `--to available` in this run.**
3. Materialize: `git -C /opt/kinerary archive M site server shared | tar -x -C <dir>`
   (the same thing `release_source.materialize_release_source` does). Check
   `tree_digest(/opt/kinerary, M)` equals the release's `artifact_digest`.

**Run 2: preflight on Orlando (read-only). About 3 min, measured, since these probes ran today.**
- Service active; no deploy or job in flight (`control_plane.jobs` latest is
  `succeeded`, as it was today).
- Config sha is still `f3dd2e4f…`. If it has changed, re-run the path projection
  (section 3) before going on.
- Seed bookings missing from the DB = 0 (item 6 at the top).
- Baseline fingerprints: the `fp.sh` pattern (agent key read inside the container
  and fed to `curl --config -`; only status + sha + bytes printed):
  | route | today (2026-09-25 ~17:30Z) |
  |---|---|
  | `/api/config` | 200 `dec1ef5b1f6e4bcd` 4353 B |
  | `/api/config/roster` | 200 `f90250dc4238ab13` 359 B |
  | `/api/itinerary/active` | 200 `95bfa9727a5d1282` 141 B |
  | `/api/config/warnings` | 200 `4f53cda18c2baa0c` 2 B (`[]`) |
- Bridge `/health` → `{"ok":true,"site":"reachable"}`.

**Run 3: deploy A+B+R with B off. Dror present, 5–8 min, estimated. Downtime: seconds.**
1. Backups on CT101 (writes, all part of the approved deploy). Tar
   `/opt/kinerary/{server,site,shared}` excluding `node_modules` to
   `/root/pre-ab-20260925.tgz`. `cp -p /opt/kinerary/.env /opt/kinerary/.env.pre-ab-20260925`.
   Make a `better-sqlite3` `db.backup()` of `trip.db` next to itself on NFS.
2. `sudo env REPO_ROOT=<dir> /opt/kinerary-deploy/deploy.sh orlando-florida-2026 101 --restart --trip-dir /opt/kinerary-deploy/trips/orlando-florida-2026`
   **with no `--sync-config`.** The VM's `deploy.sh` is byte-identical to the Mac's
   (sha256 `b36ba255…`), and root's Proxmox key is at `/root/.ssh/`.
3. Checklist, with which change each item proves:
   - [A] `/api/config`, roster, itinerary and warnings: **same hashes as run 2.**
     Any difference means stop and roll back.
   - [A] `journalctl -u kinerary-server` since restart has **no**
     `not on the served allow-list` line.
   - [R] `/api/today`: `first_date` is now `null`, `phase` is `active_day`. Nothing
     else changed in the picked fields.
   - [B-off] `/mcp`, `/.well-known/oauth-authorization-server` → 404;
     `/api/mcp/connection` unauthenticated → **401** (it was 404). No
     `[trip-mcp] failed to start` line.
   - [deps] `node_modules/@modelcontextprotocol/sdk` is present.
   - Bridge `/health` ok. Public `/api/health` 200.
   - [human] The organizer or a member opens the site from the direct hostname
     **and** through the gateway, and sees Today and a phase. That is the only check
     here that a browser is needed for.
4. Soak at least 12–24 h (calendar time, no effort). Watch the journal for errors.

**Run 4: nginx for B (still off). Dror, about 10 min.**
- Back up `/etc/nginx/sites-available/kinerary` to `/root/`, **not** into
  `sites-available/`. Insert B's three blocks from `provisioning/adapters.py`
  (`location = /mcp`, `^~ /oauth/`, `^~ /.well-known/oauth-`, all
  `proxy_pass http://127.0.0.1:3000`, with the `/mcp` block unbuffered at
  `client_max_body_size 5m` and `/oauth/` at 64k) after `location ^~ /api/`.
  `nginx -t` then `systemctl reload nginx` (a graceful reload).
- Check: `/mcp` now returns Express's 404, not nginx's HTML 404. `/api/health`
  still 200. Fingerprints unchanged.

**Run 5: switch B on. Dror, about 15 min. Security path.**
1. `.env` backup again. Create `/opt/kinerary-deploy/trips/orlando-florida-2026/trip.env`
   holding exactly `TRIP_MCP_ENABLED=1` and
   `PUBLIC_ORIGIN=https://orlando-florida-2026.ara-united.store`
   (`deploy.sh` excludes `trip.env`). Then
   `sudo /opt/kinerary-deploy/sync-env.sh 101 --trip-dir … --restart`.
   **Afterwards, check that the key count is 10** (8 today plus 2) and that
   `JWT_SECRET` is still non-default. Today: 0 default matches, 1 line of 20+
   characters.
2. Checklist:
   - Journal: `[trip-mcp] enabled at https://orlando-florida-2026.ara-united.store/mcp`.
   - Public `GET /.well-known/oauth-authorization-server` → 200, `issuer` equals
     `PUBLIC_ORIGIN`. `…/oauth-protected-resource/mcp` → 200.
   - Public unauthenticated `POST /mcp` → 401 with
     `WWW-Authenticate: Bearer resource_metadata="…/.well-known/oauth-protected-resource/mcp"`.
   - The same metadata path through the gateway (`/t/<trip>/…`) → 404.
   - Run 2's fingerprints are unchanged; A and B do not touch them.

**Run 6: acceptance. The organizer (or whoever D2 names) plus Dror, about 15 min.**
- In Claude, add the custom connector `https://orlando-florida-2026.ara-united.store/mcp`,
  sign in on the consent page with the **site password**, allow, then make one
  **read** tool call.
- The organizer's "More" screen lists the connection. Disconnect it and confirm
  the next call gets a 401. Reconnect if they want to keep it.
- Non-deterministic: an assistant is in the loop. One successful read call proves
  the plumbing and not the tools. The tools' behaviour is covered by
  `trip-mcp.test.js`.

---

## 6. Budget

| Tier | Contents | Minutes | What it buys |
|---|---|---|---|
| **Minimum gate for the code deploy** | Run 0 (suites about 5 min + boundary review) + runs 1–3 | about 30 min with Dror present, plus the reviewer | A+B on Orlando, B off, with byte-level proof that members see the same data |
| + soak | 12–24 h calendar | 0 effort | Catches a boot-time or journal error before you add surface |
| + enable B | Runs 4–6 | about 40 min, plus the organizer for 15 | The connector live, proven through the real ingress path |
| Not recommended | 80-min e2e / `preflight-deploy.sh --deploy` | – | Tests provisioning and the interview, which this change does not touch |

Measured on 2026-09-25 on the Mac: the merged trip-site suite, **533/533, 55.8 s wall**.
My first attempt reported 9 failures. That was my scratch tree's fault: I had not
installed `mcp/` dependencies, and a server I had orphaned held port 38296.
`control-plane-session.test.js` run alone passed 8/8, and so did the full rerun. All
other durations in this plan are labelled estimates.

---

## 7. Go / no-go and the way back

**Stop before the deploy if any of these hold:**
- the config sha has changed and the new projection drops anything;
- any seed booking is missing from the DB (a restart would resurrect it);
- a provision job is in flight;
- the bridge `/health` is not ok beforehand (so you are not blamed for an existing fault);
- `tree_digest(M)` does not equal the release digest.

**Roll back after the deploy if any of these hold:**
- any fingerprint differs;
- an allow-list warning appears in the journal;
- the health check fails (deploy.sh exits 1 on that by itself);
- the members' check in run 3 fails.

| Step | Way back | Time (est.) |
|---|---|---|
| Code (run 3) | `tar -xzf /root/pre-ab-20260925.tgz -C /opt/kinerary && systemctl restart kinerary-server`. The files it leaves behind (`server/trip-mcp/`, `shared/allow-list.js`, `shared/config-visibility.js`, the new `site/modern/assets/*`, extra `node_modules`) are never loaded by `cea047d`'s `server.js` or `index.html`. The alternative is the same `deploy.sh` with `REPO_ROOT` = the `cea047d` archive (`release_276dcf8b…`). | 1–2 min |
| nginx (run 4) | Restore the `/root/` backup, `nginx -t`, reload | 1 min |
| `.env` (run 5) | Restore `.env.pre-…` and restart. **`sync-env.sh` cannot switch B off**: it skips empty values. | 1 min |
| Connections | If an incident involved a connection, revoke it from the organizer's screen **before** turning B off. The grants stay in `mcp_oauth_*` and would work again if B were re-enabled. | 1 min |
| Data | A writes nothing new. B's tables are additive. `trip.db` backup from run 3 as a last resort. No control-plane migration, so no VM snapshot is needed. | – |

---

## 9. Decisions needed

- **D1. Now or after 1 October?** Orlando is on day 3 of 8. A buys Orlando nothing
  today (identical output). Only B motivates doing it mid-trip. Recommendation: go
  now **only** if the organizer asked for the connector.
- **D2. Who connects, and with what login?** Orlando has exactly 1 organizer, who is
  in `participants` and `users` (counted, names not read). CT101 has **no
  `GOOGLE_CLIENT_ID`**, so consent is password-only. The site's users were seeded
  with `SEED_PASSWORD`. I cannot tell whether the organizer knows a password for the
  direct hostname, because I did not read hashes. Ask them.
- **D3. Promote the verified release to `available` after the soak?**
  Recommendation: yes. It closes the downgrade-on-retry gap and gives new trips A
  (with B off). Do it when neither `interviewing` session is about to confirm, or
  accept that they get it.
- **D4. Fix `sync-env.sh` failing open (in `kinerary-deploy`) before run 5, or rely
  on the manual backup and key count?**
- **D5.** The control-plane record will say `cea047d` for Orlando until D3. Does
  anything, including the `trip-monitor`, need a note? I did not check whether the
  fleet monitor compares running code with the plan's release.
- **Unchecked:** Cloudflare bot and WAF settings for the assistants' servers
  (needs dashboard or API); the trip-web 143 and provisioning 36 counts on `M`
  (carried from the brief).
