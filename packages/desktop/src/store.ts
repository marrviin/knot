//! Local mirror store (better-sqlite3): project registry + facts mirror + settings.
//!
//! mem0 is the source of truth for memory (extraction/dedup/adjudication/vector
//! search all happen there). The `facts` table here is its mirror, used for UI
//! card display and MCP keyword search; the two are linked by mem0's memory uuid.

import path from 'node:path';
import fs from 'node:fs';
import Database from 'better-sqlite3';

export interface Project {
  path: string;
  name: string;
  factCount: number;
  lastUpdated: number | null;
}

export interface Fact {
  /** mem0 memory uuid */
  id: string;
  projectId: string;
  content: string;
  /** Agent that produced the memory: claude-code / myagent / user */
  agent: string;
  /** Memory carrier type: local-memory / manual */
  type: string;
  source: string;
  createdAt: number;
  updatedAt: number;
  /** Keyword relevance from FTS5's bm25() (negated so higher = better); only
   *  present on searchFacts(query) results, never on the fetch-latest path. */
  kScore?: number;
}

let db: Database.Database | null = null;

export type Db = Database.Database;

/** Virtual project that owns every agent's global (non-project-scoped) memories,
 *  e.g. hermes's profile-wide ~/.hermes/memories/. A reserved path that can never
 *  collide with a real directory; pinned first in listProjects and not removable. */
export const GLOBAL_PROJECT = '__global__';
export const GLOBAL_PROJECT_NAME = '全局记忆';

export function dbPath(userDataDir: string): string {
  return path.join(userDataDir, 'journal.db');
}

export function open(userDataDir: string): Database.Database {
  if (db) return db;
  fs.mkdirSync(userDataDir, { recursive: true });
  db = new Database(dbPath(userDataDir));
  db.pragma('journal_mode = WAL');
  initSchema(db);
  ensureGlobalProject(db);
  return db;
}

export function get(): Database.Database {
  if (!db) throw new Error('数据库尚未初始化');
  return db;
}

/** Test hook: drop the cached connection so the next open() re-runs initSchema
 *  (exercising the self-heal dedupe against a pre-seeded database). */
export function closeForTest(): void {
  db?.close();
  db = null;
}

function initSchema(conn: Database.Database): void {
  conn.exec(`
    CREATE TABLE IF NOT EXISTS projects (
      path     TEXT PRIMARY KEY,
      name     TEXT NOT NULL,
      added_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS facts (
      id         TEXT PRIMARY KEY,
      project_id TEXT NOT NULL,
      content    TEXT NOT NULL,
      norm_key   TEXT NOT NULL,
      agent      TEXT NOT NULL DEFAULT '',
      type       TEXT NOT NULL DEFAULT '',
      source     TEXT NOT NULL DEFAULT '',
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_facts_project ON facts(project_id);
    CREATE TABLE IF NOT EXISTS settings (
      key   TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );
  `);
  // Self-heal exact duplicates: mem0's extraction can re-ADD identical content
  // under a fresh uuid (its ADD/UPDATE adjudication is LLM-based and unreliable),
  // which once piled 56 twin pairs onto one project. Collapse to the newest row
  // per (project_id, norm_key) — normalize() is near-lossless, so a norm_key
  // collision means the same memory — then enforce uniqueness so a future
  // re-import collapses in place instead of piling up. (facts_fts may not exist
  // yet on a fresh database; ensureFtsIndex below creates it.)
  const doomed = `SELECT rowid FROM (
    SELECT rowid, ROW_NUMBER() OVER (
      PARTITION BY project_id, norm_key ORDER BY updated_at DESC, rowid DESC
    ) AS rn FROM facts
  ) WHERE rn > 1`;
  if (conn.prepare("SELECT 1 FROM sqlite_master WHERE name = 'facts_fts'").get()) {
    conn.exec(`DELETE FROM facts_fts WHERE rowid IN (${doomed})`);
  }
  conn.exec(`
    DELETE FROM facts WHERE rowid IN (${doomed});
    CREATE UNIQUE INDEX IF NOT EXISTS idx_facts_project_norm ON facts(project_id, norm_key);
  `);
  ensureFtsIndex(conn);
}

// ---------- FTS5 keyword index (BM25) ----------

/** Bump when ftsTokenize/ftsQuery semantics change: forces a one-shot rebuild of
 *  facts_fts from the facts table on next open. */
const FTS_INDEX_VERSION = '1';
const FTS_MARKER_KEY = 'fts_index_version';

/** Tokenize for the FTS index and for MATCH queries (must stay in lockstep):
 *  lowercase; latin/digit runs stay whole words; each CJK char becomes its own
 *  token (SQLite has no CJK segmentation, and substring matching is what the old
 *  scorer did — per-char tokens keep that recall while BM25 adds ranking).
 *  Single-char latin tokens are dropped on both sides (noise, never queried). */
export function ftsTokenize(text: string): string {
  return text
    .toLowerCase()
    .replace(/([一-鿿])/g, ' $1 ')
    .split(/\s+/)
    .filter((t) => t && (/[一-鿿]/.test(t) || [...t].length >= 2))
    .join(' ');
}

function matchExpr(tokens: string[], op: 'AND' | 'OR'): string {
  return tokens.map((t) => `"${t.replace(/"/g, '""')}"`).join(` ${op} `);
}

/** Create facts_fts if missing; rebuild it wholesale when the tokenization version
 *  changed (covers fresh DBs and pre-FTS databases in one path). Contentless FTS5
 *  cannot read even UNINDEXED columns, so rows are linked to facts by rowid —
 *  facts' implicit rowid is stable (ON CONFLICT UPDATE keeps it). */
function ensureFtsIndex(conn: Database.Database): void {
  conn.exec(`
    CREATE VIRTUAL TABLE IF NOT EXISTS facts_fts USING fts5(
      content,
      content='',
      contentless_delete=1
    );
  `);
  const row = conn.prepare('SELECT value FROM settings WHERE key = ?').get(FTS_MARKER_KEY) as any;
  if (row?.value === FTS_INDEX_VERSION) return;
  conn.prepare('DELETE FROM facts_fts').run();
  const facts = conn.prepare('SELECT rowid, content FROM facts').all() as any[];
  const insert = conn.prepare('INSERT INTO facts_fts (rowid, content) VALUES (?, ?)');
  const rebuild = conn.transaction(() => {
    for (const f of facts) insert.run(f.rowid, ftsTokenize(f.content));
  });
  rebuild();
  conn
    .prepare('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value')
    .run(FTS_MARKER_KEY, FTS_INDEX_VERSION);
}

function ftsUpsert(id: string, content: string): void {
  const conn = get();
  const fact = conn.prepare('SELECT rowid FROM facts WHERE id = ?').get(id) as any;
  if (!fact) return;
  conn.prepare('DELETE FROM facts_fts WHERE rowid = ?').run(fact.rowid);
  conn.prepare('INSERT INTO facts_fts (rowid, content) VALUES (?, ?)').run(fact.rowid, ftsTokenize(content));
}

function ftsDelete(id: string): void {
  // Caller must still have the facts row (ftsDelete resolves the rowid through it);
  // removeProject accordingly cleans the index before deleting the rows.
  const fact = get().prepare('SELECT rowid FROM facts WHERE id = ?').get(id) as any;
  if (fact) get().prepare('DELETE FROM facts_fts WHERE rowid = ?').run(fact.rowid);
}

/** Idempotently create the global-memory virtual project (guarded in removeProject) */
function ensureGlobalProject(conn: Database.Database): void {
  conn
    .prepare('INSERT OR IGNORE INTO projects (path, name, added_at) VALUES (?, ?, ?)')
    .run(GLOBAL_PROJECT, GLOBAL_PROJECT_NAME, now());
}

export function now(): number {
  return Math.floor(Date.now() / 1000);
}

// ---------- Projects ----------

export function projectRows(): { path: string; name: string; added_at: number }[] {
  return get().prepare('SELECT path, name, added_at FROM projects ORDER BY added_at').all() as any[];
}

export function listProjects(): Project[] {
  const rows = get()
    .prepare(
      `SELECT p.path, p.name, COUNT(f.id) AS cnt, MAX(f.updated_at) AS last
       FROM projects p LEFT JOIN facts f ON f.project_id = p.path
       GROUP BY p.path, p.name
       ORDER BY CASE WHEN p.path = '${GLOBAL_PROJECT}' THEN 0 ELSE 1 END, p.added_at`,
    )
    .all() as any[];
  return rows.map((r) => ({
    path: r.path,
    name: r.name,
    factCount: r.cnt,
    // DB stores second-level timestamps; convert to ms for the UI (same as rowToFact)
    lastUpdated: r.last != null ? r.last * 1000 : null,
  }));
}

export function insertProject(p: string): boolean {
  const name = path.basename(p);
  const n = get()
    .prepare('INSERT OR IGNORE INTO projects (path, name, added_at) VALUES (?, ?, ?)')
    .run(p, name, now());
  return n.changes > 0;
}

export function removeProject(p: string): void {
  if (p === GLOBAL_PROJECT) return; // virtual project: not removable
  const conn = get();
  const ids = (conn.prepare('SELECT id FROM facts WHERE project_id = ?').all(p) as any[]).map((r) => r.id);
  for (const id of ids) ftsDelete(id);
  conn.prepare('DELETE FROM facts WHERE project_id = ?').run(p);
  conn.prepare('DELETE FROM projects WHERE path = ?').run(p);
  // Guided-import markers are keyed per project — leaving them behind would make
  // re-adding the project skip its existing-content import forever.
  conn
    .prepare("DELETE FROM settings WHERE key LIKE 'bootstrap_done:%' AND key LIKE '%' || ?")
    .run(`:${p}`);
}

export function projectExists(p: string): boolean {
  return !!get().prepare('SELECT 1 FROM projects WHERE path = ?').get(p);
}

// ---------- Facts mirror (synced from mem0 events) ----------

export function normalize(text: string): string {
  return text
    .split(/\s+/)
    .join(' ')
    .toLowerCase()
    .replace(/[.。!！?？]+$/, '');
}

/** mem0 ADD/UPDATE event → persist to the mirror. True upsert: mem0's conflict
 *  adjudication rewrites an existing memory's content in place (same uuid), so an
 *  INSERT OR IGNORE here would leave the mirror permanently stale. A row whose
 *  content and metadata are unchanged is left untouched — syncMirror re-upserts
 *  the whole project on every ingest, and rewriting updated_at there would reset
 *  every card's timestamp to the sync time instead of the memory's real age. */
export function upsertFact(fact: Omit<Fact, 'createdAt' | 'updatedAt'>): boolean {
  const ts = now();
  const norm = normalize(fact.content);
  const conn = get();
  const sameRow = (r: any) =>
    r.content === fact.content &&
    r.agent === fact.agent &&
    r.type === fact.type &&
    r.source === fact.source;

  // Same uuid → mem0 rewrote the memory in place; plain UPDATE keeps created_at.
  const byId = conn
    .prepare('SELECT content, agent, type, source FROM facts WHERE id = ? AND project_id = ?')
    .get(fact.id, fact.projectId);
  if (byId) {
    if (sameRow(byId)) return false;
    conn
      .prepare(
        `UPDATE facts SET content = ?, norm_key = ?, agent = ?, type = ?, source = ?, updated_at = ?
         WHERE id = ?`,
      )
      .run(fact.content, norm, fact.agent, fact.type, fact.source, ts, fact.id);
    ftsUpsert(fact.id, fact.content);
    return true;
  }

  // Fresh uuid for content the project already holds (mem0's extraction re-ADDs
  // are unreliable): the unique index collapses it onto the existing row, taking
  // the new id so mirror ids keep tracking mem0's current state.
  const byNorm = conn
    .prepare('SELECT id, content, agent, type, source FROM facts WHERE project_id = ? AND norm_key = ?')
    .get(fact.projectId, norm) as any;
  if (byNorm) {
    if (sameRow(byNorm)) {
      // Unchanged memory: keep updated_at. Still adopt the fresh uuid (id-only
      // rewrite) so syncMirror's id-based reconciliation doesn't drop the row —
      // the old id is gone from mem0's getAll and would fall out as "deleted".
      if (byNorm.id !== fact.id) {
        conn
          .prepare('UPDATE facts SET id = ? WHERE project_id = ? AND norm_key = ?')
          .run(fact.id, fact.projectId, norm);
      }
      return false;
    }
    conn
      .prepare(
        `UPDATE facts SET id = ?, content = ?, agent = ?, type = ?, source = ?, updated_at = ?
         WHERE project_id = ? AND norm_key = ?`,
      )
      .run(fact.id, fact.content, fact.agent, fact.type, fact.source, ts, fact.projectId, norm);
    ftsUpsert(fact.id, fact.content);
    return true;
  }

  conn
    .prepare(
      `INSERT INTO facts (id, project_id, content, norm_key, agent, type, source, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(fact.id, fact.projectId, fact.content, norm, fact.agent, fact.type, fact.source, ts, ts);
  ftsUpsert(fact.id, fact.content);
  return true;
}

export function updateFactContent(id: string, content: string): void {
  get()
    .prepare('UPDATE facts SET content = ?, norm_key = ?, updated_at = ? WHERE id = ?')
    .run(content, normalize(content), now(), id);
  ftsUpsert(id, content);
}

export function deleteFactRow(id: string): void {
  ftsDelete(id);
  get().prepare('DELETE FROM facts WHERE id = ?').run(id);
}

const FACT_COLUMNS = 'id, project_id, content, agent, type, source, created_at, updated_at';

function rowToFact(r: any): Fact {
  return {
    id: r.id,
    projectId: r.project_id,
    content: r.content,
    agent: r.agent,
    type: r.type,
    source: r.source,
    // DB stores second-level timestamps (now()); convert to ms for the UI (new Date() semantics)
    createdAt: r.created_at * 1000,
    updatedAt: r.updated_at * 1000,
    // bm25() is negative with better matches more negative — flip to "higher = better"
    ...(r.kscore != null ? { kScore: -r.kscore } : {}),
  };
}

export function listFacts(projectId: string): Fact[] {
  const rows = get()
    .prepare(`SELECT ${FACT_COLUMNS} FROM facts WHERE project_id = ? ORDER BY updated_at DESC`)
    .all(projectId) as any[];
  return rows.map(rowToFact);
}

export function factCount(projectId: string): number {
  const row = get()
    .prepare('SELECT COUNT(*) AS c FROM facts WHERE project_id = ?')
    .get(projectId) as { c: number };
  return row.c;
}

/** Facts a single agent holds in a project — used by the MCP "others" mode's
 *  honest-empty message ("you have N own memories not included"). */
export function factCountByAgent(projectId: string, agent: string): number {
  const row = get()
    .prepare('SELECT COUNT(*) AS c FROM facts WHERE project_id = ? AND agent = ?')
    .get(projectId, agent) as { c: number };
  return row.c;
}

/** Resolve a project for MCP retrieval: full path first (exact match, or anything
 *  inside a registered project — longest prefix wins), then project name as a
 *  fallback. Path-first resolution keeps two same-named projects from reading
 *  each other's memories. Returns the registered project path, or null. */
export function resolveProject(idOrPath: string): string | null {
  const rows = projectRows();
  const exact = rows.find((r) => r.path === idOrPath);
  if (exact) return exact.path;
  const inside = rows
    .filter((r) => r.path !== GLOBAL_PROJECT && idOrPath.startsWith(r.path + path.sep))
    .sort((a, b) => b.path.length - a.path.length)[0];
  if (inside) return inside.path;
  return rows.find((r) => r.name === idOrPath)?.path ?? null;
}

/** Caller-identity filter for the MCP recall path: "others" mode excludes the
 *  calling agent's own facts, "self" keeps only them. The GUI search never
 *  filters — it always shows the full picture. */
export interface AgentFilter {
  excludeAgent?: string;
  onlyAgent?: string;
}

function agentClause(filter?: AgentFilter): { sql: string; params: string[] } {
  if (filter?.onlyAgent) return { sql: ' AND f.agent = ?', params: [filter.onlyAgent] };
  if (filter?.excludeAgent) return { sql: ' AND f.agent != ?', params: [filter.excludeAgent] };
  return { sql: '', params: [] };
}

/** Rank a project's facts by keyword for MCP search: FTS5 BM25 (AND first for
 *  precision, OR fallback for recall). With a query, only actual matches are
 *  returned (an empty result is honest — handing back unrelated recent memories
 *  labeled as matches erodes trust). Without a query, return the most recent
 *  memories (the tool's documented "fetch latest" mode). projectId must be a
 *  resolved registered project path (see resolveProject). agentFilter applies
 *  inside the SQL (before LIMIT), so a caller-excluded top-N can't crowd out
 *  other agents' hits. */
export function searchFacts(projectId: string, query?: string, agentFilter?: AgentFilter): Fact[] {
  const af = agentClause(agentFilter);
  if (!query) {
    const rows = get()
      .prepare(
        `SELECT ${FACT_COLUMNS.replace(/(^|,)\s*/g, '$1f.')}
         FROM facts f
         WHERE f.project_id = ?${af.sql}
         ORDER BY f.updated_at DESC
         LIMIT 30`,
      )
      .all(projectId, ...af.params) as any[];
    return rows.map(rowToFact);
  }

  const tokens = ftsTokenize(query).split(' ').filter(Boolean);
  if (tokens.length === 0) return []; // every token filtered out: honest empty, not the recent list

  const base = `
    SELECT ${FACT_COLUMNS.replace(/(^|,)\s*/g, '$1f.')}, bm25(facts_fts) AS kscore
    FROM facts_fts JOIN facts f ON f.rowid = facts_fts.rowid
    WHERE facts_fts MATCH ? AND f.project_id = ?${af.sql}`;

  const run = (expr: string): Fact[] =>
    (get()
      .prepare(`${base} ORDER BY kscore ASC, f.updated_at DESC, f.rowid ASC LIMIT 20`)
      .all(expr, projectId, ...af.params) as any[]).map(rowToFact);

  // AND first (all tokens present — close to the old substring precision), then
  // widen to OR + BM25 ranking when nothing matches everything. OR alone matches
  // any shared character, and with per-char CJK tokens that floods the result
  // with one-char coincidences (数据/配置 turning up in unrelated facts) — so a
  // widened hit must share at least 2 distinct query tokens to count.
  const strict = run(matchExpr(tokens, 'AND'));
  if (strict.length > 0) return strict;

  const widened = run(matchExpr(tokens, 'OR'));
  if (widened.length === 0 || tokens.length < 2) return widened;
  const tokenSet = new Set(tokens);
  return widened.filter((f) => {
    let hits = 0;
    for (const t of new Set(ftsTokenize(f.content).split(' '))) {
      if (tokenSet.has(t)) hits++;
    }
    return hits >= 2;
  });
}

// ---------- Settings ----------

export function getSetting(key: string): string | null {
  const row = get().prepare('SELECT value FROM settings WHERE key = ?').get(key) as any;
  return row?.value ?? null;
}

export function setSetting(key: string, value: string): void {
  get()
    .prepare(
      'INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value',
    )
    .run(key, value);
}

export function deleteSetting(key: string): void {
  get().prepare('DELETE FROM settings WHERE key = ?').run(key);
}
