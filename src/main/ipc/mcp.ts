/** MCP 服务器 IPC。所有通道均经过发送方校验与入参校验。 */

import { z } from 'zod';
import { handleTrusted, parseArgs } from './register.js';
import {
  startServer,
  stopServer,
  stopAllServers,
  callTool,
  getAllTools,
  getServerStatuses,
  refreshTools,
} from '../mcp-manager.js';

const mcpConfigSchema = z
  .object({
    name: z.string().min(1).max(128),
    command: z.string().min(1).max(4096),
    args: z.array(z.string().max(4096)).max(128),
    enabled: z.boolean(),
    description: z.string().max(2000).optional(),
  })
  .strict();

export function registerMcpIPC(): void {
  handleTrusted('mcp:startServer', async (_, rawConfig: unknown) => startServer(parseArgs(mcpConfigSchema, rawConfig)));
  handleTrusted('mcp:stopServer', (_, rawName: unknown) => {
    stopServer(parseArgs(z.string().min(1).max(128), rawName));
    return { success: true };
  });
  handleTrusted('mcp:stopAll', () => {
    stopAllServers();
    return { success: true };
  });
  handleTrusted('mcp:callTool', async (_, rawServerName: unknown, rawToolName: unknown, rawArgs: unknown) => {
    const serverName = parseArgs(z.string().min(1).max(128), rawServerName);
    const toolName = parseArgs(z.string().min(1).max(256), rawToolName);
    const args = parseArgs(z.record(z.string(), z.unknown()), rawArgs);
    return callTool(serverName, toolName, args);
  });
  handleTrusted('mcp:getTools', () => getAllTools());
  handleTrusted('mcp:getStatuses', () => getServerStatuses());
  handleTrusted('mcp:refreshTools', async (_, rawName: unknown) =>
    refreshTools(parseArgs(z.string().min(1).max(128), rawName)),
  );
}
