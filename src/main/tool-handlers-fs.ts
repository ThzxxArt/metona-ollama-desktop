/**
 * Tool Handlers - 文件系统操作
 */

import * as fs from 'fs/promises';
import * as path from 'path';
import { spawn } from 'child_process';
import { checkPathAllowed } from './tool-security.js';
import { sendLog, resolvePath, type ToolResult } from './tool-handlers-shared.js';

export async function handleReadFile(params: { path: string; encoding?: string; start_line?: number; end_line?: number; mode?: string; offset_bytes?: number; limit_bytes?: number }): Promise<ToolResult> {
  try {
    const filePath = resolvePath(params.path);
    const allowed = checkPathAllowed(filePath, 'read');
    if (!allowed.ok) return { success: false, error: allowed.reason };

    const stat = await fs.stat(filePath);
    const MAX_SIZE = params.mode === 'binary' ? 50 * 1024 * 1024 : 5 * 1024 * 1024; // 二进制50MB，文本5MB
    if (stat.size > MAX_SIZE) {
      return { success: false, error: `文件过大 (${(stat.size / 1024 / 1024).toFixed(1)}MB)，最大支持 ${MAX_SIZE / 1024 / 1024}MB` };
    }

    const mode = params.mode || 'text';

    // ── 二进制模式：返回 base64 ──
    if (mode === 'binary') {
      const buf = await fs.readFile(filePath);
      let resultBuf = buf;
      let truncated = false;
      let byteRange: [number, number] = [0, buf.length];

      if (params.offset_bytes !== undefined || params.limit_bytes !== undefined) {
        const offset = params.offset_bytes || 0;
        const limit = params.limit_bytes || Math.min(100 * 1024, buf.length - offset); // 默认100KB
        const end = Math.min(buf.length, offset + limit);
        resultBuf = buf.subarray(offset, end);
        byteRange = [offset, end];
        truncated = end < buf.length;
      } else if (buf.length > 100 * 1024) {
        resultBuf = buf.subarray(0, 100 * 1024);
        byteRange = [0, 100 * 1024];
        truncated = true;
      }

      const ext = path.extname(filePath).toLowerCase();
      return {
        success: true,
        path: filePath,
        content: resultBuf.toString('base64'),
        encoding: 'base64',
        mode: 'binary',
        size: stat.size,
        bytes_read: resultBuf.length,
        byte_range: byteRange,
        truncated,
        ...(truncated && {
          remaining_bytes: stat.size - byteRange[1],
          hint: `文件共 ${stat.size} 字节(${(stat.size / 1024 / 1024).toFixed(1)}MB)，已返回 ${byteRange[1]} 字节。使用 offset_bytes=${byteRange[1]} 继续读取后续内容。`
        }),
        mime_hint: extToMime(ext),
      };
    }

    // ── 文本模式 ──
    const encoding = (params.encoding as BufferEncoding) || 'utf-8';

    // 字节分页优先
    if (params.offset_bytes !== undefined || params.limit_bytes !== undefined) {
      const offset = params.offset_bytes || 0;
      const limit = params.limit_bytes || 50000;
      const fd = await fs.open(filePath, 'r');
      try {
        const buf = Buffer.alloc(Math.min(limit, stat.size - offset));
        await fd.read(buf, 0, buf.length, offset);
        const content = buf.toString(encoding);
        const contentLines = content.split('\n');
        const end = offset + buf.length;
        const truncated = end < stat.size;
        return {
          success: true,
          path: filePath,
          content,
          encoding,
          mode: 'text',
          size: stat.size,
          lines: contentLines.length,
          byte_range: [offset, end],
          truncated,
          ...(truncated && {
            remaining_bytes: stat.size - end,
            hint: `文件共 ${stat.size} 字节，已返回 ${offset}-${end} 的内容。使用 offset_bytes=${end} 继续读取。`
          }),
        };
      } finally {
        await fd.close();
      }
    }

    // 按行读取
    const content = await fs.readFile(filePath, encoding);
    const lines = content.split('\n');
    const defaultLimit = 2000;

    let resultContent = content;
    let lineRange: [number, number] = [1, lines.length];
    let truncated = false;

    if (params.start_line || params.end_line) {
      const start = Math.max(1, params.start_line || 1) - 1;
      const end = Math.min(lines.length, params.end_line || Math.min(start + defaultLimit, lines.length));
      resultContent = lines.slice(start, end).join('\n');
      lineRange = [start + 1, end];
      truncated = end < lines.length;
    } else if (lines.length > defaultLimit) {
      resultContent = lines.slice(0, defaultLimit).join('\n');
      lineRange = [1, defaultLimit];
      truncated = true;
    }

    return {
      success: true,
      path: filePath,
      content: resultContent,
      encoding,
      mode: 'text',
      size: stat.size,
      lines: lines.length,
      line_range: lineRange,
      truncated,
      ...(truncated && {
        remaining_lines: lines.length - lineRange[1],
        hint: `文件共 ${lines.length} 行，已返回第 ${lineRange[0]}-${lineRange[1]} 行。使用 start_line=${lineRange[1] + 1} 继续读取后续内容。`
      }),
    };
  } catch (err) {
    return { success: false, error: (err as Error).message };
  }
}

/** 扩展名 → MIME 类型 */
function extToMime(ext: string): string {
  const map: Record<string, string> = {
    '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg',
    '.gif': 'image/gif', '.webp': 'image/webp', '.svg': 'image/svg+xml',
    '.pdf': 'application/pdf', '.zip': 'application/zip',
    '.gz': 'application/gzip', '.tar': 'application/x-tar',
    '.mp4': 'video/mp4', '.mp3': 'audio/mpeg', '.wav': 'audio/wav',
    '.json': 'application/json', '.xml': 'application/xml',
    '.html': 'text/html', '.css': 'text/css', '.js': 'application/javascript',
    '.ts': 'text/typescript', '.py': 'text/x-python',
    '.wasm': 'application/wasm', '.bin': 'application/octet-stream',
    '.woff2': 'font/woff2', '.ttf': 'font/ttf',
  };
  return map[ext] || 'application/octet-stream';
}

export async function handleWriteFile(params: { path: string; content: string; encoding?: string; mode?: string }): Promise<ToolResult> {
  try {
    const filePath = resolvePath(params.path);
    const allowed = checkPathAllowed(filePath, 'write');
    if (!allowed.ok) return { success: false, error: allowed.reason };

    const writeMode = params.mode || 'overwrite';
    const encoding = (params.encoding as BufferEncoding) || 'utf-8';

    // ── base64 解码：支持写入二进制文件 ──
    let writeBuffer: Buffer;
    let contentLength: number;
    if (encoding === 'base64') {
      writeBuffer = Buffer.from(params.content, 'base64');
      contentLength = writeBuffer.length;
    } else {
      writeBuffer = Buffer.from(params.content, encoding);
      contentLength = Buffer.byteLength(params.content, encoding);
    }

    const MAX_SIZE = writeMode === 'append' ? 5 * 1024 * 1024 : 10 * 1024 * 1024;
    if (contentLength > MAX_SIZE) {
      return { success: false, error: `内容过大 (${(contentLength / 1024 / 1024).toFixed(1)}MB)，最大支持 ${MAX_SIZE / 1024 / 1024}MB` };
    }

    // ── 检查目标文件状态 ──
    let existed = false;
    let prevSize = 0;
    let prevLines = 0;
    try {
      const prevStat = await fs.stat(filePath);
      existed = true;
      prevSize = prevStat.size;
      if (writeMode === 'overwrite' && !params.encoding?.startsWith('base64')) {
        const prevContent = await fs.readFile(filePath, 'utf-8');
        prevLines = prevContent.split('\n').length;
      }
    } catch {
      // 文件不存在，正常
    }

    const dir = path.dirname(filePath);
    sendLog('info', `✏️ write_file 开始`, `${filePath} (${contentLength}B, ${writeMode})`);
    await fs.mkdir(dir, { recursive: true });

    if (writeMode === 'append') {
      await fs.appendFile(filePath, writeBuffer);
    } else {
      await fs.writeFile(filePath, writeBuffer);
    }

    // ── 读回统计 ──
    const stat = await fs.stat(filePath);
    const lines = encoding === 'base64' ? 0 : (await fs.readFile(filePath, 'utf-8')).split('\n').length;

    return {
      success: true,
      path: filePath,
      bytesWritten: contentLength,
      totalSize: stat.size,
      lines,
      mode: writeMode,
      created: !existed,
      ...(existed && writeMode === 'overwrite' && {
        overwrote: true,
        prevSize,
        ...(prevLines > 0 && { prevLines }),
      }),
      ...(writeMode === 'append' && {
        appended: true,
        prevSize,
      }),
    };
  } catch (err) {
    return { success: false, error: (err as Error).message };
  }
}

export async function handleListDir(params: { path: string; recursive?: boolean; max_depth?: number; include_hidden?: boolean; filter_extension?: string; offset?: number }): Promise<ToolResult> {
  try {
    const dirPath = resolvePath(params.path);
    const allowed = checkPathAllowed(dirPath, 'read');
    if (!allowed.ok) return { success: false, error: allowed.reason };

    const maxEntries = 2000;
    const startOffset = params.offset || 0;
    const entries: Array<{ name: string; type: string; size: number | null; modified: string }> = [];
    let truncated = false;
    let skipped = 0;

    async function scanDir(dir: string, depth: number): Promise<void> {
      if (entries.length >= maxEntries) { truncated = true; return; }
      if (params.recursive && params.max_depth && depth > params.max_depth) return;

      const items = await fs.readdir(dir, { withFileTypes: true });
      for (const item of items) {
        if (entries.length >= maxEntries) { truncated = true; return; }
        if (!params.include_hidden && item.name.startsWith('.')) continue;
        if (params.filter_extension && item.isFile() && !item.name.endsWith(params.filter_extension)) continue;

        // 分页：跳过前 offset 个条目
        if (skipped < startOffset) { skipped++; continue; }

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
    return {
      success: true, path: dirPath, entries, total: entries.length,
      truncated, offset: startOffset
    };
  } catch (err) {
    return { success: false, error: (err as Error).message };
  }
}

export async function handleSearchFiles(params: { path: string; query: string; search_type?: string; case_sensitive?: boolean; max_results?: number; file_extensions?: string[]; use_regex?: boolean }): Promise<ToolResult> {
  try {
    const rootPath = resolvePath(params.path);
    const allowed = checkPathAllowed(rootPath, 'read');
    if (!allowed.ok) return { success: false, error: allowed.reason };

    const searchType = params.search_type || 'both';
    const caseSensitive = params.case_sensitive || false;
    const useRegex = params.use_regex || false;
    const maxResults = params.max_results || 50;
    const query = params.query; // 保持原始，正则用 flags 控制大小写

    // 构建搜索匹配器
    let contentMatcher: (line: string) => boolean;
    if (useRegex) {
      try {
        const flags = caseSensitive ? '' : 'i';
        const regex = new RegExp(query, flags);
        contentMatcher = (line: string) => regex.test(line);
      } catch {
        return { success: false, error: '无效的正则表达式: ' + query };
      }
    } else {
      const q = caseSensitive ? query : query.toLowerCase();
      contentMatcher = (line: string) => (caseSensitive ? line : line.toLowerCase()).includes(q);
    }

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
            if (contentMatcher(lines[i])) {
              const col = useRegex ? 1 : (caseSensitive ? lines[i] : lines[i].toLowerCase()).indexOf(caseSensitive ? query : query.toLowerCase());
              fileMatches.push({ line: i + 1, text: lines[i].trim(), column: Math.max(1, col + 1) });
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
    const dirPath = resolvePath(params.path);
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
    const filePath = resolvePath(params.path);
    const allowed = checkPathAllowed(filePath, 'write');
    if (!allowed.ok) return { success: false, error: allowed.reason };

    const stat = await fs.stat(filePath);
    const isDir = stat.isDirectory();
    let deletedSize = stat.size;
    let deletedCount = 1;

    if (isDir) {
      // 统计目录内容
      let fileCount = 0;
      async function countDir(dir: string): Promise<void> {
        const items = await fs.readdir(dir, { withFileTypes: true });
        for (const item of items) {
          const fp = path.join(dir, item.name);
          try {
            const s = await fs.stat(fp);
            deletedSize += s.size;
            if (item.isFile()) fileCount++;
            else if (item.isDirectory()) await countDir(fp);
          } catch { /* skip */ }
        }
      }
      await countDir(filePath);
      deletedCount = fileCount;

      if (params.recursive) {
        await fs.rm(filePath, { recursive: true, force: true });
      } else {
        await fs.rmdir(filePath);
      }
    } else {
      await fs.unlink(filePath);
    }

    return {
      success: true, path: filePath, deleted: true,
      type: isDir ? 'directory' : 'file',
      ...(isDir && { filesDeleted: deletedCount }),
      deletedSize,
    };
  } catch (err) {
    return { success: false, error: (err as Error).message };
  }
}

export async function handleEditFile(params: { path: string; old_text: string; new_text: string; all?: boolean; use_regex?: boolean }): Promise<ToolResult> {
  try {
    const filePath = resolvePath(params.path);
    const allowed = checkPathAllowed(filePath, 'write');
    if (!allowed.ok) return { success: false, error: allowed.reason };

    const content = await fs.readFile(filePath, 'utf-8');

    let replaceCount: number;
    let newContent: string;

    if (params.use_regex) {
      try {
        const regex = new RegExp(params.old_text, params.all ? 'g' : '');
        if (!regex.test(content)) {
          return { success: false, error: '未找到匹配正则的文本' };
        }
        // 重新创建 regex 因为 test() 会消耗 lastIndex（带g标志时）
        const re = new RegExp(params.old_text, params.all ? 'g' : '');
        const matches = content.match(re);
        replaceCount = matches ? matches.length : 1;
        const finalRe = new RegExp(params.old_text, params.all ? 'g' : '');
        newContent = content.replace(finalRe, params.new_text);
      } catch (regexErr) {
        return { success: false, error: `无效的正则表达式: ${(regexErr as Error).message}` };
      }
    } else {
      if (!content.includes(params.old_text)) {
        return { success: false, error: '未找到要替换的文本' };
      }
      if (params.all) {
        const parts = content.split(params.old_text);
        replaceCount = parts.length - 1;
        newContent = parts.join(params.new_text);
      } else {
        replaceCount = 1;
        newContent = content.replace(params.old_text, params.new_text);
      }
    }

    sendLog('info', `✂️ edit_file`, `${filePath} (${replaceCount} 处替换${params.use_regex ? ', 正则模式' : ''})`);
    await fs.writeFile(filePath, newContent, 'utf-8');
    sendLog('success', `✂️ edit_file 完成`, `${newContent.length}B`);
    return { success: true, path: filePath, replaceCount, newSize: newContent.length, regex: params.use_regex || false };
  } catch (err) {
    sendLog('error', `✂️ edit_file 失败`, (err as Error).message);
    return { success: false, error: (err as Error).message };
  }
}

export async function handleGetFileInfo(params: { path: string }): Promise<ToolResult> {
  try {
    const filePath = resolvePath(params.path);
    const allowed = checkPathAllowed(filePath, 'read');
    if (!allowed.ok) return { success: false, error: allowed.reason };

    const stat = await fs.stat(filePath);
    return {
      success: true,
      path: filePath,
      name: path.basename(filePath),
      type: stat.isDirectory() ? 'directory' : stat.isFile() ? 'file' : 'other',
      size: stat.size,
      created: stat.birthtime.toISOString(),
      modified: stat.mtime.toISOString(),
      accessed: stat.atime.toISOString(),
      permissions: (stat.mode & 0o777).toString(8)
    };
  } catch (err) {
    return { success: false, error: (err as Error).message };
  }
}

export async function handleTree(params: { path: string; max_depth?: number; include_hidden?: boolean }): Promise<ToolResult> {
  try {
    const rootPath = resolvePath(params.path);
    const allowed = checkPathAllowed(rootPath, 'read');
    if (!allowed.ok) return { success: false, error: allowed.reason };

    const maxDepth = params.max_depth || 5;
    const includeHidden = params.include_hidden || false;
    const lines: string[] = [];
    let fileCount = 0;
    let dirCount = 0;

    async function walk(dir: string, prefix: string, depth: number): Promise<void> {
      if (depth > maxDepth) return;
      let items;
      try { items = await fs.readdir(dir, { withFileTypes: true }); } catch { return; }

      const filtered = items
        .filter(i => includeHidden || !i.name.startsWith('.'))
        .sort((a, b) => {
          if (a.isDirectory() && !b.isDirectory()) return -1;
          if (!a.isDirectory() && b.isDirectory()) return 1;
          return a.name.localeCompare(b.name);
        });

      for (let i = 0; i < filtered.length; i++) {
        const item = filtered[i];
        const isLast = i === filtered.length - 1;
        const connector = isLast ? '└── ' : '├── ';
        const icon = item.isDirectory() ? '📁' : '📄';
        lines.push(`${prefix}${connector}${icon} ${item.name}`);
        if (item.isDirectory()) {
          dirCount++;
          const childPrefix = prefix + (isLast ? '    ' : '│   ');
          await walk(path.join(dir, item.name), childPrefix, depth + 1);
        } else {
          fileCount++;
        }
      }
    }

    lines.push(`📁 ${path.basename(rootPath)}/`);
    await walk(rootPath, '', 1);

    return {
      success: true,
      path: rootPath,
      tree: lines.join('\n'),
      fileCount,
      dirCount
    };
  } catch (err) {
    return { success: false, error: (err as Error).message };
  }
}


/** 运行 shell 命令并返回 stdout/stderr */
function runShell(cmd: string, args: string[]): Promise<{ stdout: string; stderr: string; code: number }> {
  return new Promise((resolve) => {
    const proc = spawn(cmd, args, { stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = '', stderr = '';
    proc.stdout.on('data', (d: Buffer) => { stdout += d.toString(); });
    proc.stderr.on('data', (d: Buffer) => { stderr += d.toString(); });
    proc.on('close', (code) => resolve({ stdout, stderr, code: code ?? 1 }));
    proc.on('error', (err) => resolve({ stdout, stderr: err.message, code: 1 }));
  });
}

export async function handleDiffFiles(params: { file1: string; file2: string; context_lines?: number }): Promise<ToolResult> {
  try {
    const path1 = resolvePath(params.file1);
    const path2 = resolvePath(params.file2);
    const check1 = checkPathAllowed(path1, 'read');
    if (!check1.ok) return { success: false, error: check1.reason };
    const check2 = checkPathAllowed(path2, 'read');
    if (!check2.ok) return { success: false, error: check2.reason };

    const contextSize = params.context_lines || 3;
    let diffOutput = '';
    let usedCommand = '';

    // 1) 优先使用系统 diff 命令
    const diffResult = await runShell('diff', ['-u', `-U${contextSize}`, path1, path2]);
    if (diffResult.code <= 1) { // diff exits 0=identical, 1=different
      diffOutput = diffResult.stdout;
      usedCommand = 'diff -u';
    }

    // 2) diff 不可用，尝试 git diff
    if (!usedCommand) {
      const gitResult = await runShell('git', ['diff', `--unified=${contextSize}`, '--no-index', path1, path2]);
      if (gitResult.code <= 1) {
        diffOutput = gitResult.stdout;
        usedCommand = 'git diff';
      }
    }

    // 3) 回退到内置简易 diff
    if (!usedCommand) {
      diffOutput = builtinDiff(path1, path2, contextSize);
      usedCommand = 'builtin';
    }

    const hasChanges = diffOutput.trim().length > 0;
    return {
      success: true,
      file1: path1,
      file2: path2,
      diff: diffOutput,
      hasChanges,
      method: usedCommand
    };
  } catch (err) {
    return { success: false, error: (err as Error).message };
  }
}

/** 内置简易 diff（回退方案） */
function builtinDiff(path1: string, path2: string, contextSize: number): string {
  const fsSync = require('fs');
  const content1 = fsSync.readFileSync(path1, 'utf-8');
  const content2 = fsSync.readFileSync(path2, 'utf-8');
  const lines1 = content1.split('\n');
  const lines2 = content2.split('\n');

  const diffLines: string[] = [];
  let i = 0, j = 0;
  while (i < lines1.length || j < lines2.length) {
    if (i < lines1.length && j < lines2.length && lines1[i] === lines2[j]) {
      if (diffLines.length === 0 || diffLines[diffLines.length - 1].startsWith('-') || diffLines[diffLines.length - 1].startsWith('+')) {
        const ctxStart = Math.max(0, i - contextSize);
        for (let k = ctxStart; k < i; k++) diffLines.push(` ${lines1[k]}`);
      }
      diffLines.push(` ${lines1[i]}`);
      i++; j++;
    } else {
      let found = false;
      for (let look = 1; look <= 10 && i + look < lines1.length; look++) {
        if (lines1[i + look] === lines2[j]) {
          for (let k = 0; k < look; k++) diffLines.push(`-${lines1[i + k]}`);
          i += look; found = true; break;
        }
      }
      if (!found) {
        for (let look = 1; look <= 10 && j + look < lines2.length; look++) {
          if (lines1[i] === lines2[j + look]) {
            for (let k = 0; k < look; k++) diffLines.push(`+${lines2[j + k]}`);
            j += look; found = true; break;
          }
        }
      }
      if (!found) {
        if (i < lines1.length) { diffLines.push(`-${lines1[i]}`); i++; }
        if (j < lines2.length) { diffLines.push(`+${lines2[j]}`); j++; }
      }
    }
  }
  return diffLines.join('\n');
}

export async function handleReplaceInFiles(params: { path: string; glob: string; old_text: string; new_text: string }): Promise<ToolResult> {
  try {
    const rootPath = resolvePath(params.path);
    const allowed = checkPathAllowed(rootPath, 'write');
    if (!allowed.ok) return { success: false, error: allowed.reason };

    // 简单 glob 匹配
    const pattern = params.glob.replace(/\./g, '\\.').replace(/\*/g, '.*').replace(/\?/g, '.');
    const regex = new RegExp(`^${pattern}$`);

    const results: Array<{ file: string; replacements: number }> = [];
    let totalReplacements = 0;
    const maxFiles = 200;
    let fileCount = 0;

    async function scanDir(dir: string): Promise<void> {
      if (fileCount >= maxFiles) return;
      let items;
      try { items = await fs.readdir(dir, { withFileTypes: true }); } catch { return; }

      for (const item of items) {
        if (fileCount >= maxFiles) return;
        if (item.name.startsWith('.')) continue;
        const fullPath = path.join(dir, item.name);

        if (item.isDirectory()) {
          await scanDir(fullPath);
        } else if (regex.test(item.name)) {
          fileCount++;
          try {
            const content = await fs.readFile(fullPath, 'utf-8');
            if (content.includes(params.old_text)) {
              const parts = content.split(params.old_text);
              const count = parts.length - 1;
              const newContent = parts.join(params.new_text);
              await fs.writeFile(fullPath, newContent, 'utf-8');
              results.push({ file: path.relative(rootPath, fullPath), replacements: count });
              totalReplacements += count;
            }
          } catch { /* skip unreadable */ }
        }
      }
    }

    await scanDir(rootPath);

    return {
      success: true,
      pattern: params.glob,
      filesChanged: results.length,
      totalReplacements,
      results,
      truncated: fileCount >= maxFiles
    };
  } catch (err) {
    return { success: false, error: (err as Error).message };
  }
}

export async function handleReadMultipleFiles(params: { paths: string[]; max_chars_per_file?: number }): Promise<ToolResult> {
  try {
    const maxChars = params.max_chars_per_file || 10000;

    // 并行读取所有文件（最多50个）
    const filesToRead = params.paths.slice(0, 50).map(async (p) => {
      const filePath = resolvePath(p);
      const allowed = checkPathAllowed(filePath, 'read');
      if (!allowed.ok) {
        return { path: p, success: false, error: allowed.reason };
      }
      try {
        const stat = await fs.stat(filePath);
        if (stat.size > 1024 * 1024) {
          return { path: p, success: false, error: '文件超过 1MB' };
        }
        let content = await fs.readFile(filePath, 'utf-8');
        const lines = content.split('\n').length;
        if (content.length > maxChars) content = content.slice(0, maxChars) + '\n... (已截断)';
        return { path: p, success: true, content, lines };
      } catch (err) {
        return { path: p, success: false, error: (err as Error).message };
      }
    });

    const results = await Promise.all(filesToRead);

    return { success: true, files: results, total: results.length };
  } catch (err) {
    return { success: false, error: (err as Error).message };
  }
}

export async function handleMoveFile(params: { source: string; destination: string }): Promise<ToolResult> {
  try {
    const src = resolvePath(params.source);
    const dest = resolvePath(params.destination);
    const srcCheck = checkPathAllowed(src, 'read');
    if (!srcCheck.ok) return { success: false, error: srcCheck.reason };
    const destCheck = checkPathAllowed(dest, 'write');
    if (!destCheck.ok) return { success: false, error: destCheck.reason };

    sendLog('info', `📦 move_file`, `${src} → ${dest}`);
    await fs.rename(src, dest);
    sendLog('success', `📦 move_file 完成`, dest);
    return { success: true, source: src, destination: dest };
  } catch (err) {
    sendLog('error', `📦 move_file 失败`, (err as Error).message);
    return { success: false, error: (err as Error).message };
  }
}

export async function handleCopyFile(params: { source: string; destination: string; recursive?: boolean }): Promise<ToolResult> {
  try {
    const src = resolvePath(params.source);
    const dest = resolvePath(params.destination);
    const srcCheck = checkPathAllowed(src, 'read');
    if (!srcCheck.ok) return { success: false, error: srcCheck.reason };
    const destCheck = checkPathAllowed(dest, 'write');
    if (!destCheck.ok) return { success: false, error: destCheck.reason };

    const stat = await fs.stat(src);
    sendLog('info', `📋 copy_file`, `${src} → ${dest}${stat.isDirectory() ? ' (目录)' : ''}`);
    if (stat.isDirectory()) {
      await fs.cp(src, dest, { recursive: params.recursive !== false });
    } else {
      const destDir = path.dirname(dest);
      await fs.mkdir(destDir, { recursive: true });
      await fs.copyFile(src, dest);
    }
    sendLog('success', `📋 copy_file 完成`, dest);
    return { success: true, source: src, destination: dest, isDirectory: stat.isDirectory() };
  } catch (err) {
    sendLog('error', `📋 copy_file 失败`, (err as Error).message);
    return { success: false, error: (err as Error).message };
  }
}
