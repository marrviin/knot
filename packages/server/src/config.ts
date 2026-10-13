//! Server config: env-driven so the same bundle serves both deployment modes —
//! local mode (Electron spawns it as a child process, passing the user's LLM
//! settings through env) and remote mode (user-deployed Docker, env in compose).

import { PROVIDER_DEFAULTS, embedDimsOf, embedSignatureOf, type LlmConfig, type LlmProvider } from '@knot/shared';

// Shared contracts — memory-core.ts and app.ts keep importing them from './config'.
export { embedDimsOf, embedSignatureOf };
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
  llm: LlmConfig | null;
}

/** Parse the LLM block from env; null when unconfigured (server starts, /health
 *  reports ready:false, ingest answers 503 with the reason). */
function llmFromEnv(env: NodeJS.ProcessEnv): LlmConfig | null {
  const provider: LlmProvider = env.KNOT_LLM_PROVIDER === 'minimax' ? 'minimax' : 'openai';
  const apiKey = (env.KNOT_LLM_API_KEY ?? '').trim();
  const d = PROVIDER_DEFAULTS[provider];
  const baseUrl = (env.KNOT_LLM_BASE_URL ?? '').trim() || d.baseUrl;
  const model = (env.KNOT_LLM_MODEL ?? '').trim() || d.model;
  const embedModel = (env.KNOT_LLM_EMBED_MODEL ?? '').trim() || d.embedModel;
  if (!apiKey) return null;
  return { provider, baseUrl, apiKey, model, embedModel };
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
