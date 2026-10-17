# How the companion takes part in a family group

Owner's decisions of 2026-10-16 (Dror), recorded the day they were made. This is
the home for *why* the companion reacts to a group message the way it does.
The mechanism lives in code (`control-plane/api/src/relay/addressing.ts`,
`chat-router.ts`, `relay/dispatch.ts`, `relay/stay-silent.ts`); the code's own
headers say how, this document says what was decided and what was rejected.

**Status at a glance**

| Piece | State |
|---|---|
| Conversation window, mark and stay-silent | **Built and merged**: PR #406 (`ddb575c`) on the sprint branch. Not on `main`, not deployed. |
| Judge ("is this for the assistant?") | **Pending, unmerged**: PR #407 is a draft being reworked. Nothing in section 3 is shipped. |
| `/proactive 1\|2\|3` | **Pending, unmerged**: not in this tree; belongs to the #407 line of work. |
| Judge KPIs and benchmark harness | **Pending**: agreed targets only; `tools/judge-benchmark.ts` is not in this tree. |

## Why this was decided

On 2026-10-16, on the staging trip `colmar-2026`, 6 of 9 untagged follow-ups in
one conversation were dropped as `NOT_ADDRESSED` and had to be re-sent with the
assistant's name. Before this, a group message reached the companion only if it
named the assistant, @mentioned the bot, replied to the bot, or was the one
message after a companion send whose text ended in "?" (the one-shot window,
PR #64, migration 0053). That last route opens only when the Hermes half of #122
stamps `expects_reply`, and that half was never built, so the "?" test on the
text of the companion's own send was the only thing opening it. The result was a
conversation that broke whenever the companion's last message was not a question.

## 1. The conversation window (built, PR #406)

**Decision.** Once the companion is in a conversation with a member of a group,
that member's own follow-ups reach it without its name.

- **Length.** The window stays open until 5 minutes after the companion's last
  delivered send. Each exchange renews it.
- **Many may join.** Anyone whose message was forwarded to the companion, by any
  route (name, @mention, reply, the "?" window, or this window), joins the chat's
  conversation. Nobody is displaced, and all members share one deadline. When the
  deadline passes the whole set is cleared. The set is capped at 20 members.
- **The "?" window for anyone stays.** It is untouched; this window is added
  beside it.
- **Analytics.** A message admitted only by this window is recorded with trigger
  `conversation_window`, not as a mention, name, reply or `reply_window`
  (see `docs/trip-bot-analytics-and-metrics-design.md`).

**Why.** Natural conversation without repeating the bot's name, and several
family members can talk to it at once.

Facts of the build that a reader will want (from the migration and code of
PR #406, not new decisions): the window is stored on
`telegram_chat_bindings` as `conversation_user_ids` and `conversation_until`
(migration `20261016120000`), compared at read time with no sweep job; unlike the
"?" window a hit does not consume it, the hit's own forward renews it; and the
per-trip opt-out added in 0053, `trips.companion_reply_capture_enabled`, covers
this window too.

## 2. Mark, and allow silence (built, PR #406)

**Decision.** A message that only the window admitted is marked
"not addressed to you by name". The companion may answer with exactly
`[[KINERARY_STAY_SILENT]]`, and the relay drops that on send and on edit.
Photos and files in the window still go through.

**Why.** The window can catch remarks meant for the family rather than for the
companion, so the companion must be able to stay quiet.

**Why a sentinel of our own.** Hermes has native silence markers, but they do not
work on the relay lane: the lane never sets `reply_expected`, so Hermes would
replace its own marker with a visible fallback sentence, which is a message to the
family, the opposite of silence. The sentinel is deliberately not one of Hermes's
markers, so it passes through Hermes untouched and the relay drops it.

**Where the rule lives for the model.** The SOUL template
(`profile-templates/familytrip-companion/templates/SOUL.md.tpl`) carries the rule.
A live companion gets it only when it is re-rendered; until then a window-admitted
message reaches a companion that was never told it may stay silent.

## 2a. Explicit addressing is explicit; reactions are not requests (staging run, 2026-10-17)

**What the run found.** A member wrote `@<bot> <question>` twice and the companion
answered with the silence sentinel both times: its prompt named neither the bot's
`@handle` nor anything it could match the mention against, and it had learnt the
sentinel from the window mark. A laugh emoji in the window got a joke.

**Decisions.**
- A group message that names the assistant, @mentions the bot or replies to its
  message (never the windows, the "?" window or the judge) is prefixed
  `[addressed to you directly ...]`, which forbids the sentinel for that turn and
  carries the bot's handle (from `getMe`, so it differs per deployment and is never
  hardcoded). The handle goes in the line, not substituted into the member's text:
  the words reach the model as typed, and the handle is learnt from any explicit turn.
- If the companion still answers such a turn with the sentinel, nothing is sent (no
  answer can be invented), `trip_bot.silence_on_addressed_turn` is logged, and the
  `reply_sent` / `reply_suppressed` event carries `metadata.silent_on_addressed`
  (migration `20261017120000`); the daily report's Usage section counts them as a
  defect (target 0). The connector remembers per chat whether each forwarded turn was
  explicit, matched by the reply's `reply_to`, else the latest forwarded turn.
- A group message with no letter or digit (and no attachment) is a reaction. The
  conversation window and the judge never admit one, and it is not kept as overheard
  context. It is forwarded only as the answer to a question the companion asked: the
  one-shot "?" window is open (then it is marked `[a reaction sent right after your
  last question ...]`), or it is a Telegram reply to a companion message that itself
  ended in a question (then it is explicit). A thumbs-up to "Should I update the
  site?" is consent; a thumbs-up to a statement is not a message.
- A thank-you to the companion is answered briefly and warmly; the SOUL does not list
  it among the cases that get the sentinel.

**A live companion keeps the old rule** until a new Hermes session starts for each
member of the group (the gateway keeps one session per member per group, and a
continuing session reuses its stored system prompt verbatim). Ending the session
rows in the companion's `state.db` makes the next message start a fresh one.

## 3. The judge (pending, unmerged: PR #407, draft, being reworked)

Nothing in this section is shipped. It records the owner's decision so the
rework builds to it.

**Decision.**

- A bounded model call decides "is this for the assistant?".
- It runs only for group text or captions that no earlier rule caught. If an
  earlier rule (name, @mention, reply, either window) caught the message there is
  no judge call.
- A yes is forwarded with the same "not addressed by name" mark, and the sender
  joins the conversation window.
- No, error, timeout or low confidence all mean not addressed (fail closed).
- Model: a free small model via OpenRouter with data collection denied, chosen
  in configuration (`JUDGE_RUNNER` / `JUDGE_MODEL`).
- A typed-decision model such as TypeSafe Jev will be benchmarked later.

## 4. Proactive level: a preference, not a privacy switch (pending, unmerged)

**Decision.** How much the group expects the bot to be part of the conversation
is a preference, set per group. `/listen` is replaced by `/proactive 1|2|3`. The
organizer changes it; anyone can read it. The default is 3.

| Level | The companion reacts to |
|---|---|
| 1 | Only when called: its name, an @mention, or a reply to it. |
| 2 | Also follows the conversation: the "?" window plus the conversation window (section 1). |
| 3 | Also joins in: level 2 plus the judge (section 3). |

**Why.** The owner framed it as a preference: "how much the group expects the bot
to be part of the conversation". The risk the owner cares about is nagging, not
privacy. If the companion is fast and right, groups will be happy; otherwise they
will turn it down.

Levels 1 and 2 describe behaviour that already exists (name/mention/reply, and the
two windows); only the setting and level 3's judge are pending. `/listen on|off`
was the first draft of this setting in PR #407 (a judge on/off switch, worded
partly as a privacy notice); it never merged, and the owner replaced it with the
three levels.

## 5. No privacy or AI disclosure in group copy

**Decision.** Group-facing copy for this setting says nothing about privacy or
about AI. It is phrased purely as a preference.

**Why.** The owner: "TMI, users will fail to understand".

## 6. The judge must be accountable (agreed targets, pending)

**Decision.** The judge's quality and speed must be measurable, with these agreed
targets:

| Measure | Target |
|---|---|
| Precision | at least 90% |
| Recall | at least 75% |
| Judge latency p95 | at most 1.5 s |
| Hard timeout | 3 s |

- **Offline:** a benchmark harness, `tools/judge-benchmark.ts`, over a 60-message
  synthetic Hebrew/English set. (Planned; not in this tree.)
- **Live proxies:**
  - *missed*: after a judge-no, the same sender re-addresses the companion within
    3 minutes;
  - *over-eager*: after a judge-yes, the companion stayed silent
    (`[[KINERARY_STAY_SILENT]]`, section 2).
- **Reporting:** a section in the daily report.
- **Also a signal:** the rate of groups lowering their proactive level.

**Why.** The owner asked that the KPIs be accountable, for assessment and for
speed. Precision is held higher than recall on purpose: a companion that
interrupts family chatter is worse than one that misses a message (a missed
message costs one repeat with its name). The numbers were proposed by the lead
with that reasoning and agreed by the owner on 2026-10-16.

## Rejected or not chosen

- **A privacy or AI notice in the group copy.** Rejected, section 5.
- **Hermes' native silence markers.** Do not work on the relay lane, section 2.
- **Relying on the Hermes half of #122** (stamping `expects_reply`) to open the
  "?" window. It was never built, which is the root of the 2026-10-16 incident;
  the conversation window does not depend on it.

## Not recorded

- The reasons for the exact values (1.5 s, 3 s, 60 messages, 5 minutes, 20
  members, 3 minutes for "missed") beyond section 6's precision-over-recall
  reasoning were not given. The 20 is
  documented in the code as clearing every real family group while bounding a
  200-member group; that is the build's reasoning, not a stated owner decision.
- Which free model will be used was not named; it is configuration.
