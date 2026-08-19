export class ConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ConfigError';
  }
}

export interface VisionConfig {
  apiKey: string;
  baseUrl: string;
  chatUrl: string;
  model: string;
  timeoutMs: number;
  retryCount: number;
  temperature: number;
  maxTokens: number;
  extraBody: Record<string, unknown>;
}

function parsePositiveInt(env: NodeJS.ProcessEnv, name: string, fallback: number): number {
  const raw = env[name];
  if (raw === undefined || raw === '') return fallback;
  const n = Number(raw);
  if (!Number.isInteger(n) || n <= 0) {
    throw new ConfigError(`${name} must be a positive integer, got: ${raw}`);
  }
  return n;
}

function parsePositiveFloat(env: NodeJS.ProcessEnv, name: string, fallback: number): number {
  const raw = env[name];
  if (raw === undefined || raw === '') return fallback;
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 0) {
    throw new ConfigError(`${name} must be a non-negative number, got: ${raw}`);
  }
  return n;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): VisionConfig {
  const apiKey = (env.VISION_API_KEY ?? '').trim();
  if (!apiKey || /your[_-]api[_-]key/i.test(apiKey)) {
    throw new ConfigError('VISION_API_KEY is required (set it to your real API key)');
  }

  const baseUrl = env.VISION_BASE_URL?.trim().replace(/\/+$/, '');
  if (!baseUrl) {
    throw new ConfigError(
      'VISION_BASE_URL is required (your OpenAI-compatible endpoint, e.g. https://gateway.example.com/v1)',
    );
  }

  const model = env.VISION_MODEL?.trim();
  if (!model) {
    throw new ConfigError('VISION_MODEL is required (a vision-capable model served by VISION_BASE_URL)');
  }

  let extraBody: Record<string, unknown> = {};
  const rawExtra = env.VISION_EXTRA_BODY?.trim();
  if (rawExtra) {
    try {
      const parsed: unknown = JSON.parse(rawExtra);
      if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
        throw new Error('not an object');
      }
      extraBody = parsed as Record<string, unknown>;
    } catch {
      throw new ConfigError(`VISION_EXTRA_BODY must be a JSON object, got: ${rawExtra}`);
    }
  }

  return {
    apiKey,
    baseUrl,
    chatUrl: `${baseUrl}/chat/completions`,
    model,
    timeoutMs: parsePositiveInt(env, 'VISION_TIMEOUT', 300000),
    retryCount: parsePositiveInt(env, 'VISION_RETRY_COUNT', 1),
    temperature: parsePositiveFloat(env, 'VISION_TEMPERATURE', 0.6),
    maxTokens: parsePositiveInt(env, 'VISION_MAX_TOKENS', 8192),
    extraBody,
  };
}

let cached: VisionConfig | null = null;

export function getConfig(): VisionConfig {
  if (!cached) cached = loadConfig();
  return cached;
}

/** 仅测试使用：清除单例缓存。 */
export function resetConfig(): void {
  cached = null;
}
