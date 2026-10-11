//! Background file watching: expands watch targets from (enabled watch cards ×
//! registered projects) (cards are configured in settings; the toggle controls
//! enablement). New/modified files are debounced for 500ms, then handed to mem0
//! for extraction and storage. Also provides one-time guided import of each
//! card's existing content (marked when done, retried next round on failure).
//!
//! A card's `match` is a comma-separated list of match expressions supporting
//! * / ** / ? wildcards:
//! relative paths are expanded against each project root; absolute paths (~ ok)
//! must lie inside a registered project; `<slug>` expands to each project path's
//! slug; wildcard-less directory entries match all files beneath them.

import chokidar, { type FSWatcher } from 'chokidar';
import crypto from 'node:crypto';
import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs';

import * as store from './store';
import * as mem0 from './mem0';
import * as settings from './settings';
import type { WatchRule } from './settings';

const DEBOUNCE_MS = 500;
const MAX_WALK_DEPTH = 8;
const SKIP_DIRS = new Set(['node_modules', '.git']);

let watcher: FSWatcher | null = null;
let watched = new Set<string>();
const debounces = new Map<string, NodeJS.Timeout>();
let onIngested: (projectId: string, report: mem0.IngestReport) => void = () => {};

export function setIngestListener(
  cb: (projectId: string, report: mem0.IngestReport) => void,
): void {
  onIngested = cb;
}

// ---------- Match expression compilation ----------

/** One compiled match entry: absolute-path regex + chokidar watch root + owning project */
interface CompiledEntry {
  rule: WatchRule;
  project: string;
  regex: RegExp;
  root: string;
}

/** match expressions → per-project absolute path globs:
 *  - With a `<slug>` placeholder: expanded per project path slug (/a/b/c → -a-b-c)
 *  - Absolute paths (~ ok): attributed to the registered project containing them
 *  - Relative paths: expanded against each registered project's root */
function compileEntries(rule: WatchRule): CompiledEntry[] {
  const out: CompiledEntry[] = [];
  for (const raw of rule.match.split(',')) {
    const entry = raw.trim();
    if (!entry) continue;

    if (entry.includes('<slug>')) {
      for (const p of store.projectRows()) {
        push(out, rule, p.path, expandHome(entry.replace('<slug>', slugify(p.path))));
      }
    } else if (entry.startsWith('~/') || entry === '~' || path.isAbsolute(entry)) {
      const target = expandHome(entry);
      const project = containingProject(target);
      if (project) push(out, rule, project, target);
    } else {
      for (const p of store.projectRows()) {
        push(out, rule, p.path, path.join(p.path, entry));
      }
    }
  }
  return out;
}

function push(out: CompiledEntry[], rule: WatchRule, project: string, abs: string): void {
  const regex = entryToRegex(abs);
  if (!regex) return;
  out.push({ rule, project, regex, root: globRoot(abs) });
}

/** Single absolute glob → full-path matching regex; a wildcard-less directory matches itself or anything below it */
function entryToRegex(abs: string): RegExp | null {
  let re = '';
  let hasWild = false;
  for (let i = 0; i < abs.length; i++) {
    const c = abs[i];
    if (c === '*' || c === '?') {
      hasWild = true;
      if (c === '*' && abs[i + 1] === '*') {
        re += '.*';
        i++;
        if (abs[i + 1] === '/') i++; // ** also consumes the following separator
      } else {
        re += c === '*' ? '[^/]*' : '[^/]';
      }
    } else {
      re += c.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    }
  }
  if (!hasWild) re += '(/.*)?';
  try {
    return new RegExp(`^${re}$`);
  } catch {
    return null;
  }
}

/** chokidar watch root for a glob: the directory prefix before the first wildcard */
function globRoot(abs: string): string {
  const idx = [...abs].findIndex((c) => c === '*' || c === '?');
  if (idx < 0) return abs;
  const prefix = abs.slice(0, idx);
  const cut = prefix.lastIndexOf('/');
  return cut > 0 ? prefix.slice(0, cut) : path.sep;
}

function slugify(projectPath: string): string {
  return projectPath.split('/').join('-');
}

function expandHome(p: string): string {
  if (p === '~') return os.homedir();
  if (p.startsWith('~/')) return path.join(os.homedir(), p.slice(2));
  return p;
}

/** Owning project of an absolute path entry: the registered project containing it (longest prefix) */
function containingProject(target: string): string | null {
  let best: string | null = null;
  for (const p of store.projectRows()) {
    if (isInside(target, p.path) && (!best || p.path.length > best.length)) best = p.path;
  }
  return best;
}

function isInside(changed: string, target: string): boolean {
  return changed === target || changed.startsWith(target + path.sep);
}

function enabledRules(): WatchRule[] {
  return settings.loadWatchRules(store).filter((r) => r.enabled);
}

// ---------- Live watching ----------

/** Rebuild watch targets (call after project add/remove or card changes) */
export function rescan(): void {
  watcher ??= createWatcher();
  const wanted = new Set<string>();
  for (const rule of enabledRules()) {
    for (const { root } of compileEntries(rule)) {
      if (fs.existsSync(root)) wanted.add(root);
    }
  }
  const toAdd = [...wanted].filter((t) => !watched.has(t));
  const toRemove = [...watched].filter((t) => !wanted.has(t));
  if (toAdd.length > 0) watcher.add(toAdd);
  if (toRemove.length > 0) watcher.unwatch(toRemove);
  watched = wanted;
}

export function unwatchAll(): void {
  watcher?.close();
  watcher = null;
  watched = new Set();
  for (const t of debounces.values()) clearTimeout(t);
  debounces.clear();
}

function createWatcher(): FSWatcher {
  const w = chokidar.watch([], { ignoreInitial: true });
  const handle = (changed: string) => {
    const m = matchRule(changed);
    if (!m) return;
    // Index files are catalogs of memory entries, not stored as memories
    if (path.basename(changed) === 'MEMORY.md') return;
    scheduleIngest(changed, m.rule, m.project);
  };
  w.on('add', handle);
  w.on('change', handle);
  return w;
}

/** Match a changed file to its card and owning project (enabled cards in order, first hit wins) */
function matchRule(changed: string): { rule: WatchRule; project: string } | null {
  for (const rule of enabledRules()) {
    for (const { project, regex } of compileEntries(rule)) {
      if (regex.test(changed)) return { rule, project };
    }
  }
  return null;
}

// ---------- Change → extraction & storage ----------

function scheduleIngest(file: string, rule: WatchRule, projectId: string): void {
  const prev = debounces.get(file);
  if (prev) clearTimeout(prev);
  debounces.set(
    file,
    setTimeout(() => {
      debounces.delete(file);
      void ingestFile(file, rule, projectId);
    }, DEBOUNCE_MS),
  );
}

async function ingestFile(file: string, rule: WatchRule, projectId: string): Promise<void> {
  let raw: string;
  try {
    raw = await fs.promises.readFile(file, 'utf-8');
  } catch {
    return; // transient write or file deleted — wait for the next event
  }
  if (!raw.trim()) return;
  if (!store.projectExists(projectId)) return;

  const report = await mem0.ingest(currentUserDataDir, projectId, raw, {
    agent: rule.agent,
    type: 'local-memory',
    source: file,
  });
  if (report.added + report.updated + report.deleted > 0 || report.notice) {
    onIngested(projectId, report);
  }
}

// ---------- Guided import of existing content ----------

/** Ingest the existing files matched by each enabled card into mem0 (once per
 *  "card × project", idempotent).
 *  Builtin cards keep the bootstrap_done:<ruleId>:<project> marker key; custom
 *  cards are marked by id + match digest (editing the expression is treated as
 *  a new target and re-imported). */
export async function importExisting(
  onIngestedCb: (projectId: string, report: mem0.IngestReport) => void,
): Promise<void> {
  if (!mem0.isReady()) return;
  for (const rule of enabledRules()) {
    const byProject = new Map<string, CompiledEntry[]>();
    for (const entry of compileEntries(rule)) {
      const list = byProject.get(entry.project) ?? [];
      list.push(entry);
      byProject.set(entry.project, list);
    }

    for (const [project, entries] of byProject) {
      const markerKey = rule.builtin
        ? `bootstrap_done:${rule.id}:${project}`
        : `bootstrap_done:watch:${rule.id}:${hash(rule.match)}`;
      if (store.getSetting(markerKey)) continue;
      // Migration: project already has memories from this agent ⇒ old bootstrap already ran; set the marker and skip
      if (store.factCountByAgent(project, rule.agent) > 0) {
        store.setSetting(markerKey, '1');
        continue;
      }

      const files = new Set<string>();
      for (const { regex, root } of entries) {
        for (const f of await collectFiles(root, regex)) files.add(f);
      }

      const total: mem0.IngestReport = { added: 0, updated: 0, deleted: 0 };
      for (const file of [...files].sort()) {
        const report = await ingestFileOnce(project, file, rule, onIngestedCb);
        total.added += report.added;
        total.updated += report.updated;
        total.deleted += report.deleted;
        if (report.notice) total.notice = report.notice;
      }
      if (!total.notice) store.setSetting(markerKey, '1');
    }
  }
}

/** Collect existing files under a watch root matching the regex (depth-limited walk; direct check when the root is a file) */
async function collectFiles(root: string, regex: RegExp): Promise<string[]> {
  const st = await fs.promises.stat(root).catch(() => null);
  if (!st) return [];
  if (st.isFile()) return regex.test(root) ? [root] : [];

  const out: string[] = [];
  const walk = async (dir: string, depth: number): Promise<void> => {
    if (depth > MAX_WALK_DEPTH) return;
    let entries;
    try {
      entries = await fs.promises.readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      const full = path.join(dir, e.name);
      if (e.isDirectory()) {
        if (!SKIP_DIRS.has(e.name)) await walk(full, depth + 1);
      } else if (e.name !== 'MEMORY.md' && regex.test(full)) {
        out.push(full);
      }
    }
  };
  await walk(root, 0);
  return out;
}

async function ingestFileOnce(
  projectId: string,
  file: string,
  rule: WatchRule,
  onIngestedCb: (projectId: string, report: mem0.IngestReport) => void,
): Promise<mem0.IngestReport> {
  let raw = '';
  try {
    raw = await fs.promises.readFile(file, 'utf-8');
  } catch {
    return { added: 0, updated: 0, deleted: 0 };
  }
  if (!raw.trim()) return { added: 0, updated: 0, deleted: 0 };
  const report = await mem0.ingest(currentUserDataDir, projectId, raw, {
    agent: rule.agent,
    type: 'local-memory',
    source: file,
  });
  if (report.added + report.updated + report.deleted > 0 || report.notice) {
    onIngestedCb(projectId, report);
  }
  return report;
}

function hash(text: string): string {
  return crypto.createHash('md5').update(text).digest('hex').slice(0, 12);
}

// userData path injected from main.ts (avoids circular dependency on the app object)
let currentUserDataDir = '';
export function setUserDataDir(dir: string): void {
  currentUserDataDir = dir;
}
