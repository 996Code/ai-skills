# vision-mcp 实现计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 构建一个图片识别 MCP server（stdio，7 个工具），后端为 OpenAI 兼容视觉模型（默认 `qwen3.7-plus` @ `https://<你的视觉网关>/v1`）。

**Architecture:** 同构复刻 `@z_ai/mcp-server` v0.1.4 的结构：`tools/`（每工具一个注册模块）+ `prompts/`（每工具一份系统提示词）+ `core/`（config/chat/image/retry）+ `utils/logger`（console→stderr）。每个工具 = 解析图片源 → 组装多模态消息 → 调 `chat/completions` → 返回文本。

**Tech Stack:** TypeScript(ESM, NodeNext) + `@modelcontextprotocol/sdk` ^1.26.0 + `zod` ^3 + vitest。设计文档：`docs/specs/2026-08-19-vision-mcp-design.md`。

**项目根目录：** `<项目根目录>/`（下文所有相对路径基于此目录；已 git init）

**已验证事实（不要重复验证）：**
- `POST https://<你的视觉网关>/v1/chat/completions` + `Authorization: Bearer <key>`，body 为 OpenAI 多模态格式，`qwen3.7-plus` 实测能识别图片（64×64 红色 PNG 回答 "Red"）。
- 密钥从本机安全存储读取（安装阶段注入 env）。开发过程中一律用假密钥，不碰真密钥。
- 上游要求图片宽高 >10px（1×1 会被拒）。

**类型契约（全计划统一，不得改名）：**
```ts
// core/config.ts
export class ConfigError extends Error
export interface VisionConfig {
  apiKey: string; baseUrl: string; chatUrl: string; model: string;
  timeoutMs: number; retryCount: number; temperature: number; maxTokens: number;
  extraBody: Record<string, unknown>;
}
export function loadConfig(env?: NodeJS.ProcessEnv): VisionConfig
export function getConfig(): VisionConfig      // 懒加载单例
export function resetConfig(): void            // 仅测试用
// core/retry.ts
export function withRetry<T>(fn: () => Promise<T>, opts: { maxRetries: number; delayMs: number; shouldRetry?: (err: unknown) => boolean }): Promise<T>
// core/image.ts
export class FileNotFoundError extends Error
export class ValidationError extends Error
export type ImageContent = { type: 'image_url'; image_url: { url: string } }
export async function resolveImage(source: string): Promise<ImageContent>
// core/chat.ts
export class ApiError extends Error   // 字段: status?: number; retryable: boolean
export async function visionChat(systemPrompt: string, userText: string, images: ImageContent[], config?: VisionConfig): Promise<string>
// tools/shared.ts
export const IMAGE_SOURCE_DESC: string
export async function analyzeImages(systemPrompt: string, sources: string[], userText: string): Promise<string>
export function toolErrorHandler(toolName: string): (err: unknown) => { content: { type: 'text'; text: string }[]; isError: true }
// tools/*.ts
export function registerXxxTool(server: McpServer): void   // 7 个
```

---

### Task 1: 项目脚手架

**Files:**
- Create: `package.json`
- Create: `tsconfig.json`

- [ ] **Step 1: 写 package.json**

```json
{
  "name": "vision-mcp",
  "version": "0.1.0",
  "description": "Image recognition MCP server over an OpenAI-compatible vision API (default qwen3.7-plus)",
  "type": "module",
  "main": "dist/index.js",
  "bin": { "vision-mcp": "dist/index.js" },
  "engines": { "node": ">=18.0.0" },
  "scripts": {
    "build": "tsc",
    "start": "node dist/index.js",
    "test": "vitest run",
    "test:integration": "vitest run tests/integration.test.ts"
  },
  "dependencies": {
    "@modelcontextprotocol/sdk": "^1.26.0",
    "zod": "^3.23.8"
  },
  "devDependencies": {
    "@types/node": "^24.0.0",
    "typescript": "^5.9.2",
    "vitest": "^3.0.0"
  }
}
```

- [ ] **Step 2: 写 tsconfig.json**

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "lib": ["ES2022", "DOM", "DOM.Iterable"],
    "module": "NodeNext",
    "moduleResolution": "NodeNext",
    "outDir": "dist",
    "rootDir": "src",
    "strict": true,
    "esModuleInterop": true,
    "skipLibCheck": true,
    "forceConsistentCasingInFileNames": true
  },
  "include": ["src/**/*"]
}
```

- [ ] **Step 3: 安装依赖**

Run: `npm install`
Expected: 生成 `node_modules/` 与 `package-lock.json`，退出码 0。

- [ ] **Step 4: 提交**

```bash
git add package.json package-lock.json tsconfig.json
git commit -m "chore: project scaffold (TS NodeNext, MCP SDK, zod, vitest)"
```

---

### Task 2: logger — console 重定向到 stderr

**Files:**
- Create: `src/utils/logger.ts`
- Test: `tests/logger.test.ts`

- [ ] **Step 1: 写失败测试**

```ts
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
```

- [ ] **Step 2: 运行确认失败**

Run: `npx vitest run tests/logger.test.ts`
Expected: FAIL（无法解析 `../src/utils/logger.js` 模块）。

- [ ] **Step 3: 写实现**

```ts
type Level = 'log' | 'info' | 'warn' | 'error' | 'debug';

function toStderr(level: Level) {
  return (msg?: unknown, ...args: unknown[]) => {
    const parts = (args.length ? [msg, ...args] : [msg]).map((p) =>
      typeof p === 'string' ? p : JSON.stringify(p),
    );
    process.stderr.write(`[vision-mcp:${level}] ${parts.join(' ')}\n`);
  };
}

/**
 * stdio MCP server 的 stdout 是 JSON-RPC 通道，任何 console 输出都会破坏协议。
 * 必须在 index.ts 的第一行调用本函数。
 */
export function setupConsoleRedirection(): void {
  console.log = toStderr('log');
  console.info = toStderr('info');
  console.warn = toStderr('warn');
  console.error = toStderr('error');
  console.debug = toStderr('debug');
}
```

- [ ] **Step 4: 运行确认通过**

Run: `npx vitest run tests/logger.test.ts`
Expected: PASS 1 test。

- [ ] **Step 5: 提交**

```bash
git add src/utils/logger.ts tests/logger.test.ts
git commit -m "feat: redirect all console output to stderr to protect stdio protocol"
```

---

### Task 3: retry — 指数退避重试

**Files:**
- Create: `src/core/retry.ts`
- Test: `tests/retry.test.ts`

- [ ] **Step 1: 写失败测试**

```ts
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
```

- [ ] **Step 2: 运行确认失败**

Run: `npx vitest run tests/retry.test.ts`
Expected: FAIL（模块不存在）。

- [ ] **Step 3: 写实现**

```ts
export interface RetryOptions {
  maxRetries: number; // 额外重试次数（总尝试 = 1 + maxRetries）
  delayMs: number;    // 基础延迟，指数退避
  shouldRetry?: (err: unknown) => boolean;
}

export async function withRetry<T>(fn: () => Promise<T>, opts: RetryOptions): Promise<T> {
  const { maxRetries, delayMs, shouldRetry = () => true } = opts;
  let lastError: unknown;
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      return await fn();
    } catch (err) {
      lastError = err;
      if (attempt === maxRetries || !shouldRetry(err)) throw err;
      await new Promise((r) => setTimeout(r, delayMs * Math.pow(2, attempt)));
    }
  }
  throw lastError;
}
```

- [ ] **Step 4: 运行确认通过**

Run: `npx vitest run tests/retry.test.ts`
Expected: PASS 4 tests。

- [ ] **Step 5: 提交**

```bash
git add src/core/retry.ts tests/retry.test.ts
git commit -m "feat: withRetry with exponential backoff and retry predicate"
```

---

### Task 4: config — 环境变量配置

**Files:**
- Create: `src/core/config.ts`
- Test: `tests/config.test.ts`

- [ ] **Step 1: 写失败测试**

```ts
import { describe, it, expect } from 'vitest';
import { loadConfig, ConfigError } from '../src/core/config.js';

const BASE_ENV = { VISION_API_KEY: 'sk-test-1234567890abcdef' } as NodeJS.ProcessEnv;

describe('loadConfig', () => {
  it('applies documented defaults', () => {
    const c = loadConfig({ ...BASE_ENV });
    expect(c.apiKey).toBe('sk-test-1234567890abcdef');
    expect(c.baseUrl).toBe('https://<你的视觉网关>/v1');
    expect(c.chatUrl).toBe('https://<你的视觉网关>/v1/chat/completions');
    expect(c.model).toBe('qwen3.7-plus');
    expect(c.timeoutMs).toBe(300000);
    expect(c.retryCount).toBe(1);
    expect(c.temperature).toBe(0.6);
    expect(c.maxTokens).toBe(8192);
    expect(c.extraBody).toEqual({});
  });

  it('throws ConfigError when VISION_API_KEY is missing', () => {
    expect(() => loadConfig({} as NodeJS.ProcessEnv)).toThrow(ConfigError);
    expect(() => loadConfig({} as NodeJS.ProcessEnv)).toThrow(/VISION_API_KEY/);
  });

  it('throws ConfigError on placeholder keys', () => {
    expect(() => loadConfig({ VISION_API_KEY: 'your_api_key' } as NodeJS.ProcessEnv)).toThrow(/VISION_API_KEY/);
  });

  it('applies overrides and parses numbers and extraBody JSON', () => {
    const c = loadConfig({
      ...BASE_ENV,
      VISION_MODEL: 'glm-4.6v',
      VISION_TIMEOUT: '60000',
      VISION_RETRY_COUNT: '3',
      VISION_TEMPERATURE: '0.2',
      VISION_MAX_TOKENS: '4096',
      VISION_EXTRA_BODY: '{"enable_thinking":false}',
    } as NodeJS.ProcessEnv);
    expect(c.model).toBe('glm-4.6v');
    expect(c.timeoutMs).toBe(60000);
    expect(c.retryCount).toBe(3);
    expect(c.temperature).toBe(0.2);
    expect(c.maxTokens).toBe(4096);
    expect(c.extraBody).toEqual({ enable_thinking: false });
  });

  it('throws ConfigError on invalid VISION_EXTRA_BODY JSON', () => {
    expect(() => loadConfig({ ...BASE_ENV, VISION_EXTRA_BODY: '{oops' } as NodeJS.ProcessEnv)).toThrow(/VISION_EXTRA_BODY/);
  });

  it('throws ConfigError on non-numeric VISION_TIMEOUT', () => {
    expect(() => loadConfig({ ...BASE_ENV, VISION_TIMEOUT: 'abc' } as NodeJS.ProcessEnv)).toThrow(/VISION_TIMEOUT/);
  });

  it('normalizes trailing slashes in VISION_BASE_URL', () => {
    const c = loadConfig({ ...BASE_ENV, VISION_BASE_URL: 'http://x.example/v1//' } as NodeJS.ProcessEnv);
    expect(c.chatUrl).toBe('http://x.example/v1/chat/completions');
  });
});
```

- [ ] **Step 2: 运行确认失败**

Run: `npx vitest run tests/config.test.ts`
Expected: FAIL（模块不存在）。

- [ ] **Step 3: 写实现**

```ts
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

const DEFAULT_BASE_URL = 'https://<你的视觉网关>/v1';
const DEFAULT_MODEL = 'qwen3.7-plus';

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

  const baseUrl = (env.VISION_BASE_URL?.trim() || DEFAULT_BASE_URL).replace(/\/+$/, '');

  return {
    apiKey,
    baseUrl,
    chatUrl: `${baseUrl}/chat/completions`,
    model: env.VISION_MODEL?.trim() || DEFAULT_MODEL,
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
```

- [ ] **Step 4: 运行确认通过**

Run: `npx vitest run tests/config.test.ts`
Expected: PASS 7 tests。

- [ ] **Step 5: 提交**

```bash
git add src/core/config.ts tests/config.test.ts
git commit -m "feat: env-driven config with defaults for qwen3.7-plus proxy backend"
```

---

### Task 5: image — 四种图片源归一化

**Files:**
- Create: `src/core/image.ts`
- Test: `tests/image.test.ts`

- [ ] **Step 1: 写失败测试**

```ts
import { describe, it, expect, vi, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { resolveImage, ValidationError, FileNotFoundError } from '../src/core/image.js';

// 1x1 黑色 PNG（合法 PNG，仅用于本地解析逻辑测试，不会发往 API）
const PNG_B64 =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==';

function tmpFile(name: string, data: Buffer): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vision-mcp-test-'));
  const file = path.join(dir, name);
  fs.writeFileSync(file, data);
  return file;
}

afterEach(() => vi.restoreAllMocks());

describe('resolveImage', () => {
  it('passes http(s) URLs through untouched', async () => {
    const r = await resolveImage('https://example.com/a.png');
    expect(r).toEqual({ type: 'image_url', image_url: { url: 'https://example.com/a.png' } });
  });

  it('passes valid data URIs through', async () => {
    const uri = `data:image/png;base64,${PNG_B64}`;
    expect((await resolveImage(uri)).image_url.url).toBe(uri);
  });

  it('rejects non-image data URIs', async () => {
    await expect(resolveImage('data:text/plain;base64,SGVsbG8=')).rejects.toThrow(ValidationError);
  });

  it('wraps bare base64 PNG with sniffed mime', async () => {
    const r = await resolveImage(PNG_B64);
    expect(r.image_url.url).toBe(`data:image/png;base64,${PNG_B64}`);
  });

  it('sniffs JPEG magic on bare base64', async () => {
    const buf = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(120)]);
    const r = await resolveImage(buf.toString('base64'));
    expect(r.image_url.url).toMatch(/^data:image\/jpeg;base64,/);
  });

  it('rejects bare base64 that is not a known image format', async () => {
    await expect(resolveImage('A'.repeat(200))).rejects.toThrow(ValidationError);
  });

  it('reads local files into base64 data URLs', async () => {
    const file = tmpFile('x.png', Buffer.from(PNG_B64, 'base64'));
    const r = await resolveImage(file);
    expect(r.image_url.url).toBe(`data:image/png;base64,${PNG_B64}`);
  });

  it('expands ~ to homedir for local paths', async () => {
    const fakeHome = fs.mkdtempSync(path.join(os.tmpdir(), 'vision-mcp-home-'));
    fs.writeFileSync(path.join(fakeHome, 'img.png'), Buffer.from(PNG_B64, 'base64'));
    vi.spyOn(os, 'homedir').mockReturnValue(fakeHome);
    const r = await resolveImage('~/img.png');
    expect(r.image_url.url).toBe(`data:image/png;base64,${PNG_B64}`);
  });

  it('throws FileNotFoundError for missing files', async () => {
    await expect(resolveImage('/nonexistent/dir/img.png')).rejects.toThrow(FileNotFoundError);
  });

  it('rejects unsupported extensions', async () => {
    const file = tmpFile('x.txt', Buffer.from('hello'));
    await expect(resolveImage(file)).rejects.toThrow(ValidationError);
  });

  it('rejects files over 10MB', async () => {
    const file = tmpFile('big.png', Buffer.from(PNG_B64, 'base64'));
    vi.spyOn(fs, 'statSync').mockReturnValue({ size: 11 * 1024 * 1024, isFile: () => true } as fs.Stats);
    await expect(resolveImage(file)).rejects.toThrow(/10/);
  });
});
```

- [ ] **Step 2: 运行确认失败**

Run: `npx vitest run tests/image.test.ts`
Expected: FAIL（模块不存在）。

- [ ] **Step 3: 写实现**

```ts
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

export class FileNotFoundError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'FileNotFoundError';
  }
}

export class ValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ValidationError';
  }
}

export type ImageContent = { type: 'image_url'; image_url: { url: string } };

const MAX_BYTES = 10 * 1024 * 1024;
const ALLOWED_EXT: Record<string, string> = {
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.png': 'image/png',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
};
const BARE_BASE64_RE = /^[A-Za-z0-9+/]+={0,2}$/;

function sniffMime(buf: Buffer): string | null {
  if (buf.length >= 4 && buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47) {
    return 'image/png';
  }
  if (buf.length >= 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) {
    return 'image/jpeg';
  }
  if (
    buf.length >= 12 &&
    buf.toString('ascii', 0, 4) === 'RIFF' &&
    buf.toString('ascii', 8, 12) === 'WEBP'
  ) {
    return 'image/webp';
  }
  if (buf.length >= 6 && ['GIF87a', 'GIF89a'].includes(buf.toString('ascii', 0, 6))) {
    return 'image/gif';
  }
  return null;
}

/**
 * 归一化四种图片源为 OpenAI 多模态 image_url content：
 * http(s) URL / data URI 直接透传；裸 base64 按魔数嗅探；本地路径读文件转 base64。
 */
export async function resolveImage(source: string): Promise<ImageContent> {
  const s = source.trim();

  if (/^https?:\/\//i.test(s)) {
    return { type: 'image_url', image_url: { url: s } };
  }

  if (s.startsWith('data:')) {
    if (!/^data:image\/[a-z+.-]+;base64,/i.test(s)) {
      throw new ValidationError(`Unsupported data URI (expect data:image/*;base64,...): ${s.slice(0, 60)}`);
    }
    return { type: 'image_url', image_url: { url: s } };
  }

  if (s.length > 100 && BARE_BASE64_RE.test(s)) {
    const mime = sniffMime(Buffer.from(s, 'base64'));
    if (!mime) {
      throw new ValidationError('Bare base64 is not a recognized image format (PNG/JPEG/WebP/GIF)');
    }
    return { type: 'image_url', image_url: { url: `data:${mime};base64,${s}` } };
  }

  // 本地路径
  const resolved = s.startsWith('~/') ? path.join(os.homedir(), s.slice(2)) : s;
  let stats: fs.Stats;
  try {
    stats = fs.statSync(resolved);
  } catch {
    throw new FileNotFoundError(`Image file not found: ${resolved}`);
  }
  if (!stats.isFile()) {
    throw new ValidationError(`Image source is not a regular file: ${resolved}`);
  }
  if (stats.size > MAX_BYTES) {
    throw new ValidationError(
      `Image file too large: ${(stats.size / 1024 / 1024).toFixed(2)}MB (max 10MB)`,
    );
  }
  const ext = path.extname(resolved).toLowerCase();
  const mime = ALLOWED_EXT[ext];
  if (!mime) {
    throw new ValidationError(
      `Unsupported image extension: ${ext || '(none)'}. Allowed: ${Object.keys(ALLOWED_EXT).join(', ')}`,
    );
  }
  const b64 = fs.readFileSync(resolved).toString('base64');
  return { type: 'image_url', image_url: { url: `data:${mime};base64,${b64}` } };
}
```

- [ ] **Step 4: 运行确认通过**

Run: `npx vitest run tests/image.test.ts`
Expected: PASS 11 tests。

- [ ] **Step 5: 提交**

```bash
git add src/core/image.ts tests/image.test.ts
git commit -m "feat: normalize URL/data-URI/bare-base64/local-path image sources"
```

---

### Task 6: chat — OpenAI 兼容视觉调用

**Files:**
- Create: `src/core/chat.ts`
- Test: `tests/chat.test.ts`

- [ ] **Step 1: 写失败测试**

```ts
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
```

- [ ] **Step 2: 运行确认失败**

Run: `npx vitest run tests/chat.test.ts`
Expected: FAIL（模块不存在）。

- [ ] **Step 3: 写实现**

```ts
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
```

- [ ] **Step 4: 运行确认通过**

Run: `npx vitest run tests/chat.test.ts`
Expected: PASS 5 tests（其中 500 重试用例约耗时 1s，为退避延迟，正常）。

- [ ] **Step 5: 提交**

```bash
git add src/core/chat.ts tests/chat.test.ts
git commit -m "feat: visionChat over OpenAI-compatible chat/completions with timeout+retry"
```

---

### Task 7: prompts — 7 份系统提示词

**Files:**
- Create: `src/prompts/analyze-image.ts`, `src/prompts/extract-text.ts`, `src/prompts/diagnose-error.ts`, `src/prompts/diagram.ts`, `src/prompts/data-viz.ts`, `src/prompts/ui-to-artifact.ts`, `src/prompts/ui-diff.ts`, `src/prompts/index.ts`

无单测（纯常量）；Task 8 编译 + Task 9 握手测试覆盖。

- [ ] **Step 1: 写 7 个提示词文件**

`src/prompts/analyze-image.ts`:

```ts
export const ANALYZE_IMAGE_PROMPT = `You are an expert image recognition assistant with comprehensive visual understanding.

<task>
Analyze the provided image according to the user's specific request and deliver an accurate, useful answer. This is a general-purpose tool: let the user's request, not a fixed template, drive your focus.
</task>

<approach>
First scan the whole image: objects, people, text, symbols, layout, and context. Then follow the user's request precisely: describe what is asked, answer questions directly, extract what is requested. Report only what you can actually observe; mark unclear things as uncertain instead of guessing. Distinguish direct observation from inference. Add brief context when it helps.
</approach>

<output_format>
Respond in the language of the user's request. Lead with the direct answer, then supporting detail in short markdown sections or bullet lists. Never invent details that are not visible.
</output_format>`;
```

`src/prompts/extract-text.ts`:

```ts
export const EXTRACT_TEXT_PROMPT = `You are a precise OCR specialist.

<task>
Transcribe ALL text visible in the provided image, verbatim and completely: code, terminal output, UI labels, documents, handwriting, scene text.
</task>

<approach>
Work systematically: top-to-bottom, left-to-right within regions. Preserve line breaks, indentation, and layout structure so the output can be diffed against the original. For code and terminal output keep exact spacing and punctuation. Do NOT translate, correct, summarize, or embellish. Mark unreadable fragments as [illegible] and uncertain reads with [?] rather than guessing. If a context hint is given, use it only to pick formatting (e.g. code fences), never to alter the text.
</approach>

<output_format>
Output only the transcription. Use fenced code blocks for code/terminal content. At the end add a line "NOTE:" only if regions were illegible or truncated, explaining which.
</output_format>`;
```

`src/prompts/diagnose-error.ts`:

```ts
export const DIAGNOSE_ERROR_PROMPT = `You are a senior debugging assistant who reads error evidence from screenshots.

<task>
Extract and interpret the error shown in the image (error dialog, stack trace, log output, failed test, crash screen) and recommend concrete fixes.
</task>
<approach>
1. Transcribe the key error text exactly (message, error code/type, file paths, line numbers, top stack frames).
2. Identify the failing component and interpret what the error means technically.
3. Rank the most likely root causes, using any user-provided context if present.
4. Give specific, actionable fixes: commands to run, code or config changes, docs to check. Flag what needs information not present in the screenshot.
</approach>
<output_format>
Markdown with sections: "## Error" (verbatim key text), "## Interpretation", "## Likely Causes" (ranked), "## Suggested Fixes" (numbered, actionable).
</output_format>`;
```

`src/prompts/diagram.ts`:

```ts
export const UNDERSTAND_DIAGRAM_PROMPT = `You are a technical diagram interpreter for software and system diagrams.

<task>
Decode the provided diagram (architecture, flowchart, sequence, UML class/state, ER, network topology, org chart) into the output format the user requests.
</task>
<approach>
Identify the diagram type first. Then extract every node with its label/kind, every edge with its label and direction, groupings/boundaries, and the overall data or control flow. Resolve ambiguous arrows using direction and labels. Do not invent nodes or connections; mark uncertain edges as such.
</approach>
<output_format>
- structured: markdown hierarchy listing diagram type, nodes (with kind), edges (A -> B : label), and a short prose explanation of the overall flow.
- mermaid: a single valid mermaid code block (flowchart/sequenceDiagram/erDiagram/classDiagram as appropriate) reproducing the diagram, then a 2-3 sentence summary.
- description: fluent prose describing structure and flow.
Always use the language of the user's request.
</output_format>`;
```

`src/prompts/data-viz.ts`:

```ts
export const DATA_VIZ_PROMPT = `You are a data analyst who reads charts and dashboards precisely.

<task>
Read the provided visualization (bar/line/pie charts, dashboards, KPI cards, heatmaps, tables-as-images) and report what it shows: values, trends, comparisons, anomalies.
</task>
<approach>
Identify chart type, axes, units, scales, legends, and time range first. Then extract concrete numbers: key point values, peaks, troughs, shares, and comparisons. Call out trends, outliers, and anything inconsistent (e.g. truncated axes). If a focus is specified, prioritize it but still report headline numbers. Estimate values from pixel position when exact labels are absent, and mark them as approximate.
</approach>
<output_format>
Markdown sections: "## Chart" (type/axes/units/range), "## Key Values" (bullet list with numbers), "## Trends & Anomalies", "## Notes" (data quality caveats). Use the user's language.
</output_format>`;
```

`src/prompts/ui-to-artifact.ts`:

```ts
export const UI_TO_ARTIFACT_PROMPT = `You are a senior UI engineer converting screenshots into artifacts.

<task>
Convert the provided UI screenshot into the artifact type the user requests: frontend code, a detailed description, or a design spec.
</task>
<approach>
Scan systematically: overall layout and grid, then each region (header, nav, sidebar, content, cards, forms, footer), noting text, icons, images, colors, spacing, alignment, and interactive elements (buttons, inputs, toggles). Capture responsive hints from the layout. Be pixel-faithful; do not redesign or omit elements.
</approach>
<output_format>
- code: one self-contained file. Default: HTML + Tailwind CSS via CDN. If a framework is specified, use it with inline styles or its canonical styling. Use real text from the screenshot; placeholder images via https://placehold.co. Output ONLY the code block.
- description: structured natural-language description covering layout, every component, text content, and visual style.
- design_spec: design tokens: color palette (hex), typography (family/size/weight per role), spacing scale, border radius, component inventory with states.
Use the user's language except inside code.
</output_format>`;
```

`src/prompts/ui-diff.ts`:

```ts
export const UI_DIFF_PROMPT = `You are a meticulous visual QA reviewer comparing two UI screenshots.

<task>
The FIRST image is the reference/expected UI; the SECOND is the candidate/actual implementation. Report every meaningful visual difference and judge whether the candidate matches the requirements.
</task>
<approach>
Compare region by region in the same order: overall layout and alignment, then header/nav, sidebars, content areas, individual components, text content and typography, colors, spacing, images/icons, and interactive element states. Also catch missing or extra elements. Ignore trivial anti-aliasing and sub-pixel shifts. If requirements are provided, evaluate each requirement explicitly.
</approach>
<output_format>
Markdown: "## Verdict" (match / minor differences / significant differences, one line), then a differences table with columns: Location | Reference | Candidate | Severity (high/medium/low). Then "## Requirements Check" if requirements were given, and "## Notes" for anything ambiguous. Use the user's language.
</output_format>`;
```

- [ ] **Step 2: 写汇总文件 `src/prompts/index.ts`**

```ts
export { ANALYZE_IMAGE_PROMPT } from './analyze-image.js';
export { EXTRACT_TEXT_PROMPT } from './extract-text.js';
export { DIAGNOSE_ERROR_PROMPT } from './diagnose-error.js';
export { UNDERSTAND_DIAGRAM_PROMPT } from './diagram.js';
export { DATA_VIZ_PROMPT } from './data-viz.js';
export { UI_TO_ARTIFACT_PROMPT } from './ui-to-artifact.js';
export { UI_DIFF_PROMPT } from './ui-diff.js';
```

- [ ] **Step 3: 类型检查**

Run: `npx tsc --noEmit`
Expected: 无输出，退出码 0。

- [ ] **Step 4: 提交**

```bash
git add src/prompts/
git commit -m "feat: system prompts for the 7 image tools"
```

---

### Task 8: tools — 共享助手 + 7 个工具注册

**Files:**
- Create: `src/tools/shared.ts`
- Create: `src/tools/analyze-image.ts`, `src/tools/extract-text.ts`, `src/tools/diagnose-error.ts`, `src/tools/diagram.ts`, `src/tools/data-viz.ts`, `src/tools/ui-to-artifact.ts`, `src/tools/ui-diff.ts`

- [ ] **Step 1: 写 `src/tools/shared.ts`**（对应官方的 base-image-service 职责）

```ts
import { z } from 'zod';
import { resolveImage, FileNotFoundError, ValidationError, type ImageContent } from '../core/image.js';
import { visionChat, ApiError } from '../core/chat.js';
import { ConfigError } from '../core/config.js';

export const IMAGE_SOURCE_DESC =
  'Image source: local file path, http(s) URL, data URI, or bare base64';

export async function analyzeImages(
  systemPrompt: string,
  sources: string[],
  userText: string,
): Promise<string> {
  const images: ImageContent[] = [];
  for (const source of sources) {
    images.push(await resolveImage(source));
  }
  return visionChat(systemPrompt, userText, images);
}

export function toolErrorHandler(toolName: string) {
  return (err: unknown): { content: [{ type: 'text'; text: string }]; isError: true } => {
    let msg: string;
    if (err instanceof z.ZodError) {
      msg = `Validation failed: ${err.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ')}`;
    } else if (err instanceof FileNotFoundError) {
      msg = `Image file not found: ${err.message}`;
    } else if (err instanceof ValidationError) {
      msg = `Invalid image source: ${err.message}`;
    } else if (err instanceof ConfigError) {
      msg = `Config error: ${err.message}`;
    } else if (err instanceof ApiError) {
      msg = `API error: ${err.message}`;
    } else {
      msg = `Unexpected error in ${toolName}: ${err instanceof Error ? err.message : String(err)}`;
    }
    console.error(`Tool ${toolName} failed: ${msg}`);
    return { content: [{ type: 'text', text: `Error: ${msg}` }], isError: true };
  };
}
```

- [ ] **Step 2: 写 7 个工具文件**

`src/tools/analyze-image.ts`:

```ts
import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { analyzeImages, toolErrorHandler, IMAGE_SOURCE_DESC } from './shared.js';
import { ANALYZE_IMAGE_PROMPT } from '../prompts/analyze-image.js';

export function registerAnalyzeImageTool(server: McpServer): void {
  server.tool(
    'analyze_image',
    `General-purpose image recognition for any visual content. Prefer a specialized tool when one fits
(extract_text_from_screenshot, diagnose_error_screenshot, understand_technical_diagram,
analyze_data_visualization, ui_to_artifact, ui_diff_check); use this as the fallback.`,
    {
      image_source: z.string().describe(IMAGE_SOURCE_DESC),
      prompt: z.string().describe('What to analyze, extract, or understand from the image. Be specific.'),
    },
    async ({ image_source, prompt }) => {
      try {
        const text = await analyzeImages(ANALYZE_IMAGE_PROMPT, [image_source], prompt);
        return { content: [{ type: 'text', text }] };
      } catch (err) {
        return toolErrorHandler('analyze_image')(err);
      }
    },
  );
}
```

`src/tools/extract-text.ts`:

```ts
import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { analyzeImages, toolErrorHandler, IMAGE_SOURCE_DESC } from './shared.js';
import { EXTRACT_TEXT_PROMPT } from '../prompts/extract-text.js';

export function registerExtractTextTool(server: McpServer): void {
  server.tool(
    'extract_text_from_screenshot',
    `OCR: extract all visible text from screenshots of code, terminal output, documents, or scenes,
preserving layout and formatting. Verbatim transcription, no translation.`,
    {
      image_source: z.string().describe(IMAGE_SOURCE_DESC),
      context_hint: z.string().optional().describe('Hint about content: code, terminal output, document, scene text'),
    },
    async ({ image_source, context_hint }) => {
      try {
        const userText = `Extract all text from this image.${context_hint ? ` Context hint: ${context_hint}` : ''}`;
        const text = await analyzeImages(EXTRACT_TEXT_PROMPT, [image_source], userText);
        return { content: [{ type: 'text', text }] };
      } catch (err) {
        return toolErrorHandler('extract_text_from_screenshot')(err);
      }
    },
  );
}
```

`src/tools/diagnose-error.ts`:

```ts
import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { analyzeImages, toolErrorHandler, IMAGE_SOURCE_DESC } from './shared.js';
import { DIAGNOSE_ERROR_PROMPT } from '../prompts/diagnose-error.js';

export function registerDiagnoseErrorTool(server: McpServer): void {
  server.tool(
    'diagnose_error_screenshot',
    `Parse a screenshot of an error dialog, stack trace, or failing log; explain what went wrong and
suggest concrete fixes.`,
    {
      image_source: z.string().describe(IMAGE_SOURCE_DESC),
      context: z.string().optional().describe('What you were doing when the error occurred, environment info, etc.'),
    },
    async ({ image_source, context }) => {
      try {
        const userText = `Diagnose the error shown in this screenshot.${context ? ` Additional context: ${context}` : ''}`;
        const text = await analyzeImages(DIAGNOSE_ERROR_PROMPT, [image_source], userText);
        return { content: [{ type: 'text', text }] };
      } catch (err) {
        return toolErrorHandler('diagnose_error_screenshot')(err);
      }
    },
  );
}
```

`src/tools/diagram.ts`:

```ts
import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { analyzeImages, toolErrorHandler, IMAGE_SOURCE_DESC } from './shared.js';
import { UNDERSTAND_DIAGRAM_PROMPT } from '../prompts/diagram.js';

export function registerDiagramTool(server: McpServer): void {
  server.tool(
    'understand_technical_diagram',
    `Structured interpretation of technical diagrams: architecture, flowcharts, sequence, UML, ER.
Can output a structured breakdown, a Mermaid rendering, or a description.`,
    {
      image_source: z.string().describe(IMAGE_SOURCE_DESC),
      output_format: z.enum(['structured', 'mermaid', 'description']).optional()
        .describe('Output style (default: structured)'),
    },
    async ({ image_source, output_format }) => {
      try {
        const fmt = output_format ?? 'structured';
        const text = await analyzeImages(UNDERSTAND_DIAGRAM_PROMPT, [image_source], `Interpret this technical diagram. Requested output format: ${fmt}.`);
        return { content: [{ type: 'text', text }] };
      } catch (err) {
        return toolErrorHandler('understand_technical_diagram')(err);
      }
    },
  );
}
```

`src/tools/data-viz.ts`:

```ts
import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { analyzeImages, toolErrorHandler, IMAGE_SOURCE_DESC } from './shared.js';
import { DATA_VIZ_PROMPT } from '../prompts/data-viz.js';

export function registerDataVizTool(server: McpServer): void {
  server.tool(
    'analyze_data_visualization',
    `Read charts and dashboards: extract visible values, trends, comparisons, and anomalies.`,
    {
      image_source: z.string().describe(IMAGE_SOURCE_DESC),
      focus: z.string().optional().describe('What to pay attention to, e.g. "Q3 sales trend"'),
    },
    async ({ image_source, focus }) => {
      try {
        const userText = `Analyze this data visualization.${focus ? ` Focus on: ${focus}` : ''}`;
        const text = await analyzeImages(DATA_VIZ_PROMPT, [image_source], userText);
        return { content: [{ type: 'text', text }] };
      } catch (err) {
        return toolErrorHandler('analyze_data_visualization')(err);
      }
    },
  );
}
```

`src/tools/ui-to-artifact.ts`:

```ts
import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { analyzeImages, toolErrorHandler, IMAGE_SOURCE_DESC } from './shared.js';
import { UI_TO_ARTIFACT_PROMPT } from '../prompts/ui-to-artifact.js';

export function registerUiToArtifactTool(server: McpServer): void {
  server.tool(
    'ui_to_artifact',
    `Convert a UI screenshot into frontend code, a detailed description, or a design spec.`,
    {
      image_source: z.string().describe(IMAGE_SOURCE_DESC),
      output_type: z.enum(['code', 'description', 'design_spec']).describe('What to produce from the screenshot'),
      framework: z.string().optional().describe('Target framework for output_type=code, e.g. "React + Tailwind"'),
    },
    async ({ image_source, output_type, framework }) => {
      try {
        const parts = [`Convert this UI screenshot. Output type: ${output_type}.`];
        if (framework) parts.push(`Target framework: ${framework}.`);
        const text = await analyzeImages(UI_TO_ARTIFACT_PROMPT, [image_source], parts.join(' '));
        return { content: [{ type: 'text', text }] };
      } catch (err) {
        return toolErrorHandler('ui_to_artifact')(err);
      }
    },
  );
}
```

`src/tools/ui-diff.ts`:

```ts
import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { analyzeImages, toolErrorHandler, IMAGE_SOURCE_DESC } from './shared.js';
import { UI_DIFF_PROMPT } from '../prompts/ui-diff.js';

export function registerUiDiffTool(server: McpServer): void {
  server.tool(
    'ui_diff_check',
    `Compare two UI screenshots (reference vs candidate) and report visual differences and
implementation deviations.`,
    {
      image_source_1: z.string().describe(`${IMAGE_SOURCE_DESC} (reference / expected)`),
      image_source_2: z.string().describe(`${IMAGE_SOURCE_DESC} (candidate / actual)`),
      requirements: z.string().optional().describe('Checklist or spec the candidate should satisfy'),
    },
    async ({ image_source_1, image_source_2, requirements }) => {
      try {
        const userText = `Compare these two UI screenshots: the first is the reference, the second is the candidate.${requirements ? ` Requirements: ${requirements}` : ''}`;
        const text = await analyzeImages(UI_DIFF_PROMPT, [image_source_1, image_source_2], userText);
        return { content: [{ type: 'text', text }] };
      } catch (err) {
        return toolErrorHandler('ui_diff_check')(err);
      }
    },
  );
}
```

- [ ] **Step 3: 类型检查与构建**

Run: `npx tsc --noEmit && npm run build`
Expected: 均退出码 0（暂无入口文件，`npm run build` 输出 `dist/` 下各 `.js`）。

- [ ] **Step 4: 提交**

```bash
git add src/tools/
git commit -m "feat: 7 image tools with zod schemas and shared analysis/error path"
```

---

### Task 9: index.ts 入口 + stdio 握手测试

**Files:**
- Create: `src/index.ts`
- Test: `tests/handshake.test.ts`

- [ ] **Step 1: 写 `src/index.ts`**

```ts
import { setupConsoleRedirection } from './utils/logger.js';
setupConsoleRedirection(); // 必须最先执行：保护 stdout 协议通道

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { getConfig } from './core/config.js';
import { registerAnalyzeImageTool } from './tools/analyze-image.js';
import { registerExtractTextTool } from './tools/extract-text.js';
import { registerDiagnoseErrorTool } from './tools/diagnose-error.js';
import { registerDiagramTool } from './tools/diagram.js';
import { registerDataVizTool } from './tools/data-viz.js';
import { registerUiToArtifactTool } from './tools/ui-to-artifact.js';
import { registerUiDiffTool } from './tools/ui-diff.js';

async function main(): Promise<void> {
  getConfig(); // 启动期配置校验：失败即退出，不进入服务态

  const server = new McpServer(
    { name: 'vision-mcp', version: '0.1.0' },
    { capabilities: { tools: {} } },
  );

  registerAnalyzeImageTool(server);
  registerExtractTextTool(server);
  registerDiagnoseErrorTool(server);
  registerDiagramTool(server);
  registerDataVizTool(server);
  registerUiToArtifactTool(server);
  registerUiDiffTool(server);

  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.info('vision-mcp started on stdio');
}

main().catch((err: unknown) => {
  console.error('Fatal:', err instanceof Error ? err.message : String(err));
  process.exit(1);
});

process.on('SIGINT', () => process.exit(0));
process.on('SIGTERM', () => process.exit(0));
process.on('uncaughtException', (err: Error) => {
  console.error('uncaughtException:', err);
  process.exit(1);
});
process.on('unhandledRejection', (reason: unknown) => {
  console.error('unhandledRejection:', reason instanceof Error ? reason.message : String(reason));
  process.exit(1);
});
```

- [ ] **Step 2: 写握手测试 `tests/handshake.test.ts`**

```ts
import { describe, it, expect } from 'vitest';
import { spawn, type ChildProcess } from 'node:child_process';
import { once } from 'node:events';

function rpc(id: number | null, method: string, params: unknown = {}): string {
  return JSON.stringify({ jsonrpc: '2.0', ...(id !== null ? { id } : {}), method, params });
}

function startServer(): ChildProcess {
  return spawn(process.execPath, ['dist/index.js'], {
    env: { ...process.env, VISION_API_KEY: 'sk-handshake-fake-key-000000000000' },
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
        'analyze_image',
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
```

注：第一个用例只断言工具名清单；stdout/stderr 协议纯度已由 logger 单测覆盖，这里不重复断言 stderr 文本。

- [ ] **Step 3: 构建并运行测试**

Run: `npm run build && npx vitest run tests/handshake.test.ts`
Expected: PASS 2 tests。

- [ ] **Step 4: 全量单测回归**

Run: `npm test`
Expected: 全部 PASS（logger 1 + retry 4 + config 7 + image 11 + chat 5 + handshake 2 = 30 tests；integration 用例默认 skip）。

- [ ] **Step 5: 提交**

```bash
git add src/index.ts tests/handshake.test.ts
git commit -m "feat: server entry with eager config validation and stdio transport"
```

---

### Task 10: 集成测试（真实后端）

**Files:**
- Test: `tests/integration.test.ts`

- [ ] **Step 1: 写集成测试**

```ts
import { describe, it, expect } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { analyzeImages } from '../src/tools/shared.js';
import { ANALYZE_IMAGE_PROMPT } from '../src/prompts/index.js';

// 64x64 纯红 PNG（满足上游 >10px 的限制）
const RED_PNG_B64 =
  'iVBORw0KGgoAAAANSUhEUgAAAEAAAABACAIAAAAlC+aJAAAAb0lEQVR4nO3PAQkAAAyEwO9feoshgnABdLep8QUNyPEFDcjxBQ3I8QUNyPEFDcjxBQ3I8QUNyPEFDcjxBQ3I8QUNyPEFDcjxBQ3I8QUNyPEFDcjxBQ3I8QUNyPEFDcjxBQ3I8QUNyPEFDcjxBQ3IPanc8OLDQitxAAAAAElFTkSuQmCC';

const RUN = process.env.VITEST_INTEGRATION === '1' && !!process.env.VISION_API_KEY;

describe.skipIf(!RUN)('integration: real qwen3.7-plus vision', () => {
  it(
    'analyzes a local image file',
    async () => {
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vision-mcp-it-'));
      const file = path.join(dir, 'red.png');
      fs.writeFileSync(file, Buffer.from(RED_PNG_B64, 'base64'));
      const out = await analyzeImages(
        ANALYZE_IMAGE_PROMPT,
        [file],
        'What is the dominant color of this image? Answer with a single word.',
      );
      console.info('local-file output:', out.slice(0, 200));
      expect(/red/i.test(out)).toBe(true);
    },
    120000,
  );

  it(
    'analyzes bare base64 input',
    async () => {
      const out = await analyzeImages(
        ANALYZE_IMAGE_PROMPT,
        [RED_PNG_B64],
        'What is the dominant color of this image? Answer with a single word.',
      );
      console.info('base64 output:', out.slice(0, 200));
      expect(/red/i.test(out)).toBe(true);
    },
    120000,
  );
});
```

- [ ] **Step 2: 构建后用真实密钥运行**

Run:
```bash
npm run build && VITEST_INTEGRATION=1 VISION_API_KEY=$(python3 -c "
import json
print(os.environ['VISION_API_KEY'])  # 从你的安全存储注入
") npx vitest run tests/integration.test.ts
```
Expected: PASS 2 tests（输出包含 "Red" 判定通过）。注意密钥只进子进程环境变量，不落文件、不进对话。

- [ ] **Step 3: 提交**

```bash
git add tests/integration.test.ts
git commit -m "test: integration cases against real qwen3.7-plus backend (env-gated)"
```

---

### Task 11: README 与 ZCode 注册

**Files:**
- Create: `README.md`
- Create: `~/.zcode/workspace/default/.mcp.json`（工作区根，gitignore 外、不入 vision-mcp 仓库）

- [ ] **Step 1: 写 `README.md`**

````markdown
# vision-mcp

图片识别 MCP server。参照智谱官方 `@z_ai/mcp-server` 的架构实现，后端为任意
OpenAI 兼容视觉模型接口（默认 `qwen3.7-plus`）。

## 工具

| 工具 | 用途 |
|---|---|
| `analyze_image` | 通用图片识别（兜底） |
| `extract_text_from_screenshot` | OCR 文字提取（代码/终端/文档/场景） |
| `diagnose_error_screenshot` | 报错截图诊断 + 修复建议 |
| `understand_technical_diagram` | 架构图/流程图/UML/ER 解析（structured/mermaid/description） |
| `analyze_data_visualization` | 图表/仪表盘读数、趋势、异常 |
| `ui_to_artifact` | UI 截图转 code/description/design_spec |
| `ui_diff_check` | 双 UI 截图对比找差异 |

所有 `image_source` 参数支持：本地文件路径（≤10MB，jpg/jpeg/png/webp/gif，支持 `~`）、
http(s) URL、data URI、裸 base64（自动嗅探 PNG/JPEG/WebP/GIF）。

## 配置（环境变量）

| 变量 | 默认值 | 说明 |
|---|---|---|
| `VISION_API_KEY` | 必填 | API 密钥 |
| `VISION_BASE_URL` | `https://<你的视觉网关>/v1` | OpenAI 兼容端点（含 `/v1`） |
| `VISION_MODEL` | `qwen3.7-plus` | 必须是视觉模型 |
| `VISION_TIMEOUT` | `300000` | 请求超时（毫秒） |
| `VISION_RETRY_COUNT` | `1` | 额外重试次数（仅网络错误/429/5xx） |
| `VISION_TEMPERATURE` | `0.6` | 采样温度 |
| `VISION_MAX_TOKENS` | `8192` | 最大输出 token |
| `VISION_EXTRA_BODY` | 空 | JSON 对象，合并进请求体（如 `{"enable_thinking":false}`） |

## 构建与测试

```bash
npm install
npm run build
npm test                                  # 单测 + 握手（不触网）
VITEST_INTEGRATION=1 VISION_API_KEY=... npm run test:integration   # 真实后端
```

## 在 ZCode / Claude 系客户端注册

工作区根放 `.mcp.json`：

```json
{
  "mcpServers": {
    "vision-mcp": {
      "type": "stdio",
      "command": "node",
      "args": ["<项目根目录>/dist/index.js"],
      "env": { "VISION_API_KEY": "你的密钥" }
    }
  }
}
```

## 故障排查

- 工具报 `API error: HTTP 401`：密钥错误；`HTTP 404`：`VISION_BASE_URL` 不对（须含 `/v1`）。
- 换模型：`VISION_MODEL` 设为端点上的其他视觉模型。
- 关闭/开启思考等厂商参数：`VISION_EXTRA_BODY` 传 JSON。
- 本地图片须 >10px（上游限制），≤10MB。
````

- [ ] **Step 2: 写工作区 `.mcp.json`（密钥从本机配置注入，不进对话）**

Run:
```bash
python3 - <<'EOF'
import json, os
key = os.environ['VISION_API_KEY']  # 从你的安全存储注入
ws = os.path.expanduser('~/.zcode/workspace/default/.mcp.json')
cfg = json.load(open(ws)) if os.path.exists(ws) else {}
cfg.setdefault('mcpServers', {})['vision-mcp'] = {
    'type': 'stdio',
    'command': 'node',
    'args': [os.path.expanduser('~/.zcode/workspace/default/vision-mcp/dist/index.js')],
    'env': {'VISION_API_KEY': key},
}
json.dump(cfg, open(ws, 'w'), indent=2, ensure_ascii=False)
print('written:', ws)
EOF
```
Expected: 输出 `written: <工作区>/.mcp.json`。

- [ ] **Step 3: 提交 README**

```bash
git add README.md
git commit -m "docs: README with tools, config, registration and troubleshooting"
```

---

### Task 12: 用户验收（UAT）

无代码。逐项与用户确认：

- [ ] 重启 ZCode 会话（或新开任务），确认 `vision-mcp` 出现在 MCP 列表且 7 个工具可见。若 `.mcp.json` 未被识别，改经 ZCode 设置界面添加 Task 11 Step 2 的同款配置。
- [ ] 在会话中对一张本地截图调用 `analyze_image` 与 `extract_text_from_screenshot`，确认返回合理中文结果。
- [ ] 对一张远程 URL 图片调用 `analyze_image`，确认 URL 路径可用。
- [ ] `git log --oneline` 检查提交历史完整。

---

## Self-Review 记录

- 规格覆盖：设计文档 §5 架构（Task 1-9）、§6 配置（Task 4）、§7 图片源（Task 5）、§8 工具集（Task 7-8）、§9 API 层（Task 6）、§10 日志错误（Task 2/8/9）、§11 测试（Task 2-6/9/10）、§12 安装（Task 11/12）—— 全覆盖；§13 明确不在本期。
- 类型契约：`withRetry/resolveImage/visionChat/analyzeImages/toolErrorHandler` 签名在 Task 3/5/6/8 定义，后续使用处一致。
- 占位符扫描：无 TBD/TODO；所有代码步骤含完整代码。
