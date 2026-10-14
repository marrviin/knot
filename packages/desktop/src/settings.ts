//! Settings: LLM extraction-layer config (mem0's LLM).
//! One protocol family: any OpenAI-compatible chat service (standard
//! /chat/completions — OpenAI, MiniMax, DeepSeek, SiliconFlow, … all speak it).
//! Stored in the mirror store's settings table; the API key is stored locally only —
//! the renderer only ever receives a "is configured" flag.

import type * as store from './store';
import { PROVIDER_DEFAULT } from '@knot/shared';

/** Where the memory service runs: 'local' = Electron spawns the server/ bundle as
 *  a child process (default, data stays in userData); 'remote' = a user-deployed
 *  instance of the same service (server/ has the Dockerfile), addressed by URL.
 *  Both modes share one HTTP client — only the connection differs. */
export type MemoryMode = 'local' | 'remote';

export interface LlmSettings {
  baseUrl: string;
  model: string;
  apiKey: string;
  /** Service mode (see MemoryMode). In remote mode the LLM block is ignored —
   *  keys live on the service; only the URL + token matter here. */
  mode: MemoryMode;
  remoteUrl: string;
  remoteToken: string;
}

export interface LlmSettingsView {
  baseUrl: string;
  model: string;
  hasApiKey: boolean;
  mode: MemoryMode;
  remoteUrl: string;
  hasRemoteToken: boolean;
}

export function load(s: typeof store): LlmSettings {
  return {
    baseUrl: s.getSetting('llm_base_url') || PROVIDER_DEFAULT.baseUrl,
    model: s.getSetting('llm_model') || PROVIDER_DEFAULT.model,
    apiKey: s.getSetting('llm_api_key') || '',
    mode: s.getSetting('llm_mode') === 'remote' ? 'remote' : 'local',
    remoteUrl: s.getSetting('llm_remote_url') || '',
    remoteToken: s.getSetting('llm_remote_token') || '',
  };
}

/** Per-mode: local embeddings always work (the bundled model needs nothing — the
 *  chat key only enables journal backfill); remote mode needs a service address
 *  (keys are configured server-side). */
export function isConfigured(s: LlmSettings): boolean {
  if (s.mode === 'remote') return !!s.remoteUrl.trim();
  return true;
}

export function view(s: LlmSettings): LlmSettingsView {
  return {
    baseUrl: s.baseUrl,
    model: s.model,
    hasApiKey: !!s.apiKey,
    mode: s.mode,
    remoteUrl: s.remoteUrl,
    hasRemoteToken: !!s.remoteToken,
  };
}

export function save(
  s: typeof store,
  baseUrl: string,
  apiKey: string | null,
  model: string,
  mode?: MemoryMode,
  remoteUrl?: string,
  remoteToken?: string | null,
): void {
  s.setSetting('llm_base_url', baseUrl.trim() || PROVIDER_DEFAULT.baseUrl);
  s.setSetting('llm_model', model.trim() || PROVIDER_DEFAULT.model);
  s.setSetting('llm_mode', mode === 'remote' ? 'remote' : 'local');
  s.setSetting('llm_remote_url', (remoteUrl ?? '').trim());
  // remoteToken: undefined = keep the stored token (field untouched);
  // '' = explicit clear; non-empty = replace. Same contract as apiKey above.
  if (remoteToken === undefined) {
    // keep
  } else if (remoteToken && remoteToken.trim()) {
    s.setSetting('llm_remote_token', remoteToken.trim());
  } else {
    s.deleteSetting('llm_remote_token');
  }
  // null = keep the stored key (field untouched); '' = explicit clear; non-empty = replace
  if (apiKey === null) {
    // keep
  } else if (apiKey.trim()) {
    s.setSetting('llm_api_key', apiKey.trim());
  } else {
    s.deleteSetting('llm_api_key');
  }
}

// ---------- Saved model library (multiple configs, one active) ----------

/** One saved model-service config in the renderer's model library. The entry that
 *  matches the active llm_* scalars (see activeIdOf) is the one in use. */
export interface LlmModelEntry {
  id: string;
  baseUrl: string;
  model: string;
  /** Stored locally only; the renderer only ever sees hasApiKey. */
  apiKey: string;
}

const MODELS_KEY = 'llm_models';

/** Load the saved-model library. One-time migration: an existing install's active
 *  scalar config is seeded as the first entry, so the library starts non-empty. */
export function loadModels(s: typeof store): LlmModelEntry[] {
  const raw = s.getSetting(MODELS_KEY);
  if (raw !== null) {
    try {
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed)) {
        return parsed
          .filter((m) => m && typeof m.baseUrl === 'string' && typeof m.model === 'string')
          .map((m) => ({
            id: typeof m.id === 'string' && m.id ? m.id : `model-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
            // Legacy entries carried a provider field ('minimax' | 'openai'); the
            // protocol split is gone — every service speaks OpenAI wire format now,
            // so the stored value is simply dropped.
            baseUrl: m.baseUrl,
            model: m.model,
            apiKey: typeof m.apiKey === 'string' ? m.apiKey : '',
          }));
      }
    } catch {
      if (raw) s.setSetting(`${MODELS_KEY}_corrupt_backup`, raw);
    }
  }
  // Seed from the active scalar config (legacy installs / first run after this feature).
  const cur = load(s);
  if (cur.baseUrl && cur.apiKey && cur.model) {
    const seeded: LlmModelEntry = {
      id: 'model-seeded-active',
      baseUrl: cur.baseUrl,
      model: cur.model,
      apiKey: cur.apiKey,
    };
    s.setSetting(MODELS_KEY, JSON.stringify([seeded]));
    return [seeded];
  }
  return [];
}

function persistModels(s: typeof store, models: LlmModelEntry[]): void {
  s.setSetting(MODELS_KEY, JSON.stringify(models));
}

/** Upsert an entry (assigns an id when blank). Returns the stored entry. */
export function saveModel(s: typeof store, entry: Partial<LlmModelEntry>): LlmModelEntry {
  const models = loadModels(s);
  const id = entry.id || `model-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const prev = models.find((m) => m.id === id);
  const next: LlmModelEntry = {
    id,
    baseUrl: (entry.baseUrl ?? prev?.baseUrl ?? '').trim(),
    model: (entry.model ?? prev?.model ?? '').trim(),
    // apiKey undefined = keep the stored key (field untouched); '' = clear; non-empty = replace.
    apiKey: entry.apiKey === undefined ? (prev?.apiKey ?? '') : entry.apiKey.trim(),
  };
  persistModels(s, prev ? models.map((m) => (m.id === id ? next : m)) : [...models, next]);
  return next;
}

export function deleteModel(s: typeof store, id: string): void {
  persistModels(s, loadModels(s).filter((m) => m.id !== id));
}

/** The library entry currently in use: field-matches the active llm_* scalars.
 *  Field matching (instead of a stored active-id) keeps the scalars the single
 *  source of truth — edits via the old save path can't desync the flag. */
export function activeIdOf(s: typeof store, models: LlmModelEntry[]): string | null {
  const cur = load(s);
  const m = models.find((x) => x.baseUrl === cur.baseUrl && x.model === cur.model);
  return m?.id ?? null;
}

// ---------- Memory watch rules ----------

export interface WatchRule {
  /** Stable id: part of the UI key and of builtin cards' guided-import marker */
  id: string;
  /** Agent label attributed to memories ingested on change */
  agent: string;
  /** Match expression: comma-separated entries supporting * / ** / ? wildcards.
   *  Relative paths expand against each registered project; absolute paths (~ ok)
   *  must lie inside a registered project; the `<slug>` placeholder expands to the
   *  project path slug (/a/b/c → -a-b-c).
   *  Wildcard-less directory entries match all files beneath them. */
  match: string;
  /** Enable switch: when off, neither watching nor importing happens */
  enabled: boolean;
  /** Builtin default card (path locked, auto-restored when missing; can only be toggled, not deleted/retargeted) */
  builtin?: boolean;
  /** Basenames treated as catalogs of memory entries and never ingested.
   *  Default ['MEMORY.md'] (claude-code's auto-memory index); set to [] for agents
   *  whose MEMORY.md is the memory body itself (hermes). Config-managed per card —
   *  no hardcoded per-agent exceptions in the watcher. */
  indexFiles?: string[];
}

export const DEFAULT_INDEX_FILES = ['MEMORY.md'];

/** Skip set for a card's catalog files (per-card config, with the shared default) */
export function indexFilesOf(rule: WatchRule): Set<string> {
  return new Set(rule.indexFiles ?? DEFAULT_INDEX_FILES);
}

/** Default cards for common local agents. claude-code keeps per-project auto-memory
 *  under ~/.claude/projects/<slug>/memory/; hermes has no per-project memory — its
 *  built-in memory bank is profile-global (~/.hermes/memories/MEMORY.md + USER.md),
 *  so its entry is absolute and attributes to the global-memory virtual project.
 *  codex has no per-project memory dir: its instructions are per-project AGENTS.md,
 *  and its (default-off) local memories live profile-global under ~/.codex/memories/
 *  — the memory entry is absolute and attributes to the global-memory virtual
 *  project; disabled by default since the feature is off upstream. workbuddy keeps a
 *  profile-global per-user memory file (~/.workbuddy/memory/<uid>_memory.md — the
 *  whole file is the memory body), so its entry is absolute and attributes to the
 *  global-memory virtual project like hermes; the `*_memory.md` glob keeps sibling
 *  `.bak` backups out. */
export const DEFAULT_WATCH_RULES: WatchRule[] = [
  {
    id: 'claude-code',
    agent: 'claude-code',
    match: '~/.claude/projects/<slug>/memory/*.md, CLAUDE.md',
    enabled: true,
    builtin: true,
  },
  {
    id: 'codex',
    agent: 'codex',
    // per-project AGENTS.md + the profile-global (default-off) memory store
    match: 'AGENTS.md, ~/.codex/memories/**',
    enabled: false,
    builtin: true,
  },
  {
    id: 'hermes',
    agent: 'hermes',
    match: '~/.hermes/memories/*.md',
    indexFiles: [], // MEMORY.md is hermes's memory body (§-delimited entries), not an index
    enabled: false,
    builtin: true,
  },
  { id: 'joycode', agent: 'joycode', match: '.joycode/memory/*.md', enabled: true, builtin: true },
  {
    id: 'workbuddy',
    agent: 'workbuddy',
    match: '~/.workbuddy/memory/*_memory.md',
    enabled: true,
    builtin: true,
  },
];

const WATCH_KEY = 'watch_rules';

/** Load watch rules: converts legacy data (path+pattern) into match expressions;
 *  builtin cards follow the app version (match/agent/indexFiles forced to the preset,
 *  only the toggle stays user-owned); missing builtin cards are auto-restored. */
export function loadWatchRules(s: typeof store): WatchRule[] {
  const raw = s.getSetting(WATCH_KEY);
  let rules: WatchRule[] = [];
  if (raw !== null) {
    try {
      const parsed = JSON.parse(raw);
      if (!Array.isArray(parsed)) throw new Error('not an array');
      rules = parsed
        .filter((r) => r && typeof r.id === 'string' && typeof r.agent === 'string')
        .map((r) => {
          let match = typeof r.match === 'string' ? r.match.trim() : '';
          // Legacy format migration: path(+pattern) → match
          if (!match && typeof r.path === 'string' && r.path.trim()) {
            const p = r.path.trim().replace(/\/+$/, '');
            const pat = typeof r.pattern === 'string' ? r.pattern.trim() : '';
            match = pat && !p.endsWith(pat) ? `${p}/${pat}` : p;
          }
          return {
            id: r.id,
            agent: r.agent.trim() || 'custom',
            match,
            enabled: r.enabled ?? true,
            builtin: !!r.builtin,
            indexFiles: Array.isArray(r.indexFiles)
              ? r.indexFiles.filter((x: unknown): x is string => typeof x === 'string')
              : undefined,
          };
        });
        // An empty match is kept: it's a card mid-edit, and dropping it here would
        // make the next save silently delete the user's card (it just matches nothing).
    } catch {
      // Corrupted stored JSON: run with builtin defaults, but keep a one-time backup
      // so the user's custom cards survive when this (builtin-only) state gets saved back.
      if (raw) s.setSetting(`${WATCH_KEY}_corrupt_backup`, raw);
      rules = [];
    }
  }
  const presetIds = new Set(DEFAULT_WATCH_RULES.map((r) => r.id));
  const presets = new Map(DEFAULT_WATCH_RULES.map((r) => [r.id, r]));
  rules = rules.map((r) => {
    const preset = r.builtin ? presets.get(r.id) : undefined;
    return preset ? { ...r, match: preset.match, agent: preset.agent, indexFiles: preset.indexFiles } : r;
  });
  const have = new Set(rules.map((r) => r.id));
  for (const preset of DEFAULT_WATCH_RULES) {
    if (!have.has(preset.id)) rules.push({ ...preset });
  }
  // Builtin cards are managed by the app version: ones whose id left the preset list (e.g. legacy myagent) are dropped too
  return rules.filter((r) => !r.builtin || presetIds.has(r.id));
}

export function saveWatchRules(s: typeof store, rules: WatchRule[]): WatchRule[] {
  const cleaned = (Array.isArray(rules) ? rules : [])
    // Empty-match rules are kept on purpose: dropping them here silently deletes a
    // card the user is mid-edit on (persist fires on blur). They simply match nothing.
    .filter((r) => r && typeof r.match === 'string')
    .map((r) => ({
      id: typeof r.id === 'string' && r.id ? r.id : `watch-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      agent: (r.agent ?? '').trim() || 'custom',
      match: r.match.trim(),
      enabled: r.enabled !== false,
      builtin: !!r.builtin,
      ...(Array.isArray(r.indexFiles) ? { indexFiles: r.indexFiles } : {}),
    }));
  s.setSetting(WATCH_KEY, JSON.stringify(cleaned));
  return cleaned;
}
