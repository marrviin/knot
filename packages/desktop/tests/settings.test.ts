//! settings tests use an in-memory fake of the store module's kv surface
//! (settings.ts takes the store as a parameter — a clean seam for this).

import { beforeEach, describe, expect, it } from 'vitest';
import * as settings from '../src/settings';

function fakeStore() {
  const map = new Map<string, string>();
  return {
    map,
    getSetting: (k: string) => map.get(k) ?? null,
    setSetting: (k: string, v: string) => void map.set(k, v),
    deleteSetting: (k: string) => void map.delete(k),
  } as any; // settings.ts only needs the kv surface of the store module
}

describe('settings.save (API key three-state semantics)', () => {
  let s: ReturnType<typeof fakeStore>;

  beforeEach(() => {
    s = fakeStore();
    s.setSetting('llm_api_key', 'old-key');
  });

  it('null keeps the stored key (field untouched)', () => {
    settings.save(s, 'http://x', null, 'm');
    expect(s.getSetting('llm_api_key')).toBe('old-key');
  });

  it("'' explicitly clears the key", () => {
    settings.save(s, 'http://x', '', 'm');
    expect(s.getSetting('llm_api_key')).toBeNull();
  });

  it('a non-empty value replaces the key', () => {
    settings.save(s, 'http://x', 'new-key', 'm');
    expect(s.getSetting('llm_api_key')).toBe('new-key');
  });

  it('empty baseUrl/model fall back to the openai defaults', () => {
    settings.save(s, '', null, '');
    expect(s.getSetting('llm_base_url')).toBe('https://api.openai.com/v1');
    expect(s.getSetting('llm_model')).toBe('gpt-5-mini');
    // Embedding is not a stored setting anymore — it's always the bundled model.
    expect(s.getSetting('llm_embed_model')).toBeNull();
  });
});

describe('llm config', () => {
  let s: ReturnType<typeof fakeStore>;

  beforeEach(() => {
    s = fakeStore();
  });

  it('defaults to zero-config on a fresh install (no provider field anymore)', () => {
    const cfg = settings.load(s);
    // The old protocol split is gone — LlmSettings carries no provider field.
    expect((cfg as { provider?: unknown }).provider).toBeUndefined();
    // Embeddings always run on the bundled local model — no key needed.
    expect(settings.isConfigured(cfg)).toBe(true);
  });

  it('ignores a legacy stored provider setting (pre-protocol-removal installs)', () => {
    s.setSetting('llm_provider', 'minimax');
    const cfg = settings.load(s);
    expect((cfg as { provider?: unknown }).provider).toBeUndefined();
  });

  it('round-trips a custom base url and model', () => {
    settings.save(s, 'https://api.siliconflow.cn/v1', 'sk-x', 'Qwen/Qwen3-32B');
    const cfg = settings.load(s);
    expect(cfg.baseUrl).toBe('https://api.siliconflow.cn/v1');
    expect(cfg.model).toBe('Qwen/Qwen3-32B');
  });

  it('local mode is always configured, even with no key (embeddings are bundled)', () => {
    // No API key anywhere in the store — the memory layer must still be usable.
    settings.save(s, 'https://api.siliconflow.cn/v1', '', 'Qwen/Qwen3-32B');
    expect(settings.isConfigured(settings.load(s))).toBe(true);
  });
});

describe('loadWatchRules', () => {
  let s: ReturnType<typeof fakeStore>;

  beforeEach(() => {
    s = fakeStore();
  });

  it('returns builtin defaults when nothing is stored', () => {
    const rules = settings.loadWatchRules(s);
    expect(rules.map((r) => r.id)).toEqual(['claude-code', 'codex', 'hermes', 'joycode', 'workbuddy']);
  });

  it('keeps user toggles for builtin cards but forces their match/agent to the preset', () => {
    s.setSetting(
      'watch_rules',
      JSON.stringify([{ id: 'claude-code', agent: 'hacked', match: '/evil/*', enabled: false, builtin: true }]),
    );
    const rules = settings.loadWatchRules(s);
    const cc = rules.find((r) => r.id === 'claude-code')!;
    expect(cc.enabled).toBe(false); // user-owned
    expect(cc.match).toBe('~/.claude/projects/<slug>/memory/*.md, CLAUDE.md'); // app-owned
    expect(cc.agent).toBe('claude-code');
  });

  it('auto-restores missing builtin cards', () => {
    s.setSetting('watch_rules', JSON.stringify([]));
    expect(settings.loadWatchRules(s)).toHaveLength(5);
  });

  it('drops builtin ids that left the preset list (legacy myagent)', () => {
    s.setSetting(
      'watch_rules',
      JSON.stringify([{ id: 'myagent', agent: 'myagent', match: '/x/*', enabled: true, builtin: true }]),
    );
    expect(settings.loadWatchRules(s).map((r) => r.id)).not.toContain('myagent');
  });

  it('migrates legacy path+pattern entries into match expressions', () => {
    s.setSetting(
      'watch_rules',
      JSON.stringify([{ id: 'c1', agent: 'cursor', path: '/proj/.cursor', pattern: '*.md', enabled: true }]),
    );
    const [c1] = settings.loadWatchRules(s).filter((r) => r.id === 'c1');
    expect(c1!.match).toBe('/proj/.cursor/*.md');
  });

  it('preserves a custom rule with an empty match (a card mid-edit must not vanish)', () => {
    s.setSetting(
      'watch_rules',
      JSON.stringify([{ id: 'c1', agent: 'cursor', match: '', enabled: true }]),
    );
    expect(settings.loadWatchRules(s).some((r) => r.id === 'c1')).toBe(true);
  });

  it('backs up corrupted stored JSON before falling back to defaults', () => {
    s.setSetting('watch_rules', '{not json');
    const rules = settings.loadWatchRules(s);
    expect(rules).toHaveLength(5); // builtin defaults
    expect(s.getSetting('watch_rules_corrupt_backup')).toBe('{not json');
  });
});

describe('saveWatchRules', () => {
  let s: ReturnType<typeof fakeStore>;

  beforeEach(() => {
    s = fakeStore();
  });

  it('keeps empty-match rules instead of silently deleting cards mid-edit', () => {
    const saved = settings.saveWatchRules(s, [
      { id: 'c1', agent: 'cursor', match: '', enabled: true },
      { id: 'c2', agent: 'windsurf', match: '.windsurf/*.md', enabled: true },
    ]);
    expect(saved).toHaveLength(2);
    expect(settings.loadWatchRules(s).some((r) => r.id === 'c1')).toBe(true);
  });

  it('generates an id when missing and trims match/agent', () => {
    const [r] = settings.saveWatchRules(s, [{ agent: ' cursor ', match: '  .cursor/*.md  ', enabled: false } as any]);
    expect(r.id).toMatch(/^watch-\d+-/);
    expect(r.agent).toBe('cursor');
    expect(r.match).toBe('.cursor/*.md');
    expect(r.enabled).toBe(false);
  });

  it('round-trips indexFiles overrides', () => {
    settings.saveWatchRules(s, [{ id: 'h', agent: 'hermes', match: '~/.hermes/*.md', enabled: true, indexFiles: [] }]);
    expect(settings.loadWatchRules(s).find((r) => r.id === 'h')!.indexFiles).toEqual([]);
  });
});
