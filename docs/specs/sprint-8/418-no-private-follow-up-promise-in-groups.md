# The companion does not promise a private follow-up in a group

Status: draft, refreshed against 4510301 (2026-10-30) · Issue: #418 · Track: T1 · Size: S · Tier: Normal
Security path: no · Migration: no · Live-trip behaviour: yes (companion instructions)

> **Sprint 8 (2026-10-30): in scope.**

## Problem

Owner's gate-3 run, 2026-10-18 (`france-2026`): in the group the companion
answered some requests with "אטפל מולך בפרטי" ("I'll handle it with you
privately"). It never followed up in the DM. Owner: it should not say this in a
group at all. Must-fix.

The promise is **instructed**, in two places, and nothing backs it:

- `profile-templates/familytrip-companion/templates/SOUL.md.tpl:24-29`: an
  operational question in the GROUP is not answered; "say briefly that you will
  pick it up privately with the organizer, and continue in the
  organizer-private channel".
- `SOUL.md.tpl:582-588` (Stops): a stop change from the group "get[s] one
  friendly line — … you will take it up with them privately".
- The same lines appear in
  `templates/skills/travel/familytrip-companion-operations/SKILL.md:31` and
  `:42` ("offer the stop link to the organizer privately"), and the eval file
  **requires** them: `eval/stop_editing_cases.json:290` (`member_asks_to_split`)
  and `:320` (the case signed with the organizer's name).
- Neighbouring lines that push the same way:
  - `SOUL.md.tpl:230-237`: a group message signed with the organizer's name
    goes "to the organizer-private channel".
  - `trip-daily-planning/SKILL.md:314` (and `:320`, `:332`, `:456`, `:472`):
    only the organizer approves, and a plan is presented "to the organizer
    privately". This is stale and contradicts `SOUL.md.tpl:706`.
  - `SOUL.md.tpl:322-340` is the precedent: the companion was already told
    never to promise a later delivery it cannot make.
- No mechanism keeps the promise:
  - The companion's own tools cannot start a conversation. `companion-mcp.ts`
    has `get_assistant_names`, `set_assistant_names` and `report_bug` only
    (`:177-215`; unchanged on 4510301).
  - Nothing in the repo turns such a reply into a DM. The relay *can* send to
    any `chat_id` (`relay/connector.ts:508`), but only in answer to the turn it
    was given.
  - A Hermes reply is answered into the chat it came from.
  - Cron output goes to `TELEGRAM_HOME_CHANNEL`
    (`profile-templates/familytrip-companion/README.md:104`), on a schedule
    only.
- `docs/group-participation-design.md` has no section on escalating to a
  private chat (§1-§6, `:34-:193`).

**Refresh against 4510301 (2026-10-30).** Not fixed on main: every promise
quoted above is still in the templates and the eval still requires it. What
moved:

- **#481 (`6436c5b`) did not edit `SOUL.md.tpl`**; it changed
  `config.overlay.yaml.tpl`. It matters here twice. (1) `SOUL.md.tpl` is
  ~52K characters; before #481 a 200K-window model (Haiku via `/model`) got a
  48K cap that dropped the file's **middle**, which is where the Stops rule
  and the approval rule live. #481 pins `context_file_max_chars: 120000`
  (`config.overlay.yaml.tpl:54-60`), so after it the rewritten lines reach
  every model. (2) `display.interim_assistant_messages: false` (`:52`) stops
  interim narration being posted as its own message, so a "let me check with
  the organizer" said mid-tool-loop no longer reaches the group on its own;
  the final answer still can, which is what this spec fixes.
- #133 (`f7a05e0`) added four lines (`plan_open_days`) above the Stops rule
  (hence `:578` → `:582`), a `dates_overlap_stop` refusal and a "Planning days
  that belong to no stop yet" section to the operations skill (its `:73` is
  now `:82`), and an organizer-private eval case `plan_open_days_one_call`.
  None of it promises a private follow-up; the new eval case is in the
  organizer's DM and needs no change.
- The `.agents/` mirror lines are unchanged (`familytrip-companion-operations/SKILL.md:32`;
  `trip-group-reply-style/SKILL.md:332`, `:338`).

## Behaviour

In a group, the companion never says it will continue somewhere else. What it
says instead depends on the request:

- **Something it can do in the group:** it does it there.
- **Organizer-only business** (stops, someone else's login, private details): it
  says plainly, in one line, that the organizer handles that, and that the
  organizer can ask it directly in their own chat with the companion or change
  it on the site. It does not promise to act.
- **A question about its own plumbing:** it answers in plain words what it can
  and cannot do, naming no component (`SOUL.md.tpl:10-29`). It does not defer.

In the organizer's own DM nothing changes.

## Acceptance criteria

- AC-1 Given the rendered SOUL and every rendered skill for every template
  variant, when they are searched, then no instruction tells the companion to
  "pick it up privately", "take it up with them privately", "continue in the
  organizer-private channel", or to send or offer anything "privately" in
  answer to a group message. Briefing delivery choices (`SOUL.md.tpl:409-424`)
  are the only allowed exception, and the test names them explicitly.
- AC-2 Given the rendered SOUL, then the Stops section states the group or
  member reply as "the organizer handles stops; they can ask me in their own
  chat or change it on the site". It calls no stop tool and promises no
  follow-up (`SOUL.md.tpl:582-588`).
- AC-3 Given the rendered SOUL, then the plumbing rule tells the companion to
  answer a group operational question in plain words, here, with no deferral
  to another chat.
- AC-4 Given `eval/stop_editing_cases.json`, then no case requires "privately"
  in a group reply. `member_asks_to_split` and the organizer-signed group case
  instead require "the organizer can ask me directly / change it on the site"
  and forbid a promise of later action (`reply_must_not`: "privately",
  "בפרטי", "I'll get back", "אחזור").
- AC-5 Given `trip-daily-planning/SKILL.md`, then its approval paragraph
  (`:310-333`, and the checklist lines `:456`, `:472`) matches `SOUL.md.tpl:706` (anyone in the group approves). The "present to the
  organizer privately" line is removed.
- AC-6 (model, manual) Given the 3 group eval cases (member split, organizer
  name in group, plumbing question in group), when run three times each
  against the production companion model **with #481's overlay rendered**
  (else the Stops rule may be cut out of context on a smaller-window model),
  then no reply promises a private or later follow-up. The runs are recorded in the PR.

## Contracts

Instruction text only:
- `profile-templates/familytrip-companion/templates/SOUL.md.tpl` (`:24-29`,
  `:230-237`, `:582-588`);
- `templates/skills/travel/familytrip-companion-operations/SKILL.md` (`:31`,
  `:42`, `:82`, which already forbids exposing escalation in the group;
  keep it);
- `templates/skills/planning/trip-daily-planning/SKILL.md` (`:310-333`,
  `:456`, `:472`);
- `templates/skills/travel/trip-kml-export/SKILL.md:83` ("send privately to
  the organizer" on an organizer request in their DM stays; a group request
  gets the same one-line redirect);
- `eval/stop_editing_cases.json` (`member_asks_to_split` from `:269`,
  requirement at `:290`; organizer-signed group case, requirement at `:320`);
- `.agents/skills/familytrip-companion-operations/SKILL.md:32` and
  `.agents/skills/trip-group-reply-style/SKILL.md:332-369`, the repo copies
  mapped in `.agents/hermes-sync.tsv`. Keep them in sync, or preflight B5 drift
  fails.

No code, no relay change, no new tool.

## Non-goals

- Giving the companion a "message the organizer now" capability. That would be
  a new outbound path from a context full of traveller text, the same reason
  the companion cannot file issues itself (CLAUDE.md "A companion reports; the
  monitor decides"). Open question 2.
- The relay's group judge (#406/#407).

## Security and boundary notes

No invariant is touched. Organizer-only scoping is unchanged: the Stops rule
still calls no stop tool from a group (`test_no_case_calls_a_stop_write_from_outside_the_organizer_private_chat`
stays green).

## Test plan

Write first, in `profile-templates/familytrip-companion/tests/test_template.py`:
- `test_no_group_reply_promises_a_private_follow_up`, which renders every
  variant and greps every `.md` for the phrase list in AC-1, allowing the
  briefing section;
- `test_plumbing_question_in_the_group_is_answered_not_deferred`;
- `test_daily_planning_approval_matches_soul`.

In `test_stop_editing.py`:
- update `test_soul_states_the_rule_and_points_at_the_procedure`, removing the
  "privately" assertion and adding the AC-2 wording;
- add `test_group_stop_cases_forbid_a_promised_follow_up`.

Also check `control-plane/api/test/stay-silent.test.ts`, which reads the raw
template, still passes, and that #481's size guard in `test_template.py`
(SOUL.md under `context_file_max_chars`) stays green: the rewrite must not
grow the file materially.

Suites: `profile-templates` unittest, `control-plane/api` (unit, no database),
`scripts/preflight-checks.sh --staged` (B5 Hermes drift). Manual: AC-6.

## Rollout and regression

Reaches a trip only when the profile's SOUL.md and skills are re-rendered from
the template **and** each open conversation's saved prompt is cleared
(`scripts/companion-refresh-prompts.sh <profile>` does the second only; it
reads whatever SOUL.md is on disk). For the Stops wording to reach a
smaller-window model, the profile also needs #481's overlay. A live
group keeps the old wording until then. **Per-PR regression plan: needed**
(companion behaviour on live trips), but small: instruction text only, no
tool or site change. It can ride with #419's profile refresh.

## Open questions

Size: unchanged (S). Nothing in scope was built on main; #481 and #133 only
moved line numbers and removed one rollout risk (SOUL's middle being cut).


1. In a group, drop the "pick it up privately" line entirely, or tell the
   companion to point the organizer to their own chat with it? This spec
   recommends the second: honest, and it promises nothing the companion has to
   do later.
2. Do you ever want the companion to be able to message the organizer on its
   own (a real follow-up)? If yes, that is a separate, boundary-reviewed
   feature. It is not this fix.
3. (new) Live companions rendered before #481 still cut SOUL.md's middle on a
   smaller-window model. Should this fix's rollout re-render every live
   companion's overlay as well as its SOUL (one refresh for both), or only the
   SOUL and skills, leaving the overlay to #481's own rollout?
