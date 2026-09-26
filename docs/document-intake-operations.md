# Document intake — operations

Status, 2026-09-13: implemented on `feat/document-intake`
(`.claude/worktrees/document-intake`). **Uncommitted, not merged, not deployed.**
*Update, checked against the tree 2026-09-25: the work is now committed and merged
on `integration/sprint-6` (PR #136 merge `2966cbd`; Slice B forward-port `ddf943c`).
It is not on `main`; deployment status is not verified here.* The sentence above is
the 2026-09-13 state.
Scope and design: [`document-intake-feature-plan.md`](document-intake-feature-plan.md).

## What happens to an uploaded file

### During the interview

1. **Ingest** (`ingestDocument`, `document-intake.ts`). The relay's poller hands
   every file in a settled burst to one ingest service.
   - The trip comes from the authenticated chat binding, never from the upload.
   - The file is read first (`document-text.ts`): PDF page by page, DOCX, XLSX with
     cell date styles and the 1904 system, HTML, text. Coverage is recorded per page
     or sheet.
   - Identity documents are refused before anything is kept.
   - The content gets one `trip_documents` row per trip (by sha256).
   - The original bytes are written once to the document store (write-once,
     NFS-safe), and the reader never consumes the caller's buffer.
   - Each delivery is a `source_artifacts` row.
2. **Photos and text-less PDFs** (`document-vision.ts`), only when a runner serves
   `read_image`. The model transcribes; the transcript is identity-checked, kept as
   its own extraction row, and reused for every later delivery of the same bytes.
3. **Extraction**, one reading per document (`extract_intake`), two at a time.
   - Each reading is stored under a processing key: reader, prompt+schema, task,
     provider, model.
   - A failed call is not stored.
   - An identical redelivery makes no model call.
4. **Reconciliation** (`answer-merge.ts`, `document-dates.ts`, the gate in
   `interpret.ts`). Documents meet in one gate together with the answers already held:
   - add what is new and fill what is missing
   - report a disagreement instead of replacing a held value
   - leave an ambiguous match (a repeated city with an undated entry) unmerged

   Further rules:
   - A day written two ways ("2 May", "--05-02", 2026-05-02) is one day, and the
     ISO form is kept.
   - **A date given without a year.** The model proposes it as `--MM-DD`. The year is completed from the whole trip — every document in the burst and every held answer — as the one year that puts the day within half a year of the trip's known dates, so a document that extends a stay keeps its date; a day that two years could explain is left out. This happens at the gate, so a document's cached reading never depends on its siblings.
   - **Anchor times.** An anchor's `time` is made 24-hour `HH:MM`; a range such as a hotel's check-in hours is dropped.
   - **Invalid dates.** A stop or anchor date that is still not `YYYY-MM-DD` is refused by validation rather than stored.
   - **Disagreeing documents.** Two DOCUMENTS answering a text or choice question differently are not ranked by a model's confidence. The trip starts with the earliest departure and ends with the latest return; any other disagreement (a destination) is left unanswered and asked. Within one reading, the more confident proposal is still kept.
   - **Travellers are matched as people.** Name order, commas, slashes and titles are ignored. These still count as the same person:
     - a middle name present or absent
     - given names run together
     - one word clipped by at most two letters, with at least four letters left

     A different transliteration of a surname is not matched.
5. **Provenance and conflicts** (`answer-provenance.ts`): which document supported
   which entry, and each disagreement asked with keep / use-the-document buttons.
6. **Day by day** (`extract_itinerary`): days merge by date into existing stops, and a
   document longer than the budget is said to be partly read.
7. **Confirm**: `intake_versions.source_document` carries the document manifest.

### After confirmation — the correction flow (owner of post-confirm documents)

Decided 2026-09-13: the relay's correction flow is the **authoritative owner** of
documents received after confirmation (`document-correction.ts`, migration `20260918110132_document_corrections.sql`).

- **Route.** A file the organizer sends in their own private chat with the bot, after
  confirmation, goes to this flow, not to the companion gateway. The conditions
  (`organizerDocumentRoute`):
  - the chat is private
  - the sender is that chat
  - it is the chat the trip's interview was confirmed in
  - the file was re-hosted
  - it is a document, or an image where a runner reads images
  - the relay has a model runner
  - the route is switched on: `ORGANIZER_DOCUMENT_ROUTE_ENABLED=1` (below)
- **Read.** Same ingest (delivery `review_status = 'pending'`), same per-document
  extraction, then the gate against the trip's **latest confirmed intake version**.
- **Propose.** One proposal for everything that adds or fills, and one `replace`
  proposal per disagreement. Each is sent with **Approve** / **Keep as it is**.
  Nothing changes yet. The same file sent again is the same proposal, with no second
  model call.
- **Approve** (`dc:<id>:a`). Accepted only from the proposal's own chat and sender,
  while that chat is still the confirmed interview chat.
  - The proposal is claimed (`pending → applying`), so a second tap applies nothing.
  - It is applied only to the version it was computed against. A single replaced
    field may apply to a newer version whose value is still exactly what was shown.
    Otherwise the proposal is `stale`, and the organizer is asked to send the file
    again (no second model call).
  - `correctIntake` writes a new immutable version. Provenance is recorded, the
    deliveries are approved, and the site is re-provisioned through
    `provisionOnConfirm`, the same step confirming takes.
  - A trip mid-build answers "try again shortly" and the proposal stays pending.
- **Keep as it is** (`dc:<id>:r`). Nothing changes, and the deliveries close as
  `rejected`.

#### Off unless `ORGANIZER_DOCUMENT_ROUTE_ENABLED` is set

The organizer's private-chat route into this flow runs only when the relay's
environment has `ORGANIZER_DOCUMENT_ROUTE_ENABLED=1`: exactly `1`, with no
whitespace. Unset, empty and `0` are off. Any other value is also off, and the relay
logs `relay.organizer_document_route_setting_unrecognized` at start. When the route is
off, the organizer's file goes to the companion gateway, as it did before #178. The
relay downloads the file once, for the companion, and reads and proposes nothing.
Owner's decision, 2026-09-26 (Release A).

- **Why it is off.** An Approve re-provisions the site through
  `provisionOnConfirm`, from the newest `available` release. `ready_private` is a
  correctable state, so on a live trip that is a redeploy in the middle of the holiday.
  Live trips are redeployed only after they end (`docs/sprint6-tracks.md` decisions
  11 and 28; decision 12 excludes CT200). A rollback of the release does not undo a
  rebuild.
- **How to read its state.** The relay logs
  `relay.organizer_document_route {"enabled":true|false}` once at start. While the
  route is off, each file it would have read logs
  `trip_bot.organizer_document_route_off {"trip_id":…}`. That line carries no chat,
  sender or file.
- **Before turning it on anywhere real:** walk #217 on a **throwaway**
  `ready_private` trip. The walk is a PDF to the organizer's DM, the proposal,
  Approve and the rebuild, a DM photo, and the outage line with the gateway stopped.
  Also wait until every live trip on that relay has ended: Orlando after 1 Oct,
  Japan after 3 Oct. The flag is per relay, not per trip.
- **Not gated, on purpose.** An Approve or Keep tap (`dc:<id>:a|r`) still reaches
  `applyCorrectionCallback`. That tap needs a proposal row, and only this route
  creates one (`trip_document_corrections`, migration `20260918110132`, which is new
  in Release A). A relay that has never had the route on has no proposal to tap. The
  web `POST /v1/trips/:id/intake/correct` predates this flow and is unchanged.
- **Turning it off again does not withdraw proposals already made.** A proposal stays
  `pending` (a `not_now` result also puts its row back to `pending`), and the tap above
  is not gated, so on a relay where the route has been on, an old proposal stays
  approvable after the flag is switched off. Before switching it off on such a relay,
  have the organizer press Keep on every pending proposal (or reject them through the
  same code path); nothing expires them. A code follow-up (check the flag in
  `applyCorrectionCallback`, or expire pending rows) is tracked on #217.
- **On the VM the variable cannot be set from a values file.** The VM relay's
  environment is an explicit list in `compose.vm.yml` plus two auth env files;
  `vm.env` and `provisioning.env` feed only compose interpolation, so a value there
  does nothing to the relay. Turning the route on for the VM therefore needs a
  `compose.vm.yml` change, i.e. a release. On the Mac, `scripts/relay-restart.sh`
  sources `provisioning.env` with `set -a`, so a line there turns it on for the Mac
  relay only.
- **The walk before 3 Oct runs on the Mac relay, never the VM's.** Setting the flag on
  the VM relay while Orlando or Japan is live would put those organizers' chats on
  this route; the two conditions above already forbid it, and this says it outright.
  The Mac and the VM have separate databases and bots, so a walk on the Mac cannot
  approve anything on the VM.

**Legacy fallback.** `trip-confirmation-intake` still handles what this flow does not
take: files posted in groups or by other members, and relays with no model runner.
Its skill text should be updated to say so. That edit must ship together with the
profile deploy (`scripts/install-hermes-skill.sh trip-confirmation-intake familytrip`),
because the preflight drift check blocks a repo-only change. It has **not** been made.

**Web upload** should feed this same flow. **Not built**: it needs an authenticated
upload endpoint that calls the same ingest and proposal functions.

**Not in the correction flow yet:** the day-by-day (`extract_itinerary`) pass. A
post-confirm document proposes intake answers (stops, anchors, dates…) but not
per-day items.

## Configuration

All environment. Unset is never an error — it is the previous behaviour, except where
`DOCUMENT_STORE_REQUIRED=1` says otherwise.

| Variable | Read by | Effect |
|---|---|---|
| `DOCUMENT_STORE_DIR` | relay, worker | Where originals live: `<dir>/<trip_id>/<sha256>.<ext>` |
| `DOCUMENT_STORE_REQUIRED=1` | relay, worker | Refuse to start unless the store is ready (below) |
| `PROVISIONER_TRIP_NFS_LOCAL_BASE` | worker | The trips' NFS export as the worker sees it; originals are hard-linked into `<base>/<slug>/documents` |
| `TRIP_DOCUMENTS_DIR` | trip runtime | Where the site reads originals; written into new containers' `.env` as `<nfs mount>/documents` |
| `EXTRACT_INTAKE_RUNNER` / `_MODEL` / `_TIMEOUT_MS` | relay | Document answer extraction; inherits `EXTRACT_*` whole (runner, model, timeout and effort) |
| `EXTRACT_ITINERARY_RUNNER` / `_MODEL` / `_TIMEOUT_MS` | relay | The day-by-day pass; inherits `EXTRACT_*` whole (runner, model, timeout and effort) |
| `ITINERARY_EXTRACT_TIMEOUT_MS` | relay | Per-call day-by-day timeout, default **60 s** — overrides the task timeout; too short for claude-sonnet-5 on a 4-page docket |
| `VISION_RUNNER=claude\|openrouter`, `VISION_MODEL` | relay | Photos and scanned PDFs; inherits nothing |
| `OPENROUTER_API_KEY` or `OPENROUTER_API_KEY_FILE` | relay | The file may be an env file: only its `OPENROUTER_API_KEY=` line is read (`~/.hermes/.env` on the Mac, `/opt/agent-auth/openrouter.env` on the VM) |

## Storage on the VM — one physical copy, never ephemeral

**The existing NFS design.**
- TrueNAS exports `192.168.0.171:/mnt/nvme_pool/NFS`, which Proxmox mounts as
  `/mnt/pve/truenas-nfs`.
- Each trip's `/mnt/pve/truenas-nfs/<slug>` is bound into its container as
  `/nfs/<slug>` (mp0).
- Each container sees only its own trip directory, and `DATA_DIR` is
  `/nfs/<slug>/server-data`.
- Teardown deliberately leaves a trip's NFS data in place.

**The approach: a reference, not a copy.**
- The document store lives on the same export, outside every trip directory:
  `<export>/.kinerary-document-store/<trip_id>/<sha256>.<ext>`.
- At provisioning the worker **hard-links** each original into
  `<export>/<slug>/documents/`. Two names, one set of bytes on the export: no second
  physical copy and no transfer.
- The trip runtime reads it from its own mount (`TRIP_DOCUMENTS_DIR`, or derived from
  `DATA_DIR` for containers that predate the variable).
- Isolation holds: the store is outside every trip's mount, and documents are served
  only through the authenticated trip routes.
- Teardown unlinks the trip's name. The store keeps its original until
  `teardown-trip.py` removes the trip's store directory.
- If the worker cannot see the trip's NFS directory, or the export refuses the link
  (root squashing, say), that document is published beside the config instead and
  `deploy.sh` carries it. The runtime looks in both places.

Hard links cannot cross mount points, so the **worker binds the export once**
(`${KINERARY_NFS_ROOT}:/srv/kinerary-nfs`) and finds both the store and trip
directories under it. The relay only writes to the store, so it binds just
`.kinerary-document-store`.

**One-time VM setup (not performed):**

```bash
# /etc/fstab on the VM
192.168.0.171:/mnt/nvme_pool/NFS  /mnt/truenas-nfs  nfs  defaults,_netdev  0 0
sudo mount /mnt/truenas-nfs
sudo mkdir -p /mnt/truenas-nfs/.kinerary-document-store
sudo touch /mnt/truenas-nfs/.kinerary-document-store/.kinerary-document-store   # the marker
echo 'KINERARY_NFS_ROOT=/mnt/truenas-nfs' | sudo tee -a <vm.env>
```

**The check that prevents ephemeral storage.** It is `checkDocumentStore`
(`document-store.ts`) in the relay and `check_document_store` (`document_handoff.py`)
in the worker, run at startup, and fatal when `DOCUMENT_STORE_REQUIRED=1`.
`compose.vm.yml` sets that flag, and makes `KINERARY_NFS_ROOT` mandatory
(`${KINERARY_NFS_ROOT:?…}`). It checks, in order:
1. configured, exists, is a directory
2. carries the marker `.kinerary-document-store` — so an empty directory Docker
   created for a missing mount, or a host path where NFS is not mounted, fails
3. a probe file can be created and removed
4. on Linux, `/proc/self/mountinfo` puts the directory on a mount of its own, not the
   container's root filesystem

Not verified on a real NFS mount — see the unrun checks below.

## Model runners

**One abstraction.** Every task goes through `StructuredModelRunner` by task name.
Nothing outside it names a provider, and every caller keeps its own parse and
evidence gate. Runtime switching (`/models`, `/model`) is by the super admin only;
details in migration 0054.

**Codex isolation.** `codex exec` loads its whole `CODEX_HOME`. On the build machine
that meant a shell, web access, `apply_patch`, computer-use MCP tools, plugins and
apps, all offered to a model reading untrusted documents. Asked to list its tools, it
named 14; transcribing a PDF, it ran python over the file itself.

The runner fixes this on every call:
- `--disable` for every tool feature
- `-c mcp_servers={}`, `plugins={}`, `apps={}`
- `shell_environment_policy.inherit="none"`
- the allow-listed environment (next section)

The login's own `CODEX_HOME` is kept, because a private copy could lock the refresh
token out. The model then lists only `exec`/`wait`/`request_user_input`, and `exec`
refuses.

Codex **exits** on an unknown feature name, so the relay runs `codex features list`
at startup whenever a task is bound to codex. On a mismatch it logs
`relay.codex_isolation_unverified` and refuses codex bindings. Re-check the list
(`test/codex-isolation.test.ts` probes the installed codex) whenever the codex CLI
changes, including on the VM. The same probe now also runs before `/model` saves a
codex binding, and overrides already stored in the database are verified at each
30-second refresh while any of them names codex (a failure is remembered; a pass is
re-run — memoising it, and a shorter timeout for the probe on the request path, are
follow-ups in #202). A codex that cannot be verified is refused.

**Environment of every model child (#153, #58, PR #192).** Every CLI the relay
spawns to read untrusted organizer or document text starts with an **allow-listed
environment**, built in one place — `structuringChildEnv()` in `model-runner.ts` —
not the relay's own. The base set is `PATH`, `HOME`, `XDG_CONFIG_HOME`, the temp
directories, `LANG`/`LC_*`, and the certificate variables; each CLI adds only its
own location or login:

| Child | Adds |
|---|---|
| Codex | `CODEX_HOME` |
| Claude | `CLAUDE_CODE_OAUTH_TOKEN`, `CLAUDE_CONFIG_DIR`, `ANTHROPIC_API_KEY`, `ANTHROPIC_BASE_URL`, `ANTHROPIC_AUTH_TOKEN`, `XDG_CACHE_HOME` |
| Hermes | `HERMES_HOME` |

An allow-list rather than a deny-list because a deny-list cannot be audited: a
secret the relay gains later is withheld by default instead of by someone
remembering to add it. The earlier deny-list `hermeticEnv` stripped only
`CLAUDE_CODE_*` session variables and passed the rest through, so a bot token, the
database URL, Proxmox/Cloudflare tokens and a planted `DYLD_INSERT_LIBRARIES`
reached the Hermes children (`itinerary-extract.ts`, `hermes-search.ts`); it is
removed. A spec whose env function returns nothing gets an **empty** environment,
never inheritance (`specEnv`, `?? {}`), and the same applies to a spec that
declares no env. The Claude login variables stay because withholding them breaks
the call, not because they are harmless: without `CLAUDE_CODE_OAUTH_TOKEN` every
call on the VM failed on 2026-09-11.

Two consequences are deliberate:
- **A Hermes provider key that only the relay holds is no longer forwarded.**
  Hermes reads its own provider keys from `~/.hermes/.env`; that is where such a key
  belongs. Before, the deny-list forwarded (for example) the VM relay's
  `claude.env` token, so a Hermes call could authenticate with it. Now, if Hermes
  has no key of its own, its provider chain can fall through silently to the next
  provider, which on the Mac is the metered one.
- **Proxy variables (`HTTP_PROXY`, `HTTPS_PROXY`, ...) are not in the base set, so
  no model child receives them** — for Hermes that means a deployment that needs a
  proxy now fails Hermes calls loudly instead of working. Decided; the reason for
  choosing failure over a wider list is not recorded beyond "allow-list, nothing
  else the relay holds" — ask Dror.

Not covered: `mcp/mcp.js` `runHermesExtract` has the same full-environment pattern
and is live on trip bridges (#183). Reaches a running relay only after an API
rebuild and relay restart.

**Effort follows the runner.** `extract_intake`, `extract_itinerary` and the vision
task inherit their runner and model from `EXTRACT_*` / `VISION_*`, but used to look
up only `<TASK>_EFFORT`, so `EXTRACT_EFFORT` never applied to them and `claude -p`
read documents under the operator's personal `settings.json` (effortLevel `xhigh`,
hooks, MCP connectors). They now inherit effort too, and a claude binding with no
effort configured logs `model_runner.claude_effort_unset` at startup — the loud
signal, because silence is what hid it. Which effort the VM should carry, and
document quality at `medium` on the Mac, are open in #202.

**Usage and cost.** Results carry `usage` wherever the provider reports it:
- OpenRouter gives tokens and billed cost.
- The claude CLI gives tokens and an API-equivalent cost (a quota signal, not money
  spent).
- Codex gives total tokens.

**Robustness fixes found by measuring:**
- An OpenRouter completion with no content is retried on the same model.
- A structured answer with stray trailing brackets is decoded, and only that repair
  is made.

## Vision capability matrix (verified 2026-09-13, synthetic booking page)

| Provider (as run) | JPEG | PNG with transparent background | PDF | Latency | Selectable for `read_image` |
|---|---|---|---|---|---|
| claude CLI 2.1.236, claude-sonnet-5 (stream-json) | ✓ exact | ✓ exact | ✓ exact | 8–10 s | yes |
| codex CLI 0.153.2, gpt-5.6-luna (`-i`, isolated) | ✓ exact | ✗ "no text visible" | ✗ `-i` takes images only | 7–8 s | **no** — excluded pending decision |
| OpenRouter minimax/minimax-m3 | ✓ 3/3 facts | ✗ | ✓ 3/3 | 1.9 s / 5.4 s | yes |
| OpenRouter google/gemini-3.5-flash-lite | ✓ 3/3 | ✗ | ✓ 3/3 | 1.3 s / 1.1 s | yes |
| OpenRouter openai/gpt-5.6-luna | ✓ 3/3 | ✗ | ✓ 3/3 | 2.4 s / 1.8 s | yes |

API capability is not CLI capability, and neither is assumed. The first codex probes
used only transparent PNGs, which is why an earlier note said codex could not see
images — it can. Transparency defeats every model except claude, so flattening
transparent PNGs in the reader is a follow-up; until then such files may read as
illegible.

**A caveat that applies to both harnesses below.** `control-plane/api/tsconfig.json`'s
`include` is `src/**/*.ts`, so `npm run build` (`tsc -p tsconfig.json`) typechecks
neither `tools/` nor `test/`. A clean build is not evidence `tools/extract-eval.ts`
or `tools/document-acceptance.ts` still compile — a stale import `extract-eval.ts`
kept from `document-intake.ts` after the gate split into `document-gate.ts`
(2026-09-22) survived exactly this way, caught only when the file was actually
run, not by the build. Run these under `tsc --noEmit` against the whole tree, or
execute them, before trusting that a change to `document-intake.ts` or
`document-gate.ts` hasn't broken either silently.

## Extraction benchmark (`tools/extract-eval.ts`, 3 repetitions, golden `japan` + `multi`)

Metrics per provider:
- **Stops exact:** stop with name and both dates right, per run.
- **Refs:** expected booking references found.
- **Places:** planned places found.
- **Merges / splits:** false merges and splits.
- **Invented / forbidden refs:** references not in the label, or the quote number
  used as a reference.
- **Malformed:** structured proposals that did not parse.
- **Failures:** documents whose extraction failed, including BAD_OUTPUT.

No run needed a runner retry.

| Provider | Stops exact (japan · multi) | Refs (multi) | Places | Merges / splits | Invented / forbidden refs | Malformed | Failures | p50 / p95 per document | Tokens · cost |
|---|---|---|---|---|---|---|---|---|---|
| **codex gpt-5.6-luna** (isolated + repair + table/quote rule) | 3/3 · 3/3 | **8/8 ×3** | 12/12 | 0 / 0 | 0 / 0 | 0 | 0/15 | 16–17 s / 20 s | 41k · subscription |
| codex gpt-5.6-luna (isolated + repair, before the table rule) | 3/3 · 3/3 | 4/8 ×3 | 12/12 | 0 / 0 | 0 / 0 | 0 | 0/15 | 16 s / 26 s | 42k · subscription |
| claude-sonnet-5 | 3/3 · 3/3 | 8/8 ×3 | 12/12 | 0 / 0 | 0 / 0 | 0 | 0/15 | 67–76 s / 126 s | 877k · $1.88 API-equivalent |
| OpenRouter minimax/minimax-m3 | 3/3 · 3/3 | 8/8 ×3 | 12/12 | 0 / 0 | quote number as a hotel confirmation, 3 of 3 japan runs | 1 | 0/15 | 12–14 s / 23 s | 43k · $0.014 billed |
| OpenRouter google/gemini-3.5-flash-lite | 3/3 · 3/3 | 4, 4, 1 of 8 | 6/12 | 0 / 0 | 0 / 0 | 0 | 0/15 | 2 s / 3 s | 47k · $0.032 billed |

Also measured:
- **codex without isolation (A/B, before the repair):** every stop exact, malformed 2.
  Isolation does not reduce quality once stray brackets are decoded.
- **Before the prompt and merge fixes** (first run of the day): invented stop dates
  from tickets and flights gave 7–13 false conflicts per `multi` run for every
  provider. Now 0 for all, including claude's year-less `--05-02` dates under the
  current merge rules.
- **After the table/quote prompt rule** (a reference column means a booked row; a
  quote number is never a confirmation): codex went from 4/8 to 8/8 references in
  every run, with nothing else changing. minimax-m3 stopped inventing references
  (0 in 3 runs), and `multi` stayed perfect. But its `japan` stops were refused in
  3 of 3 runs by the evidence gate (`EVIDENCE_NOT_IN_SOURCE`): the stop lists were
  correct, and the quoted evidence was not verbatim from the document. The gate
  did its job; minimax's quoting is unreliable. claude-sonnet-5, re-run on `japan`
  (3 runs): every stop exact in 2 of 3. In the third, its stop list was likewise
  refused as `EVIDENCE_NOT_IN_SOURCE` (p50 49 s, $0.29 API-equivalent). gemini was
  not re-run, and claude was not re-run on `multi`. Under the same prompt codex's
  evidence passed in 6 of 6 runs.

**Benchmark preference (2026-09-13), not what runs:** codex gpt-5.6-luna for
`extract_intake` and `extract_itinerary`. It was chosen as the default at the time, but
no deployment configures it: neither the VM's compose nor the Mac's `provisioning.env`
sets `EXTRACT_INTAKE_*` / `EXTRACT_ITINERARY_*` (#202), so both read documents with
`EXTRACT_RUNNER=claude`. Dror decided on 2026-09-25 to use what is running; switching to
codex is a deliberate change with its own check, not a repair. It is as accurate as claude-sonnet-5 on every fixture metric and
more accurate on the real document, at about a quarter of the latency. `interpret`
was not benchmarked and keeps its deployed binding. Vision stays opt-in; claude CLI is
the verified choice, and codex stays excluded.

## Real-document acceptance (`tools/document-acceptance.ts`)

The real document was a 4-page travel-agency docket (a price quote): 5 stops including
one city visited twice, 5 hotels each listed twice (two rooms), 6 timed
activities/passes, and no booking references. A second, 2-page export of the same
booking was uploaded after it.

It ran through the relay's actual document path with provenance and the day-by-day
pass, against a hand-made label written before any model ran. The document and the
outputs stay outside git.

| Provider | Checks passed (applicable) | Notable failures | Time (4-page · 2-page) |
|---|---|---|---|
| codex gpt-5.6-luna | **31/31** | — | 50 s · 19 s |
| OpenRouter minimax-m3 | 30/32 | two transport passes listed as planned places | 27 s · 11 s |
| claude-sonnet-5, run 1 | 25/31 | no activity got its day/time (day-by-day empty) | 253 s · 143 s |
| claude-sonnet-5, run 2 | 23/31 | 4 of 5 hotels omitted; day-by-day timed out at 60 s | 276 s · 139 s |

Every provider kept both visits to the repeated city separate, collapsed the doubled
hotel rows into one stay each, invented no travelers, and traced every stop to the
document. None records the room count: there is no field for it.

A real multi-document folder — 22 booking confirmations for a 26-day multi-family trip,
uploaded as one burst — is recorded separately, anonymized, in
[`test-reports/document-intake-real-booking-folder-2026-09-13.md`](test-reports/document-intake-real-booking-folder-2026-09-13.md).

The defects it found are in how per-document answers are combined, not in reading. The fixes are the reconciliation rules in step 4 above.

With those fixes the folder scored:
- 32/32 with codex in 219 s
- 32/32 with claude in 1,058 s

A repeat codex run lost two flights to sporadic model output (30/32). codex stays the default.

## Pre-existing defects found

These were checked against `origin/main` (f9f0451) and the Sprint 5 baseline
(`origin/integration/sprint-5-plus`, db3f0fe), with a reproduction for each, and
**fixed on this branch** unless noted. Each is filed as a GitHub issue with the
label `pre-existing-defect` (2026-09-13).

| | Issue | Defect | main | baseline |
|---|---|---|---|---|
| A | #49 | The PDF reader detaches the caller's buffer (bytes empty after reading) | — | yes (latent) |
| B | #50 | The document path claims an interpretation and never commits it (redelivery repays the model) | — | yes |
| C | #51 | Extraction prompts silently truncate (itinerary 20,000 chars, typed messages 8,000) | yes | yes |
| D | #52 | The itinerary fold ignores days for a stop that already has one | — | yes |
| E | #53 | The XLSX reader emits date cells as serial numbers | — | yes |
| F | #54 | An undated slice merges into the first same-name stop (repeated visits) | — | yes |
| G | #55 | Stop dates that are not ISO are accepted and silently dropped at provisioning | yes | yes |
| H | #56 | The extraction prompt lets a ticket or flight define a stop's dates | — | yes |
| I | #57 | A scanned page inside a text PDF disappears with no partial-read signal | — | yes |
| J | #58 | The codex runner offers the host's shell/web/MCP tools to document text (security) | — | yes |
| K | #59 | One stray bracket in `dataJson` discards the whole structured proposal | — | yes |
| L | #60 | An OpenRouter completion with no content fails without a retry | — | yes |
| M | #61 | A document that agrees with held answers is reported as "nothing about the trip" | — | yes |
| N | #62 | `travel_anchors` offered only flights, hotels and cars, so booked tickets and passes lost their references | yes | yes |

C is partly fixed:
- Typed messages are still cut at 8,000 characters, now with a log warning.
- A day-by-day built from part of a burst now tells the organizer so, in its own wording.

N is fixed by:
- the parent-branch prompt revision `39ba81e`, which added the `activity` type and the example-echo fix
- this branch, which widened the question and the anchor rule to tickets, passes and tours

## Database

| Migration | Adds |
|---|---|
| `20260918110129_document_registry.sql` | `trip_documents`; `source_artifacts.document_id/filename/received_at`; `trip_document_extractions` |
| `20260918110130_answer_provenance.sql` | `trip_answer_sources`, `trip_answer_conflicts` |
| `20260918110131_model_task_settings.sql` | `model_task_settings`, append-only `model_task_setting_history` |
| `20260918110132_document_corrections.sql` | `trip_document_corrections` (post-confirm proposals) |

All additive, applied by `src/migrate.ts`. `0050` is absent on purpose. Recheck the
numbers against `main` before merging.

## Rollout (not performed — needs explicit merge and deploy decisions)

1. Reconcile with `main`; recheck migration numbers; review inherited Sprint 5 changes.
2. VM: NFS mount, store directory and marker, `KINERARY_NFS_ROOT` (above).
3. Build the API; run migrations.
4. Set the model bindings chosen from the benchmark (see recommendation in the
   report); if codex is used, confirm `relay.codex_isolation_unverified` is absent.
5. Restart the relay (`control-plane/deployment/vm-relay-restart.sh`) and the worker.
6. Deploy the `trip-confirmation-intake` wording change together with its profile.
7. Check: `/models`; one synthetic document before and after confirmation on a test
   trip.

## Rollback

- **Code:** redeploy the previous build. Old code ignores the new tables;
  `source_artifacts` columns are nullable; `source_document` is inert to old code.
- **Schema:** keep the tables (additive; audit records).
- **Storage:** unset `DOCUMENT_STORE_REQUIRED` to start without the store. Originals
  already stored remain on the export.
- **Models:** `/model <task> default`, or `DELETE FROM control_plane.model_task_settings`.
- **Post-confirm flow:** with no model runner the relay routes documents to the
  companion again (legacy skill).
