# WhatsApp trigger alignment notes

Use when the user wants WhatsApp group behavior to match the Telegram family group as closely as Hermes allows.

Key working pattern
- Keep WhatsApp DMs restricted by the existing allowed-users list.
- For group quietness, set:
  - `whatsapp.require_mention: true`
  - `whatsapp.free_response_chats: ''`
  - `whatsapp.mention_patterns` to the same family wake words used on Telegram
- Do not use `whatsapp.group_policy: open` unless allow-all was explicitly chosen.

Why not `group_policy: open`
- Hermes validates open DM/group policy at gateway startup.
- If `dm_policy` or `group_policy` is `open` and neither `GATEWAY_ALLOW_ALL_USERS` nor `WHATSAPP_ALLOW_ALL_USERS` is enabled, gateway startup can be refused.

Working workaround
- `whatsapp.group_policy: allowlist`
- `whatsapp.group_allow_from: '*'`
- `whatsapp.require_mention: true`

Effect
- Groups are accepted at the access-policy layer.
- The behavior layer still stays quiet unless the bot is mentioned, replied to, or called by a configured wake word.
- This is good for broad WhatsApp-group availability without opening DMs to everyone.

Tradeoff
- `group_allow_from: '*'` is not as strict as Telegram's specific `group_allowed_chats` setup.
- For exact parity, replace `'*'` with specific WhatsApp group JIDs after the bot has joined the intended family group(s).

Verification markers
- Gateway log loads WhatsApp mention patterns.
- Gateway log shows `✓ whatsapp connected`.
- A normal group message does not trigger a reply.
- A message with a wake word like `ויקטור` does trigger a reply.
