# Trip Assistant Experience Metrics — pointer

**This document intentionally holds no requirements.** The metrics that decide
whether the trip assistant is actually creating value are defined by the Hermes
skill, which is the single source of truth:

```
skill: trip-assistant-experience-evaluation
path:  ~/.hermes/profiles/<profile>/skills/travel/trip-assistant-experience-evaluation/
       SKILL.md                          scorecard, evaluation workflow, dimension details
       references/control-plan-metrics.md  weighted model, ownership, control loop, events
```

Find it by skill name rather than by path — the profile segment varies, and at
the time of writing only the `shiranusa2026` profile carries it.

Read that skill before implementing anything in this area. Do not restate its
scoring model, weights or thresholds here or in the sprint plan: a second copy
is how the last drift started, and this file exists specifically to avoid one.

## What it covers

Enough to know whether you need it, not enough to work from:

- a 1–5 top-level score derived from six weighted dimensions — availability,
  website data completeness, accuracy and cross-channel consistency,
  operational value, group experience, learning and enrichment;
- per-dimension metrics, scoring guidance, worked examples and an owner;
- the missing-information control loop, turning a gap found while answering
  into a focused organizer request;
- a daily control-plan report and an evaluation rubric;
- outcome event types and the rates derived from them.

## Relationship to the analytics design

`trip-bot-analytics-and-metrics-design.md` in this directory is the
**instrumentation** layer and stays the authority for the base event schema
(§5), the request-type taxonomy (§6), bounded Prometheus labels (§8) and
retention (§10). The skill is the **evaluation** layer.

The skill's outcome events describe how well a request was served; the §6
taxonomy classifies what was asked. Emit the former inside the latter's base
event schema. If the two disagree, extend the event contract in the analytics
design and link to it — do not fork a second vocabulary.

## When it gets implemented

Scheduled across two sprints in `onboarding-mvp-sprint-plan.md`: Sprint 6 takes
the outcome events, the daily report and the control loop alongside the
dashboard; Sprint 7 takes the weighted scoring and repeated-question reduction
with reviewed learning.

## Known risk

The Hermes profile directory is **not version controlled** — no history, no
branch, no backup through git — and lives on one machine in one profile. If the
skill is missing when Sprint 6 begins, that is this risk landing, not an
oversight. Preserving or versioning it is a deliberate open decision; see the
carried-forward items on the control-plane integration PR.
