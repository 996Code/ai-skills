import { setupConsoleRedirection } from './utils/logger.js';
setupConsoleRedirection(); // 必须最先执行：保护 stdout 协议通道

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { getConfig } from './core/config.js';
import { registerAnalyzeImageTool } from './tools/analyze-image.js';
import { registerExtractTextTool } from './tools/extract-text.js';
import { registerDiagnoseErrorTool } from './tools/diagnose-error.js';
import { registerDiagramTool } from './tools/diagram.js';
import { registerDataVizTool } from './tools/data-viz.js';
import { registerUiToArtifactTool } from './tools/ui-to-artifact.js';
import { registerUiDiffTool } from './tools/ui-diff.js';

async function main(): Promise<void> {
  getConfig(); // 启动期配置校验：失败即退出，不进入服务态

  const server = new McpServer(
    { name: 'vision-mcp', version: '0.1.0' },
    { capabilities: { tools: {} } },
  );

  registerAnalyzeImageTool(server);
  registerExtractTextTool(server);
  registerDiagnoseErrorTool(server);
  registerDiagramTool(server);
  registerDataVizTool(server);
  registerUiToArtifactTool(server);
  registerUiDiffTool(server);

  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.info('vision-mcp started on stdio');
}

main().catch((err: unknown) => {
  console.error('Fatal:', err instanceof Error ? err.message : String(err));
  process.exit(1);
});

process.on('SIGINT', () => process.exit(0));
process.on('SIGTERM', () => process.exit(0));
process.on('uncaughtException', (err: Error) => {
  console.error('uncaughtException:', err);
  process.exit(1);
});
process.on('unhandledRejection', (reason: unknown) => {
  console.error('unhandledRejection:', reason instanceof Error ? reason.message : String(reason));
  process.exit(1);
});
