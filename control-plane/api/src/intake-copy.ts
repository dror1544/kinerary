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
    // "Anything you'd like help planning" reads as handing out work, and the
    // old text then undercut itself with "it won't hold up setup" — a question
    // that announces it does not matter invites skipping, and Dror called it
    // redundant on that basis.
    //
    // It is not redundant: the answer becomes a standing instruction for the
    // companion on the live site ("the organizer asked for help with this after
    // setup: …"), which makes it the one question that shapes what the
    // assistant volunteers later. So the fix is the framing. Asking someone to
    // FLAG something for later is a small, natural thing to say yes to; asking
    // them to delegate planning is not.
    ask: {
      en: "Anything you'd like me to note for later — something to come back to once the trip is set up? An open day, a place you're still deciding on, a booking you haven't made.",
      he: "יש משהו שתרצו שאסמן לעצמי להמשך — משהו שנחזור אליו אחרי שהטיול יוקם? יום שעוד פתוח, מקום שאתם מתלבטים לגביו, הזמנה שטרם נסגרה.",
    },
    recap: { en: "Noted for later", he: "לסמן להמשך" },
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
    finish: "🏁 Finished",
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
    essentialsDone: "That's everything I actually need — the rest is optional. A few more questions let me tailor your assistant to the group: how you like to travel, what people eat, who to keep an eye on. Answer as many or as few as you like, and press Finished whenever you've had enough.",
    askMore: "➕ A few more questions",
    documentOffer: "Before we start on details — if you already have a plan, a booking confirmation, tickets or a spreadsheet for this trip, send it here and I'll read it instead of making you type it all out.",
    noDocument: "I don't have one",
    // THE FIRST THING ANYONE SEES.
    //
    // It exists because of what it is asking for: names, dates, dietary needs,
    // who is coming, booking confirmations with reference numbers on them.
    // Someone handing that over is owed three answers before they hand over
    // anything — who is asking, what happens to it, and what they get at the
    // end — and until this existed the opening was a single line about
    // documents, which answers none of them.
    //
    // Deliberately concrete about the endgame. "A personalised site and an
    // assistant" is a promise; "a site everyone on the trip can open, and a bot
    // you add to the family group that answers questions while you are there"
    // is a picture, and a picture is what makes someone willing to type their
    // children's names into a chat window.
    //
    // The documents paragraph says "you can ask me for it later" because that
    // is the difference between handing something over and giving it away.
    introduction: [
      "Hi — I'm the assistant that sets your trip up. One conversation, and it's done.",
      "",
      "I'll ask about the trip: where, when, who's coming, how you like to travel. It isn't a form — answer in your own words, in whatever language you're comfortable in, and skip anything you'd rather not say.",
      "",
      "If you already have flight confirmations, hotel bookings, tickets or a plan you wrote, send them here. I'll read them and use them, so I don't ask you for what you already have written down. Everything you send stays with your trip — ask me for any of it later here in the chat, or find it on the trip site.",
      "",
      "At the end you get two things: a private trip website for everyone coming, and an assistant of your own. You can add it to the family group chat, and during the trip it answers questions, keeps the plan, and remembers what everyone booked.",
      "",
      "So — send me anything you've got, or just say the word and I'll start asking.",
    ].join("\n"),
    // Said when the interviewer has gone quiet and the router picks the thread
    // back up. Deliberately says nothing about why: the organizer does not need
    // to hear that something stalled, and "sorry, I had a problem" invites them
    // to wonder whether their answers survived. It reads as one person
    // gathering the thread again, because from their side it is.
    resumed: "Let's pick this back up.",
    // Said when the organizer wrote something that did not answer the question
    // still on screen. It has to exist because "never send the same message
    // twice" would otherwise make the router silent at exactly the moment the
    // organizer is waiting for it — they spoke, and got nothing back. Like
    // `resumed`, it says nothing about fault: not answering a question is a
    // normal thing to do in a conversation, usually because you were asking
    // about something else.
    // Said once, at the boundary, for a required answer the interview cannot
    // finish without — not every time a message misses it. The difference
    // between this and nagging is entirely about when it is said.
    beforeWeFinish: "Before I can put your trip together, there's one thing I still need:",
    // Said after an OPEN answer — something typed, not tapped. A button press
    // is its own confirmation: the keyboard disappears and the next question
    // arrives, so acknowledging it as well is noise. Typing a list of names
    // into a chat window and getting only the next question back is the part
    // that feels unheard.
    //
    // Deliberately small. It exists to show the answer was understood, which
    // is why the understood VALUE is echoed with it — warmth without the value
    // would be flattery, and the value without warmth is a receipt.
    // THE LAST THING THE ORGANIZER READS from this interview, so it should not
    // be the only untranslated, most technical sentence in it. It was: "That's
    // locked in — version 1 of your trip plan", in English, at the end of a
    // Hebrew conversation. "Version 1" is our vocabulary, not theirs.
    //
    // What they actually want to know is what happens next and who will be in
    // touch, so it says both — and names the assistant they just named, which
    // is the moment that choice first means something.
    // On the recap, so "confirm" is an informed decision rather than a button.
    confirmMeans: "Confirming starts the build: your trip site, and your assistant.",
    intakeConfirmed: "That's everything — thank you. I'm building your trip site now, which takes a little while. When it's ready, {name} will message you right here with the link.",
    /** When they never gave the assistant a name. */
    intakeConfirmedNoName: "That's everything — thank you. I'm building your trip site now, which takes a little while. I'll message you right here with the link when it's ready.",
    gotIt: "Got it",
    gotItMore: "Got it — here's what I have:",
    // Said the moment a file lands, and it sets an expectation this code now
    // has to keep: it says reading takes a moment, and reading really does
    // take about a minute and a half. Shipping this line before anything read
    // anything would have been the worst message in the interview — a promise
    // the next question immediately contradicts.
    documentReading: "Got it — I'm reading it now. This takes a minute; I'll tell you what I found and then only ask for what's missing.",
    // What it took from the document, before anything is treated as settled.
    // The organizer has to be able to correct it: an answer they did not give
    // and cannot see is the one thing worse than being asked again.
    documentRead: "Here's what I took from it:",
    // Bridges INTO the next question instead of stopping in front of it.
    // "Check this" followed immediately by a new question reads as two
    // competing demands; saying we are carrying on makes the question that
    // follows the intended next step rather than an interruption of the review.
    documentCorrect: "If any of that is wrong just tell me and I'll fix it — no rush, later is fine too. Meanwhile, carrying on:",
    /** Places the document means to visit but has not booked. */
    documentPlanned: "Places from the document",
    documentNothing: "I read it, but I couldn't find anything about the trip in it. No harm — I'll just ask.",
    // NOT the same as finding nothing, and it took a live run to see why that
    // matters: the organizer sent a booking PDF full of dates and hotels and
    // was told there was nothing about the trip in it. There was. The reading
    // worked and the step after it failed, and telling them otherwise makes
    // the bot look like it cannot read while quietly blaming their file.
    documentExtractFailed: "I read it, but I couldn't make sense of it just now — that's on me, not the file. I'll ask instead, and you can send it again later if you like.",
    documentUnreadable: "I couldn't read that one — it may be a scan or a photo rather than a text document. Send a different file if you have one, or we can carry on and I'll ask instead.",
    // Said instead of reading a passport. It has to explain rather than just
    // refuse: someone who sent it was being helpful, and being told "no" with
    // no reason by a bot holding their other documents is unsettling.
    documentIdentity: "That looks like a passport or ID — I've left it unread. I don't need identity documents to set up the trip, so there's no reason for me to hold one. Booking confirmations, tickets and plans are the useful ones.",
    // The three messages of an interview that can end.
    //
    // All three exist to answer the question someone actually has, which is
    // never "what is the session state" but "did I lose my answers". So all
    // three say no, in the first or second line, before anything else.
    expiringSoon:
      "I'll close this conversation in about 10 minutes if I don't hear from you — nothing is lost, everything you've told me is saved. Send anything to keep going.",
    // Never on its own: both of these are a LEAD, and what the interview is
    // actually waiting for is re-sent underneath, buttons and all. "I didn't
    // understand" by itself tells someone they failed without telling them
    // what would succeed.
    didNotFollow: "Sorry — I didn't quite follow that. Here's what I'm waiting for:",
    stillWaitingBeforeExpiry:
      "I'll close this conversation in about 10 minutes if I don't hear from you — nothing is lost, everything you've told me is saved. This is what I'm still waiting for:",
    // "Saved and waiting" was a promise the system does not keep: the answers
    // ARE saved, but coming back needs a fresh interview link, and "waiting"
    // reads as "just write when you're ready". Someone who believed it would
    // return, write, and be told to go and find a link — the worst moment to
    // learn it.
    expired:
      "I've closed our conversation for now — everything you told me is saved, nothing is lost. To pick it back up you'll need a fresh interview link; ask whoever set the trip up and we'll carry on from where we stopped.",
    // Said when someone writes into a closed interview. It has to point at the
    // one thing that can reopen it, and name it the way they met it: this
    // conversation began by opening a link, so that is what "start again"
    // means. Vaguer wording ("please start a new session") leaves them looking
    // for a button that does not exist.
    expiredWriteAfter:
      "This conversation has closed, so I can't add that to your trip. Opening a fresh interview link will pick things up again — the same kind of link that started us off. Ask whoever set your trip up for a new one, and everything you've already told me will still be there.",
  },
  he: {
    skip: "⤼ דלג על זו",
    finish: "🏁 סיים",
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
    essentialsDone: "זה כל מה שבאמת צריך — מכאן זה רשות. עוד כמה שאלות יעזרו לי להתאים את העוזר לקבוצה: איך אתם אוהבים לטייל, מה אוכלים, על מי לשים לב. תענו על כמה שבא לכם, ותלחצו סיים מתי שתרצו.",
    askMore: "➕ עוד כמה שאלות",
    documentOffer: "לפני שנתחיל בפרטים — אם כבר יש לכם תוכנית, אישור הזמנה, כרטיסים או גיליון לטיול, שלחו אותו לכאן ואני אקרא אותו במקום שתקלידו הכל.",
    noDocument: "אין לי מסמך",
    introduction: [
      "היי — אני העוזר שמקים לכם את הטיול. שיחה אחת, וזהו.",
      "",
      "אשאל אתכם על הטיול: לאן, מתי, מי מגיע ואיך אתם אוהבים לטייל. זה לא טופס — ענו במילים שלכם, בכל שפה שנוח לכם, ואם משהו לא מתאים פשוט דלגו.",
      "",
      "אם כבר יש לכם אישורי טיסה, הזמנות מלון, כרטיסים או תוכנית שכתבתם — שלחו לכאן. אקרא ואשתמש בזה, כדי לא לשאול אתכם על מה שכבר כתוב אצלכם. כל מה שתשלחו נשמר עם הטיול — תוכלו לבקש ממני כל דבר מזה גם אחר כך כאן בצ'אט, או למצוא אותו באתר הטיול.",
      "",
      "בסוף מקבלים שני דברים: אתר טיול פרטי לכל מי שנוסע, ועוזר אישי משלכם. אפשר להוסיף אותו לקבוצה המשפחתית, ובמהלך הטיול הוא עונה על שאלות, מחזיק את התוכנית וזוכר מה כל אחד הזמין.",
      "",
      "אז — שלחו לי כל מה שיש לכם, או תגידו ונתחיל בשאלות.",
    ].join("\n"),
    resumed: "נמשיך מכאן.",
    beforeWeFinish: "לפני שאוכל להרכיב לכם את הטיול, נשאר דבר אחד שאני צריך:",
    confirmMeans: "אישור מתחיל את ההקמה: אתר הטיול שלכם, והעוזר.",
    intakeConfirmed: "זהו, יש לי הכול — תודה. אני מקים לכם עכשיו את אתר הטיול, וזה לוקח קצת זמן. כשיהיה מוכן, {name} יכתוב לכם לכאן עם הקישור.",
    intakeConfirmedNoName: "זהו, יש לי הכול — תודה. אני מקים לכם עכשיו את אתר הטיול, וזה לוקח קצת זמן. כשיהיה מוכן אשלח לכם לכאן את הקישור.",
    gotIt: "יופי, רשמתי",
    gotItMore: "יופי — הנה מה שרשמתי:",
    documentReading: "קיבלתי — אני קורא את זה עכשיו. זה לוקח דקה; אחר כך אספר לכם מה מצאתי ואשאל רק על מה שחסר.",
    documentRead: "הנה מה שלקחתי מהמסמך:",
    documentCorrect: "אם משהו מזה לא נכון פשוט תגידו לי ואתקן — אין לחץ, גם אחר כך אפשר. בינתיים נמשיך:",
    documentPlanned: "מקומות מהמסמך",
    documentNothing: "קראתי, אבל לא מצאתי שם מידע על הטיול. לא נורא — פשוט אשאל.",
    documentExtractFailed: "קראתי, אבל לא הצלחתי להבין את זה כרגע — זה עליי, לא על הקובץ. אשאל במקום, ואפשר לשלוח שוב מאוחר יותר.",
    documentUnreadable: "לא הצלחתי לקרוא את הקובץ — יכול להיות שזו סריקה או תמונה ולא מסמך טקסט. אפשר לשלוח קובץ אחר אם יש, או שנמשיך ואשאל במקום.",
    documentIdentity: "זה נראה כמו דרכון או תעודת זהות — לא קראתי אותו. אני לא צריך מסמכי זיהוי כדי להקים את הטיול, אז אין סיבה שאחזיק אחד כזה. אישורי הזמנה, כרטיסים ותוכניות — אלה המועילים.",
    expiringSoon:
      "אם לא אשמע מכם, אסגור את השיחה בעוד כ-10 דקות — שום דבר לא הולך לאיבוד, כל מה שסיפרתם שמור. שלחו משהו ונמשיך.",
    didNotFollow: "סליחה — לא הבנתי בדיוק. הנה מה שאני מחכה לו:",
    stillWaitingBeforeExpiry:
      "אם לא אשמע מכם, אסגור את השיחה בעוד כ-10 דקות — שום דבר לא הולך לאיבוד, כל מה שסיפרתם שמור. זה מה שאני עדיין מחכה לו:",
    expired: "סגרתי את השיחה בינתיים — כל מה שסיפרתם שמור, שום דבר לא הלך לאיבוד. כדי להמשיך צריך קישור ראיון חדש; בקשו ממי שהקים לכם את הטיול ונמשיך בדיוק מאיפה שעצרנו.",
    expiredWriteAfter:
      "השיחה הזו נסגרה, אז אני לא יכול להוסיף את זה לטיול. קישור הפעלה חדש לראיון יחזיר אותנו לאן שהיינו — אותו סוג קישור שפתח לנו את השיחה. בקשו קישור חדש ממי שהקים לכם את הטיול, וכל מה שכבר סיפרתם עדיין יהיה שם.",
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
