# Regression plan addendum: Saturday 3 Oct 2026 — the Hermes image rebuild and the fleet monitor's move to the VM

Assessed 2026-09-28 by `regression-planner` (local branch mode), with read-only production probes 07:50-08:40Z
(SSH as the operator user, SQL inside `BEGIN READ ONLY ... ROLLBACK`, file names and state only; no key, token,
chat id or message text was printed; the monitor bot was identified with `getMe`, token over stdin). Nothing was
restarted, built, edited or committed. Extends `regression-plan-2026-09-26-release-a-sprint-mode.md` (gates G1-G9,
U8). **The release-line head `D` does not exist yet: replace `D` below with its SHA when it does, before the deploy
prompt is answered** (the prompt only reads back a plan for the exact HEAD being deployed).

**Verdict: CONDITIONAL GO, and split the day.** Morning: Release A to the release-line head, code only, G1-G9
unchanged. Saturday evening after the Japan trip ends: `upgrade D --hermes-rev ab0d98414-p1a908d70` (the tool
never builds the image; it recreates Hermes), then, as a separate step, the monitor move. A combined morning
session is acceptable under section 7.

## 1. Change set: what the release line contains

Line: `a744c28` -> `8e1fbd6` (PR #293, the `postgresql-client` patch 0003 + `hermes-image-check.sh` psql probe +
tests) -> `D` (PR #298, the digest re-layout: `fleet-mcp.mjs --format digest`, `kinerary_fleet_digest.sh`,
`bootstrap-fleet-monitor.sh` setting `cron.wrap_response false`, tests). `origin/release/a` was still `a744c28` at
08:40Z. **In the line:** #241, #245, #258, #272, and **PR #182** (the first half of #119: a failed bridge run is
recorded as a reachability fact). **Not in it:** #270, #274, #275, #276, #280, #285, #286, **#290**, #116,
**#297** (the bridge probe). Consequence: after Release A the worker can mark a newly built trip
`TRIP_MCP_BRIDGE_FAILED`, and the release-line relay and the installed tool then skip that trip's companion. Both
live trips are `reachable`, so neither is exposed.

**D is not a clean cherry-pick.** #298 conflicts with the line in `cron/kinerary_fleet_digest.sh` because #270 is
not on it (every other file merges). Resolve by taking #298's version of that file whole; pass condition:
`git diff pr/298 D -- .agents/skills/trip-fleet-monitor scripts/bootstrap-fleet-monitor.sh tests/scripts/test_fleet_*.py`
is empty. A resolved conflict is not proven by a clean merge: integrator path.

## 2. Findings that change the existing plan

1. **Hermes is no longer "untouched".** A Hermes recreate is not queued at Telegram: for about 16 s (measured on
   the 09-18 recreate) an addressed message gets the generic "unavailable" line and the turn is lost; an in-flight
   companion turn is killed (Docker's default 10 s stop grace; measured turns take 20-42 s).
2. **`verify` cannot see a companion that did not come back.** The relay restarts *before* Hermes, so verify sees
   both companions "connected" to the old Hermes. Reconnection after the recreate must be asserted directly (E4).
3. **The monitor bootstrap as written starts a monitor with no persona, the terminal toolset ON, and a read-write
   database URL, delivering at 12:00 IDT.** The Mac profile has no `disabled_toolsets` (every VM companion has
   `[terminal, code_execution]`, and the runbook requires both for trip-monitor); nothing installs the skill's
   `SOUL.md` as the profile SOUL; read-only is only a session default (`PGOPTIONS`, which `fleet-mcp.mjs:338` lets an
   inherited value replace) over the relay's read-write URL; the container runs in UTC, so `0 9 * * *` fires at
   09:00 UTC unless the profile sets `timezone`. Route to `boundary-reviewer`.
4. **Nothing in CI runs on `release/**`** (workflows trigger on `sprint/**`, `integration/**`, PRs to
   `integration/**` and `main`). G1 must be restated (P-G1).
5. **Use `--hermes-rev`, never `build-hermes-image.sh --set-rev`.** `--set-rev` writes `HERMES_REV` outside the
   release tool's history: done before an upgrade the upgrade sees no Hermes change and verify fails; done after,
   a later `rollback` of Release A silently reverts Hermes. The runbook "Hermes" section and the patches README say
   `--set-rev` and must be corrected (doc-keeper).
6. **Build from a worktree/archive of `8e1fbd6`, never from `/opt/kinerary`** (`130924b`, whose `hermes-patches/`
   has only 0001/0002): building there re-tags `...-pbf43d580` and destroys the proven rollback target.
7. `rollback --restore-db` and snapshot restore refuse once the monitor profile exists (a new profile since the
   dump). Plain keep-DB `rollback` is unaffected. **Bootstrap the monitor only after the upgrade has soaked.**
8. Live trips end 2026-10-01 (Orlando) and 2026-10-03 (Japan) per `meta.returnDate`; Saturday morning IDT is Japan's
   last afternoon (~17:05 JST). 16:30Z = 19:30 IDT = 01:30 JST on 4 Oct.

## 3. Risk table

| # | Change | Blast radius | Risk | Test | Isolated? |
|---|---|---|---|---|---|
| H1 | Hermes image rebuilt with 0003; the apt line is early in the final stage, so the s6 download, npm + Playwright, `uv sync` and web/tui builds are rebuilt and apt packages re-resolved | every companion, trip-intake, site AI features | medium: first full rebuild of that stage since 09-11 | build self-verify, `hermes-image-check.sh <tag>`, import smoke, post-recreate reconnection (E4) | own tool run |
| H2 | Hermes recreate | ~16 s with no companion; lost addressed turns; in-flight turn killed | medium on a live trip, ~nil after it ends | E0 live-conversation check | own run |
| H3 | `inbound` recreated as a compose dependency | none (Hermes waits for it healthy) | low | `$C ps inbound` healthy, folder `hermes 700` | with H1 checks |
| M1 | monitor profile on the VM Hermes (bootstrap, config, token, gateway) | the operator only | medium, security (finding 3) | `boundary-reviewer` + `config get` assertions | after H1 soaks |
| M2 | Mac monitor gateway stopped (launchd `RunAtLoad` and `KeepAlive` both true) | two pollers = 409s and stolen commands if it respawns | medium | `pgrep` + plist disabled after 24 h | with M1 |
| D1 | digest re-layout | the owner's Telegram | low; residual: `_ ~ \| >` are not stripped by `md()` | owner's look on the Mac (same Hermes base) + one digest run in the window | one run (E8) |

VM headroom (measured): 4 vCPU load 0.28; 9951 MB RAM, 7579 MB available, **no swap**; `/` 79 G with 27 G free
(Docker root on it); build cache 29.7 GB; base images cached, the runtime apt layer and everything after it is
rebuilt; outbound to deb.debian.org, GitHub, npm, PyPI, Playwright CDN OK; no network filesystem mounted (#116 must
not run before Saturday: `guard_storage` would refuse upgrades). Build time is the Dockerfile's own comment (15-45
min), **not measured on this VM**. Pass after the build: `df /` >= 14 G free and available memory never under
1.5 G. A failed build cannot touch a container or a tag in use if run from an `8e1fbd6` tree without `--set-rev`;
it shares CPU/RAM/disk with production and there is no swap.

## 4. The plan

### Before (Fri 2 Oct unless marked)

| # | Step | Pass | Who |
|---|---|---|---|
| P-D | resolve the cherry-pick of #298 onto `8e1fbd6` (take #298's digest script whole); push `release/a` = D **only on the owner's yes** (decision 55) | `git diff pr/298 D -- <monitor files>` empty | lead; owner decides |
| P2 | delta check: `git diff --name-only a744c28 D -- . ':!docs' ':!CLAUDE.md' ':!CHANGELOG.md' ':!README.md' ':!FRAMEWORK.md'` is exactly the 5 files of `8e1fbd6` plus the 6 of #298; `git diff a744c28 D -- control-plane/deployment/vm-release.py control-plane/deployment/vm-relay-restart.sh control-plane/deployment/compose.vm.yml control-plane/db/migrations control-plane/api control-plane/worker` is empty (replaces U8.3's P2) | anything else: re-plan | lead |
| P-G1 | G1 restated: `a744c28`'s push CI is green; the delta touches files no CI job runs, so run in a clean checkout of D `python3 -m unittest tests.scripts.test_hermes_patches tests.scripts.test_vm_release tests.scripts.test_vm_release_rehearsal tests.scripts.test_vm_release_database tests.scripts.test_fleet_monitor tests.scripts.test_fleet_mcp` and the companion template suite (32) and `scripts/preflight-checks.sh --all` (rule 6 on the monitor files). Note: the rehearsal suite was broken on the leading branch until #301; the release line predates #290 so it passes there | all OK | lead |
| P-M0 | the owner sees D's layout working on the Mac | his yes | owner |
| BR | `boundary-reviewer` on the monitor-on-VM configuration (toolsets off; `fleet-stacks.json`'s credential; `md()`'s strip set vs Hermes's converter) | no raw `[x](y)`, `_x_` or `>` from a companion summary renders | boundary-reviewer |
| P-W | extend the **private** wrapper (kinerary-deploy; rule 6): set `model` + `fallback_providers` (the Mac's block), `agent.disabled_toolsets: [terminal, code_execution]`, `timezone: <operator TZ>`, copy the checkout's `.agents/skills/trip-fleet-monitor/SOUL.md` to the profile SOUL, `chown 10000`. One command in the window, not hand edits | `--check` reports each | lead |
| P-M1 | copy the wrapper: `scp` then `sudo install -m 0750 -o root -g root ... /opt/kinerary-deploy/bootstrap-monitor.sh` (`/opt/kinerary-deploy` is `root:root 750`, `/opt/hermes-data` is `hermes 700`: the wrapper runs under `sudo`) | `sudo ...bootstrap-monitor.sh --check` dies **only** on psql | lead; owner's yes (a VM write) |
| P-H1 | **build ahead**: `git -C /opt/kinerary fetch`; `git -C /opt/kinerary worktree add --detach /var/tmp/hermes-build-8e1fbd6 8e1fbd6`; `time sudo /var/tmp/hermes-build-8e1fbd6/control-plane/deployment/build-hermes-image.sh` (**no `--set-rev`**); a second shell running `free -m`/`uptime` every minute; a quiet hour (Japan night is 13:00-23:00Z) | prints `built and verified: kinerary-cp/hermes:ab0d98414-p1a908d70`; `df /` >= 14 G; record the minutes | lead; owner's yes (a VM write) |
| P-H2 | `sudo .../hermes-image-check.sh kinerary-cp/hermes:ab0d98414-p1a908d70` | 3 patches; psql | lead |
| P-H3 | import smoke, no network: `sudo docker run --rm --network none --entrypoint sh <tag> -lc '/opt/hermes/.venv/bin/python -c "import gateway.run, cron.scheduler, hermes_cli.container_boot" && psql --version && node --version && hermes --version'` | exit 0 | lead |
| P-DR | Friday dry-runs: `sudo kinerary-cp-release upgrade <D> --dry-run` and `... upgrade <D> --hermes-rev ab0d98414-p1a908d70 --dry-run` | 0 problems; image present; Proxmox pool within thresholds after the build | lead |
| G8 | nightly job off 2->3 Oct; Mac provisioning off | | lead |

If P-H1/H2/H3 fails: Saturday is Release A only (the existing plan), the monitor stays on the Mac, Hermes waits.
Costs the fleet nothing.

### Morning: the existing plan (U8.5) with R = D

V1-V3: `upgrade D` **without** `--hermes-rev`. V8 still uses the Mac monitor. Expected noise after V3:
`hermes-image-check.sh` with no argument fails ("a different patch set than this checkout": 3 patches vs 2 running)
until the evening.

### Evening (proposed 19:30 IDT, after Japan's return date)

| # | Step | Go / no-go | Who |
|---|---|---|---|
| E0 | fleet + live-conversation check, and save the morning relay's evidence before it restarts: `sudo docker logs -t --since 15m kinerary-cp-relay-1 2>&1 \| grep -c '"event":"trip_bot.update_shape"'` -> 0; per companion (`japantokyohakonekyotoosaka2026`, `orlandoflorida2026`) count `inbound message\|response ready` in its `gateway.log` in the last 15 min (UTC timestamps) -> 0; 0 jobs in flight; `awaiting='machine'` 0; morning history row `ok`; `df /` >= 14 G | nonzero: wait 10 min and repeat; live after 30 min: postpone (nothing has changed) | lead |
| E1 | dry-run: `sudo kinerary-cp-release upgrade D --hermes-rev ab0d98414-p1a908d70 --dry-run` | 0 problems | lead |
| E2 | the owner's word (hard rule 2) | yes | **owner** |
| E3 | the same command without `--dry-run`: snapshot, relay restart (with the gateway wait), `inbound` recreated as a dependency, Hermes recreated, verify | ok | lead |
| E4 | Hermes assertions (verify does not prove these): `H=$(sudo docker inspect -f '{{.State.StartedAt}}' hermes)`; (1) relay log since `$H`: `relay.gateway_connected` >= 3 and no `relay.gateway_disconnected` for 5 min; (2) each companion's `gateway.log` has "relay connected" after `$H`; (3) `s6-svstat` for `gateway-*`: Japan, Orlando, trip-intake up; (4) `hermes-image-check.sh` passes both checks; (5) `$C ps inbound hermes`, `stat -c '%U %a' /opt/kinerary-inbound` = `hermes 700`, `HERMES_RELAY_MEDIA_DIR` in the container | any fail after 5 min: roll back (section 6) | lead |
| E5 | soak 15 min watching E4 | clean | lead |
| E6 | monitor bootstrap: `sudo /opt/kinerary-deploy/bootstrap-monitor.sh --check`, then without `--check`, then `--check` again | "fully bootstrapped"; step 7 reads the control plane | lead |
| E6a | assertions: `hermes -p trip-monitor config get` for `agent.disabled_toolsets` (terminal, code_execution), `model.provider`, `timezone`, `cron.wrap_response` = false; `diff` profile SOUL against the checkout's; the in-container `fleet-mcp.mjs --tool alerts` exits 0 (the path cron uses); `cron list` shows 2 jobs and the digest's next run is 09:00 in the chosen zone | any missing: stop before E7 | lead |
| E6b | place the two Telegram values, never printed (from the Mac profile `.env` over stdin to `sudo install -m 600 -o 10000 -g 10000 /dev/stdin /opt/hermes-data/profiles/trip-monitor/.env`; merge if the profile has one) | `sudo grep -c '^TELEGRAM_'` = 2 | lead |
| E7 | **stop the Mac, then start the VM:** Mac `hermes -p trip-monitor gateway stop`, `pgrep` empty and still empty after 30 s (launchd `KeepAlive`); VM `sudo /opt/kinerary-deploy/bootstrap-monitor.sh --start-gateway` | VM gateway log: Telegram connected with its own bot, **no "relay adapter registered"**, no 409/Conflict for 5 min | lead |
| E8 | **one digest run answers five questions:** `hermes -p trip-monitor cron run fleet-digest`; the owner receives it: no "Cronjob Response" wrapper, bold titles and no boxes, numbers present (not "could not be read": psql + bootstrap + DB path), sent by the monitor's bot | as stated | lead + **owner** |
| E9 | the owner sends "how is the fleet?" to the monitor bot; provider names from `agent.log` | a reply; `ollama-cloud` expected while Anthropic is exhausted | **owner** + lead |

Abort points that leave the system as it was: before E3 nothing changed; after E3 and before E6 `rollback`
restores Hermes; after E6 and before E7 the VM profile is inert; after E7 restart the Mac.

**Combined morning alternative:** same P-steps; V3 becomes `upgrade D --hermes-rev ab0d98414-p1a908d70` with E0
run immediately before it (the tool checks interview turns, never companion turns) and E4 right after V4; Japan's
companion is restarted on departure day and relay and Hermes effects cannot be told apart; one `rollback` reverts
both code and Hermes (no code-only way back).

**A live conversation at the recreate:** the relay has no guard for companion turns. Detect with E0. If live, wait
it out (turns take 20-42 s) and re-check. If a turn is lost anyway the relay logs `trip_bot.update_shape`; the
owner tells the organizer to resend; nothing is replayed.

### After (first 24 h)

+1 h/+6 h: `fleet-alerts` `last_run` advancing, status ok. +1 h: Mac `pgrep` empty, no 409 on the VM gateway.
**Sun 4 Oct 09:00 in the chosen zone:** the digest arrives from the VM, laid out as in E8; the Mac sends nothing;
cross-check one number against SQL. +24 h: Hermes s6 uptimes continuous since E3, `relay.gateway_disconnected` 0,
`inbound` healthy. +24 h if clean: **disable** the Mac agent (`hermes -p trip-monitor gateway uninstall` or rename
the plist `.disabled`) with the owner's yes; until then a Mac login or reboot restarts it.

## 5. Go / no-go and the way back

**No-go for the evening Hermes run if:** the morning upgrade was not `ok`; P-H1..H3 failed; E0 finds a live turn
after 30 min; E1 reports any problem; `df /` < 14 G; a network filesystem is mounted; a job is in flight.
**No-go for the monitor (E6-E7) if:** E4/E5 not clean; BR not clean or not accepted; E6a shows terminal enabled, no
SOUL, or the wrong timezone.

| Step | Way back | Cost |
|---|---|---|
| build ahead | `sudo docker rmi kinerary-cp/hermes:ab0d98414-p1a908d70`; remove the build worktree | none |
| evening Hermes run | stop the VM monitor first if started; `sudo kinerary-cp-release rollback` (Hermes back to `...-pbf43d580`, present) | ~1 min bot pause + ~16 s companions. **The rollback path has never run on production** (history: 1 baseline, 3 upgrade rows, 0 rollbacks) |
| back past Release A after the evening run | `sudo kinerary-cp-release rollback --to 130924b --dry-run` first | the evening run's snapshot rotation deletes the pre-Release-A snapshot (<= 2 kept), and the monitor profile blocks `--restore-db` until `hermes profile delete trip-monitor` + `s6-svscanctl -an` |
| monitor | VM `hermes -p trip-monitor gateway stop`; Mac `launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/ai.hermes.gateway-trip-monitor.plist` | minutes unwatched |
| combined morning | one `rollback` reverts both; code-only needs a second `upgrade D --hermes-rev ...-pbf43d580` | coupling |

## 6. Risk reduction, ranked

1. `--hermes-rev`, never `--set-rev`; build from an `8e1fbd6` tree (0 min). 2. Put `disabled_toolsets`, the model
block, `timezone` and the SOUL copy into the private wrapper, reviewed by `boundary-reviewer` (~55 min): turns
three silent gaps and one security gap into `--check` lines. 3. Hermes recreate after the Japan trip ends (0 min).
4. E4's direct reconnection assertions (10 min). 5. The import smoke (3 min). 6. One digest run for five changes
(3 min). 7. Follow-ups, not for Saturday: a read-only DB role for the monitor; `release/**` in the Control plane
workflow's push triggers; doc-keeper on the runbook and patches-README Hermes recipe and on "What trips notice"
(a Hermes restart is not queued); the bootstrap should install the profile SOUL (a fix at the source); `md()`
should also neutralise `_ ~ | >`.

## 7. Decisions needed

1. Split (recommended) or one combined morning session. 2. Build the image on Friday (recommended) or inside the
window; either way a VM write needing the owner's yes, together with P-M1 and P-H3. 3. Mac before VM is forced;
disable the Mac launch agent after the Sunday digest arrives from the VM. 4. `watch-amit-interview` (Mac-only,
every 15 min) stops with the Mac gateway: drop or recreate. 5. Digest hour: set the VM profile's `timezone`, else it
arrives at 12:00 IDT. 6. The monitor's SOUL on the VM: the release checkout's (`a744c28`, consistent with a release
line that lacks #290's bridge-failed repair path; the tip's at Release B). 7. G1 on the release head: accept
`a744c28`'s CI plus the local runs (recommended) or push the head to an `integration/**` ref for a 14-minute run.
8. If D is not approved by Fri 20:00 IDT: keep the Hermes image on Saturday evening and move the monitor on any
later day (with psql in the image the move restarts nothing live).

Corrections to the existing plan: what ships is D, not `a744c28`; U8.3's P2 is now non-empty by design; "Hermes
untouched" no longer holds; an evening rollback restarts every companion; "messages wait at Telegram" holds for
relay restarts only; `inbound` is recreated; V8 moves to the VM monitor after E7; #182 is in the line, #290 and
#297 are not; live-trip dates are read, not carried.

## 8. Addendum 2026-09-28 (afternoon): the monitor's tool surface and its database credential

A `boundary-reviewer` pass on the monitor-on-VM configuration (with the wrapper's harness and Hermes's own tool
resolver, on a scratch profile with the real fleet MCP registered) found that section 2's finding 3 is understated.
Changes to the plan:

1. **`disabled_toolsets: [terminal, code_execution]` is not a lockdown.** On that config alone the resolver gives
   the monitor 27 tools on both telegram and cron, including `read_file`, `write_file`, `patch`, `search_files`,
   `web_search`, `web_extract`, `browser_*`, `delegate_task`, `skill_manage` and `memory`. File write into its own
   profile is process execution (`mcp_servers.<name>.command/args/env` in `config.yaml` are started as processes),
   which is the shell the runbook forbids. **The enforced configuration is an allow-list:**
   `platform_toolsets.telegram` and `.cron` = `[fleet]`, `agent.disabled_toolsets` = the full deny list
   (`terminal, code_execution, file, browser, web, delegation, cronjob, skills, memory, session_search, vision,
   image_gen, video, video_gen, tts, todo, messaging, computer_use, bfl, kanban, x_search, homeassistant,
   clarify`), and `known_builtin_toolsets.telegram/.cron` = the Hermes catalog (so a toolset shipped later fails
   closed). Resolver result: enabled toolsets == `["fleet"]`, model-visible tools == Hermes's three meta-tools
   (`tool_search`, `tool_describe`, `tool_call`) with the nine `mcp__fleet__*` tools deferred behind them.
   **Verified end to end** on the Mac monitor profile (applied 2026-09-28 12:08, gateway restarted): a real CLI chat
   called `mcp__fleet__fleet_overview` and `mcp__fleet__alerts` and answered correctly.
2. **The wrapper's `--start-gateway` gate asserts the resolved tool surface, not config keys**, fails closed when the
   resolver cannot run, refuses if `mcp_servers.fleet` has an `env` key or a command/args other than the node binary
   and the profile's `fleet-mcp.mjs`, or any other MCP server, and refuses on a symlinked `$HERMES_DATA` or
   `fleet-stacks.json` (root operates in a tree the Hermes uid writes).
3. **The monitor must not hold the relay's read-write database URL in the shared container.** Every Hermes profile
   shares one container, one uid and one data mount (`/opt/data`, and `HERMES_WRITE_SAFE_ROOT=/opt/data`), and
   `fleet-stacks.json` is not on the file tools' credential deny list. Today the control-plane credential lives only
   in root-owned `.local-secrets` outside the container. **New prerequisite P-RO (Friday, a production database
   write, needs the owner's yes):** create the read-only role `kinerary_fleet_ro` (SELECT on exactly the 12
   relations `fleet-mcp.mjs` queries; the generic script `scripts/create-monitor-db-role.sh` and its drift-guard
   test are being built), write its URL to `.local-secrets/control_plane_database_url_monitor`, and point the
   wrapper's `FLEET_DB_URL_FILE` at it. The wrapper refuses to use `control_plane_database_url_host` and its gate
   checks the URL's user (never printing it).
4. **`trip-intake` has no disabled toolsets and made 0 tool calls** in its log (the interview runs through the
   router). It can be locked down with the same allow-list at the Hermes recreate at no functional cost; optional.
5. **No monitor move without P-RO and the gate.** If either is not ready by Friday 20:00 IDT, the Hermes recreate
   (psql patch) still goes ahead and the monitor stays on the Mac (already locked down there).
6. A review of the *companion* profiles' tool surface (the same class applies to them) is tracked separately.
