/**
 * The message an organizer forwards to a traveller with their personal invite link (x-member-sign-in, S2). The wording lives HERE, once,
 * for everything in the control plane that hands an organizer a link to forward (today the relay's `/invite`, relay/invite-command.ts).
 * The dashboard's own copy of these two sentences is trip-web/src/member-invites.tsx `inviteMessages`: a different package, which this
 * one does not import, so the two are kept word for word by hand. Change both, or neither.
 *
 * One message in both languages with the link ONCE at the end, so the organizer forwards a single message whatever the traveller reads.
 */

const dateIn = (expiresAt: string, locale: "en-GB" | "he-IL"): string => {
  const date = new Date(expiresAt);
  // UTC, so the sentence does not depend on the relay host's zone.
  return Number.isNaN(date.getTime()) ? "" : date.toLocaleDateString(locale, { day: "numeric", month: "short", year: "numeric", timeZone: "UTC" });
};

/** Hebrew, English and the link: what to forward as-is. */
export function siteInviteForwardMessage(name: string, link: string, expiresAt: string): string {
  const en = dateIn(expiresAt, "en-GB");
  const he = dateIn(expiresAt, "he-IL");
  return [
    `היי ${name}, זה הקישור האישי שלך לטיול שלנו. פתחו אותו והיכנסו עם Google, או בחרו סיסמה. הוא מיועד רק לך, אז בבקשה אל תעבירו אותו הלאה.${he ? ` הוא תקף עד ${he}.` : ""}`,
    `Hi ${name}, this is your personal link to our trip. Open it and sign in with Google, or choose a password. It is only for you, so please do not forward it.${en ? ` It works until ${en}.` : ""}`,
    link,
  ].join("\n\n");
}
