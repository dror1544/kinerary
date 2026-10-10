/**
 * The one place the `retired-<slug>-<yyyymmdd>` convention lives as code, on
 * this side of the API.
 *
 * `scripts/teardown-trip.py` renames a torn-down trip's slug to this shape as
 * the durable signal that it is gone (issue #105) — `lifecycle_state` is not
 * necessarily updated, so every query that must never treat a torn-down trip
 * as live filters on the slug prefix instead. Before this it was the literal
 * `t.slug NOT LIKE 'retired-%'`, reimplemented with no shared source in
 * `relay/gateway-wait.ts`, `organizer-trips.ts` (twice) and
 * `organizer-invite.ts`. A future change to the marker (a different prefix, a
 * dedicated column) would have had four call sites to find by hand, with no
 * guarantee of catching all of them.
 *
 * `control-plane/worker/control_plane_worker/provisioner.py` has the same
 * convention on the Python side (`bind_chat_to_trip`, `scripts/teardown-trip.py`
 * itself) — not unified here, since sharing code across the two languages
 * would be a bigger change than this constant is meant to be.
 */
export const RETIRED_SLUG_PREFIX = "retired-";

/**
 * SQL fragment excluding retired trips from a query. Assumes the trips table
 * is aliased `t`, which every current call site already does.
 */
export const NOT_RETIRED_SQL = `t.slug NOT LIKE '${RETIRED_SLUG_PREFIX}%'`;
