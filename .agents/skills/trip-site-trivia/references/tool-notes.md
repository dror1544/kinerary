# Trip Site Trivia Tool Notes

## Question bank
- `get_trivia_questions` returns the full bank as a list.
- Useful filters:
  - `persons=<username|general|trip>`
  - `category=<tag>`
- Total question count can be derived from the list length.

## Add question schema
Required practical fields:
- `he`
- `en`
- `persons`
- `answers` (2–4 items)

Answer item fields:
- `he`
- `en`
- `correct` (`true` on exactly one answer)

Useful optional fields:
- `duration` (default to 20 when unspecified)
- `category` (`family` or `trip` are the common values)

## Common person values seen in the bank
`yosi, chana, dror, adva, orit, yaniv, hagit, kfir, ron, idan, shira, hadar, shaked, liam, noam, mia, romy, general, trip`

## Game state values
- `idle`
- `lobby`
- `question`
- `reveal`
- `leaderboard`
- `gameover`

## Host control actions
- `start`
- `launch`
- `pause`
- `resume`
- `reveal`
- `leaderboard`
- `next`
- `restart`
- `stop`

## Session note worth remembering
A failed write with session-level `ClosedResourceError` did not mean the feature was absent; after retrying later, question creation succeeded and returned IDs normally. Preserve the retry/refresh pattern, not the temporary failure itself.
