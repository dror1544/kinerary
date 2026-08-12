# Trip Fleet Control Plane and Onboarding Pipeline — Implementation Plan

> **Read first:** `docs/kinerary-trip-platform-handoff.md` (last reconciled
> 2026-08-07 — the authoritative architecture/status doc) and
> `.hermes/plans/2026-08-06_063428-post-interview-enrichment-and-provisioning.md`
> (the enrichment + Python provisioning task breakdown this plan depends on
> and does not duplicate). This plan is the third leg: the durable
> registry/control-plane service the handoff doc's §6 calls for, plus the
> pieces needed to close the loop from a confirmed intake to a live,
> organizer-usable trip.

**Goal:** Turn the pieces that already exist — the interview flow, the
`provisioning/` Python adapters, `telegram_manager/`, Telegram SSO, the
external FamilyTrip profile provisioner — into one deterministic,
audited pipeline: confirmed intake → LXC provisioned from the golden
template → site verified → per-trip Hermes companion + Telegram bot
created → organizer approves public activation → organizer adds the bot
to their group. Plus a small always-on service (not an LLM) that owns
this state machine, gives a super-admin visibility into every trip's
runtime health, and can reset/rotate/administer any of them.

**Architecture** (per `docs/kinerary-trip-platform-handoff.md` §1, §6 —
supersedes any Docker-Compose-per-trip design):

```text
Mac — Hermes control plane
  ├─ interviewer profile (DM-only, no provisioning/trip-data MCP access)
  └─ one isolated Hermes companion profile per confirmed trip

Proxmox (192.168.0.40)
  ├─ golden-trip LXC template — 192.168.0.202
  ├─ one LXC per real trip, cloned from that template
  └─ this plan's control-plane service — its own small LXC, NOT installed
     directly on the Proxmox host

RPi4 (192.168.0.41) — unchanged, out of this plan's scope
  Cloudflare Tunnel → Nginx Proxy Manager → the target trip LXC
```

**Tech Stack:** Node.js (control-plane service, matching the rest of the
repo's server code; `better-sqlite3` for the registry DB); Python (reuse,
don't duplicate — `provisioning/`'s adapters and `telegram_manager/`); the
existing external `/Users/elul/familytrip-provisioner/` Hermes-profile
worker, evolved rather than replaced (see Task 6).

---

## Reconciliation notes — what this supersedes

An earlier draft of this plan assumed a Docker-Compose-per-trip model
(`docker-compose -p trip-<slug>`, a `docker-socket-proxy`, per-trip host
ports). **That's wrong for this repo's actual target.** The agreed model is
per-trip Proxmox LXCs cloned from the golden template at `192.168.0.202`,
provisioned via the `provisioning/` Python package (`ProxmoxLxcAdapter`,
`NpmProxyHostAdapter`, `CloudflareTunnelDnsAdapter`) — already implemented
with dry-run-by-default `plan`/`apply --execute`/`verify` and rollback
snapshots, just not yet aligned to actually clone CT 202 (see Task 2). Every
part of this plan that talks about "resetting a trip server" or "checking
uptime" means an LXC + its supervised service, not a container.

Two more things the handoff doc makes explicit that an isolated dashboard
design would have missed:

- **The control-plane service must not live directly on the Proxmox host**
  (`docs/kinerary-trip-platform-handoff.md:431`). Give it its own LXC (or
  run it on the Mac next to Hermes) — this is a placement constraint on
  Task 1, not a detail to leave to deploy time.
- **An external, already-working profile provisioner exists**
  (`/Users/elul/familytrip-provisioner/` — outside this repo, on the Mac,
  not reachable from this checkout's environment to inspect directly).
  It already does isolated Hermes profile + workspace creation, a
  restrictive local/LAN HTTP API (`POST /v1/trips`, `/healthz`), and
  duplicate rejection. **Do not rebuild this from scratch.** Task 6 is to
  evolve it into (or wire it as) this plan's companion-profile worker; only
  write a fresh implementation if inspecting it (next session, on that Mac)
  shows it can't be adapted.

## Confirmed product/process decisions carried forward

- "SSL tokens" the super-admin service issues = per-trip API access keys,
  not TLS certs. TLS/ingress stays Cloudflare + NPM, unchanged.
- **Confirmation gate uses the literal keyword `CONFIRM`**, not a loosely
  "explicit yes" — this is what `docs/kinerary-trip-platform-handoff.md`
  §4.2 and the live interviewer persona already implement
  (`~/.hermes/profiles/trip-intake/SOUL.md`, external to this repo).
  `docs/hermes-interviewer-agent.md`'s current wording ("an explicit yes...
  in their own words") is looser than this and should be reconciled to
  match `CONFIRM` as part of Task 7 — don't silently keep two different
  standards live at once.
- Enrichment (fill missing informational text + source photos, never invent
  organizer-owned facts) is fully specified by the existing enrichment plan
  (Tasks 1-8 there). This plan does not re-specify it — Task 4 here is only
  about wiring the control-plane's state transitions around it.
- Companion Hermes agent + per-trip Telegram bot creation should be fully
  automated once `CONFIRM` + a separate explicit public-activation approval
  have both happened — automation target unchanged, mechanism changed (see
  Task 6, Task 8).

## Real-world status — handle with care

- **Japan (`trips/japan-2025/`) is the only safe end-to-end test target** —
  explicitly `approved_replay_test`, never routed publicly.
- **Shiran's Hawaii/USA2026 trip is a real, live, in-progress interview.**
  She has not sent `CONFIRM` yet. Nothing built or run under this plan may
  treat her current `intakes/shiran-usa-2026/answers.json` as confirmed,
  auto-enrich it, or provision anything from it without that explicit
  `CONFIRM` first, followed by a separate explicit public-activation
  approval. Do not use her real data as a test fixture.

---

## Task 1: Control-plane registry service

**Files:**
- Create: `control-plane/` (new service — `package.json`, `Dockerfile` or
  LXC-install script, `src/server.js`, `src/db.js`, `src/registry.js`)
- Create: `control-plane/data/registry.db` (gitignored)
- Test: `tests/control-plane/registry.test.js`

Implements the state machine from `docs/kinerary-trip-platform-handoff.md`
§6 exactly (adopt these names, don't invent new ones):

```text
invited → interviewing → awaiting_organizer_confirmation → confirmed
  → provisioning → verified → awaiting_activation → active
  (or → failed, from any state)
```

Registry row fields per §6: intake ID, trip slug, organizer reference,
interview session reference, confirmed-answer version/time, LXC ID/IP/
hostname, profile name, site/MCP endpoint references,
verification/activation state, audit timestamps. **No secrets in this
table** — those stay in profile-local files / a secret manager, referenced
by name only.

Auth: session cookie for a human super-admin UI (bcrypt, matching
`server/server.js`'s existing pattern), a separate LAN-only API key for the
interviewer/notifier side to post state transitions (`confirmed`,
verification results) — timing-safe compare, same pattern as
`mcp/provision.js`'s `requireKey`.

**Placement**: its own LXC on Proxmox, or Mac-hosted next to Hermes — never
installed directly on the Proxmox host. Decide which when this task is
picked up; either way it has no public ingress (matches `mcp/provision.js`'s
LAN-only posture, stricter given its broader blast radius).

## Task 2: Make CT 202 cloning real (unblocks everything downstream)

**Files:**
- Modify: `provisioning/adapters.py` (`ProxmoxLxcAdapter.create()`)
- Modify: `tests/provisioning/` (adjust/extend fixtures for the clone path)

This is `docs/kinerary-trip-platform-handoff.md`'s Phase B, already
scoped there in detail (§7 Phase B, §5.3's "important gap"). Do not start
Task 3+ before this lands — everything else assumes a real per-trip LXC
exists. Requires read-only Proxmox inventory of CT 202 first (`pct list`,
`pct config`, storage/mount layout) before writing the clone/copy path;
the handoff doc is explicit that a generic `POST /lxc` ostemplate-create is
**not** equivalent and must not be treated as a stand-in.

## Task 3: Registry-driven provisioning trigger

**Files:**
- Modify: `control-plane/src/registry.js` (state transition handlers)
- Create: `control-plane/src/provisioning-client.js` — shells out to
  `python3 -m provisioning plan|apply|verify` (Task 2's fixed adapter),
  parses the JSON plan/rollback snapshot, stores only non-secret references
  back into the registry row.

On `confirmed` → `provisioning`: run `provisioning plan`, then (only after
this plan's own separate human confirmation, mirroring `provisioning/`'s
own `--execute` gate — two independent "are you sure"s is intentional
here, not redundant) `apply --execute`, capturing the rollback snapshot
path in the registry row (not its contents — those may reference live
resource IDs but no secrets, per the existing adapter design). On success,
`provisioning` → `verified` runs `provisioning verify` plus the existing
ingress-hop checklist from `docs/kinerary-trip-platform-handoff.md` §2.2
(loopback → LAN → NPM Host-header → public HTTPS → rendered page, not just
HTTP 200).

## Task 4: Enrichment wiring (no new enrichment logic)

**Files:**
- Modify: `control-plane/src/registry.js` — call the enrichment CLI from
  the existing plan (`scripts/enrich_trip.py`, once built there) between
  `confirmed` and `provisioning`, store its report's `needs_review` count
  in the registry row, surface it in the super-admin UI.

Depends entirely on `.hermes/plans/2026-08-06_063428-...`'s Tasks 1-8
landing first. This task is just the state-machine glue — do not
reimplement geocoding/weather/hero-media logic here.

## Task 5: Fleet visibility + admin actions (LXC-adapted)

**Files:**
- Create: `control-plane/src/health.js` — polls each `verified`/`active`
  trip's `/api/health` over its LXC's LAN IP (from the registry row), same
  shape as the site's existing unauthenticated health route; add a
  `boot_time` field to `server/server.js`'s `/api/health` handler
  (additive only) so uptime is computable.
- Create: `control-plane/src/actions.js` — reset = SSH to the trip LXC and
  restart its supervised service (systemd unit, per
  `docs/kinerary-trip-platform-handoff.md`'s "local service supervision"
  requirement — **not** `docker compose --force-recreate`, there is no
  compose project per trip in this architecture). Key rotation and
  organizer change reuse `mcp/provision.js`'s existing confirm-token
  pattern (`get_activation_plan`/`activate_trip` shape:
  `crypto.randomBytes` token, in-memory single-use store, 5-minute TTL) —
  extract that pattern into `mcp/lib/fleet-core.js` once, shared by
  `provision.js` and `control-plane/`.
- Test: `tests/control-plane/actions.test.js` — proof-not-description for
  every destructive action, same bar as the rest of this repo's security
  tests: a stale/reused/mismatched-slug token must fail, and the SSH
  restart call must not fire until a valid token is redeemed (inject a spy
  in place of the SSH client in tests).

Every mutating action writes one audit-log row (actor, action, target
slug, result, timestamp) — closes the gap that `mcp/provision.js` has no
audit trail today.

## Task 6: Companion Hermes profile automation

**Files:**
- Investigate first (next session, on the Mac where it actually lives):
  `/Users/elul/familytrip-provisioner/` — confirm current behavior against
  `docs/kinerary-trip-platform-handoff.md` §5.5's description before
  changing anything.
- Likely modify (pending that investigation): its manifest schema to
  accept a trip LXC's verified MCP endpoint (per §7 Phase C.3 — the
  profile provisioner must only be handed the endpoint after LXC/site
  readiness has passed, never before) and its allowlist (currently
  hardcoded to the old `.200` assumption per §5.5, must become
  per-trip-dynamic).
- `control-plane/src/companion-profile-client.js` — calls this worker's
  authenticated local/LAN `POST /v1/trips` (already implemented, per the
  handoff doc) on `verified` → the profile-creation half of
  `awaiting_activation`.

Do not write a parallel from-scratch implementation unless the
investigation step shows the existing worker genuinely can't be adapted —
the handoff doc is explicit that duplicating this would create two
competing sources of truth (§7 Phase C.2).

## Task 7: Interviewer reconciliation

**Files:**
- Modify: `docs/hermes-interviewer-agent.md` — replace "explicit yes... in
  their own words" with the literal `CONFIRM` standard already live in
  `~/.hermes/profiles/trip-intake/SOUL.md` (external), so this repo's
  documented contract matches what's actually running. Also reconcile the
  tool-list section: the live interviewer has **no** `create_trip`/
  `activate_trip`/trip-data MCP access at all (§4.2) — stricter than what
  this doc currently describes for the "full access model." Mark that
  model as superseded, not just as an alternative.
- Modify: `mcp/PROVISIONING.md` — cross-reference this plan and the
  handoff doc so the "two ways to wire provisioning" section reflects
  which one is actually in production use.

No code change here — this task is closing a docs/reality gap, which
matters because the next person (or agent) picking up this repo should not
rediscover the same divergence.

## Task 8: Telegram group handoff + login-widget domain (MTProto adapter)

**Files:**
- Create: `telegram_manager/mtproto_adapter.py` — a narrowly scoped,
  explicitly allowlisted BotFather-operation client (Login Widget domain
  read/set/verify for one specific newly-created child bot only — nothing
  else). Per `docs/kinerary-trip-platform-handoff.md` §4.7: dedicated
  authorized user account/session, never a bot token; secrets in a secret
  manager or `0600` local files, never in this repo, trip config, MCP
  responses, or logs; require a per-trip reviewed operation plan and
  idempotent read-back verification before any write; only after confirmed
  intake and child-bot creation; never invoked from a family group or an
  untrusted MCP request.
- Test: `tests/telegram/test_mtproto_adapter.py` — mock the MTProto client
  entirely; assert the allowlist rejects any operation outside
  Login-domain read/set/verify for the specific bot, and that no write
  happens without the reviewed-operation-plan record.

This is genuinely new scope (`"planned, not implemented"` per §4.7) and
sits on the critical path for the Telegram Login Widget ever actually
rendering on a real domain — without it, Telegram SSO stays server-side
tested but never browser-verified (§4.5's current implementation-status
gap).

## Task 9: Login-method security hardening (pre-`active` gate)

**Files:**
- Modify: `server/server.js` — password fallback: replace the shared
  default `1234` seed with an organizer-approved first-password
  enrollment flow (signed, expiring, routed to the organizer's private
  Telegram); Google link: gate `google-link` behind the same organizer
  approval-callback pattern (one-time, expiring, auditable, bound to trip +
  participant + Google `sub`; rejection creates no link).
- Test: `tests/server.test.js` — extend to cover the new approval-gated
  paths; keep the existing Telegram-login forged/expired/non-member test
  coverage intact (`docs/kinerary-trip-platform-handoff.md` §4.5 says this
  part already has solid test coverage — don't regress it).

The handoff doc is explicit these are **not currently production-ready**
(§4.5). A trip reaching `active` in this plan's state machine should not
be possible while these gaps stand — treat this task as a gate on the
`awaiting_activation` → `active` transition, not an independent nice-to-have.

## Task 10: End-to-end pipeline verification

**Files:**
- Create: `tests/control-plane/e2e-onboarding-smoke.sh` (manual/separate
  from `npm test`, mirrors the existing `provisioning/` tests' "no real
  infrastructure contacted by the unit suite" rule — this script is the
  one place real infra gets touched, and only against Japan/non-production
  targets).

Run only against the Japan replay trip, non-public:
```text
confirmed intake (literal CONFIRM, Task 7)
→ enrichment (existing plan) → provisioning plan/apply (Task 2/3)
→ verify (Task 3) → companion profile created (Task 6)
→ per-trip bot created + Login domain set (Task 8, mocked MTProto in test)
→ awaiting_activation, login gates satisfied (Task 9)
→ manual explicit activation approval → active
```
Confirm every ingress hop from `docs/kinerary-trip-platform-handoff.md`
§2.2, not just HTTP 200. Confirm the registry never contains a secret
(grep the raw `registry.db` bytes in the test, don't just trust the code).

---

## Verification and acceptance criteria

1. Task 2 lands and is proven against a real (non-production) LXC clone of
   CT 202 before any later task depends on it.
2. The control-plane service runs off the Proxmox host, with no public
   ingress, and its registry never stores a secret.
3. Every destructive/administrative action (reset, rotate, organizer
   change) is a plan/confirm pair with a single-use, time-boxed,
   slug-bound token, and every one is audit-logged.
4. `/Users/elul/familytrip-provisioner/` is either evolved into this
   pipeline's companion-profile worker or explicitly, deliberately
   superseded with a documented migration — never silently duplicated.
5. `docs/hermes-interviewer-agent.md` and the live interviewer persona
   agree on one confirmation standard (`CONFIRM`) and one tool-access
   model (no provisioning/trip-data MCP access for the interviewer).
6. The MTProto adapter's operation allowlist is proven narrow in tests —
   nothing beyond Login-domain read/set/verify for one bot is reachable.
7. A trip cannot reach `active` while the password/Google login gaps from
   Task 9 are open.
8. Japan completes the full state machine end to end without public
   routing before Shiran's trip (or any real trip) is run through it.
9. Shiran's in-progress intake is untouched by any of this until she sends
   `CONFIRM`, and public activation still requires a separate explicit
   approval after that.
