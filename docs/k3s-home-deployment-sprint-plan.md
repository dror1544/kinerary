# Kinerary k3s Home Deployment Sprint Plan

**Status:** Proposed parallel implementation track.

**Architecture source of truth:** [`k3s-home-deployment-architecture.html`](k3s-home-deployment-architecture.html)

**Relationship to existing product work:** this plan runs **in parallel** to
`onboarding-mvp-sprint-plan.md` and the existing product/onboarding sprints. It
must not renumber them, weaken their acceptance gates, or turn deployment work
into a prerequisite for unrelated product work unless a specific integration
gate below says so.

**Outcome:** Kinerary, its control plane, Hermes AI runtime, and provisioned trip
runtimes can run reproducibly on a single-node k3s cluster inside the home
Proxmox environment. New trips are provisioned as internal Kubernetes workloads
and are exposed through path routing under the single public Kinerary URL. The
platform uses local SSD for transactional state, TrueNAS NFS for document/blob
storage, and TrueNAS-backed backups for recoverability.

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
  or subdomains.

Explicit non-goals for this track:

- multi-server / HA k3s;
- replacing macOS on the old Mac mini;
- making the Mac a required production dependency;
- Vault as a required secret manager;
- Longhorn, Ceph, service mesh, ArgoCD, Flux, or a PostgreSQL operator;
- moving PostgreSQL or live SQLite files to NFS;
- one Hermes Pod or one Hermes PVC per trip unless runtime behavior later
  proves that isolation is required.

---

## 2. Standing architecture decisions

All sprints below must comply with the architecture document. The following
choices are already decided and should not be reopened inside an implementation
PR without an explicit architecture update:

1. **One Proxmox VM, one k3s server initially.**
2. **No parallel production Docker daemon is required.** k3s/containerd owns
   production containers.
3. **One public Kinerary hostname.** Trips are reached using path routing such
   as `/trips/<slug>/...`.
4. **No per-trip Cloudflare configuration.** Cloudflare terminates/forwards to
   one stable Kinerary origin/tunnel.
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
| Trip runtime | Make the existing site/server work under a configurable path prefix |
| Provisioning approval | Replace provider execution only after the same approved durable job exists |
| Existing family trip | Use as a migration/acceptance target, never as destructive test data |

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
- Identify why the legacy `trip-server` Compose service is `privileged: true`.
  Classify every required Linux capability/mount/device and produce a remove or
  replace decision. A privileged Kubernetes Pod is not an acceptable default.
- Define the intended public base paths:
  - `/` — Kinerary web portal;
  - `/api/...` — control-plane API;
  - `/trips/<slug>/...` — trip runtime.
- Select a non-production trip fixture and path for repeated migration tests.
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
- confirm active family data has a recoverable backup before any migration;
- prove a restore of at least one copied/non-production trip data set.

**Exit gate:** no unknown privileged requirement, state directory, or public
routing dependency remains undocumented.

---

### Deployment Sprint D1 — k3s foundation on Proxmox

**Goal:** establish an empty, recoverable production-shaped cluster.

Build:

- Create `kinerary-prod` Debian VM on Proxmox.
- Initial sizing target:
  - 4 vCPU;
  - 10 GB RAM, with practical 8–12 GB range according to host pressure;
  - ~80 GB SSD-backed disk;
  - VirtIO NIC;
  - Proxmox guest agent;
  - reserved/static LAN address.
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

**Exit gate:** an empty k3s environment can be rebuilt/recovered from documented
inputs.

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

**Exit gate:** control plane runs in k3s with the same canonical contracts and
without provider mutation enabled.

---

### Deployment Sprint D3 — Public web edge and single-host path routing

**Goal:** establish the permanent routing model before migrating trip traffic.

Build:

- Deploy the public React web SPA.
- Route the main public Kinerary hostname through the existing Cloudflare edge
  to one stable cluster ingress.
- Configure Traefik routing for:
  - `/` → Web SPA;
  - `/api` → control-plane API;
  - reserved `/trips/...` route family.
- Ensure creation of a new trip will not require a Cloudflare API call, DNS
  change, tunnel change, public IP, or NPM host.
- Define forwarded headers, HTTPS-origin assumptions, and trusted proxy policy.

Automated evidence:

- ingress manifest tests where practical;
- browser/E2E test proves `/` and `/api` coexist behind the same host;
- negative test proves internal-only services are not reachable through public
  ingress.

Manual evidence:

- access Kinerary externally through the real public hostname;
- inspect Cloudflare configuration before/after adding a dummy internal route
  and show it is unchanged.

**Exit gate:** the permanent one-host routing model works before a real trip is
moved.

---

### Deployment Sprint D4 — Trip runtime base-path compatibility

**Goal:** make a trip runtime correct under `/trips/<slug>` rather than at a
root hostname.

This is a critical application/deployment seam and should be implemented as a
focused compatibility sprint rather than hidden in ingress configuration.

Build:

- Add/configure a base-path contract for the legacy trip site/server.
- Verify or fix all path-sensitive behavior:
  - static JS/CSS/images;
  - API requests;
  - redirects;
  - authentication flows;
  - cookies and cookie Path attributes;
  - Telegram login/callback URLs;
  - Google login origins/callback assumptions if enabled;
  - PWA manifest/service-worker scope if used;
  - deep links;
  - trivia routes;
  - MCP-facing URLs returned to clients;
  - avatar and uploaded-file URLs.
- Create reusable trip-runtime Kubernetes manifests/template accepting trip ID,
  slug, release image, state PVC, document storage reference, and base path.
- Trip Service remains ClusterIP only.

Automated evidence:

- existing Kinerary suite remains green;
- add explicit base-path tests that run the trip under a non-root prefix;
- browser smoke test navigates multiple pages and authentication under
  `/trips/test-trip`;
- assert no generated absolute URL silently points at `/` or a per-trip host.

Manual evidence:

- non-production trip works externally through the real public hostname and
  prefixed route.

**Exit gate:** a trip is fully usable under path routing without a subdomain.

---

### Deployment Sprint D5 — TrueNAS document/blob storage

**Goal:** move document-like durable data to NAS storage without putting
transactional databases on NFS.

Build:

- Create dedicated TrueNAS NFS dataset/export for Kinerary documents.
- Define Kubernetes NFS PV/PVC, preferably RWX.
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

**Exit gate:** document/blob storage is durable on TrueNAS, tenant scoped, and
not confused with database storage.

---

### Deployment Sprint D6 — Hermes migration into k3s

**Goal:** make the in-cluster Hermes runtime the AI plane for Kinerary without
changing product authority boundaries.

Build:

- Create Hermes Deployment and ClusterIP Service in `kinerary-agents`.
- Create Hermes local SSD-backed PVC for runtime/workspace state.
- Migrate required interviewer, companion, and extraction profile bundles.
- Keep one runtime with multiple profiles unless real runtime constraints prove
  separate processes are necessary.
- Do **not** create a separate per-trip companion PVC.
- Route Hermes access to Kinerary through constrained MCP/API contracts.
- Hermes ServiceAccount has no permission to create/update Kubernetes runtime
  resources.
- Add resource requests/limits; initial target around 768 MiB request and up to
  3 GiB limit, adjusted from observed use rather than treated as a contract.

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

**Exit gate:** Kinerary's AI flows work with in-cluster Hermes and the Mac is no
longer required for production behavior.

---

### Deployment Sprint D7 — Kubernetes provisioning adapter

**Goal:** replace per-trip Proxmox/LXC provisioning with internal Kubernetes
workload provisioning while preserving the planner/job/approval contract.

Build:

- Implement a Kubernetes runtime/provisioning adapter behind the existing
  provider-neutral worker boundary.
- On an already-approved durable job, reconcile the required trip resources:
  - labels/tenant identity;
  - Secret/ConfigMap;
  - local state PVC;
  - document-storage binding/reference;
  - trip Deployment(s);
  - ClusterIP Service;
  - path-based Ingress rule;
  - readiness evidence/resource records.
- Make provisioning idempotent and reconciliation based. A retry must converge
  rather than create duplicate Services/PVCs/routes.
- Create a dedicated worker ServiceAccount and least-privilege RBAC.
- Remove Kubernetes-targeted dependency on:
  - Proxmox create-LXC actions;
  - SSH deploy scripts;
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

**Exit gate:** approved onboarding can produce a private working trip using k3s
as the compute/runtime adapter.

---

### Deployment Sprint D8 — OCI release integration

**Goal:** deploy exactly the code that was qualified and promoted, without
requiring a worker-side Git checkout as the runtime artifact.

Build:

- Extend CI to build trip runtime image(s) from the release source revision.
- Push to GHCR using immutable revision tags and capture image digest.
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

**Exit gate:** release qualification and runtime identity are cryptographically
linked through an immutable container digest.

---

### Deployment Sprint D9 — Backup, restore, and active-trip cutover

**Goal:** prove the platform can survive operator/runtime failure before making
it the only production path.

Build:

- Scheduled PostgreSQL backups to TrueNAS.
- Application-consistent trip SQLite backup process.
- Hermes state backup process.
- TrueNAS snapshots for document/blob dataset.
- Proxmox VM backup to TrueNAS.
- Document exact restore order for:
  1. VM/k3s;
  2. secrets;
  3. PostgreSQL;
  4. Hermes state;
  5. trip state;
  6. NFS documents;
  7. reconciliation of Kubernetes objects from Git/control-plane records.
- Add a cutover checklist for the currently active family trip.

Automated evidence:

- scheduled backup Jobs expose failure status;
- backup artifacts are dated/retained according to policy;
- restore test uses copied/test data, not destructive production mutation.

Manual evidence:

- full restore drill of a representative trip into an isolated test target;
- migrate the active trip with a before/after data comparison;
- validate login, itinerary, bookings, booking-confirmation access, Telegram
  behavior, MCP operations, and Hermes companion behavior;
- keep old runtime available as rollback until acceptance completes.

**Exit gate:** the k3s deployment becomes the preferred production path only
after a successful restore drill and active-trip acceptance test.

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

**Exit gate:** common dependency failures are detected, visible, and do not
silently corrupt tenant boundaries or state.

---

## 5. Optional Mac track — not on the critical path

The old Mac mini stays on macOS. No deployment sprint depends on it.

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

1. **D0 docs/tests:** deployment inventory + base-path characterization.
2. **D1:** `deploy/` skeleton and k3s baseline manifests.
3. **D2:** PostgreSQL/API/worker Kubernetes manifests and secret mounts.
4. **D3:** Web + Traefik/path edge.
5. **D4:** trip base-path compatibility code/tests + runtime template.
6. **D5:** NFS document storage adapter and manifests.
7. **D6:** Hermes manifests/profile migration.
8. **D7a:** Kubernetes adapter interfaces/fakes/contract tests.
9. **D7b:** real reconcile implementation + RBAC + E2E sandbox.
10. **D8:** OCI release/image-digest integration.
11. **D9:** backup/restore + production cutover runbook.
12. **D10:** NetworkPolicies/observability/hardening.

Do not combine D4, D7, and D8 into one large PR: each changes a separate risk
boundary (HTTP base path, infrastructure provider, and release identity).

---

## 7. Definition of deployment-track done

The k3s migration track is complete when all of the following are true:

- Kinerary's web portal, control-plane API, worker, PostgreSQL, Hermes, and at
  least one real trip run in k3s on the Proxmox VM.
- A new trip can be provisioned from an approved control-plane job without
  creating an LXC, public IP, DNS record, subdomain, Cloudflare tunnel, or NPM
  proxy host.
- The trip is reached through the main public Kinerary hostname at
  `/trips/<slug>`.
- The runtime uses an immutable promoted release image digest.
- PostgreSQL and live SQLite state are local; document/blob data such as booking
  confirmations is stored on TrueNAS NFS through the defined storage boundary.
- Hermes works in-cluster and has no Kubernetes infrastructure authority.
- No standalone per-trip companion storage is required unless explicitly added
  by a future architecture decision.
- The old Mac mini can be turned off without breaking production.
- Backup and restore have been demonstrated, not merely configured.
- Existing onboarding/product sprint acceptance tests remain valid and are not
  bypassed by deployment-specific shortcuts.

At that point the old Proxmox/LXC deployment adapter can be marked legacy and
removed in a later cleanup sprint once rollback value has expired.
