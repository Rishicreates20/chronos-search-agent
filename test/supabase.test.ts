// The hosted store speaks to Postgres through three RPC functions. These
// tests pin the requests it sends; the SQL side is supabase/schema.sql.
import assert from "node:assert/strict";
import { test } from "node:test";
import { openStore, StoreError } from "../src/memory/index.ts";
import { SupabaseStore } from "../src/memory/supabase.ts";
import { chat, makeApp, makeSettings, sseBody, textChunks } from "./helpers.ts";

const NOW = new Date("2026-11-11T15:36:02.123Z");
const row = (id: number, role: string, content: string, meta: unknown = null) => ({ id, user_id: "u1", session_id: "s1", role, content, created_at: "2026-11-11T15:36:02.123Z", meta });

test("the backend is chosen by configuration", async () => {
  assert.equal((await openStore(makeSettings())).kind, "sqlite");
  assert.equal((await openStore(makeSettings({ supabaseUrl: "https://db.test", supabaseKey: "k", memoryToken: "t" }))).kind, "supabase");
});

test("beginTurn is one authenticated call", async () => {
  const seen: { url: string; init: any }[] = [];
  const f = (async (url: any, init: any) => {
    seen.push({ url: String(url), init });
    return Response.json({ user: row(3, "user", "q"), recent: [row(1, "user", "hi"), row(2, "assistant", "hello", { searched: false })], range_rows: [row(1, "user", "hi")], range_total: 1, hits: [], log: [row(1, "user", "hi")] });
  }) as typeof fetch;
  const store = new SupabaseStore("https://db.test/", "pub-key", "mem-token", f);
  const ctx = await store.beginTurn({ userId: "u1", sessionId: "s1", content: "q", createdAt: NOW, window: 20, range: { start: NOW, end: NOW }, terms: ["x"], logLimit: 40 });
  assert.equal(seen.length, 1);
  assert.equal(seen[0]!.url, "https://db.test/rest/v1/rpc/chronos_begin_turn");
  assert.equal(seen[0]!.init.headers.apikey, "pub-key");
  const body = JSON.parse(seen[0]!.init.body);
  assert.deepEqual(
    [body.p_token, body.p_user_id, body.p_created_at, body.p_window, body.p_terms, body.p_log_limit],
    ["mem-token", "u1", "2026-11-11T15:36:02.123Z", 20, ["x"], 40],
  );
  assert.equal(ctx.user.id, 3);
  assert.deepEqual(ctx.recent.map((m) => m.content), ["hi", "hello"]);
  assert.deepEqual(ctx.recent[1]!.meta, { searched: false });
});

test("failures become StoreError", async () => {
  const bad = new SupabaseStore("https://db.test", "k", "bad", (async () => Response.json({ message: "invalid memory token" }, { status: 403 })) as typeof fetch);
  await assert.rejects(bad.history("u1", "s1"), (e) => e instanceof StoreError && /invalid memory token/.test(e.message));
  const down = new SupabaseStore("https://db.test", "k", "t", (async () => {
    throw new TypeError("fetch failed");
  }) as typeof fetch);
  await assert.rejects(down.history("u1", "s1"), /unreachable/);
});

test("a full turn against the hosted store: question first, answer after", async () => {
  const calls: string[] = [];
  const f = (async (url: any, init: any) => {
    const u = new URL(String(url));
    if (u.host === "llm.test") return new Response(sseBody(textChunks("Paris.")));
    const fn = u.pathname.split("/").at(-1)!;
    const body = JSON.parse(init.body);
    calls.push(fn);
    if (fn === "chronos_begin_turn") return Response.json({ user: row(1, "user", body.p_content), recent: [], range_rows: [], range_total: 0, hits: [], log: [] });
    return Response.json(row(2, body.p_role, body.p_content, body.p_meta));
  }) as typeof fetch;
  const settings = makeSettings({ supabaseUrl: "https://db.test", supabaseKey: "k", memoryToken: "t" });
  const { app } = makeApp({ fetch: f }, settings, await openStore(settings, f));
  const { events } = await chat(app, "Capital of France?");
  assert.equal(events.at(-1).assistant_message_id, 2);
  assert.deepEqual(calls, ["chronos_begin_turn", "chronos_save"]);
});

test("a store outage is reported, not crashed", async () => {
  const f = (async () => Response.json({ message: "database is paused" }, { status: 503 })) as typeof fetch;
  const settings = makeSettings({ supabaseUrl: "https://db.test", supabaseKey: "k", memoryToken: "t" });
  const { app } = makeApp({ fetch: f }, settings, await openStore(settings, f));
  const { events } = await chat(app, "hi");
  assert.deepEqual(events.map((e) => e.type), ["error", "done"]);
  assert.match(events[0].message, /database is paused/);
  assert.equal((await app.request("/api/history?session_id=s1&user_id=u1")).status, 503);
});
