/**
 * Tool Handlers - 系统与网络操作
 */

import * as fs from 'fs/promises';
import * as path from 'path';
import { spawn } from 'child_process';
import { checkPathAllowed, checkCommandAllowed } from './tool-security.js';
import { mainWindow } from './main.js';
import { sendLog, resolvePath, type ToolResult } from './tool-handlers-shared.js';
import { getWorkspaceDir } from './workspace.js';

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



/** HTTP 请求超时（毫秒） */
const HTTP_TIMEOUT = 15_000;

/** 完整 HTML 实体映射（常见实体） */
const HTML_ENTITIES: Record<string, string> = {
  '&nbsp;': ' ', '&lt;': '<', '&gt;': '>', '&amp;': '&', '&quot;': '"',
  '&#39;': "'", '&apos;': "'", '&ensp;': ' ', '&emsp;': ' ',
  '&copy;': '\u00A9', '&reg;': '\u00AE', '&trade;': '\u2122', '&euro;': '\u20AC',
  '&pound;': '\u00A3', '&yen;': '\u00A5', '&deg;': '\u00B0', '&middot;': '\u00B7',
  '&hellip;': '\u2026', '&mdash;': '\u2014', '&ndash;': '\u2013',
  '&lsquo;': '\u2018', '&rsquo;': '\u2019', '&ldquo;': '\u201C', '&rdquo;': '\u201D',
  '&bull;': '\u2022',
  '&times;': '\u00D7', '&divide;': '\u00F7', '&plusmn;': '\u00B1', '&micro;': '\u00B5',
  '&para;': '\u00B6', '&sect;': '\u00A7', '&laquo;': '\u00AB', '&raquo;': '\u00BB',
  '&iexcl;': '\u00A1', '&iquest;': '\u00BF', '&not;': '\u00AC', '&shy;': '\u00AD',
  '&macr;': '\u00AF', '&acute;': '\u00B4', '&cedil;': '\u00B8',
  '&OElig;': '\u0152', '&oelig;': '\u0153', '&Scaron;': '\u0160', '&scaron;': '\u0161',
  '&Yuml;': '\u0178', '&circ;': '\u02C6', '&tilde;': '\u02DC',
};

/** 解码 HTML 实体 */
function decodeHTMLEntities(text: string): string {
  let result = text;
  for (const [entity, char] of Object.entries(HTML_ENTITIES)) {
    result = result.replaceAll(entity, char);
  }
  // 数字实体: &#123; 和 &#x1F;
  result = result.replace(/&#x([0-9a-fA-F]+);/g, (_, hex) => String.fromCharCode(parseInt(hex, 16)));
  result = result.replace(/&#(\d+);/g, (_, dec) => String.fromCharCode(parseInt(dec, 10)));
  return result;
}

/** 将 HTML 转换为可读文本（保留结构） */
function htmlToText(html: string): string {
  let text = html;
  // 移除 script/style/nav/header/footer 等噪音标签及其内容
  text = text.replace(/<script[\s\S]*?<\/script>/gi, '');
  text = text.replace(/<style[\s\S]*?<\/style>/gi, '');
  text = text.replace(/<noscript[\s\S]*?<\/noscript>/gi, '');
  text = text.replace(/<nav[\s\S]*?<\/nav>/gi, '');
  text = text.replace(/<header[\s\S]*?<\/header>/gi, '');
  text = text.replace(/<footer[\s\S]*?<\/footer>/gi, '');
  text = text.replace(/<aside[\s\S]*?<\/aside>/gi, '');
  text = text.replace(/<iframe[\s\S]*?<\/iframe>/gi, '');
  text = text.replace(/<svg[\s\S]*?<\/svg>/gi, '');
  // 移除 HTML 注释
  text = text.replace(/<!--[\s\S]*?-->/g, '');
  // 块级标签转为换行
  text = text.replace(/<\/(p|div|h[1-6]|li|tr|blockquote|section|article|pre|br|hr)[^>]*>/gi, '\n');
  text = text.replace(/<(br|hr)[^>]*\/?>/gi, '\n');
  // 表格单元用制表符分隔
  text = text.replace(/<\/(td|th)[^>]*>/gi, '\t');
  // 移除剩余标签
  text = text.replace(/<[^>]+>/g, '');
  // 解码 HTML 实体
  text = decodeHTMLEntities(text);
  // 清理多余空白（保留换行结构）
  text = text.replace(/[ \t]+/g, ' ');
  text = text.replace(/\n\s*\n\s*\n+/g, '\n\n');
  text = text.split('\n').map(l => l.trim()).join('\n');
  return text.trim();
}

export async function handleWebFetch(params: { url: string; max_chars?: number; extract_mode?: string }): Promise<ToolResult> {
  try {
    const url = params.url;
    if (!url.startsWith('http://') && !url.startsWith('https://')) {
      return { success: false, error: '仅支持 http/https 协议' };
    }

    const maxChars = params.max_chars || 0; // 0 = 不截断，返回全部内容

    sendLog('info', `🌐 web_fetch`, `${url} (${maxChars > 0 ? maxChars + ' chars' : '完整内容'})`);

    // 带超时的 fetch
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), HTTP_TIMEOUT);
    let resp: Response;
    try {
      resp = await fetch(url, {
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
          'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
          'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8'
        },
        signal: controller.signal,
        redirect: 'follow',
      });
    } finally {
      clearTimeout(timeoutId);
    }

    if (!resp.ok) {
      return { success: false, error: `HTTP ${resp.status}: ${resp.statusText}` };
    }

    const contentType = resp.headers.get('content-type') || '';
    if (!contentType.includes('text') && !contentType.includes('html') && !contentType.includes('json') && !contentType.includes('xml')) {
      return { success: false, error: `不支持的内容类型: ${contentType}` };
    }

    // 预检查内容长度，避免下载过大的页面
    const contentLength = resp.headers.get('content-length');
    if (contentLength && parseInt(contentLength, 10) > 10 * 1024 * 1024) {
      return { success: false, error: `页面过大 (${(parseInt(contentLength, 10) / 1024 / 1024).toFixed(1)}MB)，超过 10MB 限制` };
    }

    let text = await resp.text();

    // HTML → 可读文本提取
    if (contentType.includes('html')) {
      text = htmlToText(text);
    }

    const truncated = maxChars > 0 && text.length > maxChars;
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
    const errMsg = (err as Error).message;
    if (errMsg.includes('abort')) {
      return { success: false, error: `请求超时 (${HTTP_TIMEOUT / 1000}s)` };
    }
    return { success: false, error: errMsg };
  }
}

/**
 * Web Search — 联网搜索
 * 使用 Bing 搜索（首选）+ 百度作为备用
 */
export async function handleWebSearch(params: { query: string; max_results?: number }): Promise<ToolResult> {
  try {
    const query = params.query;
    if (!query || query.trim().length === 0) {
      return { success: false, error: '搜索关键词不能为空' };
    }

    const maxResults = Math.min(params.max_results || 15, 15);

    sendLog('info', `🔍 web_search`, `"${query}" (${maxResults} 条)`);

    const searchHeaders = {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
      'Accept': 'text/html',
      'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8'
    };

    /** 带超时的搜索请求 */
    async function fetchWithTimeout(url: string): Promise<Response | null> {
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), HTTP_TIMEOUT);
      try {
        const resp = await fetch(url, { headers: searchHeaders, signal: controller.signal });
        clearTimeout(timeoutId);
        return resp;
      } catch {
        clearTimeout(timeoutId);
        return null;
      }
    }

    // 1. Bing 搜索（首选）
    let results: Array<{ title: string; url: string; snippet: string }> = [];

    try {
      const bingUrl = `https://www.bing.com/search?q=${encodeURIComponent(query)}&count=${maxResults}`;
      const resp = await fetchWithTimeout(bingUrl);
      if (resp?.ok) {
        const html = await resp.text();
        results = parseBingResults(html, maxResults);
      }
    } catch (e) {
      sendLog('warn', `🔍 Bing 搜索失败`, (e as Error).message);
    }

    // 2. Bing 无结果，尝试百度
    if (results.length === 0) {
      try {
        const baiduUrl = `https://www.baidu.com/s?wd=${encodeURIComponent(query)}&rn=${maxResults}`;
        const resp = await fetchWithTimeout(baiduUrl);
        if (resp?.ok) {
          const html = await resp.text();
          results = parseBaiduResults(html, maxResults);
        }
      } catch (e) {
        sendLog('warn', `🔍 百度搜索失败`, (e as Error).message);
      }
    }

    // 3. 百度也失败，尝试 Google
    if (results.length === 0) {
      try {
        const googleUrl = `https://www.google.com/search?q=${encodeURIComponent(query)}&num=${maxResults}`;
        const resp = await fetchWithTimeout(googleUrl);
        if (resp?.ok) {
          const html = await resp.text();
          results = parseGoogleResults(html, maxResults);
        }
      } catch (e) {
        sendLog('warn', `🔍 Google 搜索失败`, (e as Error).message);
      }
    }

    if (results.length === 0) {
      return { success: false, error: '未找到搜索结果，请尝试其他关键词' };
    }

    // URL 去重：同一 URL 只保留第一个结果
    const seenUrls = new Set<string>();
    const deduped: typeof results = [];
    for (const r of results) {
      const normalizedUrl = r.url.replace(/\/+$/, '').toLowerCase();
      if (!seenUrls.has(normalizedUrl)) {
        seenUrls.add(normalizedUrl);
        deduped.push(r);
      }
    }

    // 清理摘要中的残留 HTML 标签和多余空白
    for (const r of deduped) {
      r.title = r.title.replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim();
      r.snippet = r.snippet.replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim();
    }

    // 构建格式化的搜索结果（附带当前日期）
    const now = new Date();
    const dateStr = `${now.getFullYear()}年${now.getMonth() + 1}月${now.getDate()}日`;
    const formatted = `[当前日期: ${dateStr}（搜索时的实时日期）]\n\n` + deduped.map((r, i) =>
      `[${i + 1}] ${r.title}\n    URL: ${r.url}\n    ${r.snippet}`
    ).join('\n\n');

    sendLog('success', `🔍 web_search 完成`, `"${query}" → ${deduped.length} 条结果`);

    return {
      success: true,
      query,
      results: deduped,
      total: deduped.length,
      formatted
    };
  } catch (err) {
    return { success: false, error: (err as Error).message };
  }
}

/** 解析百度 HTML 搜索结果 */
function parseBaiduResults(html: string, maxResults: number): Array<{ title: string; url: string; snippet: string }> {
  const results: Array<{ title: string; url: string; snippet: string }> = [];

  // 百度结果块：<div class="result" ...> 或 <div class="result-op" ...>
  // 标题：<h3 class="t"> 内的 <a href="...">title</a>
  // 摘要：<div class="c-abstract">...</div>
  const blockRegex = /<div class="result[^"]*"[^>]*>([\s\S]*?)(?=<div class="result|<div id="content_right|$)/gi;
  let blockMatch;

  while ((blockMatch = blockRegex.exec(html)) !== null && results.length < maxResults) {
    const block = blockMatch[1];

    // 提取标题和 URL
    const titleMatch = block.match(/<h3[^>]*class="[^"]*t[^"]*"[^>]*>[\s\S]*?<a[^>]*href="([^"]*)"[^>]*>([\s\S]*?)<\/a>/);
    if (!titleMatch) continue;

    let url = titleMatch[1].trim();
    const title = decodeHTML(titleMatch[2].replace(/<[^>]+>/g, '').trim());

    // 百度有时使用 data-url 属性
    if (!url.startsWith('http')) {
      const dataUrlMatch = block.match(/data-url="(https?:\/\/[^"]*)"/);
      if (dataUrlMatch) url = dataUrlMatch[1];
    }

    // 提取摘要
    const snippetMatch = block.match(/<div class="c-abstract"[^>]*>([\s\S]*?)<\/div>/) ||
      block.match(/<span class="content-right_[^"]*"[^>]*>([\s\S]*?)<\/span>/);
    const snippet = snippetMatch ? decodeHTML(snippetMatch[1].replace(/<[^>]+>/g, '').trim()) : '';

    if (title) {
      results.push({ title, url: url.startsWith('http') ? url : `https://www.baidu.com${url}`, snippet });
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

/** 解析 Google HTML 搜索结果 */
function parseGoogleResults(html: string, maxResults: number): Array<{ title: string; url: string; snippet: string }> {
  const results: Array<{ title: string; url: string; snippet: string }> = [];

  // Google 结果块：<div class="g">...</div>，内含 <a href="..."><h3>title</h3></a> 和摘要
  const blockRegex = /<div class="g"[^>]*>([\s\S]*?)(?=<div class="g"|<\/div>\s*<\/div>\s*<\/div>)/gi;
  let blockMatch;

  while ((blockMatch = blockRegex.exec(html)) !== null && results.length < maxResults) {
    const block = blockMatch[1];

    const titleMatch = block.match(/<a[^>]*href="(https?:\/\/[^"]*)"[^>]*>[\s\S]*?<h3[^>]*>([\s\S]*?)<\/h3>/);
    if (!titleMatch) continue;

    const url = titleMatch[1].trim();
    const title = decodeHTML(titleMatch[2].replace(/<[^>]+>/g, '').trim());

    // 摘要：尝试多种模式
    const snippetMatch =
      block.match(/<div[^>]*data-sncf="[^"]*"[^>]*>([\s\S]*?)<\/div>/) ||
      block.match(/<span[^>]*class="[^"]*st[^"]*"[^>]*>([\s\S]*?)<\/span>/) ||
      block.match(/<div[^>]*class="[^"]*VwiC3b[^"]*"[^>]*>([\s\S]*?)<\/div>/);
    const snippet = snippetMatch ? decodeHTML(snippetMatch[1].replace(/<[^>]+>/g, '').trim()) : '';

    if (title && url.startsWith('http') && !url.includes('google.com')) {
      results.push({ title, url, snippet });
    }
  }

  return results;
}

/** 简单 HTML 实体解码（用于搜索结果解析） */
function decodeHTML(text: string): string {
  return decodeHTMLEntities(text);
}

export async function handleDownloadFile(params: { url: string; destination: string }): Promise<ToolResult> {
  try {
    const destPath = resolvePath(params.destination);
    const allowed = checkPathAllowed(destPath, 'write');
    if (!allowed.ok) return { success: false, error: allowed.reason };

    if (!params.url.startsWith('http://') && !params.url.startsWith('https://')) {
      return { success: false, error: '仅支持 http/https 协议' };
    }

    sendLog('info', `⬇️ download_file`, `${params.url} → ${destPath}`);

    // 带超时的下载（大文件给更长超时）
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 60_000);
    let resp: Response;
    try {
      resp = await fetch(params.url, { signal: controller.signal });
    } finally {
      clearTimeout(timeoutId);
    }

    if (!resp.ok) return { success: false, error: `HTTP ${resp.status}: ${resp.statusText}` };

    const buf = Buffer.from(await resp.arrayBuffer());
    if (buf.length > 50 * 1024 * 1024) {
      return { success: false, error: '文件超过 50MB 限制' };
    }

    const destDir = path.dirname(destPath);
    await fs.mkdir(destDir, { recursive: true });
    await fs.writeFile(destPath, buf);

    sendLog('success', `⬇️ download_file 完成`, `${buf.length} bytes`);
    return {
      success: true,
      url: params.url,
      destination: destPath,
      size: buf.length,
      content_type: resp.headers.get('content-type') || 'unknown'
    };
  } catch (err) {
    const errMsg = (err as Error).message;
    if (errMsg.includes('abort')) {
      return { success: false, error: '下载超时 (60s)' };
    }
    return { success: false, error: errMsg };
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
