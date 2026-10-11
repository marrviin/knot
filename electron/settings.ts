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
  if (apiKey && apiKey.trim()) s.setSetting('llm_api_key', apiKey.trim());
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
}

/** Default cards for common local agents (codex/hermes have no prevailing directory
 *  convention yet, so they're preset as in-project dot directories and disabled by
 *  default; users can add custom cards when the presets don't fit) */
export const DEFAULT_WATCH_RULES: WatchRule[] = [
  {
    id: 'claude-code',
    agent: 'claude-code',
    match: '~/.claude/projects/<slug>/memory/*.md, CLAUDE.md',
    enabled: true,
    builtin: true,
  },
  { id: 'codex', agent: 'codex', match: '.codex/memory/*.md', enabled: false, builtin: true },
  { id: 'hermes', agent: 'hermes', match: '.hermes/memory/*.md', enabled: false, builtin: true },
  { id: 'joycode', agent: 'joycode', match: '.joycode/memory/*.md', enabled: true, builtin: true },
];

const WATCH_KEY = 'watch_rules';

/** Load watch rules: converts legacy data (path+pattern) into match expressions; auto-restores missing builtin cards */
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
          };
        })
        .filter((r) => r.match);
    } catch {
      rules = []; // On corrupted data, run with builtin defaults only; never overwrite what the user stored
    }
  }
  const presetIds = new Set(DEFAULT_WATCH_RULES.map((r) => r.id));
  const have = new Set(rules.map((r) => r.id));
  for (const preset of DEFAULT_WATCH_RULES) {
    if (!have.has(preset.id)) rules.push({ ...preset });
  }
  // Builtin cards are managed by the app version: ones whose id left the preset list (e.g. legacy myagent) are dropped too
  return rules.filter((r) => !r.builtin || presetIds.has(r.id));
}

export function saveWatchRules(s: typeof store, rules: WatchRule[]): WatchRule[] {
  const cleaned = (Array.isArray(rules) ? rules : [])
    .filter((r) => r && typeof r.match === 'string' && r.match.trim())
    .map((r) => ({
      id: typeof r.id === 'string' && r.id ? r.id : `watch-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      agent: (r.agent ?? '').trim() || 'custom',
      match: r.match.trim(),
      enabled: r.enabled !== false,
      builtin: !!r.builtin,
    }));
  s.setSetting(WATCH_KEY, JSON.stringify(cleaned));
  return cleaned;
}
