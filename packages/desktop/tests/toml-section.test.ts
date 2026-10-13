//! toml-section tests: the codex config.toml editor's strip/has/append semantics.

import { describe, expect, it } from 'vitest';
import { appendTomlSection, hasTomlSection, stripTomlSection } from '../src/toml-section';

describe('stripTomlSection', () => {
  it('removes the whole section at EOF, leaving earlier content intact', () => {
    const doc = '[mcp_servers]\n\n[mcp_servers.knot]\nurl = "http://x"\n';
    const out = stripTomlSection(doc, 'knot');
    expect(out).toBe('[mcp_servers]\n');
  });

  it('stops at the next section header and keeps it', () => {
    const doc = '[a]\nx = 1\n[mcp_servers.knot]\nurl = "u"\n[b]\ny = 2\n';
    const out = stripTomlSection(doc, 'knot');
    expect(out).toBe('[a]\nx = 1\n[b]\ny = 2\n');
  });

  it('matches the quoted-key form of the header too', () => {
    const doc = '[mcp_servers."knot"]\nurl = "u"\n';
    expect(stripTomlSection(doc, 'knot')).toBe('');
  });

  it('does not match a different server whose key has ours as a prefix', () => {
    const doc = '[mcp_servers.knotx]\nurl = "u"\n';
    expect(stripTomlSection(doc, 'knot')).toBe(doc);
  });

  it('is idempotent when the section is absent', () => {
    const doc = '[a]\nx = 1\n';
    expect(stripTomlSection(doc, 'knot')).toBe(doc);
  });

  it('removes the legacy key as well', () => {
    const doc = '[mcp_servers.knot-shared-memory]\ncommand = "knot"\n';
    expect(stripTomlSection(doc, 'knot-shared-memory')).toBe('');
  });
});

describe('hasTomlSection', () => {
  it('detects both key forms and rejects prefix collisions', () => {
    expect(hasTomlSection('[mcp_servers.knot]\nurl = "u"\n', 'knot')).toBe(true);
    expect(hasTomlSection('[mcp_servers."knot"]\nurl = "u"\n', 'knot')).toBe(true);
    expect(hasTomlSection('[mcp_servers.knotx]\nurl = "u"\n', 'knot')).toBe(false);
    expect(hasTomlSection('[a]\nx = 1\n', 'knot')).toBe(false);
  });
});

describe('appendTomlSection', () => {
  it('appends after existing content with one blank line', () => {
    expect(appendTomlSection('[mcp_servers]\n', 'knot', ['url = "u"'])).toBe(
      '[mcp_servers]\n\n[mcp_servers.knot]\nurl = "u"\n',
    );
  });

  it('writes a clean document when the input is empty', () => {
    expect(appendTomlSection('', 'knot', ['url = "u"'])).toBe(
      '[mcp_servers.knot]\nurl = "u"\n',
    );
  });

  it('round-trips: append → strip returns the original', () => {
    const doc = '[model]\nname = "x"\n';
    const injected = appendTomlSection(doc, 'knot', ['url = "http://x"']);
    expect(stripTomlSection(injected, 'knot')).toBe(doc);
  });
});
