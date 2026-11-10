/**
 * Tool Registry - 工具注册与调度中心
 * 管理所有可用工具的定义，负责执行调度
 */

import type { ToolDefinition, ToolResult, ToolCall } from '../types.js';
import type { SubAgentPermission } from './sub-agent.js';
import { state, KEYS } from '../state/state.js';
import { logToolStart, logToolResult, logError, logInfo, logWarn } from './log-service.js';
import { getMCPToolDefinitions } from './mcp-client.js';

export const TOOL_DEFINITIONS: ToolDefinition[] = [
  {
    type: 'function',
    function: {
      name: 'read_file',
      description: 'Read one or more LOCAL files. Use "path" for a single file, or "paths" to batch-read up to 50 files in parallel. Does NOT support URLs — use web_fetch for web pages. Supports text (utf-8/latin1, line pagination) and binary (base64, byte pagination). Files up to 5MB (text) or 50MB (binary). When truncated, returns remaining_lines/remaining_bytes and a hint to continue.',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'Single local file path (NOT a URL). Absolute or relative to workspace.' },
          paths: { type: 'array', items: { type: 'string' }, description: 'Batch-read multiple local files (max 50). Mutually exclusive with path.' },
          max_chars_per_file: { type: 'integer', description: 'Max chars per file when using paths. Default: 10000.' },
          encoding: { type: 'string', enum: ['utf-8', 'latin1', 'base64'], description: 'File encoding. Default: utf-8. Use base64 for binary content.' },
          start_line: { type: 'integer', description: 'Start line (1-indexed) for text files. Use with end_line for pagination.' },
          end_line: { type: 'integer', description: 'End line (inclusive). Default: start_line + 2000.' },
          mode: { type: 'string', enum: ['text', 'binary'], description: 'Read mode. text = decode as string, binary = return base64. Default: text.' },
          offset_bytes: { type: 'integer', description: 'Byte offset to start reading from (0-indexed). Use for binary files or large text.' },
          limit_bytes: { type: 'integer', description: 'Max bytes to read. Default: 50000 (text) or 102400 (binary).' }
        }
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'write_file',
      description: 'Write content to a local file. Creates parent directories automatically. The "path" parameter is REQUIRED — always specify a file path (relative to workspace or absolute). For example: path="output.txt" writes to workspace. Supports text (utf-8/latin1) and binary (base64). Use mode="append" to add to existing file. Max 10MB overwrite / 5MB append.',
      parameters: {
        type: 'object',
        required: ['path', 'content'],
        properties: {
          path: { type: 'string', description: 'REQUIRED — File path. Relative paths use workspace as base. E.g. "output.txt", "docs/report.md", or absolute "/home/user/file.txt".' },
          content: { type: 'string', description: 'The content to write. For binary files, pass base64-encoded string with encoding="base64".' },
          encoding: { type: 'string', enum: ['utf-8', 'latin1', 'base64'], description: 'File encoding. Use "base64" to write binary content (images, PDFs, etc). Default: utf-8.' },
          mode: { type: 'string', enum: ['overwrite', 'append'], description: 'Write mode. overwrite = replace file, append = add to end. Default: overwrite.' }
        }
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'list_directory',
      description: 'List directory contents up to 2000 entries, or render a tree when format="tree". Returns names, types, sizes, modification times. Supports offset pagination, recursion, and extension filtering.',
      parameters: {
        type: 'object',
        required: ['path'],
        properties: {
          path: { type: 'string', description: 'Directory path.' },
          format: { type: 'string', enum: ['list', 'tree'], description: 'list = flat entries; tree = nested directory tree. Default: list.' },
          recursive: { type: 'boolean', description: 'List recursively. Default: false.' },
          max_depth: { type: 'integer', description: 'Max recursion depth. Default: 3 (list) / 5 (tree).' },
          include_hidden: { type: 'boolean', description: 'Include hidden files. Default: false.' },
          filter_extension: { type: 'string', description: 'Filter files by extension (e.g. ".txt"). Only files matching this extension are returned. Default: no filter.' },
          offset: { type: 'integer', description: 'Skip first N entries for pagination. Default: 0.' }
        }
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'search_files',
      description: 'Search files by name pattern or text content within files. Supports regular expressions with use_regex=true.',
      parameters: {
        type: 'object',
        required: ['path', 'query'],
        properties: {
          path: { type: 'string', description: 'Root directory to search.' },
          query: { type: 'string', description: 'Search query (glob, text, or regex).' },
          search_type: { type: 'string', enum: ['filename', 'content', 'both'], description: 'Search target. Default: both.' },
          case_sensitive: { type: 'boolean', description: 'Case sensitive. Default: false.' },
          max_results: { type: 'integer', description: 'Max results. Default: 0 (no limit).' },
          file_extensions: { type: 'array', items: { type: 'string' }, description: 'Filter extensions, e.g. [".ts", ".js"]' },
          use_regex: { type: 'boolean', description: 'Treat query as regular expression. Default: false.' }
        }
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'delete_file',
      description: 'Delete a file or directory. Supports batch deletion via paths parameter. At least one of path or paths must be provided. Returns deleted item count and total size. Use recursive=true for non-empty directories.',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'Single path to delete. Use this for deleting one file/directory.' },
          paths: { type: 'array', items: { type: 'string' }, description: 'Multiple paths to delete in batch. Use this when deleting multiple files at once.' },
          recursive: { type: 'boolean', description: 'Recursive delete for directories. Returns filesDeleted count and total deletedSize.' }
        }
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'run_command',
      description: 'Execute a shell command via workspace. cwd defaults to workspace directory. Output is streamed in real-time through the workspace process. Execution mode is configurable (auto / confirm / disabled) — set in the Tools panel; in confirm mode the user must approve each command before it runs.',
      parameters: {
        type: 'object',
        required: ['command'],
        properties: {
          command: { type: 'string', description: 'Shell command to execute.' },
          cwd: { type: 'string', description: 'Working directory. Defaults to workspace directory.' }
        }
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'file_transfer',
      description: 'Copy or move a file/directory. operation="copy" copies, operation="move" moves or renames. Creates destination parent directories automatically.',
      parameters: {
        type: 'object',
        required: ['operation', 'source', 'destination'],
        properties: {
          operation: { type: 'string', enum: ['copy', 'move'], description: 'copy = duplicate, move = move or rename.' },
          source: { type: 'string', description: 'Source path.' },
          destination: { type: 'string', description: 'Destination path.' },
          recursive: { type: 'boolean', description: 'Copy directories recursively (copy only). Default: true.' }
        }
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'web_fetch',
      description: 'Fetch and extract full text content from a URL. Typically used after web_search: pick the most relevant result URLs from search and call web_fetch on each to get detailed content before answering. Automatically retries on failure (up to 2 times with exponential backoff). Auto-upgrades to browser rendering for JavaScript-heavy pages.',
      parameters: {
        type: 'object',
        required: ['url'],
        properties: {
          url: { type: 'string', description: 'URL to fetch (http/https).' },
          max_chars: { type: 'integer', description: 'Max characters to return. Default: 0 (no limit, return full content).' },
          extract_mode: { type: 'string', enum: ['text', 'markdown'], description: 'Extraction mode. Default: text.' },
          mobile_ua: { type: 'boolean', description: 'Use mobile User-Agent. Some sites return simpler content for mobile. Default: false.' },
          retry: { type: 'boolean', description: 'Enable auto-retry on failure (5xx/network errors, up to 2 times). Default: true.' }
        }
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'edit_file',
      description: 'Find and replace text in a file. Supports literal string matching and regex (use_regex=true). Use all=true to replace all occurrences. More efficient than write_file for small edits.',
      parameters: {
        type: 'object',
        required: ['path', 'old_text', 'new_text'],
        properties: {
          path: { type: 'string', description: 'File path to edit.' },
          old_text: { type: 'string', description: 'Text to find. Can be a regex pattern when use_regex=true.' },
          new_text: { type: 'string', description: 'Replacement text.' },
          all: { type: 'boolean', description: 'Replace all occurrences. Default: false.' },
          use_regex: { type: 'boolean', description: 'Treat old_text as a regular expression. Default: false.' }
        }
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'download_file',
      description: 'Download a file from a URL to a local path. Requires user confirmation.',
      parameters: {
        type: 'object',
        required: ['url', 'destination'],
        properties: {
          url: { type: 'string', description: 'URL to download (http/https).' },
          destination: { type: 'string', description: 'Local path to save the file.' }
        }
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'git',
      description: 'Git operations: status, log, diff, add, commit, push, pull, branch, checkout, merge, stash, remote, clone, init. All operations are automatic (no confirmation).',
      parameters: {
        type: 'object',
        required: ['action'],
        properties: {
          action: { type: 'string', enum: ['status', 'log', 'diff', 'add', 'commit', 'push', 'pull', 'branch', 'checkout', 'merge', 'stash', 'remote', 'clone', 'init', 'reset', 'tag'], description: 'Git action to perform.' },
          path: { type: 'string', description: 'Repository path. Defaults to workspace.' },
          files: { type: 'array', items: { type: 'string' }, description: 'Files for add/diff/checkout.' },
          message: { type: 'string', description: 'Commit message for commit action.' },
          branch: { type: 'string', description: 'Branch name for branch/checkout/merge.' },
          tag_name: { type: 'string', description: 'Tag name for tag action (creates an annotated tag if message is provided).' },
          stash_sub: { type: 'string', enum: ['push', 'pop', 'apply', 'list', 'drop'], description: 'Stash subcommand. Default: push.' },
          remote: { type: 'string', description: 'Remote name for push/pull/remote.' },
          remote_url: { type: 'string', description: 'Remote URL for remote add.' },
          count: { type: 'integer', description: 'Number of log entries. Default: 20.' },
          all: { type: 'boolean', description: 'Show all (branches, stashes, etc). Default: false.' },
          staged: { type: 'boolean', description: 'Show staged changes in diff. Default: false.' },
          new_branch: { type: 'boolean', description: 'Create new branch in branch action. Default: false.' },
          delete_branch: { type: 'boolean', description: 'Delete branch in branch action. Default: false.' },
          force: { type: 'boolean', description: 'Force push/checkout. Default: false.' },
          url: { type: 'string', description: 'Repository URL for clone.' }
        }
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'compress',
      description: 'Create or extract archives (zip/tar.gz). Requires user confirmation for create.',
      parameters: {
        type: 'object',
        required: ['action', 'path'],
        properties: {
          action: { type: 'string', enum: ['create', 'extract'], description: 'Create or extract archive.' },
          path: { type: 'string', description: 'Source path (create) or archive path (extract).' },
          destination: { type: 'string', description: 'Output archive path (create) or extract dir (extract).' },
          format: { type: 'string', enum: ['zip', 'tar.gz'], description: 'Archive format. Default: tar.gz.' }
        }
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'diff',
      description: 'Compare file contents and return unified diff format. Supports three modes: file_vs_file (compare two files), file_vs_content (compare a file against provided text), file_vs_git_head (compare working copy against git HEAD). Useful for verifying edits before committing, checking what changed after edit_file, or comparing two versions of a file.',
      parameters: {
        type: 'object',
        required: ['mode'],
        properties: {
          mode: { type: 'string', enum: ['file_vs_file', 'file_vs_content', 'file_vs_git_head'], description: 'Comparison mode. file_vs_file: compare path1 vs path2. file_vs_content: compare path1 file vs provided content. file_vs_git_head: compare path1 working copy vs git HEAD version.' },
          path1: { type: 'string', description: 'Primary file path. Required for all modes. In file_vs_file, this is the "old" file. In file_vs_git_head, this is the working copy.' },
          path2: { type: 'string', description: 'Second file path (only for file_vs_file mode).' },
          content: { type: 'string', description: 'Content to compare against (only for file_vs_content mode).' },
          context_lines: { type: 'integer', description: 'Number of context lines around changes in the diff output. Default: 3.' }
        }
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'web_search',
      description: 'Search the web with auto-fetch. Always use this when the user asks for information, news, facts, or current data. Never rely on training data or past conversation results — call this tool every time the user asks to search. Set fetch_top to auto-fetch full page content from the top N results.',
      parameters: {
        type: 'object',
        required: ['query', 'fetch_top'],
        properties: {
          query: { type: 'string', description: 'The search query. Be specific and concise for best results.' },
          max_results: { type: 'integer', description: 'Maximum number of results to return. Default: 30, max: 30.' },
          time_range: { type: 'string', enum: ['day', 'week', 'month', 'year'], description: 'Filter results by time. Supported by Bing and Google. Use for recent news, latest version, etc.' },
          enhance_snippets: { type: 'boolean', description: 'Auto-fetch detailed snippet for results with too-short descriptions. Default: true.' },
          fetch_top: { type: 'integer', description: 'Number of top results to auto-fetch full content for. Min: 3. Results shorter than this are useless — snippets lack detail.' }
        }
      }
    }
  },
  // ══════════════════════════════════════════════
  // 记忆工具（统一入口，读写工作空间 MEMORY.md）
  // ══════════════════════════════════════════════
  {
    type: 'function',
    function: {
      name: 'memory',
      description: `Manage agent memories stored in MEMORY.md. Usage by action:
- search: {"action":"search","query":"keywords","limit":8}
- add: {"action":"add","type":"fact","content":"the memory content","importance":8,"tags":["tag1","tag2"]}  ← type and content are REQUIRED for add!
- replace: {"action":"replace","old_text":"unique substring","new_content":"replacement"}
- remove: {"action":"remove","old_text":"unique substring"}
- remove_batch: {"action":"remove_batch","old_texts":["substring1","substring2","substring3"]}  ← Batch delete multiple entries in one call
- read_all: {"action":"read_all"}

CRITICAL: For add action, you MUST include both "type" (fact/preference/rule) and "content" fields. If you omit them, the call will fail.
TIP: Use remove_batch when deleting multiple entries — it's much more efficient than calling remove repeatedly.`,
      parameters: {
        type: 'object',
        required: ['action'],
        properties: {
          action: { type: 'string', enum: ['search', 'add', 'replace', 'remove', 'remove_batch', 'read_all'], description: 'Which operation to perform. Note: "add" requires "type"+"content", "replace" requires "old_text"+"new_content", "remove" requires "old_text", "remove_batch" requires "old_texts" (array), "search" requires "query".' },
          query: { type: 'string', description: '[search REQUIRED] Keywords to search for.' },
          limit: { type: 'integer', description: '[search] Max results. Default: 8.' },
          type: { type: 'string', enum: ['fact', 'preference', 'rule'], description: '[add REQUIRED] Memory type. fact=user info, preference=user preference, rule=behavior rule.' },
          content: { type: 'string', description: '[add REQUIRED, replace] Memory text. Keep it concise (8-100 chars).' },
          importance: { type: 'integer', description: '[add] Priority 1-10. Default: 5. Use 8+ for critical info.' },
          tags: { type: 'array', items: { type: 'string' }, description: '[add] 2-5 keywords for search matching.' },
          old_text: { type: 'string', description: '[replace, remove REQUIRED] Unique substring to identify the entry. Must be ≥5 chars. Use exact text from read_all for best results.' },
          old_texts: { type: 'array', items: { type: 'string' }, description: '[remove_batch REQUIRED] Array of substrings to identify multiple entries for batch deletion. Each must be ≥5 chars.' },
          new_content: { type: 'string', description: '[replace REQUIRED] New text to replace with.' }
        }
      }
    }
  },
  // ══════════════════════════════════════════════
  // v4.3 新增工具：子代理委派
  // ══════════════════════════════════════════════
  {
    type: 'function',
    function: {
name: 'spawn_task',
description: 'Spawn a sub-agent to independently execute a task. Default permission is "readonly" (file reading, web search, browser viewing, memory/session queries). Set permission to "limited_write" for file editing tasks (write_file, edit_file, file_transfer, browser) or "full_write" for full capability (run_command, git, delete_file). Use this to parallelize independent sub-tasks. The model is configured in Settings and cannot be overridden per call.',
parameters: {
type: 'object',
required: ['task'],
properties: {
task: { type: 'string', description: 'The task description for the sub-agent to execute.' },
context: { type: 'string', description: 'Optional additional context or reference data for the sub-agent.' },
permission: { type: 'string', enum: ['readonly', 'limited_write', 'full_write'], description: 'Permission level for the sub-agent. readonly=file reading/search only, limited_write=can edit files but no shell commands, full_write=full capability including run_command and git. Default: readonly.' }
}
      }
    }
  },
  // ══════════════════════════════════════════════
  // 会话读取（合并原两个会话工具）
  // ══════════════════════════════════════════════
  {
    type: 'function',
    function: {
      name: 'session',
      description: 'Read previous chat sessions. action="list" lists sessions (optional search/limit); action="read" reads messages of a session (requires session_id).',
      parameters: {
        type: 'object',
        required: ['action'],
        properties: {
          action: { type: 'string', enum: ['list', 'read'], description: 'list = list sessions, read = read one session.' },
          session_id: { type: 'string', description: '[read REQUIRED] Session ID to read.' },
          max_messages: { type: 'integer', description: '[read] Max messages to return. Default: 50.' },
          limit: { type: 'integer', description: '[list] Max sessions to return. Default: 20.' },
          search: { type: 'string', description: '[list] Filter sessions by title keyword.' }
        }
      }
    }
  },
  // ══════════════════════════════════════════════
  // 浏览器控制（合并 9 个 browser_* 工具）
  // ══════════════════════════════════════════════
  {
    type: 'function',
    function: {
      name: 'browser',
      description: `Control the agent browser via action:
- open: {"action":"open","url":"https://example.com","wait_selector":"#main"}
- extract: {"action":"extract","selector":"article","max_chars":15000}
- screenshot: {"action":"screenshot","full_page":true} or {"selector":"#chart"}
- click: {"action":"click","selector":"button.submit","wait":true}
- type: {"action":"type","selector":"input[name=q]","text":"query","clear":true,"submit":true}
- scroll: {"action":"scroll","direction":"down"} or {"selector":"#footer"}
- wait: {"action":"wait","selector":".loaded"} or {"time_ms":1000}
- evaluate: {"action":"evaluate","js":"document.title"}
- close: {"action":"close"}`,
      parameters: {
        type: 'object',
        required: ['action'],
        properties: {
          action: { type: 'string', enum: ['open', 'extract', 'screenshot', 'click', 'type', 'scroll', 'wait', 'evaluate', 'close'], description: 'Browser action.' },
          url: { type: 'string', description: '[open REQUIRED] URL (http/https).' },
          wait_selector: { type: 'string', description: '[open] CSS selector to wait for after load.' },
          selector: { type: 'string', description: '[extract/click/type/scroll/wait/screenshot] CSS selector.' },
          max_chars: { type: 'integer', description: '[extract] Max characters. Default: 15000.' },
          full_page: { type: 'boolean', description: '[screenshot] Capture full page.' },
          wait: { type: 'boolean', description: '[click] Wait up to 10s for element.' },
          text: { type: 'string', description: '[type REQUIRED] Text to type.' },
          clear: { type: 'boolean', description: '[type] Clear input first. Default: true.' },
          submit: { type: 'boolean', description: '[type] Submit form after typing.' },
          direction: { type: 'string', enum: ['down', 'up', 'top', 'bottom'], description: '[scroll] Direction. Default: down.' },
          time_ms: { type: 'integer', description: '[wait] Fixed delay in ms. Default: 1000.' },
          js: { type: 'string', description: '[evaluate REQUIRED] JavaScript to execute.' }
        }
      }
    }
  },
];

// 支持三档开关的工具列表（auto/confirm/disabled）
// 浏览器工具不需要确认，永远自动执行
// 导出供 tools-modal.ts 等 UI 复用，保持单一事实来源
export const MODE_TOOLS = [
  'run_command',
  'write_file', 'delete_file',
  'edit_file', 'file_transfer',
  'download_file', 'compress',
];

export type ToolMode = 'auto' | 'confirm' | 'disabled';

/**
 * 子代理工具确认回调（由 agent-engine 在主循环生命周期内设置）。
 * 子代理与主 Agent 共用同一确认管线：全局模式为 confirm 时，
 * 子代理的写类工具同样需要用户确认，防止借道子代理绕过确认机制。
 */
let _subAgentConfirmHandler: ((call: ToolCall) => Promise<boolean>) | null = null;

export function setSubAgentConfirmHandler(handler: ((call: ToolCall) => Promise<boolean>) | null): void {
  _subAgentConfirmHandler = handler;
}

// 工具模式缓存：key=工具名, value=模式
const _toolModes = new Map<string, ToolMode>();

export function needsConfirmation(toolName: string): boolean {
  if (!MODE_TOOLS.includes(toolName)) return false;
  return getToolMode(toolName) === 'confirm';
}

/** 获取工具模式，默认 confirm */
export function getToolMode(toolName: string): ToolMode {
  return _toolModes.get(toolName) ?? 'confirm';
}

/** 设置工具执行模式 */
export function setToolMode(toolName: string, mode: ToolMode): void {
  _toolModes.set(toolName, mode);
  if (mode === 'disabled') {
    setToolEnabled(toolName, false);
  } else {
    setToolEnabled(toolName, true);
  }
}

/** 兼容旧接口：设置 run_command 执行模式 */
export function setRunCommandMode(mode: ToolMode): void {
  setToolMode('run_command', mode);
}

/** 初始化全局工具模式（从数据库加载） */
export function initGlobalToolMode(mode: ToolMode): void {
  for (const toolName of MODE_TOOLS) {
    setToolMode(toolName, mode);
  }
}

let enabledTools: Set<string> = new Set(TOOL_DEFINITIONS.map(def => def.function.name));

export function setToolEnabled(toolName: string, enabled: boolean): void {
  if (enabled) enabledTools.add(toolName);
  else enabledTools.delete(toolName);
}


export function getEnabledToolDefinitions(): ToolDefinition[] {
  const builtIn = TOOL_DEFINITIONS.filter(def => enabledTools.has(def.function.name));
  return [...builtIn, ..._mcpToolCache];
}

// R55: 语义工具检索 — 根据用户查询过滤相关工具，减少上下文占用

/** 核心工具集 — 始终包含的关键工具 */
const CORE_TOOLS = new Set([
  'read_file', 'write_file', 'list_directory', 'search_files', 'edit_file',
  'run_command', 'web_search', 'web_fetch', 'memory', 'git',
]);

/** 工具关键词映射 — 用于语义匹配 */
const TOOL_KEYWORDS: Record<string, string[]> = {
  read_file: ['read', 'file', '读取', '文件', '看', '查看', '内容', '打开文件', 'cat', 'less', 'head', 'tail', '批量读取', '多个文件'],
  write_file: ['write', 'file', '写入', '保存', '创建文件', '输出', '写入文件', '写入内容', 'echo', 'mkdir', '创建目录', '新建文件夹'],
  list_directory: ['list', 'directory', '目录', '文件夹', '列', 'ls', '列出', '查看目录', 'tree', '树', '目录结构', '层级'],
  search_files: ['search', 'find', '搜索', '查找', 'grep', '正则', '通配符', 'rg', 'ag'],
  delete_file: ['delete', 'remove', '删除', 'rm', '移除', '清空'],
  run_command: ['run', 'command', 'shell', '执行', '命令', '终端', 'cmd', 'powershell', 'bash', '脚本'],
  file_transfer: ['move', 'rename', 'copy', '移动', '重命名', 'mv', '复制', 'cp', '拷贝'],
  web_fetch: ['fetch', 'url', '网页', '抓取', '获取', '爬虫', '网页内容', '页面', '网址', '链接', '请求'],
  web_search: ['search', 'web', '搜索', '联网', '查', 'google', 'bing', '百度', '搜狗', '360', '查询', '在线搜索'],
  edit_file: ['edit', 'replace', '编辑', '替换', '修改', 'sed', '补丁', 'patch', '修改文件'],
  download_file: ['download', '下载', '保存到本地', '下载文件'],
  git: ['git', 'commit', 'push', 'pull', 'branch', '仓库', '版本控制', 'checkout', 'merge', 'diff', 'log', 'stash', 'tag'],
  compress: ['compress', 'zip', 'tar', '压缩', '解压', 'extract', '打包', '归档', '解压缩', 'gzip'],
  memory: ['memory', '记忆', 'remember', 'save', 'rule', '规则', '记住', '偏好', '事实', '遗忘', '回忆'],
  session: ['session', 'history', '会话', '历史', '历史记录', '会话列表', '读取会话'],
  spawn_task: ['sub', 'agent', 'delegate', '子代理', '委派', '并行', '子任务', '委派任务'],
  browser: ['browser', 'open', '浏览器', '打开网页', '访问', '浏览', '截图', '点击', '输入', '滚动', '等待', 'javascript'],
};

/** R55: 根据用户查询语义过滤工具定义，减少 token 占用 */
export function getRelevantToolDefinitions(userQuery: string): ToolDefinition[] {
  const allTools = getEnabledToolDefinitions();
  // 查询为空或很短时返回全部
  if (!userQuery || userQuery.length < 5) return allTools;

  const queryLower = userQuery.toLowerCase();
  const relevantTools = new Set<string>();

  // 核心工具始终包含
  for (const t of CORE_TOOLS) relevantTools.add(t);

  // 语义匹配
  for (const [toolName, keywords] of Object.entries(TOOL_KEYWORDS)) {
    if (relevantTools.has(toolName)) continue;
    for (const kw of keywords) {
      if (queryLower.includes(kw.toLowerCase())) {
        relevantTools.add(toolName);
        break;
      }
    }
  }

  // 如果匹配到的工具太少，返回全部（避免遗漏）
  if (relevantTools.size < 8) return allTools;

  const filtered = allTools.filter(t => relevantTools.has(t.function.name));
  // 确保不过度过滤 — 至少保留 60% 的工具
  if (filtered.length < allTools.length * 0.6) return allTools;

  return filtered;
}

/** MCP 工具缓存 */
let _mcpToolCache: ToolDefinition[] = [];

/** 刷新 MCP 工具缓存（在 MCP 服务器配置变更时调用） */
export async function refreshMCPTools(): Promise<void> {
  try {
    const rawTools = await getMCPToolDefinitions();
    // v5.1.2 Shadowing 防护：MCP 工具不能覆盖内置工具
    const builtInNames = new Set(TOOL_DEFINITIONS.map(d => d.function.name));
    const filtered = rawTools.filter(t => {
      if (builtInNames.has(t.function.name)) {
        logWarn(`MCP 工具 "${t.function.name}" 与内置工具重名，已跳过`);
        return false;
      }
      return true;
    });
    const skipped = rawTools.length - filtered.length;
    _mcpToolCache = filtered;
    if (filtered.length > 0) {
      logInfo(`MCP 工具已注册: ${filtered.length} 个${skipped > 0 ? `（${skipped} 个因重名被跳过）` : ''}`, filtered.map(t => t.function.name).join(', '));
    }
  } catch (err) {
    logError('MCP 工具刷新失败', (err as Error).message);
    _mcpToolCache = [];
  }
}

// ══════════════════════════════════════════════
// R21-R30: 工具系统增强
// ══════════════════════════════════════════════

// ── R28: 工具安全检查增强 ──

/** R28: 路径遍历攻击检测 — 检查路径中是否包含恶意 ../ 序列 */
function hasPathTraversal(path: string): boolean {
  if (!path) return false;
  // 检测 ../ 或 ..\ 模式（路径遍历攻击）
  const normalized = path.replace(/\\/g, '/');
  // 连续的 ../ 超过 2 层（正常相对路径很少超过 2 层）
  const traversalCount = (normalized.match(/\.\.\//g) || []).length;
  if (traversalCount > 3) return true;
  // 检测 ..\..\..\ 模式
  if (normalized.includes('../../../')) return true;
  return false;
}

/** R28: 危险命令关键词 — 命令替换中包含这些词才拦截 */
const DANGEROUS_CMD_KEYWORDS = 'rm|del|format|mkfs|dd|fdisk|shred|umount|chmod\\s+777|chown|shutdown|reboot|halt';

/** R28: 命令注入检测 — 仅拦截命令替换中包含危险命令的情况，避免误伤 $(date) 等合法用法 */
function hasCommandInjection(command: string): boolean {
  if (!command) return false;
  const dangerousPatterns = [
    /;\s*(rm|del|format|mkfs|dd)\s/i,       // 命令链中的删除操作
    /\|\s*(rm|del|format|mkfs)\s/i,         // 管道到删除操作
    /&&\s*(rm|del|format|mkfs)\s/i,         // AND链中的删除操作
    /\$\{.*IFS.*\}/i,                        // IFS 变量注入
    // 仅拦截命令替换中包含危险命令的情况，放行 $(date) 等合法用法
    new RegExp(`\\$\\([^)]*\\b(?:${DANGEROUS_CMD_KEYWORDS})\\b[^)]*\\)`, 'i'),
    new RegExp('`[^`]*\\b(?:' + DANGEROUS_CMD_KEYWORDS + ')\\b[^`]*`', 'i'),
    /\x00/,                                  // null 字节注入
  ];
  return dangerousPatterns.some(p => p.test(command));
}

/** R28: 工具安全验证 — 在执行前检查安全风险 */
export function validateToolSecurity(toolName: string, args: Record<string, unknown>): string | null {
  // R28: URL 检测 — 本地文件工具不接受 URL
  const localFileTools = ['read_file', 'write_file', 'edit_file', 'list_directory', 'search_files', 'delete_file', 'file_transfer'];
  if (localFileTools.includes(toolName)) {
    const pathFields = ['path', 'source', 'destination', 'file1', 'file2'];
    for (const field of pathFields) {
      if (typeof args[field] === 'string') {
        const val = (args[field] as string).toLowerCase().trim();
        if (val.startsWith('http://') || val.startsWith('https://')) {
          return `参数 "${field}" 是 URL，不是本地路径。请改用 web_fetch 工具读取网页内容: ${args[field]}`;
        }
      }
    }
    // paths 数组检查（read_file 批量读取）
    if (Array.isArray(args.paths)) {
      const urls = (args.paths as string[]).filter(p => {
        if (typeof p !== 'string') return false;
        const lower = p.toLowerCase().trim();
        return lower.startsWith('http://') || lower.startsWith('https://');
      });
      if (urls.length > 0) {
        return `paths 数组中包含 ${urls.length} 个 URL，read_file 仅支持本地文件。请改用 web_fetch 工具逐个抓取以下 URL:\n${urls.join('\n')}`;
      }
    }
  }

  // 路径遍历检查
  const pathFields = ['path', 'source', 'destination', 'file1', 'file2', 'cwd'];
  for (const field of pathFields) {
    if (typeof args[field] === 'string' && hasPathTraversal(args[field] as string)) {
      return `安全警告: 参数 "${field}" 包含可疑的路径遍历模式: ${args[field]}`;
    }
  }

  // 多路径参数检查（read_file 批量读取）
  if (Array.isArray(args.paths)) {
    for (const p of args.paths) {
      if (typeof p === 'string' && hasPathTraversal(p)) {
        return `安全警告: paths 数组中包含可疑的路径遍历模式: ${p}`;
      }
    }
  }

  // 命令注入检查
  if (toolName === 'run_command' && typeof args.command === 'string') {
    if (hasCommandInjection(args.command as string)) {
      return `安全警告: 命令中包含潜在的注入模式: ${args.command}`;
    }
  }

  // web_fetch / download_file URL 验证
  const urlFields = ['url'];
  for (const field of urlFields) {
    if (typeof args[field] === 'string') {
      const url = args[field] as string;
      // 阻止 file:// 协议（可能读取敏感本地文件）
      if (url.toLowerCase().startsWith('file://')) {
        return `安全警告: 不允许 file:// 协议`;
      }
      // 阻止内网 IP 访问（可选，取决于安全策略）
      // 192.168.x.x, 10.x.x.x, 172.16-31.x.x
      const internalIpPattern = /^(https?:\/\/)?(192\.168\.|10\.|172\.(1[6-9]|2[0-9]|3[01])\.|127\.|localhost)/i;
      if (internalIpPattern.test(url)) {
        // 内网访问仅警告不阻止
        logWarn(`R28: 访问内网地址: ${url}`);
      }
    }
  }

  return null; // 无安全风险
}

// ── R30: 工具使用统计导出 ──

/** R30: 工具使用统计热力图数据 */
export interface ToolHeatmapData {
  toolName: string;
  displayName: string;
  icon: string;
  totalCalls: number;
  successRate: number;
  avgDurationMs: number;
  heatLevel: number;  // 0-4, 0=未使用, 4=最常用
  lastUsed: number;
  errorCount: number;
}

/** R30: 获取工具使用热力图数据 */
export function getToolHeatmap(): ToolHeatmapData[] {
  const analytics = getToolAnalytics();
  const maxCalls = Math.max(1, ...analytics.map(a => a.totalCalls));

  // 合并所有已定义工具（包括未使用的）
  const allTools = new Map<string, ToolHeatmapData>();
  for (const def of TOOL_DEFINITIONS) {
    const name = def.function.name;
    allTools.set(name, {
      toolName: name,
      displayName: formatToolName(name),
      icon: getToolIcon(name),
      totalCalls: 0,
      successRate: 0,
      avgDurationMs: 0,
      heatLevel: 0,
      lastUsed: 0,
      errorCount: 0,
    });
  }

  // 填入分析数据
  for (const a of analytics) {
    const entry = allTools.get(a.toolName);
    if (entry) {
      entry.totalCalls = a.totalCalls;
      entry.successRate = a.successRate;
      entry.avgDurationMs = a.avgDurationMs;
      entry.lastUsed = a.lastUsed;
      entry.errorCount = a.errorCount;
    } else {
      // MCP 工具或未定义工具
      allTools.set(a.toolName, {
        toolName: a.toolName,
        displayName: a.toolName,
        icon: '🔧',
        totalCalls: a.totalCalls,
        successRate: a.successRate,
        avgDurationMs: a.avgDurationMs,
        heatLevel: 0,
        lastUsed: a.lastUsed,
        errorCount: a.errorCount,
      });
    }
  }

  // 计算热力等级
  const result = Array.from(allTools.values());
  for (const entry of result) {
    if (entry.totalCalls === 0) {
      entry.heatLevel = 0;
    } else {
      const ratio = entry.totalCalls / maxCalls;
      if (ratio > 0.75) entry.heatLevel = 4;
      else if (ratio > 0.5) entry.heatLevel = 3;
      else if (ratio > 0.25) entry.heatLevel = 2;
      else entry.heatLevel = 1;
    }
  }

  // 按使用次数降序排列
  result.sort((a, b) => b.totalCalls - a.totalCalls);
  return result;
}

// ── R21: 工具参数验证 ──

/** R21: 根据 schema 验证工具参数，返回错误消息列表 */
export function validateToolArgs(toolName: string, args: Record<string, unknown>): string[] {
  const def = TOOL_DEFINITIONS.find(d => d.function.name === toolName);
  if (!def) return []; // MCP 工具或未找到定义，跳过验证

  const params = def.function.parameters;
  const errors: string[] = [];

  // 检查必填参数
  if (params.required) {
    for (const req of params.required) {
      if (!(req in args) || args[req] === undefined || args[req] === null) {
        errors.push(`缺少必填参数: "${req}"`);
      }
    }
  }

  // 检查参数类型和枚举值
  for (const [key, value] of Object.entries(args)) {
    if (value === undefined || value === null) continue;
    const prop = params.properties[key];
    if (!prop) continue; // 未定义的参数，跳过

    // 类型检查
    if (prop.type === 'string' && typeof value !== 'string') {
      errors.push(`参数 "${key}" 应为字符串类型，实际为 ${typeof value}`);
    } else if (prop.type === 'integer' && (!Number.isInteger(Number(value)) || typeof value === 'boolean')) {
      errors.push(`参数 "${key}" 应为整数，实际为 ${JSON.stringify(value)}`);
    } else if (prop.type === 'boolean' && typeof value !== 'boolean') {
      errors.push(`参数 "${key}" 应为布尔值，实际为 ${typeof value}`);
    } else if (prop.type === 'array' && !Array.isArray(value)) {
      errors.push(`参数 "${key}" 应为数组，实际为 ${typeof value}`);
    } else if (prop.type === 'object' && (typeof value !== 'object' || Array.isArray(value))) {
      errors.push(`参数 "${key}" 应为对象，实际为 ${typeof value}`);
    }

    // 枚举值检查
    if (prop.enum && !prop.enum.includes(String(value))) {
      errors.push(`参数 "${key}" 值 "${value}" 不在允许范围内: ${prop.enum.join(', ')}`);
    }
  }

  return errors;
}

// ── R22: 工具结果截断 ──

/** R22: 工具结果最大字符数 */
const MAX_TOOL_RESULT_CHARS = 100000;

/** R22: 截断单个大字符串，保留首尾并添加截断标记 */
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

  // 1. 截断顶层大字符串字段
  const largeFields = ['stdout', 'content', 'text', 'result', 'output', 'data', 'formatted', 'snippet', 'error', 'stderr'];
  for (const field of largeFields) {
    if (typeof truncated[field] === 'string' && (truncated[field] as string).length > 10000) {
      truncated[field] = truncateStringField(truncated[field] as string);
    }
  }

  // 2. 截断数组内每条记录的大字符串字段（如 _fetched[].content, results[].snippet）
  const arrayFields = ['results', 'entries', '_fetched', 'structured', 'files', 'matches'];
  for (const field of arrayFields) {
    if (Array.isArray(truncated[field])) {
      const arr = truncated[field] as unknown[];
      // 数组本身过长时先裁剪条数
      if (arr.length > 50) {
        (truncated as any)[`_original_${field}_count`] = arr.length;
        (truncated as any)[field] = arr.slice(0, 50);
      }
      // 逐条截断内部大字段
      const innerLargeKeys = ['content', 'snippet', 'text', 'stdout', 'output', 'formatted', 'data', 'result', 'stderr'];
      for (const item of (truncated as any)[field]) {
        if (item && typeof item === 'object' && !Array.isArray(item)) {
          for (const key of innerLargeKeys) {
            if (typeof item[key] === 'string' && item[key].length > 8000) {
              item[key] = truncateStringField(item[key], 6000, 2000);
            }
          }
        }
      }
    }
  }

  // 3. 兜底：如果经过上述截断后仍然超限，直接返回结构化预览对象。
  // （旧实现拼接非法 JSON 后 JSON.parse 必然抛出异常）
  let finalStr = JSON.stringify(truncated);
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

// ── R23: 工具参数自动类型转换 ──

/** R23: 根据工具定义自动转换参数类型 */
export function coerceToolArgs(toolName: string, args: Record<string, unknown>): Record<string, unknown> {
  const def = TOOL_DEFINITIONS.find(d => d.function.name === toolName);
  if (!def) return args;

  const params = def.function.parameters;
  const coerced = { ...args };

  for (const [key, value] of Object.entries(coerced)) {
    if (value === undefined || value === null) continue;
    const prop = params.properties[key];
    if (!prop) continue;

    // 字符串数字 → 整数
    if (prop.type === 'integer' && typeof value === 'string') {
      const num = parseInt(value, 10);
      if (!isNaN(num)) {
        coerced[key] = num;
      }
    }
    // 字符串数字 → 数字
    else if (prop.type === 'number' && typeof value === 'string') {
      const num = parseFloat(value);
      if (!isNaN(num)) {
        coerced[key] = num;
      }
    }
    // 字符串布尔 → 布尔
    else if (prop.type === 'boolean' && typeof value === 'string') {
      if (value === 'true' || value === '1') coerced[key] = true;
      else if (value === 'false' || value === '0') coerced[key] = false;
    }
    // 数组：字符串 → 数组（逗号分隔）
    else if (prop.type === 'array' && typeof value === 'string') {
      try {
        coerced[key] = JSON.parse(value);
      } catch {
        // 如果不是 JSON，按逗号分隔
        coerced[key] = value.split(',').map(s => s.trim()).filter(Boolean);
      }
    }
    // 对象：字符串 → 对象
    else if (prop.type === 'object' && typeof value === 'string') {
      try {
        coerced[key] = JSON.parse(value);
      } catch {
        // 解析失败，保持原样
      }
    }
  }

  return coerced;
}

// ── R24: 工具错误恢复建议 ──

/** R24: 分析工具错误并给出修复建议 */
export function suggestToolFix(toolName: string, args: Record<string, unknown>, error: string): string {
  const err = error.toLowerCase();

  // 文件未找到
  if (err.includes('no such file') || err.includes('not found') || err.includes('文件不存在') || err.includes('enoent')) {
    const path = args.path || args.source || args.file1 || '';
    return `文件路径可能不正确: "${path}"。建议：1) 使用 list_directory 检查路径是否存在; 2) 检查拼写; 3) 尝试绝对路径。`;
  }

  // 权限拒绝
  if (err.includes('permission denied') || err.includes('eacces') || err.includes('权限')) {
    return `权限不足。建议：1) 检查文件/目录权限; 2) 确认工作空间路径是否正确; 3) 某些系统目录可能需要管理员权限。`;
  }

  // 路径无效
  if (err.includes('invalid path') || err.includes('illegal characters') || err.includes('路径无效')) {
    const path = args.path || args.destination || '';
    return `路径格式可能不正确: "${path}"。建议：1) 检查特殊字符; 2) Windows 路径使用反斜杠或正斜杠; 3) 确认路径在工作空间内。`;
  }

  // 网络错误
  if (err.includes('network') || err.includes('timeout') || err.includes('econnrefused') || err.includes('fetch')) {
    return `网络请求失败。建议：1) 检查 URL 是否正确; 2) 确认网络连接; 3) 某些站点可能需要使用 browser action="open" 工具代替 web_fetch。`;
  }

  // JSON 解析错误
  if (err.includes('json') || err.includes('parse') || err.includes('syntax')) {
    return `数据解析失败。建议：1) 使用 json_format 工具验证 JSON 格式; 2) 检查参数是否为有效的 JSON 字符串。`;
  }

  // Git 错误
  if (err.includes('git') || err.includes('not a repository')) {
    return `Git 操作失败。建议：1) 确认当前目录是 Git 仓库; 2) 使用 git status 检查仓库状态; 3) 检查分支名是否正确。`;
  }

  // 命令执行失败
  if (err.includes('command') || err.includes('exit code')) {
    return `命令执行失败。建议：1) 检查命令拼写; 2) 确认命令在当前系统可用; 3) 使用 cwd 参数指定正确的工作目录。`;
  }

  // 通用建议
  return '';
}

// ── R25: 工具执行分析追踪 ──

export interface ToolAnalytics {
  toolName: string;
  totalCalls: number;
  successCount: number;
  errorCount: number;
  avgDurationMs: number;
  lastUsed: number;
  commonErrors: Map<string, number>;
}

const _toolAnalytics = new Map<string, ToolAnalytics>();

/** R25: 记录工具执行分析数据 */
function recordToolAnalytics(toolName: string, success: boolean, durationMs: number, error?: string): void {
  let analytics = _toolAnalytics.get(toolName);
  if (!analytics) {
    analytics = {
      toolName,
      totalCalls: 0,
      successCount: 0,
      errorCount: 0,
      avgDurationMs: 0,
      lastUsed: 0,
      commonErrors: new Map(),
    };
    _toolAnalytics.set(toolName, analytics);
  }

  analytics.totalCalls++;
  if (success) analytics.successCount++;
  else {
    analytics.errorCount++;
    if (error) {
      // 记录常见错误模式（取前 100 字符作为 key）
      const errorKey = error.slice(0, 100);
      analytics.commonErrors.set(errorKey, (analytics.commonErrors.get(errorKey) || 0) + 1);
    }
  }

  // 更新平均执行时间（指数移动平均）
  const alpha = 0.2;
  analytics.avgDurationMs = analytics.avgDurationMs === 0
    ? durationMs
    : analytics.avgDurationMs * (1 - alpha) + durationMs * alpha;

  analytics.lastUsed = Date.now();
}

/** R25: 获取工具分析数据 */
export function getToolAnalytics(): Array<ToolAnalytics & { successRate: number; commonErrorsArray: Array<{ error: string; count: number }> }> {
  return Array.from(_toolAnalytics.values()).map(a => ({
    ...a,
    successRate: a.totalCalls > 0 ? a.successCount / a.totalCalls : 0,
    commonErrorsArray: Array.from(a.commonErrors.entries())
      .map(([error, count]) => ({ error, count }))
      .sort((a, b) => b.count - a.count)
      .slice(0, 5),
    commonErrors: undefined as any, // 避免序列化 Map
  }));
}

/** R25: 重置工具分析数据 */
export function resetToolAnalytics(): void {
  _toolAnalytics.clear();
}

// ── R26: 工具结果格式优化 ──

/** R26: 优化工具结果格式，提升 LLM 理解能力 */
function formatToolResult(toolName: string, result: ToolResult): ToolResult {
  if (!result.success) return result;

  // 为特定工具添加结构化摘要
  switch (toolName) {
    case 'list_directory': {
      // 目录列表添加统计摘要
      const entries = (result as any).entries || (result as any).items;
      if (Array.isArray(entries)) {
        const dirs = entries.filter((e: any) => e.type === 'directory').length;
        const files = entries.filter((e: any) => e.type === 'file').length;
        (result as any)._summary = `共 ${entries.length} 项 (${dirs} 个目录, ${files} 个文件)`;
      }
      break;
    }
    case 'search_files': {
      const results = (result as any).results || (result as any).matches;
      if (Array.isArray(results)) {
        (result as any)._summary = `找到 ${results.length} 个匹配结果`;
      }
      break;
    }
    case 'read_file': {
      // 读取文件添加行数统计
      const content = (result as any).content || '';
      if (typeof content === 'string') {
        const lines = content.split('\n').length;
        const chars = content.length;
        (result as any)._meta = `文件内容: ${lines} 行, ${chars} 字符`;
      }
      break;
    }
    case 'web_search': {
      const results = (result as any).results;
      if (Array.isArray(results)) {
        (result as any)._summary = `搜索返回 ${results.length} 条结果`;
      }
      break;
    }
  }

  return result;
}

export async function executeTool(toolName: string, args: Record<string, unknown>): Promise<ToolResult> {
  // MCP 工具路由
  if (toolName.startsWith('mcp_')) {
    const { executeMCPTool } = await import('./mcp-client.js');
    return executeMCPTool(toolName, args);
  }

  if (!enabledTools.has(toolName)) {
    logError(`工具未启用: ${toolName}`);
    return { success: false, error: `工具 ${toolName} 未启用` };
  }

  const bridge = window.metonaDesktop;
  if (!bridge?.isDesktop) {
    logError(`工具调用仅支持桌面版: ${toolName}`);
    return { success: false, error: '工具调用仅支持桌面版' };
  }

  // R23: 参数自动类型转换
  args = coerceToolArgs(toolName, args);

  // R21: 参数验证
  const validationErrors = validateToolArgs(toolName, args);
  if (validationErrors.length > 0) {
    logError(`工具参数验证失败: ${toolName}`, validationErrors.join('; '));
    return { success: false, error: `参数验证失败: ${validationErrors.join('; ')}` };
  }

  // R28: 安全验证 — 路径遍历、命令注入防护
  const securityWarning = validateToolSecurity(toolName, args);
  if (securityWarning) {
    logError(`R28: 工具安全拦截: ${toolName}`, securityWarning);
    return { success: false, error: securityWarning };
  }

  const startTime = Date.now();

  try {
    // 内存工具（不走 IPC，直接处理 MEMORY.md）
    if (toolName === 'memory') {
      const { search, addEntry, replaceEntry, removeEntry, removeEntries, loadAllEntries, DuplicateEntryError } = await import('./memory-service.js');
      const action = args.action as string;
      switch (action) {
        case 'search': {
          const query = args.query as string;
          // 未指定 limit 时默认 8（与工具 schema 描述一致）；
          // 旧实现 0=不限，模型省略参数会返回全部记忆撑爆上下文
          const rawLimit = args.limit as number | undefined;
          const limit = typeof rawLimit === 'number' && Number.isFinite(rawLimit) && rawLimit > 0
            ? Math.floor(rawLimit)
            : 8;
if (!query) return { success: false, error: '缺少 query 参数' };
const results = await search(query, limit);
          logToolResult('memory', true, `${results.length} 条结果`);
          return { success: true, action, results, total: results.length };
        }
        case 'add': {
          const type = (args.type as 'fact' | 'preference' | 'rule') || 'fact';  // 兜底默认 fact
          const content = args.content as string;
          const importance = (args.importance as number) || 5;
          const tags = (args.tags as string[]) || [];
          if (!content || content.length < 2) return { success: false, error: 'add 操作缺少 content 参数或内容太短。示例: {"action":"add","type":"fact","content":"具体的记忆内容"}' };
          try {
            const entry = await addEntry(type, content, importance, tags);
            logToolResult('memory', true, `${type}: ${content.slice(0, 50)}`);
            return { success: true, action, id: entry.id, type: entry.type, content: entry.content };
          } catch (err) {
            if (err instanceof DuplicateEntryError) {
              const dupErr = err as InstanceType<typeof DuplicateEntryError>;
              logToolResult('memory', true, `重复跳过: ${dupErr.existingPreview}`);
              return { success: true, action, duplicate: true, existing_id: dupErr.existingId, message: `已跳过: 相同内容的记忆已存在 (${dupErr.existingPreview})。不要再重复添加，任务已完成。` };
            }
            throw err;
          }
        }
        case 'replace': {
          const oldText = String(args.old_text || '');
          const newContent = String(args.new_content || '');
          const result = await replaceEntry(oldText, newContent);
          logToolResult('memory', result.success, result.message);
          return { success: result.success, action, ...(result.success ? {} : { error: result.message }), message: result.message };
        }
        case 'remove': {
          const oldText = String(args.old_text || '');
          const result = await removeEntry(oldText);
          logToolResult('memory', result.success, result.message);
          return { success: result.success, action, ...(result.success ? {} : { error: result.message }), message: result.message };
        }
        case 'remove_batch': {
          const oldTexts = Array.isArray(args.old_texts) ? args.old_texts.map(String) : [];
          if (oldTexts.length === 0) return { success: false, error: '缺少 old_texts 参数（字符串数组）' };
          const result = await removeEntries(oldTexts);
          logToolResult('memory', result.success, result.message);
          return { success: result.success, action, results: result.results, deleted: result.deleted, failed: result.failed, ...(result.success ? {} : { error: result.message }), message: result.message };
        }
        case 'read_all': {
          const entries = await loadAllEntries();
          logToolResult('memory', true, `${entries.length} 条记忆`);
          return { success: true, action, entries, total: entries.length };
        }
        default:
          return { success: false, error: `未知操作: ${action}。支持: search / add / replace / remove / read_all` };
      }
    }
    if (toolName === 'session') {
      const bridge = window.metonaDesktop;
      if (!bridge?.db) return { success: false, error: '桌面 API 不可用' };
      const action = args.action as string || 'list';
      if (action === 'list') {
        const limit = (args.limit as number) || 0;
        const search = (args.search as string) || '';
        const summaries = await bridge.db.getSessionSummaries();
        let filtered = summaries.map((s: { id: string; title: string; model: string; message_count: number; created_at: number; updated_at: number }) => ({
          id: s.id,
          title: s.title,
          model: s.model,
          messageCount: s.message_count,
          createdAt: s.created_at,
          updatedAt: s.updated_at
        }));
        if (search) {
          filtered = filtered.filter(s => s.title.toLowerCase().includes(search.toLowerCase()));
        }
        filtered.sort((a: { updatedAt: number }, b: { updatedAt: number }) => b.updatedAt - a.updatedAt);
        if (limit > 0) filtered = filtered.slice(0, limit);
        logToolResult('session', true, `${filtered.length} 个会话`);
        return { success: true, action: 'list', sessions: filtered, total: filtered.length };
      }
      if (action === 'read') {
        const sessionId = args.session_id as string;
        const maxMessages = (args.max_messages as number) || 0;
        if (!sessionId) return { success: false, error: '缺少 session_id 参数' };
        const session = await bridge.db.getSession(sessionId);
        if (!session) return { success: false, error: `会话 ${sessionId} 不存在` };
        const messages = await bridge.db.getMessages(sessionId);
        const msgs = (maxMessages > 0 ? messages.slice(0, maxMessages) : messages).map((m: any) => ({
          role: m.role,
          content: m.content || '',
          timestamp: m.created_at
        }));
        logToolResult('session', true, `${msgs.length} 条消息`);
        return { success: true, action: 'read', session: { id: session.id, title: session.title, model: session.model }, messages: msgs, total: messages.length };
      }
      return { success: false, error: `未知 action: ${action}。支持: list / read` };
    }

    // v4.3 spawn_task 走子代理（模型只能从设置面板指定，不允许 AI 自选）
    if (toolName === 'spawn_task') {
      const { executeSubAgent } = await import('./sub-agent.js');
      const task = args.task as string;
      const context = args.context as string | undefined;
      // 只使用设置面板配置的子代理模型，忽略 AI 传入的 model 参数
      const configuredModel = state.get<string>('subAgentModel', '');
      let model: string | undefined;
      if (configuredModel) {
        // 设置面板存的模型名直接使用（面板加载时已验证过列表）
        model = configuredModel;
      }
      if (!task) return { success: false, error: '缺少 task 参数' };
      // 权限上限：AI 请求的权限只降不升，封顶于用户设置的 subAgentMaxPermission。
      // 防止提示注入让 AI 自授 full_write 绕过权限分级。
      const PERMISSION_RANK: Record<SubAgentPermission, number> = { readonly: 0, limited_write: 1, full_write: 2 };
      const requested = (args.permission as SubAgentPermission | undefined) ?? 'readonly';
      const maxAllowed = state.get<SubAgentPermission>('subAgentMaxPermission', 'readonly');
      const permission: SubAgentPermission = (PERMISSION_RANK[requested] ?? 0) <= (PERMISSION_RANK[maxAllowed] ?? 0)
        ? requested
        : maxAllowed;
      logInfo(`子代理委派: ${task.slice(0, 80)}${model ? ` (模型: ${model})` : ' (跟随当前模型)'} (权限: ${permission}, 上限: ${maxAllowed})`);
      const result = await executeSubAgent(task, context, { model, permission, confirmHandler: _subAgentConfirmHandler ?? undefined });
      logToolResult('spawn_task', result.success, result.success ? `完成, ${(result as any).loops} 轮` : result.error);
      return result;
    }

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

    // 其他工具：IPC 调用（无超时，由 renderer 内部处理）
    const result = await bridge.tool.execute(toolName, args);
    logToolResult(toolName, result.success, result.success ? undefined : result.error);

    // R22: 截断大输出结果
    const truncatedResult = truncateToolResult(result, toolName);
    // R26: 优化结果格式
    const formattedResult = formatToolResult(toolName, truncatedResult);

    // R25: 记录分析数据
    const duration = Date.now() - startTime;
    recordToolAnalytics(toolName, formattedResult.success, duration, formattedResult.error);

    return formattedResult;
  } catch (err) {
    const duration = Date.now() - startTime;
    const errorMsg = (err as Error).message;
    logError(`工具异常: ${toolName}`, errorMsg);

    // R24: 生成错误恢复建议
    const suggestion = suggestToolFix(toolName, args, errorMsg);
    // R25: 记录分析数据
    recordToolAnalytics(toolName, false, duration, errorMsg);

    return { success: false, error: suggestion ? `${errorMsg}\n\n💡 建议: ${suggestion}` : errorMsg };
  }
}

export function getToolIcon(name: string): string {
  const icons: Record<string, string> = {
    read_file: '📄', write_file: '✏️', list_directory: '📁',
    search_files: '🔍', delete_file: '🗑️', run_command: '💻',
    file_transfer: '📦', web_fetch: '🌐',
    edit_file: '✂️', download_file: '⬇️',
    git: '🔖', compress: '🗜️', web_search: '🔍',
    memory: '🧠',
    session: '📖', spawn_task: '🤖',
    browser: '🌐',
    diff: '🔍',
  };
  return icons[name] || '🔧';
}

export function formatToolName(name: string): string {
  const names: Record<string, string> = {
    read_file: '读取文件', write_file: '写入文件', list_directory: '列出目录',
    search_files: '搜索文件', delete_file: '删除文件',
    run_command: '执行命令', file_transfer: '复制/移动',
    web_fetch: '网页抓取', edit_file: '编辑文件',
    download_file: '下载文件',
    git: 'Git 操作', compress: '压缩/解压', web_search: '联网搜索',
    memory: '记忆管理',
    session: '会话读取', spawn_task: '子代理委派',
    browser: '浏览器控制',
    diff: '文件差异',
  };
  return names[name] || name;
}
