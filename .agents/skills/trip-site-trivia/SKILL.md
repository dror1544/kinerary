---
name: trip-site-trivia
description: "Manage the family trip site's Kahoot-style trivia game: inspect question bank, add questions, start games, and control live flow through the trip_site MCP tools."
version: 1.0.0
author: Hermes Agent
created_by: agent
license: CC0-1.0
platforms: [macos, linux]
metadata:
  hermes:
    tags: [travel, trivia, kahoot, mcp, trip-site, family-trip]
---

# Trip Site Trivia

Use this skill when the user wants to work with the family trip site's Kahoot-style trivia game: adding questions, counting/filtering the question bank, starting a game, or controlling live game flow.

## When to use
- Add a new trivia question to the trip site
- Check how many questions exist or filter by person/category
- Start a new game and verify lobby state
- Control a live game as host (launch, pause, reveal, leaderboard, next, stop)
- Inspect past scores or current game state

## Core tools
- `mcp_trip_site_get_trivia_questions`
- `mcp_trip_site_add_trivia_question`
- `mcp_trip_site_get_trivia_state`
- `mcp_trip_site_trivia_control`
- `mcp_trip_site_get_trivia_scores`

See `references/tool-notes.md` for field rules and a concise control map.

## Workflow

### 1. Adding a question
1. Collect the minimum required fields:
   - Hebrew question text
   - English question text
   - `persons` target (`general`, `trip`, a username, or an array of usernames)
   - 2–4 answers
   - exactly one correct answer
2. If the user gives only the correct answer and no distractors, ask for the missing wrong answers.
3. If the user gives more than 4 total answers, ask which wrong answers to drop before calling the tool.
4. Default `category` sensibly:
   - `family` for personal/family questions
   - `trip` for itinerary/destination questions
5. Use `duration: 20` unless the user asks for a different timer.
6. After adding, report the returned `id` and confirm who the question is about.

### 2. Counting or reviewing the bank
1. Use `mcp_trip_site_get_trivia_questions`.
2. Count from the returned list; do not guess from prior totals if questions may have changed.
3. If the user wants a subset, filter with the tool parameters when available (`persons`, `category`).

### 3. Starting a game
1. First call `mcp_trip_site_get_trivia_state`.
2. If state is already `lobby`, tell the user a game is already open.
3. If state is `question`, `reveal`, or `leaderboard`, do not blindly start a fresh game; tell the user the current phase.
4. If state is `idle` or `gameover`, call `mcp_trip_site_trivia_control(action='start')`.
5. Verify with another `get_trivia_state` call and report `status`, `gameId`, and whether players have joined.

### 4. Live host controls
Use these actions in sequence:
- `start` → opens lobby
- `launch` → begins first/current question from lobby
- `pause` / `resume` → manage timer
- `reveal` → show answer early
- `leaderboard` → move from reveal to score screen
- `next` → move to next question or gameover
- `restart` → keep players, reset game back to lobby
- `stop` → end immediately and persist scores

Always check state before and/or after a control action when the user asks to operate the live game.

### 5. Revealing question answers outside the game flow
1. If the user asks to reveal the answers/options for a trivia question, first call `mcp_trip_site_get_trivia_state`.
2. If status is `question`, `reveal`, `leaderboard`, or `lobby`, do **not** disclose the answers or hint which option is correct.
3. If status is `idle` or `gameover`, it is safe to show the options and/or the correct answer.
4. When the user asked about a person-specific question bank item, fetch that scoped subset again before answering so you quote the live options, not memory.

## Pitfalls
- **Answer limit:** the tool allows only 2–4 answers total. When the user gives 5 options, ask which wrong answer to remove.
- **Bilingual expectation:** when the user provided or requested bilingual questions, store both Hebrew and English rather than leaving one side blank.
- **Transient MCP write hiccups:** if a write fails but the MCP server still tests/connects, treat it as a transient session issue. Ask the user for a refresh/restart if needed and retry later rather than concluding the capability is unavailable.
- **Duplicates are possible:** the tool does not protect against semantically duplicate questions. If the same question may already exist, mention that and offer to check first.
- **"Category" can mean two different things in casual user wording:** users may ask "which categories have the fewest questions" while actually meaning **which people / `persons` buckets** are underrepresented. Do not assume they mean the literal `category` field (`family`, `trip`, etc.) without checking the surrounding context.
- **Per-person counts are not always a simple partition:** some questions are assigned to arrays of people (for example a question about two siblings). When reporting counts by person, count the question for each listed person and make clear you are reporting per-person membership, not a de-duplicated partition of the bank.
- **Large bank read vs. filtered reads:** if the full trivia bank payload is bulky, prefer filtered `get_trivia_questions(persons=...)` calls per relevant person when answering "who has the fewest / most questions". This is more reliable than relying on a stale remembered total.
- **Name transliteration questions:** when answer choices are place names or other proper nouns in English, and the user sounds unsure about the Hebrew spelling, provide Hebrew transliterations for the distractors too so the stored choices are readable in-game.
- **Answer-reveal safety:** when the user asks for answer options or the correct answer, do not reveal from memory alone. Check live trivia state first so you do not accidentally leak answers during an active game.

## Response style for this task
- Keep confirmations short and concrete.
- When a question is added, include: success, ID, person/category, and the final correct answer.
- When starting a game, include: current status and whether the lobby is open.
- When the user asks person-by-person inventory questions like "what are the questions about X?", answer with the **count + bare question titles** only.
- In those repetitive inventory turns, do **not** keep appending multiple follow-up offers (for example "I can also show answers / add more / compare counts") unless the user explicitly asks for next steps or pauses for guidance.

## Verification
- For question creation: verify the tool returned `ok: true` and an `id`.
- When the create response also includes `total`, treat that as the freshest question-count immediately after the write.
- If the user asks for the total again later, re-run `mcp_trip_site_get_trivia_questions` and count from the fresh result rather than relying on an older total or session summary.
- For filtered checks (for example `persons='hagit'`), re-fetch live before claiming whether a question exists or not; do not rely on earlier filtered counts after intervening edits.
- For game start/control: verify via `get_trivia_state` after the action.
- For answer reveals, verify `idle` or `gameover` via `get_trivia_state` before disclosing options or the correct answer.

## Pitfalls discovered in practice
- **Freshness after multiple edits:** when several questions are added in one session, earlier remembered totals can drift quickly. Prefer the latest MCP write result, then re-read if the user asks for a current count.
- **Scoped queries can mislead if stale:** a person-specific fetch may show an older subset than you expect from memory. If the result matters, re-run the scoped query right before answering.
