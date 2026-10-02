# Document intake — real booking folder acceptance, 2026-09-13

Revision: `feat/document-intake`, uncommitted, on base `e9c2d84`. Four runs, in order:

| Run | Code | Prompt |
|---|---|---|
| 1 | branch | branch |
| 2 | branch | parent revision `39ba81e` merged in |
| 3 | branch plus reconciliation fixes | merged, plus branch rules |
| 4 | run 3 plus three small fixes from run 3 | run 3 |

**Result.**
- The final code reads the whole folder into a correct trip skeleton with codex, the default: 32 of 32 checks passed in 219 s.
- claude reached 30 of 32 in 1,100 s in run 3, and 32 of 32 in 1,058 s in run 4.
- A repeat codex run (run 4) lost two flights to sporadic model output: 30 of 32.
- The failures of runs 1–2 were in how per-document answers were combined, not in reading. Most were fixed in reconciliation, not in the prompt.

**Privacy.** This record holds no traveller names, booking references, hotel names or calendar dates from the real documents.
- Dates are trip days: D1 is the first outbound flight, and the trip ends on D26.
- Places are described by role.
- The documents, the hand label, raw results and scripts are kept outside git (see "Reproduce").

## Context

The document intake reads what an organizer uploads during the interview:
- each file is registered and stored by digest
- each is extracted on its own
- the answers are reconciled across documents and with what is already held

Earlier acceptance used synthetic fixtures and one real single-document itinerary. This run is the first with a real multi-document folder: the confirmations of a 26-day, multi-family trip, uploaded as one burst, the way an organizer forwards a folder.

| Kind | Files | What makes it hard |
|---|---|---|
| Long-haul flight itineraries (agency PNR printouts) | 5 | Two passenger groups on different outbound days sharing a return flight; one PNR arrives twice; agency code and airline locator both printed; one flight's departure time differs between two printouts |
| Domestic flight receipts / e-ticket | 3 | Names printed differently per airline; one PDF's text is clipped at the left margin, so surnames lose their first letter and given names run together |
| Hotel confirmations (one booking platform) | 6 | Check-in/out printed as day + month; the year appears only on another line (a cancellation deadline) or nowhere at all |
| Car rentals | 2 | Pick-up printed as weekday, month, day — no year on the line; 12-hour times |
| Booked ticket / voucher / pass | 3 | A timed attraction ticket as a JPG photo; a shuttle voucher; an event parking pass whose order number is its reference |
| Travel-authorization application pages (HTML) | 2 | No trip facts |
| Passport scan (PDF) | 1 | Must be refused, not read |

## Method

- **Harness:** `control-plane/api/tools/document-acceptance.ts`. It drives the relay's real document path against a disposable test database, through:
  - `applyDecision`
  - the settled-burst claim
  - the registry and store
  - per-document extraction
  - the gate and reconciliation
  - `submitAnswerForChat`
  - provenance and conflicts
  - the day-by-day fold

  Telegram and the relay media store are stand-ins. `--burst` sends every file as one upload.
- **Label:** written by hand from each document's own text before any output was compared:
  - 6 stays with exact dates
  - 7 flights, 2 car pick-ups and 3 booked tickets, each on its date
  - 18 booking references — an agency PNR or the airline locator printed beside it both count
  - trip dates D1–D26
  - the passport refused
- **Scoring:** a script compares the label with the accepted answers. It checks:
  - stays, as a stop or hotel anchor with those dates
  - flights, cars and tickets, as an anchor or day item on the date
  - references: found, missing, or invented (not in any document's text)
  - duplicated or overlapping stops
  - passport refusal, image read, partial read reported, provenance recorded
  - it lists conflicts without scoring them
  - travellers are reported separately below: the label has no traveller list, so the scorer only checks that names came from the documents
- **Providers:**
  - `extract_intake` and `extract_itinerary`: `codex:gpt-5.6-luna`, then `claude:claude-sonnet-5`
  - `read_image`: `claude:claude-sonnet-5`, since codex is not a vision provider
- **Databases:** disposable test databases only (`cptest_docintake`, `cptest_reconcile`, `cptest`). The harness and the suites refuse any database whose name does not say it is for tests.

## Results

Checks passed out of 32, and wall-clock time for the whole burst:

| | Run 1 | Run 2 (codex) | Run 3 | Run 4 |
|---|---|---|---|---|
| codex | 26 · 220 s | 25 · 249 s | **32 · 219 s** | 30 · 250 s |
| claude | 27 · 915 s | — | 30 · 1,100 s | **32 · 1,058 s** |

Detail of the final runs, with run 1 for comparison:

| | codex run 1 | codex run 3 | claude run 1 | claude run 3 |
|---|---|---|---|---|
| Stays with exact dates | 4 / 6 | **6 / 6** | 4 / 6 | 5 / 6 |
| Trip dates | D2–D26 (start wrong) | **D1–D26** | D2–D26 | **D1–D26** |
| Destination | a one-night hotel town | not answered (asked) | the final city | not answered: 5 documents disagreed, asked |
| Invented or misplaced stops | 3 | **0** | 0 | 0 |
| Flights / cars on their dates | 7/7 · 2/2 | 7/7 · 2/2 | 7/7 · 2/2 | 7/7 · 2/2 |
| Booked tickets with reference | 0 / 3 | **3 / 3** | 2 / 3 | 3 / 3 |
| References found (of 18) | 14 | **18** | 14 | 16 |
| Invented references | 0 | 0 | 0 | 0 |
| Anchors without a date | 2 | 0 | 0 | 0 |
| Travellers (7 people in the documents) | 16 | 11 | 9 | 8 |
| Conflict questions | 0 | 2 (1 genuine) | 4 (all false) | 3 (1 genuine) |
| Day-by-day | written, cut at budget | 20 days on 6 stops, cut at budget | written, cut | none written |

In both run 3s, every file was accepted and stored by digest. Every run 3 also got the rest right:
- the passport was refused, with a message to the organizer
- the travel-authorization pages produced nothing
- the page PDF that could not be read was reported as partly read
- the ticket photo was read by the vision runner

## Findings, causes and fixes

### Run 1 — the branch as it stood

1. **Trip-level answers decided by confidence, silently.** Each document proposes its own destination and trip dates: a hotel town, a stadium city, a domestic flight's day. In one burst the most confident proposal won and the rest were rejected as `DUPLICATE_PROPOSAL`, with no question asked. Two itineraries both claimed the trip start at confidence 1, and document order picked D2 over D1.
2. **Dates without a year.** Hotel and car confirmations print day and month only. codex, correctly, would not guess a year and left stays undated; claude dropped them.
3. **One traveller, several spellings.** Travellers were matched by exact folded name, which failed on:
   - a middle name printed on one ticket only
   - surname-first printing
   - a clipped PDF column, where codex completed the clipped surnames from the booker's name — 7 invented surnames

   claude's four conflict questions were the same name in two formats.
4. **Booked tickets had no anchor type.** The question offered only flights, hotels and cars (#62).
5. **The day-by-day over its 20,000-character budget** was reported with the partly-scanned-file wording, a second time after the recap (#51 follow-up).

### Run 2 — parent prompt revision `39ba81e` merged

The revision fixed ticket anchors (3/3 with references) and stopped single-booking documents from proposing trip dates and destinations.

On these documents it was worse overall (25/32). Its year rule — take a year from the whole-trip dates only — made codex leave out every date whose year was not on the same line:
- four of six stays undated
- both car pick-ups undated
- 18 travellers, because the clipped PDF's names were now copied verbatim rather than invented

This is the result that set the direction for run 3: completing a year needs the rest of the trip, which a single document's extraction does not have and must not depend on.

### Run 3 — what changed

**Prompt, on top of `39ba81e`:**
- **Year-less dates.** A date whose line has no year, in a document with no whole-trip dates, is written as ISO 8601's year-less `--MM-DD`, and the year is completed later.
- **Destination.** A single booking's city is a stop, not the trip's destination.
- **Names and titles.** Surname-first or titled names are written given-names-first; a name cut off at a page or column edge is left out.
- **Tickets.** `activity` covers tickets, passes, vouchers and tours, and an order number tied to one is its confirmation. The `travel_anchors` question names trains, tickets and tours (#62).
- **One booking, one anchor.** A parking pass for a match is one anchor, not two.
- **Anchor times.** `time` is one 24-hour HH:MM; a hotel's check-in hours are not a time.
- **Constraints.** A supplier's policy or terms is not a constraint.
- **Trip dates.** One flight within the trip does not set the trip's dates.
- **Removed the branch's QUOTE/OFFER/ORDER rule.** The parent's "only where the document ties that code to that item" is correct. The branch rule wrongly excluded the parking pass's order number, and quoted the e2e fixture's quote number, which `extract-intake-prompt.test.ts` refuses.

**Reconciliation, code:**
- **Disagreeing documents** (`interpret.ts`, `applyProposals`). Two documents answering a text or choice question differently are not ranked by confidence. The trip starts with the earliest departure and ends with the latest return; any other disagreement is rejected as `CONFLICTING_PROPOSALS` and asked. Within one reading, the more confident proposal is still kept, which preserves typed-message behaviour. The document gate passes `sourceOf`, since a model leaves `sourceMessageId` empty on documents.
- **Year completion** (`document-dates.ts`). A `--MM-DD` date is completed from the whole trip — every document in the burst and every held answer — as the one year that puts it within half a year of the trip's known dates; otherwise it is left out. Anchor times are made HH:MM, and ranges are dropped. This runs at the document gate, so a cached per-document extraction never depends on its siblings.
- **Travellers as people** (`answer-merge.ts`, `samePerson`). A traveller entry is the same person, and no question is asked about the printing, when:
  - the words are the same in any order, ignoring commas, slashes and titles
  - a middle name is present on one printing and absent on the other
  - given names are run together
  - one word is cut short by at most two letters, with at least four letters left

  A match against two held travellers is reported as ambiguous, never merged. Place names keep exact matching.
- **Day-by-day truncation.** It has its own organizer message, `itineraryPartial`.

**A defect introduced and caught during this work.** The first version of the gate handed `applyProposals` normalised copies of document proposals. The relay traces a conflict, refusal or ambiguity to its document by the proposal object's identity (`recordDocumentOutcomes`), so every conflict a structured document raised was silently not opened. Three existing `document-intake-flow` database tests failed on it. The gate now replaces the proposal's value in place, and `document-reconcile.test.ts` pins the invariant.

### Run 3 — what remained, and run 4

- **codex, 11 travellers.** 7 people, plus:
  - two where a clipped surname and a missing middle name met in one printing
  - two email correspondents from a forwarded message's From/To lines

  Fixed for run 4: either printing may be the clipped one, and the prompt says email senders and recipients are not travellers.
- **claude, two false conflict questions.** The same booked flight was labelled differently by two printouts. Fixed for run 4: an entry matched by its reference is not disputed over its label; a stop's hotel name is still compared.
- **Not fixed; by design or open:**
  - *A second transliteration of a surname* is not matched (claude: 8 travellers). Telling two spellings of one family from two families needs a person.
  - *The held name is kept when a shorter printing arrived first* (codex kept one traveller without a surname). Preferring the fuller name is safe only within one burst; open.
  - *claude refused one year-less hotel stay* at low confidence, so it wrote no dates for it; and *claude's day-by-day produced no days*. Model behaviour, not reconciliation.
  - *Genuine conflicts.* A flight's departure time printed differently by two documents is a real question. A special-request wording offered as a constraint in two documents is a low-value one.
  - *No document states the trip's destination*, so it is left to the interviewer.

## Results — run 4

Run 4 added three fixes from run 3:
- either printing of a name may be the clipped one
- email senders and recipients are not travellers
- a booking matched by its reference is not disputed over its label

| | codex | claude |
|---|---|---|
| Checks passed | 30 / 32 · 250 s | **32 / 32** · 1,058 s |
| Stays with exact dates | 6 / 6 | 6 / 6 |
| Trip dates | D1–D26 | D1–D26 |
| Flights on their dates | 6 / 7 | 7 / 7 |
| References found (of 18) | 15 | 18 |
| Travellers (7 people) | **7** | 10 |
| Conflict questions | 1 (genuine) | 3 (1 genuine) |
| Day-by-day | 2 days on each of 6 stops, cut at budget | none written |

**codex.**
- Its travellers are exactly the seven people.
- Its only question is genuine: a flight's departure time that two printouts give differently.
- Its two misses are domestic flights. One reading came back with nothing usable even after its retry; another came back without the anchor.
- Replayed three times each with the same prompt, both documents proposed the flight every time, with no malformed output. That is model variance, not a regression.

**claude.**
- It answered every labelled fact.
- Its three extra travellers are a second transliteration of one surname (not matched, by design) and two email correspondents the new prompt rule did not stop.
- Of its three questions, one is genuine and one compares two wordings of the same room request.
- The third is false: one printing read a middle name as part of the family name, so the `family` field disagreed on a traveller already matched as the same person.
- Its day-by-day again produced no days.

Open after run 4, for the branch:
- A traveller already matched as one person should not be asked about its `family` field either.
- Free-text constraints that paraphrase each other should not become a question.
- claude's itinerary pass returns no days on this folder.
- Email correspondents still reach claude's traveller list.

## Tests

- `test/extract-intake-prompt.test.ts` (from the parent branch) checks every question example with production's parsers, the rendered prompt, and the e2e japan fixture through the gate. It passes on the merged branch.
- `test/document-reconcile.test.ts` (new) covers:
  - `samePerson`
  - people-aware reconciliation
  - label-versus-hotel conflicts
  - `clockTime`
  - year completion
  - disagreeing documents in `applyProposals` and through `gateDocumentProposals`
  - the proposal-identity invariant
- API suite without a database: 1,055 tests, 711 passed, 0 failed, 344 skipped (the database suites).
- API suite with a database, final code, on an unshared test database: 1,178 tests, 1,172 passed, 0 failed, 6 skipped.
  - Two earlier full runs were disturbed from outside the code under test.
    - One run sat on the shared `cptest` database while another session reset it: 45 failures, all `42P01 relation "control_plane.users" does not exist`. Rerun alone, the file passed 98/98.
    - While model CLIs ran on the same machine, `interview-transcript.test.ts` (56–65 s against the suite's 60 s per-file limit) timed out. Alone it passes 56/56 in 56 s. It is unchanged by this work, but it sits close to the limit.
- `tsc --noEmit`: clean. `scripts/preflight-checks.sh --all`: passes; its four warnings concern files this work does not touch.

## Default provider

codex stays the default for `extract_intake` and `extract_itinerary`:
- **run 3:** 32/32 in 219 s, against claude's 30/32 in 1,100 s
- **run 4:** 30/32 in 250 s (model variance on two flights), against claude's 32/32 in 1,058 s — equal accuracy across runs, at about a fifth of the time
- **single-itinerary acceptance:** 31/31, earlier

claude remains the vision reader. The choice stays behind the runner abstraction and is switchable per task.

No commit, merge or deploy was made. No live trip data was touched, and no Telegram message was sent.

## Reproduce

The private material is kept on the author's machine, outside every git repository, in `~/kinerary-test-data/document-intake/usa2026-2026-09-13/`:
- `label.json` — the hand label
- `compare-usa.mts` — the scorer
- `replay.mts` — single-document replay without a database
- `text/` — each document's extracted text, for the invented-reference check
- `runs/` — raw results and scores of every run

The source documents stay on the family NAS share.

```sh
cd control-plane/api
export CONTROL_PLANE_TEST_DATABASE_URL="postgres://postgres:test@127.0.0.1:5434/cptest_docintake"
files=(); for f in <folder>/*; do files+=(--file "$f"); done
node --import tsx tools/document-acceptance.ts --provider codex:gpt-5.6-luna \
  --vision claude:claude-sonnet-5 --burst "${files[@]}" --out <outside-git>/result-codex.json
npx tsx <private>/compare-usa.mts <private>/label.json <outside-git>/result-codex.json
```

The harness wipes the database it is given; never point it at one whose name does not say it is for tests.
