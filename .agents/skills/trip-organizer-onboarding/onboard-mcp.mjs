#!/usr/bin/env node
/**
 * Kinerary onboarding MCP — the one write this server is allowed to make:
 * mint a real production organizer account and issue a real Telegram
 * interview link, by shelling out to `create-trip-link` (the wrapper in
 * kinerary-deploy, which supplies the host, the bot and the credential
 * store this file deliberately never learns).
 *
 * WHY THIS IS ITS OWN SERVER. The fleet monitor's `fleet-mcp.mjs` is
 * read-only by construction; `issue-mcp.mjs` is a second server because
 * filing an issue is a write and putting it in the read-only process would
 * quietly retire that invariant. This is a second write, to a different
 * system, with different consequences — a live account and a live message
 * to a real person, not a tracker row — so it gets its own process on the
 * same principle: a profile can run without this server wired and lose
 * nothing but the ability to onboard.
 *
 * WHAT IT CAN DO: run `create-trip-link <email> [--name] [--lang] [--new-link]`
 * with typed, fixed arguments via execFile (never a shell string, so nothing
 * in `email` or `name` can be interpreted as a shell operator). It cannot run
 * `--adopt-password` — that flag reads a password from stdin for migrating a
 * pre-existing account, and is deliberately not reachable from here at all.
 *
 * THIS MINTS A REAL ACCOUNT. There is no password-reset route in the control
 * plane, so a wrong email cannot be undone by re-running — it can only be
 * re-linked. `confirmed` is a required argument for exactly this reason: an
 * agent must set it explicitly, after reading the email/name/lang back to
 * its operator in chat, never as a reflex.
 *
 * WHERE THE COMMAND COMES FROM. Configuration names the path to the
 * `create-trip-link` wrapper; this file never hardcodes it, the same rule
 * `fleet-stacks.json` and `issue-target.json` follow for their own targets.
 *
 * ZERO DEPENDENCIES, like its siblings: newline-delimited JSON-RPC on stdio.
 * It runs from a Hermes profile with no node_modules and outlives any git
 * worktree.
 */
import { createInterface } from "node:readline";
import { execFile } from "node:child_process";
import { accessSync, constants, existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const SERVER_NAME = "kinerary-onboarding";
const SERVER_VERSION = "1.0.0";
const HERE = dirname(fileURLToPath(import.meta.url));

/* --------------------------------------------------------- configuration --- */

/**
 * Same rule as fleet-stacks.json and issue-target.json: nothing about
 * *where* create-trip-link lives in code. `$KINERARY_ONBOARD_CONFIG`
 * set-but-missing refuses rather than searching on, so a typo cannot
 * silently select a different command.
 */
function loadConfig() {
  const explicit = process.env.KINERARY_ONBOARD_CONFIG;
  if (explicit) {
    if (!existsSync(explicit)) {
      throw new Error(`KINERARY_ONBOARD_CONFIG is set to '${explicit}', which does not exist`);
    }
    return parseConfig(explicit);
  }
  const candidates = [
    join(homedir(), "kinerary-deploy", "onboarding-target.json"),
    join(homedir(), ".hermes", "onboarding-target.json"),
    join(HERE, "onboarding-target.json"),
  ];
  for (const path of candidates) if (existsSync(path)) return parseConfig(path);
  throw new Error(
    `no onboarding-target.json found. Looked at:\n  ${candidates.join("\n  ")}\n` +
      `See onboarding-target.example.json for the schema.`,
  );
}

function expandHome(path) {
  if (path === "~") return homedir();
  if (path.startsWith("~/")) return join(homedir(), path.slice(2));
  return path;
}

function parseConfig(path) {
  let raw;
  try {
    raw = JSON.parse(readFileSync(path, "utf8"));
  } catch (error) {
    throw new Error(`${path} is not valid JSON: ${error.message}`);
  }
  if (!raw.command) throw new Error(`${path}: "command" is required`);
  // Resolved relative to the config file, so a deploy directory can move as a
  // unit — same rule issue-target.json follows for tokenFile.
  const command = resolve(dirname(path), expandHome(String(raw.command)));
  if (!existsSync(command)) throw new Error(`${path}: command '${command}' does not exist`);
  try {
    accessSync(command, constants.X_OK);
  } catch {
    throw new Error(`${path}: command '${command}' exists but is not executable (chmod +x it)`);
  }
  return {
    source: path,
    command,
    maxPerHour: clamp(raw.maxPerHour, 1, 20, 6),
  };
}

function clamp(value, min, max, fallback) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, Math.trunc(n)));
}

let CONFIG;
try {
  CONFIG = loadConfig();
} catch (error) {
  process.stderr.write(`[kinerary-onboarding] ${error.message}\n`);
  process.exit(1);
}

/* ---------------------------------------------------------- the wrapper --- */

function run(command, args) {
  return new Promise((done) => {
    execFile(command, args, { timeout: 45_000, maxBuffer: 1_000_000 }, (error, stdout, stderr) => {
      if (!error) return done({ code: 0, stdout, stderr });
      if (error.killed) {
        return done({ code: 1, stdout, stderr: `${stderr}\n(timed out after 45s)`.trim() });
      }
      done({ code: typeof error.code === "number" ? error.code : 1, stdout, stderr: stderr || error.message });
    });
  });
}

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/** Shared by the real handler and --dry-run, so they cannot drift apart. */
function buildArgs(args) {
  const email = String(args.email ?? "").trim();
  if (!EMAIL_RE.test(email)) {
    throw new Error(`email '${email}' does not look like an email address`);
  }
  const cliArgs = [email];
  if (args.name !== undefined && args.name !== null && String(args.name).trim() !== "") {
    cliArgs.push("--name", String(args.name).trim());
  }
  if (args.lang !== undefined && args.lang !== null) {
    if (!["he", "en"].includes(args.lang)) throw new Error("lang must be 'he' or 'en'");
    cliArgs.push("--lang", args.lang);
  }
  if (args.new_link === true) cliArgs.push("--new-link");
  return { email, cliArgs };
}

const issued = [];

async function createTripLink(args) {
  if (args.confirmed !== true) {
    throw new Error(
      "confirmed must be true. Read the email, the name (or 'no name'), and the language back to " +
        "your operator in this chat and wait for a clear yes — then call this again with confirmed: true. " +
        "This mints a real production account; there is no undo.",
    );
  }
  const { email, cliArgs } = buildArgs(args);

  const hourAgo = Date.now() - 3_600_000;
  while (issued.length && issued[0] < hourAgo) issued.shift();
  if (issued.length >= CONFIG.maxPerHour) {
    throw new Error(
      `rate limit: ${CONFIG.maxPerHour} onboarding links in the last hour already. ` +
        `That is not a normal pace for one operator confirming one email at a time — say so in the ` +
        `operator channel instead of retrying, and raise maxPerHour in ${CONFIG.source} only if this rate is genuinely real.`,
    );
  }

  const { code, stdout, stderr } = await run(CONFIG.command, cliArgs);
  if (code !== 0) {
    throw new Error(
      `create-trip-link exited ${code} for ${email}.\n${(stderr || stdout || "(no output)").trim()}`,
    );
  }
  issued.push(Date.now());
  return [
    "GREETING — forward this to the organizer verbatim, nothing added or removed:",
    "",
    stdout.trim(),
    "",
    "---",
    "OPERATOR NOTES — for this chat only, never forward to the organizer:",
    "",
    stderr.trim() || "(none)",
  ].join("\n");
}

const TOOLS = [
  {
    name: "create_trip_link",
    description:
      "Mint a REAL production Kinerary organizer account for `email` and issue a REAL 24h Telegram interview " +
      "link through @Kinerary_bot. There is no password-reset route in the control plane, so a wrong email " +
      "cannot be undone — only re-linked. Idempotent for the common case: calling it again for the same " +
      "email while its link is still live returns that SAME link rather than minting a second trip, so a " +
      "retry after an ambiguous result is safe. Set new_link=true only when your operator explicitly asks to " +
      "revoke the existing link and issue a fresh one — the old one stops working the moment you do. " +
      "Requires confirmed=true, which you may only set after reading the email, name and language back to " +
      "your operator in chat and getting a clear yes.",
    inputSchema: {
      type: "object",
      required: ["email", "confirmed"],
      properties: {
        email: { type: "string", description: "The organizer's email address." },
        name: { type: "string", description: "How to address them in the greeting, e.g. 'יואב'. Omit for no name — never guess one from the email." },
        lang: { type: "string", enum: ["he", "en"], description: "Language of the GREETING text only (default he). The interview itself follows the organizer's own phone." },
        new_link: { type: "boolean", description: "Revoke the trip's existing live link and issue a fresh one. Only true when the operator explicitly asked for that." },
        confirmed: {
          type: "boolean",
          description:
            "Must be true. Set it only after reading email/name/lang back to your operator in this chat and receiving a clear yes — never as a default.",
        },
      },
    },
    handler: createTripLink,
  },
];

/* ------------------------------------------------------- MCP over stdio --- */

const send = (message) => process.stdout.write(`${JSON.stringify(message)}\n`);
const reply = (id, result) => send({ jsonrpc: "2.0", id, result });
const fail = (id, code, message) => send({ jsonrpc: "2.0", id, error: { code, message } });

async function handle(request) {
  const { id, method, params } = request;
  if (id === undefined || id === null) return;
  switch (method) {
    case "initialize":
      return reply(id, {
        protocolVersion: params?.protocolVersion ?? "2025-06-18",
        capabilities: { tools: {} },
        serverInfo: { name: SERVER_NAME, version: SERVER_VERSION },
      });
    case "ping":
      return reply(id, {});
    case "tools/list":
      return reply(id, {
        tools: TOOLS.map(({ name, description, inputSchema }) => ({ name, description, inputSchema })),
      });
    case "tools/call": {
      const tool = TOOLS.find((t) => t.name === params?.name);
      if (!tool) return fail(id, -32602, `unknown tool '${params?.name}'`);
      try {
        const text = await tool.handler(params?.arguments ?? {});
        return reply(id, { content: [{ type: "text", text }] });
      } catch (error) {
        return reply(id, { content: [{ type: "text", text: `Tool failed: ${error.message}` }], isError: true });
      }
    }
    default:
      return fail(id, -32601, `method not found: ${method}`);
  }
}

/* ------------------------------------------------------------------ CLI --- */

// `onboard-mcp.mjs --check` proves the config resolves to a runnable command
// without minting anything — it never invokes the command itself.
if (process.argv.includes("--check")) {
  process.stdout.write(
    `config:   ${CONFIG.source}\n` +
      `command:  ${CONFIG.command}\n` +
      `runnable: yes\n` +
      `rate:     ${CONFIG.maxPerHour}/hour\n` +
      `Nothing above ran the command — this cannot mint an account.\n`,
  );
  process.exit(0);
}

// `onboard-mcp.mjs --dry-run '<json args>'` prints exactly the argv that
// would run and executes nothing — the same "preview before you trust it"
// shape as issue-mcp.mjs's --render.
const dryAt = process.argv.indexOf("--dry-run");
if (dryAt !== -1) {
  try {
    const args = JSON.parse(process.argv[dryAt + 1] ?? "{}");
    const { cliArgs } = buildArgs(args);
    process.stdout.write(`would run: ${CONFIG.command} ${cliArgs.join(" ")}\n(nothing executed)\n`);
    process.exit(0);
  } catch (error) {
    process.stderr.write(`[kinerary-onboarding] ${error.message}\n`);
    process.exit(1);
  }
}

createInterface({ input: process.stdin }).on("line", async (line) => {
  const trimmed = line.trim();
  if (!trimmed) return;
  let request;
  try {
    request = JSON.parse(trimmed);
  } catch {
    return fail(null, -32700, "parse error");
  }
  try {
    await handle(request);
  } catch (error) {
    fail(request?.id ?? null, -32603, error.message);
  }
});
