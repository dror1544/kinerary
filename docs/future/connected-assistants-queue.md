# Connected assistants — managed queue

Updated 2026-10-02. Lead: Codex. State: CA-00 and CA-01 F0/L1/P1 slices on the combined testing lane; R1 original retrieval verified on a separate feature branch.

[Parent initiative #247](https://github.com/dror1544/kinerary/issues/247).
Design and operating contract: [plan](connected-assistants-plan.md).

GitHub issue state is authoritative for execution. This index records initial
ordering and dependencies; CA-00 documentation, CA-01 F0 fixtures, and CA-01 L1 confirmation linkage and P1 authenticated upload fallback are reviewed on the separate initiative branch. Claude handed over the narrow CA-01 server paths on #249. The contract draft is [here](connected-assistants-contracts.md). PR #257 remains open; this branch carries its plan text from the repaired integration baseline and Claude decides whether the older PR is superseded. The initiative now tests on `feat/connected-assistants-integration`; owner agreement and Claude review precede any merge into Sprint 6. GitHub issue comments carry the current brief and owner handover requests; the original issue body is a dated planning snapshot.

| Work | Issue | Initial status |
|---|---|---|
| CA-00 — Contracts and coexistence design | [#248](https://github.com/dror1544/kinerary/issues/248) | Reviewed in [draft PR #267](https://github.com/dror1544/kinerary/pull/267); Claude owns merge and #257 disposition |
| CA-01 — Reliable confirmation files through customer assistants | [#249](https://github.com/dror1544/kinerary/issues/249) | F0 fixtures in [draft PR #268](https://github.com/dror1544/kinerary/pull/268); L1 booking linkage reviewed in [draft PR #271](https://github.com/dror1544/kinerary/pull/271) and integrated at `39b1bf2`; P1 authenticated browser fallback is in [draft PR #273](https://github.com/dror1544/kinerary/pull/273); direct client file transfer remains |
| CA-02 — Account-wide grants and authorized trip access | [#250](https://github.com/dror1544/kinerary/issues/250) | [Account-owner handover requested](https://github.com/dror1544/kinerary/issues/250#issuecomment-5949526943); not dispatched |
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
| Codex lead | `feat/connected-assistants-ca01-fixtures` | `tests/connected-assistants/**` only |
| Codex lead | `feat/connected-assistants-integration` | combined CA-00 docs, CA-01 F0 fixtures and L1 confirmation route/tests and P1 public MCP upload fallback; target for future initiative slices |
| Codex lead | `feat/ca01-confirmation-readback` (base cc048c6) | R1 original retrieval in server/trip-mcp and directly related tests; new feature branch, not yet integrated |

Claude-led Sprint 6 claims are external dependencies, not transferred here.
Shared paths require a recorded owner handover on the issue before a developer
starts. An implementation brief must name the exact base, target, worktree,
model/effort, owned paths, isolated DB, tests, security and infrastructure gates.

## Next managed action

The P1 fallback passed a synthetic public-HTTPS OAuth/MCP/upload/readback/revoke probe, plus a signed-in real-browser page check; evidence is on #249. Real ChatGPT and Claude acceptance awaits the intended test accounts and an account-level connector grant. Implement direct file transfer only after a verified client file payload and a bounded SSRF-safe fetch contract. P1 passed the full trip-site suite (608/608), preflight, and independent HTTP/boundary checks. The earlier L1 slice passed 606/606. [#249 decision 55](https://github.com/dror1544/kinerary/issues/249#issuecomment-5856293225), recorded 2026-09-27, supersedes the earlier 3 October freeze: Release A deploys pinned release/a; ready CA-01 PRs may enter Sprint 6 through the normal security/integrator path. Owner merge authority, outstanding OAuth findings and main-via-sprint conditions remain. #116 remains open and is not a product-path handover. Before editing `server/trip-mcp/oauth.js`, obtain Claude's note about its pre-existing findings.

## Resume evidence

Planning source: Sprint 6 `7d0a14c2ece8b6fe459773eec9446edba09abdc4`.
Role source latest commit at planning: `11cb63e`; generated Codex mirror checked.
No existing issues reassigned, no sprint milestone changed, no infrastructure
window or production path claimed. See the plan for verification and limitations.

## R1 retrieval evidence and remaining work (2026-10-02)

R1 is prepared on feat/ca01-confirmation-readback, based on initiative commit
cc048c6. It retrieves the original linked PDF through organizer write grants
with exact bytes, byte count and SHA-256. The binary phase is limited to 5 MiB
and 10 seconds; the preceding booking lookup is outside that deadline. No
upload mutation, caller URL fetch or new account grant is introduced.

The independent verifier reported 616/616 tests across 115 suites in 65.3
seconds, with zero skipped tests. The final independent boundary addendum
checked the injected-error case against tools blob afba671 and helper-test
blob 0abc553: one passed, six unrelated cases skipped, no new finding.
These are synthetic/local observations, not real ChatGPT/Claude acceptance.

An actual-server probe exposed the existing shared Unicode Content-Disposition
failure. R1 returns a truthful error and no resource; the synthetic Unicode
guard test does not prove real-server Unicode-original retrieval. A separate
[shared-helper handover was requested](https://github.com/dror1544/kinerary/issues/249#issuecomment-5949632734).
Real client accounts and direct attachment transfer remain pending.

R1 has not been integrated into the initiative branch, Sprint 6, main or
production. Current Sprint 6 and the initiative diverge; later integration
must preserve both current budget-ownership and CA-01 test coverage and verify
the merged tree. No release or deployment approval follows from these tests.
