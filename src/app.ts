// HTTP surface: POST /api/chat (SSE), GET /api/history, /api/health, /api/models.
import { Hono } from "hono";
import { runTurn, type AgentEvent } from "./agent.js";
import type { Settings } from "./config.js";
import { StoreError, toIso, type MemoryStore } from "./memory/types.js";

const ID_RE = /^[A-Za-z0-9_-]{1,64}$/;

export interface AppDeps {
  settings: Settings;
  /** Lazy so a serverless cold start does not open the store until needed. */
  getStore: () => Promise<MemoryStore>;
  fetchFn?: typeof fetch;
}

const sse = (ev: AgentEvent) => `event: ${ev.type}\ndata: ${JSON.stringify(ev)}\n\n`;

export function createApp({ settings, getStore, fetchFn = fetch }: AppDeps): Hono {
  const app = new Hono();

  app.post("/api/chat", async (c) => {
    const body = await c.req.json().catch(() => null);
    const sessionId = body?.session_id;
    const userId = body?.user_id ?? sessionId;
    const text = typeof body?.message === "string" ? body.message.trim() : "";
    if (!ID_RE.test(sessionId ?? "") || !ID_RE.test(userId ?? "") || !text || text.length > 8000) {
      return c.json({ error: "Expected { session_id, user_id, message } with a non-empty message." }, 422);
    }
    const store = await getStore();
    const events = runTurn({ settings, store, fetchFn }, { userId, sessionId, text, timezone: body.timezone });
    const encoder = new TextEncoder();
    const stream = new ReadableStream<Uint8Array>({
      async pull(controller) {
        const { value, done } = await events.next();
        if (done) controller.close();
        else controller.enqueue(encoder.encode(sse(value)));
      },
      // Client went away: finish the generator so its `finally` still saves
      // whatever part of the answer was shown.
      async cancel() {
        await events.return(undefined);
      },
    });
    return new Response(stream, {
      headers: { "Content-Type": "text/event-stream; charset=utf-8", "Cache-Control": "no-cache, no-transform", "X-Accel-Buffering": "no" },
    });
  });

  app.get("/api/history", async (c) => {
    const sessionId = c.req.query("session_id") ?? "";
    const userId = c.req.query("user_id") ?? sessionId;
    if (!ID_RE.test(sessionId) || !ID_RE.test(userId)) return c.json({ messages: [], error: "bad id" }, 422);
    try {
      const rows = await (await getStore()).history(userId, sessionId);
      return c.json({ messages: rows.map((m) => ({ id: m.id, role: m.role, content: m.content, created_at: m.createdAt, meta: m.meta })) });
    } catch (err) {
      return c.json({ messages: [], error: err instanceof StoreError ? err.message : "memory store failed" }, 503);
    }
  });

  app.get("/api/health", async (c) =>
    c.json({
      ok: true,
      time: toIso(new Date()),
      model: settings.llmModel,
      llm_key: Boolean(settings.llmApiKey),
      search_key: Boolean(settings.tavilyApiKey),
      memory: (await getStore()).kind,
    }),
  );

  // Model ids the configured key can use. For picking LLM_MODEL.
  app.get("/api/models", async (c) => {
    try {
      const resp = await fetchFn(`${settings.llmBaseUrl}/models`, {
        headers: { Authorization: `Bearer ${settings.llmApiKey}` },
        signal: AbortSignal.timeout(10_000),
      });
      const data: any = await resp.json();
      return c.json({ configured: settings.llmModel, status: resp.status, available: (data?.data ?? []).map((m: any) => m.id).sort() });
    } catch (err) {
      return c.json({ configured: settings.llmModel, error: (err as Error).name }, 502);
    }
  });

  return app;
}
