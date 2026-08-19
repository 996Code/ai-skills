import { describe, it, expect } from 'vitest';
import { loadConfig, ConfigError } from '../src/core/config.js';

const BASE_ENV = {
  VISION_API_KEY: 'sk-test-1234567890abcdef',
  VISION_BASE_URL: 'http://proxy.test/v1',
  VISION_MODEL: 'test-vision-model',
} as NodeJS.ProcessEnv;

describe('loadConfig', () => {
  it('applies documented defaults for optional tuning vars', () => {
    const c = loadConfig({ ...BASE_ENV });
    expect(c.apiKey).toBe('sk-test-1234567890abcdef');
    expect(c.baseUrl).toBe('http://proxy.test/v1');
    expect(c.chatUrl).toBe('http://proxy.test/v1/chat/completions');
    expect(c.model).toBe('test-vision-model');
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

  it('throws ConfigError when VISION_BASE_URL is missing', () => {
    const env = { ...BASE_ENV } as NodeJS.ProcessEnv;
    delete env.VISION_BASE_URL;
    expect(() => loadConfig(env)).toThrow(/VISION_BASE_URL/);
  });

  it('throws ConfigError when VISION_MODEL is missing', () => {
    const env = { ...BASE_ENV } as NodeJS.ProcessEnv;
    delete env.VISION_MODEL;
    expect(() => loadConfig(env)).toThrow(/VISION_MODEL/);
  });

  it('applies overrides and parses numbers and extraBody JSON', () => {
    const c = loadConfig({
      ...BASE_ENV,
      VISION_TIMEOUT: '60000',
      VISION_RETRY_COUNT: '3',
      VISION_TEMPERATURE: '0.2',
      VISION_MAX_TOKENS: '4096',
      VISION_EXTRA_BODY: '{"enable_thinking":false}',
    } as NodeJS.ProcessEnv);
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
