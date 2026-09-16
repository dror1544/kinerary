# Running a full end-to-end test

How to prove a build works end to end, the way Sprint 5 was accepted on
2026-09-13: signup → interview (typed answers and documents) → confirm → build
(LXC, NPM, Cloudflare) → site content → traveller login → companion → trip-mcp
→ teardown. Background, credentials and the stack itself are in
`docs/control-plane-vm-deployment.md`; this page is the procedure.

**Where:** the Proxmox VM `kinerary-cp` (`192.168.0.45`) is the reference stack,
and it owns `@Kinerary_bot`. The Mac stack runs on `@Tripinterviewer_bot`; its
equivalent is `scripts/preflight-deploy.sh --deploy --auto --scenario all --cleanup`.

```bash
ssh -i ~/.ssh/id_ed25519_kinerary_cp debian@192.168.0.45
```

## 0. Before you start

- **Nothing else is provisioning.** The Mac and the VM share Proxmox, NPM,
  Cloudflare and the RPi4 tunnel, and both derive the same slug from the same
  answers. Don't finish an interview on the Mac during a VM run.
- **The VM runs the commit you mean.** `sudo kinerary-cp-release status`.
  To deploy one: `sudo kinerary-cp-release upgrade <rev> --dry-run`, then
  without `--dry-run` — it builds, dumps, snapshots, switches, restarts the
  relay (refusing mid-interview) and verifies, and `rollback` is the way back
  (VM runbook: "Upgrades and rollback").
- **Preconditions pass:** `/opt/kinerary/control-plane/deployment/vm-manual-test.sh --check`.
  That checks the control plane is ready, the relay is on `@Kinerary_bot`,
  Hermes has provider credentials, no job is in flight, and a sealed release
  exists.
- **The automated organizer needs `tsx`:** run `npm ci` in `control-plane/api`
  once per checkout.

## A. Hands-off: every scenario, automated organizer

The automated organizer replaces exactly one thing: the person on Telegram.
The relay is pointed at a local Bot API stand-in for the run and put back on
real Telegram in a `finally`. While it runs, real messages to `@Kinerary_bot`
wait at Telegram. It takes about 80 minutes.

Provisioning is off on the VM by default, so switch it on for the run and off
again on every exit:

```bash
cd /opt/kinerary
C="sudo docker compose -f control-plane/deployment/compose.vm.yml --env-file /opt/kinerary-deploy/provisioning.env --env-file /opt/kinerary-deploy/vm.env"
flags() {  # flags 1 1  -> on;  flags "" 0 -> off
  sudo sed -i -e "s/^PROVISIONER_COMPUTE_ENABLED=.*/PROVISIONER_COMPUTE_ENABLED=$1/" \
    -e "s/^PROVISIONER_COMPANION_PROFILE_ENABLED=.*/PROVISIONER_COMPANION_PROFILE_ENABLED=$2/" \
    -e "s/^PROVISIONER_MCP_BRIDGE_ENABLED=.*/PROVISIONER_MCP_BRIDGE_ENABLED=$2/" /opt/kinerary-deploy/vm.env
  $C up -d --wait worker
}
trap 'flags "" 0' EXIT
flags 1 1
control-plane/deployment/vm-e2e.sh --scenario all --auto --teardown 2>&1 | tee /tmp/vm-e2e-all-$(date -u +%Y%m%d-%H%M).log
```

Run it detached (`setsid nohup … &`) if your ssh session might drop. It ends
with one row per scenario (`japan`, `multi`, `manual` → `green`) and
`e2e exit 0`.

`vm-e2e.sh` takes the runner's arguments (`scripts/e2e-full-cycle.py`):

| | |
|---|---|
| `--scenario japan\|multi\|manual\|own\|all` | `japan`: a booking PDF. `multi`: several documents and stops. `manual`: every answer typed. `own`: a person's real trip. |
| `--auto` | the automated organizer plays the person |
| `--stop-after confirm` | stop at the confirmed intake: no plan, no job, Proxmox untouched |
| `--teardown` / `--keep` | remove what the run created / leave it running |
| `--wait-minutes N` | how long to wait for a person to confirm (default 30) |
| `--trip-name "…"` | the name the signup form would have carried |

## B. A person's run

```bash
/opt/kinerary/control-plane/deployment/vm-manual-test.sh --wait-minutes 60
```

It signs a new organizer up and prints a `t.me/Kinerary_bot?start=…` link. Do
the interview in Telegram, add documents if you like, and **confirm**. It then
verifies the build, the site and its content, the companion and trip-mcp, and
leaves the trip running for you to use: open the site, add the bot to a group,
talk to the companion.

**Confirm before the wait runs out.** When it expires the script switches
provisioning off, so a confirmation that arrives afterwards starts a build that
fails at once (`automatic container creation … is not turned on`). If that
happens, tear the trip down and start again.

## Monitors: what to watch while it runs

| Layer | Command | Look for |
|---|---|---|
| The run | `tail -f /tmp/vm-manual-*.log` (or the `tee` file) | ✓/✗ lines, `waiting for …` countdowns |
| Relay (router) | `sudo docker logs -f kinerary-cp-relay-1 2>&1 \| grep -v getUpdates` | `interview.document_read` / `document_committed`, `interview.confirmed`, `interview.provisioning_started`, `relay.gateway_connected`, `relay.internal_leak_suppressed`; any `409` means two pollers on one bot |
| Relay before its last restart | `sudo less /var/log/kinerary/relay.log` | a restart recreates the container, and its old log is only here |
| Worker (build) | `sudo docker logs -f kinerary-cp-worker-1 2>&1 \| grep -E "provisioner\|job_failed\|Error"` | `provisioner.job_failed` plus the traceback |
| Jobs | `sudo docker exec kinerary-cp-postgres-1 psql -U kinerary_control_plane -d kinerary_control_plane -c "select trip_id, state, attempt, safe_error_code, updated_at from control_plane.jobs order by created_at desc limit 5"` | `succeeded`; `failed` after 3 attempts |
| Companion | `sudo tail -f /opt/hermes-data/profiles/<profile>/logs/gateway.log` | `inbound message`, `[Relay] Sending response` |
| Companion memory | the `sessions` table in `/opt/hermes-data/profiles/<profile>/state.db` | **one** session per chat. Several keys for one group (`…:forum:<chat>:<n>`) means conversations are being split: the reply-thread bug fixed in `d1cd907` |
| The site | `ssh -i ~/.ssh/id_ed25519_proxmox_hermes root@192.168.0.40 pct exec <vmid> -- journalctl -u kinerary-server -f` | request and enrichment errors. The plan lives in `/nfs/<slug>/server-data/trip.db`; the vmid is in `/opt/kinerary-deploy/trips/<slug>/topology.yaml` |

## Afterwards

- **Remove a trip:** `/opt/kinerary/control-plane/deployment/vm-teardown-trip.sh --trip <trip_id|slug>`
  shows the plan; add `--execute` to do it. It backs up first and refuses a
  trip past `ready_private`.
- **Provisioning is off again:** `sudo grep ^PROVISIONER_ /opt/kinerary-deploy/vm.env`
  shows compute blank and the companion and bridge flags at 0.
- **The relay is on real Telegram:** its `relay.bot_identity` names
  `Kinerary_bot`, and `docker exec kinerary-cp-relay-1 env` has no `TELEGRAM_API_ROOT`.
- **Record the run** under `docs/test-reports/` (see `vm-e2e-2026-09-13.md`),
  with no names, chat ids, booking references or document contents.
