import { describe, it, expect, vi, afterEach } from 'vitest';
import { visionChat, ApiError } from '../src/core/chat.js';
import type { VisionConfig } from '../src/core/config.js';

const config: VisionConfig = {
  apiKey: 'sk-test',
  baseUrl: 'http://proxy.test/v1',
  chatUrl: 'http://proxy.test/v1/chat/completions',
  model: 'qwen3.7-plus',
  timeoutMs: 5000,
  retryCount: 1,
  temperature: 0.6,
  maxTokens: 8192,
  extraBody: {},
};

const okResponse = () =>
  new Response(JSON.stringify({ choices: [{ message: { content: 'Red' } }] }), { status: 200 });

afterEach(() => vi.unstubAllGlobals());

describe('visionChat', () => {
  it('posts a well-formed multimodal request and returns content', async () => {
    const fetchMock = vi.fn().mockResolvedValue(okResponse());
    vi.stubGlobal('fetch', fetchMock);
    const img = { type: 'image_url' as const, image_url: { url: 'data:image/png;base64,QQ==' } };
    const out = await visionChat('SYS', 'What color?', [img], config);
    expect(out).toBe('Red');
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('http://proxy.test/v1/chat/completions');
    expect((init.headers as Record<string, string>).Authorization).toBe('Bearer sk-test');
    const body = JSON.parse(init.body as string);
    expect(body.model).toBe('qwen3.7-plus');
    expect(body.stream).toBe(false);
    expect(body.temperature).toBe(0.6);
    expect(body.max_tokens).toBe(8192);
    expect(body.messages[0]).toEqual({ role: 'system', content: 'SYS' });
    expect(body.messages[1].content[0]).toEqual(img);
    expect(body.messages[1].content[1]).toEqual({ type: 'text', text: 'What color?' });
  });

  it('merges extraBody into the request body', async () => {
    const fetchMock = vi.fn().mockResolvedValue(okResponse());
    vi.stubGlobal('fetch', fetchMock);
    const cfg = { ...config, extraBody: { enable_thinking: false } };
    await visionChat('S', 'q', [], cfg);
    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(JSON.parse(init.body as string).enable_thinking).toBe(false);
  });

  it('does not retry 4xx and surfaces status text', async () => {
    const fetchMock = vi.fn().mockImplementation(() =>
      new Response('{"error":{"message":"bad param"}}', { status: 400 }),
    );
    vi.stubGlobal('fetch', fetchMock);
    await expect(visionChat('S', 'q', [], config)).rejects.toThrow(ApiError);
    await expect(visionChat('S', 'q', [], config)).rejects.toThrow(/400/);
    expect(fetchMock).toHaveBeenCalledTimes(2); // 两次断言各一次，均无重试
  });

  it('retries 500 once (retryCount=1) then succeeds', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response('boom', { status: 500 }))
      .mockResolvedValueOnce(okResponse());
    vi.stubGlobal('fetch', fetchMock);
    await expect(visionChat('S', 'q', [], { ...config, retryCount: 1 })).resolves.toBe('Red');
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('throws ApiError when content is missing', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(new Response(JSON.stringify({ choices: [{ message: {} }] }), { status: 200 })),
    );
    await expect(visionChat('S', 'q', [], config)).rejects.toThrow(/content/);
  });
});
