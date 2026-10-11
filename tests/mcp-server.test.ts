//! MCP retrieval text-building tests over a real (tmp) mirror store.
//! electron/mcp-server imports the electron module for app.getVersion — mocked here.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('electron', () => ({ app: { getVersion: () => '0.0.0-test' } }));

import * as store from '../electron/store';
import { fetchKnots, handleToolCall } from '../electron/mcp-server';

const PROJ = '/work/demo';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'knot-mcp-test-'));
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

beforeEach(seed);

describe('fetchKnots project resolution', () => {
  it('unregistered cwd (default) returns a pointer to list_knot_projects instead of a silent "no memories"', () => {
    const text = fetchKnots({}); // cwd = this repo's dir, never a registered project in the tmp db
    expect(text).toContain('未能定位');
    expect(text).toContain('list_knot_projects');
  });

  it('resolves by project name', () => {
    expect(fetchKnots({ project_id: 'demo' })).toContain(PROJ);
  });

  it('resolves a subdirectory of a registered project by path prefix', () => {
    expect(fetchKnots({ project_id: `${PROJ}/packages/app` })).toContain(PROJ);
  });
});

describe('fetchKnots retrieval honesty', () => {
  it('no query returns the most recent memories with an explicit "最近沉淀" label', () => {
    const text = fetchKnots({ project_id: PROJ });
    expect(text).toContain('最近沉淀的共享记忆');
    expect(text).toContain('pnpm 管理依赖');
  });

  it('query hit returns the matches', () => {
    const text = fetchKnots({ project_id: PROJ, query: 'pnpm build' });
    expect(text).toContain('构建命令');
  });

  it('query with zero hits returns an honest empty result — no recent-30 fallback', () => {
    const text = fetchKnots({ project_id: PROJ, query: '完全无关的词' });
    expect(text).toContain('无命中');
    expect(text).not.toContain('pnpm 管理依赖');
  });

  it('a single CJK character is a valid keyword', () => {
    const text = fetchKnots({ project_id: PROJ, query: '构' });
    expect(text).toContain('构建命令');
  });
});

describe('handleToolCall', () => {
  it('flags unknown tools with isError', () => {
    const r = handleToolCall({ params: { name: 'nope', arguments: {} } });
    expect('isError' in r && r.isError).toBe(true);
  });

  it('list_knot_projects reports registered projects with counts', () => {
    const r = handleToolCall({ params: { name: 'list_knot_projects', arguments: {} } });
    expect(!('isError' in r)).toBe(true);
    expect(r.content[0].text).toContain(PROJ);
  });
});
