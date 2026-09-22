/**
 * Recovery for the gap Postgres and the filesystem cannot close together.
 *
 * A document is claimed in the registry ('reserved'), its bytes are written with
 * a temp file linked into place, and the row is marked 'stored'. A crash can land
 * between any two of those steps, and this sweep is what makes each outcome
 * harmless rather than permanent:
 *
 *   a temp file with no final name   an interrupted write — deleted once old
 *   a 'reserved' row with no bytes   an interrupted claim — released once old, so
 *                                    the same file uploaded again is not blocked
 *                                    behind a row that will never complete
 *
 * A stored document is never touched. A final blob with no row is left alone
 * too: it is complete and content-addressed, a later upload of the same file
 * reuses it, and deleting it is a retention decision rather than a recovery one.
 *
 * "Old" is deliberately generous. A document read takes minutes; a reservation
 * swept out from under a read still in progress would be the bug this exists to
 * prevent.
 */
import type pg from "pg";
import type { DocumentBlobStore } from "./document-store.js";
import { releaseReservation, staleReservedDocuments } from "./document-registry.js";
import { structuredLog } from "./redaction.js";

export const TEMPORARY_WRITE_MAX_AGE_MS = 60 * 60_000;
export const RESERVATION_MAX_AGE_SECONDS = 60 * 60;

export async function sweepDocumentStore(
  db: pg.Pool,
  store: DocumentBlobStore | undefined,
  options: { now?: number; temporaryMaxAgeMs?: number; reservationMaxAgeSeconds?: number } = {},
): Promise<{ temporaryRemoved: number; reservationsReleased: number }> {
  const temporaryRemoved = store
    ? await store.sweepTemporary(options.temporaryMaxAgeMs ?? TEMPORARY_WRITE_MAX_AGE_MS, options.now)
    : 0;
  let reservationsReleased = 0;
  for (const document of await staleReservedDocuments(db, options.reservationMaxAgeSeconds ?? RESERVATION_MAX_AGE_SECONDS)) {
    if (await releaseReservation(db, document.tripId, document.id)) reservationsReleased += 1;
  }
  return { temporaryRemoved, reservationsReleased };
}

/** Sweep on an interval for the life of the process. Returns the stop function. */
export function startDocumentSweeper(
  db: pg.Pool,
  store: DocumentBlobStore | undefined,
  log: (line: string) => void,
  intervalMs = 15 * 60_000,
): () => void {
  let sweeping = false;
  const timer = setInterval(() => {
    if (sweeping) return;
    sweeping = true;
    sweepDocumentStore(db, store)
      .then((swept) => {
        if (swept.temporaryRemoved || swept.reservationsReleased) {
          log(structuredLog("info", "relay.document_store_swept", {
            temporary_removed: swept.temporaryRemoved,
            reservations_released: swept.reservationsReleased,
          }));
        }
      })
      .catch((error) => {
        log(structuredLog("warn", "relay.document_sweep_failed", {
          detail: String((error as Error)?.message ?? error).slice(0, 200),
        }));
      })
      .finally(() => {
        sweeping = false;
      });
  }, intervalMs);
  timer.unref();
  return () => clearInterval(timer);
}
