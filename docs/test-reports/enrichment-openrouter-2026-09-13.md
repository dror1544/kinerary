# Itinerary-item enrichment through OpenRouter — 2026-09-13

Endpoint: `POST /enrich` in `mcp/mcp.js` at `39ba81e`. The trip site's enrichment worker
calls it to add Google Maps, Waze, website and ticket links, plus the missing
language, to an itinerary item.

Setup: `mcp.js` started locally on the Mac mini, not on a trip site, with
`HERMES_EXTRACT_PROFILE=kinerary-extract`. `HERMES_BIN` pointed at a test wrapper
that appends `--provider openrouter --model minimax/minimax-m3` to the exact
Hermes call `mcp.js` makes. No trip data was read or written.

Result: 6 of 6 calls returned HTTP 200 from OpenRouter in 3–6 s with well-formed
answers, but 4 of the 6 website and ticket URLs are dead links.

## The model that answered

Hermes recorded all six sessions as model `minimax/minimax-m3`, billing provider
`openrouter`, so no fallback provider was involved. Tokens: 4,690 in, 561 out,
about $0.002 at OpenRouter's list price.

## Calls

| Item sent (context) | Kind | Time | Returned |
|---|---|---|---|
| Tokyo Skytree (Tokyo) | item | 6 s | Hebrew and English title, maps, Waze, website, ticket, needs tickets, book ahead |
| TeamLab Planets (Tokyo) | item | 6 s | same set |
| Maroon Bells shuttle from Aspen Highlands (Colorado) | item | 4 s | same set |
| Griffith Observatory, sent in Hebrew only (Los Angeles) | item | 5 s | English title "Griffith Observatory", maps, Waze, website |
| Pack the suitcases (Osaka) | item | 3 s | titles only, no links — correct for a non-place |
| Skytree 10:00 and TeamLab 18:00 on one day (Tokyo) | day headline | 4 s | "Tokyo Skytree + TeamLab Planets" in both languages |

## Links

All four places used the required `google.com/maps/search/?api=1&query=` and
`waze.com/ul?q=…&navigate=yes` forms.

Website and ticket URLs were fetched with `curl -L` and a browser user agent.
Each broken host's root was fetched as well, to rule out bot blocking.

| URL returned | Status |
|---|---|
| `https://www.tokyo-skytree.jp/en/` | 200 (redirects to `en.tokyo-skytree.jp`) |
| `https://www.tokyo-skytree.jp/en/ticket` | **404** — a real ticket page is at `/en/ticket/individual/` |
| `https://www.teamlab.art/en/planets/` | **404** — the real page `/e/planets/` answers 200 |
| `https://www.teamlab.art/en/planets/tickets/` | **404** |
| `https://www.aspen.com/experience/maroon-bells/` (website and ticket) | **404** — `aspen.com` answers 200 |
| `https://griffithobservatory.org/` | 200 (redirects to `griffithobservatory.lacity.gov`) |

## Findings

1. **Guessed URLs.** The prompt says to omit a link rather than guess, and this
   model guessed: 4 of 6 distinct website and ticket URLs are dead. `mcp.js`
   checks only that a link starts with `http(s)`, so a dead link would reach the
   family's itinerary.
2. **Hebrew quality.** The Maroon Bells Hebrew title mixes Hebrew and Latin
   letters inside one word. The day headline's Hebrew field is in Latin script;
   both parts are proper names, which the prompt allows.
3. **Speed.** 3–6 s per call, against the ~30 s per lookup that the comment in
   `mcp.js` records for the current provider chain.
4. **Production does not use OpenRouter for enrichment today.**
   - The `kinerary-extract` profile names `minimax/minimax-m3:free` on OpenRouter.
     OpenRouter's model list (445 models, fetched 2026-09-13) has no such id;
     `minimax/minimax-m3` exists as a paid model ($0.30/M input, $1.20/M output).
     `control-plane/api/src/model-runner.ts` already notes the `:free` id does not exist.
   - Mac profile, last 30 days: 15 sessions on `claude-sonnet-4-6` (Anthropic),
     10 on `gpt-5.6-sol` (6 via OpenAI Codex, 4 with no provider recorded),
     none on OpenRouter.
   - VM: Hermes has no OpenRouter key, so enrichment there also runs on the
     fallback providers.

## Not covered

- One run with one model; no side-by-side run on the current fallback chain.
- Not run on a trip site or on the VM; the site's storage of the result was not exercised.
- The `schedule_review` kind was not called.

The six test sessions remain in the Mac `kinerary-extract` profile's
`state.db`, tagged `or-enrich-test`.
