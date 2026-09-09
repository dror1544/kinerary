# Kinerary k3s Home Deployment Sprint Plan

**Status:** Proposed parallel implementation track.

**Architecture source of truth:** [`k3s-home-deployment-architecture.html`](k3s-home-deployment-architecture.html)

**Relationship to existing product work:** this plan runs **in parallel** to
`onboarding-mvp-sprint-plan.md` and the existing product/onboarding sprints. It
must not renumber them, weaken their acceptance gates, or turn deployment work
into a prerequisite for unrelated product work unless a specific integration
gate below says so.

**Outcome:** Kinerary, its control plane, a dedicated Hermes AI runtime, and
provisioned trip runtimes can run reproducibly on a single-node k3s cluster
inside the home Proxmox environment. New trips are provisioned as internal
Kubernetes workloads and are exposed as `<slug>.<trip-domain>` hostnames under
one wildcard DNS record and one dedicated, in-cluster Cloudflare tunnel, so no
per-trip edge change is ever needed. The platform uses local SSD for
transactional state, TrueNAS NFS for document/blob storage, TrueNAS-backed
backups for recoverability, and Google Drive as the off-host backup copy.

**Review history:** reviewed 2026-09-04 against the live home lab (Proxmox
`192.168.0.40`, TrueNAS, RPi4) and the current code; the decisions from that
review are folded in below. The
[compatibility-break ledger](#8-compatibility-break-ledger) lists every place
the migration breaks an existing tool, script, or document, and every sprint
carries a **Compatibility flags reached** line naming the entries it hits. The
project is not in production, so reaching a flag means *stop, decide, record*
— not *blocked*.

---

## 1. Scope and non-goals

This track migrates **deployment infrastructure**, not product semantics.
Existing canonical control-plane records and safety boundaries remain the
contract. In particular:

- Kinerary remains the owner of trip identity, lifecycle, approvals, releases,
  routing, and infrastructure mutations.
- Hermes remains a critical Kinerary dependency, but does not receive direct
  Kubernetes infrastructure authority.
- The current Proxmox/LXC/SSH/NPM/Cloudflare provisioning implementation is an
  adapter to be replaced for this target environment, not a product contract.
- Existing sealed release semantics are retained and evolved toward immutable
  OCI image digests.
- New trips do **not** require new Cloudflare tunnels, DNS records, public IPs,
  or NPM proxy hosts. A trip's hostname is covered by one wildcard record.
- Kinerary's public edge does **not** depend on the RPi4 (home-lab Cloudflare
  tunnel, NPM, Pi-hole). The RPi4's shared tunnel config is never edited for
  Kinerary.

Explicit non-goals for this track:

- multi-server / HA k3s;
- replacing macOS on the old Mac mini;
- making the Mac a required production dependency;
- Vault as a required secret manager;
- Longhorn, Ceph, service mesh, ArgoCD, Flux, or a PostgreSQL operator;
- moving PostgreSQL or live SQLite files to NFS;
- one Hermes Pod or one Hermes PVC per trip unless runtime behavior later
  proves that isolation is required;
- path routing of trips under one origin (`/trips/<slug>`) — deferred to the
  unified-account product track and the `trip-web` front-end (decision 3);
- moving the `elulhome` Hermes profile (Home Assistant control) into the
  cluster. Home control stays local-first and outside Kinerary.

---

## 2. Standing architecture decisions

All sprints below must comply with the architecture document. The following
choices are already decided and should not be reopened inside an implementation
PR without an explicit architecture update:

1. **One Proxmox VM, one k3s server initially.**
2. **No parallel production Docker daemon is required.** k3s/containerd owns
   production containers.
3. **Host-based trip routing under one wildcard.** The portal lives at the
   Kinerary hostname; each trip is `<slug>.<trip-domain>`, matched by one
   proxied wildcard DNS record and Traefik `Host()` rules. Browser isolation is
   per origin, not per path: the trip site keeps its JWT in `localStorage`
   (`trip-token`/`trip-user`/`trip-lang`), so two trips under one origin would
   clobber each other's sessions and share permissions and XSS blast radius.
   Path routing (`/trips/<slug>`) is deferred until a unified account exists
   and the `trip-web` front-end (already built with a relative base) replaces
   `site/app.js`. Use a **first-level** wildcard (`*.<trip-domain>`) so
   Cloudflare Universal SSL covers it without a paid certificate.
4. **Dedicated in-cluster Cloudflare tunnel.** A `cloudflared` Deployment in
   `kinerary-system` runs its own named tunnel. The RPi4's locally managed
   `/etc/cloudflared/config.yml` (which also serves the home services) is never
   edited for Kinerary; existing trip hostnames are moved off it at cutover.
5. **Trip Services use internal Kubernetes networking.** No per-trip public IP.
6. **PostgreSQL and live SQLite use local SSD-backed PVCs.**
7. **Booking confirmations, PDFs, uploads, photos, and generated exports may use
   a TrueNAS NFS-backed RWX volume through a storage abstraction.**
8. **No standalone companion-specific PVC by default.** Companion configuration
   derives from canonical trip/profile data; durable Hermes state belongs to
   the Hermes persistence model and is tenant keyed.
9. **The Mac mini remains macOS and is optional.** Any future use must work
   without replacing macOS; production cannot depend on it.
10. **Recoverability precedes HA.** Backup/restore evidence is mandatory before
    cluster expansion work.
11. **Proxmox host preparation gates D1.** The host (i5-9400, 6 cores, 31 GB)
    has ~24.5 GB committed to guests today; the VM is created only after the
    preparation checklist in D1 frees room, and it starts at 8 GB, not 10.
12. **Dedicated Hermes runtime, after Sprint 6.5.** Kinerary gets its own
    in-cluster Hermes built from the current fork. D6 starts only once Sprint
    6.5 is merged to `main`. Documented fallback: if host resources are
    insufficient, Hermes stays on the Mac and decision 9 is suspended until
    resources allow — recorded as a deviation, never silently accepted.
13. **Container images are built in CI before anything runs in k3s.** D1.5
    precedes D2; nothing is imported into the cluster from a laptop build.
14. **Google Drive is the off-host backup copy and an optional document
    source.** Small, high-value backups (PostgreSQL dumps, trip SQLite, Hermes
    state) are copied to Google Drive. Through the storage abstraction a user
    may attach their own Google Drive as a document source for their trip; NFS
    stays the primary store.

---

## 3. Parallel-track integration model

Deployment work may proceed while onboarding/product sprints continue.
Integration should happen only at explicit seams:

| Existing product seam | Deployment-track responsibility |
|---|---|
| Control-plane API | Package and run the existing entrypoint in k3s without changing its canonical behavior |
| Worker queue | Run the worker privately and later add a Kubernetes runtime adapter |
| Release catalog | Preserve verification/promotion rules; add immutable image identity |
| Hermes interviewer / companion | Move runtime into the cluster without changing tenant/auth contracts |
| Trip runtime | Make the existing site/server correct at its own hostname behind Traefik (`trust proxy`, `PUBLIC_ORIGIN`); no path prefix |
| Provisioning approval | Replace provider execution only after the same approved durable job exists |
| Existing family trip | Use as a migration/acceptance target, never as destructive test data. No family trip is live today; `japan-2026` (CT101, dates 2026-09-19→10-03) is a **test trip** and is the migration fixture |
| Sprint 5 relay (`control-plane/api/src/relay/`, in the sprint-5 worktree only as of 2026-09-04) | D6 cannot start until it is on `main`; the relay is what lets one in-cluster gateway own the shared bot |
| Sprint 4.7 compute / persistent-data / secret adapter abstractions (still deferred) | D7 builds on them; until they land the provisioner calls `kinerary-deploy` directly |
| Sprint 6.5 | Hard gate for D6 (decision 12) |

A product sprint can merge while a deployment sprint is incomplete if its
current deployment path remains valid and no canonical contract is broken.
Likewise, deployment PRs should avoid opportunistic product rewrites.

---

## 4. Deployment sprints

### Deployment Sprint D0 — Inventory, invariants, and migration test fixture

**Goal:** remove ambiguity before changing runtime infrastructure.

Build / document:

- Inventory the current production-like Kinerary deployment and the old Mac
  Hermes installation:
  - Hermes version and launch mode;
  - profiles/skills used by interviewer, companion, and extraction flows;
  - persistent Hermes directories and credentials;
  - active trip runtime data directories;
  - SQLite/data/avatar/upload locations;
  - current public URL, Cloudflare/tunnel path, and any NPM involvement;
  - current backup behavior.
- Privilege audit — largely answered by the 2026-09-04 review; record it:
  - `privileged: true` on the `trip-server` Compose service is **dev-only**
    (`docker-compose.yml:23`, unexplained since the initial commit, no
    `devices`/`cap_add`); the production LXC runtime is systemd + nginx with no
    Docker at all. Remove it from the Compose file.
  - the real privilege dependency is the LXC itself: `pct create
    --unprivileged 0` (`provisioning/adapters.py`) because NFS uid mapping
    broke bootstrap. In Kubernetes this becomes the NFS ownership decision in
    D5 (`mapall` on the export vs a fixed runtime UID), never a privileged Pod.
- Define the intended public hostnames:
  - `<kinerary-host>/` — Kinerary web portal;
  - `<kinerary-host>/api/...` — control-plane API;
  - `<slug>.<trip-domain>/` — trip runtime (wildcard DNS, Traefik `Host()`).
- Characterize origin assumptions in the trip runtime (replaces the old
  base-path audit): `trust proxy` is never set, `PUBLIC_ORIGIN` is read only by
  `/photo/:id`, and the worker's `_private_url()` is shaped by `topology.yaml`'s
  `npm.hostname`. All three are fixed in D4.
- Select the migration fixture: `japan-2026` on CT101 is a **test trip**, not a
  family's live trip, and is the repeated migration/acceptance target.
- Define the TrueNAS dataset names and ownership model for:
  - document/blob storage;
  - application backups;
  - VM/cluster backups.

Automated evidence:

- no code behavior required yet;
- add focused tests for any discovered base-path assumptions before changing
  them.

Manual evidence:

- written inventory with no secret values;
- confirm every existing trip's data (CT101/200/201/202 `/opt/kinerary` state
  and their `/mnt/pve/truenas-nfs/<trip>` media) has a recoverable copy before
  any container is retired or migrated;
- prove a restore of at least one copied/non-production trip data set.

**Compatibility flags reached:** C6 (`tests/provisioning/` is not in CI — add
it before any adapter work), C7 (doc/skill drift starts here: list the
LXC/NPM/Cloudflare-specific references that will go stale), C11 (drop the
dev-only `privileged: true`).

**Exit gate:** no unknown privileged requirement, state directory, or public
routing dependency remains undocumented.

---

### Deployment Sprint D1 — Proxmox host preparation and k3s foundation

**Goal:** establish an empty, recoverable production-shaped cluster on a host
that actually has room for it.

**Host preparation (infra prerequisite — complete before the VM is created):**

Measured 2026-09-04 on `192.168.0.40`: i5-9400, 6 cores (no HT), 31 GB RAM,
PVE 9.0.3. Guests: HA VM 100 (2 cores/4 GB, critical), TrueNAS VM 103
(2 cores/16 GB), trip LXCs 101/200/201/202 (2 cores/1 GB each), Pi-hole CT102
stopped. ~24.5 GB committed, 16 GB in use, load 0.35; `nvme-thin` 723 GB free.

- Trim the TrueNAS VM from 16 GB to 8–10 GB (the 2.8 TB pool is 0.5% used; ZFS
  ARC adapts). Re-check Immich and NFS behaviour afterwards.
- Retire CT200 (`usa-2026`, ended 2026-07-30) and CT202
  (`los-angeles-hawaii-vegas-2026`, ended 2026-08-24) after their data and NFS
  media dirs are archived (D0 evidence). Frees 2 GB and 4 cores of commitment.
- Raise the HA VM's CPU weight (`cpuunits`) so home control never starves
  behind Hermes or PostgreSQL bursts.
- Set Proxmox startup order: TrueNAS first, the k3s VM after it with a delay
  (`startup: order=…,up=…`). Today neither VM has an order, so NFS-backed PVCs
  would race TrueNAS on host reboot.
- Leave CT102 (Pi-hole) stopped with `onboot: 0`: it holds the RPi4's `.41`
  address and would take down DNS and the home tunnel if started.
- Pick a static VM address outside the trip pool (`.60–.99`) and outside DHCP
  (`.100–.250`).

Build:

- Create `kinerary-prod` Debian VM on Proxmox.
- Initial sizing target:
  - 4 vCPU;
  - **8 GB RAM** to start (8–10 GB practical range; 10 GB only after the host
    preparation above is done and measured);
  - ~80 GB disk on `nvme-thin`, not `local`;
  - VirtIO NIC;
  - Proxmox guest agent;
  - reserved/static LAN address as above.
- Resolvers: Pi-hole (`192.168.0.41`) **plus** a public fallback. k3s CoreDNS
  forwards to the node's `resolv.conf`; with Pi-hole alone an RPi4 outage would
  take down every outbound LLM/Telegram call, and Hermes with it.
- Install k3s as a single server node.
- Create repository deployment shape:

  ```text
  deploy/
    base/
    overlays/home-prod/
  ```

- Define namespaces / tenancy choice for:
  - `kinerary-system`;
  - `kinerary-agents`;
  - trip workloads (`kinerary-trips` shared namespace initially unless a
    namespace-per-trip requirement is proven).
- Add baseline ResourceQuota/LimitRange only if they improve failure isolation
  without blocking initial bring-up.
- Establish cluster backup procedure including k3s datastore and server token.

Automated evidence:

- `kubectl apply -k` is idempotent for the empty platform baseline;
- manifest validation in CI.

Manual evidence:

- reboot VM and confirm k3s returns healthy without manual repair;
- restore cluster configuration into a disposable test VM or otherwise perform
  a documented recovery rehearsal;
- verify the Mac mini is not required for cluster health.

**Compatibility flags reached:** C1 — the first `kubectl apply` is a deploy
that `scripts/claude-hooks/match-command.py` does not recognise; extend its
`DEPLOY` pattern (kubectl apply/rollout/delete/scale/set, helm, kustomize) in
this sprint so hard rule 2 keeps applying.

**Exit gate:** an empty k3s environment can be rebuilt/recovered from documented
inputs.

---

### Deployment Sprint D1.5 — Container images in CI

**Goal:** every workload that D2 and later run comes from an image built and
pushed by CI, never imported from a laptop.

Today `.github/workflows/control-plane.yml` builds and tests but pushes no image
anywhere, and no registry login exists. Dockerfiles already exist for
`control-plane/api`, `control-plane/worker`, `web`, `server`, and `mcp`.

Build:

- A CI job that builds those images and pushes them to GHCR tagged by immutable
  revision (`sha-<rev>`), capturing each digest as a job output.
- Move `npm install --production` for the trip server into the image build
  (`kinerary-deploy/deploy.sh` runs it on the container at deploy time today).
- GHCR pull-secret as a Kubernetes Secret in each namespace that pulls.

Automated evidence:

- CI produces an image per revision; the digest is in the job summary.

**Compatibility flags reached:** C14 (release delivery moves from
tar-over-`pct exec` plus `systemctl restart` to images).

**Exit gate:** D2 can reference `ghcr.io/...@sha256:...` for API, worker, web,
and trip runtime without any local build step. Release-to-digest linkage stays
in D8.

---

### Deployment Sprint D2 — PostgreSQL, secrets, and control-plane runtime

**Goal:** run the existing control-plane entrypoints in Kubernetes without
changing control-plane semantics.

Build:

- PostgreSQL on a local SSD-backed PVC.
- One-shot migration Job using the same architecture profile as the API.
- Control-plane API Deployment + ClusterIP Service.
- Control-plane worker Deployment in non-provider-mutating mode first.
- Kubernetes Secret volumes mounted at the current file reference paths such as
  `/run/secrets/control_plane_database_url`.
- Health/readiness probes using the existing `/readyz` and worker DB checks.
- **API runs one replica with `strategy: Recreate`.** `server.ts` starts
  `startTelegramApprovalPoller` (getUpdates every 3 s) in-process; Telegram
  answers a second poller with 409, so a rolling update would briefly break
  approvals. Alternatively split the poller into its own single-replica
  Deployment.
- Run the interview MCP (`dist/interview-mcp.js`, hand-started on the Mac
  today, bound to `127.0.0.1:4311`) as a sidecar container of the API Pod with
  a configurable bind host, reachable through the API Service for Hermes.
- Migrate the PostgreSQL data from the Mac compose stack (`pg_dump` →
  restore), including `control_plane.releases` and `telegram_chat_bindings`.
- Keep PostgreSQL and worker private; only the intended API path is routable.
- Do not add Vault as a required production dependency.

Automated evidence:

- existing control-plane API tests remain green;
- existing worker tests remain green;
- boot-level tests cover the Kubernetes-targeted process configuration;
- fresh migration and upgrade migration path both pass.

Manual evidence:

- restart API/worker Pods independently;
- restart PostgreSQL Pod and confirm state survives;
- prove no database host port is exposed on the LAN.

**Compatibility flags reached:** C8 (single Telegram poller — replicas and
strategy above), C9 (interview MCP bind host and start-up), C13
(`compose.local.yml`'s `${VAR:-}` quirk disappears; every `provisioning.env`
value becomes a Secret/ConfigMap entry and must be re-checked for empty-string
assumptions).

**Exit gate:** control plane runs in k3s with the same canonical contracts and
without provider mutation enabled.

---

### Deployment Sprint D3 — Dedicated public edge and wildcard host routing

**Goal:** establish the permanent routing model before migrating trip traffic,
without touching the RPi4.

Build:

- Deploy `cloudflared` as a Deployment in `kinerary-system` running a **new
  named tunnel** dedicated to Kinerary; tunnel token in a Secret. The RPi4's
  `/etc/cloudflared/config.yml` is not edited.
- DNS in the Kinerary zone: the portal hostname and one proxied wildcard
  `*.<trip-domain>` record, both CNAMEs to the new tunnel. Tunnel ingress: the
  portal hostname and `*.<trip-domain>` → Traefik; catch-all `http_status:404`.
- Deploy the public React web SPA (`web/`, has its own Dockerfile and nginx).
- Configure Traefik routing for:
  - `Host(<kinerary-host>) && PathPrefix(/api)` → control-plane API;
  - `Host(<kinerary-host>)` → Web SPA;
  - `Host(<slug>.<trip-domain>)` → that trip's Service (added per trip by D7);
  - anything else → 404, never a default backend.
- Ensure creation of a new trip will not require a Cloudflare API call, DNS
  change, tunnel change, public IP, or NPM host: the wildcard covers it.
- Define forwarded headers, HTTPS-origin assumptions, and trusted proxy policy
  (`X-Forwarded-Proto` from cloudflared → Traefik → Pods).
- Reproduce the trivia SSE behaviour (`nginx.conf` disables buffering for
  `/api/trivia/*`); confirm Traefik streams those responses.

Automated evidence:

- ingress manifest tests where practical;
- browser/E2E test proves the portal and `/api` coexist behind the portal host
  and a dummy `test.<trip-domain>` host reaches a dummy Service;
- negative test proves internal-only services are not reachable through public
  ingress, and an unknown hostname gets 404, not another tenant.

Manual evidence:

- access Kinerary externally through the real public hostname;
- add a dummy `Host()` route and show that neither the Cloudflare zone nor the
  RPi4 tunnel config changed;
- verify per the smart-home-expert skill: `/api/health` returns the JSON
  contract at every hop, not merely HTTP 200.

**Compatibility flags reached:** C7 (the smart-home-expert skill's
`public-trip-site-ingress*.md` references and its "no wildcard tunnel routing"
rule describe the NPM model; update them — with explicit `Host()` rules and a
404 default the wildcard is safe).

**Exit gate:** the permanent edge works and is provably independent of the RPi4
before a trip is moved.

---

### Deployment Sprint D4 — Trip runtime host-routing compatibility

**Goal:** make a trip runtime correct at `<slug>.<trip-domain>` behind Traefik
and cloudflared, and produce the reusable trip runtime template.

The 2026-09-04 audit found the runtime already origin-shaped: no cookies, no
`res.redirect`, no service worker, no client router, and both login flows
(Telegram widget `data-onauth`, Google GIS ID token) are callback-free. What
remains is small and is listed here so it is not hidden in ingress config.

Build:

- `app.set('trust proxy', …)` in `server/server.js` (never set today) so
  `req.protocol` / `req.get('host')` are right behind TLS termination.
- `PUBLIC_ORIGIN` set per trip (`https://<slug>.<trip-domain>`); it feeds the
  `/photo/:id` Open Graph URLs and should also be the `canonical_site_url`
  passed to the companion profile.
- Reshape `_private_url()` in `control_plane_worker/provisioner.py` (today it
  parses `topology.yaml`'s `npm.hostname`) to derive the hostname from the trip
  record, not from a topology file.
- MCP: `mcp/mcp.js` already funnels every call through `fetchTrip()` with
  `API_BASE_URL`; point it at the trip Service. Run the per-trip `mcp.js` as a
  **sidecar of the trip Pod** (today one node process per trip on the Mac).
- Create reusable trip-runtime Kubernetes manifests/template accepting trip ID,
  slug, hostname, release image digest, state PVC, document storage reference,
  and the per-trip Secret (`JWT_SECRET`, `HERMES_API_KEY`, the **shared** bot
  token, `SEED_PASSWORD`).
- Trip Service remains ClusterIP only.
- Explicitly **not** done: base-path / `/trips/<slug>` support in `site/app.js`
  (~101 absolute-path literals). If ever needed, that work targets `trip-web/`
  (Vite, relative base) after the unified-account track.

Automated evidence:

- existing Kinerary suite remains green;
- a test runs the server behind a proxy sending `X-Forwarded-Proto: https` and
  asserts `/photo/:id` emits `https://<slug>.<trip-domain>/...` URLs;
- browser smoke test navigates multiple pages, trivia SSE, and login under
  `test-trip.<trip-domain>`;
- assert no generated absolute URL points at another tenant's host.

Manual evidence:

- `japan-2026` (test trip) works externally at its wildcard hostname through
  the new tunnel while its LXC copy is still running as rollback.

**Compatibility flags reached:** C4 (`_private_url()` / `topology.yaml`), C5
(`trust proxy` / `PUBLIC_ORIGIN`), C10 (trip MCP becomes a sidecar; the Mac's
`com.hermes.trip-mcp` launchd job and per-profile `mcp_servers` URLs change).

**Exit gate:** a trip is fully usable at its own hostname with no per-trip edge
configuration.

---

### Deployment Sprint D5 — TrueNAS document/blob storage

**Goal:** move document-like durable data to NAS storage without putting
transactional databases on NFS.

Build:

- Create dedicated TrueNAS NFS dataset/export for Kinerary documents. The
  existing export is `192.168.0.171:/mnt/nvme_pool/NFS` (LAN-wide; the
  smart-home skill doc still says `.177`); today's trip media lives there under
  `/mnt/pve/truenas-nfs/<trip>` via LXC bind mounts.
- Decide NFS ownership: `mapall` to a dedicated Kinerary UID on the export, or
  run every Pod that touches the share with that fixed UID. Kubernetes
  `fsGroup` does not chown NFS; this is what forced the privileged LXC.
- Define Kubernetes NFS PV/PVC, preferably RWX.
- Optional Google Drive document source: through the same storage abstraction,
  a user may attach their own Google Drive (OAuth, per account) as a source for
  imported itineraries and booking documents. NFS remains the primary store;
  Drive is a source and an off-host copy, never the only copy.
- Introduce or formalize an application storage abstraction for:
  - booking confirmation PDFs;
  - imported itinerary/source documents;
  - user uploads;
  - photos where Kinerary owns the binary;
  - generated exports.
- Store files under opaque trip-scoped object keys. Do not derive trusted
  filesystem paths directly from user-supplied filenames.
- Record object metadata/provenance in application state as needed without
  storing machine-specific NFS paths in canonical trip records.
- Define file limits, accepted MIME policy, deletion behavior, and retention.
- Define behavior when NFS is unavailable: core control-plane/database
  functions should remain healthy where possible while document operations
  report a clear dependency failure.

Automated evidence:

- storage adapter tests for tenant scoping, traversal rejection, missing NFS,
  duplicate upload/idempotency, and metadata handling;
- tests prove PostgreSQL and trip SQLite paths do not resolve onto the NFS
  mount.

Manual evidence:

- upload/read a sample booking confirmation through the real application path;
- snapshot the TrueNAS dataset and restore a deleted test object;
- temporarily remove NFS availability and confirm defined degraded behavior.

**Compatibility flags reached:** C11 (NFS ownership replaces the privileged
LXC; `site/avatars` is a symlink to `/nfs/<trip>/media/avatars` on today's
containers and must become a mount), C7 (TrueNAS address in the skill doc).

**Exit gate:** document/blob storage is durable on TrueNAS, tenant scoped, and
not confused with database storage.

---

### Deployment Sprint D6 — Dedicated Hermes runtime in k3s

**Starts only after Sprint 6.5 is merged to `main`** (decision 12). Hard
dependency: the Sprint 5 relay (`control-plane/api/src/relay/`, in the sprint-5
worktree only as of 2026-09-04) must be on `main`, because it is what lets one
gateway own the shared `@Kinerary_bot` while the control-plane approval poller
also runs. D7–D9 do not wait for D6: the Mac Hermes keeps serving through the
relay meanwhile.

**Goal:** give Kinerary its own in-cluster Hermes runtime as the AI plane,
without changing product authority boundaries.

What exists today (2026-09-04): `~/.hermes/hermes-agent` is a fork 9,250
commits ahead of upstream (Python 3.11 venv, vendored Node 22 plus `node@20`,
`uv`, Playwright browsers, ~100 MB of language servers, 3.2 GB total), run by
seven launchd agents, one per profile; `trip-intake` is already in relay mode
(`GATEWAY_RELAY_URL` env, `multiplex_profiles: true`); inference is entirely
cloud; the terminal toolset uses Docker images.

Build:

- Build a Hermes image from the fork's pinned revision (not an upstream image)
  with the venv, Node runtimes, `uv`, and Playwright; record the revision.
- Decide the terminal-toolset backend: k3s has no Docker socket. Options are
  disabling the terminal tool for Kinerary profiles, an in-container backend,
  or a Kubernetes sandbox; record the choice.
- Create the Hermes Deployment (**one gateway process per Pod**, one replica)
  and ClusterIP Service in `kinerary-agents`. The gateway dials out to the
  relay over WebSocket, so it needs no inbound port.
- Create a local SSD-backed PVC for `HERMES_HOME` state (`state.db`, sessions,
  memories, cron; ~1 GB for the Kinerary profiles today).
- Build the interviewer, companion, and extraction **profile bundles from
  `.agents/skills/` in Git**, not by copying `~/.hermes/profiles` from the Mac;
  secrets (`TELEGRAM_BOT_TOKEN`, provider keys, relay secret, Google OAuth
  token) as Kubernetes Secrets.
- Keep one runtime with multiple profiles (`multiplex_profile_allowlist`)
  unless real runtime constraints prove separate processes are necessary.
- Do **not** create a separate per-trip companion PVC.
- `elulhome` (Home Assistant control, `HASS_TOKEN`) stays on the Mac and is
  never given cluster secrets; `familytrip`'s legacy per-trip bot stays out
  until its trips are folded into the shared bot.
- Route Hermes access to Kinerary through constrained MCP/API contracts
  (interview MCP sidecar from D2, trip MCP sidecars from D4).
- Hermes ServiceAccount has no permission to create/update Kubernetes runtime
  resources.
- Egress: Hermes needs outbound HTTPS to LLM providers, Telegram, and Google;
  D10's NetworkPolicies must allow exactly that.
- Add resource requests/limits; initial target around 768 MiB request and up to
  3 GiB limit, adjusted from observed use rather than treated as a contract.
- Cutover of the shared bot: stop the Mac gateway **before** the in-cluster one
  starts (only one may own the token); keep the Mac profile directories intact
  as rollback.

**Fallback (documented deviation):** if the host cannot give Hermes its share
after D1's preparation, Hermes stays on the Mac, connected to the in-cluster
relay and APIs over the LAN. Decision 9 (Mac optional) is then suspended and
the deviation is recorded in this document with the resource numbers that
forced it, reviewed at each deployment sprint boundary.

Automated evidence:

- profile self-tests remain green;
- interviewer routing and trip-companion isolation tests pass;
- test proves Hermes credentials cannot call Kubernetes provider mutation
  paths directly;
- restart Hermes Pod and prove required state survives on the PVC.

Manual evidence:

- run a real test interview;
- run a known companion conversation against a test trip;
- leave old Mac Hermes intact as rollback until cutover confidence is achieved.

**Compatibility flags reached:** C2 (Hermes skill-sync tooling assumes
`~/.hermes/profiles` on the Mac), C8 (the relay must be the only poller), C12
(terminal-toolset Docker backend), C7 (profile SOULs and skills that describe
LXC operations).

**Exit gate:** Kinerary's AI flows work with in-cluster Hermes and the Mac is no
longer required for production behavior — or the fallback deviation is recorded
with its numbers.

---

### Deployment Sprint D7 — Kubernetes provisioning adapter

**Goal:** replace per-trip Proxmox/LXC provisioning with internal Kubernetes
workload provisioning while preserving the planner/job/approval contract.

**Prerequisite:** the Sprint 4.7 compute / persistent-data / secret adapter
abstractions that `onboarding-mvp-sprint-plan.md` still lists as deferred.
Today the worker's seams are `ComputeAdapter` (`compute.py`) and
`DeployAdapter` (`provisioner.py`), both with Null defaults; the
`provisioning/` engine and `Topology` model underneath are hard-shaped to
Proxmox/NPM/Cloudflare and cannot express another provider.

Build:

- Implement a Kubernetes runtime/provisioning adapter as a new
  `ComputeAdapter` + `DeployAdapter` pair injected in `__main__.py`, behind the
  existing provider-neutral worker boundary. It does not go through the
  `provisioning/` engine.
- Re-create the `deploy.sh` slug guard's safety property: a job for trip X can
  only ever reconcile objects labelled with trip X's ID; a name/label mismatch
  is a hard failure, never an overwrite.
- Generate the per-trip Secret (`JWT_SECRET`, `HERMES_API_KEY`, the shared bot
  token, `SEED_PASSWORD`) — today `trip.env` is hand-maintained per trip. The
  "no login on a provisioned site" gap is a product item and stays open.
- No IP pool, no `topology.yaml`: the trip's Kubernetes objects and hostname
  are the resource record.
- On an already-approved durable job, reconcile the required trip resources:
  - labels/tenant identity;
  - Secret/ConfigMap;
  - local state PVC;
  - document-storage binding/reference;
  - trip Deployment(s);
  - ClusterIP Service;
  - host-based Ingress/IngressRoute rule (`Host(<slug>.<trip-domain>)`);
  - readiness evidence/resource records.
- Make provisioning idempotent and reconciliation based. A retry must converge
  rather than create duplicate Services/PVCs/routes.
- Create a dedicated worker ServiceAccount and least-privilege RBAC.
- Remove Kubernetes-targeted dependency on:
  - Proxmox create-LXC actions;
  - SSH deploy scripts (`kinerary-deploy/deploy.sh`, `retarget-container.sh`,
    per-trip `topology.yaml`) and SSH into the RPi4;
  - NPM per-trip host creation;
  - Cloudflare per-trip tunnel/DNS creation.
- Keep the existing Proxmox adapter available only as a legacy/alternate
  adapter until migration is proven, rather than deleting it in the first PR.

Automated evidence:

- fake and real/local adapter contract suites assert the same provider-neutral
  result shape;
- duplicate job/retry tests create one logical runtime;
- authorization tests prove worker RBAC cannot mutate unrelated namespaces or
  cluster-wide resources beyond explicitly required objects;
- failed provisioning leaves durable failed-job evidence and no false active
  trip state.

Manual evidence:

- provision a fresh non-production trip end to end without any manual
  Cloudflare, NPM, Proxmox, or SSH step;
- delete one recoverable Kubernetes object and rerun reconciliation to prove it
  is repaired rather than duplicated.

**Compatibility flags reached:** C3 (`mcp/provision.js` restarts Docker
containers; give it a Kubernetes mode or retire it in favour of this adapter —
hard rule 5 becomes ClusterIP + NetworkPolicy), C4 (`kinerary-deploy` scripts
and the "deploy via kinerary-deploy" operating rule become legacy), C6, C14,
C15 (manifest-less releases fall back to ambient `REPO_ROOT`; the adapter must
refuse them), C16 (per-trip `trip.env`).

**Exit gate:** approved onboarding can produce a private working trip using k3s
as the compute/runtime adapter.

---

### Deployment Sprint D8 — OCI release integration

**Goal:** deploy exactly the code that was qualified and promoted, without
requiring a worker-side Git checkout as the runtime artifact.

Build (image build and push themselves moved to D1.5; this sprint links them
to the release record):

- Build the trip runtime image from the **release source revision** in the
  release pipeline, not from `main`.
- Record the GHCR image digest next to `source_revision` and `artifact_digest`
  in `control_plane.releases` (new migration).
- Associate the promoted Kinerary release with the immutable OCI digest while
  retaining source revision, manifest, sanitation, and compatibility evidence.
- Make the Kubernetes adapter deploy by digest.
- Build/publish versioned images for Web, control-plane API, and worker as part
  of the deployment pipeline.
- Do not use `:latest` as the production identity.

Automated evidence:

- release digest verification tests;
- test proves changing `main` after promotion cannot alter the already promoted
  runtime;
- deployment manifest contains the expected digest;
- existing release promotion state-machine tests remain intact.

Manual evidence:

- inspect running Pod image IDs and match them to the promoted release record.

**Compatibility flags reached:** C15 (releases without a digest are refused).

**Exit gate:** release qualification and runtime identity are cryptographically
linked through an immutable container digest.

---

### Deployment Sprint D9 — Backup, restore, and active-trip cutover

**Goal:** prove the platform can survive operator/runtime failure before making
it the only production path.

Build:

- Scheduled PostgreSQL backups (`pg_dump` CronJob) to TrueNAS **and a copy to
  Google Drive** (off-host; TrueNAS is a VM on the same Proxmox host).
- Application-consistent trip SQLite backup via `sqlite3 .backup` or
  `VACUUM INTO`, never a file copy of a live database (the same rule the
  smart-home skill applies to Home Assistant); copy to Google Drive.
- Hermes state backup process (restic/kopia to TrueNAS, copy to Google Drive).
- TrueNAS snapshots for document/blob dataset.
- Proxmox VM backup (`vzdump`) to TrueNAS: the `/mnt/HP_HDD/vm_backups` export
  exists but is not registered as Proxmox storage yet.
- Google Drive credentials: a dedicated service/OAuth identity with a
  Kinerary-only folder, stored as a Secret; never a personal account's full
  Drive scope.
- Document exact restore order for:
  1. VM/k3s;
  2. secrets;
  3. PostgreSQL;
  4. Hermes state;
  5. trip state;
  6. NFS documents;
  7. reconciliation of Kubernetes objects from Git/control-plane records.
- Add a cutover checklist for the reference trip. No family trip is live today;
  `japan-2026` (test trip, CT101) is the cutover rehearsal target, and the
  first real trip provisioned after D7 is the first production tenant.
- Decommission the trip hostnames from the RPi4 tunnel config and NPM only
  after the k3s copies are verified; then retire CT101 and CT201.

Automated evidence:

- scheduled backup Jobs expose failure status;
- backup artifacts are dated/retained according to policy;
- restore test uses copied/test data, not destructive production mutation.

Manual evidence:

- full restore drill of a representative trip into an isolated test target;
- migrate the reference trip with a before/after data comparison;
- validate login, itinerary, bookings, booking-confirmation access, Telegram
  behavior, MCP operations, and Hermes companion behavior;
- keep old runtime available as rollback until acceptance completes.

**Compatibility flags reached:** C4 (`kinerary-deploy` retired), C7 (rewrite
the LXC/NPM/Cloudflare operating docs and skills, then capture-then-deploy per
`CLAUDE.md`).

**Exit gate:** the k3s deployment becomes the preferred production path only
after a successful restore drill, a reference-trip acceptance test, and an
off-host (Google Drive) copy of the database-class backups.

---

### Deployment Sprint D10 — Operational hardening

**Goal:** make failures visible and bounded after the platform is functional.

Build:

- default-deny NetworkPolicies plus explicit allowed flows;
- production resource requests/limits from observed measurements;
- startup/readiness/liveness probes for all long-running services;
- centralized lightweight logs and searchable correlation IDs;
- node/filesystem/PVC capacity alerts;
- PostgreSQL backup failure alert;
- Hermes unavailable alert tied to Kinerary readiness/degraded status;
- image-digest pinning enforcement/check;
- egress allowlist (LLM providers, Telegram, Google APIs) for Hermes and the
  API; everything else denied;
- a test that the deploy-verb hook (C1) classifies every kubectl/helm form used
  in the runbooks as a deploy;
- SOPS/age or equivalent encrypted Git workflow if secret manifests are to be
  kept in the repository.

Possible but not required in this sprint:

- metrics-server;
- lightweight Prometheus/Grafana if operational need justifies it.

Explicitly still deferred:

- service mesh;
- Longhorn/Ceph;
- multi-server control plane;
- Vault as mandatory production infrastructure;
- GitOps controller.

**Compatibility flags reached:** C1 (verified closed).

**Exit gate:** common dependency failures are detected, visible, and do not
silently corrupt tenant boundaries or state.

---

## 5. Optional Mac track — not on the critical path

The old Mac mini stays on macOS. No deployment sprint depends on it.

One exception is the documented D6 fallback: if host resources force it,
Hermes keeps running on the Mac against the in-cluster relay and APIs until
the host can take it. That is a recorded deviation from decision 9, reviewed
at each deployment sprint boundary, not a design choice.

After D9/D10, optionally evaluate one of these independently:

### Option M1 — external macOS worker

Use the Mac for non-critical tasks through a constrained queue/API, for example:

- builds or release qualification;
- browser-heavy enrichment;
- test automation;
- experimental Hermes workloads;
- offline/background jobs.

This does not make the Mac a k3s node.

### Option M2 — Linux VM hosted on macOS

Only if useful and acceptable later, run a Linux VM on the Mac and join that
VM as a k3s agent. macOS remains installed and in control of the hardware.
Production must remain valid if the VM or Mac disappears.

No architecture work should assume either M1 or M2 will happen.

---

## 6. Suggested PR boundaries

Keep the deployment track reviewable and orthogonal. A practical PR sequence:

1. **D0 docs/tests:** deployment inventory + origin characterization +
   `tests/provisioning/` into CI.
2. **D1:** host-preparation record, `deploy/` skeleton, k3s baseline
   manifests, deploy-verb hook update.
3. **D1.5:** CI image build/push to GHCR.
4. **D2:** PostgreSQL/API/worker Kubernetes manifests, secret mounts,
   interview MCP sidecar.
5. **D3:** cloudflared tunnel + wildcard DNS + Traefik host edge + Web.
6. **D4:** trip host-routing fixes/tests + runtime template + trip MCP sidecar.
7. **D5:** NFS ownership, document storage adapter, optional Drive source.
8. **D7a:** Kubernetes adapter interfaces/fakes/contract tests.
9. **D7b:** real reconcile implementation + RBAC + E2E sandbox.
10. **D8:** release ↔ image-digest linkage.
11. **D6:** Hermes image, manifests, profile bundles (after Sprint 6.5 merges).
12. **D9:** backup/restore incl. Google Drive + cutover runbook.
13. **D10:** NetworkPolicies/observability/hardening.

Do not combine D4, D7, and D8 into one large PR: each changes a separate risk
boundary (public origin, infrastructure provider, and release identity). D6
floats to wherever Sprint 6.5 lands; D7–D9 do not wait for it.

---

## 7. Definition of deployment-track done

The k3s migration track is complete when all of the following are true:

- Kinerary's web portal, control-plane API, worker, PostgreSQL, Hermes, and at
  least one real trip run in k3s on the Proxmox VM.
- A new trip can be provisioned from an approved control-plane job without
  creating an LXC, public IP, DNS record, subdomain, Cloudflare tunnel, or NPM
  proxy host.
- The trip is reached at `<slug>.<trip-domain>` through the dedicated tunnel
  and the wildcard record; the RPi4's tunnel config and NPM contain no Kinerary
  entries any more.
- The runtime uses an immutable promoted release image digest.
- PostgreSQL and live SQLite state are local; document/blob data such as booking
  confirmations is stored on TrueNAS NFS through the defined storage boundary.
- Hermes works in-cluster and has no Kubernetes infrastructure authority.
- No standalone per-trip companion storage is required unless explicitly added
  by a future architecture decision.
- The old Mac mini can be turned off without breaking production.
- Backup and restore have been demonstrated, not merely configured, and an
  off-host copy (Google Drive) of the database-class backups exists.
- Every entry in the compatibility-break ledger below is resolved or explicitly
  accepted with a reason.
- Existing onboarding/product sprint acceptance tests remain valid and are not
  bypassed by deployment-specific shortcuts.

At that point the old Proxmox/LXC deployment adapter can be marked legacy and
removed in a later cleanup sprint once rollback value has expired.

---

## 8. Compatibility-break ledger

Everything the migration breaks that exists and works today. The project is
not in production, so none of these blocks the track — but each one is a
*decision*, and the sprint that reaches it must stop, decide (resolve, or
accept with a reason), and fill in the Status column. Sprints name the entries
they reach in their **Compatibility flags reached** line.

| ID | What breaks | Reached in | What to do | Status |
|---|---|---|---|---|
| C1 | `scripts/claude-hooks/match-command.py` `DEPLOY` pattern matches `deploy.sh`, `docker compose up`, `docker restart`, `systemctl restart trip-server` only; `kubectl`/`helm`/`kustomize` are invisible, so hard rule 2 stops being enforced for cluster deploys | D1, verified D10 | Extend the pattern + its tests | open |
| C2 | `scripts/install-hermes-skill.sh`, `.agents/hermes-sync.tsv`, and the preflight drift check assume `~/.hermes/profiles/<p>` on the Mac; once profiles live on a PVC the check is stale (silently green or falsely red) | D6 | Build profile bundles from `.agents/skills/`; re-point or retire the drift check for cluster profiles | open |
| C3 | `mcp/provision.js` writes files and restarts Docker containers; there is no Docker in k3s. Hard rule 5 ("LAN-only") needs a cluster equivalent | D7 | Kubernetes mode, or retire in favour of the worker adapter; ClusterIP + NetworkPolicy | open |
| C4 | `kinerary-deploy/deploy.sh` (slug guard, tar over `pct exec`, `systemctl restart`), `retarget-container.sh`, per-trip `topology.yaml`, and the worker's `_private_url()`; the standing rule "always deploy via kinerary-deploy" | D4, D7, D9 | Re-create the slug-guard safety property in the adapter; mark the scripts legacy at D9 | open |
| C5 | `trust proxy` never set in `server/server.js`; `PUBLIC_ORIGIN` read only by `/photo/:id` | D4 | Set both per trip | open |
| C6 | `tests/provisioning/` (33 tests over `provisioning/adapters|engine|models`) is not in `tests/package.json` and not run by CI | D0, D7 | Add to CI before touching the adapter layer | open |
| C7 | Docs and skills encode LXC + NPM + Cloudflare: smart-home-expert `public-trip-site-ingress*.md` (also TrueNAS `.177` vs the real `.171`, and its "no wildcard" rule), `.agents/skills/trip-site-operations`, `trip-site-verification`, `docs/kinerary-trip-platform-handoff.md`, profile SOULs | D0, D3, D5, D6, D9 | Capture-then-deploy per `CLAUDE.md`; rewrite at D9 | open |
| C8 | Exactly one `getUpdates` poller per bot token: today the API's `startTelegramApprovalPoller`; after Sprint 5 the relay | D2, D6 | One replica + `Recreate`; stop the Mac gateway before the cluster gateway starts | open |
| C9 | `dist/interview-mcp.js` is hand-started, bound to `127.0.0.1:4311`, not in any compose file | D2 | API Pod sidecar with configurable bind | open |
| C10 | trip MCP: one node process per trip on the Mac (`~/.hermes/services/trip-mcp`, launchd `com.hermes.trip-mcp`); profiles point at `127.0.0.1:<port>/sse` | D4 | Sidecar of the trip Pod; update profile `mcp_servers` URLs | open |
| C11 | `docker-compose.yml` `privileged: true` (dev-only, unexplained); production LXC `--unprivileged 0` for NFS uid mapping; `site/avatars` symlinked to NFS on containers | D0, D5 | Drop the Compose flag; NFS ownership decision (`mapall` vs fixed UID); avatars become a mount | open |
| C12 | Hermes terminal toolset expects Docker/Modal images (`nikolaik/python-nodejs`) | D6 | Backend decision recorded | open |
| C13 | `compose.local.yml` passes `${VAR:-}` so unset vars arrive as `""`; Kubernetes omits them, so code defaults start applying | D2 | Re-verify each consumer; most vanish with D7 | open |
| C14 | Release delivery = `git archive` → tar over `pct exec` → `npm install --production` → `systemctl restart` | D1.5, D7 | Image build; adapter deploys by digest | open |
| C15 | Manifest-less releases silently fall back to ambient `REPO_ROOT` | D7, D8 | Adapter refuses releases without a digest | open |
| C16 | Per-trip `trip.env` hand-maintained (`JWT_SECRET`, `HERMES_API_KEY`, bot token, `SEED_PASSWORD`); provisioned sites still have no login | D7 | Adapter generates the Secret; the login gap stays a product item | open |

Unrelated to the plan but found while reviewing, for the homelab owner: the
stopped Pi-hole CT102 on Proxmox holds the RPi4's `.41` address. Keep it
`onboot: 0` (it is today) or delete it.
