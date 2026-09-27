# Connected assistants — managed queue

Updated 2026-09-27. Lead: Codex. State: CA-00 contract review in progress after the hook gate.

[Parent initiative #247](https://github.com/dror1544/kinerary/issues/247).
Design and operating contract: [plan](connected-assistants-plan.md).

GitHub issue state is authoritative for execution. This index records initial
ordering and dependencies; CA-00 is the only active task; it claims documentation only. Product paths remain unclaimed. The contract draft is [here](connected-assistants-contracts.md). PR #257 remains open; this branch carries its plan text from the repaired integration baseline and Claude decides whether the older PR is superseded. GitHub issue comments carry the current brief and owner handover requests; the original issue body is a dated planning snapshot.

| Work | Issue | Initial status |
|---|---|---|
| CA-00 — Contracts and coexistence design | [#248](https://github.com/dror1544/kinerary/issues/248) | In progress: contract and independent review |
| CA-01 — Reliable confirmation files through customer assistants | [#249](https://github.com/dror1544/kinerary/issues/249) | Next: shared server-path handover required |
| CA-02 — Account-wide grants and authorized trip access | [#250](https://github.com/dror1544/kinerary/issues/250) | Planned / not dispatched |
| CA-03 — One OAuth MCP for onboarding and active trips | [#251](https://github.com/dror1544/kinerary/issues/251) | Planned / not dispatched |
| CA-04 — Portable Kinerary skills and ChatGPT/Claude packages | [#252](https://github.com/dror1544/kinerary/issues/252) | Planned / not dispatched |
| CA-05 — Forwarded email and one-time Drive folder import | [#253](https://github.com/dror1544/kinerary/issues/253) | Planned / not dispatched |
| CA-06 — Reviewed Gmail discovery and optional source synchronization | [#254](https://github.com/dror1544/kinerary/issues/254) | Planned / not dispatched |
| CA-07 — Refine and deliver Telegram Mini App private and group flows | [#255](https://github.com/dror1544/kinerary/issues/255) | Planned / not dispatched |
| CA-08 — Cross-client pilot, migration and release evidence | [#256](https://github.com/dror1544/kinerary/issues/256) | Planned / not dispatched |

## Current claims

| Owner | Branch | Owned paths |
|---|---|---|
| Codex lead | `feat/connected-assistants-ca00-current` (based on repaired integration; carries PR #257 docs for Claude to disposition) | `docs/future/connected-assistants-plan.md`, `docs/future/connected-assistants-queue.md`, `docs/future/connected-assistants-contracts.md` |

Claude-led Sprint 6 claims are external dependencies, not transferred here.
Shared paths require a recorded owner handover on the issue before a developer
starts. An implementation brief must name the exact base, target, worktree,
model/effort, owned paths, isolated DB, tests, security and infrastructure gates.

## Next managed action

Finish independent review of CA-00, then brief a bounded CA-01 slice. #116 remains open and is not a product-path handover. The #227/#163/Sprint 6 owners must hand over the shared server paths before CA-01 code edits. Disjoint fixtures can proceed while that is pending.

## Resume evidence

Planning source: Sprint 6 `7d0a14c2ece8b6fe459773eec9446edba09abdc4`.
Role source latest commit at planning: `11cb63e`; generated Codex mirror checked.
No existing issues reassigned, no sprint milestone changed, no infrastructure
window or production path claimed. See the plan for verification and limitations.
