# Sprint 5 — next session brief

Updated 2026-09-01 (second session). Read this plus
`docs/sprint5-trip-bot-router-design.md` (the why, and the live evidence)
before touching anything.

## Where things stand

**Worktree** `.claude/worktrees/sprint-5-organizer-router`
**Branch** `sprint/5-organizer-profile-router`
**Stacks onto** `integration/sprint-5-plus` (from `main` @ `fc809a0`)
**Not pushed.** Nothing is on the remote yet; no PR exists.

The routing spine is now **wired together and runnable**. A process starts, owns
the bot's update stream, routes each update, and records button answers.

Built and committed previously:

- **Deterministic layer** — `chat-router.ts` + migration 0028.
- **Relay connector** — `src/relay/{protocol,normalize,dispatch,telegram-api,connector}.ts`.

Built this session:

- **The poll loop** (`src/relay/poller.ts`). Owns one `getUpdates` loop on the
  trip bot, feeds `dispatchUpdate`, and performs the I/O for every decision.
  `applyDecision` is exported separately so the whole decision→effect table
  runs against a fake Telegram client.
- **`relay/server.ts` wiring.** Two explicit modes — SERVE (architecture
  profile) and CONFORMANCE (`RELAY_GATEWAY_SECRET` alone, no DB, no bot token).
  Setting both is refused, so a typo'd profile cannot silently degrade into a
  connector that answers handshakes and routes nothing.
- **Config binding** for the relay, through the existing `secret_ref`
  indirection: `relay.{bind_host,port,gateway_secret_refs,
  telegram_bot_token_secret_ref}`. `gateway_secret_refs` stayed a list.
- **Interview answer capture**, chat-addressed. `submitAnswerForChat`,
  `confirmIntakeForChat` and `getSessionForChat` in `interview.ts`.

Tests after the wiring work: **446 in the control-plane suite, 440 pass /
0 fail / 6 skipped** (from 423/417/6). The provisioner fix below moved them
again — see its own section for the current numbers. Site suite untouched at
405/405.

Re-verified after the changes:

- **Wire conformance passes** — `HANDSHAKE OK`, `UNSUPPORTED_OP` for an
  unadvertised op, clean disconnect. No framing regression.
- **Serve mode boots** against a throwaway DB with a deliberately invalid bot
  token: listens, reports `polling: true`, 401s on `getUpdates`, and backs off
  1s → 2s → 4s. Both misconfiguration guards fire.

## How the token bridge was resolved

The brief warned not to store a raw session token at rest just to fit
`submitAnswer`'s signature. It is not stored, and no new primitive takes a bare
session id either — a session id is not secret, so `submitAnswerById` would
have been a credential-shaped footgun.

Instead `interview.ts` grew an internal `SessionLocator` (`by: "token"` or
`by: "chat"`) and a shared `lockSession`. `submitAnswer`/`confirmIntake` keep
their exact signatures and their exact SQL; the `ForChat` variants take the
router-verified chat id and resolve it **inside the same transaction that
writes**. So the chat binding is the authorization fact, as intended, and every
rule below the lookup — confirmed-session guards, validation, versioning — is
shared rather than duplicated per caller.

Two details worth not re-deriving:

- The chat locator deliberately does **not** filter out confirmed sessions. It
  is what makes a Confirm double-tap idempotent: the second tap re-reads under
  the lock and finds the confirmed row. Excluding it would report `NOT_FOUND`
  for a confirmation that actually succeeded. There is a test.
- It orders live-first, then most-recently-updated, because a chat accumulates
  one confirmed session per trip the organizer has onboarded from that DM.
  0028's partial unique index means the first sort key can never tie.

## The wall — read this before promising an end-to-end demo

**A deterministic interview cannot finish.** The required question path is:

| # | question | type | router can handle? |
|---|---|---|---|
| 1 | `trip_type` | choice | yes — buttons |
| 2 | `destination` | text | **no** |
| 3 | `group_size` | choice | yes |
| 4 | `trip_duration` | choice | yes |
| 5 | `departure_date` | text | **no** |
| 6 | `return_date` | text | **no** |
| 7 | `travelers` | structured | **no** |
| 8 | `phases` | structured | **no** |

So an organizer taps the deep link, gets a real question with real buttons,
taps it, is recorded — and then hits `destination` at question 2.

This was **not** closed by capturing raw text, and that was deliberate:

- `departure_date`/`return_date` must be normalised before submission. The
  question prompts deliberately name no format, and the design comment on them
  is explicit that the interviewer resolves "September 6th" and confirms its
  reading back in words. Storing the raw string would put un-normalised dates
  into an immutable intake version and on into `trip.config.json`.
- `travelers`/`phases` are JSON assembled from conversation. That is LLM work.

Capturing text for *some* text questions and not others is the special-casing
that drifts. The line is: **taps are deterministic, written answers need the
interviewer agent.**

What the organizer sees today at question 2 is an honest refusal
(`DEFAULT_STRINGS.writtenAnswerUnsupported`) rather than a "got it!" for
something nothing stored. `dispatch.ts` now returns a dedicated
`interview_text` decision, and the poller picks the copy from the pending
question's type — "tap one of the options above" only when a choice question is
actually pending.

### Closing it is the next real decision

`interview_text` is deliberately shaped to become the forward-to-the-gateway
branch. Turning it into one needs a decision that is genuinely open:

**How does the interviewer agent bind to a session?** It calls MCP
`submit_answer` with a session token it does not have. The router holds the
chat binding and no token. Handing the agent a token, or letting it assert its
own chat id, walks straight into what migration 0022's header spends its length
warning about — an LLM-relayed chat id must never become an authentication
fact. An MCP tool addressed by *verified* chat id is the shape that fits, but
the verification has to come from the router, not the agent.

This is a design decision for Dror, not something to guess at.

## Done — the provisioner binding fix

Both halves are fixed, so Track 2's two-trip isolation matrix is now a real
test rather than a test of a known-broken binding.

**Migration 0029** gives a binding a lifecycle. `chat_id` stops being the
primary key (a surrogate `id` takes over, carrying 0005's opaque-id format);
"the binding in force" becomes a PARTIAL UNIQUE INDEX over rows where
`closed_at IS NULL`. Same shape 0028 uses for one live interview per chat. A
`CHECK` keeps `closed_at` and `closed_reason` from ever disagreeing.

**`bind_chat_to_trip`** in `provisioner.py` replaces the `ON CONFLICT DO UPDATE`
with four explicit cases, under `FOR UPDATE`:

| situation | what happens |
|---|---|
| no open binding | open one |
| same trip, same profile | no-op (an unchanged re-provision) |
| same trip, new profile | close the old row, open a new one — leaves a trail |
| **a different trip** | **`BindingRefused`** — the existing binding is untouched |

Refusing the last case is the point: a background provisioning job has no
signed organizer action, so it has no standing to move a group that is actively
using another trip.

**The swallowed failure** is fixed separately. The binding write moved out of
the broad `except Exception: logger.warning` that also covers the companion
install, into its own handler at **error** level with an explicit `consequence`
field. A trip whose companion installed but whose binding did not open is
*unroutable*, which is a different severity from a best-effort profile install
failing. The provision still succeeds — a deployed trip must not roll back over
a side effect — but the absence of an open binding row is now durable,
queryable evidence, and there is a test asserting exactly that.

**READERS MUST FILTER.** Both production readers now carry `closed_at IS NULL`
(`chat-router.ts`'s `resolveChatRoute` and `app.ts`'s chat-routing endpoint).
A closed binding that still resolved would be worse than having no lifecycle:
it would route a group to the trip it was deliberately detached from. Tests
assert it.

Tests: control plane **448, 442 pass / 0 fail / 6 skipped**; worker **257, all
pass** (7 new binding-lifecycle cases plus an end-to-end refusal case).

Note the brief previously gave the wrong path — it is
`control-plane/worker/control_plane_worker/provisioner.py`.

## Done — the two-trip isolation matrix (Half A)

`control-plane/api/test/two-trip-isolation.test.ts`, 10 tests. Every case has a
SECOND trip present that must not be reached — a one-trip test can pass while
the code ignores the chat id entirely, which is the failure this shape catches.

Covers each surface the control plane owns: `resolveChatRoute`, the
`source.profile` stamp in `normalizeUpdate`, `dispatchUpdate` end to end, the
`/internal/telegram-chat-bindings/:chatId` endpoint Hermes actually calls, and
`submitAnswerForChat`. Plus the adversarial ones: a message body naming the
other trip's profile and id, a callback replayed from the wrong chat, a deep
link redeemed in the wrong DM, and closing one binding while the other keeps
serving.

**These were mutation-checked, not just observed to pass.** Two deliberate
regressions were introduced and both were caught by the intended test:

| mutation | caught by |
|---|---|
| drop `closed_at IS NULL` from `resolveChatRoute` | "closing one binding leaves the other serving" |
| derive `source.profile` from message text | "the wire event is stamped from the chat, not the message" |

Worth repeating if these tests are ever refactored — passing tests around
routing prove nothing unless you have seen them fail.

### Half B is still open, and is not automatable here

Two live Hermes profiles, asserting no private-memory leakage. That needs each
companion allowlisted **by name** in `multiplex_profile_allowlist` plus a
gateway restart per trip — the manual step under Open decisions. It also tests
an UPSTREAM property (Hermes's multiplex isolation) rather than code in this
repo, so it belongs as a one-time live verification, not a suite.

Track 3 (the interview UX batch) is last — most parallelizable, least blocked.

## Getting running

```bash
cd .claude/worktrees/sprint-5-organizer-router

# Deps are per-package and NOT shared with the main checkout.
(cd control-plane/api && npm install)
(cd tests && npm install)
(cd server && npm install)
(cd mcp && npm install)

# Throwaway Postgres. NEVER point these at the local control plane's own
# Postgres on 5433 — they DROP SCHEMA.
docker run -d --name kinerary-sprint5-testdb \
  -e POSTGRES_PASSWORD=test -e POSTGRES_DB=cptest -p 5434:5432 postgres:16-alpine

cd control-plane/api
CONTROL_PLANE_TEST_DATABASE_URL="postgres://postgres:test@127.0.0.1:5434/cptest" npm test

cd ../../tests && npm test        # site suite, no DB needed
```

The **worker** suite is Python and has two traps worth not rediscovering: it
needs the repo root on `PYTHONPATH` (`control_plane_worker.compute` imports the
top-level `provisioning` package), and it needs **Python 3.10+** — macOS's
system 3.9 dies on `str | None` in a module-level type alias. The Dockerfile
targets 3.12.

```bash
python3.11 -m venv /tmp/wvenv && /tmp/wvenv/bin/pip install -r control-plane/worker/requirements.txt
cd control-plane/worker
PYTHONPATH=$(git rev-parse --show-toplevel) \
  CONTROL_PLANE_TEST_DATABASE_URL="postgres://postgres:test@127.0.0.1:5434/cptest" \
  /tmp/wvenv/bin/python -m unittest discover -s tests
```

Wire conformance (the only thing that validates the protocol — see Landmines):

```bash
# terminal 1 — CONFORMANCE mode: no profile, no DB, no bot token
cd control-plane/api
RELAY_GATEWAY_SECRET=$(grep '^GATEWAY_RELAY_SECRET=' ~/.hermes/profiles/trip-intake/.env | cut -d= -f2) \
  npx tsx src/relay/server.ts

# terminal 2
RELAY_GATEWAY_SECRET=$(grep '^GATEWAY_RELAY_SECRET=' ~/.hermes/profiles/trip-intake/.env | cut -d= -f2) \
  ~/.hermes/hermes-agent/venv/bin/python control-plane/deployment/relay-conformance-check.py
```

Expect `HANDSHAKE OK` and `UNSUPPORTED_OP`. A **hang at handshake means a
framing bug**. (`get_chat_info` printing a name is the *gateway library's* own
client-side fallback, not our answer — the connector correctly returns
`CHAT_NOT_FOUND` with no bot token.)

Serve mode needs a profile with a `relay` block; see
`control-plane/config/architecture.example.json`.

## Landmines — do not re-derive these

**The bot is still dark, and un-darkening it is a deliberate act.** Nothing has
been pointed at the real trip-intake bot token. Starting the poll loop on it
takes the bot live — every prior link-holder can then talk to it. The serve
boot test above used an intentionally invalid token for exactly this reason.

**Frames are newline-delimited.** `encodeFrame` appends `\n`. The gateway reads
by `*lines, buf = buf.split("\n")` and keeps the remainder as a partial, so a
frame without it is received and never parsed — a silent handshake hang. Unit
tests cannot catch this: our harness and upstream's `stub_connector.py` both
bypass the wire. Run the conformance check after any protocol change.

**A poll loop must yield a macrotask each turn.** `await` on an
already-resolved promise only drains microtasks, so a `getUpdates` that returns
without real I/O starves timers entirely — the stop flag is never observed and
the process hangs. The loop's trailing `await sleep(backoffMs)` is
unconditional for this reason, including at zero. This was found by a test
hanging, not by reading.

**The offset advances before handling, not after.** Telegram redelivers
everything at or after the offset until it moves, so an update that throws every
time would be retried forever and block every update behind it — one poisoned
message silencing the whole bot. There is a test.

**`multiplex_profile_allowlist: []` serves NOTHING** — only `default`. *Absent*
serves every profile on the machine. There is no deny list, and `default` can
never be excluded. Full detail in the `hermes-multiplex-relay` skill.

**`GATEWAY_RELAY_URL` and `multiplex_profiles` travel together.** The env stamp
is what disables directly-connected adapters; `gateway.relay_url` in
config.yaml keeps the *additive* behaviour and reinstates the `default`-bot
collision. Removing one without the other is the failure mode.

**Do not allowlist `familytrip`** without first dealing with its three enabled
one-shot cron jobs (flight watches dated 2026-07-12, in the past). Serving a
profile activates its cron.

**The signup bot and the trip bot are different tokens**, so the connector's
loop cannot 409 against `startTelegramApprovalPoller`. The `approval_callback`
branch is therefore unreachable in the current topology and is defensive only —
the poller logs it rather than handling it. Do not build on it without
re-checking. The config schema documents why the two token refs must stay
distinct.

**Env var names ending in `TOKEN` fail the example-config guard.** A pre-existing
test rejects anything matching `token|password|api_key` followed by a separator,
because an inline credential and an env var name are indistinguishable to it.
Hence `CONTROL_PLANE_TRIP_BOT_CREDS`, matching signup's existing
`CONTROL_PLANE_TELEGRAM_CREDS`.

**A multi_choice tap is refused, not recorded.** One tap carries one option, but
the answer is the whole set — recording a single tap would silently discard
every other selection. Accumulating one needs a per-chat draft and a Done
button. Nothing renders a multi_choice keyboard today, so this is a guard, not
a live path, and `keep_planning` deliberately does not walk into the optional
questions (the next ones in line are multi_choice).

**Enrollment refusal reasons are coarse.** `consumeEnrollmentInTx` returns null
for every non-issued state, so consumed / revoked / unknown all surface as
`INVALID_TOKEN`. Correct as security behaviour; it just means the router cannot
say "you already used that link".

**The relay contract is EXPERIMENTAL** and still `contract_version: 1` upstream.
Installed Hermes is **0.20.5**; latest upstream is **2026.8.27**, so an upgrade
is a real compatibility event. Everything protocol-shaped is in `protocol.ts`
behind `CONTRACT_VERSION`.

**No queueing.** Gateway down ⇒ `pushInbound` returns false and the turn is
lost. The poller now tells the organizer rather than leaving them waiting, but
the contract's buffered-delivery lane is still unimplemented.

## Open decisions

- **Interviewer-agent session binding** — the wall above. Blocks a complete
  organizer flow.
- **Allowlist automation.** Adding a companion profile is a manual config edit
  plus a gateway restart, per trip. Blocks comfortable parallel-trip testing.
  Automating it in the provisioner is unscoped — raise with Dror.
- **Who closes a binding, and how.** 0029 makes closing expressible and the
  provisioner refuses to do it implicitly, but nothing yet performs a reviewed
  reassignment — the signed organizer action is still unbuilt. Today a chat is
  freed only by an operator UPDATE. `closed_reason` is free text at 64 chars;
  the values used so far are `profile_rebound` and `organizer_reassigned`.
- **Capability model.** What is built stamps a *profile name*. The sprint text
  describes a richer router-issued organizer/trip/channel/role/lifecycle
  capability. Whether the profile stamp suffices for the exit gate is undecided.
- **Unbuilt sprint items:** group binding via signed organizer action,
  `/select`, the Super Bot, reassignment review.

## Key files

| Path | What |
|---|---|
| `control-plane/api/src/chat-router.ts` | routing decisions, `/start`, keyboards |
| `control-plane/api/src/interview.ts` | `SessionLocator`, `lockSession`, the `ForChat` entry points |
| `control-plane/api/src/relay/protocol.ts` | frames, descriptor, upgrade HMAC |
| `control-plane/api/src/relay/normalize.ts` | Telegram → wire, `source.profile` stamp |
| `control-plane/api/src/relay/dispatch.ts` | the single branch table |
| `control-plane/api/src/relay/poller.ts` | the update loop and every decision's I/O |
| `control-plane/api/src/relay/connector.ts` | WS server the gateway dials |
| `control-plane/api/src/relay/server.ts` | serve vs conformance entrypoint |
| `control-plane/db/migrations/0028_*.sql` | chat ↔ intake session binding |
| `control-plane/db/migrations/0029_*.sql` | binding lifecycle — close, don't overwrite |
| `control-plane/worker/.../provisioner.py` | `bind_chat_to_trip`, `BindingRefused` |
| `control-plane/api/test/two-trip-isolation.test.ts` | the isolation matrix (Half A) |
| `control-plane/deployment/relay-conformance-check.py` | wire validation |
| `.agents/skills/hermes-multiplex-relay/SKILL.md` | Hermes multiplex/relay operations |
| `docs/sprint5-trip-bot-router-design.md` | design, A/B, live evidence |
