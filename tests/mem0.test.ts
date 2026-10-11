import { describe, expect, it, vi } from 'vitest';
import { withTimeout } from '../electron/mem0';

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
