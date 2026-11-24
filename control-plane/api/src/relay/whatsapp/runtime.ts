/**
 * Assembling the relay's WhatsApp side from the architecture profile (spec 625,
 * Configuration; AC-20). Kept out of `relay/server.ts`, which runs `main()` on import,
 * so a test can drive the real decision: what is built, and what refuses to start.
 *
 * ABSENT IS ABSENT. No `relay.whatsapp` block: `whatsappRuntimeConfig` returns null,
 * nothing is built, no secret is read and no connection to a bridge is attempted. The
 * relay is exactly what it was.
 *
 * PRESENT IS STRICT. A block that is there but cannot work refuses to start with a
 * message naming the field (never its value): the bridge URL must be exactly
 * `http://127.0.0.1:<port>` (the schema also admits `localhost` and `[::1]`, which the
 * bridge never binds and the client refuses), the bridge secret must resolve to at
 * least 32 characters, and the sender-id key to at least 32 bytes. A relay that started
 * anyway would look healthy and drop every WhatsApp message.
 */
import { CodeAttemptLimiter } from "../../chat-binding-codes.js";
import { WHATSAPP_MIN_KEY_BYTES } from "../../identity.js";
import { createHttpWhatsAppClient, whatsappBridgeUrl, type WhatsAppClient } from "./client.js";
import { BridgeStateTracker, WhatsAppMessageLedger } from "./state.js";

/** The `relay.whatsapp` block as the profile schema parses it (config.ts). */
export interface WhatsAppProfileBlock {
  bridge_url: string;
  bridge_secret_ref: string;
  sender_id_secret_ref: string;
  number: string;
  code_ttl_seconds: number;
  code_attempts_per_hour: number;
}

export interface WhatsAppRuntimeConfig {
  bridgeUrl: string;
  bridgeSecret: string;
  senderKey: string;
  codeAttemptsPerHour: number;
}

/** Why a present block cannot start. The message names the field and the rule, never a value. */
export class WhatsAppConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "WhatsAppConfigError";
  }
}

export async function whatsappRuntimeConfig(
  block: WhatsAppProfileBlock | undefined,
  resolveSecretRef: (ref: string) => Promise<string>,
): Promise<WhatsAppRuntimeConfig | null> {
  if (!block) return null;
  let bridgeUrl: string;
  try {
    bridgeUrl = whatsappBridgeUrl(block.bridge_url);
  } catch (error) {
    throw new WhatsAppConfigError(error instanceof Error ? error.message : "relay.whatsapp.bridge_url is invalid");
  }
  const [secretRaw, keyRaw] = await Promise.all([
    resolveSecretRef(block.bridge_secret_ref).catch(() => {
      throw new WhatsAppConfigError("relay.whatsapp.bridge_secret_ref could not be resolved");
    }),
    resolveSecretRef(block.sender_id_secret_ref).catch(() => {
      throw new WhatsAppConfigError("relay.whatsapp.sender_id_secret_ref could not be resolved");
    }),
  ]);
  const bridgeSecret = secretRaw.trim();
  if (bridgeSecret.length < 32 || /\s/.test(bridgeSecret)) {
    throw new WhatsAppConfigError("relay.whatsapp.bridge_secret_ref must resolve to at least 32 characters with no whitespace");
  }
  const senderKey = keyRaw.trim();
  if (Buffer.byteLength(senderKey) < WHATSAPP_MIN_KEY_BYTES) {
    throw new WhatsAppConfigError(`relay.whatsapp.sender_id_secret_ref must resolve to at least ${WHATSAPP_MIN_KEY_BYTES} bytes`);
  }
  if (senderKey === bridgeSecret) {
    // One leaked value would then both reach the bridge and make every opaque id reversible by enumeration.
    throw new WhatsAppConfigError("relay.whatsapp.sender_id_secret_ref must not resolve to the same value as bridge_secret_ref");
  }
  return { bridgeUrl, bridgeSecret, senderKey, codeAttemptsPerHour: block.code_attempts_per_hour };
}

/** What the connector and the loop share: one client, one ledger, one state line, one attempt limiter. */
export interface WhatsAppTransport {
  client: WhatsAppClient;
  ledger: WhatsAppMessageLedger;
  state: BridgeStateTracker;
  codeLimiter: CodeAttemptLimiter;
  senderKey: string;
}

/** Builds the transport. Connects to nothing: the first request is the loop's. */
export function createWhatsAppTransport(
  config: WhatsAppRuntimeConfig,
  log: (line: string) => void,
  options: { client?: WhatsAppClient } = {},
): WhatsAppTransport {
  return {
    client: options.client ?? createHttpWhatsAppClient({ baseUrl: config.bridgeUrl, secret: config.bridgeSecret }),
    ledger: new WhatsAppMessageLedger(),
    state: new BridgeStateTracker(log),
    codeLimiter: new CodeAttemptLimiter({ perChatPerHour: config.codeAttemptsPerHour, log }),
    senderKey: config.senderKey,
  };
}
