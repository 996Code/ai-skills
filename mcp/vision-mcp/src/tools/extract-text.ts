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
