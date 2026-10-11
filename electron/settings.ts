//! Settings: LLM extraction-layer config (both mem0's LLM and embedding go through MiniMax).
//! Stored in the mirror store's settings table; the API key is stored locally only —
//! the renderer only ever receives a "is configured" flag.

import type * as store from './store';

export interface LlmSettings {
  enabled: boolean;
  baseUrl: string;
  model: string;
  apiKey: string;
}

export interface LlmSettingsView {
  enabled: boolean;
  baseUrl: string;
  model: string;
  hasApiKey: boolean;
}

const DEFAULT_BASE_URL = 'https://api.minimax.cn/v1';
const DEFAULT_MODEL = 'MiniMax-M2.7';

export function load(s: typeof store): LlmSettings {
  return {
    enabled: s.getSetting('llm_enabled') === '1',
    baseUrl: s.getSetting('llm_base_url') || DEFAULT_BASE_URL,
    model: s.getSetting('llm_model') || DEFAULT_MODEL,
    apiKey: s.getSetting('llm_api_key') || '',
  };
}

export function isConfigured(s: LlmSettings): boolean {
  return !!(s.baseUrl && s.apiKey && s.model);
}

export function view(s: LlmSettings): LlmSettingsView {
  return {
    enabled: s.enabled,
    baseUrl: s.baseUrl,
    model: s.model,
    hasApiKey: !!s.apiKey,
  };
}

export function save(
  s: typeof store,
  enabled: boolean,
  baseUrl: string,
  apiKey: string | null,
  model: string,
): void {
  s.setSetting('llm_enabled', enabled ? '1' : '0');
  s.setSetting('llm_base_url', baseUrl.trim() || DEFAULT_BASE_URL);
  s.setSetting('llm_model', model.trim() || DEFAULT_MODEL);
  // null = keep the stored key (field untouched); '' = explicit clear; non-empty = replace
  if (apiKey === null) {
    // keep
  } else if (apiKey.trim()) {
    s.setSetting('llm_api_key', apiKey.trim());
  } else {
    s.deleteSetting('llm_api_key');
  }
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
 *  codex has no prevailing directory convention yet, so it's preset as an in-project
 *  dot directory and disabled by default; users can add custom cards when the
 *  presets don't fit. */
export const DEFAULT_WATCH_RULES: WatchRule[] = [
  {
    id: 'claude-code',
    agent: 'claude-code',
    match: '~/.claude/projects/<slug>/memory/*.md, CLAUDE.md',
    enabled: true,
    builtin: true,
  },
  { id: 'codex', agent: 'codex', match: '.codex/memory/*.md', enabled: false, builtin: true },
  {
    id: 'hermes',
    agent: 'hermes',
    match: '~/.hermes/memories/*.md',
    indexFiles: [], // MEMORY.md is hermes's memory body (§-delimited entries), not an index
    enabled: false,
    builtin: true,
  },
  { id: 'joycode', agent: 'joycode', match: '.joycode/memory/*.md', enabled: true, builtin: true },
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
