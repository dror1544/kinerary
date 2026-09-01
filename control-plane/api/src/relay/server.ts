#!/usr/bin/env node
/**
 * Runnable entrypoint for the relay connector and the Trip Bot poll loop.
 *
 * Deliberately its own process rather than a mount inside the control-plane
 * API: it owns a long-lived WebSocket server, the only getUpdates loop on the
 * shared trip bot, and the bot token itself. Keeping the process separate
 * keeps that blast radius separate too.
 *
 * Two ways to start, and they are not interchangeable:
 *
 *   SERVE (normal).  Set CONTROL_PLANE_ARCHITECTURE_PROFILE. The `relay` block
 *     supplies the bind address, the gateway secret list and the bot token, all
 *     through the same secret_ref indirection every other secret in the profile
 *     uses. This is the only mode that routes anything, because routing needs
 *     the database.
 *
 *   CONFORMANCE (diagnostic).  Set RELAY_GATEWAY_SECRET with no profile. Serves
 *     the relay socket and nothing else — no database, no bot token, no poll
 *     loop — so relay-conformance-check.py can validate the wire protocol
 *     against a process that cannot touch a real trip. Deliberately NOT a
 *     fallback for a misconfigured deployment: it refuses to start if a profile
 *     path is also set, so a typo'd profile can never silently degrade into a
 *     connector that answers handshakes and routes nothing.
 */
import { loadArchitectureProfile } from "../config.js";
import { createDatabasePool } from "../database.js";
import { structuredLog } from "../redaction.js";
import { resolveSecretRef } from "../secrets.js";
import { RelayConnector } from "./connector.js";
import { startTripBotPoller } from "./poller.js";
import { HttpTelegramClient, type TelegramClient } from "./telegram-api.js";

const log = (line: string) => process.stderr.write(`${line}\n`);

const profilePath = process.env.CONTROL_PLANE_ARCHITECTURE_PROFILE;
const envSecret = process.env.RELAY_GATEWAY_SECRET ?? "";

if (profilePath && envSecret) {
  log(structuredLog("error", "relay.ambiguous_config", {
    hint: "set CONTROL_PLANE_ARCHITECTURE_PROFILE to serve, or RELAY_GATEWAY_SECRET alone for a conformance check — not both",
  }));
  process.exit(1);
}
if (!profilePath && !envSecret) {
  log(structuredLog("error", "relay.no_config", {
    hint: "CONTROL_PLANE_ARCHITECTURE_PROFILE (serve) or RELAY_GATEWAY_SECRET (conformance) is required",
  }));
  process.exit(1);
}

/**
 * Stands in when no bot token is configured — the conformance mode. Every op
 * fails explicitly rather than silently succeeding, so a misconfigured
 * deployment shows up in the gateway's own outbound results instead of looking
 * like a delivered message.
 */
const unconfigured: TelegramClient = {
  async sendMessage() { return { ok: false, error: "TELEGRAM_NOT_CONFIGURED" }; },
  async editMessageText() { return { ok: false, error: "TELEGRAM_NOT_CONFIGURED" }; },
  async sendChatAction() { /* no-op */ },
  async answerCallbackQuery() { /* no-op */ },
  async getChatInfo() { return null; },
  async getUpdates() { return []; },
  async deleteWebhookIfPresent() { /* no-op */ },
};

interface Runtime {
  gatewaySecrets: string[];
  port: number;
  host: string;
  telegram: TelegramClient;
  /** Set only in serve mode; its absence is what disables the poll loop. */
  db?: ReturnType<typeof createDatabasePool>;
}

async function serveRuntime(path: string): Promise<Runtime> {
  const profile = await loadArchitectureProfile(path);
  if (!profile.relay) {
    log(structuredLog("error", "relay.not_configured", {
      hint: "the architecture profile has no `relay` block",
    }));
    process.exit(1);
  }
  const relay = profile.relay;
  const [connectionString, botToken, ...gatewaySecrets] = await Promise.all([
    resolveSecretRef(profile.database.connection_secret_ref),
    resolveSecretRef(relay.telegram_bot_token_secret_ref),
    ...relay.gateway_secret_refs.map((ref) => resolveSecretRef(ref)),
  ]);

  const resolved = gatewaySecrets.map((s) => s.trim()).filter(Boolean);
  if (resolved.length === 0) {
    // Every ref resolved to whitespace. Continuing would serve a connector
    // that accepts no upgrade token at all and looks healthy doing it.
    log(structuredLog("error", "relay.empty_gateway_secrets", {}));
    process.exit(1);
  }

  const db = createDatabasePool(connectionString, () => {
    log(structuredLog("error", "database.pool_idle_error", {
      safe_error_code: "DATABASE_POOL_IDLE_ERROR",
    }));
  });

  return {
    gatewaySecrets: resolved,
    port: relay.port,
    host: relay.bind_host,
    telegram: new HttpTelegramClient(botToken, log),
    db,
  };
}

function conformanceRuntime(secret: string): Runtime {
  const gatewaySecrets = secret.split(",").map((s) => s.trim()).filter(Boolean);
  if (gatewaySecrets.length === 0) {
    log(structuredLog("error", "relay.empty_gateway_secrets", {}));
    process.exit(1);
  }
  log(structuredLog("warn", "relay.conformance_mode", {
    hint: "no database and no bot token — the socket serves, nothing routes",
  }));
  return {
    gatewaySecrets,
    port: Number(process.env.RELAY_PORT ?? "4312"),
    host: process.env.RELAY_HOST ?? "127.0.0.1",
    telegram: unconfigured,
  };
}

async function main(): Promise<void> {
  const runtime = profilePath ? await serveRuntime(profilePath) : conformanceRuntime(envSecret);

  const connector = new RelayConnector({
    gatewaySecrets: runtime.gatewaySecrets,
    telegram: runtime.telegram,
    port: runtime.port,
    host: runtime.host,
    log,
  });

  // Listen BEFORE polling. The gateway reconnects on its own every 30s, so a
  // socket that is not up yet costs a delay; an update pulled off Telegram
  // before the socket is up would be routed to a gateway that is not there and
  // lost outright, since nothing queues.
  await connector.listen();

  let stopPolling: (() => void) | undefined;
  if (runtime.db) {
    stopPolling = startTripBotPoller({
      db: runtime.db,
      telegram: runtime.telegram,
      connector,
      log,
    });
  }

  log(structuredLog("info", "relay.ready", {
    port: runtime.port,
    host: runtime.host,
    polling: Boolean(runtime.db),
  }));

  for (const signal of ["SIGINT", "SIGTERM"] as const) {
    process.on(signal, () => {
      log(structuredLog("info", "relay.shutting_down", { signal }));
      stopPolling?.();
      void connector
        .close()
        .then(() => runtime.db?.end())
        .then(() => process.exit(0))
        .catch(() => process.exit(1));
    });
  }
}

main().catch((error) => {
  log(structuredLog("error", "relay.start_failed", {
    safe_error_code: error instanceof Error ? error.name : "UNKNOWN",
  }));
  process.exit(1);
});
