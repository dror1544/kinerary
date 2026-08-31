/**
 * venue_links — the deferred-retry side of extract_itinerary's venue ticket /
 * official-URL search (Sprint 4.5).
 *
 * When the interview-time web search is knocked back by a provider rate limit,
 * the unresolved venue names are parked here as `url IS NULL` rows. This
 * module's `resolvePendingVenueLinks` drain — run from server.ts on the same
 * interval as the notification outbox — retries them later. `enrich_config`'s
 * per-venue pass reads the resolved (`url IS NOT NULL`) rows at provision time,
 * so a link filled after CONFIRM still reaches the site on the next provision,
 * and any later trip that names the same place reuses it.
 */
import type pg from "pg";
import { searchVenueUrls, type VenueUrlSearch } from "./itinerary-extract.js";
import { sessionActive } from "./interview.js";
import { structuredLog } from "./redaction.js";

/** Give up on a name after this many drain passes fail to resolve it, so a
 * place with no findable first-party URL doesn't get searched forever. A
 * rate-limited pass does not count against this. */
const MAX_ATTEMPTS = 6;

function normaliseName(value: unknown): string {
  return String(value ?? "").trim().toLowerCase().replace(/\s+/g, " ").slice(0, 160);
}

/** Park venue names whose interview-time URL search was rate-limited. Never
 * clobbers a row that already has a URL (ON CONFLICT DO NOTHING). Gated on an
 * active (unconfirmed) session, like the consular endpoint. */
export async function saveDeferredVenueLinks(
  db: pg.Pool,
  rawSessionToken: string,
  destination: string,
  names: unknown,
): Promise<{ ok: true; queued: number } | { ok: false; reason: "NOT_FOUND" | "INVALID_REQUEST" }> {
  const dest = normaliseName(destination);
  const list = Array.isArray(names)
    ? [...new Set(names.map(normaliseName).filter(Boolean))].slice(0, 40)
    : [];
  if (!dest) return { ok: false, reason: "INVALID_REQUEST" };
  if (!(await sessionActive(db, rawSessionToken))) return { ok: false, reason: "NOT_FOUND" };
  if (!list.length) return { ok: true, queued: 0 };
  await db.query(
    `INSERT INTO control_plane.venue_links (destination, venue_name, url, source)
     SELECT $1, unnest($2::text[]), NULL, 'deferred'
     ON CONFLICT (destination, venue_name) DO NOTHING`,
    [dest, list],
  );
  return { ok: true, queued: list.length };
}

type VenueSearchFn = (names: string[], destination: string) => Promise<VenueUrlSearch>;

/**
 * Retry every parked (`url IS NULL`) venue-link row. One web search per
 * destination. A rate-limited pass is left for the next tick without counting
 * an attempt; any other outcome bumps `attempts` so unresolvable names age out.
 * Returns the number of URLs filled this pass.
 */
export async function resolvePendingVenueLinks(
  db: pg.Pool,
  search: VenueSearchFn = searchVenueUrls,
  log: (line: string) => void = () => {},
): Promise<number> {
  const { rows } = await db.query<{ destination: string; names: string[] }>(
    `SELECT destination, array_agg(venue_name ORDER BY venue_name) AS names
     FROM control_plane.venue_links
     WHERE url IS NULL AND attempts < $1
     GROUP BY destination
     ORDER BY destination
     LIMIT 5`,
    [MAX_ATTEMPTS],
  );

  let resolved = 0;
  for (const { destination, names } of rows) {
    let result: VenueUrlSearch;
    try {
      result = await search(names, destination);
    } catch {
      result = { ok: false, rateLimited: false };
    }
    if (!result.ok) {
      if (result.rateLimited) {
        log(structuredLog("info", "venue_links.retry_rate_limited", { destination, parked: names.length }));
        continue; // leave attempts untouched — try again next tick
      }
      await db.query(
        `UPDATE control_plane.venue_links SET attempts = attempts + 1, fetched_at = now()
         WHERE destination = $1 AND venue_name = ANY($2) AND url IS NULL`,
        [destination, names],
      );
      continue;
    }
    for (const name of names) {
      const hit = result.urls.get(name);
      if (hit) {
        await db.query(
          `UPDATE control_plane.venue_links
           SET url = $3, source = 'cron-retry', attempts = attempts + 1, fetched_at = now()
           WHERE destination = $1 AND venue_name = $2 AND url IS NULL`,
          [destination, name, hit],
        );
        resolved++;
      } else {
        await db.query(
          `UPDATE control_plane.venue_links SET attempts = attempts + 1, fetched_at = now()
           WHERE destination = $1 AND venue_name = $2 AND url IS NULL`,
          [destination, name],
        );
      }
    }
  }
  if (resolved) log(structuredLog("info", "venue_links.retry_resolved", { count: resolved }));
  return resolved;
}
