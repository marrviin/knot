//! LLM provider defaults + embedding identity. Previously duplicated between
//! electron/settings.ts's DEFAULTS/EMBED_DIMS and server/src/config.ts's
//! PROVIDER_DEFAULTS/EMBED_DIMS (both carrying "keep in sync" comments); the
//! server must stay deployable without the Electron tree, which is why this
//! lives in the zero-dependency shared package.

import type { LlmConfig, LlmProvider } from './types';

/** Provider defaults — consumed by the desktop settings UI and the server's env
 *  config alike. */
export const PROVIDER_DEFAULTS: Record<LlmProvider, { baseUrl: string; model: string; embedModel: string }> = {
  minimax: { baseUrl: 'https://api.minimax.cn/v1', model: 'MiniMax-M2.7', embedModel: 'embo-01' },
  openai: { baseUrl: 'https://api.openai.com/v1', model: 'gpt-5-mini', embedModel: 'text-embedding-3-small' },
};

/** Native embedding dimensions of known models; the vector store is created with this
 *  dimension, so switching to a model with different dims invalidates all vectors.
 *  Unknown models fall back to 1536 (the most common). */
const EMBED_DIMS: Record<string, number> = {
  'embo-01': 1536,
  'text-embedding-3-small': 1536,
  'text-embedding-3-large': 3072,
  'bge-m3': 1024,
  'qwen3-embedding-0.6b': 1024,
};

export function embedDimsOf(embedModel: string): number {
  const name = embedModel.trim().toLowerCase();
  // Registry models carry an org prefix (BAAI/bge-m3) — match the full name first,
  // then the bare model name.
  return EMBED_DIMS[name] ?? EMBED_DIMS[name.split('/').pop() ?? ''] ?? 1536;
}

/** Identity of the embedding space: any change invalidates every stored vector. */
export function embedSignatureOf(llm: LlmConfig): string {
  return `${llm.provider}/${llm.embedModel.trim().toLowerCase()}`;
}
