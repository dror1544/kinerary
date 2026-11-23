# Kinerary WhatsApp bridge

A small sidecar that holds one WhatsApp Web session (one number per process)
and exposes it to the relay over loopback HTTP. Spec:
`docs/specs/sprint-9/625-whatsapp-via-relay.md`, "Bridge sidecar and
`WhatsAppClient`". It has its own `package.json` so the WhatsApp library never
enters the control-plane API's dependency tree.

The bridge decides nothing. No allow-list, no pairing policy, no addressing rule,
no reply of its own: the relay decides who may talk to the companion.

## Run

```bash
npm ci
# link the phone once (prints a QR; the session is written to the directory and the process exits)
node src/bridge.js --session <dir> --pair-only
# serve
WHATSAPP_BRIDGE_SECRET=<16+ chars> node src/bridge.js --session <dir> --port <port>
```

- `--session <dir>` is required. It is a **credential** (full control of the
  WhatsApp account, plus the library's per-participant key files). It is created
  `0700`, and the bridge refuses a directory inside a git work tree. Keep it in
  the deployment's own state, never in this repository or an image.
- The bearer secret comes from `WHATSAPP_BRIDGE_SECRET` or `--secret-file <path>`
  (mode `0600`), never from an argument.
- The listener binds `127.0.0.1` only. The host is not a parameter.
- Starting, supervising and pairing the process on a real number is deployment
  work (`kinerary-deploy`), not this package's.

## Endpoints (every one needs `Authorization: Bearer <secret>`)

| Endpoint | |
|---|---|
| `GET /health` | `{ state, own: { lid, phone }, epoch, lastSeq, buffered, counters }`; state is `starting`, `connecting`, `connected`, `disconnected`, `logged_out` or `replaced` |
| `GET /messages?after=<seq>&epoch=<e>&waitMs=<ms>` | long-poll over a bounded ring; reading removes nothing; no `after` means "from now"; a different `epoch` means the bridge restarted; `lost` counts events that fell off the ring; a batch holds at most 100 events, `lastSeq` is the cursor of its LAST event and `more` says to ask again at once; messages delivered while the bridge was disconnected (`append`) are delivered if under 10 minutes old |
| `GET /media/<chatId>/<messageId>[?maxBytes=]` | bytes of a recent message's media, downloaded on demand; 404 once the bounded store dropped it |
| `POST /send` `{ chatId, text, replyTo?, mentions? }` | a `replyTo` quotes only a message of the same chat (`quoted: false` otherwise) |
| `POST /edit` `{ chatId, messageId, text }` | only a message the number sent, in that chat |
| `POST /typing` `{ chatId, state? }` | `composing` (default) or `paused` |
| `GET /chat/<id>` | a group's title and size; participant ids are not returned |
| `GET /chat/<id>/participant/<participantId>` | `inGroup` true or false, matched across id forms; 503 means "could not check", which is not "no" |

Ids contain `@` and `-` and travel percent-encoded in the path.

Events from `/messages` are `message`, `added_to_group` (with `addedBy` only when
the notification names its author), `participant_left` and `title_changed`.
Participants are in the linked-identity form (`<digits>@lid`); the phone form,
when known, is a separate optional `senderPhone`. A sender that cannot be
resolved is `senderId: null`; a private chat that cannot be resolved is not
delivered and is counted in `/health`.

## What is discarded, and what is never logged

Pairing hands the linked device the phone's address book and history-sync
notices. The bridge subscribes to neither, refuses history sync, and delivers
nothing for them. Log lines carry states, codes and counts only: no id, number,
name or message text, and an error is reduced to its status code. Tests:
`test/privacy.test.mjs`.

## Tests

```bash
npm test      # node --test; never connects to WhatsApp
```

The library is injected (`src/core.js` takes it as a parameter) and every test
uses a faked socket. Only `src/bridge.js` imports the real library.
