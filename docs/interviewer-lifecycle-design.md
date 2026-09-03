# Ephemeral interviewer, deterministic orchestrator, judging loop

Design for how the intake interviewer should be *run*, as opposed to what it
asks. Proposed 2026-09-03 by Dror, after the first live end-to-end interview
failed in a way none of the existing tests could have caught.

**Status: proposed. Not scheduled inside Sprint 5.** Sprint 5 finishes on the
interim fix described under "What Sprint 5 ships instead". The decision points
at the end say what has to be settled before this becomes a sprint.

---

## The evidence this is answering

On 2026-09-03 an organizer redeemed a real deep link and the interview ended
after one answer with this message:

> אין בעיה, Japan — רשמתי.
> כל הפרטים מסודרים. נסיעה טובה ומהנה למשפחת סולומון! 🇯🇵

Three separate claims in two sentences, none of them true. The answer was not
recorded. The details were not in order. There is no Solomon family on this
trip — that name came from another conversation entirely.

What the database and relay log actually show:

| | |
|---|---|
| deep link redeemed, session created against the right trip | ✅ `interview.session_started` |
| tapped answer recorded | ✅ `trip_type` stored |
| written answer forwarded, agent turn opened | ✅ `trip_bot.interview_forwarded` |
| agent wrote the answer | ❌ nothing stored; turn still open, unclosed |
| interview state | `interviewing` — never near confirmation |

**The deterministic layer did everything right.** Every failure was in the
agent layer, and each one traces to the same root: *the agent layer is the only
part of this pipeline with no lifecycle.*

Three findings, all from that one run:

1. **The profile was months out of date.** The live `trip-intake` profile was
   missing `extract_itinerary` and `lookup_consular_contacts` entirely —
   capabilities the repo had shipped in Sprint 4.5. Nothing detected the drift,
   because nothing ever compares a live profile to its template.
2. **The profile described a flow that no longer exists.** It instructed the
   agent to take an enrollment token and call `start_interview`, and asserted
   as a "real, confirmed platform constraint" that deep links *cannot* work —
   which is precisely what Sprint 5's router was built to do. Every tool it
   named needs a session token the agent no longer holds.
3. **Sessions bleed between profiles.** In `state.db` the only routing entry
   for that DM was `agent:main:` — the *personal assistant's* namespace — and
   the legacy mirror showed three profiles sharing a session created identical
   to the microsecond. The interviewer ran inside someone else's conversation.
   That is where the Solomon family came from.

None of these are bugs in code that tests could have caught. They are all
consequences of a long-lived, hand-maintained, stateful profile.

---

## The proposal

An interviewer that is **created per interview, stateless, and destroyed
afterwards**, driven by a **deterministic orchestrator** that calls a **judge**
for the one step that genuinely needs judgement.

```
signup approved
      │
      ▼
[orchestrator]  render interviewer profile for THIS interview
      │         (chat id + session id baked in at render time)
      ▼
  interview runs ──── organizer abandons ──────┐
      │                                        │
      ▼ CONFIRM                                ▼
[orchestrator]  hand over to trip companion    │
      │         destroy interviewer profile    │
      ▼                                        │
[judge]  ◀───────── transcript + outcome ──────┘
      │            (finished AND abandoned)
      ▼
  proposed template diff + rationale + metrics
      │
      ▼
[super admin]  review → promote or reject
```

### Why per-interview rendering is the load-bearing idea

It is not tidiness. It removes three failure classes structurally:

- **Drift becomes impossible.** The template is applied at every interview, so
  a live profile cannot be months behind the repo. Finding (1) cannot recur.
- **Bleed becomes impossible.** A profile created for one interview has no
  prior conversation to inherit. Finding (3) cannot recur, and the hand-editing
  of `state.db` that was needed on 09-03 stops being an operation anyone does.
- **It solves the chat-id blocker outright.** See below — this is the part that
  turns a blocked design into an available one.

### The chat-id problem, and why this dissolves it

Verified on the live install, 2026-09-03: **the agent cannot learn its own chat
id.** The gateway sets `_chat_id` on the agent object, but nothing renders it
into the prompt — there is no per-turn exposure anywhere in
`prompt_builder.py`, and the only place a chat id has ever appeared is a stored
memory belonging to a different profile. So `submit_answer_for_chat(chatId, …)`
was uncallable as designed, and the brief parks the fix as "FUTURE —
gateway-injected trusted context", waiting on an upstream relay-contract change
that Hermes 0.21.0 does not provide.

A rendered per-interview profile **is written**, so the chat id and session id
can be baked into its `SOUL.md`/config at creation. The agent knows them by
construction. No upstream change, no waiting on the contract.

And the cost is far lower than the brief implies. `_profile_dir_for_source`
resolves `source.profile` via `profile_exists()` **on disk** — not via
`multiplex_profile_allowlist`, which governs secondary *adapters* and cron.
So a rendered profile directory is routable with **no allowlist edit and no
gateway restart per interview**. That was the obvious objection to per-interview
provisioning, and it does not hold.

---

## A/B: where the interviewer's instructions live

The real choice is not "ephemeral or not" — it is what owns the agent's
behaviour between runs.

### Option A — long-lived hand-maintained profile (today)

A single `trip-intake` profile, edited in place, deployed by copying files.

- ✅ Zero provisioning cost; one thing to reason about.
- ✅ Conversation continuity across an organizer's sessions, for free.
- ❌ Drift is undetectable and *did* happen — months of it.
- ❌ Bleed is structural, not incidental: sessions are keyed per profile but
  the session ids are not namespaced.
- ❌ The chat id is unavailable, so the write path cannot work without an
  upstream change.
- ❌ No natural place to hang per-interview measurement, because there is no
  per-interview object.

### Option B — ephemeral per-interview profile (proposed)

Rendered at interview start, destroyed at handover or expiry.

- ✅ Drift and bleed both become impossible rather than monitored.
- ✅ Chat id and session id known by construction — unblocks the write path
  with no upstream dependency.
- ✅ Each interview is a first-class object with a lifecycle, which is exactly
  what metrics and judging need to attach to.
- ✅ Matches how the rest of the pipeline already works: trips, plans and
  releases all have lifecycle states in the control plane.
- ❌ Requires a GC/TTL sweeper, or orphaned profiles accumulate — the same
  class of mess as the stale sessions cleaned by hand on 09-03.
- ❌ No cross-interview continuity: an organizer starting a second trip gets a
  genuinely fresh agent. (Arguably correct — the intake record, not the chat
  history, is the memory that matters.)
- ❌ More moving parts at provisioning time.

**Recommendation: B.** Option A's three defects are not things that can be
fixed by being more careful; two of them are properties of long-lived
hand-maintained state, and the third needs an upstream change that does not
exist. B removes all three and is the only one that makes the interview a
measurable object.

---

## The orchestrator: deterministic, with LLM only where needed

Agreed with Dror, 2026-09-03: as deterministic as possible.

**Deterministic — belongs in the existing control-plane worker, not a new
agent.** Create, render, hand over, destroy, TTL, sweep, promotion gating.
These are state-machine transitions, and the worker already *is* that machine:
a job queue with lifecycle states and adapters. Putting an LLM in charge of
them would put a model in charge of infrastructure it can be wrong about, and
today's run is a reminder of how confidently wrong a model can be about state.

**LLM — exactly one step.** Reading a transcript and saying what went wrong and
what to change. That is a one-shot call, the same shape as the existing
`kinerary-extract` profile.

Proposed lifecycle states, following the existing `trips` convention:

```
pending → rendered → interviewing → { confirmed | abandoned } → judged → reaped
```

`abandoned` is reached by the sweeper on TTL, not by anyone's judgement.

---

## Judging and measurement

Dror, 2026-09-03: measure the unfinished interviews and where they were
abandoned; judge offline; suggest improvements to the super admin; use a strong
model for the judge.

### Abandonment is the primary signal

A finished interview tells you the questions were answerable. **An abandoned one
tells you where the interview loses people, which is the thing worth fixing.**
Today nothing records it at all: an organizer who stops answering leaves a row
in `interviewing` forever, indistinguishable from one still in progress.

Metrics to add — all derivable from `intake_sessions` plus the new lifecycle,
none requiring message content:

| metric | why it earns its place |
|---|---|
| `interview_started_total` | denominator for everything else |
| `interview_completed_total` | completion rate |
| `interview_abandoned_total` | the number that is currently invisible |
| `interview_abandoned_at_question` (bounded label: question id) | **the drop-off point** — which question loses people |
| `interview_duration_seconds` (histogram, by outcome) | a long completion and a long abandonment mean different things |
| `interview_answers_recorded_total` | detects the 09-03 failure directly: turns opened but nothing written |
| `interview_turn_unclosed_total` | a turn opened and never closed is an agent that failed silently |
| `interview_write_failed_total` (by reason) | distinguishes refusal from breakage |
| `interview_corrections_total` (by question id) | a question answered twice is a question asked badly |

The question-id label is bounded by `INTAKE_QUESTIONS`, satisfying the
bounded-labels rule in `docs/trip-bot-analytics-and-metrics-design.md` §8.

`interview_answers_recorded_total` deserves emphasis: had it existed on
2026-09-03, "turn opened, zero answers recorded, session declared complete"
would have been a visible anomaly rather than something found by reading a
Hebrew message and not believing it.

### The judge

A **strong model**, run **offline** — never in the organizer's path, so it can
be slow and expensive without anyone waiting.

Input: the transcript, the recorded intake, the outcome (confirmed/abandoned),
and where it stopped. Output, per interview and aggregated across a window:

- what went wrong, in plain language;
- whether the failure was the template, the model, or the pipeline — the
  distinction the 09-03 run needed and no automated signal provided;
- a **proposed diff** to the interviewer template, with rationale;
- a survey-style summary for the super admin across recent interviews.

It runs on **abandoned interviews too** — those are where the material is.

### The template loop must be gated, not automatic

**A judge that edits the live template unattended will drift, and drift here is
invisible until an organizer hits it** — which is exactly the 09-03 failure
mode reappearing with a faster feedback loop.

So the judge proposes and a human promotes, using the machinery the repo
already has for exactly this shape: candidate → eval → promotion, mirroring the
sealed-manifest release pipeline from Sprint 4.7. `trip-assistant-experience-evaluation`
already exists as the scoring half.

The super admin sees: what changed, why, which interviews motivated it, and
what the eval said. Promotion is a deliberate act.

---

## What Sprint 5 ships instead (the interim, built 2026-09-03)

Sprint 5 does **not** wait for this. The blocker was closed a different way:
the two MCP tools stopped taking a chat id, and `/internal/interview/agent/current`
resolves the interview from the single open, unexpired turn the router already
holds.

That is strictly safer than the chat-addressed form — there is no id for the
model to get wrong, and nothing it says is read — and it needs no per-interview
profile. Its one limitation is the reason this design still matters:
**two organizers interviewing simultaneously resolve ambiguously and are
refused** (409 `AMBIGUOUS`, mutation-checked). Refusing is recoverable and a
cross-organizer write is not, but it does not scale past one concurrent
interview.

Also shipped as interim: the profile rewritten for the router-driven flow, and
a rule that an answer exists only when a tool call returned success — which
converts the 09-03 failure from an invented completion into an honest error.

**So the interim buys correctness for one organizer at a time. This design is
what makes it correct for many.**

---

## Decision points — to address after Sprint 5

Ordered by what blocks what. None are settled; each changes the shape of the
build.

1. **Does the ephemeral interviewer replace the shared one, or coexist?**
   Coexistence means two code paths for the same interview and a way to choose;
   replacement means the interim `/current` path becomes dead weight once
   concurrency arrives. Recommendation: replace, keeping `/current` until the
   ephemeral path has run a real interview.

2. **What is the interview TTL, and what happens at expiry?** An organizer who
   goes quiet for a day and comes back is common. Options: destroy and require
   a new deep link; keep the intake and re-render a profile on their next
   message; or extend on activity. This decides whether "abandoned" is a
   terminal state or a resumable one, and the metric means different things
   under each.

3. **Who may promote a judge-proposed template change, and against what gate?**
   Super admin alone, or super admin plus a passing eval? What is the eval set —
   recorded past interviews, or synthetic? Without an answer the judging loop
   produces suggestions nobody is authorised to act on.

4. **How much transcript may the judge see, and for how long is it kept?**
   Interview transcripts contain traveler names, ages, and dietary and mobility
   constraints. `docs/trip-bot-analytics-and-metrics-design.md` §5/§10 already
   set an event-privacy and retention model; the judge is a new consumer that
   needs to fit inside it, or the retention policy needs revisiting deliberately
   rather than by accident.

5. **Does the judge run per interview, or batched?** Per interview gives the
   fastest signal on a bad question; batched is cheaper and better at spotting
   patterns, which is what a template change should be based on. Probably both,
   at different cadences — but the metric surface differs.

6. **Where does the profile-render step live?** The provisioner already renders
   the *companion* profile (`RenderProfileAdapter`, now on by default). Reusing
   it makes the interviewer another rendered profile; a separate path avoids
   coupling interview lifecycle to trip provisioning. Recommendation: reuse,
   since the adapter, its validation and its forbidden-key scan already exist.

7. **Is the un-namespaced session id worth fixing upstream anyway?** The
   ephemeral design routes around it rather than fixing it, and every other
   profile on the machine still shares the defect. If any long-lived profile
   remains — the companions do — this is still live for them.

---

## Key files this would touch

| Path | Why |
|---|---|
| `control-plane/worker/control_plane_worker/provisioner.py` | the orchestrator's home; already the lifecycle machine |
| `control-plane/worker/control_plane_worker/companion_profile.py` | `RenderProfileAdapter`, the render step to reuse |
| `profile-templates/trip-intake-interviewer/` | becomes a rendered template rather than a hand-maintained profile |
| `control-plane/api/src/interview.ts` | interview lifecycle states, abandonment, metrics source |
| `control-plane/db/migrations/` | lifecycle + judged-outcome tables |
| `docs/trip-bot-analytics-and-metrics-design.md` | §7/§8 gain the interview metrics above |
| `.agents/skills/trip-assistant-experience-evaluation/` | the scoring half of the judge |
