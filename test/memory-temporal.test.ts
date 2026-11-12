import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { SqliteStore } from "../src/memory/sqlite.ts";
import { toIso } from "../src/memory/types.ts";
import { analyze, buildRecallBlock, keywords, parseRange, tag } from "../src/temporal.ts";

// Wednesday 11 November 2026, 15:36:02 UTC.
const NOW = new Date("2026-11-11T15:36:02.000Z");
const MIN = 60_000, HOUR = 3_600_000, DAY = 86_400_000;
const ago = (ms: number) => new Date(NOW.getTime() - ms);

function seeded() {
  const s = new SqliteStore(":memory:");
  s.add("u1", "s0", "user", "Who won the 2022 World Cup?", ago(DAY + 2 * HOUR));
  s.add("u1", "s0", "assistant", "Argentina won it.", ago(DAY + 2 * HOUR - 2000));
  s.add("u1", "s1", "user", "What is the price of bitcoin?", ago(5 * MIN));
  s.add("u1", "s1", "assistant", "About $100k.", ago(5 * MIN - 1000));
  s.add("u1", "s1", "user", "Explain python decorators", ago(40_000));
  s.add("u2", "sx", "user", "Someone else's bitcoin question", ago(5 * MIN));
  return s;
}

async function recallBlock(s: SqliteStore, text: string, session = "s1", user = "u1") {
  const r = analyze(text, NOW, "UTC");
  const ctx = await s.beginTurn({ userId: user, sessionId: session, content: text, createdAt: NOW, window: 20, range: r.range ?? undefined, terms: r.keywords, logLimit: 40 });
  return buildRecallBlock(r, ctx, NOW, "UTC");
}

test("timestamps are ISO-8601 UTC and immutable", () => {
  const s = new SqliteStore(":memory:");
  const m = s.add("u1", "s1", "user", "hello", NOW);
  assert.equal(m.createdAt, "2026-11-11T15:36:02.000Z");
  assert.throws(() => s.db.exec("UPDATE messages SET created_at='2000-01-01T00:00:00.000Z'"), /immutable/);
  assert.throws(() => s.db.exec("UPDATE messages SET content='edited'"), /immutable/);
});

test("the database file runs in WAL mode", () => {
  const s = new SqliteStore(join(mkdtempSync(join(tmpdir(), "chronos-")), "db", "chronos.db"));
  assert.equal((s.db.prepare("PRAGMA journal_mode").get() as any).journal_mode, "wal");
});

test("the sliding window is chronological, per session, and excludes the current message", async () => {
  const s = seeded();
  const ctx = await s.beginTurn({ userId: "u1", sessionId: "s1", content: "current", createdAt: NOW, window: 3 });
  assert.deepEqual(ctx.recent.map((m) => m.content), ["What is the price of bitcoin?", "About $100k.", "Explain python decorators"]);
});

test("keyword search stems, is scoped to the user, and returns whole exchanges", () => {
  const s = seeded();
  assert.deepEqual(s.search("u1", ["decorator"]).map((m) => m.content), ["Explain python decorators"]);
  // The question matched; its answer comes with it. Another user's row does not.
  assert.deepEqual(s.search("u1", ["bitcoin"]).map((m) => m.content), ["What is the price of bitcoin?", "About $100k."]);
  // The answer matched; its question comes with it.
  assert.deepEqual(s.search("u1", ["argentina"]).map((m) => m.content), ["Who won the 2022 World Cup?", "Argentina won it."]);
  assert.deepEqual(s.search("u1", ['"; DROP TABLE']), []);
  assert.deepEqual(s.search("u1", []), []);
});

const ranges: [string, string, string][] = [
  ["what did we discuss yesterday?", "2026-11-10T00:00:00.000Z", "2026-11-11T00:00:00.000Z"],
  ["summarize today's questions", "2026-11-11T00:00:00.000Z", "2026-11-11T15:36:02.000Z"],
  ["what did I ask 5 minutes ago?", "2026-11-11T15:28:32.000Z", "2026-11-11T15:33:32.000Z"],
  ["what did I ask in the last 2 hours", "2026-11-11T13:36:02.000Z", "2026-11-11T15:36:02.000Z"],
  ["what did I ask 2 days ago", "2026-11-09T00:00:00.000Z", "2026-11-10T00:00:00.000Z"],
  ["what did I ask on 2026-11-03?", "2026-11-03T00:00:00.000Z", "2026-11-04T00:00:00.000Z"],
  // The three phrasings in the challenge brief.
  ["What did I ask you on 3 November? Is your answer still correct today?", "2026-11-03T00:00:00.000Z", "2026-11-04T00:00:00.000Z"],
  ["On Monday we shortlisted 5 CRM tools for a 20-person sales team.", "2026-11-09T00:00:00.000Z", "2026-11-10T00:00:00.000Z"],
  ["Last Tuesday I asked you about Postgres hosting. Has any pricing changed since then?", "2026-11-10T00:00:00.000Z", "2026-11-11T00:00:00.000Z"],
  // Other date spellings.
  ["what did I ask on November 3rd", "2026-11-03T00:00:00.000Z", "2026-11-04T00:00:00.000Z"],
  ["what did we cover on the 3rd of Nov 2025?", "2025-11-03T00:00:00.000Z", "2025-11-04T00:00:00.000Z"],
  ["what did I ask on 25 December", "2025-12-25T00:00:00.000Z", "2025-12-26T00:00:00.000Z"], // not in the future
  ["what did we discuss last week", "2026-11-02T00:00:00.000Z", "2026-11-09T00:00:00.000Z"],
  ["anything I asked since Monday?", "2026-11-09T00:00:00.000Z", "2026-11-11T15:36:02.000Z"],
];
for (const [text, start, end] of ranges) {
  test(`range: ${text}`, () => {
    const r = parseRange(text, NOW, "UTC");
    assert.ok(r, "expected a range");
    assert.deepEqual([toIso(r.start), toIso(r.end)], [start, end]);
  });
}

test("ranges use the user's timezone", () => {
  // 15:36 UTC is 21:06 in Kolkata; "yesterday" must be the Kolkata calendar day.
  const r = parseRange("what did I ask yesterday", NOW, "Asia/Kolkata")!;
  assert.deepEqual([toIso(r.start), toIso(r.end)], ["2026-11-09T18:30:00.000Z", "2026-11-10T18:30:00.000Z"]);
});

test("recall detection", () => {
  assert.ok(analyze("What did I ask earlier?", NOW, "UTC").isRecall);
  assert.deepEqual(analyze("When did I ask about bitcoin?", NOW, "UTC").keywords, ["bitcoin"]);
  assert.ok(analyze("On Monday we shortlisted 5 CRM tools for a 20-person sales team. Has any of them changed pricing?", NOW, "UTC").isRecall);
  assert.ok(analyze("Is your answer still correct today?", NOW, "UTC").isRecall);
  assert.ok(!analyze("What is the capital of France?", NOW, "UTC").isRecall);
  assert.ok(!analyze("What happened in the election on Monday?", NOW, "UTC").isRecall); // about the world, not the chat
  assert.deepEqual(keywords("Last Tuesday I asked you about Postgres hosting. Has any pricing changed since then?"), ["postgres", "hosting", "pricing"]);
});

test("tags carry the exact local time, weekday and age", () => {
  assert.equal(tag(ago(5 * MIN), "Asia/Kolkata", NOW), "[2026-11-11 Wed 21:01:02 GMT+5:30 · 5 min ago]");
  assert.equal(tag(ago(DAY + 2 * HOUR), "UTC", NOW), "[2026-11-10 Tue 13:36:02 UTC · 1d 2h ago]");
});

test("recall block: time range, keyword hits across sessions, session log", async () => {
  let block = await recallBlock(seeded(), "what did I ask 5 minutes ago?");
  assert.ok(block.includes("[2026-11-11 Wed 15:31:02 UTC · 5 min ago] USER: What is the price of bitcoin?"));
  assert.ok(!block.includes("USER: what did I ask 5 minutes ago?")); // the current message is never recalled
  assert.ok(!block.includes("Someone else"));

  block = await recallBlock(seeded(), "when did I ask about the world cup?", "new-session");
  assert.ok(block.includes("[2026-11-10 Tue 13:36:02 UTC · 1d 2h ago] USER: Who won the 2022 World Cup?"));
  assert.ok(block.includes("ASSISTANT: Argentina won it."));
  assert.ok(block.includes("no earlier user questions"));
});

test("recall block states an empty range instead of leaving a gap", async () => {
  const block = await recallBlock(seeded(), "what did we discuss last week?");
  assert.ok(block.includes("Nothing was recorded in this range."));
});
