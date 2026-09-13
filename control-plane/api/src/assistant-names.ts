/**
 * The assistant's names — the words that make a group message reach it.
 *
 * In a family group the router forwards a message to the companion only when it
 * names the assistant, replies to it, or @mentions the bot (relay/addressing.ts).
 * The names that count live on `trips.assistant_names`, written once at
 * provisioning from the interview's `bot_name` answer. Until 2026-09-13 nothing
 * could change them afterwards: a family renamed their assistant in the group,
 * the companion agreed and saved the new name to its own memory, and every
 * message that used it was dropped as NOT_ADDRESSED before the companion could
 * see it. It had agreed to a name it could never hear.
 *
 * So a rename has one home, here, and two ways in: the router's `/name` command
 * and the companion's `set_assistant_names` tool (companion-mcp.ts). Both write
 * the router's list and the stored introduction facts together, so the next
 * group welcome uses the same name the family is already typing.
 *
 * A rename REPLACES the list rather than adding to it. The case that found this
 * had the family's own surname registered as the assistant's name — an
 * interview misfiling, issue #48 — so keeping old names would keep the bot
 * waking up whenever the family was mentioned.
 */
import type pg from "pg";

export const MAX_ASSISTANT_NAMES = 3;
const MIN_NAME_LENGTH = 2;
const MAX_NAME_LENGTH = 40;

export type ParsedAssistantNames =
  | { ok: true; names: string[] }
  | { ok: false; reason: "EMPTY" | "TOO_MANY" | "TOO_LONG" | "INVALID" };

/**
 * Validates a rename, from either a command argument ("סולו / Solo") or a
 * tool's list. Deliberately structural only: whether a name is appropriate or
 * confusing (a traveller's name, the family name) is issue #48's due diligence,
 * not a format rule.
 */
export function parseAssistantNames(input: string | readonly string[]): ParsedAssistantNames {
  const raw = typeof input === "string" ? input.split(/[/,،|]/) : [...input];
  // Line breaks are refused BEFORE whitespace is collapsed. Collapsing first
  // turned "סולו\nתודה" — a rename followed by a thank-you on the next line —
  // into the single name "סולו תודה".
  if (raw.some((n) => /[\n\r\t]/.test(String(n ?? "").trim()))) return { ok: false, reason: "INVALID" };
  const names = [...new Set(raw.map((n) => String(n ?? "").replace(/\s+/g, " ").trim()).filter(Boolean))];
  if (names.length === 0) return { ok: false, reason: "EMPTY" };
  if (names.length > MAX_ASSISTANT_NAMES) return { ok: false, reason: "TOO_MANY" };
  for (const name of names) {
    if (name.length > MAX_NAME_LENGTH) return { ok: false, reason: "TOO_LONG" };
    // A name is matched as a whole word in ordinary chat, so it must be one a
    // person can type: no command, no @handle, no markup.
    if (name.length < MIN_NAME_LENGTH || name.startsWith("/") || /[@<>`\n\r\t]/.test(name)) {
      return { ok: false, reason: "INVALID" };
    }
  }
  return { ok: true, names };
}

/** The names a trip's assistant currently answers to. */
export async function getAssistantNames(db: pg.Pool, tripId: string): Promise<string[]> {
  const { rows } = await db.query<{ assistant_names: string[] | null }>(
    "SELECT assistant_names FROM control_plane.trips WHERE id = $1",
    [tripId],
  );
  return rows[0]?.assistant_names ?? [];
}

/**
 * Replaces the names, and the name the stored introduction uses. Returns the
 * names now in force, or null when the trip does not exist.
 */
export async function setAssistantNames(
  db: pg.Pool,
  tripId: string,
  names: readonly string[],
): Promise<string[] | null> {
  const { rows } = await db.query<{ assistant_names: string[] }>(
    `UPDATE control_plane.trips
        SET assistant_names = $2::text[],
            companion_intro = CASE
              WHEN companion_intro IS NULL THEN NULL
              ELSE jsonb_set(companion_intro, '{assistant_name}', to_jsonb($3::text))
            END,
            updated_at = now()
      WHERE id = $1
      RETURNING assistant_names`,
    [tripId, names, names[0]],
  );
  return rows[0]?.assistant_names ?? null;
}
