# Connected assistants — managed queue

Updated 2026-09-26. Lead: Codex. State: planning only.

[Parent initiative #247](https://github.com/dror1544/kinerary/issues/247).
Design and operating contract: [plan](connected-assistants-plan.md).

GitHub issue state is authoritative for execution. This index records initial
ordering and dependencies; no task is agent-ready or claims product paths.
CA-00 has this planning document as input; its architecture contracts remain to
be designed and reviewed. Creating an issue is not completing its acceptance.

| Work | Issue | Initial status |
|---|---|---|
| CA-00 — Contracts and coexistence design | [#248](https://github.com/dror1544/kinerary/issues/248) | Planned / not dispatched |
| CA-01 — Reliable confirmation files through customer assistants | [#249](https://github.com/dror1544/kinerary/issues/249) | Planned / not dispatched |
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
| Codex lead | `feat/connected-assistants-plan` | `docs/future/connected-assistants-plan.md`, `docs/future/connected-assistants-queue.md` |

Claude-led Sprint 6 claims are external dependencies, not transferred here.
Shared paths require a recorded owner handover on the issue before a developer
starts. An implementation brief must name the exact base, target, worktree,
model/effort, owned paths, isolated DB, tests, security and infrastructure gates.

## Next managed action

CA-00: settle delegated runtime authorization and document transport contracts,
check current issue owners and the disposition of PR #116, and refine the Mini
App account-handoff flow. Product implementation remains a later instruction.

## Resume evidence

Planning source: Sprint 6 `7d0a14c2ece8b6fe459773eec9446edba09abdc4`.
Role source latest commit at planning: `11cb63e`; generated Codex mirror checked.
No existing issues reassigned, no sprint milestone changed, no infrastructure
window or production path claimed. See the plan for verification and limitations.
