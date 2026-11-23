# Notice

Parts of this package are adapted from the WhatsApp bridge that ships with
Hermes Agent (`scripts/whatsapp-bridge/`), which is MIT-licensed:

> MIT License
>
> Copyright (c) 2025 Nous Research
>
> Permission is hereby granted, free of charge, to any person obtaining a copy
> of this software and associated documentation files (the "Software"), to deal
> in the Software without restriction, including without limitation the rights
> to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
> copies of the Software, and to permit persons to whom the Software is
> furnished to do so, subject to the following conditions:
>
> The above copyright notice and this permission notice shall be included in all
> copies or substantial portions of the Software.
>
> THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
> IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
> FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
> AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
> LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
> OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
> SOFTWARE.

What was taken, and in which file:

| Idea or code | Where it lives here |
|---|---|
| Stripping the `:<device>` suffix so the number's own ids compare equal | `src/ids.js` (`stripDevice`) |
| Peeling message envelopes (ephemeral, view-once, caption wrappers) | `src/events.js` (`unwrap`) |
| The bounded, oldest-first message store | `src/events.js` (`createMessageStore`) |
| One `sendMessage` at a time on a socket, with a timeout | `src/core.js` (`enqueue`, `withTimeout`) |
| Reconnect scheduling that survives a failed reconnect | `src/core.js` (`scheduleReconnect`) |
| A bounded fetch of the current WhatsApp Web version, falling back to the library's | `src/core.js` (`connect`) |
| The pair-only flow and the restart-required close after a scan | `src/pairing.js` |

What was deliberately NOT taken: the allow-lists and pairing policy, the reply
prefix, polls, locations, media caches on disk, the owner-message gate, the
phone-preferred sender form, every log line that named an id, and
`process.exit` on logout. This bridge decides nothing about who may talk to the
companion; the relay does.

The address book and history-sync notices that pairing delivers to a linked device
are not forwarded and not logged by this bridge. (The library itself persists
linked-identity-to-phone mappings in the session directory, so "not stored" would
overstate it; the directory is a credential for that reason, and the bot's number
should have an empty address book.)

The WhatsApp Web client library, `@whiskeysockets/baileys`, is a separate
dependency under its own licence, pinned to the exact version the capture in
`docs/specs/sprint-9/625-whatsapp-via-relay.md` (AC-0) was taken on.
