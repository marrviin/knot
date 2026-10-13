//! Server-side meta store (better-sqlite3, dataDir/projects.db): the project
//! registry + per-fact display timestamps. mem0 stays the truth source for
//! memory content; this store only carries what the display layer needs that
//! mem0 doesn't hold natively (project names, createdAt/updatedAt per fact).
//!
//! Timestamps live here instead of mem0 metadata on purpose: mem0's own
//! update path doesn't let us stamp metadata reliably, and old facts created
//! before this store existed simply have no row (UI renders "-") — no risky
//! metadata backfill into the vector store.

import fs from 'node:fs';
import path from 'node:path';

import Database from 'better-sqlite3';

let db: Database.Database | null = null;
let dbDir: string | null = null;

function open(dataDir: string): Database.Database {
  if (db && dbDir === dataDir) return db;
  // close a handle opened for a different dataDir (tests / config changes)
  if (db) db.close();
  fs.mkdirSync(dataDir, { recursive: true });
  db = new Database(path.join(dataDir, 'projects.db'));
  db.pragma('journal_mode = WAL');
  db.exec(`
    CREATE TABLE IF NOT EXISTS projects (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      added_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS facts_meta (
      id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL,
      created_at INTEGER,
      updated_at INTEGER
    );
    CREATE INDEX IF NOT EXISTS idx_facts_meta_project ON facts_meta (project_id);
  `);
  dbDir = dataDir;
  return db;
}

export function close(): void {
  if (db) db.close();
  db = null;
  dbDir = null;
}

/** Reserved virtual project that owns every agent's global (non-project-scoped)
 *  memories — mirrors the desktop client's reserved path; pinned first there. */
export const GLOBAL_PROJECT = '__global__';
export const GLOBAL_PROJECT_NAME = '全局记忆';

/** Display name for a bare projectId: desktop sends directory paths, so the
 *  last path segment is the natural label; web clients may pass an explicit name. */
function defaultName(projectId: string): string {
  const parts = projectId.split(/[\\/]/).filter(Boolean);
  return parts[parts.length - 1] || projectId;
}

/** Register a project if unknown (ingest/facts writes call this lazily). */
export function ensureProject(dataDir: string, projectId: string, name?: string): void {
  open(dataDir)
    .prepare('INSERT OR IGNORE INTO projects (id, name, added_at) VALUES (?, ?, ?)')
    .run(projectId, name ?? defaultName(projectId), Date.now());
}

export function removeProjectRow(dataDir: string, projectId: string): void {
  const conn = open(dataDir);
  conn.prepare('DELETE FROM projects WHERE id = ?').run(projectId);
  conn.prepare('DELETE FROM facts_meta WHERE project_id = ?').run(projectId);
}

/** Registry rows in insertion order (the client pins the virtual global project). */
export function projectRows(dataDir: string): { id: string; name: string; added_at: number }[] {
  return open(dataDir)
    .prepare('SELECT id, name, added_at FROM projects ORDER BY added_at, rowid')
    .all() as { id: string; name: string; added_at: number }[];
}

/** Stamp created_at/updated_at (unix ms) for freshly added fact ids. */
export function stampAdded(dataDir: string, projectId: string, ids: string[], at: number): void {
  if (!ids.length) return;
  const stmt = open(dataDir).prepare(
    'INSERT OR REPLACE INTO facts_meta (id, project_id, created_at, updated_at) VALUES (?, ?, ?, ?)',
  );
  const tx = db!.transaction((rows: string[]) => {
    for (const id of rows) stmt.run(id, projectId, at, at);
  });
  tx(ids);
}

/** Advance updated_at for ids whose content changed (created_at preserved). */
export function stampUpdated(dataDir: string, ids: string[], at: number): void {
  if (!ids.length) return;
  const stmt = open(dataDir).prepare(
    'UPDATE facts_meta SET updated_at = ? WHERE id = ?',
  );
  const tx = db!.transaction((rows: string[]) => {
    for (const id of rows) stmt.run(at, id);
  });
  tx(ids);
}

/** Drop meta rows for facts the service no longer holds. */
export function deleteMeta(dataDir: string, ids: string[]): void {
  if (!ids.length) return;
  const stmt = open(dataDir).prepare('DELETE FROM facts_meta WHERE id = ?');
  const tx = db!.transaction((rows: string[]) => {
    for (const id of rows) stmt.run(id);
  });
  tx(ids);
}

/** created_at/updated_at by fact id for one project (missing id → absent key). */
export function metaOf(dataDir: string, projectId: string): Map<string, { createdAt: number | null; updatedAt: number | null }> {
  const rows = open(dataDir)
    .prepare('SELECT id, created_at, updated_at FROM facts_meta WHERE project_id = ?')
    .all(projectId) as { id: string; created_at: number | null; updated_at: number | null }[];
  return new Map(rows.map((r) => [r.id, { createdAt: r.created_at, updatedAt: r.updated_at }]));
}

/** Newest updated_at across a project's meta rows (null when unknown — pre-meta
 *  facts contribute nothing; the UI falls back to "-"). */
export function lastUpdatedAt(dataDir: string, projectId: string): number | null {
  const row = open(dataDir)
    .prepare('SELECT MAX(updated_at) AS last FROM facts_meta WHERE project_id = ?')
    .get(projectId) as { last: number | null };
  return row.last ?? null;
}
