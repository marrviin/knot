//! Shared contract types between the desktop client and the memory server.
//! Previously duplicated across electron/mem0.ts and server/src/memory-core.ts
//! (with "keep in sync" comments); this is now the single source of truth.

/** LLM protocol family. 'minimax' → MiniMax-native LLM; 'openai' → OpenAI-compatible
 *  chat. Only the chat side is user-configurable — embeddings always run locally
 *  (the bundled bge model), so there is no embedding configuration surface. */
export type LlmProvider = 'minimax' | 'openai';

export interface LlmConfig {
  provider: LlmProvider;
  baseUrl: string;
  apiKey: string;
  model: string;
  /** Informational: always the bundled local model — embeddings have no config. */
  embedModel: string;
}

/** A memory fact as the service's truth state reports it. */
export interface FactItem {
  id: string;
  memory: string;
  metadata?: Record<string, string>;
  /** Display timestamps (unix ms), owned by the server's meta store. null/absent
   *  for facts created before the meta store existed — UI renders "-". */
  createdAt?: number | null;
  updatedAt?: number | null;
}

/** Diff report between the project's pre- and post-mutation truth state. */
export interface IngestReport {
  added: number;
  updated: number;
  deleted: number;
  notice?: string;
}

/** mem0 semantic search hit — the server answers the wire shape (id/memory/score);
 *  the desktop client enriches it with mirror metadata for card display. */
export interface SemanticHit {
  id: string;
  memory: string;
  score: number;
  agent?: string;
  type?: string;
  source?: string;
  updatedAt?: number;
}
