/**
 * Plays the organizer through a real interview — the one step of the full
 * cycle that used to need a person on Telegram.
 *
 *   node --import tsx tools/auto-organizer.ts --scenario japan --token <enrollment token> \
 *     --chat 9000000000001 --telegram http://127.0.0.1:4399 [--docs /tmp/kinerary-e2e-japan]
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
import { readFile, readdir } from "node:fs/promises";
import { extname, join } from "node:path";
import pg from "pg";
import { getSessionForChat, type IntakeQuestion, type SessionView } from "../src/interview.js";

const arg = (name: string, fallback = "") => {
  const i = process.argv.indexOf(`--${name}`);
  return i > 0 ? process.argv[i + 1] ?? fallback : fallback;
};
const scenarioName = arg("scenario");
const token = arg("token");
const chatId = arg("chat", "9000000000001");
const telegram = arg("telegram", "http://127.0.0.1:4399").replace(/\/+$/, "");
const docsDir = arg("docs");
const turnSeconds = Number(arg("turn-seconds", "240"));
const totalMinutes = Number(arg("minutes", "30"));
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
async function settle(before: string, what: string): Promise<SessionView | null> {
  const deadline = Date.now() + turnSeconds * 1000;
  let v: SessionView | null = null;
  while (Date.now() < deadline) {
    await sleep(1500);
    await drain();
    const queued = Number((await control("health")).updatesQueued ?? 0);
    v = await view();
    if (queued === 0 && !v && (await confirmed())) return null;
    if (queued === 0 && v && v.awaiting !== "machine" && fingerprint(v) !== before) {
      await sleep(1000); // let a follow-up message land before reading the screen
      await drain();
      return await view();
    }
  }
  throw new Stalled(`no progress within ${turnSeconds}s after ${what} (session: ${fingerprint(v)})`);
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
async function answer(q: IntakeQuestion, s: Scenario): Promise<boolean> {
  const notYet = () => {
    const n = (waitedFor.get(q.id) ?? 0) + 1;
    waitedFor.set(q.id, n);
    if (n > BUTTON_PATIENCE) throw new Stalled(`${q.id} is the next question but its buttons never arrived`);
    return false;
  };
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
    if (!text) {
      // Nothing scripted: an optional question is skipped the way a person
      // would; a required one is a gap in this script, reported, not guessed.
      if (q.required) throw new Stalled(`the scenario has no answer for required question ${q.id} (${q.type})`);
      return (await tap(`k:${q.id}`)) || notYet();
    }
    await type(text, s.language);
  }
  asked.add(q.id);
  return true;
}

async function main(): Promise<number> {
  const s = SCENARIOS[scenarioName];
  if (!s || !token || !databaseUrl) {
    console.error("usage: CONTROL_PLANE_DATABASE_URL=… auto-organizer.ts --scenario japan|multi|manual --token T [--docs DIR]");
    return 2;
  }
  const deadline = Date.now() + totalMinutes * 60_000;
  say(`== organizer: ${scenarioName} (${s.language}) as chat ${chatId}`);

  await type(`/start ${token}`, s.language);
  let v = await settle("none", "/start");
  if (!v) throw new Stalled("/start did not open a session");

  if (s.documents) {
    const files = (await readdir(docsDir)).filter((f) => !f.startsWith(".")).sort();
    const before = fingerprint(v);
    for (const f of files) {
      say(`  YOU send file: ${f}`);
      await control("document", {
        chatId, filename: f, mime: MIME[extname(f).toLowerCase()] ?? "application/octet-stream",
        base64: (await readFile(join(docsDir, f))).toString("base64"), languageCode: s.language,
      });
    }
    v = await settle(before, `${files.length} document(s)`);
  } else {
    const before = fingerprint(v);
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

    const q = v.nextQuestion ?? v.pendingAsk;
    if (q) {
      if (!(await answer(q, s))) { await sleep(2000); await drain(); continue; }
      await settle(before, `answering ${q.id}`);
      continue;
    }
    // Required questions done and nothing nominated: the boundary message
    // offers "a few more" or "that's everything" — finish.
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
  return 0;
}

main()
  .then(async (code) => { await pool.end(); process.exit(code); })
  .catch(async (error) => {
    await drain().catch(() => {});
    const v = await view().catch(() => null);
    console.error(`\nORGANIZER STALLED: ${error instanceof Error ? error.message : String(error)}`);
    console.error(`session: ${fingerprint(v)}`);
    await pool.end();
    process.exit(1);
  });
