#!/usr/bin/env node
/**
 * Interview MCP server — exposes the control-plane's /v1/interview* HTTP
 * API as MCP tools, so a real Hermes interviewer profile (see
 * .agents/skills/trip-intake-interviewer/) can conduct an actual
 * conversation with an organizer instead of that conversation's answers
 * being simulated or saved to a local file.
 *
 * Deliberately a thin, stateless protocol adapter — the same shape as
 * mcp/mcp.js (trip-site data) and mcp/provision.js (trip lifecycle): it
 * forwards each tool call to the corresponding HTTP endpoint and relays the
 * response. All validation, session state and business logic already live
 * in interview.ts; nothing here duplicates them.
 *
 * Runs as its own small Express + SSE process, matching mcp.js's proven
 * pattern, rather than mounting onto the main Fastify app — Fastify/SSE/MCP
 * transport compatibility is unverified in this codebase, while this exact
 * combination (McpServer + SSEServerTransport + Express) is already running
 * in production for mcp.js.
 *
 * Auth is two-layered, matching mcp.js:
 *   - INTERVIEW_MCP_KEY (X-API-Key / ?key= / Bearer) gates the SSE/MCP
 *     transport itself — the same outer gate every MCP server in this repo
 *     has, independent of what's being called.
 *   - Each tool additionally carries the real per-conversation credential
 *     (an enrollment token for start_interview, a session token for
 *     everything after) as an explicit tool argument, forwarded as-is to
 *     the control-plane API's own Authorization: Bearer check. The MCP
 *     server never mints, stores, or interprets these tokens itself.
 */
import crypto from "node:crypto";
import express, { type Request, type Response, type NextFunction } from "express";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { SSEServerTransport } from "@modelcontextprotocol/sdk/server/sse.js";
import { z } from "zod";
import { extractItinerary } from "./itinerary-extract.js";

const API_BASE = (process.env.CONTROL_PLANE_API_BASE_URL || "http://127.0.0.1:4310").replace(/\/$/, "");
const MCP_PORT = Number(process.env.INTERVIEW_MCP_PORT || "4311");
const API_KEY = process.env.INTERVIEW_MCP_KEY || "";

if (!API_KEY) {
  process.stderr.write("[interview-mcp] INTERVIEW_MCP_KEY is not set — exiting\n");
  process.exit(1);
}

// ── HTTP helpers — forward to the control-plane API with the caller's bearer token ──

function ok(data: unknown) {
  return { content: [{ type: "text" as const, text: JSON.stringify(data, null, 2) }] };
}

async function forward(path: string, method: "GET" | "POST", bearerToken: string, body?: unknown) {
  // Fastify's JSON body parser rejects an empty body when content-type is
  // application/json, even for routes that never read one — default POST to
  // "{}" rather than omitting the body.
  const response = await fetch(`${API_BASE}${path}`, {
    method,
    headers: {
      authorization: `Bearer ${bearerToken}`,
      ...(method === "POST" ? { "content-type": "application/json" } : {}),
    },
    body: method === "POST" ? JSON.stringify(body ?? {}) : undefined,
  });
  const text = await response.text();
  let parsed: unknown;
  try { parsed = text ? JSON.parse(text) : {}; }
  catch { parsed = { raw: text.slice(0, 500) }; }
  if (!response.ok) {
    throw new Error(`${method} ${path} → ${response.status}: ${JSON.stringify(parsed).slice(0, 300)}`);
  }
  return parsed;
}

// ── MCP tool definitions ──────────────────────────────────────────────────────

function buildMcpServer() {
  const mcp = new McpServer({ name: "interview", version: "1.0.0" });

  mcp.tool(
    "start_interview",
    "Start (or resume) an intake interview session by exchanging the organizer's enrollment token. " +
      "Call this once per interview, right after the organizer confirms they're ready to begin. " +
      "Returns sessionId and sessionToken — hold onto both; every later tool call in this conversation needs them.",
    {
      enrollmentToken: z.string().describe("The single-use enrollment token from the organizer's deep link"),
      telegramChatId: z.string().optional().describe(
        "The organizer's own numeric Telegram id, ONLY if you already know it from this conversation's " +
          "platform context. Used purely as a best-effort hint for where to send the 'your site is ready' " +
          "notification later — never fabricate or guess a value here; omit the field entirely if you don't " +
          "have it. This is not an identity check, just a delivery hint.",
      ),
    },
    async ({ enrollmentToken, telegramChatId }) =>
      ok(await forward("/v1/interview", "POST", enrollmentToken, telegramChatId ? { telegramChatId } : undefined)),
  );

  mcp.tool(
    "get_session_status",
    "Get the current interview state and the next question to ask. Call this if you need to check " +
      "where the conversation left off (e.g. after a gap, or to confirm state before CONFIRM).",
    {
      sessionId: z.string(),
      sessionToken: z.string(),
    },
    async ({ sessionId, sessionToken }) => ok(await forward(`/v1/interview/${encodeURIComponent(sessionId)}`, "GET", sessionToken)),
  );

  mcp.tool(
    "submit_answer",
    "Submit or correct the organizer's answer to one question. For choice questions, pass optionId " +
      "(or \"other\" plus otherText). For plain text questions, pass the text in otherText. For " +
      "structured questions (travelers, phases, travel_anchors, constraints), pass a JSON array/object " +
      "in data — never as a string. A second submission for the same question overwrites the first " +
      "(corrections are allowed before CONFIRM).",
    {
      sessionId: z.string(),
      sessionToken: z.string(),
      questionId: z.string().describe("Question id, e.g. \"destination\" or \"travelers\" — see get_session_status's nextQuestion"),
      optionId: z.string().optional().describe("For choice questions: the chosen option id, or \"other\""),
      otherText: z.string().optional().describe("For choice questions with optionId=\"other\", or for plain text questions"),
      data: z.union([z.array(z.unknown()), z.record(z.string(), z.unknown())]).optional()
        .describe("For structured questions only: an array (travelers, phases, travel_anchors) or object (constraints)"),
    },
    async ({ sessionId, sessionToken, questionId, optionId, otherText, data }) =>
      ok(await forward(`/v1/interview/${encodeURIComponent(sessionId)}/answer`, "POST", sessionToken, { questionId, optionId, otherText, data })),
  );

  // Unlike the tools above, this one does not forward to a control-plane
  // endpoint: it runs a one-shot model call (the shared `kinerary-extract`
  // profile) on this host, where the Hermes CLI is available. All invariants
  // the trip site depends on are enforced in itinerary-extract.ts.
  mcp.tool(
    "extract_itinerary",
    "Turn an uploaded trip-plan document into a per-phase day-by-day itinerary. Call this once, AFTER " +
      "the `phases` answer is captured, ONLY when the organizer shared a plan document. Pass its text " +
      "content as documentText (you have already read it in the conversation), the phases you captured, " +
      "and the destination. Returns { ok, phases: [{ name, days: [...] }], warnings }: review the days " +
      "with the organizer, then fold each phase's days[] into your phases answer and call " +
      "submit_answer(\"phases\", ...). On { ok: false } just continue the interview without days[] — it is " +
      "never required.",
    {
      sessionId: z.string(),
      sessionToken: z.string(),
      destination: z.string().describe("The trip destination, for prompt context"),
      phases: z.array(z.object({
        name: z.string(),
        start: z.string().optional().describe("YYYY-MM-DD if known"),
        end: z.string().optional().describe("YYYY-MM-DD if known"),
      })).describe("The phases you captured — name plus start/end where known"),
      travelers: z.array(z.string()).optional().describe("Traveller first names, for context"),
      documentText: z.string().describe("Plain-text content of the uploaded plan document"),
    },
    async ({ destination, phases, travelers, documentText }) =>
      ok(await extractItinerary({ destination, phases, travelers, documentText })),
  );

  mcp.tool(
    "confirm_intake",
    "Confirm the interview once every required question is answered and the organizer has explicitly " +
      "replied with the literal word CONFIRM after reviewing the summary. Creates an immutable intake " +
      "version. Calling this again after a successful confirm is safe and returns the same result.",
    {
      sessionId: z.string(),
      sessionToken: z.string(),
    },
    async ({ sessionId, sessionToken }) => ok(await forward(`/v1/interview/${encodeURIComponent(sessionId)}/confirm`, "POST", sessionToken)),
  );

  return mcp;
}

// ── Express / SSE transport — mirrors mcp/mcp.js exactly ────────────────────────

const app = express();
const sessions = new Map<string, { transport: SSEServerTransport; server: McpServer; closing: boolean }>();

async function disposeSession(sessionId: string) {
  const session = sessions.get(sessionId);
  if (!session || session.closing) return;
  session.closing = true;
  sessions.delete(sessionId);
  try { await session.server.close(); } catch { /* best-effort */ }
}

function presentedKey(req: Request): string {
  const authHeader = req.headers["authorization"] || "";
  const bearerKey = authHeader.startsWith("Bearer ") ? authHeader.slice(7) : null;
  return (req.headers["x-api-key"] as string) || (req.query.key as string) || bearerKey || "";
}

function keyMatches(presented: string, expected: string): boolean {
  const a = Buffer.from(String(presented || ""));
  const b = Buffer.from(String(expected || ""));
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

function requireKey(req: Request, res: Response, next: NextFunction) {
  if (!keyMatches(presentedKey(req), API_KEY)) { res.status(401).json({ error: "unauthorized" }); return; }
  next();
}

app.get("/sse", requireKey, async (req: Request, res: Response) => {
  const transport = new SSEServerTransport("/messages", res);
  const server = buildMcpServer();
  sessions.set(transport.sessionId, { transport, server, closing: false });
  transport.onclose = () => { disposeSession(transport.sessionId).catch(() => {}); };
  req.on("close", () => { disposeSession(transport.sessionId).catch(() => {}); });
  await server.connect(transport);
});

app.post("/messages", express.json(), async (req: Request, res: Response) => {
  const sessionId = String(req.query.sessionId || "");
  const session = sessions.get(sessionId);
  if (!session) { res.status(404).json({ error: "session_not_found" }); return; }
  await session.transport.handlePostMessage(req, res, req.body);
});

app.listen(MCP_PORT, "127.0.0.1", () => {
  process.stderr.write(`[interview-mcp] listening on 127.0.0.1:${MCP_PORT} → control-plane API: ${API_BASE}\n`);
});
