import { describe, it, expect, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { resolveImage, ValidationError, FileNotFoundError } from '../src/core/image.js';

// ESM 下不能 spyOn 内置模块，用 hoisted 状态 + vi.mock 控制 homedir 返回值
const homedirState = vi.hoisted(() => ({ home: '' as string }));
vi.mock('node:os', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:os')>();
  return {
    ...actual,
    homedir: () => homedirState.home || actual.homedir(),
  };
});

// 1x1 黑色 PNG（合法 PNG，仅用于本地解析逻辑测试，不会发往 API）
const PNG_B64 =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==';

function tmpFile(name: string, data: Buffer): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vision-mcp-test-'));
  const file = path.join(dir, name);
  fs.writeFileSync(file, data);
  return file;
}

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

  it('treats unrecognized bare base64 as a path and reports file-not-found', async () => {
    await expect(resolveImage('A'.repeat(200))).rejects.toThrow(FileNotFoundError);
  });

  it('reads local files into base64 data URLs', async () => {
    const file = tmpFile('x.png', Buffer.from(PNG_B64, 'base64'));
    const r = await resolveImage(file);
    expect(r.image_url.url).toBe(`data:image/png;base64,${PNG_B64}`);
  });

  it('expands ~ to homedir for local paths', async () => {
    const fakeHome = fs.mkdtempSync(path.join(os.tmpdir(), 'vision-mcp-home-'));
    fs.writeFileSync(path.join(fakeHome, 'img.png'), Buffer.from(PNG_B64, 'base64'));
    homedirState.home = fakeHome;
    try {
      const r = await resolveImage('~/img.png');
      expect(r.image_url.url).toBe(`data:image/png;base64,${PNG_B64}`);
    } finally {
      homedirState.home = '';
    }
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
    fs.truncateSync(file, 11 * 1024 * 1024); // 稀疏文件，瞬时完成
    await expect(resolveImage(file)).rejects.toThrow(/10/);
  });
});
