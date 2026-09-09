# Review — "The Companion is the product; the Agent Runtime is a replaceable engine"

**Written 2026-09-05**, the same day as the position paper it reviews, and the
same day as run 12 and the round after it. That timing is the point: the paper
predicts a class of failure, and the runs that afternoon produced two fresh
instances of it. This is a review, not a replacement — the paper stays the
authoritative statement of the position.

> The paper's own framing: "ה־runtime אינו 'המוח של Kinerary'. הוא מנוע
> execution. ההיכרות, הזיכרון, ה־trust model וה־trip intelligence הם נכסי
> Kinerary."

The paper is **not** a proposal to replace Hermes with LangGraph, and it is
worth saying that plainly because it is the first thing people assume from the
title. Section 7 keeps Hermes as the always-on conversational runtime, gives
LangGraph the durable multi-step workflows, and says outright that there is no
need to pick a single winner. Section 11 goes further: the first step is not
`Hermes → LangGraph` at all, it is extracting product assets out of the harness.

---

## 1. Where the paper is right, and why it matters more than the runtime choice

The strongest move in the paper is a sequencing argument, not an architectural
one. The runtime question is **downstream** of a bigger problem: identity,
memory and capabilities currently live inside the harness, which is what makes
the runtime choice load-bearing in the first place. Fix the ownership and the
runtime becomes an operational decision — which is exactly the paper's claim
in §10 ("Runtime portability").

That ordering de-risks the whole thing. The four contracts (`AgentContext`,
`MemoryContext`, `CapabilityContext`, `ExecutionContext`) are worth building
whether or not LangGraph ever ships, because they are what let you find out.
You do not have to be right about the destination to justify the first leg.

---

## 2. What 2026-09-05 adds as evidence

Two concrete instances, both from the runs that day, both landing on rows the
paper had already written.

### 2.1 The 404s were an `ExecutionContext` failure, precisely

Run 12, mid-document-upload. The sequence, read off the turn table and the
relay log rather than the chat:

| Time (UTC) | What happened |
|---|---|
| 16:00:03 | Turn `iat_8347…` opened for the uploaded document |
| 16:00:31 | Watchdog reclaimed the floor at 30s — `trip_bot.agent_floor_reclaimed` |
| 16:00:44 | Agent called `record_answers_for_chat` → **404 NOT_FOUND** |
| 16:01:06 | Agent called `say_for_chat` → **404 NOT_FOUND** |
| 16:04:44 | A later turn opened; the retry succeeded and the data landed |

Nothing was permanently lost, but the organizer was told, in-band, that "the
interview tools returned a 404 NOT_FOUND twice."

The mechanism is worth stating exactly: `/internal/interview/agent/current/*`
resolves "which interview am I in" by looking for an **open turn**. The
watchdog had closed it, because the watchdog's only way to ask "is the agent
still working?" is to guess from elapsed time. The agent was working fine. We
had no way to know.

That is `ExecutionContext` — execution identity and lifecycle — missing.
§3 of the paper already lists "session/context leakage… chat identity
ambiguity" from the Sprint 5 PR and concludes that "זיכרון וזהות אינם יכולים
להישאר סמנטיקה פנימית של harness". This is a sharper instance of the same
finding: **you cannot supervise a lifecycle you do not own, you can only
guess at it, and every guess is a threshold someone will eventually exceed.**

### 2.2 The silent capability downgrade happened, on camera

§13's risk row "Capability fallback — model selection fail-closed; never
silently route tool task to incapable model" was observed live. In one round
the agent rotated through four models inside a single conversation:

```
gpt-5.4              → HTTP 429, usage limit reached, credential pool exhausted
meta/muse-spark-1.2  → HTTP 403, requires 18+ age attestation
stealth/ox-alpha     → served, then
gpt-5.6-luna         → served the rest of the run
```

That round is also the one that recorded `travelers` as
`{count: 5, age_group: "adults"}` — five people, no names — and then asked the
organizer for "the name of the organizer" and about allergies with no roster to
attach either to. Dror's own report: the missing names "made some confusion
later on."

Two things follow. The routing half is the paper's (§8) and stands. The other
half is not in the paper at all — see §4 below.

---

## 3. Three places I would push back

### 3.1 The roadmap contradicts §12

§12 says two things that do not sit together:

- "לא לבצע rewrite בזמן שה־onboarding E2E עדיין מתייצב" — don't migrate mid-stabilization. Correct.
- "כן לבצע עכשיו את ה־seams" — do the boundaries now. Also correct.

But the Roadmap then puts Companion Contracts at **Phase 1, after** Phase 0
"stabilize onboarding". Those cannot both be true, and the evidence says the
second one wins: onboarding stability is asymptotic *because of* the seam.
Twelve runs, each closing real defects, and the residue is increasingly
made of seam failures — the 404s above, the duplicate asks, the floor
mechanics, the whole Track 4/5/6/8 apparatus.

"Contracts once onboarding is stable" is a condition that can fail to arrive.
Phase 1 should run **in parallel** with Phase 0, which is what §12 actually
implies; the linear roadmap under-sells the paper's own argument.

### 3.2 Phase 2's memory model is where scope explodes

§5's taxonomy is the best part of the paper conceptually — six memory types,
each with its own authority, retention, confidence and visibility, plus the
scope model where a private mobility limit can shape a route without being
disclosed to the group. That is genuinely the moat.

It is also a research project. Learned preferences with confidence, evidence,
decay and revalidation is not a sprint; it is a subsystem with a correctness
problem nobody has solved cheaply. The paper hedges correctly ("להתחיל רק
במה שה־MVP באמת צורך") but the roadmap placement does not reflect the hedge.

What the MVP actually consumes today is two of the six: **canonical facts**
and **explicit preferences**. Both are already in `intake_versions` in
everything but name. Situation state is real but ephemeral and small.
Learned-preference inference belongs with Phase 8's cross-trip work, where
the same risk row ("False learning") already lives.

### 3.3 A fifth contract is missing

The four proposed contracts all govern **what the agent is allowed to do** —
who it is, what it may read, what it may call, what execution it belongs to.
None of them govern **whether what it produced is any good.**

Every failure on 2026-09-05 that was not a seam failure was that: a capable
model, under duress, writing something structurally valid and substantively
empty, and the system accepting it because it type-checked.

- `travelers` = `{count: 5, age_group: "adults"}` satisfied `dataShape: "array"` and established nobody.
- The same round asked for the organizer's name and dietary scope against an empty roster.

No amount of identity, memory, capability or execution contract catches that.
Routing to a better model does not catch it either — the model was capable, it
was rushed. The only thing that catches it is the product asserting what an
answer has to establish, at the boundary, and refusing what does not.

That principle shipped the same day as a working reference implementation:
`IntakeQuestion.checkComplete` (commit `6205b2d`). Schema validity and
substantive completeness are different questions; a failure returns
`INCOMPLETE_ANSWER` plus a detail string the agent can act on, writes nothing,
and leaves the question outstanding rather than answered badly.

**Proposed:** a fifth contract alongside the other four — call it
`ValidationContract`, or fold it into `CapabilityContext` — stating that every
agent write is checked against what the product requires, not merely against a
schema, and that a rejection is actionable rather than fatal. It is the same
"fail-closed" instinct as §8's model routing, applied to output instead of
capability.

---

## 4. What this means for the sprint in flight

The paper's Phase 0 and §12 argue **against** abandoning the current approach.
They argue for keeping a working baseline, because Phase 4's LangGraph pilot is
specified as "test/shadow לפני cutover" — and a shadow test needs something to
shadow. You cannot tell whether the graph version is better without knowing, in
detail, what the current one actually does.

So "stop perfecting the current approach" needs scoping, and the right scope is
narrow:

| Stop | Keep |
|---|---|
| Adding to the floor / turn / settle / watchdog machinery (Track 6's remaining work, Track 7) — this is precisely what a graph migration deletes | Characterizing the current baseline honestly: one more live run, recorded the way the others were |
| Adding new Hermes-specific identity or memory semantics anywhere | The question schema, `intake-copy`, the recap, the phase machine, the transcript harness — all runtime-agnostic, all carry over |

As of `6205b2d` the baseline is committed and green (637 tests, 631 pass,
6 skipped, 0 fail). Track 8 — deterministic router-owned question progression —
is worth noting here because it is a small, hand-built instance of the thing
LangGraph does natively: some nodes do not call a model. Building it by hand is
evidence for the paper's thesis, not against it.

---

## 5. Recommended next moves

1. **Start `ExecutionContext` now**, in parallel with the remaining onboarding
   work rather than after it. It is the contract today's 404s were about, and
   the one whose absence is currently costing live runs.
2. **Scope Phase 2 down** to canonical facts + explicit preferences for the
   MVP. Move learned-preference inference to sit with Phase 8, where its risk
   row already lives.
3. **Add the validation contract** to the Phase 1 set, with `checkComplete` as
   the reference implementation.
4. **One more characterizing live run** before any pilot work — not to fix
   more, but to record what the baseline does, so a shadow comparison later has
   a real "before".
5. **Give the Phase 4 pilot a deployment acceptance test, not just a functional
   one.** The interview path is already four services, and two live rounds were
   lost this week to service-state mismatch (which is why
   `.agents/skills/interview-stack-deploy/` exists). If a graph runtime is
   added and the floor/turn/settle machinery does *not* go away, net complexity
   went up and the migration is not paying for itself. Service count should
   fall, not rise.

---

## 6. Bottom line

The paper is a valid way forward, and its most valuable claim is the one that
is easiest to skip past: the runtime is the last decision, not the first. The
sequencing it proposes — own identity, memory and capabilities first; choose
engines per workload after — is right, is testable, and is worth starting
before onboarding is finished rather than after.

The one thing I would add is that the harness is not the only thing the product
has been trusting too much. It has also been trusting the model's output. Both
need a contract.

---

### Sources

The position paper (2026-09-05), plus the repo documents it cites:
`docs/FamilyTrip-Agent-Handoff.md`, `docs/kinerary-trip-platform-handoff.md`,
`docs/k3s-home-deployment-architecture.html`,
`docs/k3s-home-deployment-sprint-plan.md`,
`docs/onboarding-mvp-sprint-plan.md`, and the Sprint 5 interview/relay work.

Evidence cited from 2026-09-05 lives in `docs/signup-test-run9..11-raw-notes.md`,
the run-12 turn table and relay log readings recorded in this session, and
commit `6205b2d`.
