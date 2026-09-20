# Regression plan — `main` → production (VM 110 `kinerary-cp`)

- **Date:** 2026-09-19
- **Commit assessed:** `810795a` (`origin/main`, "fix(provisioning): verify a new trip-mcp bridge can reach its trip (#104)")
  — **already deployed to production, verified read-only 2026-09-19.** Not a pending deploy target.
- **Candidate to carry:** PR #109 `fix/62-travel-anchor-confirmations`, head `42487a7` (`42487a7fd7406a9c3b53379ba14f812d8e16c726`)
- **Author:** `regression-planner`, local run (live fleet read; CI cannot do this half)
- **Scope deliberately narrowed by the user:** `integration/sprint-6` is **not ready and is excluded**. Its seven open PRs (#89, #90, #91, #92, #95, #108, #111) were not diffed, not planned for, and are not in this assessment.

---

## UPDATE 2026-09-19, later the same day — the blocker is RESOLVED

**Everything below about `/srv/kinerary-nfs` blocking `kinerary-cp-release` is
now historical.** The mount has been removed and the release tool works again.
Verified read-only on VM 110 after the fact, independently of the session that
did it:

```
── Storage ──
  ✓ backups go to /var/backups/kinerary-cp on local ext4, never NFS
  ✓ no network filesystem mounted in this VM
  ✓ / has 27.5 GB free (need 10.0 GB)
status exit: 0
```

`mount` shows no network filesystem, `/etc/fstab` carries none, `/srv/kinerary-nfs`
no longer exists, and `git -C /opt/kinerary status --short` returns empty — the two
`scp`'d scripts are gone, so no hot patch is left on production. `upgrade` and
`upgrade --dry-run` are both unblocked.

**Attribution and cause.** The mount was made by the local session `Sprint 6 -work`
at 18:02 while bootstrapping the document store, ahead of the code that needs it.
It was reverted as a scripted reversal, not a manual `umount`: fstab restored from
the bootstrap's own backup (diff confirmed one line), a second backup taken first,
`KINERARY_NFS_ROOT` dropped from `vm.env` so config describes reality.

**The design question is answered, and NOT by abandoning NFS.** The requirement is
real and belongs to #92: `compose.vm.yml` has the worker mount the whole export as
`PROVISIONER_TRIP_NFS_LOCAL_BASE` so it writes trip data locally instead of over SSH
to Proxmox, with the relay's document store under the same mount — through one mount,
deliberately. What was wrong was timing, not design: `PROVISIONER_TRIP_NFS_LOCAL_BASE`
appears on no file outside #92's branch. The mount, the guard change and the runbook
correction all land inside #92's Slice B, on sprint-6, never on main.

**Carry forward when #92 brings the mount back:** `guard_storage()` has *two*
checks and only one is the decided rule. Check 1 — `BACKUP_DIR` must be on a local
filesystem — is what the 2026-09-13 vzdump-into-NFS incident actually established,
and this mount never affected it. Check 2 — no network filesystem mounted at all —
is a generalisation from that incident, and it duplicates a protection
`proxmox-snapshot-runner.sh` already implements properly (reads `fsfreeze-status`,
refuses unless thawed, thaws on recovery). **Narrow check 2, never check 1.**
Confirmed by reading `vm-release.py:874-891`.

Sections 3.2, 7 and 8 below are left as written, as the record of what was found
and why it mattered. Item 1 of section 8 is done.

---

## 0 — Verdict, before anything else

**The deploy you are planning has already happened.** Production VM 110 is
running `810795a` — the exact tip of `origin/main` — on every container, put
there by `kinerary-cp-release upgrade` at 2026-09-18 20:24 UTC. The code delta
between `origin/main` and production is **zero**. `kinerary-cp-release upgrade
main` today returns `already running 810795a` and exits 0 without touching
anything (`vm-release.py:1462`).

So there are only three real questions left, and all three have teeth:

1. **A fix that is deployed is not a fix that arrived.** The one live trip is
   pinned to a release from *before* the site-upload auth fix, and is still
   being protected by a proxy rule instead of by the code. See §4.
2. **The next upgrade is currently blocked.** Somebody mounted NFS on the
   production VM about an hour before this run, which makes the release tool's
   own storage guard refuse in stage 1/5. See §3.2 — this is the single most
   actionable finding in this document.
3. **PR #109 is the only open PR based on `main`**, it is small, and it is
   safe — but deploying it costs a relay restart, and the family it would
   restart the bot on is on day 2 of a 16-day trip and gets no benefit from
   it at all. See §2, §3.4 and §7.

Two record corrections that would change the plan if believed wrong: the
`kinerary-cp-release` command **is** installed (at `/usr/local/sbin/`, not
`/usr/local/bin/`), is byte-identical to `main`, and **has** been exercised —
one install and one upgrade with a dump and a Proxmox snapshot on record. Its
agent gate, however, is **not** wired (no sudoers entry), so every upgrade is a
human at a root shell. Details and hashes in §3.4.

---

## 1 — Change set

### 1.1 The `main` → production delta: **empty**

Read off production at 2026-09-19 ~18:05 local:

| What | Value | How it was read |
|---|---|---|
| `KINERARY_REV` | `810795a` | `/opt/kinerary-deploy/vm.env` |
| `HERMES_REV` | `ab0d98414-pbf43d580` | same |
| Checkout | detached at `810795a6da586229d7601f9c9decc921493eed93`, tag `deployed/810795a` | `git -C /opt/kinerary rev-parse HEAD` |
| Container images | `api`, `worker`, `agent-runtime`, `companion-mcp`, `interview-mcp`, `relay`, `inbound` all at `:810795a`; `hermes` at `:ab0d98414-pbf43d580` | `docker ps --format '{{.Names}}\t{{.Image}}'` |
| `readyz` | `{"status":"ready","profile_version":1,"database":"ready","schema_migrations":51}` | `curl 127.0.0.1:4310/readyz` |
| Schema | 51 applied, newest `0051_trip_person_links.sql` applied **2026-09-12** | `control_plane_schema_migrations` |

`origin/main` carries exactly 51 migration files, newest `0051_trip_person_links.sql`.
**Production's schema and `main`'s schema are identical. There are no pending migrations.**

Release history (`/var/lib/kinerary-cp-release/history.tsv`):

```
2026-09-18T20:19:46Z  baseline            → cc63dab           ok             install
2026-09-18T20:24:30Z  upgrade   cc63dab → 810795a             switching      human   pre-810795a-202609182024
2026-09-18T20:26:11Z  upgrade   cc63dab → 810795a             verify-failed  human   pre-810795a-202609182024
```

Every PR the task listed as "possibly not deployed" is therefore **already in
production**: #84 (`94e572d`), #86 (`cea047d`), #87 (`b56f4c0`), #88 (`1ffbc9a`),
#93 (`bfa8573`), #94 (`b5ead6f`), #96 (`1606c5f`), #98 (`03b0cf1`),
#99 (`ee3675f`), #101 (`ff522e4`), #102 (`f1f4ba4`), #104 (`810795a`).

**The `verify-failed` is explained and already resolved.** It was issue #105 —
a chat binding created against a torn-down trip, so `verify` reported a
companion (`japan2026`) that could never connect. The stale row was closed by
hand at `2026-09-18 20:32:42+00` with `closed_reason='trip_destroyed'`; there
are now exactly two open bindings and both belong to the live trip. The last
relay restart's log still shows the 40 s penalty it caused
(`relay.gateways_awaited … missing:["japan2026"] waited_ms:40001`), because that
line predates the fix. **The root cause (#105) is still open and not on `main`.**

### 1.2 PR #109 — the only open PR based on `main`

`gh pr list --state open` returns 8 PRs. Seven are based on
`integration/sprint-6` (out of scope). One is based on `main`:

| PR | Head | Base | Files | Size | Mergeable |
|---|---|---|---|---|---|
| #109 `fix(intake): retain ticketed attraction confirmations` | `42487a7` | `main` | `control-plane/api/src/interview.ts` (+2/−2), `control-plane/api/test/extract-intake-prompt.test.ts` (+7/−3), `control-plane/worker/tests/test_transformer.py` (+2/−2) | +11 / −7 | MERGEABLE |

What it actually changes, in `INTAKE_QUESTIONS`, question `travel_anchors`:

- the **prompt** goes from "Any flights, hotels, or cars already booked?" to one
  that also names "ticketed attractions, tours, activities, events, shuttles, or
  parking" and asks for "its confirmation, order, or booking code";
- the **`dataExample`** type goes from `"activity"` to `"attraction"`.

No migration. No schema bump. No file added or renamed under `site/`, `server/`
or `shared/`, so **no new release is needed** and `artifactDigest` is untouched.

### 1.3 An unplanned change that is already on production

`scripts/bootstrap-document-store.sh` is present on the production VM as an
**untracked** file in `/opt/kinerary`, and was run there today (the mount and
`.kinerary-document-store` marker are dated `Sep 19 18:02`–`18:04`). That script
exists on **no** branch this assessment covers: not `main`, not
`integration/sprint-6` — only on `origin/feat/document-store-bootstrap`, which
has no PR. It is Sprint 6 document-intake groundwork applied to production ahead
of the code that uses it. Its effect is in §3.2.

---

## 2 — Risk table

| # | Change | Surface (§2 of the agent contract) | Blast radius | Migration? | Compat break? | Risk | Test | Min | Batch? |
|---|---|---|---|---|---|---|---|---|---|
| A | `main` @ `810795a` → production | — | — | none | none | **none — already deployed**. `upgrade main` is a no-op | `kinerary-cp-release status` (done) | 0 | n/a |
| B | Live trip still pinned to `release_ee61…` (`8f4d4e1`), missing `db93228` (auth on `POST /api/upload`) | `server/` → a **release**, then a per-trip redeploy | The one live trip, mid-flight. Anyone who knows the hostname could push files into that family's Immich library with the site's own API key, and multer would read up to 200 MB into memory first | no | no | **Highest in this document.** Currently masked by a proxy 403, not fixed | `boundary-reviewer` with real request/response, before and after a redeploy | 20 | **isolated** — security path |
| C | #109 prompt/example change | `control-plane/api/src/` — but imported by `relay/poller.ts` and `interpret.ts`, so it lands in the **relay** too | Every *future* interview. Zero effect on any existing intake version (immutable) or any built trip | no | no — `_ANCHOR_TYPE_MAP` already maps `activity`→`attraction` **and** `attraction`→`attraction` | Low blast radius, but it is a model-facing prompt, so it is non-deterministic | prompt + transformer files (measured below), then ≥2 interview walks | 4 + walks | ride-along on one interview run, see §5 |
| D | #109 widens the prompt's vocabulary past the alias map | worker `transformer.py` | A booked shuttle/parking/event is filed as booking type `other`, not `attraction` | no | **partial** — `shuttle`, `parking`, `event` are absent from `_ANCHOR_TYPE_MAP`; `.get(anchor_type, "other")` catches them | Cosmetic: the confirmation and the date are kept, and the day plan still gets it (`_NON_ITINERARY_ANCHORS` excludes only `hotel`, `car`, `proposal`) | one added transformer case | 5 | isolated (a unit test, not a run) |
| E | NFS mounted on VM 110 (`/srv/kinerary-nfs`) | host/infrastructure, outside every row of the table | **Every live trip's companion**, and every future upgrade | no | n/a | **Blocks the release tool outright**; and a hung NFS server can stall the VM that every companion and the relay run on, while a family is mid-trip | `kinerary-cp-release status` (done — reports ✗) | 0 to read, ~5 to undo | **isolated — decision, not a test** |
| F | #105 root cause (binding against a torn-down trip) unfixed on `main` | `control-plane/api/src/` | Recurs the moment a message lands in a group whose trip was torn down: red `verify` forever + 40 s on every relay restart | no | no | Medium; the workaround is one hand-edited row | a regression test at the binding write path | 30 to write | not part of this deploy |

---

## 3 — Migration and compatibility findings

### 3.1 Migrations: nothing pending, and nothing to rehearse

Production is at `0051_trip_person_links.sql`; `origin/main` ends at the same
file. `applyMigrations` has nothing to do. #109 adds no migration.

Two things worth recording anyway, because they will matter the next time:

- **`0051` carries no `-- rollback:` header on `main`**, and the tool treats an
  undeclared migration as *breaking*. That is not a live problem: `0051` is in
  the `GRANDFATHERED` set in `control-plane/api/test/migration-rollback.test.ts`,
  whose comment is explicit — "All of them are applied on every deployment and
  below every rollback target, so no rollback can ever cross one." The header
  *is* added on `integration/sprint-6` (`60ab9d0`), which is out of scope here.
- **`migrations.test.ts` asserts the literal ordered file list.** Since this
  deploy adds no migration, a failure in that file is a *real* failure, not the
  expected one. Do not wave it through.

The next upgrade that *does* carry a migration inherits the `--restore-db`
refusal condition: it is refused once a trip has reached `provisioning` or
later, a job has run, or a Hermes profile has appeared since the dump. With a
live trip and an active companion on the box, assume `--restore-db` will be
refused and that the cheap way back is code-only `rollback`.

### 3.2 The blocker: `kinerary-cp-release upgrade` will refuse

`sudo kinerary-cp-release status` on VM 110, this run:

```
── Storage ──
  ✓ nvme-vmdata/data: data 30.59% meta 20.34% size 906.17G vg_free 47.47G
  ✓ backups go to /var/backups/kinerary-cp on local ext4, never NFS
  ✗ this VM has network filesystems mounted (/srv/kinerary-nfs) — a snapshot freeze could hang on them
  ✓ / has 27.5 GB free (need 10.0 GB)
  ✓ 1 backup dir(s), 0.07 GB
```

That ✗ is not advisory. In `vm-release.py`:

```python
netfs = self.sh.text(["findmnt", "-rn", "-t", "nfs,nfs4,cifs,smb3,fuse.sshfs", "-o", "TARGET"]).strip()
if netfs:
    self.r.fail(f"this VM has network filesystems mounted ({netfs…}) — a snapshot freeze could hang on them")
```

and `cmd_upgrade` runs `cp.guard_storage(...)` then `cp.refuse_if_failed("nothing was changed")`
in **stage 1/5 Prepare**, before images are even built. So today, and until the
mount is removed:

- `kinerary-cp-release upgrade <rev>` → **Refused**
- `kinerary-cp-release upgrade <rev> --dry-run` → **Refused** (the dry run runs
  every guard for real)

The mount is `192.168.0.171:/mnt/nvme_pool/NFS` on `/srv/kinerary-nfs`, `nfs4`,
**`hard`**, and it is in `/etc/fstab` with `_netdev`, so it comes back on every
reboot. `docs/control-plane-vm-deployment.md` gives the reason the VM had none:
"It is deliberately not the NFS: the VM mounts none, a hung mount would freeze
every companion at once, and the trip folders hold every family's live site data
inside a container all companions share." With `hard`, a TrueNAS outage does not
return an error — it blocks, indefinitely, inside a VM that is currently hosting
a mid-trip family's companion and the relay that carries their Telegram messages.

One mitigating detail, read from the code rather than assumed:
`guard_checkout_clean()` runs `git status --porcelain --untracked-files=no`, so
the untracked `bootstrap-document-store.sh` does **not** by itself block an
upgrade. Only the mount does.

### 3.3 Compatibility, other than SQL

- **Release seal.** `PAYLOAD_ROOTS = ["site","server","shared"]`
  (`release-artifact.ts:24`). `git diff --stat cea047d..origin/main -- site server shared`
  is **empty**: no commit on `main` after `cea047d` touches the payload. So the
  newest `available` release `release_276dcf8beebcd18e442d8501a0fe33d8`
  (rev `cea047d650`, created 2026-09-16 21:47 UTC) *is* current `main`'s trip
  runtime. #109 does not change that. **No release needs to be built or promoted
  for this deploy.**
- **Intake schema.** All 13 releases in the pool are `available` with
  `data_schema_min=1, data_schema_max=3`; the live trip's intake versions are
  `schema_version=3`. #109 does not bump the intake schema, so the
  `release_accepts_intake_schema_vN` ritual does not apply.
- **Two producers, one shape.** `travel_anchors` reaches `transformer.py` from
  both paths. `_read_anchor()` handles the agent's `{type, detail}` free text and
  the interpret path's `{type, name, date, confirmation, time}` structured shape.
  #109 only changes the *value* of `type` the prompt suggests, and both `activity`
  and `attraction` are in `_ANCHOR_TYPE_MAP`. **Old intake versions keep working**
  — which matters because `intake_versions` rows are immutable and a
  re-provision reads them back.
- **`trip.config.json` on a live site** is untouched by #109.
- **Fail-safe defaults.** #109 touches nothing in `shared/needs-schema.js` or
  `shared/agent-schema.js`. Item B (the upload auth fix reaching the live site)
  *is* a security path and goes to `boundary-reviewer`, not here.
- **Relay env.** Read inside `kinerary-cp-relay-1`: `INTERPRET_PATH_DEFAULT=1`,
  `INTERPRET_RUNNER=claude`, `INTERPRET_MODEL=claude-sonnet-5`,
  `EXTRACT_RUNNER=claude`, `EXTRACT_MODEL=claude-sonnet-5`, `TELEGRAM_API_ROOT`
  empty. **`INTERPRET_EFFORT` / `EXTRACT_EFFORT` are not set** — effort comes
  from `CLAUDE_CONFIG_DIR` per the runbook, which is correct today but is the
  inherited-settings failure mode the repo already paid for once. `47c99eb`
  (explicit per-task effort) is deployed; the env is not using it.

### 3.4 Deploying #109 alone: what it actually takes, and what it costs the live trip

This is now the *only* deploy on the table, so it is worth being exact. All of
this is read off `control-plane/deployment/vm-release.py`, not inferred.

### The tool: installed, current, and already exercised — correcting the record

Two standing claims are wrong and both would change the plan if believed:

| Claim | Reality, read this run |
|---|---|
| "`kinerary-cp-release` is not installed on the VM" | **It is installed**, at `/usr/local/sbin/kinerary-cp-release` (+ `kinerary-cp-release-gate`), dated 2026-09-18 20:19. `/usr/local/**bin**/` is the wrong path to check — the file's own docstring says `sbin`. `sudo kinerary-cp-release --help` and `status` both run. |
| "It has never been exercised on this VM" | **It has.** `/var/lib/kinerary-cp-release/history.tsv` holds a `baseline` install row and the `cc63dab → 810795a` upgrade; `/var/backups/kinerary-cp/20260918T202406Z-cc63dab-to-810795a/` holds `db.dump`, `db.counts.json`, `hermes-data.tar.gz` (70 MB) and the outgoing `vm.env`; and the Proxmox snapshot `pre-810795a-202609182024` exists. The upgrade itself was clean; only stage 5 `verify` went red, on issue #105. |

The installed copy is **byte-identical to `main`**:

```
52520d7726db70595284c622781cd2ec382d3ff3b43f19beba380225c9d53f67
  /usr/local/sbin/kinerary-cp-release
  /opt/kinerary/control-plane/deployment/vm-release.py
  origin/main:control-plane/deployment/vm-release.py
```

One thing that *is* fragile and worth a line in the runbook:
`install_tool_files(cp, quiet=True)` runs **only after a successful verify**
(`cmd_upgrade`, stage 5). The 2026-09-18 upgrade ended `verify-failed`, so the
installed tool was never refreshed from the newly deployed tree. It matches today
by luck, not by mechanism. **After any upgrade that ends `verify-failed`, compare
`sha256sum /usr/local/sbin/kinerary-cp-release` against the deployed tree's
`vm-release.py` before trusting the next run.**

**The agent gate is not wired.** `/etc/sudoers.d/` holds only `90-cloud-init-users`
and `README` — there is no `cprelease ALL=(root) NOPASSWD: …` line. So the
`trip-monitor` request/approve path from #84 does not exist on this VM yet; every
upgrade and rollback is a human at a root shell. That is a safe default, and it
should be a recorded state rather than a surprise the first time somebody asks
the agent to do it.

### What #109 rebuilds and restarts

`control-plane/api/src/interview.ts` is in the api package, and `INTAKE_QUESTIONS`
is imported by `app.ts`, `chat-router.ts`, `interpret.ts`, `intake-copy.ts`,
`intake-correction.ts`, `relay/poller.ts` and `relay/internal-leak.ts`. So it is
compiled into both the `api` image and the `agent-runtime` image (the api image
plus the `claude`/`codex` CLIs). The two changed test files are tests only — the
worker's runtime code is untouched, though its image is rebuilt anyway.

`start_switched()` is the whole restart, in this order:

```python
compose up -d --wait --remove-orphans api worker interview-mcp companion-mcp
    # describe: "downtime: none for trips"
vm-relay-restart.sh --force-live            (KINERARY_RELAY_READY_SECONDS=120)
    # describe: "downtime: the Telegram bot pauses; messages wait at Telegram"
# hermes: only if HERMES_REV changed — otherwise "Hermes untouched —
#         companions and site AI features keep running"
```

**There is no lighter path, and you should not invent one.** A hand `docker
compose up -d api` skips the snapshot, the dump, the history row and the guards,
and the history row is what makes `rollback` able to find its way back at all.

### What that costs the live trip, on day 2 of 16

- **`HERMES_REV` does not change for #109**, so Hermes is untouched and the
  companion's gateway is not restarted. `start_switched` says so explicitly.
- **The trip's website: nothing.** It is its own LXC on its own pinned release.
- **The bot pauses** for `vm-relay-restart.sh`. The relay waits for the live
  trip's companion to reconnect before polling; messages sent in that window wait
  at Telegram rather than getting an error. With the #105 ghost binding closed on
  2026-09-18, the expected gateway set is now exactly
  `["japantokyohakonekyotoosaka2026"]`, so the wait should be short rather than
  the full 40 s the last restart paid.
- **`--force-live` is passed by the tool**, which means the relay's own refusal
  to restart under a live conversation is *overridden* during an upgrade. That is
  the one place the deploy can genuinely drop a turn. Mitigation is scheduling,
  not a flag: today no session is `awaiting='machine'`, but the family is on
  their trip and may be mid-message at any hour. **Check
  `awaiting='machine'` within five minutes immediately before, and pick a window
  the organizer has been told about.**
- **Net benefit to this family: zero.** #109 changes a prompt used when an
  interview *starts*. Their interview was confirmed 2026-09-15. They get the bot
  pause and none of the fix.

### #109's rollback story

- **Verdict: `compatible`, unconditionally.** `classify_migrations(files - applied, …)`
  is computed over migrations `main`+#109 carries that are not applied — the empty
  set. With no new migration, `cmd_upgrade` records `rollback: "code-only rollback
  keeps the database"` and the way back is plain `kinerary-cp-release rollback`:
  previous images and checkout, newer database kept, ~1 minute bot pause, no data
  lost.
- **`--restore-db` is neither needed nor likely available.** It is refused once a
  trip reached `provisioning` or later, a job ran, or a Hermes profile appeared
  since the dump. Provisioning is ON for a real organizer, so assume refusal.
- **The point of no return is `start_switched`.** Everything before it —
  checkout, `vm.env`, `migrate` — is undone automatically on failure, and with no
  migration there is nothing for `migrate` to fail at.
- **`vm-restore-snapshot.sh` is the third tier** and is for Docker/OS/Hermes image
  damage only. It refuses when a trip was built since the snapshot, and it must be
  run from the Mac by a person.
- **Prerequisite, again:** none of the above can start while `/srv/kinerary-nfs`
  is mounted, because the snapshot that `rollback` would later need is never taken
  — `guard_storage` refuses in stage 1/5. **Removing the mount is what buys #109 a
  way back**, not any property of #109 itself.

### Verdict on deploying #109

Merge it; do not spend a relay restart on it by itself. Let it ride the next
upgrade that has its own reason to restart the relay — by which time the NFS
mount will have had to be resolved anyway, because nothing can be deployed until
it is.

---

## 4 — Live-fleet impact

Read from the production control plane (read-only, via the fleet monitor's MCP
and read-only `psql`), 2026-09-19.

### 4.1 The fleet

47 trips. **Exactly one is live.**

| Trip | State | Live now? | Pinned release | Site |
|---|---|---|---|---|
| `japan-tokyo-hakone-kyoto-osaka-2026` (`trip_66617c87099572fc766c282a5761d55b`) | `ready_private`, reachable | **YES — mid-flight** | `release_ee61ecd6c2e5c3633101fb5d11fd6d00` = rev `8f4d4e1672` | `https://japan-tokyo-hakone-kyoto-osaka-2026.ara-united.store` → HTTP 200 |

Everything else: 3 `draft` prospects, 2 `intake_confirmed` that were never built
(2026-09-11), 1 `intake_in_progress`, and ~40 `retired-*`. No jobs queued,
leased, running or waiting. Six unfinished interview sessions, all
`awaiting='person'`, idle 5–8 days — **no interview is awaiting the machine**, so
a relay restart today would not drop a turn.

**The live trip is running right now.** Its confirmed intake (version 3,
`schema_version` 3, confirmed 2026-09-15 21:17 UTC) says
`departure_date = 2026-09-18`, `return_date = 2026-10-03`. Today is 2026-09-19:
**day 2 of 16.** `shift-trip-dates.py` would refuse to touch this trip, and so
does this plan.

Its companion is alive: profile `japantokyohakonekyotoosaka2026`, gateway
`gateway-japantokyohakonekyotoosaka2026` running as an s6 slot in the Hermes
container, connected to the relay. Two open bindings — a private chat since
2026-09-15 20:29 UTC and the **family group** since 2026-09-16 13:14 UTC. One
organizer linked, verified via `interview_chat`.

Relay: `relay.bot_identity username=Kinerary_bot`, `relay.ready … polling:true
routing:"exact"`, no `409`. The Mac stack is up (api, worker, postgres, mounting
`/Users/elul/kinerary/.claude/worktrees/sprint-6-integration`) but **has no relay
container**, so there is no second `getUpdates` loop on either token right now.

`PROVISIONER_COMPUTE_ENABLED=1` on the VM — **provisioning is ON**, as memory
says, for a real organizer, since 2026-09-14. `PROVISIONER_VMID_MAP={}`.

### 4.2 What could not be read, and what it would take

- **CT200 `trip-usa2026`** — real production that no control plane tracks. The
  Proxmox host read (`ssh root@192.168.0.40 pct list`) was **denied by this
  session's sandbox**, so its container state is unverified. Public probe says
  it is not published on `ara-united.store` (only the japan trip answers 200;
  `japan-2026-test` returns 502; seven other historical hostnames do not
  resolve). To size it: one `pct list` on the Proxmox host, plus a LAN GET of
  its site. **Until that is read, treat CT200 as a live site running an unknown
  release, outside every guard in this document.**
- **The NPM rule set** — `NPM_API_TOKEN` in `provisioning.env` expired
  2026-08-29, and minting a new one is a write this run did not do.

### 4.3 Split the delta by who actually gets it

**(a) Control-plane changes — everyone, at restart.** Nothing pending. All of
`main` is live. When #109 lands, it reaches everyone at the next api + relay
restart, and its only effect is on interviews that start afterwards.

**(b) Trip-runtime / site / companion — reaches nobody until a named trip is
redeployed.** This is the live one:

> The live trip is pinned to `release_ee61…` (`8f4d4e1`). The *only* payload
> change between that release and the newest `available` release
> `release_276dcf8b…` (`cea047d`) is `server/server.js`, +8/−1 — the auth fix
> from `db93228`:
>
> ```js
> -app.post('/api/upload', upload.array('files'), async (req, res) => {
> +app.post('/api/upload', authRequired, upload.array('files'), async (req, res) => {
> ```
>
> **`japan-tokyo-hakone-kyoto-osaka-2026` is still serving the unauthenticated
> route.** Probed read-only this run: `GET /` → **200**, `GET /api/upload` →
> **403**. A 403 on a route the app has no GET handler for is the proxy
> answering, not the app — the NPM block from 2026-09-17 is **still the only
> thing standing between that family's photo library and the open internet**.
> Memory's "blocked at NPM instead of redeployed" is the standing state,
> confirmed today. To actually fix it, that trip has to be **redeployed onto
> `release_276dcf8b…`** — and that is a redeploy of a site a family is using on
> day 2 of their holiday.

**(c) Provisioning changes — only trips minted after the deploy.** #104's
bridge-reachability check, #96's organizer-from-roster, #101's natural-language
boundary replies and #109's prompt all fall here for practical purposes: they
change what a *new* trip or a *new* interview gets. The live trip already exists;
none of them retroactively repair it.

### 4.4 What the family would actually notice

| Window | What a traveller/organizer sees |
|---|---|
| During an upgrade (if one happened) | **The website: nothing.** Trip sites are their own containers and are not touched. **The bot pauses** for the relay restart. Because the relay waits for live companions to reconnect before polling (`RELAY_GATEWAY_WAIT_SECONDS`, default 40), messages sent in that window **wait at Telegram** rather than erroring. With the ghost binding now closed, the wait should be short rather than the full 40 s. |
| After | Nothing, for an existing trip — control-plane code does not rewrite a built site. #109 changes only interviews that start later. |
| If it goes wrong mid-trip | The failure that reaches them is **the companion going quiet**, not the site going down. Three ways that happens: (1) Hermes restarts and a gateway does not come back; (2) the relay comes up but the companion does not reconnect, and messages queue; (3) **the NFS server stalls**, and with `hard` the VM blocks — relay, sidecars and every companion at once, with no error to anybody. (3) is new as of today and is the one this plan asks you to remove. |
| Never in this window | The site itself. It is an LXC on its own release, and nothing in this change set redeploys it. That is also exactly why the upload fix has not arrived. |

---

## 5 — The plan

Nothing here deploys, promotes a release, or restarts anything. Steps 1–3 are
already done in this run and their results are above.

### Run 0 — establish the ground (done, 0 min for you)

Already read: VM revision, images, `readyz`, schema, release history, snapshots,
storage, trips, bindings, jobs, interviews, relay identity, release pool, live
site response codes. Nothing below re-reads it.

### Run 1 — the merge gate for #109 (**~4 minutes, batched, nobody present**)

All four ride on one invocation each; they are disjoint and all cheap.

```bash
cd /path/to/a/checkout/of/42487a7
npm test --prefix control-plane/api                       # no DB → DB suites skip
cd control-plane/worker && PYTHONPATH=.:../.. python3 -m unittest discover -s tests
cd ../../tests && npm test
```

Checklist, each item named to the change it belongs to:

1. `test/extract-intake-prompt.test.ts` — **31 tests**, including the two #109
   rewrote: `travel_anchors` example type is exactly `attraction`, and the prompt
   names all six categories. *(change C)*
2. `test/interpret*.test.ts` — no regression from the prompt text. *(change C)*
3. `tests/test_transformer.py` — the anchor cases now typed `attraction` still
   produce booking rows of type `attraction`. *(change C)*
4. `test/migrations.test.ts` and `test/migration-rollback.test.ts` — must be
   green. **This deploy adds no migration, so any failure here is real.** *(§3.1)*
5. trip-site suite — unaffected by #109; run it to keep the baseline honest, and
   apply the flake rule below.

**Flake rule, do not skip it:** the `tests/` suite runs at
`--test-concurrency=4` and is known flaky — two consecutive full runs on
2026-09-18 each failed exactly one *different* test. A single red test is not
yet a regression. Re-run, then run the file alone. Never raise a timeout as the
fix. A failure that survives isolation is real.

### Run 2 — DB-backed control-plane suites (**minutes, nobody present**)

```bash
CONTROL_PLANE_TEST_DATABASE_URL="postgres://postgres:test@127.0.0.1:5434/cptest" \
  npm test --prefix control-plane/api
```

- **Name your own test database.** Every DB-backed suite opens with
  `DROP SCHEMA IF EXISTS control_plane CASCADE`; on 2026-09-06 it was handed the
  dev stack's real database and destroyed it. `test/support/test-database.ts`
  refuses a name that does not say "test".
- **`cptest` is shared between sessions.** A `42P01` on `schema_migrations`
  mid-`applyMigrations` means another run reset it. Re-run the file alone before
  costing a fix.

### Run 3 — the interview walk for #109 (**isolated from everything else; a person or `--auto`**)

#109 is a **prompt**. One green run is one sample of a model's behaviour, not a
proof. Do **not** fold this into an unrelated e2e run: the observable is "what
did the model put in `travel_anchors`", and a second change that also touches the
interview would make a green run ambiguous.

On the **Mac** (never the VM — see §5.1):

```bash
scripts/preflight-deploy.sh --deploy --auto --scenario japan --cleanup
scripts/preflight-deploy.sh --deploy --auto --scenario manual --cleanup
```

Two scenarios, minimum, because the paths differ: `japan` sends a booking PDF
(exercises `extract`), `manual` types every answer (exercises `interpret`).

**Do not assert through the UI. Assert on the column** — this is the repo's own
silent-failure class, and a direct read is nearly free:

```sql
-- which path actually ran
SELECT id, interpret_path, language FROM control_plane.intake_sessions
ORDER BY created_at DESC LIMIT 3;

-- what the prompt actually produced
SELECT version, data->'travel_anchors' FROM control_plane.intake_versions
ORDER BY created_at DESC LIMIT 1;
```

Checklist:

1. `interpret_path` is `t` on the new session — otherwise you measured the agent
   path and #109's prompt was never used.
2. At least one anchor exists and its `type` is one of the alias-mapped values.
   `attraction` is the expected one.
3. The `confirmation` survives into the site's bookings row. **This is the whole
   point of #62** — a ticketed attraction losing its order code is the bug.
4. A dated anchor lands on a day: `derive_days_from_anchors` excludes only
   `hotel`, `car`, `proposal`, so `attraction` must appear in the phase's day
   plan at its `HH:MM`.
5. Note whether the model ever answers `shuttle`, `parking` or `event` now that
   the prompt invites them — those fall to booking type `other` (§2 row D).

**Cost:** an `--auto --scenario japan --cleanup` run is a deploy of the Mac
stack plus one provision; budget tens of minutes each and treat the number as an
estimate — this run did not measure it. The documented all-scenarios figure is
**~80 minutes** (`docs/e2e-full-test.md:39`).

### Run 4 — the upload-auth boundary check (**isolated, security path, ~20 min, a person**)

Route to `boundary-reviewer`. "It came up in the e2e run" is not evidence here.
Required: the actual request and response for `POST /api/upload` on
`japan-tokyo-hakone-kyoto-osaka-2026`, **with and without** a family member's
JWT, before and after any redeploy — plus the same against a trip built from
`release_276dcf8b…`, to show the code refuses it rather than the proxy.
Note for the reviewer: `authRequired` accepts a family JWT *or* the agent API
key and is **not** an organizer check.

### 5.1 Interlocks — read these before scheduling anything

- **The VM and the Mac share Proxmox, NPM, Cloudflare and the tunnel**, and
  derive the same slug from the same scenario. Two runs must never overlap. Ask
  for a window.
- **The `japan` e2e fixture collides with the live trip** — same cities, and its
  dates now overlap a trip that is running. Slug derivation is nondeterministic
  and there is no guard in code. **Prefer `manual` and `multi` for anything that
  provisions**, or run `japan` only with `--stop-after confirm`.
- **One bot per stack.** The VM owns `@Kinerary_bot`; the Mac's relay owns
  `@Tripinterviewer_bot`. The Mac currently has no relay container running —
  starting one for a test run is fine on `@Tripinterviewer_bot` and is an
  incident on `@Kinerary_bot`.
- **Provisioning is ON on the VM for a real organizer.** Any VM run needs a
  human's yes first, and the test scripts switch provisioning off on exit, which
  would switch it off *for that organizer*.
- **Never run `scripts/e2e-full-cycle.py` against the VM without its VM
  switches** — its `--auto` mode repoints the relay by calling the *Mac's*
  `relay-restart.sh`.
- **On the VM, restart the relay only with
  `control-plane/deployment/vm-relay-restart.sh`**, never `scripts/relay-restart.sh`.
- **No interview is awaiting the machine right now**, so the relay's live-turn
  refusal would not fire today. Re-check immediately before, not from this page.

---

## 6 — Budget

Measured this run, on the Mac, in the `sprint-6-integration` worktree
(so the counts are that tree's, not `main`'s — the *durations* are what matters
here and they are real):

| Run | Command | Measured 2026-09-19 |
|---|---|---|
| trip-site suite | `cd tests && npm test` | **483 tests, 0 fail, 52.0 s wall** |
| control-plane API, no DB | `npm test --prefix control-plane/api` | **1191 tests: 799 pass, 392 skipped (DB suites), 0 fail, 15.9 s wall** |
| control-plane API unit subset | `npm run test:unit --prefix control-plane/api` | **23 tests, 1.0 s** |
| #109's prompt file alone | `node --import tsx --test test/extract-intake-prompt.test.ts` | **31 tests, 0.2 s** |
| #109's transformer file alone | `python3 -m unittest tests.test_transformer` | **166 tests, 0.1 s** |
| full e2e on the real stack | `docs/e2e-full-test.md` | **~80 min** (documented, line 39 — not measured here) |
| DB-backed control-plane, worker, guardrails | `scripts/test-control-plane.sh` | not measured this run — **estimate**, minutes |
| `scripts/preflight-deploy.sh` (no deploy) | as written | not measured this run — **estimate**, tens of minutes |

**Minimum gate — merge #109:** Run 1. **~4 minutes, hands off.** That is the
whole automated cost of this change set, because the deploy delta is empty.

| Tier | Adds | Buys |
|---|---|---|
| **Gate** (Run 1) | ~4 min | The contract change is internally consistent and nothing on `main` regressed. Enough to merge #109. |
| **+ Run 2** | minutes | Migration ordering and the rollback-contract rule stay green on a real Postgres. Cheap insurance; the only reason to skip it is that no migration changed. |
| **+ Run 3, one scenario** | tens of min | One sample that a real model, given the new prompt, actually emits an anchor whose confirmation survives to the site. Without this you are shipping a prompt nobody has watched a model answer. |
| **+ Run 3, two scenarios** | double | A second sample. A prompt is non-deterministic; one green run is one sample, and #62 exists because the previous prompt was wrong in a way one run would not have shown. |
| **+ Run 4** | ~20 min + a person | The only thing that tells you whether that family's upload route is protected by code or by a proxy rule somebody could remove. **This is not optional; it is just not gated on #109.** |
| **+ full e2e on the VM** | ~80 min + a person + a window + provisioning ON for a real organizer | Proves the whole chain on production hardware. **Recommended against this week**: the fixture collides with the live trip, provisioning is on for a real organizer, and a family is mid-holiday. There is nothing in this change set that needs it. |

---

## 7 — Go / no-go, and the way back

### Should #109 be merged, and should it ride this deploy?

**Merge it. Do not deploy it this week — hold it for the next upgrade window,
after the NFS mount is resolved.** Reasons, in order:

1. **It is correct and backward compatible.** `_ANCHOR_TYPE_MAP` already contains
   both `activity → attraction` and `attraction → attraction`, so old immutable
   `intake_versions` rows keep transforming exactly as before and a
   re-provision of any existing trip is unaffected.
2. **It cannot ride anything today**, because there is nothing to ride: `main` is
   already deployed, and `upgrade` refuses while `/srv/kinerary-nfs` is mounted.
   Deploying #109 alone means paying a relay restart — a bot pause for a family
   on day 2 of their trip — to change a prompt that only affects interviews that
   have not started.
3. **It is a prompt, so it deserves more than one run**, and the cheapest place
   to get those runs is the Mac, not production.
4. **It should not be batched with anything that also touches the interview.**
   It is the only open PR on `main`, so that is easy today. When Sprint 6 lands,
   it must not be the same run as #92 (document intake) or #95 (invite links).

**Go conditions for merging #109:** Run 1 green (after the flake rule);
`migrations.test.ts` and `migration-rollback.test.ts` green; at least one Run 3
scenario showing a confirmation surviving to a booking row.

**No-go — stop and do not deploy anything to VM 110 while any of these hold:**

- `/srv/kinerary-nfs` is still mounted (the tool will refuse anyway, so a deploy
  attempt means somebody bypassed it by hand — which is the real risk);
- any interview session has `awaiting='machine'` updated within five minutes;
- any job is `queued`, `leased`, `running` or `waiting`;
- the live trip is within a travel day you care about and nobody has told the
  organizer;
- `kinerary-cp-release status` shows a `switching` row that never finished.

### The way back

- **Snapshot and dump are taken by the tool itself**, in stage 3/5, before the
  switch, and the storage/snapshot preflight runs before that. There is nothing
  for a human to remember — which is exactly why the preflight refusing is a
  blocker to fix, not a guard to route around.
- **Cheapest way back:** `kinerary-cp-release rollback` — code-only, keeps the
  newer database, ~1 minute bot pause. Valid whenever every migration since is
  declared `compatible`. With **no** pending migration, a rollback of a
  `main`+#109 deploy is unconditionally in this tier.
- **`rollback --restore-db`** loses DB writes since the dump and is **refused**
  if a trip reached `provisioning` or later, a job ran, or a Hermes profile
  appeared. With provisioning ON for a real organizer, assume it will be refused.
- **`vm-restore-snapshot.sh`** (from the Mac, a person only) is for Docker/OS/
  Hermes image damage. The last release snapshot is `pre-810795a-202609182024`
  (0.9 days old at this run). There is also a hand-made `Baseline` snapshot, 3.0
  days old, which the tool never prunes and which counts against the thin pool's
  worst case — delete it when it is no longer wanted.

---

## 8 — What would reduce the risk

Ranked by risk removed per minute spent.

1. **Unmount `/srv/kinerary-nfs` on VM 110 and take it out of `/etc/fstab`
   (~5 min).** It arrived today from a branch with no PR, it is `hard`-mounted
   in a VM the runbook says must mount no network filesystem, it blocks every
   future `kinerary-cp-release upgrade` at stage 1/5, and if TrueNAS stalls it
   blocks the relay and every companion while a family is mid-trip. If the
   document store genuinely needs it, that is a Sprint 6 design decision that has
   to come with an answer for the snapshot guard — not a mount added ahead of the
   code. **Highest value item in this document.**
2. **Redeploy `japan-tokyo-hakone-kyoto-osaka-2026` onto
   `release_276dcf8beebcd18e442d8501a0fe33d8` (rev `cea047d`) — with the
   organizer told first (~20 min + a person).** That is the only way the upload
   auth fix reaches the one family who has the bug. The payload delta is a single
   file, `server/server.js` +8/−1, so this is about as small a site redeploy as
   exists. The NPM 403 is a good mitigation and a bad fix: it lives in a system
   with an expired API token and no test asserting it. Until this is done, treat
   the trip as running unpatched code.
3. **Add `shuttle`, `parking` and `event` to `_ANCHOR_TYPE_MAP` in the same PR as
   #109 (~5 min).** #109's prompt now invites exactly those three words, and the
   map does not know them, so they silently become booking type `other`. Fixing
   it at the map is a fix at the source; adding one transformer test case turns a
   silent mis-categorisation into a red test. Cheapest risk removal on the PR.
4. **Write the #105 regression test and the guard with it (~30 min).** Refuse a
   binding whose trip is retired or past teardown. One stale row already cost a
   permanently red `verify` on production's first real upgrade and 40 s on every
   relay restart, and it was fixed by hand-editing a row. It will recur.
5. **Read CT200 `trip-usa2026` (~5 min, needs Proxmox access this run did not
   have).** `pct list` on the Proxmox host plus a LAN GET of its site. A real
   production site that no control plane tracks, running an unknown release, is
   an unsized risk — and an unsized risk is a decision, not a low risk.
6. **Set `INTERPRET_EFFORT` and `EXTRACT_EFFORT` explicitly in the VM's `vm.env`
   (~2 min).** `47c99eb` shipped per-task effort; the VM still leans on
   `CLAUDE_CONFIG_DIR`. It is correct today and it is one `docker cp` away from
   silently not being.
7. **Add a test that asserts `POST /api/upload` without auth returns 401 from the
   app (~15 min), and keep it in the trip-site suite.** The current protection is
   a proxy rule with no test anywhere. `tests/server.test.js` already pins the
   middleware *order*; what is missing is anything that would notice the proxy
   rule being removed.
8. **Nothing else.** The `main` → production step itself is genuinely zero risk,
   because it has already happened, and #109 is a small, backward-compatible,
   low-blast-radius change. Do not manufacture work for it.

---

## 9 — Decisions needed

Nothing here is guessed. Each needs a human answer.

1. **The NFS mount on VM 110.** Who mounted it, and does it stay? It is from
   `origin/feat/document-store-bootstrap`, which has no PR and is on no
   integration branch. If it stays, the snapshot guard and the "no network
   filesystem in this VM" rule in the runbook both need a decision, not a
   workaround. **Until then no upgrade can run.**
2. **Redeploying the live trip's site, mid-holiday.** Redeploying is the only way
   the upload fix reaches them; not redeploying leaves the route protected by a
   proxy rule alone. Both are choices with a cost. Only the organizer's owner can
   pick the moment.
3. **#109: merge now, deploy later — confirm.** This plan recommends merging into
   `main` after Run 1 and holding the VM deploy for the next window. If it must
   ship sooner, say so and it becomes a relay restart during a live trip.
4. **CT200 `trip-usa2026`.** Confirm whether it is still running and on what, and
   whether it is in scope for the upload auth fix. This run could not read the
   Proxmox host.
5. **Which scenarios Run 3 may use.** `japan` collides with the live trip by
   design; `manual` and `multi` do not. Confirm `manual` + `multi` is acceptable
   evidence for a prompt change that was reported against a booking PDF.
6. **Whether the Mac may start a relay for Run 3.** It would run on
   `@Tripinterviewer_bot`, which is safe by construction — but it wants a stated
   window because both stacks share Proxmox, NPM, Cloudflare and the tunnel.

---

*Live fleet read directly from production on 2026-09-19 (read-only MCP and
read-only `psql`); Proxmox host access was denied in this session and is the one
gap. Nothing was deployed, committed, restarted, or promoted.*
