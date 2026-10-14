//! splitMemoryChunks: deterministic structural chunking of long memory files.
//! The contract is byte-level determinism with *edit locality* — re-import of
//! unchanged content yields identical chunks (so near-dup compaction dedupes),
//! and editing one section leaves every other chunk untouched.

import { describe, expect, it } from 'vitest';
import { splitMemoryChunks } from '@knot/shared';

const bullet = (name: string, size: number) =>
  `- ${name}: ${'内容'.repeat(Math.ceil(size / 2))}`.slice(0, size);

describe('splitMemoryChunks', () => {
  it('passes short files through untouched', () => {
    const raw = '---\nname: 短记忆\n---\n\n一句话记忆。';
    expect(splitMemoryChunks(raw)).toEqual([raw]);
    expect(splitMemoryChunks('a'.repeat(1200))).toHaveLength(1);
  });

  it('splits a long file into one chunk per top-level segment', () => {
    const raw = [
      '---',
      'name: 长文件',
      '---',
      '',
      '## 部署',
      bullet('冷部署路径', 300),
      bullet('回滚步骤', 300),
      '## 网关',
      bullet('回调前缀', 300),
      bullet('域名白名单', 300),
      bullet('限流阈值', 300),
    ].join('\n');
    const chunks = splitMemoryChunks(raw);
    expect(chunks.length).toBeGreaterThanOrEqual(4);
    // frontmatter only rides the first chunk
    expect(chunks[0]).toContain('name: 长文件');
    expect(chunks.slice(1).some((c) => c.includes('name: 长文件'))).toBe(false);
    // no content lost: every bullet appears exactly once across chunks
    for (const name of ['冷部署路径', '回滚步骤', '回调前缀', '域名白名单', '限流阈值']) {
      expect(chunks.filter((c) => c.includes(name))).toHaveLength(1);
    }
    // headings open their chunk (context travels with the items under them)
    expect(chunks.some((c) => c.startsWith('## 网关') && c.includes('回调前缀'))).toBe(true);
  });

  it('edit locality: a one-line edit changes only its own chunk', () => {
    const raw = ['---\nname: x\n---\n', ...Array.from({ length: 6 }, (_, i) => bullet(`条目${i}`, 200))].join('\n');
    const edited = raw.replace('条目2', '条目2（已修订）');
    const before = splitMemoryChunks(raw);
    const after = splitMemoryChunks(edited);
    expect(before.length).toBe(after.length);
    before.forEach((c, i) => {
      if (!c.includes('条目2')) expect(after[i]).toBe(c);
    });
    expect(after.some((c) => c.includes('条目2（已修订）'))).toBe(true);
  });

  it('keeps an unsplittable file (single oversized paragraph) whole', () => {
    const raw = '---\nname: 大段落\n---\n\n' + '很长的一段话。'.repeat(400);
    expect(splitMemoryChunks(raw)).toEqual([raw]);
  });

  it('glues sub-bullets and paragraphs onto their parent segment', () => {
    const raw = [
      '---',
      'name: 层级',
      '---',
      '',
      '- 顶层条目',
      '  - 子条目贴着父节点',
      '',
      '后续段落也属于同一块。',
      '',
      bullet('独立条目', 900),
      bullet('再一条', 300),
    ].join('\n');
    const chunks = splitMemoryChunks(raw);
    expect(chunks.some((c) => c.includes('顶层条目') && c.includes('子条目贴着父节点') && c.includes('后续段落'))).toBe(true);
    // the oversized 900-char bullet stands alone, unshredded
    expect(chunks.some((c) => c.startsWith('- 独立条目') && c.length > 800)).toBe(true);
  });
});
