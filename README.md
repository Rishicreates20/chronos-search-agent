# Chronos: a web-grounded, time-aware chat agent

A small chat agent with **exactly one tool, web search**, built to do three things well:

1. **Answer fast.** Tokens stream over SSE; questions that do not need the web take a single LLM round trip.
2. **Get things right.** Web answers carry inline citations, and a URL can only reach you if it came from the search results.
3. **Remember what you asked, and when.** Every message is stored in SQLite with an immutable ISO-8601 timestamp and can be recalled by time range or keyword.

The reasoning behind each choice is in [design.md](design.md).

## Run it

Requires Python 3.11+ and two API keys: an LLM key (Gemini by default, [get one here](https://aistudio.google.com/apikey)) and a [Tavily](https://app.tavily.com) search key.

```bash
./run.sh
```

The first run creates a virtualenv, installs four dependencies, writes `.env` from `.env.example` and stops so you can paste the two keys in. Run it again and open <http://localhost:8000>.

To use another provider, set `LLM_PROVIDER` in `.env` and put that provider's key in `LLM_API_KEY`: `groq` (defaults to `openai/gpt-oss-120b`) or `openai` (defaults to `gpt-4o-mini`). `LLM_MODEL` overrides the model, and `GET /api/models` lists the ids your key can use.

<details>
<summary>Without the script</summary>

```bash
python3 -m venv .venv
.venv/bin/pip install -r requirements.txt
cp .env.example .env        # then add the two keys
.venv/bin/python -m uvicorn app.main:app --port 8000
```
</details>

## Things to try

| Ask | What it shows |
| --- | --- |
| `What are today's top technology headlines?` | "Searching web…" status, streamed answer, citation pills, source list, latency badges |
| `Explain SQLite WAL mode in two sentences` | No search, single round trip, low time-to-first-token |
| `What did I ask earlier?` | This session's questions in order, each with its exact timestamp |
| `When did I ask about WAL mode?` | Keyword recall through FTS5 |
| `What did I ask 5 minutes ago?` / `What did we discuss yesterday?` | Time-range recall, resolved in your timezone |
| `Summarize today's questions` | Range recall plus synthesis |
| Restart the server, then ask `What did I ask earlier?` | Memory is on disk, not in the process |

Every message shows its timestamp as `[HH:MM:SS UTC]` (hover for local time). Each answer shows server-measured `TTFT` and `total`, and a `web` badge when a search ran.

## Deploying to Vercel

The repo deploys to Vercel as-is: `app/main.py` is detected as the FastAPI entrypoint and `vercel.json` raises the function timeout to 60 s. Set `LLM_API_KEY` and `TAVILY_API_KEY` as project environment variables.

Vercel functions have no durable disk, so a SQLite file there would be lost on every cold start. For durable memory the app can store messages in Supabase Postgres instead:

1. Create a Supabase project and run [`supabase/schema.sql`](supabase/schema.sql) in its SQL editor.
2. Pick a long random string as the memory token and store its SHA-256:
   `insert into chronos.settings (token_sha256) values (encode(sha256('<token>'::bytea), 'hex'));`
3. Set `SUPABASE_URL`, `SUPABASE_KEY` (the project's publishable key) and `MEMORY_TOKEN` in Vercel.

`GET /api/health` reports which backend is active as `"memory": "supabase"` or `"sqlite"`. Without those three variables the app falls back to SQLite, in `/tmp` on Vercel.

## Tests

```bash
.venv/bin/pip install -r requirements-dev.txt
.venv/bin/python -m pytest -q
```

The suite runs offline: the LLM and the search API are replaced by scripted responses, and the tests drive the real FastAPI app over its SSE stream. They cover the single-tool constraint, streaming, citation enforcement, empty and timed-out searches, timestamp immutability, time-range parsing and recall across restarts.

## Layout

```
├── README.md
├── design.md            Architecture, latency, grounding and memory trade-offs
├── .env.example
├── requirements.txt     fastapi, uvicorn, httpx, tzdata
├── run.sh               One-command setup and start
├── app/
│   ├── main.py          FastAPI app: POST /api/chat (SSE), GET /api/history
│   ├── agent.py         The LLM loop, system prompt and the single tool
│   ├── llm.py           Streaming chat-completions client (plain httpx)
│   ├── search.py        web_search(query) via Tavily
│   ├── grounding.py     Citation guard: strips URLs that were not retrieved
│   ├── memory.py        Memory store: SQLite WAL + FTS5, or Supabase Postgres
│   ├── temporal.py      Recall detection, time-range parsing, timestamp tags
│   ├── config.py        Settings from the environment
│   └── static/          Dark-mode chat UI (no build step)
├── supabase/schema.sql  Postgres schema for durable memory on serverless hosts
└── tests/
```

## API

`POST /api/chat` with `{"session_id": "...", "message": "...", "timezone": "Asia/Kolkata"}` returns a `text/event-stream` of these events:

| Event | Payload |
| --- | --- |
| `meta` | `created_at` of the stored user message |
| `status` | `state` is `searching` or `search_failed`, with the `query` |
| `sources` | the search results that may be cited |
| `token` | `text`, a piece of the answer |
| `error` | `message` |
| `done` | `created_at`, `ttft_ms`, `total_ms`, `search_ms`, `searched`, `removed_urls` |

`GET /api/history?session_id=...` returns the stored messages for a session.
