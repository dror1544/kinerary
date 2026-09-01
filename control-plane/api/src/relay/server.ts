#!/usr/bin/env node
/**
 * Runnable entrypoint for the relay connector.
 *
 * Deliberately its own process rather than a mount inside the control-plane
 * API: the connector owns a long-lived WebSocket server and (later) the
 * Telegram poll loop, and it is the sole holder of the bot token. Keeping it
 * separate keeps that blast radius separate too.
 *
 * Env:
 *   RELAY_GATEWAY_SECRET      required. Must equal the gateway's
 *                             GATEWAY_RELAY_SECRET. Comma-separated to accept
 *                             several during a rotation.
 *   RELAY_PORT                default 4312. Must match the port in the
 *                             gateway's GATEWAY_RELAY_URL.
 *   RELAY_HOST                default 127.0.0.1.
 *   TELEGRAM_BOT_TOKEN        optional. Without it the connector still serves
 *                             the relay socket but cannot send — enough to
 *                             verify a handshake, not enough to run.
 */
import { RelayConnector } from "./connector.js";
import { HttpTelegramClient, type TelegramClient } from "./telegram-api.js";
import { structuredLog } from "../redaction.js";

const log = (line: string) => process.stderr.write(`${line}\n`);

const secretsRaw = process.env.RELAY_GATEWAY_SECRET ?? "";
const gatewaySecrets = secretsRaw.split(",").map((s) => s.trim()).filter(Boolean);
if (gatewaySecrets.length === 0) {
  process.stderr.write("[relay] RELAY_GATEWAY_SECRET is not set — exiting\n");
  process.exit(1);
}

const port = Number(process.env.RELAY_PORT ?? "4312");
const host = process.env.RELAY_HOST ?? "127.0.0.1";
const botToken = process.env.TELEGRAM_BOT_TOKEN ?? "";

/**
 * Stands in when no bot token is configured. Every op fails explicitly rather
 * than silently succeeding, so a misconfigured deployment is visible in the
 * gateway's own outbound results instead of looking like a delivered message.
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

const telegram: TelegramClient = botToken ? new HttpTelegramClient(botToken, log) : unconfigured;
if (!botToken) {
  log(structuredLog("warn", "relay.telegram_unconfigured", {
    hint: "relay socket will serve, but no message can be sent",
  }));
}

const connector = new RelayConnector({ gatewaySecrets, telegram, port, host, log });

async function main(): Promise<void> {
  await connector.listen();
  log(structuredLog("info", "relay.ready", { port, host, telegram_configured: Boolean(botToken) }));
}

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, () => {
    log(structuredLog("info", "relay.shutting_down", { signal }));
    void connector.close().then(() => process.exit(0));
  });
}

main().catch((error) => {
  log(structuredLog("error", "relay.start_failed", {
    safe_error_code: error instanceof Error ? error.name : "UNKNOWN",
  }));
  process.exit(1);
});
