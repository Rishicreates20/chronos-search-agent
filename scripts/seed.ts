// Seeds a few past conversations so recall can be tried straight away:
//   npm run seed      then open http://localhost:3000/?user=demo
//
// The dates are computed relative to today (the most recent Monday and
// Tuesday, and 3 November). The answers are ILLUSTRATIVE demo text, not real
// quotes; their only job is to give "then versus now" something to compare.
import { loadDotenv, settingsFromEnv } from "../src/config.ts";
import { SqliteStore } from "../src/memory/sqlite.ts";

loadDotenv();
const settings = settingsFromEnv();
if (settings.supabaseUrl) {
  console.error("SUPABASE_URL is set: the seed script only writes to the local SQLite file. Unset it to seed.");
  process.exit(1);
}
const store = new SqliteStore(settings.dbPath);
const USER = "demo";

const today = new Date();
today.setHours(10, 0, 0, 0);
const daysBack = (n: number) => new Date(today.getTime() - n * 86_400_000);
const lastWeekday = (dow: number) => daysBack((today.getDay() - dow + 7) % 7 || 7);
let nov3 = new Date(today.getFullYear(), 10, 3, 10, 0, 0);
if (nov3 >= today) nov3 = new Date(today.getFullYear() - 1, 10, 3, 10, 0, 0);

const NOTE = "\n\n_(Seeded demo answer. Figures are illustrative, not real quotes.)_";
const turns: [Date, string, string, string][] = [
  [
    lastWeekday(1), "seed-crm",
    "Shortlist 5 CRM tools for a 20-person sales team.",
    "Shortlist for a 20-person sales team:\n" +
      "- **HubSpot Sales Hub** — Starter around $20 per seat/month\n" +
      "- **Pipedrive** — Advanced around $29 per seat/month\n" +
      "- **Attio** — Plus around $34 per seat/month\n" +
      "- **Close** — Growth around $99 per seat/month\n" +
      "- **Zoho CRM** — Professional around $23 per seat/month" + NOTE,
  ],
  [
    lastWeekday(2), "seed-postgres",
    "Which managed Postgres hosting should I use for a small SaaS, and what does it cost?",
    "Three good options for a small SaaS:\n" +
      "- **Neon** — Launch plan around $19/month, scales to zero\n" +
      "- **Supabase** — Pro around $25/month, includes auth and storage\n" +
      "- **Render Postgres** — Basic from around $6/month for 256 MB" + NOTE,
  ],
  [nov3, "seed-fx", "What is the US dollar to Indian rupee exchange rate?", "About ₹88 per US dollar." + NOTE],
];

const existing = store.db.prepare("SELECT COUNT(*) AS n FROM messages WHERE user_id = ?").get(USER) as { n: number };
if (Number(existing.n) > 0) {
  console.log(`User "${USER}" already has ${existing.n} messages; nothing added.`);
} else {
  for (const [when, session, question, answer] of turns) {
    store.add(USER, session, "user", question, when);
    store.add(USER, session, "assistant", answer, new Date(when.getTime() + 4000), { seeded: true });
  }
  console.log(`Seeded ${turns.length} past conversations for user "${USER}":`);
  for (const [when, , question] of turns) console.log(`  ${when.toDateString()}  ${question}`);
}
console.log(`\nOpen http://localhost:${settings.port}/?user=${USER} and try:`);
console.log('  "On Monday we shortlisted 5 CRM tools for a 20-person sales team. Has any of them changed pricing or shipped something big since?"');
console.log('  "What did I ask you on 3 November? Is your answer still correct today?"');
console.log('  "Last Tuesday I asked you about Postgres hosting. Has any pricing changed since then?"');
