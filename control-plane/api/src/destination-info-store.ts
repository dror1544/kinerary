/**
 * The monthly re-verification of destination info, and the fan-out that keeps
 * its duplicates in sync (Sprint 6 track 1a, issue #156).
 *
 * `country_reference.fetched_at` has existed since migration 0023 and NOTHING
 * has ever refreshed it — there was no job anywhere that revisited a row. This
 * module is that job for the destination-info half, which needs it far more
 * than the consular half does: an embassy phone number is stable for years,
 * whereas "you can use an eSIM" and "cards are accepted everywhere now" go
 * stale in months and go stale silently, because a wrong line looks exactly
 * like a right one.
 *
 * WHY THE WRITE IS HERE AND NOT AT INTERVIEW TIME. Consular contacts are
 * filled by the interviewer's `lookup_consular_contacts` because they depend on
 * an interview answer (the traveller's home country) and because the whole
 * read/write path is deliberately gated on an ACTIVE intake session
 * (`sessionActive`). Destination info depends on no interview answer — it is a
 * fact about the destination alone — and the monthly refresh has to run when no
 * interview exists at all, so a session-gated tool could not perform it. Adding
 * a second silent background tool to the interviewer's workflow would also buy
 * nothing: the interview does not use the answer. So the write lives here, on a
 * timer, and provision time is a pure cached read — the pattern the brief asked
 * for, and the one `_enrich_consular` already uses on the read side.
 *
 * THE FAN-OUT. country_reference is keyed (destination_country, home_country),
 * but destination info is true of the destination alone, so it is duplicated
 * across every home-country row sharing a destination. `writeDestinationInfo`
 * is a SINGLE destination-keyed UPDATE with no home_country predicate: one
 * model call per destination, one statement, every pairing updated. The model
 * is paid for once per destination per month however many home countries point
 * at it.
 */
import type pg from "pg";
// The country_reference key, shared with saveConsularContacts rather than
// re-implemented here: this module's fan-out UPDATE has to match rows that path
// wrote, and a silent divergence discards a paid-for lookup. See country-key.ts.
import { normaliseCountryKey } from "./country-key.js";
import {
  destinationInfoIsEmpty,
  destinationInfoProfile,
  destinationInfoSearchConfigured,
  lookupDestinationInfo,
  type DestinationInfo,
  type DestinationInfoResult,
} from "./destination-info.js";
import { structuredLog } from "./redaction.js";

/** "Re-verify monthly" (Dror, 2026-09-19). */
export const DESTINATION_INFO_MAX_AGE_DAYS = 30;

/** Destinations refreshed per pass. One pass is one tick of the timer; a model
 * call per destination is minutes, so a small batch keeps a tick bounded. */
const DESTINATIONS_PER_PASS = 3;

/**
 * Destinations that need a lookup: never fetched, or older than *maxAgeDays*.
 *
 * `bool_or(destination_info_fetched_at IS NULL)` is load-bearing and is NOT
 * the same test as `min(destination_info_fetched_at) IS NULL`. SQL's `min()`
 * SKIPS nulls, so a destination with one fresh row and one brand-new null row
 * has a non-null, recent `min()` and would never be selected — and that is
 * precisely the state the consular path creates, every time a trip introduces a
 * new home country for a destination whose info is already cached. Written the
 * obvious way, those rows would stay empty forever while the job reported
 * itself healthy. `bool_or` selects the destination, and the fan-out then fills
 * every row for it, which is how the duplicates converge instead of drifting.
 */
export async function destinationsNeedingInfo(
  db: pg.Pool,
  maxAgeDays: number = DESTINATION_INFO_MAX_AGE_DAYS,
  limit: number = DESTINATIONS_PER_PASS,
): Promise<string[]> {
  const { rows } = await db.query<{ destination_country: string }>(
    `SELECT destination_country
       FROM control_plane.country_reference
      GROUP BY destination_country
     HAVING bool_or(destination_info_fetched_at IS NULL)
         OR min(destination_info_fetched_at) < now() - ($1 || ' days')::interval
      ORDER BY bool_or(destination_info_fetched_at IS NULL) DESC,
               min(destination_info_fetched_at) ASC NULLS FIRST,
               destination_country ASC
      LIMIT $2`,
    [String(maxAgeDays), limit],
  );
  return rows.map((r) => r.destination_country);
}

/**
 * Write one destination's info to EVERY home-country row for that destination,
 * in one statement. Returns the number of rows updated — 0 means the
 * destination has no rows at all, which the caller treats as a miss rather than
 * a success, because a silent 0 here is the difference between "cached" and
 * "we paid a model and threw the answer away".
 */
export async function writeDestinationInfo(
  db: pg.Pool,
  destination: string,
  info: DestinationInfo,
  source: string,
): Promise<number> {
  const dest = normaliseCountryKey(destination);
  if (!dest) return 0;
  const result = await db.query(
    `UPDATE control_plane.country_reference
        SET destination_info = $2::jsonb,
            destination_info_source = $3,
            destination_info_fetched_at = now()
      WHERE destination_country = $1`,
    [dest, JSON.stringify(info), source.slice(0, 200) || null],
  );
  return result.rowCount ?? 0;
}

/**
 * Read the cached info for a destination. Any row will do — the fan-out keeps
 * them identical — but the freshest is preferred in case a pass was interrupted
 * partway.
 *
 * IT HAS NO PRODUCTION CALLER IN THIS PACKAGE, AND THAT IS NOT AN OVERSIGHT.
 * The question was asked in review on #156 — future TS consumer, or dead code?
 * — and the honest answer is neither. This is the TESTED REFERENCE
 * IMPLEMENTATION of a read that genuinely happens, just in another language:
 * `_destination_info_lookup` in
 * control-plane/worker/control_plane_worker/__main__.py issues the same SELECT
 * over psycopg at provision time, and that copy is a closure nested inside the
 * worker's command entry point, with no test harness and no database to run
 * against. Deleting this function would leave the provision-time read — the
 * only read a traveller's Info tab actually depends on — asserted nowhere at
 * all.
 *
 * So the duplication is deliberate and, like the other two cross-language
 * duplications this change introduced (the country key, the item caps), it is
 * ASSERTED RATHER THAN TRUSTED: destination-info-store.test.ts's "the worker's
 * provision-time read matches this module's reference implementation" reads
 * __main__.py and fails if either side changes the filter, the ordering or the
 * row limit alone. Three elements carry meaning and would each fail silently:
 *
 *   - `destination_info_fetched_at IS NOT NULL` — without it a row the consular
 *     path inserted but the refresh has never filled reads as three EMPTY
 *     lists rather than as a miss, and the worker would write an Info tab of
 *     empty sections instead of leaving the config alone.
 *   - `ORDER BY destination_info_fetched_at DESC` — which row wins when a
 *     fan-out was interrupted partway and the duplicates briefly disagree.
 *   - `LIMIT 1` — one destination, one answer.
 *
 * If a TypeScript caller ever does want this (an operator endpoint showing what
 * is cached for a destination is the obvious one), it is ready. Until then its
 * job is to be the half of the contract that can be executed against a real
 * database in CI.
 */
export async function readDestinationInfo(
  db: pg.Pool,
  destination: string,
): Promise<{ info: DestinationInfo; source: string | null; fetchedAt: string } | null> {
  const dest = normaliseCountryKey(destination);
  if (!dest) return null;
  const { rows } = await db.query<{
    destination_info: unknown;
    destination_info_source: string | null;
    destination_info_fetched_at: string;
  }>(
    `SELECT destination_info, destination_info_source, destination_info_fetched_at
       FROM control_plane.country_reference
      WHERE destination_country = $1 AND destination_info_fetched_at IS NOT NULL
      ORDER BY destination_info_fetched_at DESC
      LIMIT 1`,
    [dest],
  );
  const [hit] = rows;
  if (!hit) return null;
  const raw = (hit.destination_info ?? {}) as Partial<DestinationInfo>;
  return {
    info: {
      health: Array.isArray(raw.health) ? raw.health : [],
      money: Array.isArray(raw.money) ? raw.money : [],
      communication: Array.isArray(raw.communication) ? raw.communication : [],
    },
    source: hit.destination_info_source,
    fetchedAt: hit.destination_info_fetched_at,
  };
}

export type DestinationInfoLookupFn = (destination: string) => Promise<DestinationInfoResult>;

export type RefreshSummary = {
  considered: number;
  refreshed: number;
  rowsWritten: number;
  rateLimited: number;
  failed: number;
};

/**
 * One pass: pick the stalest destinations, look each one up once, fan the
 * answer out to every home-country row for it.
 *
 * A RATE LIMIT LEAVES THE CLOCK ALONE. `destination_info_fetched_at` is not
 * touched on a throttled or failed lookup, so the destination stays selected
 * and the next pass retries it. Stamping the clock on a failure would mark a
 * row "verified this month" that nothing verified — the same silent downgrade
 * the venue-link drain avoids by not counting a rate-limited pass as an
 * attempt.
 */
export async function refreshStaleDestinationInfo(
  db: pg.Pool,
  lookup: DestinationInfoLookupFn = lookupDestinationInfo,
  log: (line: string) => void = () => {},
  maxAgeDays: number = DESTINATION_INFO_MAX_AGE_DAYS,
): Promise<RefreshSummary> {
  const summary: RefreshSummary = { considered: 0, refreshed: 0, rowsWritten: 0, rateLimited: 0, failed: 0 };
  const destinations = await destinationsNeedingInfo(db, maxAgeDays);
  summary.considered = destinations.length;

  // SEQUENTIAL ON PURPOSE. Each iteration spawns a `hermes` CLI process that
  // web-searches for minutes, so three in parallel would be three concurrent
  // model processes on a box that is also running the control plane, the relay
  // and a provisioning worker — and would triple the rate at which one provider
  // throttles the lot of them, which this job handles by giving up the pass. The
  // cost of serial is a worst case near six minutes inside an HOURLY unref'd
  // timer that overlaps with nothing (the `refreshing` guard), against a monthly
  // freshness requirement: there is no deadline to miss. Revisit only if
  // DESTINATIONS_PER_PASS grows enough for a pass to approach the interval.
  for (const destination of destinations) {
    let result: DestinationInfoResult;
    try {
      result = await lookup(destination);
    } catch (error) {
      result = {
        ok: false,
        reason: "LOOKUP_FAILED",
        detail: String((error as Error)?.message ?? error).slice(0, 200),
      };
    }

    if (!result.ok) {
      if (result.reason === "RATE_LIMITED") {
        summary.rateLimited++;
        log(structuredLog("info", "destination_info.rate_limited", { destination }));
      } else {
        summary.failed++;
        // Named reason, not just "failed": LOOKUP_NOT_CONFIGURED and a model
        // that answered nothing usable need different fixes, and both otherwise
        // look like an empty Info tab.
        log(structuredLog("warn", "destination_info.lookup_failed", { destination, reason: result.reason }));
      }
      continue;
    }

    if (destinationInfoIsEmpty(result.info)) {
      summary.failed++;
      log(structuredLog("warn", "destination_info.empty_result", { destination }));
      continue;
    }

    const source = `hermes:${destinationInfoProfile() || "unknown"}`;
    const rows = await writeDestinationInfo(db, destination, result.info, source);
    if (rows === 0) {
      // The destination was selected from this very table, so zero rows means
      // it was deleted between the SELECT and the UPDATE. Rare, but a paid
      // model call thrown away is worth a line rather than a silent success.
      summary.failed++;
      log(structuredLog("warn", "destination_info.write_matched_no_rows", { destination }));
      continue;
    }
    summary.refreshed++;
    summary.rowsWritten += rows;
    log(
      structuredLog("info", "destination_info.refreshed", {
        destination,
        rows,
        health: result.info.health.length,
        money: result.info.money.length,
        communication: result.info.communication.length,
        warnings: result.warnings.length,
      }),
    );
  }
  return summary;
}

export { destinationInfoSearchConfigured };
