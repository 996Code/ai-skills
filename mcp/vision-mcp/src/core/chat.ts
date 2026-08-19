import { getConfig, type VisionConfig } from './config.js';
import { withRetry } from './retry.js';
import type { ImageContent } from './image.js';

export class ApiError extends Error {
  readonly status?: number;
  readonly retryable: boolean;

  constructor(message: string, opts: { status?: number; retryable?: boolean } = {}) {
    super(message);
    this.name = 'ApiError';
    this.status = opts.status;
    this.retryable = opts.retryable ?? false;
  }
}

function truncate(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max)}...` : text;
}

interface ChatCompletionResponse {
  choices?: Array<{ message?: { content?: unknown } }>;
}

async function postChat(config: VisionConfig, body: unknown): Promise<ChatCompletionResponse> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), config.timeoutMs);
  let res: Response;
  try {
    res = await fetch(config.chatUrl, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${config.apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
  } catch (err) {
    if (err instanceof Error && err.name === 'AbortError') {
      throw new ApiError(`Request timeout after ${config.timeoutMs}ms calling ${config.chatUrl}`);
    }
    throw new ApiError(
      `Network error calling ${config.chatUrl}: ${err instanceof Error ? err.message : String(err)}`,
      { retryable: true },
    );
  } finally {
    clearTimeout(timer);
  }

  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new ApiError(`HTTP ${res.status} from ${config.chatUrl}: ${truncate(text, 500)}`, {
      status: res.status,
      retryable: res.status === 429 || res.status >= 500,
    });
  }

  try {
    return (await res.json()) as ChatCompletionResponse;
  } catch (err) {
    throw new ApiError(`Invalid JSON response: ${err instanceof Error ? err.message : String(err)}`);
  }
}

/**
 * 单次视觉分析调用：system 提示词 + 多图 + 用户文本 → 模型文本输出。
 * 仅对网络错误与 429/5xx 重试（指数退避，基础 1s）。
 */
export async function visionChat(
  systemPrompt: string,
  userText: string,
  images: ImageContent[],
  config: VisionConfig = getConfig(),
): Promise<string> {
  const body = {
    model: config.model,
    messages: [
      { role: 'system', content: systemPrompt },
      { role: 'user', content: [...images, { type: 'text', text: userText }] },
    ],
    stream: false,
    temperature: config.temperature,
    max_tokens: config.maxTokens,
    ...config.extraBody,
  };

  const result = await withRetry(() => postChat(config, body), {
    maxRetries: config.retryCount,
    delayMs: 1000,
    shouldRetry: (err) => err instanceof ApiError && err.retryable,
  });

  const content = result?.choices?.[0]?.message?.content;
  if (typeof content !== 'string' || !content.trim()) {
    throw new ApiError('API response missing choices[0].message.content');
  }
  return content;
}
