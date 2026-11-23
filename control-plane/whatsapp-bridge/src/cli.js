/**
 * Command line and environment for the bridge. The bearer secret is read from
 * the environment or a file, NEVER from an argument: arguments are visible to
 * every user on the machine in the process list.
 */
import { readFileSync, statSync } from "node:fs";
import { validateSecret } from "./http.js";

export const USAGE = `usage: node src/bridge.js --session <dir> --port <port>      serve on 127.0.0.1:<port>
       node src/bridge.js --session <dir> --pair-only          show a QR, link the phone, exit
secret: WHATSAPP_BRIDGE_SECRET, or --secret-file <path> (not needed for --pair-only)`;

export class UsageError extends Error {}

function valueOf(args, name) {
  const at = args.indexOf(name);
  if (at === -1) return undefined;
  const value = args[at + 1];
  return value && !value.startsWith("--") ? value : undefined;
}

/**
 * @param {string[]} argv arguments after the script name
 * @param {Record<string, string|undefined>} env
 */
export function parseArgs(argv, env = {}) {
  const pairOnly = argv.includes("--pair-only");
  const session = valueOf(argv, "--session");
  if (!session) throw new UsageError("--session <dir> is required");
  if (pairOnly) return { pairOnly: true, session };

  const portRaw = valueOf(argv, "--port");
  const port = Number(portRaw);
  if (!portRaw || !Number.isInteger(port) || port < 1 || port > 65535) {
    throw new UsageError("--port <1-65535> is required");
  }

  let secret = typeof env.WHATSAPP_BRIDGE_SECRET === "string" ? env.WHATSAPP_BRIDGE_SECRET.trim() : undefined;
  // Read once and removed: a secret left in the environment is inherited by every
  // child process and readable from /proc and `ps eww`.
  delete env.WHATSAPP_BRIDGE_SECRET;
  const secretFile = valueOf(argv, "--secret-file");
  if (!secret && secretFile) {
    // Refuse a secret file anyone but its owner can read.
    const mode = statSync(secretFile).mode & 0o777;
    if ((mode & 0o077) !== 0) throw new UsageError("the secret file must not be readable by group or others");
    secret = readFileSync(secretFile, "utf8").trim();
  }
  if (!secret) throw new UsageError("a bearer secret is required (WHATSAPP_BRIDGE_SECRET or --secret-file)");
  try {
    validateSecret(secret);
  } catch (err) {
    throw new UsageError(err.message);
  }
  return { pairOnly: false, session, port, secret };
}
