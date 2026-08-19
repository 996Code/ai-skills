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
 * http(s) URL / data URI 直接透传；疑似裸 base64 时按魔数嗅探（嗅探成功才是 base64，
 * 失败则继续按本地路径处理——路径字符集与 base64 有重叠，魔数是可靠判别器）；
 * 本地路径读文件转 base64。
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

  if (s.length >= 40 && BARE_BASE64_RE.test(s)) {
    const mime = sniffMime(Buffer.from(s, 'base64'));
    if (mime) {
      return { type: 'image_url', image_url: { url: `data:${mime};base64,${s}` } };
    }
    // 魔数不匹配：不是图片 base64，按本地路径继续判断
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
