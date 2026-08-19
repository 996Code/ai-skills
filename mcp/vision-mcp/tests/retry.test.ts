import { describe, it, expect, vi } from 'vitest';
import { withRetry } from '../src/core/retry.js';

class TransientError extends Error {}

describe('withRetry', () => {
  it('returns on first success without extra calls', async () => {
    const fn = vi.fn(async () => 'ok');
    await expect(withRetry(fn, { maxRetries: 2, delayMs: 10 })).resolves.toBe('ok');
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('retries a failure then succeeds', async () => {
    const fn = vi.fn().mockRejectedValueOnce(new TransientError('x')).mockResolvedValueOnce('ok');
    await expect(withRetry(fn, { maxRetries: 2, delayMs: 1 })).resolves.toBe('ok');
    expect(fn).toHaveBeenCalledTimes(2);
  });

  it('throws immediately when shouldRetry returns false', async () => {
    const fn = vi.fn().mockRejectedValue(new Error('fatal'));
    await expect(
      withRetry(fn, { maxRetries: 3, delayMs: 1, shouldRetry: () => false }),
    ).rejects.toThrow('fatal');
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('exhausts retries and throws the last error', async () => {
    const fn = vi.fn().mockRejectedValue(new TransientError('down'));
    await expect(withRetry(fn, { maxRetries: 2, delayMs: 1 })).rejects.toThrow('down');
    expect(fn).toHaveBeenCalledTimes(3);
  });
});
