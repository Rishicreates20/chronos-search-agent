"""End-to-end through the real FastAPI app and SSE stream, with the LLM and
search API scripted. These are the PRD's acceptance criteria as tests."""
import json
from datetime import timedelta

import httpx
from fastapi.testclient import TestClient

from app.main import create_app
from app.memory import utcnow

from conftest import make_settings, text_chunks, tool_chunks


def chat(client, message, session="s1", tz="UTC"):
    events = []
    with client.stream("POST", "/api/chat", json={"session_id": session, "message": message, "timezone": tz}) as r:
        assert r.status_code == 200
        assert r.headers["content-type"].startswith("text/event-stream")
        for line in r.iter_lines():
            if line.startswith("data: "):
                events.append(json.loads(line[6:]))
    return events


def answer(events):
    return "".join(e["text"] for e in events if e["type"] == "token")


def make_client(backend, tmp_path, **over):
    settings = make_settings(str(tmp_path / "t.db"), **over)
    return TestClient(create_app(settings, transport=backend.transport))


def test_direct_answer_streams_without_search(backend, tmp_path):
    backend.llm_script = [text_chunks("Hello! How can I help?")]
    with make_client(backend, tmp_path) as c:
        events = chat(c, "hi")
    assert [e["type"] for e in events][0] == "meta"
    assert sum(e["type"] == "token" for e in events) > 1  # token by token
    assert answer(events) == "Hello! How can I help?"
    done = events[-1]
    assert done["type"] == "done" and done["searched"] is False and done["ttft_ms"] is not None
    assert backend.search_requests == []


def test_exactly_one_tool_is_registered(backend, tmp_path):
    backend.llm_script = [text_chunks("ok")]
    with make_client(backend, tmp_path) as c:
        chat(c, "hi")
    tools = backend.llm_requests[0]["tools"]
    assert [t["function"]["name"] for t in tools] == ["web_search"]
    assert list(tools[0]["function"]["parameters"]["properties"]) == ["query"]


def test_search_flow_cites_real_urls_and_strips_fabricated_ones(backend, tmp_path):
    backend.search_results = [
        {"title": "Fed holds rates", "url": "https://reuters.com/fed", "content": "The Fed held rates steady."}
    ]
    backend.llm_script = [
        tool_chunks("fed rate decision 2026"),
        text_chunks(
            "The Fed held rates [Reuters](https://reuters.com/fed). "
            "More at [Bloomberg](https://bloomberg.com/invented-article)."
        ),
    ]
    with make_client(backend, tmp_path) as c:
        events = chat(c, "what did the fed do today?")
        stored = c.get("/api/history", params={"session_id": "s1"}).json()["messages"]

    types = [e["type"] for e in events]
    assert types.index("status") < types.index("sources") < types.index("token")
    assert events[types.index("status")]["query"] == "fed rate decision 2026"
    text = answer(events)
    assert "[Reuters](https://reuters.com/fed)" in text
    assert "bloomberg.com" not in text and "More at Bloomberg." in text
    assert events[-1]["searched"] is True and events[-1]["removed_urls"] == 1
    assert backend.search_requests[0]["query"] == "fed rate decision 2026"
    assert backend.search_requests[0]["search_depth"] == "fast"
    assert "Citation rule" in backend.llm_requests[1]["messages"][-1]["content"]

    # The second LLM call saw the tool result, snippets included.
    tool_msg = backend.llm_requests[1]["messages"][-1]
    assert tool_msg["role"] == "tool" and "https://reuters.com/fed" in tool_msg["content"]

    # Both turns persisted with ISO-8601 UTC timestamps; stored text is the guarded text.
    assert [m["role"] for m in stored] == ["user", "assistant"]
    assert all(m["created_at"].endswith("Z") and "T" in m["created_at"] for m in stored)
    assert stored[1]["content"] == text
    assert stored[1]["meta"]["sources"] == [{"title": "Fed holds rates", "url": "https://reuters.com/fed"}]


def test_empty_results_force_explicit_uncertainty_instruction(backend, tmp_path):
    backend.search_results = []
    backend.llm_script = [tool_chunks("zzqx"), text_chunks("I could not find verified information on this.")]
    with make_client(backend, tmp_path) as c:
        events = chat(c, "what is zzqx?")
    assert "NO_RESULTS" in backend.llm_requests[1]["messages"][-1]["content"]
    assert answer(events) == "I could not find verified information on this."


def test_search_timeout_is_reported_and_handled(backend, tmp_path):
    backend.search_exception = httpx.ReadTimeout("slow")
    backend.llm_script = [tool_chunks("anything"), text_chunks("Live search timed out, so this is from my training knowledge.")]
    with make_client(backend, tmp_path) as c:
        events = chat(c, "latest news?")
    failed = [e for e in events if e["type"] == "status" and e["state"] == "search_failed"]
    assert failed and failed[0]["detail"] == "Search timed out"
    assert "SEARCH_TIMEOUT" in backend.llm_requests[1]["messages"][-1]["content"]
    assert events[-1]["type"] == "done"


def test_search_rounds_are_bounded(backend, tmp_path):
    backend.search_results = [{"title": "t", "url": "https://a.example/1", "content": "c"}]
    backend.llm_script = [tool_chunks("q1", "c1"), tool_chunks("q2", "c2"), text_chunks("final")]
    with make_client(backend, tmp_path) as c:
        events = chat(c, "dig deep")
    assert answer(events) == "final"
    assert len(backend.llm_requests) == 3
    # The last request declares no tool and carries both result sets as text.
    final = backend.llm_requests[2]
    assert "tools" not in final and "tool_choice" not in final
    assert all(m["role"] != "tool" and "tool_calls" not in m for m in final["messages"])
    assert final["messages"][-1]["content"].count("https://a.example/1") == 2


def test_history_is_injected_with_timestamp_tags(backend, tmp_path):
    backend.llm_script = [text_chunks("Paris."), text_chunks("You asked about France.")]
    with make_client(backend, tmp_path) as c:
        first = chat(c, "What is the capital of France?")
        chat(c, "And what did I ask earlier?")
    msgs = backend.llm_requests[1]["messages"]
    stamp = first[0]["created_at"]  # 2026-11-11T15:36:02.123Z
    local = stamp[:10] + " " + stamp[11:19]
    assert msgs[1]["role"] == "user" and msgs[1]["content"].startswith(f"[{local} UTC · ")
    assert msgs[1]["content"].endswith("What is the capital of France?")
    assert msgs[2]["role"] == "assistant" and msgs[2]["content"].endswith("Paris.")
    assert msgs[-1] == {"role": "user", "content": "And what did I ask earlier?"}
    system = msgs[0]["content"]
    assert "MEMORY RECALL" in system and f"[{local} UTC" in system
    assert "CURRENT TIME:" in system
    # Non-recall turns carry no recall block.
    assert "## MEMORY RECALL" not in backend.llm_requests[0]["messages"][0]["content"]


def test_recall_reaches_beyond_the_sliding_window_and_across_restarts(backend, tmp_path):
    settings = make_settings(str(tmp_path / "t.db"), history_turns=1)
    with TestClient(create_app(settings, transport=backend.transport)) as c:
        store = c.app.state.store
        store.add("old", "user", "How tall is Mount Kilimanjaro?", utcnow() - timedelta(days=1))
        store.add("old", "assistant", "5,895 m.", utcnow() - timedelta(days=1) + timedelta(seconds=1))
    backend.llm_script = [text_chunks("Yesterday you asked about Kilimanjaro.")]
    # New app instance on the same file = process restart.
    with TestClient(create_app(settings, transport=backend.transport)) as c:
        chat(c, "What did we discuss yesterday?", session="new")
    system = backend.llm_requests[0]["messages"][0]["content"]
    assert "USER: How tall is Mount Kilimanjaro?" in system
    assert 'Time range "yesterday"' in system and "2 stored message(s)" in system


def test_llm_failure_becomes_an_error_event(backend, tmp_path):
    def boom(request):
        return httpx.Response(401, json={"error": {"message": "API key not valid"}})

    settings = make_settings(str(tmp_path / "t.db"))
    with TestClient(create_app(settings, transport=httpx.MockTransport(boom))) as c:
        events = chat(c, "hi")
        stored = c.get("/api/history", params={"session_id": "s1"}).json()["messages"]
    err = [e for e in events if e["type"] == "error"]
    assert err and "401" in err[0]["message"] and "API key not valid" in err[0]["message"]
    assert events[-1]["type"] == "done"
    assert [m["role"] for m in stored] == ["user"]  # the question is still remembered


def test_request_validation(backend, tmp_path):
    with make_client(backend, tmp_path) as c:
        assert c.post("/api/chat", json={"session_id": "s1", "message": ""}).status_code == 422
        assert c.post("/api/chat", json={"session_id": "bad id!", "message": "x"}).status_code == 422
        assert c.get("/").status_code == 200
        assert c.get("/api/health").json()["ok"] is True


def test_rejected_reasoning_effort_is_dropped_and_retried(tmp_path):
    seen = []

    def handler(request):
        body = json.loads(request.content)
        seen.append("reasoning_effort" in body)
        if "reasoning_effort" in body:
            return httpx.Response(400, json={"error": {"message": "Unknown parameter"}})
        from conftest import sse_body
        return httpx.Response(200, content=sse_body(text_chunks("hello")))

    settings = make_settings(str(tmp_path / "t.db"), llm_reasoning_effort="none", llm_base_url="https://llm2.test/v1")
    with TestClient(create_app(settings, transport=httpx.MockTransport(handler))) as c:
        assert answer(chat(c, "hi")) == "hello"
        assert answer(chat(c, "hi again")) == "hello"
    assert seen == [True, False, False]


def test_rejected_tool_call_is_retried_once(tmp_path):
    """Some providers fail the whole request when the model emits a tool
    call it should not have. That must not surface as an error."""
    n = {"calls": 0}

    def handler(request):
        from conftest import sse_body
        n["calls"] += 1
        if n["calls"] == 1:
            return httpx.Response(400, json={"error": {"message": "Tool choice is none, but model called a tool"}})
        return httpx.Response(200, content=sse_body(text_chunks("Recovered.")))

    settings = make_settings(str(tmp_path / "t.db"))
    with TestClient(create_app(settings, transport=httpx.MockTransport(handler))) as c:
        events = chat(c, "hi")
    assert answer(events) == "Recovered." and not [e for e in events if e["type"] == "error"]
    assert n["calls"] == 2


def test_fast_search_depth_with_fallback_to_basic(tmp_path):
    from conftest import sse_body
    depths = []

    def handler(request):
        body = json.loads(request.content)
        if request.url.host == "llm.test":
            last = body["messages"][-1]
            return httpx.Response(200, content=sse_body(text_chunks("ok") if last["role"] == "tool" else tool_chunks("q")))
        depths.append(body["search_depth"])
        if body["search_depth"] != "basic":
            return httpx.Response(400, json={"detail": "invalid search_depth"})
        return httpx.Response(200, json={"results": [{"title": "t", "url": "https://a.example/1", "content": "c"}]})

    settings = make_settings(str(tmp_path / "t.db"), tavily_base_url="https://search2.test")
    with TestClient(create_app(settings, transport=httpx.MockTransport(handler))) as c:
        first = chat(c, "news?")
        chat(c, "more news?")
    assert depths == ["fast", "basic", "basic"]  # asked for fast, fell back, remembered
    assert [e for e in first if e["type"] == "sources"] and not [e for e in first if e["type"] == "error"]
