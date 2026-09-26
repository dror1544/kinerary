# Regression plan: PR #230 (`92e3cb6`), #225 items 1, 3 and 5 before the VM

**Verdict: SUFFICIENT to merge #230 into `integration/sprint-6`.** The merge gate is met. The "TypeScript API" CI job on the PR's merge ref finished green at 10:34:05Z: `# tests 1977 / pass 1971 / fail 0 / cancelled 0 / skipped 6` (job 108386332179, read from its log). That matches the developer's local figures.
- **Everything that decides what is stored, applied or dropped has a test that fails when it is removed.** I measured the pure half: 10 of 11 mutations were caught. The DB half I checked by reading. What nothing pins decides only which prompt comes back in one edge case, one HTTP-parsing detail, and log fields (§1).
- **This is not enough to deploy.** #230 is relay code, and it reaches no one until Release A (decision 28) upgrades the VM and restarts its relay. That still needs the walks owed since #199, plus two new checks from this PR (§5, D12 and D13). A 429 cannot be provoked safely on a real bot, so it stays a fake-only check plus a log read after deploy.
- **The largest blast radius is `telegram-api.ts`.** A 429 is now waited out in-call (≤ 3 s) for every Bot API call the **relay** makes. That makes the relay's poll loop about 3 s slower per rate-limited call. Before this PR, the same call lost the message. For this fleet that trade is right (§2).

Assessed by `regression-planner`, 2026-09-26, branch mode, local.
- I ran tsc and the non-DB tests, and mutated them on a scratch copy.
- I did **not** run a DB suite (brief; ports 5433/5434 untouched).
- No SSH and no production read. Fleet facts are carried, with their source.
- Nothing deployed, nothing committed.

## What this PR changes about the #199 plan

This PR is additive to `regression-plan-2026-09-26-pr199-round3.md` and its Round 4 addendum. That plan's §5 table, "owed before any VM deploy", still applies. Four things change:

| #199 plan item | After #230 |
|---|---|
| Decision 28 conditions for Release A: #225 items 1, 3, 5 | **Built and tested in #230.** Still owed: seeing them work in the walk (§5 D12, D13) and in the logs after the deploy (§5 H) |
| Round-4 §5 "watch the first real interview" | Add `interview.change_displaced_moved`, the `reply` field of `interview.change_floor_taken_back`, `permanent` on `interview.change_show_failed`, and `telegram_api.rate_limited` (§5 H) |
| Round-4 B3: "a refused re-show drops the change" | Narrowed. Only a **permanent** refusal (a 400) drops it. A 429, a 5xx, a network error or a throw keeps the change waiting and sends `change.sendFailed`. The round-4 B3 tests (400 → dropped) are unchanged in the diff |
| C: real-model run after round 4 (`typed-change-real-model-2026-09-26-after-round4.md`, 113/114, tree `72a288b`) | **Still valid.** `git diff d2958f4 92e3cb6 -- intake-copy.ts interpret.ts typed-changes.ts typed-changes-render.ts` is empty. The prompt, the parser and the renderer are untouched |
| G: Hebrew read | **No new or changed strings** (`intake-copy.ts` is not in the diff). One existing string appears in a new place (§5 G) |

## 1. Change set

| PR | Head | Base | Files |
|---|---|---|---|
| #230 (`gh pr view`, 10:29Z: `MERGEABLE`, not draft) | `fix/225-typed-change-pre-deploy` @ `92e3cb6` | parent `d2958f4`. The tip is `8f66492` | 7 files, +683/−46. `src/`: `relay/poller.ts`, `relay/telegram-api.ts`, `typed-changes-store.ts`, `chat-router.ts`. `test/`: `telegram-api-failures` (new), `typed-changes-integrity-db`, `chat-router`. **No migration** |

- **Tip drift.** `git diff --stat d2958f4 8f66492 -- control-plane/` is empty. `git merge-tree --write-tree 8f66492 92e3cb6` gives `ed8a17b`, exit 0.
- **Correction to the brief:** the #228 carry is *not* free of control-plane code. It changes `provisioning/adapters.py`: new nginx `location` blocks for `/mcp` and `/oauth/`, which is the worker's surface. That does not touch #230, but Release A's own plan has to count it.
- The CI run was created at 10:20:08Z, 60 s after #228 merged, so its merge ref is probably on `8f66492`. Either way the `control-plane/` tree is the same.

**What #230 does, and what pins it.** "Pure" means I measured it: mutated `scratchpad/plan230` and ran `telegram-api-failures`, `telegram-api-root`, `telegram-escape` and `chat-router` (baseline 59 pass, 0 fail, 23 DB tests skipped). "Read" means a DB test that I read but did not run.

| Behaviour | Where | Test that fails without it |
|---|---|---|
| A 429 with `retry_after ≤ 3` is waited out and retried **once** | `telegram-api.ts:186-195` | **Pure.** No retry: 4 fail. Retry twice: 1. Cap made exclusive: 1. Sleep in seconds instead of ms: 4 |
| Only a 400 is `permanent` | `:227-231` | **Pure.** Any 4xx permanent: 3 fail. NETWORK marked permanent: 1 |
| `permanent` carried out of `sendMessage` / `editMessageText` | `:286`, `:319-321` | **Pure**: 2 and 1 fail |
| The body's `error_code` wins over the HTTP status | `:227` | **None. Pure: `code = response.status` gives 0 fails.** No live effect: the VM's relay talks to `api.telegram.org` directly |
| `renderSuggestion` cuts on whole characters within 3000 UTF-16 units | `chat-router.ts:926-949` | **Pure.** `.slice`: 1 fail. Code-point count (`cutText`): 1 |
| Transient vs permanent in `showChangeDraft`: transient always says `change.sendFailed` and returns `send_failed`; only `refused` drops | `poller.ts:2389-2396`, `:2517` | **Read.** Item-5 DB tests × 4 failure kinds, plus the typed-"no" test; the 9th way-out state; round-4 B3 (400 still drops) |
| A preview records the non-`pc:` prompt it covers | `poller.ts:2376-2404`, `typed-changes-store.ts:281` | **Read.** Item 1, test 1: the draft is proposed under `pc:v1`, so it is displaced `null`. Without the record, settling it does not put the offer back, and `settled.at(-1) === essentialsDone` fails |
| On settling, what is on screen now (not `pc:`) wins over what the change displaced | `poller.ts:2462-2465` | **Read.** Item 1, test 2 (the offer lands *after* v2's preview) and test 3 (the summary is up) |
| The tell for too big, uneditable and not understood takes the floor back | `poller.ts:2664`, `:3309`, helpers `:2746-2779` | **Read.** Item 3 × 3: "the tell, once, as the last message" |
| **Overwriting a displaced prompt that is already set** (the guard is `covered !== draft.displacedPrompt`, not "only when null", which is what the audit proposed) | `poller.ts:2398` | **None.** Test 1 starts from `null`. Test 3's cover equals the stored value. Effect: in a stale-tap edge, a question key can replace `optional_offer`, and then the offer is not re-sent. The offer's own buttons are still above it (#225's "way out"). UX only |
| `answerThisMessage` loses the floor a second time → returns false. The not-understood branch then falls through to pacing | `:2772-2775` | none. A double race |
| Log fields for the post-deploy grep: `reply`, `displaced`, `permanent`, `retried` | several | **None.** Only "`telegram_api.rate_limited` is logged for a 429 above the cap" is asserted (`telegram-api-failures.test.ts:163`) |

The developer's mutation list (M1a, M1b, M3, M3c–d, M5a–c) maps onto the "Read" rows above. I did not see those runs. Checked by reading, each one's assertion does fail without its fix.

## 2. Risk table

| Change | Surface (§2 row) | Blast radius | Migr. | Compat. | Risk | Test | Min | Batch |
|---|---|---|---|---|---|---|---|---|
| In-call 429 wait (≤3 s, once) | `api/src/relay/`, relay restart | **Every Bot API call the relay makes**: interview, taps, group and DM routing to companions, companion replies, `my_chat_member` introductions, approval callbacks, boot `getMe`/`setMyCommands`. Not `getUpdates`, which uses its own `fetch` (`telegram-api.ts:442`) | no | none | medium: timing, fleet-wide | pure (pinned); log read after deploy | 0 + 5 | isolated (log) |
| `permanent` classification; drop only on a 400 | relay | interviews with a waiting change | no | none | low; fails safe (keeps, and tells) | DB (read) | 0 | — |
| Displaced prompt recorded; on-screen wins | relay + store | interpret-path interviews at the boundary | no | writes `displaced_prompt` in the same value set (§3) | low | DB (read); one edge unpinned | 0 | walk D12 |
| Tell takes the floor back | relay | interpret-path interviews | no | none | low | DB (read) | 0 | walk D13 |
| `cutWhole` in `renderSuggestion` | relay (sends from `chat-router.ts`) | a document label over 3000 units | no | none | low | pure | 0 | — |

**Where the client runs.** `new HttpTelegramClient` exists once, in `relay/server.ts:153`: the `relay` service, `node dist/relay/server.js` (`compose.vm.yml:194`). The API, the worker and the interview sidecar do not construct it. The signup approval poller (`telegram-poller.ts`) and the messaging adapter (`adapters/telegram.ts`) have their own clients, which are unchanged. `grep` over `control-plane/api/src`, `tools` and `control-plane/worker` agrees. That one instance goes to two consumers:
- **The poll loop** (`startTripBotPoller`, `server.ts:390`). `run()` handles each update in turn and awaits its sends (`poller.ts:4810-4870`).
- **The connector** (`server.ts:293`). Companion replies arrive as WebSocket frames, dispatched `void this.onFrame(...)` (`connector.ts:294`). They run **concurrently** and never stall the poll loop.

**Worst-case stall, derived from the code (not measured):**
- **Per call:** one round trip, then `min(retry_after, 3)` s, then a second round trip. A `retry_after` above 3 is not waited. It fails at once, exactly as before the PR.
- **Per `sendMessage` with `parseMode`** (connector only): two posts can each hit a 429, which is ≤ 6 s plus 4 round trips. The Mac's Hermes checkout (`ab0d98414`, `gateway/relay/ws_transport.py:56`) has `_OUTBOUND_TIMEOUT_S = 30.0`, so the gateway's future does not time out. I did not read the VM's Hermes image.
- **Per update in the poll loop:** 3 s × the number of rate-limited sends. The heaviest is a Confirm tap with a waiting change, at up to 5 messages (#225). If every one were limited, the poll loop could stall about 15 s. Every chat queued behind that tap waits too, including the live trips' group and DM messages to their companions. A realistic 429 in one private chat hits one call, which is 1–3 s.
- **Deliver loop:** typed interview bursts and router prompts (`poller.ts:4906`) run in a separate loop. It carries interviews only, so a wait there delays other *interviews*, not companions.

**Telegram's own timers:**
- Each tap is answered **before** its own sends (`poller.ts:424-431`), so a tap's spinner does not wait on its own 429.
- A tap queued *behind* a stalled update is answered late. Telegram does not document how long a callback may go unanswered. A late answer is refused with "query is too old", and `answerCallbackQuery`'s result is ignored anyway. The cost is a spinner, not lost data. I did not measure that window.
- `getUpdates` holds undelivered updates, so a stall only delays them.
- The floor watchdog is 30 s (`AGENT_FLOOR_SECONDS`, `interview.ts:2793`), well above a 3–15 s stall.

**Is a 3 s cap adequate?**
- For the case it targets, yes. A private-chat burst (the Confirm tap) asks for about a second. Group flood-waits (20 messages a minute per group) usually ask for tens of seconds, sit above the cap, and fail fast as before. Those `retry_after` distributions are Telegram's behaviour, not something I read.
- **Before:** every such 429 lost the message. **After:** at most 3 s of delay per hit. With 2 live trips and 1 organizer, the loop is rarely busy, so delay is the cheaper failure.

**What the logs would show, and a gap in reading them:**
- `telegram_api.rate_limited` carries `{method, retry_after, retried}` and **no chat or chat kind**. So "`retried:false` on a private chat, meaning the cap is too small" cannot be read off the line. Correlate it with the adjacent `trip_bot.*` / `interview.*` lines, or add a `chat_kind` field (§8).
- **No relay log line carries a timestamp.** `structuredLog` is bare JSON (`redaction.ts`). `vm-relay-restart.sh:66` archives with `docker logs` **without `-t`**. Stalls ("long gaps between polls", "cap too big") can only be measured on the running container with `docker logs -t`, and only before the next restart. There is no per-poll log line: `trip_bot.poll_backoff` fires only on failure.

## 3. Migration and compatibility

- **No migration**, so no snapshot rehearsal and no expected noise from `migrations.test.ts`.
- **Persisted:** `recordDisplacedPrompt` updates `intake_pending_changes.displaced_prompt` on a `pending` row of the same session (`typed-changes-store.ts:281-289`). The value is always a non-`pc:` `lastPrompt` key (`poller.ts:2398`). That is exactly the set `proposeChange` already writes at `poller.ts:2988` (`startsWith("pc:") ? null : lastPrompt`).
- **Rollback to #199's relay** (a code-only rollback of #230): the #199 relay reads `draft.displacedPrompt` only to pass it to `resumeAfterChange` (callers at `poller.ts:911`, `2444`, `2509`, `2587`, `2599`). It understands every key #230 can write. The result is what #230 intended: the covered offer comes back. **Compatible both ways.**
- **Rollback of Release A to what the VM runs today** (pre-sprint-6, schema `0051`, carried from the 2026-09-25 read): #230 adds nothing to round-3 §3. Count `pending` drafts first; the old relay orphans them.
- **Two producers:** not applicable. The agent path makes no drafts. The Telegram client change applies to both interview paths and to companions alike.
- **Confirmed sessions** (check requested by the brief). "Every entry point refuses a confirmed session" **still holds at `92e3cb6`**:
  - `proposeChange` returns `{kind:"confirmed"}` (`typed-changes-store.ts:187`).
  - `applyPendingChangeForChat` returns `SESSION_CONFIRMED` (`interview.ts:4066`), and so does `submitAnswerForChat` (`:3958`).
  - `markAwaitingMachine` / `claimFloor` both require `state <> 'confirmed'` (`interview.ts:2009`, `:2027`). So #230's new `retakeFloor` **cannot** take the floor on a confirmed session. `answerThisMessage` returns false there.
  - #230 changes none of those lines.

## 4. Live-fleet impact

**Not read today (brief: no SSH).** Carried:
- Two `ready_private` trips: `orlando-florida-2026` and `japan-tokyo-hakone-kyoto-osaka-2026` (fleet MCP read, 2026-09-25, via the round-3 plan §4).
- End dates: Orlando 1 Oct, Japan 3 Oct (brief).
- The VM is at schema `0051` and runs no sprint-6 code (same read).
- Provisioning is on for a real organizer (memory, since 2026-09-14).

**When it is felt.** #230 reaches no one on merge. The VM moves only through `sudo kinerary-cp-release upgrade <ref>` (runbook "Upgrades and rollback"). That tool migrates, then restarts api, worker and sidecars, then the relay through `vm-relay-restart.sh`. **A control-plane upgrade is not a site "release" promoted to `available`**, contrary to the brief's wording. No trip site is redeployed, and none needs to be.

| Who | What they feel | When |
|---|---|---|
| Both live trips' families (companions, via the relay) | **The relay restart.** The runbook says: "The bot pauses for the relay restart". The relay waits up to `RELAY_GATEWAY_WAIT_SECONDS` (40 s) for companions to reconnect, and messages wait at Telegram rather than failing. Rollback costs "~1 min bot pause". A companion reply **in flight at the moment of restart** loses its socket; how Hermes handles that I did not read, so assume that one reply can be lost. `vm-relay-restart.sh` guards interviews (`awaiting='machine'`), **not companion conversations** | at the upgrade |
| Same | **The 429 wait.** Companion replies (connector, concurrent): ≤ 3 s later instead of lost, when the `retry_after` is short. Their inbound messages: delayed while a rate-limited update is in the poll loop, in practice only while an organizer is interviewing at the same moment | after the upgrade, rarely |
| The live trips' organizers | **Not** the typed-change flow: confirmed sessions are refused everywhere (§3). #178/#217 corrections go through the same client, so they get the retry | after the upgrade |
| The next real organizer's interview | All of #230 (items 1, 3, 5), plus #199 underneath it | the first interview after the upgrade |
| Web and trip sites | nothing | — |

**Choosing the window** (my inference: time zones from the destinations, dates from the brief):
- Japan's night (22:00–08:00 JST) is 13:00–23:00 UTC. Orlando's night (22:00–08:00 EDT) is 02:00–12:00 UTC. **There is no hour when both families are asleep.**
- If Release A can land **2 Oct**, Orlando has ended. Then 14:00–20:00 UTC (23:00–05:00 JST) touches no active trip.
- Before that, the least bad slot is about 13:00 UTC: Orlando at breakfast, Japan at 22:00.

## 5. The plan

| # | Run | Command / where | Checklist | Min | Who |
|---|---|---|---|---|---|
| A | **Done.** tsc and the non-DB tests at `92e3cb6` | scratch `git archive`, `node_modules` linked from the PR worktree; `npx tsc --noEmit`; `node --import tsx --test` on the 4 files | tsc clean; 59/59 (23 DB tests skipped) | 2.7 s + 1.8 s (measured 10:2xZ) | — |
| A′ | **Done.** 11 mutations of the pure behaviours | `scratchpad/plan230/mutate.py` | 10 caught, 1 not (body `error_code`), §1 | ~2 s each (measured) | — |
| **B** | **Done, green.** "TypeScript API" on #230's merge ref | CI (full `control-plane/api` with its own Postgres) | 1977 / 1971 pass / 0 fail / 0 cancelled / 6 skipped | 13.9 job, of which 11.7 tests (measured: 10:20:12→10:34:05Z, `duration_ms 700474`) | nobody |
| D12 | *(new, #225 item 1)* A covered offer comes back. **Rides the owed walk D** on `@Tripinterviewer_bot` | Mac stack from the merged tree; hard-rule-2 prompt; no VM run overlapping | Answer every required question, so the offer is up. Type a change (preview v1). Type a follow-up about **another** list and tap v1's **Yes** within ~5 s: the model p50 is 6.2 s (real-model run). Expect "Done", the offer, then v2's preview. Settle v2 → **the offer is the last message**, and its buttons work. Log: `interview.change_floor_taken_back {"reply":"change_preview"}`, `interview.change_displaced_moved {"displaced":"optional_offer"}`. If the tap misses the window, try once more | +8 (est.; 2 tries) | Dror |
| D13 | *(new, #225 item 3)* A refusal is answered while a tap wins | same walk | With v1 up, type a follow-up the model should find unclear about an answered list (for example "move it a day later" with two stops held) and tap v1's Yes during the read. Expect the tap's "Done" and next step, **then** the not-understood reply, once. Log `…taken_back {"reply":"change_not_understood"}`. "Uneditable" needs a list saved in a mixed shape (`blocked.unsupportedShape`, `typed-changes-store.ts:153`) and "too big" needs about 20 long stops, so neither can be reached by hand. A real model may also answer with a picker instead. In both cases the item-3 DB tests are the evidence, and that is fine | +5 (est.) | Dror |
| — | A 429 on a real bot | **Do not provoke.** Flooding the test bot's token risks a flood-wait of tens of seconds or more on `@Tripinterviewer_bot` and proves only Telegram's behaviour. Never on `@Kinerary_bot`. `tools/fake-telegram.ts` has no 429 mode (`grep 429` is empty). So this is **fake-only** (A, plus the item-5 DB tests), plus H | 0 | — |
| D | The rest of the owed walk (round-4 §5 D1–D11) and the #178→#217 document route, unchanged by #230 | as in the round-3 plan | as there | 25 + 20–40 (carried est.) | Dror |
| G | Hebrew read. **No new strings** (verified). Read one pair in context: on a Confirm tap under a *transient* failure, `changePendingBlocksConfirm` is now followed by `change.sendFailed` ("לא הצלחתי להראות לכם את השינוי עכשיו, אז הוא ממתין…"). Before #230 it was `change.droppedUnshown` | `intake-copy.ts:784`, `:857` | the pair reads right together | +1 on G's ~25 | Dror |
| F | Fleet probes (round-3 §4, still unread), plus the open interviews and the live trips' active chats at the window | read-only fleet MCP | as there | ~10 (est.) | lead |
| H | After the upgrade, before any relay restart | `sudo docker logs -t kinerary-cp-relay-1 2>&1 \| grep -E 'telegram_api.rate_limited\|change_floor_taken_back\|change_displaced_moved\|change_show_failed\|change_dropped_unshowable\|trip_bot.floor_lost'` | `rate_limited` with `retried:false` on interview chats (correlate by neighbours) → the cap is too small. Several `retried:true` bunched in one poll → measure the `-t` gap. `change_show_failed {"permanent":false}` followed by `change_dropped_unshowable` → a regression | ~5, after the first real interview | lead |

**Batching.** D12 and D13 ride the one Mac walk that #199 already owes; the observables are distinct messages in a different order. Kept apart: the 429 (a silent timing change, fake-only plus H) and B.

## 6. Budget

- **Merge (minimum):** B, A and A′ are all done. Nothing more is owed for the merge.
- **Release A (in addition, owed anyway by decisions 17 and 28):**
  - #230 adds **~14 minutes of Dror's time** (D12, D13, the G pair) to the ~1.7 h already owed with him, plus 5 minutes of H for the lead.
  - D12 is the only proof that item 1 works against real Telegram timing. Without it, you learn about it on the next organizer's boundary offer. In the worst case they walk optional questions they did not choose, with the offer's buttons still there.

## 7. Go / no-go and the way back

- **Stop the merge** only if the branch moves. A new commit on #230 needs B again.
- **Stop Release A (this PR's part)** if:
  - D12 does not bring the offer back;
  - D13 leaves a message unanswered;
  - F shows an interview mid-turn at the window.
- **Way back:**
  - Integration branch: `git revert -m 1 <merge>`.
  - VM: `sudo kinerary-cp-release rollback --dry-run`, then rollback. There is no migration, so the database is kept; the cost is about 1 min of bot pause (runbook).
  - Rolling back past #199 as well: count pending drafts first (round-3 §3).

## 8. What would reduce the risk (ranked by risk removed per minute)

1. **H with `-t`, before any restart (5 min).** It is the only evidence of the 429 path in production. The timestamps vanish when the log is archived.
2. **Add `chat_kind` (private/group) to `telegram_api.rate_limited` (~10 min with test).** The HTTP client does not have the chat. It can pass along whether `chat_id` is negative, which says nothing identifying. That makes "the cap is too small for private chats" readable from one line.
3. **Pin the overwrite choice (~10 min + ~40 s for the integrity file alone).** One DB test: a preview whose draft already names `optional_offer` is re-shown over a question key. Assert which one comes back. Then decide (§9.1) and keep it.
4. **Follow-up for outside item 9, in the same PR as 3 (~20 min).** §9 below.
5. **A 429 mode in `tools/fake-telegram.ts` (~20 min dev, optional).** For example, "refuse every Nth `sendMessage` with `retry_after:1`". The Mac `--auto` walk then exercises the real client's wait end to end. Only worth it if someone will run `--auto` before Release A anyway.

## 9. Decisions needed, and the three items the developer found outside the brief

1. **Overwrite or fill-only for the displaced prompt?** The audit proposed "only when null". #230 overwrites any value that differs. Both keep a way out. Pick one, and pin it (§8.3).
2. **The upgrade window** (§4): 2 Oct 14:00–20:00 UTC (Orlando has ended), or about 13:00 UTC before that?

| Outside item (developer's, confirmed by reading) | Blocks Release A? | Follow-up issue? |
|---|---|---|
| **7.** `poller.ts:1278` edits a confirmed suggestion with `cutText(label, 3000)`, which counts code points. About 1,000+ astral characters inside the first 3000 make the edit exceed 4096 units, and Telegram refuses it with a 400. The answer is already stored and the next step still goes out (`respond`, `:1282`). The only effect is that the old message keeps its buttons | **No.** It needs a pathological document, and it is cosmetic | Yes, small. Export `cutWhole` and use it there (5 min). It can join #225's tracked list |
| **8.** `HttpTelegramClient.post` (and `getUpdates`) has **no request timeout**. A half-open connection stalls that loop until undici's default. The developer says about 300 s; that is carried, and I did not verify the Node version's default | **No.** Pre-existing on `main` today, so Release A does not make it worse. #230 adds at most one extra `fetch`, and only after a 429 | **Yes.** `AbortSignal.timeout(~15 s)` on `post`, and long-poll + 10 s on `getUpdates`, with an abort counted as transient (~30 min with test). It deserves priority, because one hung socket silences every chat in the poll loop |
| **9.** `sendNextStep` records `lastPrompt` **before** sending and rolls back only on a throw (`poller.ts:4713-4720`). The real client never throws; it returns `ok:false`. **Worse than stated:** `claimFloor` had already set `awaiting='person'`, so the stall watchdog does not fire either, and the refused question or recap can stay unasked, silently. **The same class exists in reverse** in `askOpenConflict` (`:2005-2009`): it records *after* a send whose `ok` it never checks | **No.** Pre-existing (2026-09-18), and #230 removes the most likely trigger, a short 429. It is the repo's silent-failure class, though, so a cheap fix could ride Release A if a developer is free | **Yes.** Check `sent.ok` in both places and roll back or skip the record, plus one DB test each (~20 min) |

<details><summary>Evidence, 2026-09-26</summary>

- `git -C agent-a941e76eb62570f6d show HEAD --stat`: `92e3cb6`, parent `d2958f4`, 7 files. `gh pr view 230`: +683/−46, `MERGEABLE`. CI "TypeScript API" job 108386332179 (run 36235473027, `pull_request`, head `92e3cb6`): 10:20:12Z→10:34:05Z. The log reads `# tests 1977 / # pass 1971 / # fail 0 / # cancelled 0 / # skipped 6 / # duration_ms 700474.785`. The other 6 checks passed.
- `origin/integration/sprint-6` = `8f66492` (#228 merged 10:19:09Z). `git diff --stat d2958f4 8f66492 -- control-plane/` is empty. `git merge-tree --write-tree 8f66492 92e3cb6` = `ed8a17b`, exit 0.
- Scratch `scratchpad/plan230/control-plane/api` (`git archive 92e3cb6`, `node_modules` symlinked). tsc: no output, 2.7 s. The 4 test files: `# tests 82 / pass 59 / fail 0 / skipped 23`, 1.75 s.
- Mutation results (pass/fail): baseline 59/0. T1 no retry 55/4. T2 cap `<` 58/1. **T3 status-only code 59/0**. T4 any 4xx permanent 56/3. T5 retry twice 58/1. T6 send drops `permanent` 57/2. T7 edit drops it 58/1. T8 sleep in seconds 55/4. T9 `.slice` 58/1. T10 code-point cut 58/1. T11 NETWORK permanent 58/1. Restored 59/0.
- Test files read in full: `telegram-api-failures.test.ts`; the `chat-router.test.ts` diff; the `typed-changes-integrity-db.test.ts` diff, including the `Telegram` fake's failure kinds, `GatedTelegram`, and items 1 (4 tests), 3 (3) and 5 (5), plus the new way-out state.
- `grep HttpTelegramClient`: `relay/server.ts:153` is the only construction. `grep 429 tools/fake-telegram.ts` is empty. Hermes `_OUTBOUND_TIMEOUT_S = 30.0` is in `~/.hermes/hermes-agent` `ab0d98414` (the Mac's copy).
- **Not done:** any DB suite, SSH, a production read, a deploy, a commit. The #199 plan files are not edited.
</details>

---

## Round 2 addendum (2026-09-26)

**Verdict: SUFFICIENT to merge #230 at `5850157`, provided the "TypeScript API" CI job on its merge ref is green.** That job was `IN_PROGRESS` at 11:06Z (run 36237691394). The verifier's local run (1985 / 1979 / 0 fail / 0 cancelled / 6 skips, on its own database) is the evidence until CI finishes. I did not see that run. Round 2 changes nothing on the deploy side except one extra log field.

**Delta.** `git diff 92e3cb6 5850157`: 3 files, +207/−19. The only source change is `showChangeDraft` (`poller.ts:2398-2417`). After a delivered send, it re-reads the session. A non-`pc:` `lastPrompt` that differs from `covered` becomes the displaced prompt, and the log line gains `during_send`.
- The tip has moved to `035be91`. `git diff --stat 8f66492 035be91 -- control-plane/` is empty, and `git merge-tree --write-tree 035be91 5850157` gives `2f0d08c`, clean.
- tsc on `5850157` is clean (2.9 s). The four non-DB test files pass 60/60.

1. **The fix has a test that fails without it.** I judged it by reading; it is a DB test, and I did not run it.
   - **Interleaving:** in the two "OVERLAP" tests, the v2 preview is proposed under `pc:v1`, so `covered` is `pc:v1`. The preview is held in flight. Only then does the tap's offer record `optional_offer`. The test asserts `lastPrompt === "optional_offer"` *before* releasing the preview. That assertion is what makes the test non-vacuous: the interleaving really happened.
   - **Without the fix:** `covered` is `pc:v1`, so nothing is recorded, and `pc:v2` goes over the offer. When v2 is settled, the on-screen value is `pc:` and the displaced prompt is `null`, so the offer is not put back. `settled.at(-1) === essentialsDone` then fails, for both the yes and the no settlement.
   - **Window left open:** the few DB round trips between the re-read and the `pc:` record. The code comment says so, and the window is far smaller than one Telegram round trip.
2. **The overwrite edge is still unpinned, and its exposure is slightly wider.** The guard is still `displaced !== draft.displacedPrompt` (`:2410`), so an existing non-null value is still overwritten. The during-send read is now a second source of the value that overwrites it. Every new test starts from a `null` displaced prompt.
   - The effect is still a UX edge only: a question key can replace `optional_offer`, and the offer's own buttons stay on screen above it.
   - §8.3 still applies: one DB test, about 10 minutes, and a decision (§9.1).
3. **The two reviewer-named gaps were real, and both are now pinned.**
   - **401/403/404/409 transient.** Measured on scratch copies: making 403 permanent, or any 4xx below 429 permanent, fails **0** tests on `92e3cb6` and **1** on `5850157`. The round-1 suite would have let a later edit widen "permanent" and drop changes on a blocked bot.
   - **Real client driven end to end.** Three tests send a 403, a 404 and a 400 through `HttpTelegramClient` into `applyDecision`. Round 1 tested each half against a fake only.
   - **`change.sendFailed` itself failing.** Two tests cover #225's own worst case: the organizer is never told, and a later Confirm must be refused, show the change, and apply it on Yes. The test asserts `state <> 'confirmed'` after that Confirm. It pins the Confirm-block path that item 5's silent loss depended on.
4. **Blast radius and deploy side: unchanged.**
   - The fix adds one `getSessionForChat` per *delivered* interview preview. It adds no Telegram call and does not touch companions.
   - The 403/404-as-transient pinning describes what round 1 already did.
   - **The overlap is fake-only.** Its window is one Telegram round trip (hundreds of ms), stretched to at most 3 s only when a 429 is being waited out. A person cannot hit it on purpose on the test bot, and nothing short of the gated fake reproduces it.
   - D12 stays as written. It exercises the sequential order.
   - In the log read after the deploy (H), `interview.change_displaced_moved` with `"during_send":true` is positive evidence that the overlap happened and was handled. **Its absence proves nothing**, because the overlap is rare.
   - Add `during_send` to H's grep.
5. **Cost line: unchanged.** Dror still spends +14 min (D12, D13, the G pair) and the lead +5 (H). There is no new manual check. The merge gate is again the CI job, at about 14 min with nobody present (round 1 measured 13.9).

<details><summary>Round-2 evidence</summary>

- `git -C agent-a941e76eb62570f6d log`: `5850157` on `92e3cb6`. `gh pr view 230` (11:05:58Z): head `5850157…`, `MERGEABLE`. "TypeScript API" and "Kinerary suite" were `IN_PROGRESS`; the other checks passed.
- Scratch `scratchpad/plan230/r2` (`git archive 5850157`, `node_modules` symlinked). Script `scratchpad/plan230/mut2.py`. Results:
  - Round 1 copy: baseline 59/0; 4xx<429 permanent 59/0; 403 permanent 59/0.
  - Round 2 copy: baseline 60/0; 4xx<429 permanent 59/1; 403 permanent 59/1.
- Read in full: the `poller.ts` hunk, the `GatedTelegram` rewrite (several holds at once, matched by predicate), the 2 OVERLAP tests, the 3 real-client tests, the 2 `failSendFailed` tests, and the new `telegram-api-failures` case.
- Not done: any DB suite, SSH, production, a deploy, a commit. The text above this addendum is unedited.
</details>
