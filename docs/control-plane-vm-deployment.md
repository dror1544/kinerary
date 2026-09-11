# The control plane on Proxmox — VM `kinerary-cp`

**Status (2026-09-11):** running, on an empty database, in parallel with the
Mac stack. Not yet the production control plane — see [Cutover](#cutover-phase-b).
Built by session `kinerary-53`; decisions and evidence are in the session plan,
this page is the durable part.

VM 110 `kinerary-cp` runs the whole Kinerary runtime under Docker Compose:
PostgreSQL, migrations, API, provisioning worker, the relay (the router), the
interview MCP sidecar, and Hermes. It is a stepping stone: when the k3s track
(`k3s-home-deployment-sprint-plan.md` D1) builds `kinerary-prod`, workloads
move there and this VM is destroyed.

## Why the Mac is no longer needed

Every Mac dependency traced to one fact — Hermes was a macOS arm64 venv — and
three things had to sit next to it: the interview sidecar (it shelled out to
`hermes`), the relay (its `bind_host` is schema-pinned to loopback because the
socket sends as the bot, and its clients are Hermes gateways), and companion
installation (the worker SSHed back to the Mac). With Hermes in a container on
the same VM, all three are loopback-local, with no schema change.

The Mac keeps a separate, general-purpose Hermes (`elulhome`, personal
profiles). It has no Kinerary role and shares no credential with the VM.

## Host

| | |
|---|---|
| VMID / name | `110` / `kinerary-cp`, `onboot=1` |
| Size | 4 vCPU, 10 GB (TrueNAS VM 103 was trimmed 16→10 GB to make room), 80 GB on `nvme-thin` |
| OS | Debian 13 genericcloud + cloud-init, Docker 29 / Compose v5 |
| Address | `192.168.0.45/24`, gw `.1`, DNS `.41` + `1.1.1.1` |
| SSH | `debian@192.168.0.45` with `~/.ssh/id_ed25519_kinerary_cp` (Mac) |

Only SSH is reachable from the LAN. Everything Kinerary listens on loopback:

| Port | Service | Why loopback |
|---|---|---|
| 4310 | api | same posture as the Mac; reach it with `ssh -L 14310:127.0.0.1:4310` |
| 4311 | interview-mcp | `interview-mcp.ts` binds 127.0.0.1 unconditionally |
| 4312 | relay | `relay.bind_host` is schema-pinned to loopback (`config.ts`) |
| 5433 | postgres | the relay (host networking) reads the DB directly; nothing off-box does |

The relay, sidecar and Hermes use **host networking** so they share the VM's
loopback; postgres/api/worker stay on compose networks.

## Layout

| Path | Owner / mode | What |
|---|---|---|
| `/opt/kinerary` | debian | clone of `feat/interview-interpret` via a **read-only** deploy key (GitHub key id `162968294`) |
| `/opt/kinerary/control-plane/deployment/.local-secrets/` | debian 0700 | compose secrets (below) |
| `/opt/kinerary-deploy` | root 0750 | deploy root, rsynced from the Mac's `~/kinerary-deploy` (its `trips/` are untracked there) |
| `/opt/kinerary-deploy/vm.env` | root 0600 | VM-only overrides, loaded after `provisioning.env` |
| `/opt/hermes-data` | 10000 0700 | Hermes `HERMES_HOME` (the container's `/opt/data`) |
| `/opt/hermes-src` | root | `git archive` of the Hermes fork at `HERMES_REV` |
| `/opt/agent-auth/` | root 0711 | `claude.env` (0600, `CLAUDE_CODE_OAUTH_TOKEN`), `codex/` (`CODEX_HOME`) |
| `/root/.ssh/` | root | Proxmox + RPi4 keys (worker), pinned `known_hosts`, `id_ed25519_kinerary_companion_vm`, `known_hosts_companion_vm` |
| `/home/hermes` | hermes | companion host user — see [Companion host](#companion-host) |

## Running it

Always from `control-plane/deployment/`, always with both env files, in this
order (later wins):

```bash
C="sudo docker compose -f compose.vm.yml \
  --env-file /opt/kinerary-deploy/provisioning.env \
  --env-file /opt/kinerary-deploy/vm.env"
$C up -d --wait
$C ps
curl -s http://127.0.0.1:4310/readyz
```

Images are built on the VM and pinned by revision in `vm.env`
(`KINERARY_REV`, `HERMES_REV`) — no dev `dist/` overlays, unlike
`compose.local.yml`:

```bash
cd /opt/kinerary && git pull --ff-only && REV=$(git rev-parse --short HEAD)
sudo docker build -f control-plane/api/Dockerfile -t kinerary-cp/api:$REV .
sudo docker build -f control-plane/worker/Dockerfile -t kinerary-cp/worker:$REV .
sudo docker build -f control-plane/deployment/agent-runtime.Dockerfile \
  --build-arg BASE=kinerary-cp/api:$REV -t kinerary-cp/agent-runtime:$REV .
sudo sed -i "s/^KINERARY_REV=.*/KINERARY_REV=$REV/" /opt/kinerary-deploy/vm.env
$C up -d --wait
```

`agent-runtime` is the api image plus the `claude` and `codex` CLIs the relay
(interpret) and sidecar (extract) shell out to through `model-runner.ts`,
**pinned to the versions the Mac runs** (npm's `stable` tag for claude). Bump
them together with the Mac, never one side alone: on 2026-09-11 an older CLI
with the same model id returned no proposal for a one-word answer the Mac read
correctly 4 times out of 4, and the interview stalled.

**Effort is explicit here, and inherited on the Mac.** Every `claude -p` on the
Mac loads Dror's personal `~/.claude/settings.json`, which sets
`effortLevel: xhigh` — so the Mac's interpretation runs at extra-high effort by
accident of a coding-session preference. At the default effort the VM mapped
answers to the wrong question (a one-word assistant name to nothing; "Dror, the
family's dad" to `travelers` instead of `organizer_identity`), and the
interview stalled. The relay and sidecar therefore get
`CLAUDE_CONFIG_DIR=/home/node/.claude-config` holding only
`{"effortLevel": "xhigh"}` (`/opt/agent-auth/claude-config/`). Measured: 7.8 s
per interpret call at default effort, 15.2 s with it (Mac: 13.1 s), and the
mapping matched the Mac's.

The relay's credential is `CLAUDE_CODE_OAUTH_TOKEN`. `model-runner.ts`'s
`hermeticEnv` strips a calling Claude Code session's `CLAUDE_CODE_*` variables
from the nested CLI but keeps that one — on the Mac the CLI uses the keychain,
here the token is its only credential, and losing it made every interpret call
`FAILED`.

### Checks that actually answer the question

- **API:** `readyz` → `"status":"ready"` with the expected `schema_migrations`.
- **Relay:** `$C logs relay` shows `relay.bot_identity` naming the bot you
  expect, `relay.ready … polling:true`, and **no** `409`/`Conflict` — a 409
  means a second `getUpdates` loop exists somewhere on the same token.
- **Relay env:** `INTERPRET_PATH_DEFAULT=1`, `INTERPRET_RUNNER`,
  `EXTRACT_RUNNER` set *inside* the container (compose fails `up` without
  them, on purpose).
- **Gateway tools:** the same check as `interview-stack-deploy/deploy.sh` —
  extract the `*_for_chat` tool names from `interview-mcp.ts` and find each in
  the gateway's own `MCP server 'interview' … registered N tool(s):` line in
  `/opt/hermes-data/profiles/trip-intake/logs/agent.log`.
- **Reboot:** the full stack and the trip-intake gateway return unattended
  (~30 s measured).

## Credentials

Values never go in this file or in logs. Where each lives:

| Credential | Where | Notes |
|---|---|---|
| Postgres password, DB URLs | `.local-secrets/` | `control_plane_database_url_host` = same URL via `127.0.0.1:5433`, for the relay |
| Bot token | `.local-secrets/telegram_creds` | **`@Tripinterviewer_bot`** until cutover — see below. Also mounted as `trip_bot_creds` (one bot, two roles) |
| Signup: approval key, webhook secret, super-admin chat id | `.local-secrets/` | the relay mounts these too: its bot is also the signup bot, so it subsumes the approval poller |
| Relay↔gateway secret | `.local-secrets/relay_gateway_secret` | same value in `trip-intake/.env` |
| Chat-routing key, interview MCP key, interview agent key | `vm.env` | **VM-only**, generated on the VM, not shared with the Mac |
| Claude | `/opt/agent-auth/claude.env` | `claude setup-token` (subscription), long-lived |
| Codex (CLI) | `/opt/agent-auth/codex/` | `codex login --device-auth` inside the agent-runtime image |
| Hermes providers | `/opt/hermes-data/auth.json` | `hermes auth add` inside the container: `openai-codex` and `anthropic` as OAuth (subscription logins), `openrouter` and `ollama-cloud` as API keys |
| Proxmox, NPM, Cloudflare | `provisioning.env` | unchanged from the Mac |

**Never copy a rotating OAuth credential** (codex `auth.json`) between the Mac
and the VM: its refresh tokens are single-use, and two holders lock each other
out (`refresh_token_reused` is already on record for this account). Each
instance logs in for itself.

## Safety rules while the Mac stack is live

These exist because both stacks share Telegram, Proxmox, NPM, Cloudflare and
the RPi4:

1. **The VM never polls `@Kinerary_bot`.** Telegram gives each update to one
   `getUpdates` caller; a second loop steals live interview messages. The VM
   runs on `@Tripinterviewer_bot`, the retired pre-shared-bot interviewer.
2. **Provisioning is off** (`PROVISIONER_COMPUTE_ENABLED=` in `vm.env`). IP
   allocation scans only *this* deploy root's topology files
   (`compute.py _ips_already_claimed`), so the VM cannot see trips the Mac
   creates; both workers edit the same RPi4 `cloudflared` config. A VM
   provisioning run needs a unique slug, the `.95–.99` pool (already in
   `vm.env`; the Mac allocates lowest-first from `.60`), and an agreed window.
3. **`PROVISIONER_VMID_MAP={}` in `vm.env`.** `provisioning.env` maps Mac trips
   onto real containers (201, 202), and with compute off the worker deploys
   straight to a mapped container — an inherited map is a path from this VM
   onto the Mac's trips. `{}`, not blank: the worker rejects blank at start.
4. **Only Kinerary profiles in `/opt/hermes-data`.** The container auto-starts
   any profile whose last recorded state was `running`, and the Mac's other
   profiles poll other live bots directly. Never copy `~/.hermes` wholesale;
   strip `TELEGRAM_BOT_TOKEN` from anything staged.
5. **Never run `scripts/e2e-full-cycle.py` against the VM without its VM switches.** Its
   automated-organizer mode repoints the relay by calling the **Mac's**
   `scripts/relay-restart.sh` unless told otherwise; it now refuses `--auto`
   on a non-Mac stack without `KINERARY_RELAY_RESTART` (see below).
6. **Hermes gets no Docker socket.** It would give the AI runtime root over
   every container here, the control plane included. The terminal toolset
   (k3s ledger C12) stays off for Kinerary profiles.

## End-to-end test on the VM

`scripts/e2e-full-cycle.py`'s automated organizer runs here, on the VM, so
every loopback address is the VM's own. Three switches point it at this stack
and one stops it before anything could provision:

```bash
cd /opt/kinerary
KINERARY_COMPOSE_PROJECT=kinerary-cp \
KINERARY_RELAY_CONTAINER=kinerary-cp-relay-1 \
KINERARY_RELAY_RESTART=/opt/kinerary/control-plane/deployment/vm-relay-restart.sh \
python3 scripts/e2e-full-cycle.py --scenario manual --auto --stop-after confirm
```

`vm-relay-restart.sh` is the VM twin of `scripts/relay-restart.sh`: same
interface, same refusals, checks read off the container. It recreates the relay
to change its environment, which deletes the old container's log — so it
appends the outgoing log to `/var/log/kinerary/relay.log` first. Read that file,
not `docker compose logs`, for anything that happened before the last restart.

Green on 2026-09-11: `--scenario manual` (every answer typed, 13 turns) and
`--scenario japan` (a booking PDF, 10 turns) — intake version written, no plan
and no job created, Proxmox untouched. `multi` not yet run. `--stop-after confirm`
ends the run at the confirmed intake; on this VM the build could not start
anyway, because unsealed releases are off and `provisionOnConfirm` answers
`NO_COMPATIBLE_RELEASE`. `--teardown` needs `KINERARY_TEARDOWN` pointing at
`control-plane/deployment/vm-teardown-trip.sh`. The automated organizer needs the api package's
dev dependencies (`npm ci` in `control-plane/api`) for `tsx`.

## Hermes

Built from the fork's own `Dockerfile` (`kinerary-cp/hermes:$HERMES_REV`),
s6-overlay as PID 1. The main process is `sleep infinity`, **not** the fork's
legacy `gateway run`, which would seed a default gateway; every gateway is an
s6 slot started with `hermes -p <profile> gateway start`, which records the
intent the container reads on the next boot.

The fork's only git remote is upstream `NousResearch/hermes-agent`; its local
commits are on no remote. `/opt/hermes-src` is a history-less snapshot.

## Companion host

The worker installs a trip's companion over SSH to a forced command, as on the
Mac — only the host changed. On the VM:

- host user **`hermes`**, uid/gid 10000 = the container's `hermes`, in the
  `docker` group; `~/.hermes → /opt/hermes-data`,
  `~/kinerary-deploy → /opt/kinerary-deploy`;
- `/usr/local/bin/hermes` (and `~/.local/bin/hermes`) is a wrapper that runs
  the CLI inside the container, so a profile name means the same files on both
  sides. It uses `docker exec -i`, which forwards stdin eagerly — callers that
  must not lose stdin close it (`companion-install-host.sh` reads the whole
  handoff up front, so it is safe);
- `~hermes/.ssh/authorized_keys` pins the worker's **VM-only** key to
  `command="/opt/kinerary/scripts/companion-install-host.sh",restrict`;
- ACLs give `hermes` traverse-only on the deploy root, `setup-mcp.sh`, and
  `trips/` + `logs/` (with default ACLs so files the worker creates later stay
  writable) — and nothing in `provisioning.env`, `vm.env` or other secrets;
- `.local-secrets/architecture.relay-host.json` is a minimal relay block that
  `enroll_relay` reads for the relay URL and secret.

`companion-install-host.sh` starts the gateway through `start_gateway_supervised`
on non-Darwin hosts (stop, then start — the s6 twin of launchd's
bootout-then-bootstrap). `setup-mcp.sh` needed no change.

### Tearing a trip down from the VM

```bash
control-plane/deployment/vm-teardown-trip.sh --trip <slug|trip_id>            # the plan
control-plane/deployment/vm-teardown-trip.sh --trip <slug|trip_id> --execute  # do it
```

The same `scripts/teardown-trip.py`, run as root with the VM's locations
(`KINERARY_DEPLOY_ROOT`, `KINERARY_HERMES_HOME`, `KINERARY_COMPOSE_PROJECT`,
`KINERARY_HERMES_CONTAINER`). On Linux it finds a companion's gateway as an s6
slot in the Hermes container rather than a launchd agent, confirms the bridge's
listener with `ss` where there is no `lsof`, reads `vm.env` over
`provisioning.env` the way compose does, and after deleting the profile runs
`/command/s6-svscanctl -an /run/service` — Hermes's own delete leaves the
supervisor behind — then fails the run if one survives. The e2e runner uses it
with `KINERARY_TEARDOWN=…/vm-teardown-trip.sh`.

Proven 2026-09-11 on a throwaway trip with a companion installed through the
forced command: backup, gateway uninstalled, bindings closed and slug retired,
profile deleted and stayed gone through the 70 s cron watch, no supervisor left.
The Cloudflare/NPM/LXC and bridge steps run the same provisioner code as on the
Mac; they are proven by the first VM provisioning run (A6).

## Later: model and effort per task (parked by Dror, 2026-09-11)

Today both interview tasks — **interpret** (reading a typed answer) and
**extract** (reading an uploaded document) — run `claude-sonnet-5` through the
Claude Code CLI at effort `xhigh`: explicit on this VM, inherited from a
personal setting on the Mac. `model-runner.ts` can already route each task to
`codex` (`gpt-5.6-luna`), `openrouter` (default `minimax/minimax-m3`) or a
`hermes` profile.

Choosing deliberately is future optimisation, and it needs testing, not
opinion. This VM is the bench for it: the automated organizer runs here without
touching the Mac, and `interview_interpretations` already records every call's
outcome and duration. Measure per task, per candidate model and effort:
question-mapping accuracy (the two misreads above are the regression cases),
latency, and cost. Make effort an explicit per-task setting at the same time,
so the Mac stops depending on a coding-session preference.

## Cutover (Phase B)

Not done. Gates, in order:

1. The VM's branch must carry every migration the Mac's database has applied —
   today the Mac has `0050_telegram_organizer_links.sql`, the VM's branch does
   not.
2. No interview mid-turn (`intake_sessions.awaiting = 'machine'`).
3. Stop the Mac's relay, sidecar, trip-intake gateway and compose stack — only
   one `getUpdates` loop may own `@Kinerary_bot`.
4. Fresh `pg_dump -Fc` from the Mac, restore on the VM, compare row counts.
5. Swap the VM's `telegram_creds` to `@Kinerary_bot`, restart the relay.
6. `/opt/kinerary-deploy` becomes the single copy of per-trip state: give it a
   backup target first.

The Mac's compose volume and Hermes profiles stay intact as the rollback.
