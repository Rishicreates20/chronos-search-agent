// Hosted memory: Postgres on Supabase, for serverless hosts with no durable
// disk. Schema and functions are in supabase/schema.sql. A turn costs two
// HTTP calls: chronos_begin_turn (store the question, fetch all context)
// and chronos_save (store the answer).
import { StoreError, toIso, type MemoryStore, type Message, type Role, type TurnContext, type TurnRequest } from "./types.js";

type Wire = { id: number; user_id: string; session_id: string; role: Role; content: string; created_at: string; meta: Record<string, unknown> | null };

const fromWire = (d: Wire): Message => ({
  id: d.id,
  userId: d.user_id,
  sessionId: d.session_id,
  role: d.role,
  content: d.content,
  createdAt: d.created_at,
  meta: d.meta ?? {},
});

export class SupabaseStore implements MemoryStore {
  readonly kind = "supabase" as const;
  private rpc: string;
  private headers: Record<string, string>;

  constructor(url: string, key: string, private token: string, private fetchFn: typeof fetch = fetch) {
    this.rpc = url.replace(/\/+$/, "") + "/rest/v1/rpc/";
    this.headers = { apikey: key, Authorization: `Bearer ${key}`, "Content-Type": "application/json" };
  }

  private async call<T>(fn: string, args: Record<string, unknown>): Promise<T> {
    let resp: Response;
    try {
      resp = await this.fetchFn(this.rpc + fn, {
        method: "POST",
        headers: this.headers,
        body: JSON.stringify({ p_token: this.token, ...args }),
        signal: AbortSignal.timeout(8000),
      });
    } catch (err) {
      throw new StoreError(`Memory store unreachable (${(err as Error).name}).`);
    }
    if (!resp.ok) {
      const body = await resp.text();
      let detail = body.slice(0, 200);
      try {
        detail = JSON.parse(body).message ?? detail;
      } catch {}
      throw new StoreError(`Memory store returned HTTP ${resp.status}: ${detail}`);
    }
    return (await resp.json()) as T;
  }

  async beginTurn(req: TurnRequest): Promise<TurnContext> {
    const d = await this.call<{ user: Wire; recent: Wire[]; range_rows: Wire[]; range_total: number; hits: Wire[]; log: Wire[] }>(
      "chronos_begin_turn",
      {
        p_user_id: req.userId,
        p_session_id: req.sessionId,
        p_content: req.content,
        p_created_at: toIso(req.createdAt),
        p_window: req.window,
        p_start: req.range ? toIso(req.range.start) : null,
        p_end: req.range ? toIso(req.range.end) : null,
        p_terms: req.terms?.length ? req.terms : null,
        p_log_limit: req.logLimit ?? 0,
      },
    );
    return {
      user: fromWire(d.user),
      recent: d.recent.map(fromWire),
      rangeRows: d.range_rows.map(fromWire),
      rangeTotal: d.range_total,
      hits: d.hits.map(fromWire),
      log: d.log.map(fromWire),
    };
  }

  async save(msg: { userId: string; sessionId: string; role: Role; content: string; meta?: Record<string, unknown>; createdAt?: Date }): Promise<Message> {
    return fromWire(
      await this.call<Wire>("chronos_save", {
        p_user_id: msg.userId,
        p_session_id: msg.sessionId,
        p_role: msg.role,
        p_content: msg.content,
        p_created_at: toIso(msg.createdAt ?? new Date()),
        p_meta: msg.meta ?? null,
      }),
    );
  }

  async history(userId: string, sessionId: string, limit = 500): Promise<Message[]> {
    const rows = await this.call<Wire[]>("chronos_history", { p_user_id: userId, p_session_id: sessionId, p_limit: limit });
    return rows.map(fromWire);
  }

  async close(): Promise<void> {}
}
