/**
 * The companion's first message — composed here, not by the agent.
 *
 * Every line of an introduction is a fact: a name, a URL, a password, whether a
 * schedule is configured. None of it is judgement, and all of it is worse than
 * useless if invented — a mistyped password or a hallucinated URL sends the
 * organizer somewhere that does not exist. So the router writes it, the same
 * way it owns the interview's questions, and for the same reason.
 *
 * Design: `docs/companion-introduction-design.md`.
 *
 * TWO AUDIENCES, TWO MESSAGES. The organizer's is a SETUP message — it exists
 * to get them from "a site was provisioned" to "my family is in a group talking
 * to the assistant". The group's is an ARRIVAL message — everyone is already
 * there; tell them what this is and how to get in. Neither is a trimmed version
 * of the other.
 */

/** The `agent.proactive` block from the trip config, as the handoff carries it. */
export interface ProactiveSettings {
  /** "07:30" — a time, not a boolean, when a morning briefing is on. */
  morning_briefing?: string | false | null;
  tomorrow_preview?: boolean | string | null;
  photo_recap?: boolean | string | null;
  flight_changes?: boolean | string | null;
  packing_reminders?: boolean | string | null;
}

export interface CompanionIntroFacts {
  /** The assistant's own name, in the trip's language. */
  assistantName: string;
  tripTitle: string | null;
  siteUrl: string;
  language: "he" | "en";
  /** The shared site login. Null when no seed password was configured. */
  loginPassword?: string | null;
  /**
   * Who to log in AS, name by name.
   *
   * The password alone is half a credential. The site's accounts are the
   * travellers, one username each, and the modern site has no name picker to
   * choose from — so "log in with your name and the password" left an organizer
   * on 2026-09-12 typing at a form with no way to know that אלה is `ella`.
   * Listed here so the introduction can say it outright.
   */
  loginUsernames?: readonly { name: string; username: string }[] | null;
  /** The shared bot's @username, for the add-to-group link. */
  botUsername?: string | null;
  /** Payload for the add-to-group deep link — the trip slug. */
  tripSlug?: string | null;
  organizerName?: string | null;
  proactive?: ProactiveSettings | null;
  /**
   * The group-binding token, when one has been issued for this trip.
   *
   * Adding the bot to a group is only half the job — the group still has to be
   * bound to the trip, and nothing said inside a group proves who the organizer
   * is. This token is the other half: issued here, in the channel where their
   * identity is already established, and redeemed by posting it there.
   */
  groupBindingToken?: string | null;
  /** The group's own invite link, when the bot could read one. Group message only. */
  groupInviteUrl?: string | null;
}

/**
 * The login block: the password, and the name each person types to use it.
 *
 * Every traveller shares one password, so the username is the only thing that
 * distinguishes them — and it is derived from their name rather than chosen, so
 * nobody can guess it. An empty list falls back to the old wording, which is
 * what a trip with no seeded accounts still gets.
 */
function loginLines(facts: CompanionIntroFacts): string[] {
  const he = facts.language === "he";
  if (!facts.loginPassword) return [he ? "הכניסה מהאתר עצמו." : "Log in from the site itself."];
  const people = (facts.loginUsernames ?? []).filter((p) => p.username);
  if (people.length === 0) {
    return [he
      ? `הכניסה עם השם שלכם והסיסמה: ${facts.loginPassword}`
      : `Log in with your name and the password: ${facts.loginPassword}`];
  }
  return [
    he
      ? `הכניסה לאתר — שם המשתמש שלכם והסיסמה ${facts.loginPassword}:`
      : `Log in with your username and the password ${facts.loginPassword}:`,
    ...people.map((p) => `• ${p.name} — ${p.username}`),
  ];
}

/**
 * The deep link that adds this bot to a group, asking for the rights it needs.
 *
 * `?startgroup=` opens Telegram's group picker. There is no URL that CREATES a
 * group — the copy says "pick one, or make one first" rather than pretending
 * otherwise.
 *
 * `&admin=` is the part that matters. Pinning the arrival message and reading
 * an invite link both require admin, and this is the one moment the organizer
 * is already in a permissions dialog. Ask here or the bot lands with no rights
 * and pinning silently fails.
 */
export function groupAddUrl(botUsername: string | null | undefined, payload: string): string | null {
  const handle = (botUsername ?? "").trim().replace(/^@/, "");
  if (!handle) return null;
  // Telegram accepts A-Z a-z 0-9 _ - in a start payload, and every real trip
  // slug is already within that set. So an unsafe character means something
  // upstream is wrong — and STRIPPING it is the dangerous repair: `trip abc/x`
  // would become `tripabcx`, a payload that looks valid and identifies a
  // different trip. Drop the payload whole instead. The link still adds the
  // bot; it simply carries nothing, which is recoverable in a way that a
  // confidently wrong binding is not.
  const raw = payload ?? "";
  const safe = /^[A-Za-z0-9_-]*$/.test(raw) ? raw : "";
  return `https://t.me/${handle}?startgroup=${safe}&admin=pin_messages+invite_users`;
}

/** Whether any proactive message is actually switched on. */
function scheduleLines(proactive: ProactiveSettings | null | undefined, lang: "he" | "en"): string[] {
  const p = proactive ?? {};
  const lines: string[] = [];
  const on = (v: unknown): boolean => v !== undefined && v !== null && v !== false && v !== "";

  if (typeof p.morning_briefing === "string" && p.morning_briefing.trim()) {
    lines.push(lang === "he"
      ? `סיכום בוקר בשעה ${p.morning_briefing}`
      : `a morning briefing at ${p.morning_briefing}`);
  }
  if (on(p.tomorrow_preview)) {
    lines.push(lang === "he" ? "תצוגה מקדימה של מחר" : "a preview of tomorrow");
  }
  if (on(p.flight_changes)) {
    lines.push(lang === "he" ? "התראה על שינויי טיסה" : "a heads-up on flight changes");
  }
  if (on(p.packing_reminders)) {
    lines.push(lang === "he" ? "תזכורות אריזה" : "packing reminders");
  }
  if (on(p.photo_recap)) {
    lines.push(lang === "he" ? "סיכום תמונות" : "a photo recap");
  }
  return lines;
}

/** Joins a list the way the language does, so the sentence reads naturally. */
function listJoin(items: readonly string[], lang: "he" | "en"): string {
  if (items.length <= 1) return items[0] ?? "";
  const last = items[items.length - 1]!;
  const rest = items.slice(0, -1).join(", ");
  return lang === "he" ? `${rest} ו${last}` : `${rest} and ${last}`;
}

/**
 * The organizer's setup message.
 *
 * Order is deliberate: who I am → what I can do → your site and how to get in →
 * how to bring me to the family. The last is the action; it goes last so it is
 * the thing still on screen when they stop reading.
 */
export function organizerIntroText(facts: CompanionIntroFacts): string {
  const he = facts.language === "he";
  const title = facts.tripTitle?.trim() || null;
  const addUrl = groupAddUrl(facts.botUsername, facts.tripSlug ?? "");
  const schedule = scheduleLines(facts.proactive, facts.language);
  const parts: string[] = [];

  if (he) {
    parts.push(
      `שלום! אני ${facts.assistantName}, העוזר של${title ? ` ${title}` : " הטיול"}. האתר של הטיול מוכן, ומעכשיו אני כאן.`,
      "",
      "מה אני יודע לעשות:",
      "• לענות על שאלות על התוכנית — מה יש היום, מתי יוצאים, איפה ישנים",
      "• לעדכן את התוכנית — להוסיף ימים ופעילויות, להזיז דברים, לשנות שעות",
      "• לשמור אישורי הזמנה — שלחו לי אישור טיסה, מלון או כרטיס ואמצא אותו כשתצטרכו",
      "• לזכור העדפות ורגישויות של המשתתפים",
      "",
      `האתר: ${facts.siteUrl}`,
    );
    parts.push(...loginLines(facts));
    if (schedule.length) {
      parts.push("", `אשלח מיוזמתי: ${listJoin(schedule, "he")}.`);
    }
    if (addUrl || facts.groupBindingToken) {
      parts.push("", "כדי שאהיה גם בקבוצה המשפחתית:");
      if (addUrl) {
        parts.push(`1. מוסיפים אותי עם הקישור הזה: ${addUrl}`, "   (בוחרים קבוצה קיימת, או פותחים חדשה ואז מוסיפים)");
      }
      parts.push(`${addUrl ? "2" : "1"}. הופכים אותי למנהל, כדי שאוכל להצמיד את הודעת הפתיחה`);
      if (facts.groupBindingToken) {
        parts.push(
          `${addUrl ? "3" : "2"}. שולחים לקבוצה את השורה שבהודעה הבאה שלי`,
          "",
          "שלחתם לפני שהפכתם אותי למנהל? לא נורא — שלחו שוב אחר כך ואשלים את ההגדרה.",
        );
      }
    }
    return parts.join("\n");
  }

  parts.push(
    `Hello! I'm ${facts.assistantName}, the assistant for${title ? ` ${title}` : " your trip"}. The trip site is ready, and I'm here from now on.`,
    "",
    "What I can do:",
    "• Answer questions about the plan — what's on today, when you leave, where you're staying",
    "• Change the plan — add days and activities, move things around, adjust times",
    "• Keep booking confirmations — send me a flight, hotel or ticket confirmation and I'll find it when you need it",
    "• Remember what people need — diets, allergies, preferences",
    "",
    `The site: ${facts.siteUrl}`,
  );
  parts.push(...loginLines(facts));
  if (schedule.length) {
    parts.push("", `I'll send you ${listJoin(schedule, "en")} without being asked.`);
  }
  if (addUrl || facts.groupBindingToken) {
    parts.push("", "To bring me into the family group:");
    if (addUrl) {
      parts.push(`1. Add me with this link: ${addUrl}`, "   (pick an existing group, or make a new one first)");
    }
    parts.push(
      `${addUrl ? "2" : "1"}. Make me an admin, so I can pin the welcome message`,
    );
    if (facts.groupBindingToken) {
      parts.push(
        `${addUrl ? "3" : "2"}. Post the line in my next message into the group`,
        "",
        "Posted it before making me an admin? No problem — post it again afterwards and I'll finish setting up.",
      );
    }
  }
  return parts.join("\n");
}

/**
 * The group's arrival message.
 *
 * `includePassword` is the one switch in this module. The trip login is shared
 * by design and this message is pinned so a member who joins later can scroll
 * back to it — which is the argument FOR posting it. The argument against is
 * that a password in a group is durable, searchable, and visible to everyone
 * ever added to that group. Both are true; the choice is the deployment's, and
 * turning it off changes nothing else about the message.
 */
export function groupIntroText(
  facts: CompanionIntroFacts,
  options: { includePassword: boolean },
): string {
  const he = facts.language === "he";
  const title = facts.tripTitle?.trim() || null;
  const schedule = scheduleLines(facts.proactive, facts.language);
  const showPassword = options.includePassword && Boolean(facts.loginPassword);
  const parts: string[] = [];

  if (he) {
    parts.push(
      `שלום לכולם! אני ${facts.assistantName}, העוזר של${title ? ` ${title}` : " הטיול"}.`,
      "",
      "אפשר לפנות אליי כאן בכל שאלה:",
      "• מה בתוכנית היום, מתי יוצאים, איפה ישנים",
      "• לעדכן את התוכנית — להוסיף או להזיז פעילויות",
      "• לשלוח לי אישורי הזמנה כדי שיהיו זמינים לכולם",
      "",
      `האתר של הטיול: ${facts.siteUrl}`,
    );
    if (showPassword) {
      parts.push(...loginLines(facts));
    } else if (facts.organizerName) {
      parts.push(`לפרטי הכניסה — ${facts.organizerName}.`);
    }
    if (facts.groupInviteUrl) {
      parts.push("", `קישור להצטרפות לקבוצה: ${facts.groupInviteUrl}`);
    }
    if (schedule.length) {
      parts.push("", `אשלח לכאן מיוזמתי: ${listJoin(schedule, "he")}.`);
    }
    return parts.join("\n");
  }

  parts.push(
    `Hello everyone! I'm ${facts.assistantName}, the assistant for${title ? ` ${title}` : " this trip"}.`,
    "",
    "Ask me anything here:",
    "• What's on today, when we leave, where we're staying",
    "• Change the plan — add or move activities",
    "• Send me booking confirmations so everyone can find them",
    "",
    `The trip site: ${facts.siteUrl}`,
  );
  if (showPassword) {
    parts.push(...loginLines(facts));
  } else if (facts.organizerName) {
    parts.push(`Ask ${facts.organizerName} for the login.`);
  }
  if (facts.groupInviteUrl) {
    parts.push("", `Group invite link: ${facts.groupInviteUrl}`);
  }
  if (schedule.length) {
    parts.push("", `I'll post ${listJoin(schedule, "en")} here without being asked.`);
  }
  return parts.join("\n");
}

/**
 * The command that binds a group, as its own message.
 *
 * Separate from the instructions on purpose. A token buried in a paragraph has
 * to be selected by dragging handles across a phone screen, and getting it
 * slightly wrong produces a token that simply does not work with nothing to
 * explain why. A message containing ONLY the line to post is one long-press
 * and one Copy.
 *
 * It is the full command rather than the bare token because that is what has to
 * be pasted: under Telegram's privacy mode a bot that is not yet an admin
 * receives commands but not ordinary text, so the command form is the one that
 * always arrives — including on the "post it again after making me an admin"
 * retry this flow promises.
 */
export function groupBindingCommand(token: string): string {
  return `/group ${token}`;
}

/**
 * The organizer's introduction, as the messages to send in order.
 *
 * One message when there is no token to hand over, two when there is — the
 * second being nothing but the line to copy.
 */
export function organizerIntroMessages(facts: CompanionIntroFacts): string[] {
  const messages = [organizerIntroText(facts)];
  if (facts.groupBindingToken) messages.push(groupBindingCommand(facts.groupBindingToken));
  return messages;
}
