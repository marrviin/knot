//! MCP retrieval text-building tests over a real (tmp) mirror store.
//! src/mcp-server imports the electron module for app.getVersion — mocked here.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('electron', () => ({ app: { getVersion: () => '0.0.0-test' } }));
// mem0 is only reachable through the semantic fallback; stub it so tests control
// readiness and hits without network/API keys.
vi.mock('../src/mem0', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  isReady: vi.fn(() => false),
  semanticSearch: vi.fn(),
}));

import * as store from '../src/store';
import * as mem0 from '../src/mem0';
import { fetchJournals, handleToolCall, handleJsonRpc, hybridSearch, setMcpContext, startMcpHttpServer } from '../src/mcp-server';

const isReadyMock = vi.mocked(mem0.isReady);
const semanticSearchMock = vi.mocked(mem0.semanticSearch);

const PROJ = '/work/demo';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'journal-mcp-test-'));
store.open(tmp);

function seed(): void {
  const conn = store.get();
  conn.exec('DELETE FROM facts; DELETE FROM projects; DELETE FROM settings;');
  conn
    .prepare('INSERT INTO projects (path, name, added_at) VALUES (?, ?, ?)')
    .run(store.GLOBAL_PROJECT, store.GLOBAL_PROJECT_NAME, store.now());
  store.insertProject(PROJ);
  store.upsertFact({ id: 'f1', projectId: PROJ, content: '项目使用 pnpm 管理依赖', agent: 'claude-code', type: 'local-memory', source: '' });
  store.upsertFact({ id: 'f2', projectId: PROJ, content: '构建命令是 pnpm build', agent: 'claude-code', type: 'local-memory', source: '' });
}

beforeEach(() => {
  seed();
  // Default: no mem0 context — the keyword-only behavior the older tests assert on.
  setMcpContext('');
  isReadyMock.mockReturnValue(false);
  semanticSearchMock.mockReset();
});

describe('fetchJournals project resolution', () => {
  it('unregistered cwd (default) returns a pointer to list_projects instead of a silent "no memories"', async () => {
    const text = await fetchJournals({}); // cwd = this repo's dir, never a registered project in the tmp db
    expect(text).toContain('未能定位');
    expect(text).toContain('list_projects');
  });

  it('resolves by project name', async () => {
    expect(await fetchJournals({ project_id: 'demo' })).toContain(PROJ);
  });

  it('resolves a subdirectory of a registered project by path prefix', async () => {
    expect(await fetchJournals({ project_id: `${PROJ}/packages/app` })).toContain(PROJ);
  });
});

describe('fetchJournals retrieval honesty', () => {
  it('no query returns the most recent memories with an explicit "最近沉淀" label', async () => {
    const text = await fetchJournals({ project_id: PROJ });
    expect(text).toContain('最近沉淀的共享记忆');
    expect(text).toContain('pnpm 管理依赖');
  });

  it('query hit returns the matches', async () => {
    const text = await fetchJournals({ project_id: PROJ, query: 'pnpm build' });
    expect(text).toContain('构建命令');
  });

  it('query with zero hits returns an honest empty result — no recent-30 fallback', async () => {
    const text = await fetchJournals({ project_id: PROJ, query: '完全无关的词' });
    expect(text).toContain('无命中');
    expect(text).not.toContain('pnpm 管理依赖');
  });

  it('a single CJK character is a valid keyword', async () => {
    const text = await fetchJournals({ project_id: PROJ, query: '构' });
    expect(text).toContain('构建命令');
  });
});

describe('fetchJournals semantic fallback', () => {
  it('keyword miss falls back to mem0 semantic search and labels the results as such', async () => {
    isReadyMock.mockReturnValue(true);
    setMcpContext(tmp);
    semanticSearchMock.mockResolvedValue([
      { id: 'm1', memory: '语义命中的记忆内容', score: 0.71 },
    ]);
    const text = await fetchJournals({ project_id: PROJ, query: '完全无关的词' });
    expect(text).toContain('语义检索');
    expect(text).toContain('语义命中的记忆内容');
    expect(text).toContain('0.71');
    expect(semanticSearchMock).toHaveBeenCalledWith(tmp, PROJ, '完全无关的词', 8);
  });

  it('keyword miss with mem0 unready keeps the honest empty result', async () => {
    isReadyMock.mockReturnValue(false);
    setMcpContext(tmp);
    const text = await fetchJournals({ project_id: PROJ, query: '完全无关的词' });
    expect(text).toContain('无命中');
    expect(semanticSearchMock).not.toHaveBeenCalled();
  });

  it('keyword miss with mem0 ready but zero semantic hits also stays honest', async () => {
    isReadyMock.mockReturnValue(true);
    setMcpContext(tmp);
    semanticSearchMock.mockResolvedValue([]);
    const text = await fetchJournals({ project_id: PROJ, query: '完全无关的词' });
    expect(text).toContain('无命中');
  });

  it('hybrid fusion labels a fact surfaced by both paths and semantic-only hits with scores', async () => {
    isReadyMock.mockReturnValue(true);
    setMcpContext(tmp);
    semanticSearchMock.mockResolvedValue([
      { id: 'f2', memory: '构建命令是 pnpm build', score: 0.8 }, // also a BM25 hit → 双命中
      { id: 'm9', memory: '语义独享的记忆', score: 0.42 },
    ]);
    const text = await fetchJournals({ project_id: PROJ, query: 'pnpm build' });
    expect(text).toContain('混合检索');
    expect(text).toContain('语义检索');
    expect(text).toMatch(/\[关键词 \d+\.\d \+ 语义 0\.80\] 构建命令是 pnpm build/);
    expect(text).toContain('语义 0.42');
    expect(text).toContain('语义独享的记忆');
  });

  it('semantic hits below the noise threshold are dropped, keeping the honest empty result', async () => {
    isReadyMock.mockReturnValue(true);
    setMcpContext(tmp);
    semanticSearchMock.mockResolvedValue([
      { id: 'm2', memory: '碰巧沾边的低分记忆', score: 0.31 },
    ]);
    const text = await fetchJournals({ project_id: PROJ, query: '完全无关的词' });
    expect(text).toContain('无命中');
    expect(text).not.toContain('碰巧沾边的低分记忆');
  });

  it('twin semantic hits (same text under different uuids) collapse to one line', async () => {
    isReadyMock.mockReturnValue(true);
    setMcpContext(tmp);
    semanticSearchMock.mockResolvedValue([
      { id: 'x1', memory: '重复的记忆内容', score: 0.7 },
      { id: 'x2', memory: '重复的记忆内容', score: 0.65 },
    ]);
    const text = await fetchJournals({ project_id: PROJ, query: '完全无关的词' });
    expect(text.split('重复的记忆内容').length - 1).toBe(1);
  });

  it('weak top semantic hits stay (0.4 floor only) — no whole-path strong gate', async () => {
    isReadyMock.mockReturnValue(true);
    setMcpContext(tmp);
    semanticSearchMock.mockResolvedValue([
      { id: 'w1', memory: '同域但弱相关的记忆', score: 0.5 },
      { id: 'w2', memory: '更弱的记忆', score: 0.35 },
    ]);
    const text = await fetchJournals({ project_id: PROJ, query: '完全无关的词' });
    expect(text).toContain('语义 0.50');
    expect(text).toContain('同域但弱相关的记忆');
    expect(text).not.toContain('更弱的记忆'); // below the 0.4 floor
  });

  it('hybridSearch and fetchJournals agree — one engine, no consumer-specific gates', async () => {
    isReadyMock.mockReturnValue(true);
    setMcpContext(tmp);
    semanticSearchMock.mockResolvedValue([{ id: 'w4', memory: '弱语义记忆', score: 0.45 }]);
    const hits = await hybridSearch(PROJ, 'pnpm build');
    expect(hits.some((h) => h.semanticScore != null)).toBe(true);
    const text = await fetchJournals({ project_id: PROJ, query: 'pnpm build' });
    expect(text).toContain('弱语义记忆');
  });
});

describe('fetchJournals others-first mode (caller identity)', () => {
  it('default mode excludes the caller agent\'s own facts and explains the honest empty', async () => {
    // Both seeded facts are claude-code's — others-first returns an honest empty,
    // not the caller's own memories and not a generic "no memories" message.
    const text = await fetchJournals({ project_id: PROJ, query: 'pnpm' }, 'claude-code');
    expect(text).toContain('其他 agent');
    expect(text).toContain('mode:"all"');
    expect(text).not.toContain('pnpm 管理依赖');
  });

  it('mode:"all" returns everything including the caller\'s own', async () => {
    const text = await fetchJournals({ project_id: PROJ, query: 'pnpm', mode: 'all' }, 'claude-code');
    expect(text).toContain('构建命令');
  });

  it('mode:"self" returns only the caller\'s own facts', async () => {
    store.upsertFact({ id: 'f3', projectId: PROJ, content: 'joycode 侧沉淀的踩坑记忆', agent: 'joycode', type: 'local-memory', source: '' });
    store.upsertFact({ id: 'f4', projectId: PROJ, content: 'claude-code 侧沉淀的决策记忆', agent: 'claude-code', type: 'local-memory', source: '' });
    const text = await fetchJournals({ project_id: PROJ, query: '沉淀', mode: 'self' }, 'claude-code');
    expect(text).toContain('claude-code 侧沉淀的决策记忆');
    expect(text).not.toContain('joycode 侧沉淀的踩坑记忆');
  });

  it('unknown caller in others mode degrades to the pre-mode behavior (return everything)', async () => {
    const text = await fetchJournals({ project_id: PROJ, query: 'pnpm build' });
    expect(text).toContain('构建命令');
  });

  it('fetch-latest (no query) also applies the others filter with the own-count note', async () => {
    const text = await fetchJournals({ project_id: PROJ }, 'claude-code');
    expect(text).toContain('其他 agent');
    expect(text).toContain('你自己的 2 条');
    expect(text).not.toContain('pnpm 管理依赖');
  });

  it('semantic hits from the caller\'s own agent are excluded before fusion', async () => {
    isReadyMock.mockReturnValue(true);
    setMcpContext(tmp);
    semanticSearchMock.mockResolvedValue([
      { id: 'f2', memory: '构建命令是 pnpm build', score: 0.8, agent: 'claude-code' },
      { id: 'm1', memory: '语义命中的记忆内容', score: 0.71, agent: 'joycode' },
    ]);
    const text = await fetchJournals({ project_id: PROJ, query: '完全无关的词' }, 'claude-code');
    expect(text).not.toContain('构建命令');
    expect(text).toContain('语义命中的记忆内容');
    // Filtering shrinks the pool, so the vector store is asked for extra candidates.
    expect(semanticSearchMock).toHaveBeenCalledWith(tmp, PROJ, '完全无关的词', 12);
  });

  it('the tool argument is the identity fallback when no caller agent is known', async () => {
    const text = await fetchJournals({ project_id: PROJ, query: 'pnpm', agent: 'claude-code' });
    expect(text).toContain('其他 agent');
    expect(text).not.toContain('pnpm 管理依赖');
  });
});

describe('HTTP MCP caller identity via URL path', () => {
  it('POST /mcp/<agent> identifies the caller; plain /mcp stays unknown; other paths 405', async () => {
    const handle = await startMcpHttpServer(0);
    if (!handle) throw new Error('随机端口启动 HTTP 服务不应失败');
    try {
      const base = `http://127.0.0.1:${handle.port}`;
      const post = (path: string, body: unknown) =>
        fetch(`${base}${path}`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
        });
      const recall = { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'recall_memories', arguments: { project_id: 'demo', query: 'pnpm' } } };

      // Path identity: claude-code caller + others default → honest empty.
      const identified = await (await post('/mcp/claude-code', recall)).json() as any;
      expect(identified.result.content[0].text).toContain('其他 agent');

      // Plain /mcp: identity unknown → others degrades to returning everything.
      const unknown = await (await post('/mcp', recall)).json() as any;
      expect(unknown.result.content[0].text).toContain('构建命令');

      // Paths outside /mcp are still rejected.
      const bad = await fetch(`${base}/nope`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
      expect(bad.status).toBe(405);
    } finally {
      handle.close();
    }
  });
});

describe('handleToolCall', () => {
  it('flags unknown tools with isError', async () => {
    const r = await handleToolCall({ params: { name: 'nope', arguments: {} } });
    expect('isError' in r && r.isError).toBe(true);
  });

  it('list_projects reports registered projects with counts', async () => {
    const r = await handleToolCall({ params: { name: 'list_projects', arguments: {} } });
    expect(!('isError' in r)).toBe(true);
    expect(r.content[0].text).toContain(PROJ);
  });
});

describe('handleJsonRpc initialize', () => {
  it('echoes the client protocol version and carries usage instructions', async () => {
    const r = await handleJsonRpc({
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: { protocolVersion: '2025-06-18' },
    });
    const init = r.result as { protocolVersion: string; serverInfo: { name: string }; instructions: string };
    expect(init.protocolVersion).toBe('2025-06-18');
    expect(init.serverInfo.name).toBe('journal');
    expect(init.instructions).toContain('recall_memories');
  });
});

describe('HTTP MCP server', () => {
  it('serves initialize / tools/list / tools/call over loopback HTTP and rejects other verbs', async () => {
    const handle = await startMcpHttpServer(0);
    if (!handle) throw new Error('随机端口启动 HTTP 服务不应失败');
    try {
      const post = (body: unknown) =>
        fetch(`${handle.url}`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
        });

      const init = await (await post({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18' } })).json() as any;
      expect(init.result.serverInfo.name).toBe('journal');
      // Echo the client's requested protocol version so negotiation succeeds.
      expect(init.result.protocolVersion).toBe('2025-06-18');

      const tools = await (await post({ jsonrpc: '2.0', id: 2, method: 'tools/list' })).json() as any;
      expect(tools.result.tools.map((t: { name: string }) => t.name)).toContain('recall_memories');

      const call = await (
        await post({
          jsonrpc: '2.0',
          id: 3,
          method: 'tools/call',
          params: { name: 'recall_memories', arguments: { project_id: 'demo' } },
        })
      ).json() as any;
      expect(call.result.content[0].text).toContain('pnpm 管理依赖');

      // Notifications get 202 and no body (stateless Streamable-HTTP style)
      const note = await fetch(`${handle.url}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }),
      });
      expect(note.status).toBe(202);

      const get = await fetch(`${handle.url}`);
      expect(get.status).toBe(405);
    } finally {
      handle.close();
    }
  });
});
