#!/usr/bin/env node
/**
 * Kinerary WhatsApp bridge — the process. Everything testable lives in core.js,
 * http.js, pairing.js and cli.js; this file only wires the real library in, which
 * is the one thing a test must never do (it would connect to WhatsApp).
 *
 * Adapted from the MIT-licensed Hermes Agent WhatsApp bridge (see NOTICE.md).
 */
import { parseArgs, USAGE } from "./cli.js";
import { prepareSessionDir, sessionIsPaired } from "./session.js";
import { createSafeLogger, crashSummary, errorCode } from "./safe-log.js";

const { log } = createSafeLogger();

// The library's signal dependency calls console.info/warn/error directly, with
// session objects as arguments, and the library's own logger does not reach it.
// Everything this process writes goes through process.stderr/stdout instead.
for (const level of ["log", "info", "warn", "error", "debug", "trace"]) console[level] = () => {};

// A crash must not write the error: a library error message can quote an id.
const fatal = (err) => {
  const { name, at } = crashSummary(err);
  log("fatal", { code: errorCode(err), name, at });
  process.exit(1);
};
process.on("uncaughtException", fatal);
process.on("unhandledRejection", fatal);

let options;
let sessionDir;
try {
  options = parseArgs(process.argv.slice(2), process.env);
  sessionDir = prepareSessionDir(options.session);
} catch (err) {
  process.stderr.write(`${err instanceof Error ? err.message : "invalid arguments"}\n${USAGE}\n`);
  process.exit(2);
}

// Serving needs a paired session; check before the library is even loaded.
if (!options.pairOnly && !sessionIsPaired(sessionDir)) {
  log("unpaired", {});
  process.stderr.write("The session is not paired. Run with --pair-only first.\n");
  process.exit(3);
}

// The library is loaded only now, after the arguments are good.
const baileys = await import("@whiskeysockets/baileys");
const lib = {
  makeWASocket: baileys.makeWASocket ?? baileys.default,
  useMultiFileAuthState: baileys.useMultiFileAuthState,
  fetchLatestBaileysVersion: baileys.fetchLatestBaileysVersion,
  downloadMediaMessage: baileys.downloadMediaMessage,
  DisconnectReason: baileys.DisconnectReason,
};

if (options.pairOnly) {
  const { default: qrcode } = await import("qrcode-terminal");
  const { pair } = await import("./pairing.js");
  try {
    await pair({
      lib,
      sessionDir,
      log,
      onQr: (qr) => {
        process.stdout.write("\nScan this QR code in WhatsApp > Linked devices:\n\n");
        qrcode.generate(qr, { small: true }, (code) => process.stdout.write(`${code}\n`));
      },
    });
    process.stdout.write("Paired. The session is saved in the session directory.\n");
    process.exit(0);
  } catch (err) {
    log("pairing_failed", { code: errorCode(err) });
    process.stderr.write("Pairing did not complete.\n");
    process.exit(1);
  }
} else {
  const { createBridge } = await import("./core.js");
  const { createBridgeServer } = await import("./http.js");
  const bridge = createBridge({ lib, sessionDir, log });
  const http = createBridgeServer(bridge, { secret: options.secret, log });
  const address = await http.listen(options.port);
  log("listening", { loopback: address.address === "127.0.0.1", port: address.port });
  if (!(await bridge.start())) {
    await http.close();
    process.exit(3);
  }
  const shutdown = async () => {
    bridge.stop();
    await http.close();
    process.exit(0);
  };
  process.on("SIGTERM", shutdown);
  process.on("SIGINT", shutdown);
}
