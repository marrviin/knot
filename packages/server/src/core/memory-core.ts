//! Memory core (ported from electron/mem0.ts): mem0 instance lifecycle + memory
//! ingestion. Ingestion skips mem0's LLM extraction (infer: false) — watched
//! files are agent-curated already, so raw text goes straight to the vector
//! store; near-dup compaction keeps re-imports deduped.
//! The mirror store stays on the client — the server is the single truth source:
//! every mutation returns the project's full fact list so the client reconciles
//! its mirror from it.
//!
//! Ported behaviors (unchanged from the original):
//! - LLM: provider-configurable — MiniMax (mem0's native minimax provider) or any
//!   OpenAI-compatible service;
//! - Embedding: MiniMax embo-01 via the local shim for the minimax protocol, or a
//!   standard OpenAI-compatible /embeddings endpoint passed through;
//! - Vector store: mem0's built-in SQLite persistence (vectorStore.provider=memory +
//!   dbPath); no Qdrant needed.

import fs from 'node:fs';
import path from 'node:path';
import { Memory, type MemoryConfig } from 'mem0ai/oss';

import { embedDimsOf, embedSignatureOf, type LlmConfig } from '../config';
import { startEmbeddingShim, type ShimHandle } from '../embedding-shim';
import { findNearDupIds, withTimeout, type FactItem, type IngestReport, type SemanticHit } from '@knot/shared';

/** Ingestion behavior tuning: keep the original language, no meta info, correct old memories on conflict */
const CUSTOM_INSTRUCTIONS =
  '记忆保持原文语言，中文内容输出中文，不要附加日期或 Observation Date 等元信息。' +
  '若新信息与某条已有记忆矛盾，视作对该记忆的更正：用 UPDATE 改写那条旧记忆，不要为矛盾信息新增条目。';

let memory: Memory | null = null;
let shim: ShimHandle | null = null;
let currentKey: string | null = null;
/** Single-flight guard for ensureMemory: concurrent callers (startup import vs a
 *  live change vs a manual add) share one rebuild instead of each starting their
 *  own embedding shim and racing over process.env.OPENAI_BASE_URL. */
let ensurePromise: Promise<Memory | null> | null = null;

const ADD_TIMEOUT_MS = 3 * 60_000; // embedding (RPM-cap retries) can legitimately take a while
const QUERY_TIMEOUT_MS = 60_000;

/** Lazily initialize or rebuild the mem0 instance from config. Returns null when
 *  the LLM block is unconfigured (server starts anyway; /health reports ready:false). */
export async function ensureMemory(cfg: LlmConfig | null, dataDir: string): Promise<Memory | null> {
  if (!cfg) return null;
  const key = `${cfg.provider}|${cfg.baseUrl}|${cfg.apiKey}|${cfg.model}|${cfg.embedModel}`;
  if (memory && currentKey === key) return memory;
  if (ensurePromise) return ensurePromise;

  // Changing the embedding model changes the whole vector space — stored vectors
  // (and the vector store's dimension) no longer match. Semantic search will fail
  // loudly and fall back to keyword; surface the cause for whoever debugs it.
  const signature = embedSignatureOf(cfg);
  const sigFile = path.join(dataDir, 'embed-signature');
  const prevSignature = fs.existsSync(sigFile) ? fs.readFileSync(sigFile, 'utf8').trim() : '';
  if (prevSignature && prevSignature !== signature) {
    console.error(
      `[Knot server] embedding 模型已从 ${prevSignature} 变为 ${signature}：旧向量与 ${embedDimsOf(cfg.embedModel)} 维新空间不匹配，语义检索将不可用。需清空并重新导入记忆（或换回原模型）。`,
    );
  }

  const mem0Dir = dataDir;
  fs.mkdirSync(mem0Dir, { recursive: true });
  ensurePromise = (async () => {
    if (shim) shim.close();
    let newShim: ShimHandle | null = null;
    try {
      let embedder: MemoryConfig['embedder'];
      let llm: MemoryConfig['llm'];
      if (cfg.provider === 'openai') {
        // OpenAI-compatible: standard /chat/completions + /embeddings, straight through.
        llm = {
          provider: 'openai',
          config: { apiKey: cfg.apiKey, model: cfg.model, baseURL: cfg.baseUrl, maxTokens: 4000, temperature: 0 },
        };
        embedder = {
          provider: 'openai',
          config: {
            apiKey: cfg.apiKey,
            model: cfg.embedModel,
            baseURL: cfg.baseUrl,
            embeddingDims: embedDimsOf(cfg.embedModel),
          },
        };
      } else {
        // MiniMax: its /v1/embeddings rejects OpenAI's `input` (needs `texts`) and
        // answers {vectors} — translate via the local shim (serialized + rate-limit
        // retries for embo-01's RPM cap).
        newShim = await startEmbeddingShim(cfg.apiKey, cfg.baseUrl, cfg.embedModel);
        process.env.OPENAI_BASE_URL = `http://127.0.0.1:${newShim.port}/v1`;
        llm = {
          provider: 'minimax',
          config: { apiKey: cfg.apiKey, model: cfg.model, baseURL: cfg.baseUrl, maxTokens: 4000, temperature: 0 },
        };
        embedder = {
          provider: 'openai',
          config: {
            apiKey: cfg.apiKey,
            model: cfg.embedModel,
            embeddingDims: embedDimsOf(cfg.embedModel),
          },
        };
      }
      shim = newShim;
      const m = new Memory({
        llm,
        embedder,
        vectorStore: {
          provider: 'memory',
          config: {
            collectionName: 'knot',
            dimension: embedDimsOf(cfg.embedModel),
            dbPath: path.join(mem0Dir, 'vectors.db'),
          },
        },
        historyStore: {
          provider: 'sqlite',
          config: { historyDbPath: path.join(mem0Dir, 'history.db') },
        },
        customInstructions: CUSTOM_INSTRUCTIONS,
      });
      memory = m;
      currentKey = key;
      fs.writeFileSync(sigFile, signature);
      return m;
    } catch (e) {
      // Constructor failed: tear the new shim back down so it can't leak, and
      // invalidate the old state (its shim is already closed, config changed anyway).
      newShim?.close();
      shim = null;
      memory = null;
      currentKey = null;
      throw e;
    }
  })().finally(() => {
    ensurePromise = null;
  });
  return ensurePromise;
}

export function isReady(): boolean {
  return memory !== null;
}

/** Batch-embed texts through the configured /embeddings endpoint. MiniMax goes
 *  through the local shim (which answers in OpenAI format); openai provider is a
 *  native OpenAI-compatible endpoint. Returns null when unconfigured — compaction
 *  is best-effort, not a hard dependency. */
async function embedTexts(cfg: LlmConfig | null, shimPort: number | null, texts: string[]): Promise<number[][] | null> {
  if (!cfg || !cfg.apiKey) return null;
  // MiniMax: route through the shim (it translates OpenAI's `input` into the
  // native `texts`+`type` the upstream requires). Original hit s.baseUrl directly
  // with OpenAI format — the shim is strictly more correct for the minimax family.
  const url =
    cfg.provider === 'minimax' && shimPort
      ? `http://127.0.0.1:${shimPort}/embeddings`
      : `${cfg.baseUrl.replace(/\/$/, '')}/embeddings`;
  const resp = await fetch(url, {
    method: 'POST',
    headers: { Authorization: `Bearer ${cfg.apiKey}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ model: cfg.embedModel, input: texts }),
    signal: AbortSignal.timeout(60_000),
  });
  if (!resp.ok) throw new Error(`embeddings HTTP ${resp.status}`);
  const j = (await resp.json()) as { data?: { index: number; embedding: number[] }[] };
  const rows = [...(j.data ?? [])].sort((a, b) => a.index - b.index);
  if (rows.length !== texts.length) throw new Error(`embeddings 返回 ${rows.length}/${texts.length} 条`);
  return rows.map((r) => r.embedding);
}

/** Delete near-duplicate memories from mem0 itself so getAll stays the single
 *  truth and the client's mirror reconciliation picks the collapse up for free. */
async function compactNearDups(
  m: Memory,
  cfg: LlmConfig | null,
  shimPort: number | null,
  results: { id: string; memory: string }[],
  preferExisting: Set<string>,
): Promise<Map<string, string>> {
  if (results.length < 2) return new Map();
  // Canonical preference: a fact the client mirror already holds beats a fresh re-ADD.
  const ordered = [...results].sort(
    (a, b) => Number(preferExisting.has(b.id)) - Number(preferExisting.has(a.id)),
  );
  const vectors = new Map<string, number[]>();
  const embs = await embedTexts(cfg, shimPort, ordered.map((r) => r.memory));
  if (!embs) return new Map();
  ordered.forEach((r, i) => vectors.set(r.id, embs[i]!));
  const dupOf = findNearDupIds(ordered, vectors);
  for (const id of dupOf.keys()) {
    await withTimeout(m.delete(id), QUERY_TIMEOUT_MS, '删除近重复记忆');
  }
  return dupOf;
}

/** The project's full truth state: every fact with its mem0 metadata. */
async function listAll(m: Memory, projectId: string): Promise<FactItem[]> {
  const all = await withTimeout(
    m.getAll({ filters: { user_id: projectId }, topK: 10000 }),
    QUERY_TIMEOUT_MS,
    '读取记忆',
  );
  return all.results
    .filter((r) => r.id && r.memory)
    .map((r) => ({
      id: r.id!,
      memory: r.memory,
      metadata: (r.metadata ?? {}) as Record<string, string>,
    }));
}

/** Diff two truth snapshots into the report the client mirrors. */
function diffReports(
  before: Map<string, string>,
  after: FactItem[],
): { report: IngestReport; facts: FactItem[] } {
  const report: IngestReport = { added: 0, updated: 0, deleted: 0 };
  const afterIds = new Set<string>();
  for (const f of after) {
    afterIds.add(f.id);
    if (!before.has(f.id)) report.added += 1;
    else if (before.get(f.id) !== f.memory) report.updated += 1;
  }
  report.deleted = [...before.keys()].filter((id) => !afterIds.has(id)).length;
  return { report, facts: after };
}

/** Ingest raw memory text into mem0, then return the truth diff + full fact list
 *  (the client reconciles its mirror from it). Stored with infer: false — the
 *  text is agent-curated already, so no LLM extraction; near-dup compaction
 *  below keeps re-imports deduped. Does not rely on add()'s results events: in
 *  practice add events on 3.3.1 can be empty even though the data did land in
 *  the vector store, so the real state from getAll is the most reliable source. */
export async function ingest(
  cfg: LlmConfig | null,
  dataDir: string,
  projectId: string,
  raw: string,
  meta: { agent: string; type: string; source: string },
  preferExisting: Set<string> = new Set(),
): Promise<{ report: IngestReport; facts: FactItem[] }> {
  const m = await ensureMemory(cfg, dataDir);
  if (!m) return { report: { added: 0, updated: 0, deleted: 0, notice: '记忆库未启用或未配置' }, facts: [] };

  const before = await listAll(m, projectId);
  const beforeMap = new Map(before.map((f) => [f.id, f.memory]));

  await withTimeout(
    m.add(raw, {
      userId: projectId,
      metadata: { agent: meta.agent, type: meta.type, source: meta.source },
      infer: false,
    }),
    ADD_TIMEOUT_MS,
    '记忆入库',
  );

  // Near-dup compaction runs on every ingest (best-effort — failure must not break
  // the ingest itself): re-ADDs of nearly identical text are deleted from mem0.
  let after = await listAll(m, projectId);
  const shimPort = shim?.port ?? null;
  const dupOf = await compactNearDups(
    m,
    cfg,
    shimPort,
    after.map((f) => ({ id: f.id, memory: f.memory })),
    preferExisting,
  ).catch(() => new Map<string, string>());
  if (dupOf.size) after = after.filter((f) => !dupOf.has(f.id));

  return diffReports(beforeMap, after);
}

/** Manual entry / correction: write to mem0 directly (no extraction). */
export function addManualMemory(
  cfg: LlmConfig | null,
  dataDir: string,
  projectId: string,
  content: string,
  preferExisting: Set<string> = new Set(),
): Promise<{ report: IngestReport; facts: FactItem[] }> {
  return ingest(cfg, dataDir, projectId, content, { agent: 'user', type: 'manual', source: '' }, preferExisting);
}

/** Rewrite one memory's content in place (mem0 re-embeds). Throws on failure —
 *  the client only updates its mirror after this succeeds. */
export async function updateFact(cfg: LlmConfig | null, dataDir: string, memoryId: string, content: string): Promise<void> {
  const m = await ensureMemory(cfg, dataDir);
  if (!m) throw new Error('LLM 提炼未启用或未配置，无法更新记忆');
  await withTimeout(m.update(memoryId, { text: content }), ADD_TIMEOUT_MS, '更新记忆');
}

export async function removeFact(cfg: LlmConfig | null, dataDir: string, memoryId: string): Promise<void> {
  const m = await ensureMemory(cfg, dataDir);
  if (m) await withTimeout(m.delete(memoryId), QUERY_TIMEOUT_MS, '删除记忆');
}

/** The project's full fact list (client mirror restore). */
export async function listFacts(
  cfg: LlmConfig | null,
  dataDir: string,
  projectId: string,
): Promise<FactItem[]> {
  const m = await ensureMemory(cfg, dataDir);
  if (!m) return [];
  return listAll(m, projectId);
}

/** mem0 semantic search: query a project's memories in natural language. */
export async function semanticSearch(
  cfg: LlmConfig | null,
  dataDir: string,
  projectId: string,
  query: string,
  topK = 8,
): Promise<SemanticHit[]> {
  const m = await ensureMemory(cfg, dataDir);
  if (!m) return [];
  const r = await withTimeout(
    m.search(query, { filters: { user_id: projectId }, topK }),
    QUERY_TIMEOUT_MS,
    '语义检索',
  );
  return r.results
    .filter((x) => x.id && x.memory)
    .map((x) => ({ id: x.id!, memory: x.memory, score: x.score ?? 0 }));
}

/** Count of mem0 memories for a project attributed to a given agent — used to
 *  detect "guided import already ran" without burning LLM calls again. */
export async function countByAgent(
  _cfg: LlmConfig | null,
  _dataDir: string,
  projectId: string,
  agent: string,
): Promise<number> {
  if (!memory) return 0;
  try {
    const all = await listAll(memory, projectId);
    return all.filter((f) => (f.metadata ?? {}).agent === agent).length;
  } catch (e) {
    console.error('[Knot server] 迁移检查读取失败:', e);
    return 0;
  }
}

export function shutdown(): void {
  shim?.close();
  shim = null;
  memory = null;
  currentKey = null;
}
