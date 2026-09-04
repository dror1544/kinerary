# Booking field checklist

Use this as a compact extraction/handoff template when a travel confirmation arrives.

## Minimum fields
- Source file path
- Booking/vendor name
- Confirmation number
- Holder name
- Date / date range
- Time (if timed entry)
- Phase / city match
- Booking type
- Passenger count
- Cost
- Operational location / address

## Nice-to-have fields
- Voucher breakdown (adult / child / senior)
- Reply-to or support contact
- PIN / access code
- Linked attachments or voucher pages

## Matching note template

```md
# <booking name> — confirmation match

Source file: `<absolute path>`

## Extracted facts
- Confirmation:
- Holder:
- Date:
- Time:
- Location:
- Passengers:
- Cost:

## Trip-plan match
- Phase:
- File + section:
- Reason for match:

## Suggested website entry
- Phase:
- Type:
- Name:
- Date/date range:
- Confirmation:
- Passengers:
- Cost:
- Notes:

## Blocker
- None / auth required / ambiguous mapping / missing field
```

## Session-specific note
In this session, a forwarded Gmail PDF for **Maroon Bells Shuttle** required ignoring email wrapper text and capturing the embedded reservation details instead. The correct trip match was Colorado → Wed 2026-07-15 → Maroon Bells, and when the site API returned unauthorized, the right fallback was a note in `notes-rw/confirmation-matches/` rather than claiming the booking had been added.
