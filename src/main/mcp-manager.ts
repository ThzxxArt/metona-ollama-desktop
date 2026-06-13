/**
 * MCP Manager - Model Context Protocol 主进程管理器
 * 通过 stdio JSON-RPC 2.0 与 MCP Server 通信
 */

import { spawn, ChildProcess } from 'child_process';
import * as path from 'path';
import * as fs from 'fs';
import { mainWindow } from './main.js';

function sendLog(level: 'info' | 'success' | 'warn' | 'error', message: string, detail?: string): void {
  mainWindow?.webContents.send('main:log', { level, message, detail });
}

// ─── 类型定义 ───

interface JSONRPCRequest {
  jsonrpc: '2.0';
  id: number;
  method: string;
  params?: Record<string, unknown>;
}

interface JSONRPCResponse {
  jsonrpc: '2.0';
  id: number;
  result?: unknown;
  error?: { code: number; message: string; data?: unknown };
}

interface MCPTool {
  name: string;
  description?: string;
  inputSchema: {
    type: string;
    properties?: Record<string, unknown>;
    required?: string[];
  };
}

interface MCPServerInstance {
  config: { name: string; command: string; args: string[]; enabled: boolean; description?: string };
  process: ChildProcess;
  requestId: number;
  pendingRequests: Map<number, { resolve: (value: unknown) => void; reject: (reason: Error) => void; timer: ReturnType<typeof setTimeout> }>;
  buffer: string;
  tools: MCPTool[];
  initialized: boolean;
  capabilities: Record<string, unknown>;
}

// ─── 状态 ───

const servers = new Map<string, MCPServerInstance>();
/** MCP 请求超时（毫秒），默认 60s，可通过 IPC 设置 */
let MCP_TIMEOUT = 60_000;

/** 设置 MCP 请求超时（毫秒） */
export function setMCPTimeout(ms: number): void {
  MCP_TIMEOUT = Math.max(10_000, ms);
}

// ─── JSON-RPC 通信 ───

function sendRequest(server: MCPServerInstance, method: string, params?: Record<string, unknown>): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const id = ++server.requestId;
    const request: JSONRPCRequest = { jsonrpc: '2.0', id, method, params };

    const timer = setTimeout(() => {
      server.pendingRequests.delete(id);
      reject(new Error(`MCP 请求超时: ${server.config.name} / ${method} (${MCP_TIMEOUT}ms)`));
    }, MCP_TIMEOUT);

    server.pendingRequests.set(id, { resolve, reject, timer });

    const line = JSON.stringify(request) + '\n';
    try {
      server.process.stdin!.write(line);
    } catch (err) {
      server.pendingRequests.delete(id);
      clearTimeout(timer);
      reject(new Error(`MCP 写入失败: ${(err as Error).message}`));
    }
  });
}

function handleResponse(server: MCPServerInstance, response: JSONRPCResponse): void {
  const pending = server.pendingRequests.get(response.id);
  if (!pending) return;

  clearTimeout(pending.timer);
  server.pendingRequests.delete(response.id);

  if (response.error) {
    pending.reject(new Error(`MCP 错误 [${response.error.code}]: ${response.error.message}`));
  } else {
    pending.resolve(response.result);
  }
}

function processData(server: MCPServerInstance, data: Buffer): void {
  server.buffer += data.toString('utf-8');
  const lines = server.buffer.split('\n');
  server.buffer = lines.pop() || '';

  for (const line of lines) {
    if (!line.trim()) continue;
    try {
      const msg = JSON.parse(line);
      if (msg.id !== undefined && (msg.result !== undefined || msg.error !== undefined)) {
        handleResponse(server, msg as JSONRPCResponse);
      }
      // 忽略通知（无 id 的消息）
    } catch {
      // 非 JSON 行，忽略（有些 server 会输出启动日志）
    }
  }
}

// ─── 服务器生命周期 ───

export async function startServer(config: { name: string; command: string; args: string[]; enabled: boolean; description?: string }): Promise<{ success: boolean; error?: string }> {
  // 已在运行则先停止
  if (servers.has(config.name)) {
    stopServer(config.name);
  }

  sendLog('info', `🔌 MCP 启动: ${config.name}`, `${config.command} ${config.args.join(' ')}`);

  try {
    const proc = spawn(config.command, config.args, {
      stdio: ['pipe', 'pipe', 'pipe'],
      env: { ...process.env },
      cwd: process.cwd()
    });

    const server: MCPServerInstance = {
      config,
      process: proc,
      requestId: 0,
      pendingRequests: new Map(),
      buffer: '',
      tools: [],
      initialized: false,
      capabilities: {}
    };

    servers.set(config.name, server);

    proc.stdout.on('data', (data: Buffer) => processData(server, data));

    proc.stderr.on('data', (data: Buffer) => {
      const msg = data.toString('utf-8').trim();
      if (msg) sendLog('info', `🔌 MCP [${config.name}] stderr`, msg.slice(0, 200));
    });

    proc.on('close', (code) => {
      sendLog(code === 0 ? 'info' : 'warn', `🔌 MCP 关闭: ${config.name}`, `exit code: ${code}`);
      cleanupServer(server);
      servers.delete(config.name);
    });

    proc.on('error', (err) => {
      sendLog('error', `🔌 MCP 启动失败: ${config.name}`, err.message);
      cleanupServer(server);
      servers.delete(config.name);
    });

    // MCP initialize 握手
    try {
      const initResult = await sendRequest(server, 'initialize', {
        protocolVersion: '2024-11-05',
        capabilities: { tools: {} },
        clientInfo: { name: 'Metona Ollama', version: '5.0.0' }
      }) as Record<string, unknown>;

      server.capabilities = (initResult.capabilities as Record<string, unknown>) || {};
      server.initialized = true;

      // 发送 initialized 通知
      const notification = JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) + '\n';
      server.process.stdin!.write(notification);

      sendLog('success', `🔌 MCP 已连接: ${config.name}`, `协议 ${(initResult.protocolVersion as string) || 'unknown'}`);

      // 获取工具列表
      await refreshTools(config.name);

      return { success: true };
    } catch (err) {
      sendLog('error', `🔌 MCP 握手失败: ${config.name}`, (err as Error).message);
      stopServer(config.name);
      return { success: false, error: (err as Error).message };
    }
  } catch (err) {
    sendLog('error', `🔌 MCP spawn 失败: ${config.name}`, (err as Error).message);
    return { success: false, error: (err as Error).message };
  }
}

function cleanupServer(server: MCPServerInstance): void {
  for (const [, pending] of server.pendingRequests) {
    clearTimeout(pending.timer);
    pending.reject(new Error('MCP 服务器已关闭'));
  }
  server.pendingRequests.clear();
  try { server.process.kill('SIGTERM'); } catch { /* ignore */ }
}

export function stopServer(name: string): void {
  const server = servers.get(name);
  if (!server) return;
  cleanupServer(server);
  servers.delete(name);
  sendLog('info', `🔌 MCP 已停止: ${name}`);
}

export function stopAllServers(): void {
  for (const [name] of servers) {
    stopServer(name);
  }
}

// ─── 工具操作 ───

export async function refreshTools(name: string): Promise<MCPTool[]> {
  const server = servers.get(name);
  if (!server || !server.initialized) return [];

  try {
    const result = await sendRequest(server, 'tools/list') as { tools?: MCPTool[] };
    server.tools = result.tools || [];
    sendLog('success', `🔌 MCP [${name}] ${server.tools.length} 个工具`,
      server.tools.map(t => t.name).join(', '));
    return server.tools;
  } catch (err) {
    sendLog('error', `🔌 MCP [${name}] 获取工具失败`, (err as Error).message);
    return [];
  }
}

export async function callTool(serverName: string, toolName: string, args: Record<string, unknown>): Promise<{ success: boolean; result?: unknown; error?: string }> {
  const server = servers.get(serverName);
  if (!server || !server.initialized) {
    return { success: false, error: `MCP 服务器 ${serverName} 未运行` };
  }

  sendLog('info', `🔌 MCP 调用工具`, `${serverName}/${toolName} ${JSON.stringify(args || {}).slice(0, 100)}`);

  try {
    const result = await sendRequest(server, 'tools/call', { name: toolName, arguments: args });
    sendLog('success', `🔌 MCP 工具完成`, `${serverName}/${toolName}`);
    return { success: true, result };
  } catch (err) {
    sendLog('error', `🔌 MCP 工具失败`, `${serverName}/${toolName}: ${(err as Error).message}`);
    return { success: false, error: (err as Error).message };
  }
}

// ─── 查询 ───

export interface MCPToolInfo {
  serverName: string;
  name: string;
  fullName: string;
  description: string;
  inputSchema: MCPTool['inputSchema'];
}

/** 获取所有已连接服务器的工具列表 */
export function getAllTools(): MCPToolInfo[] {
  const tools: MCPToolInfo[] = [];
  for (const [serverName, server] of servers) {
    if (!server.initialized) continue;
    for (const tool of server.tools) {
      tools.push({
        serverName,
        name: tool.name,
        fullName: `mcp_${serverName}_${tool.name}`,
        description: `[MCP:${serverName}] ${tool.description || ''}`,
        inputSchema: tool.inputSchema
      });
    }
  }
  return tools;
}

/** 获取服务器状态 */
export function getServerStatuses(): Array<{ name: string; running: boolean; toolCount: number; error?: string }> {
  const statuses: Array<{ name: string; running: boolean; toolCount: number; error?: string }> = [];
  for (const [name, server] of servers) {
    statuses.push({
      name,
      running: server.initialized,
      toolCount: server.tools.length
    });
  }
  return statuses;
}

