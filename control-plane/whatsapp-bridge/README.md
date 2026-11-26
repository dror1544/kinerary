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
WHATSAPP_BRIDGE_SECRET=<32+ chars, no whitespace> node src/bridge.js --session <dir> --port <port>
```

- `--session <dir>` is required. It is a **credential** (full control of the
  WhatsApp account, plus the library's per-participant key files). It is created
  `0700`, and the bridge refuses a directory inside a git work tree. Keep it in
  the deployment's own state, never in this repository or an image.
- The bearer secret (at least 32 characters, no whitespace) comes from
  `WHATSAPP_BRIDGE_SECRET` or `--secret-file <path>` (mode `0600`), never from an
  argument; the environment variable is removed from the process's environment
  once read.
- Serving needs a paired session: with no registered credentials the process
  exits 3 before the library is loaded; a QR request while serving sets state
  `unpaired` on `/health` and the bridge stops (it never reconnects in a loop).
- The relay's `bridge_url` must be exactly `http://127.0.0.1:<port>`: not
  `localhost`, not `[::1]`, not a numeric spelling of the address.
- The listener binds `127.0.0.1` only. The host is not a parameter.
- On the control-plane VM it runs as a container built from this directory's
  `Dockerfile` (`kinerary-cp/whatsapp-bridge:<rev>`), added by the optional overlay
  `control-plane/deployment/compose.vm.whatsapp.yml` and paired with
  `control-plane/deployment/vm-whatsapp-pair.sh`; the runbook is "WhatsApp
  (optional)" in `docs/control-plane-vm-deployment.md`. The number, the secrets and
  the session path are deployment values (`kinerary-deploy`), never this repository's.

## Endpoints (every one needs `Authorization: Bearer <secret>`)

| Endpoint | |
|---|---|
| `GET /health` | `{ state, own: { lid, phone }, epoch, lastSeq, buffered, counters }`; state is `starting`, `connecting`, `connected`, `disconnected`, `logged_out`, `replaced` or `unpaired` |
| `GET /messages?after=<seq>&epoch=<e>&waitMs=<ms>` | long-poll over a bounded ring; reading removes nothing; no `after` means "from now"; a different `epoch` means the bridge restarted; `lost` counts events that fell off the ring; a batch holds at most 100 events, `lastSeq` is the cursor of its LAST event and `more` says to ask again at once; messages delivered while the bridge was disconnected (`append`) are delivered if under 10 minutes old |
| `GET /media/<chatId>/<messageId>[?maxBytes=]` | bytes of a recent message's media, downloaded on demand; 404 once the bounded store dropped it |
| `POST /send` `{ chatId, text, replyTo?, mentions? }` | a `replyTo` quotes only a message of the same chat (`quoted: false` otherwise) |
| `POST /edit` `{ chatId, messageId, text }` | only a message this bridge sent, in that chat (one typed on the number's own phone, or sent before a restart, is refused: 403 `not_own_message` / 404 `gone`) |
| `POST /typing` `{ chatId, state? }` | `composing` (default) or `paused` |
| `GET /chat/<id>` | a group's title and size; participant ids are not returned |
| `GET /chat/<id>/participant/<participantId>` | linked-identity form only (400 for anything else); `inGroup` true or false; 503 means "could not check", which is not "no". Group metadata is cached 60 s per group and dropped on a participant or title event for it |

Ids contain `@` and `-` and travel percent-encoded in the path. Every chat id,
participant id and message id (`^[A-Za-z0-9]{1,128}$`) is checked against its shape
before it is used; the path is split as written, so `..` is an id that fails the
check, not a route.

Events from `/messages` are `message`, `added_to_group` (with `addedBy` only when
the notification names its author), `participant_left` and `title_changed`.
Participants are in the linked-identity form (`<digits>@lid`); when the phone
form is known, only its last four digits travel, as an optional
`senderPhoneLast4`: a full number appears in no `/messages` item (`/health`'s
`own` is the number's own ids). A sender that cannot be
resolved is `senderId: null`; a private chat that cannot be resolved is not
delivered and is counted in `/health`.

## What is discarded, and what is never logged

Pairing hands the linked device the phone's address book and history-sync
notices. The bridge subscribes to neither, refuses history sync, and neither
forwards nor logs anything from them. It does not claim they are never stored:
the library itself persists linked-identity-to-phone mappings in the session
directory, which is why that directory is a credential. The number the bridge
runs on should be a dedicated one with an empty address book.

A crash is logged by error name and the top frame's file and line only. Log lines carry states, codes and counts only: no id, number,
name or message text, and an error is reduced to its status code. Tests:
`test/privacy.test.mjs`.

## Tests

```bash
npm test      # node --test; never connects to WhatsApp
```

The library is injected (`src/core.js` takes it as a parameter) and every test
uses a faked socket. Only `src/bridge.js` imports the real library.
