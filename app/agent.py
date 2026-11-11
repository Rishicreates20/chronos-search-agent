"""The agent: one direct LLM loop with exactly one tool, web_search(query).

run_turn() is an async generator of UI events:
  meta    - the user message was timestamped and stored
  status  - "searching" / "search_failed" (drives the "Searching web..." pill)
  sources - search results that may be cited
  token   - a piece of the answer
  done    - final timestamps and latency numbers
  error   - something failed; the message is user-readable
"""
from __future__ import annotations

import asyncio
import json
import time
import uuid
from typing import AsyncIterator

import httpx

from . import temporal
from .config import Settings
from .grounding import CitationGuard, extract_urls
from .llm import LLMError, stream_chat
from .memory import StoreError, TurnContext, to_iso, utcnow
from .search import TOOL_SPEC, SearchOutcome, web_search

# The only tools the model can ever see (FR-01).
TOOLS = [TOOL_SPEC]

SYSTEM_PROMPT = """You are Chronos, a fast, web-grounded chat assistant. You have exactly one tool: web_search(query).

CURRENT TIME: {local_now} ({weekday}), which is {utc_now} UTC. User timezone: {tz_name}.
Treat this as "now". Your training data is older than this date.

WHEN TO SEARCH
- Call web_search for anything live, recent or external: news, prices, scores, weather, releases, schedules, who currently holds a role, "latest" anything, or any specific fact you are not certain of.
- Do NOT search for greetings, small talk, reasoning, writing or coding help, stable textbook knowledge, or questions about this conversation itself. Answer those directly.
- Make queries specific. Add the current year or date for time-sensitive topics.

GROUNDING (after a search)
- Base factual claims only on the search results. Cite each claim inline, right after it, as a markdown link with the result's exact URL and the publisher as link text: [Reuters](https://...).
- Only use URLs that appear verbatim in the search results. Never invent, guess, shorten or edit a URL. Unverified URLs are stripped before the user sees them.
- If the results are empty or do not answer the question, say exactly: "I could not find verified information on this." You may add what the results do say. Never fill gaps with guesses.
- If sources disagree, say so and cite each. Prefer the most recent source and mention its date.
- If the tool reports a timeout or that it is unavailable, follow the instruction in the tool result.

WITHOUT A SEARCH
- Answer from your own knowledge with no URLs. If it may be outdated or you are unsure, say so plainly.

MEMORY AND TIME
- Every earlier message is prefixed with a tag like [2026-11-11 21:01:10 IST · 5 min ago]: the exact time it was sent and its age right now. These tags, and the MEMORY RECALL section when present, are the authoritative record of what was said and when.
- When asked what or when the user asked something, quote or closely paraphrase the stored message and give its exact timestamp from the tag. Never estimate a time. If nothing stored matches, say there is no record of it.
- "Earlier" with no date means this session: list the user's questions in order, each with its timestamp.
- MEMORY RECALL is only for questions about the conversation. Ignore it when the user is asking about the outside world.
- Never start your own reply with a timestamp tag; the system adds them.

STYLE: lead with the answer. Be concise and direct. Use markdown."""


def build_messages(ctx: TurnContext, recall: temporal.Recall, user_text: str, now, tz) -> tuple[list[dict], set[str]]:
    """Memory hydration: system prompt + sliding window + recall block."""
    local = now.astimezone(tz)
    system = SYSTEM_PROMPT.format(
        local_now=f"{local:%Y-%m-%d %H:%M:%S} {temporal.tz_label(local)}",
        weekday=f"{local:%A}",
        utc_now=to_iso(now),
        tz_name=tz.key,
    )
    block = temporal.build_recall_block(recall, ctx, now, tz)
    if block:
        system += "\n\n" + block

    messages = [{"role": "system", "content": system}]
    known_urls = extract_urls(block) | extract_urls(user_text)
    for m in ctx.recent:
        body = m.content if len(m.content) <= 4000 else m.content[:4000] + "…"
        messages.append({"role": m.role, "content": f"{temporal.tag(m.dt, tz, now)} {body}"})
        known_urls |= extract_urls(m.content)
    messages.append({"role": "user", "content": user_text})
    return messages, known_urls


async def run_turn(
    client: httpx.AsyncClient,
    store,
    settings: Settings,
    session_id: str,
    user_text: str,
    tz_name: str | None = None,
) -> AsyncIterator[dict]:
    t0 = time.perf_counter()
    now = utcnow()
    tz = temporal.get_tz(tz_name)

    def ms() -> int:
        return int((time.perf_counter() - t0) * 1000)

    # Stages 1-2: take the immutable timestamp at receipt, then store the
    # question and load memory. Recall phrases are resolved to exact bounds
    # in code first, so the store does one combined lookup.
    recall = temporal.analyze(user_text, now, tz)
    try:
        ctx = await store.begin_turn(
            session_id, user_text, now, settings.history_turns * 2,
            start=recall.start, end=recall.end,
            terms=recall.keywords if recall.is_recall else None,
            log_limit=40 if recall.is_recall else 0,
        )
    except StoreError as exc:
        yield {"type": "error", "message": str(exc)}
        yield {"type": "done", "assistant_message_id": None, "created_at": to_iso(utcnow()), "ttft_ms": None,
               "total_ms": ms(), "search_ms": 0, "hydrate_ms": ms(), "searched": False, "removed_urls": 0}
        return
    user_msg = ctx.user
    yield {"type": "meta", "user_message_id": user_msg.id, "created_at": user_msg.created_at}
    messages, known_urls = build_messages(ctx, recall, user_text, now, tz)
    hydrate_ms = ms()

    guard = CitationGuard(known_urls)
    answer: list[str] = []
    sources: list[dict] = []
    queries: list[str] = []
    ttft_ms: int | None = None
    search_ms = 0
    error = ""

    try:
        # Stages 3-5: the model either answers directly (one round trip) or
        # asks for a search, after which it answers from the results.
        for round_no in range(settings.max_search_rounds + 1):
            last_round = round_no == settings.max_search_rounds
            tool_calls: list[dict] = []
            round_text: list[str] = []
            async for kind, value in stream_chat(
                client, settings, messages, tools=TOOLS, tool_choice="none" if last_round else None
            ):
                if kind == "text":
                    round_text.append(value)
                    safe = guard.feed(value)
                    if safe:
                        if ttft_ms is None:
                            ttft_ms = ms()
                        answer.append(safe)
                        yield {"type": "token", "text": safe}
                else:
                    tool_calls = [c for c in value if c["name"] == "web_search"]
            if not tool_calls or last_round:
                break

            calls = []
            for c in tool_calls:
                try:
                    query = str(json.loads(c["arguments"] or "{}").get("query", "")).strip()
                except json.JSONDecodeError:
                    query = ""
                calls.append({"id": c["id"] or f"call_{uuid.uuid4().hex[:12]}", "query": query, "raw": c["arguments"]})
            for c in calls:
                yield {"type": "status", "state": "searching", "query": c["query"]}

            s0 = time.perf_counter()
            outcomes: list[SearchOutcome] = await asyncio.gather(
                *(web_search(client, settings, c["query"]) for c in calls)
            )
            search_ms += int((time.perf_counter() - s0) * 1000)

            new_sources = []
            for out in outcomes:
                queries.append(out.query)
                if out.error:
                    yield {
                        "type": "status",
                        "state": "search_failed",
                        "query": out.query,
                        "detail": "Search timed out" if out.error == "timeout" else "Search unavailable",
                    }
                for r in out.results:
                    if all(r["url"] != s["url"] for s in sources):
                        sources.append({"title": r["title"], "url": r["url"]})
                        new_sources.append(r)
            guard.allow(s["url"] for s in sources)
            if new_sources:
                yield {"type": "sources", "sources": sources}

            assistant: dict = {
                "role": "assistant",
                "tool_calls": [
                    {
                        "id": c["id"],
                        "type": "function",
                        "function": {"name": "web_search", "arguments": c["raw"] or "{}"},
                    }
                    for c in calls
                ],
            }
            if round_text:
                assistant["content"] = "".join(round_text)
            messages.append(assistant)
            for c, out in zip(calls, outcomes):
                messages.append({"role": "tool", "tool_call_id": c["id"], "content": out.for_llm()})

        tail = guard.flush()
        if tail:
            if ttft_ms is None:
                ttft_ms = ms()
            answer.append(tail)
            yield {"type": "token", "text": tail}
    except LLMError as exc:
        error = str(exc)
    except Exception as exc:  # keep the stream well-formed whatever happens
        error = f"Unexpected error: {type(exc).__name__}"
    finally:
        # Stage 6: persist the assistant turn. This also runs if the client
        # disconnects mid-stream, so memory always matches what was shown.
        text = "".join(answer).strip()
        stored = None
        if text:
            meta = {
                "sources": sources,
                "queries": queries,
                "ttft_ms": ttft_ms,
                "total_ms": ms(),
                "search_ms": search_ms,
                "searched": bool(queries),
                "removed_urls": len(guard.removed),
            }
            try:
                stored = await store.save(session_id, "assistant", text, meta=meta)
            except StoreError as exc:
                error = error or f"The answer could not be saved to memory. {exc}"

    if error:
        yield {"type": "error", "message": error}
    if not text and not error:
        yield {"type": "error", "message": "The model returned an empty response. Please try again."}
    yield {
        "type": "done",
        "assistant_message_id": stored.id if stored else None,
        "created_at": stored.created_at if stored else to_iso(utcnow()),
        "ttft_ms": ttft_ms,
        "total_ms": ms(),
        "search_ms": search_ms,
        "hydrate_ms": hydrate_ms,
        "searched": bool(queries),
        "removed_urls": len(guard.removed),
    }
