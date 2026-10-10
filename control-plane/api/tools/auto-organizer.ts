/**
 * Plays the organizer through a real interview — the one step of the full
 * cycle that used to need a person on Telegram.
 *
 *   node --import tsx tools/auto-organizer.ts --scenario japan --token <enrollment token> \
 *     --chat 9000000000001 --telegram http://127.0.0.1:4399 [--docs <dir of the scenario's documents>]
 *
 * It talks to the relay exactly as a person does — through Telegram, here the
 * stand-in in tools/fake-telegram.ts: it sends /start with the deep-link token,
 * uploads the scenario's documents, types answers, taps buttons, and confirms.
 * Nothing is written behind the relay's back.
 *
 * To decide WHAT to answer it reads the session the way the router does
 * (getSessionForChat), over a connection opened READ ONLY — so a slip here
 * cannot write to the live control plane even by accident. Which question is on
 * screen is a fact the router already knows; re-deriving it from message text
 * would test this script, not the product.
 *
 * Exits 0 once the intake is confirmed (which is what starts the build), non-zero
 * with the transcript and the session as it stood when anything stalls.
 */
import { readFile, readdir, writeFile } from "node:fs/promises";
import { extname, join } from "node:path";
import pg from "pg";
import { getSessionForChat, type IntakeQuestion, type SessionView } from "../src/interview.js";
import { suggestionTapData } from "./organizer-suggestions.js";
import {
  CHAOS_LATE_CORRECTIONS,
  MAX_TRIES_PER_QUESTION,
  chaosMove,
  judgeIntake,
  replyInOtherLanguage,
  writtenLanguage,
  type ChaosCheck,
  type ChaosMove,
} from "./organizer-chaos.js";

const arg = (name: string, fallback = "") => {
  const i = process.argv.indexOf(`--${name}`);
  return i > 0 ? process.argv[i + 1] ?? fallback : fallback;
};
const scenarioName = arg("scenario");
const token = arg("token");
const chatId = arg("chat", "9000000000001");
const telegram = arg("telegram", "http://127.0.0.1:4399").replace(/\/+$/, "");
const docsDir = arg("docs");
/** The organizer who does not follow — see tools/organizer-chaos.ts. */
const chaos = scenarioName === "chaos";
// A chaos run reads documents in the middle of other questions and gets
// re-asked on purpose, so each turn and the whole run get more time.
const turnSeconds = Number(arg("turn-seconds", chaos ? "480" : "240"));
const totalMinutes = Number(arg("minutes", chaos ? "60" : "30"));
const reportPath = arg("report");
const databaseUrl = process.env.CONTROL_PLANE_DATABASE_URL;

// ── The scenarios: what this organizer says, by question ─────────────────────
// Consistent with control-plane/api/test/fixtures/make_documents.py, whose
// facts the full cycle checks on the finished site. A document scenario still
// scripts the answers its documents carry, in case the router asks anyway —
// being asked twice is a finding the transcript shows, not a stuck run.

interface Scenario {
  language: "he" | "en";
  documents: boolean;
  text: Record<string, string>;
  choice: Record<string, string>;
  multi: Record<string, string[]>;
}

const SCENARIOS: Record<string, Scenario> = {
  japan: {
    language: "he",
    documents: true,
    text: {
      destination: "יפן — טוקיו, האקונה, קיוטו ואוסקה",
      departure_date: "19 בספטמבר 2026",
      return_date: "3 באוקטובר 2026",
      travelers: "דרור אלול, שירן אלול, נועם אלול, יעל אלול ומשה אלול",
      phases: "טוקיו 19-23 בספטמבר, האקונה 23-24, קיוטו 24-27, אוסקה 27-30, ואז חזרה לטוקיו עד ה-3 באוקטובר",
      bot_name: "יומי",
      trip_interests: "אוכל, מקדשים וטיולים רגליים",
      organizer_identity: "דרור, אבא של המשפחה",
    },
    choice: { trip_type: "family", bot_gender: "male", bot_tone: "warm", trip_pace: "balanced" },
    multi: { dietary: ["kosher_style"] },
  },
  multi: {
    language: "en",
    documents: true,
    text: {
      destination: "Italy",
      departure_date: "May 2, 2026",
      return_date: "May 12, 2026",
      travelers: "Dana Levi, Omri Levi and Yael Levi",
      phases: "Rome May 2-6, Florence May 6-9, Venice May 9-12",
      bot_name: "Luca",
      organizer_identity: "Dana",
    },
    choice: { trip_type: "family", bot_gender: "male", bot_tone: "playful", trip_pace: "balanced" },
    multi: { dietary: ["vegetarian", "lactose_free"] },
  },
  // The chaos organizer's PROPER answers: what it says after each question's
  // misbehaviour (tools/organizer-chaos.ts). Consistent with make_documents.py
  // "chaos", whose documents it uploads out of place rather than at the start.
  chaos: {
    language: "he",
    documents: false,
    text: {
      destination: "יוון — אתונה, נקסוס וסנטוריני",
      departure_date: "12 ביולי 2027",
      return_date: "July 26, 2027",
      travelers: "אבי כהן 46, רונית כהן 44, תמר כהן 15, יואב כהן 12 ומיכל כהן 9",
      phases: "Athens July 12-16, Naxos July 16-21, Santorini July 21-26",
      bot_name: "הרמס / Hermes",
      trip_interests: "חופים, עתיקות וגלידה",
      organizer_identity: "רונית",
      dietary_scope: "הצמחונות לכולם, והאלרגיה לאגוזים רק ליואב",
    },
    choice: { trip_type: "family", bot_gender: "female", bot_tone: "playful", trip_pace: "balanced", dietary_visibility: "group" },
    multi: { dietary: ["vegetarian", "nut_allergy"] },
  },
  // Scenario 5 — Dror's own baseline run, 2026-09-20, replayed verbatim.
  //
  // The others all describe a trip that is ALREADY DECIDED: every phase has a
  // city and a pair of dates, so the interview only has to write down what it
  // is told. This one does not, and that is the whole reason it exists. Half
  // the trip is planned and half is explicitly open, the organizer says so in
  // as many words and asks for a proposal, and one dietary need belongs to one
  // traveller and not the rest.
  //
  // Answers are the ones that actually reached `intake_sessions.answers` on
  // that run, in the phrasings that produced them — `timezone` included. It
  // reads "Vietnam", which is not a timezone, because that is what an organizer
  // typed when asked; the fixture keeps it so the SITE is what has to end up
  // with a real zone. Normalising it here would test the fixture instead.
  vietnam: {
    language: "he",
    documents: false,
    text: {
      destination: "וייטנאם",
      // The phrasing the organizer actually gave, and the one that was stored.
      //
      // Their first answer was "בתחילת מרץ" — early March — and the exact date
      // came only when the interview asked again. A scenario answers each
      // question once, so it cannot replay a two-turn exchange; and the vague
      // form is not a gate-worthy input anyway. It was tried: one run resolved
      // it to 2028-03-01 (wrong — the trip starts on the 5th) and the next
      // returned `unclear`, on identical input. A required field whose value
      // depends on model whim cannot decide whether a build is green.
      //
      // Loose date PARSING belongs in a test that asserts parsing. What this
      // scenario still carries is the other real shape: a return date written
      // in English in the middle of a Hebrew interview.
      departure_date: "5.3.28",
      return_date: "until March 20",
      travelers: "דרור אלול, שירן אלול, נועם אלול, יעל אלול ומשה אלול",
      // SIX of sixteen days. The rest is the next answer's problem, on purpose.
      // The flights and the show are in the run's own travel_anchors, so the
      // organizer gave them; which turn they were typed in is not recorded, so
      // they ride with the phases answer here. Note the return leg departs
      // SAIGON — the trip's own anchors prove a city no phase covers.
      phases:
        "האנוי 5-9 במרץ, ואז הא לונג 9-11 במרץ. " +
        "טיסה VN572 מתל אביב להאנוי ב-5 במרץ ב-06:40, " +
        "וחזרה VN571 מסייגון לתל אביב ב-20 במרץ ב-23:15. " +
        "הזמנתי הצגה בתיאטרון בובות המים תאנג לונג ב-6 במרץ ב-18:00.",
      planning_help: "עשרה ימים בהוי אן וסייגון - לא הוחלט איך לחלק, מבקש הצעת חלוקה",
      bot_name: "פאם",
      organizer_identity: "דרור אלול",
      dietary_scope: "רק נועם צמחוני",
      timezone: "Vietnam",
    },
    choice: {
      trip_type: "family",
      bot_gender: "female",
      bot_tone: "warm",
      trip_pace: "balanced",
      dietary_visibility: "group",
    },
    multi: { dietary: ["vegetarian"], bot_proactive: ["morning_briefing"] },
  },
  manual: {
    language: "en",
    documents: false,
    text: {
      destination: "Portugal — Lisbon and Porto",
      departure_date: "June 10, 2026",
      return_date: "June 18, 2026",
      // First person on purpose: "me" next to a name is how organizer_identity
      // should be learned without being asked. The japan script lists the
      // family in the third person, so between them both paths run.
      travelers: "Me — Noa Cohen, 45 — my husband Avi Cohen, 47, and our kids Tamar, 12, and Eitan, 9",
      phases: "Lisbon from June 10 to June 14, then Porto from June 14 to June 18",
      bot_name: "Sol",
      trip_interests: "food, tiles and old neighbourhoods, one beach day",
      organizer_identity: "Noa, the mom",
    },
    choice: { trip_type: "family", bot_gender: "female", bot_tone: "warm", trip_pace: "easygoing" },
    multi: { dietary: ["none"] },
  },
};

// ── Plumbing ─────────────────────────────────────────────────────────────────

interface SentMessage { seq: number; kind: string; messageId: number; text: string; buttons: { text: string; data: string }[] }

let seenSeq = 0;
/** The language of the organizer's last clearly-worded message — what the interview should now speak. */
let lastWritten: "he" | "en" | null = null;
const otherLanguageReplies: string[] = [];
const transcript: string[] = [];
const say = (line: string) => { transcript.push(line); console.log(line); };

async function control(path: string, body?: unknown): Promise<Record<string, unknown>> {
  const res = await fetch(`${telegram}/_control/${path}`, body === undefined ? {} : {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body),
  });
  const json = (await res.json()) as { ok: boolean; result?: Record<string, unknown>; description?: string };
  if (!json.ok) throw new Error(`fake telegram ${path}: ${json.description}`);
  return json.result ?? {};
}

async function botMessages(): Promise<SentMessage[]> {
  const r = await control(`sent?chatId=${chatId}`);
  return r.messages as SentMessage[];
}

/** Everything the bot said since last time, echoed into the transcript. */
async function drain(): Promise<SentMessage[]> {
  const all = await botMessages();
  const fresh = all.filter((m) => m.seq > seenSeq);
  for (const m of fresh) {
    if (m.kind === "send" && lastWritten && replyInOtherLanguage(lastWritten, m.text)) {
      otherLanguageReplies.push(`after writing ${lastWritten}: ${m.text.replace(/\n/g, " ").slice(0, 120)}`);
    }
    const buttons = m.buttons.length ? `  [${m.buttons.map((b) => `${b.text}=${b.data}`).join(" | ")}]` : "";
    say(`  BOT${m.kind === "edit" ? " (edit)" : ""}: ${m.text.replace(/\n/g, " ⏎ ").slice(0, 400)}${buttons}`);
    seenSeq = Math.max(seenSeq, m.seq);
  }
  return all;
}

/** The message currently carrying a button with this callback data, if any. */
async function messageWith(data: string): Promise<number | null> {
  const all = await botMessages();
  for (let i = all.length - 1; i >= 0; i -= 1) {
    if (all[i]!.buttons.some((b) => b.data === data)) return all[i]!.messageId;
  }
  return null;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const pool = new pg.Pool({
  connectionString: databaseUrl,
  // Read only, enforced by the server: this is an oracle, never a writer.
  options: "-c default_transaction_read_only=on",
  max: 2,
});

let sessionId: string | null = null;

async function view(): Promise<SessionView | null> {
  const r = await getSessionForChat(pool, chatId);
  if (r.ok) sessionId = r.view.sessionId;
  return r.ok ? r.view : null;
}

/**
 * A CONFIRMED session is no longer the chat's active one, so `view()` returns
 * nothing once confirm lands — which the first automated run read as "the
 * session vanished" and reported a stall on a run that had in fact built the
 * trip. The session's own row says what happened.
 */
async function confirmed(): Promise<boolean> {
  if (!sessionId) return false;
  const r = await pool.query("SELECT state FROM control_plane.intake_sessions WHERE id = $1", [sessionId]);
  return r.rows[0]?.state === "confirmed";
}

function fingerprint(v: SessionView | null): string {
  if (!v) return "none";
  // `lastPrompt` is what the router last put on screen — the surest sign the
  // screen changed, even when no answer did (declining the document offer).
  return JSON.stringify([v.state, v.phase, v.awaiting, v.nextQuestion?.id, v.pendingAsk?.id,
    v.optionalRemaining.length, v.offeredMore, v.selections, v.recap?.length ?? 0, v.lastPrompt]);
}

class Stalled extends Error {}

/** Waits until the relay has taken our input AND the session has moved on. */
async function settle(before: string, what: string, repliedSince?: number): Promise<SessionView | null> {
  const deadline = Date.now() + turnSeconds * 1000;
  let v: SessionView | null = null;
  while (Date.now() < deadline) {
    await sleep(1500);
    await drain();
    const queued = Number((await control("health")).updatesQueued ?? 0);
    v = await view();
    if (queued === 0 && !v && (await confirmed())) return null;
    // A misbehaving organizer is often answered with the SAME question again,
    // which changes nothing on the session — so after chaos a reply is progress.
    // Only silence is a stall.
    const replied = repliedSince !== undefined && seenSeq > repliedSince;
    if (queued === 0 && v && v.awaiting !== "machine" && (fingerprint(v) !== before || replied)) {
      await sleep(1000); // let a follow-up message land before reading the screen
      await drain();
      return await view();
    }
  }
  throw new Stalled(`${repliedSince !== undefined ? "silence" : "no progress"} within ${turnSeconds}s after ${what} (session: ${fingerprint(v)})`);
}

async function tap(data: string): Promise<boolean> {
  const messageId = await messageWith(data);
  if (messageId === null) return false;
  say(`  YOU tap: ${data}`);
  await control("tap", { chatId, messageId, data });
  return true;
}

async function type(text: string, languageCode: string): Promise<void> {
  say(`  YOU: ${text}`);
  lastWritten = writtenLanguage(text) ?? lastWritten;
  await control("message", { chatId, text, languageCode });
}

const MIME: Record<string, string> = {
  ".pdf": "application/pdf",
  ".docx": "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  ".xlsx": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  ".md": "text/markdown",
  ".txt": "text/plain",
};

// ── The organizer ────────────────────────────────────────────────────────────

/** What the phone says its language is. The chaos organizer's is English whatever it writes (2026-09-15). */
let phoneLanguage = "en";
const tries = new Map<string, number>();
const movesRun: string[] = [];

/** One misbehaviour, and whatever the interview says back to it. */
async function perform(move: ChaosMove, where: string, before: string): Promise<void> {
  const since = seenSeq;
  say(`  CHAOS (${where}): ${move.why}`);
  if (move.kind === "type") {
    await type(move.text, phoneLanguage);
  } else if (move.kind === "tap") {
    if (!(await tap(move.data))) {
      say(`  (no ${move.data} button anywhere to tap — skipped)`);
      return;
    }
  } else {
    say(`  YOU send file: ${move.file}`);
    await control("document", {
      chatId, filename: move.file, mime: MIME[extname(move.file).toLowerCase()] ?? "application/octet-stream",
      base64: (await readFile(join(docsDir, move.file))).toString("base64"), languageCode: phoneLanguage,
    });
  }
  movesRun.push(`${where}: ${move.why}`);
  await settle(before, `chaos on ${where} (${move.why})`, since);
}

/** An optional question the router walked to on its own, read off what it last put on screen. */
function onScreen(v: SessionView): IntakeQuestion | null {
  if (v.state !== "interviewing" || !v.lastPrompt?.startsWith("q:")) return null;
  const id = v.lastPrompt.slice(2).split(":")[0];
  return v.optionalRemaining.find((q) => q.id === id) ?? null;
}

const asked = new Set<string>();
/** How many times each question was found on screen without its buttons yet. */
const waitedFor = new Map<string, number>();
const BUTTON_PATIENCE = 30; // × ~2s: a rendered question has its buttons long before this

/**
 * Answers the question on screen. `false` means "not answerable YET" — its
 * message and buttons have not arrived — and the caller waits and asks again.
 * The 2026-09-11 run treated a button that had simply not been sent yet as a
 * missing answer and stalled the manual scenario at its very first question.
 */
async function answer(q: IntakeQuestion, s: Scenario, suggestions: SessionView["suggestions"]): Promise<boolean> {
  const notYet = () => {
    const n = (waitedFor.get(q.id) ?? 0) + 1;
    waitedFor.set(q.id, n);
    if (n > BUTTON_PATIENCE) throw new Stalled(`${q.id} is the next question but its buttons never arrived`);
    return false;
  };
  // An unsure reading from a document becomes a Yes/No suggestion rather than
  // an outright accept (2026-09-13) — see organizer-suggestions.ts.
  const suggested = suggestionTapData(q, suggestions);
  if (suggested) {
    if (!(await tap(suggested))) return notYet();
    asked.add(q.id);
    return true;
  }
  if (q.type === "choice") {
    const option = s.choice[q.id] ?? q.options?.[0]?.id;
    if (!option) throw new Stalled(`${q.id} has no options to choose from`);
    if (!(await tap(`a:${q.id}:${option}`))) return notYet();
  } else if (q.type === "multi_choice") {
    const picks = s.multi[q.id];
    if (!picks) {
      if (q.required) throw new Stalled(`the scenario has no answer for required question ${q.id}`);
      return (await tap(`k:${q.id}`)) || notYet();
    }
    if (!(await messageWith(`n:${q.id}`))) return notYet();
    for (const option of picks) {
      await tap(`t:${q.id}:${option}`);
      await sleep(2500);
      await drain();
    }
    await tap(`n:${q.id}`);
  } else {
    const text = s.text[q.id];
    // The roster as buttons: the chaos organizer taps its own name when offered.
    if (chaos && text) {
      const offered = (await botMessages()).flatMap((m) => m.buttons)
        .filter((b) => b.data.startsWith(`a:${q.id}:`) && b.text.includes(text));
      if (offered.length > 0 && (await tap(offered[offered.length - 1]!.data))) {
        asked.add(q.id);
        return true;
      }
    }
    if (!text) {
      // Nothing scripted: an optional question is skipped the way a person
      // would; a required one is a gap in this script, reported, not guessed.
      if (q.required) throw new Stalled(`the scenario has no answer for required question ${q.id} (${q.type})`);
      return (await tap(`k:${q.id}`)) || notYet();
    }
    await type(text, phoneLanguage);
  }
  asked.add(q.id);
  return true;
}

async function main(): Promise<number> {
  const s = SCENARIOS[scenarioName];
  if (!s || !token || !databaseUrl) {
    console.error("usage: CONTROL_PLANE_DATABASE_URL=… auto-organizer.ts --scenario japan|multi|manual|chaos --token T [--docs DIR] [--report FILE]");
    return 2;
  }
  const deadline = Date.now() + totalMinutes * 60_000;
  const lateCorrectionsSent = new Set<string>();
  let walkedOptional = false;
  say(`== organizer: ${scenarioName} (${s.language}) as chat ${chatId}`);
  phoneLanguage = chaos ? "en" : s.language;

  await type(`/start ${token}`, phoneLanguage);
  let v = await settle("none", "/start");
  if (!v) throw new Stalled("/start did not open a session");

  if (s.documents) {
    const files = (await readdir(docsDir)).filter((f) => !f.startsWith(".")).sort();
    const before = fingerprint(v);
    for (const f of files) {
      say(`  YOU send file: ${f}`);
      await control("document", {
        chatId, filename: f, mime: MIME[extname(f).toLowerCase()] ?? "application/octet-stream",
        base64: (await readFile(join(docsDir, f))).toString("base64"), languageCode: phoneLanguage,
      });
    }
    v = await settle(before, `${files.length} document(s)`);
  } else {
    for (let n = 0; chaos && chaosMove("opening", n); n += 1) {
      await perform(chaosMove("opening", n)!, "opening", fingerprint(await view()));
    }
    const before = fingerprint(await view());
    if (!(await tap("c:nodoc"))) throw new Stalled("no document offer to decline");
    // Wait for the first question to arrive, as a person would, before reading
    // the screen — the manual scenario tapped for trip_type before it was sent.
    v = await settle(before, "declining the document offer");
  }

  for (let turn = 0; Date.now() < deadline; turn += 1) {
    v = await view();
    if (!v) {
      if (await confirmed()) break;
      throw new Stalled("the session disappeared without being confirmed");
    }
    if (v.state === "confirmed") break;
    const before = fingerprint(v);

    if (v.state === "awaiting_confirmation") {
      if (!(await tap("c:confirm"))) { await sleep(2000); await drain(); continue; }
      await settle(before, "confirm");
      continue;
    }
    if (v.awaiting === "machine") { await sleep(2000); await drain(); continue; }

    const q = v.nextQuestion ?? v.pendingAsk ?? (chaos ? onScreen(v) : null);
    if (q) {
      if (chaos) {
        const n = tries.get(q.id) ?? 0;
        if (n >= MAX_TRIES_PER_QUESTION) throw new Stalled(`the interview did not recover on ${q.id} after ${n} tries`);
        tries.set(q.id, n + 1);
        const move = chaosMove(q.id, n);
        if (move) { await perform(move, q.id, before); continue; }
      }
      const since = seenSeq;
      if (!(await answer(q, s, v.suggestions))) {
        if (chaos) tries.set(q.id, Math.max(0, (tries.get(q.id) ?? 1) - 1)); // not answerable yet is not a try
        await sleep(2000);
        await drain();
        continue;
      }
      await settle(before, `answering ${q.id}`, chaos ? since : undefined);
      const late = CHAOS_LATE_CORRECTIONS.find((c) => c.after === q.id && !lateCorrectionsSent.has(c.after));
      if (chaos && late) {
        const now = await view();
        if (now && (now.nextQuestion ?? now.pendingAsk ?? onScreen(now))?.id !== q.id) {
          lateCorrectionsSent.add(late.after);
          await perform(late.move, `after ${q.id}`, fingerprint(now));
        }
      }
      continue;
    }
    // Required questions done and nothing nominated: the boundary message
    // offers "a few more" or "that's everything". The chaos organizer asks for
    // more once, so the optional questions — dietary, interests — get walked.
    if (chaos && !walkedOptional && (await tap("c:more"))) {
      walkedOptional = true;
      await settle(before, "asking for more questions", seenSeq);
      continue;
    }
    if (await tap("c:done")) { await settle(before, "finish"); continue; }
    await sleep(2000);
    await drain();
  }

  await drain();
  if (!(await confirmed())) throw new Stalled(`out of time before the intake was confirmed`);
  const unknown = (await control(`sent?chatId=${chatId}`)).unknownMethods as string[];
  // Which questions a person would actually have been asked — the rest came
  // from their documents or from something they had already said.
  say(`  asked: ${[...asked].join(", ")}`);
  if (!asked.has("organizer_identity")) say("  organizer_identity: inferred, not asked");
  console.log(JSON.stringify({ event: "organizer.confirmed", scenario: scenarioName, sessionId,
    asked: [...asked], unknownTelegramMethods: unknown }));
  if (!chaos) return 0;

  const intake = await pool.query(
    `SELECT v.data, v.language FROM control_plane.intake_versions v
       JOIN control_plane.intake_sessions s ON s.trip_id = v.trip_id
      WHERE s.id = $1 ORDER BY v.version DESC LIMIT 1`,
    [sessionId],
  );
  const row = intake.rows[0] as { data?: Record<string, never>; language?: string | null } | undefined;
  const verdict = judgeIntake(row?.data ?? {}, row?.language ?? null, lastWritten);
  const findings = [
    ...verdict.findings,
    ...[...tries].filter(([, n]) => n > 2).map(([id, n]) => `${id} took ${n} tries`),
    otherLanguageReplies.length === 0
      ? "every reply after a clearly-worded message came in that message's language"
      : `${otherLanguageReplies.length} replies came in the other language; first: ${otherLanguageReplies[0]}`,
    unknown.length ? `Telegram methods the stand-in does not model: ${unknown.join(", ")}` : "",
  ].filter(Boolean);
  await report(verdict.checks.every((c) => c.ok) ? "PASSED" : "FAILED", verdict.checks, findings);
  for (const c of verdict.checks) say(`  ${c.ok ? "✓" : "✗"} ${c.name} — ${c.detail}`);
  for (const f of findings) say(`  • ${f}`);
  return verdict.checks.every((c) => c.ok) ? 0 : 1;
}

/** The chaos run's record, kept pass or fail: whether it made sense is for a person to judge. */
async function report(result: string, checks: ChaosCheck[], findings: string[]): Promise<void> {
  if (!reportPath) return;
  const lines = [
    `# Chaos interview — ${new Date().toISOString()}`, "",
    `**Result: ${result}**`, "",
    "## Checks (these decide the result)", ...checks.map((c) => `- ${c.ok ? "✅" : "❌"} ${c.name} — ${c.detail}`), "",
    "## Findings (for a person to read)", ...findings.map((f) => `- ${f}`), "",
    "## Misbehaviour tried", ...movesRun.map((m) => `- ${m}`), "",
    "## Tries per question", ...[...tries].map(([id, n]) => `- ${id}: ${n}`), "",
    "## Transcript", "```", ...transcript, "```", "",
  ];
  await writeFile(reportPath, lines.join("\n"));
  console.log(`chaos report: ${reportPath}`);
}

main()
  .then(async (code) => { await pool.end(); process.exit(code); })
  .catch(async (error) => {
    await drain().catch(() => {});
    const v = await view().catch(() => null);
    console.error(`\nORGANIZER STALLED: ${error instanceof Error ? error.message : String(error)}`);
    console.error(`session: ${fingerprint(v)}`);
    if (chaos) {
      await report("FAILED — the interview did not recover", [{
        name: "the interview recovered and confirmed", ok: false,
        detail: error instanceof Error ? error.message : String(error),
      }], otherLanguageReplies.map((r) => `reply in the other language: ${r}`)).catch(() => {});
    }
    await pool.end();
    process.exit(1);
  });
