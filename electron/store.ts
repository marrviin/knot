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
}

let db: Database.Database | null = null;

export type Db = Database.Database;

/** Virtual project that owns every agent's global (non-project-scoped) memories,
 *  e.g. hermes's profile-wide ~/.hermes/memories/. A reserved path that can never
 *  collide with a real directory; pinned first in listProjects and not removable. */
export const GLOBAL_PROJECT = '__global__';
export const GLOBAL_PROJECT_NAME = '全局记忆';

export function dbPath(userDataDir: string): string {
  return path.join(userDataDir, 'knot.db');
}

/** Legacy Tauri app database location (for one-time migration) */
export function legacyDbPath(): string {
  return path.join(
    process.env.HOME || '',
    'Library',
    'Application Support',
    'com.knot.memory',
    'knot.db',
  );
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
 *  INSERT OR IGNORE here would leave the mirror permanently stale. */
export function upsertFact(fact: Omit<Fact, 'createdAt' | 'updatedAt'>): boolean {
  const ts = now();
  const n = get()
    .prepare(
      `INSERT INTO facts (id, project_id, content, norm_key, agent, type, source, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET
         project_id = excluded.project_id,
         content = excluded.content,
         norm_key = excluded.norm_key,
         agent = excluded.agent,
         type = excluded.type,
         source = excluded.source,
         updated_at = excluded.updated_at`,
    )
    .run(fact.id, fact.projectId, fact.content, normalize(fact.content), fact.agent, fact.type, fact.source, ts, ts);
  return n.changes > 0;
}

export function updateFactContent(id: string, content: string): void {
  get()
    .prepare('UPDATE facts SET content = ?, norm_key = ?, updated_at = ? WHERE id = ?')
    .run(content, normalize(content), now(), id);
}

export function deleteFactRow(id: string): void {
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

/** Score and rank a project's facts by keyword (keyword hits + recency) for MCP search.
 *  With a query, only actual keyword hits are returned (an empty result is honest —
 *  handing back unrelated recent memories labeled as matches erodes trust). Without a
 *  query, return the most recent memories (the tool's documented "fetch latest" mode).
 *  projectId must be a resolved registered project path (see resolveProject). */
export function searchFacts(projectId: string, query?: string): Fact[] {
  const rows = get()
    .prepare(
      `SELECT ${FACT_COLUMNS.replace(/(^|,)\s*/g, '$1f.')}
       FROM facts f
       WHERE f.project_id = ?
       ORDER BY f.updated_at DESC`,
    )
    .all(projectId) as any[];
  const all = rows.map(rowToFact);

  // Single CJK characters are meaningful queries; require 2+ only for latin words
  const keywords = (query ?? '')
    .split(/\s+/)
    .filter((k) => k && (/[一-鿿]/.test(k) || [...k].length >= 2))
    .map((k) => k.toLowerCase());

  // No query = documented fetch-latest mode (recent memories). A query whose every
  // token was filtered out must yield an honest empty result, not the recent list
  // dressed up as matches.
  if (keywords.length === 0) return query ? [] : all.slice(0, 30);

  const scored = all
    .map((f) => {
      const lower = f.content.toLowerCase();
      const hits = keywords.filter((k) => lower.includes(k)).length;
      return { hits, f };
    })
    .filter((x) => x.hits > 0);
  scored.sort((a, b) => b.hits - a.hits || b.f.updatedAt - a.f.updatedAt);
  return scored.slice(0, 20).map((x) => x.f);
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

/** Whether the legacy Tauri database is usable (exists and has facts) */
export function legacyDbHasFacts(): boolean {
  const legacy = legacyDbPath();
  if (!fs.existsSync(legacy)) return false;
  try {
    const conn = new Database(legacy, { readonly: true });
    const row = conn.prepare('SELECT COUNT(*) AS c FROM facts').get() as any;
    conn.close();
    return row.c > 0;
  } catch {
    return false;
  }
}

/** Read settings from the legacy Tauri database (for one-time migration) */
export function readLegacySettings(): Record<string, string> {
  const legacy = legacyDbPath();
  if (!fs.existsSync(legacy)) return {};
  try {
    const conn = new Database(legacy, { readonly: true });
    const rows = conn.prepare('SELECT key, value FROM settings').all() as any[];
    conn.close();
    return Object.fromEntries(rows.map((r) => [r.key, r.value]));
  } catch {
    return {};
  }
}

/** Read all facts from the legacy Tauri database (for one-time migration) */
export function readLegacyFacts(): { projectId: string; content: string; agent: string; source: string }[] {
  const conn = new Database(legacyDbPath(), { readonly: true });
  const rows = conn
    .prepare("SELECT project_id, content, agent, source FROM facts WHERE status = 'active' ORDER BY project_id, updated_at")
    .all() as any[];
  conn.close();
  return rows.map((r) => ({
    projectId: r.project_id,
    content: r.content,
    agent: r.agent || 'myagent',
    source: r.source || '',
  }));
}
