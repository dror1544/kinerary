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
    id: "fixture-museum",
    name: { en: "Fixture museum", he: "מוזיאון לדוגמה" },
  },
];
config.phases[1].venues = [{ name: { en: "Mountain museum", he: "מוזיאון ההרים" }, tickets: "https://example.com/tickets" }];
config.phases[1].days = [];
config.phases[0].rsvp_activities = [
  {
    id: "fixture-walk",
    title: { en: "Group walk", he: "הליכה קבוצתית" },
    date: "2026-09-11",
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
await loginAsAlice();
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
