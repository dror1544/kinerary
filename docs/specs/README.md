# Implementation specs

From Sprint 7 (decided by Dror, 2026-10-19) sprint work is **spec-driven**: no
item is briefed to a developer, or built by the lead under the Small tier,
until its implementation spec here is approved.

- **This folder** holds *implementation* specs — behaviour, contracts,
  acceptance criteria, tests. They are technical and product-neutral, and they
  obey hard rule 6: no host, IP, container name, VMID, chat id or `/opt` path.
  Anything deployment-specific is named by the env var or config file that
  carries it.
- **The notes folder** (`$KINERARY_NOTES_DIR/specs/`) holds the product-level
  sprint spec: goal, tracks, decisions and their reasons, exit gate.

## Lifecycle

```
draft → approved (date, by Dror) → in build (PR) → built (PR merged) → verified (verifier report)
```

1. A spec is drafted, reviewed (a `consult` or Plan pass for L items), and
   approved by Dror — the approval is recorded in the spec's Status line.
2. The brief (`docs/agent-team-plan.md`, Appendix B) carries `Spec:` pointing
   here, and its **Done when** is the spec's acceptance criteria, verbatim.
3. Tests are written from the acceptance criteria first.
4. `verifier` reports criterion by criterion (AC-1 … AC-n), with real output.
5. A behaviour change discovered mid-build is a **spec PR first**, then code —
   never code that quietly drifts from its spec.
6. Small-tier items (`scripts/regression-assessment-scope.sh` exits 0) may use
   the short form: Problem, Acceptance criteria, Test plan.

## File naming

`docs/specs/sprint-<N>/<issue>-<short-slug>.md`; an item with no issue yet
uses `x-<slug>` until one is filed.

## Template

```markdown
# <Title>

Status: draft (<date>) · Issue: #<n> · Track: T<n> · Size: S|M|L · Tier: Small|Normal|High
Security path: yes|no (<which>) · Migration: yes|no · Live-trip behaviour: yes|no

## Problem
What is wrong or missing today, with the evidence (file:line, issue, run note).

## Behaviour
What is true when this is done, from the user's or operator's side.

## Acceptance criteria
- AC-1 Given …, when …, then …
- AC-2 …

## Contracts
APIs, schema, migrations (with the `-- rollback:` header), config keys, events.
Name the files expected to change.

## Non-goals
What this deliberately does not do.

## Security and boundary notes
Which invariant from CLAUDE.md "Security-sensitive paths" applies, and how it is kept.

## Test plan
Suites touched; new tests (by name), written first; manual check if any.

## Rollout and regression
Which live trips feel it and when; redeploy needs; regression plan needed or
"assessment: not needed (why)".

## Open questions
Decisions for Dror before approval.
```
