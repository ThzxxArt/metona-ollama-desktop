/**
 * Tool Handlers - 主进程工具执行器
 * 所有文件系统操作在此执行，通过 IPC 被渲染进程调用
 */

import * as fs from 'fs/promises';
import * as path from 'path';
import { checkPathAllowed, checkCommandAllowed } from './tool-security.js';
import { execWorkspaceCommand } from './workspace.js';

export interface ToolResult {
  success: boolean;
  [key: string]: unknown;
}

export async function handleReadFile(params: { path: string; encoding?: string; start_line?: number; end_line?: number }): Promise<ToolResult> {
  try {
    const filePath = path.resolve(params.path);
    const allowed = checkPathAllowed(filePath, 'read');
    if (!allowed.ok) return { success: false, error: allowed.reason };

    const stat = await fs.stat(filePath);
    if (stat.size > 1024 * 1024) {
      return { success: false, error: `文件过大 (${(stat.size / 1024 / 1024).toFixed(1)}MB)，最大支持 1MB` };
    }

    const encoding = (params.encoding as BufferEncoding) || 'utf-8';
    const content = await fs.readFile(filePath, encoding);
    const lines = content.split('\n');

    let resultContent = content;
    let lineRange: [number, number] = [1, lines.length];
    let truncated = false;

    if (params.start_line || params.end_line) {
      const start = Math.max(1, params.start_line || 1) - 1;
      const end = Math.min(lines.length, params.end_line || Math.min(start + 500, lines.length));
      resultContent = lines.slice(start, end).join('\n');
      lineRange = [start + 1, end];
      truncated = end < lines.length;
    } else if (lines.length > 500) {
      resultContent = lines.slice(0, 500).join('\n');
      lineRange = [1, 500];
      truncated = true;
    }

    return {
      success: true,
      path: filePath,
      content: resultContent,
      encoding,
      size: stat.size,
      lines: lines.length,
      truncated,
      line_range: lineRange
    };
  } catch (err) {
    return { success: false, error: (err as Error).message };
  }
}

export async function handleWriteFile(params: { path: string; content: string; encoding?: string }): Promise<ToolResult> {
  try {
    const filePath = path.resolve(params.path);
    const allowed = checkPathAllowed(filePath, 'write');
    if (!allowed.ok) return { success: false, error: allowed.reason };

    if (params.content.length > 5 * 1024 * 1024) {
      return { success: false, error: '内容过大，最大支持 5MB' };
    }

    let created = false;
    try {
      await fs.stat(filePath);
    } catch {
      created = true;
    }

    const dir = path.dirname(filePath);
    await fs.mkdir(dir, { recursive: true });

    await fs.writeFile(filePath, params.content, (params.encoding as BufferEncoding) || 'utf-8');

    return {
      success: true,
      path: filePath,
      bytesWritten: Buffer.byteLength(params.content, (params.encoding as BufferEncoding) || 'utf-8'),
      created
    };
  } catch (err) {
    return { success: false, error: (err as Error).message };
  }
}

export async function handleListDir(params: { path: string; recursive?: boolean; max_depth?: number; include_hidden?: boolean; filter_extension?: string }): Promise<ToolResult> {
  try {
    const dirPath = path.resolve(params.path);
    const allowed = checkPathAllowed(dirPath, 'read');
    if (!allowed.ok) return { success: false, error: allowed.reason };

    const maxEntries = 500;
    const entries: Array<{ name: string; type: string; size: number | null; modified: string }> = [];
    let truncated = false;

    async function scanDir(dir: string, depth: number): Promise<void> {
      if (entries.length >= maxEntries) { truncated = true; return; }
      if (params.recursive && params.max_depth && depth > params.max_depth) return;

      const items = await fs.readdir(dir, { withFileTypes: true });
      for (const item of items) {
        if (entries.length >= maxEntries) { truncated = true; return; }
        if (!params.include_hidden && item.name.startsWith('.')) continue;
        if (params.filter_extension && item.isFile() && !item.name.endsWith(params.filter_extension)) continue;

        const fullPath = path.join(dir, item.name);
        const stat = await fs.stat(fullPath);
        entries.push({
          name: params.recursive ? path.relative(dirPath, fullPath) : item.name,
          type: item.isDirectory() ? 'directory' : 'file',
          size: item.isFile() ? stat.size : null,
          modified: stat.mtime.toISOString()
        });

        if (params.recursive && item.isDirectory()) {
          await scanDir(fullPath, depth + 1);
        }
      }
    }

    await scanDir(dirPath, 1);
    return { success: true, path: dirPath, entries, total: entries.length, truncated };
  } catch (err) {
    return { success: false, error: (err as Error).message };
  }
}

export async function handleSearchFiles(params: { path: string; query: string; search_type?: string; case_sensitive?: boolean; max_results?: number; file_extensions?: string[] }): Promise<ToolResult> {
  try {
    const rootPath = path.resolve(params.path);
    const allowed = checkPathAllowed(rootPath, 'read');
    if (!allowed.ok) return { success: false, error: allowed.reason };

    const searchType = params.search_type || 'both';
    const caseSensitive = params.case_sensitive || false;
    const maxResults = params.max_results || 50;
    const query = caseSensitive ? params.query : params.query.toLowerCase();

    const results: Array<{ path: string; matches: Array<{ line: number; text: string; column?: number }> }> = [];
    let totalMatches = 0;
    let filesScanned = 0;
    const maxScanFiles = 1000;

    async function collectFiles(dir: string): Promise<string[]> {
      const files: string[] = [];
      let items;
      try { items = await fs.readdir(dir, { withFileTypes: true }); } catch { return files; }
      for (const item of items) {
        if (filesScanned >= maxScanFiles) return files;
        if (item.name.startsWith('.')) continue;
        const fullPath = path.join(dir, item.name);
        if (item.isDirectory()) {
          files.push(...(await collectFiles(fullPath)));
        } else {
          if (params.file_extensions?.length) {
            const ext = path.extname(item.name);
            if (!params.file_extensions.includes(ext)) continue;
          }
          files.push(fullPath);
          filesScanned++;
        }
      }
      return files;
    }

    const allFiles = await collectFiles(rootPath);

    for (const filePath of allFiles) {
      if (totalMatches >= maxResults) break;

      if (searchType === 'filename' || searchType === 'both') {
        const fileName = path.basename(filePath);
        const nameToCheck = caseSensitive ? fileName : fileName.toLowerCase();
        if (nameToCheck.includes(query)) {
          results.push({ path: filePath, matches: [{ line: 0, text: `[文件名匹配] ${fileName}` }] });
          totalMatches++;
          continue;
        }
      }

      if (searchType === 'content' || searchType === 'both') {
        try {
          const stat = await fs.stat(filePath);
          if (stat.size > 500 * 1024) continue;

          const content = await fs.readFile(filePath, 'utf-8');
          const lines = content.split('\n');
          const fileMatches: Array<{ line: number; text: string; column: number }> = [];

          for (let i = 0; i < lines.length && fileMatches.length < 10; i++) {
            const lineToCheck = caseSensitive ? lines[i] : lines[i].toLowerCase();
            const col = lineToCheck.indexOf(query);
            if (col !== -1) {
              fileMatches.push({ line: i + 1, text: lines[i].trim(), column: col + 1 });
              totalMatches++;
            }
          }

          if (fileMatches.length > 0) {
            results.push({ path: filePath, matches: fileMatches });
          }
        } catch { /* skip unreadable files */ }
      }
    }

    return {
      success: true,
      query: params.query,
      search_type: searchType,
      results,
      total_files: allFiles.length,
      total_matches: totalMatches,
      truncated: totalMatches >= maxResults
    };
  } catch (err) {
    return { success: false, error: (err as Error).message };
  }
}

export async function handleCreateDir(params: { path: string }): Promise<ToolResult> {
  try {
    const dirPath = path.resolve(params.path);
    const allowed = checkPathAllowed(dirPath, 'write');
    if (!allowed.ok) return { success: false, error: allowed.reason };

    await fs.mkdir(dirPath, { recursive: true });
    return { success: true, path: dirPath, created: true };
  } catch (err) {
    return { success: false, error: (err as Error).message };
  }
}

export async function handleDeleteFile(params: { path: string; recursive?: boolean }): Promise<ToolResult> {
  try {
    const filePath = path.resolve(params.path);
    const allowed = checkPathAllowed(filePath, 'write');
    if (!allowed.ok) return { success: false, error: allowed.reason };

    const stat = await fs.stat(filePath);
    if (stat.isDirectory()) {
      if (params.recursive) {
        await fs.rm(filePath, { recursive: true, force: true });
      } else {
        await fs.rmdir(filePath);
      }
    } else {
      await fs.unlink(filePath);
    }

    return { success: true, path: filePath, deleted: true };
  } catch (err) {
    return { success: false, error: (err as Error).message };
  }
}

export async function handleRunCommand(params: { command: string; cwd?: string; timeout?: number }): Promise<ToolResult> {
  try {
    const cmdCheck = checkCommandAllowed(params.command);
    if (!cmdCheck.ok) return { success: false, error: cmdCheck.reason };

    // 通过 workspace 子进程执行，复用安全检查和进程管理
    const result = await execWorkspaceCommand(params.command, params.cwd);

    return {
      success: result.success,
      stdout: result.stdout,
      stderr: result.stderr,
      exitCode: result.exitCode,
      duration: result.duration
    };
  } catch (err) {
    const error = err as { message: string };
    return {
      success: false,
      stdout: '',
      stderr: error.message,
      exitCode: 1,
      error: error.message
    };
  }
}
