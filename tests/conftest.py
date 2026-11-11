"""Test doubles: a scripted LLM and search API served through httpx.MockTransport,
so the whole pipeline runs offline and deterministically."""
from __future__ import annotations

import json
import sys
from pathlib import Path

import httpx
import pytest

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from app.config import Settings  # noqa: E402


def make_settings(db_path: str = ":memory:", **over) -> Settings:
    base = dict(
        llm_api_key="test-key",
        llm_base_url="https://llm.test/v1",
        llm_model="test-model",
        llm_reasoning_effort="",
        tavily_api_key="test-key",
        tavily_base_url="https://search.test",
        db_path=db_path,
        history_turns=10,
        search_timeout_s=3,
        search_max_results=5,
        max_search_rounds=2,
    )
    base.update(over)
    return Settings(**base)


def sse_body(chunks: list[dict]) -> bytes:
    return ("".join(f"data: {json.dumps(c)}\n\n" for c in chunks) + "data: [DONE]\n\n").encode()


def text_chunks(text: str, size: int = 7) -> list[dict]:
    return [{"choices": [{"delta": {"content": text[i : i + size]}}]} for i in range(0, len(text), size)]


def tool_chunks(query: str, call_id: str = "call_1") -> list[dict]:
    args = json.dumps({"query": query})
    half = len(args) // 2
    return [
        {"choices": [{"delta": {"tool_calls": [
            {"index": 0, "id": call_id, "type": "function", "function": {"name": "web_search", "arguments": args[:half]}}
        ]}}]},
        {"choices": [{"delta": {"tool_calls": [{"index": 0, "function": {"arguments": args[half:]}}]}}]},
    ]


class FakeBackend:
    """Scripts LLM replies in order and records every request it receives."""

    def __init__(self):
        self.llm_script: list[list[dict]] = []
        self.llm_requests: list[dict] = []
        self.search_requests: list[dict] = []
        self.search_results: list[dict] = []
        self.search_exception: Exception | None = None

    def handler(self, request: httpx.Request) -> httpx.Response:
        if request.url.host == "llm.test":
            self.llm_requests.append(json.loads(request.content))
            return httpx.Response(200, content=sse_body(self.llm_script.pop(0)))
        if request.url.host == "search.test":
            self.search_requests.append(json.loads(request.content))
            if self.search_exception:
                raise self.search_exception
            return httpx.Response(200, json={"results": self.search_results})
        return httpx.Response(404)

    @property
    def transport(self) -> httpx.MockTransport:
        return httpx.MockTransport(self.handler)


@pytest.fixture
def backend() -> FakeBackend:
    return FakeBackend()
