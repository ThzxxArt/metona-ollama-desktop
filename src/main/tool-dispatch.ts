/**
 * Tool Dispatch — 主进程工具分发注册表（0.18.0：18 个内置工具）
 *
 * 工具合并：
 * - read_file 同时处理单文件与 paths 批量
 * - list_directory 的 format=tree 走目录树实现
 * - file_transfer 处理 copy / move
 * - browser 用 action 分发到 9 个浏览器操作
 *
 * run_command 因需要独立管理日志与实时输出流，仍由 ipc/tools.ts 特殊处理。
 */

import {
  handleReadFile,
  handleWriteFile,
  handleListDir,
  handleSearchFiles,
  handleDeleteFile,
  handleWebFetch,
  handleWebSearch,
  handleEditFile,
  handleTree,
  handleDownloadFile,
  handleReadMultipleFiles,
  handleGit,
  handleCompress,
  handleDiff,
  handleMoveFile,
  handleCopyFile,
} from './tool-handlers.js';
import {
  browserOpen, browserScreenshot, browserEvaluate, browserExtract,
  browserClick, browserType, browserScroll, browserWait, browserClose,
} from './browser.js';
import type { ToolResult } from './tool-handlers-shared.js';

type Args = Record<string, unknown>;
export type ToolHandler = (args: Args) => Promise<ToolResult> | ToolResult;

const BROWSER_ACTIONS: Record<string, ToolHandler> = {
  open: (a) => browserOpen(a.url as string, a.wait_selector as string | undefined),
  screenshot: (a) => browserScreenshot({ full_page: a.full_page as boolean, selector: a.selector as string }),
  evaluate: (a) => browserEvaluate(a.js as string),
  extract: (a) => browserExtract({ selector: a.selector as string, max_chars: a.max_chars as number }),
  click: (a) => browserClick(a.selector as string, (a.wait as boolean) || false),
  type: (a) => browserType(a.selector as string, a.text as string, a.clear !== false, (a.submit as boolean) || false),
  scroll: (a) => browserScroll({ direction: a.direction as string, selector: a.selector as string }),
  wait: (a) => browserWait({ selector: a.selector as string, time_ms: a.time_ms as number }),
  close: () => browserClose().then(() => ({ success: true })),
};

export const MAIN_TOOL_HANDLERS: Record<string, ToolHandler> = {
  // ── 文件系统（18 个内置工具中的文件类）──
  read_file: (a) => {
    if (Array.isArray(a.paths) && a.paths.length > 0) {
      return handleReadMultipleFiles({
        paths: a.paths as string[],
        max_chars_per_file: a.max_chars_per_file as number | undefined,
      });
    }
    return handleReadFile(a as { path: string; encoding?: string; start_line?: number; end_line?: number; mode?: string; offset_bytes?: number; limit_bytes?: number });
  },
  write_file: (a) => handleWriteFile(a as { path: string; content: string; encoding?: string; mode?: string }),
  list_directory: (a) => {
    if (a.format === 'tree') {
      return handleTree({
        path: a.path as string,
        max_depth: a.max_depth as number | undefined,
        include_hidden: a.include_hidden as boolean | undefined,
      });
    }
    return handleListDir(a as { path: string; recursive?: boolean; max_depth?: number; include_hidden?: boolean; filter_extension?: string; limit?: number; offset?: number });
  },
  search_files: (a) => handleSearchFiles(a as { path: string; query: string; search_type?: string; case_sensitive?: boolean; use_regex?: boolean; max_results?: number; file_extensions?: string[] }),
  edit_file: (a) => handleEditFile(a as { path: string; old_text: string; new_text: string; all?: boolean; use_regex?: boolean }),
  delete_file: (a) => handleDeleteFile(a as { path?: string; paths?: string[]; recursive?: boolean }),
  file_transfer: (a) => {
    if (a.operation === 'move') {
      return handleMoveFile({ source: a.source as string, destination: a.destination as string });
    }
    if (a.operation === 'copy') {
      return handleCopyFile({
        source: a.source as string,
        destination: a.destination as string,
        recursive: a.recursive as boolean | undefined,
      });
    }
    return { success: false, error: 'operation 必须为 copy 或 move' };
  },
  download_file: (a) => handleDownloadFile(a as { url: string; destination: string }),
  compress: (a) => handleCompress(a as { action: string; path: string; destination?: string; format?: string }),
  diff: (a) => handleDiff(a as { mode: 'file_vs_file' | 'file_vs_content' | 'file_vs_git_head'; path1?: string; path2?: string; content?: string; context_lines?: number }),

  // ── 系统 / 网络 ──
  web_fetch: (a) => handleWebFetch(a as { url: string; max_chars?: number; extract_mode?: string; mobile_ua?: boolean; retry?: boolean }),
  web_search: (a) => handleWebSearch(a as { query: string; max_results?: number; time_range?: string; enhance_snippets?: boolean; fetch_top?: number }),

  // ── Git ──
  git: (a) => handleGit(a as { action: string; path?: string; files?: string[]; message?: string; branch?: string; tag_name?: string; stash_sub?: string; remote?: string; remote_url?: string; count?: number; all?: boolean; staged?: boolean; new_branch?: boolean; delete_branch?: boolean; force?: boolean; url?: string }),

  // ── 浏览器控制（单工具多 action）──
  browser: (a) => {
    const action = String(a.action || '');
    const handler = BROWSER_ACTIONS[action];
    if (!handler) {
      return { success: false, error: `未知 browser action: ${action}。支持: ${Object.keys(BROWSER_ACTIONS).join(' / ')}` };
    }
    return handler(a);
  },
};

/** 获取工具执行器（run_command 不在此注册，由 ipc.ts 特殊处理） */
export function getToolHandler(name: string): ToolHandler | undefined {
  return MAIN_TOOL_HANDLERS[name];
}

/** 判断是否为已知主进程工具 */
export function isKnownTool(name: string): boolean {
  return name === 'run_command' || name in MAIN_TOOL_HANDLERS;
}

export type { ToolResult };
