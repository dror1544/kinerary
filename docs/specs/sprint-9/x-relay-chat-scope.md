# Outbound relay actions are scoped to the caller's own chats

Status: approved (2026-11-16, by Dror: the four open questions answered) · Issue: none yet (file one; this file is renamed to `<n>-relay-chat-scope.md` then) · Track: hardening · Size: S–M (one slice) · Tier: High
Security path: yes (the relay's gateway identity; `control-plane/api/src/relay/connector.ts`) · Migration: no · Live-trip behaviour: yes (relay behaviour; risk class)

Related: `docs/per-trip-gateway-architecture.md` §4 (inbound routing by authenticated
identity, and "The one declared exception"); `docs/companion-runtime-identity.md`.

## Requirement

Every outbound action a gateway sends over the relay socket (`send`, `edit`, `typing`,
`get_chat_info`) is performed only for a chat that belongs to that gateway's authenticated
identity, decided from the control-plane database at the time of the action. Inbound
routing already follows this rule (`socketsFor`, `connector.ts:681-687`); outbound is made
to match it.

Current behaviour, as needed for the contract:

- The gateway id is derived from the upgrade token at connection
  (`connector.ts:267`, `bearerIdentity` at `:297-303`) and passed to `onConnection`
  (`:305`), where it keys the socket map.
- Frames are dispatched with `onFrame(ws, frame)` (`:336`, `:363`) →
  `onOutbound(ws, frame)` (`:379`, `:394`) → `performAction(action)` (`:417`, `:430`).
  `performAction` does not receive the gateway id, and `chat_id` comes only from the frame.
- The only per-chat lookup on this path is `interviewChat` (`:145`, used at `:455`,
  `send` only), wired in `control-plane/api/src/relay/server.ts:383-386` to
  `resolveChatRoute` (`control-plane/api/src/chat-router.ts:377-425`).
- `control-plane/api/test/relay-connector.test.ts:218-229` sends to chat `"900"` from
  `gw_1` with no route configured and expects delivery.

## Behaviour

For each outbound action the connector resolves the chat's route once, with
`resolveChatRoute`, and allows the action only when one rule below holds. The gateway id
is the one from the upgrade token; nothing in the frame (including any profile or
`hello` field) is an input.

| Route for `chat_id` | Allowed when the caller's gateway id is |
|---|---|
| `companion`, `hermesProfile` = P (not null) | P, or the declared multiplex gateway |
| `companion`, `hermesProfile` null | nobody |
| `interview` | the interviewer profile, or the declared multiplex gateway |
| `unbound` | nobody |
| lookup failed, or no database configured | nobody |

- "Declared multiplex gateway" is `relay.multiplex_gateway_id` (`fallbackGatewayId`,
  `connector.ts:130`; `server.ts:122,263,376`). The interviewer gateway authenticates
  under that id today, not under `relay.interviewer_profile`
  (`docs/per-trip-gateway-architecture.md`, "The one declared exception"), so the
  interview row depends on it. Unsetting the key makes outbound as exact as inbound, with
  no code change.
- "Interviewer profile" is `relay.interviewer_profile` (`server.ts:111,262`). Unset, the
  `interview` row is allowed for the multiplex gateway only.
- The check runs first in `performAction`, before the interview branch, the silence
  verdict, the leak filter and any Telegram call. A refused action has no side effect:
  no Telegram call, no `interviewSay`, no `setExpectsReply`, no `renewConversation`, no
  `assistantEvents` record, no `explicitTurns` lookup.
- One resolution per action. The `send` path reuses it for the existing interview branch
  instead of calling `interviewChat` a second time.
- No cache. A binding closed or switched takes effect on the next action.

Consequences that follow from the table and are intended:

- **A chat mid-interview** (a live session, `LIVE_INTAKE_SESSION_PREDICATE`,
  `organizer-trips.ts:54-55`) belongs to the interviewer. A companion whose trip is also
  bound to that chat is refused there until the session is confirmed or expires; the
  existing conversion through `say` (`connector.ts:455-478`) then applies only to the
  interviewer's own sends.
- **A closed binding** stops resolving (`chat-router.ts:397-410`, `closed_at IS NULL`),
  so the companion that held it is refused from that moment, including a reply to a turn
  it received before the close. A DM switched to another trip with `/switch` is the same
  case.
- **A companion route with no profile** (migration 0043, companion not installed yet) is
  refused for everyone, as inbound already drops it (`normalize.ts:484`).

## Acceptance criteria

- AC-1 Given a gateway authenticated as P and a chat whose route is `companion` with
  profile P, then each of `send`, `edit`, `typing` and `get_chat_info` is performed and
  answered exactly as before this change (same Telegram call, same `outbound_result`).
- AC-2 Given a gateway authenticated as P and a chat whose route is `companion` with
  profile Q ≠ P, then for each of the four ops no Telegram call is made and the result is
  `{ success: false, error: "CHAT_NOT_IN_SCOPE" }`.
- AC-3 Given a chat whose route is `unbound`, or `companion` with a null profile, then
  every caller gets AC-2's refusal for every op, the multiplex gateway included.
- AC-4 Given a chat whose route is `interview`, then the interviewer profile's gateway
  and the multiplex gateway get today's behaviour (the `send` conversion through `say`
  included), and any other gateway gets AC-2's refusal for every op.
- AC-5 Given the multiplex gateway is configured, then it is allowed on every
  `companion` route with a non-null profile; given it is not configured, then no gateway
  id is allowed on a route that is not its own.
- AC-6 Given a binding that was open when a turn was pushed and closed before the reply,
  then the reply is refused (AC-2) and nothing reaches Telegram.
- AC-7 Given the route lookup throws, or the connector has no route resolver, then the
  action is refused with `{ success: false, error: "SCOPE_CHECK_FAILED" }` and no Telegram
  call is made. Every `outbound` frame with a `requestId` still gets exactly one
  `outbound_result` (the file header's invariant, `connector.ts:18-21`).
- AC-8 Given a refusal, then exactly one log line `relay.outbound_out_of_scope` is
  written with `op`, `gateway_id`, `route_kind` (`companion` | `companion_no_profile` |
  `interview` | `unbound` | `lookup_failed`) and `reason`. It carries no message content,
  no content length, no `reply_to`, no `message_id`, and no profile other than the
  caller's own.
- AC-9 Given the two error words, then neither is classified as a timeout or as
  retryable by the captured Hermes classifier (`hermesIsTimeout`, `hermesIsRetryable`,
  `test/support/hermes-mirror.js`), so the gateway does not retry or re-send a refused
  action.
- AC-10 Given a refused action, then no `setExpectsReply`, `renewConversation`,
  `interviewSay` or `assistantEvents` call was made.
- AC-11 Given inbound routing, `canReachProfile`, the media plane and the upgrade, then
  their behaviour and their existing tests are unchanged.

## Contracts

**Pure decision: `control-plane/api/src/relay/outbound-scope.ts`** (new)

```ts
export type OutboundScope =
  | { allowed: true }
  | { allowed: false; routeKind: "companion" | "companion_no_profile" | "interview" | "unbound"; reason: string };

export function outboundChatAllowed(
  route: ChatRoute,
  gatewayId: string,
  roles: { interviewerProfile?: string; multiplexGatewayId?: string },
): OutboundScope;
```

No I/O; the whole table above is this function. Unit-tested over every `ChatRoute`
variant × {own id, other id, interviewer id, multiplex id, multiplex unset}.

**Connector** (`connector.ts`)

- `ConnectorOptions` gains `resolveRoute?: (chatId: string) => Promise<ChatRoute>` and
  `interviewerProfile?: string`. Absent `resolveRoute` means every outbound action is
  refused (AC-7): fail closed, same direction as inbound (`normalize.ts:13-17`).
- `interviewChat` is removed; the interview branch reads `route.kind === "interview"` from
  the one resolution. Its two callers (`server.ts:383`, the test harness) move to
  `resolveRoute`.
- `onConnection` passes `gatewayId` to `onFrame`, `onOutbound` and `performAction`
  (`performAction(action, gatewayId)`). The id is the one closed over at `:305`, never
  re-read from a frame.
- Error words exported as constants: `CHAT_NOT_IN_SCOPE`, `SCOPE_CHECK_FAILED`.

**Relay server** (`server.ts:368-433`): passes `resolveRoute: (chatId) =>
resolveChatRoute(runtime.db!, chatId)` and `interviewerProfile: runtime.interviewerProfile`
when `runtime.db` is set. Without a database nothing is passed, and outbound is refused,
as inbound already routes nothing without one.

**Logging**: `relay.outbound_out_of_scope` at `warn` (AC-8), through `structuredLog`.

## Non-goals

- Changing inbound routing, the multiplex exception itself, or retiring
  `relay.multiplex_gateway_id`. That is `per-trip-gateway-architecture.md` §11's work.
- Giving the interviewer gateway its own id. Until it has one, the interview row depends
  on the multiplex id; once it has one, the multiplex id can be unset.
- Scoping the media plane (`/relay/media/{id}`) by gateway. Separate change if wanted.
- Rate limits or a cache on the lookup.

## Security and boundary notes

- **Fail-safe direction.** Every unrecognised, missing or failed input resolves to
  refusal (AC-3, AC-7), the same rule as `shared/needs-schema.js` and inbound routing.
- **Identity source.** Only the upgrade token's id. A test proves a frame carrying a
  different profile in any field changes nothing.
- **Boundary review** by `boundary-reviewer` before merge, with real request/response
  through the relay test harness (`relay-connector.test.ts`'s `withConnector` + `dial`,
  real WebSocket frames, `FakeTelegram` recording calls): for each of the four ops, the
  `outbound` frame sent and the `outbound_result` received, own chat vs. another
  profile's chat vs. unbound vs. interview, with `FakeTelegram`'s record shown empty on
  every refusal, plus the log line from AC-8 showing no content.
- **Logs.** No content, length or message ids on a refusal (AC-8).

## Test plan

Written first, from the criteria.

- `control-plane/api/test/relay-outbound-scope.test.ts` (new): the pure table, every
  route kind × caller kind, including multiplex unset and interviewer unset.
- `control-plane/api/test/relay-connector.test.ts`:
  - the harness gains a `routes` option (chat id → `ChatRoute`) and a default that binds
    the chats the existing tests use to `gw_1`'s own profile, so every existing
    outbound test keeps its assertion and now also proves AC-1;
  - `:218-229` is kept for the own-chat case and gains its inverse: the same frame from
    a gateway authenticated as another profile gets `CHAT_NOT_IN_SCOPE` and
    `h.telegram.sent` stays empty;
  - AC-2 to AC-8 and AC-10, one test per op where the op matters; a closed-binding test
    (AC-6) flips the route between push and reply;
  - the interview tests (`:247-330`, `:493`, `:606`) run as the interviewer/multiplex id
    and gain the inverse for a companion id.
- `control-plane/api/test/hermes-mirror.test.ts`: AC-9, and its connector construction
  gains a route resolver.
- The other constructors of `RelayConnector` (`assistant-events-contract`,
  `assistant-events-paths`, `assistant-events-replay`, `group-conversation-window.e2e`,
  `group-document-to-plan.integration`) get a resolver that binds their chats to their
  gateway, and must pass unchanged otherwise. A test that needs a different expectation
  is a finding to report, not to adjust silently.
- A DB-backed test (`cptest_*` database) through `server.ts`'s wiring: a real
  `telegram_chat_bindings` row, open then closed, and a live `intake_sessions` row.

## Rollout and regression

- Relay behaviour change: risk class. A regression plan is needed before the merge to
  `main`, and the owner's manual test is decided by it.
- **Backward compatibility for live companions.** No live companion may lose an action
  on its own chats. Before merge, a read-only probe per environment (staging, then the
  VM) lists every gateway id that has sent an outbound action recently together with the
  route each target chat resolves to, from relay logs and `telegram_chat_bindings` only
  (no message content): every pair must be allowed by the table. Specifically checked:
  each companion's scheduled deliveries (daily message, cron home channel) target a chat
  with an open binding to its own profile; the interviewer's gateway id equals the
  configured multiplex id or interviewer profile.
- Ship order: staging relay first, one full interview plus one companion turn in a
  group and in a DM, then the VM relay with `vm-relay-restart.sh`. Grep
  `relay.outbound_out_of_scope` after each; any line on a known-good chat stops the
  rollout and the change is reverted by restarting the previous relay.
- Not behind a feature switch: switches are per trip and this is a relay-wide rule. The
  way back is the previous relay image.
- Docs updated in the same PR: `docs/per-trip-gateway-architecture.md` §4 (outbound now
  follows the same identity rule) and the connector's file header.

## Decisions (Dror, 2026-11-16)

1. **The multiplex exception covers every bound chat** (option (a), as AC-5 is written). Not tied to live
   socket state.
2. **The refusal log line carries `chat_id`**, and still no content, length or message ids.
3. **An interview is bound to one private chat, and only that chat is closed to the companion.** While a
   person is mid-interview, the companion is refused in that person's private chat only. Every other chat
   bound to the trip, every group included, keeps working with the companion as before. A test proves a
   group of the same trip is unaffected while its organizer's private chat is mid-interview.
4. **A relay without a database refuses all outbound.** The pre-merge probe confirms no deployment runs one.

## Open questions

None open.
