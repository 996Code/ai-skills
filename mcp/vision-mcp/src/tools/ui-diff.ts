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
