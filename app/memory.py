"""Temporal memory.

Every message is stored once with an immutable ISO-8601 UTC timestamp.
Three access paths cover recall:
  * recent     - sliding window of the current session
  * time range - exact lookup ("yesterday", "5 minutes ago")
  * keywords   - full-text lookup ("when did I ask about X?")

Two interchangeable backends implement the same three async methods
(begin_turn, save, load_history):
  * MemoryStore   - a local SQLite file (WAL + FTS5). The default.
  * SupabaseStore - hosted Postgres, for serverless hosts with no durable disk.
"""
from __future__ import annotations

import json
import re
import sqlite3
import threading

import httpx
from dataclasses import dataclass, field
from datetime import datetime, timezone
from pathlib import Path

SCHEMA = """
CREATE TABLE IF NOT EXISTS messages (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    session_id TEXT NOT NULL,
    role       TEXT CHECK(role IN ('user', 'assistant')) NOT NULL,
    content    TEXT NOT NULL,
    created_at TEXT NOT NULL,          -- ISO-8601 UTC: 2026-11-11T15:36:00.000Z
    meta       TEXT                    -- JSON: sources, latency (UI only)
);
CREATE INDEX IF NOT EXISTS idx_messages_time ON messages(session_id, created_at);
CREATE INDEX IF NOT EXISTS idx_messages_created ON messages(created_at);

CREATE VIRTUAL TABLE IF NOT EXISTS messages_fts USING fts5(
    content, content='messages', content_rowid='id', tokenize='porter unicode61'
);
CREATE TRIGGER IF NOT EXISTS messages_ai AFTER INSERT ON messages BEGIN
    INSERT INTO messages_fts(rowid, content) VALUES (new.id, new.content);
END;
CREATE TRIGGER IF NOT EXISTS messages_ad AFTER DELETE ON messages BEGIN
    INSERT INTO messages_fts(messages_fts, rowid, content)
    VALUES ('delete', old.id, old.content);
END;
-- The record of what was said, and when, can never be rewritten.
CREATE TRIGGER IF NOT EXISTS messages_immutable BEFORE UPDATE ON messages BEGIN
    SELECT RAISE(ABORT, 'messages are immutable');
END;
"""

_COLS = "id, session_id, role, content, created_at, meta"


def utcnow() -> datetime:
    return datetime.now(timezone.utc)


def to_iso(dt: datetime) -> str:
    """Fixed-width, millisecond ISO-8601 UTC, so string order == time order."""
    dt = dt.astimezone(timezone.utc)
    return dt.strftime("%Y-%m-%dT%H:%M:%S.") + f"{dt.microsecond // 1000:03d}Z"


def from_iso(value: str) -> datetime:
    return datetime.fromisoformat(value.replace("Z", "+00:00"))


@dataclass
class Message:
    id: int
    session_id: str
    role: str
    content: str
    created_at: str
    meta: dict = field(default_factory=dict)

    @property
    def dt(self) -> datetime:
        return from_iso(self.created_at)

    def public(self) -> dict:
        return {
            "id": self.id,
            "role": self.role,
            "content": self.content,
            "created_at": self.created_at,
            "meta": self.meta,
        }


@dataclass
class TurnContext:
    """Everything one turn needs from memory, fetched in one go."""

    user: Message                                   # the message just stored
    recent: list[Message] = field(default_factory=list)
    range_rows: list[Message] = field(default_factory=list)
    range_total: int = 0
    hits: list[Message] = field(default_factory=list)
    log: list[Message] = field(default_factory=list)


class StoreError(Exception):
    pass


def _row(row: tuple) -> Message:
    return Message(row[0], row[1], row[2], row[3], row[4], json.loads(row[5]) if row[5] else {})


class MemoryStore:
    def __init__(self, path: str):
        if path != ":memory:":
            Path(path).parent.mkdir(parents=True, exist_ok=True)
        # One shared connection guarded by a lock: every statement here is a
        # sub-millisecond indexed lookup, so calling it inline from the event
        # loop is cheaper than a thread hop.
        self._db = sqlite3.connect(path, check_same_thread=False)
        self._lock = threading.Lock()
        self._db.execute("PRAGMA journal_mode=WAL")
        self._db.execute("PRAGMA synchronous=NORMAL")
        self._db.execute("PRAGMA busy_timeout=3000")
        self._db.executescript(SCHEMA)
        self._db.commit()

    kind = "sqlite"

    def close(self) -> None:
        self._db.close()

    # -- async interface shared with SupabaseStore ---------------------------
    async def begin_turn(
        self, session_id: str, content: str, created_at: datetime, window: int,
        start: datetime | None = None, end: datetime | None = None,
        terms: list[str] | None = None, log_limit: int = 0,
    ) -> TurnContext:
        """Store the user's message and load the memory this turn needs."""
        user = self.add(session_id, "user", content, created_at=created_at)
        ctx = TurnContext(user=user, recent=self.recent(session_id, window, before_id=user.id))
        if start and end:
            ctx.range_rows, ctx.range_total = self.in_range(start, end, limit=40, exclude_id=user.id)
        if terms:
            ctx.hits = sorted(self.search(terms, limit=8, exclude_id=user.id), key=lambda m: m.id)
        if log_limit:
            ctx.log = self.session_log(session_id, limit=log_limit, exclude_id=user.id)
        return ctx

    async def save(self, session_id: str, role: str, content: str, meta: dict | None = None) -> Message:
        return self.add(session_id, role, content, meta=meta)

    async def load_history(self, session_id: str, limit: int = 500) -> list[Message]:
        return self.recent(session_id, limit)

    async def aclose(self) -> None:
        self.close()

    def _all(self, sql: str, params: tuple) -> list[Message]:
        with self._lock:
            return [_row(r) for r in self._db.execute(sql, params).fetchall()]

    # -- writes ------------------------------------------------------------
    def add(
        self,
        session_id: str,
        role: str,
        content: str,
        created_at: datetime | None = None,
        meta: dict | None = None,
    ) -> Message:
        ts = to_iso(created_at or utcnow())
        with self._lock:
            cur = self._db.execute(
                "INSERT INTO messages(session_id, role, content, created_at, meta) VALUES (?,?,?,?,?)",
                (session_id, role, content, ts, json.dumps(meta) if meta else None),
            )
            self._db.commit()
            return Message(cur.lastrowid, session_id, role, content, ts, meta or {})

    # -- reads -------------------------------------------------------------
    def recent(self, session_id: str, limit: int, before_id: int | None = None) -> list[Message]:
        """Last `limit` messages of a session, oldest first."""
        rows = self._all(
            f"SELECT {_COLS} FROM messages WHERE session_id=? AND id < ? ORDER BY id DESC LIMIT ?",
            (session_id, before_id if before_id is not None else 1 << 62, limit),
        )
        return rows[::-1]

    def in_range(
        self, start: datetime, end: datetime, limit: int = 40, exclude_id: int | None = None
    ) -> tuple[list[Message], int]:
        """Messages with start <= created_at < end (all sessions), oldest first.

        Returns (rows, total) so the caller can say when a range was truncated.
        """
        args = (to_iso(start), to_iso(end), exclude_id or -1)
        where = "created_at >= ? AND created_at < ? AND id != ?"
        with self._lock:
            total = self._db.execute(f"SELECT COUNT(*) FROM messages WHERE {where}", args).fetchone()[0]
        rows = self._all(
            f"SELECT {_COLS} FROM messages WHERE {where} ORDER BY created_at, id LIMIT ?",
            args + (limit,),
        )
        return rows, total

    def search(self, keywords: list[str], limit: int = 8, exclude_id: int | None = None) -> list[Message]:
        """FTS5 keyword match (all sessions), best BM25 rank first."""
        terms = [re.sub(r'[^\w]', "", k) for k in keywords]
        terms = [t for t in terms if t]
        if not terms:
            return []
        query = " OR ".join(f'"{t}"' for t in terms)
        cols = ", ".join(f"m.{c}" for c in _COLS.split(", "))
        try:
            return self._all(
                f"SELECT {cols} FROM messages_fts f JOIN messages m ON m.id = f.rowid "
                "WHERE messages_fts MATCH ? AND m.id != ? ORDER BY bm25(messages_fts), m.id DESC LIMIT ?",
                (query, exclude_id or -1, limit),
            )
        except sqlite3.OperationalError:
            return []

    def session_log(self, session_id: str, limit: int = 40, exclude_id: int | None = None) -> list[Message]:
        """The user's own questions in this session, chronological."""
        rows = self._all(
            f"SELECT {_COLS} FROM messages WHERE session_id=? AND role='user' AND id != ? "
            "ORDER BY id DESC LIMIT ?",
            (session_id, exclude_id or -1, limit),
        )
        return rows[::-1]


def _msg(d: dict) -> Message:
    return Message(d["id"], d["session_id"], d["role"], d["content"], d["created_at"], d.get("meta") or {})


class SupabaseStore:
    """Durable memory in hosted Postgres, reached over Supabase's REST API.

    The schema and functions are in supabase/schema.sql. A turn costs two
    HTTP calls: chronos_begin_turn (store the question, fetch all context)
    and chronos_save (store the answer).
    """

    kind = "supabase"

    def __init__(self, client: httpx.AsyncClient, url: str, key: str, token: str):
        self._client = client
        self._rpc = url.rstrip("/") + "/rest/v1/rpc/"
        self._headers = {"apikey": key, "Authorization": f"Bearer {key}"}
        self._token = token

    async def _call(self, fn: str, args: dict):
        try:
            resp = await self._client.post(
                self._rpc + fn, headers=self._headers, json={"p_token": self._token, **args}, timeout=8
            )
        except httpx.HTTPError as exc:
            raise StoreError(f"Memory store unreachable ({type(exc).__name__}).") from exc
        if resp.status_code != 200:
            try:
                detail = resp.json().get("message", "")
            except Exception:
                detail = resp.text[:200]
            raise StoreError(f"Memory store returned HTTP {resp.status_code}: {detail}")
        return resp.json()

    async def begin_turn(
        self, session_id: str, content: str, created_at: datetime, window: int,
        start: datetime | None = None, end: datetime | None = None,
        terms: list[str] | None = None, log_limit: int = 0,
    ) -> TurnContext:
        data = await self._call(
            "chronos_begin_turn",
            {
                "p_session_id": session_id,
                "p_content": content,
                "p_created_at": to_iso(created_at),
                "p_window": window,
                "p_start": to_iso(start) if start and end else None,
                "p_end": to_iso(end) if start and end else None,
                "p_terms": terms or None,
                "p_log_limit": log_limit,
            },
        )
        return TurnContext(
            user=_msg(data["user"]),
            recent=[_msg(d) for d in data["recent"]],
            range_rows=[_msg(d) for d in data["range_rows"]],
            range_total=data["range_total"],
            hits=[_msg(d) for d in data["hits"]],
            log=[_msg(d) for d in data["log"]],
        )

    async def save(self, session_id: str, role: str, content: str, meta: dict | None = None) -> Message:
        data = await self._call(
            "chronos_save",
            {
                "p_session_id": session_id,
                "p_role": role,
                "p_content": content,
                "p_created_at": to_iso(utcnow()),
                "p_meta": meta,
            },
        )
        return _msg(data)

    async def load_history(self, session_id: str, limit: int = 500) -> list[Message]:
        return [_msg(d) for d in await self._call("chronos_history", {"p_session_id": session_id, "p_limit": limit})]

    async def aclose(self) -> None:
        pass


def open_store(settings, client: httpx.AsyncClient):
    """Supabase when it is configured, otherwise the local SQLite file."""
    if settings.supabase_url and settings.supabase_key and settings.memory_token:
        return SupabaseStore(client, settings.supabase_url, settings.supabase_key, settings.memory_token)
    return MemoryStore(settings.db_path)
