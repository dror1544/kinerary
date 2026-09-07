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
  /** The shared bot's @username, for the add-to-group link. */
  botUsername?: string | null;
  /** Payload for the add-to-group deep link — the trip slug. */
  tripSlug?: string | null;
  organizerName?: string | null;
  proactive?: ProactiveSettings | null;
  /** The group's own invite link, when the bot could read one. Group message only. */
  groupInviteUrl?: string | null;
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
    parts.push(facts.loginPassword
      ? `הכניסה עם השם שלכם והסיסמה: ${facts.loginPassword}`
      : "הכניסה מהאתר עצמו.");
    if (schedule.length) {
      parts.push("", `אשלח מיוזמתי: ${listJoin(schedule, "he")}.`);
    }
    if (addUrl) {
      parts.push(
        "",
        "כדי שאהיה גם בקבוצה המשפחתית — הקישור הזה מוסיף אותי לקבוצה:",
        addUrl,
        "בוחרים קבוצה קיימת, או פותחים קבוצה חדשה ואז מוסיפים אותי.",
      );
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
  parts.push(facts.loginPassword
    ? `Log in with your name and the password: ${facts.loginPassword}`
    : "Log in from the site itself.");
  if (schedule.length) {
    parts.push("", `I'll send you ${listJoin(schedule, "en")} without being asked.`);
  }
  if (addUrl) {
    parts.push(
      "",
      "To bring me into the family group, this link adds me:",
      addUrl,
      "Pick an existing group, or make a new one first and then add me.",
    );
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
      parts.push(`הכניסה עם השם שלכם והסיסמה: ${facts.loginPassword}`);
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
    parts.push(`Log in with your name and the password: ${facts.loginPassword}`);
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
