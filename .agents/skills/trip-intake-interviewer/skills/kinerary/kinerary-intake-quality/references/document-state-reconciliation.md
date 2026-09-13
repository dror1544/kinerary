# Document/state reconciliation pattern

## Validated sequence

1. Read the current interview state before processing the new turn.
2. Extract the attached PDF text with PyMuPDF. For RTL booking PDFs, render pages when names, counts, or table order are ambiguous.
3. Separate facts into: destination/dates (text), phases and bookings (structured), roster (only if names and ages are present), and optional interests.
4. Record document-established fields before speaking. If a write fails, do not claim success; retry the direct chat-scoped path once, then escalate and stop if it still fails.
5. Re-read state. The next question and recorded selections determine what still needs a response.
6. When the organizer later confirms a transliteration, submit the same traveler roster with `name_en` and `family_en`; confirmation is a correction/update, not a new traveler list.

## Common ambiguity checks

- “5 adults” is a headcount, not five traveler records.
- “No” or “none” typed in response to a multi-choice question may not reflect the current router selection. Trust the state readback, then correct the option set if needed.
- “Kosher” and “kosher-style” are different options; do not weaken a stated kosher requirement.
- Any non-`none` dietary selection needs a matching scope object immediately (everyone or exact traveler names).
- A student label can remain conversational context unless the organizer asks for it to become a standing trip constraint.
