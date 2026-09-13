# Document reconciliation — 2026-09-09 session (Solomon Japan trip)

## What worked well

- PDF extracted successfully via `pymupdf` Python API (`fitz.open(path)` +
  `page.get_text()` per page). The document was a Yapan Tours booking PDF with
  RTL Hebrew text and structured booking tables.
- All hotels, activities, dates, and traveler count (5 adults) were present in
  the document and correctly extracted.
- Destination, departure date (2026-09-19), return date (2026-10-03), and full
  phases (Tokyo→Hakone→Kyoto→Osaka→Tokyo/Shibuya) were submitted before the
  first organizer reply about travelers.

## Pitfall: organizer sent one-word "יפן" (Japan) before document

The organizer sent "יפן" as their first message, then attached the PDF. The
interrupt context showed the first assistant response was cut off mid-sentence
("I'll read the document and check..."). The correct recovery:
1. Treat the word as confirming destination.
2. Read the PDF immediately alongside `get_interview_for_chat`.
3. Record destination from the PDF (more specific: city list), then dates, then
   phases — before the next organizer message.

## Traveler data pattern that worked

Organizer provided roster as:
```
אני ניר סולומון 56 / אלה אישתי בת 53 / נועה ביתי בת 25 סטודנטית / מאיה בת 23 / שי בת 14
```

Extracted to structured array with transliteration without asking:
```json
[
  {"name": "ניר סולומון", "name_en": "Nir Solomon", "age": 56, "family": "Solomon", "role": "organizer"},
  {"name": "אלה סולומון", "name_en": "Ela Solomon", "age": 53, "family": "Solomon"},
  {"name": "נועה סולומון", "name_en": "Noa Solomon", "age": 25, "family": "Solomon"},
  {"name": "מאיה סולומון", "name_en": "Maya Solomon", "age": 23, "family": "Solomon"},
  {"name": "שי סולומון", "name_en": "Shai Solomon", "age": 14, "family": "Solomon"}
]
```

Key observations:
- "אישתי" = wife; "ביתי" = my daughter — role context, not part of name.
- "סטודנטית" = student — occupation context, ignore for intake.
- Family name "סולומון" → Solomon (standard English transliteration).
- All 5 share one family; no multi-family logic needed.
- Transliteration shown to organizer for confirmation AFTER submission, not before.

## Phases from PDF: structure that was accepted

```json
{
  "name": "טוקיו", "name_en": "Tokyo",
  "start": "2026-09-19", "end": "2026-09-23",
  "accommodation": {"name": "OMO3 Asakusa by Hoshino Resorts", "address": "..."},
  "venues": [
    {"name": "Tokyo Skytree", "time": "2026-09-20T10:00"},
    {"name": "TeamLab Planets", "time": "2026-09-20T18:00"}
  ]
}
```

The `venues` key with `name` + `time` fields was accepted by the API.
Confirmation numbers were NOT in the document (Yapan Tours format omits them
from the PDF), so `accommodation.confirmation` was omitted.
