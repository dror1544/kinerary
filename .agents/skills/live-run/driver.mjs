#!/usr/bin/env node
// .agents/skills/live-run/driver.mjs — drive the 🤖 steps of the live
// acceptance run in docs/setup-test-plan.md, and stop at every 🧍.
//
// That document already legends each step: 🤖 AI (a stand-in for a UI that
// does not exist yet — signup, plan, approve, correct), 🏭 PRODUCTION (a loop
// already running that we only wait on), and 🧍 HUMAN (tapping Approve in
// Telegram, holding the interview). The 🤖 steps are plain API calls and are
// the ones worth automating; the 🧍 steps genuinely need a person, so the
// driver prints what to do and exits, resumable with --from.
//
//   node driver.mjs --run <name> --email <e> --password <p> --trip "<name>"
//   node driver.mjs --run <name> --from 9        # resume after a human step
//   node driver.mjs --run <name> --smoke         # post-deploy reachability only
//   node driver.mjs --run <name> --status        # where this run stands
//
// State lives in .live-runs/<name>.json so a run survives the pauses.
import { mkdirSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const REPO = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const RUNS = join(REPO, ".live-runs");

const argv = process.argv.slice(2);
const flag = (n, d = undefined) => {
  const i = argv.indexOf(`--${n}`);
  return i === -1 ? d : (argv[i + 1]?.startsWith("--") ? true : argv[i + 1] ?? true);
};
const has = (n) => argv.includes(`--${n}`);

const API = flag("api", process.env.CONTROL_PLANE_URL || "http://127.0.0.1:8080");
const SITE = flag("site", process.env.TRIP_SITE_URL || "");
const runName = flag("run");
if (!runName) {
  console.error("usage: driver.mjs --run <name> [--email .. --password .. --trip ..] [--from N] [--smoke] [--status]");
  process.exit(2);
}

mkdirSync(RUNS, { recursive: true });
const statePath = join(RUNS, `${runName}.json`);
const state = existsSync(statePath) ? JSON.parse(readFileSync(statePath, "utf8")) : { run: runName, started: new Date().toISOString(), steps: {} };
const save = () => writeFileSync(statePath, JSON.stringify(state, null, 2) + "\n");

const C = { r: "\x1b[1;31m", g: "\x1b[1;32m", y: "\x1b[1;33m", b: "\x1b[1;34m", d: "\x1b[2m", x: "\x1b[0m" };
const say  = (m) => console.log(m);
const ok   = (m) => say(`${C.g}[ ok ]${C.x} ${m}`);
const info = (m) => say(`${C.b}[info]${C.x} ${m}`);
const warn = (m) => say(`${C.y}[warn]${C.x} ${m}`);
const die  = (m) => { say(`${C.r}[fail]${C.x} ${m}`); save(); process.exit(1); };

const record = (n, data) => { state.steps[n] = { at: new Date().toISOString(), ...data }; save(); };

// Auth is a base64url JSON header, not a bearer token — see
// control-plane/api/src/password-identity.ts resolveWebAuth().
// The password is deliberately never written to state: the state file lives in
// the repo directory, and a test credential on disk is still a credential on
// disk. Pass it per invocation, or export KINERARY_TEST_PASSWORD.
const password_ = () => flag("password") || process.env.KINERARY_TEST_PASSWORD || "";
const authHeader = () => {
  const email = state.email, password = password_();
  if (!email || !password) die("no credentials: pass --email once, and --password (or export KINERARY_TEST_PASSWORD) on every invocation");
  return { "x-portal-password-login": Buffer.from(JSON.stringify({ email, password })).toString("base64url") };
};

async function call(method, path, { body, auth = true } = {}) {
  const url = `${API}${path}`;
  const headers = { "content-type": "application/json", ...(auth ? authHeader() : {}) };
  let res, text;
  try {
    res = await fetch(url, { method, headers, body: body ? JSON.stringify(body) : undefined });
    text = await res.text();
  } catch (e) {
    die(`${method} ${path} — could not reach ${API}: ${e.message}\n       is the control-plane API up?`);
  }
  let json; try { json = JSON.parse(text); } catch { json = null; }
  say(`${C.d}    ${method} ${path} -> ${res.status} ${text.slice(0, 400)}${C.x}`);
  return { status: res.status, json, text };
}

// A 🧍 step: say exactly what the person must do, then stop.
function pause(step, title, lines) {
  say("");
  say(`${C.y}────────────────────────────────────────────────────────${C.x}`);
  say(`${C.y} 🧍 STEP ${step} — ${title}${C.x}`);
  say(`${C.y}────────────────────────────────────────────────────────${C.x}`);
  for (const l of lines) say(`   ${l}`);
  say("");
  say(`   When that is done, resume with:`);
  say(`     node ${"$(git rev-parse --show-toplevel)"}/.agents/skills/live-run/driver.mjs --run ${runName} --from ${step + 1}`);
  say("");
  record(step, { kind: "human", state: "awaiting" });
  process.exit(0);
}

const poll = async (label, fn, { tries = 60, every = 5000 } = {}) => {
  for (let i = 1; i <= tries; i++) {
    const r = await fn();
    if (r.done) return r;
    info(`${label}: ${r.note ?? "waiting"} (${i}/${tries})`);
    await new Promise((r2) => setTimeout(r2, every));
  }
  die(`${label}: gave up after ${tries} polls`);
};

// ── steps ────────────────────────────────────────────────────────────────────
const steps = {
  4: { kind: "ai", title: "POST /v1/signup (stand-in for the landing-SPA form)", async run() {
    const r = await call("POST", "/v1/signup", { auth: false, body: {
      password: { email: state.email, password: password_() },
      trip_name_request: state.trip,
    }});
    if (r.status !== 200) die(`signup returned ${r.status}`);
    record(4, { kind: "ai", status: r.status, body: r.json });
    ok(`signup accepted: ${JSON.stringify(r.json)}`);
  }},

  6: { kind: "human", async run() {
    pause(6, "Approve the signup in Telegram", [
      "The outbox dispatcher has sent a DM from the Kinerary bot with",
      "Approve / Reject buttons. Tap Approve on your phone, for real.",
      "",
      "The API's long-polling loop (telegram-poller.ts, getUpdates every 3s)",
      "picks the tap up on its next poll — no public URL is involved.",
    ]);
  }},

  7: { kind: "ai", title: "confirm the approval landed", async run() {
    const r = await poll("signup status", async () => {
      const s = await call("GET", "/v1/signup/status");
      const st = s.json?.status;
      if (st && st !== "pending") return { done: true, st, body: s.json };
      return { done: false, note: `status=${st ?? "?"}` };
    });
    if (!/approved|active|ready/i.test(String(r.st))) die(`signup ended in status '${r.st}', not approved`);
    state.tripId = r.body?.trip_id ?? r.body?.tripId ?? state.tripId;
    record(7, { kind: "ai", status: r.st, tripId: state.tripId });
    ok(`signup ${r.st}${state.tripId ? `, trip ${state.tripId}` : ""}`);
  }},

  8: { kind: "human", async run() {
    pause(8, "Hold the interview on Telegram", [
      "Talk to the trip-intake interviewer and complete the interview,",
      "ending with CONFIRM. This is the real interviewer profile.",
      "",
      "Note what goes wrong as you go — the run-capture agent turns those",
      "notes into ledger rows afterwards.",
    ]);
  }},

  9: { kind: "ai", title: "POST plan, then approve it", async run() {
    if (!state.tripId) die("no trip id in state; re-run step 7, or pass --trip-id");
    const p = await call("POST", `/v1/trips/${state.tripId}/plan`, { body: {} });
    if (p.status !== 200 && p.status !== 201) die(`plan returned ${p.status}`);
    const planId = p.json?.plan_id ?? p.json?.planId ?? p.json?.id;
    if (!planId) die(`no plan id in response: ${p.text.slice(0, 200)}`);
    state.planId = planId; save();

    warn("approving a plan is a real decision — this driver places the call because you started it");
    const a = await call("POST", `/v1/plans/${planId}/approve`, { body: {} });
    if (a.status !== 200 && a.status !== 201) die(`approve returned ${a.status}`);
    record(9, { kind: "ai", planId, approve: a.status });
    ok(`plan ${planId} approved`);
  }},

  10: { kind: "wait", title: "wait for the worker to provision (🏭, already running)", async run() {
    const r = await poll("provisioning", async () => {
      const t = await call("GET", `/v1/trips/${state.tripId}`);
      const st = t.json?.status ?? t.json?.lifecycle_state;
      if (st && /ready|active|failed|error/i.test(String(st))) return { done: true, st, body: t.json };
      return { done: false, note: `state=${st ?? "?"}` };
    }, { tries: 120, every: 10000 });
    if (/fail|error/i.test(String(r.st))) die(`provisioning ended in '${r.st}'`);
    state.siteUrl = r.body?.url ?? r.body?.site_url ?? state.siteUrl;
    record(10, { kind: "wait", status: r.st, siteUrl: state.siteUrl });
    ok(`provisioned: ${r.st}${state.siteUrl ? ` — ${state.siteUrl}` : ""}`);
  }},

  12: { kind: "ai", title: "smoke-check the provisioned site", async run() { await smoke(); record(12, { kind: "ai", done: true }); }},

  13: { kind: "ai", title: "POST intake correction (stand-in for a resubmit UI)", async run() {
    if (!has("with-correction")) { info("step 13 skipped — pass --with-correction to exercise the correction path"); return; }
    const r = await call("POST", `/v1/trips/${state.tripId}/intake/correct`, { body: state.correction ?? {} });
    record(13, { kind: "ai", status: r.status, body: r.json });
    if (r.status >= 400) die(`correction returned ${r.status}`);
    ok("correction accepted; old version should be preserved and a re-plan queued");
  }},
};

async function smoke() {
  const url = state.siteUrl || SITE;
  if (!url) { warn("no site URL known — skipping site smoke check"); return; }
  for (const path of ["/", "/api/config", "/api/config/warnings"]) {
    try {
      const res = await fetch(`${url.replace(/\/$/, "")}${path}`);
      const body = (await res.text()).slice(0, 200);
      const mark = res.ok ? `${C.g}ok${C.x}` : `${C.r}${res.status}${C.x}`;
      say(`    ${mark}  ${url}${path}  ${C.d}${body.replace(/\s+/g, " ")}${C.x}`);
    } catch (e) { say(`    ${C.r}unreachable${C.x}  ${url}${path}  ${e.message}`); }
  }
  const apiHealth = await fetch(`${API}/healthz`).then((r) => r.status).catch((e) => e.message);
  say(`    control-plane /healthz -> ${apiHealth}`);
}

// ── entry ────────────────────────────────────────────────────────────────────
if (flag("email")) state.email = flag("email");
// --password is intentionally NOT persisted; see password_() above.
if (flag("trip")) state.trip = flag("trip");
if (flag("trip-id")) state.tripId = flag("trip-id");
save();

if (has("status")) {
  say(`run ${runName} — API ${API}`);
  say(`  trip: ${state.trip ?? "?"}  id: ${state.tripId ?? "?"}  plan: ${state.planId ?? "?"}`);
  for (const k of Object.keys(state.steps).sort((a, b) => a - b)) {
    const s = state.steps[k];
    say(`  step ${k.padStart(2)}  ${s.state === "awaiting" ? "AWAITING HUMAN" : "done"}  ${s.at}`);
  }
  process.exit(0);
}
if (has("smoke")) { await smoke(); process.exit(0); }

const from = Number(flag("from", 4));
const order = Object.keys(steps).map(Number).sort((a, b) => a - b);
say(`${C.b}live-run '${runName}'${C.x} — API ${API}, starting at step ${from}`);
for (const n of order) {
  if (n < from) continue;
  const s = steps[n];
  if (s.title) info(`STEP ${n} — ${s.title}`);
  await s.run();
}
say("");
ok(`run '${runName}' reached the end of the scripted steps.`);
say(`   Teardown (step 14) is deliberately manual — it destroys a real container.`);
say(`   Next: hand your notes to the run-capture agent.`);
