# Sprint 5 — next session brief

Updated 2026-09-02 (third session). That session ended abruptly in a power
outage at roughly 13:00, so it never wrote this itself — the 09-02 sections
below were reconstructed afterwards from its commits and from the state it left
on the machine. Read this plus
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

Built 2026-09-01 (second session):

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

## 2026-09-02 — the bot went live, and what that taught

This session pointed the relay at the real token and put the assistant in front
of a real family group (יפן 2026). Everything in this section was found there,
in production, rather than reasoned out — which is why it is worth more than its
line count suggests. The brief's old "the bot is still dark" landmine has been
corrected in place rather than deleted, so the change of state is visible.

**`@Kinerary_bot` is the signup bot.** Its token is byte-identical to
`signup.telegram_bot_token_secret_ref`. The previous brief asserted the two were
different tokens and concluded the loops could not contend; both halves were
wrong. Two concurrent `getUpdates` on one token do not split the work — Telegram
409s the second or hands each update to whichever loop asked, at random, so an
approval tap would go missing about half the time, intermittently. `poller.ts`
now implements the `approval_callback` branch it previously only logged, reusing
the same `processApprovalCallback` path the HTTP callback uses rather than
growing a third copy of the authorization behaviour. `server.ts` stands the old
approval poller down when the relay owns the stream, **detected by comparing the
two resolved tokens** rather than configured by a flag — a flag is something to
set wrong, two refs naming one bot is a fact the process can observe. Neither
token is logged. (`223b9fa`, `f8fae24`)

**Group chats need a relevance gate, and the relay does not carry Hermes's.**
`telegram.mention_patterns` is not in the vocabulary the gateway projects to a
connector (it projects only requireAddress / freeResponseScopes /
allowOtherBots), and the adapter that reads it is disabled outright by the
relay-exclusive sweep. Under Sprint 5's model the connector owns the socket, so
the connector owns the gate: a group message engages only on a name in either
language, an @mention, or a reply; a DM is never gated. A trip with no names
configured falls back to @mention/reply, **not** to answering everything —
silence from a misconfigured trip is recoverable, a bot interrupting a family
conversation is what people remember. Migration 0030 stores the names on the
trip because the router cannot read a Hermes profile directory from inside a
container. `\b` is unusable here: JavaScript's word boundary is ASCII-only, so
`\bבוטסאן\b` matches *inside* Hebrew words; the matcher uses Unicode property
escapes. (`793e53e`)

**One name field could not hold a bilingual name.** `transform_intake` copied
`name` straight into `name_en`, so an organizer given one field typed
"בוטסאן / botsan" and the whole string landed in both — and those fields are
what the wake-words are built from, so it matched neither word anyone types.
`split_bilingual_name()` separates them, but only on a genuine change of script:
a single-language answer keeps today's behaviour rather than acquiring a
transliteration the organizer never chose. (`d8e0e97`)

**The assistant emits CommonMark; the descriptor advertises MarkdownV2.** They
are not the same language, and the mismatch reached the group as literal
asterisks and visible `##`. MarkdownV2 bold is one asterisk, it reserves
`. - ( )` and more *everywhere*, and it has no heading syntax at all — so
sending CommonMark as MarkdownV2 fails outright and sending it as plain text
shows the markers. `markdown.ts` converts. Only agent-authored content is
converted; the router's own replies stay plain, so an ordinary full stop in
"That link isn't valid any more." cannot break them. (`c3389d1`)

**Three template fixes, every one from observed behaviour in the live group.**
Asked about its connections in the family chat, the assistant named
`MCP_TRIP_MCP_API_KEY` outright — the old "never reveal internal
implementation terms" rule was a passive clause in a list and did not survive a
direct question, so it is now its own section with the nouns spelled out and an
instruction on what to do instead. It also said "בדקתי את האתר החי" and then
described a different trip entirely, reciting conversation history under the
live site's authority; the new rule draws the line at the *claim* rather than
the content. And sessions never reset (Hermes's `SessionResetPolicy` defaults to
`none`), which is what made that recitation possible in the first place.
(`f7e9d13`, `aab28ce`)

**It was scraping the public site instead of reading its MCP connection.** The
template said the authoritative connection was `trip-site` while the profile
actually registered `trip-mcp`, so it looked for a connection that did not exist
and fell back to fetching a client-rendered shell (864 bytes) whose data
endpoint 401s. Everything that *creates* the server already said `trip-mcp`;
only the handoff contract disagreed, so the handoff is what changed.
(`a27fbd7`)

**Upstream hazard, not fixed here: session IDs are not namespaced per profile.**
The gateway's routing table keys sessions as
`agent:<profile>:telegram:dm:<chat>`, but the session ID itself is not
namespaced — so four profiles, including two unrelated trips, all resolved to
one conversation, three of them written with a `created_at` identical to the
microsecond. A newly served profile inherits whatever session that chat already
had rather than starting its own. The stale japan2026 binding was removed by
hand. Expect this again the next time a profile is added to the allowlist.

## Where the machine stopped — power outage, 2026-09-02 ~13:00

The last commit landed at 12:51 and the machine went down shortly after. **No
work was lost**: every worktree is clean and nothing was left uncommitted. What
did not survive is the *running* state, and it does not all come back on its
own.

| | state after reboot |
|---|---|
| Hermes gateways (trip-intake, japan2026 in the allowlist, +4) | back up on their own, 13:46–13:49 |
| Docker daemon | **down** — the whole control-plane stack with it |
| relay connector, `:4312` | **not listening** |
| interview MCP sidecar, `:4311` | **not listening** (hand-started by design) |

So the bot is quiet again — but for an accident, not for the deliberate reason
the old landmine gave. `multiplex_profile_allowlist` still reads `[japan2026]`,
so bringing the relay back up puts the assistant straight back into that family
group. That is a live action, not a restart.

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

### Closing it — BUILT 2026-09-02

The forward path and the agent's write path both exist now. What follows is
the record of why it is shaped the way it is; the section below it is the
reasoning that got there, kept because the constraints have not changed.

**The transport.** `dispatch.ts` returns a new `interview_to_gateway` decision
for a written mid-interview message, carrying the wire event and the session
the router resolved. `poller.ts` opens the turn and then pushes — in that
order, because the agent may call back the instant it is handed the turn, and
a turn opened afterwards could arrive second. If the gateway is down the turn
is closed again rather than left to lapse, so the next forward is the only open
one at every instant.

`relay.interviewer_profile` gates the whole thing and is OPTIONAL. Absent, the
router keeps answering written messages itself — the state the bot shipped in.
Forwarding begins only when there is somewhere to forward to.

**The write path.** `interview.ts` gained an `agent` `SessionLocator` variant
alongside `token` and `chat`, so the addition is one more branch in
`lockSession` rather than a parallel write path — the confirmed-session guards,
validation and versioning stay shared. The turn is verified by JOIN inside the
same transaction that locks the session, not looked up beforehand, so nothing
can change between the check and the write.

Migration 0031 holds the turns. Both halves of "open" are required on every
read: a superseded turn is closed but may not have expired, an abandoned one
has expired but was never closed.

**Surfaces:** `/internal/interview/agent/:chatId` (GET, the session view) and
`/internal/interview/agent/:chatId/answer` (POST), both X-API-Key, plus
`get_interview_for_chat` and `submit_answer_for_chat` in the MCP sidecar —
registered only when `CONTROL_PLANE_INTERVIEW_AGENT_KEY` is set.

**Tests:** `interview-agent-turn.test.ts`, 12 cases, every one with a second
chat mid-interview that must not be reached. Mutation-checked like the
two-trip matrix:

| mutation | caught by |
|---|---|
| drop both open-ness filters from the JOIN | "an expired turn is refused", "a closed turn is refused" |
| bypass the agent branch entirely | 4 tests including "a turn open for one chat does not admit a write naming the other" |

Note the read path survived the second mutation — `getSessionForAgent` carries
its own copy of the predicate. That is intentional duplication, but it means a
future refactor must mutate BOTH to prove the gate.

**FUTURE — replace the agent-supplied chat id with gateway-injected trusted
context.** The relay contract cannot carry it today; when it can, the turn
table and the `agent` locator both collapse back into the chat-addressed path.
This is the hardening step, and it sits alongside the mini-app sign-in already
scoped under "Decisions taken 2026-09-02".

### Why it is shaped this way — the constraints found on the way

`interview_text` is deliberately shaped to become the forward-to-the-gateway
branch. The question that blocked turning it into one was:

**How does the interviewer agent bind to a session?** It calls MCP
`submit_answer` with a session token it does not have. The router holds the
chat binding and no token. Handing the agent a token, or letting it assert its
own chat id, walks straight into what migration 0022's header spends its length
warning about — an LLM-relayed chat id must never become an authentication
fact. An MCP tool addressed by *verified* chat id is the shape that fits, but
the verification has to come from the router, not the agent.

**Dror's answer dissolves most of it:** the interviewer is *meant* to be the
public default route. Any chat with no live binding reaches it, by design —
so there is no identity for the agent to prove, and the question was never
really about authentication. The router's verified chat id stays the sole
authorization input; the agent supplies judgement, not identity. Full text,
including the later hardening path, under "Decisions taken 2026-09-02".

`destination` in particular is settled as an LLM question — "Vienna and
Prague" is a multi-destination trip and no parser gets there. That does not
reopen raw-text capture for the *other* text questions; the date questions
still need normalising before an immutable intake version records them.

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

**The bot is LIVE. It was un-darkened on 2026-09-02** and has been in front of
a real family group since. Every prior link-holder can talk to it, and anything
shipped is shipped in front of people. It is not polling at this moment only
because the power outage took the relay process down — see "Where the machine
stopped" — so restarting the relay is not a restart, it is putting an assistant
back into a family's chat. The old advice here (nothing points at the real
token; the serve boot test uses a deliberately invalid one) described the state
before 09-02 and no longer holds.

**The wire has no structured return path and no free-form context slot.** The
gateway->connector op set is `send`/`edit`/`typing`/`get_chat_info`, and
`WireMessageEvent` carries only the fields in `protocol.ts`. So an agent cannot
hand a value back to the router, and the router cannot hand the agent anything
that varies per turn — the MCP connection is one static endpoint shared by
every chat the interviewer serves (`example.setup.json`). Both shaped the
interview write path; do not re-derive them by proposing either.

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

**The signup bot and the trip bot are the SAME bot** on this deployment —
`@Kinerary_bot`, one token behind two secret_refs. An earlier version of this
brief said the opposite and concluded the `approval_callback` branch was
unreachable and defensive only; both halves were wrong, and the correction is
what drove `223b9fa`. The branch is reachable, is implemented, and the relay
poller subsumes `startTelegramApprovalPoller` rather than running beside it. The
stand-down is detected by comparing resolved tokens, so a deployment where the
two genuinely differ still runs both pollers. The schema keeps the refs distinct
because they are distinct ROLES; `compose.local.yml` is where the fact that they
currently coincide is recorded.

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

**The relay contract is EXPERIMENTAL** and still `contract_version: 1` — on
BOTH sides, which is the part that matters. Everything protocol-shaped is in
`protocol.ts` behind `CONTRACT_VERSION`.

The upgrade picture, checked 2026-09-02 (the previous note here said "latest
upstream is 2026.8.27", which does not correspond to anything in the actual
versioning):

- Hermes is an **editable install from a local git checkout** at
  `~/.hermes/hermes-agent`, not a PyPI package. PyPI's latest is 0.19.0 —
  *behind* the installed 0.20.5, so `pip install -U` would downgrade.
- The public `NousResearch/hermes-agent` has had its history collapsed to a
  **single commit**, and shares no ancestor with the local checkout (9250
  commits, no merge base). `git pull` cannot work; an upgrade means replacing
  the tree.
- Upstream is **0.21.0** — one minor version ahead.
- It does **not** unlock the trusted-context field. Upstream's
  `supports_context` is the connector supplying channel/group conversation
  context for grounding, not an identity injected into tool calls, and
  `agent/relay_tools.py` is NVIDIA NeMo Relay tool execution — a different
  "relay" entirely.

So the upgrade is hygiene, not a blocker-remover, against a gateway serving a
real family group. Revisit when there is a reason.

**No queueing.** Gateway down ⇒ `pushInbound` returns false and the turn is
lost. The poller now tells the organizer rather than leaving them waiting, but
the contract's buffered-delivery lane is still unimplemented.

## Open decisions

- ~~**Interviewer-agent session binding**~~ — **decided 2026-09-02 by Dror.**
  See "The wall" above for the shape of the answer. What remains open under it
  is narrower: the mechanism by which a verified chat id reaches the agent's
  write path, not who may write.
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

## Unsupervised services — the failure that wastes an evening

Four long-running services are plain background processes with pid files and
no supervision: each control-plane trip's `trip-mcp` bridge, and the interview
MCP sidecar on `:4311`. They do not come back after a reboot.

**The expensive part is not that they stop.** It is that the bots keep
answering while their data access is gone. An assistant with no MCP does not
fall silent — it answers from memory, at full confidence. On 2026-09-02 that
looked exactly like cross-trip contamination, and hours went into it before
the real cause turned up: japan-2026's bridge was correctly configured all
along (`:3013` → `192.168.0.60:8080`) and had simply died at ~13:00. A stale
shared `com.hermes.trip-mcp` on `:3001` from June, hardcoded to the USA trip,
made the wrong story look right. That service has no clients at all — every
trip profile dials 3011/3012/3013 — and is a red herring, not a leak.

`kinerary-deploy/bring-up.sh` closes this. One command, idempotent, with a
status table that separates "up", "no bridge" and "FAILED".

**Its scope is defined by the control plane, not by a list.** Trips are
discovered by querying `control_plane.trips`, so a newly provisioned trip is
covered with no edit, and the legacy trips (japan-2025,
los-angeles-hawaii-vegas-2026, elul-family-usa-2026) can never drift back in —
they are not in the control plane and are out of scope by decision, 2026-09-02.
They still have `mcp/.env` directories; the script deliberately will not touch
them.

**It never starts the relay.** Starting the relay puts the assistant into a
live family group, which is a deliberate act, not a side effect of a recovery
script. It reports the state and prints the command.

### The onboarding half

A "no bridge" row is usually NOT an operator forgetting. The pipeline already
knows how to do this — `mcp_bridge.py`'s `ShellMcpBridgeAdapter` calls the same
`setup-mcp.sh` for a newly provisioned trip — but it is gated behind
`--enable-mcp-bridge` AND `--companion-templates-dir`, and **both default off**.
The local compose worker passes neither, so every trip onboarded today lands
with a live site, no companion profile and no bridge.

Turning both on is the fix at the source, and it is unmade: it needs a
templates dir path and it changes what a provisioning job does to real infra,
so it is a decision rather than a default to flip quietly.

## Decisions taken 2026-09-02 (Dror)

Both were open in the previous brief. Neither is implemented yet — they are
recorded here so the next session builds to them rather than re-opening them.

**1. `destination` is an LLM question, not a text-capture question.** The wall
section above argued that capturing raw text for *some* text questions is
special-casing that drifts. That reasoning holds, and the resolution is not to
relax it: `destination` genuinely needs judgement. An organizer writes
"Vienna and Prague" — that is a multi-destination trip, and turning it into
structured phases needs context no parser has. So it routes to an LLM, either
the `kinerary-extract` profile or the interviewer itself. Which of the two is
an implementation choice, not a further decision.

**2. The interviewer is deliberately the public default route, for now.**
An inbound chat with no live binding routes to the interviewer. That is the
intended behaviour, not a gap: the interviewer is a public front door that
serves any newcomer. It follows that the session-binding question is not
"how does the agent prove who it is" — the router already established the chat
id, and an unbound chat is *supposed* to reach the interviewer.

Hardening comes later in the project, and the shapes named are:

- a mini-app requiring sign-in before an interview becomes active;
- a signed-in user who came through the onboarding site with location and dates
  already entered gets routed straight to the interview for their first trip,
  and thereafter is asked whether they want a new interview and routed back to
  the interviewer for each additional trip.

Until then, do **not** build an authentication fact on top of the interviewer's
openness. Migration 0022's warning is unchanged: an LLM-relayed chat id is
still not an authentication fact. The router's verified chat id remains the
only authorization input.

## Restored after the power outage — 2026-09-02, later session

The stack came back, but not by itself and not completely. What was actually
wrong, and what fixed it:

| | state | resolution |
|---|---|---|
| control-plane API, postgres, site, server | up | came back on their own |
| `worker` | **crash-looping ~6h** | see below |
| relay connector `:4312` | down | **left down deliberately** |
| interview MCP sidecar `:4311` | down | hand-started by design; still down |

**The worker's crash loop was the fail-loud path working as designed**, not a
bug. `compose.local.yml` defaults `PROVISIONER_DEPLOY_ROOT`, `REPO_ROOT` and
`PROVISIONER_VMID_MAP` to empty so that an unconfigured worker refuses every
poll cycle rather than reaching real infra by accident. They are supplied at
`up` time from `~/kinerary-deploy/provisioning.env`, which is not version
controlled — so a restart that does not source it reproduces this exactly. It
will happen again; the log line names the missing variable each time.

Brought back with the three variables and **`PROVISIONER_COMPUTE_ENABLED`
left off**, which is narrower than the pre-outage configuration. The job queue
is empty, so nothing was waiting to drain and nothing was skipped by leaving
compute off. Arming real Proxmox/NPM/Cloudflare provisioning again is a
deliberate act — source `provisioning.env` in full when a real provision is
actually wanted.

```bash
cd control-plane/deployment
PROVISIONER_DEPLOY_ROOT=/deploy-root REPO_ROOT=/repo \
  PROVISIONER_VMID_MAP="$(grep '^PROVISIONER_VMID_MAP=' ~/kinerary-deploy/provisioning.env | cut -d= -f2-)" \
  docker compose -f compose.local.yml up -d worker
```

**The relay was left down on purpose.** Two bindings are open in
`telegram_chat_bindings`: the יפן 2026 supergroup (`-1004305582269`) and the
organizer DM (`391627336`). Starting the relay is not a restart — it puts the
assistant back into a family's chat. See the LIVE landmine above.

Suites at the time of the restore, all green:

| suite | result |
|---|---|
| control-plane API | 493 tests, 487 pass, 0 fail, 6 skipped |
| site | 405 pass, 0 fail |
| worker (Python) | 261 pass, 0 fail |

Two traps re-confirmed while running these. The site suite fails with
`Server exited with code 1 before becoming ready` if two runs overlap — they
contend for the same port, and it looks like a real failure. And macOS's
`python3.9` still cannot load the worker package; `/tmp/wvenv` was rebuilt on
`python3.12`.

**`japan-2026` is absent from `PROVISIONER_VMID_MAP`, and that is correct** —
not the gap an earlier draft of this section called it. `provisioner.py` reads
`self._vmid_map.get(slug) or self._compute.create_container(...)`, so a static
entry means "legacy, hand-provisioned, long-lived container" and *absence*
means "allocate a fresh one through Phase G". `japan-2026` took the second
path: `LxcProvisionAdapter` allocated vmid 101 at `192.168.0.60` (first in the
60-99 pool) and wrote `~/kinerary-deploy/trips/japan-2026/topology.yaml`
before apply, so a retried job reuses the allocation rather than taking a
second IP. `mcp_bridge.py` falls back to reading that file for the same reason.
The container survived the outage — both `192.168.0.60:8080` and
`japan-2026.ara-united.store` return 200.

**What actually bypassed the pipeline is the trip row, not the container.**
`trip_japan2026seed0000000000000a` is a hand-seeded stub with empty `title`,
`destination_label`, `start_date` and `end_date`, created to give the router a
binding target for the live group test. So the compute half of provisioning has
been exercised for real and the intake→trip half has not, for this trip. See
the full-cycle item added to Sprint 6.

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
