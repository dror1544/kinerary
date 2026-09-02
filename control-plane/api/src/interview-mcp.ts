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
import { lookupConsularContacts } from "./consular-lookup.js";

const API_BASE = (process.env.CONTROL_PLANE_API_BASE_URL || "http://127.0.0.1:4310").replace(/\/$/, "");
const MCP_PORT = Number(process.env.INTERVIEW_MCP_PORT || "4311");
const API_KEY = process.env.INTERVIEW_MCP_KEY || "";
/**
 * Service credential for the chat-addressed routes.
 *
 * Unset is a working state: the two `*_for_chat` tools are simply not
 * registered, and an interviewer profile that never sees them keeps to the
 * token-carrying tools. Registering them without a key would advertise a
 * capability every call then fails on.
 */
const AGENT_KEY = process.env.CONTROL_PLANE_INTERVIEW_AGENT_KEY || "";

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

/**
 * Forwards to a chat-addressed route, which authenticates with the service key
 * rather than a per-conversation token.
 *
 * These routes serve an interview the ROUTER started from a /start deep link,
 * so there is no session token to carry — the interview is named by the chat
 * the turn is running in, and the control plane matches that against the turn
 * the router opened when it forwarded.
 */
async function forwardAsAgent(path: string, method: "GET" | "POST", body?: unknown) {
  const response = await fetch(`${API_BASE}${path}`, {
    method,
    headers: {
      "x-api-key": AGENT_KEY,
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
      documentName: z.string().optional().describe("The document's filename, if known"),
    },
    async ({ sessionId, sessionToken, destination, phases, travelers, documentText, documentName }) => {
      const result = await extractItinerary({ destination, phases, travelers, documentText });
      // Keep the raw document for a later re-extraction. Best-effort — the
      // extraction above already used it, so a persistence failure is silent.
      if (documentText && documentText.trim()) {
        try {
          await forward(`/v1/interview/${encodeURIComponent(sessionId)}/source-document`, "POST", sessionToken, {
            text: documentText, filename: documentName,
          });
        } catch { /* not fatal */ }
      }
      // A venue whose URL search was rate-limited is parked in venue_links for
      // the API's background drain to retry; enrich_config picks it up at
      // provision time. Best-effort.
      if (result.ok && result.venueLinksDeferred.length) {
        try {
          await forward(`/v1/interview/${encodeURIComponent(sessionId)}/venue-links`, "POST", sessionToken, {
            destination, deferred: result.venueLinksDeferred,
          });
        } catch { /* not fatal */ }
      }
      return ok(result);
    },
  );

  // Also host-side, also not a forward: find the organizer's home-country
  // embassy/consulate in the destination (there is no keyless API). Checks the
  // cross-trip country_reference store first via the /consular endpoint and
  // only runs the web search on a miss, then writes the result back so the
  // next trip to the same pair reuses it.
  mcp.tool(
    "lookup_consular_contacts",
    "Find the organizer's home-country embassy/consulate in the trip destination (name + phone) for the " +
      "site's Info tab. Call this once, after the destination is known. Pass the destination country and the " +
      "organizer's home country (default the organizer's own country; ask only if unclear). Returns " +
      "{ ok, contacts: [{ name: {he,en}, phone }], cached }. On { ok: false } just continue — the site still " +
      "shows the generic emergency numbers; consular contacts are optional.",
    {
      sessionId: z.string(),
      sessionToken: z.string(),
      destination: z.string().describe("The destination country, e.g. \"Japan\""),
      homeCountry: z.string().describe("The organizer's home country, e.g. \"Israel\""),
    },
    async ({ sessionId, sessionToken, destination, homeCountry }) => {
      const base = `/v1/interview/${encodeURIComponent(sessionId)}/consular`;
      try {
        const cached = (await forward(base, "POST", sessionToken, { destination, homeCountry })) as {
          found?: boolean; contacts?: unknown[];
        };
        if (cached?.found && Array.isArray(cached.contacts) && cached.contacts.length) {
          return ok({ ok: true, contacts: cached.contacts, cached: true });
        }
      } catch {
        // fall through to a live lookup — a read failure shouldn't block one
      }

      const result = await lookupConsularContacts({ destination, homeCountry });
      if (!result.ok) return ok(result);

      try {
        const saved = (await forward(base, "POST", sessionToken, {
          destination, homeCountry, contacts: result.contacts, source: "interview-web-search",
        })) as { contacts?: unknown[] };
        return ok({ ok: true, contacts: saved?.contacts ?? result.contacts, cached: false, warnings: result.warnings });
      } catch (e) {
        // The lookup worked; persistence didn't. Still hand the interviewer the
        // contacts — they just won't be reused by the next trip.
        return ok({ ok: true, contacts: result.contacts, cached: false, persisted: false, warnings: result.warnings });
      }
    },
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

  // ── Chat-addressed tools ───────────────────────────────────────────────────
  //
  // For the interview a Telegram organizer is conducting through the Trip Bot,
  // which the router started from a /start deep link. There is no session
  // token for it — the interview is named by the chat, and the control plane
  // matches that against the turn the router opened when it forwarded the
  // message. Registered only when the service key is configured.
  if (AGENT_KEY) {
    mcp.tool(
      "get_interview_for_chat",
      "Read the interview in progress for the Telegram chat you are currently talking in. Use this " +
        "before answering, to see which question is pending and what has already been recorded. " +
        "Pass the chat id of the conversation you are in.",
      {
        chatId: z.string(),
      },
      async ({ chatId }) => ok(await forwardAsAgent(`/internal/interview/agent/${encodeURIComponent(chatId)}`, "GET")),
    );

    mcp.tool(
      "submit_answer_for_chat",
      "Record an answer for the interview in progress in the Telegram chat you are currently talking " +
        "in. Use this for answers the organizer wrote in words rather than tapped: resolve what they " +
        "meant first, then submit the resolved value. Dates must be normalised to YYYY-MM-DD before " +
        "submitting, and a destination naming several places is a multi-destination trip rather than " +
        "one city. Never show the organizer a YYYY-MM-DD date — confirm your reading back in words.",
      {
        chatId: z.string(),
        questionId: z.string(),
        optionId: z.string().nullish(),
        otherText: z.string().optional(),
        optionIds: z.array(z.string()).optional(),
        data: z.unknown().optional(),
      },
      async ({ chatId, questionId, optionId, otherText, optionIds, data }) =>
        ok(await forwardAsAgent(`/internal/interview/agent/${encodeURIComponent(chatId)}/answer`, "POST", {
          questionId, optionId: optionId ?? null, otherText, optionIds, data,
        })),
    );
  }

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
