import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { analyzeImages, toolErrorHandler, IMAGE_SOURCE_DESC } from './shared.js';
import { DATA_VIZ_PROMPT } from '../prompts/data-viz.js';

export function registerDataVizTool(server: McpServer): void {
  server.tool(
    'analyze_data_visualization',
    `Read charts and dashboards: extract visible values, trends, comparisons, and anomalies.`,
    {
      image_source: z.string().describe(IMAGE_SOURCE_DESC),
      focus: z.string().optional().describe('What to pay attention to, e.g. "Q3 sales trend"'),
    },
    async ({ image_source, focus }) => {
      try {
        const userText = `Analyze this data visualization.${focus ? ` Focus on: ${focus}` : ''}`;
        const text = await analyzeImages(DATA_VIZ_PROMPT, [image_source], userText);
        return { content: [{ type: 'text', text }] };
      } catch (err) {
        return toolErrorHandler('analyze_data_visualization')(err);
      }
    },
  );
}
