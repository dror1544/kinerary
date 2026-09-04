---
name: flight-json-watch-crons
description: Create low-token cron-based flight monitoring for the family trip using no-agent Python scripts that fetch FlightAware/FlightStats, save structured JSON snapshots, and only notify on material changes.
---

# Flight JSON watch crons

<!-- Added reference to setup notes -->

Reference: `references/flight-monitoring-setup.md`

Use when Dror wants recurring flight checks on flight days with structured JSON output that can later update the trip site and avoid unnecessary LLM token usage.

## Steps
1. Create a shared Python helper under `~/.hermes/scripts/` that:
   - fetches at least two sources (`FlightAware` and `FlightStats` worked)
   - normalizes `status`, `delay_minutes`, `is_delayed`, departure/arrival terminals, gates, and scheduled/estimated/actual times
   - writes `latest.json` plus timestamped history under `~/familytrip-workspace/notes-rw/flight-status-json/<flight-slug>/`
   - computes a fingerprint of material fields and prints `[SILENT]` when unchanged.
2. Create one wrapper script per watched flight/day because Hermes cron scripts do not accept argv. Put the booking-specific config in each wrapper.
3. For future-dated flights, distrust live-source pages that only expose the airline's current same-number flight. Add a `date_match` check against the target travel date and refuse to promote mismatched live data to the normalized result.
4. Create cron jobs with the current Hermes CLI shape: `hermes cron create <schedule> --deliver telegram:391627336 --no-agent --script <wrapper.py> --workdir /Users/elul/familytrip-workspace` so stdout is delivered directly and no routine LLM call is spent on checks.
   - Use `--deliver telegram:<chat_id>` rather than older `--target/--chat-id` flag pairs.
   - Pass only the **filename** to `--script` (for example `familytrip_watch_aa2359_2026_07_12.py`), not an absolute path.
   - **Preflight the actual runtime resolution before scheduling:** for a `familytrip` profile, verify that the exact filename exists under `/Users/elul/.hermes/profiles/familytrip/scripts/` (the no-agent runner may resolve relative script names there), even when the authoring workflow created the wrapper under `~/.hermes/scripts/`. If it is missing, install a real profile-local copy before creating or enabling the job.
5. For a same-day intensive watch window (for example every 5 minutes from a specific departure/arrival checkpoint until landing), create a dedicated loop wrapper that:
   - calls `build_report()`, `save_report()`, and `maybe_emit()`
   - detects landed/arrived status
   - removes any remaining future cron jobs with the same name prefix once landing is confirmed
6. If the delivery target is a **family group** instead of Dror's private DM, do not reuse the default `build_message()` output as-is. Create a group-facing wrapper that still dedupes with a fingerprint but formats a short clean message in the family's language (no JSON paths, no tool-like phrasing, no raw debugging text).
7. Schedule the intensive watch as many one-off jobs (`hermes cron create 'YYYY-MM-DD HH:MM' ...`) instead of one repeating job. This makes it easy for the landing-detection script to delete the remaining future checks cleanly.
8. Verify by running each wrapper manually once, then run it again to confirm the second run returns `[SILENT]` when nothing changed.
8. Confirm with `hermes cron list --all` that each job shows:
   - `Deliver: telegram:391627336`
   - `Script: familytrip_watch_<...>.py`
   - `Mode: no-agent (script stdout delivered directly)`
9. After any edits or rescheduling, verify that all **expected named one-shot jobs still exist**. If an expected pre-departure job is missing, recreate it immediately before assuming the watcher itself is broken.
10. If Dror forwards or replies to a cron failure alert, do not just explain the error. First attempt an immediate self-heal using the concrete failure text (fix path/import/job issues, rerun the exact failing script path, and verify the next relevant cron state). Only ask Dror a question when the fix truly requires missing information or approval.
11. If Hermes sends Dror a cron-failure message proactively, the same response (or the immediate next reply) should include action, not just the raw error: either (a) `ניסיתי לתקן והמצב עכשיו ...` with verification status, or (b) a short question stating exactly what missing input/approval is needed. Do not leave a bare failure alert hanging without attempted remediation context.

## Useful paths
- Shared helper: `~/.hermes/scripts/familytrip_flight_watch_common.py`
- Per-flight wrappers: `~/.hermes/scripts/familytrip_watch_<carrier><flight>_<date>.py`
- JSON output: `~/familytrip-workspace/notes-rw/flight-status-json/`

## Pitfalls
- `FlightAware /live/flight/<ident>` is for the current live leg, not an arbitrary future date. Without `date_match`, it can wrongly look valid for a future trip flight.
- `FlightStats` may return `detail_available: false` for future dates until closer to departure. Treat that as "no structured live status yet", not as an error.
- Flight numbers in bookings can sometimes mismatch the booked route. Keep `route_hint` in config and surface route mismatches in JSON and alerts.
- Do not assume that creating the wrapper under `~/.hermes/scripts/` is sufficient: the active profile's no-agent runner can resolve the filename under `/Users/elul/.hermes/profiles/familytrip/scripts/`. Verify both the authoring path and the exact runtime path before scheduling.
- If a cron failure says `Script not found: ~/.hermes/profiles/<profile>/scripts/<name>.py` even though the job lists only a filename under `Script:`, create a real copy of the wrapper at that profile-local path (not a symlink) and include `sys.path.append(str(Path('~/.hermes/scripts').expanduser()))` before importing `familytrip_flight_watch_common`. Verify by running the exact failing path once. Symlinks can be blocked because the resolved path points outside the profile-local scripts directory.

## Verification commands
```bash
python3 ~/.hermes/scripts/familytrip_watch_aa2359_2026_07_12.py
python3 ~/.hermes/scripts/familytrip_watch_aa2359_2026_07_12.py   # should print [SILENT] on repeat
hermes cron list --all | grep -A8 'familytrip-flight-watch-'
```
