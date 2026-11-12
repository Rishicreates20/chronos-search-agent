// Entry point for serverless hosts (Vercel): export the app, do not listen.
import { createApp } from "./http.js";
import { loadDotenv, settingsFromEnv } from "./config.js";
import { openStore, type MemoryStore } from "./memory/index.js";

loadDotenv();
const settings = settingsFromEnv();
let store: Promise<MemoryStore> | undefined;

export default createApp({ settings, getStore: () => (store ??= openStore(settings)) });
