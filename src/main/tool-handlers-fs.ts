/**
 * Tool Handlers - 文件系统操作
 */

import * as fs from 'fs/promises';
import * as path from 'path';
import { checkPathAllowed } from './tool-security.js';
import { sendLog, resolvePath, type ToolResult } from './tool-handlers-shared.js';

export async function handleReadFile(params: { path: string; encoding?: string; start_line?: number; end_line?: number }): Promise<ToolResult> {
  try {
    const filePath = resolvePath(params.path);
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
    const filePath = resolvePath(params.path);
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
    const dirPath = resolvePath(params.path);
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
    const rootPath = resolvePath(params.path);
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

/** 当前工具命令进程（用于用户手动终止） */

export async function handleAppendFile(params: { path: string; content: string; newline?: boolean }): Promise<ToolResult> {
  try {
    const filePath = resolvePath(params.path);
    const allowed = checkPathAllowed(filePath, 'write');
    if (!allowed.ok) return { success: false, error: allowed.reason };

    const prefix = params.newline !== false ? '\n' : '';
    sendLog('info', `➕ append_file`, `${filePath} (${params.content.length} chars)`);
    await fs.appendFile(filePath, prefix + params.content, 'utf-8');

    const stat = await fs.stat(filePath);
    sendLog('success', `➕ append_file 完成`, `${stat.size}B`);
    return { success: true, path: filePath, newSize: stat.size };
  } catch (err) {
    sendLog('error', `➕ append_file 失败`, (err as Error).message);
    return { success: false, error: (err as Error).message };
  }
}

export async function handleEditFile(params: { path: string; old_text: string; new_text: string; all?: boolean }): Promise<ToolResult> {
  try {
    const filePath = resolvePath(params.path);
    const allowed = checkPathAllowed(filePath, 'write');
    if (!allowed.ok) return { success: false, error: allowed.reason };

    const content = await fs.readFile(filePath, 'utf-8');

    if (!content.includes(params.old_text)) {
      return { success: false, error: '未找到要替换的文本' };
    }

    let newContent: string;
    let replaceCount: number;

    if (params.all) {
      const parts = content.split(params.old_text);
      replaceCount = parts.length - 1;
      newContent = parts.join(params.new_text);
    } else {
      replaceCount = 1;
      newContent = content.replace(params.old_text, params.new_text);
    }

    sendLog('info', `✂️ edit_file`, `${filePath} (${replaceCount} 处替换)`);
    await fs.writeFile(filePath, newContent, 'utf-8');
    sendLog('success', `✂️ edit_file 完成`, `${newContent.length}B`);
    return { success: true, path: filePath, replaceCount, newSize: newContent.length };
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

    const maxDepth = params.max_depth || 3;
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


export async function handleDiffFiles(params: { file1: string; file2: string; context_lines?: number }): Promise<ToolResult> {
  try {
    const path1 = resolvePath(params.file1);
    const path2 = resolvePath(params.file2);
    const check1 = checkPathAllowed(path1, 'read');
    if (!check1.ok) return { success: false, error: check1.reason };
    const check2 = checkPathAllowed(path2, 'read');
    if (!check2.ok) return { success: false, error: check2.reason };

    const content1 = await fs.readFile(path1, 'utf-8');
    const content2 = await fs.readFile(path2, 'utf-8');
    const lines1 = content1.split('\n');
    const lines2 = content2.split('\n');

    // 简单的统一 diff 实现
    const diffLines: string[] = [];
    const contextSize = params.context_lines || 3;
    let i = 0, j = 0;

    while (i < lines1.length || j < lines2.length) {
      if (i < lines1.length && j < lines2.length && lines1[i] === lines2[j]) {
        if (diffLines.length === 0 || diffLines[diffLines.length - 1].startsWith('-') || diffLines[diffLines.length - 1].startsWith('+')) {
          // 添加上下文
          const ctxStart = Math.max(0, i - contextSize);
          for (let k = ctxStart; k < i; k++) {
            diffLines.push(` ${lines1[k]}`);
          }
        }
        diffLines.push(` ${lines1[i]}`);
        i++; j++;
      } else {
        // 尝试找匹配
        let found = false;
        for (let look = 1; look <= 5 && i + look < lines1.length; look++) {
          if (lines1[i + look] === lines2[j]) {
            for (let k = 0; k < look; k++) diffLines.push(`-${lines1[i + k]}`);
            i += look; found = true; break;
          }
        }
        if (!found) {
          for (let look = 1; look <= 5 && j + look < lines2.length; look++) {
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

    const hasChanges = diffLines.some(l => l.startsWith('-') || l.startsWith('+'));
    return {
      success: true,
      file1: path1,
      file2: path2,
      diff: diffLines.join('\n'),
      hasChanges,
      lines1: lines1.length,
      lines2: lines2.length
    };
  } catch (err) {
    return { success: false, error: (err as Error).message };
  }
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
    const maxChars = params.max_chars_per_file || 2000;
    const results: Array<{ path: string; success: boolean; content?: string; error?: string; lines?: number }> = [];

    for (const p of params.paths.slice(0, 20)) {
      const filePath = resolvePath(p);
      const allowed = checkPathAllowed(filePath, 'read');
      if (!allowed.ok) {
        results.push({ path: p, success: false, error: allowed.reason });
        continue;
      }
      try {
        const stat = await fs.stat(filePath);
        if (stat.size > 1024 * 1024) {
          results.push({ path: p, success: false, error: '文件超过 1MB' });
          continue;
        }
        let content = await fs.readFile(filePath, 'utf-8');
        const lines = content.split('\n').length;
        if (content.length > maxChars) content = content.slice(0, maxChars) + '\n... (已截断)';
        results.push({ path: p, success: true, content, lines });
      } catch (err) {
        results.push({ path: p, success: false, error: (err as Error).message });
      }
    }

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
