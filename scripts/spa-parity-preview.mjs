#!/usr/bin/env node
// Disposable browser acceptance environment; never reads a real trip or secrets.
import {
  mkdtempSync,
  cpSync,
  readFileSync,
  writeFileSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  startTestServer,
  stopTestServer,
  loginAsAlice,
  api,
} from "../tests/helpers/server.js";
const port = Number(process.env.SPA_PREVIEW_PORT || 4197);
const root = fileURLToPath(new URL("../", import.meta.url));
const temp = mkdtempSync(join(tmpdir(), "spa-parity-preview-"));
cpSync(join(root, "tests/fixtures"), temp, { recursive: true });
const config = JSON.parse(readFileSync(join(temp, "trip.config.json"), "utf8"));
config.tasks = [
  {
    id: "parity-passport",
    text: { en: "Check passport", he: "בדיקת דרכון" },
    owner: { en: "Alice", he: "אליס" },
    deadline: "2026-10-01",
  },
];
config.travel_info = {
  countries: {
    Japan: {
      flag: "🇯🇵",
      emergency: { police: "110", ambulance: "119", fire: "119" },
      currency: { code: "JPY", name: "Yen" },
    },
  },
  health: [{ en: "Bring regular medication", he: "להביא תרופות קבועות" }],
  hospitals: [{ area: { en: "Tokyo", he: "טוקיו" }, name: "Fixture hospital" }],
};
config.packing_general = [
  [
    { en: "Documents", he: "מסמכים" },
    { en: "Passport", he: "דרכון" },
  ],
];
config.phases[0].venues = [
  {
    id: "fixture-breakfast-venue",
    name: config.phases[0].days[0].items[0].text,
  },
];
config.phases[1].venues = [{ name: { en: "Mountain museum", he: "מוזיאון ההרים" }, tickets: "https://example.com/tickets" }];
config.phases[1].days = [];
config.phases[0].rsvp_activities = [
  {
    id: "fixture-breakfast",
    title: config.phases[0].days[0].items[0].text,
    date: config.phases[0].days[0].date,
    price: { en: "Free", he: "חינם" },
  },
];
writeFileSync(join(temp, "trip.config.json"), JSON.stringify(config));
writeFileSync(
  join(temp, "trivia_questions.json"),
  JSON.stringify([
    {
      id: 1,
      he: "כמה זה אחת ועוד אחת?",
      en: "What is one plus one?",
      persons: "general",
      category: "general",
      duration: 60,
      answers: [
        { he: "שתיים", en: "Two", correct: true },
        { he: "שלוש", en: "Three", correct: false },
      ],
    },
  ]),
);
await startTestServer({
  PORT: port,
  TRIP_DIR: temp,
  SITE_DIR: join(root, "site"),
});
const organizer = await loginAsAlice();
// A real one-page PDF, generated in memory; no binary fixture enters git.
const stream = "BT /F1 24 Tf 60 720 Td (DEMO - Breakfast confirmation) Tj 0 -45 Td /F1 14 Tf (New York - March 11, 2027 - 09:00) Tj 0 -30 Td (Confirmation: DEMO-ONLY) Tj 0 -45 Td (Sample document for view and download testing.) Tj 0 -25 Td (Not a reservation or a ticket.) Tj ET";
const objects = [
  "<< /Type /Catalog /Pages 2 0 R >>",
  "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
  "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>",
  "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
  `<< /Length ${Buffer.byteLength(stream)} >>\nstream\n${stream}\nendstream`,
];
let pdf = "%PDF-1.4\n";
const offsets = [0];
objects.forEach((object, i) => { offsets.push(Buffer.byteLength(pdf)); pdf += `${i + 1} 0 obj\n${object}\nendobj\n`; });
const xref = Buffer.byteLength(pdf);
pdf += `xref\n0 6\n0000000000 65535 f \n${offsets.slice(1).map(offset => `${String(offset).padStart(10, "0")} 00000 n \n`).join("")}trailer\n<< /Size 6 /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
const pdfPath = join(temp, "demo-breakfast.pdf");
writeFileSync(pdfPath, pdf);
async function checked(path, options = {}) {
  const response = await api(path, { token: organizer, ...options });
  if (!response.ok) throw new Error(`Demo setup failed: ${path} ${response.status}`);
  return response.json();
}
const booking = await checked("/api/bookings", { method: "POST", body: { phase: config.phases[0].id, type: "attraction", name: "Demo breakfast confirmation", date_from: config.phases[0].days[0].date, confirmation: "DEMO-ONLY" } });
const form = new FormData();
form.append("file", new Blob([pdf], { type: "application/pdf" }), "demo-breakfast.pdf");
const document = await checked(`/api/bookings/${booking.id}/confirmation`, { method: "POST", body: form });
await checked("/api/phase-plan/promote-config-days", { method: "POST", body: {} });
const planPath = `/api/phases/${encodeURIComponent(config.phases[0].id)}/plan`;
const plan = await checked(planPath);
const breakfast = plan.find(item => item.text_en === "Breakfast");
if (!breakfast) throw new Error("Demo breakfast item missing");
await checked(`${planPath}/${breakfast.id}`, { method: "PATCH", body: { booking_id: booking.id } });
const itinerary = await checked("/api/itinerary/active");
if (!itinerary.items.some(item => item.text_en === "Breakfast" && item.booking?.conf_file === document.conf_file)) throw new Error("Demo document is not attached to Journey");
const memberLogin = await (await api("/api/auth/login", { method: "POST", body: { username: "bob", password: "1234" } })).json();
const documentPath = `/api/bookings/confirmation/${encodeURIComponent(document.conf_file)}`;
const memberDocument = await api(documentPath, { token: memberLogin.token });
const anonymousDocument = await api(documentPath);
if (memberDocument.status !== 200 || anonymousDocument.status !== 401) throw new Error("Demo document access check failed");
console.log(`Demo PDF: ${pdfPath}; member document GET: ${memberDocument.status}, anonymous: ${anonymousDocument.status}`);
console.log(
  `Disposable parity preview: http://127.0.0.1:${port}/modern/ (alice or bob / 1234)`,
);
function stop() {
  stopTestServer();
  rmSync(temp, { recursive: true, force: true });
  process.exit();
}
process.on("SIGTERM", stop);
process.on("SIGINT", stop);
