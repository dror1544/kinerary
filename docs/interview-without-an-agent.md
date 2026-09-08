# A deterministic interview with bounded LLM functions

**Status: approved 2026-09-07 with adjustments. Steps 1–5 built, unmeasured.**
Frozen comparison point: the tag `pre-interview-rewrite`. The slice is behind
`intake_sessions.interpret_path`, off by default, and no session has been
switched onto it — §8's benchmark is the next thing, and until it has run this
is a path that passes its tests rather than a path that is known to work.

The one-line statement of intent, which the rest of this document exists to
serve:

> **A deterministic interview with bounded LLM functions — not an interview
> agent.**

The interview is an application workflow that calls a model for semantic
judgment. It is not a model workflow that happens to call application code.
Postgres and the router remain the single authority for state, ordering,
lifecycle, validation and completion.

## 1. What is actually wrong

Not the state machine. The router already owns the question set, ordering,
`routerOwned`, the floor, turn lifecycle, settle windows, dedup, recap, confirm
and language — 23 questions, mostly linear. That half works and is not in
question here.

The problem is one affordance: **an autonomous agent can put words on the
organizer's screen, and can write answers into the interview.** Every failure of
the last three runs descends from it.

| What the organizer saw | Because |
|---|---|
| "I'm waiting for your answer" to a question never sent | the agent narrated its own intent as if it were speech |
| The router and the agent asking at once | the agent decided what to ask |
| English arriving mid-Hebrew | the agent composed prose, and a rate-limit swapped the model mid-run |
| The interview going quiet | the agent hit a turn boundary it does not control and could not speak at all |

Each has been fixed *at the door* — a leak filter, a prose/narration split, a
language guard. Every one of those is detection after the fact.
`internal-leak.ts` already says why that ceiling is low:

> A prompt rule cannot be relied on for this: it has been written three times
> now and each new model finds a way around it.

An interview is a **bounded, structured data-collection task with a known
question set**. That is close to the worst fit for an autonomous agent, and a
good fit for constrained calls.

## 2. The shape, which already exists here

`itinerary-extract.ts` is the pattern, and its own docstring is the thesis:

> The model … **only produces structure**. Every invariant the site depends on is
> enforced here, in reviewed code, not left to the model.
>
> `normaliseExtractedItinerary` is pure and is what the tests exercise;
> `extractItinerary` wraps it with the one-shot CLI call. Any failure returns
> `{ ok: false }` — the interviewer proceeds, never blocked.

Three properties worth naming, because they are the whole design:

1. **The model's output goes to our code, never to a person.** Whatever it
   returns is data to be validated.
2. **The pure function is the tested unit.** The CLI wrapper is thin enough to
   be uninteresting.
3. **Failure is a value, not an exception.** `{ ok: false }` and the flow
   continues.

Extending this to the interview is applying a local pattern, not importing a
framework.

### Why not LangGraph

Considered and rejected. It brings its own state and checkpoint model, and we
already have one in Postgres that the router depends on. **Two authorities over
"where is this interview" is precisely the bug class this project has been
chasing** — the router yielding to a turn the watchdog would not close, each
waiting on the other. Adding a second state machine multiplies that rather than
removing it. It is also Python-first, on a latency-sensitive path in a
TypeScript control plane.

The graph here is small and mostly linear. What is actually needed is structured
output, per-task model choice, and no free-text channel — none of which requires
a framework.

## 3. The pipeline

The first slice is exactly this, and nothing else:

```
organizer message
  → interpret            (model: proposes)
  → validate / normalize (our code: decides)
  → router               (our code: records, orders, asks next)
  → intake-copy.ts       (our code: the words on screen)
```

There is no generative prose in that path. Every character the organizer reads
comes from `intake-copy.ts`, localised, as it does today when the agent is
silent.

## 4. `interpret` — proposals, not answers

`interpret` answers one question: *which of the outstanding questions does this
message answer, and with what?* Its output is **proposed**, never accepted.

**In:** the organizer's message burst, the current session state (answered,
outstanding, the question on screen), the trip's language.

**Out:**

```ts
export type ProposedValue =
  | { kind: "choice"; optionId: string }
  | { kind: "choice_other"; otherText: string }
  | { kind: "multi_choice"; optionIds: string[] }
  | { kind: "text"; text: string }
  | { kind: "structured"; data: unknown };

export interface ProposedAnswer {
  questionId: string;
  value: ProposedValue;
  /** 0..1. Below the threshold the proposal is not committed — the question
   *  stays outstanding and the router asks it. Never silently dropped. */
  confidence: number;
  /** A verbatim span of the source burst. Checkable: see §4.2. */
  evidence: string;
  /** Which message in the burst it came from. Carries into the idempotency
   *  key (§6) and into the audit row. */
  sourceMessageId: string;
}

export type InterpretResult =
  | { ok: true; proposals: ProposedAnswer[]; unclear: { questionId: string; why: string }[] }
  | { ok: false; reason: "NOT_CONFIGURED" | "FAILED" | "RATE_LIMITED" | "TIMED_OUT"; detail?: string };
```

`ProposedValue`'s discriminants mirror `IntakeAnswer`'s deliberately — but they
are separate types, and the conversion between them is the gate in §4.1. A
proposal is not an answer that happens to be untrusted; it is a different thing.

### 4.1 The gate already exists

`validateAnswer` (`control-plane/api/src/interview.ts:566`) is already the
deterministic validator this design needs, already tested, already the only path
by which the agent's `submit_answer_for_chat` reaches storage. `ProposedAnswer`
maps onto its parameter list one-for-one:

| Proposal | `validateAnswer` argument |
|---|---|
| `{ kind: "choice", optionId }` | `optionId` |
| `{ kind: "choice_other", otherText }` | `optionId = "other"`, `otherText` |
| `{ kind: "multi_choice", optionIds }` | `optionIds` |
| `{ kind: "text", text }` | `otherText` |
| `{ kind: "structured", data }` | `structuredData` |

So the model **cannot invent an option** — an id not in `question.options`
returns `UNKNOWN_OPTION`. It cannot exceed a length, skip a required field, or
hand a structured question the wrong shape; `checkComplete` still runs. This is
the single most important consequence of the redesign and it costs no new code:
the validator we already trust becomes the only door, and the model is moved to
the outside of it.

Nothing new is written that bypasses `validateAnswer`. If a future proposal kind
cannot be expressed through it, that is a signal to extend the validator, not to
add a second path.

### 4.2 Evidence is checked, not decorative

`evidence` must be a span of the source burst, and we verify that it is —
normalisation (a date phrase to ISO, a Hebrew name to a Latin spelling) happens
on `value`, never on `evidence`. A proposal whose evidence does not appear in
the message the model was given is evidence of nothing, and is rejected before
validation.

This is cheap and catches the specific failure where a model fills a field from
its own prior rather than from what the organizer wrote.

### 4.3 Policy on proposals, which is ours

- **Below threshold** → not committed. The question stays outstanding; the
  router asks it normally. A low-confidence read costs one question, never a
  wrong answer.
- **Already answered** → a change, not a write. Mid-interview overwrites are not
  applied silently; the router confirms. (Distinct from the post-confirmation
  path, which is `intake-correction.ts` and creates a new intake version.)
- **`unclear[]`** → the router asks that question next, which is what it would
  have done anyway. `unclear` is a scheduling hint, not an error.
- **`{ ok: false }`** → the router proceeds on its own copy. The interview
  cannot go silent because a provider rate-limited. This is `extractItinerary`'s
  contract, unchanged.

## 5. One writer per session

If the `interpret` path is enabled for a session, **the agent may no longer
write into that interview at all.** Not "should not" — the write is refused.

Running both in one session would preserve exactly the competing-writer failure
the redesign exists to remove, and would make the benchmark in §8 meaningless:
any result would be a property of the mixture, not of either path.

**Where the guard goes, checked rather than assumed.** The agent's write surface
is not the six MCP tools — those are seven `mcp.tool` registrations in a
*separate process* (`interview-mcp.ts`, the sidecar on :4311), and every one of
them reaches the interview by calling `forwardAsAgent()` over HTTP. The real
surface is the route group they forward to, in `app.ts`:

```
POST /internal/interview/agent/current/ask       ask_question_for_chat
POST /internal/interview/agent/current/answers   record_answers_for_chat
POST /internal/interview/agent/current/answer    submit_answer_for_chat
POST /internal/interview/agent/current/say       say_for_chat
POST /internal/interview/agent/current/language  set_interview_language_for_chat
POST /internal/interview/agent/current/summary   show_summary_for_chat
GET  /internal/interview/agent/current           get_interview_for_chat  (read-only, stays)
```

One hook on that prefix, refusing the POSTs for a session on the new path, is
the whole guard — and it must live here rather than in the sidecar, because the
sidecar is a separately deployed process that can be stale. A per-tool check in
`interview-mcp.ts` would be seven chances to add an eighth tool that forgets,
in the one place that is not authoritative.

`SessionLocator` (`interview.ts:1898`) already distinguishes
`{ by: "agent", chatId }` from `{ by: "chat", chatId }`, so answer-writes are
separable at the data layer too — but only answers. The speech tools go through
the same `by: "chat"` path the router uses, which is precisely why the route
prefix, not the locator, is the correct seam.

The refusal is a typed reason (`SESSION_NOT_AGENT_WRITABLE`), logged, not a
silent no-op: if the agent is still running against a converted session, that is
a deployment fault worth seeing.

## 6. Idempotency is a requirement, not a property

Every interpretation and every commit is keyed to the message that caused it.
Telegram redelivers, the relay restarts, and a crash between model completion
and DB commit is an ordinary event, not a hypothetical — the relay process died
silently for ten minutes during run 15.

**Prerequisite — smaller than it first looked, and worth recording why.** The
design said the Telegram `message_id` was dropped when a burst was queued, on
the strength of `QueuedInboundEvent` being declared `{ text: string }`
(`interview.ts:1545`). Implementing it showed the declaration was simply wrong:
the poller queues the whole `WireMessageEvent`, and `flushSettledInboundBursts`
casts it straight back out with `as WireMessageEvent[]`. The id was in
`pending_inbound` the entire time — the *type* was hiding it, not the storage.

So the prerequisite was a type fix, not a data migration. It is still a
prerequisite: a declaration narrower than its data is exactly how a field goes
missing for everything downstream, and the cast was what let the two disagree
without anyone noticing.

With that in place:

- The interpretation is stored against `(chat_id, message_ids)`; a repeat of the
  same burst reuses the stored result rather than paying for the call again.
- The commit is keyed the same way, so a retry after a crash is a no-op rather
  than a second answer.
- The burst is already claimed atomically (`claimSettledInboundBursts`, a CTE
  chosen precisely so two poll ticks cannot both flush one burst). The
  idempotency key extends that guarantee across the model call, which sits
  outside the claim.

## 7. `StructuredModelRunner`

The interview does not know which CLI it is talking to.

```ts
export interface StructuredModelRunner {
  run<T>(req: {
    task: string;        // "interpret" — selects the pinned model
    prompt: string;
    schema: JsonSchema;  // what shape is acceptable
    timeoutMs: number;
  }): Promise<{ ok: true; value: T } | { ok: false; reason: string; detail?: string }>;
}
```

Adapters behind it: the Claude and Hermes CLIs, **OpenRouter over HTTP**, and a
fake for tests. The interface is transport-agnostic on purpose — only
`cliRunner` spawns a process — so adding OpenRouter needed no change to any
caller. Model pinning is per `task`, in configuration, not in the interview's
code: `interpret` wants precise and cheap, `extract` wants long-context, and
those move independently. `composeRunners` routes a task to its own runner, so
the two can live on different transports at once.

**One rule the OpenRouter adapter enforces by omission:** the request never
carries a `models: [...]` fallback array. OpenRouter will silently substitute
another model for one that is unavailable, which is the exact shape of the
2026-09-07 failure — and from the caller it is indistinguishable from success.
Provider routing *within* one model is fine (same weights, different host); a
different model is not. There is a test asserting the key is absent from the
request body, because an omission nothing checks is an omission that comes back.

Two reasons this abstraction earns its keep rather than being ceremony:

1. **Benchmarking needs it.** §8 compares accuracy and latency across providers;
   without a seam that is a rewrite each time.
2. **It is where "own the retry" lives.** The 2026-09-07 failure was a fallback
   chain we did not own: `status=429`, the primary exhausted, and a *different
   model* finished the interview under the same SOUL. A rate-limit must degrade
   to our own copy, visibly, not to a different personality. That policy belongs
   in one place, and this is it.

`extractItinerary` shells out to `hermes` with a no-tools profile today. It
should move behind this interface too — but not in the first slice.

## 8. Benchmark before extending

The slice is not "done" when it works once. Measured against runs 14–15 on the
same organizer messages:

- **Accuracy** — answers recorded, per question, versus what the organizer meant.
- **Latency** — p50 and p95 per turn. Current agent turns run **20–90 seconds**;
  one turn took 111s across 16 API calls to produce 103 characters. A one-shot
  call has to beat that comfortably, and probably will — but process spawn per
  turn is the one cost this design *adds*, so it is measured, not assumed.
- **Retries** — how often the runner retried, and why.
- **Failure rate** — `{ ok: false }` per turn, by reason.

If the numbers hold, that is sufficient evidence to remove Hermes from the
intake path entirely.

## 9. Then: `extract`

Document extraction follows the same shape. `extractItinerary` now runs as the
`extract` task on the shared runner, pinned to **MiniMax M3 on OpenRouter**
(`minimax/minimax-m3`, `EXTRACT_RUNNER=openrouter`). Verified against
OpenRouter's live model list on 2026-09-08: 1,048,576-token context, $0.30/M in
and $1.20/M out, `response_format` and `structured_outputs` both declared. The
million-token window is the reason — extraction is the one task where long
context earns its cost.

### A fallback chain hiding a broken primary

The `kinerary-extract` Hermes profile names `minimax/minimax-m3:free` as its
default. **There is no such model id.** OpenRouter publishes 16 `:free`
variants and no MiniMax is among them.

So that profile's primary has been failing on every call, and its seven
fallbacks across four providers — openai-codex, anthropic, three more
OpenRouter models, ollama-cloud — have been quietly absorbing it. Nobody would
see this: extraction kept working, on a model nobody chose.

That is the argument for §7's no-fallback rule stated better than the design
stated it. A chain does not just risk swapping models under load; it removes
the signal that would tell you your configuration is wrong. Going direct means
a limit is a limit and a bad model id is an error: retried on the same model,
then surfaced as `RATE_LIMITED` or `FAILED`, and the caller decides.
`extractItinerary` already treats failure as `{ ok: false }` and proceeds, so
that decision is one the path knows how to make.

Worth fixing in the profile too — separately, since anything still on the
Hermes path deserves a primary that resolves.

Unset, `extractItinerary` still shells out to the Hermes profile exactly as it
always has — the current acceptance path does not move until the environment
says so.

Still to do here: the call should answer travellers, phases, dates and anchors,
not only the day-by-day. Runs 14–15 leaned on this path hard — a multi-file USA
upload responded to one file and stopped — and none of that is fixed by
changing which model is called.

## 10. Deferred: `phrase`

Earlier drafts had a third call producing one string of prose in the organizer's
voice, with a null return falling back to `intake-copy.ts`. **Deferred, and
deliberately.**

The architectural benefit should be proved *without* reintroducing generated
prose into the user-facing path. Every failure in §1 is a prose failure; a
design whose first move is to add a prose channel back has not demonstrated
much.

If it returns, it returns as a non-critical layer with a hard fallback:
`intake-copy.ts` is correct, localised, and merely robotic. The bar for
reintroduction is a specific complaint the canonical copy cannot answer — not a
general sense that the interview reads flat.

## 11. What we give up, honestly

The agent does real judgment today, and each piece becomes an explicit step:

- **Transliterating Hebrew names.** Becomes part of `interpret`'s proposal for
  `travelers` — a proposed spelling the organizer can correct, which is what the
  SOUL already asks for.
- **Reading a document and asking a natural follow-up.** Becomes `extract` then
  the router's own next question.
- **Judging when the organizer has said several things at once.** Becomes
  `interpret` returning several proposals, which is strictly easier than the
  agent remembering to batch them — and is the case `record_answers_for_chat`
  handles badly today (`text` questions come back in `rejected[]` with
  `TEXT_REQUIRED`, so a batch has to be followed by one call per text field).

Bounded work, and each piece becomes testable — which nothing in the current
interview is.

Two things genuinely lost: conversational improvisation, and warmth beyond what
canonical copy carries. For an intake with a known question set, that trade is
worth making. **For the companion it would not be** — open-ended conversation
over live trip data is the case where an autonomous agent is the right shape,
and Hermes stays there. Two runtimes for two genuinely different jobs is a
reasonable end state, not a smell.

## 12. Rollout

1. ~~Carry `message_id` into `QueuedInboundEvent`~~ — BUILT (2026-09-07).
2. ~~Implement `interpret` only, behind `StructuredModelRunner`~~ — BUILT.
   `model-runner.ts`, `interpret.ts`; Claude and Hermes CLI specs plus a fake.
3. ~~Make the router the sole writer for sessions on the new path~~ — BUILT.
   One `preHandler` on `/internal/interview/agent/`, POSTs only.
4. ~~Typed proposals validated through `validateAnswer` before persistence~~ —
   BUILT. `applyProposals`, and accepted proposals are written through
   `submitAnswerForChat` so there is still exactly one way an answer is stored.
5. ~~Make persistence idempotent per turn/message~~ — BUILT. Migration 0048,
   unique `(telegram_chat_id, burst_key)`, `committed_at` separating "we know
   what this meant" from "the answers are written".
6. **Benchmark** accuracy, p50/p95 latency, retries and failure rate against
   runs 14–15 (§8). Not started, and nothing below should start before it.
7. Extend document extraction (§9). **Transport BUILT** — `extract` runs on
   MiniMax over OpenRouter when configured, Hermes otherwise. The extraction
   *scope* (travellers, phases, dates, anchors) is not started.
8. Decide afterwards whether `phrase` is needed at all (§10).

Steps 1–5 are one slice; the flag is per session, and the agent path stays
intact and untouched for sessions not on it.

What steps 1–5 do **not** establish: that any of it is better. No session has
run on the path, no model has been called outside a fake, and the process-spawn
cost §8 exists to measure has not been paid once. The tests show the gate
refuses what it should refuse; they say nothing about whether a real model
proposes the right things in Hebrew.

## 13. What must not regress

The properties runs 6–15 paid for, each with tests already standing:

- **One voice, one writer** — the router remains the only writer. Strengthened:
  now nothing else *can* write (§5).
- **The interview always has a way to finish** — `/done` reaches the recap
  regardless of what any model does.
- **The interview never asks what it already knows** — dedup and
  `optionalRemaining` are ours and unchanged.
- **Never a form** — the router's ordering and its buttons are what keep it from
  reading as one; §10 is a bet that they are enough.
- **Fail safe** — an unrecognised value resolves to the most restrictive option;
  a failed call resolves to our own copy.
