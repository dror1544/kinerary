# Flight monitoring setup (session notes)

During this session we introduced a concrete pattern for low‑token flight‑status monitoring:

1. **Shared helper** – `~/.hermes/scripts/familytrip_flight_watch_common.py` fetches from FlightAware and FlightStats, normalises the data, writes a `latest.json` snapshot, and prints `[SILENT]` when nothing changed.
2. **Per‑flight wrapper scripts** – one tiny script per flight/day (e.g. `familytrip_watch_aa1820_2026_07_09.py`) that imports the helper, supplies a static config dict (carrier, flight number, date, optional `route_hint`), runs the helper, stores the JSON under `notes-rw/flight-status-json/<date>/<flight>/latest.json`, and prints the JSON for the cron delivery.
3. **Cron job definition** – each wrapper is scheduled via `hermes cron add` with `Mode: no-agent` so the script stdout is sent directly to Telegram, avoiding LLM token consumption. The job includes `Deliver: telegram:<your‑id>`.
4. **Change detection** – the wrapper computes a SHA‑256 hash of the normalized JSON; if the hash matches the previous snapshot the script outputs `[SILENT]`, causing the cron to emit no message.
5. **Verification** – run the wrapper manually twice; the second run should print `[SILENT]`. After confirming, add the cron entry.
6. **Pitfalls captured** –
   - FlightAware URLs represent the *live* leg, not a future flight. We added a `date_match` check against the target travel date to avoid false‑positive data.
   - FlightStats may return `detail_available: false` for far‑future flights; treat that as “no live status yet”.
   - Route mismatches (e.g. carrier code‑reversal) are flagged in the JSON (`route_match: false`).
   - Scripts must live under `~/.hermes/scripts/`; paths elsewhere are blocked by Hermes.

**Result** – A robust, reusable, low‑cost monitoring system that can be extended to any future flight simply by copying the wrapper template and adjusting the config.
