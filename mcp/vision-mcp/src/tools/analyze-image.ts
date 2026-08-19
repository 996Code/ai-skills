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
