/**
 * MCP Client - Model Context Protocol 渲染端客户端
 * 管理 MCP Server 配置，通过 IPC 调用主进程进行协议通信
 */

import { state, KEYS } from '../state/state.js';
import { logInfo, logWarn, logSuccess, logError } from './log-service.js';
import type { ToolDefinition, ToolResult } from '../types.js';

export interface MCPServerConfig {
  name: string;
  command: string;
  args: string[];
  enabled: boolean;
  description?: string;
}

// ─── 配置管理 ───

export async function getMCPServers(): Promise<MCPServerConfig[]> {
  const db = state.get<any>(KEYS.DB);
  if (!db) return [];
  try {
    return await db.getSetting('mcp_servers', []);
  } catch {
    return [];
  }
}

export async function saveMCPServers(servers: MCPServerConfig[]): Promise<void> {
  const db = state.get<any>(KEYS.DB);
  if (db) await db.saveSetting('mcp_servers', servers);
}

export async function addMCPServer(config: MCPServerConfig): Promise<void> {
  const servers = await getMCPServers();
  const existing = servers.findIndex(s => s.name === config.name);
  if (existing >= 0) {
    servers[existing] = config;
  } else {
    servers.push(config);
  }
  await saveMCPServers(servers);
  logInfo(`MCP Server 已${existing >= 0 ? '更新' : '添加'}: ${config.name}`);
}

export async function removeMCPServer(name: string): Promise<void> {
  const bridge = window.metonaDesktop;
  if (bridge?.mcp) await bridge.mcp.stopServer(name);
  const servers = await getMCPServers();
  await saveMCPServers(servers.filter(s => s.name !== name));
  logInfo(`MCP Server 已删除: ${name}`);
}

export async function toggleMCPServer(name: string): Promise<boolean> {
  const servers = await getMCPServers();
  const server = servers.find(s => s.name === name);
  if (!server) return false;
  server.enabled = !server.enabled;
  await saveMCPServers(servers);
  logInfo(`MCP Server ${server.enabled ? '已启用' : '已禁用'}: ${name}`);
  return server.enabled;
}

export async function getEnabledMCPServers(): Promise<MCPServerConfig[]> {
  const servers = await getMCPServers();
  return servers.filter(s => s.enabled);
}

// ─── MCP 服务器生命周期 ───

/** 启动所有已启用的 MCP 服务器 */
export async function startAllMCPServers(): Promise<void> {
  const bridge = window.metonaDesktop;
  if (!bridge?.mcp) return;

  const configs = await getEnabledMCPServers();
  for (const config of configs) {
    try {
      const result = await bridge.mcp.startServer(config);
      if (result.success) {
        logSuccess(`MCP 服务器已启动: ${config.name}`);
      } else {
        logWarn(`MCP 服务器启动失败: ${config.name}`, result.error);
      }
    } catch (err) {
      logError(`MCP 服务器启动异常: ${config.name}`, (err as Error).message);
    }
  }
}

/** 停止所有 MCP 服务器 */
export async function stopAllMCPServers(): Promise<void> {
  const bridge = window.metonaDesktop;
  if (bridge?.mcp) await bridge.mcp.stopAll();
}

/** 获取 MCP 服务器状态 */
export async function getMCPServerStatuses(): Promise<Array<{ name: string; running: boolean; toolCount: number }>> {
  const bridge = window.metonaDesktop;
  if (!bridge?.mcp) return [];
  try {
    return await bridge.mcp.getStatuses();
  } catch {
    return [];
  }
}

// ─── 工具定义（供 Agent 使用）───

/** 从主进程获取所有 MCP 工具并转换为 ToolDefinition 格式 */
export async function getMCPToolDefinitions(): Promise<ToolDefinition[]> {
  const bridge = window.metonaDesktop;
  if (!bridge?.mcp) return [];

  try {
    const mcpTools = await bridge.mcp.getTools() as Array<{
      serverName: string;
      name: string;
      fullName: string;
      description: string;
      inputSchema: { type: string; properties?: Record<string, unknown>; required?: string[] };
    }>;

    if (mcpTools.length === 0) return [];

    logInfo(`MCP 工具已注册: ${mcpTools.length} 个`, mcpTools.map(t => t.fullName).join(', '));

    return mcpTools.map(t => ({
      type: 'function' as const,
      function: {
        name: t.fullName,
        description: t.description,
        parameters: {
          type: 'object' as const,
          required: t.inputSchema.required || [],
          properties: (t.inputSchema.properties || {}) as Record<string, { type: string; description?: string }>
        }
      }
    }));
  } catch (err) {
    logError('MCP 工具获取失败', (err as Error).message);
    return [];
  }
}

/** 执行 MCP 工具调用 */
export async function executeMCPTool(toolName: string, args: Record<string, unknown>): Promise<ToolResult> {
  const bridge = window.metonaDesktop;
  if (!bridge?.mcp) {
    return { success: false, error: 'MCP API 不可用' };
  }

  // 解析工具全名: mcp_{serverName}__{toolName}（双下划线分隔，避免 serverName/toolName 含下划线时歧义）
  const match = toolName.match(/^mcp_(.+?)__(.+)$/);
  if (!match) {
    return { success: false, error: `无效的 MCP 工具名: ${toolName}` };
  }

  const serverName = match[1];
  const actualToolName = match[2];

  try {
    const result = await bridge.mcp.callTool(serverName, actualToolName, args);
    return result;
  } catch (err) {
    return { success: false, error: (err as Error).message };
  }
}
