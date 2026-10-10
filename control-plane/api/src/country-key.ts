/**
 * The primary key of control_plane.country_reference, derived from free text.
 *
 * THIS EXISTS AS ONE FUNCTION BECAUSE TWO WRITE PATHS HAVE TO AGREE ON IT, and
 * they are in different files with different owners:
 *
 *   saveConsularContacts  (interview.ts)            INSERT … ON CONFLICT
 *                                                   (destination_country, home_country)
 *   writeDestinationInfo  (destination-info-store.ts) UPDATE … WHERE destination_country = $1
 *
 * The second is a fan-out: it updates whatever rows the first created. So the
 * key it computes must be byte-identical to the key the first stored, or the
 * UPDATE matches ZERO rows and a model lookup that has already been paid for is
 * silently discarded — visible only as a `destination_info.write_matched_no_rows`
 * line, which nobody reads until an Info tab is mysteriously empty.
 *
 * The two were duplicated verbatim when destination info was added (#156), which
 * made that divergence a single careless edit away: change the 80-character
 * slice, or the whitespace rule, in one copy and the two paths quietly stop
 * addressing the same row. Fixed at the source rather than at the call site.
 *
 * The rules, and why each one matters to the key:
 *   - trim + collapse internal whitespace: the interview captures whatever the
 *     organizer typed, and "United  States " must not be a different country
 *     from "United States".
 *   - lower-case: the same country arrives capitalised differently from the
 *     interviewer, from a document and from a hand-written config.
 *   - 80 characters: the column is free text with no length constraint, so the
 *     key is bounded here. Both paths must truncate at the SAME point.
 *
 * Deliberately NOT shared with venue-links.ts's `normaliseName`: that one keys a
 * different table on a different kind of value (place names, 160 characters).
 * Two things that merely look alike are not one thing, and merging them would
 * couple a venue-name change to an embassy lookup.
 */

/** Max characters of a country name kept in the key. Changing this changes the
 * primary key of every row written from here on; existing rows are not
 * rewritten, so a shorter value would orphan them. */
export const COUNTRY_KEY_MAX_CHARS = 80;

export function normaliseCountryKey(value: unknown): string {
  return String(value ?? "")
    .trim()
    .toLowerCase()
    .replace(/\s+/g, " ")
    .slice(0, COUNTRY_KEY_MAX_CHARS);
}
