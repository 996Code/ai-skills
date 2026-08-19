import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { analyzeImages, toolErrorHandler, IMAGE_SOURCE_DESC } from './shared.js';
import { UNDERSTAND_DIAGRAM_PROMPT } from '../prompts/diagram.js';

export function registerDiagramTool(server: McpServer): void {
  server.tool(
    'understand_technical_diagram',
    `Structured interpretation of technical diagrams: architecture, flowcharts, sequence, UML, ER.
Can output a structured breakdown, a Mermaid rendering, or a description.`,
    {
      image_source: z.string().describe(IMAGE_SOURCE_DESC),
      output_format: z.enum(['structured', 'mermaid', 'description']).optional()
        .describe('Output style (default: structured)'),
    },
    async ({ image_source, output_format }) => {
      try {
        const fmt = output_format ?? 'structured';
        const text = await analyzeImages(
          UNDERSTAND_DIAGRAM_PROMPT,
          [image_source],
          `Interpret this technical diagram. Requested output format: ${fmt}.`,
        );
        return { content: [{ type: 'text', text }] };
      } catch (err) {
        return toolErrorHandler('understand_technical_diagram')(err);
      }
    },
  );
}
