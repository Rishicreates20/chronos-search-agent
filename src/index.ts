// Entry point for serverless hosts (Vercel): export the app, do not listen.
// The static UI in public/ is served by the host.
import { Hono } from "hono";
import { loadDotenv, settingsFromEnv } from "./config.js";
import { createApp } from "./http.js";
import { openStore, type MemoryStore } from "./memory/index.js";

loadDotenv();
const settings = settingsFromEnv();
let store: Promise<MemoryStore> | undefined;

const app = new Hono();
app.route("/", createApp({ settings, getStore: () => (store ??= openStore(settings)) }));

export default app;
