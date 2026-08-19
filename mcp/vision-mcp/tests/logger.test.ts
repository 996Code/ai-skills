import { describe, it, expect, vi } from 'vitest';
import { setupConsoleRedirection } from '../src/utils/logger.js';

describe('setupConsoleRedirection', () => {
  it('routes console output to stderr, never stdout', () => {
    const stderrChunks: string[] = [];
    const origWrite = process.stderr.write;
    process.stderr.write = ((chunk: Uint8Array | string) => {
      stderrChunks.push(String(chunk));
      return true;
    }) as typeof process.stderr.write;
    const stdoutSpy = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    try {
      setupConsoleRedirection();
      console.log('hello-stdout-protection');
      console.error('boom', { a: 1 });
      expect(stderrChunks.join('')).toContain('hello-stdout-protection');
      expect(stderrChunks.join('')).toContain('boom');
      expect(stderrChunks.join('')).toContain('{"a":1}');
      expect(stdoutSpy).not.toHaveBeenCalled();
    } finally {
      process.stderr.write = origWrite;
      stdoutSpy.mockRestore();
    }
  });
});
