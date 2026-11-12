// The single tool: web_search, backed by Tavily.
import type { Settings } from "./config.ts";

export const TOOL_SPEC = {
  type: "function",
  function: {
    name: "web_search",
    description:
      "Search the live web. Use for anything recent, time-sensitive, or that you are not certain of. " +
      "Returns the top results with title, URL, publish date when known, and a snippet. " +
      "You may call it several times in one step, one call per entity or question, and they run in parallel.",
    parameters: {
      type: "object",
      properties: {
        query: {
          type: "string",
          description: "A specific search query. Name the product or entity. Include the year for time-sensitive topics.",
        },
        since: {
          type: "string",
          description:
            "Optional YYYY-MM-DD. Only return pages published on or after this date. Use it for 'what changed since <date>' " +
            "questions about news or announcements. Omit it when looking up a current fact such as a pricing page.",
        },
      },
      required: ["query"],
    },
  },
} as const;

export interface SearchResult {
  title: string;
  url: string;
  snippet: string;
  published: string;
}

export interface SearchOutcome {
  query: string;
  since?: string;
  results: SearchResult[];
  error: "" | "timeout" | string;
  note?: string;
}

export const CITATION_RULE =
  'Citation rule: put a markdown link to the supporting result directly after EACH claim, in the same sentence or bullet, ' +
  'e.g. "NZ won by 87 runs [ESPN](https://...)". Every bullet needs its own link. Do not collect sources in a line at the end.';

export function forLLM(o: SearchOutcome): string {
  if (o.error === "timeout") {
    return (
      "SEARCH_TIMEOUT: the search did not return in time. Do not cite any URL. If you are confident of the answer from your " +
      'own knowledge, give it prefixed with "Live search timed out, so this is from my training knowledge and may be outdated." ' +
      "Otherwise say you could not verify it right now."
    );
  }
  if (o.error) {
    return (
      `SEARCH_UNAVAILABLE (${o.error}). Do not cite any URL. Tell the user live search is unavailable; answer from your own ` +
      "knowledge only if confident, with an explicit disclaimer that it is unverified and may be outdated."
    );
  }
  if (!o.results.length) {
    return (
      `NO_RESULTS for "${o.query}". For this part of the question say exactly "I could not find verified information on this." ` +
      "Do not answer it from guesswork and do not cite any URL for it."
    );
  }
  const blocks = o.results.map(
    (r, i) => `[${i + 1}] ${r.title}\nURL: ${r.url}${r.published ? `\nPublished: ${r.published}` : ""}\nSnippet: ${r.snippet}`,
  );
  const head = `Results for "${o.query}"${o.since ? ` (published since ${o.since})` : ""}${o.note ? ` — ${o.note}` : ""}:`;
  return `${head}\n\n${blocks.join("\n\n")}\n\n${CITATION_RULE}`;
}

// Search endpoints that rejected the optional parameters (depth, start_date).
const plainOnly = new Set<string>();

async function post(settings: Settings, fetchFn: typeof fetch, body: Record<string, unknown>): Promise<Response> {
  return fetchFn(`${settings.tavilyBaseUrl}/search`, {
    method: "POST",
    headers: { Authorization: `Bearer ${settings.tavilyApiKey}`, "Content-Type": "application/json" },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(settings.searchTimeoutMs),
  });
}

function parse(data: any, max: number): SearchResult[] {
  const out: SearchResult[] = [];
  for (const item of data?.results ?? []) {
    const url = String(item?.url ?? "").trim();
    if (!/^https?:\/\//.test(url)) continue;
    out.push({
      title: String(item.title ?? url).trim(),
      url,
      snippet: String(item.content ?? "").replace(/\s+/g, " ").trim().slice(0, 700),
      published: String(item.published_date ?? ""),
    });
  }
  return out.slice(0, max);
}

/** Never throws: every failure becomes an outcome the model is told about. */
export async function webSearch(settings: Settings, query: string, since: string | undefined, fetchFn: typeof fetch = fetch): Promise<SearchOutcome> {
  const validSince = since && /^\d{4}-\d{2}-\d{2}$/.test(since) ? since : undefined;
  if (!settings.tavilyApiKey) return { query, results: [], error: "TAVILY_API_KEY is not configured" };
  if (!query) return { query, results: [], error: "empty query" };
  const base = { query, max_results: settings.searchMaxResults, include_answer: false };
  const plain = { ...base, search_depth: "basic" };
  try {
    const usePlain = plainOnly.has(settings.tavilyBaseUrl);
    let dated = !usePlain && !!validSince;
    let resp = await post(settings, fetchFn, usePlain ? plain : { ...base, search_depth: settings.searchDepth, ...(validSince ? { start_date: validSince } : {}) });
    if ((resp.status === 400 || resp.status === 422) && !usePlain) {
      // This account or API version does not take the optional parameters.
      plainOnly.add(settings.tavilyBaseUrl);
      dated = false;
      resp = await post(settings, fetchFn, plain);
    }
    if (!resp.ok) return { query, results: [], error: `search API returned HTTP ${resp.status}` };
    let results = parse(await resp.json(), settings.searchMaxResults);
    let note: string | undefined;
    if (dated && !results.length) {
      // A date filter drops undated pages. Better to return unfiltered
      // results, labelled as such, than to report nothing.
      const again = await post(settings, fetchFn, { ...base, search_depth: settings.searchDepth });
      if (again.ok) results = parse(await again.json(), settings.searchMaxResults);
      note = "nothing was dated in that window, so these are not date-filtered; check each Published date";
      dated = false;
    }
    return { query, since: dated ? validSince : undefined, results, error: "", note };
  } catch (err) {
    const name = (err as Error).name;
    return { query, results: [], error: name === "TimeoutError" || name === "AbortError" ? "timeout" : name };
  }
}
