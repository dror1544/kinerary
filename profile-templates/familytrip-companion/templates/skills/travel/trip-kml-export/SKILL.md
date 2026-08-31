---
name: trip-kml-export
description: Export trip places to KML (hotels, attractions, restaurants, or all) and send the file to the group or organizer.
version: 1.0.0
author: Nahum / Hermes
license: MIT
metadata:
  hermes:
    tags: [travel, kml, maps, export, google-maps, offline, places, family-group]
    category: travel
---

# Trip KML Export

Use this skill when someone asks to export trip locations to Google Maps — as a downloadable file, a shareable map, or a navigation list.

## Trigger phrases
- "תוציא את כל המקומות בטיול"
- "תשלח את המלונות למפה"
- "תייצא אטרקציות ל-Google Maps"
- "תכין קובץ KML / GPX"
- "תשתף את כל המקומות עם הקבוצה"
- "תוציא רק את [סוג]" — מסעדות / מלונות / אטרקציות

## Filter modes

| בקשה | --filter |
|---|---|
| "כל המקומות" / לא צוין | `all` |
| "רק מלונות" / "לינה" | `hotels` |
| "אטרקציות" / "סייטים" | `attractions` |
| "מסעדות" | `restaurants` |
| "כל ההזמנות" | `all_bookings` |

---

## Workflow

### 1. Read live trip data
```python
config   = mcp__trip_mcp__get_config()
bookings = mcp__trip_mcp__get_bookings()   # may be empty — that's ok
```

### 2. Run the export script
```bash
SCRIPT="$PROFILE_SKILLS_DIR/travel/trip-kml-export/scripts/trip_kml_export.py"
OUTPUT="/tmp/trip_export_$(date +%s).kml"

echo '{"config": <config_json>, "bookings": <bookings_json>}' \
  | python3 "$SCRIPT" --filter <mode> --output "$OUTPUT"
```

Concrete terminal call (use execute_code or terminal):
```python
import json, subprocess, tempfile, time

config_json   = ...   # dict from get_config
bookings_json = ...   # list/dict from get_bookings

payload = json.dumps({"config": config_json, "bookings": bookings_json}, ensure_ascii=False)
output_path = f"/tmp/trip_{int(time.time())}.kml"
script = "$PROFILE_SKILLS_DIR/travel/trip-kml-export/scripts/trip_kml_export.py"

result = subprocess.run(
    ["python3", script, "--filter", FILTER_MODE, "--output", output_path],
    input=payload, capture_output=True, text=True
)
meta = json.loads(result.stdout)
print(meta)   # {"ok": true, "file": "...", "placemarks": N, "trip": "..."}
```

### 3. Verify result
- `meta["ok"]` must be `true`
- `meta["placemarks"]` > 0 — if 0, warn the user that no coordinates were found for the requested filter
- The file must exist at `meta["file"]`

### 4. Send the file
- **To the group** (if organizer approved or request came from group): send as file attachment via Telegram — include a short message with the filter label and a usage tip.
- **To the organizer only** (if in doubt): send privately to שירן.

**Message template (group):**
```
📍 קובץ המקומות מוכן — [filter label] ([N] מקומות)
ייבוא ל-Google Maps: לחצו על הקובץ → "פתח בـ..." → Google Maps → "ייבא"
עובד גם אופליין אחרי הייבוא 🗺️
```

**Message template (organizer private):**
```
הכנתי את קובץ ה-KML עם [N] מקומות ([filter label]).
שלח לקבוצה? אני יכול לשתף ישירות.
```

---

## Sending the file via Telegram
Include the absolute path in the response wrapped in `MEDIA:`:
```
MEDIA:/tmp/trip_1234567890.kml
```
Hermes will deliver it as a file attachment.

---

## Coordinate coverage note
The script extracts coordinates from:
- Phase `accommodation` objects (hotels)
- Bookings with `lat`/`lon`/`latitude`/`longitude` fields

**If a place has no coordinates** — it is silently skipped (not included in KML). After export, tell the user how many places were exported. If the count seems low, check whether the missing places have coordinates in the config/bookings and offer to look up their coordinates via the `maps` skill and update them.

---

## Pitfalls
- Do not send the KML to the group without the organizer's approval unless the request came from the group itself.
- Do not fabricate coordinates. Only export what is in the verified config/bookings.
- If `get_bookings` fails or returns empty, still export hotels from the config and note that attraction/booking data was unavailable.
- The file is temporary (`/tmp/`). Do not reference it after the current session as if it persists.
- KML opens natively in Google Maps mobile (tap → "Open with" → Google Maps). Mention this in the message.

---

## Example output message
> 📍 **מפת הטיול מוכנה** — כל המקומות (12 מקומות)
> 
> כולל: מלונות, אטרקציות והזמנות עם קואורדינטות.
> 
> **איך לפתוח:** לחצו על הקובץ → שתפו / פתחו בGoogle Maps → "ייבא מקובץ"
> עובד אופליין אחרי הייבוא 🗺️
