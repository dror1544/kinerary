# Site read verification notes

Session-proven pattern for proving the trip site is readable:

- Start with the public homepage and extract the human-facing content.
- Use the homepage as evidence that the site is live and serving real trip data.
- If a browser navigation path fails, do not treat that as proof the site is unreadable.
- If a hidden API endpoint is blocked, fall back to the public page and any visible route you can inspect.
- Use repo/source searches only to find where the visible data is rendered, not as the source of truth.

Observed example from the live site:
- Homepage text included: `Family Trip`, `17 People · 26 Days · 4 Families`.
- The public homepage exposed participant chooser tiles and the main trip shell.

Use this note as a lightweight probe guide, not as a replacement for the live site.
