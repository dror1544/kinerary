# Trip Assistant Experience Metrics — pointer

**This document intentionally holds no requirements.** The metrics that decide
whether the trip assistant is actually creating value are defined by the skill:

```
.agents/skills/trip-assistant-experience-evaluation/
  SKILL.md                            scorecard, evaluation workflow, dimension details
  references/control-plan-metrics.md  weighted model, ownership, control loop, events
```

That directory is the source of truth. Read it before implementing anything in
this area, and do not restate its scoring model, weights or thresholds here or
in the sprint plan — a second copy is how the last drift started, and this file
exists to avoid one.

## Deployment to Hermes profiles

The skill runs inside a Hermes profile. Traffic goes both ways:

```bash
scripts/install-hermes-skill.sh trip-assistant-experience-evaluation <profile> --capture
scripts/install-hermes-skill.sh trip-assistant-experience-evaluation <profile>
scripts/install-hermes-skill.sh trip-assistant-experience-evaluation <profile> --check
```

The profile is where the agent works, so it is where insight shows up first — a
scoring note that proved wrong, a metric worth adding, a takeaway worth reusing.
That content has no history where it sits, so **capture it into the repo before
deploying over it**, then commit. Deploy refuses when the profile has diverged,
so the ordering is enforced rather than remembered.

## What the skill covers

Enough to know whether you need it, not enough to work from:

- a 1–5 top-level score derived from six weighted dimensions — availability,
  website data completeness, accuracy and cross-channel consistency,
  operational value, group experience, learning and enrichment;
- per-dimension metrics, scoring guidance, worked examples and an owner;
- the missing-information control loop, turning a gap found while answering
  into a focused organizer request;
- a daily control-plan report and an evaluation rubric;
- outcome event types and the rates derived from them;
- scoring notes naming the traps that produce a flattering score for a service
  travelers did not actually receive.

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
