type Level = 'log' | 'info' | 'warn' | 'error' | 'debug';

function toStderr(level: Level) {
  return (msg?: unknown, ...args: unknown[]) => {
    const parts = (args.length ? [msg, ...args] : [msg]).map((p) =>
      typeof p === 'string' ? p : JSON.stringify(p),
    );
    process.stderr.write(`[vision-mcp:${level}] ${parts.join(' ')}\n`);
  };
}

/**
 * stdio MCP server 的 stdout 是 JSON-RPC 通道，任何 console 输出都会破坏协议。
 * 必须在 index.ts 的第一行调用本函数。
 */
export function setupConsoleRedirection(): void {
  console.log = toStderr('log');
  console.info = toStderr('info');
  console.warn = toStderr('warn');
  console.error = toStderr('error');
  console.debug = toStderr('debug');
}
