"""FastAPI app: SSE chat endpoint, history endpoint, static UI."""
from __future__ import annotations

import asyncio
import json
from contextlib import asynccontextmanager
from pathlib import Path

import httpx
from fastapi import FastAPI, Query
from fastapi.responses import FileResponse, StreamingResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel, Field

from .agent import run_turn
from .config import Settings
from .memory import MemoryStore, to_iso, utcnow

STATIC = Path(__file__).parent / "static"


class ChatRequest(BaseModel):
    session_id: str = Field(min_length=1, max_length=64, pattern=r"^[A-Za-z0-9_-]+$")
    message: str = Field(min_length=1, max_length=8000)
    timezone: str | None = Field(default=None, max_length=64)


def sse(event: dict) -> bytes:
    return f"event: {event['type']}\ndata: {json.dumps(event, ensure_ascii=False)}\n\n".encode()


async def _prewarm(client: httpx.AsyncClient, settings: Settings) -> None:
    """Open TLS connections at startup so the first question does not pay
    for the handshakes. Best effort."""
    for url in (f"{settings.llm_base_url}/models", settings.tavily_base_url):
        try:
            await client.get(url, timeout=3)
        except Exception:
            pass


def create_app(settings: Settings | None = None, transport: httpx.AsyncBaseTransport | None = None) -> FastAPI:
    settings = settings or Settings.from_env()

    @asynccontextmanager
    async def lifespan(app: FastAPI):
        app.state.settings = settings
        app.state.store = MemoryStore(settings.db_path)
        # One pooled keep-alive client for both the LLM and the search API.
        app.state.client = httpx.AsyncClient(
            transport=transport, limits=httpx.Limits(max_keepalive_connections=10, keepalive_expiry=120)
        )
        warm = asyncio.create_task(_prewarm(app.state.client, settings)) if transport is None else None
        yield
        if warm:
            warm.cancel()
        await app.state.client.aclose()
        app.state.store.close()

    app = FastAPI(title="Chronos", lifespan=lifespan, docs_url=None, redoc_url=None)

    @app.post("/api/chat")
    async def chat(req: ChatRequest):
        async def stream():
            async for event in run_turn(
                app.state.client, app.state.store, settings, req.session_id, req.message.strip(), req.timezone
            ):
                yield sse(event)

        return StreamingResponse(
            stream(),
            media_type="text/event-stream",
            headers={"Cache-Control": "no-cache, no-transform", "X-Accel-Buffering": "no"},
        )

    @app.get("/api/history")
    async def history(session_id: str = Query(min_length=1, max_length=64)):
        return {"messages": [m.public() for m in app.state.store.history(session_id)]}

    @app.get("/api/health")
    async def health():
        return {
            "ok": True,
            "time": to_iso(utcnow()),
            "model": settings.llm_model,
            "llm_key": bool(settings.llm_api_key),
            "search_key": bool(settings.tavily_api_key),
        }

    @app.get("/")
    async def index():
        return FileResponse(STATIC / "index.html", headers={"Cache-Control": "no-cache"})

    app.mount("/static", StaticFiles(directory=STATIC), name="static")
    return app


app = create_app()
