# Sprint 5 close-out — handoff for the next agent

Sprint 5 was declared **finished by Dror on 2026-09-13**. What remains is getting
the tested work onto `main`, deploying it, and running the full test once more.
Work top to bottom; each step says what proves it done.

**Standing rules (CLAUDE.md):**
- **Approval:** never commit, merge to `main`, or deploy without Dror's
  explicit approval.
- **Public repo:** no names, chat ids, booking references or document
  contents in commits, issues or reports.
- **Database suites:** they drop the database they are given. Use only
  `postgres://postgres:test@127.0.0.1:5434/cptest_cpvm`, one run at a time.

## Where things stand (2026-09-13)

| | |
|---|---|
| `integration/sprint-5-plus` | `77d106a`, containing #66 (the VM branch `feat/cp-vm-compose`) and #63 |
| VM `kinerary-cp` | runs `d1cd907` (`feat/cp-vm-compose`), relay on **`@Kinerary_bot`**, provisioning off |
| Mac stack | relay at `e8567a7` (`feat/interview-interpret`) on **`@Tripinterviewer_bot`**, without the reply-thread fix `d1cd907` |
| Left running | the `japan-2026` trip from Dror's manual run (`trip_76c4d83f1daa37c09e794a5c46956230`), which is his to keep until he says otherwise |

## 1. Land the two PRs that conflict

**#47 `feat/trip-bot-trip-commands` → integration** conflicts in
`control-plane/api/src/chat-router.ts`. Both sides extended the router's
commands: #47 adds `/trips` and `/switch`; integration has `/name`, `/rename`
and the ⌘ menu. Keep both.
- *Done when:* `test/command-menu.test.ts`, `test/chat-router.test.ts` and the
  `relay-*` suites pass, CI is green, and it is merged.

**#64 `feat/group-reply-capture`** conflicts in `control-plane/api/src/relay/dispatch.ts`,
`test/chat-router.test.ts` and `test/migrations.test.ts`.
- It is still based on `main`; retarget it to integration before resolving.
- The migrations conflict suggests two branches claiming the same migration
  number. Renumber rather than merge two files into one.
- The main checkout `/Users/elul/kinerary` is on this branch, with another
  session's uncommitted edit to `docs/onboarding-mvp-sprint-plan.md`. Do not
  clobber it.
- *Done when:* the suites above pass, CI is green, and it is merged.

## 2. Local work that has not landed: ask Dror, do not discard

| Worktree | Branch | State |
|---|---|---|
| `.claude/worktrees/document-intake` | `feat/document-intake` @ `39ba81e` | 30 tracked files changed, none identical to integration. Parts may be superseded by `931d3f1`, which is in integration; compare before deciding. |
| `.claude/worktrees/agent-a296f6b551bbff059` | `live-plan-enrichment-worker` | 6 files changed (`model-runner.ts`, `server.ts`, `provisioner.py`, tests, sprint plan), none in integration |

## 3. This branch

Open a PR from `docs/sprint5-closeout` into integration. It holds the
Sprint 5 FINISHED box in the sprint plan, `docs/e2e-full-test.md`, and this file.

## 4. Prove the integration head before `main`

- CI green on the integration head.
- `scripts/preflight-deploy.sh`, without `--deploy`, runs every suite and
  deploys nothing.
- `CONTROL_PLANE_TEST_DATABASE_URL=postgres://postgres:test@127.0.0.1:5434/cptest_cpvm npm test --prefix control-plane/api`,
  expecting 0 failures. The "a burst of agent writes produces one prompt" test
  depends on order: if it fails, rerun that file alone before investigating.

## 5. Merge #40 (integration → `main`), with Dror's approval

**Done — 2026-09-13.** `d6d2e0e` merged PR #40 (`integration/sprint-5-plus` →
`main`). Independently confirmed from this checkout's git history
(`git log --oneline main`/`origin/main`). PR #76 (dispatch.ts never threaded
`botUsername`/login usernames into a live group message —
`companionIntroLoginUsernames()` in `chat-router.ts`) landed first. Full suite
green at the time: 1081 tests, 1075 pass, 6 skipped, `tsc` clean, all 6 CI
checks pass. #47, #64, #73 remained open at that point, not blocking.

## 6. Deploy `main` to the VM, with Dror's approval

The VM checkout still tracks `feat/cp-vm-compose`; move it to `main`
(`git fetch origin main && git checkout -B main origin/main`), then follow
"Running it" in `docs/control-plane-vm-deployment.md`:
1. build `api`, `worker` and `agent-runtime` at the rev;
2. set `KINERARY_REV` in `/opt/kinerary-deploy/vm.env`;
3. `up -d --wait api worker interview-mcp companion-mcp`;
4. `control-plane/deployment/vm-relay-restart.sh`.

*Done when:* every `kinerary-cp-*` container runs the rev, `readyz` is ready,
the relay's `relay.bot_identity` is `Kinerary_bot`, and there are no `409`s.

**Reported done by Dror 2026-09-14; independently re-verified 2026-09-15 by
SSH** (`ssh -i ~/.ssh/id_ed25519_kinerary_cp debian@192.168.0.45` — `readyz`
is loopback-only on the VM, not reachable from a Mac shell directly, so this
needs SSH, not `curl` from the Mac). Confirmed on the VM: `/opt/kinerary` on
`main` @ `aa61f6e` (= `origin/main` HEAD at check time, "Merge PR #79"),
`vm.env`'s `KINERARY_REV` matches, every `kinerary-cp-*` container running
that tag (~9-10h old at check time), `readyz` reports ready with 51
migrations, relay log shows `bot_identity=Kinerary_bot`, `polling: true`,
zero 409s in the last 300 lines. All of this step's own done-when criteria
are met, checked directly rather than taken on Dror's word.

## 7. Run the full E2E: `docs/e2e-full-test.md`

1. **A:** `--scenario all --auto --teardown`, with provisioning on only for
   the run. *Done when:* all three scenarios are `green` and `e2e exit 0`.
2. **B:** hand Dror the `vm-manual-test.sh --wait-minutes 60` link and stop;
   he drives it and reports back.
3. Write `docs/test-reports/vm-e2e-<date>.md`.

**Reported done by Dror 2026-09-14; only partially corroborated 2026-09-15,
not confirmed.** `control_plane.trips` on the VM shows a dense burst of test
trips created and torn down through 2026-09-14, slugs matching the documented
scenarios, ending in a clean batch ~18:21–19:25 UTC — consistent with a real
run. But **no `docs/test-reports/vm-e2e-2026-09-14.md` (or any date past
09-13) exists anywhere** — checked git history on every branch, every
worktree, and the VM's own checkout. The only committed report is
`vm-e2e-2026-09-13.md`, against an earlier revision (`39ba81e`, before
`aa61f6e`). So: activity looks real, but sub-step 3 (write the report)
genuinely was not done. Scenario B is inherently unverifiable from server
state alone. **Someone still needs to write
`docs/test-reports/vm-e2e-2026-09-14.md`** before this step is actually done.

## 8. First real user, once steps 6–7 pass

Dror's plan: when `main` is deployed and the E2E is concluded, a signup link
goes to a **new real user**. That is Dror's call and his to send. Before
generating one, check that provisioning is back off, no test trip is still in a
build, and the relay is on `@Kinerary_bot`. Remember it is a real family's data
from then on: teardown refuses past `ready_private`, and nothing about them goes
into the repo.

**Reported done by Dror 2026-09-14; not independently verifiable from this
environment, by design** — no LAN/VM access here beyond the SSH path above,
and this step is specifically about a real family's private data, which
should not be inspected or reproduced in a repo checkout regardless. One
non-identifying data point: a new `draft`-state trip appeared in the VM's
database 14 minutes after the last E2E teardown on 09-14, untouched since —
consistent with, but not proof of, a link having been sent. Its
destination/chat-id/contents were deliberately not inspected.

## 9. Clean-up, only on Dror's word

- **Old VM drafts:** six drafts from 2026-09-11/12, never provisioned.
  Remove them with `vm-teardown-trip.sh --trip <id> --execute`:
  `trip_dd44ea101db94375cf59c6382142b51c`, `trip_f149ff16532ceb98c73fa72be9ef44c6`,
  `trip_cfc815febadfc7af4fa4f7ba82bff9c9`, `trip_2c52e40d052fe892444dc1d82b874026`,
  `trip_da01f51dde38dc5cba167fc427ec2016`, `trip_2f51d6bd9a6a55de83b339fac1e5694a`.
- **Bot-swap backups:** `~/kinerary-deploy/secret-backups/` (Mac),
  `/opt/kinerary-deploy/secret-backups/` (VM), and
  `~/.hermes/profiles/trip-intake/.env.bak-20260913-botswap`.

## Follow-ups that did not block the sprint

- **#65:** a new companion's first reply carries Hermes's Codex auto-compaction
  notice; the companion template lacks `compression.codex_gpt55_autoraise_notice: false`.
- **#67:** asked to "update the site", the companion re-adds plan items that
  already exist; `add_plan_item` has no duplicate guard.
- **#68:** plan items about a neighbourhood or several places get no map link.
- **#69:** show each place's English name in parentheses on Hebrew items.
- **No issue yet:** `vm-manual-test.sh` switches provisioning off when its wait
  expires, even while the person is still in the interview, so a late
  confirmation starts a build that fails at once. Keep waiting while the
  session is active.
- **No issue yet:** `control-plane/api/test/interpret.test.ts` (already public)
  contains a real booking reference, a family member's name and a hotel. Replace
  them with invented values.
- **The Mac relay** needs `d1cd907` (a reply in a supergroup is not a forum topic)
  whenever the Mac stack is next updated.
