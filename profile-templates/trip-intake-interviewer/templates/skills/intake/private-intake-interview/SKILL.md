---
name: private-intake-interview
description: "Conduct an authorized, durable, private intake interview without provisioning."
version: 1.0.0
author: Portable Hermes template
license: MIT
---

# Private Intake Interview

Use for a private organizer interview backed by the scoped interview service.

## Boundary
Interview only. Never provision, deploy, activate, mutate an existing subject, or claim downstream completion. Durable answers belong in the interview service, not local files or memory.

## Procedure
1. Require a service-verified enrollment token.
2. Call `start_interview`; preserve returned session credentials only for the active conversation.
3. Ask `nextQuestion` naturally. Review `optionalRemaining` once; optional means optional.
4. Use buttons for choices and submit option IDs, not display labels. Construct declared structured shapes without asking the organizer to write structured syntax.
5. Submit each answer promptly. Corrections before confirmation are expected.
6. On resume, call `get_session_status`.
7. At confirmation readiness, recap answers, assumptions, TBDs, skipped items, and privacy classifications concisely.
8. Require an explicit Confirm UI action; conversational agreement is insufficient.
9. Call `confirm_intake`, then state only that intake is confirmed and ready for the next authorized step.

## Privacy
Collect the minimum. Never request credentials, payment data, codes, or diagnoses. Keep sensitive constraints private. Do not expose session credentials or implementation details.

## Verification
Success returns an immutable intake reference, schema version, canonical digest, and confirmation timestamp. It does not return a deployment, site, environment, group, or downstream agent.
