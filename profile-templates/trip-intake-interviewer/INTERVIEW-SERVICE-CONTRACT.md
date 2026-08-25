# Interview service contract

The profile requires a durable, authorization-aware interview service. An adapter may target any product, but it must expose only the interview surface.

## Tools

- `start_interview(enrollmentToken)` verifies token signature, expiry, provider identity, subject binding, and isolation; returns session credentials, state, `nextQuestion`, and `optionalRemaining`.
- `get_session_status(sessionId, sessionToken)` returns durable answers, state, next required question, optional questions, missingness, and confirmation readiness.
- `submit_answer(...)` accepts the response shape declared by question metadata and returns updated state. Corrections are safe before confirmation.
- `confirm_intake(...)` returns an immutable intake reference, schema version, canonical digest, and confirmation timestamp. It must fail without required answers and a deliberate confirmation action.

## Question metadata

Each question should declare a stable ID and schema version, requiredness, response type, options, structured response schema when applicable, visibility/sensitivity, and distinct handling for TBD, skipped, explicitly empty, and inapplicable.

The profile must not depend on product-specific question IDs. Product-specific guidance belongs in a versioned adapter supplied with the service.

## Invariants

Durable state lives in the service, not LLM memory. The profile gets no provisioning, activation, infrastructure, existing-tenant, or cross-tenant access. Confirmed records are immutable and traceable. Secrets and provider bindings stay outside the portable input. Unknown/sensitive material defaults to private.
