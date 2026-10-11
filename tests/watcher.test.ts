//! Pure-function tests for the watcher's match-expression compilation and watch-root
//! selection. Importing electron/watcher pulls chokidar + the (heavy) mem0ai module —
//! no side effects at import time, just a slower first load.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { entryToRegex, globRoot, watchableRoot } from '../electron/watcher';

describe('entryToRegex', () => {
  it('escapes regex-special characters in literal paths', () => {
    const re = entryToRegex('/a/b(v1)+c.md')!;
    expect(re.test('/a/b(v1)+c.md')).toBe(true);
    expect(re.test('/a/bXv1Yc.md')).toBe(false);
  });

  it('single * matches within one path segment', () => {
    const re = entryToRegex('/p/memory/*.md')!;
    expect(re.test('/p/memory/a.md')).toBe(true);
    expect(re.test('/p/memory/sub/a.md')).toBe(false);
    expect(re.test('/p/memory/a.txt')).toBe(false);
  });

  it('? matches exactly one character', () => {
    const re = entryToRegex('/p/a?c.md')!;
    expect(re.test('/p/abc.md')).toBe(true);
    expect(re.test('/p/ac.md')).toBe(false);
    expect(re.test('/p/abbc.md')).toBe(false);
  });

  it('** crosses path segments', () => {
    const re = entryToRegex('/p/**/*.md')!;
    expect(re.test('/p/x.md')).toBe(true);
    expect(re.test('/p/a/b/c.md')).toBe(true);
  });

  it('a wildcard-less directory matches itself and everything beneath it', () => {
    const re = entryToRegex('/p/memory')!;
    expect(re.test('/p/memory')).toBe(true);
    expect(re.test('/p/memory/a.md')).toBe(true);
    expect(re.test('/p/other/a.md')).toBe(false);
  });

  it('treats regex-special characters as literals when they cannot be wildcards', () => {
    // [unclosed would break a naive regex, but it's escaped and matched literally
    expect(entryToRegex('/p/[unclosed')!.test('/p/[unclosed')).toBe(true);
  });
});

describe('globRoot', () => {
  it('returns the whole path when there is no wildcard', () => {
    expect(globRoot('/p/memory')).toBe('/p/memory');
  });

  it('cuts at the directory prefix before the first wildcard', () => {
    expect(globRoot('/p/memory/*.md')).toBe('/p/memory');
    expect(globRoot('/p/*/memory/a.md')).toBe('/p');
    expect(globRoot('/p/**/a.md')).toBe('/p');
  });

  it('falls back to the filesystem root when the wildcard starts the path', () => {
    expect(globRoot('*.md')).toBe(path.sep);
  });
});

describe('watchableRoot', () => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'knot-watch-'));
  const dir = path.join(base, 'existing');
  fs.mkdirSync(dir);
  const file = path.join(dir, 'a.md');
  fs.writeFileSync(file, 'x');

  it('returns an existing file as-is (file entries are watched directly)', () => {
    expect(watchableRoot(file)).toBe(file);
  });

  it('returns an existing directory as-is', () => {
    expect(watchableRoot(dir)).toBe(dir);
  });

  it('walks up one missing level so a directory created after rescan is picked up', () => {
    // <project>/memory where <project> exists — the claude-code first-run case
    expect(watchableRoot(path.join(dir, 'memory'))).toBe(dir);
  });

  it('refuses to walk up more than one missing level', () => {
    // .joycode/memory — both missing: watching the project root recursively would
    // traverse dependency trees and exhaust file descriptors
    expect(watchableRoot(path.join(dir, '.joycode', 'memory'))).toBeNull();
  });

  it('refuses the filesystem root (too broad)', () => {
    expect(watchableRoot(path.parse(base).root)).toBeNull();
  });
});
