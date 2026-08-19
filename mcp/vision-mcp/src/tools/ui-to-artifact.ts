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
