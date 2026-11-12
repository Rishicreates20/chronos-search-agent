// The memory model shared by both storage backends.
//
// Every message is stored once with an immutable ISO-8601 UTC timestamp.
// A user (one browser) owns many sessions; the sliding window is per
// session, recall by time or keyword spans all of that user's sessions.

export type Role = "user" | "assistant";

export interface Message {
  id: number;
  userId: string;
  sessionId: string;
  role: Role;
  content: string;
  createdAt: string; // 2026-11-11T15:36:02.123Z, fixed width, so string order == time order
  meta: Record<string, unknown>;
}

export interface TurnRequest {
  userId: string;
  sessionId: string;
  content: string;
  createdAt: Date;
  window: number; // sliding window size, in messages
  range?: { start: Date; end: Date }; // start <= created_at < end
  terms?: string[]; // keyword recall
  logLimit?: number; // this session's user questions
}

/** Everything one turn needs from memory, fetched in one go. */
export interface TurnContext {
  user: Message; // the message just stored
  recent: Message[];
  rangeRows: Message[];
  rangeTotal: number;
  hits: Message[]; // keyword matches plus the other half of each matched turn
  log: Message[];
}

export interface MemoryStore {
  readonly kind: "sqlite" | "supabase";
  /** Store the user's message and load the memory this turn needs. */
  beginTurn(req: TurnRequest): Promise<TurnContext>;
  save(msg: { userId: string; sessionId: string; role: Role; content: string; meta?: Record<string, unknown>; createdAt?: Date }): Promise<Message>;
  history(userId: string, sessionId: string, limit?: number): Promise<Message[]>;
  close(): Promise<void>;
}

export class StoreError extends Error {}

export const RANGE_LIMIT = 40;
export const HIT_LIMIT = 8;

/** Fixed-width millisecond ISO-8601 UTC. */
export const toIso = (d: Date): string => d.toISOString();
