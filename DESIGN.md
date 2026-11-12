# Design

Chronos is a chat agent with one tool, web search. The hard part of the brief is questions like *"On Monday we shortlisted 5 CRM tools. Has any changed pricing since?"*, which need exact memory of a past exchange **and** a fresh look at the web, in one answer.

## How it works

```
question → timestamp → resolve time phrases in code → ONE memory lookup
        → LLM (streaming) ─┬─ answers directly
                           └─ web_search × N in parallel → LLM answers from results
        → citation guard → SSE to the browser → answer stored
```

1. **Time is resolved in code, before the model.** "On Monday", "3 November", "last Tuesday", "5 minutes ago" become exact UTC bounds in the user's timezone (`src/temporal.ts`). The model never does date arithmetic.
2. **One memory lookup** (`src/memory/`) stores the question and returns the last 10 turns, every message in the resolved time range, keyword matches (full-text, with the other half of each matched exchange), and this session's questions. Each message carries an immutable timestamp and reaches the model tagged `[2026-11-09 Mon 10:00:00 UTC · 2d 5h ago]`.
3. **One model call routes and answers.** Because memory is already in the prompt, the model's first step can name the five tools from Monday and search for all of them at once. Searches run in parallel; at most two search steps, then a final call with no tool declared.
4. **A citation guard** (`src/grounding.ts`) filters the output stream: a URL reaches the user only if a search returned it this turn or it was already in the conversation.

## Why this way

- **Memory is not a tool.** The brief allows one tool. More importantly, recall done in code is deterministic, costs no model round trip, and lets memory and search be planned in the same step.
- **No agent framework.** The loop is about 200 lines over `fetch`. Every latency cost and failure path is visible, and a no-search answer is exactly one model call.
- **Honest by construction.** An empty time range goes into the prompt as "nothing was recorded", so the model says "no record" instead of inventing a past. Fabricated links are removed, not just discouraged.
- **Storage behind three methods.** SQLite locally, through Node's built-in driver so `npm install` compiles nothing; Postgres for the hosted demo, where the whole lookup is one SQL function.

## Considered and rejected

- **Embeddings for recall.** Better at paraphrase, but a model call per message and fuzzy matches where the questions ask for exact ones. Time range plus keywords covers every example in the brief.
- **A separate router or planner call.** A round trip on every message for a decision the answering call already makes.
- **Exposing memory through the search tool.** A second tool hidden in the first, and recall would depend on the model choosing to look.
- **Summarising old conversations.** Loses the exact prices and wording that "is it still correct?" must compare against.
- **Fetching full pages.** Deeper, but outside the latency budget; dated snippets are enough to detect a change.

## With another week

- **An eval set** from the brief's question shapes, scored on recall accuracy, citation validity and time to first token. Today there are 51 offline tests, but answer quality is checked by hand.
- **Claim-level verification.** The guard proves a link is real, not that it supports the sentence.
- **Speed.** First token with a search measured about 2 s on the live demo, mostly the search API. I would start likely searches while the model is still deciding.
- **Hybrid recall:** embeddings as a fallback only when time and keywords find nothing.
- **Accounts.** A user is a browser id today: enough to separate memories, not authentication.
