//! Server config: env-driven so the same bundle serves both deployment modes —
//! local mode (Electron spawns it as a child process, passing the user's LLM
//! settings through env) and remote mode (user-deployed Docker, env in compose).

import { LOCAL_EMBED_MODEL, PROVIDER_DEFAULTS, embedSignatureOf, type LlmConfig, type LlmProvider } from '@knot/shared';

// Shared contracts — memory-core.ts and app.ts keep importing them from './config'.
export { embedSignatureOf, LOCAL_EMBED_MODEL };
export type { LlmConfig, LlmProvider };

export interface ServerConfig {
  host: string;
  port: number;
  /** Directory holding vectors.db / history.db / embed-signature (server-owned data). */
  dataDir: string;
  /** Optional bearer token; null = no auth (local loopback child process). */
  token: string | null;
  /** Access-Control-Allow-Origin: true reflects the request origin (local
   *  renderer / file:// builds); a remote deployment pins an explicit origin. */
  corsOrigin: boolean | string;
  /** Always present — the chat LLM inside may be unkeyed (local-only mode). */
  llm: LlmConfig;
}

/** Parse the LLM block from env. The chat LLM is optional — embeddings always
 *  run locally (the bundled bge model), so the memory layer works with zero
 *  configuration; the API key only enables the chat side (journal backfill). */
function llmFromEnv(env: NodeJS.ProcessEnv): LlmConfig {
  const provider: LlmProvider = env.KNOT_LLM_PROVIDER === 'minimax' ? 'minimax' : 'openai';
  const d = PROVIDER_DEFAULTS[provider];
  return {
    provider,
    baseUrl: (env.KNOT_LLM_BASE_URL ?? '').trim() || d.baseUrl,
    apiKey: (env.KNOT_LLM_API_KEY ?? '').trim(),
    model: (env.KNOT_LLM_MODEL ?? '').trim() || d.model,
    embedModel: LOCAL_EMBED_MODEL,
  };
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): ServerConfig {
  return {
    host: (env.KNOT_HOST ?? '127.0.0.1').trim() || '127.0.0.1',
    port: Number(env.KNOT_PORT) > 0 ? Number(env.KNOT_PORT) : 27184,
    dataDir: (env.KNOT_DATA_DIR ?? '').trim() || 'data',
    // Local mode: the parent generates an ephemeral token per launch; Docker: set KNOT_TOKEN.
    token: (env.KNOT_TOKEN ?? '').trim() || null,
    // CORS: true = reflect any origin (default — the desktop renderer is a local
    // page); remote deployments set KNOT_CORS_ORIGIN to a pinned origin.
    corsOrigin: ((env.KNOT_CORS_ORIGIN ?? '').trim() || true) as boolean | string,
    llm: llmFromEnv(env),
  };
}
