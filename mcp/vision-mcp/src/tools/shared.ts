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
