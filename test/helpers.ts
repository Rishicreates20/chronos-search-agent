// Test doubles: a scripted LLM and search API behind a fake fetch, so the
// whole pipeline runs offline and deterministically.
import { createApp } from "../src/http.js";
import { settingsFromEnv, type Settings } from "../src/config.js";
import { SqliteStore } from "../src/memory/sqlite.js";
import type { MemoryStore } from "../src/memory/types.js";

export function makeSettings(over: Partial<Settings> = {}): Settings {
  return {
    ...settingsFromEnv({}),
    llmApiKey: "test-key", llmBaseUrl: "https://llm.test/v1", llmModel: "test-model", llmReasoningEffort: "",
    tavilyApiKey: "test-key", tavilyBaseUrl: "https://search.test", dbPath: ":memory:",
    ...over,
  };
}

export const sseBody = (chunks: unknown[]) => chunks.map((c) => `data: ${JSON.stringify(c)}\n\n`).join("") + "data: [DONE]\n\n";

export function textChunks(text: string, size = 7): unknown[] {
  const out = [];
  for (let i = 0; i < text.length; i += size) out.push({ choices: [{ delta: { content: text.slice(i, i + size) } }] });
  return out;
}

export function toolChunks(...calls: { query: string; since?: string }[]): unknown[] {
  // First call is streamed in two fragments, as OpenAI does.
  return calls.flatMap((c, i) => {
    const args = JSON.stringify(c);
    const half = Math.floor(args.length / 2);
    return [
      { choices: [{ delta: { tool_calls: [{ index: i, id: `call_${i}`, type: "function", function: { name: "web_search", arguments: args.slice(0, half) } }] } }] },
      { choices: [{ delta: { tool_calls: [{ index: i, function: { arguments: args.slice(half) } }] } }] },
    ];
  });
}

/** Scripts LLM replies in order and records every request it receives. */
export class FakeBackend {
  llmScript: unknown[][] = [];
  llmRequests: any[] = [];
  searchRequests: any[] = [];
  searchResults: unknown[] = [];
  searchHandler?: (body: any) => Response | Promise<Response>;

  fetch: typeof fetch = async (input, init) => {
    const url = new URL(String(input));
    const body = init?.body ? JSON.parse(String(init.body)) : undefined;
    if (url.host === "llm.test") {
      this.llmRequests.push(body);
      const next = this.llmScript.shift();
      if (!next) return new Response(JSON.stringify({ error: { message: "script exhausted" } }), { status: 500 });
      return new Response(sseBody(next), { status: 200 });
    }
    if (url.host === "search.test") {
      this.searchRequests.push(body);
      if (this.searchHandler) return this.searchHandler(body);
      return Response.json({ results: this.searchResults });
    }
    return new Response("not found", { status: 404 });
  };
}

export function makeApp(backend: { fetch: typeof fetch }, over: Partial<Settings> = {}, store?: MemoryStore) {
  const settings = makeSettings(over);
  const s = store ?? new SqliteStore(settings.dbPath);
  const app = createApp({ settings, getStore: async () => s, fetchFn: backend.fetch });
  return { app, store: s as SqliteStore, settings };
}

export async function chat(app: { request: (path: string, init?: RequestInit) => Response | Promise<Response> }, message: string, ids: { session?: string; user?: string; tz?: string } = {}) {
  const res = await app.request("/api/chat", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ session_id: ids.session ?? "s1", user_id: ids.user ?? "u1", message, timezone: ids.tz ?? "UTC" }),
  });
  const text = await res.text();
  const events: any[] = text.split("\n").filter((l) => l.startsWith("data: ")).map((l) => JSON.parse(l.slice(6)));
  return { res, events, answer: events.filter((e) => e.type === "token").map((e) => e.text).join("") };
}
