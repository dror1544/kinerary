# The native-name translation is given the time the binding needs

Status: draft 2026-11-12 — behaviour decided by Dror in #548; approval at merge · Issue: #546 · Track: Sprint 8 staging-test fixes · Size: S · Tier: Normal
Security path: no · Migration: no · Live-trip behaviour: yes (interviews started after the relay restart)

Related: `438-dashboard-trip-seeds-interview.md` (AC-14 made the call; AC-17 to AC-19 are the greeting's shape, #548).

## Problem

Sprint 8 staging run, 2026-11-12 (Mac staging, trip `gatecity-2026-2`, Hebrew
organizer "Arlo", session `sess_98f6fb359b9c0ca2e7062ea3d09d87fe`): the relay
logged `interview.native_names_unavailable reason=TIMED_OUT` at session start,
so the greeting carried "Arlo" and "Gatecity" in Latin letters inside a Hebrew
sentence, which is what AC-14 exists to avoid. The same log shows the
`interpret` binding (the one the translation runs on) taking 7137–9432 ms per
call (`interview.interpret_ok ms=`). The ceiling in `native-names.ts` was 5 s:
it was written for a model call that "should" take 1–2 s and it fails on every
call at the real latency. It failed silently from the organizer's side (the
English fallback is the designed behaviour), which is why it went unseen until a
person read the greeting.

## Behaviour

Choice made (2026-11-12): **fit the ceiling to the binding's real latency**
(5 s → 15 s), rather than start the translation earlier.

Why not earlier: the language the translation is made for is the Telegram
client's locale, which the control plane learns only from the `/start` update
that opens the link (`startFromDeepLink`). The dashboard has no language for the
organizer, so a translation started when the dashboard creates the trip or
issues the link would have to guess a language, and a wrong guess is a wasted
model call and a Hebrew greeting with an English place. Nothing can start before
`/start`, and the greeting is the reply to `/start`. The portal routes that
would be the earlier hook are also outside this task's paths. What stays true:
the call is made once per session, after the session's transaction has
committed, and is stored in `ui_state.native_names`.

Why 15 s: the slowest call seen was 9.4 s; 15 s is that plus about half again.
It is the longest a first message ever waits, and only for a non-English
organizer on a first start; every other case is faster, or makes no call at all.
It is a ceiling, not a target: the greeting goes out the moment the model
answers. A longer ceiling would make an organizer who has just tapped a link
stare at nothing; a shorter one is the bug. If the binding's latency changes
materially, the constant (`NATIVE_NAMES_TIMEOUT_MS`) is the one place to move.

- **AC-1 (the ceiling clears the real latency)** Given the `interpret` binding
  takes 7–9.5 s per call, when a Hebrew organizer opens a dashboard trip's link,
  then the translation is not abandoned: the ceiling handed to the runner is
  `NATIVE_NAMES_TIMEOUT_MS`, which is above 9432 ms and at most 20 s.
- **AC-2 (a slow answer still lands)** Given the model answers after 5.5 s (past
  the old ceiling), when the session starts in Hebrew, then the first message
  names the organizer and the destination in Hebrew, no
  `native_names_unavailable` warning is logged, and the result is stored with the
  session.
- **AC-3 (never blocked indefinitely)** Given the model never answers, when the
  ceiling passes, then the greeting is sent with the English as entered and a
  `TIMED_OUT` warning (reason only, never the values), and nothing is stored.
  (Unchanged from AC-14 of the #438 spec; the existing test runs it with a short
  ceiling passed in.)
- **AC-4 (the English fallback is kept)** Given the runner is not configured,
  fails, throws, or returns something the validation gate refuses, then the
  greeting carries the English as entered and a warning names the reason.
  (Unchanged; existing tests.)

## Non-goals

- A faster binding or a separate `NATIVE_NAMES_*` binding for this one call
  (`model-runner.ts` and the deployment's env are not this task's); if 7–9 s is
  too long to wait for a greeting, that is a decision about the binding.
- Translating before `/start` (see above), or caching a name per account across
  trips (no storage for it without a migration).
- Changing the greeting's shape: that is #548, `438-…`'s AC-17 to AC-19.

## Test plan

`control-plane/api/test/dashboard-seeds-interview.test.ts`, "AC-14 the greeting in
the interview's own language": the constant is above the slowest observed call
and at most 20 s, and is what the runner is given; a runner answering after
5.5 s still produces the Hebrew greeting, a stored translation and no warning
(fails on a 5 s ceiling); the existing never-answers, not-configured, failing and
garbage-answer cases still fall back to English with a warning. Runs against a
`*test*` database.

## Status

draft 2026-11-12 — behaviour decided by Dror in #548; approval at merge.
Built on branch, not merged. Live effect: Mac staging relay after restart.
