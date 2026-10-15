//! LLM provider defaults + embedding identity. Previously duplicated between
//! electron/settings.ts's DEFAULTS/EMBED_DIMS and server/src/config.ts's
//! PROVIDER_DEFAULTS/EMBED_DIMS (both carrying "keep in sync" comments); the
//! server must stay deployable without the Electron tree, which is why this
//! lives in the zero-dependency shared package.

import type { LlmConfig } from './types';

/** The bundled local embedding model — served by the server process's local
 *  embedder (ONNX q8, ~24MB, packed into the installer; no network at runtime).
 *  bge-small-zh-v1.5: Chinese-focused but trained on zh-en pairs, so mixed
 *  memory content (中文 + code terms) works; C-MTEB beats e5-small at 1/5 the size. */
export const LOCAL_EMBED_MODEL = 'bge-small-zh-v1.5';

/** Chat-LLM defaults (OpenAI-compatible) — consumed by the desktop settings UI
 *  and the server's env config alike. Embeddings have no defaults: they always
 *  run locally. */
export const PROVIDER_DEFAULT = { baseUrl: 'https://api.openai.com/v1', model: 'gpt-5-mini' };

/** Identity of the embedding space. Embeddings always come from the bundled local
 *  model, so this is constant for a given app build — it only changes (and
 *  invalidates stored vectors) when the bundled model itself is upgraded. */
export function embedSignatureOf(llm: LlmConfig): string {
  return `local/${llm.embedModel.trim().toLowerCase()}`;
}
