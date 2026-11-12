// Direct, framework-free streaming client for an OpenAI-compatible
// /chat/completions endpoint (Groq, OpenAI, or Gemini's compatibility API).
import type { Settings } from "./config.js";

export class LLMError extends Error {}

export interface ToolCall {
  id: string;
  name: string;
  arguments: string;
}

export type ChatMessage =
  | { role: "system" | "user"; content: string }
  | { role: "assistant"; content?: string; tool_calls?: { id: string; type: "function"; function: { name: string; arguments: string } }[] }
  | { role: "tool"; tool_call_id: string; content: string };

export type LLMEvent = { type: "text"; text: string } | { type: "tool_calls"; calls: ToolCall[] };

// Endpoints that returned 400 for `reasoning_effort`; see streamChat().
const noReasoningParam = new Set<string>();

/** Yields text as tokens arrive, then one event with fully assembled tool calls. */
export async function* streamChat(
  settings: Settings,
  messages: ChatMessage[],
  tools: unknown[] | null,
  fetchFn: typeof fetch = fetch,
): AsyncGenerator<LLMEvent> {
  if (!settings.llmApiKey) throw new LLMError("LLM_API_KEY is not set. Copy .env.example to .env and add your key.");
  const url = `${settings.llmBaseUrl}/chat/completions`;
  const payload: Record<string, unknown> = { model: settings.llmModel, messages, stream: true, temperature: 0.2 };
  if (tools?.length) payload.tools = tools;
  if (settings.llmReasoningEffort && !noReasoningParam.has(url)) payload.reasoning_effort = settings.llmReasoningEffort;

  let resp: Response | undefined;
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      resp = await fetchFn(url, {
        method: "POST",
        headers: { Authorization: `Bearer ${settings.llmApiKey}`, "Content-Type": "application/json" },
        body: JSON.stringify(payload),
        signal: AbortSignal.timeout(60_000),
      });
    } catch (err) {
      throw new LLMError(`Could not reach the LLM API (${(err as Error).name}).`);
    }
    if (resp.ok) break;
    const body = await resp.text();
    if (resp.status === 400 && "reasoning_effort" in payload && attempt === 0) {
      // This model or endpoint rejects the parameter: drop it for the rest
      // of the process and retry once.
      noReasoningParam.add(url);
      delete payload.reasoning_effort;
      continue;
    }
    throw new LLMError(`LLM API returned HTTP ${resp.status}: ${errorText(body)}`);
  }
  if (!resp?.ok || !resp.body) throw new LLMError("LLM API returned no response body.");

  const calls: ToolCall[] = [];
  const decoder = new TextDecoder();
  let buf = "";
  for await (const chunk of resp.body as unknown as AsyncIterable<Uint8Array>) {
    buf += decoder.decode(chunk, { stream: true });
    let nl: number;
    while ((nl = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, nl).trim();
      buf = buf.slice(nl + 1);
      if (!line.startsWith("data:")) continue;
      const data = line.slice(5).trim();
      if (!data || data === "[DONE]") continue;
      let parsed: any;
      try {
        parsed = JSON.parse(data);
      } catch {
        continue;
      }
      if (parsed?.error) throw new LLMError(`LLM API error: ${errorText(data)}`);
      for (const choice of parsed.choices ?? []) {
        const delta = choice.delta ?? {};
        if (delta.content) yield { type: "text", text: delta.content };
        for (const tc of delta.tool_calls ?? []) mergeToolCall(calls, tc);
      }
    }
  }
  yield { type: "tool_calls", calls: calls.filter((c) => c.name) };
}

/** OpenAI streams a call in fragments keyed by index. Other providers send
 * each call whole and may omit or repeat the index, so also split on a new id. */
function mergeToolCall(calls: ToolCall[], tc: any): void {
  const fn = tc.function ?? {};
  let target: ToolCall | undefined = Number.isInteger(tc.index) ? calls[tc.index] : undefined;
  if (target && tc.id && target.id && tc.id !== target.id) target = undefined;
  if (!target && tc.index === undefined && calls.length && !tc.id && !fn.name) target = calls.at(-1);
  if (!target) {
    target = { id: "", name: "", arguments: "" };
    calls.push(target);
  }
  target.id ||= tc.id ?? "";
  target.name ||= fn.name ?? "";
  target.arguments += fn.arguments ?? "";
}

function errorText(body: string): string {
  try {
    let data = JSON.parse(body);
    if (Array.isArray(data)) data = data[0];
    const err = data?.error ?? data;
    return String(typeof err === "object" ? err.message ?? JSON.stringify(err) : err).slice(0, 300);
  } catch {
    return body.slice(0, 300);
  }
}
