//! Background file watching: expands watch targets from (enabled watch cards ×
//! registered projects) (cards are configured in settings; the toggle controls
//! enablement). New/modified files are debounced for 500ms, then handed to mem0
//! for extraction and storage. Also provides one-time guided import of each
//! card's existing content (marked when done, retried next round on failure).
//!
//! A card's `match` is a comma-separated list of match expressions supporting
//! * / ** / ? wildcards:
//! relative paths are expanded against each project root; absolute paths (~ ok)
//! attribute to the registered project containing them, falling back to the
//! global-memory virtual project; `<slug>` expands to each project path's slug;
//! wildcard-less directory entries match all files beneath them.

import chokidar, { type FSWatcher } from 'chokidar';
import crypto from 'node:crypto';
import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs';

import * as store from './store';
import * as mem0 from './mem0';
import * as settings from './settings';
import { log } from './log';
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

/** Progress of the one-time existing-content import, pushed to the renderer
 *  so the project panel can show a live counter while LLM extraction runs. */
export interface ImportProgress {
  /** Project path ('' for a global notice, e.g. LLM not configured) */
  project: string;
  ruleId: string;
  phase: 'start' | 'file' | 'done';
  /** 'file': 1-based index; 'start': 0; 'done': total */
  current: number;
  total: number;
  /** 'file' phase only: the file just ingested */
  file?: string;
  /** 'done' phase only: cumulative report for this rule × project */
  report?: mem0.IngestReport;
  /** 'done' phase only: failure notice (marker stays unset for retry) */
  notice?: string;
}

let onImportProgress: (p: ImportProgress) => void = () => {};

export function setImportListener(cb: (p: ImportProgress) => void): void {
  onImportProgress = cb;
}

// ---------- Match expression compilation ----------

/** One compiled match entry: absolute-path regex + chokidar watch root + owning project.
 *  `hasWild` distinguishes dir-glob roots (memory/*.md → parent fallback ok) from
 *  exact-file targets (CLAUDE.md → missing file must not fall back to the parent:
 *  a registered project like the home directory would be watched recursively). */
interface CompiledEntry {
  rule: WatchRule;
  project: string;
  regex: RegExp;
  root: string;
  hasWild: boolean;
}

/** match expressions → per-project absolute path globs:
 *  - With a `<slug>` placeholder: expanded per project path slug (/a/b/c → -a-b-c)
 *  - Absolute paths (~ ok): attributed to the registered project containing them,
 *    falling back to the global-memory virtual project (agent-level memories like
 *    hermes's ~/.hermes/memories/ don't live inside any registered project)
 *  - Relative paths: expanded against each registered project's root */
function compileEntries(rule: WatchRule): CompiledEntry[] {
  const out: CompiledEntry[] = [];
  for (const raw of rule.match.split(',')) {
    const entry = raw.trim();
    if (!entry) continue;

    if (entry.includes('<slug>')) {
      for (const p of realProjects()) {
        push(out, rule, p.path, expandHome(entry.replace('<slug>', slugify(p.path))));
      }
    } else if (entry.startsWith('~/') || entry === '~' || path.isAbsolute(entry)) {
      const target = expandHome(entry);
      push(out, rule, containingProject(target) ?? store.GLOBAL_PROJECT, target);
    } else {
      for (const p of realProjects()) {
        push(out, rule, p.path, path.join(p.path, entry));
      }
    }
  }
  return out;
}

function push(out: CompiledEntry[], rule: WatchRule, project: string, abs: string): void {
  const regex = entryToRegex(abs);
  if (!regex) return;
  out.push({ rule, project, regex, root: globRoot(abs), hasWild: /[*?]/.test(abs) });
}

/** Single absolute glob → full-path matching regex; a wildcard-less directory matches itself or anything below it */
// (exported for tests)
export function entryToRegex(abs: string): RegExp | null {
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
// (exported for tests)
export function globRoot(abs: string): string {
  const idx = [...abs].findIndex((c) => c === '*' || c === '?');
  if (idx < 0) return abs;
  const prefix = abs.slice(0, idx);
  const cut = prefix.lastIndexOf('/');
  return cut > 0 ? prefix.slice(0, cut) : path.sep;
}

/** Claude Code's project-dir slug encodes every non-alphanumeric char as '-'
 *  (/a/b/my.app → -a-b-my-app), so plain '/'-splitting would miss paths with
 *  dots/underscores in them. */
// (exported for tests)
export function slugify(projectPath: string): string {
  return projectPath.replace(/[^a-zA-Z0-9]/g, '-');
}

function expandHome(p: string): string {
  if (p === '~') return os.homedir();
  if (p.startsWith('~/')) return path.join(os.homedir(), p.slice(2));
  return p;
}

/** Owning project of an absolute path entry: the registered project containing it (longest prefix) */
function containingProject(target: string): string | null {
  let best: string | null = null;
  for (const p of realProjects()) {
    if (isInside(target, p.path) && (!best || p.path.length > best.length)) best = p.path;
  }
  return best;
}

function isInside(changed: string, target: string): boolean {
  return changed === target || changed.startsWith(target + path.sep);
}

/** Registered real projects (the global-memory virtual project only owns absolute entries) */
function realProjects(): { path: string }[] {
  return store.projectRows().filter((p) => p.path !== store.GLOBAL_PROJECT);
}

function enabledRules(): WatchRule[] {
  return settings.loadWatchRules(store).filter((r) => r.enabled);
}

// ---------- Live watching ----------

/** EMFILE guard: a pathological watch target (a registered project that is the home
 *  directory, expanded to its whole tree) would exhaust file descriptors and flood
 *  errors — surface the target count once instead of dying quietly. */
const WATCH_TARGET_WARN = 200;

/** Rebuild watch targets (call after project add/remove or card changes) */
export function rescan(): void {
  watcher ??= createWatcher();
  const wanted = new Set<string>();
  missingFileTargets = new Set<string>();
  for (const rule of enabledRules()) {
    for (const { root, hasWild } of compileEntries(rule)) {
      // Exact-file target missing on disk: watching the existing parent would
      // recursively watch the whole project tree (a home-directory project blows
      // past EMFILE instantly) — poll for creation instead, see missingFileTargets.
      if (!hasWild && !fs.existsSync(root)) {
        missingFileTargets.add(root);
        continue;
      }
      const target = watchableRoot(root);
      if (target) wanted.add(target);
    }
  }
  log(
    `watcher: ${wanted.size} 个监听目标` +
      (missingFileTargets.size > 0 ? `（另有 ${missingFileTargets.size} 个文件待创建，轮询中）` : ''),
  );
  if (wanted.size > WATCH_TARGET_WARN) {
    log(`watcher: 监听目标过多（${wanted.size} > ${WATCH_TARGET_WARN}），有 EMFILE 风险，请检查监听卡片表达式`);
  }
  const toAdd = [...wanted].filter((t) => !watched.has(t));
  const toRemove = [...watched].filter((t) => !wanted.has(t));
  if (toAdd.length > 0) watcher.add(toAdd);
  if (toRemove.length > 0) watcher.unwatch(toRemove);
  watched = wanted;
  syncMissingPoll();
}

/** Wildcard-less file targets that don't exist yet (e.g. CLAUDE.md on first run):
 *  polled so their creation is picked up without the parent-fallback's recursive
 *  watch. Kept as a module var — rescan() rebuilds it on every pass. */
let missingFileTargets = new Set<string>();
let missingPollTimer: NodeJS.Timeout | null = null;
const MISSING_POLL_MS = 20_000;

function syncMissingPoll(): void {
  if (missingFileTargets.size === 0) {
    if (missingPollTimer) {
      clearInterval(missingPollTimer);
      missingPollTimer = null;
    }
    return;
  }
  missingPollTimer ??= setInterval(() => {
    for (const t of missingFileTargets) {
      try {
        fs.statSync(t);
        // Appeared: rescan moves it from the poll set into the live watcher
        rescan();
        return;
      } catch {
        // still missing
      }
    }
  }, MISSING_POLL_MS);
}

/** Watchable target for a dir-glob root: the root itself when it exists; when only the
 *  last segment is missing (e.g. a project's memory/ dir on first agent run), its
 *  existing parent — so the directory created *after* rescan still gets picked up
 *  instead of being missed forever. Only dir-glob roots reach here (rescan routes
 *  missing wildcard-less file targets to polling instead): walking further up (home,
 *  project root) would recursively watch whole trees and exhaust file descriptors. */
// (exported for tests)
export function watchableRoot(root: string): string | null {
  if (fs.existsSync(root)) {
    const st = fs.statSync(root);
    if (st.isFile()) return root;
    return root === path.parse(root).root ? null : root;
  }
  const parent = path.dirname(root);
  if (parent === root || parent === path.parse(parent).root || !fs.existsSync(parent)) return null;
  return fs.statSync(parent).isDirectory() ? parent : null;
}

export function unwatchAll(): void {
  const w = watcher;
  watcher = null;
  watched = new Set();
  missingFileTargets = new Set();
  if (missingPollTimer) {
    clearInterval(missingPollTimer);
    missingPollTimer = null;
  }
  for (const t of debounces.values()) clearTimeout(t);
  debounces.clear();
  for (const t of retryTimers.values()) clearTimeout(t);
  retryTimers.clear();
  // close() is async; swallow rejection on quit (the process is going away anyway)
  void w?.close().catch(() => {});
}

function createWatcher(): FSWatcher {
  const w = chokidar.watch([], {
    ignoreInitial: true,
    // A broad watch root (e.g. an existing project dir whose memory/ subdir is
    // pending) must not recurse into dependency trees.
    ignored: (p: string) => SKIP_DIRS.has(path.basename(p)),
    depth: MAX_WALK_DEPTH,
  });
  const handle = (changed: string) => {
    const m = matchRule(changed);
    if (!m) return;
    // Catalog files (per-card config, default MEMORY.md) are indexes of memory
    // entries, not memories themselves — except where a card opts out (hermes)
    if (settings.indexFilesOf(m.rule).has(path.basename(changed))) return;
    scheduleIngest(changed, m.rule, m.project);
  };
  w.on('add', handle);
  w.on('change', handle);
  // Without an error listener, chokidar's EventEmitter throw takes down the whole
  // GUI process (e.g. a watched directory deleted or permission-denied mid-run).
  // Throttled: an fd-exhausted chokidar can emit thousands of errors a second, and
  // the unthrottled log flood itself would freeze the main process.
  let lastErrorLog = 0;
  w.on('error', (err) => {
    const now = Date.now();
    if (now - lastErrorLog < 10_000) return;
    lastErrorLog = now;
    log(`chokidar 监听错误（已忽略，等待下次变更）: ${err}`);
  });
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
      void ingestFile(file, rule, projectId).catch((e) =>
        log(`ingestFile 异常（已忽略）: ${file}: ${e}`),
      );
    }, DEBOUNCE_MS),
  );
}

/** Failed live-ingest retry queue: a single change is the only chance to capture it
 *  (an agent typically writes a memory file once), so a transient upstream failure
 *  must not silently drop it. Marker-based imports already retry by themselves. */
const MAX_LIVE_RETRIES = 3;
const retryCounts = new Map<string, number>();
const retryTimers = new Map<string, NodeJS.Timeout>();

function scheduleRetry(file: string, rule: WatchRule, projectId: string, attempt: number): void {
  const prev = retryTimers.get(file);
  if (prev) clearTimeout(prev);
  const t = setTimeout(() => {
    retryTimers.delete(file);
    void ingestFile(file, rule, projectId).catch((e) =>
      log(`ingestFile 重试异常（已忽略）: ${file}: ${e}`),
    );
  }, attempt * 10_000);
  retryTimers.set(file, t);
}

/** Read a candidate memory file with guardrails: size cap (a misconfigured card
 *  matching huge files would otherwise ship whole logs/databases to the LLM) and a
 *  binary sniff (NUL bytes) so binary content is never sent for extraction. */
const MAX_FILE_BYTES = 2 * 1024 * 1024;

async function readTextFile(file: string): Promise<string | null> {
  try {
    const st = await fs.promises.stat(file);
    if (!st.isFile() || st.size > MAX_FILE_BYTES) return null;
    const raw = await fs.promises.readFile(file, 'utf-8');
    if (raw.slice(0, 8000).includes('\u0000')) return null; // binary
    return raw;
  } catch {
    return null; // transient write or file deleted — wait for the next event
  }
}

async function ingestFile(file: string, rule: WatchRule, projectId: string): Promise<void> {
  const raw = await readTextFile(file);
  if (!raw?.trim()) return;
  if (!store.projectExists(projectId)) return;

  const report = await mem0.ingest(currentUserDataDir, projectId, raw, {
    agent: rule.agent,
    type: 'local-memory',
    source: file,
  });
  if (report.notice) {
    const attempt = (retryCounts.get(file) ?? 0) + 1;
    retryCounts.set(file, attempt);
    if (attempt <= MAX_LIVE_RETRIES) {
      log(`ingestFile: 失败，${attempt * 10}s 后重试（${attempt}/${MAX_LIVE_RETRIES}）${file}`);
      scheduleRetry(file, rule, projectId, attempt);
    }
  } else {
    retryCounts.delete(file);
  }
  if (report.added + report.updated + report.deleted > 0 || report.notice) {
    onIngested(projectId, report);
  }
}

// ---------- Guided import of existing content ----------

/** Ingest the existing files matched by each enabled card into mem0 (once per
 *  "card × project", idempotent).
 *  Marker keys are scoped per project for both builtin
 *  (bootstrap_done:<ruleId>:<project>) and custom cards
 *  (bootstrap_done:watch:<ruleId>:<match digest>:<project>) — editing a custom
 *  card's expression changes the digest and is treated as a new target; removing
 *  a project clears its markers so re-adding re-imports (restored from mem0
 *  without LLM when the memories are still there). */
export async function importExisting(
  onIngestedCb: (projectId: string, report: mem0.IngestReport) => void,
): Promise<void> {
  // Single-flight: callers overlap (startup / add_project / save_watch_rules /
  // save_settings); queue one re-run — markers make it cheap (done targets skip).
  if (importRunning) {
    importPending = true;
    return;
  }
  importRunning = true;
  try {
    do {
      importPending = false;
      await runImport(onIngestedCb);
    } while (importPending);
  } finally {
    importRunning = false;
  }
}

let importRunning = false;
let importPending = false;

async function runImport(
  onIngestedCb: (projectId: string, report: mem0.IngestReport) => void,
): Promise<void> {
  try {
    await doRunImport(onIngestedCb);
  } catch (e) {
    // Every failure path must emit a done event (with a global notice) — otherwise
    // the renderer's progress ring spins forever with no error surfaced.
    log(`importExisting: 失败: ${e}`);
    onImportProgress({
      project: '',
      ruleId: '',
      phase: 'done',
      current: 0,
      total: 0,
      report: { added: 0, updated: 0, deleted: 0 },
      notice: `存量导入中断: ${e}`,
    });
    throw e;
  }
}

async function doRunImport(
  onIngestedCb: (projectId: string, report: mem0.IngestReport) => void,
): Promise<void> {
  log('importExisting: 开始存量导入');
  // Initialize mem0 here (covers enable-off / unconfigured / config-changed rebuild);
  // a null result is reported so the renderer can surface it instead of failing silently.
  if (!(await mem0.ensureMemory(currentUserDataDir))) {
    log('importExisting: mem0 未就绪（未启用或未配置）');
    onImportProgress({
      project: '',
      ruleId: '',
      phase: 'done',
      current: 0,
      total: 0,
      report: { added: 0, updated: 0, deleted: 0 },
      notice: '记忆服务未配置，已有记忆未导入',
    });
    return;
  }
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
        : `bootstrap_done:watch:${rule.id}:${hash(rule.match)}:${project}`;
      if (store.getSetting(markerKey)) {
        log(`importExisting: 跳过（marker 已设）${rule.id} × ${project}`);
        continue;
      }
      // Migration: mem0 already holds memories from this agent for this project ⇒ the
      // old bootstrap already ran (e.g. the project was removed and re-added). Restore
      // the wiped mirror straight from mem0 — no LLM extraction — and set the marker.
      const existing = await mem0.memoryCountByAgent(project, rule.agent);
      if (existing > 0) {
        const report = await mem0.restoreMirror(project);
        store.setSetting(markerKey, '1');
        log(`importExisting: 迁移恢复（mem0 已有 ${existing} 条，镜像补回 ${report.added} 条）${rule.id} × ${project}`);
        onImportProgress({
          project,
          ruleId: rule.id,
          phase: 'done',
          current: report.added,
          total: report.added,
          report,
        });
        continue;
      }

      const files = new Set<string>();
      for (const { regex, root } of entries) {
        for (const f of await collectFiles(root, regex, settings.indexFilesOf(rule))) files.add(f);
      }
      log(`importExisting: ${rule.id} × ${project} 匹配到 ${files.size} 个文件`);
      if (files.size > 0) {
        onImportProgress({ project, ruleId: rule.id, phase: 'start', current: 0, total: files.size });
      }

      let done = 0;
      const total: mem0.IngestReport = { added: 0, updated: 0, deleted: 0 };
      for (const file of [...files].sort()) {
        log(`importExisting: 开始导入 ${file}（${done + 1}/${files.size}）`);
        // One bad file (upstream down, init failure) must not abort the whole
        // import mid-way — record the notice and keep going; the marker stays
        // unset so a later import retries the failed round.
        const report = await ingestFileOnce(project, file, rule, onIngestedCb).catch(
          (e): mem0.IngestReport => {
            log(`importExisting: 单文件导入失败 ${file}: ${e}`);
            return { added: 0, updated: 0, deleted: 0, notice: '记忆入库失败' };
          },
        );
        log(`importExisting: 完成 ${path.basename(file)} added=${report.added} updated=${report.updated} deleted=${report.deleted}${report.notice ? ` notice=${report.notice}` : ''}`);
        done += 1;
        onImportProgress({
          project,
          ruleId: rule.id,
          phase: 'file',
          current: done,
          total: files.size,
          file,
        });
        total.added += report.added;
        total.updated += report.updated;
        total.deleted += report.deleted;
        if (report.notice) total.notice = report.notice;
      }
      if (!total.notice) store.setSetting(markerKey, '1');
      onImportProgress({
        project,
        ruleId: rule.id,
        phase: 'done',
        current: done,
        total: files.size,
        report: total,
      });
    }
  }
}

/** Collect existing files under a watch root matching the regex (depth-limited walk;
 *  direct check when the root is a file; catalog files per card config are skipped) */
async function collectFiles(root: string, regex: RegExp, skip: Set<string>): Promise<string[]> {
  const st = await fs.promises.stat(root).catch(() => null);
  if (!st) return [];
  if (st.isFile()) return regex.test(root) && !skip.has(path.basename(root)) ? [root] : [];

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
      } else if (!skip.has(e.name) && regex.test(full)) {
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
  const raw = await readTextFile(file);
  if (!raw?.trim()) return { added: 0, updated: 0, deleted: 0 };
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
