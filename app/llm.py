"""Direct, framework-free streaming client for an OpenAI-compatible
/chat/completions endpoint (Gemini's compatibility endpoint or OpenAI)."""
from __future__ import annotations

import json
from typing import AsyncIterator

import httpx

from .config import Settings


class LLMError(Exception):
    pass


# Endpoints that returned 400 for `reasoning_effort`; see stream_chat().
_no_reasoning_param: set[str] = set()


async def stream_chat(
    client: httpx.AsyncClient,
    settings: Settings,
    messages: list[dict],
    tools: list[dict] | None = None,
    tool_choice: str | None = None,
) -> AsyncIterator[tuple[str, object]]:
    """Yields ("text", str) as tokens arrive, then one ("tool_calls", list)
    with fully assembled calls: [{"id", "name", "arguments"}]."""
    if not settings.llm_api_key:
        raise LLMError("LLM_API_KEY is not set. Copy .env.example to .env and add your key.")
    payload: dict = {"model": settings.llm_model, "messages": messages, "stream": True, "temperature": 0.2}
    if tools:
        payload["tools"] = tools
        if tool_choice:
            payload["tool_choice"] = tool_choice
    if settings.llm_reasoning_effort:
        payload["reasoning_effort"] = settings.llm_reasoning_effort

    calls: list[dict] = []
    url = f"{settings.llm_base_url}/chat/completions"
    headers = {"Authorization": f"Bearer {settings.llm_api_key}"}
    if "reasoning_effort" in payload and url in _no_reasoning_param:
        del payload["reasoning_effort"]
    try:
        for attempt in range(2):
            async with client.stream(
                "POST", url, headers=headers, json=payload, timeout=httpx.Timeout(60, connect=5)
            ) as resp:
                if resp.status_code != 200:
                    body = (await resp.aread()).decode("utf-8", "replace")
                    if resp.status_code == 400 and "reasoning_effort" in payload and attempt == 0:
                        # This model/endpoint rejects the parameter: drop it
                        # for the rest of the process and retry once.
                        _no_reasoning_param.add(url)
                        del payload["reasoning_effort"]
                        continue
                    raise LLMError(f"LLM API returned HTTP {resp.status_code}: {_error_text(body)}")
                async for line in resp.aiter_lines():
                    if not line.startswith("data:"):
                        continue
                    data = line[5:].strip()
                    if not data or data == "[DONE]":
                        continue
                    try:
                        chunk = json.loads(data)
                    except json.JSONDecodeError:
                        continue
                    if isinstance(chunk, dict) and chunk.get("error"):
                        raise LLMError(f"LLM API error: {_error_text(data)}")
                    for choice in chunk.get("choices") or []:
                        delta = choice.get("delta") or {}
                        if delta.get("content"):
                            yield "text", delta["content"]
                        for tc in delta.get("tool_calls") or []:
                            _merge_tool_call(calls, tc)
                break
    except httpx.HTTPError as exc:
        raise LLMError(f"Could not reach the LLM API ({type(exc).__name__}).") from exc

    yield "tool_calls", [c for c in calls if c["name"]]


def _merge_tool_call(calls: list[dict], tc: dict) -> None:
    """OpenAI streams a call in fragments keyed by index. Gemini sends each
    call whole and may omit or repeat the index, so also split on a new id."""
    fn = tc.get("function") or {}
    idx = tc.get("index")
    target = calls[idx] if isinstance(idx, int) and 0 <= idx < len(calls) else None
    if target is not None and tc.get("id") and target["id"] and tc["id"] != target["id"]:
        target = None
    if target is None and idx is None and calls and not tc.get("id") and not fn.get("name"):
        target = calls[-1]
    if target is None:
        target = {"id": "", "name": "", "arguments": ""}
        calls.append(target)
    target["id"] = target["id"] or tc.get("id") or ""
    target["name"] = target["name"] or fn.get("name") or ""
    target["arguments"] += fn.get("arguments") or ""


def _error_text(body: str) -> str:
    try:
        data = json.loads(body)
        if isinstance(data, list) and data:
            data = data[0]
        err = data.get("error", data)
        return str(err.get("message", err))[:300] if isinstance(err, dict) else str(err)[:300]
    except Exception:
        return body[:300]
