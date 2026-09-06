# Hermes multiplexing — what is per-profile, what is process-global

> **Status: SUPERSEDED as a plan; retained as analysis and as the rejected
> alternative.** The chosen architecture is
> `per-trip-gateway-architecture.md` — one Hermes gateway *process* per trip,
> sharing one installation. **§4 below (per-profile MCP inside one multiplexed
> gateway) will not be built.**
>
> Kept, in full, deliberately. §1–§3 are measurements of the running system and
> remain true; §5's session-ID collision is a real observed bug; and §4 is the
> record of what the alternative would have cost, which is the reason the
> alternative was rejected. A design discarded without its reasoning is a design
> that gets re-proposed.

**Originally written 2026-09-06** as investigation and design, after a trip
companion answered correctly from its reference files while telling the
organizer "I can't read the live site" — because its MCP server had never
connected, and never could.

Sibling to `activation-scope.md`: both record a boundary that has to be decided
before code is written against it. Read `onboarding-to-active-plan.md` for where
this sits in the journey.

## 1. The one-sentence finding

**Multiplexing scopes DATA correctly and does not scope CONNECTIONS.**

Config, skills, memory, SOUL, sessions and secrets are all properly
per-profile. MCP is different in kind — long-lived connections and subprocesses
in a process-global registry, with tools registered into a global namespace —
and it is not scoped at all.

## 2. The boundary, measured

### 2.1 Correctly per-profile

`gateway/run.py`'s `_profile_runtime_scope` does this deliberately and well,
through two seams:

- **`set_hermes_home_override`** — a *contextvar*, so it propagates into the
  agent worker thread via `copy_context()`. Redirects `get_hermes_home()`, and
  with it config, skills, memory, SOUL and sessions.
- **`set_secret_scope`** — installs the profile's `.env` as an isolated dict
  rather than mutating `os.environ`, "which is what keeps subprocesses (MCP,
  kanban) from inheriting cross-profile secrets".

Verified behaviourally: the companion read its own
`references/interview-context.private.json` and answered with its own trip's
phases, hotels and activities. Cron is profile-aware too — the gateway logs
"Cron scheduler will tick 3 profile(s) under multiplex".

### 2.2 Process-global: MCP

`tools/mcp_tool.py`:

```python
_servers: Dict[str, MCPServerTask] = {}          # module-level
_server_connect_errors: Dict[str, str] = {}
```

`_load_mcp_config()` calls `load_config()` — the *process's* config. Discovery
runs once, from `hermes_cli/mcp_startup.start_background_mcp_discovery`, at
process launch, under the launch profile's home. The only re-discovery inside
the gateway is `_execute_mcp_reload` — a user-typed `/mcp reload`. Never
per-turn.

Upstream already knows this bug class. `hermes_cli/mcp_startup.py:70`:

> "'switched' to profile X would discover the LAUNCH profile's `mcp_servers`
> instead (#67605)."

That fix covers a CLI profile switch at launch. The multiplex case is not
covered.

**Evidence:** `grep -c "trip-mcp" gateway.log` → **0**. Never registered, for
any companion, ever — including `japan2026`, whose `127.0.0.1:3013` entry has
been in config for days with a matching `node mcp.js` running and no consumer.

**There is no leak today.** No companion sees another trip's MCP because no
companion sees any MCP. The isolation requirement is satisfied vacuously; the
capability is what is missing. That distinction matters when weighing risk.

### 2.3 Session: key namespaced, ID not

`gateway/session.py`'s `build_session_key(..., profile=...)` — "`profile`
selects the key namespace" — yields `agent:japan20262:telegram:dm:391627336`,
and each profile has its own `state.db`. **Message history does not merge
through storage.**

The session *ID* does collide:

```
japan20262    12 msgs   20260825_011320_d52a9d49
trip-intake  176 msgs   20260825_011320_d52a9d49   <- the interview
```

Same ID, both profiles. The agent log carries `[20260825_011320_d52a9d49]` for
yesterday's interview turns *and* today's companion turns. This is the hazard
`scripts/fresh-interview.py` documents in its own words: "three profiles shared
one session for that DM, created identical to the microsecond." The
`message_count changed (1516 -> 2)` cache invalidation is that seam moving.

## 3. Why this blocks Kinerary specifically

The requirement is stronger than "switch the prompt": selecting a trip
companion must establish a real per-trip execution context, and a companion
must never see another trip's tools or conversational state.

Today a companion gets its own SOUL, references, memory, secrets and session
store — and no tools at all. It can describe the trip from the handoff written
at provision time, and cannot read anything live: no bookings, no photos, no
comments, no updates. Every answer is as old as the last provision.

## 4. Design — making MCP profile-scoped — REJECTED

> **Not being built.** Every mechanism below exists to answer one question:
> *whose tools are these?* A gateway process that serves exactly one trip never
> asks it. Superseded by `per-trip-gateway-architecture.md`; retained because
> the cost sized here is what justified rejecting it.

A bounded upstream change in Hermes, not a Kinerary patch. Sized here so the
decision in §6 is informed rather than guessed.

### 4.1 Registry keying

```python
_servers: Dict[str, Dict[str, MCPServerTask]]        # profile -> name -> task
_server_connect_errors: Dict[str, Dict[str, str]]
```

Profile resolved from `get_hermes_home_override()`, falling back to a `default`
bucket so single-profile gateways keep byte-identical behaviour — the same
compatibility posture `build_session_key` already takes.

### 4.2 Discovery and connection lifecycle

Discovery becomes lazy and per-profile: the first turn for a profile discovers
that profile's servers, inside the existing `_profile_runtime_scope`. Not eager
at launch, because a multiplexer may host many profiles and most are idle;
connecting every trip's MCP at boot would make gateway start scale with trip
count and hold sockets open for conversations that never happen.

The existing failure cooldown (`#50394`'s restart-storm guard) must become
per-(profile, server) rather than per-server, or one trip's unreachable MCP
suppresses retries for a different trip's healthy one.

### 4.3 Tool registration and per-turn visibility

This is the substantive half, and the reason this is not a config fix.

Tools register into a toolset named `mcp-{server}` with names shaped
`mcp__{server}__{tool}`. Two profiles both defining `trip-mcp` therefore
produce *identical* tool names in one process. Today that cannot happen because
only one profile's servers ever load; under this change it becomes the normal
case, since every trip companion will define `trip-mcp`.

Two options:

- **Namespace the toolset** — `mcp-{profile}-{server}`, tools
  `mcp__{profile}__{server}__{tool}`. Unambiguous, but the tool name leaks the
  profile into the model's context and changes names single-profile users see.
- **Keep names, scope visibility** *(preferred)*. Registration stays
  `mcp__{server}__{tool}`; the agent's tool list is filtered per turn to the
  active profile's servers. Names stay stable, and a companion cannot see
  another trip's tools because they are never offered.

Preferred option requires the tool-list assembly to consult the active profile,
which is where the real work is: the registry is global today and the agent
reads it wholesale.

**Isolation must be enforced at call time, not only at list time.** A model
that has seen `mcp__trip-mcp__get_bookings` in one turn may emit it in another;
dispatch must resolve the tool through the *active profile's* registry and fail
closed on a miss, rather than falling through to whichever server holds that
name.

### 4.4 Reload and reconnect

`/mcp reload` currently rebuilds the global registry. Under this change it must
rebuild only the invoking profile's bucket — and note the latent hazard today:
a `/mcp reload` typed in a companion chat runs under that profile's scope and
would discover *its* servers into the shared registry, replacing the host's.

Keepalive/reconnect (`MCP server 'interview' keepalive failed... → degraded`)
must reconnect under the owning profile's secret scope, not whichever profile
happens to be active when the timer fires. This is the subtlest part of the
change: the reconnect path is timer-driven and has no inbound turn to inherit
scope from, so the owning profile must be captured in `MCPServerTask` at
creation and re-entered on reconnect.

### 4.5 Secret scoping

Already correct and must be preserved: `build_profile_secret_scope` returns an
isolated dict and does not touch `os.environ`, so a stdio MCP subprocess
inherits nothing cross-profile. Per-profile registries make this *more*
important — a server task created under profile A must never be reconnected
with profile B's `${...}` interpolations, which is what §4.4 captures.

### 4.6 Cleanup

`shutdown_mcp_servers()` becomes per-profile, plus a global sweep at process
exit. Idle eviction is worth having once discovery is lazy: a multiplexer
serving fifty trips should not hold fifty MCP connections forever because each
was messaged once. Suggest closing a profile's servers after a configurable
idle period, reconnecting on the next turn — the reconnect path exists anyway.

### 4.7 What this does not need

No change to the config schema, `_profile_runtime_scope`, secret scoping, or
session keys. The contextvar seam is already correct; MCP simply never
consulted it.

## 5. Separate issue — the session-ID collision

Independent of MCP, and worth its own fix.

**What is safe today:** message storage (per-profile `state.db`) and the
session *key* (`build_session_key` namespaces by profile).

**What is not:** anything keyed on the raw session ID within one process.
`agent/aux_accounting.set_accounting_context(session_db, session_id)` pairs the
ID with a profile-scoped DB and is therefore fine; in-memory maps such as
`_pending_native_image_paths_by_session` are keyed on the ID alone and would
collide for the same DM across profiles.

**Should the ID itself be namespaced?** Probably not directly — it is persisted
in `state.db` rows and in log prefixes, and changing its shape is a migration
for every profile. The cheaper, equally sufficient fix is to key in-process
maps on the already-namespaced session *key* and leave the stored ID alone.
That should be verified by enumerating raw-ID keying rather than assuming the
two cases found here are all of them.

Kinerary mitigates today by having `fresh-interview.py` clear the chat's
gateway conversation between runs — a workaround for exactly this, and a sign
the hazard is real rather than theoretical.

## 6. Recommendation — superseded by §7

Deferred to the reader of §4: the change is **bounded but not small**, and it
is genuinely upstream.

Bounded, because the seam it needs already exists — `_profile_runtime_scope` is
correct, the contextvar propagates, secrets are already isolated, and
`build_session_key` sets the compatibility precedent for a `default` bucket.

Not small, because §4.3 and §4.4 are behavioural: per-turn tool visibility with
fail-closed dispatch, and reconnect under a captured owning scope. Those touch
the tool registry and the MCP task lifecycle, which every Hermes user depends
on — and this is a local fork carrying 9250 commits, so the change is ours to
maintain.

The honest risk comparison is that **there is nothing to leak today**, so this
work buys capability, not safety. It should be scheduled as a feature and
reviewed as one.

## 7. Outcome — why §4 was rejected

Written 2026-09-06, after §1–§6.

§2.2's finding was that MCP connections are process-global while everything
else is correctly per-profile. §4 took that as a defect to repair inside the
process. Inspecting the running system afterwards showed the repair was
unnecessary: **six Hermes gateway processes, one installation, were already
running on the provisioning Mac**, each with its own `HERMES_HOME`, and
`hermes_cli/main.py:521` sets that home *before any module is imported*.

Process-global state is only a problem when a process serves more than one
trip. Give each trip its own process and every mechanism in §4 — registry
keying, per-turn tool visibility, fail-closed dispatch, scope capture in
`MCPServerTask`, per-profile cleanup — has nothing left to decide.

Measured, same day:

- **~25 MB RSS per idle gateway**, stable over three days of uptime.
- `hermes --profile japan20262 mcp test trip-mcp` → **41 tools, connected in
  400ms**, against the trip's own container with the trip's own key.

The second result also relocates the original bug. `profiles/japan20262/config.yaml`
had correct `mcp_servers` config the whole time. Nothing was wrong with it; no
process had ever been started that would read it.

§5 (the session-ID collision) is not superseded — but under per-trip processes
it dissolves rather than needing the fix proposed there, because separate
profile homes remove the shared session store the collision requires. See
`per-trip-gateway-architecture.md` §8.
