/**
 * lookup_consular_contacts — find the traveler's home-country embassy /
 * consulate in the trip destination (name + phone) at interview time, so
 * enrich_config can put it on the site's Info tab (Sprint 4.5).
 *
 * There is no keyless API for this, so it is a web search. The model produces
 * only structure; `normaliseConsularResult` enforces what the site and the
 * country_reference store require:
 *   - name is plain text (the site renders it through `_biSpan` as raw HTML);
 *   - phone is digits / + ( ) - space only, and goes into a `tel:` href;
 *   - both `he` and `en` are present on every name.
 *
 * The tool that calls this (interview-mcp.ts) checks the cross-trip
 * country_reference store first and only reaches here on a miss.
 */
import { execFile } from "node:child_process";

const HERMES_BIN = process.env.HERMES_BIN || "hermes";
const HERMES_CONSULAR_PROFILE = process.env.HERMES_CONSULAR_PROFILE || "";
const LOOKUP_TIMEOUT_MS = Number(process.env.CONSULAR_LOOKUP_TIMEOUT_MS || "90000");

export type ConsularContact = { name: { he: string; en: string }; phone: string };

export type ConsularLookupArgs = { destination: string; homeCountry: string };

export type ConsularLookupResult =
  | { ok: true; contacts: ConsularContact[]; warnings: string[] }
  | { ok: false; reason: "LOOKUP_NOT_CONFIGURED" | "LOOKUP_FAILED"; detail?: string };

function plain(value: unknown): string {
  return String(value ?? "").replace(/[<>]/g, "").replace(/\s+/g, " ").trim();
}

function cleanPhone(value: unknown): string {
  return plain(value).replace(/[^\d+()\-\s]/g, "").replace(/\s+/g, " ").trim().slice(0, 40);
}

export function normaliseConsularResult(raw: unknown): { contacts: ConsularContact[]; warnings: string[] } {
  const warnings: string[] = [];
  let list: unknown[] = [];
  if (Array.isArray(raw)) list = raw;
  else if (raw && typeof raw === "object") {
    const o = raw as Record<string, unknown>;
    if (Array.isArray(o.contacts)) list = o.contacts;
    else if (Array.isArray(o.emergency_contacts)) list = o.emergency_contacts;
  }

  const contacts: ConsularContact[] = [];
  for (const entry of list.slice(0, 8)) {
    if (!entry || typeof entry !== "object") continue;
    const e = entry as Record<string, unknown>;
    const nameObj = (e.name && typeof e.name === "object" ? e.name : {}) as Record<string, unknown>;
    const nameStr = typeof e.name === "string" ? e.name : "";
    const he = plain(nameObj.he ?? nameStr);
    const en = plain(nameObj.en ?? nameStr);
    const phone = cleanPhone(e.phone);
    if (!he && !en) { warnings.push("dropped a contact with no name"); continue; }
    if (!phone) { warnings.push(`dropped "${en || he}" — no usable phone`); continue; }
    contacts.push({ name: { he: he || en, en: en || he }, phone });
  }
  return { contacts, warnings };
}

export function buildConsularPrompt(args: ConsularLookupArgs): string {
  return [
    `Find the ${args.homeCountry} embassy and any ${args.homeCountry} consulates in ${args.destination}.`,
    `Use web search. Return ONLY a JSON object, no commentary.`,
    ``,
    `For each office give its official name and its main public phone number`,
    `(the one a citizen in distress would call — an after-hours emergency line`,
    `if one is published, otherwise the switchboard). Do not invent a number:`,
    `omit an office you cannot find a real phone for.`,
    ``,
    `Return exactly:`,
    `{ "contacts": [ { "name": { "he": "...", "en": "..." }, "phone": "+..." } ] }`,
    `Provide both "he" (Hebrew) and "en" (English) for every name — you translate.`,
    `Phone in international format. 1-4 offices; the embassy first.`,
  ].join("\n");
}

function firstJsonObject(text: string): unknown {
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start < 0 || end <= start) return null;
  try {
    return JSON.parse(text.slice(start, end + 1));
  } catch {
    return null;
  }
}

function runLookup(prompt: string): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(
      HERMES_BIN,
      ["-p", HERMES_CONSULAR_PROFILE, "chat", "-q", prompt, "-Q", "--safe-mode"],
      { timeout: LOOKUP_TIMEOUT_MS, maxBuffer: 10 * 1024 * 1024 },
      (err, stdout, stderr) => {
        if (!err) return resolve(String(stdout));
        if ((err as NodeJS.ErrnoException).code === "ENOENT") {
          return reject(new Error(`hermes CLI not found (HERMES_BIN=${HERMES_BIN})`));
        }
        const why = err.killed || err.signal ? `timed out (${LOOKUP_TIMEOUT_MS}ms)` : `exit ${(err as NodeJS.ErrnoException).code}`;
        reject(new Error(`hermes ${why}${stderr ? ` — ${String(stderr).trim().slice(-200)}` : ""}`));
      },
    );
  });
}

export async function lookupConsularContacts(args: ConsularLookupArgs): Promise<ConsularLookupResult> {
  if (!HERMES_CONSULAR_PROFILE) return { ok: false, reason: "LOOKUP_NOT_CONFIGURED" };
  if (!args.destination?.trim() || !args.homeCountry?.trim()) {
    return { ok: false, reason: "LOOKUP_FAILED", detail: "destination and homeCountry are required" };
  }
  let stdout: string;
  try {
    stdout = await runLookup(buildConsularPrompt(args));
  } catch (e) {
    return { ok: false, reason: "LOOKUP_FAILED", detail: String((e as Error)?.message ?? e).slice(0, 200) };
  }
  const parsed = firstJsonObject(stdout);
  if (!parsed) return { ok: false, reason: "LOOKUP_FAILED", detail: "no JSON object in model output" };
  const { contacts, warnings } = normaliseConsularResult(parsed);
  if (contacts.length === 0) return { ok: false, reason: "LOOKUP_FAILED", detail: "no usable contacts found" };
  return { ok: true, contacts, warnings };
}
