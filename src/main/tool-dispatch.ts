/**
 * Tool Dispatch — 主进程工具分发注册表
 *
 * 新增工具的接线点收敛为两处：
 * - 渲染端 tool-registry.ts：工具定义（schema）+ 启用开关
 * - 此处：主进程执行器
 *
 * run_command 因需要独立管理日志与实时输出流，仍由 ipc.ts 特殊处理。
 */

import {
  handleReadFile,
  handleWriteFile,
  handleListDir,
  handleSearchFiles,
  handleCreateDir,
  handleDeleteFile,
  handleMoveFile,
  handleCopyFile,
  handleWebFetch,
  handleWebSearch,
  handleEditFile,
  handleTree,
  handleDownloadFile,
  handleReadMultipleFiles,
  handleGit,
  handleCompress,
  handleDiff,
} from './tool-handlers.js';
import { handleCalculator } from './calculator.js';
import {
  browserOpen, browserScreenshot, browserEvaluate, browserExtract,
  browserClick, browserType, browserScroll, browserWait,
} from './browser.js';
import type { ToolResult } from './tool-handlers-shared.js';

type Args = Record<string, unknown>;
export type ToolHandler = (args: Args) => Promise<ToolResult> | ToolResult;

export const MAIN_TOOL_HANDLERS: Record<string, ToolHandler> = {
  // ── 文件系统 ──
  read_file: a => handleReadFile(a as { path: string; encoding?: string; start_line?: number; end_line?: number; mode?: string; offset_bytes?: number; limit_bytes?: number }),
  write_file: a => handleWriteFile(a as { path: string; content: string; encoding?: string; mode?: string }),
  list_directory: a => handleListDir(a as { path: string; recursive?: boolean; max_depth?: number; include_hidden?: boolean; filter_extension?: string; limit?: number; offset?: number }),
  search_files: a => handleSearchFiles(a as { path: string; query: string; search_type?: string; case_sensitive?: boolean; use_regex?: boolean; max_results?: number; file_extensions?: string[] }),
  create_directory: a => handleCreateDir(a as { path: string }),
  delete_file: a => handleDeleteFile(a as { path?: string; paths?: string[]; recursive?: boolean }),
  move_file: a => handleMoveFile(a as { source: string; destination: string }),
  copy_file: a => handleCopyFile(a as { source: string; destination: string; recursive?: boolean }),
  edit_file: a => handleEditFile(a as { path: string; old_text: string; new_text: string; all?: boolean; use_regex?: boolean }),
  tree: a => handleTree(a as { path: string; max_depth?: number; include_hidden?: boolean }),
  download_file: a => handleDownloadFile(a as { url: string; destination: string }),
  read_multiple_files: a => handleReadMultipleFiles(a as { paths: string[]; max_chars_per_file?: number }),
  diff: a => handleDiff(a as { mode: 'file_vs_file' | 'file_vs_content' | 'file_vs_git_head'; path1?: string; path2?: string; content?: string; context_lines?: number }),

  // ── 系统 / 网络 ──
  web_fetch: a => handleWebFetch(a as { url: string; max_chars?: number; extract_mode?: string; mobile_ua?: boolean; retry?: boolean }),
  web_search: a => handleWebSearch(a as { query: string; max_results?: number; time_range?: string; enhance_snippets?: boolean; fetch_top?: number }),
  compress: a => handleCompress(a as { action: string; path: string; destination?: string; format?: string }),
  calculator: a => handleCalculator(a as { expression: string }),

  // ── Git ──
  git: a => handleGit(a as { action: string; path?: string; files?: string[]; message?: string; branch?: string; tag_name?: string; stash_sub?: string; remote?: string; remote_url?: string; count?: number; all?: boolean; staged?: boolean; new_branch?: boolean; delete_branch?: boolean; force?: boolean; url?: string }),

  // ── 浏览器控制 ──
  browser_open: a => browserOpen(a.url as string, a.wait_selector as string | undefined),
  browser_screenshot: a => browserScreenshot({ full_page: a.full_page as boolean, selector: a.selector as string }),
  browser_evaluate: a => browserEvaluate(a.js as string),
  browser_extract: a => browserExtract({ selector: a.selector as string, max_chars: a.max_chars as number }),
  browser_click: a => browserClick(a.selector as string, (a.wait as boolean) || false),
  browser_type: a => browserType(a.selector as string, a.text as string, a.clear !== false, (a.submit as boolean) || false),
  browser_scroll: a => browserScroll({ direction: a.direction as string, selector: a.selector as string }),
  browser_wait: a => browserWait({ selector: a.selector as string, time_ms: a.time_ms as number }),
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
