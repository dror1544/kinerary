/**
 * Per-trip feature switches: resolve one, set one, describe them all.
 * Contract: docs/specs/sprint-9/567-feature-switches.md (slice S1).
 *
 * A switch is declared once, in shared/feature-switches.js. For a trip its
 * value is: the trip's own setting, else the every-trip setting, else the
 * future-trips setting if the trip was created after it, else OFF — decided in
 * SQL by `control_plane.feature_enabled`, so there is one resolution and every
 * caller (relay code here; the worker in slice S2) gets the same answer.
 *
 * FAIL SAFE. Everything uncertain is off: a name the registry does not hold, a
 * blank trip, a read that fails, a table or function that is missing, an answer
 * that is not the boolean `true`. `featureEnabled` never throws. A failed read
 * is logged (`feature_switch.read_failed`, switch name only) and takes the off
 * branch, so a feature behind a switch behaves as if its code were absent.
 *
 * WHO MAY WRITE: the operator only — `setFeatureSwitch` is reached from the
 * operator command (feature-cli.ts) and the admin-key route (app.ts); there is
 * no organizer route and no companion tool. On a trip in use a switch is a
 * deploy under CLAUDE.md hard rule 2, so a set that touches one needs `live`.
 */
import { createHash, randomBytes } from "node:crypto";
import type pg from "pg";
import {
  FEATURE_SWITCHES,
  findSwitch,
  type FeatureSurface,
} from "../../../shared/feature-switches.js";
import { structuredLog } from "./redaction.js";

export const SWITCH_SCOPES = ["trip", "all_trips", "new_trips"] as const;
export type SwitchScope = (typeof SWITCH_SCOPES)[number];

/** Where a resolved value came from. `default` is the off nobody set. */
export type SwitchSource = SwitchScope | "default";

/**
 * Trip states past `ready_private`: real people have used the site. The same
 * four states `scripts/teardown-trip.py` refuses (REFUSED_STATES); a test pins
 * the two together.
 */
export const IN_USE_TRIP_STATES: readonly string[] = ["activation_approved", "active", "completed", "sealed"];

/** Named in every refusal of an unregistered switch, so the reader knows where to look. */
export const REGISTRY_FILE = "shared/feature-switches.js";

type Queryable = Pick<pg.Pool, "query">;

function sqlstateOf(error: unknown): string | undefined {
  const code = (error as { code?: unknown } | null)?.code;
  return typeof code === "string" && /^[0-9A-Z]{5}$/.test(code) ? code : undefined;
}

const defaultLog = (line: string) => process.stderr.write(`${line}\n`);

/**
 * Is `name` on for `tripId`? The one question relay code asks.
 *
 * The registry is checked first, in code and without touching the database: an
 * unregistered name is off even if a row for it exists. Then one call to the SQL
 * resolver. Anything but a literal `true` back, and any error, is off.
 *
 * The log line carries the switch name and the SQLSTATE and nothing else — not
 * the trip, and not the driver's message, which can quote a connection string.
 */
export async function featureEnabled(
  db: Queryable,
  tripId: string,
  name: string,
  log: (line: string) => void = defaultLog,
): Promise<boolean> {
  if (!findSwitch(name)) return false;
  if (typeof tripId !== "string" || tripId.length === 0) return false;
  try {
    const res = await db.query<{ enabled: unknown }>(
      "SELECT control_plane.feature_enabled($1, $2) AS enabled",
      [tripId, name],
    );
    return res.rows[0]?.enabled === true;
  } catch (error) {
    try {
      log(structuredLog("warn", "feature_switch.read_failed", {
        switch: name,
        ...(sqlstateOf(error) ? { sqlstate: sqlstateOf(error) } : {}),
      }));
    } catch {
      // Logging must never be the reason a feature turns on, or a request fails.
    }
    return false;
  }
}

// ── Setting ──────────────────────────────────────────────────────────────────

export interface SetFeatureSwitchInput {
  switch: string;
  enabled: boolean;
  scope: SwitchScope;
  /** A trip id or slug. Required for the `trip` scope, refused for the others. */
  trip?: string | undefined;
  /** The operator's acknowledgement that this reaches trips in use (hard rule 2). */
  live?: boolean | undefined;
  /** Who. Stored only as a sha256 digest. */
  by?: string | undefined;
}

export type SetFeatureSwitchFailure =
  | "UNKNOWN_SWITCH"
  | "INVALID_REQUEST"
  | "TRIP_REQUIRED"
  | "TRIP_NOT_FOUND"
  | "TRIP_IN_USE"
  | "LIVE_REQUIRED";

export type SetFeatureSwitchResult =
  | {
      ok: true;
      switch: string;
      scope: SwitchScope;
      tripId: string | null;
      /** The value before this set; null when there was no row. */
      previous: boolean | null;
      enabled: boolean;
      effectiveFrom: Date;
    }
  | { ok: false; reason: SetFeatureSwitchFailure; message: string };

const fail = (reason: SetFeatureSwitchFailure, message: string): SetFeatureSwitchResult => ({ ok: false, reason, message });

export function actorDigest(actor: string): string {
  return `sha256:${createHash("sha256").update(actor).digest("hex")}`;
}

interface TripRef {
  id: string;
  slug: string;
  lifecycleState: string;
  createdAt: Date;
}

/** A trip by id or slug, or null. */
export async function findTrip(db: Queryable, ref: string): Promise<TripRef | null> {
  if (typeof ref !== "string" || ref.length === 0 || ref.length > 200) return null;
  const res = await db.query<{ id: string; slug: string; lifecycle_state: string; created_at: Date }>(
    "SELECT id, slug, lifecycle_state, created_at FROM control_plane.trips WHERE id = $1 OR slug = $1 LIMIT 1",
    [ref],
  );
  const row = res.rows[0];
  return row ? { id: row.id, slug: row.slug, lifecycleState: row.lifecycle_state, createdAt: row.created_at } : null;
}

/**
 * Set a switch for one trip, every trip, or future trips; the change and its
 * history row are one transaction. Refusals never write.
 *
 * `live` means "I know this reaches trips in use". The trip scope needs it only
 * when the trip is past `ready_private`; the every-trip and future-trips scopes
 * always need it, because they are not about one test trip.
 *
 * For the future-trips scope the moment it takes effect moves when the VALUE
 * changes and stays put when the same value is set again, so repeating a
 * command cannot drop trips created in between from the switch.
 */
export async function setFeatureSwitch(db: pg.Pool, input: SetFeatureSwitchInput): Promise<SetFeatureSwitchResult> {
  if (typeof input?.switch !== "string") return fail("INVALID_REQUEST", "switch must be a name");
  if (!findSwitch(input.switch)) {
    return fail(
      "UNKNOWN_SWITCH",
      `"${input.switch.slice(0, 60)}" is not a registered switch. Switches are declared in ${REGISTRY_FILE}; nothing was changed.`,
    );
  }
  if (typeof input.enabled !== "boolean") return fail("INVALID_REQUEST", "enabled must be true or false");
  if (!(SWITCH_SCOPES as readonly string[]).includes(input.scope)) {
    return fail("INVALID_REQUEST", `scope must be one of ${SWITCH_SCOPES.join(", ")}`);
  }
  if (input.trip !== undefined && typeof input.trip !== "string") return fail("INVALID_REQUEST", "trip must be a trip id or slug");
  if (input.live !== undefined && typeof input.live !== "boolean") return fail("INVALID_REQUEST", "live must be true or false");
  const by = input.by === undefined ? "operator" : input.by;
  if (typeof by !== "string" || by.trim().length === 0 || by.length > 100) return fail("INVALID_REQUEST", "by must be a short name");
  if (input.scope === "trip" && !input.trip) return fail("TRIP_REQUIRED", "the trip scope needs a trip (id or slug)");
  if (input.scope !== "trip" && input.trip) return fail("INVALID_REQUEST", `scope ${input.scope} takes no trip`);

  const live = input.live === true;
  const changedBy = actorDigest(by);
  const client = await db.connect();
  try {
    await client.query("BEGIN");
    // One writer per switch at a time, so "old value" is the value this set replaced.
    await client.query("SELECT pg_advisory_xact_lock(hashtext($1))", [`feature_switch:${input.switch}`]);

    let trip: TripRef | null = null;
    if (input.scope === "trip") {
      trip = await findTrip(client, input.trip!);
      if (!trip) {
        await client.query("ROLLBACK");
        return fail("TRIP_NOT_FOUND", `no trip "${input.trip!.slice(0, 80)}"`);
      }
      if (IN_USE_TRIP_STATES.includes(trip.lifecycleState) && !live) {
        await client.query("ROLLBACK");
        return fail(
          "TRIP_IN_USE",
          `${trip.slug} is ${trip.lifecycleState}: the trip is in use, so this change is a live change. Re-run with --live, once you have approval to change a trip in use.`,
        );
      }
    } else if (!live) {
      await client.query("ROLLBACK");
      return fail(
        "LIVE_REQUIRED",
        `${input.scope === "all_trips" ? "every trip" : "future trips"} is a live change. Re-run with --live, once you have approval.`,
      );
    }

    const tripId = trip?.id ?? null;
    const before = await client.query<{ enabled: boolean }>(
      `SELECT enabled FROM control_plane.feature_switch_settings
        WHERE switch = $1 AND scope = $2 AND COALESCE(trip_id, '') = COALESCE($3, '')`,
      [input.switch, input.scope, tripId],
    );
    const previous = before.rows[0]?.enabled ?? null;

    const written = await client.query<{ effective_from: Date }>(
      `INSERT INTO control_plane.feature_switch_settings (switch, scope, trip_id, enabled, changed_by)
       VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (switch, scope, (COALESCE(trip_id, ''))) DO UPDATE
         SET enabled = EXCLUDED.enabled,
             changed_by = EXCLUDED.changed_by,
             changed_at = now(),
             effective_from = CASE
               WHEN control_plane.feature_switch_settings.enabled IS DISTINCT FROM EXCLUDED.enabled THEN now()
               ELSE control_plane.feature_switch_settings.effective_from
             END
       RETURNING effective_from`,
      [input.switch, input.scope, tripId, input.enabled, changedBy],
    );
    await client.query(
      `INSERT INTO control_plane.feature_switch_history (id, switch, scope, trip_id, old_enabled, new_enabled, changed_by)
       VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      [`fsh_${randomBytes(16).toString("hex")}`, input.switch, input.scope, tripId, previous, input.enabled, changedBy],
    );
    await client.query("COMMIT");
    return {
      ok: true,
      switch: input.switch,
      scope: input.scope,
      tripId,
      previous,
      enabled: input.enabled,
      effectiveFrom: written.rows[0]!.effective_from,
    };
  } catch (error) {
    try { await client.query("ROLLBACK"); } catch { /* the connection may already be gone */ }
    throw error;
  } finally {
    client.release();
  }
}

// ── Describing ───────────────────────────────────────────────────────────────

export interface FeatureSwitchView {
  name: string;
  summary: string;
  surfaces: readonly FeatureSurface[];
  memberVisible: boolean;
  enabled: boolean;
  source: SwitchSource;
}

/** The registry with no trip: what exists, not what is on. */
export function listFeatureSwitches(): Array<Omit<FeatureSwitchView, "enabled" | "source">> {
  return FEATURE_SWITCHES.map((entry) => ({
    name: entry.name,
    summary: entry.summary,
    surfaces: entry.surfaces,
    memberVisible: entry.memberVisible,
  }));
}

/**
 * Every registered switch with its value for one trip and where the value came
 * from. The VALUE is `control_plane.feature_enabled`'s answer, never recomputed
 * here; the SOURCE is read off the same rows in the same order, and a test
 * pins the two together. Unlike `featureEnabled` this throws on a failed read:
 * an operator asking "what is on" must not be told "nothing" by a broken link.
 */
export async function describeFeatureSwitches(db: Queryable, tripId: string): Promise<FeatureSwitchView[]> {
  const names = FEATURE_SWITCHES.map((entry) => entry.name);
  const [values, rows, trip] = await Promise.all([
    db.query<{ switch: string; enabled: boolean }>(
      "SELECT s AS switch, control_plane.feature_enabled($1, s) AS enabled FROM unnest($2::text[]) AS s",
      [tripId, names],
    ),
    db.query<{ switch: string; scope: SwitchScope; effective_from: Date }>(
      `SELECT switch, scope, effective_from FROM control_plane.feature_switch_settings
        WHERE switch = ANY($2::text[]) AND (scope IN ('all_trips', 'new_trips') OR trip_id = $1)`,
      [tripId, names],
    ),
    db.query<{ created_at: Date }>("SELECT created_at FROM control_plane.trips WHERE id = $1", [tripId]),
  ]);
  const createdAt = trip.rows[0]?.created_at;
  const valueOf = new Map(values.rows.map((row) => [row.switch, row.enabled === true]));

  return FEATURE_SWITCHES.map((entry) => {
    const mine = rows.rows.filter((row) => row.switch === entry.name);
    const has = (scope: SwitchScope) => mine.some((row) => row.scope === scope);
    const newTrips = mine.find((row) => row.scope === "new_trips");
    const source: SwitchSource = has("trip") ? "trip"
      : has("all_trips") ? "all_trips"
      : newTrips && createdAt && createdAt > newTrips.effective_from ? "new_trips"
      : "default";
    return {
      name: entry.name,
      summary: entry.summary,
      surfaces: entry.surfaces,
      memberVisible: entry.memberVisible,
      enabled: valueOf.get(entry.name) === true,
      source,
    };
  });
}
