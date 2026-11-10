/**
 * 工具结果截断、格式化、图标与中文名。
 */

import type { ToolResult } from '../../types.js';
import { logWarn } from '../log-service.js';

const MAX_TOOL_RESULT_CHARS = 100000;

function truncateStringField(str: string, headKeep = 8000, tailKeep = 3000): string {
  if (str.length <= headKeep + tailKeep) return str;
  const head = str.slice(0, headKeep);
  const tail = str.slice(-tailKeep);
  const omitted = str.length - headKeep - tailKeep;
  return `${head}\n\n... [已截断 ${omitted} 字符，共 ${str.length} 字符] ...\n\n${tail}`;
}

/** R22: 截断大输出结果，保留首尾并添加截断标记 */
export function truncateToolResult(result: ToolResult, toolName: string): ToolResult {
  const jsonStr = JSON.stringify(result);
  if (jsonStr.length <= MAX_TOOL_RESULT_CHARS) return result;

  const truncated = { ...result };

  const largeFields = ['stdout', 'content', 'text', 'result', 'output', 'data', 'formatted', 'snippet', 'error', 'stderr'];
  for (const field of largeFields) {
    if (typeof truncated[field] === 'string' && (truncated[field] as string).length > 10000) {
      truncated[field] = truncateStringField(truncated[field] as string);
    }
  }

  const arrayFields = ['results', 'entries', '_fetched', 'structured', 'files', 'matches'];
  for (const field of arrayFields) {
    if (Array.isArray(truncated[field])) {
      const arr = truncated[field] as unknown[];
      if (arr.length > 50) {
        (truncated as Record<string, unknown>)[`_original_${field}_count`] = arr.length;
        (truncated as Record<string, unknown>)[field] = arr.slice(0, 50);
      }
      const innerLargeKeys = ['content', 'snippet', 'text', 'stdout', 'output', 'formatted', 'data', 'result', 'stderr'];
      for (const item of (truncated as Record<string, unknown>)[field] as unknown[]) {
        if (item && typeof item === 'object' && !Array.isArray(item)) {
          const record = item as Record<string, unknown>;
          for (const key of innerLargeKeys) {
            if (typeof record[key] === 'string' && (record[key] as string).length > 8000) {
              record[key] = truncateStringField(record[key] as string, 6000, 2000);
            }
          }
        }
      }
    }
  }

  const finalStr = JSON.stringify(truncated);
  if (finalStr.length > MAX_TOOL_RESULT_CHARS) {
    const omitted = finalStr.length - MAX_TOOL_RESULT_CHARS;
    logWarn(`R22: 工具 ${toolName} 结果过大，暴力截断 (${finalStr.length} → ${MAX_TOOL_RESULT_CHARS} 字符)`);
    return {
      success: truncated.success,
      _truncated: true,
      preview: finalStr.slice(0, MAX_TOOL_RESULT_CHARS),
      _omitted_chars: omitted,
    } as ToolResult;
  }

  logWarn(`R22: 工具 ${toolName} 结果已截断 (${jsonStr.length} → ~${finalStr.length} 字符)`);
  return truncated;
}

/** R26: 为特定工具添加结构化摘要 */
export function formatToolResult(toolName: string, result: ToolResult): ToolResult {
  if (!result.success) return result;

  switch (toolName) {
    case 'list_directory': {
      const entries = (result as Record<string, unknown>).entries || (result as Record<string, unknown>).items;
      if (Array.isArray(entries)) {
        const dirs = entries.filter((e: { type?: string }) => e.type === 'directory').length;
        const files = entries.filter((e: { type?: string }) => e.type === 'file').length;
        (result as Record<string, unknown>)._summary = `共 ${entries.length} 项 (${dirs} 个目录, ${files} 个文件)`;
      }
      break;
    }
    case 'search_files': {
      const results = (result as Record<string, unknown>).results || (result as Record<string, unknown>).matches;
      if (Array.isArray(results)) {
        (result as Record<string, unknown>)._summary = `找到 ${results.length} 个匹配结果`;
      }
      break;
    }
    case 'read_file': {
      const content = (result as Record<string, unknown>).content || '';
      if (typeof content === 'string') {
        const lines = content.split('\n').length;
        const chars = content.length;
        (result as Record<string, unknown>)._meta = `文件内容: ${lines} 行, ${chars} 字符`;
      }
      break;
    }
    case 'web_search': {
      const results = (result as Record<string, unknown>).results;
      if (Array.isArray(results)) {
        (result as Record<string, unknown>)._summary = `搜索返回 ${results.length} 条结果`;
      }
      break;
    }
  }

  return result;
}

export function getToolIcon(name: string): string {
  const icons: Record<string, string> = {
    read_file: '📄',
    write_file: '✏️',
    list_directory: '📁',
    search_files: '🔍',
    delete_file: '🗑️',
    run_command: '💻',
    file_transfer: '📦',
    web_fetch: '🌐',
    edit_file: '✂️',
    download_file: '⬇️',
    git: '🔖',
    compress: '🗜️',
    web_search: '🔍',
    memory: '🧠',
    session: '📖',
    spawn_task: '🤖',
    browser: '🌐',
    diff: '🔍',
  };
  return icons[name] || '🔧';
}

export function formatToolName(name: string): string {
  const names: Record<string, string> = {
    read_file: '读取文件',
    write_file: '写入文件',
    list_directory: '列出目录',
    search_files: '搜索文件',
    delete_file: '删除文件',
    run_command: '执行命令',
    file_transfer: '复制/移动',
    web_fetch: '网页抓取',
    edit_file: '编辑文件',
    download_file: '下载文件',
    git: 'Git 操作',
    compress: '压缩/解压',
    web_search: '联网搜索',
    memory: '记忆管理',
    session: '会话读取',
    spawn_task: '子代理委派',
    browser: '浏览器控制',
    diff: '文件差异',
  };
  return names[name] || name;
}
