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
import { log } from './log';
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
/** Single-flight guard for ensureMemory: concurrent callers (startup import vs a
 *  live change vs a manual add) share one rebuild instead of each starting their
 *  own embedding shim and racing over process.env.OPENAI_BASE_URL. */
let ensurePromise: Promise<Memory | null> | null = null;

/** Reject when the wrapped promise exceeds ms — without this, one hung upstream
 *  request (TCP stall) would block the serialized ingestion queue forever. */
// (exported for tests)
export function withTimeout<T>(p: Promise<T>, ms: number, label: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(`${label}超时（${Math.round(ms / 1000)}s）`)), ms);
    p.then(
      (v) => {
        clearTimeout(t);
        resolve(v);
      },
      (e) => {
        clearTimeout(t);
        reject(e);
      },
    );
  });
}

const ADD_TIMEOUT_MS = 3 * 60_000; // LLM extraction can legitimately take a while
const QUERY_TIMEOUT_MS = 60_000;

/** Lazily initialize or rebuild the mem0 instance from settings. Returns null when unconfigured. */
export async function ensureMemory(userDataDir: string): Promise<Memory | null> {
  const s = settings.load(store);
  if (!s.enabled || !settings.isConfigured(s)) return null;
  const key = `${s.baseUrl}|${s.apiKey}|${s.model}`;
  if (memory && currentKey === key) return memory;
  if (ensurePromise) return ensurePromise;

  const mem0Dir = path.join(userDataDir, 'mem0');
  ensurePromise = (async () => {
    if (shim) shim.close();
    const newShim = await startEmbeddingShim(s.apiKey, s.baseUrl);
    try {
      shim = newShim;
      process.env.OPENAI_BASE_URL = `http://127.0.0.1:${newShim.port}/v1`;
      const m = new Memory({
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
      memory = m;
      currentKey = key;
      return m;
    } catch (e) {
      // Constructor failed: tear the new shim back down so it can't leak, and
      // invalidate the old state (its shim is already closed, config changed anyway).
      newShim.close();
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
  let m: Memory | null;
  try {
    m = await ensureMemory(userDataDir);
  } catch (e) {
    console.error('[Knot mem0] mem0 初始化失败:', e);
    log(`mem0.ingest: mem0 初始化失败: ${e}`);
    return { added: 0, updated: 0, deleted: 0, notice: '记忆服务初始化失败，本批记忆未入库' };
  }
  if (!m) return { added: 0, updated: 0, deleted: 0 };

  const before = new Map(store.listFacts(projectId).map((f) => [f.id, f.content]));

  try {
    log(`mem0.ingest: m.add 开始（source=${meta.source}）`);
    await withTimeout(
      m.add(raw, {
        userId: projectId,
        metadata: { agent: meta.agent, type: meta.type, source: meta.source },
      }),
      ADD_TIMEOUT_MS,
      'LLM 提炼',
    );
    log('mem0.ingest: m.add 完成');
  } catch (e) {
    console.error('[Knot mem0] 洗入失败:', e);
    log(`mem0.ingest: m.add 失败: ${e}`);
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
    log(`mem0.syncMirror: getAll 开始（projectId=${projectId}）`);
    all = await withTimeout(
      m.getAll({ filters: { user_id: projectId }, topK: 10000 }),
      QUERY_TIMEOUT_MS,
      '读取记忆',
    );
    log(`mem0.syncMirror: getAll 返回 ${all.results.length} 条`);
  } catch (e) {
    console.error('[Knot mem0] 对账读取失败:', e);
    log(`mem0.syncMirror: getAll 失败: ${e}`);
    return { ...report, notice: '记忆已入库，但同步本地索引失败' };
  }

  const afterIds = new Set<string>();
  const contentById = new Map<string, string>();
  for (const item of all.results) {
    const id = item.id;
    const content = item.memory;
    if (!id || !content) continue;
    afterIds.add(id);
    contentById.set(id, content);
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
    else if (before.get(id) !== contentById.get(id)) report.updated += 1;
  }
  report.deleted = [...before.keys()].filter((id) => !afterIds.has(id)).length;
  log(`mem0.syncMirror: 对账完成 added=${report.added} updated=${report.updated} deleted=${report.deleted} 镜像总数=${store.factCount(projectId)}`);
  return report;
}

/** Manual entry / correction: write to mem0 directly (through extraction) and sync the mirror. */
export async function addManualMemory(
  userDataDir: string,
  projectId: string,
  content: string,
): Promise<IngestReport> {
  return ingest(userDataDir, projectId, content, { agent: 'user', type: 'manual', source: '' });
}

/** Mirror writes only happen after mem0 succeeded — otherwise the mirror diverges
 *  from the truth source and the next syncMirror resurrects the old content
 *  ("deleted memories come back"). Failures propagate to the IPC caller. */
export async function updateMemory(
  userDataDir: string,
  memoryId: string,
  content: string,
): Promise<void> {
  const m = (await ensureMemory(userDataDir).catch(() => memory)) ?? memory;
  if (!m) throw new Error('LLM 提炼未启用或未配置，无法更新记忆');
  await withTimeout(m.update(memoryId, { text: content }), ADD_TIMEOUT_MS, '更新记忆');
  store.updateFactContent(memoryId, content);
}

export async function removeMemory(userDataDir: string, memoryId: string): Promise<void> {
  const m = (await ensureMemory(userDataDir).catch(() => memory)) ?? memory;
  if (m) {
    await withTimeout(m.delete(memoryId), QUERY_TIMEOUT_MS, '删除记忆');
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

/** Count of mem0 memories for a project attributed to a given agent. Reads the
 *  truth source, so it survives mirror wipes (project removed & re-added) — used
 *  to detect "guided import already ran" without burning LLM calls again. */
export async function memoryCountByAgent(projectId: string, agent: string): Promise<number> {
  const m = memory;
  if (!m) return 0;
  try {
    const all = await m.getAll({ filters: { user_id: projectId }, topK: 10000 });
    return all.results.filter((x) => ((x.metadata ?? {}) as Record<string, string>).agent === agent)
      .length;
  } catch (e) {
    console.error('[Knot mem0] 迁移检查读取失败:', e);
    log(`mem0.memoryCountByAgent 失败: ${e}`);
    return 0;
  }
}

/** Restore the mirror store straight from mem0 (no LLM): the inverse of a mirror
 *  wipe. Returns the diff report relative to the (empty) mirror. */
export async function restoreMirror(projectId: string): Promise<IngestReport> {
  const m = memory;
  if (!m) return { added: 0, updated: 0, deleted: 0 };
  return syncMirror(m, projectId, { agent: 'unknown', type: 'local-memory', source: '' }, new Map());
}

export function shutdown(): void {
  shim?.close();
  shim = null;
  memory = null;
  currentKey = null;
}
