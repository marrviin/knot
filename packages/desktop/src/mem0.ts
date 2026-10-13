//! Memory client: thin HTTP wrapper over the memory service (server/).
//!
//! One code path for both modes — local (the Electron main process spawns the
//! server/ bundle as a child, see server-process.ts) and remote (a user-deployed
//! service URL from settings). Truth (mem0 + vector store) lives on the service;
//! this side only keeps the mirror store reconciled from the responses and never
//! writes facts the service doesn't hold (an unreachable service surfaces an
//! error, it never degrades to local-only writes).
//!
//! Ported from the original in-process mem0 integration; export signatures are
//! unchanged so ipc.ts / watcher.ts / mcp-server.ts needed no edits.

import * as store from './store';
import * as settings from './settings';
import { log } from './log';
import { ensureServerProcess, stopServer } from './server-process';
import type { FactItem, IngestReport, SemanticHit } from '@knot/shared';

// Shared contracts — re-exported so ipc.ts / watcher.ts / mcp-server.ts keep
// importing them from this module.
export type { FactItem, IngestReport, SemanticHit };

/** Opaque connection handle (was: the in-process mem0 Memory instance). Callers
 *  only ever test truthiness, so a plain descriptor keeps every signature stable. */
export interface Memory {
  base: string;
  token: string | null;
  kind: 'local' | 'remote';
  embedSignature: string | null;
}

interface HealthInfo {
  ok: boolean;
  ready: boolean;
  embedSignature?: string;
  embedModel?: string;
  notice?: string;
}

interface IngestResponse {
  report: IngestReport;
  facts: FactItem[];
}

let conn: Memory | null = null;
let currentKey: string | null = null;
/** Single-flight guard for ensureMemory: concurrent callers (startup import vs a
 *  live change vs a manual add) share one (re)connect instead of racing spawns. */
let ensurePromise: Promise<Memory | null> | null = null;

const ADD_TIMEOUT_MS = 3 * 60_000; // LLM extraction can legitimately take a while
const QUERY_TIMEOUT_MS = 60_000;

/** User-facing error text: distinguish the two modes so the fix is obvious. */
function unreachableMessage(kind: 'local' | 'remote', base: string): string {
  return kind === 'local'
    ? '本地记忆服务不可达，请重启应用重试'
    : `远程记忆服务不可达（${base}），请检查服务地址或部署状态`;
}

async function healthCheck(base: string, token: string | null): Promise<HealthInfo> {
  const resp = await fetch(`${base}/health`, {
    headers: token ? { Authorization: `Bearer ${token}` } : undefined,
    signal: AbortSignal.timeout(5000),
  });
  if (!resp.ok) throw new Error(`/health HTTP ${resp.status}`);
  return (await resp.json()) as HealthInfo;
}

/** Lazily connect (spawn the local child or ping the remote service) or rebuild
 *  the connection after a settings change. Returns null when unconfigured. */
export async function ensureMemory(userDataDir: string): Promise<Memory | null> {
  const s = settings.load(store);
  if (!settings.isConfigured(s)) return null;
  const key = [
    s.mode,
    s.remoteUrl,
    s.remoteToken,
    s.provider,
    s.baseUrl,
    s.apiKey,
    s.model,
    s.embedModel,
  ].join('|');
  if (conn && currentKey === key) return conn;
  if (ensurePromise) return ensurePromise;

  ensurePromise = (async () => {
    let next: Memory;
    if (s.mode === 'remote') {
      const base = s.remoteUrl.trim().replace(/\/+$/, '');
      const info = await healthCheck(base, s.remoteToken || null);
      next = { base, token: s.remoteToken || null, kind: 'remote', embedSignature: info.embedSignature ?? null };
    } else {
      const proc = await ensureServerProcess({
        userDataDir,
        llm: {
          provider: s.provider,
          baseUrl: s.baseUrl,
          apiKey: s.apiKey,
          model: s.model,
          embedModel: s.embedModel,
        },
      });
      next = { base: `http://127.0.0.1:${proc.port}`, token: proc.token, kind: 'local', embedSignature: null };
      // Local /health carries the same embed identity; fetch it for the warning below.
      try {
        const info = await healthCheck(next.base, proc.token);
        next.embedSignature = info.embedSignature ?? null;
      } catch {
        // Health worked a moment ago (spawn gate passed) — treat as non-fatal.
      }
    }

    // Changing the embedding model changes the whole vector space — stored vectors
    // (and the vector store's dimension) no longer match. Semantic search will fail
    // loudly and fall back to keyword; surface the cause for whoever debugs it.
    const signature = next.embedSignature;
    if (signature) {
      const prevSignature = store.getSetting('embed_signature');
      if (prevSignature && prevSignature !== signature) {
        console.error(
          `[Knot mem0] embedding 模型已从 ${prevSignature} 变为 ${signature}：旧向量与新空间不匹配，语义检索将不可用。需清空并重新导入记忆（或换回原模型）。`,
        );
      }
      store.setSetting('embed_signature', signature);
    }
    conn = next;
    currentKey = key;
    return next;
  })()
    .catch((e) => {
      conn = null;
      currentKey = null;
      throw e;
    })
    .finally(() => {
      ensurePromise = null;
    });
  return ensurePromise;
}

export function isReady(): boolean {
  return conn !== null;
}

interface ApiInit {
  method?: 'GET' | 'POST' | 'PUT' | 'DELETE';
  body?: unknown;
  timeoutMs?: number;
}

/** JSON request against the connected service. Network failures and non-2xx both
 *  throw with the server's message — callers decide whether to surface a notice
 *  (ingest, retried by the watcher) or propagate (manual edits via IPC). */
async function api<T>(path: string, init: ApiInit = {}): Promise<T> {
  if (!conn) throw new Error('记忆服务未连接（未启用或未配置）');
  const c = conn;
  let resp: Response;
  try {
    resp = await fetch(`${c.base}${path}`, {
      method: init.method ?? 'GET',
      headers: {
        'Content-Type': 'application/json',
        ...(c.token ? { Authorization: `Bearer ${c.token}` } : {}),
      },
      body: init.body !== undefined ? JSON.stringify(init.body) : undefined,
      signal: AbortSignal.timeout(init.timeoutMs ?? QUERY_TIMEOUT_MS),
    });
  } catch (e) {
    throw new Error(unreachableMessage(c.kind, c.base));
  }
  const j = (await resp.json().catch(() => ({}))) as { message?: string } & Record<string, unknown>;
  if (!resp.ok) throw new Error(j.message ?? `记忆服务 HTTP ${resp.status}`);
  return j as T;
}

/** Reconcile the mirror store against the service's truth state for a project
 *  (same semantics as the original syncMirror: upsert every fact, drop rows the
 *  service no longer holds). Falls back to the ingest meta when the fact carries
 *  no metadata (defensive — the service always stamps it). */
function reconcileMirror(
  projectId: string,
  facts: FactItem[],
  meta: { agent: string; type: string; source: string },
  dropMissing: boolean,
): void {
  const before = new Map(store.listFacts(projectId).map((f) => [f.id, f.content]));
  for (const f of facts) {
    const m = f.metadata ?? {};
    store.upsertFact({
      id: f.id,
      projectId,
      content: f.memory,
      agent: m.agent || meta.agent,
      type: m.type || meta.type,
      source: m.source || meta.source,
    });
  }
  if (!dropMissing) return;
  const afterIds = new Set(facts.map((f) => f.id));
  for (const id of before.keys()) {
    if (!afterIds.has(id)) store.deleteFactRow(id);
  }
}

/** Ingest raw memory text through the service, then reconcile the mirror store
 *  against the truth state it reports. Failures return a notice (the watcher's
 *  retry loop keys off it) — the mirror is only ever written from a successful
 *  service response, never degraded to local-only. sourceMtime: the source
 *  file's mtime — display timestamps track the file, not the ingest moment. */
export async function ingest(
  userDataDir: string,
  projectId: string,
  raw: string,
  meta: { agent: string; type: string; source: string },
  sourceMtime?: number,
): Promise<IngestReport> {
  let m: Memory | null;
  try {
    m = await ensureMemory(userDataDir);
  } catch (e) {
    console.error('[Knot mem0] 记忆服务初始化失败:', e);
    log(`mem0.ingest: 记忆服务初始化失败: ${e}`);
    return { added: 0, updated: 0, deleted: 0, notice: '记忆服务初始化失败，本批记忆未入库' };
  }
  if (!m) return { added: 0, updated: 0, deleted: 0 };

  try {
    log(`mem0.ingest: /ingest 开始（source=${meta.source}）`);
    // preferExisting: mirror ids beat fresh re-ADDs as the canonical near-dup —
    // same preference the original compactNearDups applied via the mirror state.
    const preferExisting = store.listFacts(projectId).map((f) => f.id);
    const r = await api<IngestResponse>('/ingest', {
      method: 'POST',
      body: { projectId, raw, meta, preferExisting, ...(sourceMtime ? { sourceMtime } : {}) },
      timeoutMs: ADD_TIMEOUT_MS,
    });
    log(
      `mem0.ingest: /ingest 完成 added=${r.report.added} updated=${r.report.updated} deleted=${r.report.deleted}`,
    );
    if (r.report.notice) return r.report;
    reconcileMirror(projectId, r.facts, meta, true);
    log(`mem0.ingest: 镜像对账完成 镜像总数=${store.factCount(projectId)}`);
    return r.report;
  } catch (e) {
    console.error('[Knot mem0] 洗入失败:', e);
    log(`mem0.ingest: /ingest 失败: ${e}`);
    return { added: 0, updated: 0, deleted: 0, notice: `记忆入库失败（${String(e)}），本批记忆未入库` };
  }
}

/** Manual entry / correction: write through the service (extraction pipeline) and
 *  reconcile the mirror from the response. */
export async function addManualMemory(
  userDataDir: string,
  projectId: string,
  content: string,
): Promise<IngestReport> {
  return ingest(userDataDir, projectId, content, { agent: 'user', type: 'manual', source: '' });
}

/** Mirror writes only happen after the service succeeded — otherwise the mirror
 *  diverges from the truth source and the next reconcile resurrects the old
 *  content ("deleted memories come back"). Failures propagate to the IPC caller. */
export async function updateMemory(
  userDataDir: string,
  memoryId: string,
  content: string,
): Promise<void> {
  const m = (await ensureMemory(userDataDir).catch(() => conn)) ?? conn;
  if (!m) throw new Error('记忆服务未配置，无法更新记忆');
  await api<{ ok: boolean }>(`/facts/${encodeURIComponent(memoryId)}`, {
    method: 'PUT',
    body: { content },
    timeoutMs: ADD_TIMEOUT_MS,
  });
  store.updateFactContent(memoryId, content);
}

export async function removeMemory(userDataDir: string, memoryId: string): Promise<void> {
  const m = (await ensureMemory(userDataDir).catch(() => conn)) ?? conn;
  if (m) {
    await api<{ ok: boolean }>(`/facts/${encodeURIComponent(memoryId)}`, {
      method: 'DELETE',
      timeoutMs: QUERY_TIMEOUT_MS,
    });
  }
  store.deleteFactRow(memoryId);
}

export async function semanticSearch(
  userDataDir: string,
  projectId: string,
  query: string,
  topK = 8,
): Promise<SemanticHit[]> {
  const m = await ensureMemory(userDataDir);
  if (!m) return [];
  const r = await api<{ hits: { id: string; memory: string; score: number }[] }>('/search', {
    method: 'POST',
    body: { projectId, query, topK },
    timeoutMs: QUERY_TIMEOUT_MS,
  });
  const mirror = new Map(store.listFacts(projectId).map((f) => [f.id, f]));
  return r.hits
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
}

/** Count of service memories for a project attributed to a given agent. Reads the
 *  truth source, so it survives mirror wipes (project removed & re-added) — used
 *  to detect "guided import already ran" without burning LLM calls again. */
export async function memoryCountByAgent(projectId: string, agent: string): Promise<number> {
  if (!conn) return 0;
  try {
    const r = await api<{ count: number }>(
      `/projects/${encodeURIComponent(projectId)}/count?agent=${encodeURIComponent(agent)}`,
    );
    return Number(r.count) || 0;
  } catch (e) {
    console.error('[Knot mem0] 迁移检查读取失败:', e);
    log(`mem0.memoryCountByAgent 失败: ${e}`);
    return 0;
  }
}

/** Restore the mirror store straight from the service (no LLM): the inverse of a
 *  mirror wipe. Returns the diff report relative to the (empty) mirror. */
export async function restoreMirror(projectId: string): Promise<IngestReport> {
  if (!conn) return { added: 0, updated: 0, deleted: 0 };
  const r = await api<{ facts: FactItem[] }>(
    `/projects/${encodeURIComponent(projectId)}/facts`,
    { timeoutMs: QUERY_TIMEOUT_MS },
  );
  // Same as the original: pure upsert against an empty before-state (no deletes —
  // a restore never wipes rows the service simply didn't return mid-sync).
  reconcileMirror(
    projectId,
    r.facts,
    { agent: 'unknown', type: 'local-memory', source: '' },
    false,
  );
  return { added: r.facts.length, updated: 0, deleted: 0 };
}

export function shutdown(): void {
  conn = null;
  currentKey = null;
  stopServer();
}
