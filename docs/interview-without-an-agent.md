# The interview without an agent

**Status: design, not implemented.** Written 2026-09-07, after runs 13–15.
Frozen comparison point: the tag `pre-interview-rewrite`.

## 1. What is actually wrong

Not the state machine. The router already owns the question set, ordering,
`routerOwned`, the floor, turn lifecycle, settle windows, dedup, recap, confirm
and language — 23 questions, mostly linear. That half works and is not in
question here.

The problem is one affordance: **an autonomous agent can put words on the
organizer's screen.** Every failure of the last three runs descends from it.

| What the organizer saw | Because |
|---|---|
| "I'm waiting for your answer" to a question never sent | the agent narrated its own intent as if it were speech |
| The router and the agent asking at once | the agent decided what to ask |
| English arriving mid-Hebrew | the agent composed prose, and a rate-limit swapped the model mid-run |
| The interview going quiet | the agent hit a turn boundary it does not control and could not speak at all |

Each has been fixed *at the door* — a leak filter, a prose/narration split, a
language guard. Every one of those is detection after the fact. `internal-leak.ts`
already says why that ceiling is low:

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

## 3. The calls

Three, each one-shot, each returning typed data, each independently testable.

### 3.1 `interpret` — what did the organizer just say?

**In:** the organizer's message (or burst), the current session state (answered,
outstanding, the question on screen), the trip's language.

**Out:**
```
{ answers: [{ questionId, value }], unclear: [{ questionId, why }], notes }
```

This is where `record_answers_for_chat` / `submit_answer_for_chat` failures live
today, and where the agent's own documented confusion sat (`data` vs
`structured` — a shape it got wrong repeatedly against a tool description that
already said `data`). A typed return removes the possibility.

**Model:** precise and cheap. Pinned.

### 3.2 `extract` — what is in this document?

Already exists as `extractItinerary`. Extended, not replaced: the same call
should answer travellers, phases, dates and anchors, not only the day-by-day.

**Model:** the extraction model, pinned separately from 3.1 — this is the one
task where a stronger or longer-context model earns its cost.

### 3.3 `phrase` — say this in the organizer's words

**In:** the question id, the session language, what was just recorded.

**Out:** one string, or null.

The **only** call that produces prose, and its output is still ours: the router
renders it inside its own message, with its own buttons, or discards it. A null
return falls back to `intake-copy.ts`, which is correct and localised and merely
robotic — the current fallback, unchanged.

Language is checked here as it is today (`agentTextIsInLanguage`), but now the
failure is recoverable without loss: discard and use our copy.

## 4. What our code keeps

Everything that works. The router still decides which question is next, owns the
keyboard, records answers, holds the floor, draws the recap and confirms. Every
message to the organizer is rendered by us, from localised copy, with the model
contributing at most a phrasing.

**No session, no SOUL, no tool registry, no autonomous loop, no fallback chain we
do not own.** A model call that fails returns `{ ok: false }` and the router
proceeds with its own copy — the interview cannot go silent because a provider
rate-limited.

## 5. What we give up, honestly

The agent does real judgment today, and each piece becomes an explicit step:

- **Transliterating Hebrew names.** Becomes part of `interpret`'s output for
  `travelers` — a proposed spelling the organizer can correct, which is what the
  SOUL already asks for.
- **Reading a document and asking a natural follow-up.** Becomes `extract` then
  the router's own next question.
- **Judging when the organizer has said several things at once.** Becomes
  `interpret` returning several answers, which is strictly easier than the agent
  remembering to batch them.

Bounded work, and each piece becomes testable — which nothing in the current
interview is.

Two things genuinely lost: open-ended conversational warmth beyond a phrasing,
and the agent's ability to improvise around an unanticipated situation. For an
intake with a known question set, that trade is worth making. **For the
companion it would not be** — open-ended conversation over live trip data is the
case where an autonomous agent is the right shape, and Hermes stays there. Two
runtimes for two genuinely different jobs is a reasonable end state, not a smell.

## 6. Which CLI

`extractItinerary` shells out to `hermes` with a no-tools profile. For the
interview, going straight to the Claude/Anthropic CLI drops the Hermes
dependency on this path entirely, and with it the fallback chain that swapped
models mid-run on 2026-09-07 (`status=429`, primary exhausted, a different model
finishing the interview under the same SOUL).

Pin the model per call. Own the retry. A rate-limit should degrade to the
router's own copy, visibly, not to a different personality.

## 7. First slice

Do not convert the whole interview.

Convert **3.1 `interpret`** alone, behind a flag, with the agent still handling
everything else. It is the single step where the most failures live, and it is
measurable: same organizer message, compare answers recorded and latency against
the agent path.

Current agent turns run **20–90 seconds** (measured, runs 14–15: one turn took
111s across 16 API calls to produce 103 characters). A one-shot call has to beat
that comfortably, and probably will — but measure on the slice rather than
assume, because process spawn per turn is the one cost this design adds.

If the slice is faster and more reliable, 3.2 and 3.3 follow the same shape. If
it is not, little was spent.

## 8. What must not regress

The properties runs 6–15 paid for, each with tests already standing:

- **One voice, one writer** — the router remains the only writer. Strengthened:
  now nothing else *can* write.
- **The interview always has a way to finish** — `/done` reaches the recap
  regardless of what any model does.
- **The interview never asks what it already knows** — dedup and
  `optionalRemaining` are ours and unchanged.
- **Never a form** — the reason `phrase` exists at all.
- **Fail safe** — an unrecognised value resolves to the most restrictive option;
  a failed call resolves to our own copy.
