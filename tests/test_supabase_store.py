"""The hosted store speaks to Postgres through three RPC functions. These
tests pin the requests it sends and how it reads the replies; the SQL side
is in supabase/schema.sql."""
import asyncio
import json
from datetime import datetime, timezone

import httpx
import pytest
from fastapi.testclient import TestClient

from app.main import create_app
from app.memory import MemoryStore, StoreError, SupabaseStore, open_store

from conftest import make_settings, sse_body, text_chunks

NOW = datetime(2026, 11, 11, 15, 36, 2, 123000, tzinfo=timezone.utc)


def row(i, role, content, ts="2026-11-11T15:36:02.123Z", meta=None):
    return {"id": i, "session_id": "s1", "role": role, "content": content, "created_at": ts, "meta": meta}


def test_open_store_picks_backend():
    client = httpx.AsyncClient()
    assert isinstance(open_store(make_settings(), client), MemoryStore)
    hosted = make_settings(supabase_url="https://db.test", supabase_key="k", memory_token="t")
    assert isinstance(open_store(hosted, client), SupabaseStore)


def test_begin_turn_is_one_authenticated_call():
    seen = []

    def handler(request):
        seen.append(request)
        return httpx.Response(200, json={
            "user": row(3, "user", "what did I ask yesterday?"),
            "recent": [row(1, "user", "hi"), row(2, "assistant", "hello", meta={"searched": False})],
            "range_rows": [row(1, "user", "hi")], "range_total": 1, "hits": [], "log": [row(1, "user", "hi")],
        })

    async def go():
        async with httpx.AsyncClient(transport=httpx.MockTransport(handler)) as client:
            store = SupabaseStore(client, "https://db.test/", "pub-key", "mem-token")
            return await store.begin_turn("s1", "what did I ask yesterday?", NOW, 20, start=NOW, end=NOW, terms=["x"], log_limit=40)

    ctx = asyncio.run(go())
    assert len(seen) == 1
    req = seen[0]
    assert str(req.url) == "https://db.test/rest/v1/rpc/chronos_begin_turn"
    assert req.headers["apikey"] == "pub-key" and req.headers["authorization"] == "Bearer pub-key"
    body = json.loads(req.content)
    assert body["p_token"] == "mem-token" and body["p_created_at"] == "2026-11-11T15:36:02.123Z"
    assert body["p_window"] == 20 and body["p_terms"] == ["x"] and body["p_log_limit"] == 40
    assert ctx.user.id == 3 and ctx.user.dt == NOW
    assert [m.content for m in ctx.recent] == ["hi", "hello"] and ctx.recent[1].meta == {"searched": False}
    assert ctx.range_total == 1 and ctx.log[0].content == "hi"


def test_errors_become_store_errors():
    async def go(handler):
        async with httpx.AsyncClient(transport=httpx.MockTransport(handler)) as client:
            await SupabaseStore(client, "https://db.test", "k", "bad").load_history("s1")

    with pytest.raises(StoreError, match="invalid memory token"):
        asyncio.run(go(lambda r: httpx.Response(403, json={"message": "invalid memory token"})))

    def down(request):
        raise httpx.ConnectError("no route")

    with pytest.raises(StoreError, match="unreachable"):
        asyncio.run(go(down))


def test_full_turn_against_hosted_store(tmp_path):
    """Chat end to end with the hosted backend: the question is stored
    first, the answer after, and nothing touches local disk."""
    calls = []

    def handler(request):
        if request.url.host == "llm.test":
            return httpx.Response(200, content=sse_body(text_chunks("Paris.")))
        fn = request.url.path.rsplit("/", 1)[-1]
        body = json.loads(request.content)
        calls.append((fn, body))
        if fn == "chronos_begin_turn":
            return httpx.Response(200, json={"user": row(1, "user", body["p_content"]), "recent": [],
                                             "range_rows": [], "range_total": 0, "hits": [], "log": []})
        if fn == "chronos_save":
            return httpx.Response(200, json=row(2, body["p_role"], body["p_content"], meta=body["p_meta"]))
        return httpx.Response(200, json=[row(1, "user", "q"), row(2, "assistant", "Paris.")])

    db = tmp_path / "never.db"
    settings = make_settings(str(db), supabase_url="https://db.test", supabase_key="k", memory_token="t")
    with TestClient(create_app(settings, transport=httpx.MockTransport(handler))) as c:
        assert c.get("/api/health").json()["memory"] == "supabase"
        with c.stream("POST", "/api/chat", json={"session_id": "s1", "message": "Capital of France?"}) as r:
            events = [json.loads(l[6:]) for l in r.iter_lines() if l.startswith("data: ")]
        assert len(c.get("/api/history", params={"session_id": "s1"}).json()["messages"]) == 2

    assert [e["type"] for e in events][0] == "meta" and events[-1]["assistant_message_id"] == 2
    assert [fn for fn, _ in calls] == ["chronos_begin_turn", "chronos_save", "chronos_history"]
    assert calls[1][1]["p_role"] == "assistant" and calls[1][1]["p_content"] == "Paris."
    assert not db.exists()


def test_store_outage_is_reported_not_crashed(tmp_path):
    def handler(request):
        return httpx.Response(503, json={"message": "database is paused"})

    settings = make_settings(str(tmp_path / "x.db"), supabase_url="https://db.test", supabase_key="k", memory_token="t")
    with TestClient(create_app(settings, transport=httpx.MockTransport(handler))) as c:
        with c.stream("POST", "/api/chat", json={"session_id": "s1", "message": "hi"}) as r:
            events = [json.loads(l[6:]) for l in r.iter_lines() if l.startswith("data: ")]
        assert c.get("/api/history", params={"session_id": "s1"}).status_code == 503
    assert [e["type"] for e in events] == ["error", "done"]
    assert "database is paused" in events[0]["message"]
