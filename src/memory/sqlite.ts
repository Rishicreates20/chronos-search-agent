// Local memory: one SQLite file (WAL) with an FTS5 index, using Node's
// built-in driver so `npm install` never has to compile anything.
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { HIT_LIMIT, RANGE_LIMIT, toIso, type MemoryStore, type Message, type Role, type TurnContext, type TurnRequest } from "./types.js";

const SCHEMA = `
CREATE TABLE IF NOT EXISTS messages (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id    TEXT NOT NULL,
    session_id TEXT NOT NULL,
    role       TEXT CHECK(role IN ('user', 'assistant')) NOT NULL,
    content    TEXT NOT NULL,
    created_at TEXT NOT NULL,          -- ISO-8601 UTC: 2026-11-11T15:36:02.123Z
    meta       TEXT                    -- JSON: sources, latency (UI only)
);
CREATE INDEX IF NOT EXISTS idx_messages_session ON messages(user_id, session_id, id);
CREATE INDEX IF NOT EXISTS idx_messages_time ON messages(user_id, created_at);

CREATE VIRTUAL TABLE IF NOT EXISTS messages_fts USING fts5(
    content, content='messages', content_rowid='id', tokenize='porter unicode61'
);
CREATE TRIGGER IF NOT EXISTS messages_ai AFTER INSERT ON messages BEGIN
    INSERT INTO messages_fts(rowid, content) VALUES (new.id, new.content);
END;
CREATE TRIGGER IF NOT EXISTS messages_ad AFTER DELETE ON messages BEGIN
    INSERT INTO messages_fts(messages_fts, rowid, content) VALUES ('delete', old.id, old.content);
END;
-- The record of what was said, and when, can never be rewritten.
CREATE TRIGGER IF NOT EXISTS messages_immutable BEFORE UPDATE ON messages BEGIN
    SELECT RAISE(ABORT, 'messages are immutable');
END;
`;

const COLS = "id, user_id, session_id, role, content, created_at, meta";

type Row = { id: number; user_id: string; session_id: string; role: Role; content: string; created_at: string; meta: string | null };

const fromRow = (r: Row): Message => ({
  id: Number(r.id),
  userId: r.user_id,
  sessionId: r.session_id,
  role: r.role,
  content: r.content,
  createdAt: r.created_at,
  meta: r.meta ? JSON.parse(r.meta) : {},
});

export class SqliteStore implements MemoryStore {
  readonly kind = "sqlite" as const;
  readonly db: DatabaseSync;

  constructor(path: string) {
    if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
    this.db = new DatabaseSync(path);
    this.db.exec("PRAGMA journal_mode=WAL; PRAGMA synchronous=NORMAL; PRAGMA busy_timeout=3000;");
    this.db.exec(SCHEMA);
  }

  private all(sql: string, ...params: (string | number)[]): Message[] {
    return (this.db.prepare(sql).all(...params) as unknown as Row[]).map(fromRow);
  }

  add(userId: string, sessionId: string, role: Role, content: string, createdAt = new Date(), meta?: Record<string, unknown>): Message {
    const ts = toIso(createdAt);
    const res = this.db
      .prepare("INSERT INTO messages(user_id, session_id, role, content, created_at, meta) VALUES (?,?,?,?,?,?)")
      .run(userId, sessionId, role, content, ts, meta ? JSON.stringify(meta) : null);
    return { id: Number(res.lastInsertRowid), userId, sessionId, role, content, createdAt: ts, meta: meta ?? {} };
  }

  /** Last `limit` messages of a session before `beforeId`, oldest first. */
  recent(userId: string, sessionId: string, limit: number, beforeId = Number.MAX_SAFE_INTEGER): Message[] {
    return this.all(
      `SELECT ${COLS} FROM messages WHERE user_id=? AND session_id=? AND id < ? ORDER BY id DESC LIMIT ?`,
      userId, sessionId, beforeId, limit,
    ).reverse();
  }

  inRange(userId: string, start: Date, end: Date, excludeId = -1): { rows: Message[]; total: number } {
    const where = "user_id=? AND created_at >= ? AND created_at < ? AND id != ?";
    const args = [userId, toIso(start), toIso(end), excludeId] as const;
    const total = Number((this.db.prepare(`SELECT COUNT(*) AS n FROM messages WHERE ${where}`).get(...args) as { n: number }).n);
    const rows = this.all(`SELECT ${COLS} FROM messages WHERE ${where} ORDER BY created_at, id LIMIT ?`, ...args, RANGE_LIMIT);
    return { rows, total };
  }

  /** FTS5 keyword match, best BM25 rank first, then completed into turns:
   * a matched question brings its answer and vice versa, because "what did
   * you tell me about X" needs both halves. Returned oldest first. */
  search(userId: string, terms: string[], excludeId = -1): Message[] {
    const clean = terms.map((t) => t.replace(/[^\p{L}\p{N}_]/gu, "")).filter(Boolean);
    if (!clean.length) return [];
    const query = clean.map((t) => `"${t}"`).join(" OR ");
    let hits: Message[];
    try {
      hits = this.all(
        `SELECT ${COLS.split(", ").map((c) => "m." + c).join(", ")} FROM messages_fts f JOIN messages m ON m.id = f.rowid
         WHERE messages_fts MATCH ? AND m.user_id = ? AND m.id != ? ORDER BY bm25(messages_fts), m.id DESC LIMIT ?`,
        query, userId, excludeId, HIT_LIMIT,
      );
    } catch {
      return [];
    }
    const byId = new Map(hits.map((m) => [m.id, m]));
    for (const m of hits) {
      const partner =
        m.role === "user"
          ? this.all(`SELECT ${COLS} FROM messages WHERE user_id=? AND session_id=? AND id > ? ORDER BY id LIMIT 1`, userId, m.sessionId, m.id)
          : this.all(`SELECT ${COLS} FROM messages WHERE user_id=? AND session_id=? AND id < ? ORDER BY id DESC LIMIT 1`, userId, m.sessionId, m.id);
      const p = partner[0];
      if (p && p.role !== m.role && p.id !== excludeId) byId.set(p.id, p);
    }
    return [...byId.values()].sort((a, b) => a.id - b.id);
  }

  sessionLog(userId: string, sessionId: string, limit: number, excludeId = -1): Message[] {
    return this.all(
      `SELECT ${COLS} FROM messages WHERE user_id=? AND session_id=? AND role='user' AND id != ? ORDER BY id DESC LIMIT ?`,
      userId, sessionId, excludeId, limit,
    ).reverse();
  }

  // -- MemoryStore ----------------------------------------------------------
  async beginTurn(req: TurnRequest): Promise<TurnContext> {
    const user = this.add(req.userId, req.sessionId, "user", req.content, req.createdAt);
    const ctx: TurnContext = {
      user,
      recent: this.recent(req.userId, req.sessionId, req.window, user.id),
      rangeRows: [],
      rangeTotal: 0,
      hits: [],
      log: [],
    };
    if (req.range) {
      const r = this.inRange(req.userId, req.range.start, req.range.end, user.id);
      ctx.rangeRows = r.rows;
      ctx.rangeTotal = r.total;
    }
    if (req.terms?.length) ctx.hits = this.search(req.userId, req.terms, user.id);
    if (req.logLimit) ctx.log = this.sessionLog(req.userId, req.sessionId, req.logLimit, user.id);
    return ctx;
  }

  async save(msg: { userId: string; sessionId: string; role: Role; content: string; meta?: Record<string, unknown>; createdAt?: Date }): Promise<Message> {
    return this.add(msg.userId, msg.sessionId, msg.role, msg.content, msg.createdAt, msg.meta);
  }

  async history(userId: string, sessionId: string, limit = 500): Promise<Message[]> {
    return this.recent(userId, sessionId, limit);
  }

  async close(): Promise<void> {
    this.db.close();
  }
}
