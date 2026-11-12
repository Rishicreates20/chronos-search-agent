import type { Settings } from "../config.js";
import { SupabaseStore } from "./supabase.js";
import type { MemoryStore } from "./types.js";

export * from "./types.js";

/** Supabase when it is configured, otherwise the local SQLite file. The
 * SQLite driver is imported lazily so a hosted deployment never loads it. */
export async function openStore(settings: Settings, fetchFn: typeof fetch = fetch): Promise<MemoryStore> {
  if (settings.supabaseUrl && settings.supabaseKey && settings.memoryToken) {
    return new SupabaseStore(settings.supabaseUrl, settings.supabaseKey, settings.memoryToken, fetchFn);
  }
  const { SqliteStore } = await import("./sqlite.js");
  return new SqliteStore(settings.dbPath);
}
