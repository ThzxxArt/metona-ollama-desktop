/**
 * Tool Handlers - 主进程工具执行器
 * 所有文件系统操作在此执行，通过 IPC 被渲染进程调用
 */

import * as fs from 'fs/promises';
import * as path from 'path';
import { spawn } from 'child_process';
import { checkPathAllowed, checkCommandAllowed } from './tool-security.js';
import { mainWindow } from './main.js';
import { getWorkspaceDir } from './workspace.js';

/** 发送日志到渲染进程日志面板 */
function sendLog(level: 'info' | 'success' | 'warn' | 'error' | 'debug', message: string, detail?: string): void {
  mainWindow?.webContents.send('main:log', { level, message, detail });
}

/** 解析路径：相对路径基于工作空间目录 */
function resolvePath(inputPath: string): string {
  if (path.isAbsolute(inputPath)) return path.resolve(inputPath);
  return path.resolve(getWorkspaceDir(), inputPath);
}

export interface ToolResult {
  success: boolean;
  [key: string]: unknown;
}

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
let _toolProc: ReturnType<typeof spawn> | null = null;

export async function handleRunCommand(params: { command: string; cwd?: string; timeout?: number }): Promise<ToolResult> {
  try {
    const cmdCheck = checkCommandAllowed(params.command);
    if (!cmdCheck.ok) {
      sendLog('warn', `🔧 run_command 被拦截`, `${params.command.slice(0, 100)} | ${cmdCheck.reason}`);
      return { success: false, error: cmdCheck.reason };
    }

    const cwd = params.cwd ? path.resolve(params.cwd) : getWorkspaceDir();
    const dirCheck = checkPathAllowed(cwd, 'read');
    if (!dirCheck.ok) {
      sendLog('warn', `🔧 run_command 目录被拦截`, `${cwd} | ${dirCheck.reason}`);
      return { success: false, error: dirCheck.reason };
    }

    sendLog('info', `🔧 run_command 执行`, `${params.command.slice(0, 200)} | cwd: ${cwd}`);

    return new Promise((resolve) => {
      const isWin = process.platform === 'win32';
      const shell = isWin ? 'cmd.exe' : 'bash';
      const actualCmd = isWin ? `chcp 65001 >nul && ${params.command}` : params.command;
      const shellArgs = isWin ? ['/c', actualCmd] : ['-c', actualCmd];
      const startTime = Date.now();

      _toolProc = spawn(shell, shellArgs, {
        cwd,
        env: {
          ...process.env,
          ...(isWin ? {} : { TERM: 'xterm-256color' }),
          LANG: 'en_US.UTF-8',
          LC_ALL: 'en_US.UTF-8',
          PYTHONIOENCODING: 'utf-8'
        },
        stdio: ['pipe', 'pipe', 'pipe']
      });

      let stdout = '';
      let stderr = '';

      // 实时推送到工作空间终端
      _toolProc.stdout?.on('data', (data: Buffer) => {
        const str = data.toString('utf-8');
        stdout += str;
        mainWindow?.webContents.send('cmd:output', { command: params.command, type: 'stdout', data: str });
      });

      _toolProc.stderr?.on('data', (data: Buffer) => {
        const str = data.toString('utf-8');
        stderr += str;
        mainWindow?.webContents.send('cmd:output', { command: params.command, type: 'stderr', data: str });
      });

      _toolProc.on('close', (code) => {
        _toolProc = null;
        const duration = Date.now() - startTime;
        sendLog(
          code === 0 ? 'success' : 'warn',
          `🔧 run_command 完成`,
          `exitCode: ${code} | ${duration}ms | stdout: ${stdout.length}B | stderr: ${stderr.length}B`
        );
        mainWindow?.webContents.send('cmd:done', { command: params.command, exitCode: code });
        resolve({
          success: code === 0,
          stdout,
          stderr,
          exitCode: code,
          duration
        });
      });

      _toolProc.on('error', (err) => {
        _toolProc = null;
        const duration = Date.now() - startTime;
        sendLog('error', `🔧 run_command 失败`, `${err.message} | ${duration}ms`);
        mainWindow?.webContents.send('cmd:done', { command: params.command, exitCode: 1 });
        resolve({
          success: false,
          stdout,
          stderr: stderr + (stderr ? '\n' : '') + err.message,
          exitCode: 1,
          error: err.message,
          duration
        });
      });
    });
  } catch (err) {
    sendLog('error', `🔧 run_command 异常`, (err as Error).message);
    return { success: false, stdout: '', stderr: (err as Error).message, exitCode: 1, error: (err as Error).message };
  }
}

/** 终止当前工具命令进程 */
export function killToolProcess(): boolean {
  if (!_toolProc) {
    sendLog('warn', `🔧 cmd:kill`, '无正在运行的工具命令');
    return false;
  }
  try { _toolProc.kill('SIGTERM'); } catch { /* ignore */ }
  _toolProc = null;
  sendLog('info', `🔧 cmd:kill`, '工具命令已终止');
  return true;
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

export async function handleWebFetch(params: { url: string; max_chars?: number; extract_mode?: string }): Promise<ToolResult> {
  try {
    const url = params.url;
    if (!url.startsWith('http://') && !url.startsWith('https://')) {
      return { success: false, error: '仅支持 http/https 协议' };
    }

    const maxChars = params.max_chars || 10000;

    sendLog('info', `🌐 web_fetch`, `${url} (${maxChars} chars)`);
    const resp = await fetch(url, {
      headers: { 'User-Agent': 'MetonaOllama/1.0' },
      signal: AbortSignal.timeout(15000)
    });

    if (!resp.ok) {
      return { success: false, error: `HTTP ${resp.status}: ${resp.statusText}` };
    }

    const contentType = resp.headers.get('content-type') || '';
    if (!contentType.includes('text') && !contentType.includes('html') && !contentType.includes('json') && !contentType.includes('xml')) {
      return { success: false, error: `不支持的内容类型: ${contentType}` };
    }

    let text = await resp.text();

    // 简单 HTML → 文本提取
    if (contentType.includes('html')) {
      text = text
        .replace(/<script[\s\S]*?<\/script>/gi, '')
        .replace(/<style[\s\S]*?<\/style>/gi, '')
        .replace(/<[^>]+>/g, ' ')
        .replace(/&nbsp;/g, ' ')
        .replace(/&lt;/g, '<')
        .replace(/&gt;/g, '>')
        .replace(/&amp;/g, '&')
        .replace(/\s+/g, ' ')
        .trim();
    }

    const truncated = text.length > maxChars;
    if (truncated) text = text.slice(0, maxChars);

    sendLog('success', `🌐 web_fetch 完成`, `${resp.status} | ${text.length} chars${truncated ? ' (已截断)' : ''}`);
    return {
      success: true,
      url,
      content: text,
      content_type: contentType,
      status: resp.status,
      truncated,
      length: text.length
    };
  } catch (err) {
    return { success: false, error: (err as Error).message };
  }
}

/**
 * Web Search — 联网搜索
 * 使用 DuckDuckGo HTML 搜索并提取结果
 */
export async function handleWebSearch(params: { query: string; max_results?: number }): Promise<ToolResult> {
  try {
    const query = params.query;
    if (!query || query.trim().length === 0) {
      return { success: false, error: '搜索关键词不能为空' };
    }

    const maxResults = Math.min(params.max_results || 8, 10);

    sendLog('info', `🔍 web_search`, `"${query}" (${maxResults} 条)`);

    // 1. 尝试 DuckDuckGo HTML 搜索
    let results: Array<{ title: string; url: string; snippet: string }> = [];

    try {
      const ddgUrl = `https://html.duckduckgo.com/html/?q=${encodeURIComponent(query)}`;
      const resp = await fetch(ddgUrl, {
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
          'Accept': 'text/html',
          'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8'
        },
        signal: AbortSignal.timeout(15000)
      });

      if (resp.ok) {
        const html = await resp.text();
        results = parseDDGResults(html, maxResults);
      }
    } catch (e) {
      sendLog('warn', `🔍 DuckDuckGo 搜索失败`, (e as Error).message);
    }

    // 2. 如果 DuckDuckGo 无结果，尝试备用方案
    if (results.length === 0) {
      try {
        const bingUrl = `https://www.bing.com/search?q=${encodeURIComponent(query)}&count=${maxResults}`;
        const resp = await fetch(bingUrl, {
          headers: {
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
            'Accept': 'text/html',
            'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8'
          },
          signal: AbortSignal.timeout(15000)
        });

        if (resp.ok) {
          const html = await resp.text();
          results = parseBingResults(html, maxResults);
        }
      } catch (e) {
        sendLog('warn', `🔍 Bing 搜索失败`, (e as Error).message);
      }
    }

    if (results.length === 0) {
      return { success: false, error: '未找到搜索结果，请尝试其他关键词' };
    }

    // 构建格式化的搜索结果
    const formatted = results.map((r, i) =>
      `[${i + 1}] ${r.title}\n    URL: ${r.url}\n    ${r.snippet}`
    ).join('\n\n');

    sendLog('success', `🔍 web_search 完成`, `"${query}" → ${results.length} 条结果`);

    return {
      success: true,
      query,
      results,
      total: results.length,
      formatted
    };
  } catch (err) {
    return { success: false, error: (err as Error).message };
  }
}

/** 解析 DuckDuckGo HTML 搜索结果 */
function parseDDGResults(html: string, maxResults: number): Array<{ title: string; url: string; snippet: string }> {
  const results: Array<{ title: string; url: string; snippet: string }> = [];

  // 匹配结果块：<a class="result__a" href="...">title</a> ... <a class="result__snippet">snippet</a>
  const resultRegex = /<a[^>]*class="result__a"[^>]*href="([^"]*)"[^>]*>([\s\S]*?)<\/a>[\s\S]*?<a[^>]*class="result__snippet"[^>]*>([\s\S]*?)<\/a>/gi;

  let match;
  while ((match = resultRegex.exec(html)) !== null && results.length < maxResults) {
    let url = match[1].trim();
    // DuckDuckGo 使用重定向链接，提取真实 URL
    const uddgMatch = url.match(/[?&]uddg=([^&]+)/);
    if (uddgMatch) {
      url = decodeURIComponent(uddgMatch[1]);
    }

    const title = decodeHTML(match[2].replace(/<[^>]+>/g, '').trim());
    const snippet = decodeHTML(match[3].replace(/<[^>]+>/g, '').trim());

    if (title && url.startsWith('http')) {
      results.push({ title, url, snippet });
    }
  }

  return results;
}

/** 解析 Bing HTML 搜索结果 */
function parseBingResults(html: string, maxResults: number): Array<{ title: string; url: string; snippet: string }> {
  const results: Array<{ title: string; url: string; snippet: string }> = [];

  // 匹配 <li class="b_algo"> 块
  const blockRegex = /<li class="b_algo"[^>]*>([\s\S]*?)<\/li>/gi;
  let blockMatch;

  while ((blockMatch = blockRegex.exec(html)) !== null && results.length < maxResults) {
    const block = blockMatch[1];

    const titleMatch = block.match(/<a[^>]*href="(https?:\/\/[^"]*)"[^>]*>([\s\S]*?)<\/a>/);
    const snippetMatch = block.match(/<p[^>]*>([\s\S]*?)<\/p>/) || block.match(/<div class="b_caption"[^>]*>([\s\S]*?)<\/div>/);

    if (titleMatch) {
      const url = titleMatch[1].trim();
      const title = decodeHTML(titleMatch[2].replace(/<[^>]+>/g, '').trim());
      const snippet = snippetMatch ? decodeHTML(snippetMatch[1].replace(/<[^>]+>/g, '').trim()) : '';

      if (title && url.startsWith('http')) {
        results.push({ title, url, snippet });
      }
    }
  }

  return results;
}

/** 简单 HTML 实体解码 */
function decodeHTML(text: string): string {
  return text
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&nbsp;/g, ' ')
    .replace(/&#x([0-9a-f]+);/gi, (_, hex) => String.fromCharCode(parseInt(hex, 16)))
    .replace(/&#(\d+);/g, (_, dec) => String.fromCharCode(parseInt(dec, 10)));
}

export async function handleAppendFile(params: { path: string; content: string; newline?: boolean }): Promise<ToolResult> {
  try {
    const filePath = resolvePath(params.path);
    const allowed = checkPathAllowed(filePath, 'write');
    if (!allowed.ok) return { success: false, error: allowed.reason };

    const prefix = params.newline !== false ? '\n' : '';
    await fs.appendFile(filePath, prefix + params.content, 'utf-8');

    const stat = await fs.stat(filePath);
    return { success: true, path: filePath, newSize: stat.size };
  } catch (err) {
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

    await fs.writeFile(filePath, newContent, 'utf-8');
    return { success: true, path: filePath, replaceCount, newSize: newContent.length };
  } catch (err) {
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

export async function handleDownloadFile(params: { url: string; destination: string }): Promise<ToolResult> {
  try {
    const destPath = resolvePath(params.destination);
    const allowed = checkPathAllowed(destPath, 'write');
    if (!allowed.ok) return { success: false, error: allowed.reason };

    if (!params.url.startsWith('http://') && !params.url.startsWith('https://')) {
      return { success: false, error: '仅支持 http/https 协议' };
    }

    const resp = await fetch(params.url, {
      signal: AbortSignal.timeout(60000)
    });
    if (!resp.ok) return { success: false, error: `HTTP ${resp.status}: ${resp.statusText}` };

    const buf = Buffer.from(await resp.arrayBuffer());
    if (buf.length > 50 * 1024 * 1024) {
      return { success: false, error: '文件超过 50MB 限制' };
    }

    const destDir = path.dirname(destPath);
    await fs.mkdir(destDir, { recursive: true });
    await fs.writeFile(destPath, buf);

    return {
      success: true,
      url: params.url,
      destination: destPath,
      size: buf.length,
      content_type: resp.headers.get('content-type') || 'unknown'
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

export async function handleGit(params: { action: string; path?: string; files?: string[]; message?: string; branch?: string; remote?: string; remote_url?: string; count?: number; all?: boolean; staged?: boolean; new_branch?: boolean; delete_branch?: boolean; force?: boolean; url?: string }): Promise<ToolResult> {
  try {
    const cwd = params.path ? path.resolve(params.path) : getWorkspaceDir();

    async function runGit(args: string[]): Promise<{ stdout: string; stderr: string; code: number }> {
      return new Promise((resolve) => {
        const git = spawn('git', args, { cwd, stdio: ['pipe', 'pipe', 'pipe'], env: { ...process.env, LANG: 'en_US.UTF-8' } });
        let stdout = '';
        let stderr = '';
        git.stdout.on('data', (d: Buffer) => { stdout += d.toString(); });
        git.stderr.on('data', (d: Buffer) => { stderr += d.toString(); });
        git.on('close', (code) => resolve({ stdout, stderr, code: code ?? 1 }));
        git.on('error', (err) => resolve({ stdout, stderr: err.message, code: 1 }));
      });
    }

    switch (params.action) {
      case 'status': {
        const r = await runGit(['status', '--porcelain=v1', '-b']);
        if (r.code !== 0) return { success: false, error: r.stderr || '不是 git 仓库' };

        const lines = r.stdout.split('\n').filter(l => l.trim());
        const branchLine = lines.find(l => l.startsWith('##')) || '';
        const branch = branchLine.replace('## ', '').split('...')[0] || 'unknown';
        const tracking = branchLine.includes('...') ? branchLine.split('...')[1] : '';

        const modified: string[] = [];
        const staged: string[] = [];
        const untracked: string[] = [];
        const deleted: string[] = [];
        const renamed: string[] = [];

        for (const line of lines) {
          if (line.startsWith('##')) continue;
          const status = line.slice(0, 2);
          const file = line.slice(3);
          if (status === '??') untracked.push(file);
          else {
            if (status[0] === 'D') deleted.push(file);
            else if (status[0] === 'R') renamed.push(file);
            else if (status[0] !== ' ' && status[0] !== '?') staged.push(file);
            if (status[1] === 'M') modified.push(file);
            else if (status[1] === 'D') deleted.push(file);
          }
        }

        return {
          success: true, branch, tracking, modified, staged, untracked, deleted, renamed,
          isClean: modified.length === 0 && staged.length === 0 && untracked.length === 0 && deleted.length === 0
        };
      }

      case 'log': {
        const count = params.count || 20;
        const format = '--oneline';
        const r = await runGit(['log', format, `--max-count=${count}`, ...(params.all ? ['--all'] : [])]);
        if (r.code !== 0) return { success: false, error: r.stderr };
        const commits = r.stdout.split('\n').filter(l => l.trim()).map(l => {
          const spaceIdx = l.indexOf(' ');
          return { hash: l.slice(0, spaceIdx), message: l.slice(spaceIdx + 1) };
        });
        return { success: true, commits, total: commits.length };
      }

      case 'diff': {
        const args = ['diff'];
        if (params.staged) args.push('--cached');
        if (params.files?.length) args.push('--', ...params.files);
        const r = await runGit(args);
        if (r.code !== 0) return { success: false, error: r.stderr };
        const hasChanges = r.stdout.trim().length > 0;
        return { success: true, diff: r.stdout, hasChanges, staged: !!params.staged };
      }

      case 'add': {
        if (!params.files?.length) return { success: false, error: '请指定要暂存的文件' };
        const r = await runGit(['add', ...params.files]);
        if (r.code !== 0) return { success: false, error: r.stderr };
        return { success: true, action: 'add', files: params.files };
      }

      case 'commit': {
        if (!params.message) return { success: false, error: '请提供提交信息' };
        const r = await runGit(['commit', '-m', params.message]);
        if (r.code !== 0) return { success: false, error: r.stderr || '提交失败（可能没有暂存的更改）' };
        return { success: true, action: 'commit', message: params.message, output: r.stdout.trim() };
      }

      case 'push': {
        const args = ['push'];
        if (params.remote) args.push(params.remote);
        if (params.branch) args.push(params.branch);
        if (params.force) args.push('--force');
        const r = await runGit(args);
        if (r.code !== 0) return { success: false, error: r.stderr };
        return { success: true, action: 'push', output: r.stderr.trim() || r.stdout.trim() };
      }

      case 'pull': {
        const args = ['pull'];
        if (params.remote) args.push(params.remote);
        if (params.branch) args.push(params.branch);
        const r = await runGit(args);
        if (r.code !== 0) return { success: false, error: r.stderr };
        return { success: true, action: 'pull', output: r.stdout.trim() };
      }

      case 'branch': {
        if (params.new_branch && params.branch) {
          const r = await runGit(['checkout', '-b', params.branch]);
          if (r.code !== 0) return { success: false, error: r.stderr };
          return { success: true, action: 'branch', created: params.branch };
        }
        if (params.delete_branch && params.branch) {
          const r = await runGit(['branch', '-d', params.branch]);
          if (r.code !== 0) return { success: false, error: r.stderr };
          return { success: true, action: 'branch', deleted: params.branch };
        }
        const r = await runGit(['branch', ...(params.all ? ['-a'] : [])]);
        if (r.code !== 0) return { success: false, error: r.stderr };
        const branches = r.stdout.split('\n').filter(l => l.trim()).map(l => ({
          name: l.replace(/^\*?\s*/, '').trim(),
          current: l.startsWith('*')
        }));
        return { success: true, action: 'branch', branches };
      }

      case 'checkout': {
        if (!params.branch) return { success: false, error: '请指定分支名' };
        const args = ['checkout'];
        if (params.force) args.push('-f');
        args.push(params.branch);
        const r = await runGit(args);
        if (r.code !== 0) return { success: false, error: r.stderr };
        return { success: true, action: 'checkout', branch: params.branch };
      }

      case 'merge': {
        if (!params.branch) return { success: false, error: '请指定要合并的分支' };
        const r = await runGit(['merge', params.branch]);
        if (r.code !== 0) return { success: false, error: r.stderr || '合并冲突' };
        return { success: true, action: 'merge', branch: params.branch, output: r.stdout.trim() };
      }

      case 'stash': {
        const subAction = params.message || 'push';
        const args = ['stash', subAction];
        if (subAction === 'push' && params.message) args.push('-m', params.message);
        const r = await runGit(args);
        if (r.code !== 0) return { success: false, error: r.stderr };
        return { success: true, action: 'stash', subAction, output: r.stdout.trim() };
      }

      case 'remote': {
        if (params.remote_url && params.remote) {
          const r = await runGit(['remote', 'add', params.remote, params.remote_url]);
          if (r.code !== 0) return { success: false, error: r.stderr };
          return { success: true, action: 'remote', added: params.remote, url: params.remote_url };
        }
        const args = ['remote', '-v'];
        const r = await runGit(args);
        if (r.code !== 0) return { success: false, error: r.stderr };
        const remotes = r.stdout.split('\n').filter(l => l.trim()).map(l => {
          const [name, url] = l.split(/\s+/);
          return { name, url };
        });
        return { success: true, action: 'remote', remotes };
      }

      case 'clone': {
        if (!params.url) return { success: false, error: '请提供仓库 URL' };
        const destDir = params.path ? path.resolve(params.path) : getWorkspaceDir();
        const r = await runGit(['clone', params.url, destDir]);
        if (r.code !== 0) return { success: false, error: r.stderr };
        return { success: true, action: 'clone', url: params.url, destination: destDir };
      }

      case 'init': {
        const r = await runGit(['init']);
        if (r.code !== 0) return { success: false, error: r.stderr };
        return { success: true, action: 'init', output: r.stdout.trim() };
      }

      case 'reset': {
        const args = ['reset'];
        if (params.staged) args.push('--cached');
        if (params.force) args.push('--hard');
        if (params.files?.length) args.push('--', ...params.files);
        const r = await runGit(args);
        if (r.code !== 0) return { success: false, error: r.stderr };
        return { success: true, action: 'reset', output: r.stdout.trim() };
      }

      case 'tag': {
        if (params.branch) {
          // branch field reused as tag name
          const args = ['tag', params.branch];
          if (params.message) args.push('-m', params.message);
          const r = await runGit(args);
          if (r.code !== 0) return { success: false, error: r.stderr };
          return { success: true, action: 'tag', created: params.branch };
        }
        const r = await runGit(['tag', '-l']);
        if (r.code !== 0) return { success: false, error: r.stderr };
        const tags = r.stdout.split('\n').filter(l => l.trim());
        return { success: true, action: 'tag', tags };
      }

      default:
        return { success: false, error: `未知 git 操作: ${params.action}` };
    }
  } catch (err) {
    return { success: false, error: (err as Error).message };
  }
}

export async function handleCompress(params: { action: string; path: string; destination?: string; format?: string }): Promise<ToolResult> {
  try {
    const format = params.format || 'tar.gz';

    if (params.action === 'create') {
      const srcPath = resolvePath(params.path);
      const check = checkPathAllowed(srcPath, 'read');
      if (!check.ok) return { success: false, error: check.reason };

      const destPath = params.destination
        ? resolvePath(params.destination)
        : srcPath + (format === 'zip' ? '.zip' : '.tar.gz');
      const destCheck = checkPathAllowed(destPath, 'write');
      if (!destCheck.ok) return { success: false, error: destCheck.reason };

      return new Promise((resolve) => {
        const cmd = format === 'zip'
          ? `zip -r "${destPath}" "${path.basename(srcPath)}"`
          : `tar czf "${destPath}" "${path.basename(srcPath)}"`;
        const proc = spawn('bash', ['-c', cmd], { cwd: path.dirname(srcPath), stdio: ['pipe', 'pipe', 'pipe'] });
        let stderr = '';
        proc.stderr.on('data', (d: Buffer) => { stderr += d.toString(); });
        proc.on('close', (code) => {
          if (code === 0) {
            fs.stat(destPath).then(s => {
              resolve({ success: true, action: 'create', archive: destPath, size: s.size });
            }).catch(() => resolve({ success: true, action: 'create', archive: destPath }));
          } else {
            resolve({ success: false, error: stderr || `压缩失败 (exit ${code})` });
          }
        });
        proc.on('error', (err) => resolve({ success: false, error: err.message }));
      });
    } else {
      // extract
      const archivePath = resolvePath(params.path);
      const check = checkPathAllowed(archivePath, 'read');
      if (!check.ok) return { success: false, error: check.reason };

      const destDir = params.destination ? resolvePath(params.destination) : path.dirname(archivePath);
      const destCheck = checkPathAllowed(destDir, 'write');
      if (!destCheck.ok) return { success: false, error: destCheck.reason };

      await fs.mkdir(destDir, { recursive: true });

      return new Promise((resolve) => {
        const isZip = archivePath.endsWith('.zip');
        const cmd = isZip
          ? `unzip -o "${archivePath}" -d "${destDir}"`
          : `tar xzf "${archivePath}" -C "${destDir}"`;
        const proc = spawn('bash', ['-c', cmd], { stdio: ['pipe', 'pipe', 'pipe'] });
        let stderr = '';
        proc.stderr.on('data', (d: Buffer) => { stderr += d.toString(); });
        proc.on('close', (code) => {
          resolve(code === 0
            ? { success: true, action: 'extract', destination: destDir }
            : { success: false, error: stderr || `解压失败 (exit ${code})` }
          );
        });
        proc.on('error', (err) => resolve({ success: false, error: err.message }));
      });
    }
  } catch (err) {
    return { success: false, error: (err as Error).message };
  }
}
