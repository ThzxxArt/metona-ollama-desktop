/**
 * MCP Client - Model Context Protocol 客户端 (v4.3)
 * 轻量级实现：管理 MCP Server 配置，提供工具注册框架
 *
 * MCP Server 配置存储在 settings.mcp_servers 中，格式：
 * [
 *   { "name": "filesystem", "command": "npx", "args": ["-y", "@anthropic/mcp-filesystem"], "enabled": true },
 *   { "name": "sqlite", "command": "npx", "args": ["-y", "@anthropic/mcp-sqlite", "./data.db"], "enabled": false }
 * ]
 */

import { state, KEYS } from '../state/state.js';
import { logInfo, logWarn } from './log-service.js';
import type { ToolDefinition } from '../types.js';

export interface MCPServerConfig {
  name: string;
  command: string;
  args: string[];
  enabled: boolean;
  description?: string;
}

/** 获取所有 MCP 服务器配置 */
export async function getMCPServers(): Promise<MCPServerConfig[]> {
  const db = state.get<any>(KEYS.DB);
  if (!db) return [];
  try {
    return await db.getSetting('mcp_servers', []);
  } catch {
    return [];
  }
}

/** 保存 MCP 服务器配置 */
export async function saveMCPServers(servers: MCPServerConfig[]): Promise<void> {
  const db = state.get<any>(KEYS.DB);
  if (db) await db.saveSetting('mcp_servers', servers);
}

/** 添加 MCP 服务器 */
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

/** 删除 MCP 服务器 */
export async function removeMCPServer(name: string): Promise<void> {
  const servers = await getMCPServers();
  await saveMCPServers(servers.filter(s => s.name !== name));
  logInfo(`MCP Server 已删除: ${name}`);
}

/** 切换 MCP 服务器启用状态 */
export async function toggleMCPServer(name: string): Promise<boolean> {
  const servers = await getMCPServers();
  const server = servers.find(s => s.name === name);
  if (!server) return false;
  server.enabled = !server.enabled;
  await saveMCPServers(servers);
  logInfo(`MCP Server ${server.enabled ? '已启用' : '已禁用'}: ${name}`);
  return server.enabled;
}

/** 获取已启用的 MCP 服务器 */
export async function getEnabledMCPServers(): Promise<MCPServerConfig[]> {
  const servers = await getMCPServers();
  return servers.filter(s => s.enabled);
}

/**
 * 获取 MCP 工具定义（供 Agent 使用）
 * 目前返回占位工具定义，实际 MCP 协议通信需通过主进程实现
 */
export async function getMCPToolDefinitions(): Promise<ToolDefinition[]> {
  const enabled = await getEnabledMCPServers();
  // MCP 工具通过主进程的 MCP bridge 动态注册
  // 这里返回空数组，工具定义由 MCP bridge 在 IPC 层注入
  if (enabled.length > 0) {
    logInfo(`MCP: ${enabled.length} 个服务器已启用`, enabled.map(s => s.name).join(', '));
  }
  return [];
}
