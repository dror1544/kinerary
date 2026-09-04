#!/usr/bin/env python3
"""Drive Hermes's OWN relay transport against our connector. Dev tool.

Why this exists: our connector's unit tests speak to a harness we wrote, from
our reading of the contract — so they cannot catch a misreading. This script
imports `gateway.relay.ws_transport.WebSocketRelayTransport` from the installed
Hermes and dials the connector with it, which means the framing, upgrade auth,
handshake and outbound request/result correlation are all exercised by the code
that will actually talk to us in production.

It earned its keep immediately: the connector originally sent frames without
the trailing newline the gateway's reader splits on, so every frame landed in
the gateway's partial-line buffer and was never parsed. Unit tests passed —
the harness had the same bug. This script hung at handshake, which is exactly
what a real gateway would have done.

Safety: starts no gateway, holds no bot token, touches no launchd service. It
only opens a client socket to the connector.

Usage:
    # 1. start the connector (no TELEGRAM_BOT_TOKEN needed for a wire check)
    cd control-plane/api
    RELAY_GATEWAY_SECRET=<secret> npx tsx src/relay/server.ts

    # 2. in another shell
    RELAY_GATEWAY_SECRET=<same secret> \\
      ~/.hermes/hermes-agent/venv/bin/python \\
      control-plane/deployment/relay-conformance-check.py

Expected: HANDSHAKE OK, a descriptor matching TELEGRAM_DESCRIPTOR, an
`UNSUPPORTED_OP` result for an op we do not advertise, and a clean disconnect.
Run it again with a deliberately wrong RELAY_GATEWAY_SECRET and expect
`InvalidStatus: HTTP 401`.
"""
import asyncio
import os
import sys
from pathlib import Path

HERMES = Path(os.environ.get("HERMES_AGENT_DIR", Path.home() / ".hermes" / "hermes-agent"))
if not (HERMES / "gateway" / "relay" / "ws_transport.py").exists():
    sys.exit(f"Hermes agent source not found at {HERMES}; set HERMES_AGENT_DIR")
sys.path.insert(0, str(HERMES))

from gateway.relay.ws_transport import WebSocketRelayTransport  # noqa: E402

URL = os.environ.get("RELAY_URL", "http://127.0.0.1:4312")
SECRET = os.environ.get("RELAY_GATEWAY_SECRET")
if not SECRET:
    sys.exit("RELAY_GATEWAY_SECRET is required (must match the connector's verify list)")


async def main() -> int:
    transport = WebSocketRelayTransport(
        URL,
        "telegram",
        "conformance-check",
        gateway_id=os.environ.get("RELAY_GATEWAY_ID", "kinerary-trip-intake"),
        upgrade_secret=SECRET,
    )
    print("dial url ->", transport._url)

    if not await transport.connect():
        print("FAIL: connect returned False")
        return 1

    # A handshake TIMEOUT here is the signature of a framing bug: the connector
    # sent a descriptor the gateway received but never parsed.
    descriptor = await asyncio.wait_for(transport.handshake(), timeout=10)
    print("HANDSHAKE OK")
    print("  platform      :", descriptor.platform)
    print("  label         :", descriptor.label)
    print("  max_len       :", descriptor.max_message_length)
    print("  len_unit      :", descriptor.len_unit)
    print("  supports_edit :", descriptor.supports_edit)
    print("  supported_ops :", getattr(descriptor, "supported_ops", None))

    print("send            ->", await transport.send_outbound(
        {"op": "send", "chat_id": "123", "content": "conformance check"}))
    # Must come back as a RESULT, not a timeout — the gateway blocks a
    # per-request future on every outbound action.
    print("unadvertised op ->", await transport.send_outbound(
        {"op": "send_media", "chat_id": "123", "source_url": "http://example.invalid"}))
    print("get_chat_info   ->", await transport.get_chat_info("123"))

    await transport.disconnect()
    print("disconnected cleanly")
    return 0


sys.exit(asyncio.run(main()))
