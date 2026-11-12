# Chronos

A chat agent with one tool, **web search**, that remembers what you asked and when, so it can answer questions like:

- "On Monday we shortlisted 5 CRM tools for a 20-person sales team. Has any of them changed pricing or shipped something big since?"
- "What did I ask you on 3 November? Is your answer still correct today?"
- "Last Tuesday I asked you about Postgres hosting. Has any pricing changed since then?"

How it works and why is in [DESIGN.md](DESIGN.md).

## Run it

Requires Node 22.13 or newer.

```bash
npm install
```

```bash
cp .env.example .env
```

Add two keys to `.env` (both have free tiers): `LLM_API_KEY` from [Groq](https://console.groq.com/keys) and `TAVILY_API_KEY` from [Tavily](https://app.tavily.com). Then:

```bash
npm run dev
```

Open <http://localhost:3000>.

To use OpenAI or Gemini instead of Groq, set `LLM_PROVIDER` in `.env`; see `.env.example`.

## Try the memory questions without waiting a week

Recall needs a past to recall. This adds three clearly labelled demo conversations dated last Monday, last Tuesday and 3 November:

```bash
npm run seed
```

Then open <http://localhost:3000/?user=demo> and ask the three questions above. The seeded answers contain illustrative figures, not real quotes; the agent compares them with what it finds on the web today.

Without the seed, everything you ask is remembered from the first message: try "What did I ask earlier?", "What did I ask 5 minutes ago?", or come back tomorrow and ask "What did we discuss yesterday? Is it still correct?".

## What you see

Every message shows its timestamp. Each answer shows a `web` badge when it searched, the queries it ran, its sources, and server-measured timings: `TTFT` (time to first token), `memory`, `search` and `total`. A warning badge appears if the model produced a link that was not in the search results and it was removed.

## Tests

```bash
npm test
```

51 tests, all offline: the LLM and the search API are replaced by scripted responses and the tests drive the real HTTP app over its SSE stream. They include the brief's example questions.

## Layout

```
├── DESIGN.md
├── .env.example
├── src/
│   ├── dev.ts          Local server (npm run dev)
│   ├── index.ts        Serverless entry point
│   ├── http.ts         HTTP routes: POST /api/chat (SSE), GET /api/history
│   ├── agent.ts        The loop, the system prompt, the single tool
│   ├── temporal.ts     Recall detection, date parsing, timestamp tags
│   ├── grounding.ts    Citation guard
│   ├── llm.ts          Streaming chat-completions client
│   ├── search.ts       web_search via Tavily
│   └── memory/         Store interface, SQLite and Supabase backends
├── public/             Chat UI (no build step)
├── scripts/seed.ts     Demo history for the recall questions
├── supabase/schema.sql Postgres schema for the hosted demo
└── test/
```

## Hosted demo

<https://chronos-search-agent.vercel.app> runs the same code on Vercel. There, memory is stored in Supabase Postgres, selected by the three optional variables at the bottom of `.env.example`.
