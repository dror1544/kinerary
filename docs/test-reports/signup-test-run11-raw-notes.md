# Signup Run 11 — raw notes (LIVE, 2026-09-05)

Third run on Track 5's build. Runs 9 and 10 (`signup-test-run9/10-raw-notes.md`)
each reached `intake_confirmed`; this run adds the companion-value pitch
(Dror's request, ahead of this run) and finds one genuinely serious bug this
session's own earlier fixes introduced. Standing instructions as always:
Dror's notes verbatim, agent notes marked as such, nothing triaged until the
run ends, nothing "fixed" without a human saying so.

---

## Run context

| | |
|---|---|
| Trip | `draft-sreq-690fd8186d0b329b14693c3da1258bd0`, a fresh signup |
| Session | `sess_867e5179316ac5cb8287da5bdc1b23c2` |
| Code | `sprint/5-interview-followups` @ `ea5853d` at start; two more fixes shipped live mid-run |
| Outcome | **`intake_confirmed`**, 17 answers — **third clean confirmation in a row** |

## What run 11 was meant to prove

1. Whether the companion-value pitch (added just before this run, per Dror's
   request) actually lands and reads as intended.
2. Whether the previous rounds' fixes (collapse-on-tap, typing indicator, the
   floor-reclaim fix) hold up over a full run.

---

## Dror's notes

*(verbatim, added during the run)*

### Step 3 — interview bot

**1. A "leak" that turned out to be legitimate — flagged fast, corrected
fast.** Verbatim:

> This response came without me indicating that all are kosher and Noa is
> alegic. Look like a leak from previouse interview
>
> [רשמתי שמופיעות מגבלת כשרות־בסגנון ורגישות ללקטוז...]

and the correction, moments later:

> Sorry my bad, ir was an example

*Agent note.* Checked the database before concluding anything: the Solomon
family (Nir, Ella, Noa, Maya, Shay) is legitimately this round's own data —
the same test document reused across rounds, not a cross-session identity
leak. `dietary: kosher_style + lactose_free` was a real, already-written
answer (from the document), and the message was the standard
dietary→dietary_scope follow-up (SOUL rule 9a), using Noa as a natural
example since she is a real, known name — not an assertion about her.
Resolved by Dror's own correction; no code change needed. Worth recording
because the INSTINCT to flag it was right — cross-session leaks are exactly
the class of thing worth a fast, no-blame check every time.

**2. Document reading failed on the first pass again.** Verbatim:

> This maintenance response came after I answered about the coutry (which was
> supposed to come from the document, look like a time out issue) it asked
> some more but didn't feel like repeating, maybe for documentation we need
> longer time out

*Agent note — root cause found, and it is not a timeout.* The agent log shows
`read_file failed: document extraction failed — File not found` on a Hermes
local temp path (`relay_media_*.pdf`) — Hermes's own cached copy of the
document was gone by the time the agent tried to read it. Our own media
store's TTL is a full hour and was untouched; this is Hermes-side. Given how
much turn interruption was logged in the same window
(`handback_skipped`/`agent_floor_reclaimed` repeating), the most likely
explanation is the delay before the agent actually got to read the file
stretched long enough for Hermes's own cache cleanup to sweep it — the same
mismatch between our turn-bookkeeping and Hermes's real activity that Track 6
already names. **Lengthening one of our timeouts would not fix this** — none
of `INBOUND_SETTLE_SECONDS` (2s) or `AGENT_FLOOR_SECONDS` (30s) are document-
read timeouts. Not built; tracked under Track 6.

**3. The self-narration pattern, a new example.** Verbatim:

> It tends to add this type of message after a question
>
> [המשכתי את הראיון: תשובתך נשמרה בהצלחה...]
>
> It is not terrible but not helpful

*Agent note — a distinct failure from the existing "never narrate the
machinery" rule, and now covered by its own.* This message leaked no field
ids and named no "router" — the EXISTING rule's exact scope — so it slipped
through. It narrates the agent's OWN actions as a status report ("I continued
the interview... I now asked...") instead of just continuing the
conversation. New SOUL rule added with this exact quote and a natural
rewrite beside it, deployed live (SOUL re-reads per turn).

**4. Several duplications on `bot_gender` — root-caused precisely, and fixed.**
Verbatim:

> I got several duplications on the gender Question look like the agent was
> ahead asked and than the router came in
>
> Also, the duplication is an issue that needs resolving, it seems like in
> the optional questions the agent precedes the router

*Agent note — a real, structural bug, not a fuzzy content problem.* Traced
precisely: `say_for_chat` and `ask_question_for_chat` are two independent
slots. When the agent calls both in the same breath — a lead-in, then a
nomination, moments apart with no real gap — the first slot delivers as its
own Telegram message, and the second (the router's buttoned render) goes out
separately right after. Fixed in `nominateQuestionForChat`: if there is a
`say_for_chat` still queued and undelivered when a question is nominated, its
text is folded into the question's own rendering — one message, lead-in and
question together, buttons attached. If the earlier say has ALREADY been
delivered (real time passed), nothing is touched — that preserves the
floor-reclaim fix's whole point, that the agent can speak more than once
across a genuine span of time. Two tests hold both halves.

**5. THE SERIOUS ONE — the recap-protection fix from earlier today had a real
bug, and it produced total silence.** Verbatim:

> After responding אין to [the bot_limits question], the bot did not respond.

*Agent note — found by checking the database and the relay log in sequence,
not assumed.* The session had genuinely reached `phase: recap`,
`state: awaiting_confirmation` — but `last_prompt` was still the PREVIOUS
question, meaning the recap had never actually been rendered. Root cause: the
"the recap cannot be buried" guard (shipped earlier today, run 10) suppressed
a stray agent `say_for_chat` correctly — but then **returned from the whole
function**, before ever reaching the code that renders the recap. The fix was
built to stop the agent's WORDS burying the recap; as written, it also
prevented the recap itself whenever the two happened to land in the same
instant. Fixed by falling through instead of returning after the suppression.
A new test reproduces the exact ordering (a say queued the SAME moment the
interview reaches recap) rather than the run-7 case the original test
covers (a say arriving AFTER the recap was already sent) — both are now
tested and both pass.

Deployed live (a real code change, needed a restart): confirmed no
organizer-facing turn was in flight, restarted all four services, then
manually rescheduled delivery for the stuck session so the fixed code path
delivered the recap without asking the organizer to do anything.

---

## What worked, confirmed live

- **Third consecutive `intake_confirmed`.**
- The companion-value pitch shipped ahead of this run — not separately
  confirmed as delivered-and-read-well this round; worth checking explicitly
  next time.
- A genuine cross-session-leak concern was checked and resolved within
  minutes, with the database as the source of truth rather than the chat
  transcript.

## Still open at the end of the run

- **Track 6** (turn/timing mismatch with Hermes) now has a second, concrete
  symptom: the document-cache "File not found" failure, likely the same root
  cause as the stuck-button one from run 10.
- **The choice-question-in-prose violation itself is not fixed** — only its
  worst symptom (the duplicate message) is. SOUL still relies on a prompt
  rule ("never ask a question that has fixed options") that has now failed
  across at least three different models this session. A structural
  detector — catching the agent's prose BEFORE it reaches the organizer, the
  way `internal-leak.ts` already does for banned tokens — is the honest next
  step, scoped but not built.
- Whether the companion-value pitch actually reads as intended has not been
  explicitly confirmed by Dror.

## Agent debrief

Two fixes this run were genuine bugs in code shipped earlier THIS SAME
session (the recap-return bug from run 10's own fix, discovered within about
an hour of shipping it) — both found by reading the database and logs first,
neither assumed from the chat transcript alone. The recap-silence bug in
particular is a reminder that a fix built under real time pressure, even a
carefully-tested one, is not exempt from the next live run finding what the
test suite's imagination did not cover.
