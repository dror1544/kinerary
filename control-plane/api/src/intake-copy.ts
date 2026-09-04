/**
 * Organizer-facing copy for the intake, in the languages the interview speaks.
 *
 * TWO PROBLEMS, ONE FILE.
 *
 * 1. `INTAKE_QUESTIONS[].prompt` was doing two incompatible jobs: a field spec
 *    for the interviewer agent, and the sentence the router says out loud. So
 *    organizers were read instructions written for a model — the `phases`
 *    prompt's "a short place name (city or region — e.g. "Dallas", not "Dallas
 *    (boys; Mavericks game September 6)")… it's fine to just not record it
 *    structurally" appeared verbatim in a live interview, twice, including on
 *    the confirmation screen. `prompt` stays as the agent's spec and is never
 *    shown; `ask` is what a person reads.
 *
 * 2. Every router-drawn string was English regardless of the conversation. An
 *    organizer writing Hebrew got Hebrew from the agent and English from the
 *    router, alternating, inside one interview.
 *
 * Fallbacks are deliberate and total: a question with no entry here falls back
 * to its English `prompt`, and a language with no translation falls back to
 * English. A missing translation should degrade to a sentence in the wrong
 * language, never to a blank message or a crash.
 */
import type { IntakeQuestion } from "./interview.js";

/** The languages the router can draw. Not the languages the AGENT can speak — it speaks whatever the organizer writes. */
export const LANGUAGES = ["en", "he"] as const;
export type Language = (typeof LANGUAGES)[number];
export const DEFAULT_LANGUAGE: Language = "en";

export function isLanguage(value: unknown): value is Language {
  return typeof value === "string" && (LANGUAGES as readonly string[]).includes(value);
}

/**
 * Coerces anything the agent might report into a supported language.
 *
 * The agent is told to send a two-letter code, but it is a language model and
 * "Hebrew" or "he-IL" are exactly the kinds of thing it sends instead. Taking
 * the prefix and matching case-insensitively costs nothing and avoids an
 * interview silently staying English because of a hyphen.
 */
export function coerceLanguage(value: unknown): Language | null {
  if (typeof value !== "string") return null;
  const head = value.trim().toLowerCase().split(/[-_\s]/)[0] ?? "";
  if (isLanguage(head)) return head;
  const named: Record<string, Language> = { hebrew: "he", english: "en", עברית: "he", אנגלית: "en" };
  return named[head] ?? null;
}

type Localised = Record<Language, string>;

interface QuestionCopy {
  /** What the organizer is asked. */
  ask: Localised;
  /** Short noun for the recap line — a recap of fifteen full questions is unreadable. */
  recap: Localised;
  options?: Record<string, Localised>;
}

export const INTAKE_COPY: Record<string, QuestionCopy> = {
  trip_type: {
    ask: { en: "What type of trip is this?", he: "איזה סוג טיול זה?" },
    recap: { en: "Trip type", he: "סוג הטיול" },
    options: {
      family: { en: "Family", he: "משפחה" },
      group_of_families: { en: "Group of families", he: "כמה משפחות" },
      couple: { en: "Couple", he: "זוג" },
    },
  },
  destination: {
    ask: { en: "Where is the trip? (city, region or country)", he: "לאן נוסעים? (עיר, אזור או מדינה)" },
    recap: { en: "Destination", he: "יעד" },
  },
  trip_interests: {
    ask: { en: "Any specific interests or must-sees?", he: "יש משהו שחשוב לכם לראות או לעשות?" },
    recap: { en: "Interests", he: "תחומי עניין" },
  },
  departure_date: {
    ask: { en: "What day does the trip start?", he: "מתי הטיול מתחיל?" },
    recap: { en: "Starts", he: "תאריך יציאה" },
  },
  return_date: {
    ask: { en: "What day does everyone head home?", he: "מתי חוזרים הביתה?" },
    recap: { en: "Ends", he: "תאריך חזרה" },
  },
  timezone: {
    ask: {
      en: "What timezone should times show in? The destination city is enough — we can work it out.",
      he: "באיזה אזור זמן להציג שעות? מספיק לכתוב את עיר היעד.",
    },
    recap: { en: "Timezone", he: "אזור זמן" },
  },
  travelers: {
    ask: {
      en: "Who's coming? Names and ages, and which family each person belongs to.",
      he: "מי מגיע לטיול? שם וגיל של כל אחד, ולאיזו משפחה הוא שייך.",
    },
    recap: { en: "Travellers", he: "נוסעים" },
  },
  phases: {
    ask: {
      en: "Where are you going, and when? The stops in order, with rough dates — and where you're staying if it's booked.",
      he: "לאן אתם הולכים, ומתי? התחנות לפי הסדר, עם תאריכים משוערים — ואיפה אתם ישנים אם כבר הזמנתם.",
    },
    recap: { en: "Stops", he: "תחנות" },
  },
  travel_anchors: {
    ask: {
      en: "Any flights, hotels or cars already booked? Confirmation numbers help.",
      he: "יש טיסות, מלונות או רכב שכבר הזמנתם? מספרי אישור יעזרו.",
    },
    recap: { en: "Booked already", he: "הזמנות קיימות" },
  },
  constraints: {
    ask: {
      en: "Anything the group needs accommodated — mobility, budget expectations, family dynamics?",
      he: "יש משהו שצריך להתחשב בו — ניידות, ציפיות תקציב, דינמיקה משפחתית?",
    },
    recap: { en: "To accommodate", he: "התחשבויות" },
  },
  trip_pace: {
    ask: { en: "What pace suits this group?", he: "באיזה קצב מתאים לקבוצה לטייל?" },
    recap: { en: "Pace", he: "קצב" },
    options: {
      easygoing: {
        en: "Easygoing — late starts, few things a day",
        he: "רגוע — יוצאים מאוחר, מעט דברים ביום",
      },
      balanced: {
        en: "Balanced — a main plan a day, room to drift",
        he: "מאוזן — תוכנית מרכזית ביום, עם מקום לזרום",
      },
      intense: { en: "Intense — early starts, pack it in", he: "אינטנסיבי — יוצאים מוקדם, ממקסמים" },
    },
  },
  dietary: {
    ask: {
      en: "Does any of this apply to anyone travelling?",
      he: "יש מגבלות אכילה אצל מישהו מהנוסעים?",
    },
    recap: { en: "Food", he: "מגבלות אכילה" },
    options: {
      none: { en: "None of these", he: "אין" },
      kosher: { en: "Kosher", he: "כשר" },
      kosher_style: {
        en: "Kosher-style — no pork or shellfish, regular beef and chicken is fine",
        he: "כשר־סטייל — בלי חזיר ופירות ים, בשר ועוף רגילים בסדר",
      },
      vegetarian: { en: "Vegetarian", he: "צמחוני" },
      vegan: { en: "Vegan", he: "טבעוני" },
      lactose_free: { en: "Lactose intolerant", he: "רגישות ללקטוז" },
      gluten_free: { en: "Gluten-free / celiac", he: "ללא גלוטן / צליאק" },
      nut_allergy: { en: "Nut allergy", he: "אלרגיה לאגוזים" },
    },
  },
  dietary_scope: {
    ask: {
      en: "Do those apply to everyone, or to particular people?",
      he: "זה נוגע לכולם או לאנשים מסוימים?",
    },
    recap: { en: "Who that applies to", he: "למי זה נוגע" },
  },
  organizer_identity: {
    ask: {
      en: "Which of the travellers are you? This opens your private organizer channel with the assistant.",
      he: "מי מהנוסעים זה אתה? זה פותח לך ערוץ מארגן פרטי מול העוזר.",
    },
    recap: { en: "Organizer", he: "המארגן" },
  },
  bot_name: {
    ask: {
      en: "What should the trip assistant be called? Give the name people would actually type — both, if your group writes in two languages.",
      he: "איך לקרוא לעוזר של הטיול? תנו את השם שבאמת יקלידו — ואם בקבוצה כותבים בשתי שפות, תנו את שניהם.",
    },
    recap: { en: "Assistant name", he: "שם העוזר" },
  },
  bot_gender: {
    ask: { en: "How should the assistant refer to itself?", he: "באיזו לשון העוזר יפנה לעצמו?" },
    recap: { en: "Assistant voice", he: "לשון פנייה" },
    options: {
      male: { en: "Male", he: "זכר" },
      female: { en: "Female", he: "נקבה" },
      neutral: { en: "Neither — avoid gendered phrasing", he: "בלי לשון מגדרית" },
    },
  },
  bot_tone: {
    ask: { en: "What tone should it take?", he: "באיזה סגנון?" },
    recap: { en: "Assistant tone", he: "סגנון" },
    options: {
      warm: { en: "Warm", he: "חמים" },
      playful: { en: "Playful", he: "שובב" },
      dry: { en: "Dry", he: "ענייני" },
    },
  },
  bot_proactive: {
    ask: {
      en: "What should it send on its own, without being asked?",
      he: "מה שהעוזר ישלח מיוזמתו, בלי שיבקשו ממנו?",
    },
    recap: { en: "Sends on its own", he: "יוזמה" },
    options: {
      none: { en: "Nothing — only answer when asked", he: "כלום — רק כשפונים אליו" },
      morning_briefing: { en: "Morning briefing — today's plan", he: "תדריך בוקר — התוכנית להיום" },
      tomorrow_preview: { en: "Evening look-ahead at tomorrow", he: "הצצה בערב לקראת מחר" },
      photo_recap: { en: "Photo recap when people upload", he: "סיכום תמונות כשמעלים" },
      flight_changes: { en: "Flight changes", he: "שינויים בטיסות" },
      packing_reminders: { en: "Packing reminders the day before", he: "תזכורת אריזה יום לפני" },
    },
  },
  bot_limits: {
    ask: {
      en: "Anything it should keep in mind about these people, or stay away from?",
      he: "משהו שכדאי שהעוזר יזכור לגבי האנשים האלה, או שיימנע ממנו?",
    },
    recap: { en: "Assistant limits", he: "גבולות לעוזר" },
  },
  planning_help: {
    ask: {
      en: "Anything you'd like help planning once the assistant is up — days you haven't worked out, places you're unsure about, bookings still to make? It won't hold up setup.",
      he: "יש משהו שתרצו עזרה לתכנן אחרי שהעוזר יעלה — ימים שעוד לא סגורים, מקומות שאתם מתלבטים לגביהם, הזמנות שנשארו? זה לא מעכב את ההקמה.",
    },
    recap: { en: "Wants help with", he: "עזרה בתכנון" },
  },
  home_country: {
    ask: {
      en: "Which country are you from? This only decides which embassy the site lists for emergencies.",
      he: "מאיזו מדינה אתם? זה רק קובע איזו שגרירות תופיע באתר למקרי חירום.",
    },
    recap: { en: "Home country", he: "מדינת מוצא" },
  },
  budget_detail: {
    ask: {
      en: "Want a rough budget on the site? A currency and a few cost lines is enough.",
      he: "רוצים תקציב משוער באתר? מספיק מטבע וכמה שורות עלות.",
    },
    recap: { en: "Budget", he: "תקציב" },
  },
};

/** Every router-drawn string that is not a question. */
export const UI_STRINGS: Record<Language, Record<string, string>> = {
  en: {
    skip: "⤼ Skip this one",
    finish: "🏁 No more questions",
    multiDone: "✔️ Done",
    confirm: "✅ Confirm",
    keepPlanning: "✏️ Keep planning",
    recapHeader: "Here's what I have:",
    recapFooter: "Confirm to lock this in, or keep planning to change something.",
    keepPlanningReply: "Sure — tell me what you'd like to change and we'll go from there.",
    fileReceived: "Got it — reading it now…",
    none: "(none)",
    skipped: "(skipped)",
    otherPrefix: "Other",
    essentialsDone: "That's everything I need. Want to add a few more details, or shall I show you the summary?",
    askMore: "➕ A few more questions",
    documentOffer: "Before we start on details — if you already have a plan, a booking confirmation, tickets or a spreadsheet for this trip, send it here and I'll read it instead of making you type it all out.",
    noDocument: "I don't have one",
  },
  he: {
    skip: "⤼ דלג על זו",
    finish: "🏁 מספיק שאלות",
    multiDone: "✔️ סיימתי",
    confirm: "✅ אישור",
    keepPlanning: "✏️ עוד לא סיימתי",
    recapHeader: "זה מה שיש לי:",
    recapFooter: "אם הכל נכון — אישור. אם משהו לא מדויק — עוד לא סיימתי.",
    keepPlanningReply: "בטח — ספרו לי מה לשנות ונמשיך משם.",
    fileReceived: "קיבלתי — קורא את זה עכשיו…",
    none: "(אין)",
    skipped: "(דילגו)",
    otherPrefix: "אחר",
    essentialsDone: "זה כל מה שצריך. רוצים להוסיף עוד כמה פרטים, או שאראה לכם סיכום?",
    askMore: "➕ עוד כמה שאלות",
    documentOffer: "לפני שנתחיל בפרטים — אם כבר יש לכם תוכנית, אישור הזמנה, כרטיסים או גיליון לטיול, שלחו אותו לכאן ואני אקרא אותו במקום שתקלידו הכל.",
    noDocument: "אין לי מסמך",
  },
};

export function uiString(key: string, language: Language = DEFAULT_LANGUAGE): string {
  return UI_STRINGS[language]?.[key] ?? UI_STRINGS[DEFAULT_LANGUAGE][key] ?? key;
}

function pick(localised: Localised | undefined, language: Language): string | null {
  if (!localised) return null;
  return localised[language] ?? localised[DEFAULT_LANGUAGE] ?? null;
}

/** The sentence to put to the organizer. Falls back to the agent-facing prompt. */
export function askText(question: IntakeQuestion, language: Language = DEFAULT_LANGUAGE): string {
  return pick(INTAKE_COPY[question.id]?.ask, language) ?? question.prompt;
}

/** The short noun for a recap line. Falls back to the sentence, then the prompt. */
export function recapLabel(question: IntakeQuestion, language: Language = DEFAULT_LANGUAGE): string {
  return pick(INTAKE_COPY[question.id]?.recap, language) ?? askText(question, language);
}

/** A button's label. Falls back to the English label in the question set. */
export function optionLabel(
  question: IntakeQuestion,
  optionId: string,
  language: Language = DEFAULT_LANGUAGE,
): string {
  const translated = pick(INTAKE_COPY[question.id]?.options?.[optionId], language);
  return translated ?? question.options?.find((o) => o.id === optionId)?.label ?? optionId;
}
