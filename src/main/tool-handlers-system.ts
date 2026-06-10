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
          duration,
          cwd,
          command: params.command,
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
          duration,
          cwd,
          command: params.command,
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



/** HTTP 请求超时（毫秒），默认 30s，可通过 IPC 设置 */
let HTTP_TIMEOUT = 30_000;

/** 设置 HTTP 请求超时（毫秒） */
export function setHTTPTimeout(ms: number): void {
  HTTP_TIMEOUT = Math.max(5000, Math.min(300_000, ms)); // 5s ~ 300s
}

// ── LRU 搜索缓存 ──────────────────────────────────
interface CacheEntry { results: Array<{ title: string; url: string; snippet: string; engine: string; reachable?: boolean }>; time: number; }
const _searchCache = new Map<string, CacheEntry>();
const CACHE_MAX = 200;
const CACHE_TTL = 5 * 60 * 1000; // 5 分钟

function cacheGet(query: string): CacheEntry | null {
  const entry = _searchCache.get(query);
  if (!entry) return null;
  if (Date.now() - entry.time > CACHE_TTL) { _searchCache.delete(query); return null; }
  return entry;
}
function cacheSet(query: string, entry: CacheEntry): void {
  if (_searchCache.size >= CACHE_MAX) {
    const firstKey = _searchCache.keys().next().value;
    if (firstKey !== undefined) _searchCache.delete(firstKey);
  }
  _searchCache.set(query, entry);
}

// ── 反爬请求头 ────────────────────────────────────
const DESKTOP_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';
const MOBILE_UA = 'Mozilla/5.0 (Linux; Android 14; Pixel 8 Pro) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Mobile Safari/537.36';

/** 构建 fetch 请求头，根据 UA 类型动态设置 */
function buildFetchHeaders(url: string, useMobileUA: boolean): Record<string, string> {
  const ua = useMobileUA ? MOBILE_UA : DESKTOP_UA;
  let referer = 'https://www.google.com/';
  try {
    const u = new URL(url);
    referer = `${u.protocol}//${u.hostname}/`;
  } catch { /* ignore */ }
  return {
    'User-Agent': ua,
    'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8',
    'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8',
    'Accept-Encoding': 'gzip, deflate, br',
    'Cache-Control': 'no-cache',
    'DNT': '1',
    'Connection': 'keep-alive',
    'Upgrade-Insecure-Requests': '1',
    'Sec-Fetch-Dest': 'document',
    'Sec-Fetch-Mode': 'navigate',
    'Sec-Fetch-Site': 'none',
    'Sec-Fetch-User': '?1',
    'Pragma': 'no-cache',
    'Referer': referer,
  };
}

/** 带超时的 fetch 封装 */
async function fetchWithTimeout(url: string, timeout = HTTP_TIMEOUT, headers?: Record<string,string>): Promise<Response | null> {
  const _headers = headers || buildFetchHeaders(url, false);
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), timeout);
  try {
    const resp = await fetch(url, { headers: _headers, signal: controller.signal, redirect: 'follow' });
    clearTimeout(timeoutId);
    return resp;
  } catch {
    clearTimeout(timeoutId);
    return null;
  }
}

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

import { browserOpen, browserExtract, browserClose } from './browser.js';

// ──────────────────────────────────────────────────
// web_fetch 重试配置
// ──────────────────────────────────────────────────
const FETCH_MAX_RETRIES = 2;          // fetch 阶段最多重试 2 次
const FETCH_RETRY_DELAYS = [1500, 3000]; // 指数退避 (ms)
/** fetch 全部失败后自动回退到浏览器渲染 */
const BROWSER_FALLBACK_ENABLED = true;
/** 内容过短阈值：小于此字符数且是 HTML 时，自动升级到浏览器渲染 */
const SHORT_CONTENT_THRESHOLD = 200;
/** 需要回退浏览器的 HTTP 状态码（反爬/拦截信号） */
const BROWSER_FALLBACK_STATUSES = new Set([403, 503, 429, 502]);

/** 浏览器回退：打开 URL → 等待渲染 → 提取内容 */
async function browserFallback(url: string, maxChars: number): Promise<{ text: string; method: string } | null> {
  try {
    const openResult = await browserOpen(url);
    if (!openResult.success) return null;
    await new Promise(r => setTimeout(r, 2500)); // 等待 JS 渲染
    const extractResult = await browserExtract();
    browserClose();
    if (extractResult.success && extractResult.text && extractResult.text.length > 0) {
      let text = extractResult.text;
      if (maxChars > 0 && text.length > maxChars) text = text.slice(0, maxChars);
      return { text, method: 'browser' };
    }
    return null;
  } catch {
    try { browserClose(); } catch { /* */ }
    return null;
  }
}

export async function handleWebFetch(params: { url: string; max_chars?: number; extract_mode?: string; mobile_ua?: boolean; retry?: boolean }): Promise<ToolResult> {
  const url = params.url;
  if (!url.startsWith('http://') && !url.startsWith('https://')) {
    return { success: false, error: '仅支持 http/https 协议' };
  }

  const maxChars = params.max_chars || 0; // 0 = 不截断
  const useMobileUA = params.mobile_ua === true;
  const shouldRetry = params.retry !== false; // 默认开启重试

  sendLog('info', `🌐 web_fetch`, `${url} (${maxChars > 0 ? maxChars + ' chars' : '完整内容'}${useMobileUA ? ', 移动端UA' : ''})`);

  // ── Phase 1 & 2: HTTP fetch with UA switching ──
  let lastError = '';
  const maxAttempts = shouldRetry ? FETCH_MAX_RETRIES + 1 : 1;

  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    if (attempt > 0) {
      const delay = FETCH_RETRY_DELAYS[attempt - 1] || 3000;
      sendLog('warn', `🌐 web_fetch 重试`, `第 ${attempt + 1}/${maxAttempts} 次, 等待 ${delay}ms`);
      await new Promise(r => setTimeout(r, delay));
    }

    // 重试时切换 UA：首次用指定 UA，第二次换另一种，第三次用移动端
    const useMobile = attempt >= 2 ? true : (attempt === 1 ? !useMobileUA : useMobileUA);
    const headers = buildFetchHeaders(url, useMobile);

    try {
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), HTTP_TIMEOUT);
      let resp: Response;
      try {
        resp = await fetch(url, { headers, signal: controller.signal, redirect: 'follow' });
      } finally {
        clearTimeout(timeoutId);
      }

      if (!resp.ok) {
        // 反爬信号（403/503/429）→ 跳过后续 fetch，直接走浏览器回退
        if (BROWSER_FALLBACK_STATUSES.has(resp.status) && BROWSER_FALLBACK_ENABLED) {
          sendLog('warn', `🌐 web_fetch HTTP ${resp.status}，触发浏览器回退`, url);
          break; // 跳出 fetch 循环，走浏览器回退
        }
        // 5xx 服务器错误可重试
        if (resp.status >= 500 && attempt < maxAttempts - 1) {
          lastError = `HTTP ${resp.status}: ${resp.statusText}（将重试）`;
          continue;
        }
        return { success: false, error: `HTTP ${resp.status}: ${resp.statusText}。可尝试用 browser_open 直接打开页面。` };
      }

      const contentType = resp.headers.get('content-type') || '';
      if (!contentType.includes('text') && !contentType.includes('html') && !contentType.includes('json') && !contentType.includes('xml')) {
        return { success: false, error: `不支持的内容类型: ${contentType}。如果是二进制文件，请用 download_file 工具。` };
      }

      const contentLength = resp.headers.get('content-length');
      if (contentLength && parseInt(contentLength, 10) > 10 * 1024 * 1024) {
        return { success: false, error: `页面过大 (${(parseInt(contentLength, 10) / 1024 / 1024).toFixed(1)}MB)，超过 10MB 限制` };
      }

      let text = await resp.text();
      const isHTML = contentType.includes('html');
      if (isHTML) {
        text = htmlToText(text);
      }

      // ── SPA/短内容自动升级到浏览器渲染 ──
      if (isHTML && text.length < SHORT_CONTENT_THRESHOLD && BROWSER_FALLBACK_ENABLED) {
        sendLog('info', `🌐 web_fetch 内容过短(${text.length}字符)`, `自动升级到浏览器渲染: ${url}`);
        const browserResult = await browserFallback(url, maxChars);
        if (browserResult) {
          sendLog('success', `🌐 web_fetch 浏览器渲染完成`, `${browserResult.text.length} 字符`);
          return {
            success: true, url,
            content: browserResult.text,
            content_type: 'text/html (browser)',
            status: resp.status,
            truncated: maxChars > 0 && browserResult.text.length >= maxChars,
            length: browserResult.text.length,
            retries: attempt,
            method: 'browser',
          };
        }
        sendLog('warn', `🌐 web_fetch 浏览器渲染失败，使用原始内容`);
      }

      const truncated = maxChars > 0 && text.length > maxChars;
      if (truncated) text = text.slice(0, maxChars);

      sendLog('success', `🌐 web_fetch 完成`, `HTTP ${resp.status} | ${text.length} chars${truncated ? ' (已截断)' : ''}${attempt > 0 ? ` | 重试${attempt}次后成功` : ''}`);
      return {
        success: true, url,
        content: text,
        content_type: contentType,
        status: resp.status,
        truncated,
        length: text.length,
        retries: attempt,
        method: useMobile ? 'fetch(mobile)' : 'fetch(desktop)',
      };
    } catch (err) {
      const errMsg = (err as Error).message;
      if (errMsg.includes('abort') && attempt < maxAttempts - 1) {
        lastError = `请求超时 (${HTTP_TIMEOUT / 1000}s)（将重试）`;
        continue;
      }
      if (errMsg.includes('abort')) {
        // 超时 → 浏览器回退
        sendLog('warn', `🌐 web_fetch 超时，触发浏览器回退`, url);
        break;
      }
      // 网络错误可重试
      if (attempt < maxAttempts - 1) {
        lastError = errMsg + '（将重试）';
        continue;
      }
      // 最后一次也失败了 → 浏览器回退
      if (BROWSER_FALLBACK_ENABLED) {
        sendLog('warn', `🌐 web_fetch 所有 fetch 均失败(${errMsg})，触发浏览器回退`, url);
        break;
      }
      return { success: false, error: `fetch 失败: ${errMsg}。可尝试用 browser_open 直接打开页面。` };
    }
  }

  // ── Phase 3: 浏览器回退（fetch 全部失败后的最后手段）──
  if (BROWSER_FALLBACK_ENABLED) {
    sendLog('info', `🌐 web_fetch 回退到浏览器渲染`, url);
    const browserResult = await browserFallback(url, maxChars);
    if (browserResult) {
      sendLog('success', `🌐 web_fetch 浏览器渲染完成`, `${browserResult.text.length} 字符`);
      return {
        success: true, url,
        content: browserResult.text,
        content_type: 'text/html (browser)',
        status: 200,
        truncated: maxChars > 0 && browserResult.text.length >= maxChars,
        length: browserResult.text.length,
        retries: maxAttempts,
        method: 'browser(fallback)',
      };
    }
    return { success: false, error: `fetch 和浏览器渲染均失败。${lastError ? '最后错误: ' + lastError : '请检查 URL 是否可访问。'}` };
  }

  return { success: false, error: lastError || '所有重试均失败' };
}

/**
 * Web Search — 联网搜索（并行多引擎 + LRU 缓存 + 智能排序 + 时间过滤 + 摘要增强）
 * 同时请求 Bing / 百度 / DuckDuckGo / Google，智能排序后返回
 */
export async function handleWebSearch(params: { query: string; max_results?: number; time_range?: string; enhance_snippets?: boolean }): Promise<ToolResult> {
  try {
    const query = params.query;
    if (!query || query.trim().length === 0) {
      return { success: false, error: '搜索关键词不能为空' };
    }

    const maxResults = Math.min(params.max_results || 15, 20);
    const timeRange = params.time_range || '';
    const enhanceSnippets = params.enhance_snippets !== false; // 默认开启
    const cacheKey = `${query}|${maxResults}|${timeRange}`;

    // ── 时间范围 → URL 参数映射 ──
    let bingFreshness = '';
    let googleTbs = '';
    if (timeRange) {
      const tr = timeRange.toLowerCase();
      if (tr === 'day' || tr === '1d' || tr === '一天') { bingFreshness = 'Day'; googleTbs = 'qdr:d'; }
      else if (tr === 'week' || tr === '1w' || tr === '一周') { bingFreshness = 'Week'; googleTbs = 'qdr:w'; }
      else if (tr === 'month' || tr === '1m' || tr === '一月') { bingFreshness = 'Month'; googleTbs = 'qdr:m'; }
      else if (tr === 'year' || tr === '1y' || tr === '一年') { googleTbs = 'qdr:y'; }
    }

    // ── 1. 检查缓存 ──
    const cached = cacheGet(cacheKey);
    if (cached) {
      sendLog('success', `🔍 web_search 缓存命中`, `"${query}" → ${cached.results.length} 条`);
      return buildSearchResponse(cached.results, maxResults, true);
    }

    sendLog('info', `🔍 web_search`, `"${query}" (${maxResults} 条) [并行]`);

    // ── 2. 并行请求所有搜索引擎 ──
    const engines: Array<{ name: string; weight: number; fetcher: () => Promise<Array<{title:string;url:string;snippet:string}>> }> = [
      {
        name: 'bing', weight: 90,
        fetcher: async () => {
          const bingUrl = `https://www.bing.com/search?q=${encodeURIComponent(query)}&count=${maxResults}${bingFreshness ? '&freshness=' + bingFreshness : ''}`;
          const resp = await fetchWithTimeout(bingUrl);
          if (!resp?.ok) throw new Error(`Bing ${resp?.status}`);
          return parseBingResults(await resp.text(), maxResults);
        }
      },
      {
        name: 'baidu', weight: 80,
        fetcher: async () => {
          const resp = await fetchWithTimeout(
            `https://www.baidu.com/s?wd=${encodeURIComponent(query)}&rn=${maxResults}`
          );
          if (!resp?.ok) throw new Error(`百度 ${resp?.status}`);
          return parseBaiduResults(await resp.text(), maxResults);
        }
      },
      {
        name: 'ddg', weight: 70,
        fetcher: async () => {
          const resp = await fetchWithTimeout(
            `https://lite.duckduckgo.com/lite/?q=${encodeURIComponent(query)}`
          );
          if (!resp?.ok) throw new Error(`DDG ${resp?.status}`);
          return parseDDGResults(await resp.text(), maxResults);
        }
      },
      {
        name: 'google', weight: 85,
        fetcher: async () => {
          const googleUrl = `https://www.google.com/search?q=${encodeURIComponent(query)}&num=${maxResults}${googleTbs ? '&tbs=' + googleTbs : ''}`;
          const resp = await fetchWithTimeout(googleUrl);
          if (!resp?.ok) throw new Error(`Google ${resp?.status}`);
          return parseGoogleResults(await resp.text(), maxResults);
        }
      },
    ];

    // 所有引擎并行执行，收集结果
    const settled = await Promise.allSettled(engines.map(e =>
      e.fetcher().then(results => ({ engine: e.name, results }))
    ));

    // 汇总各引擎结果，合并去重（保留引擎和权重信息）
    const engineWeights = new Map(engines.map(e => [e.name, e.weight]));
    const allResults: Array<{ title: string; url: string; snippet: string; engine: string; weight: number; reachable?: boolean }> = [];
    const seenUrls = new Set<string>();
    const engineStats: Record<string, string> = {};

    for (let i = 0; i < settled.length; i++) {
      const s = settled[i];
      const engineName = engines[i].name;
      if (s.status === 'fulfilled') {
        const r = s.value;
        engineStats[engineName] = `${r.results.length} 条`;
        for (const item of r.results) {
          const normalized = item.url.replace(/\/+$/, '').toLowerCase();
          if (!seenUrls.has(normalized)) {
            seenUrls.add(normalized);
            allResults.push({ ...item, engine: engineName, weight: engineWeights.get(engineName) || 50 });
          }
        }
      } else {
        engineStats[engineName] = `失败: ${(s.reason as Error)?.message || 'timeout'}`;
        sendLog('warn', `🔍 ${engineName} 搜索失败`, (s.reason as Error)?.message || '未知');
      }
    }

    if (allResults.length === 0) {
      return { success: false, error: '所有搜索引擎均未返回结果，请尝试其他关键词' };
    }

    // ── 3. 清理摘要 ──
    for (const r of allResults) {
      r.title = r.title.replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim();
      r.snippet = r.snippet.replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim();
    }

    // ── 4. URL 可达性预检 + 质量评分 ──
    const topResults = allResults.slice(0, Math.min(maxResults * 2, allResults.length)); // 多检查一些用于排序
    const CONCURRENCY = 5;
    for (let i = 0; i < topResults.length; i += CONCURRENCY) {
      const batch = topResults.slice(i, i + CONCURRENCY);
      const checks = batch.map(async r => {
        try {
          const resp = await fetchWithTimeout(r.url, 3000, {
            'User-Agent': DESKTOP_UA,
            'Accept': 'text/html,*/*',
          });
          r.reachable = resp?.ok === true;
        } catch {
          r.reachable = false;
        }
      });
      await Promise.allSettled(checks);
    }

    // ── 5. 智能排序：可达优先 + 引擎权重 + 摘要质量 ──
    const scored = topResults.map(r => {
      let score = (r.weight / 100) * 50; // 引擎权重贡献 50%
      if (r.reachable === true) score += 30; // 可达 +30
      else if (r.reachable === false) score -= 20; // 不可达 -20
      // 摘要质量：越长越好（上限100字符），有内容的加分
      const snippetLen = Math.min(r.snippet.length, 100);
      score += (snippetLen / 100) * 20; // 摘要质量贡献 20%
      return { ...r, _score: Math.round(score * 10) / 10 };
    });

    scored.sort((a, b) => b._score - a._score);

    // ── 5.5 摘要自动增强：snippet 太短/为空时，用 web_fetch 补充 top 3 ──
    if (enhanceSnippets) {
      const needEnhance = scored.slice(0, Math.min(5, maxResults)).filter(r => r.snippet.length < 30 && r.reachable !== false);
      if (needEnhance.length > 0) {
        sendLog('info', `🔍 自动补充摘要`, `${needEnhance.length} 个结果摘要过短，尝试 web_fetch`);
        const enhanced = await Promise.allSettled(needEnhance.slice(0, 3).map(async (r) => {
          try {
            const fetchResult = await handleWebFetch({ url: r.url, max_chars: 500, retry: false });
            if (fetchResult.success && fetchResult.content) {
              const text = String(fetchResult.content).replace(/\s+/g, ' ').trim();
              r.snippet = text.length > 200 ? text.slice(0, 200) + '…' : text;
              r._enhanced = true;
            }
          } catch { /* enhancement is optional */ }
        }));
        const enhancedCount = enhanced.filter(e => e.status === 'fulfilled').length;
        if (enhancedCount > 0) sendLog('success', `🔍 摘要增强完成`, `${enhancedCount} 个`);
      }
    }

    // 截取最终结果
    const finalResults = scored.slice(0, maxResults);

    // ── 6. 缓存结果 ──
    cacheSet(cacheKey, { results: finalResults, time: Date.now() });

    return buildSearchResponse(finalResults, maxResults, false, engineStats);
  } catch (err) {
    return { success: false, error: (err as Error).message };
  }
}

/** 构建搜索响应（格式化文本 + 结构化 JSON） */
function buildSearchResponse(
  results: Array<{ title: string; url: string; snippet: string; engine: string; weight?: number; reachable?: boolean; _score?: number; _enhanced?: boolean }>,
  maxResults: number,
  fromCache: boolean,
  engineStats?: Record<string, string>,
): ToolResult {
  const sliced = results.slice(0, maxResults);

  // 格式化文本（保持向后兼容）
  const now = new Date();
  const dateStr = `${now.getFullYear()}年${now.getMonth() + 1}月${now.getDate()}日`;
  let formatted = `[当前日期: ${dateStr}（搜索时的实时日期）]`;
  if (fromCache) formatted += ` [缓存]`;
  formatted += `\n\n`;

  if (engineStats) {
    const statsStr = Object.entries(engineStats).map(([k, v]) => `${k}: ${v}`).join(' | ');
    formatted += `[引擎状态: ${statsStr}]\n\n`;
  }

  formatted += sliced.map((r, i) => {
    const marks: string[] = [];
    if (r.reachable === false) marks.push('⚠️可能不可达');
    if (r._score !== undefined) marks.push(`${r._score}分`);
    if (r._enhanced) marks.push('📝增强摘要');
    const markStr = marks.length > 0 ? ` [${marks.join(' ')}]` : '';
    return `[${i + 1}] ${r.title}${markStr}\n    URL: ${r.url}\n    ${r.snippet}`;
  }).join('\n\n');

  // 结构化 JSON（新增）
  const structured = sliced.map((r, i) => ({
    index: i + 1,
    title: r.title,
    url: r.url,
    snippet: r.snippet,
    engine: r.engine,
    reachable: r.reachable,
    ...(r._score !== undefined && { score: r._score }),
    ...(r._enhanced && { enhanced_snippet: true }),
  }));

  return {
    success: true,
    query: '',
    results: sliced,
    total: sliced.length,
    formatted,
    structured,
    from_cache: fromCache,
    engine_stats: engineStats || {},
  };
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

/** 解析 DuckDuckGo Lite HTML 搜索结果 */
function parseDDGResults(html: string, maxResults: number): Array<{ title: string; url: string; snippet: string }> {
  const results: Array<{ title: string; url: string; snippet: string }> = [];

  // DDG Lite 结果：<tr class="result-snippet"> 内的 <a> + <td class="result-snippet">
  // 尝试匹配：<a rel="nofollow" href="...">title</a> 后跟 <span class="link-text"> 显示URL
  // 以及 <td class="result-snippet">snippet</td>
  const blockRegex = /<tr[^>]*class="[^"]*result-snippet[^"]*"[^>]*>([\s\S]*?)<\/tr>/gi;
  let blockMatch;

  while ((blockMatch = blockRegex.exec(html)) !== null && results.length < maxResults) {
    const block = blockMatch[1];

    // 提取 URL
    const linkMatch = block.match(/<a[^>]*href="(https?:\/\/[^"]*)"[^>]*>([\s\S]*?)<\/a>/);
    if (!linkMatch) continue;

    const url = decodeHTML(linkMatch[1].trim());
    const title = decodeHTML(linkMatch[2].replace(/<[^>]+>/g, '').trim());

    // 跳过 DuckDuckGo 自身链接
    if (url.includes('duckduckgo.com')) continue;

    // 提取摘要
    const snippetMatch = block.match(/<td[^>]*class="[^"]*result-snippet[^"]*"[^>]*>([\s\S]*?)<\/td>/);
    const snippet = snippetMatch ? decodeHTML(snippetMatch[1].replace(/<[^>]+>/g, '').trim()) : '';

    if (title && url.startsWith('http')) {
      results.push({ title, url, snippet });
    }
  }

  // 回退：尝试匹配更通用的 DDG 结果格式
  if (results.length === 0) {
    const altRegex = /<a[^>]*href="(https?:\/\/[^"]*)"[^>]*class="[^"]*result-link[^"]*"[^>]*>([\s\S]*?)<\/a>/gi;
    let altMatch;
    while ((altMatch = altRegex.exec(html)) !== null && results.length < maxResults) {
      const url = decodeHTML(altMatch[1].trim());
      const title = decodeHTML(altMatch[2].replace(/<[^>]+>/g, '').trim());
      if (url.includes('duckduckgo.com')) continue;
      if (title && url.startsWith('http')) {
        results.push({ title, url, snippet: '' });
      }
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
