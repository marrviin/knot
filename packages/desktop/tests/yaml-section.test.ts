//! yaml-section tests: the hermes config.yaml editor's upsert/remove semantics.

import { describe, expect, it } from 'vitest';
import {
  hasYamlMappingEntry,
  removeYamlMappingEntry,
  upsertYamlMappingEntry,
} from '../src/yaml-section';

describe('upsertYamlMappingEntry', () => {
  it('creates the root mapping on an empty document', () => {
    expect(upsertYamlMappingEntry('', 'mcp_servers', 'journal', ['url: "u"'])).toBe(
      'mcp_servers:\n  journal:\n    url: "u"\n',
    );
  });

  it('appends the root mapping after existing content', () => {
    const doc = 'provider: openai\nmodel: gpt\n';
    const out = upsertYamlMappingEntry(doc, 'mcp_servers', 'journal', ['url: "u"']);
    expect(out).toBe(
      'provider: openai\nmodel: gpt\n\nmcp_servers:\n  journal:\n    url: "u"\n',
    );
  });

  it('inserts into an existing empty mapping before the next top-level key', () => {
    const doc = 'mcp_servers:\nprovider: openai\n';
    const out = upsertYamlMappingEntry(doc, 'mcp_servers', 'journal', ['url: "u"']);
    expect(out).toBe('mcp_servers:\n  journal:\n    url: "u"\nprovider: openai\n');
  });

  it('inserts into an existing populated mapping, keeping siblings and comments', () => {
    const doc = [
      '# config',
      'provider: openai',
      'mcp_servers:',
      '  # filesystem server',
      '  filesystem:',
      '    command: "npx"',
      'provider2: x',
      '',
    ].join('\n');
    const out = upsertYamlMappingEntry(doc, 'mcp_servers', 'journal', ['url: "u"']);
    expect(out).toContain('  journal:\n    url: "u"');
    expect(out).toContain('# filesystem server');
    expect(out).toContain('command: "npx"');
    expect(out.trimEnd().endsWith('provider2: x')).toBe(true);
  });

  it('replaces an existing journal entry in place, keeping its siblings', () => {
    const doc = [
      'mcp_servers:',
      '  journal:',
      '    url: "old"',
      '    extra: 1',
      '  filesystem:',
      '    command: "npx"',
    ].join('\n');
    const out = upsertYamlMappingEntry(doc, 'mcp_servers', 'journal', ['url: "new"']);
    expect(out).toBe(
      'mcp_servers:\n  journal:\n    url: "new"\n  filesystem:\n    command: "npx"',
    );
    expect(out).not.toContain('old');
    expect(out).not.toContain('extra');
  });

  it('throws on a flow-style root value instead of mangling it', () => {
    expect(() =>
      upsertYamlMappingEntry('mcp_servers: {github: {command: npx}}\n', 'mcp_servers', 'journal', ['url: "u"']),
    ).toThrow();
  });

  it('does not confuse a same-named deeper key with the entry', () => {
    const doc = [
      'mcp_servers:',
      '  group:',
      '    journal:',
      '      url: "nested"',
      '  other: 1',
    ].join('\n');
    const out = upsertYamlMappingEntry(doc, 'mcp_servers', 'journal', ['url: "u"']);
    expect(out).toContain('    journal:\n      url: "nested"');
    expect(out).toContain('  journal:\n    url: "u"');
  });
});

describe('hasYamlMappingEntry', () => {
  it('detects the entry and ignores a same-named deeper key', () => {
    const doc = 'mcp_servers:\n  journal:\n    url: "u"\n';
    expect(hasYamlMappingEntry(doc, 'mcp_servers', 'journal')).toBe(true);
    expect(hasYamlMappingEntry('mcp_servers:\n  group:\n    journal: 1\n', 'mcp_servers', 'journal')).toBe(false);
    expect(hasYamlMappingEntry('provider: openai\n', 'mcp_servers', 'journal')).toBe(false);
  });
});

describe('removeYamlMappingEntry', () => {
  it('removes the entry and its children, keeping siblings', () => {
    const doc = [
      'mcp_servers:',
      '  journal:',
      '    url: "u"',
      '  filesystem:',
      '    command: "npx"',
    ].join('\n');
    const out = removeYamlMappingEntry(doc, 'mcp_servers', 'journal');
    expect(out).toBe('mcp_servers:\n  filesystem:\n    command: "npx"');
  });

  it('is idempotent when the entry or root mapping is absent', () => {
    const doc = 'mcp_servers:\n  other: 1\n';
    expect(removeYamlMappingEntry(doc, 'mcp_servers', 'journal')).toBe(doc);
    expect(removeYamlMappingEntry('provider: x\n', 'mcp_servers', 'journal')).toBe('provider: x\n');
  });

  it('round-trips: upsert → remove returns the original block structure', () => {
    const doc = 'mcp_servers:\n  filesystem:\n    command: "npx"\n';
    const injected = upsertYamlMappingEntry(doc, 'mcp_servers', 'journal', ['url: "u"']);
    const out = removeYamlMappingEntry(injected, 'mcp_servers', 'journal');
    expect(out).toBe('mcp_servers:\n  filesystem:\n    command: "npx"\n');
  });
});
