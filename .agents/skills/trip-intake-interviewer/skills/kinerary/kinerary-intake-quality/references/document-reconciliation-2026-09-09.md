# Document reconciliation — 2026-09-09 session (worked example, family invented)

## What worked well

- PDF extracted successfully via `pymupdf` Python API (`fitz.open(path)` +
  `page.get_text()` per page). The document was a tour operator's booking PDF with
  RTL Hebrew text and structured booking tables.
- All hotels, activities, dates, and traveler count (5 adults) were present in
  the document and correctly extracted.
- Destination, departure date, return date, and full
  phases (a multi-city route) were submitted before the
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
אני רון מרגולין 47 / טלי אישתי בת 45 / יעל ביתי בת 21 סטודנטית / דנה בת 18 / גל בת 11
```

Extracted to structured array with transliteration without asking:
```json
[
  {"name": "רון מרגולין", "name_en": "Ron Margolin", "age": 47, "family": "Margolin", "role": "organizer"},
  {"name": "טלי מרגולין", "name_en": "Tali Margolin", "age": 45, "family": "Margolin"},
  {"name": "יעל מרגולין", "name_en": "Yael Margolin", "age": 21, "family": "Margolin"},
  {"name": "דנה מרגולין", "name_en": "Dana Margolin", "age": 18, "family": "Margolin"},
  {"name": "גל מרגולין", "name_en": "Gal Margolin", "age": 11, "family": "Margolin"}
]
```

Key observations:
- "אישתי" = wife; "ביתי" = my daughter — role context, not part of name.
- "סטודנטית" = student — occupation context, ignore for intake.
- Family name "מרגולין" → Margolin (standard English transliteration).
- All 5 share one family; no multi-family logic needed.
- Transliteration shown to organizer for confirmation AFTER submission, not before.

## Phases from PDF: structure that was accepted

```json
{
  "name": "טוקיו", "name_en": "Tokyo",
  "start": "2026-03-01", "end": "2026-03-05",
  "accommodation": {"name": "Example Hotel Asakusa", "address": "..."},
  "venues": [
    {"name": "Tokyo Skytree", "time": "2026-03-02T10:00"},
    {"name": "TeamLab Planets", "time": "2026-03-02T18:00"}
  ]
}
```

The `venues` key with `name` + `time` fields was accepted by the API.
Confirmation numbers were NOT in the document (this operator's format omits them
from the PDF), so `accommodation.confirmation` was omitted.
