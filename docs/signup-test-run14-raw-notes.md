# Signup test — run 14 raw notes (2026-09-12, Proxmox VM)

The organizer's own interviews against the VM stack (`@Tripinterviewer_bot`,
agentless interpret path), untriaged. Nothing here enters the Status ledger in
`signup-test-execution-capture (Manual).md` until the run ends — the standing
instruction at the top of that file.

Two runs, same night. The first (`trip_c595f355…`, torn down) produced five
findings that were fixed the same night: double MarkdownV2 escaping, the
multi-select finishing on its first tap, a tapped Skip going silent, a
companion naming its plumbing and asking the organizer to read the site for it,
and an introduction that gave the site password without the username to use it
with. The second (`trip_e853e76f…`) is below.

---

## 1. "From here it's optional" arrived after the optional questions — and
## "more questions" answered with the summary

**Reported (Dror, verbatim):** the message

> זה כל מה שבאמת צריך — מכאן זה רשות. עוד כמה שאלות יעזרו לי להתאים את העוזר
> לקבוצה: איך אתם אוהבים לטייל, מה אוכלים, על מי לשים לב. תענו על כמה שבא לכם,
> ותלחצו סיים מתי שתרצו.

"come after the optional question (seems like it). I checked more questions on
it and got the interview summary."

**What the relay recorded for that session:**

```
05:01:12–05:01:18  trip_bot.prompt_deduped  prompt=q:dietary        (×4)
05:01:59–05:02:03  trip_bot.prompt_deduped  prompt=q:bot_proactive  (×3)
05:02:19           trip_bot.prompt_deduped  prompt=q:planning_help
05:02:34           trip_bot.router_prompt_sent state=awaiting_confirmation
```

So the optional walk was already underway — `dietary`, then `bot_proactive`,
then `planning_help` — when the boundary message landed, and by the time More
was tapped there was nothing optional left unanswered, which is exactly when
`deriveSessionState` moves the session to `awaiting_confirmation` and the next
thing the router has to send IS the summary. The organizer asked for more
questions and was shown the end.

**Where it lives.** The boundary message is `renderEssentialsDone`, sent from
`sendNextStep`'s `!question && state !== "awaiting_confirmation"` branch, whose
"exactly once" is the entry action of the `optional` phase. On the interpret
path the router ALSO walks the optional list itself (`autoWalkOptional`, true
whenever `onInterpretPath`). Nothing orders those two against each other: the
walk can start before the phase transition announces it.

**Decided (Dror, 2026-09-12), not yet built.** Seen again on the next run —
"it doesn't matter what I choose, it always goes to the trip summary" — with
the answer: **the boundary belongs before the optional questions, not after
them.** Announce it as the interview enters the optional phase, then ask the
first optional question; then "more questions" has questions to give, and
"finish" means what it says.

That also removes the second symptom without a separate fix: More lands on the
recap today only because, by the time it is offered, nothing optional is left
unanswered — which is precisely the state `deriveSessionState` reads as
`awaiting_confirmation`.

Deliberately not done mid-run: it changes what `sendNextStep` says and when,
and the relay cannot be restarted under a live interview.

## 2. Note — the floor race showed itself, and the retry covered it

Instrumentation added the same day (`trip_bot.floor_lost`, for `claimFloor`
returning false, which used to be a bare `return false` with no log at all)
fired for the first time in the wild:

```
05:02:19  telegram_api.call_threw
05:02:19  trip_bot.floor_lost
05:02:19  trip_bot.prompt_deduped prompt=q:planning_help
05:02:34  trip_bot.router_prompt_sent state=awaiting_confirmation
```

A Telegram call threw, the floor was lost, and the session still reached the
recap fifteen seconds later — the retry added the same day covered it.

The `TypeError` is almost certainly a network failure rather than a defect:
Node's `fetch` rejects a failed request as `TypeError`, and the catch already
treats it as `NETWORK`. It records `error.name` only, deliberately — nothing
from the error message, which could carry a URL with the bot token in it. The
cost of that is precisely this: a real TypeError and a dropped connection are
indistinguishable in the log. What was lost is one `editMessageText`, so a
keyboard somewhere kept its old text instead of collapsing.

If telling the two apart ever matters, the fix is a classifier at the catch
(`error.cause?.code`, `ECONNRESET`/`UND_ERR_*` → `NETWORK`, anything else →
`THREW`), not a wider log line.

---

## 3. The companion arrived in the family group as Hermes, not as the trip

**Reported (Dror, 2026-09-12, trip `trip_dffa9730…`, the run that reached a
live site and a live bot):**

1. "Once added the bot to the group I pasted the group link command in the
   group — it did not initiate a greeting message and did not pin it as it was
   supposed to."
2. "The greeting message was Hermes's one, which also routed all Hermes
   commands to the group." Verbatim, in the group:

   > שלום! אני יפו, מלווה הטיול שלכם ליפן 2026 — משפחה. הקלידו /help כדי לראות
   > את הפקודות הזמינות.
   >
   > אשמח להכיר אתכם קצת יותר כדי שאוכל להיות יותר שימושי — שם, מה אתם עושים,
   > איך אתם אוהבים שאעבוד אתכם.

Three separate defects, and the first one is why the other two were visible.

**(a) The group's arrival message could never be composed — a transposed
variable.** `provisioner.py` builds the full `intro_facts` for migration 0044
and, four lines later, a minimal `notif_payload` (`private_url` alone) for the
site-ready notification. The `UPDATE trips SET companion_intro` was handed
`notif_payload`. So every trip provisioned since 0044 stored one true fact and
nothing the message is made of; `dispatchUpdate` found no `assistant_name`,
fell through to the bare `groupBoundNoIntro`, and — since the pin rides on the
`group_intro` decision — pinned nothing. The relay log shows it exactly:
`trip_bot.group_bound` with no `trip_bot.group_intro_sent` after it.

Fixed, with a test that asserts what the column is FOR rather than that it is
non-null: `assistant_name`, the site, and the per-traveller usernames.

**(b) Hermes's own first-contact onboarding answered the family.** Both halves
of it: `gateway/run.py` appends "[System note: … briefly introduce yourself and
mention that /help shows available commands]" on the first message a profile
ever receives, and `agent/onboarding.py`'s profile-build offer (default "ask",
fires once per install) produced the second paragraph. With (a) broken there was
no router message in the room, so this was the group's first contact with its
assistant.

`onboarding.profile_build: "off"` in the companion overlay kills the offer —
**quoted**, because bare `off` is a YAML 1.1 boolean and the reader accepts only
the string, which is a config that looks right while doing nothing. The plain
intro note has no switch; SOUL.md now carries a standing rule against
advertising commands, and the router makes /help harmless.

**(c) Hermes's slash surface was reachable from a family group.** Under the
relay every one of Hermes's commands arrives as ordinary text, and the
companion path forwarded them — `/help`, `/model`, `/reset`, `/sethome`. The
connector's leak guard was already catching the consequences on their way into
the room (`relay.internal_leak_suppressed matched "sethome"`, and a
"switched to fallback model" notice).

Fixed in the router, which is the only authoritative place: a command is
answered by `dispatchUpdate` or not at all — never forwarded to any gateway,
companion or interviewer. Hermes's own gate cannot do this job (its
`slash_access` enables gating only when a scope names an admin, and keeps
`help`/`whoami` reachable regardless), so the profile config is depth, not the
fix.

**Residue, not fixed:** the plain first-contact self-introduction still fires
once per profile. It is now a brief self-introduction with nothing to act on,
behind a pinned arrival message — acceptable. Killing it would mean priming a
session at install so the profile's first real message is not its first ever.
