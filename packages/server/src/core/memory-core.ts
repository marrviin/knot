//! Memory core (ported from electron/mem0.ts): mem0 instance lifecycle + memory
//! ingestion. Ingestion skips mem0's LLM extraction (infer: false) — watched
//! files are agent-curated already, so raw text goes straight to the vector
//! store; near-dup compaction keeps re-imports deduped.
//! The mirror store stays on the client — the server is the single truth source:
//! every mutation returns the project's full fact list so the client reconciles
//! its mirror from it.
//!
//! Ported behaviors (unchanged from the original):
//! - LLM: any OpenAI-compatible chat service (standard /chat/completions wire
//!   format). Optional: Knot's mem0 paths (infer:false add,
//!   update, search, delete, getAll) never call it — a placeholder config stands
//!   in when no API key is set, so the memory layer works with zero configuration.
//! - Embedding: always the bundled bge-small-zh-v1.5 ONNX model, served by a local
//!   /embeddings side-server in OpenAI wire format (see local-embedder.ts) —
//!   there is no cloud-embedding path and no embedding configuration;
//! - Vector store: mem0's built-in SQLite persistence (vectorStore.provider=memory +
//!   dbPath); no Qdrant needed.

import fs from 'node:fs';
import path from 'node:path';
import { Memory, type MemoryConfig } from 'mem0ai/oss';

import { embedSignatureOf, type LlmConfig } from '../config';
import { LOCAL_EMBED_DIMS, resolveLocalModelDir, startLocalEmbedder, type ShimHandle } from '../local-embedder';
import * as store from '../store';
import {
  findNearDupIds,
  splitMemoryChunks,
  withTimeout,
  type FactItem,
  type IngestReport,
  type SemanticHit,
} from '@knot/shared';

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

/** Lazily initialize or rebuild the mem0 instance from config. Embeddings always
 *  run locally, so this only ever fails on a broken install (model assets gone). */
export async function ensureMemory(cfg: LlmConfig | null, dataDir: string): Promise<Memory | null> {
  if (!cfg) return null;
  const key = `${cfg.baseUrl}|${cfg.apiKey}|${cfg.model}|${cfg.embedModel}`;
  if (memory && currentKey === key) return memory;
  if (ensurePromise) return ensurePromise;

  // A different embedding model (e.g. a bundled-model upgrade) changes the whole
  // vector space — stored vectors (and the vector store's dimension) no longer
  // match. Semantic search will fail loudly and fall back to keyword; surface
  // the cause for whoever debugs it.
  const signature = embedSignatureOf(cfg);
  const sigFile = path.join(dataDir, 'embed-signature');
  const prevSignature = fs.existsSync(sigFile) ? fs.readFileSync(sigFile, 'utf8').trim() : '';
  if (prevSignature && prevSignature !== signature) {
    console.error(
      `[Knot server] embedding 模型已从 ${prevSignature} 变为 ${signature}：旧向量与新空间不匹配，语义检索将不可用。需清空并重新导入记忆（或换回原模型）。`,
    );
  }

  const mem0Dir = dataDir;
  fs.mkdirSync(mem0Dir, { recursive: true });
  ensurePromise = (async () => {
    if (shim) shim.close();
    let newShim: ShimHandle | null = null;
    try {
      // Vectors always come from the local /embeddings side-server (bundled model).
      const modelDir = resolveLocalModelDir();
      if (!modelDir) {
        throw new Error('未找到内置 embedding 模型（models/bge-small-zh-v1.5）— 请重新构建 @knot/server');
      }
      newShim = await startLocalEmbedder(modelDir);
      const embedder: MemoryConfig['embedder'] = {
        provider: 'openai',
        config: {
          apiKey: 'local',
          model: cfg.embedModel,
          baseURL: `http://127.0.0.1:${newShim.port}/v1`,
          embeddingDims: LOCAL_EMBED_DIMS,
        },
      };
      // The chat LLM is real only when the user set a key; without one, mem0
      // still requires an llm block but Knot's paths never invoke it — stand in
      // a dead-port config so any accidental call fails loudly instead of hanging.
      // (OpenAI-compatible wire format everywhere — see the LlmConfig contract.)
      const llm: MemoryConfig['llm'] = cfg.apiKey
        ? {
            provider: 'openai',
            config: { apiKey: cfg.apiKey, model: cfg.model, baseURL: cfg.baseUrl, maxTokens: 4000, temperature: 0 },
          }
        : {
            provider: 'openai',
            config: { apiKey: 'unused', model: 'unused', baseURL: 'http://127.0.0.1:9/v1', maxTokens: 4000, temperature: 0 },
          };
      shim = newShim;
      const m = new Memory({
        llm,
        embedder,
        vectorStore: {
          provider: 'memory',
          config: {
            collectionName: 'knot',
            dimension: LOCAL_EMBED_DIMS,
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

/** Batch-embed texts through the local embedding side-server (near-dup compaction).
 *  Returns null when unconfigured — compaction is best-effort, not a hard dependency. */
async function embedTexts(cfg: LlmConfig | null, shimPort: number | null, texts: string[]): Promise<number[][] | null> {
  if (!cfg || !shimPort) return null;
  const url = `http://127.0.0.1:${shimPort}/embeddings`;
  const resp = await fetch(url, {
    method: 'POST',
    headers: { Authorization: 'Bearer local', 'Content-Type': 'application/json' },
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
  /** Pre-ingest truth (id → text): tells fresh re-ADDs apart from existing rows. */
  beforeMap: Map<string, string>,
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
  // Byte-identical re-adds keep the existing row (no id churn on unchanged
  // re-imports). But when the fresh text actually differs, the fresh one wins —
  // it was just read from a newer file, and letting the mirror-held twin win
  // would silently swallow the update.
  const textOf = new Map(results.map((r) => [r.id, r.memory]));
  for (const [dupId, canonicalId] of [...dupOf]) {
    if (
      !beforeMap.has(dupId) &&
      beforeMap.has(canonicalId) &&
      textOf.get(dupId) !== textOf.get(canonicalId)
    ) {
      dupOf.delete(dupId);
      dupOf.set(canonicalId, dupId);
    }
  }
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

/** Diff two truth snapshots into the report the client mirrors. The id sets
 *  drive the meta store's timestamp stamping (created for added ids, updated_at
 *  advanced for changed ids, rows dropped for deleted ids). */
function diffReports(
  before: Map<string, string>,
  after: FactItem[],
): {
  report: IngestReport;
  facts: FactItem[];
  addedIds: string[];
  updatedIds: string[];
  deletedIds: string[];
} {
  const report: IngestReport = { added: 0, updated: 0, deleted: 0 };
  const afterIds = new Set<string>();
  const addedIds: string[] = [];
  const updatedIds: string[] = [];
  for (const f of after) {
    afterIds.add(f.id);
    if (!before.has(f.id)) {
      report.added += 1;
      addedIds.push(f.id);
    } else if (before.get(f.id) !== f.memory) {
      report.updated += 1;
      updatedIds.push(f.id);
    }
  }
  const deletedIds = [...before.keys()].filter((id) => !afterIds.has(id));
  report.deleted = deletedIds.length;
  return { report, facts: after, addedIds, updatedIds, deletedIds };
}

/** Ingest raw memory text into mem0, then return the truth diff + full fact list
 *  (the client reconciles its mirror from it). Stored with infer: false — the
 *  text is agent-curated already, so no LLM extraction; long files are split
 *  deterministically (see splitMemoryChunks) so each chunk gets a focused vector,
 *  and near-dup compaction below keeps re-imports deduped. Does not rely on
 *  add()'s results events: in practice add events on 3.3.1 can be empty even
 *  though the data did land in the vector store, so the real state from getAll
 *  is the most reliable source. */
export async function ingest(
  cfg: LlmConfig | null,
  dataDir: string,
  projectId: string,
  raw: string,
  meta: { agent: string; type: string; source: string },
  preferExisting: Set<string> = new Set(),
  sourceMtime?: number,
): Promise<{ report: IngestReport; facts: FactItem[] }> {
  const m = await ensureMemory(cfg, dataDir);
  if (!m) return { report: { added: 0, updated: 0, deleted: 0, notice: '记忆库未配置' }, facts: [] };

  // Any write path registers the project lazily (bare path segments make a
  // reasonable display name; explicit names come through ensureProject callers).
  store.ensureProject(dataDir, projectId);

  const before = await listAll(m, projectId);
  const beforeMap = new Map(before.map((f) => [f.id, f.memory]));

  const chunks = splitMemoryChunks(raw);
  for (let i = 0; i < chunks.length; i++) {
    await withTimeout(
      m.add(chunks[i]!, {
        userId: projectId,
        metadata: {
          agent: meta.agent,
          type: meta.type,
          source: meta.source,
          // Provenance for chunked files ("2/3") — single-chunk ingests stay clean.
          ...(chunks.length > 1 ? { part: `${i + 1}/${chunks.length}` } : {}),
        },
        infer: false,
      }),
      ADD_TIMEOUT_MS,
      '记忆入库',
    );
  }

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
    beforeMap,
  ).catch(() => new Map<string, string>());
  if (dupOf.size) after = after.filter((f) => !dupOf.has(f.id));

  const { report, facts, addedIds, updatedIds, deletedIds } = diffReports(beforeMap, after);
  // Timestamps tracked server-side (see store.ts) — compacted-away dups land in
  // deletedIds too, keeping the meta rows exactly aligned with the truth state.
  // File-sourced ingests stamp the source file's mtime (the fact's "as of" time),
  // not the ingest moment; manual writes fall back to now.
  const at = sourceMtime && sourceMtime > 0 ? sourceMtime : Date.now();
  store.stampAdded(dataDir, projectId, addedIds, at);
  store.stampUpdated(dataDir, updatedIds, at);
  store.deleteMeta(dataDir, deletedIds);
  return { report, facts: withMeta(dataDir, projectId, facts) };
}

/** Attach the meta store's display timestamps to a fact list (missing rows →
 *  null — pre-meta facts; the UI renders "-"). */
function withMeta(dataDir: string, projectId: string, facts: FactItem[]): FactItem[] {
  const meta = store.metaOf(dataDir, projectId);
  if (!meta.size) return facts;
  return facts.map((f) => {
    const m = meta.get(f.id);
    return m ? { ...f, createdAt: m.createdAt, updatedAt: m.updatedAt } : f;
  });
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
  if (!m) throw new Error('记忆服务未配置，无法更新记忆');
  await withTimeout(m.update(memoryId, { text: content }), ADD_TIMEOUT_MS, '更新记忆');
  store.stampUpdated(dataDir, [memoryId], Date.now());
}

export async function removeFact(cfg: LlmConfig | null, dataDir: string, memoryId: string): Promise<void> {
  const m = await ensureMemory(cfg, dataDir);
  if (m) await withTimeout(m.delete(memoryId), QUERY_TIMEOUT_MS, '删除记忆');
  store.deleteMeta(dataDir, [memoryId]);
}

/** The project's full fact list (client mirror restore / renderer display). */
export async function listFacts(
  cfg: LlmConfig | null,
  dataDir: string,
  projectId: string,
): Promise<FactItem[]> {
  const m = await ensureMemory(cfg, dataDir);
  if (!m) return [];
  return withMeta(dataDir, projectId, await listAll(m, projectId));
}

/** mem0 semantic search: query a project's memories in natural language. Hits
 *  carry the metadata the display cards need (agent/type/source from mem0's
 *  stored metadata, updatedAt from the meta store). */
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
  const meta = store.metaOf(dataDir, projectId);
  return r.results
    .filter((x) => x.id && x.memory)
    .map((x) => {
      const m = meta.get(x.id!);
      const md = (x.metadata ?? {}) as Record<string, string>;
      return {
        id: x.id!,
        memory: x.memory,
        score: x.score ?? 0,
        agent: typeof md.agent === 'string' ? md.agent : undefined,
        type: typeof md.type === 'string' ? md.type : undefined,
        source: typeof md.source === 'string' ? md.source : undefined,
        ...(m?.updatedAt != null ? { updatedAt: m.updatedAt } : {}),
      };
    });
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
  store.close();
}

/** The project registry with display stats: factCount comes from the truth
 *  state (listAll per project — accurate even for pre-meta facts), lastUpdated
 *  from the meta store (null for pre-meta facts → UI renders "-"). The virtual
 *  全局记忆 project is seeded on first read so it always appears. */
export async function listProjects(cfg: LlmConfig | null, dataDir: string): Promise<
  { id: string; name: string; factCount: number; lastUpdated: number | null }[]
> {
  store.ensureProject(dataDir, store.GLOBAL_PROJECT, store.GLOBAL_PROJECT_NAME);
  const m = await ensureMemory(cfg, dataDir);
  const rows = store.projectRows(dataDir);
  const out: { id: string; name: string; factCount: number; lastUpdated: number | null }[] = [];
  for (const r of rows) {
    let factCount = 0;
    if (m) {
      try {
        factCount = (await listAll(m, r.id)).length;
      } catch (e) {
        console.error(`[Knot server] 项目 ${r.id} 记忆统计失败:`, e);
      }
    }
    out.push({ id: r.id, name: r.name, factCount, lastUpdated: store.lastUpdatedAt(dataDir, r.id) });
  }
  return out;
}

/** Idempotent registry registration so a just-added project shows in the
 *  sidebar before its first ingest lands (ingest auto-registers too). Returns
 *  the display row; factCount reflects any memories the project already holds. */
export async function registerProject(
  cfg: LlmConfig | null,
  dataDir: string,
  projectId: string,
  name?: string,
): Promise<{ id: string; name: string; factCount: number; lastUpdated: number | null }> {
  if (!projectId.trim()) throw new Error('projectId 不能为空');
  store.ensureProject(dataDir, projectId.trim(), name);
  const m = await ensureMemory(cfg, dataDir);
  let factCount = 0;
  if (m) {
    try {
      factCount = (await listAll(m, projectId.trim())).length;
    } catch (e) {
      console.error(`[Knot server] 项目 ${projectId} 记忆统计失败:`, e);
    }
  }
  return {
    id: projectId.trim(),
    name: store.projectRows(dataDir).find((r) => r.id === projectId.trim())?.name ?? projectId,
    factCount,
    lastUpdated: store.lastUpdatedAt(dataDir, projectId.trim()),
  };
}

/** Delete a project outright: every fact in the truth state + its meta rows +
 *  the registry row. The virtual global project is not removable. */
export async function removeProject(cfg: LlmConfig | null, dataDir: string, projectId: string): Promise<void> {
  if (projectId === store.GLOBAL_PROJECT) {
    throw new Error('全局记忆项目不可删除');
  }
  const m = await ensureMemory(cfg, dataDir);
  if (m) {
    const all = await listAll(m, projectId);
    for (const f of all) {
      await withTimeout(m.delete(f.id), QUERY_TIMEOUT_MS, '删除记忆');
    }
  }
  store.removeProjectRow(dataDir, projectId);
}
