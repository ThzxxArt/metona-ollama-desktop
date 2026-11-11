/**
 * 工具调度辅助：超时、路径依赖、参数前置校验、缓存与去重。
 */

import { state } from '../../state/state.js';
import { executeTool } from '../tool-registry.js';
import { logInfo } from '../log-service.js';
import { stableStringify } from '../../utils/utils.js';
import type { ToolCall, ToolResult } from '../../types.js';

export const SIDE_EFFECT_TOOLS = new Set([
  'write_file',
  'edit_file',
  'delete_file',
  'file_transfer',
  'download_file',
  'run_command',
  'git',
  'compress',
  'browser',
]);

const TOOL_TIMEOUT_MAP: Record<
  string,
  { base: number; grade: 'fast' | 'medium' | 'slow' | 'long'; description: string }
> = {
  memory: { base: 5_000, grade: 'fast', description: '记忆操作' },
  session: { base: 5_000, grade: 'fast', description: '会话读取' },
  list_directory: { base: 10_000, grade: 'medium', description: '列目录' },
  delete_file: { base: 10_000, grade: 'medium', description: '删除文件' },
  write_file: { base: 15_000, grade: 'medium', description: '写入文件' },
  edit_file: { base: 15_000, grade: 'medium', description: '编辑文件' },
  file_transfer: { base: 15_000, grade: 'medium', description: '复制/移动文件' },
  web_search: { base: 900_000, grade: 'slow', description: '网页搜索' },
  git: { base: 30_000, grade: 'medium', description: 'Git 操作' },
  read_file: { base: 60_000, grade: 'slow', description: '读取文件' },
  search_files: { base: 60_000, grade: 'slow', description: '搜索文件' },
  web_fetch: { base: 900_000, grade: 'long', description: '网页抓取' },
  compress: { base: 60_000, grade: 'slow', description: '压缩' },
  browser: { base: 60_000, grade: 'slow', description: '浏览器控制' },
  download_file: { base: 900_000, grade: 'long', description: '下载文件' },
  default: { base: 60_000, grade: 'medium', description: '默认工具' },
};

export function getAdjustedToolTimeout(toolName: string, args: Record<string, unknown>): number {
  const config = TOOL_TIMEOUT_MAP[toolName] ?? TOOL_TIMEOUT_MAP.default;
  let timeout = config.base;

  const NETWORK_TOOLS = ['web_search', 'web_fetch', 'download_file'];
  if (NETWORK_TOOLS.includes(toolName)) {
    const userHttpTimeout = state.get<number>('httpTimeout', 900_000);
    if (userHttpTimeout === 0) timeout = 0;
    else timeout = Math.max(timeout, userHttpTimeout);
  }

  if (toolName === 'run_command' && args.command) {
    const cmd = String(args.command);
    if (cmd.includes('npm install') || cmd.includes('pip install') || cmd.includes('apt-get install')) {
      timeout = 300_000;
    } else if (cmd.includes('build') || cmd.includes('compile') || cmd.includes('make')) {
      timeout = 180_000;
    } else if (cmd.includes('test')) {
      timeout = 120_000;
    } else {
      timeout = 120_000;
    }
  }

  if (toolName === 'web_fetch' && args.url) {
    const url = String(args.url);
    if (url.includes('youtube') || url.includes('video') || url.includes('mp4')) {
      timeout = Math.max(timeout, 90_000);
    }
  }

  if (toolName === 'write_file' && args.content) {
    if (String(args.content).length > 100_000) timeout = 30_000;
  }

  return timeout;
}

function killToolSubprocess(toolName: string): void {
  if (toolName !== 'run_command') return;
  try {
    void window.metonaDesktop?.workspace?.cmdKill?.();
  } catch {
    /* 终止失败不阻塞超时返回 */
  }
}

export async function executeToolWithTimeout(
  toolName: string,
  args: Record<string, unknown>,
  abortSignal?: AbortSignal,
): Promise<ToolResult> {
  const timeoutMs = getAdjustedToolTimeout(toolName, args);
  if (timeoutMs <= 0) return executeTool(toolName, args);

  if (abortSignal?.aborted) {
    killToolSubprocess(toolName);
    return { success: false, error: '用户中止' };
  }

  let timer: ReturnType<typeof setTimeout> | null = null;
  let onExternalAbort: (() => void) | null = null;

  return new Promise<ToolResult>((resolve) => {
    let settled = false;

    const cleanup = () => {
      if (timer) {
        clearTimeout(timer);
        timer = null;
      }
      if (abortSignal && onExternalAbort) abortSignal.removeEventListener('abort', onExternalAbort);
    };

    const settle = (result: ToolResult) => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve(result);
    };

    timer = setTimeout(() => {
      killToolSubprocess(toolName);
      settle({
        success: false,
        error: `工具 ${toolName} 执行超时 (${timeoutMs / 1000}s)，请尝试拆分任务或优化参数`,
      });
    }, timeoutMs);

    if (abortSignal) {
      if (abortSignal.aborted) {
        killToolSubprocess(toolName);
        settle({ success: false, error: '用户中止' });
        return;
      }
      onExternalAbort = () => {
        killToolSubprocess(toolName);
        settle({ success: false, error: '用户中止' });
      };
      abortSignal.addEventListener('abort', onExternalAbort, { once: true });
    }

    executeTool(toolName, args)
      .then((result) => settle(result))
      .catch((err) => settle({ success: false, error: (err as Error)?.message || String(err) }));
  });
}

export function hasPathDependency(call: ToolCall, prevBatch: ToolCall[]): boolean {
  const callWritePath = extractWritePath(call);
  const callReadPath = extractReadPath(call);

  for (const prev of prevBatch) {
    const prevWritePath = extractWritePath(prev);
    const prevAffectedPath = extractAffectedPath(prev);

    if (callWritePath && prevWritePath && pathsConflict(callWritePath, prevWritePath)) {
      logInfo(`R27: 串行化(写-写): ${prev.function.name}(${prevWritePath}) → ${call.function.name}(${callWritePath})`);
      return true;
    }
    if (callWritePath && prevAffectedPath && pathsConflict(callWritePath, prevAffectedPath)) {
      logInfo(
        `R27: 串行化(读-写): ${prev.function.name}(${prevAffectedPath}) → ${call.function.name}(${callWritePath})`,
      );
      return true;
    }
    if (callReadPath && prevWritePath && pathsConflict(callReadPath, prevWritePath)) {
      logInfo(`R27: 串行化(写-读): ${prev.function.name}(${prevWritePath}) → ${call.function.name}(${callReadPath})`);
      return true;
    }
    if (call.function.name === 'run_command' && prevWritePath) {
      const cmdCwd = String(call.function.arguments?.cwd || '');
      if (cmdCwd && pathsConflict(cmdCwd, prevWritePath)) {
        logInfo(`R27: 串行化(命令依赖): ${prev.function.name}(${prevWritePath}) → run_command(${cmdCwd})`);
        return true;
      }
    }
  }
  return false;
}

function extractReadPath(call: ToolCall): string | null {
  const args = call.function.arguments;
  switch (call.function.name) {
    case 'read_file':
      return Array.isArray(args.paths) ? null : String(args.path || '');
    case 'list_directory':
      return String(args.path || '');
    case 'search_files':
      return String(args.path || '');
    default:
      return null;
  }
}

function extractWritePath(call: ToolCall): string | null {
  const args = call.function.arguments;
  switch (call.function.name) {
    case 'write_file':
      return String(args.path || '');
    case 'edit_file':
      return String(args.path || '');
    case 'delete_file':
      return args.paths && Array.isArray(args.paths) && args.paths.length > 0
        ? String(args.paths[0] || '')
        : String(args.path || '');
    case 'file_transfer':
      return String(args.destination || args.source || '');
    case 'download_file':
      return String(args.destination || '');
    case 'compress':
      return String(args.destination || args.path || '');
    default:
      return null;
  }
}

function extractAffectedPath(call: ToolCall): string | null {
  const args = call.function.arguments;
  switch (call.function.name) {
    case 'read_file':
      return Array.isArray(args.paths) ? null : String(args.path || '');
    case 'write_file':
      return String(args.path || '');
    case 'edit_file':
      return String(args.path || '');
    case 'delete_file':
      return args.paths && Array.isArray(args.paths) && args.paths.length > 0
        ? String(args.paths[0] || '')
        : String(args.path || '');
    case 'list_directory':
      return String(args.path || '');
    case 'search_files':
      return String(args.path || '');
    case 'file_transfer':
      return String(args.source || '');
    case 'download_file':
      return null;
    case 'compress':
      return String(args.path || '');
    default:
      return null;
  }
}

export function pathsConflict(a: string, b: string): boolean {
  if (!a || !b) return false;
  const na = a.replace(/\\/g, '/').replace(/\/+$/, '');
  const nb = b.replace(/\\/g, '/').replace(/\/+$/, '');
  return na === nb || na.startsWith(nb + '/') || nb.startsWith(na + '/');
}

export function validateToolArgsQuick(toolName: string, args: Record<string, unknown>): string | null {
  const getString = (key: string): string | null => {
    const v = args[key];
    if (typeof v === 'string' && v.trim().length > 0) return v;
    return null;
  };
  switch (toolName) {
    case 'read_file':
      if (!getString('path') && !(Array.isArray(args.paths) && args.paths.length > 0)) {
        return 'read_file 需要 path 或非空 paths 参数';
      }
      break;
    case 'write_file':
    case 'delete_file':
    case 'compress':
      if (!getString('path')) return `${toolName} 缺少有效的 path 参数`;
      break;
    case 'list_directory':
      if (!getString('path')) return 'list_directory 缺少 path 参数';
      break;
    case 'search_files':
      if (!getString('query')) return 'search_files 缺少有效的 query 参数';
      if (!getString('path')) return 'search_files 缺少 path 参数';
      break;
    case 'web_fetch':
      if (!args.url || typeof args.url !== 'string' || !/^https?:\/\//.test(args.url as string)) {
        return 'web_fetch 的 url 参数无效（需以 http:// 或 https:// 开头）';
      }
      break;
    case 'web_search':
      if (!getString('query')) return 'web_search 缺少有效的 query 参数';
      break;
    case 'run_command':
      if (!getString('command')) return 'run_command 缺少有效的 command 参数';
      break;
    case 'file_transfer':
      if (args.operation !== 'copy' && args.operation !== 'move') {
        return 'file_transfer 的 operation 必须为 copy 或 move';
      }
      if (!getString('source')) return 'file_transfer 缺少 source 参数';
      if (!getString('destination')) return 'file_transfer 缺少 destination 参数';
      break;
    case 'browser':
      if (!getString('action')) return 'browser 缺少 action 参数';
      break;
    case 'session':
      if (args.action !== 'list' && args.action !== 'read') return 'session 的 action 必须为 list 或 read';
      if (args.action === 'read' && !getString('session_id')) return 'session read 缺少 session_id 参数';
      break;
    case 'edit_file':
      if (!getString('path')) return 'edit_file 缺少 path 参数';
      if (args.old_text === undefined || args.old_text === null) return 'edit_file 缺少 old_text 参数';
      if (args.new_text === undefined || args.new_text === null) return 'edit_file 缺少 new_text 参数';
      break;
  }
  return null;
}

const MAX_TOOL_CACHE_SIZE = 100;
const toolResultCache = new Map<string, { result: ToolResult; timestamp: number }>();

export function setToolCache(key: string, entry: { result: ToolResult; timestamp: number }): void {
  if (toolResultCache.has(key)) toolResultCache.delete(key);
  toolResultCache.set(key, entry);
  if (toolResultCache.size > MAX_TOOL_CACHE_SIZE) {
    const oldestKey = toolResultCache.keys().next().value;
    if (oldestKey !== undefined) toolResultCache.delete(oldestKey);
  }
}

export function getToolCache(key: string): { result: ToolResult; timestamp: number } | undefined {
  const entry = toolResultCache.get(key);
  if (entry) {
    toolResultCache.delete(key);
    toolResultCache.set(key, entry);
  }
  return entry;
}

export function clearToolCache(): void {
  toolResultCache.clear();
}

export function deleteToolCache(key: string): void {
  toolResultCache.delete(key);
}

const CACHE_TTL_MAP: Record<string, number> = {
  web_search: 5 * 60_000,
  web_fetch: 10 * 60_000,
  read_file: 30 * 60_000,
  list_directory: 2 * 60_000,
  search_files: 2 * 60_000,
  browser: 60_000,
  git: 30_000,
  session: 60_000,
  memory: 10_000,
  default: 60_000,
};

export function isCacheValid(toolName: string, timestamp: number): boolean {
  const ttl = CACHE_TTL_MAP[toolName] ?? CACHE_TTL_MAP.default;
  if (!isFinite(ttl)) return true;
  return Date.now() - timestamp < ttl;
}

export function getToolCacheKey(name: string, args: Record<string, unknown>): string {
  try {
    return name + '::' + stableStringify(args);
  } catch {
    return name + '::' + String(args);
  }
}

export function isDuplicateCall(call: ToolCall, allCalls: ToolCall[]): boolean {
  const callKey = getToolCacheKey(call.function.name, call.function.arguments);
  let count = 0;
  for (const prev of allCalls) {
    if (getToolCacheKey(prev.function.name, prev.function.arguments) === callKey) {
      count++;
      if (count > 1) return true;
    }
  }
  return false;
}
