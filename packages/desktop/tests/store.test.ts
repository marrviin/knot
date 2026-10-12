//! Store tests run against a real (tmp) SQLite file. The test script drives vitest
//! with Electron's node runtime (ELECTRON_RUN_AS_NODE=1) because better-sqlite3 is
//! rebuilt for the Electron ABI in this repo (scripts/rebuild-sqlite-electron.mjs).

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';
import * as store from '../src/store';

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
    // Zero character overlap with every seeded content (unigram tokens make any
    // shared CJK char a hit); the honest-empty guarantee covers exactly that case.
    const r = store.searchFacts('/tmp/p1', '紫电青霜');
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

  it('OR widening requires at least 2 shared tokens — a one-char coincidence is not a hit', () => {
    store.upsertFact(fact({ id: 'd', content: '代码重构规范' })); // shares only 构 with the query
    const r = store.searchFacts('/tmp/p1', '构建流程');
    expect(r.map((f) => f.id)).toContain('b'); // 构建 → 2 shared tokens
    expect(r.map((f) => f.id)).not.toContain('d');
  });

  it('matches only the exact resolved project (no name collision)', () => {
    store.insertProject('/tmp/p2');
    store.upsertFact(fact({ id: 'x', projectId: '/tmp/p2', content: 'pnpm 另一个项目' }));
    // BM25 ranks shorter docs first, so order between a and b is score-driven;
    // the point here is isolation: p1's facts only, never p2's.
    expect(store.searchFacts('/tmp/p1', 'pnpm').map((f) => f.id).sort()).toEqual(['a', 'b']);
  });
});

describe('upsertFact dedup (mem0 re-ADDs the same content under a fresh uuid)', () => {
  beforeEach(() => {
    store.insertProject('/tmp/p1');
  });

  it('collapses onto the existing row, taking the new id so mirror ids track mem0', () => {
    store.upsertFact(fact({ id: 'old', content: '项目使用 pnpm 管理依赖' }));
    // false = the memory itself is unchanged (id adopted, updated_at kept) — a
    // full-mirror reconcile re-upserting everything must not rewrite timestamps
    expect(store.upsertFact(fact({ id: 'new', content: '项目使用 pnpm 管理依赖' }))).toBe(false);
    const r = store.listFacts('/tmp/p1');
    expect(r).toHaveLength(1);
    expect(r[0]!.id).toBe('new');
    // the FTS mirror stays queryable through the surviving id
    expect(store.searchFacts('/tmp/p1', 'pnpm 依赖').map((f) => f.id)).toEqual(['new']);
  });

  it('keeps updated_at when content and metadata are unchanged (same uuid)', () => {
    store.upsertFact(fact({ id: 'm1', content: '项目使用 pnpm' }));
    const before = (store.get().prepare('SELECT updated_at FROM facts WHERE id = ?').get('m1') as any).updated_at;
    // simulate an older row: push updated_at back, then re-upsert identical content
    store.get().prepare('UPDATE facts SET updated_at = ? WHERE id = ?').run(before - 3600, 'm1');
    expect(store.upsertFact(fact({ id: 'm1', content: '项目使用 pnpm' }))).toBe(false);
    const after = (store.get().prepare('SELECT updated_at FROM facts WHERE id = ?').get('m1') as any).updated_at;
    expect(after).toBe(before - 3600);
    // a real content change still bumps the timestamp
    expect(store.upsertFact(fact({ id: 'm1', content: '项目改用 pnpm workspaces' }))).toBe(true);
    const bumped = (store.get().prepare('SELECT updated_at FROM facts WHERE id = ?').get('m1') as any).updated_at;
    expect(bumped).toBeGreaterThanOrEqual(before);
  });
});

describe('initSchema self-heal (collapses pre-existing duplicates on open)', () => {
  it('deletes twin rows keeping the newest and creates the unique index', () => {
    const tmp2 = fs.mkdtempSync(path.join(os.tmpdir(), 'knot-store-heal-'));
    store.closeForTest(); // release the shared db so open() actually opens tmp2
    store.open(tmp2);
    store.insertProject('/tmp/h1');
    const conn = store.get();
    // Seed twins without the unique index, as a legacy database would have them.
    conn.exec('DROP INDEX IF EXISTS idx_facts_project_norm');
    const ins = conn.prepare(
      `INSERT INTO facts (id, project_id, content, norm_key, agent, type, source, created_at, updated_at)
       VALUES (?, ?, ?, ?, 'a', 't', 's', ?, ?)`,
    );
    ins.run('twin-old', '/tmp/h1', 'A 记忆', store.normalize('A 记忆'), 1000, 1000);
    ins.run('twin-new', '/tmp/h1', 'A 记忆', store.normalize('A 记忆'), 2000, 2000);
    ins.run('solo', '/tmp/h1', 'B 记忆', store.normalize('B 记忆'), 3000, 3000);
    store.closeForTest();

    store.open(tmp2); // re-runs initSchema → self-heal
    const rows = store.get().prepare('SELECT id FROM facts ORDER BY id').all() as any[];
    expect(rows.map((r) => r.id)).toEqual(['solo', 'twin-new']);
    // unique index in place: a third twin raises on raw insert
    expect(() =>
      store
        .get()
        .prepare(
          `INSERT INTO facts (id, project_id, content, norm_key, agent, type, source, created_at, updated_at)
           VALUES ('twin-3', '/tmp/h1', 'A 记忆', 'a 记忆', 'a', 't', 's', 4000, 4000)`,
        )
        .run(),
    ).toThrow();

    // switch back to the shared test db so later describes are unaffected
    store.closeForTest();
    store.open(tmp);
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

describe('search history (per project, last 10)', () => {
  it('pushes, moves repeats to the front, caps at 10', () => {
    expect(store.getSearchHistory('/tmp/p1')).toEqual([]);
    for (let i = 0; i < 12; i++) store.pushSearchHistory('/tmp/p1', `q${i}`);
    expect(store.getSearchHistory('/tmp/p1')).toHaveLength(10);
    expect(store.getSearchHistory('/tmp/p1')[0]).toBe('q11');
    // re-push moves the query to the front without duplicating it
    store.pushSearchHistory('/tmp/p1', 'q5');
    const h = store.getSearchHistory('/tmp/p1');
    expect(h[0]).toBe('q5');
    expect(h.filter((x) => x === 'q5')).toHaveLength(1);
    // a blank query is a no-op
    store.pushSearchHistory('/tmp/p1', '   ');
    expect(store.getSearchHistory('/tmp/p1')[0]).toBe('q5');
    // histories are isolated per project
    expect(store.getSearchHistory('/tmp/p2')).toEqual([]);
  });

  it('is dropped with the project', () => {
    store.insertProject('/tmp/p1');
    store.pushSearchHistory('/tmp/p1', '语义检索');
    store.pushSearchHistory('/tmp/other', '保留');
    store.removeProject('/tmp/p1');
    expect(store.getSearchHistory('/tmp/p1')).toEqual([]);
    expect(store.getSearchHistory('/tmp/other')).toEqual(['保留']);
  });
});
