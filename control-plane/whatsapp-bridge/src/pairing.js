/**
 * `--pair-only`: show the QR, let the phone link this device, write the session,
 * exit. No server is started and no message is handled.
 *
 * After a successful scan WhatsApp closes the socket with "restart required"
 * (515) once; pairing is not done until the socket has been rebuilt and opened.
 * Anything else that closes the socket ends pairing with a failure.
 */
import { createSilentLibraryLogger, errorCode } from "./safe-log.js";

/**
 * @returns {Promise<void>} resolves when the device is linked and credentials are saved
 */
export function pair({ lib, sessionDir, onQr, log, timeoutMs = 5 * 60_000, settleMs = 2_000, timers }) {
  const t = timers ?? { setTimeout: globalThis.setTimeout, clearTimeout: globalThis.clearTimeout };
  const reasons = lib.DisconnectReason ?? { restartRequired: 515 };
  return new Promise((resolve, reject) => {
    let finished = false;
    const done = (err) => {
      if (finished) return;
      finished = true;
      t.clearTimeout(deadline);
      if (err) reject(err);
      else resolve();
    };
    const deadline = t.setTimeout(() => done(new Error("pairing timed out")), timeoutMs);

    async function open() {
      const { state, saveCreds } = await lib.useMultiFileAuthState(sessionDir);
      const sock = lib.makeWASocket({
        auth: state,
        logger: createSilentLibraryLogger(),
        printQRInTerminal: false,
        browser: ["Kinerary", "Chrome", "120.0"],
        syncFullHistory: false,
        shouldSyncHistoryMessage: () => false,
        markOnlineOnConnect: false,
        getMessage: async () => ({ conversation: "" }),
      });
      sock.ev.on("creds.update", () => {
        Promise.resolve(saveCreds()).catch(() => log("creds_save_failed", {}));
      });
      sock.ev.on("connection.update", (update = {}) => {
        if (update.qr) onQr(update.qr);
        if (update.connection === "open") {
          log("paired", {});
          // Let the library flush its credentials before the process exits.
          t.setTimeout(() => done(), settleMs);
        }
        if (update.connection === "close") {
          const code = update.lastDisconnect?.error?.output?.statusCode;
          if (code === reasons.restartRequired) {
            log("restart_required", { code });
            open().catch((err) => done(err));
            return;
          }
          log("pairing_closed", { code: typeof code === "number" ? code : errorCode(update.lastDisconnect?.error) });
          done(new Error("the connection closed before pairing completed"));
        }
      });
    }
    open().catch((err) => done(err));
  });
}
