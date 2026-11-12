// Entry point for serverless hosts (Vercel): export the app, do not listen.
import { createApp } from "./app.ts";
import { loadDotenv, settingsFromEnv } from "./config.ts";
import { openStore, type MemoryStore } from "./memory/index.ts";

loadDotenv();
const settings = settingsFromEnv();
let store: Promise<MemoryStore> | undefined;

export default createApp({ settings, getStore: () => (store ??= openStore(settings)) });
