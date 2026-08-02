/**
 * Tool Handlers - 文件系统操作
 */

import * as fs from 'fs/promises';
import * as path from 'path';
import * as os from 'os';
import { checkPathAllowed } from './tool-security.js';
import { sendLog, resolvePath, isUrl, type ToolResult } from './tool-handlers-shared.js';
import { getWorkspaceDir } from './workspace.js';

export async function handleReadFile(params: { path: string; encoding?: string; start_line?: number; end_line?: number; mode?: string; offset_bytes?: number; limit_bytes?: number }): Promise<ToolResult> {
  try {
    // URL 检测：read_file 仅支持本地文件，URL 请使用 web_fetch
    if (isUrl(params.path)) {
      return { success: false, error: `read_file 仅支持本地文件路径，不支持 URL。请改用 web_fetch 工具读取网页内容。收到的 URL: ${params.path}` };
    }
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
        const limit = params.limit_bytes || buf.length - offset;
        const end = Math.min(buf.length, offset + limit);
        resultBuf = buf.subarray(offset, end);
        byteRange = [offset, end];
        truncated = end < buf.length;
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

    let resultContent = content;
    let lineRange: [number, number] = [1, lines.length];
    let truncated = false;

    if (params.start_line || params.end_line) {
      const start = Math.max(1, params.start_line || 1) - 1;
      const end = Math.min(lines.length, params.end_line || lines.length);
      resultContent = lines.slice(start, end).join('\n');
      lineRange = [start + 1, end];
      truncated = end < lines.length;
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
    if (!params.path || typeof params.path !== 'string') {
      const wsDir = getWorkspaceDir();
      const homeDir = os.homedir();
      const absExample = process.platform === 'win32'
        ? `${homeDir}\\Documents\\file.txt`
        : `${homeDir}/file.txt`;
      return { success: false, error: `缺少 path 参数。请指定文件路径，相对路径基于工作空间 ${wsDir}。例如: "output.txt" 或 "${absExample}"` };
    }
    if (params.content === undefined || params.content === null) {
      return { success: false, error: '缺少 content 参数，请指定要写入的内容' };
    }
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

    const startOffset = params.offset || 0;
    const MAX_ENTRIES = 2000;
    const entries: Array<{ name: string; type: string; size: number | null; modified: string }> = [];
    let truncated = false;
    let skipped = 0;

    async function scanDir(dir: string, depth: number): Promise<void> {
      if (truncated) return;
      if (params.recursive && params.max_depth && depth > params.max_depth) return;

      const items = await fs.readdir(dir, { withFileTypes: true });
      for (const item of items) {
        if (truncated) return;
        if (!params.include_hidden && item.name.startsWith('.')) continue;
        if (params.filter_extension && item.isFile() && !item.name.endsWith(params.filter_extension)) continue;

        const fullPath = path.join(dir, item.name);

        // 递归模式下先递归子目录，再做分页跳过（避免跳过目录时丢失子树）
        if (params.recursive && item.isDirectory()) {
          await scanDir(fullPath, depth + 1);
          continue;
        }

        // 分页：跳过前 offset 个条目（仅对非目录条目计数）
        if (skipped < startOffset) { skipped++; continue; }

        // 截断保护：超过 2000 条标记 truncated
        if (entries.length >= MAX_ENTRIES) { truncated = true; return; }

        const stat = await fs.stat(fullPath);
        entries.push({
          name: params.recursive ? path.relative(dirPath, fullPath) : item.name,
          type: item.isDirectory() ? 'directory' : 'file',
          size: item.isFile() ? stat.size : null,
          modified: stat.mtime.toISOString()
        });
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
    const maxResults = params.max_results || 0; // 0 = 不限制
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
      if (maxResults > 0 && totalMatches >= maxResults) break;

      if (searchType === 'filename' || searchType === 'both') {
        const fileName = path.basename(filePath);
        let nameMatched: boolean;
        if (useRegex) {
          nameMatched = contentMatcher(fileName);
        } else {
          const nameToCheck = caseSensitive ? fileName : fileName.toLowerCase();
          const queryToCheck = caseSensitive ? query : query.toLowerCase();
          nameMatched = nameToCheck.includes(queryToCheck);
        }
        if (nameMatched) {
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

          for (let i = 0; i < lines.length; i++) {
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
      truncated: maxResults > 0 && totalMatches >= maxResults
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

export async function handleDeleteFile(params: { path?: string; paths?: string[]; recursive?: boolean }): Promise<ToolResult> {
  // 收集所有要删除的路径
  const allPaths: string[] = [];
  if (params.paths && Array.isArray(params.paths) && params.paths.length > 0) {
    allPaths.push(...params.paths);
  }
  if (params.path) {
    allPaths.push(params.path);
  }
  if (allPaths.length === 0) {
    return { success: false, error: '未提供 path 或 paths 参数' };
  }

  // 单个路径 — 保持原逻辑（返回单个结果）
  if (allPaths.length === 1) {
    return handleDeleteSingle(allPaths[0], params.recursive);
  }

  // 批量删除
  const results: Array<{ path: string; success: boolean; error?: string; type?: string; deletedSize?: number; filesDeleted?: number }> = [];
  let totalDeletedSize = 0;
  let totalFilesDeleted = 0;
  let successCount = 0;
  let failCount = 0;

  for (const p of allPaths) {
    const result = await handleDeleteSingle(p, params.recursive);
    if (result.success) {
      successCount++;
      totalDeletedSize += (result as Record<string, unknown>).deletedSize as number || 0;
      totalFilesDeleted += (result as Record<string, unknown>).filesDeleted as number || 1;
      results.push({
        path: (result as Record<string, unknown>).path as string,
        success: true,
        type: (result as Record<string, unknown>).type as string,
        deletedSize: (result as Record<string, unknown>).deletedSize as number,
        ...((result as Record<string, unknown>).filesDeleted !== undefined && { filesDeleted: (result as Record<string, unknown>).filesDeleted as number }),
      });
    } else {
      failCount++;
      results.push({ path: p, success: false, error: (result as Record<string, unknown>).error as string });
    }
  }

  return {
    success: failCount === 0,
    batch: true,
    totalPaths: allPaths.length,
    successCount,
    failCount,
    results,
    deletedSize: totalDeletedSize,
    ...(totalFilesDeleted > 0 && { filesDeleted: totalFilesDeleted }),
    ...(failCount > 0 && { error: `${failCount} 个路径删除失败` }),
  };
}

/** 删除单个文件或目录 */
async function handleDeleteSingle(rawPath: string, recursive?: boolean): Promise<ToolResult> {
  try {
    const filePath = resolvePath(rawPath);
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

      if (recursive) {
        await fs.rm(filePath, { recursive: true, force: true });
      } else {
        await fs.rmdir(filePath);
      }
    } else {
      await fs.unlink(filePath);
    }

    return {
      success: true, path: filePath, deleted: true,
      message: `已删除${isDir ? '目录' : '文件'}：${filePath}`,
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
    if (content.length > 5 * 1024 * 1024) {
      return { success: false, error: `文件过大 (${(content.length / 1024 / 1024).toFixed(1)}MB)，最大支持 5MB` };
    }

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

export async function handleReadMultipleFiles(params: { paths: string[]; max_chars_per_file?: number }): Promise<ToolResult> {
  try {
    // URL 检测：read_multiple_files 仅支持本地文件，URL 请使用 web_fetch
    const urlPaths = (params.paths || []).filter(p => isUrl(p));
    if (urlPaths.length > 0) {
      return {
        success: false,
        error: `read_multiple_files 仅支持本地文件路径，不支持 URL。以下路径是 URL，请改用 web_fetch 工具逐个抓取：\n${urlPaths.join('\n')}`
      };
    }
    const maxChars = params.max_chars_per_file || 0; // 0 = 不截断

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
        if (maxChars > 0 && content.length > maxChars) content = content.slice(0, maxChars) + '\n... (已截断)';
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

/**
 * diff 工具：比较文件差异，返回 unified diff 格式
 * 支持三种模式：file_vs_file / file_vs_content / file_vs_git_head
 */
export async function handleDiff(params: {
  mode: 'file_vs_file' | 'file_vs_content' | 'file_vs_git_head';
  path1?: string;
  path2?: string;
  content?: string;
  context_lines?: number;
}): Promise<ToolResult> {
  try {
    const mode = params.mode || 'file_vs_file';
    const contextLines = params.context_lines ?? 3;
    const MAX_LINES = 5000;

    // 获取左侧内容（文件1）
    let leftLabel: string;
    let leftContent: string;

    if (mode === 'file_vs_file' || mode === 'file_vs_content' || mode === 'file_vs_git_head') {
      if (!params.path1) return { success: false, error: 'path1 参数必填' };
      const filePath1 = resolvePath(params.path1);
      const check1 = checkPathAllowed(filePath1, 'read');
      if (!check1.ok) return { success: false, error: check1.reason };

      const stat1 = await fs.stat(filePath1);
      if (stat1.isDirectory()) return { success: false, error: `${filePath1} 是目录，不是文件` };
      if (stat1.size > 5 * 1024 * 1024) return { success: false, error: `文件过大 (${(stat1.size / 1024 / 1024).toFixed(1)}MB)，最大支持 5MB` };

      if (mode === 'file_vs_git_head') {
        // git HEAD 版本
        leftLabel = `a/${path.basename(filePath1)} (HEAD)`;
        try {
          const { execFile } = await import('child_process');
          const gitResult = await new Promise<string>((resolve, reject) => {
            execFile('git', ['show', `HEAD:${params.path1}`], {
              cwd: path.dirname(filePath1),
              maxBuffer: 5 * 1024 * 1024,
              encoding: 'utf-8',
            }, (err, stdout) => {
              if (err) reject(err);
              else resolve(stdout);
            });
          });
          leftContent = gitResult;
        } catch {
          return { success: false, error: '无法获取 git HEAD 版本（确保文件在 git 仓库中且有提交历史）' };
        }
      } else {
        leftLabel = `a/${path.basename(filePath1)}`;
        leftContent = await fs.readFile(filePath1, 'utf-8');
      }
    } else {
      return { success: false, error: `不支持的 mode: ${mode}` };
    }

    // 获取右侧内容
    let rightLabel: string;
    let rightContent: string;

    if (mode === 'file_vs_file') {
      if (!params.path2) return { success: false, error: 'file_vs_file 模式下 path2 参数必填' };
      const filePath2 = resolvePath(params.path2);
      const check2 = checkPathAllowed(filePath2, 'read');
      if (!check2.ok) return { success: false, error: check2.reason };

      const stat2 = await fs.stat(filePath2);
      if (stat2.isDirectory()) return { success: false, error: `${filePath2} 是目录，不是文件` };
      if (stat2.size > 5 * 1024 * 1024) return { success: false, error: `文件过大，最大支持 5MB` };

      rightLabel = `b/${path.basename(filePath2)}`;
      rightContent = await fs.readFile(filePath2, 'utf-8');
    } else if (mode === 'file_vs_content') {
      rightLabel = `b/${path.basename(params.path1 || '')} (new)`;
      rightContent = params.content ?? '';
    } else {
      // file_vs_git_head: 右侧是当前工作区文件
      rightLabel = `b/${path.basename(params.path1 || '')}`;
      rightContent = await fs.readFile(resolvePath(params.path1!), 'utf-8');
    }

    // 按行分割
    const leftLines = leftContent.split('\n');
    const rightLines = rightContent.split('\n');

    // 限制行数
    if (leftLines.length > MAX_LINES || rightLines.length > MAX_LINES) {
      return { success: false, error: `文件行数过多（左侧 ${leftLines.length} / 右侧 ${rightLines.length}），最大支持 ${MAX_LINES} 行` };
    }

    // ── LCS 差异算法 ──
    const diff = computeUnifiedDiff(leftLines, rightLines, contextLines);

    const added = diff.additions;
    const removed = diff.deletions;
    const unchanged = leftLines.length + rightLines.length - added - removed;

    sendLog('info', `🔍 diff (${mode})`, `${params.path1 || ''} ${mode === 'file_vs_file' ? '↔ ' + (params.path2 || '') : mode === 'file_vs_content' ? '↔ content' : '↔ HEAD'} → +${added} -${removed}`);

    if (diff.hunks.length === 0) {
      return {
        success: true,
        mode,
        path1: params.path1,
        path2: params.path2,
        diff: '',
        additions: 0,
        deletions: 0,
        unchanged,
        identical: true,
        message: '文件内容完全相同，无差异',
      };
    }

    // 生成 unified diff 头部 + hunks
    const header = `--- ${leftLabel}\n+++ ${rightLabel}\n`;
    const diffText = header + diff.hunks.join('\n');

    return {
      success: true,
      mode,
      path1: params.path1,
      path2: params.path2,
      diff: diffText,
      additions: added,
      deletions: removed,
      unchanged,
      identical: false,
      hunk_count: diff.hunks.length,
      total_lines: leftLines.length + rightLines.length,
    };
  } catch (err) {
    sendLog('error', `🔍 diff 失败`, (err as Error).message);
    return { success: false, error: (err as Error).message };
  }
}

/**
 * 计算 unified diff（行级 LCS 算法）
 */
interface DiffResult {
  hunks: string[];
  additions: number;
  deletions: number;
}

function computeUnifiedDiff(oldLines: string[], newLines: string[], contextSize: number): DiffResult {
  const n = oldLines.length;
  const m = newLines.length;

  // 构建 LCS 表（使用 Uint32Array 节省内存）
  // dp[(n+1) * (m+1)]，索引 [i][j] = i * (m+1) + j
  const dp = new Uint32Array((n + 1) * (m + 1));
  for (let i = 1; i <= n; i++) {
    for (let j = 1; j <= m; j++) {
      if (oldLines[i - 1] === newLines[j - 1]) {
        dp[i * (m + 1) + j] = dp[(i - 1) * (m + 1) + (j - 1)] + 1;
      } else {
        dp[i * (m + 1) + j] = Math.max(
          dp[(i - 1) * (m + 1) + j],
          dp[i * (m + 1) + (j - 1)]
        );
      }
    }
  }

  // 回溯生成操作序列
  type Op = 'equal' | 'delete' | 'insert';
  const ops: Array<{ op: Op; line: string; oldIdx?: number; newIdx?: number }> = [];
  let i = n, j = m;
  while (i > 0 || j > 0) {
    if (i > 0 && j > 0 && oldLines[i - 1] === newLines[j - 1]) {
      ops.push({ op: 'equal', line: oldLines[i - 1], oldIdx: i - 1, newIdx: j - 1 });
      i--; j--;
    } else if (j > 0 && (i === 0 || dp[i * (m + 1) + (j - 1)] >= dp[(i - 1) * (m + 1) + j])) {
      ops.push({ op: 'insert', line: newLines[j - 1], newIdx: j - 1 });
      j--;
    } else {
      ops.push({ op: 'delete', line: oldLines[i - 1], oldIdx: i - 1 });
      i--;
    }
  }
  ops.reverse();

  // 分组为 hunks（带上下文行）
  const hunks: string[] = [];
  let additions = 0;
  let deletions = 0;

  // 找到所有变更点
  const changeIndices: number[] = [];
  for (let k = 0; k < ops.length; k++) {
    if (ops[k].op !== 'equal') changeIndices.push(k);
  }

  if (changeIndices.length === 0) {
    return { hunks, additions: 0, deletions: 0 };
  }

  // 按上下文分组合并为 hunks
  let hunkStart = Math.max(0, changeIndices[0] - contextSize);
  let hunkEnd = Math.min(ops.length - 1, changeIndices[0] + contextSize);
  let oldStart = ops[hunkStart].oldIdx ?? 0;
  let newStart = ops[hunkStart].newIdx ?? 0;
  let hunkLines: string[] = [];

  for (let k = hunkStart; k <= hunkEnd && k < ops.length; k++) {
    const op = ops[k];
    if (op.op === 'equal') hunkLines.push(' ' + op.line);
    else if (op.op === 'delete') { hunkLines.push('-' + op.line); deletions++; }
    else { hunkLines.push('+' + op.line); additions++; }
  }

  // 扩展 hunk：如果下一个变更点在当前 hunk 的上下文范围内
  for (let idx = 1; idx < changeIndices.length; idx++) {
    const nextChange = changeIndices[idx];
    if (nextChange - hunkEnd <= contextSize * 2) {
      // 合并到当前 hunk
      while (hunkEnd < nextChange) {
        hunkEnd++;
        if (hunkEnd >= ops.length) break;
        const op = ops[hunkEnd];
        if (op.op === 'equal') hunkLines.push(' ' + op.line);
        else if (op.op === 'delete') { hunkLines.push('-' + op.line); deletions++; }
        else { hunkLines.push('+' + op.line); additions++; }
      }
      // 添加后续上下文
      for (let c = 1; c <= contextSize && hunkEnd + c < ops.length; c++) {
        hunkEnd++;
        const op = ops[hunkEnd];
        if (op.op === 'equal') hunkLines.push(' ' + op.line);
        else if (op.op === 'delete') { hunkLines.push('-' + op.line); deletions++; }
        else { hunkLines.push('+' + op.line); additions++; }
      }
    } else {
      // 完成当前 hunk
      const oldCount = hunkLines.filter(l => l.startsWith(' ') || l.startsWith('-')).length;
      const newCount = hunkLines.filter(l => l.startsWith(' ') || l.startsWith('+')).length;
      hunks.push(`@@ -${oldStart + 1},${oldCount} +${newStart + 1},${newCount} @@\n${hunkLines.join('\n')}`);

      // 开始新 hunk
      hunkStart = Math.max(0, nextChange - contextSize);
      hunkEnd = Math.min(ops.length - 1, nextChange + contextSize);
      oldStart = ops[hunkStart].oldIdx ?? 0;
      newStart = ops[hunkStart].newIdx ?? 0;
      hunkLines = [];
      for (let k = hunkStart; k <= hunkEnd && k < ops.length; k++) {
        const op = ops[k];
        if (op.op === 'equal') hunkLines.push(' ' + op.line);
        else if (op.op === 'delete') { hunkLines.push('-' + op.line); deletions++; }
        else { hunkLines.push('+' + op.line); additions++; }
      }
    }
  }

  // 最后一个 hunk
  if (hunkLines.length > 0) {
    const oldCount = hunkLines.filter(l => l.startsWith(' ') || l.startsWith('-')).length;
    const newCount = hunkLines.filter(l => l.startsWith(' ') || l.startsWith('+')).length;
    hunks.push(`@@ -${oldStart + 1},${oldCount} +${newStart + 1},${newCount} @@\n${hunkLines.join('\n')}`);
  }

  return { hunks, additions, deletions };
}
