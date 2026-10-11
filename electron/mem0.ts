//! mem0 integration: Memory instance management + memory ingestion (extraction/
//! dedup/conflict adjudication are all handled by mem0), plus syncing mem0's
//! ADD/UPDATE/DELETE events into the mirror store.
//!
//! Empirical findings from the 2026-10-10 spike:
//! - LLM: mem0's native minimax provider (MiniMax-M2.7 non-reasoning model, stable parsing);
//! - Embedding: MiniMax embo-01, adapted to the OpenAI format via a local shim (embedding-shim);
//! - Vector store: mem0's built-in SQLite persistence (vectorStore.provider=memory + dbPath);
//!   no Qdrant needed.

import path from 'node:path';
import { Memory } from 'mem0ai/oss';

import * as store from './store';
import * as settings from './settings';
import { startEmbeddingShim, type ShimHandle } from './embedding-shim';

/** Ingestion behavior tuning: keep the original language, no meta info, correct old memories on conflict */
const CUSTOM_INSTRUCTIONS =
  '记忆保持原文语言，中文内容输出中文，不要附加日期或 Observation Date 等元信息。' +
  '若新信息与某条已有记忆矛盾，视作对该记忆的更正：用 UPDATE 改写那条旧记忆，不要为矛盾信息新增条目。';

export interface IngestReport {
  added: number;
  updated: number;
  deleted: number;
  notice?: string;
}

let memory: Memory | null = null;
let shim: ShimHandle | null = null;
let currentKey: string | null = null;

/** Lazily initialize or rebuild the mem0 instance from settings. Returns null when unconfigured. */
export async function ensureMemory(userDataDir: string): Promise<Memory | null> {
  const s = settings.load(store);
  if (!s.enabled || !settings.isConfigured(s)) return null;
  if (memory && currentKey === `${s.baseUrl}|${s.apiKey}|${s.model}`) return memory;

  const mem0Dir = path.join(userDataDir, 'mem0');
  if (shim) shim.close();
  shim = await startEmbeddingShim(s.apiKey, s.baseUrl);
  process.env.OPENAI_BASE_URL = `http://127.0.0.1:${shim.port}/v1`;

  memory = new Memory({
    llm: {
      provider: 'minimax',
      config: { apiKey: s.apiKey, model: s.model, baseURL: s.baseUrl, maxTokens: 4000, temperature: 0 },
    },
    embedder: {
      provider: 'openai',
      config: { apiKey: s.apiKey, model: 'embo-01', embeddingDims: 1536 },
    },
    vectorStore: {
      provider: 'memory',
      config: { collectionName: 'knot', dimension: 1536, dbPath: path.join(mem0Dir, 'vectors.db') },
    },
    historyStore: {
      provider: 'sqlite',
      config: { historyDbPath: path.join(mem0Dir, 'history.db') },
    },
    customInstructions: CUSTOM_INSTRUCTIONS,
  });
  currentKey = `${s.baseUrl}|${s.apiKey}|${s.model}`;
  return memory;
}

export function isReady(): boolean {
  return memory !== null;
}

/** Ingest raw memory text into mem0, then reconcile the mirror store against
 *  the actual state reported by getAll.
 *  (Does not rely on add()'s results events: in practice add events on 3.3.1
 *  can be empty even though the data did land in the vector store, so the real
 *  state from getAll is the most reliable source.) */
export async function ingest(
  userDataDir: string,
  projectId: string,
  raw: string,
  meta: { agent: string; type: string; source: string },
): Promise<IngestReport> {
  const m = await ensureMemory(userDataDir);
  if (!m) return { added: 0, updated: 0, deleted: 0 };

  const before = new Map(store.listFacts(projectId).map((f) => [f.id, f.content]));

  try {
    await m.add(raw, {
      userId: projectId,
      metadata: { agent: meta.agent, type: meta.type, source: meta.source },
    });
  } catch (e) {
    console.error('[Knot mem0] 洗入失败:', e);
    return { added: 0, updated: 0, deleted: 0, notice: 'LLM 提炼失败，本批记忆未入库' };
  }

  const report = await syncMirror(m, projectId, meta, before);
  return report;
}

/** Sync mem0's actual state for a project into the mirror store and produce a diff report. */
async function syncMirror(
  m: Memory,
  projectId: string,
  meta: { agent: string; type: string; source: string },
  before: Map<string, string>,
): Promise<IngestReport> {
  const report: IngestReport = { added: 0, updated: 0, deleted: 0 };
  let all;
  try {
    all = await m.getAll({ filters: { user_id: projectId }, topK: 10000 });
  } catch (e) {
    console.error('[Knot mem0] 对账读取失败:', e);
    return { ...report, notice: '记忆已入库，但同步本地索引失败' };
  }

  const afterIds = new Set<string>();
  for (const item of all.results) {
    const id = item.id;
    const content = item.memory;
    if (!id || !content) continue;
    afterIds.add(id);
    const itemMeta = (item.metadata ?? {}) as Record<string, string>;
    store.upsertFact({
      id,
      projectId,
      content,
      agent: itemMeta.agent || meta.agent,
      type: itemMeta.type || meta.type,
      source: itemMeta.source || meta.source,
    });
  }
  // Ids gone from mem0 (adjudicated away / merged) → remove from the mirror
  for (const id of before.keys()) {
    if (!afterIds.has(id)) store.deleteFactRow(id);
  }
  for (const id of afterIds) {
    if (!before.has(id)) report.added += 1;
    else if (before.get(id) !== contentOf(all, id)) report.updated += 1;
  }
  report.deleted = [...before.keys()].filter((id) => !afterIds.has(id)).length;
  return report;
}

function contentOf(all: { results: any[] }, id: string): string | undefined {
  return all.results.find((r) => r.id === id)?.memory;
}

/** Manual entry / correction: write to mem0 directly (through extraction) and sync the mirror. */
export async function addManualMemory(
  userDataDir: string,
  projectId: string,
  content: string,
): Promise<IngestReport> {
  return ingest(userDataDir, projectId, content, { agent: 'user', type: 'manual', source: '' });
}

export async function updateMemory(
  userDataDir: string,
  memoryId: string,
  content: string,
): Promise<void> {
  const m = await ensureMemory(userDataDir);
  if (!m) return;
  try {
    await m.update(memoryId, { text: content });
  } catch (e) {
    console.error('[Knot mem0] 更新失败:', e);
  }
  store.updateFactContent(memoryId, content);
}

export async function removeMemory(memoryId: string): Promise<void> {
  const m = memory;
  if (m) {
    try {
      await m.delete(memoryId);
    } catch (e) {
      console.error('[Knot mem0] 删除失败:', e);
    }
  }
  store.deleteFactRow(memoryId);
}

/** One-time migration: move the legacy Tauri store's facts into mem0 as-is.
 *  Legacy memories are already-extracted finished products, so infer:false skips
 *  LLM extraction and inserts them verbatim — no distortion and no extraction cost.
 *  Calls are grouped by (project × original source file) so each memory's metadata
 *  keeps the real source file path. */
export async function migrateLegacy(userDataDir: string): Promise<IngestReport> {
  const report: IngestReport = { added: 0, updated: 0, deleted: 0 };
  if (!store.legacyDbHasFacts()) return report;
  const m = await ensureMemory(userDataDir);
  if (!m) return { ...report, notice: 'LLM 未配置，无法迁移（迁移不需要调用 LLM，但需要 mem0 初始化）' };

  const facts = store.readLegacyFacts();
  const groups = new Map<string, { projectId: string; contents: string[]; agent: string; source: string }>();
  for (const f of facts) {
    const key = `${f.projectId}\u0000${f.source}`;
    const g = groups.get(key) ?? { projectId: f.projectId, contents: [], agent: f.agent, source: f.source };
    g.contents.push(f.content);
    if (f.agent === 'user') g.agent = 'user'; // keep manual user marking
    groups.set(key, g);
  }

  for (const g of groups.values()) {
    store.insertProject(g.projectId);
    const meta = { agent: g.agent, type: 'local-memory', source: g.source };
    const before = new Map(store.listFacts(g.projectId).map((x) => [x.id, x.content]));
    try {
      await m.add(
        g.contents.map((content) => ({ role: 'user' as const, content })),
        { userId: g.projectId, infer: false, metadata: meta },
      );
    } catch (e) {
      console.error(`[Knot mem0] 项目 ${g.projectId}（${g.source}）迁移失败:`, e);
      report.notice = '部分项目迁移失败，详见日志';
      continue;
    }
    const r = await syncMirror(m, g.projectId, meta, before);
    report.added += r.added;
    report.updated += r.updated;
    report.deleted += r.deleted;
  }
  return report;
}

/** mem0 semantic search: query a project's memories in natural language (for validating
 *  search quality from the board). Hits carry mirror metadata (agent/type/source/time)
 *  for card display. */
export interface SemanticHit {
  id: string;
  memory: string;
  score: number;
  agent?: string;
  type?: string;
  source?: string;
  updatedAt?: number;
}

export async function semanticSearch(
  userDataDir: string,
  projectId: string,
  query: string,
  topK = 8,
): Promise<SemanticHit[]> {
  const m = await ensureMemory(userDataDir);
  if (!m) return [];
  try {
    const r = await m.search(query, { filters: { user_id: projectId }, topK });
    const mirror = new Map(store.listFacts(projectId).map((f) => [f.id, f]));
    return r.results
      .filter((x) => x.id && x.memory)
      .map((x) => {
        const f = mirror.get(x.id);
        return {
          id: x.id,
          memory: x.memory,
          score: x.score ?? 0,
          agent: f?.agent,
          type: f?.type,
          source: f?.source,
          updatedAt: f?.updatedAt,
        };
      });
  } catch (e) {
    console.error('[Knot mem0] 语义检索失败:', e);
    throw e;
  }
}

export function shutdown(): void {
  shim?.close();
  shim = null;
  memory = null;
  currentKey = null;
}
