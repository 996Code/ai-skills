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
