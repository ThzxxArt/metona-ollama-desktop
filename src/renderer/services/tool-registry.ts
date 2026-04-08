/**
 * Tool Registry - 工具注册与调度中心
 * 管理所有可用工具的定义，负责执行调度
 */

import type { ToolDefinition, ToolResult } from '../types.js';
import { logToolStart, logToolResult, logError, logInfo } from './log-service.js';

export const TOOL_DEFINITIONS: ToolDefinition[] = [
  {
    type: 'function',
    function: {
      name: 'read_file',
      description: 'Read the contents of a local file. Returns the file content as a string. Supports text files up to 1MB. Use start_line/end_line for large files.',
      parameters: {
        type: 'object',
        required: ['path'],
        properties: {
          path: { type: 'string', description: 'The file path to read. Absolute or relative.' },
          encoding: { type: 'string', enum: ['utf-8', 'latin1', 'base64'], description: 'File encoding. Default: utf-8' },
          start_line: { type: 'integer', description: 'Start line (1-indexed). For reading specific sections.' },
          end_line: { type: 'integer', description: 'End line (inclusive). Default: start_line + 500.' }
        }
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'write_file',
      description: 'Write content to a local file. Creates parent directories automatically. Overwrites existing files. Max 5MB content.',
      parameters: {
        type: 'object',
        required: ['path', 'content'],
        properties: {
          path: { type: 'string', description: 'The file path to write to.' },
          content: { type: 'string', description: 'The content to write.' }
        }
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'list_directory',
      description: 'List directory contents. Returns file names, types, sizes, and modification times.',
      parameters: {
        type: 'object',
        required: ['path'],
        properties: {
          path: { type: 'string', description: 'Directory path.' },
          recursive: { type: 'boolean', description: 'List recursively. Default: false.' },
          max_depth: { type: 'integer', description: 'Max recursion depth. Default: 3.' },
          include_hidden: { type: 'boolean', description: 'Include hidden files. Default: false.' }
        }
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'search_files',
      description: 'Search files by name pattern or text content within files.',
      parameters: {
        type: 'object',
        required: ['path', 'query'],
        properties: {
          path: { type: 'string', description: 'Root directory to search.' },
          query: { type: 'string', description: 'Search query (glob or text).' },
          search_type: { type: 'string', enum: ['filename', 'content', 'both'], description: 'Search target. Default: both.' },
          case_sensitive: { type: 'boolean', description: 'Case sensitive. Default: false.' },
          max_results: { type: 'integer', description: 'Max results. Default: 50.' },
          file_extensions: { type: 'array', items: { type: 'string' }, description: 'Filter extensions, e.g. [".ts", ".js"]' }
        }
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'create_directory',
      description: 'Create a new directory. Creates parents automatically.',
      parameters: {
        type: 'object',
        required: ['path'],
        properties: {
          path: { type: 'string', description: 'Directory path to create.' }
        }
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'delete_file',
      description: 'Delete a file or directory. Requires user confirmation.',
      parameters: {
        type: 'object',
        required: ['path'],
        properties: {
          path: { type: 'string', description: 'Path to delete.' },
          recursive: { type: 'boolean', description: 'Recursive delete for directories. DANGEROUS.' }
        }
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'run_command',
      description: 'Execute a shell command via workspace. No timeout limit — runs until the process exits. Requires user confirmation. Output is streamed in real-time through the workspace process.',
      parameters: {
        type: 'object',
        required: ['command'],
        properties: {
          command: { type: 'string', description: 'Shell command to execute.' },
          cwd: { type: 'string', description: 'Working directory. Defaults to workspace directory.' }
        }
      }
    }
  }
];

const CONFIRM_TOOLS = ['write_file', 'delete_file', 'run_command', 'create_directory'];

export function needsConfirmation(toolName: string): boolean {
  return CONFIRM_TOOLS.includes(toolName);
}

let enabledTools: Set<string> = new Set([
  'read_file', 'list_directory', 'search_files',
  'write_file', 'create_directory', 'delete_file',
  'run_command'  // 默认启用，需要用户确认
]);

export function setToolEnabled(toolName: string, enabled: boolean): void {
  if (enabled) enabledTools.add(toolName);
  else enabledTools.delete(toolName);
}

export function isToolEnabled(toolName: string): boolean {
  return enabledTools.has(toolName);
}

export function getEnabledToolDefinitions(): ToolDefinition[] {
  return TOOL_DEFINITIONS.filter(def => enabledTools.has(def.function.name));
}

export async function executeTool(toolName: string, args: Record<string, unknown>): Promise<ToolResult> {
  if (!isToolEnabled(toolName)) {
    logError(`工具未启用: ${toolName}`);
    return { success: false, error: `工具 ${toolName} 未启用` };
  }

  const bridge = window.metonaDesktop;
  if (!bridge?.isDesktop) {
    logError(`工具调用仅支持桌面版: ${toolName}`);
    return { success: false, error: '工具调用仅支持桌面版' };
  }

  try {
    logToolStart(toolName, JSON.stringify(args));

    // run_command 走 workspace IPC
    if (toolName === 'run_command') {
      const command = args.command as string;
      const cwd = args.cwd as string | undefined;
      if (!command) {
        return { success: false, error: '缺少 command 参数' };
      }
      logInfo(`工作空间命令执行: ${command.slice(0, 100)}`);
      const result = await bridge.workspace.execTool(command, cwd);
      logToolResult('run_command', result.success, result.success ? undefined : result.stderr?.slice(0, 200));
      return {
        success: result.success,
        stdout: result.stdout,
        stderr: result.stderr,
        exitCode: result.exitCode,
        duration: result.duration
      };
    }

    // 其他工具：IPC 调用 + 25 秒硬超时
    const result = await Promise.race([
      bridge.tool.execute(toolName, args),
      new Promise<ToolResult>((_, reject) =>
        setTimeout(() => reject(new Error(`工具 ${toolName} IPC 超时（25秒）`)), 25000)
      )
    ]);
    logToolResult(toolName, result.success, result.success ? undefined : result.error);
    return result;
  } catch (err) {
    logError(`工具异常: ${toolName}`, (err as Error).message);
    return { success: false, error: (err as Error).message };
  }
}

export function getToolIcon(name: string): string {
  const icons: Record<string, string> = {
    read_file: '📄',
    write_file: '✏️',
    list_directory: '📁',
    search_files: '🔍',
    create_directory: '📂',
    delete_file: '🗑️',
    run_command: '💻'
  };
  return icons[name] || '🔧';
}

export function formatToolName(name: string): string {
  const names: Record<string, string> = {
    read_file: '读取文件',
    write_file: '写入文件',
    list_directory: '列出目录',
    search_files: '搜索文件',
    create_directory: '创建目录',
    delete_file: '删除文件',
    run_command: '执行命令'
  };
  return names[name] || name;
}
