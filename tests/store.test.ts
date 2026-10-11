//! Store tests run against a real (tmp) SQLite file. The test script drives vitest
//! with Electron's node runtime (ELECTRON_RUN_AS_NODE=1) because better-sqlite3 is
//! rebuilt for the Electron ABI in this repo (scripts/rebuild-sqlite-electron.mjs).

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';
import * as store from '../electron/store';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'knot-store-test-'));
store.open(tmp);

/** store keeps one module-level db; clear all rows between tests and restore the
 *  global virtual project (normally created by open()). */
function resetDb(): void {
  const conn = store.get();
  conn.exec('DELETE FROM facts; DELETE FROM projects; DELETE FROM settings;');
  conn
    .prepare('INSERT INTO projects (path, name, added_at) VALUES (?, ?, ?)')
    .run(store.GLOBAL_PROJECT, store.GLOBAL_PROJECT_NAME, store.now());
}

function fact(over: Partial<store.Fact> = {}): Omit<store.Fact, 'createdAt' | 'updatedAt'> {
  return {
    id: over.id ?? 'id-1',
    projectId: over.projectId ?? '/tmp/p1',
    content: over.content ?? '使用 pnpm 管理依赖',
    agent: over.agent ?? 'claude-code',
    type: over.type ?? 'local-memory',
    source: over.source ?? '/tmp/p1/memory/a.md',
  };
}

beforeEach(resetDb);

describe('upsertFact (true upsert — the INSERT OR IGNORE regression)', () => {
  it('inserts a new fact', () => {
    expect(store.upsertFact(fact())).toBe(true);
    expect(store.listFacts('/tmp/p1')).toHaveLength(1);
  });

  it('updates content in place when mem0 adjudicates an existing memory (same uuid)', () => {
    store.upsertFact(fact({ id: 'm1', content: '旧结论：使用 npm' }));
    store.upsertFact(fact({ id: 'm1', content: '新结论：使用 pnpm' }));
    const facts = store.listFacts('/tmp/p1');
    expect(facts).toHaveLength(1);
    expect(facts[0]!.content).toBe('新结论：使用 pnpm');
  });

  it('normalizes content into norm_key on both insert and update', () => {
    store.upsertFact(fact({ id: 'm1', content: 'Hello   World' }));
    const row = store
      .get()
      .prepare('SELECT norm_key FROM facts WHERE id = ?')
      .get('m1') as { norm_key: string };
    expect(row.norm_key).toBe('hello world');
  });

  it('stores second-level timestamps and returns ms in listFacts', () => {
    store.upsertFact(fact());
    const f = store.listFacts('/tmp/p1')[0]!;
    expect(f.createdAt).toBeGreaterThan(1e12); // ms, not seconds
    expect(f.updatedAt).toBeGreaterThan(1e12);
  });
});

describe('searchFacts', () => {
  beforeEach(() => {
    store.insertProject('/tmp/p1');
    store.upsertFact(fact({ id: 'a', content: '项目使用 pnpm 管理依赖' }));
    store.upsertFact(fact({ id: 'b', content: '构建命令是 pnpm build' }));
    store.upsertFact(fact({ id: 'c', content: '与关键词无关的记录' }));
  });

  it('without a query returns the most recent memories (documented fetch-latest mode)', () => {
    const r = store.searchFacts('/tmp/p1');
    expect(r.length).toBe(3);
  });

  it('with a query returns only actual keyword hits — no recent-30 fallback', () => {
    const r = store.searchFacts('/tmp/p1', '无关词');
    expect(r).toHaveLength(0);
  });

  it('ranks by hit count', () => {
    const r = store.searchFacts('/tmp/p1', 'pnpm 依赖');
    expect(r[0]!.id).toBe('a');
  });

  it('accepts a single CJK character as a keyword', () => {
    const r = store.searchFacts('/tmp/p1', '构');
    expect(r.map((f) => f.id)).toContain('b');
  });

  it('ignores single latin characters as keywords', () => {
    const r = store.searchFacts('/tmp/p1', 'p');
    expect(r).toHaveLength(0);
  });

  it('matches only the exact resolved project (no name collision)', () => {
    store.insertProject('/tmp/p2');
    store.upsertFact(fact({ id: 'x', projectId: '/tmp/p2', content: 'pnpm 另一个项目' }));
    expect(store.searchFacts('/tmp/p1', 'pnpm').map((f) => f.id)).toEqual(['a', 'b']);
  });
});

describe('resolveProject', () => {
  beforeEach(() => {
    store.insertProject('/work/alpha');
    store.insertProject('/work/beta');
    store.insertProject('/work/beta/other'); // registered project nested inside another
  });

  it('resolves an exact path', () => {
    expect(store.resolveProject('/work/alpha')).toBe('/work/alpha');
  });

  it('resolves a subdirectory to its containing project (longest prefix wins)', () => {
    expect(store.resolveProject('/work/beta/src/deep')).toBe('/work/beta');
    expect(store.resolveProject('/work/beta/other/x')).toBe('/work/beta/other');
  });

  it('falls back to the project name', () => {
    expect(store.resolveProject('alpha')).toBe('/work/alpha');
  });

  it('prefers path resolution over the name (no cross-project bleed for same-named dirs)', () => {
    expect(store.resolveProject('/work/alpha/alpha')).toBe('/work/alpha');
  });

  it('returns null for an unregistered path', () => {
    expect(store.resolveProject('/somewhere/else')).toBeNull();
  });
});

describe('removeProject', () => {
  it('deletes facts, the project row, and its bootstrap markers; protects the global project', () => {
    store.insertProject('/tmp/rm');
    store.upsertFact(fact({ projectId: '/tmp/rm' }));
    store.setSetting('bootstrap_done:claude-code:/tmp/rm', '1');
    store.setSetting('bootstrap_done:watch:w1:abc123:/tmp/rm', '1');
    store.setSetting('bootstrap_done:claude-code:/tmp/other', '1');

    store.removeProject('/tmp/rm');

    expect(store.projectExists('/tmp/rm')).toBe(false);
    expect(store.listFacts('/tmp/rm')).toHaveLength(0);
    expect(store.getSetting('bootstrap_done:claude-code:/tmp/rm')).toBeNull();
    expect(store.getSetting('bootstrap_done:watch:w1:abc123:/tmp/rm')).toBeNull();
    // markers of other projects survive
    expect(store.getSetting('bootstrap_done:claude-code:/tmp/other')).toBe('1');

    // virtual project is not removable
    store.removeProject(store.GLOBAL_PROJECT);
    expect(store.projectExists(store.GLOBAL_PROJECT)).toBe(true);
  });
});

describe('listProjects', () => {
  it('returns ms-level lastUpdated and a fact count', () => {
    store.insertProject('/tmp/p1');
    store.upsertFact(fact({ id: 'z1' }));
    const p = store.listProjects().find((x) => x.path === '/tmp/p1')!;
    expect(p.factCount).toBe(1);
    expect(p.lastUpdated).toBeGreaterThan(1e12);
  });
});

describe('settings kv', () => {
  it('setSetting upserts and deleteSetting removes', () => {
    store.setSetting('k', 'v1');
    store.setSetting('k', 'v2');
    expect(store.getSetting('k')).toBe('v2');
    store.deleteSetting('k');
    expect(store.getSetting('k')).toBeNull();
    expect(() => store.deleteSetting('nope')).not.toThrow();
  });
});
