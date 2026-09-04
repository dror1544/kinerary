# San Francisco cable car ticket caution example

Use case: the user bought a MuniMobile Cable Car Single Ride ticket after asking whether it could be bought before the travel day. The assistant gave conflicting advice about validity/expiration and the user lost trust.

## Durable lesson

For transit app tickets and other paid trip logistics, never infer validity or expiration from general knowledge when the user is looking at a live app screen. Ask for or read the exact visible fields first.

## Safe workflow

1. Confirm the ticket/pass type the user selected.
2. Separate these states:
   - **Purchased / Available**: paid for, not yet active.
   - **Active / Activated / Use**: started and may expire soon.
   - **Expired**: no longer usable.
3. If the screenshot shows an expiration date, ask the user to transcribe it if there is any ambiguity.
4. Tell the user what *not* to press before explaining next steps.
5. If refund/support is needed, choose the category that matches the issue:
   - Purchasing ticket: bought the wrong thing / bought too early / not activated.
   - Accidental activation: only if the user actually activated it.
   - Duplicate purchase: only if bought twice.

## Good response pattern

"I can see the ticket is in Available, so do not activate it now. I cannot confidently read the expiration line from the screenshot. Please tell me exactly what it says before we decide whether it is safe for tomorrow."

## Bad response pattern

- Say "buy now, activate tomorrow" without checking the app's ticket validity rules.
- Reverse course based on a partial read of the screenshot.
- Treat an ambiguous date like 08/18 or 07/18 as obvious without verifying locale/date format and current trip date.

## User trust recovery

If the user is upset because of paid-ticket advice:
- apologize briefly and directly
- stop defending the earlier answer
- move immediately to practical recovery: do not activate, avoid duplicate purchases, find refund/support category, preserve screenshots/receipts
