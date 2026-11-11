"""Runtime configuration, read once from the environment (and an optional .env)."""
from __future__ import annotations

import os
from dataclasses import dataclass
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent

# Both providers are reached through the same OpenAI-compatible
# /chat/completions wire format, so switching is configuration only.
PROVIDERS = {
    "gemini": {
        "base_url": "https://generativelanguage.googleapis.com/v1beta/openai",
        "model": "gemini-2.5-flash",
        # 2.5 Flash "thinks" by default, which costs TTFT. Turn it off.
        "reasoning_effort": "none",
    },
    "openai": {
        "base_url": "https://api.openai.com/v1",
        "model": "gpt-4o-mini",
        "reasoning_effort": "",
    },
}


def load_dotenv(path: Path) -> None:
    """Minimal .env loader: KEY=VALUE lines, real environment wins."""
    if not path.is_file():
        return
    for raw in path.read_text(encoding="utf-8").splitlines():
        line = raw.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        key, _, value = line.partition("=")
        value = value.strip()
        if len(value) >= 2 and value[0] == value[-1] and value[0] in "\"'":
            value = value[1:-1]
        os.environ.setdefault(key.strip(), value)


def _default_db_path() -> str:
    # Serverless hosts (Vercel) only allow writes under /tmp, and that
    # directory is per-instance and temporary. See design.md, section 5.
    if os.environ.get("VERCEL"):
        return "/tmp/chronos.db"
    return str(ROOT / "data" / "chronos.db")


@dataclass(frozen=True)
class Settings:
    llm_api_key: str
    llm_base_url: str
    llm_model: str
    llm_reasoning_effort: str
    tavily_api_key: str
    tavily_base_url: str
    db_path: str
    history_turns: int
    search_timeout_s: float
    search_max_results: int
    max_search_rounds: int
    supabase_url: str = ""
    supabase_key: str = ""
    memory_token: str = ""

    @classmethod
    def from_env(cls) -> "Settings":
        load_dotenv(ROOT / ".env")
        env = os.environ.get
        provider = env("LLM_PROVIDER", "gemini").strip().lower()
        preset = PROVIDERS.get(provider, PROVIDERS["gemini"])
        return cls(
            llm_api_key=env("LLM_API_KEY", "").strip(),
            llm_base_url=(env("LLM_BASE_URL") or preset["base_url"]).rstrip("/"),
            llm_model=env("LLM_MODEL") or preset["model"],
            llm_reasoning_effort=env("LLM_REASONING_EFFORT", preset["reasoning_effort"]),
            tavily_api_key=env("TAVILY_API_KEY", "").strip(),
            tavily_base_url=env("TAVILY_BASE_URL", "https://api.tavily.com").rstrip("/"),
            db_path=env("DB_PATH") or _default_db_path(),
            history_turns=int(env("HISTORY_TURNS", "10")),
            search_timeout_s=float(env("SEARCH_TIMEOUT_S", "3")),
            search_max_results=int(env("SEARCH_MAX_RESULTS", "5")),
            max_search_rounds=int(env("MAX_SEARCH_ROUNDS", "2")),
            supabase_url=env("SUPABASE_URL", "").strip(),
            supabase_key=env("SUPABASE_KEY", "").strip(),
            memory_token=env("MEMORY_TOKEN", "").strip(),
        )
