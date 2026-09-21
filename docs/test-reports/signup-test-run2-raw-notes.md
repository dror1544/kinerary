# Signup Run 2 — raw notes (LIVE, 2026-09-04)

**This file is open.** Unlike `signup-test-run1-raw-notes.md`, which is an
archive, issues are being written here *as the run happens*. Dror's notes are
verbatim and are the primary record; anything I add is marked as an agent
note so the two never blur.

Nothing here is triaged yet. At the end of the run every item moves into the
Status ledger in `signup-test-execution-capture (Manual).md` and gets a home
in `docs/onboarding-mvp-sprint-plan.md`. Per the standing instruction, an item
is only **fixed / rejected / ignored** once a human approves it — recorded
here when that happens, not assumed.

---

## Run context

| | |
|---|---|
| Date | 2026-09-04, started ~10:35 IDT |
| Trip | `draft-sreq-57b50d20272a524b9260e4b5cafed4d5` (`trip_66bd9f7d5305034a434482356d429652`) |
| Signup request | `sreq_57b50d20272a524b9260e4b5cafed4d5`, approved 09:33 UTC by Telegram tap |
| Organizer account | `dror.elul+s5test2@gmail.com` — a **new** user, because signup allows one approved request per user and the run-1 user is bound to the confirmed 09-03 trip |
| Enrollment | `enrl_d775d2e0340b52b067ba1326d95362d0`, single-use, expires 2026-09-05 09:34 UTC |
| Entry | one-tap deep link `https://t.me/Kinerary_bot?start=…` — no token pasted |
| Code | `sprint/5-interview-followups` @ `12604a0`, `control-plane/api` rebuilt 10:57 |
| Services | API :4310 · interview sidecar :4311 · relay/router :4312 — all restarted onto that build |
| Interviewer | `trip-intake` Hermes profile, `SOUL.md` and the `trip-creation-interview` skill verified byte-identical to the repo |

Run-2 prep also wiped the interviewer's copy of the 09-03 conversation for
chat 391627336 (86 messages). Leaving it is how a "fresh" interview resumes a
conversation whose own replies say the interview is already finished.

### What run 2 is meant to prove

Landed since run 1, never exercised live:

- **Language is pinned** (`993dd4c`). Chosen once, defaults to English, and
  names / place names / document contents are explicitly not a language
  signal. Run 1 opened in English and switched to Hebrew unprompted.
- **No "(Recommended)" on any answer** (`993dd4c`). **DISPROVEN on this run —
  see Step 3 #6.** The label is appended by Hermes's own `clarify` tool, not
  written by the model, so the SOUL rule that commit added cannot suppress it.
  Run-1 items Step 2 #3b and Step 3 #2 remain open.
- **`planning_help`** (`0c1cb05`) — an optional late question recording what
  the organizer still needs help with, projected into
  `agent.standing_instructions[]` for the trip companion. It must record the
  ask, not become a planning session.

Still unreproduced from run 1, worth pushing on:

- **Step 3 #7** — the dietary step threw an error.
- **Step 3 #9** — planned-order / schedule failed to submit.

Known-degraded and deliberately not chased mid-run: the relay logged
`telegram_api.call_threw` on `getMe` at startup, so it has no bot identity
(`relay.bot_identity_unavailable`). That degrades **group** @mention gating
only; the 1:1 interview path does not use it. Agent note, 2026-09-04.

---

## Dror's notes

*(verbatim, added during the run)*

### General comments

### Step 1 — onboarding / signup

### Step 2 — DM approval message

### Step 3 — interview bot

**1. Hermes housekeeping notice still reaches the organizer.** Verbatim:

> still getting this message: "No home channel is set for Telegram. A home
> channel is where Hermes delivers cron job results and cross-platform
> messages. Type /sethome to make this chat your home channel, or ignore to
> skip."

Recurrence of Run-1 General #1, and of the 2026-09-03 incident that the
`trip-intake` config comment claims to have closed.

*Agent note — root cause found, 2026-09-04.* The notice fires at
`gateway/run.py:20279` when a conversation has **no history**, i.e. on the
first message of every fresh conversation — so every new organizer sees it as
one of the first things the bot says. It is skipped when the profile has a
home channel for the platform. `trip-intake/config.yaml` **does** carry one
(added 09-03), but under a **top-level `telegram:` key**, and
`GatewayConfig.from_dict` (`gateway/config.py:1168-1176`) only reads platform
config out of the `platforms:` mapping. Verified rather than assumed:
`load_gateway_config()` under `HERMES_HOME=~/.hermes/profiles/trip-intake`
returns `get_home_channel(TELEGRAM) = None`. `/sethome` itself persists to
`platforms.telegram.home_channel` (`persist_home_channel`, `config.py:519`),
which is the shape the loader reads. Fix is to move that block; it needs a
gateway restart to take effect, so it is **deferred to the end of the run**
rather than applied mid-interview — and the gateway rewrites its own
`config.yaml`, so editing it under a live process risks losing the edit.

**2. Agent narration (chain of thought) delivered to the organizer.**
Verbatim:

> After I said japan there was a longer pause and got chain of thought message
> "The next question is destination — and the organizer just answered
> 'Japan.' Let me record that now." this need to be hidden (maybe if the home
> will be set properly). check if those messages are marked differently or if
> you set the home channel it do something else

*Agent note — checked both, answer is no to each.* Setting the home channel
does not affect this: the `/sethome` notice is **gateway-generated**
housekeeping delivered through `_deliver_platform_notice`, whereas this is the
**model's own assistant text**, emitted before a tool call and delivered as an
ordinary message. They share nothing but the destination chat. Nor is it
marked in any way we can filter on: the relay contract's `send` op carries an
optional `metadata` bag (`relay/protocol.ts` `SendAction`), but nothing on our
side reads it — `connector.ts`, `dispatch.ts` and `telegram-api.ts` never
reference `metadata` — and Hermes is not stamping a kind on it. So today there
is no marker to key a filter off. Two ways out: **(a)** a SOUL rule that the
interviewer never narrates its own next step — one line, immediate, but a
prompt-level mitigation of a plumbing problem; **(b)** suppress pre-tool-call
assistant text at the gateway/relay boundary, which is the real fix and needs
Hermes to mark the message first. Not done during the run.

**3. Language: the agent followed the switch, the router did not.** Verbatim:

> After I switced to hebrew it did too, but after it changed back to english
> after asked a similar unanswered question in hebrew
> "רשמתי — משפחת סולומון, 5 נוסעים.
>
> עכשיו התחנות — לאן אתם הולכים ביפן? אם יש כמה ערים, ספר לי את הסדר ואת
> התאריכים בערך (לא חייב לדייק).
> Where are you going, and when? List each stop: a short place name (city or
> region — e.g. "Dallas", not "Dallas (boys; Mavericks game September 6)"),
> date range, and accommodation (with confirmation number) if already booked.
> Keep any extra context — who's on this leg, an event, a plan detail — out of
> the name; it's fine to just not record it structurally."

*Agent note.* That is **two speakers in one screen**. The Hebrew half is the
interviewer agent, correctly holding Hebrew after an explicit switch — the
language pin (`993dd4c`) behaved. The English half is the **deterministic
router** sending `INTAKE_QUESTIONS.phases.prompt` verbatim
(`control-plane/api/src/interview.ts:149`, logged as
`trip_bot.router_prompt_sent`), which is English-only regardless of the
interview's language. So this is not the run-1 language defect returning; it is
its mirror image, and the same class as Run-1 General #3 (button labels always
Hebrew) — **router-side text is never localised, in either direction**.

Second, worse defect in the same string: that prompt is written as **guidance
for the agent**, not copy for a human. "Keep any extra context … out of the
name; it's fine to just not record it structurally", and the Dallas
counter-example, are instructions about how to fill a schema field. No
organizer should ever read them. `INTAKE_QUESTIONS[].prompt` is currently
doing two incompatible jobs — field spec for the agent, and the sentence the
router says out loud — and they need splitting into two fields.


**4. Document upload never reaches the interviewer — the agent is handed an
empty message.** Verbatim:

> it upload of a PDF (and I assume also a photo) does not work it does not
> recieve anything "לא קיבלתי כלום — הודעה ריקה הגיעה. 😊
> לאן אתם מתכננים ללכת ביפן? אם יש לך מסמך תכנון, כרטיסים, או אישורי מלון,
> אפשר לשתף אותם כאן ואני אחלץ את הפרטים במקומך."

*Agent note — root cause found, and it is ours.* The Sprint 5 media ingress
fix (`12ad8d9`) re-hosts attachments so they reach the agent, but it is wired
into **one** of the two routes. `normalizeUpdate` (`relay/normalize.ts:260`)
builds the companion route's event with `toWireEventWithMedia(...)`, passing
the attachment and `MediaDeps`. A chat mid-interview never reaches that line —
it is returned as `{ dropped, reason: "INTERVIEW" }` and rebuilt in
`relay/dispatch.ts:256`, which calls the plain `toWireEvent(...)`: no
attachment, no media deps, `message_type: "text"`. So for the interview route
a caption-less PDF becomes `text: ""` and the agent is handed a genuinely
empty message — which is exactly what it reported, in the right language, with
no way to know a file was ever sent.

Confirmed against the logs rather than inferred: `relay.log` has **zero**
media events for the whole run, and the PDF still produced a
`trip_bot.interview_forwarded` — the turn was opened and forwarded, just with
nothing in it. Photos, voice and video take the same path, so the report's
guess about photos is right.

The fix is small and the plumbing is already there: `dispatch.ts`'s
`DecideOptions` already carries `media?: MediaDeps` (line 158) and the poller
already passes it (`poller.ts:489`). The INTERVIEW branch needs to call
`toWireEventWithMedia` with `describeAttachment(message)` — which
`normalize.ts` currently keeps module-private and would have to export — and
`options.media`. Requires a relay restart, and should carry a test alongside
`relay-media.test.ts`, which covers the companion route only. **This is the
one blocking item so far:** step 3 of the interview asks the organizer for a
document before making them type dates, and Sprint 4.5's whole
document → per-phase itinerary feature is unreachable while it holds.

**5. The router ends the interview the moment the required questions are done
— talking over the agent mid-question, in the wrong language, with an
unverifiable recap.** Verbatim:

> After I geave it a trip plan (manually) it ask about the trip tempo in
> hebrew, but before I could answer, it jumped to the concluding message
> (again in english), not so helpful to user and ask me to confirm/keep
> planning "Here's what I have: … • Who's coming? … 5 item(s) recorded •
> Where are you going, and when? … 5 item(s) recorded — Confirm to lock this
> in, or keep planning to change something."

*Agent note.* Four defects stacked in one message, all traceable:

1. **The interview is declared over too early.** `deriveSessionState`
   (`interview.ts:524-528`) is `allRequired.every(answered) ?
   "awaiting_confirmation" : "interviewing"` — `optionalRemaining` is not
   consulted at all. Recording `phases` was the last required answer, so the
   session flipped to awaiting_confirmation and the router sent the confirm
   prompt. But `SOUL.md` step 5 tells the agent the opposite: optional
   questions arrive in `optionalRemaining` and are worked through *after* the
   required ones. **The router and the agent disagree about when the interview
   ends**, and the router wins because it holds the keyboard. Everything
   optional — pace, dietary, timezone, bookings, the assistant's name and
   tone, and this morning's new `planning_help` — is behind that wall.
2. **It talks over the agent.** `renderDueRouterPrompts` fires for every
   interview the agent has just written to (`poller.ts:349-373`), with no
   notion of the agent still having something to say in the same turn. The
   agent asked about pace in Hebrew; the router shipped the recap on top of it.
3. **English again, and the same prompt leak as Step 3 #3.** The recap is
   built from `entry.prompt` (`poller.ts:385-392`), i.e. the raw
   agent-facing question text — so the confirmation screen repeats the Dallas
   example and "keep any extra context … out of the name" back at the
   organizer, in English, inside a Hebrew interview.
4. **The recap cannot be verified, which is the point of a recap.** Structured
   answers render as `"5 item(s) recorded"` (`interview.ts:483`). The two
   questions that most need checking — who is coming, and where you are going
   — are exactly the two that show a count instead of the content. A
   confirmation step that hides what it is confirming is worse than no
   confirmation step.

**Second occurrence, same run** (after tapping Keep planning), verbatim:

> it asked in hebrew how to call the bot and again before I answered back to
> the conclusion message

*Agent note — it is a loop, not a one-off, and the workaround does not hold.*
`submitAnswerForChat` sets `router_prompt_due_at = now()` on every successful
agent write (`interview.ts:1097-1101`) — deliberately, so the interview never
loses its buttons. `renderDueRouterPrompts` then calls `sendNextStep`, which
sends the **full confirm recap** whenever `view.state === "awaiting_confirmation"`
(`poller.ts:376-392`). And that state is *derived*, not a transition: once the
required questions are answered it is permanently awaiting_confirmation.

So every optional answer the agent records re-fires the entire English recap on
top of the next question. Pace, then the assistant's name — the same collision
twice, and it will repeat for every remaining optional question. **Keep
planning does not break the loop**: it only sends "Sure — tell me what you'd
like to change and we'll go from there" and deliberately does not walk into the
optional questions (`poller.ts:315-325`), leaving the state untouched.

The router needs a state that means "required questions done, still collecting
optional ones", and the recap should be sent when the organizer asks to
finish — not after every write.

**6. "(Recommended)" is back, still no buttons, options in English inside a
Hebrew question — and the 993dd4c fix could never have worked.** Verbatim:

> I pressed kepp planning and it asked about deitery restrictions (again no
> multiple answers botton and still mix of hebrew and english "סדר! כמה שאלות
> קצרות: 1. אוכל — האם יש הגבלות אכילה אצל מישהו בקבוצה? ❓ האם יש הגבלות
> אכילה אצל מישהו? (בחר הכל שרלוונטי) 1. None of these (Recommended) 2.
> Kosher-style — no pork or shellfish 3. Vegetarian 4. Vegan — Multiple
> selections allowed — reply with the numbers separated by commas or spaces
> (e.g. "1, 3"), the option text, or your own answer." also unclear what does
> it mean "בחר שהכל רלוונטי"

*Agent note — this corrects a conclusion in `993dd4c`.* That commit removed
"(Recommended)" by adding a SOUL rule, on the reasoning that "the wording
appears nowhere in this repo: the model was inventing it." **It was not.** It
comes from Hermes, deterministically:
`~/.hermes/hermes-agent/tools/clarify_tool.py:40` defines
`RECOMMENDED_LABEL = "(Recommended)"` and appends it to the **first** option of
every `clarify` call — the tool's own docstring (lines 444, 488-490) tells the
model "the UI labels it '(Recommended)' and pre-selects it… Do not write
'(Recommended)' yourself." So no prompt rule can suppress it, and this run is
the proof: the SOUL rule is deployed and the label appeared anyway, on
"None of these", which is the worst possible option to nudge a group toward.

The same call explains the missing buttons, and they have one root cause.
Hermes renders `clarify` as native buttons only when the platform adapter
overrides `send_clarify`; otherwise `gateway/platforms/base.py:4317-4326`
falls back to a numbered text list with "reply with the numbers separated by
commas". Under relay-exclusive routing the adapter *is* our relay connector,
and the contract has no way to express a keyboard: `CapabilityDescriptor`
(`relay/protocol.ts:34-51`) advertises edit / threads / draft-streaming /
block-formatting but nothing interactive, and the outbound `send` op carries
`content` only — no `reply_markup`. So every question the **agent** asks
degrades to numbered text, while every question the **router** asks gets real
buttons (`renderQuestion` → `InlineKeyboard`). Run-1 Step 3 #1 is therefore
not a formatting slip; it is structural.

`SOUL.md` steps 4 and 12 still instruct the agent to present choice and
multi-choice questions "as tappable `clarify` buttons". Under this topology
that instruction is actively wrong — it is what produces both the numbered
list and the "(Recommended)". The mechanism to do it properly already exists
(`ddc8e6a`, "hand the turn back to the router so questions keep their
buttons"); the SOUL has not caught up with it. **Recommended fix: the agent
never asks an option question itself — it hands the turn back and the router
draws it.** Extending the relay contract to carry buttons is the alternative,
and it duplicates what the router already does well.

**Confirmed again later in the same run**, verbatim: "on the name of the bot
still has the recomneded on the first choise". So it is not specific to the
dietary question — it fires on every clarify with two or more choices, which is
every option question the agent asks.

*Agent note — there is no toggle.* `_decorate_choices`
(`clarify_tool.py:90-95`) appends the label to `choices[0]` unconditionally
whenever `len(choices) >= 2`, and `strip_recommended` removes it again from the
answer so the model never sees it — which is exactly why the agent cannot
notice or prevent what the organizer is being shown. There is no config flag,
env var or per-call argument to disable it. The only two real options are to
stop calling `clarify` for these questions (hand them to the router, which
draws proper buttons and adds no label) or to patch Hermes. The first is
already the intended design.

Two smaller things in the same message: the option labels are English
(`INTAKE_QUESTIONS[].options[].label`) inside a Hebrew question — the same
non-localised router text as Step 3 #3 and #5 — and the agent's Hebrew for
"select all that apply", "בחר הכל שרלוונטי", is a literal translation that
does not read as natural Hebrew and confused the organizer. Localisation needs
real strings, not per-turn improvisation by the model.

**7. The agent cannot confirm the intake at all, and told the organizer it
would hand off to a human instead.** Verbatim:

> that that it really finish the trip it ask to comfirm by the bot with out
> buttons. I selrcted 1 and it failed since the bot "confirm_intake דורש
> sessionToken שאינו זמין בזרימה הנוכחית. אכתוב הודעה לדרור להשלמה ידנית."

*Agent note — structural, and the last piece of the same hole as #6.* The
interview MCP exposes exactly two chat-scoped tools —
`get_interview_for_chat` and `submit_answer_for_chat`
(`interview-mcp.ts:283,294`). There is **no `confirm_intake_for_chat`**.
`confirm_intake` (`interview-mcp.ts:264-272`) requires `sessionId` +
`sessionToken`, which SOUL itself tells the agent it does not hold under
router routing. So the agent physically cannot confirm; only the router's
Confirm button can (`confirmIntakeForChat`, `poller.ts:290-311`, which needs
no token because it acts server-side from a verified chat binding).

Yet `SOUL.md` step 13 still says "After confirmation only, call
`confirm_intake`" — the same stale-instruction class as the `clarify` steps in
#6. The agent followed its instructions into a wall, then invented a recovery
("I'll write to Dror for manual completion") that no tool performs.

**Run outcome, read from the database rather than the conversation:** the
interview is **not** confirmed. `sess_511d665104855ed5dd29d69e7d2f094f` is
still `awaiting_confirmation`, no `intake_versions` row exists for
`trip_66bd9f7d5305034a434482356d429652`, and the trip is still
`intake_in_progress`. 14 answers are recorded. It reads as finished in the
chat and is unfinished in the record — exactly the failure mode the SOUL's
"never claim an answer was recorded unless a tool said so" section exists to
prevent, arriving this time through a stale instruction rather than a
hallucination.

`planning_help` is **not** among the 14 recorded answers: this morning's new
question was never asked, so `0c1cb05` remains unexercised.

### Step 4–5 — plan + provisioning

### Step 6–7 — family access + correction

---

## Agent debrief

*(written at the end of the run, per the standing instruction — issues I
noticed driving it, kept separate from Dror's)*

**Dror's verdict on run 2, verbatim:**

> The feeling that we have regressed, it seems like nothing really fixed and
> what woked stopped

> I finished the intrview, UX was terrible worse than last time. we need to try
> again until we nail it

**My assessment of that, stated plainly.** The run was worse to sit through
than run 1, and the record backs that: run 1 reached a confirmed intake
version; run 2 did not reach one at all.

On "nothing really fixed" — the three things shipped this morning were all
prompt-level, and two of them could not have worked:

- The language pin **did** hold; the Hebrew/English mixing organizers saw came
  from router-side text that no prompt governs (#3, #5, #6).
- The "(Recommended)" rule **cannot** work: Hermes appends the label itself
  (#6). `993dd4c` diagnosed it from inside the conversation, where the label is
  invisible to the model, and reached the wrong conclusion.
- `planning_help` was **never asked** — it sits behind the confirmation wall
  (#5), so `0c1cb05` is still unexercised.

On "what worked stopped" — nothing that ran in run 1 was broken by today's
commits. What actually happened is that run 2 walked further into paths run 1
never entered: optional questions after the required set (#5), an uploaded
document on the interview route (#4), and confirmation attempted by the agent
rather than by the button (#7). Each of those was already broken; run 1 simply
did not reach them. That is not reassuring — it means the interview only ever
worked along one narrow tap-through path, and every step off it hits a hole.

The pattern across #4, #6 and #7 is one root cause worth naming: **the agent
was given a topology it has stale instructions for.** Media, buttons and
confirmation are all router-owned now, and `SOUL.md` still tells the agent to
handle them itself — so it reaches for tools that do not exist or degrade, and
the organizer sees the wreckage. Fixing the SOUL is necessary but not
sufficient; the interview route also has to actually carry media (#4) and hold
a state between "required done" and "confirmed" (#5).

**Bot identity is resolved once at startup and never retried.** On this run's
relay start, `getMe` threw during a burst of Telegram `502`/`504` responses
(both visible in `relay.log`), so the relay came up with
`relay.bot_identity_unavailable` and group @mention gating fell back to trip
names for the whole session. An earlier start the same morning resolved it
fine (`relay.bot_identity username=Kinerary_bot bot_id=8463178587`), so this is
transient-network-shaped, not a config problem. A one-shot lookup that
degrades a capability permanently on a blip should retry with backoff, or
re-resolve lazily on first use. It does not touch the 1:1 interview path, which
is why the run continued.

---

## Evidence

Read the database rather than the bot's account of itself — the interviewer
has claimed to record answers it never wrote:

```bash
docker exec kinerary-control-plane-local-postgres-1 psql -U kinerary_control_plane \
  -d kinerary_control_plane -c "SELECT id, telegram_chat_id, state, answers FROM control_plane.intake_sessions;"
docker exec kinerary-control-plane-local-postgres-1 psql -U kinerary_control_plane \
  -d kinerary_control_plane -c "SELECT chat_id, session_id, opened_at, closed_at FROM control_plane.interview_agent_turns ORDER BY opened_at DESC LIMIT 5;"
tail -30 ~/kinerary-deploy/logs/relay.log
```

An **open turn that never closed** means the agent took the turn and failed
silently — the signature of the 2026-09-03 failure, and invisible from the
conversation itself.
