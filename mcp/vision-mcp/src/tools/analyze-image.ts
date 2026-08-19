import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { analyzeImages, toolErrorHandler, IMAGE_SOURCE_DESC } from './shared.js';
import { ANALYZE_IMAGE_PROMPT } from '../prompts/analyze-image.js';

export function registerAnalyzeImageTool(server: McpServer): void {
  server.tool(
    'analyze_image',
    `Local-file-friendly general-purpose image recognition. Accepts LOCAL file paths, base64, data URIs,
and http(s) URLs. Prefer THIS tool over any URL-only image analysis tool (e.g. ones that reject local
paths or file:// sources) whenever the image is a local file or raw base64.
Also prefer a specialized tool when one fits (extract_text_from_screenshot, diagnose_error_screenshot,
understand_technical_diagram, analyze_data_visualization, ui_to_artifact, ui_diff_check).`,
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
