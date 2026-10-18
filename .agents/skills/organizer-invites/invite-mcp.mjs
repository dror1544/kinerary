#!/usr/bin/env node
/**
 * Kinerary invitations MCP — how a monitoring agent hands somebody an interview
 * link without holding anything that could do more than that.
 *
 * WHY IT IS NOT PART OF THE FLEET MCP. That server is read-only at the
 * connection level, and its value is that it can be pointed at production
 * without a second thought. Inviting an organizer is a write. Mixing the two
 * would mean the tool an agent reaches for a hundred times a day sits behind
 * the same door as the one that creates trips, so they stay separate servers,
 * separate keys, separate SSH users.
 *
 * WHAT IT CAN REACH. One SSH key, authorized on the control-plane host only as
 * the `cpinvite` user with a forced command (`kinerary-invite-gate`), which
 * hands a few validated tokens to `kinerary-invite gate` through one sudoers
 * line. No tool here takes free text for the remote side: an address is checked
 * against a strict pattern locally and again on the host, the language is one
 * of two literals, and everything else is fixed. Nothing opens a shell at
 * either end.
 *
 * WHAT IT STILL CANNOT DO. Read anybody's data, change a password (no such
 * route exists anywhere), reach a trip that is already under way, or send a
 * message. It prints the invitation; a person decides who receives it. The
 * control plane refuses an address that is mid-interview or mid-build, rate
 * limits the whole operation, and records every invitation with the name of
 * whoever asked for it — which is passed from here and never invented.
 *
 * ZERO DEPENDENCIES ON PURPOSE, like fleet-mcp.mjs: it runs from a Hermes
 * profile, which has no node_modules and outlives any git worktree. MCP is
 * spoken directly (newline-delimited JSON-RPC on stdio).
 *
 * DEPLOYMENT IS CONFIGURATION, AND NOT IN THIS REPO. The gate's SSH target, key
 * and pinned known_hosts are infrastructure facts and this repo is public. They
 * are read from the private deploy repo's `control-plane.env`
 * (CP_INVITE_GATE_TARGET, CP_INVITE_GATE_KEY_ON_MAC,
 * CP_INVITE_GATE_KNOWN_HOSTS_ON_MAC).
 */
import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const SERVER_NAME = "kinerary-invitations";
const SERVER_VERSION = "1.0.0";

/** What may cross the gate. The host re-checks every one of these. */
const TOKEN = /^[A-Za-z0-9._:@+-]{1,120}$/;
const EMAIL = /^[^@\s]{1,64}@[A-Za-z0-9.-]{1,120}\.[A-Za-z]{2,24}$/;
const LANGUAGES = ["en", "he"];
const GATE_TIMEOUT_MS = 60_000;

const expandHome = (value) =>
  typeof value === "string" && value.startsWith("~/") ? join(homedir(), value.slice(2)) : value;

function findBinary(name, envVar, fallbacks) {
  const pinned = process.env[envVar];
  if (pinned) return pinned;
  const dirs = [...(process.env.PATH ?? "").split(":").filter(Boolean), "/usr/bin", "/bin", "/usr/local/bin", "/opt/homebrew/bin"];
  for (const dir of dirs) {
    const candidate = join(dir, name);
    if (existsSync(candidate)) return candidate;
  }
  return fallbacks.find((path) => existsSync(path)) ?? name;
}

/* --------------------------------------------------------------- config --- */

const PINNED_CONFIG = process.env.KINERARY_INVITE_CONFIG || null;
const DEFAULT_CONFIG = join(process.env.KINERARY_DEPLOY_ROOT || join(homedir(), "kinerary-deploy"), "control-plane.env");

/** KEY=value lines; comments and blanks ignored. */
export function readEnvText(text) {
  const values = {};
  for (const raw of text.split("\n")) {
    const line = raw.trim();
    if (!line || line.startsWith("#") || !line.includes("=")) continue;
    const index = line.indexOf("=");
    values[line.slice(0, index).trim()] = line.slice(index + 1).trim();
  }
  return values;
}

function loadConfig() {
  const path = PINNED_CONFIG ?? DEFAULT_CONFIG;
  if (!existsSync(path)) {
    return { error: `${path} does not exist — the gate's address and keys live in the private deploy repo's control-plane.env` };
  }
  const values = readEnvText(readFileSync(path, "utf8"));
  const missing = ["CP_INVITE_GATE_TARGET", "CP_INVITE_GATE_KEY_ON_MAC", "CP_INVITE_GATE_KNOWN_HOSTS_ON_MAC"]
    .filter((key) => !values[key]);
  if (missing.length) return { error: `${path} lacks ${missing.join(", ")}` };
  const target = values.CP_INVITE_GATE_TARGET;
  if (!/^cpinvite@[A-Za-z0-9.:-]+$/.test(target)) {
    // The key is authorized only for this user. A config naming another user is
    // either a mistake or a key with more power than this tool should hold.
    return { error: `${path}: CP_INVITE_GATE_TARGET must be cpinvite@<host>, the gate user` };
  }
  return {
    path,
    ssh: {
      target,
      key: values.CP_INVITE_GATE_KEY_ON_MAC,
      known_hosts: values.CP_INVITE_GATE_KNOWN_HOSTS_ON_MAC,
      connect_timeout: 10,
    },
  };
}

const CONFIG = loadConfig();

/* ----------------------------------------------------------- the gate call --- */

export function gateArgv(tokens, config = CONFIG) {
  if (config.error) throw new Error(`No usable invitation configuration: ${config.error}`);
  for (const token of tokens) {
    if (!TOKEN.test(token)) throw new Error(`refused token ${JSON.stringify(String(token).slice(0, 20))}`);
  }
  const ssh = config.ssh;
  const args = [
    "-i", expandHome(ssh.key),
    "-o", "BatchMode=yes",
    "-o", "IdentitiesOnly=yes",
    "-o", "StrictHostKeyChecking=yes",
    "-o", `UserKnownHostsFile=${expandHome(ssh.known_hosts)}`,
    "-o", `ConnectTimeout=${Number(ssh.connect_timeout ?? 10)}`,
    "-T",
  ];
  // The forced command ignores what is "run" and reads SSH_ORIGINAL_COMMAND;
  // the tokens are joined with single spaces only.
  return [findBinary("ssh", "INVITE_SSH_BIN", ["/usr/bin/ssh"]), ...args, ssh.target, tokens.join(" ")];
}

function runGate(tokens) {
  const argv = gateArgv(tokens);
  if (process.env.INVITE_MCP_ECHO === "1") return Promise.resolve(JSON.stringify(argv));
  return new Promise((resolvePromise, reject) => {
    const child = spawn(argv[0], argv.slice(1), {
      env: { PATH: process.env.PATH ?? "/usr/bin:/bin", HOME: process.env.HOME ?? homedir() },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let out = "";
    let err = "";
    const timer = setTimeout(() => {
      child.kill("SIGTERM");
      reject(new Error(`the control-plane host did not answer within ${Math.round(GATE_TIMEOUT_MS / 1000)}s`));
    }, GATE_TIMEOUT_MS);
    child.stdout.on("data", (chunk) => { out += chunk; });
    child.stderr.on("data", (chunk) => { err += chunk; });
    child.on("error", (error) => { clearTimeout(timer); reject(error); });
    child.on("close", (code) => {
      clearTimeout(timer);
      const text = `${out}${err && code !== 0 ? `\n${err}` : ""}`.trim();
      resolvePromise(code === 0 ? text : `${text}\n\n(exit ${code})`);
    });
  });
}

/* ---------------------------------------------------------------- tools --- */

/** An address, checked here so an obvious mistake never becomes a remote call. */
function checkedEmail(value) {
  const email = String(value ?? "").trim();
  if (!EMAIL.test(email)) throw new Error("email must be one ordinary address, e.g. someone@example.com");
  return email;
}

function checkedLanguage(value) {
  const language = String(value ?? "en").trim().toLowerCase();
  if (!LANGUAGES.includes(language)) {
    throw new Error(`the interview speaks ${LANGUAGES.join(" and ")} — ask your operator which one they want`);
  }
  return language;
}

/**
 * Who asked. Recorded with the invitation and never inferred: an agent must
 * pass what the person actually said about themselves, not a guess, and this
 * strips it to something that cannot carry an instruction across the gate.
 */
function checkedRequester(value) {
  const requested = String(value ?? "").trim().replace(/[^A-Za-z0-9._+-]/g, "");
  if (requested.length < 2) {
    throw new Error("requested_by must name the person asking, as a plain word (e.g. their name or handle)");
  }
  return requested.slice(0, 60);
}

const TOOLS = [
  {
    name: "invite_preview",
    description:
      "What an invitation to this address WOULD do — new person, a draft to re-link, or a returning organizer with trips already — and whether it is refused right now. Changes nothing. Always run this and show it before inviting.",
    inputSchema: {
      type: "object",
      properties: { email: { type: "string", description: "The organizer's email address" } },
      required: ["email"],
    },
    handler: ({ email }) => runGate(["preview", checkedEmail(email)]),
  },
  {
    name: "invite_create",
    description:
      "Create the trip and issue a single-use interview link for this address, and return the message to forward, written in the chosen language. The link is not sent anywhere — your operator decides who receives it. Refused while that person is mid-interview or their last trip is still building.",
    inputSchema: {
      type: "object",
      properties: {
        email: { type: "string", description: "The organizer's email address" },
        language: { type: "string", enum: LANGUAGES, description: "The language the invitation is written in (default en)" },
        requested_by: { type: "string", description: "Who asked for this invitation. Recorded with it." },
      },
      required: ["email", "requested_by"],
    },
    handler: ({ email, language, requested_by: requestedBy }) =>
      runGate(["create", checkedEmail(email), checkedLanguage(language), checkedRequester(requestedBy)]),
  },
  {
    name: "invite_help",
    description: "What the control-plane host says this key may do. Use when a call is refused and the reason is unclear.",
    inputSchema: { type: "object", properties: {} },
    handler: () => runGate(["help"]),
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
      return reply(id, { tools: TOOLS.map(({ name, description, inputSchema }) => ({ name, description, inputSchema })) });
    case "tools/call": {
      const tool = TOOLS.find((t) => t.name === params?.name);
      if (!tool) return fail(id, -32602, `unknown tool '${params?.name}'`);
      try {
        const text = await tool.handler(params?.arguments ?? {});
        return reply(id, { content: [{ type: "text", text }] });
      } catch (error) {
        // Reported as tool output: a refusal is an answer the agent should
        // relay to the person, not a crash.
        return reply(id, { content: [{ type: "text", text: `Refused: ${error.message}` }], isError: true });
      }
    }
    default:
      return fail(id, -32601, `method not found: ${method}`);
  }
}

if (process.argv.includes("--self-test")) {
  // Prints what a call would send, without sending it. `--self-test` never
  // reaches the host, so it is safe to run anywhere.
  process.env.INVITE_MCP_ECHO = "1";
  const argv = CONFIG.error ? CONFIG.error : JSON.parse(await runGate(["preview", "someone@example.com"]));
  process.stdout.write(`${JSON.stringify(argv, null, 2)}\n`);
} else if (process.stdin.isTTY) {
  process.stderr.write(
    "kinerary-invitations MCP speaks JSON-RPC on stdin. Try --self-test, or register it with your agent.\n",
  );
  process.exit(2);
} else {
  createInterface({ input: process.stdin }).on("line", (line) => {
    const text = line.trim();
    if (!text) return;
    let request;
    try {
      request = JSON.parse(text);
    } catch {
      return fail(null, -32700, "parse error");
    }
    handle(request).catch((error) => fail(request?.id ?? null, -32603, error.message));
  });
}
