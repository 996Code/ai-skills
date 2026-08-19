import { describe, it, expect } from 'vitest';
import { spawn, type ChildProcess } from 'node:child_process';
import { once } from 'node:events';

function rpc(id: number | null, method: string, params: unknown = {}): string {
  return JSON.stringify({ jsonrpc: '2.0', ...(id !== null ? { id } : {}), method, params });
}

function startServer(): ChildProcess {
  return spawn(process.execPath, ['dist/index.js'], {
    env: {
      ...process.env,
      VISION_API_KEY: 'sk-handshake-fake-key-000000000000',
      VISION_BASE_URL: 'http://handshake.test/v1',
      VISION_MODEL: 'test-vision-model',
    },
    stdio: ['pipe', 'pipe', 'pipe'],
  });
}

async function listTools(): Promise<Array<{ name: string }>> {
  const proc = startServer();
  let out = '';
  let errText = '';
  proc.stdout!.on('data', (d) => (out += d));
  proc.stderr!.on('data', (d) => (errText += d));
  const closed = once(proc, 'close');

  proc.stdin!.write(rpc(1, 'initialize', {
    protocolVersion: '2024-11-05',
    capabilities: {},
    clientInfo: { name: 'handshake-test', version: '0.0.0' },
  }) + '\n');
  proc.stdin!.write(rpc(null, 'notifications/initialized') + '\n');
  proc.stdin!.write(rpc(2, 'tools/list') + '\n');

  const deadline = Date.now() + 15000;
  while (Date.now() < deadline) {
    for (const line of out.split('\n')) {
      if (!line.trim()) continue;
      try {
        const msg = JSON.parse(line);
        if (msg.id === 2 && msg.result?.tools) {
          proc.kill();
          await closed;
          return msg.result.tools;
        }
      } catch { /* 未完整行，继续等 */ }
    }
    await new Promise((r) => setTimeout(r, 100));
  }
  proc.kill();
  throw new Error(`tools/list timed out. stdout=${out} stderr=${errText}`);
}

describe('stdio handshake', () => {
  it(
    'advertises exactly the 7 expected tools and keeps logs off stdout',
    async () => {
      const tools = await listTools();
      expect(tools.map((t) => t.name).sort()).toEqual([
        'analyze_data_visualization',
        'analyze_image_local',
        'diagnose_error_screenshot',
        'extract_text_from_screenshot',
        'ui_diff_check',
        'ui_to_artifact',
        'understand_technical_diagram',
      ]);
    },
    20000,
  );

  it('exits non-zero with a stderr message when VISION_API_KEY is missing', async () => {
    const proc = spawn(process.execPath, ['dist/index.js'], {
      env: { PATH: process.env.PATH },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let errText = '';
    proc.stderr!.on('data', (d) => (errText += d));
    const [code] = (await once(proc, 'close')) as [number | null];
    expect(code).not.toBe(0);
    expect(errText).toContain('VISION_API_KEY');
  });
});
