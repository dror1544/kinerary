/**
 * Shared fixture for the WhatsApp S2 tests: a database with every migration (or every migration but the S2 one, for the
 * "new code on the old schema" cases), and small row builders. Fixture phone numbers live here and in tests only.
 */
import { randomBytes } from "node:crypto";
import { mkdtemp, copyFile, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type pg from "pg";
import { setFeatureSwitch } from "../../src/feature-switches.js";
import { applyMigrations } from "../../src/migrations.js";
import { testPool } from "./test-database.js";

export const MIGRATIONS_DIR = fileURLToPath(new URL("../../../db/migrations/", import.meta.url));
export const S2_MIGRATION = "20261122090000_chat_binding_platform.sql";

const hex = (n = 8) => randomBytes(n).toString("hex");
export const uid = (prefix: string) => `${prefix}_${hex(10)}`;

/** A fresh schema. `oldSchema` applies every migration EXCEPT the S2 one. */
export async function freshDatabase(options: { oldSchema?: boolean } = {}): Promise<pg.Pool> {
  const pool = testPool({ max: 8 });
  const client = await pool.connect();
  try {
    await client.query("DROP SCHEMA IF EXISTS control_plane CASCADE");
    await client.query("DROP TABLE IF EXISTS public.control_plane_schema_migrations");
    let dir = MIGRATIONS_DIR;
    if (options.oldSchema) {
      dir = await mkdtemp(join(tmpdir(), "mig-old-"));
      for (const name of await readdir(MIGRATIONS_DIR)) {
        if (name !== S2_MIGRATION && name.endsWith(".sql")) await copyFile(join(MIGRATIONS_DIR, name), join(dir, name));
      }
    }
    await applyMigrations(client, dir);
  } finally {
    client.release();
  }
  return pool;
}

export async function mkUser(pool: pg.Pool, name = "User"): Promise<string> {
  const id = uid("user");
  await pool.query("INSERT INTO control_plane.users(id,status,display_name) VALUES ($1,'active',$2)", [id, name]);
  return id;
}

export async function mkTrip(pool: pg.Pool, options: { title?: string; retired?: boolean; profile?: string | null; lifecycle?: string } = {}): Promise<string> {
  const id = uid("trip");
  const slug = `${options.retired ? "retired-" : "wa-"}${id.replace(/_/g, "-").toLowerCase()}`;
  await pool.query(
    "INSERT INTO control_plane.trips(id,slug,lifecycle_state,title,hermes_profile) VALUES ($1,$2,$5,$3,$4)",
    [id, slug, options.title ?? "Alsace", options.profile === undefined ? `gw-${hex(4)}` : options.profile, options.lifecycle ?? "ready_private"],
  );
  return id;
}

export async function mkMember(pool: pg.Pool, tripId: string, userId: string, role: "owner" | "organizer" | "member" = "member", status = "active"): Promise<string> {
  const id = uid("memb");
  await pool.query(
    "INSERT INTO control_plane.trip_memberships(id,trip_id,user_id,role,status,dashboard_access,runtime_access) VALUES ($1,$2,$3,$4,$5,$6,true)",
    [id, tripId, userId, role, status, role !== "member"],
  );
  return id;
}

/** A WhatsApp opaque sender id and the private chat id built from it. */
export function waSender(): { senderId: string; chatId: string } {
  const senderId = `wa_${randomBytes(16).toString("hex")}`;
  return { senderId, chatId: `${senderId}@p` };
}

/** A WhatsApp group's chat id: the ALIAS (`wa_<32 hex>@g`), the only form stored in `chat_id`. */
export function waGroupId(): string {
  return `wa_${randomBytes(16).toString("hex")}@g`;
}

/** A group's REAL id as the bridge reports it, new style (18 digits). Rests only in `transport_address`. */
export function waGroupAddress(): string {
  return `${Math.floor(1e17 + Math.random() * 8e17)}@g.us`;
}

/** An OLD-style group's real id: its creator's number, a dash and its creation time. A test value, not a real number. */
export function waOldGroupAddress(): string {
  return `${Math.floor(1e11 + Math.random() * 8e11)}-${Math.floor(1e9 + Math.random() * 8e9)}@g.us`;
}

/** A WhatsApp address as the bridge reports it. A fixture value: the code treats it as opaque. */
export const FIXTURE_ADDRESS = "100000000000001@lid";
export const FIXTURE_PHONE_LAST4 = "4567";

export async function openBinding(pool: pg.Pool, input: {
  tripId: string; chatId: string; platform?: "telegram" | "whatsapp"; profile?: string | null; title?: string | null;
  transportAddress?: string | null; phoneLast4?: string | null;
}): Promise<string> {
  const id = uid("tcb");
  // An open WhatsApp binding always carries the real address (the database requires it): a default for a fixture that does not care.
  const address = input.transportAddress !== undefined ? input.transportAddress
    : input.platform === "whatsapp" ? (input.chatId.endsWith("@g") ? waGroupAddress() : FIXTURE_ADDRESS) : null;
  await pool.query(
    `INSERT INTO control_plane.telegram_chat_bindings (id, chat_id, trip_id, hermes_profile, platform, chat_title, transport_address, phone_last4)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
    [id, input.chatId, input.tripId, input.profile === undefined ? "gw-test" : input.profile, input.platform ?? "telegram",
      input.title ?? null, address, input.phoneLast4 ?? null],
  );
  return id;
}

/** Turns the `whatsapp` switch on (or off) for one trip, the way the operator command does. */
export async function setWhatsappSwitch(pool: pg.Pool, tripId: string, enabled: boolean): Promise<void> {
  const result = await setFeatureSwitch(pool, { switch: "whatsapp", enabled, scope: "trip", trip: tripId, live: true, by: "test" });
  if (!result.ok) throw new Error(`could not set the switch: ${JSON.stringify(result)}`);
}

/** A trip with an owner, the switch on, and a companion profile. */
export async function mkWhatsappTrip(pool: pg.Pool, options: { title?: string; switchOn?: boolean; lifecycle?: string } = {}) {
  const tripId = await mkTrip(pool, { title: options.title ?? "Alsace", ...(options.lifecycle ? { lifecycle: options.lifecycle } : {}) });
  const ownerId = await mkUser(pool, "Dana Owner");
  await mkMember(pool, tripId, ownerId, "owner");
  if (options.switchOn !== false) await setWhatsappSwitch(pool, tripId, true);
  return { tripId, ownerId };
}
