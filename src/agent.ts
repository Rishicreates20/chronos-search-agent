// The agent: one direct LLM loop with exactly one tool, web_search.
//
// runTurn() is an async generator of UI events:
//   meta    - the user message was timestamped and stored
//   status  - "searching" / "search_failed" (drives the "Searching web…" row)
//   sources - search results that may be cited
//   token   - a piece of the answer
//   done    - final timestamps and latency numbers
//   error   - something failed; the message is user-readable
import { randomUUID } from "node:crypto";
import type { Settings } from "./config.js";
import { CitationGuard, extractUrls } from "./grounding.js";
import { LLMError, streamChat, type ChatMessage, type ToolCall } from "./llm.js";
import { StoreError, toIso, type MemoryStore, type Message, type TurnContext } from "./memory/types.js";
import { forLLM, TOOL_SPEC, webSearch, type SearchOutcome } from "./search.js";
import { analyze, buildRecallBlock, formatLocal, tag, validTz, weekdayName, type Recall } from "./temporal.js";

// The only tool the model can ever see.
export const TOOLS = [TOOL_SPEC];
const MAX_PARALLEL_SEARCHES = 6;

export type AgentEvent =
  | { type: "meta"; user_message_id: number; created_at: string }
  | { type: "status"; state: "searching" | "search_failed"; query: string; detail?: string }
  | { type: "sources"; sources: { title: string; url: string }[] }
  | { type: "token"; text: string }
  | { type: "error"; message: string }
  | {
      type: "done"; assistant_message_id: number | null; created_at: string; ttft_ms: number | null; total_ms: number;
      search_ms: number; hydrate_ms: number; searched: boolean; removed_urls: number;
    };

export function systemPrompt(now: Date, tz: string): string {
  return `You are Chronos, a fast, web-grounded chat assistant. You have exactly one tool: web_search.

CURRENT TIME: ${formatLocal(now, tz)} (${weekdayName(now, tz)}), which is ${toIso(now)} UTC. User timezone: ${tz}.
Treat this as "now". Your training data is older than this date.

WHEN TO SEARCH
- Search for anything live, recent or external: news, prices, releases, scores, schedules, who currently holds a role, "latest" anything, or any specific fact you are not certain of.
- Do not search for greetings, small talk, reasoning, writing or coding help, or stable textbook knowledge.
- A question that is only about this conversation ("what did I ask earlier?", "when did I ask about X?") is answered from memory with no search.
- Make each query specific and name the entity. One call per entity: to check five products, issue five calls in the same step; they run in parallel. You get at most two search steps, so ask for everything you need in the first.

MEMORY AND TIME
- Every earlier message is prefixed with a tag like [2026-11-11 Wed 21:01:10 GMT+5:30 · 5 min ago]: the exact time it was sent and its age right now. These tags, and the MEMORY RECALL section when present, are the authoritative record of what was said and when.
- When asked what or when the user asked something, quote or closely paraphrase the stored message and give its exact date and time from the tag. Never estimate a time. If nothing stored matches, say plainly that there is no record of it, and do not invent one.
- "Earlier" with no date means this session: list the user's questions in order, each with its timestamp.
- Never start your own reply with a timestamp tag; the system adds them.

THEN VERSUS NOW (memory and the web together)
Some questions point at a past exchange and ask about the present: "has any of them changed pricing since?", "is your answer still correct today?", "anything new since Monday?".
1. Find the past exchange in MEMORY RECALL or the history. Note exactly what was said then (names, prices, claims) and its date.
2. If there is no record of it, say so first. Then offer what you can find about the topic now, without pretending to compare.
3. Otherwise search for the current state of each item. Use the names from memory in your queries. For "what shipped or was announced since <date>" pass that date as \`since\`; for a current fact such as today's price, omit it.
4. Answer as a comparison: for each item, what was recorded on <date>, what the sources say now, and whether it changed. Say "no change found" when the sources show none, and "could not verify" when they do not cover it. Start with a one-line verdict.

GROUNDING (after a search)
- Base factual claims only on the search results. Cite EACH claim inline, directly after it in the same sentence or bullet, as a markdown link with the result's exact URL and the publisher as link text: "NZ won by 87 runs [ESPN](https://...)". Every bullet or sentence that states a web fact carries its own link. Never gather sources into a "Source:" line at the end.
- Only use URLs that appear verbatim in the search results. Never invent, guess, shorten or edit a URL. Unverified URLs are stripped before the user sees them.
- Facts recalled from memory are attributed to the conversation with their date ("on 9 Nov you were told…"), not to a web link.
- If the results are empty or do not answer the question, say exactly: "I could not find verified information on this." You may add what the results do say. Never fill gaps with guesses.
- If sources disagree, say so and cite each. Prefer the most recent and mention its date.
- If the tool reports a timeout or that it is unavailable, follow the instruction in the tool result.

WITHOUT A SEARCH
- Answer from your own knowledge with no URLs. If it may be outdated or you are unsure, say so plainly.

STYLE: lead with the answer. Be concise and direct, like a knowledgeable colleague. Short sentences or bullets, markdown, no padding.`;
}

/** Memory hydration: system prompt + sliding window + recall block. */
export function buildMessages(ctx: TurnContext, recall: Recall, userText: string, now: Date, tz: string): { messages: ChatMessage[]; knownUrls: Set<string> } {
  let system = systemPrompt(now, tz);
  const block = buildRecallBlock(recall, ctx, now, tz);
  if (block) system += "\n\n" + block;
  const messages: ChatMessage[] = [{ role: "system", content: system }];
  const knownUrls = new Set([...extractUrls(block), ...extractUrls(userText)]);
  for (const m of ctx.recent) {
    const body = m.content.length <= 4000 ? m.content : m.content.slice(0, 4000) + "…";
    messages.push({ role: m.role, content: `${tag(new Date(m.createdAt), tz, now)} ${body}` });
    for (const u of extractUrls(m.content)) knownUrls.add(u);
  }
  messages.push({ role: "user", content: userText });
  return { messages, knownUrls };
}

function finalPrompt(toolResults: string[]): ChatMessage {
  return {
    role: "user",
    content:
      "(Automated message from the web_search tool, not from the user.)\n\n" +
      toolResults.join("\n\n---\n\n") +
      "\n\nNo further searches are available. Answer the user's question now, in plain text, using only these results " +
      "and the conversation, with a link after each web claim as instructed.",
  };
}

export interface TurnInput {
  userId: string;
  sessionId: string;
  text: string;
  timezone?: string | null;
}

export interface AgentDeps {
  settings: Settings;
  store: MemoryStore;
  fetchFn?: typeof fetch;
  now?: () => Date;
}

export async function* runTurn(deps: AgentDeps, input: TurnInput): AsyncGenerator<AgentEvent> {
  const { settings, store } = deps;
  const fetchFn = deps.fetchFn ?? fetch;
  const t0 = performance.now();
  const ms = () => Math.round(performance.now() - t0);
  const now = (deps.now ?? (() => new Date()))();
  const tz = validTz(input.timezone);
  const finish = (over: Partial<Extract<AgentEvent, { type: "done" }>> = {}): AgentEvent => ({
    type: "done", assistant_message_id: null, created_at: toIso(new Date()), ttft_ms: null, total_ms: ms(),
    search_ms: 0, hydrate_ms: 0, searched: false, removed_urls: 0, ...over,
  });

  // Stages 1-2: take the immutable timestamp at receipt, then store the
  // question and load memory. Recall phrases are resolved to exact bounds in
  // code first, so the store does one combined lookup.
  const recall = analyze(input.text, now, tz);
  let ctx: TurnContext;
  try {
    ctx = await store.beginTurn({
      userId: input.userId, sessionId: input.sessionId, content: input.text, createdAt: now,
      window: settings.historyTurns * 2,
      range: recall.range ? { start: recall.range.start, end: recall.range.end } : undefined,
      terms: recall.isRecall ? recall.keywords : undefined,
      logLimit: recall.isRecall ? 40 : 0,
    });
  } catch (err) {
    yield { type: "error", message: err instanceof StoreError ? err.message : `Memory store failed (${(err as Error).name}).` };
    yield finish({ hydrate_ms: ms() });
    return;
  }
  yield { type: "meta", user_message_id: ctx.user.id, created_at: ctx.user.createdAt };
  const { messages, knownUrls } = buildMessages(ctx, recall, input.text, now, tz);
  const hydrateMs = ms();

  const guard = new CitationGuard(knownUrls);
  const sources: { title: string; url: string }[] = [];
  const queries: string[] = [];
  let answer = "";
  let ttftMs: number | null = null;
  let searchMs = 0;
  let error = "";
  let stored: Message | null = null;

  try {
    // Stages 3-5: the model either answers directly (one round trip) or asks
    // for searches, after which it answers from the results.
    const baseMessages = [...messages];
    const toolResults: string[] = [];
    for (let round = 0; round <= settings.maxSearchRounds; round++) {
      const lastRound = round === settings.maxSearchRounds;
      // Search budget spent: ask for the answer in a plain request with no
      // tool declared, so the model cannot ask for another.
      const callMessages = lastRound ? [...baseMessages, finalPrompt(toolResults)] : messages;
      let toolCalls: ToolCall[] = [];
      let roundText = "";
      for (let attempt = 0; attempt < 2; attempt++) {
        toolCalls = [];
        roundText = "";
        try {
          for await (const ev of streamChat(settings, callMessages, lastRound ? null : TOOLS, fetchFn)) {
            if (ev.type === "text") {
              roundText += ev.text;
              const safe = guard.feed(ev.text);
              if (safe) {
                ttftMs ??= ms();
                answer += safe;
                yield { type: "token", text: safe };
              }
            } else {
              toolCalls = ev.calls.filter((c) => c.name === "web_search");
            }
          }
          break;
        } catch (err) {
          // Providers reject a malformed or disallowed tool call outright.
          // Nothing has been shown yet, so try once more.
          if (attempt === 0 && !roundText && err instanceof LLMError && /tool/i.test(err.message)) continue;
          throw err;
        }
      }
      if (!toolCalls.length || lastRound) break;

      const calls = toolCalls.slice(0, MAX_PARALLEL_SEARCHES).map((c) => {
        let args: { query?: unknown; since?: unknown } = {};
        try {
          args = JSON.parse(c.arguments || "{}");
        } catch {}
        return {
          id: c.id || `call_${randomUUID().slice(0, 12)}`,
          raw: c.arguments || "{}",
          query: String(args.query ?? "").trim(),
          since: typeof args.since === "string" ? args.since : undefined,
        };
      });
      for (const c of calls) yield { type: "status", state: "searching", query: c.query };

      const s0 = performance.now();
      const outcomes: SearchOutcome[] = await Promise.all(calls.map((c) => webSearch(settings, c.query, c.since, fetchFn)));
      searchMs += Math.round(performance.now() - s0);

      let added = false;
      for (const out of outcomes) {
        queries.push(out.query);
        if (out.error) {
          yield { type: "status", state: "search_failed", query: out.query, detail: out.error === "timeout" ? "Search timed out" : "Search unavailable" };
        }
        for (const r of out.results) {
          if (!sources.some((s) => s.url === r.url)) {
            sources.push({ title: r.title, url: r.url });
            added = true;
          }
        }
      }
      guard.allow(sources.map((s) => s.url));
      if (added) yield { type: "sources", sources: [...sources] };

      messages.push({
        role: "assistant",
        ...(roundText ? { content: roundText } : {}),
        tool_calls: calls.map((c) => ({ id: c.id, type: "function" as const, function: { name: "web_search", arguments: c.raw } })),
      });
      calls.forEach((c, i) => {
        const text = forLLM(outcomes[i]!);
        messages.push({ role: "tool", tool_call_id: c.id, content: text });
        toolResults.push(text);
      });
    }

    const tail = guard.flush();
    if (tail) {
      ttftMs ??= ms();
      answer += tail;
      yield { type: "token", text: tail };
    }
  } catch (err) {
    error = err instanceof LLMError ? err.message : `Unexpected error: ${(err as Error).name}`;
  } finally {
    // Stage 6: persist the assistant turn. This also runs if the client
    // disconnects mid-stream, so memory always matches what was shown.
    const text = answer.trim();
    if (text) {
      try {
        stored = await store.save({
          userId: input.userId, sessionId: input.sessionId, role: "assistant", content: text,
          meta: {
            sources, queries, ttft_ms: ttftMs, total_ms: ms(), search_ms: searchMs, hydrate_ms: hydrateMs,
            searched: queries.length > 0, removed_urls: guard.removed.length,
          },
        });
      } catch (err) {
        error ||= `The answer could not be saved to memory. ${(err as Error).message}`;
      }
    }
  }

  if (error) yield { type: "error", message: error };
  else if (!answer.trim()) yield { type: "error", message: "The model returned an empty response. Please try again." };
  yield finish({
    assistant_message_id: stored?.id ?? null,
    created_at: stored?.createdAt ?? toIso(new Date()),
    ttft_ms: ttftMs, search_ms: searchMs, hydrate_ms: hydrateMs, searched: queries.length > 0, removed_urls: guard.removed.length,
  });
}
