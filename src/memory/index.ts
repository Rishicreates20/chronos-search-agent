import type { Settings } from "../config.ts";
import { SupabaseStore } from "./supabase.ts";
import type { MemoryStore } from "./types.ts";

export * from "./types.ts";

/** Supabase when it is configured, otherwise the local SQLite file. The
 * SQLite driver is imported lazily so a hosted deployment never loads it. */
export async function openStore(settings: Settings, fetchFn: typeof fetch = fetch): Promise<MemoryStore> {
  if (settings.supabaseUrl && settings.supabaseKey && settings.memoryToken) {
    return new SupabaseStore(settings.supabaseUrl, settings.supabaseKey, settings.memoryToken, fetchFn);
  }
  const { SqliteStore } = await import("./sqlite.ts");
  return new SqliteStore(settings.dbPath);
}
