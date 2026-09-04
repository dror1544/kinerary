---
name: trip-bot-messaging-platform-setup
description: Configure additional messaging platforms for the family trip bot, with a focus on low-friction setup, safe access controls, and post-setup verification.
---

# Trip bot messaging platform setup

Use this skill when you are:
- adding a new messaging platform to the family trip bot
- pairing or enabling WhatsApp for the trip bot
- updating platform allowlists / authorized senders for a trip messaging channel
- restarting or reloading the trip gateway after platform setup
- verifying that a newly added platform is actually connected

This skill is for trip-bot channel expansion. It complements group-reply style skills and Hermes core docs.

## Goals

1. Add the platform with the least family friction.
2. Keep access restricted to intended participants unless the user explicitly wants open access.
3. Verify the platform is truly connected in gateway logs/status, not just configured.
4. Preserve existing platforms like Telegram while adding the new one.

## Default recommendation for WhatsApp

For the family trip bot, prefer:
- a dedicated WhatsApp number
- QR pairing (`hermes whatsapp`) for quick setup
- a strict allowed-users list unless the user explicitly wants open access

Use the official WhatsApp Cloud API only when the user wants a production-grade long-term business bot and is willing to handle Meta Business setup plus a public webhook.

## WhatsApp QR setup workflow

1. Load Hermes guidance first if needed (`hermes-agent` docs/skill) for current command names.
2. Confirm the gateway is already running and note the active profile.
3. Run the QR setup flow with:
   - `hermes whatsapp`
4. Prefer **separate bot number** mode unless the user explicitly wants self-chat.
5. When prompted for access control:
   - ask for allowed phone numbers with country code and no plus signs
   - normalize user-supplied numbers before submission
6. Let the wizard install bridge dependencies and present the QR.
7. For scanning, have the user scan the QR from a real terminal window on the Mac when possible.
   - Do not rely on a QR copied through chat if the live terminal is available.
8. After pairing succeeds, verify session credentials were created in the profile's WhatsApp session directory.
9. Enable the platform in profile config.
10. Restart or start the gateway.
11. Verify actual connection in logs, ideally with a line equivalent to:
   - `Connecting to whatsapp...`
   - `Bridge found at .../bridge.js`
   - `✓ whatsapp connected`
12. Ask the user to send a simple test message from an allowed number.

## Access-control rules

- Default to an allowlist for family-trip WhatsApp bots.
- Normalize numbers by removing spaces and `+` before entering them.
- Preserve the full family allowlist if the user provides several numbers at once.
- Only use allow-all if the user explicitly chooses that tradeoff.

## Matching Telegram-style quiet group behavior on WhatsApp

When the user wants WhatsApp to behave like the Telegram family group — mostly silent unless directly addressed — configure the behavior layer, not just the phone allowlist.

Recommended baseline:
- `whatsapp.require_mention: true`
- `whatsapp.free_response_chats: ''`
- `whatsapp.mention_patterns`: reuse the family wake words already used on Telegram when appropriate (for example Hermes / הרמס / bot / Victor / ויקטור)

Important safety nuance:
- Do not set `whatsapp.group_policy: open` unless the user explicitly opted into allow-all with `GATEWAY_ALLOW_ALL_USERS` or `WHATSAPP_ALLOW_ALL_USERS`.
- Hermes can refuse to start the gateway if WhatsApp DM/group policy is `open` without that allow-all opt-in.

Safer workaround for quiet-group behavior without opening WhatsApp to everyone:
- set `whatsapp.group_policy: allowlist`
- set `whatsapp.group_allow_from: '*'`
- keep `require_mention: true`

That combination keeps groups mention-gated while avoiding the startup refusal tied to `group_policy: open`.

If the user later wants exact Telegram-style chat restriction, tighten further by replacing `group_allow_from: '*'` with the specific WhatsApp group JIDs after the bot has joined the intended family group(s).

## Verification checklist

A setup is only complete when all of these are true:
- pairing completed successfully
- WhatsApp session credentials exist for the active profile
- profile config has WhatsApp enabled
- gateway restarted or started successfully
- gateway logs show WhatsApp connected
- at least one real test message is requested from an allowed sender

## Approval-routing hardening for mixed-platform trip bots

When the family trip bot is reachable from a group platform like WhatsApp, treat dangerous-command approvals as an **admin-channel routing problem**, not just an auth problem.

Recommended default for this trip profile:
- send approvals only to Dror's private Telegram DM
- do not let approval prompts appear back in the WhatsApp group
- keep the approval tied to the original session key so the Telegram approval resolves the correct WhatsApp-originated request

Useful config pattern:
- `approvals.route_platform: telegram`
- `approvals.route_chat_id: <Dror Telegram user/chat id>`
- optional `approvals.route_thread_id` if the admin channel is a topic/thread rather than a plain DM

Behavior note:
- if `route_chat_id` is omitted, the implementation can safely fall back to the configured home channel for that platform
- this is appropriate for "all approvals go to the admin Telegram home chat" policies

Verification after changing routing:
1. confirm the profile config contains the approval route keys
2. restart the gateway from **outside** the running gateway process
3. trigger a harmless approval-requiring action from the non-admin platform
4. verify the approval prompt lands in Telegram DM, not in the source WhatsApp group
5. approve it there and confirm the original session resumes

## Pitfalls

- QR codes rendered into copied chat text may fail even when the live terminal QR is valid. Prefer scanning from the live Mac terminal window.
- After repairing or changing Node, the managed gateway service may still hold an old PATH in its launchd/service definition. Reinstall/reload the gateway service so the new Node path is picked up before judging WhatsApp setup as failed.
- Do not stop at "paired" alone; pairing without enabling the platform and verifying gateway connection is incomplete.
- Do not loosen access controls by default just to get a faster setup.
- Do not disable existing trip channels like Telegram unless the user asks.

## When to prefer Cloud API instead

Choose `hermes whatsapp-cloud` only if the user explicitly values:
- official Meta support
- lower account-risk
- long-term stability
- willingness to manage webhook/public-URL setup

## Support files

- `references/whatsapp-qr-notes.md` — concise notes from a real successful QR setup, including QR-rendering and service-reload pitfalls.
- `references/whatsapp-trigger-alignment.md` — notes on making WhatsApp group triggers behave like the Telegram family group without tripping Hermes open-policy startup checks.
