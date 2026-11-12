// Runtime configuration, read once from the environment (and an optional .env).
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

export const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

// Every provider is reached through the same OpenAI-compatible
// /chat/completions wire format, so switching is configuration only.
const PROVIDERS: Record<string, { baseUrl: string; model: string; reasoningEffort: string }> = {
  groq: {
    baseUrl: "https://api.groq.com/openai/v1",
    model: "openai/gpt-oss-120b",
    // A reasoning model: keep its thinking short for a fast first token.
    reasoningEffort: "low",
  },
  openai: { baseUrl: "https://api.openai.com/v1", model: "gpt-4o-mini", reasoningEffort: "" },
  gemini: {
    baseUrl: "https://generativelanguage.googleapis.com/v1beta/openai",
    model: "gemini-2.5-flash",
    reasoningEffort: "none",
  },
};

export interface Settings {
  llmApiKey: string;
  llmBaseUrl: string;
  llmModel: string;
  llmReasoningEffort: string;
  tavilyApiKey: string;
  tavilyBaseUrl: string;
  searchDepth: string;
  searchTimeoutMs: number;
  searchMaxResults: number;
  maxSearchRounds: number;
  historyTurns: number;
  dbPath: string;
  supabaseUrl: string;
  supabaseKey: string;
  memoryToken: string;
  port: number;
}

/** Minimal .env loader: KEY=VALUE lines; the real environment wins. */
export function loadDotenv(path = join(ROOT, ".env")): void {
  if (!existsSync(path)) return;
  for (const raw of readFileSync(path, "utf8").split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith("#") || !line.includes("=")) continue;
    const i = line.indexOf("=");
    const key = line.slice(0, i).trim();
    let value = line.slice(i + 1).trim();
    if (value.length >= 2 && value[0] === value.at(-1) && `"'`.includes(value[0]!)) value = value.slice(1, -1);
    if (process.env[key] === undefined) process.env[key] = value;
  }
}

export function settingsFromEnv(env: NodeJS.ProcessEnv = process.env): Settings {
  const preset = PROVIDERS[(env.LLM_PROVIDER ?? "groq").trim().toLowerCase()] ?? PROVIDERS.groq!;
  const str = (k: string, d = "") => (env[k] ?? d).trim();
  const num = (k: string, d: number) => (Number.isFinite(Number(env[k])) && env[k] ? Number(env[k]) : d);
  return {
    llmApiKey: str("LLM_API_KEY"),
    llmBaseUrl: (str("LLM_BASE_URL") || preset.baseUrl).replace(/\/+$/, ""),
    llmModel: str("LLM_MODEL") || preset.model,
    llmReasoningEffort: env.LLM_REASONING_EFFORT !== undefined ? str("LLM_REASONING_EFFORT") : preset.reasoningEffort,
    tavilyApiKey: str("TAVILY_API_KEY"),
    tavilyBaseUrl: str("TAVILY_BASE_URL", "https://api.tavily.com").replace(/\/+$/, ""),
    searchDepth: str("SEARCH_DEPTH", "fast") || "basic",
    searchTimeoutMs: num("SEARCH_TIMEOUT_S", 4) * 1000,
    searchMaxResults: num("SEARCH_MAX_RESULTS", 5),
    maxSearchRounds: num("MAX_SEARCH_ROUNDS", 2),
    historyTurns: num("HISTORY_TURNS", 10),
    // Serverless hosts only allow writes under /tmp; see DESIGN.md.
    dbPath: str("DB_PATH") || (env.VERCEL ? "/tmp/chronos.db" : join(ROOT, "data", "chronos.db")),
    supabaseUrl: str("SUPABASE_URL").replace(/\/+$/, ""),
    supabaseKey: str("SUPABASE_KEY"),
    memoryToken: str("MEMORY_TOKEN"),
    port: num("PORT", 3000),
  };
}
