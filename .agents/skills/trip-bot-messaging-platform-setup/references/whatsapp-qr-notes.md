# WhatsApp QR setup notes

Use alongside the umbrella skill `trip-bot-messaging-platform-setup`.

## What worked

- Repair Node first if the WhatsApp bridge cannot start.
- Run `hermes whatsapp` in the active trip profile.
- Use bot-number mode and enter a normalized allowlist (country code, no `+`, no spaces).
- If the QR shown inside chat is unreliable, open a real Terminal window on the Mac and scan the live QR there.
- After pairing, verify `creds.json` and related session files exist under the active profile's `whatsapp/session/` directory.
- Enable WhatsApp in profile config, then restart/start the gateway.
- Confirm log lines showing real adapter connection, not just config success.

## Important pitfall: service PATH can lag behind Node repair

A repaired shell PATH does not guarantee the supervised gateway service sees the same Node.

If the gateway still says WhatsApp requirements are not met after pairing:
1. Inspect the service definition / launchd environment.
2. Reinstall or force-refresh the gateway service so its PATH includes the healthy Node path.
3. Start the service again.
4. Re-check logs for `✓ whatsapp connected`.

## Practical scanning rule

When the user says the QR is failing but WhatsApp Web in a browser works, prefer this interpretation:
- the terminal QR rendering/copy path is the problem, not necessarily the account or number.

Best response:
- present the QR in a live local terminal window
- ask the user to scan directly from that screen
- avoid repeated pasted QR attempts unless there is no other option
