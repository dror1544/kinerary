# MCP readiness and imagery notes

## Telegram readiness signals
- `health_check.ok: true` means the trip server answered.
- `health_check.telegramBotUsername: null` means Telegram Login is **not** configured yet, even if the site itself is up.
- Do not promise group binding until `telegramBotUsername` is non-null.

## Group binding prerequisites
- The bot must be added to the Telegram group.
- The bot must actually observe a message in that group.
- The binding tool requires the real negative Telegram `chat_id` from that observed group message.
- If the organizer is not Telegram-bound in the trip system yet, the bind step may fail until that organizer binding exists.

## Live config fallback
When the local `trip-config-readonly` symlink is broken or the target path is missing, use `mcp__trip_mcp__get_config` as the authoritative source instead of treating the trip data as unavailable.

## Image-scope clarifier
If the organizer asks to "change the image," clarify the target with the smallest possible fork:
1. site-wide logo / main image
2. a specific phase hero image (for example Honolulu or Maui)

## Hawaii image suggestion patterns
Good fast options to offer:
- Waikiki panorama with bright turquoise water
- palm-lined beach with clear sky
- colorful sunset over the water
- Maui tropical coastline with vivid greens and blues
