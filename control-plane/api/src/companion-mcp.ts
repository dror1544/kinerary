#!/usr/bin/env node
/**
 * Companion control MCP — the one narrow way a trip's companion reaches the
 * control plane.
 *
 * A companion's only other connection is `trip-mcp`, which speaks to its trip
 * SITE. Some facts about a trip live in the control plane instead, and the one
 * that bit on 2026-09-13 is the assistant's own name: the router decides which
 * group messages reach a companion by matching `trips.assistant_names`, so a
 * companion that agrees to a new name in conversation — and even saves it to
 * memory — still never hears it. This server gives the companion the write that
 * makes a rename real. Deliberately nothing else: every tool added here is a new
 * way for an AI runtime to change the control plane.
 *
 * AUTHENTICATION — NO NEW SECRET. Every companion is already enrolled with the
 * relay: its profile holds the relay's gateway secret and its gateway id, and
 * the relay proves identity with a signed `id:expiry:signature` token checked by
 * `verifyUpgradeToken`. The companion's token here is that exact format (minted
 * by the installer with no expiry), verified by that exact function. So the
 * trust boundary is the relay's own — whoever can connect to the relay as a
 * gateway can already act as that gateway — and this adds none.
 *
 * SCOPE — FROM THE TOKEN, NEVER FROM AN ARGUMENT. The verified gateway id IS the
 * Hermes profile (connector.ts: "a gateway's authenticated id IS the Hermes
 * profile it serves"), and the trip is the one that profile's open chat bindings
 * point at. No tool takes a trip id, so no argument can reach another family's
 * trip. A profile bound to no trip, or to more than one, is refused.
 */
import express, { type Request, type Response } from "express";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { SSEServerTransport } from "@modelcontextprotocol/sdk/server/sse.js";
import { fileURLToPath } from "node:url";
import type pg from "pg";
import { z } from "zod";
import { getAssistantNames, parseAssistantNames, setAssistantNames } from "./assistant-names.js";
import { loadArchitectureProfile } from "./config.js";
import { createDatabasePool } from "./database.js";
import { structuredLog } from "./redaction.js";
import { verifyUpgradeToken } from "./relay/protocol.js";
import { resolveSecretRef } from "./secrets.js";

const log = (line: string) => process.stderr.write(`${line}\n`);

/** The gateway id a request proves, or null. Bearer only — never a query string. */
export function gatewayFromAuthorization(header: unknown, secrets: readonly string[]): string | null {
  const value = typeof header === "string" ? header : "";
  const token = value.startsWith("Bearer ") ? value.slice("Bearer ".length).trim() : "";
  if (!token || secrets.length === 0) return null;
  return verifyUpgradeToken(token, secrets);
}

export type CompanionTrip =
  | { ok: true; tripId: string }
  | { ok: false; reason: "NO_TRIP" | "AMBIGUOUS_TRIP" };

/** The one trip a companion profile serves, through its open chat bindings. */
export async function tripForCompanion(db: pg.Pool, profile: string): Promise<CompanionTrip> {
  const { rows } = await db.query<{ trip_id: string }>(
    `SELECT DISTINCT trip_id
       FROM control_plane.telegram_chat_bindings
      WHERE hermes_profile = $1 AND closed_at IS NULL`,
    [profile],
  );
  if (rows.length === 0) return { ok: false, reason: "NO_TRIP" };
  if (rows.length > 1) return { ok: false, reason: "AMBIGUOUS_TRIP" };
  return { ok: true, tripId: rows[0]!.trip_id };
}

export type RenameResult =
  | { ok: true; names: string[] }
  | { ok: false; reason: "NO_TRIP" | "AMBIGUOUS_TRIP" | "EMPTY" | "TOO_MANY" | "TOO_LONG" | "INVALID" };

/** Renames the assistant of the trip this profile serves — and only that trip. */
export async function renameFromCompanion(
  db: pg.Pool,
  profile: string,
  names: readonly string[],
): Promise<RenameResult> {
  const trip = await tripForCompanion(db, profile);
  if (!trip.ok) return trip;
  const parsed = parseAssistantNames(names);
  if (!parsed.ok) return parsed;
  const now = await setAssistantNames(db, trip.tripId, parsed.names);
  if (!now) return { ok: false, reason: "NO_TRIP" };
  log(structuredLog("info", "companion_mcp.renamed", { profile, names: now.length }));
  return { ok: true, names: now };
}

function ok(data: unknown) {
  return { content: [{ type: "text" as const, text: JSON.stringify(data) }] };
}

export function buildCompanionMcpServer(db: pg.Pool, profile: string): McpServer {
  const mcp = new McpServer({ name: "trip-control", version: "1.0.0" });

  mcp.tool(
    "get_assistant_names",
    "The names you currently answer to in the family group. In a group, a message reaches you only when " +
      "it uses one of these names, replies to one of your messages, or tags the bot.",
    {},
    async () => {
      const trip = await tripForCompanion(db, profile);
      if (!trip.ok) return ok(trip);
      return ok({ ok: true, names: await getAssistantNames(db, trip.tripId) });
    },
  );

  mcp.tool(
    "set_assistant_names",
    "Change what you are called. Call this whenever anyone in the family asks you to take a new name — " +
      "agreeing in the chat is not enough, because group messages reach you only by names registered here. " +
      "Replaces the current names. Give both languages when the group writes in two, e.g. [\"סולו\", \"Solo\"].",
    {
      names: z.array(z.string()).min(1).max(3)
        .describe("The new name, or up to three spellings of it. Each 2–40 characters, no @ or markup."),
    },
    async ({ names }) => ok(await renameFromCompanion(db, profile, names)),
  );

  return mcp;
}

async function main(): Promise<void> {
  const profilePath = process.env.CONTROL_PLANE_ARCHITECTURE_PROFILE;
  const port = Number(process.env.COMPANION_MCP_PORT || "4313");
  if (!profilePath) {
    log(structuredLog("error", "companion_mcp.not_configured", { hint: "CONTROL_PLANE_ARCHITECTURE_PROFILE is unset" }));
    process.exit(1);
  }
  const architecture = await loadArchitectureProfile(profilePath);
  if (!architecture.relay) {
    log(structuredLog("error", "companion_mcp.not_configured", { hint: "the architecture profile has no relay block" }));
    process.exit(1);
  }
  const [connectionString, ...secretValues] = await Promise.all([
    resolveSecretRef(architecture.database.connection_secret_ref),
    ...architecture.relay.gateway_secret_refs.map((ref) => resolveSecretRef(ref)),
  ]);
  const secrets = secretValues.map((s) => s.trim()).filter(Boolean);
  if (secrets.length === 0) {
    // Serving with no secret would accept no token and look healthy doing it.
    log(structuredLog("error", "companion_mcp.empty_gateway_secrets", {}));
    process.exit(1);
  }
  const db = createDatabasePool(connectionString);

  const sessions = new Map<string, { transport: SSEServerTransport; server: McpServer }>();
  const dispose = async (id: string) => {
    const session = sessions.get(id);
    if (!session) return;
    sessions.delete(id);
    try { await session.server.close(); } catch { /* best-effort */ }
  };

  const app = express();
  app.get("/sse", async (req: Request, res: Response) => {
    const profile = gatewayFromAuthorization(req.headers.authorization, secrets);
    if (!profile) { res.status(401).json({ error: "unauthorized" }); return; }
    const transport = new SSEServerTransport("/messages", res);
    const server = buildCompanionMcpServer(db, profile);
    sessions.set(transport.sessionId, { transport, server });
    transport.onclose = () => { dispose(transport.sessionId).catch(() => {}); };
    req.on("close", () => { dispose(transport.sessionId).catch(() => {}); });
    await server.connect(transport);
  });
  // The session id is the capability for the message channel, as in
  // interview-mcp.ts: it exists only for a /sse that authenticated.
  app.post("/messages", express.json(), async (req: Request, res: Response) => {
    const session = sessions.get(String(req.query.sessionId || ""));
    if (!session) { res.status(404).json({ error: "session_not_found" }); return; }
    await session.transport.handlePostMessage(req, res, req.body);
  });
  app.listen(port, "127.0.0.1", () => {
    log(structuredLog("info", "companion_mcp.listening", { port }));
  });
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  void main();
}
