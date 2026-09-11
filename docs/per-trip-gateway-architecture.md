# Per-trip gateway processes — the companion runtime architecture

**Status: proposed architecture, not yet implemented.** Written 2026-09-06.

Supersedes §4 of `hermes-multiplex-execution-boundary.md` (per-profile MCP
inside one multiplexed gateway). That analysis stays where it is, and stays
correct — it is now recorded there as a **rejected alternative**, because the
finding that killed it is also the finding that made this document possible.

Sibling to `activation-scope.md`. See `onboarding-to-active-plan.md` for where
this sits in the organizer journey.

## 1. The direction

```
Shared bot / connector
  → Kinerary-owned trip routing
    → one Hermes gateway process per trip
      → trip-owned MCP / runtime
```

One Telegram bot. One Kinerary relay. Routing decided by Kinerary, in
Kinerary's database, before Hermes is involved. Then **one gateway process per
trip**, each with its own Hermes home, each talking to its own trip's MCP
service inside that trip's own container.

**The isolation boundary is the process plus its per-trip Hermes home — not a
separate installation.** Gateways share the Hermes codebase, the venv, and
provider credentials where sharing is safe and already locked. What they do not
share is the thing that was never isolable in-process: connections.

### Why this, and not the multiplexing fix

The multiplex design existed to make *one* process safely serve *many* trips:
per-turn tool visibility, fail-closed dispatch, capturing an owning scope in
`MCPServerTask` so a timer-driven reconnect could not borrow another trip's
secrets. Every one of those mechanisms answers the question "whose tools are
these?"

A process that only knows one trip never asks that question. The design is not
deferred; it is unnecessary.

### It is not a new deployment model

Six gateway processes, one installation, are running on the provisioning Mac
right now and have been for days:

```
python -m hermes_cli.main --profile kinerarytest    gateway run --replace
python -m hermes_cli.main --profile familytrip      gateway run --replace
python -m hermes_cli.main --profile elulhome        gateway run --replace
python -m hermes_cli.main --profile shiranusa2026   gateway run --replace
python -m hermes_cli.main --profile trip-intake     gateway run --replace --external-supervisor
python -m hermes_cli.main                           gateway run --replace --external-supervisor
```

macOS launchd units already exist per profile (`ai.hermes.gateway-<n>.plist`).
This document does not propose a runtime model; it proposes routing Kinerary's
trips onto the one already in production use.

## 2. The mechanism

`hermes_cli/main.py:521` — *"Pre-parse `--profile`/`-p` and set `HERMES_HOME`
before imports."*

`HERMES_HOME` becomes `~/.hermes/profiles/<name>` **before any Hermes module is
imported**. Every module-level global therefore resolves inside that profile for
the life of the process. That is the entire isolation mechanism, and it is why
the boundary needs no per-subsystem work: there is nothing to scope, because
nothing shared was ever constructed.

## 3. Per-trip vs. intentionally shared

### Per-trip (one gateway process, one Hermes home)

| Concern | Where it lives |
|---|---|
| MCP `_servers` + tool registry | discovered at launch under that home |
| Sessions / runtime state | `profiles/<n>/sessions`, own `state.db` |
| Secrets | `profiles/<n>/.env` |
| Caches | `cache/`, `image_cache/`, `audio_cache/`, `models_dev_cache.json` |
| Reconnect / background tasks | process-local; no foreign scope to inherit |
| Control socket | `profiles/<n>/gateway.sock` |
| Config | `config.yaml`, `config.overlay.yaml`, `profile.yaml` |
| Agent identity | `SOUL.md`, `skills/`, `memories/`, `references/` |
| Cron, pairing, plans, hooks | per-profile subdirectories |
| Logs | `profiles/<n>/logs/gateway.log` |

### Intentionally shared

| Thing | Why it is safe |
|---|---|
| `~/.hermes/hermes-agent` + venv | read-only code; 1.5G, not worth duplicating |
| `~/.hermes/auth.json` | provider credentials. `hermes_cli/auth.py:6`: *"persisted in ~/.hermes/auth.json with cross-process file locking"* — designed for concurrent processes, and six have been exercising it |
| The launchd/systemd supervisor | per-unit config, shared mechanism |
| The Telegram bot token | held by Kinerary's relay, never by a gateway |

The bot token line matters: a per-trip gateway is **relay-exclusive**. It holds
no messaging credential at all, so no trip's gateway can reach Telegram except
through Kinerary's connector, which decides what it is allowed to see.

## 4. How connector.ts maps a resolved trip to a gateway

### The routing decision is already Kinerary's

`normalize.ts:9` — *"`source.profile` IS the trip context, unconditionally, for
that turn"* — stamped from `resolveChatRoute`, a database lookup on the chat →
trip binding, at the trust boundary documented in `protocol.ts:23`. Hermes is
*told* which trip a message belongs to. It never decides.

That half needs no change. `route.hermesProfile` is already the address.

### The gap: the connector broadcasts

`connector.ts:391`:

```ts
pushInbound(event) {
  for (const ws of this.sockets) { … }   // sockets is a bare Set
}
```

Every connected gateway receives every message. With one gateway that is
correct; with one gateway per trip it is exactly wrong.

### The change

`authorizeUpgrade` already resolves the gateway's identity from its bearer
token and logs it (`connector.ts:164-166`), then discards it.
`verifyUpgradeToken` returns the token payload — the `gatewayId` — and
`gatewaySecrets` is already a list supporting many gateways
(`server.ts:178`). So:

1. Keep the identity: `onConnection(ws, gatewayId)`.
2. Store `Map<string, Set<WebSocket>>` keyed by `gatewayId`.
3. Route: `pushInbound(event)` sends only to sockets registered under the
   gateway id for `event.source.profile`.
4. No socket for that profile → the message is not silently dropped; see §7.

**The gateway id is the profile name.** One address, derived from the binding
already stored in `trip_chat_bindings.hermes_profile`, with no second registry
to keep in sync.

`scripts/companion-install-host.sh` writes `GATEWAY_RELAY_URL` /
`GATEWAY_RELAY_ID` / `GATEWAY_RELAY_SECRET` into the profile's `.env` as part
of installing the companion, and starts the gateway under a launchd label of
its own — so the identity a gateway presents is provisioned, not asserted.
Both values are derived host-side from the same architecture profile the relay
itself reads; neither comes from the handoff.

**Not** `hermes gateway enroll`, despite the name. That subcommand redeems a
single-use token against the hosted Nous connector and requires a portal
login. This relay authenticates a gateway with a shared secret and takes its
identity from the id, so per-trip enrollment here is "same secret, distinct
id" — three env stamps, no round trip.

Until 2026-09-10 nothing performed that step at all, and this section
described the wrong command as though it did. Two trips shipped unenrolled.
The failure is not silence: with no identity of its own, a gateway is served
the fallback's traffic, so japan-2026's organizer was answered *in the
interviewer's voice, out of the interviewer's profile*, about their own trip.
It was repaired by hand and not written down, so italy-2026 shipped the same
way hours later.

### The one declared exception

The gateway running today does not follow that rule and cannot:
`profiles/trip-intake/.env` carries `GATEWAY_RELAY_ID=kinerary-trip-intake`,
while the profile it is stamped with is `trip-intake`. More fundamentally, a
multiplexing gateway serves *every* profile under *one* id, so no identity rule
could ever match it.

`relay.multiplex_gateway_id` names it: the gateway that receives turns no
per-trip gateway claims.

Declared, not inferred. "If only one gateway is connected, send it everything"
looks equivalent and behaves very differently the moment that single gateway is
a *trip's own* — it would hand one family's companion another family's
conversation, which is the failure this architecture exists to make
structurally impossible. Naming the multiplexing gateway makes the exception
visible, auditable, and deletable: unset the key and routing is exact, with no
code change.

### Defence in depth

With `multiplex_profiles` **off**, `gateway/run.py:7810` honours
`source.profile` only under multiplexing. A single-trip gateway ignores the
stamp entirely and serves its own profile.

That is the property worth having: a misrouted message degrades to *the wrong
gateway answering as itself* — and since it has no binding for that chat, to
silence — rather than to one family's companion speaking with another family's
data. Kinerary's routing is the correctness mechanism; the process boundary is
the containment mechanism. Neither depends on the other being right.

## 5. Lifecycle

### Provisioning (install-time)

The existing companion install path already produces a per-trip profile. It
gains two steps at the end, both inside the same host-side trust boundary
(`scripts/companion-install-host.sh`), both derived host-side from the
validated handoff:

1. `hermes --profile <n> gateway enroll` — writes relay id/secret/URL into the
   profile `.env`.
2. `hermes --profile <n> gateway install` — writes the launchd unit.
3. `hermes --profile <n> gateway start`.

Nothing about the adapter contract changes. `CompanionProfileAdapter.install()`
still means "materialize this companion from this validated handoff"
(`companion_profile.py:157`); it now materializes a running one.

**SSH remains install-time only.** A provisioned trip's routing, binding and
chat traffic never touch it — the running gateway is reached over the relay
socket it dials outward, and the MCP over the trip's own network.

### Runtime (Stage 1: always-running)

**Active trips get always-running gateways. No lazy wake, no buffering.**

The measurements say we can afford it: **~25 MB RSS per idle gateway**, stable
across three days of uptime. Forty concurrent trips fit in a gigabyte. Lazy
wake buys nothing at Kinerary's current scale and costs the two things Stage 1
cannot absorb — a cold-start delay on the first message of a conversation, and
a buffering layer the connector does not have (`pushInbound` queues nothing,
by design and by comment).

For the record, if it is ever needed: cold start measured at ~2–3s (exec →
control socket 1.2s → serving 3.3s), and `gateway/scale_to_zero.py` is
Fly-specific (self-suspend via the Machines API socket), so a local idle-stop
would be ours to write. Deferred deliberately.

### Shutdown

`hermes --profile <n> gateway stop`. Teardown is bounded and observable —
measured at 2.34s total, with phase-by-phase logging (`notify_active_sessions`,
`drain`, adapter disconnect, tool kill, SessionDB close).

Trip lifecycle maps onto it directly: a trip leaving active state stops its
gateway; the profile and its state stay on disk, so restarting is a `start`,
not a re-provision.

## 6. What "gateway ready" means

Routing traffic to a gateway that is up but not serving loses the turn —
`pushInbound` does not queue. Readiness must be **read off the gateway**, not
inferred from a process existing. Three levels, cheapest first:

1. **Process claim** — the PID-file claim, "the point where this process
   becomes the authoritative gateway for its HERMES_HOME"
   (`gateway/control_socket.py:229`). Necessary, not sufficient.
2. **Control socket answers** — `profiles/<n>/gateway.sock` responds to
   `status` with a live payload (`build_status_payload`). Proves the process is
   past startup and responsive.
3. **Relay socket registered** — the connector has a socket under this
   gateway's id. This is the only one that proves *a message would arrive*, and
   it is checkable from the connector's own state rather than from the host.

**Kinerary should gate routing on (3), because (3) is the claim being made.**
It is the same discipline `interview-stack-deploy` already applies: that skill
greps the *gateway's own* post-restart log for each expected tool name rather
than trusting that an upstream process is alive. Same failure it was written to
prevent — "restarted" is not "serving".

Readiness for the *product* loop additionally requires the trip's MCP to have
connected. That is checkable, cheaply, off the gateway's own startup log, and
belongs in the same probe rather than in a human's memory.

## 7. Failure behaviour and reason codes

The vocabulary already exists and already fits. `normalize.ts:110`:

```
"NO_MESSAGE" | "NO_CHAT_ID" | "NO_TEXT" | "FROM_BOT" | "UNROUTED" | "INTERVIEW" | "COMPANION_PENDING"
```

| Situation | Reason | Organizer sees |
|---|---|---|
| Chat has no trip binding | `UNROUTED` | `strings.unbound` |
| Binding exists, no companion profile | `COMPANION_PENDING` | `strings.companionPending` |
| Profile exists, **gateway not connected** | `COMPANION_PENDING` | `strings.companionPending` |

The third row is the new one, and it needs no new code path.
`normalize.ts:276` already returns `COMPANION_PENDING` on
`!route.hermesProfile`, and `dispatch.ts:322` already answers it with a real
reply rather than silence.

This is the A2/A4 requirement landing exactly where it was aimed: **a binding
existing must not imply the destination is reachable.** Under per-trip
gateways, "reachable" acquires a direct, honest test — is there a socket under
this profile's id — instead of being assumed from a row's existence. A trip
whose gateway is down is *recoverably* unreachable: `gateway start`, no
re-provision, no manufactured healthy state, and the reachability record from
migration 0042 keeps saying so until the socket comes back.

## 8. Session implications of dropping multiplexing

Session keys change namespace. `gateway/run.py:7805-7818` computes the profile
segment only under multiplexing:

```python
_profile = None
if getattr(config, "multiplex_profiles", False):
    …
```

So `agent:japan20262:telegram:dm:391627336` becomes the legacy
`agent:main:telegram:dm:391627336`.

Three consequences:

1. **No collision risk.** Each gateway has its own `profiles/<n>/sessions` and
   its own `state.db`. The profile segment was namespacing keys inside a shared
   store; with separate stores it is redundant.
2. **Existing sessions do not carry over** unless keys are migrated. For trips
   whose companion has never worked, there is nothing to lose.
3. **It fixes a live bug.** The current multiplexed gateway logs:

   ```
   Agent cache invalidated for session agent:japan20262:telegram:dm:391627336:
   message_count changed (1516 -> 2), possible cross-process write
   ```

   That is §5 of the multiplex doc — key namespaced, session *ID* colliding
   across profiles — showing up in production. Separate homes remove the shared
   store the collision needs, so the fix falls out of the architecture instead
   of being scheduled after it.

## 9. The product loop, verified

The requirement: **live bidirectional access to the same canonical trip state
the website uses.** A references-only snapshot does not qualify.

```
User ↔ Companion ↔ trip-owned MCP/runtime ↔ canonical trip state ↔ Website
```

Verified end to end on 2026-09-06, `hermes --profile japan20262 mcp test trip-mcp`:

```
Transport: HTTP → http://192.168.0.61:3001/sse
Authorization: Bear***49b3
✓ Connected (400ms)
✓ Tools discovered: 41
```

Link by link:

- **User ↔ Companion** — shared bot → Kinerary relay → this trip's gateway
  (§4). The routing that gets it there is already built and already Kinerary's.
- **Companion ↔ MCP** — 41 tools over SSE, authenticated with this trip's own
  key, from a process that resolved `mcp_servers` under this trip's home. The
  live half is proven: reads (`get_config`, `get_phase_plan`, `get_bookings`,
  `get_photos`) and writes (`add_plan_item`, `update_plan_item`,
  `swap_plan_days`, `set_plan_day_label`, `post_venue_comment`, `add_booking`,
  `post_lost_found`).
- **MCP ↔ canonical state** — the MCP runs *inside the trip's own container*
  (192.168.0.61) against the trip's own server and database. Not a copy.
- **State ↔ Website** — the same server that renders the site.
  `get_phase_plan` is documented as *"THE ACTIVE PLAN for a phase — the live
  day-by-day"*: the plan the site shows, in the vocabulary the site uses.

So the loop closes, bidirectionally, on live state. `references/` remains what
it should be — the companion's briefing, not its database.

**And the reason it does not close today is now precisely stated.**
`profiles/japan20262/config.yaml` has carried correct `mcp_servers` config all
along. No process has ever loaded it, because no gateway has ever run
`--profile japan20262`. The config was never wrong; nothing was ever listening
to it.

## 10. Mapping to a per-trip K3s pod

This architecture is the same shape as its own successor, which is the strongest
argument for it.

| Today (Stage 1) | K3s |
|---|---|
| One gateway process per trip | One pod per trip |
| `--profile <n>` → `HERMES_HOME` | `HERMES_HOME` on a per-trip PVC |
| launchd unit per profile | Deployment per trip |
| `gatewayId` = profile name | Service name / label selector |
| Relay socket dialled outward | Same socket, same direction |
| trip-mcp at `192.168.0.61:3001` | per-trip Service, cluster-internal |
| Shared `auth.json`, file-locked | Secret mounted into each pod |
| `gateway start` / `stop` | replicas 1 / 0 |
| Always-running (§5) | replicas: 1 |

Nothing above the adapter changes. `CompanionProfileAdapter.install()` keeps
meaning "materialize and activate this companion from this validated handoff";
only the adapter behind it changes, and `SshCompanionProfileAdapter` is deleted
rather than migrated — which is what `companion-install-host.sh:24` already
committed to in writing: *"This is a BRIDGE, not a foundation."*

The lazy-wake work deliberately skipped in §5 is the one piece K3s would supply
for free (`replicas: 0` plus an activator). Another reason not to build it now.

## 11. Smallest implementation sequence

Ordered so the acceptance path keeps working at every step, and so the riskiest
change is the last one rather than the first.

**1. Connector: key sockets by gateway id.** — **BUILT (2026-09-06)**
`Map<profile, Set<WebSocket>>` in `connector.ts`, keyed off the authenticated
upgrade token; `pushInbound` routes by `event.source.profile`, with
`relay.multiplex_gateway_id` taking what no per-trip gateway claims. Inert on
today's deployment once that key names `kinerary-trip-intake`. Six routing
tests, including the cutover case (a trip's own gateway taking its traffic away
from the multiplexing one) and disconnect/reconnect.

One pre-existing test changed rather than being added to: *"an event reaches a
connected gateway with its profile intact"* dialled as `gw_1` and pushed an
event for `companion-japan`, which passed only because delivery was a
broadcast. It now dials as the profile it serves. The test's intent survives;
what it asserted about addressing did not, which is the point.

**2. Reachability: no socket ⇒ `COMPANION_PENDING`.** — **BUILT (2026-09-06)**
`connector.canReachProfile(profile)` answers from live socket state;
`normalize.ts` takes it as an optional `ReachabilityCheck` and applies it after
the existing `!route.hermesProfile` test. Same reason code, same organizer-
facing string, one more true condition. Optional so it ships inert: a caller
that passes nothing keeps today's behaviour exactly.

Asked per update rather than cached — a gateway can stop between one message
and the next, and a stale "reachable" spends the organizer's turn on a socket
that is gone.

**3. Stand up one trip gateway by hand: japan-2026-2.**
`gateway enroll` + `install` + `start` for `japan20262`, `multiplex_profiles`
off. This is the acceptance test: the connector now has two gateways, so step 1
starts routing for real and step 2 starts answering for real. Verify against
`interview-stack-deploy`'s standard — read tool registration off *the gateway's
own* log, then close the §9 loop from a real chat: ask the companion something
only the live site knows, then have it write, and confirm the write on the
site.

**4. Turn `multiplex_profiles` off on trip-intake.**
Only after step 3 proves a per-trip gateway serves a real conversation. The
interviewer becomes what it always should have been: one profile, one process,
one job. Session keys move to the legacy namespace here (§8) — expected, and
the point at which the `message_count 1516 -> 2` collision should stop
appearing.

**5. Wire enroll/install/start into provisioning.**
Extend `companion-install-host.sh`, host-derived as always. Only now, when the
manual sequence in step 3 is known to produce a working companion, is there
something worth automating.

**6. Delete the multiplex path from Kinerary's side.**
Kinerary stops depending on `source.profile` selecting an in-process scope. The
stamp stays — it is the routing address (§4) — but nothing downstream of Hermes
reads it as a profile switch.

Steps 1 and 2 are inert on today's deployment. Step 3 is the first behavioural
change, it is one trip, and it is reversible by stopping one process.
