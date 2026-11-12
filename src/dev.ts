// Local server: `npm run dev`. Serves the API and the static UI.
import { serve } from "@hono/node-server";
import { serveStatic } from "@hono/node-server/serve-static";
import { Hono } from "hono";
import { createApp } from "./app.ts";
import { loadDotenv, settingsFromEnv } from "./config.ts";
import { openStore } from "./memory/index.ts";

loadDotenv();
const settings = settingsFromEnv();
const store = await openStore(settings);

const app = new Hono();
app.route("/", createApp({ settings, getStore: async () => store }));
app.use("/*", serveStatic({ root: "./public" }));

serve({ fetch: app.fetch, port: settings.port }, ({ port }) => {
  console.log(`Chronos is running at http://localhost:${port}  (model: ${settings.llmModel}, memory: ${store.kind})`);
  if (!settings.llmApiKey) console.warn("  LLM_API_KEY is not set: copy .env.example to .env and add it.");
  if (!settings.tavilyApiKey) console.warn("  TAVILY_API_KEY is not set: web search will be unavailable.");
});

// Open TLS connections now so the first question does not pay for the
// handshakes. Best effort.
for (const url of [`${settings.llmBaseUrl}/models`, settings.tavilyBaseUrl]) {
  fetch(url, { signal: AbortSignal.timeout(3000) }).catch(() => {});
}
