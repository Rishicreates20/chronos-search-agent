import asyncio
import sqlite3
from datetime import datetime, timedelta, timezone
from zoneinfo import ZoneInfo

import pytest

from app import temporal
from app.memory import MemoryStore, to_iso

NOW = datetime(2026, 11, 11, 15, 36, 2, tzinfo=timezone.utc)
UTC = ZoneInfo("UTC")
IST = ZoneInfo("Asia/Kolkata")


@pytest.fixture
def store():
    s = MemoryStore(":memory:")
    yield s
    s.close()


def seed(store):
    store.add("s1", "user", "Who won the 2022 World Cup?", NOW - timedelta(days=1, hours=2))
    store.add("s1", "assistant", "Argentina won it.", NOW - timedelta(days=1, hours=2) + timedelta(seconds=2))
    store.add("s1", "user", "What is the price of bitcoin?", NOW - timedelta(minutes=5))
    store.add("s1", "assistant", "About $100k.", NOW - timedelta(minutes=5) + timedelta(seconds=1))
    store.add("s1", "user", "Explain python decorators", NOW - timedelta(seconds=40))
    return store.add("s1", "user", "current question", NOW)


def test_timestamps_are_iso_utc_and_immutable(store):
    m = store.add("s1", "user", "hello", NOW)
    assert m.created_at == "2026-11-11T15:36:02.000Z"
    assert m.dt == NOW
    with pytest.raises(sqlite3.DatabaseError):
        store._db.execute("UPDATE messages SET created_at='2000-01-01T00:00:00.000Z'")
    with pytest.raises(sqlite3.DatabaseError):
        store._db.execute("UPDATE messages SET content='edited'")


def test_wal_mode_on_disk(tmp_path):
    s = MemoryStore(str(tmp_path / "db" / "chronos.db"))
    assert s._db.execute("PRAGMA journal_mode").fetchone()[0] == "wal"
    s.close()


def test_recent_window_is_chronological_and_excludes_current(store):
    cur = seed(store)
    rows = store.recent("s1", 3, before_id=cur.id)
    assert [m.content for m in rows] == ["What is the price of bitcoin?", "About $100k.", "Explain python decorators"]


def test_fts_search_with_stemming(store):
    seed(store)
    hits = store.search(["decorator"])
    assert [m.content for m in hits] == ["Explain python decorators"]
    assert store.search(['"; DROP TABLE']) == []  # hostile input never raises
    assert store.search([]) == []


def test_in_range(store):
    seed(store)
    rows, total = store.in_range(NOW - timedelta(minutes=8), NOW - timedelta(minutes=2))
    assert total == 2 and rows[0].content == "What is the price of bitcoin?"


@pytest.mark.parametrize(
    "text,start,end",
    [
        ("what did we discuss yesterday?", "2026-11-10T00:00:00.000Z", "2026-11-11T00:00:00.000Z"),
        ("summarize today's questions", "2026-11-11T00:00:00.000Z", "2026-11-11T15:36:02.000Z"),
        ("what did I ask 5 minutes ago?", "2026-11-11T15:28:32.000Z", "2026-11-11T15:33:32.000Z"),
        ("what did I ask in the last 2 hours", "2026-11-11T13:36:02.000Z", "2026-11-11T15:36:02.000Z"),
        ("what did I ask an hour ago", "2026-11-11T14:06:02.000Z", "2026-11-11T15:06:02.000Z"),
        ("what did I ask 2 days ago", "2026-11-09T00:00:00.000Z", "2026-11-10T00:00:00.000Z"),
        ("what did I ask on 2026-11-03?", "2026-11-03T00:00:00.000Z", "2026-11-04T00:00:00.000Z"),
        ("what did we talk about on monday", "2026-11-09T00:00:00.000Z", "2026-11-10T00:00:00.000Z"),
    ],
)
def test_parse_range_utc(text, start, end):
    s, e, _ = temporal.parse_range(text, NOW, UTC)
    assert (to_iso(s), to_iso(e)) == (start, end)


def test_parse_range_uses_user_timezone():
    # 15:36 UTC is 21:06 IST; "yesterday" must be the IST calendar day.
    s, e, _ = temporal.parse_range("what did I ask yesterday", NOW, IST)
    assert (to_iso(s), to_iso(e)) == ("2026-11-09T18:30:00.000Z", "2026-11-10T18:30:00.000Z")


def test_recall_detection():
    assert temporal.analyze("What did I ask earlier?", NOW, UTC).is_recall
    assert temporal.analyze("When did I ask about bitcoin?", NOW, UTC).keywords == ["bitcoin"]
    assert not temporal.analyze("What is the capital of France?", NOW, UTC).is_recall
    assert not temporal.analyze("Latest news on the Mars mission", NOW, UTC).is_recall


def test_tag_has_exact_local_time_and_age():
    t = temporal.tag(NOW - timedelta(minutes=5), IST, NOW)
    assert t == "[2026-11-11 21:01:02 IST · 5 min ago]"


def recall_block(store, text, session="s1"):
    """What the agent does for one turn: analyze, one store call, render."""
    r = temporal.analyze(text, NOW, UTC)
    ctx = asyncio.run(
        store.begin_turn(session, text, NOW, 20, start=r.start, end=r.end, terms=r.keywords, log_limit=40)
    )
    return temporal.build_recall_block(r, ctx, NOW, UTC)


def seed_past(store):
    seed(store)
    store._db.execute("DELETE FROM messages WHERE content='current question'")


def test_recall_block_range_keyword_and_log(store):
    seed_past(store)
    block = recall_block(store, "what did I ask 5 minutes ago?")
    assert "[2026-11-11 15:31:02 UTC · 5 min ago] USER: What is the price of bitcoin?" in block
    assert "what did I ask 5 minutes ago?" not in block  # the current message is never recalled

    block = recall_block(store, "when did I ask about the world cup?", session="other-session")
    assert "[2026-11-10 13:36:02 UTC · 1d 2h ago] USER: Who won the 2022 World Cup?" in block
    assert "no earlier user questions" in block


def test_recall_block_states_empty_range(store):
    seed_past(store)
    block = recall_block(store, "what did we discuss last week?")
    assert "Nothing was recorded in this range." in block
