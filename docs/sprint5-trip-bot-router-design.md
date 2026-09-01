# Sprint 5 — Trip Bot router: design note and an open decision

Status: **decision needed before implementation.** Branch
`sprint/5-organizer-profile-router`, worktree
`.claude/worktrees/sprint-5-organizer-router`, based on `main` @ `fc809a0`
(PR #10, Sprints 0–4.7). Baseline `cd tests && npm test`: 405 pass, 0 fail.

## What the router has to do

Three separately-recorded requirements all converge on one missing component:

1. **One-tap onboarding.** `https://t.me/<bot>?start=<enrollment_token>` must
   start the bot and authorize the conversation in one tap. Hermes's gateway
   discards *every* `/start` before it reaches the agent, so this is
   structurally impossible while Hermes owns the Telegram connection.
2. **Real buttons.** Choice questions and the Confirm / Keep-planning step need
   `inline_keyboard`, not typed text. Hermes's Telegram adapter can send
   inline keyboards, but only for its own internal flows — no tool exposes
   them to the conversational agent.
3. **Deterministic trip selection.** The Trip Context Gateway must resolve
   organizer/trip/channel/role from a server-side fact, never from something
   the model or the message chose.

All three need the same thing: **a process that owns the Telegram connection,
handles the deterministic parts itself, and hands Hermes only the
conversational turns.**

## The finding: Hermes already specifies this component

`~/.hermes/hermes-agent/docs/relay-connector-contract.md` (v1, EXPERIMENTAL,
781 lines) defines a **relay ↔ connector** split that is the same shape:

- The gateway runs a generic `RelayAdapter` that dials **out** over WebSocket
  to a *connector*. There is no gateway-side inbound port.
- **The connector owns the platform socket and every platform secret.** The
  gateway holds zero platform credentials and performs no platform crypto —
  an invariant with a test enforcing it
  (`tests/gateway/relay/test_relay_sheds_crypto.py`).
- **Tenant is resolved from the event's own discriminator** (Telegram
  `chat_id`) — explicitly "never from which token/socket/process delivered
  it". That is requirement 3, already written down as the contract's rule.
- Phase 6 gives **per-instance delivery**: one shared bot fronts many
  users/agents without cross-delivery. That is the two-trip isolation matrix.
- Phase 7 adds an **account-link DM path**: a user binds their account to an
  instance with a one-time code redeemed by DMing the shared bot. That is
  requirement 1's enrollment token, and the contract's routing rule for an
  **unlinked author is fail-closed** — which is exactly the decision point
  where an unbound chat should fall to interviewer mode.

So Sprint 5's "shared Trip Bot router" is, in Hermes's own vocabulary, a
**Telegram connector**.

### The `multiplex_profiles` blocker: Telegram collision defused, cron duplication is not

Recorded previously: per-profile routing needs `gateway.multiplex_profiles:
true`, but `profiles_to_serve()` unconditionally prepends the `default`
profile, whose `.env` holds a live `TELEGRAM_BOT_TOKEN`, and the mere presence
of that var auto-enables a second Telegram adapter that collides with the
running `ai.hermes.gateway` launchd service. An allowlist cannot exclude
`default`. Hence the setting was turned back off on 2026-08-27.

**Verified 2026-08-31 against the installed Hermes 0.20.5 — the Telegram
collision is genuinely defused under relay-exclusive mode**, and by a stronger
mechanism than expected. `GATEWAY_RELAY_URL` is not merely *falling back* to
the process value for the prepended `default` profile; it sits on an explicit
**global env allowlist** that bypasses profile scoping entirely
(`agent/secret_scope.py:129-130`, short-circuited to `os.environ` at
`secret_scope.py:172-174` before the scope is ever consulted). The rationale
comment there names this exact code path: the "relay-exclusive sweep in
gateway/config.py must keep seeing them."

`TELEGRAM_BOT_TOKEN` is deliberately **not** on that allowlist, so `default`'s
token still resolves per-profile and still auto-enables Telegram at
`config.py:1991` — and then the relay-exclusive sweep at `config.py:2866-2889`
disables it again, later in the same `_apply_env_overrides` pass. The sweep
runs **per profile**, not once for the active one: `load_gateway_config()` is
called inside each profile's scope (`run.py:15465-15470`) and the adapter loop
skips whatever the sweep disabled (`run.py:15500-15502`).

Corroborated three ways: an upstream test for this precise scenario
(`tests/gateway/test_config.py:774`,
`test_relay_exclusive_reads_profile_scoped_env`, whose docstring says "an
isolated multiplex scope is never consulted for globals"), a standalone
reproduction against this install in an isolated temp home — `telegram=False`
with the relay stamp, `telegram=True` without it — and the deployment path
(`hermes_cli/env_loader.py:499-500` loads a profile's `.env` with
`override=True`, so a stamp in `profiles/trip-intake/.env` becomes a real
process global).

**But two other mechanisms still make `multiplex_profiles: true` unsafe here,
and the relay sweep does nothing about either:**

1. **Duplicate cron execution — live and unmitigated.** `run.py:31238-31245`
   passes `_multiplex_profile_homes(...)` to the cron ticker: the same
   unconditional `default` prepend. `~/.hermes/cron/jobs.json` currently holds
   two enabled jobs on `default` — `trip-mcp-icloud-sync` and
   `shiran-group-gentle-reengagement`. A multiplexed trip-intake gateway would
   tick both a second time, concurrently with the launchd gateway already
   ticking them. The sweep only mutates `config.platforms`; cron is untouched.
   The re-engagement job appears to send messages, so this is a duplicate-send
   risk, not merely wasted work.
2. **No cross-process lock stops it.** `status.py:223-228` resolves the gateway
   lock relative to `_get_process_hermes_home()`, so the launchd gateway locks
   `~/.hermes/` while a trip-intake multiplexer locks
   `~/.hermes/profiles/trip-intake/`. Different paths, no contention.

So the answer to "can we finally turn multiplexing on?" is: **the reason it was
turned off is fixed; a different reason has taken its place.** Turning it on
needs `default`'s two cron jobs dealt with first — disabled, moved, or the
multiplexer run with cron off. That is a decision about a live personal
profile, so it is Dror's, not something to change from here.

**One architecture constraint that lands on Sprint 5 either way:** secondary
profiles are deliberately denied their own relay adapter
(`run.py:15503-15510`). The **active** profile owns the single connection, and
inbound turns reach secondaries by a connector-stamped `source.profile`. That
is not a defect — and it is arguably good news, because it means the connector
(our router) is what decides which profile serves each turn. That is precisely
the Trip Context Gateway's job: resolve chat → trip → profile server-side and
stamp it, with no way for the model or the message to influence the choice.

**Remaining unverified by static reading:** whether anything constructs a
Telegram client outside `config.platforms` and would poll `getUpdates`
regardless of the sweep. None was found in the adapter-start flow, but only a
real boot with `GATEWAY_RELAY_URL` set and `multiplex_profiles: true`, watched
for a Telegram 409 Conflict, is conclusive. Run that with `default`'s token
rotated or the launchd service stopped — never against the live one.

## Decision: Option A, taken 2026-08-31

Dror cleared `default`'s two cron jobs (`~/.hermes/cron/jobs.json` is now
`"jobs": []`), which removes the last blocker to `multiplex_profiles: true`.
Sprint 5 therefore implements the **Telegram connector against Hermes's relay
contract**, rather than a bespoke router.

Why this is the better half of the fork, restated now that it is chosen:

- Tenant-from-discriminator, per-instance isolation, and the account-link DM
  flow are *specified behaviour* with a conformance oracle, not rules we
  invented and would have to defend alone.
- The connector is where the contract puts the trust boundary — "the gateway
  re-validates nothing" — which is exactly where Sprint 5 wants the Trip
  Context Gateway to sit.
- `source.profile` gives us server-side trip selection with no new mechanism
  to design. It also namespaces gateway session keys (`agent:<profile>:…`),
  so trip selection and session isolation are the same decision rather than
  two that could drift apart.

The cost stands and should stay visible: the contract is EXPERIMENTAL and may
change without a deprecation cycle until two Class-1 platforms validate it.
Everything protocol-shaped is therefore pinned in one file with a
`CONTRACT_VERSION`, and the HMAC scheme is tested against vectors generated by
running the real Python.

**Prerequisite before this runs live:** `multiplex_profiles` must be turned on
*and* `GATEWAY_RELAY_URL` stamped as an env var (not `gateway.relay_url` in
config.yaml, which keeps the additive behaviour and would leave direct
adapters running beside the relay). The gateway honours `source.profile` only
when multiplexing is enabled — `_resolve_profile_for_key` returns `None`
otherwise and every turn collapses into the legacy `agent:main` namespace.

## Constraint the implementation must respect either way

**One bot token, one `getUpdates` loop.** Telegram rejects concurrent
`getUpdates` for the same token (409). `startTelegramApprovalPoller` already
runs one for signup approvals. If the router polls the same bot, it must
*subsume* that loop and dispatch by update type — not run beside it.

Whether the control plane's signup bot (`telegram_bot_token_secret_ref`) and
the `trip-intake` bot are the same token is unconfirmed; if they are, this
collision is live today, not hypothetical.

## Built so far

### The deterministic layer (common to either option, built first)

- **`0028_interview_chat_binding.sql`** — `intake_sessions.telegram_chat_id`,
  with a partial unique index scoped to non-confirmed sessions: one live
  interview per chat, but many confirmed ones over time, so an organizer can
  start a second trip from the same DM.
- **`chat-router.ts`** — `parseInbound` (`/start <payload>`, `@botusername`
  stripping, payload alphabet/length), `resolveChatRoute` (chat id → live
  interview / companion binding / `unbound`), `startFromDeepLink` (verifies
  and consumes the enrollment, no LLM), and the inline-keyboard renderers for
  choice questions and the Confirm / Keep-planning pair.
- **`interview.ts`** — `startSession` takes a fifth `verifiedTelegramChatId`
  parameter, written in the same transaction as the session. Its doc comment
  now contrasts the two chat-id parameters explicitly, since the difference
  between the unverified 0022 hint and this verified value is the whole reason
  both exist.

### The relay connector (Option A)

- **`relay/protocol.ts`** — frame types, the Telegram `CapabilityDescriptor`,
  outbound-action parsing, and the §6.1 upgrade-token HMAC. Everything
  contract-shaped lives here behind `CONTRACT_VERSION`, so an experimental
  contract bump is one diff rather than a hunt.
- **`relay/normalize.ts`** — Telegram update → wire event, and the stamp of
  `source.profile` from a chat-id lookup. The Trip Context Gateway, concretely.
- **`relay/dispatch.ts`** — the single branch table: `/start` handled
  deterministically and never forwarded; a mid-interview chat served by the
  router; a bound chat normalized to the gateway; everything else refused.
- **`relay/telegram-api.ts`** — the Bot API client, behind an interface so the
  routing rules can be tested without a token or a network. The connector is
  the only holder of the bot token, per the contract's Appendix A.
- **`relay/connector.ts`** — the WebSocket server the gateway dials out to:
  upgrade auth, `hello` → `descriptor`, `inbound` push, and `outbound`
  execution.

Tests: **420 in the control-plane suite, 414 pass / 0 fail / 6 skipped**
(the 6 skip without a database); site suite **405 pass / 0 fail**. The DB
tests drop and recreate the schema, so point `CONTROL_PLANE_TEST_DATABASE_URL`
at a throwaway database and **never** at the local control plane's own
Postgres on 5433.

Three things worth knowing, found while building rather than by reading:

- **A group chat tapping a deep link used to burn the link.** `startSession`
  would succeed, but `interview.ts` records a binding only for the
  private-chat shape, so the organizer was left with a consumed single-use
  enrollment and a session no chat could reach. `startFromDeepLink` now
  refuses a non-private chat id *before* consuming anything, and a test
  asserts the link still works afterwards in the DM.
- **Enrollment refusal reasons are coarser than the router wants.**
  `consumeEnrollmentInTx` returns null for every non-issued state, so a
  consumed, revoked or unknown token all surface as `INVALID_TOKEN`. Correct
  as security behavior, but the router cannot yet say "you already used that
  link" instead of "that link is not valid". Widening the taxonomy touches a
  reason code the HTTP and MCP paths also consume, so it is a deliberate
  follow-up.
- **Upgrade-token expiry is whole-second.** `now > exp` in both this
  implementation and the Python gateway, so a 1-second token is live for up to
  two wall-clock seconds. Matching Python exactly matters more than the
  granularity does; noted so nobody "fixes" one side alone.

## Live boot test — 2026-09-01, passed

Run against the real launchd-managed `ai.hermes.gateway-trip-intake` on Hermes
0.20.5, with the connector deliberately holding **no bot token** so it could
not take the bot from anything, and every other gateway left running so a
collision would be observable rather than hidden.

The gateway's own log settles the last open unknown:

```
Relay connector is configured via GATEWAY_RELAY_URL; disabling directly-connected platform 'telegram'.   (x3 — per profile)
Relay connector is configured via GATEWAY_RELAY_URL; disabling directly-connected platform 'homeassistant'.
relay self-provision skipped: GATEWAY_RELAY_SECRET already set
relay adapter registered (connector at http://127.0.0.1:4312)
✓ relay connected
Gateway running with 1 platform(s)
Cron scheduler will tick 1 profile(s) under multiplex: ['default']
```

- **`Gateway running with 1 platform(s)`** — the relay alone. Nothing
  constructs a Telegram client outside `config.platforms`; the sweep is
  sufficient. That was the one thing static reading could not prove.
- **Zero 409s** in either log; `ai.hermes.gateway` (default) untouched at the
  same PID throughout.
- **`multiplex: ['default']`** — confirms live that `allowlist: []` serves only
  `default`, and that cron ticks it (harmless only because its `jobs.json` is
  empty).

**Full loop confirmed**: a synthetic inbound event pushed from the connector
reached the gateway, produced a typing indicator, and came back as an outbound
`send` — connector → gateway → Hermes → connector. Note what the responder
was: Hermes's own "no home channel is set" notice, not the interviewer agent.
So transport, routing and egress are proven end to end; an actual LLM turn was
not exercised.

Also observed, and reassuring: the gateway's reconnect supervisor re-dialled on
its own every 30s while the connector was down, and re-handshaked cleanly when
it returned.

`control-plane/deployment/relay-conformance-check.py` reproduces the wire half
of this without touching any service.

### The bug this whole exercise existed to find

The connector originally sent frames with no trailing newline. The gateway
reads by `*lines, buf = buf.split("\n")` and keeps the remainder as a partial
(`ws_transport.py` ~877), so every frame would have been received and never
parsed — a handshake hang, not an error. Unit tests passed, because the test
harness had the same misreading baked in.

Nothing local could have caught it. Upstream could not either: their own
`tests/gateway/relay/stub_connector.py` is an **in-memory** `RelayTransport`
that bypasses the socket entirely, so no test on either side exercises the
framing. Treat "our tests pass" as saying nothing about wire conformance —
run the conformance check.

## Not wired up yet

The pieces exist but nothing runs them together yet:

- **The poll loop.** `dispatch.ts` decides what happens to an update; no loop
  feeds it updates or acts on its decisions. That loop must SUBSUME
  `startTelegramApprovalPoller` rather than run beside it (see the constraint
  below) — `dispatch.ts` already returns `approval_callback` for that path.
- **Interview answer capture.** A tapped intake button routes to
  `interview_callback` with the right session, but nothing calls
  `submitAnswer` yet, and free-text answers mid-interview currently get a
  nudge rather than being parsed.
- **Server wiring.** No `server.ts` entry constructs a `RelayConnector`, and
  the Hermes side needs `multiplex_profiles: true` plus the
  `GATEWAY_RELAY_URL` env stamp before `source.profile` is honoured at all.

Tracks 2 (capability issuance, the two-trip isolation matrix) and 3 (the
interview UX batch and the two unreproduced bugs) remain untouched.
