# Kinerary Trip Platform — Architecture, Current State, and Claude Code Handoff

**Purpose:** preserve the agreed architecture, live operational facts, current trip plans, implementation locations, and next actions so work can continue without rediscovering context.

**Last reconciled:** 2026-08-07 (infrastructure inventory remains read-only/partially unverified; see status labels below)

**Read this before changing infrastructure or onboarding code.** This is a factual handoff, not authorization to deploy. The repository's `CLAUDE.md` still governs: do not commit or deploy a live trip without explicit approval, do not write to `trip/`, and never expose `mcp/provision.js` beyond the LAN.

## 1. Decision summary

Kinerary is being generalized from the working **USA2026** deployment into a multi-trip platform.

The target model is:

```text
Mac (Hermes control plane)
  ├─ shared Telegram intake/interviewer agent
  ├─ one isolated Hermes FamilyTrip profile per real trip
  ├─ profile/workspace provisioning and integration verification
  └─ no trip website runtime or Proxmox control service directly exposed publicly

Proxmox hypervisor (192.168.0.40)
  ├─ generalized golden-trip LXC at 192.168.0.202
  ├─ one separate LXC for every real trip
  └─ a separate control-plane VM for onboarding, durable registry and jobs

Each trip LXC
  ├─ one trip website/runtime
  ├─ one scoped data MCP endpoint and credentials
  ├─ local service supervision (systemd or the proven equivalent)
  └─ no public provisioning API

Ingress for an organizer-approved public site
  Internet → Cloudflare Tunnel on RPi4 → Nginx Proxy Manager on RPi4 → trip LXC
```

Critical corrections that must not regress:

- **`192.168.0.40` is Proxmox.** It is not a trip-site address.
- **`192.168.0.202` is the generalized golden-trip LXC/template source.** New trips must be created from that generalized baseline after a reviewed clone/copy procedure.
- **`192.168.0.200` is the existing USA2026 deployment/reference.** It is not the template source for new trips.
- Hermes runs on the Mac and remains the control plane. Trip websites and their runtime live in per-trip Linux LXCs.
- Japan is a non-production replay/test trip. Hawaii/USA2026 for Shiran is the real near-term trip to set up, but it must not be deployed until her interview is explicitly confirmed and the deployment checks pass.

## 2. Real infrastructure and operating constraints

### 2.1 Home-lab topology

The `smart-home-expert` reference is the source for the surrounding home-lab architecture.

| Component | Address / location | Role |
|---|---|---|
| Proxmox | `192.168.0.40` | Hypervisor. Also hosts Home Assistant and TrueNAS VMs; do not casually add services directly to the hypervisor. |
| Generalized Kinerary LXC | `192.168.0.202` | Golden/generalized trip deployment used to validate and later clone new trip containers. |
| Existing USA2026 LXC | `192.168.0.200` | Existing trip deployment and useful operational reference. |
| RPi4 | `192.168.0.41` | Cloudflare Tunnel, Nginx Proxy Manager (NPM), DNS/failover responsibilities. Treat it as a constrained control-plane SPOF. |
| Mac | this machine | Hermes, profiles, workspaces, interviewer/notifier, operator tooling. |

Observed trip-ingress notes that need re-verification immediately before a live change:

- Cloudflare Tunnel runs as a systemd service on the RPi4 and forwards public HTTP traffic to NPM.
- NPM runs as Docker container `nginx_proxy_manager`; its persisted data is on the RPi4.
- The generalized CT at `.202` was observed as CT `201` named `trip-kinerary`. **Do not infer CT ID from IP**; use `pct list` and `pct config` before doing anything.
- The old/general CT had no active Docker runtime during inspection. Determine its real runtime before treating Docker Compose as the deployment mechanism.
- Proxmox root SSH was not available non-interactively from this Mac during the last inspection. Future automation needs an explicitly scoped Proxmox API token or dedicated SSH identity, tested read-only first.

### 2.2 Public ingress and verification rule

Only the user-facing site may be published. Never route provisioning or privileged MCP ports through Cloudflare, NPM, port-forwarding, or a catch-all ingress rule.

For each public deployment verify in order:

```text
LXC loopback health
→ LXC LAN health
→ NPM route using the exact Host header
→ public HTTPS health
→ public rendered page and important UI controls
```

`HTTP 200` alone is not sufficient: NPM's default page can return 200. Require Kinerary's structured `/api/health` response with `ok: true`, and inspect the actual rendered page.

### 2.3 LXC cloning guardrails

1. Do not clone the live USA2026 LXC at `.200` as the source.
2. Do not remove a bind mount from an active source CT just to make `pct clone` work.
3. Check `pvesm status`, free storage, CT ID, hostname, and unused IP before a clone/copy.
4. Every new LXC needs an independent hostname, MAC/IP configuration, data mount, app path, keys, and site/MCP identity before first use.
5. The first implementation should favor the simplest reviewed procedure that works with the generalized `.202` source: a supported full clone if its mount/storage layout permits it, otherwise a deliberate rootfs copy plus a newly reviewed CT config. Do not pretend a generic `POST /lxc` create from an OS template is equivalent to cloning the generalized application container.

## 3. Trip status and trip plans

### 3.1 Japan — test/replay only, not a real deployment

**Canonical repo config:** `trips/japan-2025/trip.config.json`

**Replay intake:** `intakes/japan-2025/source.json`

Status:

- This is explicitly an `approved_replay_test` intake, not a production trip.
- It is a father-and-daughter Japan itinerary: Eitan and Noa.
- The source config currently describes a September 2026 trip through Tokyo, Hakone/Fuji, Kyoto, and Osaka.
- It is useful for validating the interview → generator → enrichment → provision plan without risking a real organizer's trip.
- It must not be selected as the target for public routing, a real Telegram group, or production deployment.

Use it to test:

```text
intake replay
→ driver.mjs base-config generation
→ deterministic enrichment (when implemented)
→ deployment plan/dry-run
→ non-destructive verification against generalized CT 202
```

### 3.2 Shiran's real Hawaii / USA2026 trip — near-term target

**Current generated config:** `trips/los-angeles-hawaii-vegas-2026/trip.config.json` (currently untracked)

**Interview-derived input:** `intakes/shiran-usa-2026/answers.json` (currently untracked)

Trip facts captured in the current input/config:

| Item | Current information |
|---|---|
| Title | Los Angeles · Hawaii · Vegas 2026 / USA2026 |
| Dates | 2026-08-09 through 2026-08-24 (15 days) |
| Organizer | Shiran / שירן |
| Party | 12 travelers in three families |
| Phases | Los Angeles → Honolulu → Maui → Las Vegas |
| Lodging | W Hollywood; OUTRIGGER Waikiki Beachcomber; AC Hotel by Marriott Maui Wailea; Bellagio Las Vegas |
| Confirmed travel anchors | Arrive Los Angeles; Delta LAX→HNL; Southwest HNL→OGG; Southwest OGG→LAS; return flight listed |
| Agent intent | Hebrew-default, playful male persona named Nahum/נחום; local-time briefings and organizer-facing administration |
| Trivia | configured with a count but no supplied questions; keep it hidden until organizer-supplied questions exist |

Important status distinction:

- Shiran has started the private Telegram interview.
- She has **not yet been observed sending the explicit final `CONFIRM`** required to trigger a confirmed intake artifact.
- The current `intakes/shiran-usa-2026/answers.json` is useful structured input but is not proof that infrastructure provisioning or public activation is approved.
- No verified Hawaii LXC, NPM proxy host, Cloudflare route, per-trip Hermes FamilyTrip profile, or dedicated FamilyTrip group bot is known to have been deployed yet.

Required path for this trip:

```text
finish Shiran's interview
→ explicit CONFIRM
→ persist confirmed intake and recap
→ human review of the real input
→ clone/configure new LXC from generalized CT 202
→ deploy site and unique secrets
→ create scoped Hermes trip profile on Mac
→ verify LXC/MCP/profile/ingress end-to-end
→ explicit separate activation/public-routing approval
→ organizer creates Telegram group and adds the dedicated trip bot
```

## 4. Interviewer and organizer onboarding

### 4.1 Current live interviewer implementation — outside this repository

The active intake system is intentionally isolated from the `familytrip` and `default` profiles.

| Artifact | Location | Status / purpose |
|---|---|---|
| Dedicated Hermes profile | `~/.hermes/profiles/trip-intake/` | Exists and its Telegram gateway is supervised by launchd. It has no MCP configuration and must not gain trip-data/provisioning access. |
| Interviewer persona | `~/.hermes/profiles/trip-intake/SOUL.md` | Intake-only: conversational interview, explicit confirmation, no LXC/site/profile/MCP provisioning. |
| Interview skill copy | `~/.hermes/profiles/trip-intake/skills/kinerary/trip-creation-interview/` | Uses the repo's interview structure while retaining the no-provision boundary. |
| Intake workspace | `~/familytrip-workspaces/trip-intake/` | Private working folder; `notes-rw/confirmed-intake.json` is the intended confirmed artifact location. |
| Deterministic notification relay | `~/familytrip-workspaces/trip-intake/interview-notifier.py` | Reads interviewer-written event JSON files and notifies the administrator. It falls back to the established default-agent Telegram DM if the dedicated bot cannot DM the administrator yet. |
| Operations skill | `~/.hermes/skills/productivity/telegram-trip-intake-operations/SKILL.md` | Captures Telegram onboarding, notification, confirmation, and group-handoff lessons. |

The dedicated interviewer bot is active and has successfully exchanged messages with Shiran. It is restricted to the administrator and Shiran's allowlisted Telegram accounts. Do not copy its token, `.env`, or identifier into this repository.

### 4.2 Interviewer rules that must remain true

- Direct-message only; never use the prospective organizer's family group for intake.
- Ask in the organizer's language, in small mobile-friendly batches.
- Do not request credentials, payment-card information, codes, PINs, or medical details.
- Save a confirmed draft only after literal `CONFIRM`.
- Never claim a site, agent, LXC, group, or provisioning step exists before the deterministic control plane has verified it.
- Start / issue / completion notices must be short and omit sensitive answers and full transcripts.
- The interviewer must not get `trip_data`, `create_trip`, `activate_trip`, or broad trip-site MCP capabilities.

### 4.3 Telegram onboarding facts

Telegram Bot API limitation: a bot cannot initiate a private chat with a user who has not pressed **Start**. A numeric user ID alone is insufficient for an initial DM.

Correct organizer onboarding procedure:

1. Obtain the organizer's verified Telegram ID and a separately supplied email address.
2. Add only that ID plus the administrator to the dedicated interviewer allowlist.
3. Start/verify the interviewer gateway.
4. Send a minimal email invitation containing only a deep link such as `https://t.me/<bot>?start=intake` and explain that the organizer must tap **Start**.
5. Verify the gateway sees an inbound organizer message and sends a response.
6. Notify the administrator when the interview starts, is blocked, and is completed.

Email sending is currently blocked until the Mac's Google OAuth/Gmail authorization is renewed. Do not store OAuth redirects, tokens, or mail credentials in the repo.

### 4.4 Telegram group handoff

Bots cannot create a Telegram group or add themselves to one. The organizer/admin must create the group and add the eventual dedicated trip bot.

The in-repo, untracked `telegram_manager/` code contains an early managed-bot and signed-`startgroup` design:

- `telegram_manager/main.py`: Bot API manager / managed-child-bot concept.
- `telegram_manager/group_link.py`: signed, single-use `startgroup` payloads with expiration.
- `telegram_manager/group_onboarding.py`: verifies the invite, organizer identity, and group context before writing a binding.
- `docs/telegram-sso.md`: related SSO work (currently untracked).

This is promising but is not yet verified as an operational deployment. Its `.env` and any database/token state must remain untracked.

### 4.5 Website identity and login model — agreed target and implementation gap

The product has three ways for an already-known trip participant to authenticate. They are alternatives that all issue the same site JWT session; they must never auto-create a participant account.

| Method | Agreed production behavior | Current implementation status |
|---|---|---|
| **Telegram group-membership SSO (primary)** | The browser receives a signed Telegram Login payload. The server verifies its HMAC/freshness, performs a live `getChatMember` check against the canonical trip group, maps the Telegram numeric identity to an already-seeded participant, and issues the normal 30-day site JWT. The bot is limited admin solely to verify membership. No participant bot DMs are required. | Server route and focused local tests exist: `POST /api/auth/telegram-login`, documented in `docs/telegram-sso.md`. The test suite covers forged/expired callbacks, non-members, active members, JWT issuance, and non-leakage of Telegram IDs. The website login overlay does **not** yet show a Telegram Login Widget, so it has not been browser-tested on an authorized HTTPS domain/group. |
| **Password fallback** | A known participant selects their existing identity and requests a **first-password enrollment**. The request is sent to the organizer's private Telegram approval flow. Only a signed, expiring organizer approval allows the participant to set a password; subsequent password login uses the participant's own bcrypt hash. | Username/password login and password-change endpoints/UI already exist, but they do **not** meet the agreed enrollment security model. The fresh database path currently seeds a shared default password (`1234`), and an existing authenticated session can change its password directly. Replace this before production; never expose a default/shared password. |
| **Google identity (optional fallback)** | A signed Google ID token identifies a candidate Google account, but it must become a participant login only after a private organizer approval button accepts the proposed mapping to an existing participant. The approval must be one-time, expiring, auditable, and bound to trip + participant + Google `sub`; rejection must create no link. Later Google sign-in maps only the approved `sub` to the existing participant and issues the same JWT. | Google token verification, `google-link`, and `google-login` server paths plus Google Sign-In UI hooks exist. The current direct `google-link` path lets any already-authenticated user bind a Google identity immediately, so it must be replaced/gated by the organizer callback workflow before production. No organizer approval-bot callback workflow is yet verified. |

### 4.6 Required unified login UX

The post-provisioned site must present a clear, localized login screen before requesting protected trip data:

```text
Continue with Telegram        ← primary, group-membership checked
Continue with Google          ← optional; pending organizer approval if not linked
Choose yourself → request/set first password  ← organizer-approved enrollment only
```

The current `site/index.html` provides username/password and Google UI elements, but no Telegram Login Widget. Do not announce the login system as complete until all three routes and their failure states have been exercised through a real HTTPS test domain and test group.

### 4.7 Telegram Bot API versus MTProto for complete provisioning

Use the official **Telegram Bot API 9.6 Managed Bots** surface for managed child-bot creation whenever the manager bot has `can_manage_bots=true`. It can create/configure child bots, retrieve their dedicated tokens, and set supported bot profile/menu operations. MTProto is **not** required merely to create a managed trip bot.

However, full Telegram-backed site provisioning also requires actions that the Bot API does not publicly expose. In particular, registering/verifying a Telegram Login Widget domain is a BotFather-side operation; the existing `telegram_manager/configure_webapp.py` can configure and read back the Web App menu button, but explicitly cannot set the Login Widget domain.

Therefore the agreed target includes a separate, tightly scoped **MTProto user-account automation adapter** for BotFather-only steps:

```text
approved intake
→ managed child bot through Bot API
→ configure child bot through Bot API
→ MTProto user-account adapter: register/verify the exact HTTPS Login domain in BotFather
→ configure group binding and Telegram SSO environment
→ render/test the real Telegram Login Widget on that domain
```

MTProto status: **planned, not implemented.** No MTProto client/session, BotFather command adapter, or production credential store has been created/verified in this repository.

MTProto safeguards:

- Use a dedicated authorized Telegram user account/session; never repurpose a bot token as an MTProto credential.
- Keep API ID/hash, session material, 2FA state, and recovery material in a secret manager or local `0600` runtime files outside Git, trip config, MCP responses, and logs.
- Allow only an explicit BotFather operation allowlist (initially Login-domain read/set/verification for the specific newly-created child bot); never expose arbitrary account messaging, contact, or channel management.
- Require a per-trip reviewed operation plan, exact target bot/domain, idempotency/read-back verification, and audit record before an MTProto write.
- Execute MTProto only after confirmed intake and child-bot creation, and never from a family group or an untrusted MCP request.
- Do not run a second `getUpdates` poller against a Bot API manager token; managed-bot events need a single gateway/webhook dispatcher integration.

## 5. What exists in the Kinerary repository now

### 5.1 Established repository architecture

The repo is a config-driven multi-trip travel site:

- common server/site code;
- trip configuration under `trips/<slug>/trip.config.json`;
- canonical creation flow under `.agents/skills/create-trip/` (`.claude/skills/create-trip` is a symlink);
- regular trip-data MCP: `mcp/mcp.js`;
- privileged provisioning MCP: `mcp/provision.js`.

Security boundary already documented in `CLAUDE.md`:

| Service | Role | Exposure |
|---|---|---|
| `mcp/mcp.js` | data within an existing trip | may be published if appropriately authorized |
| `mcp/provision.js` | writes trip files, runs scaffolding, can restart runtime | LAN-only; never tunnel/reverse-proxy/publicly expose |

`mcp/provision.js` already has useful deterministic behavior: validation, scaffolding, verification, and separate activation planning. The activation token is intentionally short-lived, single-use, and slug-bound.

### 5.2 Current uncommitted in-repo work

The working tree is not clean. Claude Code must treat it as work in progress and inspect it before editing or committing.

Modified tracked files include:

```text
.agents/skills/create-trip/SKILL.md
.gitignore
README.md
server/server.js
site/app.js
site/index.html
site/styles.css
tests/helpers/server.js
tests/package.json
tests/run-tests.sh
tests/server.test.js
trips/japan-2025/trip.config.json
```

New/untracked material includes:

```text
.env.example
docs/telegram-sso.md
intakes/
provisioning/
telegram_manager/
tests/provisioning/
tests/telegram-sso.test.js
tests/test_telegram_manager_local.py
trips/los-angeles-hawaii-vegas-2026/
workspaces/
.hermes/plans/2026-08-06_063428-post-interview-enrichment-and-provisioning.md
```

Also present but intentionally not a product artifact: `.hermes-pr3-architecture-review.md`, which was used to post architecture context on GitHub PR #3. Do not commit it unless the user explicitly wants a durable in-repo copy of that review.

Before any commit:

```bash
cd /Users/elul/kinerary
./tests/run-tests.sh
python3 -m unittest discover -s tests/provisioning -v
# Review all untracked files deliberately; never add .env, data, credentials, caches, or pycache.
git status --short
```

### 5.3 In-repo provisioning framework — implemented but not yet aligned with the final LXC design

**Location:** `provisioning/` (untracked)

Implemented design:

- provider adapters for Proxmox LXC, NPM proxy hosts, and Cloudflare tunnel/DNS;
- environment-variable secrets and topology YAML with unresolved-variable validation;
- `plan`, dry-run `apply`, explicit `--execute`, `verify`, and secret-free rollback snapshots;
- idempotent lookup by stable resource identity;
- unit tests using fake JSON transport rather than real infrastructure.

Important gap to fix before using it for a real trip:

- `ProxmoxLxcAdapter.create()` currently creates an LXC from an `ostemplate` through `POST /api2/json/nodes/<node>/lxc`. That does **not** implement the agreed requirement to clone/copy the generalized Kinerary container at `.202`.
- Replace or extend the adapter with a reviewed clone/copy path based on the actual CT 202 storage/mount layout, with unique CT ID, hostname, IP/MAC, disk/data mounts, and per-trip configuration.
- Do not write an adapter that assumes CT `.202` can be blindly cloned; first inspect the actual CT and storage with read-only Proxmox commands.
- The current Cloudflare adapter creates/manages a tunnel per spec. Reconcile that with the real RPi4-owned `cloudflared` service and existing tunnel before executing anything. The desired operational model is likely **one existing tunnel with exact per-trip ingress + DNS entries**, not unmanaged creation of competing tunnels.
- The NPM/Cloudflare adapter work is unit-tested only. It has not been proven against the actual RPi4/NPM/Cloudflare installation.

### 5.4 Post-interview enrichment plan — planned, not implemented

**Location:** `.hermes/plans/2026-08-06_063428-post-interview-enrichment-and-provisioning.md`

Plan intent:

```text
lean organizer interview
→ driver.mjs base config
→ deterministic, sourced enrichment
→ explicit needs_review/provenance
→ non-destructive deployment plan/verification
→ reviewed production deployment
```

Planned but not currently implemented as described:

- enriched trip schema and provenance fields;
- deterministic enrichment CLI;
- geocoding and derived Maps/Waze links;
- always-live seven-day weather via a live data source;
- emergency/consular source adapters;
- hero-media source/license/mime/quality validation;
- derived phase cards with no invented itinerary content;
- DOM/UI contract tests for those derived fields.

Enrichment principles:

- never invent organizer-owned itinerary, booking, activity, or trivia content;
- auto-derived content must carry source/retrieval/review status;
- show unresolved items as `needs_review`;
- do not call climate averages a live forecast;
- trivia stays hidden until organizer-supplied questions are present.

### 5.5 Existing external FamilyTrip profile provisioner — implemented outside the repo

**Location:** `/Users/elul/familytrip-provisioner/`

Files:

```text
/Users/elul/familytrip-provisioner/provision_familytrip.py
/Users/elul/familytrip-provisioner/README.md
/Users/elul/familytrip-provisioner/example-manifest.json
```

Implemented and previously tested:

- creates an isolated `familytrip-<trip-id>` Hermes profile and matching workspace;
- allows only a pre-approved MCP host and allowed source roots;
- writes profile-local MCP configuration with restrictive file permissions;
- supports local-manifest provisioning and an authenticated local/LAN HTTP API;
- rejects duplicate profile/workspace names instead of overwriting;
- performs a profile-specific `hermes -p <profile> mcp test` after creation;
- exposes only `/healthz` and authenticated `POST /v1/trips`, never arbitrary shell/configuration access.

Verified during its earlier development:

```text
Python syntax compilation passed.
Example-manifest dry-run passed.
In-process GET /healthz returned 200.
Authenticated POST /v1/trips returned 201.
Unauthenticated POST /v1/trips returned 401.
```

Not currently production-ready for the new architecture:

- no long-running production process is currently running;
- its examples/allowlist use the old `.200` trip-site assumption and must be updated to per-trip dynamically assigned LXC destinations;
- it creates the Hermes profile/workspace only; it does not create/cloned LXC, deploy a site, configure ingress, or create messaging tokens;
- MCP header secrets are still stored in profile `config.yaml` because of current Hermes configuration behavior. Keep files `0600`; migrate to environment-based secret references if Hermes adds support.

Do not delete it. Either evolve it into the control-plane worker/client or clearly supersede it with an in-repo replacement and add a tested migration path.

## 6. Recommended target control plane

A durable registry/provisioner should run outside every trip LXC as a small
dedicated control-plane VM on Proxmox. Docker Compose provides the service
boundary inside the VM; do **not** install this web/service layer directly on
the Proxmox host.

It is not an LLM. It should record state and run deterministic jobs.

Suggested state machine:

```text
invited
→ interviewing
→ awaiting_organizer_confirmation
→ confirmed
→ provisioning
→ verified
→ awaiting_activation
→ active

or → failed
```

A registry record should contain only non-secret identifiers/references required to audit the trip:

```text
intake ID, trip slug, organizer reference, interview session reference,
confirmed-answer version/time, LXC ID/IP/hostname, profile name,
site/MCP endpoint references, verification/activation state, audit timestamps
```

Keep actual secrets in profile-local files or a secret manager, never in this registry, source-controlled YAML, intake JSON, or logs.

## 7. Implementation sequence for Claude Code

Follow this order; do not jump to public deployment.

### Phase A — reconcile current code safely

1. Read `CLAUDE.md`, this document, `mcp/PROVISIONING.md`, and the current `git diff`.
2. Run the existing test suites and record exact results.
3. Classify every untracked file as one of: product source, test fixture, local state, secret, generated cache, or disposable artifact.
4. Ensure `.env`, token files, SQLite databases, `__pycache__`, generated data, and local workspace state cannot be committed.
5. Review the new provisioning and Telegram code as a change set; do not assume untracked code is correct because it has a README.

### Phase B — make CT 202 cloning real

1. Obtain explicit, scoped read-only access to Proxmox and inventory CT 202, storage, mounts, service runtime, and unused resources.
2. Decide clone versus rootfs-copy based on facts, not a generic adapter assumption.
3. Implement an idempotent creation path that uses generalized CT 202 and allocates unique trip identity/network/data/secrets.
4. Test with Japan only in a non-production LXC/IP. Do not route it publicly.
5. Add provider integration tests plus a manually run read-only plan mode.

### Phase C — complete deterministic provisioning boundaries

1. Keep interviewer input and confirmed intake separate from the worker.
2. Tie the in-repo provisioning framework and external FamilyTrip profile provisioner together or consolidate them; avoid two competing sources of truth.
3. Make the profile provisioner accept the new trip LXC's exact MCP endpoint only after LXC/site readiness passes.
4. Verify from the Mac:
   - profile uses only that trip MCP;
   - default/interviewer profiles do not gain the MCP;
   - health route and real MCP tool list work;
   - site UI renders expected content through the intended route.
5. Retain explicit human activation/public-routing approval.

### Phase D — prepare Shiran's real Hawaii trip

Only after Shiran sends `CONFIRM` and the pipeline above is validated with Japan:

1. review Shiran's intake and resolve missing/ambiguous organizer-owned fields;
2. derive only sourced operational fields through the enrichment layer;
3. provision a new per-trip LXC from CT 202;
4. configure site, private MCP, scoped Hermes profile, and dedicated trip-bot identity;
5. ask an organizer/admin to create the family Telegram group and add the trip bot;
6. validate the signed group binding and group permissions;
7. verify each ingress hop and rendered site;
8. request a separate explicit approval before public activation or user-facing announcement.

## 8. Acceptance checks

Do not claim the generalized platform or Shiran's trip is ready until all relevant checks are backed by real output:

- [ ] CT 202 was inspected and the actual clone/copy procedure was verified.
- [ ] Japan completed an end-to-end non-production replay without public routing.
- [ ] No privileged provisioning endpoint is publicly reachable.
- [ ] A real per-trip LXC was created with distinct identity/data/secrets.
- [ ] The trip site returns the expected `/api/health` JSON at each required hop.
- [ ] The rendered page, not just HTTP status, was checked for expected content.
- [ ] The per-trip Hermes profile has only its own MCP; interviewer/default profiles do not.
- [ ] The interviewer has a confirmed intake and its administrator notification path is verified.
- [ ] The organizer/admin—not the bot—created the group and added the dedicated trip bot.
- [ ] Group binding is single-use, signed, organizer-scoped, and verified.
- [ ] Any email invitation/group handoff uses restored Gmail authorization and excludes secrets/private trip details.
- [ ] A human explicitly approved public activation.

## 9. References

Start with these files:

```text
CLAUDE.md
FRAMEWORK.md
mcp/PROVISIONING.md
docs/hermes-interviewer-agent.md
docs/FamilyTrip-Agent-Handoff.md
.agents/skills/create-trip/INTERVIEW.md
.agents/skills/create-trip/driver.mjs
provisioning/README.md
.hermes/plans/2026-08-06_063428-post-interview-enrichment-and-provisioning.md
```

External operational references:

```text
/Users/elul/familytrip-provisioner/README.md
/Users/elul/familytrip-workspaces/trip-intake/
/Users/elul/.hermes/profiles/trip-intake/
~/.hermes/skills/smart-home/smart-home-expert/references/public-trip-site-ingress.md
~/.hermes/skills/smart-home/smart-home-expert/references/proxmox.md
~/.hermes/skills/productivity/telegram-trip-intake-operations/SKILL.md
```

Treat credentials, profile `.env` files, Gmail OAuth state, Telegram bot tokens, group IDs, private organizer details, and live infrastructure values as local secrets. They are deliberately not recorded here.
