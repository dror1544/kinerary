---
name: trip-site-verification
description: Use when verifying live trip-site reads and writes.
version: 1.0.0
author: Kinerary
license: MIT
---

# Trip Site Verification

Use this skill whenever the task depends on the live trip site being readable, on checking what a traveler would actually see, or on proving that a change is visible after a write.

## When to use
- Confirming that the trip site loads and exposes real content
- Checking whether a phase, booking, roster item, or plan is visible
- Verifying a write on the traveler-facing site
- Finding the correct UI route before making a change

## Read-first workflow
1. Read the live public site first.
2. Prefer the human-facing page over hidden endpoints when you only need proof that the site is readable.
3. If a browser path fails, try a direct fetch of the public page before concluding anything about the site itself.
4. Use repo mirrors, local source files, or app code only to identify where the visible data is rendered.
5. Treat the site itself as the source of truth for traveler-visible state.

## Write verification
- Discover the current live state and the exact record or visible section before editing.
- After any write, read back the exact target.
- If the traveler-facing page still shows the old state, say so plainly and do not claim success.
- For day-plan changes, verify the rendered plan block, not just a hidden booking note or backend record.

## Pitfalls
- Do not treat a browser/tool failure as evidence that the site is down.
- Do not use API access denial as proof that no readable public content exists.
- Do not rely on repo code as the final source of truth for live state.
- Do not claim success without a read-back of the exact visible target.

## Reference notes
- Session-specific probes and examples live in `references/site-read-verification.md`.
