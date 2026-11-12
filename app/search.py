"""The single external tool: web_search(query), backed by Tavily."""
from __future__ import annotations

from dataclasses import dataclass, field

import httpx

from .config import Settings

TOOL_SPEC = {
    "type": "function",
    "function": {
        "name": "web_search",
        "description": (
            "Search the live web. Use for anything recent, time-sensitive, or that you "
            "are not certain of. Returns the top results with title, URL and snippet."
        ),
        "parameters": {
            "type": "object",
            "properties": {
                "query": {
                    "type": "string",
                    "description": "A specific search query. Include the year or date for time-sensitive topics.",
                }
            },
            "required": ["query"],
        },
    },
}


@dataclass
class SearchOutcome:
    query: str
    results: list[dict] = field(default_factory=list)  # {title, url, snippet, published}
    error: str = ""                                    # "", "timeout", or a message

    def for_llm(self) -> str:
        if self.error == "timeout":
            return (
                "SEARCH_TIMEOUT: the search did not return in time. Do not cite any URL. If you are "
                "confident of the answer from your own knowledge, give it prefixed with the disclaimer "
                "\"Live search timed out, so this is from my training knowledge and may be outdated.\" "
                "Otherwise say you could not verify it right now."
            )
        if self.error:
            return (
                f"SEARCH_UNAVAILABLE ({self.error}). Do not cite any URL. Tell the user live search is "
                "unavailable; answer from your own knowledge only if confident, with an explicit "
                "disclaimer that it is unverified and may be outdated."
            )
        if not self.results:
            return (
                "NO_RESULTS: the search returned nothing. Say exactly \"I could not find verified "
                "information on this.\" Do not answer from guesswork and do not cite any URL."
            )
        blocks = []
        for i, r in enumerate(self.results, 1):
            published = f"\nPublished: {r['published']}" if r.get("published") else ""
            blocks.append(f"[{i}] {r['title']}\nURL: {r['url']}{published}\nSnippet: {r['snippet']}")
        return (
            f"Results for \"{self.query}\":\n\n" + "\n\n".join(blocks) + "\n\n"
            "Citation rule: put a markdown link to the supporting result directly after EACH claim, "
            "in the same sentence or bullet, e.g. \"NZ won by 87 runs [ESPN](https://...)\". "
            "Every bullet needs its own link. Do not collect sources in a line at the end."
        )


# Search endpoints that rejected a non-default search depth.
_depth_rejected: set[str] = set()


async def _post(client: httpx.AsyncClient, settings: Settings, query: str, depth: str) -> httpx.Response:
    return await client.post(
        f"{settings.tavily_base_url}/search",
        headers={"Authorization": f"Bearer {settings.tavily_api_key}"},
        json={
            "query": query,
            "max_results": settings.search_max_results,
            "search_depth": depth,
            "include_answer": False,
        },
        timeout=settings.search_timeout_s,
    )


async def web_search(client: httpx.AsyncClient, settings: Settings, query: str) -> SearchOutcome:
    """Never raises: every failure becomes an outcome the LLM is told about."""
    if not settings.tavily_api_key:
        return SearchOutcome(query, error="TAVILY_API_KEY is not configured")
    depth = "basic" if settings.tavily_base_url in _depth_rejected else settings.search_depth
    try:
        resp = await _post(client, settings, query, depth)
        if resp.status_code in (400, 422) and depth != "basic":
            # This account or API version does not take the faster depth:
            # use "basic" from now on.
            _depth_rejected.add(settings.tavily_base_url)
            resp = await _post(client, settings, query, "basic")
        resp.raise_for_status()
        data = resp.json()
    except httpx.TimeoutException:
        return SearchOutcome(query, error="timeout")
    except httpx.HTTPStatusError as exc:
        return SearchOutcome(query, error=f"search API returned HTTP {exc.response.status_code}")
    except Exception as exc:  # network, bad JSON
        return SearchOutcome(query, error=type(exc).__name__)

    results = []
    for item in data.get("results") or []:
        url = (item.get("url") or "").strip()
        if not url.startswith(("http://", "https://")):
            continue
        results.append(
            {
                "title": (item.get("title") or url).strip(),
                "url": url,
                "snippet": " ".join((item.get("content") or "").split())[:700],
                "published": item.get("published_date") or "",
            }
        )
    return SearchOutcome(query, results=results[: settings.search_max_results])
