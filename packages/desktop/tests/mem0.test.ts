import { describe, expect, it, vi } from 'vitest';
import { findNearDupIds, withTimeout } from '@journal/shared';

describe('withTimeout', () => {
  it('resolves with the wrapped value when fast enough', async () => {
    await expect(withTimeout(Promise.resolve(42), 1000, '测试')).resolves.toBe(42);
  });

  it('propagates the underlying rejection', async () => {
    await expect(withTimeout(Promise.reject(new Error('boom')), 1000, '测试')).rejects.toThrow('boom');
  });

  it('rejects with a labeled timeout error when the promise hangs', async () => {
    vi.useFakeTimers();
    try {
      const p = withTimeout(new Promise(() => {}), 50, 'LLM 提炼');
      const assertion = expect(p).rejects.toThrow('LLM 提炼超时');
      await vi.advanceTimersByTimeAsync(60);
      await assertion;
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('findNearDupIds', () => {
  const unit = (x: number): number[] => [x, 1 - x]; // unit vectors along distinct directions
  const near = (v: number[]): number[] => {
    const n = Math.hypot(...v) || 1;
    return v.map((x) => x / n);
  };

  it('collapses near-identical vectors onto the first (canonical) item', () => {
    const a = near([1, 0.01]);
    const b = near([1, 0.011]); // cosine ≈ 0.9999 vs a
    const c = unit(0);
    const dupOf = findNearDupIds(
      [{ id: 'a' }, { id: 'b' }, { id: 'c' }],
      new Map([
        ['a', a],
        ['b', b],
        ['c', c],
      ]),
    );
    expect(dupOf.get('b')).toBe('a');
    expect(dupOf.has('c')).toBe(false);
  });

  it('keeps items below the threshold even when they chain toward the canonical', () => {
    // c is ~0.87 from a and ~0.87 from b (b collapsed into a): no pair ≥ 0.95
    const a = [1, 0];
    const b = [Math.cos(0.5), Math.sin(0.5)];
    const c = [Math.cos(1.0), Math.sin(1.0)];
    const dupOf = findNearDupIds(
      [{ id: 'a' }, { id: 'b' }, { id: 'c' }],
      new Map([
        ['a', a],
        ['b', b],
        ['c', c],
      ]),
    );
    expect(dupOf.size).toBe(0);
  });

  it('skips items without a vector instead of throwing', () => {
    const dupOf = findNearDupIds([{ id: 'a' }, { id: 'orphan' }], new Map([['a', [1, 0]]]));
    expect(dupOf.size).toBe(0);
  });
});
