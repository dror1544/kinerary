# Regression plan: PR #234 (`464e56c`), #225 items 7, 8, 9 and F-b, relay send hardening

**Verdict: NOT SUFFICIENT to merge #234 at `464e56c`. It becomes sufficient with the round 2 now in the PR worktree, once that is committed and CI is green on it.** CI on `464e56c` is green: "TypeScript API" job 108403896839 read `# tests 2003 / pass 1997 / fail 0 / cancelled 0 / skipped 6`, 12:26:52→12:40:45Z. That is 13.9 min, 66 s under the old 15-minute wall clock. The suite is still missing one test, for a case this PR makes worse:
- **The unpinned regression.** A document disagreement that Telegram refuses **for good** (a 400) is now un-named and asked first again on every turn. Its un-naming is at `poller.ts:4476-4481`, and the "spoke" answer comes from `:2011-2012` via `:4612`.
- **Its effect:** the organizer's every message ends in the same refused ask, and **no later question or summary is ever sent**. Before #234, the ask was recorded regardless, so it cost one silent turn and the interview went on.
- **The only conflict test is the transient one** (`typed-changes-integrity-db.test.ts:1831`).
- **Round 2 targets exactly this.** The PR worktree holds uncommitted round-2 edits, read at 12:4xZ: `skipOnPermanent`, plus two tests labelled "round 2 (R1)". So the adversarial review appears to have found it too. I read the source half of those edits, not the tests, and I assess `464e56c` only.
- **Everything else that decides whether the organizer hears a step has a test that fails without it:** un-naming, the floor handed back, the backoff gate, the retry on the tick, the 8-attempt bound, the summary, the nomination, the recovery. Of the timeout's verdict I measured 11 of 16 mutations caught (§1).
- **Unpinned but not blocking:** the boundary re-raise call site (`:4645`; fold its test into round 2, §8.2), the backoff *values*, `SPOKEN_SINCE`, the abort signal, and a `.slice` cut in the item-7 edit.
- **Not deployable as it stands either. One finding changes what the live trips' families see.** The relay now answers a companion send with the error `"TIMEOUT"`. The Hermes checkout I could read (the Mac's, `ab0d98414`) treats that word as a formatting failure and re-sends the reply as `(Response formatting failed, plain text:)` plus the text. So one slow Telegram call can show a family the same reply twice. The fix is one line in `connector.ts`, about 15 min with a test. It should land before Release A, cheapest in this round 2 (§4.3, §8.1).
- **Deploy-day guard:** #234 cannot block **Release A's** own interview guard, which reads what the *old* relay wrote. After Release A, one retry episode blocks a guarded restart or rollback for **at most about 4 minutes**, then clears. It blocks indefinitely only while Telegram keeps failing *and* the organizer keeps writing (§3.3).

Assessed by `regression-planner`, 2026-09-26, branch mode, local.
- I ran tsc and the non-DB tests, and mutated the non-DB halves on a scratch copy.
- I did **not** run any DB suite (brief; 5433/5434 untouched).
- No SSH and no production read. Fleet facts are carried, with their source.
- Nothing deployed, nothing committed. The adversarial review (round 1) is not duplicated here.

## What this PR changes about the #230 plan

This plan is additive to `regression-plan-2026-09-26-pr230-typed-change-pre-deploy.md`. That plan's §5 D, D12, D13, G, F and H all stand.

| #230 plan item | After #234 |
|---|---|
| §9 "outside" **7** (`poller.ts:1278` cut in code points) | **Built.** `suggestionConfirmedText` → `cutWhole` within 3000 UTF-16 units (`poller.ts:2014-2027`). The code-point regression is pinned. A plain `.slice` is **not** pinned (§1, C1) |
| §9 **8** (no request timeout; the plan proposed ~15 s) | **Built for `post` at 10 s** (`telegram-api.ts:91`, `:231-303`). The developer chose 10 over 15 so that hang + 429 wait + hang = 23 s stays under Hermes' 30 s outbound wait. `getUpdates` (`:501`) and the **file byte download** (`:468`) are still unbounded (§6) |
| §9 **9** (`sendNextStep` / `askOpenConflict` record a send whose `ok` nobody reads) | **Built, and more than proposed.** It un-names and hands back as before, and adds a per-process retry with backoff, because the stall watchdog never fires on the interpret path (PR body, D2; confirmed at `advanceRouterOwnedQuestions`, `poller.ts:3699`, which scans `state = 'interviewing'` only) |
| §8.2 `chat_kind` on `telegram_api.rate_limited`; §8.3 pin the displaced-prompt overwrite | **Not done**, and not in this brief. Still open |
| §8.5 a 429 mode in `tools/fake-telegram.ts` | **Worth more now.** One fault mode (429 / hang on the Nth `sendMessage`) would exercise #230's in-call wait *and* #234's step retry end to end, through the real client and the real tick (§5 E) |
| Release A: D, D12, D13, G | Unchanged. #234 adds **no strings** (`intake-copy.ts` is not in the diff). D14 (negative checks) rides the same walk (§5) |
| F (fleet probes) | Add F2: read the **VM's** Hermes image for the two functions §4.3 depends on |
| H (log read after the upgrade) | Add five relay lines and one Hermes line (§5 H) |

## 1. Change set, and what pins it

| PR | Head | Base | Files |
|---|---|---|---|
| #234 `fix/225-relay-send-hardening` | `464e56c` (one commit) | parent `72c4d69` (#230's merge). The tip is now `dde2218` | 6 files, +801/−50, all under `control-plane/api`. `src/`: `relay/telegram-api.ts`, `relay/poller.ts`, `chat-router.ts` (only `export`s `cutWhole`). `test/`: `telegram-api-failures`, `relay-poller`, `typed-changes-integrity-db`. **No migration** |

- **Tip drift.** `72c4d69..dde2218` is #233 (CI timeout 15 → 30) and #232 (docs). `git diff --stat 72c4d69 dde2218 -- control-plane/` is empty. `git merge-tree --write-tree dde2218 464e56c` gives `b279e3a`, exit 0.
- **The CI run predates #233.** Run 36241909300 was created at 12:26:13Z; #233 merged at 12:28:03Z. So this run still had the **15-minute** wall clock. It finished in 13.9 min, green. The next run gets 30 minutes, and round 2 adds DB tests, so a slow runner could cross 15 minutes.

**What pins each behaviour.** "Pure" means measured: I mutated a scratch copy and ran the five non-DB files (`telegram-api-failures`, `relay-poller`, `telegram-api-root`, `telegram-escape`, `chat-router`). Baseline: 74 pass, 0 fail, 57 DB tests skipped, 2.3 s; tsc clean in 3.0 s. "Read" means a DB test I read but did not run.

| Behaviour | Where | Test that fails without it |
|---|---|---|
| A call is bounded at `timeoutMs` | `telegram-api.ts:231-258` | **Pure.** Timer never fires: file cancelled. No race (signal only): 6 cancelled |
| A timeout is transient, not retried, reports `"TIMEOUT"`, and logs `call_timed_out` with the method only | `:286-292` | **Pure.** Marked permanent: 3 fail. Error text carried: 4. Retried once: 3. Reported as NETWORK: 3. Log line removed: 2 |
| 10 s stays within `[5 s, (30−3)/2 s)` | `:91` | **Pure.** 15 s: 1 fail |
| **The abort signal is passed to `fetch`** | `:252` | **None. Pure: removing it gives 0 fails**, because the race alone satisfies every test. In production the signal is what cancels the socket. Without it, a timed-out request keeps running, can still deliver after we have reported failure (a duplicate once the step is retried), and holds a connection |
| The body read is raced too | `:257` | None (0 fails). Covered in production by the signal, which undici applies to the body as well. Only matters together with the row above |
| The timer is cleared | `:302` | None (0 fails). Harmless: a stray 10 s timer aborts a controller that is already finished |
| Item 7: the edit cuts on whole characters within 3000 units | `poller.ts:2024-2027` | **Pure.** Code-point cut: 1 fail. Budget 4090: 1. **`.slice(0, 3000)`: 0 fails.** The fixture is 3000 × 🎌, whose pairs all start on even offsets, so a plain slice never splits one. An odd-length prefix ("a" + emoji) would catch it. Effect if it regressed: Telegram refuses the edit (a 400), the old message keeps its buttons, and the answer is already stored. Cosmetic |
| F-b: a failed post-send read degrades to `covered` | `poller.ts:2427` | **Read.** "#225 F-b" test: `armedCrash` throws on the session read after the preview is delivered. It asserts `pc:` is recorded and a typed "yes" applies |
| A step is named before the send, un-named after a refusal, with the floor back to the machine | `deliverStep` / `stepNotDelivered`, `poller.ts:4426-4497` | **Read.** Item 9, tests 1, 3 and 6 assert `lastPrompt` restored, `awaiting` = machine (transient) or person (400), and the log |
| `sendNextStep` stays quiet during the backoff | `:4566-4567` | **Read.** Test 1 "not hammered": an immediate second tick sends nothing. This pins "delay > 0", not the delay's value |
| The retry runs on the deliver tick | `:5139` | **Read.** The "wired" test runs `startTripBotPoller` with a 20 ms base |
| At most 8 attempts, then `step_send_abandoned`, and the floor goes to the organizer | `:4484-4488` | **Read.** It asserts exactly 8 sends, `awaiting` = person, and 1 abandoned line |
| The summary is retried (the tick scan never does that) | `retryFailedSteps`, `:4505-4529` | **Read.** The SUMMARY test, and the wired test |
| A nomination is spent only once delivered | `:4927`, `:4944-4948` | **Read.** The "first optional question" test |
| A transient failure returns true, so no "didn't follow" | `:4942` | **Read.** The typed-message test |
| `askOpenConflict` goes through `deliverStep` | `:2011` | **Read.** The conflict test |
| **A disagreement refused FOR GOOD (a 400)** | `:2011-2012`, `stepNotDelivered` `:4476-4481`, caller `:4612` | **None, and it is a regression.** `deliverStep` un-names `cfl:` and `askOpenConflict` still returns true, so `sendNextStep` stops there. The next pass finds the conflict un-named and asks it first again, is refused again, and says nothing else. Only the transient case is tested (`:1831`). Round 2 (uncommitted) adds `skipOnPermanent` and two R1 tests |
| `recoverStalledInterviews` records only what arrived | `:3603-3617` | **Read.** The recovery test |
| **The boundary re-raise goes through `deliverStep`** | `:4645` | **None.** No test refuses the `beforeWeFinish` message. Reverting this call site to record-then-send would bring item 9's silence back for a required answer re-raised at the boundary, and every test would still pass |
| **The backoff schedule** (2 s base, doubling, 60 s cap) | `:4396-4406` | **None.** Every test waits with `LATER()` (+1 h) or a 20 ms base. A constant 2 s would pass, and it would spend all 8 attempts in about 16 s, inside a 30 s flood-wait |
| **`SPOKEN_SINCE`:** after someone else spoke during the failed send, leave their prompt and the floor alone | `:4470-4477` | **None.** Without it, a failure would un-name another speaker's prompt and hand the floor back, which risks a duplicate question. The window is one in-flight send (≤ 10 s now) |
| Retry-record cleanup when the session is unreadable; `step_retry_failed` | `:4515-4527` | None. Memory and log only |
| `permanent` on `stalled_turn_recovery_failed` | `:3612-3615` | None. A log field |

The developer reports 18 mutations, all caught. I did not see those runs. Their list maps onto the "Read" rows, and the gaps above are not on it.

## 2. Risk table

| Change | Surface (§2 row) | Blast radius | Migr. | Compat. | Risk | Test | Min | Batch |
|---|---|---|---|---|---|---|---|---|
| 10 s bound on every relay Bot API call | `api/src/relay/`, relay restart | **Every** `post` the relay makes: the interview, taps, the companions' replies and edits through the connector, `getMe` / `setMyCommands` at boot, `getFile` metadata. Not `getUpdates`, not file bytes | no | **Hermes reads the new error word as a formatting failure** (§4.3) | **medium**: live families | pure (pinned, except the signal) | 0 | isolated: H + the Hermes log |
| Step retry with backoff (item 9) | relay | interpret-path interviews only: router steps in unconfirmed, unexpired sessions | no | none | low–medium: a new in-memory state per process, and it interacts with the restart guard (§3.3) | DB (read); 3 gaps | 0 | D14 + H |
| `askOpenConflict` through `deliverStep`; recovery | relay | interviews with a document conflict; agent path | no | none | **high for that case at `464e56c`:** a 400 on the conflict message stops the interview with no way out but expiry. It needs a content-dependent 400 (long document values or a filename in the text), so it is rare. Fixed in round 2 | DB: transient only; permanent **unpinned** | 0 | — |
| Item 7 edit cut | relay | a confirmed document suggestion with a label over 3000 units | no | none | low (cosmetic) | pure (partly) | 0 | — |
| F-b `.catch` | relay | a DB read failing just after a preview | no | none | low | DB (read) | 0 | — |

**Where the client runs** (re-read today): `new HttpTelegramClient` is constructed once, in `relay/server.ts:153`. That one client feeds the poll loop, the deliver loop and the connector. `retryFailedSteps` keys its record on that client (`poller.ts:4385`, a `WeakMap`), so it lives and dies with the relay process.

## 3. Migration and compatibility

1. **No migration.** No snapshot rehearsal, and no expected noise from `migrations.test.ts`.
2. **Nothing new is persisted.** The retry record is in memory. The DB writes are the same `last_prompt` / `awaiting` / `pending_ask` writes as before, in a different order. A code-only rollback to #230 is **compatible both ways**. A session left `awaiting='machine'` by a failed step is picked up by #230's tick scan while `state = 'interviewing'`.
3. **The restart guard (brief item 3).** All three guards run the same query: `state <> 'confirmed' AND awaiting = 'machine' AND awaiting_since > now() - interval '5 minutes'`. They are `scripts/relay-restart.sh:39-44` (the Mac), `vm-relay-restart.sh:51-56` (the VM) and `vm-release.py:850-859` (`guard_interview`). Only the Mac script also has `expired_at IS NULL`, a small pre-existing difference.
   - **During a retry episode**, every transient failure calls `markAwaitingMachine` (`poller.ts:4494`), which resets `awaiting_since`. Each retry attempt's `takeFloor` sets `person` while its send is in flight.
   - **The abandonment and a 400 leave `awaiting = 'person'`**. They do not call `markAwaitingMachine`, so the guard clears **at once**. The PR body's "about 3 minutes plus 5" overstates it: there is no 5-minute tail.
   - **Worst case, one episode**, derived from the code and not measured: the gaps after failures 1–7 are 2+4+8+16+32+60+60 = **182 s**. If every attempt is a 10 s timeout, add 6 × 10 s, plus 0.7 s tick granularity each. That is about **3 to 4¼ minutes**, then clear.
   - **Indefinitely?** Only if something re-arms it. Each organizer message during a persistent failure starts a fresh 8-attempt cycle. A DB error inside the retry sets `notBefore = 0`, so it retries every tick. But the floor is then `person` (set by `takeFloor`), so that case does not hold the guard. With no human input, **no**.
   - **Release A itself is not affected.** `kinerary-cp-release upgrade` runs `guard_interview` at step 2 (`vm-release.py:1488`), while the **old** relay, which has no retry machinery, is still running. At step 4 it restarts the relay with `vm-relay-restart.sh --force-live` (`:1246`), so the script's own guard does not run again. The first guarded restart that #234 can affect is **after** Release A: a relay-only restart, `vm-interview-runner.sh`, the next upgrade, or **a rollback of Release A** (`guard_interview` at `:1633`).
   - **Override:** `--force-live` on each tool. It is refused through the trip-monitor gate (runbook, "Refused through the gate"), so it is a person's call on the VM.
4. **Two producers:** not applicable. The client change applies to both interview paths and to companions alike.
5. **Confirmed and expired sessions get nothing new.** Every `deliverStep` is preceded by `takeFloor` (`:2005`, `:4639`, `:4937`). `claimFloor` requires `state <> 'confirmed' AND expired_at IS NULL` (`interview.ts:2023-2031`), and so does `markAwaitingMachine` (`:2001-2011`). So a confirmed session can never get a `deliverStep` send or a retry entry. A retry entry whose session has since expired or been confirmed is dropped on its next due pass: `sendNextStep` cannot take the floor, records nothing, and the entry is deleted (`:4524`).

## 4. Live-fleet impact

**Not read today** (brief: no SSH). Carried from the #230 plan §4, which carried the 2026-09-25 fleet MCP read:
- Two `ready_private` trips: `orlando-florida-2026` (ends 1 Oct) and `japan-tokyo-hakone-kyoto-osaka-2026` (ends 3 Oct).
- The VM is at schema `0051` and runs no sprint-6 code.
- Provisioning is on for a real organizer.

#234 reaches no one on merge. It reaches the VM only through `sudo kinerary-cp-release upgrade` (Release A). That tool restarts the relay with `--force-live`.

### 4.1 Who feels it, and when

| Who | What they feel | When |
|---|---|---|
| Both live trips' families | **The relay restart**, unchanged from #230's plan. The bot pauses; the relay waits up to 40 s (`RELAY_GATEWAY_WAIT_SECONDS`) for companions to reconnect; messages wait at Telegram. The runbook costs a rollback at "~1 min bot pause". The upgrade gives the relay 120 s to report ready (`vm-release.py:1248`) | at the upgrade |
| Same | **Better:** a hung Telegram connection now costs every chat in the poll loop at most 10 s per call, where it used to cost undici's default, which the developer says is minutes. I did not verify that default | after the upgrade, rarely |
| Same | **Worse, in one case (§4.3):** a companion reply that Telegram answers slower than 10 s can arrive twice, the second copy prefixed "(Response formatting failed, plain text:)" | after the upgrade, rarely |
| The live trips' organizers | **Nothing from item 9.** Their sessions are confirmed (§3.5), so no retry entry can exist for them. A live-trip organizer who starts a *new* trip's interview gets #234 like anyone else, which is intended | — |
| The next real organizer's interview | A question or summary Telegram refuses for now arrives **2 s to 60 s later instead of never**. After about 3 minutes of failures, nothing more is sent until they write. A timeout on a send Telegram actually delivered produces a **duplicate question** 2 s later (the fail-safe direction) | first interview after the upgrade |
| Web and trip sites | nothing | — |

**Can companions trigger `deliverStep`?** No. It is reached only through `sendNextStep`, `askOpenConflict` and the boundary re-raise (`grep deliverStep(`: `:2011`, `:4645`, `:4942`), and all of them need an interview session's floor. Group chats and member DMs have no intake session. Companion replies go through `connector.ts:451` / `:504` and never touch the retry record.

### 4.2 A rate limit after the upgrade

- **Interview:** a 429 with `retry_after ≤ 3` is waited out in-call (#230). A longer one fails at once and is retried by the step backoff at 2, 4, 8, 16… s. The backoff **ignores `retry_after`**, so attempts inside a flood-wait fail again and each one spends one of the 8. A flood-wait longer than about 3 minutes abandons the step (§8.4).
- **Companions** (not changed by #234, noted because §4.3 shares the fix): a 429 above 3 s comes back to Hermes as "Too Many Requests: retry after N". Hermes classifies that as neither network nor timeout, so it also takes the plain-text fallback. That has been true since before #230.

### 4.3 The timeout versus the Hermes gateway (brief item 4)

**Is 10 s safe against the 30 s outbound wait?**
- **The number is.** A connector send is one or two `post`s: the second only after a *parse* error, which is a completed response. One `post` is at most 10 + 3 + 10 = 23 s. The realistic maximum for a send is therefore 23 s, under `_OUTBOUND_TIMEOUT_S = 30.0` (`~/.hermes/hermes-agent` `ab0d98414`, `gateway/relay/ws_transport.py:56`).
- **Theoretical 46 s:** a first `post` that ends in a parse error only after 23 s, followed by a second hung one. That needs two near-10 s answers in a row, so I discount it.
- **Caveat:** this is the Mac's checkout (2026-08-24). **The VM's Hermes image was not read.**

**The error word is not safe.** On a timeout the connector returns `{success:false, error:"TIMEOUT"}` (`connector.ts:499-501`), and `RelayAdapter.send` passes the error through unchanged (`adapter.py:1945-1949`). The final reply goes through `_send_with_retry` (`base.py:6612`). I ran the gateway's own classifier over the strings (`base.py:2769-2780`, `:5464-5481`):

| relay error | retryable | recognised as a timeout | Hermes then |
|---|---|---|---|
| `TIMEOUT` (new in #234) | no | **no** | **plain-text fallback**: sends `(Response formatting failed, plain text:)\n\n` + `content[:3500]` (`base.py:5605-5620`) |
| `NETWORK` (existing) | yes | no | retries twice, then sends "⚠️ Message delivery failed…" |
| `relay outbound timed out` (Hermes' own 30 s, the old behaviour on a hang) | no | yes | returns the failure, sends nothing more |
| `telegram call timed out` (a proposed mapping) | no | yes | the same as the row above: an honest "outcome unknown" |

- **The consequence.** Before #234, a hung call left Hermes waiting 30 s and then doing nothing (and the hung fetch might still deliver late). After #234, Hermes gets `TIMEOUT` at 10 s and immediately sends the reply again, labelled as a formatting failure.
- **If Telegram had delivered the first one** (slow answer, not a dead socket), the family sees the reply **twice**. If it had not, they see it once with a wrong label, and cut at 3500 characters.
- **The fix:** in the connector's `send` and `edit` cases, return `"telegram call timed out"` when `sent.error === TIMEOUT_ERROR`, with a connector test (§8.1). The alternative is to change `TIMEOUT_ERROR` itself, but the tests pin `"TIMEOUT"` and the word is also the internal verdict, so mapping it at the one boundary Hermes sees is cleaner.

**How the logs would show a wrong 10 s:**
- **Too tight:** `telegram_api.call_timed_out {method}` on a day with no Telegram incident, not bunched together. Paired on the Hermes side with "Send failed: TIMEOUT — trying plain-text fallback".
- **Too loose, or the bound not holding:** Hermes logging `relay outbound timed out` for a relay send. That means one action took over 30 s.
- **What cannot be measured:** no per-call duration is logged, and relay lines carry no timestamp. Use `docker logs -t` on the running container, before the next restart (#230 plan §2).

## 5. The plan

| # | Run | Command / where | Checklist | Min | Who |
|---|---|---|---|---|---|
| A | **Done.** tsc and non-DB tests at `464e56c` | scratch `git archive`, `node_modules` linked; `npx tsc --noEmit`; the 5 files | tsc clean; 74 pass / 0 fail / 57 skipped | 3.0 + 2.3 s (measured 12:3xZ) | — |
| A′ | **Done.** 16 non-DB mutations | `scratchpad/plan234/mutate.py` | 11 caught, 5 not (§1) | 80 s total (measured) | — |
| **B** | **Done, green on `464e56c`.** "TypeScript API" on the merge ref | CI run 36241909300 (full `control-plane/api` with its own Postgres) | 2003 / 1997 pass / 0 fail / 0 cancelled / 6 skipped | 13.9 (measured 12:26:52→12:40:45Z; `duration_ms 720976`) | nobody |
| B′ | **Owed:** B again on round 2's head (with §8.1/§8.2 if folded in). The new run gets the 30-minute limit | CI | same | ~14 | nobody |
| — | A real 429, 5xx or hang on a real bot | **Do not provoke.** Flooding `@Tripinterviewer_bot` risks a long flood-wait and proves only Telegram's behaviour; never `@Kinerary_bot`. `tools/fake-telegram.ts` has no fault mode. So this stays **fake-only** (A, the DB tests), plus E if built, plus H | 0 | — |
| D14 | *(new, rides the owed walk D on `@Tripinterviewer_bot`, Mac stack, no VM overlap, hard-rule-2 prompt)* **The new machinery does not misfire on a healthy bot** | during and after the walk: `grep -cE 'telegram_api.call_timed_out\|trip_bot.step_send_failed\|trip_bot.step_send_abandoned\|trip_bot.step_retry_failed'` on the Mac relay log for the run's window | 1. All four counts are **0**. 2. Every question and the summary arrived **once**; count `trip_bot.step_sent` per `prompt` and compare with the screen. 3. Tap "a few more questions" and check the **first optional question** arrives (the nomination now clears after the send). 4. With a document conflict on screen (it rides the #178→#217 document route), check it is asked once. A non-zero count on a healthy bot is a regression: a success being read as a failure. That is the one way #234 could hurt a normal interview | +3 (est.) | Dror |
| E | *(optional)* **End-to-end fault walk** on the Mac with `--auto` | add a fault mode to `tools/fake-telegram.ts`: refuse the Nth `sendMessage` with 429 `retry_after:30`, and hang the Mth past 10 s. Then `scripts/preflight-deploy.sh --deploy --auto --scenario multi --cleanup` (not `japan`: memory, fixture collides with the live trip) | relay log: `step_send_failed {"retry":true}` then `step_sent` for the same prompt within 60 s; one `call_timed_out`; the interview completes; no duplicate on screen except one allowed after the hang. Also covers #230's in-call wait (its §8.5) | ~30 dev + tens of minutes run (agent table; not measured) | a developer, then a hands-off run with approval |
| F2 | *(new)* The VM's Hermes, read-only | on the VM: grep the running Hermes container (name from the runbook) for `_OUTBOUND_TIMEOUT_S =` and `def _is_timeout_error` | confirms or corrects §4.3 for the image that actually runs. If `_OUTBOUND_TIMEOUT_S` < 23, the relay's bound is not the binding one (still safe: Hermes then reports ambiguous and does not retry) | ~3 | lead |
| H | After the upgrade, before any relay restart (extends #230's H) | `sudo docker logs -t kinerary-cp-relay-1 2>&1 \| grep -E 'telegram_api.(rate_limited\|call_timed_out)\|trip_bot.(step_send_failed\|step_send_abandoned\|step_retry_failed\|stalled_turn_recovery_failed\|floor_lost)\|change_(floor_taken_back\|displaced_moved\|show_failed\|dropped_unshowable)'`, plus the Hermes gateway log for `trying plain-text fallback\|relay outbound timed out` | See "Reading H" below this table | ~7 after the first real interview | lead |

**Reading H:**
- `step_send_failed {"retry":true}` followed by `step_sent` for the same session is **the fix working**.
- `step_send_abandoned` means Telegram failed that chat for about 3 minutes. Check the organizer is not stuck.
- `step_send_failed {"permanent":true}` means router content got a 400 (length or markup). File an issue.
- `reason:"SPOKEN_SINCE"` is a race. Fine if rare.
- `step_retry_failed` repeating about every 0.7 s means the retry loop is failing on the DB.
- `call_timed_out` with no incident is §4.3's "too tight".
- A Hermes `plain-text fallback` right after a relay `call_timed_out` is §4.3 happening. Expected until §8.1 lands.

**Batching:**
- D14 rides walk D. Its observables are counts in the log plus "once" on screen, which do not overlap D12's or D13's message order.
- Kept apart: B (the gate); the fault path (fakes, or E), because a real fault cannot be provoked; and §4.3, which is a cross-repo behaviour seen only in Hermes' log, so it is read in H and F2 rather than inferred from a walk.

## 6. Budget, and the carry-forward (brief items 5 and 6)

- **Merge (minimum):** round 2 committed with its R1 tests, then B′ green (~14 min, nobody present), plus a ~10-min delta check. B, A and A′ are done for `464e56c`.
- **Release A, in addition to #230's ~1.7 h with Dror plus the lead's time:**
  - §8.1: ~15 min dev + B′ (~14 min, nobody present).
  - D14: +3 min of Dror, riding D.
  - F2: 3 min, lead.
  - H: +2 min on the lead's H.
  - **Without §8.1 you are deciding to find out on a live family's chat** whether Telegram is ever slower than 10 s for them.
- **What E buys (~30 min dev + one hands-off run):** the only end-to-end proof that a refused step comes back through the real client and the real tick. Without it, that proof is the DB tests plus the first real 429 read in H.

| Carry-forward (developer's) | Blocks Release A? | Follow-up, and when |
|---|---|---|
| **`fetchFile` byte download has no timeout** (`telegram-api.ts:468`). It is awaited from `attachMedia` in `dispatch.ts:994/1043`, i.e. **in the poll loop**, for photos and PDFs sent to *companions*. That makes it item 8's class, with the live families as the exposure | No. Pre-existing on the VM today; #234 does not worsen it | **Yes, first of these.** `AbortSignal.timeout` of about 60 s plus the same race (~20 min with a hung-stub test). Before or with Release A if a developer is free, otherwise right after |
| `sendOptionalOffer` (`poller.ts:4103-4120`): records `optional_offer`, sets `offeredMore` and clears `pending_entry` **before** an unchecked send. If refused, the organizer sees nothing and the floor is theirs; their next message is read under an offer they never saw | No. One message per interview; #230 absorbs short 429s and #234 bounds hangs. Same silent class, though | **Yes, one issue with the next row:** "route `sendOptionalOffer` / `speakBoundary` through `deliverStep`, restoring `offeredMore` / `pending_entry` on failure" (~45 min + DB tests). After Release A |
| `speakBoundary` (`:4175-4192`): records its key, then an unchecked send. If refused, the confirmation is deduped | No | Same issue |
| `restateExpectation`, the pendingSay-alone send, `closeIdleInterviews` notices (`:3516-3547`): unchecked, record nothing, so there is no dedupe trap. A refusal is silent, and the next message works | No | One small issue: log `step_send_failed` on `!ok` so a refusal is at least visible (~10 min). Low |
| `recoverStalledInterviews` failure is not retried (agent path only; new sessions are interpret path) | No | Fold into the `sendOptionalOffer` issue, or leave. Low |
| `getUpdates` has no client timeout (the brief said not to touch it) | No. A long poll with Telegram's own `timeout` | Track it with the `fetchFile` issue: long-poll + 10 s |

**Order:** §8.1 lands (in this PR's round 2 or a one-line follow-up) → Release A → the `fetchFile` issue → the `sendOptionalOffer`/`speakBoundary` issue → the logging issue.

## 7. Go / no-go and the way back

- **Stop the merge:**
  - at `464e56c`, until the permanent-conflict case is fixed and pinned (round 2);
  - on any new head, until B is green on it;
  - if round 2 changes anything beyond `askOpenConflict` / `deliverStep`'s return type and its tests, until that delta is checked. A delta check is ~10 min: re-run A′ on the new head and read the diff.
- **Stop Release A (this PR's part)** if:
  - §8.1 has not landed, **and** Dror does not accept the duplicate-reply risk for the two live trips' remaining days (§9.1);
  - D14 shows any non-zero count or a duplicate question on a healthy bot;
  - F2 shows a Hermes that retries `TIMEOUT` (worse than §4.3).
- **Deploy-day line (brief item 3):** "At step 2 of `kinerary-cp-release upgrade`, a refusal saying 'an interview is mid-turn (chat X)' means a real organizer is mid-turn; #234 is not running yet. Wait 5 minutes and re-run `--dry-run`. **After** Release A (a rollback, or any later restart), a refusal can also be one #234 retry episode, which clears within about 4 minutes. If it is still refused after two re-runs 5 minutes apart, run `grep -E 'step_send_(failed|abandoned)'` on the relay log. Repeated failures mean Telegram is failing that chat, and a restart will not fix it: postpone. Use `--force-live` only after the organizer has been told."
- **Way back:**
  - Integration branch: `git revert -m 1 <merge>`.
  - VM: `sudo kinerary-cp-release rollback --dry-run`, then rollback. There is no migration, so the database is kept (runbook: "~1 min bot pause").
  - A rollback is itself a guarded restart. Expect the line above to apply.

## 8. What would reduce the risk (ranked by risk removed per minute)

0. **Commit round 2 with its R1 tests (in flight).** This is the merge condition. Everything below that touches code is cheapest folded into the same round, because one more B costs ~14 min with nobody present.
1. **Map `TIMEOUT` for Hermes in `connector.ts` (~15 min + B′).** In `send` and `edit`, return `"telegram call timed out"` when `sent.error === TIMEOUT_ERROR`. Add one connector test asserting the word Hermes sees. This removes the only behaviour change a live family can see. Fold it into the round 2 already in progress.
2. **Pin the boundary re-raise (~15 min + ~40 s for the integrity file alone; the file-time estimate is carried from #230's plan).** One DB test: a required answer deferred, everything else answered, `beforeWeFinish` refused for now, then asked after `LATER()`. This is the only item-9 call site with no test.
3. **Pin the abort signal and the backoff schedule (~10 min, pure).**
   - `stubHungFetch` records `init.signal` and asserts it was aborted.
   - Export `stepRetryDelayMs`, or assert `retry_in_ms` in `step_send_failed`, as 2000 / 4000 / … / 60000.
   - Both are measured gaps (§1).
4. **Honour `retry_after` in the step backoff (~20 min).** Use `max(backoff, retry_after)` when the refusal carries one. It needs `SendResult` to carry it through, so it can follow Release A.
5. **An odd-prefix label in the item-7 test (~3 min, pure):** `"a" + "🎌".repeat(3000)`. It turns the `.slice` gap into a failing test.
6. **E (optional):** only worth it if someone will run `--auto` before Release A anyway.

## 9. Decisions needed

1. **§8.1 before Release A, or accept the risk?** Accept the chance of a duplicated, mislabelled companion reply on the two live trips until they end (1 and 3 Oct), or hold Release A for a ~15-minute change. I recommend the change.
2. **Where §8.1–§8.3 land:** in #234's round 2 (one more B, ~14 min) or as a follow-up PR before Release A. That is the lead's call once the adversarial review reports.
3. The upgrade window, carried unchanged from #230 §9.2.

<details><summary>Evidence, 2026-09-26</summary>

- **The PR.** `git -C agent-a332973465f70c502 log`: `464e56c` on `72c4d69`, 6 files, +801/−50. `gh pr view 234` (12:3xZ): head `464e56c…`. Checks: Python worker, Web SPA, Kinerary suite, Modern trip SPA, Runtime gateway and Assess deployment risk passed. "TypeScript API" (job 108403896839) completed `success` at 12:40:45Z; its log reads `# tests 2003 / # pass 1997 / # fail 0 / # cancelled 0 / # skipped 6 / # duration_ms 720976.3`.
- **Timing.** Run 36241909300 was created at 12:26:13Z. #233 merged at 12:28:03Z. `72c4d69:.github/workflows/control-plane.yml:28` reads `timeout-minutes: 15`; `dde2218` reads 30.
- **The base.** `origin/integration/sprint-6` = `dde2218`. The `control-plane/` diff from `72c4d69` is empty. merge-tree gives `b279e3a`, clean.
- **Scratch.** `scratchpad/plan234/tree` (`git archive 464e56c control-plane/api`, `node_modules` symlinked from the PR worktree), run with `CONTROL_PLANE_TEST_DATABASE_URL` unset. Script `scratchpad/plan234/mutate.py`. Results (pass/fail/cancelled):
  - baseline 74/0/0.
  - Caught: T1 68/0/1; T2 68/0/6; T5 71/3/0; T6 70/4/0; T7 71/3/0; T9 71/3/0; T10 73/1/0; T11 72/2/0; C2 73/1/0; C4 73/1/0.
  - **Not caught:** T3 74/0/0, T4 74/0/0, T8 74/0/0, C1 74/0/0, C3 (4000-unit budget) 74/0/0, C5 (cut off by one) 74/0/0.
  - restored 74/0/0.
- **Read in full:** the `src/` diff; the `telegram-api-failures` and `relay-poller` diffs; the `typed-changes-integrity-db` diff (F-b, `RefusingTelegram`, and the 9 item-9 tests). Also: `advanceRouterOwnedQuestions`, `renderDueRouterPrompts`, `recoverStalledInterviews`, `closeIdleInterviews`, `sendOptionalOffer`, `speakBoundary`, `takeFloor`, and `interview.ts` `markAwaitingMachine`/`claimFloor`/`listMachineAwaitingChats`. On the connector side, `send`/`edit`; `server.ts:153-168`; `normalize.ts:358-369` and the `dispatch.ts` callers.
- **Guards read:** `scripts/relay-restart.sh:39-44`, `vm-relay-restart.sh:51-56`, `vm-release.py:850-859`, `:1456-1520`, `:1244-1250`. The runbook's "Upgrades and rollback".
- **Hermes** (`~/.hermes/hermes-agent` @ `ab0d98414`, the Mac's copy): `ws_transport.py:56`, `:814-826`; `adapter.py:1845-1949`; `base.py:2769-2780`, `:5464-5481`, `:5533-5620`, `:6612`. I ran the classifier over five strings in Python (table §4.3). **The VM image was not read.**
- **The PR worktree is dirty.** `git -C agent-a332973465f70c502 status` at 12:4xZ showed uncommitted edits to `poller.ts`, `telegram-api-failures.test.ts` and `typed-changes-integrity-db.test.ts` (+175/−17): round 2 in progress. Every line number and every mutation here is against the committed `464e56c`, extracted with `git archive`.
- **Not done:** any DB suite, SSH, a production read, a deploy, a commit. No other doc edited.
</details>

---

## Round 2 addendum (2026-09-26)

**Verdict: SUFFICIENT to merge #234 at `3826c34`, provided the "TypeScript API" CI job on its merge ref is green.** **CI on the merge ref, read 2026-09-26: all seven checks passed at `3826c34`, including TypeScript API (14m05s, under the 30-minute limit PR #233 introduced).**
- Every round-2 fix has a test that fails without it, including the first-round verdict's blocking regression.
- What round 2 leaves unpinned decides no delivery (item 2 below).
- The companion-side finding is closed.
- Release A still owes D14 and H, the only work left for this PR on the deploy side.

**Delta and method.**
- `git diff 464e56c 3826c34`: 7 files, +426/−31. The worktree is clean at `3826c34`.
- I ran tsc on a `git archive` copy: clean.
- The 6 non-DB files give 118 pass / 0 fail / 57 DB tests skipped.
- I ran 13 mutations of the non-DB parts (`scratchpad/plan234/mutate2.py`).
- DB tests I judged by reading.

**1. Does each fix have a test that fails without it?**

| Fix | Where | Test that fails without it |
|---|---|---|
| **R1: a permanently refused disagreement is skipped, not re-asked every turn** | `deliverStep` / `stepNotDelivered` skip branch, `poller.ts:4460-4468`, `:4500-4507`; recursion `:4643-4654` | **Read.** `typed-changes-integrity-db:1877` asserts the next question arrives on the same tick, `last_prompt = q:destination`, the turn is the organizer's, and there is no re-ask over 3 ticks. Each variant fails it: no skip (the key is un-named, so "spoke" and no question); keep the key but **do not hand the floor back** (the recursion reads `awaiting = person`, so `floor_held_by_person` and no question); no recursion (no question on this tick); skip on a transient failure too (the transient conflict test at `:1831` fails). `:1903` pins that the recursion reads a **fresh** view: a stale one would roll a failed question back to the pre-conflict prompt, and the retry would re-ask the disagreement |
| R5: the connector answers Hermes `"telegram call timed out"` on a timeout | `connector.ts:53-59`, `:523`, `:535` | **Pure.** No mapping: 2 fail. Send only: 1. Every error mapped: 2. `"telegram call timeout"`: 2. A phrase containing "network": 2 |
| R6: the boundary re-raise (my §8.2) | `:4687`, unchanged code, now tested | **Read.** `:1935` asserts un-named, owed, not hammered, then asked once. Reverting the call site to record-then-send fails "un-named" |
| R7a: the abort signal (my T3) | `telegram-api.ts:252` | **Pure.** 1 fail (it was 0 in round 1) |
| R2: the body read raced (my T4) | `:257` | **Pure.** 7 cancelled (it was 0) |
| R7b: the backoff sequence | `poller.ts:4415` | **Pure.** A constant 2 s, a cap of 120 s and a max of 6 each fail 1 |
| R7c: odd-offset emoji cut (my C1) | `:2024-2027` | **Pure.** `.slice`: 1 fail (it was 0) |
| R7d: `SPOKEN_SINCE` | `:4493-4499` | **Read.** `:1963` asserts that another speaker's `optional_offer` stays named and the turn stays theirs. Without the check, both assertions fail |
| R3: the wired-tick test sets its base before the failure | test only | Fixes a real 2 s wait the round-1 test depended on. Not a behaviour |

The mutation the brief names ("keep the key but do not hand the floor back", the lead's literal suggestion) is caught by `:1877` for the reason above. I reasoned that from the code; I did not run it (it is DB).

**2. Added with no failing-without-it test (none blocks):**
- **The `startsWith("cfl:")` guard on the recursion (`:4651`) and `skip && ours` (`:4468`).** Each is belt and braces for the other. Removing one alone is covered by the rest: a skipped-but-not-ours outcome finds another speaker's `last_prompt` and stops. Recursion is bounded: `nextOpenConflict` orders by `created_at, id` (`answer-provenance.ts:203`), so the re-read dedupes the same conflict.
- **`retries.delete` in the skip branch:** harmless. A due entry has `notBefore = 0` and never gates.
- **The timer cleanup** (my T8) and the `expired.catch` guard: 0 fails. Both are harmless, because both races attach a handler to `expired`.
- **One remaining behaviour, not a regression.** While a permanently refused disagreement stays open, **each later turn re-attempts it once** (one refused Telegram call and one `step_send_failed {"skipped":true}` line), then says the next thing. That is exactly how it behaved before #225. A later open disagreement is never offered while the refused one stays open, which is pre-existing ordering. Tracked below.
- **The comment at `telegram-api.ts:85-94`** says the longest `sendMessage` is "about 16 s plus round trips". That holds when round trips are fast. With each of the 3 answered calls taking up to just under 10 s, the bound is about 46 s, over Hermes' 30 s. That needs Telegram to answer slowly three times in one send. If it happens, Hermes reports "relay outbound timed out", which it treats as ambiguous and does not re-send, so it is safe. Not worth a change.

**3. Blast radius on the live trips after R5.**
- **What Hermes sees differently:** only a companion **`send`** or **`edit`** whose client call timed out. It now gets `"telegram call timed out"` at about 10 s, where it got `"TIMEOUT"` in round 1, or its own 30 s `relay outbound timed out` on a hang before #234.
- **Unchanged:**
  - Every other error passes through unchanged (`NETWORK` is still retried by Hermes; pinned at `relay-connector:404`).
  - `typing` ignores its result.
  - `get_chat_info` answers `CHAT_NOT_FOUND` on any failure, as before, only sooner.
  - `grep` finds nothing else in `src/` keyed on the old word; `TIMEOUT_ERROR` is used only in `telegram-api.ts` and the one mapping.
  - `assistantEvents.replySent` keys on `sent.ok`, not the string.
- **What a family could notice:** a companion reply held up by a hung call is not re-sent (no duplicate, no "formatting failed" label). If the cancelled request never reached Telegram, that one reply is missing, the same outcome as before #234 but after 10 s instead of 30. §4.3's "worse, in one case" row is **withdrawn**.
- **F2 is closed.** This is the lead's read, not mine: the VM's `hermes` container, image `kinerary-cp/hermes:ab0d98414-pbf43d580`, has `_OUTBOUND_TIMEOUT_S = 30.0` and the same classifier as the Mac checkout. The connector test mirrors that classifier (`relay-connector.test.ts:357-377`), so a Hermes upgrade that changes it must also change the mirror. That is a manual coupling, and the test's comment says so.
- **What remains of D14**, the checklist in §5 minus nothing: the four failure counts at 0 on a healthy walk, each step once, the first optional question after "a few more questions", and a disagreement asked once. Add a fifth: `grep -c '"skipped":true'` is 0 on a healthy walk. A skip on a healthy bot would mean a 400 on a disagreement's own text, which is a content bug.

**4. Deploy-day guard, with the refined figure.**
- **The claim:** 182 s of backoffs + 7 attempts × ~13 s = ≈278 s.
- **Confirmed as an upper bound, and slightly generous.** Router steps are sent without `parseMode`, so each is one `post`: at most a ≤3 s 429 wait plus a 10 s hang, i.e. ~13 s. But an attempt's send runs with `awaiting = 'person'` (set by `takeFloor`), and the guard only refuses `'machine'`. The 8th attempt ends in abandonment, which leaves `'person'`.
- **So the refusable window** runs from the first failure to attempt 8's `takeFloor`: 182 + 6 × 13 + ≤ 7 × 0.7 s of tick granularity ≈ **265 s**. ≈278 s is a safe ceiling.
- **Checklist line (replaces §7's):** "At step 2 of `kinerary-cp-release upgrade`, a refusal saying 'an interview is mid-turn (chat X)' is a real organizer, because the old relay is still running. Wait 5 minutes and re-run `--dry-run`. **After** Release A (a rollback, a relay-only restart, the next upgrade), a refusal can also be one #234 retry episode, which clears within **about 4½ minutes** (≤ ≈278 s). If it is still refused after two re-runs 5 minutes apart, run `grep -E 'step_send_(failed|abandoned)'` on the relay log. Repeated failures mean Telegram is failing that chat, and a restart will not fix it: postpone. Use `--force-live` only after the organizer has been told."

**5. What moved in §6/§8.**
- **§8.1 (TIMEOUT mapping), §8.2 (boundary pin), §8.3 (abort signal and backoff pins) and §8.5 (odd-prefix cut): done in round 2.**
- **Still open:**
  - §8.4, honouring `retry_after` in the step backoff (after Release A);
  - E, the optional fault walk;
  - #230's §8.2 and §8.3.
- **§9.1 is moot**, and §7's "stop Release A if §8.1 has not landed" is met.
- **Carry-forward table:** unchanged, with one row added. Order: Release A → `fetchFile` timeout → `sendOptionalOffer`/`speakBoundary` → logging.

| Added row | Blocks Release A? | Follow-up |
|---|---|---|
| A permanently refused disagreement is re-attempted once per later turn and holds back any later disagreement (pre-#225 behaviour, now logged as `skipped`) | No | Low. If `"skipped":true` appears in H, mark such a conflict un-askable (store-side), or render it shorter. Only with evidence |

**Budget now.**
- **Merge:** B on `3826c34`, ~14 min, nobody present.
- **Release A for this PR:** D14 (+3 min Dror, riding D) and H (+2 min lead). F2 is gone.

<details><summary>Round-2 evidence</summary>

- **Read in full:** `git -C agent-a332973465f70c502 diff 464e56c 3826c34`, the src diff and the four test diffs.
- **Scratch.** `scratchpad/plan234/r2` (`git archive 3826c34 control-plane/api`, `node_modules` symlinked), run with `CONTROL_PLANE_TEST_DATABASE_URL` unset. Results (pass/fail/cancelled):
  - baseline 118/0/0 (57 skipped).
  - Connector: K1 116/2/0; K2 117/1/0; K3 116/2/0; K4 116/2/0; K5 116/2/0.
  - Client: T3 117/1/0; T4 111/0/7; **T8 118/0/0**; **T12 (no `expired.catch`) 118/0/0**.
  - Poller: B1 117/1/0; B2 117/1/0; B3 117/1/0; C1 117/1/0.
  - restored 118/0/0. Measured 108 s total, 13:2xZ.
- **CI:** run 36244855493 on head `3826c34`; "TypeScript API" started 13:20:53Z (see the verdict line).
- **Not done:** any DB suite, SSH, a production read, a deploy, a commit. The text above this addendum is unedited.
</details>
