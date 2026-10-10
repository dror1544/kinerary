// What one member may learn about another (issue #191).
//
// The users table holds telegram_id, google_sub/google_email/google_picture,
// age and family alongside the fields a comment or an RSVP needs to say who
// wrote it. This is an ALLOW-list: a column nobody names here is never
// attached to another member's record, whatever gets added to the table later.
// getUser() stays for a caller's OWN record (/api/auth/me) and nothing else.

const PUBLIC_USER_FIELDS = ['username', 'name', 'name_en', 'color', 'avatar_file'];

function publicUser(row) {
  if (!row || typeof row !== 'object') return null;
  const out = {};
  for (const field of PUBLIC_USER_FIELDS) {
    if (row[field] !== undefined) out[field] = row[field];
  }
  return out;
}

module.exports = { publicUser, PUBLIC_USER_FIELDS };
