/** MCP 服务器 IPC。 */

import { ipcMain } from 'electron';
import {
  startServer,
  stopServer,
  stopAllServers,
  callTool,
  getAllTools,
  getServerStatuses,
  refreshTools,
} from '../mcp-manager.js';

export function registerMcpIPC(): void {
  ipcMain.handle('mcp:startServer', async (_, config) => startServer(config));
  ipcMain.handle('mcp:stopServer', (_, name: string) => {
    stopServer(name);
    return { success: true };
  });
  ipcMain.handle('mcp:stopAll', () => {
    stopAllServers();
    return { success: true };
  });
  ipcMain.handle('mcp:callTool', async (_, serverName: string, toolName: string, args: Record<string, unknown>) => {
    return callTool(serverName, toolName, args);
  });
  ipcMain.handle('mcp:getTools', () => getAllTools());
  ipcMain.handle('mcp:getStatuses', () => getServerStatuses());
  ipcMain.handle('mcp:refreshTools', async (_, name: string) => refreshTools(name));
}
