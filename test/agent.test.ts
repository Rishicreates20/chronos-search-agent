// End to end through the real HTTP app and SSE stream, with the LLM and
// search API scripted.
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { runTurn, type AgentEvent } from "../src/agent.ts";
import { SqliteStore } from "../src/memory/sqlite.ts";
import { chat, FakeBackend, makeApp, makeSettings, sseBody, textChunks, toolChunks } from "./helpers.ts";

const types = (events: any[]) => events.map((e) => e.type);

test("a direct answer streams token by token with no search", async () => {
  const b = new FakeBackend();
  b.llmScript = [textChunks("Hello! How can I help?")];
  const { app } = makeApp(b);
  const { res, events, answer } = await chat(app, "hi");
  assert.match(res.headers.get("content-type")!, /^text\/event-stream/);
  assert.equal(events[0].type, "meta");
  assert.ok(events.filter((e) => e.type === "token").length > 1);
  assert.equal(answer, "Hello! How can I help?");
  const done = events.at(-1);
  assert.equal(done.type, "done");
  assert.equal(done.searched, false);
  assert.notEqual(done.ttft_ms, null);
  assert.equal(b.searchRequests.length, 0);
});

test("exactly one tool is registered: web_search", async () => {
  const b = new FakeBackend();
  b.llmScript = [textChunks("ok")];
  await chat(makeApp(b).app, "hi");
  const tools = b.llmRequests[0].tools;
  assert.deepEqual(tools.map((t: any) => t.function.name), ["web_search"]);
  assert.deepEqual(tools[0].function.parameters.required, ["query"]);
});

test("search flow: real URLs are cited, fabricated ones are stripped, both turns are stored", async () => {
  const b = new FakeBackend();
  b.searchResults = [{ title: "Fed holds rates", url: "https://reuters.com/fed", content: "The Fed held rates steady." }];
  b.llmScript = [
    toolChunks({ query: "fed rate decision 2026" }),
    textChunks("The Fed held rates [Reuters](https://reuters.com/fed). More at [Bloomberg](https://bloomberg.com/invented-article)."),
  ];
  const { app } = makeApp(b);
  const { events, answer } = await chat(app, "what did the fed do today?");
  const t = types(events);
  assert.ok(t.indexOf("status") < t.indexOf("sources") && t.indexOf("sources") < t.indexOf("token"));
  assert.equal(events[t.indexOf("status")].query, "fed rate decision 2026");
  assert.ok(answer.includes("[Reuters](https://reuters.com/fed)"));
  assert.ok(!answer.includes("bloomberg.com") && answer.includes("More at Bloomberg."));
  assert.equal(events.at(-1).searched, true);
  assert.equal(events.at(-1).removed_urls, 1);
  assert.equal(b.searchRequests[0].query, "fed rate decision 2026");
  assert.equal(b.searchRequests[0].search_depth, "fast");

  // The second LLM call saw the tool result, with the citation rule restated.
  const toolMsg = b.llmRequests[1].messages.at(-1);
  assert.equal(toolMsg.role, "tool");
  assert.ok(toolMsg.content.includes("https://reuters.com/fed") && toolMsg.content.includes("Citation rule"));

  const stored = (await (await app.request("/api/history?session_id=s1&user_id=u1")).json()).messages;
  assert.deepEqual(stored.map((m: any) => m.role), ["user", "assistant"]);
  assert.ok(stored.every((m: any) => /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(m.created_at)));
  assert.equal(stored[1].content, answer); // what is stored is what was shown
  assert.deepEqual(stored[1].meta.sources, [{ title: "Fed holds rates", url: "https://reuters.com/fed" }]);
});

test("several searches in one step run in parallel, and `since` becomes a date filter", async () => {
  const b = new FakeBackend();
  let inFlight = 0, peak = 0;
  b.searchHandler = async (body) => {
    peak = Math.max(peak, ++inFlight);
    await new Promise((r) => setTimeout(r, 20));
    inFlight--;
    return Response.json({ results: [{ title: body.query, url: `https://x.example/${encodeURIComponent(body.query)}`, content: "c" }] });
  };
  b.llmScript = [toolChunks({ query: "HubSpot pricing", since: "2026-11-09" }, { query: "Pipedrive pricing" }, { query: "Attio pricing" }), textChunks("done")];
  const { events } = await chat(makeApp(b).app, "check all three");
  assert.equal(peak, 3);
  assert.equal(b.searchRequests.find((r) => r.query === "HubSpot pricing").start_date, "2026-11-09");
  assert.equal(b.searchRequests.find((r) => r.query === "Pipedrive pricing").start_date, undefined);
  assert.equal(events.filter((e) => e.type === "status").length, 3);
  assert.equal(events.find((e) => e.type === "sources").sources.length, 3);
  assert.equal(b.llmRequests[1].messages.filter((m: any) => m.role === "tool").length, 3);
});

test("a date filter that finds nothing falls back to unfiltered results, labelled", async () => {
  const b = new FakeBackend();
  b.searchHandler = (body) => Response.json({ results: body.start_date ? [] : [{ title: "Pricing", url: "https://a.example/pricing", content: "c" }] });
  b.llmScript = [toolChunks({ query: "Neon pricing", since: "2026-11-10" }), textChunks("ok")];
  await chat(makeApp(b).app, "any change?");
  assert.equal(b.searchRequests.length, 2);
  assert.match(b.llmRequests[1].messages.at(-1).content, /not date-filtered/);
});

test("empty results force explicit uncertainty", async () => {
  const b = new FakeBackend();
  b.llmScript = [toolChunks({ query: "zzqx" }), textChunks("I could not find verified information on this.")];
  const { answer } = await chat(makeApp(b).app, "what is zzqx?");
  assert.ok(b.llmRequests[1].messages.at(-1).content.includes("NO_RESULTS"));
  assert.equal(answer, "I could not find verified information on this.");
});

test("a search timeout is reported to the user and to the model", async () => {
  const b = new FakeBackend();
  b.searchHandler = () => {
    throw new DOMException("slow", "TimeoutError");
  };
  b.llmScript = [toolChunks({ query: "anything" }), textChunks("Live search timed out, so this is from my training knowledge.")];
  const { events } = await chat(makeApp(b).app, "latest news?");
  const failed = events.find((e) => e.type === "status" && e.state === "search_failed");
  assert.equal(failed.detail, "Search timed out");
  assert.ok(b.llmRequests[1].messages.at(-1).content.includes("SEARCH_TIMEOUT"));
  assert.equal(events.at(-1).type, "done");
});

test("search rounds are bounded; the final request declares no tool", async () => {
  const b = new FakeBackend();
  b.searchResults = [{ title: "t", url: "https://a.example/1", content: "c" }];
  b.llmScript = [toolChunks({ query: "q1" }), toolChunks({ query: "q2" }), textChunks("final")];
  const { answer } = await chat(makeApp(b).app, "dig deep");
  assert.equal(answer, "final");
  const last = b.llmRequests[2];
  assert.ok(!("tools" in last) && !("tool_choice" in last));
  assert.ok(last.messages.every((m: any) => m.role !== "tool" && !m.tool_calls));
  assert.equal(last.messages.at(-1).content.split("https://a.example/1").length - 1, 2);
});

test("history reaches the model with timestamp tags; recall adds a memory section", async () => {
  const b = new FakeBackend();
  b.llmScript = [textChunks("Paris."), textChunks("You asked about France.")];
  const { app } = makeApp(b);
  const first = await chat(app, "What is the capital of France?");
  await chat(app, "And what did I ask earlier?");
  const msgs = b.llmRequests[1].messages;
  const stamp: string = first.events[0].created_at;
  const day = stamp.slice(0, 10), clock = stamp.slice(11, 19);
  assert.match(msgs[1].content, new RegExp(`^\\[${day} \\w{3} ${clock} UTC · \\d+s ago\\] What is the capital of France\\?$`));
  assert.ok(msgs[2].role === "assistant" && msgs[2].content.endsWith("Paris."));
  assert.deepEqual(msgs.at(-1), { role: "user", content: "And what did I ask earlier?" });
  assert.ok(msgs[0].content.includes("## MEMORY RECALL") && msgs[0].content.includes("CURRENT TIME:"));
  assert.ok(!b.llmRequests[0].messages[0].content.includes("## MEMORY RECALL")); // not on ordinary turns
});

test("brief scenario: 'On Monday we shortlisted 5 CRM tools… changed pricing since?'", async () => {
  // Wednesday 11 Nov 2026. The shortlist was made on Monday, in another session.
  const now = new Date("2026-11-11T15:36:02.000Z");
  const store = new SqliteStore(":memory:");
  store.add("u1", "monday", "user", "Shortlist 5 CRM tools for a 20-person sales team", new Date("2026-11-09T10:00:00.000Z"));
  store.add("u1", "monday", "assistant", "Shortlist: HubSpot ($20/seat), Pipedrive ($24/seat), Attio, Close, Zoho CRM.", new Date("2026-11-09T10:00:05.000Z"));
  store.add("u1", "monday", "user", "Thanks. Unrelated: best pizza dough hydration?", new Date("2026-11-09T11:00:00.000Z"));
  const b = new FakeBackend();
  b.searchHandler = (body) => Response.json({ results: [{ title: body.query, url: `https://x.example/${body.query.split(" ")[0]}`, content: "now $25/seat" }] });
  b.llmScript = [
    toolChunks({ query: "HubSpot CRM pricing 2026" }, { query: "Pipedrive pricing 2026" }),
    textChunks("On 9 Nov HubSpot was $20/seat; it is now $25 [x.example](https://x.example/HubSpot)."),
  ];
  const events: AgentEvent[] = [];
  const question = "On Monday we shortlisted 5 CRM tools for a 20-person sales team. Has any of them changed pricing or shipped something big since?";
  for await (const ev of runTurn({ settings: makeSettings(), store, fetchFn: b.fetch, now: () => now }, { userId: "u1", sessionId: "today", text: question, timezone: "UTC" })) events.push(ev);

  // Memory was resolved before the model ran: Monday's exchange, with the
  // answer that named the tools and prices, is in the first request.
  const system: string = b.llmRequests[0].messages[0].content;
  assert.ok(system.includes('Time range "on Monday (2026-11-09)"'));
  assert.ok(system.includes("[2026-11-09 Mon 10:00:00 UTC · 2d 5h ago] USER: Shortlist 5 CRM tools for a 20-person sales team"));
  assert.ok(system.includes("ASSISTANT: Shortlist: HubSpot ($20/seat), Pipedrive ($24/seat), Attio, Close, Zoho CRM."));
  // So one model step could plan the searches, and they ran together.
  assert.equal(b.searchRequests.length, 2);
  assert.equal(b.llmRequests.length, 2);
  const answer = events.filter((e) => e.type === "token").map((e: any) => e.text).join("");
  assert.ok(answer.includes("[x.example](https://x.example/HubSpot)"));
});

test("brief scenario: 'What did I ask you on 3 November?' with nothing stored says so", async () => {
  const now = new Date("2026-11-11T15:36:02.000Z");
  const b = new FakeBackend();
  b.llmScript = [textChunks("I have no record of a question from you on 3 November.")];
  const events: AgentEvent[] = [];
  for await (const ev of runTurn({ settings: makeSettings(), store: new SqliteStore(":memory:"), fetchFn: b.fetch, now: () => now }, { userId: "u1", sessionId: "s", text: "What did I ask you on 3 November? Is your answer still correct today?", timezone: "UTC" })) events.push(ev);
  const system: string = b.llmRequests[0].messages[0].content;
  assert.ok(system.includes('Time range "3 November 2026" = 2026-11-03 00:00:00 UTC to 2026-11-04 00:00:00 UTC: 0 stored message(s). Nothing was recorded in this range.'));
});

test("memory survives a restart and is private to each user", async () => {
  const dbPath = join(mkdtempSync(join(tmpdir(), "chronos-")), "t.db");
  const b = new FakeBackend();
  b.llmScript = [textChunks("5,895 m."), textChunks("Yesterday…"), textChunks("No record.")];
  let { app, store } = makeApp(b, { dbPath });
  await chat(app, "How tall is Mount Kilimanjaro?", { session: "old", user: "alice" });
  await store.close();
  ({ app } = makeApp(b, { dbPath })); // new process, same file
  await chat(app, "When did I ask about Kilimanjaro?", { session: "new", user: "alice" });
  assert.ok(b.llmRequests[1].messages[0].content.includes("USER: How tall is Mount Kilimanjaro?"));
  assert.ok(b.llmRequests[1].messages[0].content.includes("ASSISTANT: 5,895 m."));
  await chat(app, "When did I ask about Kilimanjaro?", { session: "x", user: "bob" });
  assert.ok(!b.llmRequests[2].messages[0].content.includes("How tall is Mount Kilimanjaro?"));
});

test("an LLM failure becomes an error event; the question is still remembered", async () => {
  const fail = { fetch: (async () => Response.json({ error: { message: "API key not valid" } }, { status: 401 })) as typeof fetch };
  const { app } = makeApp(fail);
  const { events } = await chat(app, "hi");
  const err = events.find((e) => e.type === "error");
  assert.ok(err.message.includes("401") && err.message.includes("API key not valid"));
  assert.equal(events.at(-1).type, "done");
  const stored = (await (await app.request("/api/history?session_id=s1&user_id=u1")).json()).messages;
  assert.deepEqual(stored.map((m: any) => m.role), ["user"]);
});

test("a rejected tool call is retried once instead of surfacing", async () => {
  let n = 0;
  const flaky = {
    fetch: (async () =>
      ++n === 1
        ? Response.json({ error: { message: "Tool choice is none, but model called a tool" } }, { status: 400 })
        : new Response(sseBody(textChunks("Recovered.")))) as typeof fetch,
  };
  const { events, answer } = await chat(makeApp(flaky).app, "hi");
  assert.equal(answer, "Recovered.");
  assert.ok(!events.some((e) => e.type === "error"));
  assert.equal(n, 2);
});

test("a rejected reasoning_effort parameter is dropped and remembered", async () => {
  const seen: boolean[] = [];
  const picky = {
    fetch: (async (_url: any, init: any) => {
      const body = JSON.parse(init.body);
      seen.push("reasoning_effort" in body);
      return "reasoning_effort" in body ? Response.json({ error: { message: "Unknown parameter" } }, { status: 400 }) : new Response(sseBody(textChunks("hello")));
    }) as typeof fetch,
  };
  const { app } = makeApp(picky, { llmReasoningEffort: "low", llmBaseUrl: "https://llm2.test/v1" });
  assert.equal((await chat(app, "hi")).answer, "hello");
  assert.equal((await chat(app, "again")).answer, "hello");
  assert.deepEqual(seen, [true, false, false]);
});

test("a search API that rejects the fast depth falls back to basic, once", async () => {
  const b = new FakeBackend();
  const depths: string[] = [];
  b.searchHandler = (body) => {
    depths.push(body.search_depth);
    return body.search_depth !== "basic" ? Response.json({ detail: "invalid" }, { status: 400 }) : Response.json({ results: [{ title: "t", url: "https://a.example/1", content: "c" }] });
  };
  b.llmScript = [toolChunks({ query: "q" }), textChunks("ok"), toolChunks({ query: "q" }), textChunks("ok")];
  // A distinct host so the remembered fallback does not leak between tests.
  const base = b.fetch;
  b.fetch = (async (u: any, i: any) => base(String(u).replace("search3.test", "search.test"), i)) as typeof fetch;
  const { app } = makeApp(b, { tavilyBaseUrl: "https://search3.test" });
  const first = await chat(app, "news?");
  await chat(app, "more?");
  assert.deepEqual(depths, ["fast", "basic", "basic"]);
  assert.ok(first.events.some((e) => e.type === "sources") && !first.events.some((e) => e.type === "error"));
});

test("request validation, health", async () => {
  const { app } = makeApp(new FakeBackend());
  const post = (body: unknown) => app.request("/api/chat", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
  assert.equal((await post({ session_id: "s1", message: "" })).status, 422);
  assert.equal((await post({ session_id: "bad id!", message: "x" })).status, 422);
  const health = await (await app.request("/api/health")).json();
  assert.ok(health.ok && health.memory === "sqlite");
});
