/**
 * Tool Handlers - 系统与网络操作
 */

import * as fs from 'fs/promises';
import * as path from 'path';
import { spawn } from 'child_process';
import * as crypto from 'crypto';
import { checkPathAllowed, checkCommandAllowed } from './tool-security.js';
import { mainWindow } from './main.js';
import { sendLog, resolvePath, type ToolResult } from './tool-handlers-shared.js';
import { getWorkspaceDir } from './workspace.js';
import { getSetting } from './db/sqlite.js';

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
  HTTP_TIMEOUT = Math.max(5000, ms);
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

// ── 浏览器回退结果缓存 ─────────────────────────────
// 浏览器渲染耗时数秒，同一 URL 在多次搜索中可能被重复抓取
interface BrowserCacheEntry { text: string; time: number; }
const _browserFetchCache = new Map<string, BrowserCacheEntry>();
const BROWSER_CACHE_MAX = 100;
const BROWSER_CACHE_TTL = 10 * 60 * 1000; // 10 分钟

function browserCacheGet(url: string): string | null {
  const entry = _browserFetchCache.get(url);
  if (!entry) return null;
  if (Date.now() - entry.time > BROWSER_CACHE_TTL) { _browserFetchCache.delete(url); return null; }
  return entry.text;
}
function browserCacheSet(url: string, text: string): void {
  if (_browserFetchCache.size >= BROWSER_CACHE_MAX) {
    const firstKey = _browserFetchCache.keys().next().value;
    if (firstKey !== undefined) _browserFetchCache.delete(firstKey);
  }
  _browserFetchCache.set(url, { text, time: Date.now() });
}

// ── 反爬请求头 ────────────────────────────────────
const UA_POOL = [
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36 Edg/130.0.0.0',
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 14_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.1 Safari/605.1.15',
  'Mozilla/5.0 (X11; Linux x86_64; rv:132.0) Gecko/20100101 Firefox/132.0',
  'Mozilla/5.0 (Linux; Android 14; Pixel 8 Pro) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Mobile Safari/537.36',
];
const LANG_POOL = ['zh-CN,zh;q=0.9,en;q=0.8', 'zh-CN,zh;q=0.9,en-US;q=0.8,en;q=0.7', 'en-US,en;q=0.9,zh-CN;q=0.8'];

/** 被拦截页面特征模式 */
const BLOCKED_PATTERNS = [
  /<title>\s*(Just a moment\.\.\.|Attention Required!|Cloudflare)\s*<\/title>/i,
  /challenge-platform/i,
  /\.cf-challenge-/i,
  /<title>\s*Access Denied\s*<\/title>/i,
  /<title>\s*403 Forbidden\s*<\/title>/i,
  /请启用JavaScript/i,
  /Please enable JavaScript/i,
  /Checking your browser/i,
  /DDoS protection/i,
];

function isBlockedPage(html: string): boolean {
  if (html.length < 80) return true;
  for (const p of BLOCKED_PATTERNS) { if (p.test(html)) return true; }
  return false;
}

function jitter(ms: number): number { return ms + Math.floor(Math.random() * ms * 0.6); }

/** 构建 fetch 请求头，根据尝试次数轮换 UA 和语言 */
function buildFetchHeaders(url: string, attemptIndex: number, useMobileUA: boolean = false): Record<string, string> {
  const ua = useMobileUA
    ? 'Mozilla/5.0 (iPhone; CPU iPhone OS 16_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/16.0 Mobile/15E148 Safari/604.1'
    : UA_POOL[attemptIndex % UA_POOL.length];
  const lang = LANG_POOL[attemptIndex % LANG_POOL.length];
  let referer = 'https://www.google.com/';
  try {
    const u = new URL(url);
    referer = `${u.protocol}//${u.hostname}/`;
  } catch { /* ignore */ }
  return {
    'User-Agent': ua,
    'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8',
    'Accept-Language': lang,
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
async function fetchWithTimeout(url: string, timeout = HTTP_TIMEOUT, headers?: Record<string,string>, attemptIndex = 0): Promise<Response | null> {
  const _headers = headers || buildFetchHeaders(url, attemptIndex);

  const controller = new AbortController();
  const tid = setTimeout(() => controller.abort(), timeout);
  try {
    const resp = await fetch(url, { headers: _headers, signal: controller.signal, redirect: 'follow' });
    clearTimeout(tid); return resp;
  } catch { clearTimeout(tid); return null; }
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

/** HTML → Markdown 转换（保留标题、列表、链接、代码块等结构） */
function htmlToMarkdown(html: string): string {
  let text = html;
  // 移除 script/style/nav/header/footer 等噪音标签
  text = text.replace(/<script[\s\S]*?<\/script>/gi, '');
  text = text.replace(/<style[\s\S]*?<\/style>/gi, '');
  text = text.replace(/<noscript[\s\S]*?<\/noscript>/gi, '');
  text = text.replace(/<nav[\s\S]*?<\/nav>/gi, '');
  text = text.replace(/<header[\s\S]*?<\/header>/gi, '');
  text = text.replace(/<footer[\s\S]*?<\/footer>/gi, '');
  text = text.replace(/<aside[\s\S]*?<\/aside>/gi, '');
  text = text.replace(/<iframe[\s\S]*?<\/iframe>/gi, '');
  text = text.replace(/<svg[\s\S]*?<\/svg>/gi, '');
  text = text.replace(/<!--[\s\S]*?-->/g, '');

  // 标题 → Markdown 标题
  text = text.replace(/<h1[^>]*>([\s\S]*?)<\/h1>/gi, '\n# $1\n');
  text = text.replace(/<h2[^>]*>([\s\S]*?)<\/h2>/gi, '\n## $1\n');
  text = text.replace(/<h3[^>]*>([\s\S]*?)<\/h3>/gi, '\n### $1\n');
  text = text.replace(/<h4[^>]*>([\s\S]*?)<\/h4>/gi, '\n#### $1\n');
  text = text.replace(/<h5[^>]*>([\s\S]*?)<\/h5>/gi, '\n##### $1\n');
  text = text.replace(/<h6[^>]*>([\s\S]*?)<\/h6>/gi, '\n###### $1\n');

  // 代码块
  text = text.replace(/<pre[^>]*>([\s\S]*?)<\/pre>/gi, '\n```\n$1\n```\n');
  text = text.replace(/<code[^>]*>([\s\S]*?)<\/code>/gi, '`$1`');

  // 链接和图片
  text = text.replace(/<a[^>]*href=["']([^"']*)["'][^>]*>([\s\S]*?)<\/a>/gi, '[$2]($1)');
  text = text.replace(/<img[^>]*src=["']([^"']*)["'][^>]*alt=["']([^"']*)["'][^>]*\/?>/gi, '![$2]($1)');
  text = text.replace(/<img[^>]*src=["']([^"']*)["'][^>]*\/?>/gi, '![]($1)');

  // 列表
  text = text.replace(/<li[^>]*>([\s\S]*?)<\/li>/gi, '- $1\n');
  text = text.replace(/<\/?(ul|ol)[^>]*>/gi, '\n');

  // 引用块
  text = text.replace(/<blockquote[^>]*>([\s\S]*?)<\/blockquote>/gi, '\n> $1\n');

  // 表格行
  text = text.replace(/<\/tr>/gi, '|\n');
  text = text.replace(/<tr[^>]*>/gi, '|');
  text = text.replace(/<\/?(td|th)[^>]*>/gi, '');

  // 块级标签转为换行
  text = text.replace(/<\/(p|div|section|article)[^>]*>/gi, '\n');
  text = text.replace(/<(br|hr)[^>]*\/?>/gi, '\n');

  // 加粗/斜体
  text = text.replace(/<(strong|b)[^>]*>([\s\S]*?)<\/\1>/gi, '**$2**');
  text = text.replace(/<(em|i)[^>]*>([\s\S]*?)<\/\1>/gi, '*$2*');

  // 移除剩余标签
  text = text.replace(/<[^>]+>/g, '');
  // 解码 HTML 实体
  text = decodeHTMLEntities(text);
  // 清理多余空白
  text = text.replace(/[ \t]+/g, ' ');
  text = text.replace(/\n\s*\n\s*\n+/g, '\n\n');
  text = text.split('\n').map(l => l.trim()).join('\n');
  return text.trim();
}

import { browserOpen, browserExtract, browserClose } from './browser.js';

// ──────────────────────────────────────────────────
// web_fetch 重试配置
// ──────────────────────────────────────────────────
const FETCH_MAX_RETRIES = 3;          // fetch 阶段最多重试 3 次
const FETCH_RETRY_DELAYS = [2000, 4000, 6000]; // 指数退避 (ms)，由 jitter() 随机化
/** 自动抓取最大条数硬上限 — 防止上下文爆炸 */
const MAX_AUTO_FETCH = 8;
/** fetch 全部失败后自动回退到浏览器渲染 */
const BROWSER_FALLBACK_ENABLED = true;
/** 内容过短阈值：小于此字符数且是 HTML 时，自动升级到浏览器渲染 */
const SHORT_CONTENT_THRESHOLD = 200;
/** 需要回退浏览器的 HTTP 状态码（反爬/拦截信号） */
const BROWSER_FALLBACK_STATUSES = new Set([403, 503, 429, 502]);

/** 浏览器回退：打开 URL → 等待渲染 → 提取内容 */
async function browserFallback(url: string, maxChars: number): Promise<{ text: string; method: string } | null> {
  // 1) 检查浏览器回退缓存
  const cached = browserCacheGet(url);
  if (cached) {
    let text = cached;
    if (maxChars > 0 && text.length > maxChars) text = text.slice(0, maxChars);
    sendLog('info', `🌐 browser 缓存命中`, url.slice(0, 60));
    return { text, method: 'browser(cached)' };
  }

  try {
    const openResult = await browserOpen(url);
    if (!openResult.success) return null;
    await new Promise(r => setTimeout(r, 2500)); // 等待 JS 渲染
    const extractResult = await browserExtract();
    browserClose();
    if (extractResult.success && extractResult.text && extractResult.text.length > 0) {
      let text = extractResult.text;
      if (maxChars > 0 && text.length > maxChars) text = text.slice(0, maxChars);
      // 写入浏览器回退缓存（缓存完整文本，下次命中时再截断）
      if (extractResult.text.length >= 100) {
        browserCacheSet(url, extractResult.text);
      }
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

  // ── Phase 1 & 2: HTTP fetch with UA rotation + 反爬增强 ──
  let lastError = '';
  const maxAttempts = shouldRetry ? FETCH_MAX_RETRIES + 1 : 1;

  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    if (attempt > 0) {
      const baseDelay = FETCH_RETRY_DELAYS[attempt - 1] || 5000;
      const delay = jitter(baseDelay);
      sendLog('warn', `🌐 web_fetch 重试`, `第 ${attempt + 1}/${maxAttempts} 次, 等待 ${delay}ms, UA#${attempt % UA_POOL.length}`);
      await new Promise(r => setTimeout(r, delay));
    }

    const headers = buildFetchHeaders(url, attempt, useMobileUA);

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

      // 无 content-length 头时，流式读取并限制最大体积（防 OOM）
      const MAX_BODY_SIZE = 10 * 1024 * 1024; // 10MB
      let text: string;
      if (!contentLength && resp.body) {
        const reader = resp.body.getReader();
        const chunks: Uint8Array[] = [];
        let totalSize = 0;
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          totalSize += value.length;
          if (totalSize > MAX_BODY_SIZE) {
            reader.cancel();
            return { success: false, error: `页面过大 (超过 10MB)，已中止下载` };
          }
          chunks.push(value);
        }
        const decoder = new TextDecoder();
        text = decoder.decode(Buffer.concat(chunks));
      } else if (!contentLength) {
        // 无 body stream 回退，但仍需限制
        text = await resp.text();
        if (text.length > MAX_BODY_SIZE) {
          return { success: false, error: `页面过大 (${(text.length / 1024 / 1024).toFixed(1)}MB)，超过 10MB 限制` };
        }
      } else {
        text = await resp.text();
      }
      const isHTML = contentType.includes('html');
      if (isHTML) {
        // P2 修复：支持 extract_mode 参数 — 'markdown' 模式保留结构化格式，'text' 模式纯文本
        const extractMode = params.extract_mode || 'text';
        if (extractMode === 'markdown') {
          text = htmlToMarkdown(text);
        } else {
          text = htmlToText(text);
        }
        // 检测是否被拦截（Cloudflare/验证码/空白页）
        if (isBlockedPage(text) && BROWSER_FALLBACK_ENABLED) {
          sendLog('warn', `🌐 web_fetch 检测到拦截页`, '自动回退浏览器渲染');
          const browserResult = await browserFallback(url, maxChars);
          if (browserResult) {
            return {
              success: true, url, content: browserResult.text,
              content_type: 'text/html (browser)', status: resp.status,
              truncated: maxChars > 0 && browserResult.text.length >= maxChars,
              length: browserResult.text.length, retries: attempt, method: 'browser(blocked)',
            };
          }
        }
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
        method: `fetch (UA#${attempt % UA_POOL.length})`,
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
 * SearXNG 元搜索引擎 — JSON API 搜索
 * 支持 70+ 引擎聚合、隐私保护、无广告
 */
async function handleWebSearchSearxng(
  query: string,
  maxResults: number,
  timeRange: string,
  _enhanceSnippets: boolean
): Promise<ToolResult> {
  const url = getSetting<string>('searxng_url', '');
  if (!url) {
    return { success: false, error: 'SearXNG API 地址未配置。请在 SearXNG 设置中填写 API 地址。' };
  }
  const engines = getSetting<string>('searxng_engines', '');
  const language = getSetting<string>('searxng_language', 'zh-CN');
  const safesearch = getSetting<number>('searxng_safesearch', 1);
  const cfgTimeRange = getSetting<string>('searxng_time_range', '');
  const effectiveTimeRange = timeRange || cfgTimeRange;
  const cfgMaxResults = getSetting<number>('searxng_max_results', 0);
  const effectiveMax = cfgMaxResults > 0 ? cfgMaxResults : maxResults;

  const format = getSetting<string>('searxng_format', 'json');
  const isHtml = format === 'html';

  const params = new URLSearchParams({ q: query });
  if (!isHtml) params.set('format', 'json');
  if (engines) params.set('engines', engines);
  if (language) params.set('language', language);
  if (safesearch > 0) params.set('safesearch', String(safesearch));
  if (effectiveTimeRange) params.set('time_range', effectiveTimeRange);

  const authKey = getSetting<string>('searxng_auth_key', '');
  const authType = getSetting<string>('searxng_auth_type', 'bearer');

  const apiUrl = `${url.replace(/\/+$/, '')}/search?${params.toString()}`;
  sendLog('info', `🔍 SearXNG 搜索`, `${query} → ${url} (${format})`);

  try {
    const headers = buildFetchHeaders(apiUrl, 0);
    if (authKey) {
      if (authType === 'basic') {
        headers['Authorization'] = 'Basic ' + Buffer.from(authKey).toString('base64');
      } else {
        headers['Authorization'] = `Bearer ${authKey}`;
      }
    }
    const resp = await fetchWithTimeout(apiUrl, HTTP_TIMEOUT, headers);
    if (!resp || !resp.ok) {
      return {
        success: false,
        error: `SearXNG 搜索失败 (HTTP ${resp?.status || 'timeout'})。请检查 SearXNG 实例是否运行正常：${url}。`,
        _searxng_url: apiUrl
      };
    }

    // ── HTML 模式：返回原始网页文本，让 AI 自行分析 ──
    if (isHtml) {
      const html = await resp.text();
      const text = htmlToText(html);
      sendLog('success', `🔍 SearXNG HTML 完成`, `${text.length} 字符`);
      return {
        success: true,
        _mode: 'searxng',
        url: apiUrl,
        content: text,
        content_type: 'text/html',
        length: text.length,
        truncated: false,
        format: 'html',
        _hint: '这是 SearXNG 搜索结果页面的纯文本提取。请从中提取有用的搜索结果信息来回答用户问题。'
      };
    }

    const data = await resp.json() as {
      query: string;
      number_of_results?: number;
      results?: Array<{
        title: string;
        url: string;
        content: string;
        engine: string;
        score?: number;
        category?: string;
      }>;
      unresponsive_engines?: Array<[string, string]>;
    };

    const rawResults = (data.results || []).slice(0, effectiveMax);
    if (rawResults.length === 0) {
      return { success: false, error: 'SearXNG 未返回任何结果，请尝试其他关键词或调整搜索引擎配置' };
    }

    // 转换为兼容格式
    const results = rawResults.map(r => ({
      title: (r.title || '').replace(/<[^>]+>/g, '').trim(),
      url: r.url,
      snippet: (r.content || '').replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim(),
      engine: r.engine || 'searxng',
      weight: 80,
      reachable: true,
    }));

    const engineNames = [...new Set(rawResults.map(r => r.engine))].filter(Boolean);
    const unresponsive = data.unresponsive_engines || [];
    const engineStats: Record<string, string> = {};
    for (const engine of engineNames) {
      engineStats[engine] = `${rawResults.filter(r => r.engine === engine).length} 条`;
    }
    for (const [eng, reason] of unresponsive) {
      engineStats[eng] = `⚠️ ${reason}`;
    }

    sendLog('success', `🔍 SearXNG 完成`, `${results.length} 条结果, 引擎: ${engineNames.join(', ')}`);

    const result = buildSearchResponse(
      results.map(r => ({
        title: r.title,
        url: r.url,
        snippet: r.snippet,
        engine: `searxng:${r.engine}`,
        weight: 80,
        reachable: true,
      })),
      effectiveMax,
      false,
      engineStats,
      query,
    );
    result._mode = 'searxng';
    return result;
  } catch (err) {
    sendLog('error', `🔍 SearXNG 异常`, (err as Error).message);
    return { success: false, error: `SearXNG 搜索异常: ${(err as Error).message}` };
  }
}

/**
 * Web Search — 联网搜索（并行多引擎 + LRU 缓存 + 智能排序 + 时间过滤 + 摘要增强）
 * 同时请求 Bing / 百度 / 搜狗 / 360搜索，智能排序后返回
 * 如果启用了 SearXNG，则使用 SearXNG JSON API 替代
 */
export async function handleWebSearch(params: { query: string; max_results?: number; time_range?: string; enhance_snippets?: boolean; fetch_top?: number }): Promise<ToolResult> {
  try {
    const query = params.query;
    if (!query || query.trim().length === 0) {
      return { success: false, error: '搜索关键词不能为空' };
    }

    const maxResults = Math.min(params.max_results || 30, 30);
    const timeRange = params.time_range || '';
    const enhanceSnippets = params.enhance_snippets !== false;
    const aiFetchTop = Math.min(Math.max(3, params.fetch_top || 5), MAX_AUTO_FETCH);

    // 内置引擎默认：使用 AI 指定条数 + 顺序抓取
    let fetchTop = Math.min(aiFetchTop, MAX_AUTO_FETCH);
    let fetchMode: 'sequential' | 'random' = 'sequential';

    let result: ToolResult;

    // ── SearXNG 模式 ──
    const searxngEnabled = getSetting<boolean>('searxng_enabled', false);
    if (searxngEnabled) {
      // SearXNG 模式下读取用户面板设置的抓取条数和类型
      const userFetchCount = getSetting<number>('fetch_count', 0);
      fetchMode = (getSetting<string>('fetch_mode', 'sequential') || 'sequential') as 'sequential' | 'random';
      fetchTop = Math.min(userFetchCount > 0 ? Math.max(3, userFetchCount) : aiFetchTop, MAX_AUTO_FETCH);
      sendLog('info', `🔍 web_search → SearXNG 模式`, `"${query}" | 抓取=${fetchTop}条 ${fetchMode === 'random' ? '随机' : '顺序'}`);
      result = await handleWebSearchSearxng(query, maxResults, timeRange, enhanceSnippets);
    } else {
      sendLog('info', `🔍 web_search → 内置引擎`, `"${query}" | 抓取=${fetchTop}条 顺序`);
      result = await (async () => {
    const cacheKey = `${query}|${maxResults}|${timeRange}`;

    // ── 时间范围 → URL 参数映射 ──
    let bingFreshness = '';
    if (timeRange) {
      const tr = timeRange.toLowerCase();
      if (tr === 'day' || tr === '1d' || tr === '一天') { bingFreshness = 'Day'; }
      else if (tr === 'week' || tr === '1w' || tr === '一周') { bingFreshness = 'Week'; }
      else if (tr === 'month' || tr === '1m' || tr === '一月') { bingFreshness = 'Month'; }
    }

    // ── 1. 检查缓存 ──
    const cached = cacheGet(cacheKey);
    if (cached) {
      sendLog('success', `🔍 web_search 缓存命中`, `"${query}" → ${cached.results.length} 条`);
    const cachedResult = buildSearchResponse(cached.results, maxResults, true, undefined, query);
    cachedResult._mode = 'builtin';
    return cachedResult;
  }

    sendLog('info', `🔍 web_search`, `"${query}" (${maxResults} 条) [并行]`);

    // ── 2. 并行请求所有搜索引擎 ──
    const engines: Array<{ name: string; weight: number; fetcher: () => Promise<Array<{title:string;url:string;snippet:string}>> }> = [
      {
        name: 'bing', weight: 90,
        fetcher: async () => {
          const bingUrl = `https://www.bing.com/search?q=${encodeURIComponent(query)}&count=${maxResults}${bingFreshness ? '&freshness=' + bingFreshness : ''}`;
          const resp = await fetchWithTimeout(bingUrl, HTTP_TIMEOUT, undefined, 0);
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
        name: 'sogou', weight: 75,
        fetcher: async () => {
          const resp = await fetchWithTimeout(
            `https://www.sogou.com/web?query=${encodeURIComponent(query)}`
          );
          if (!resp?.ok) throw new Error(`搜狗 ${resp?.status}`);
          return parseSogouResults(await resp.text(), maxResults);
        }
      },
      {
        name: '360搜索', weight: 75,
        fetcher: async () => {
          const resp = await fetchWithTimeout(
            `https://www.so.com/s?q=${encodeURIComponent(query)}`
          );
          if (!resp?.ok) throw new Error(`360 ${resp?.status}`);
          return parse360Results(await resp.text(), maxResults);
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
            'User-Agent': UA_POOL[0],
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
              (r as any)._enhanced = true;
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

    const finalResult = buildSearchResponse(finalResults, maxResults, false, engineStats, query);
    finalResult._mode = 'builtin';
    return finalResult;
  })();
    }

    // ── 自动抓取前 N 条完整内容 ──
    if (fetchTop > 0 && result.success && (result as any).results) {
      result = await applyAutoFetch(result, fetchTop, fetchMode);
    }

    return result;
  } catch (err) {
    return { success: false, error: (err as Error).message };
  }
}

/** 对搜索结果的前 fetchTop 条自动调用 web_fetch 获取完整内容
 *  @param fetchMode 'sequential'=顺序抓取前N条 | 'random'=从结果中随机选取N条
 *  抓取失败时：先依赖 handleWebFetch 内置的浏览器回退，全部失败后随机选 1 条未抓取的补充抓取 */

/** 计算搜索结果标题与搜索 query 的相关性得分
 *  提取 query 中的关键词（CJK 字符取 2-4 字片段，英文取单词），
 *  检查标题中是否包含这些关键词。返回 0-100 的得分 */
function computeRelevance(query: string, title: string, snippet: string): number {
  if (!query) return 50; // 无 query 信息时不做过滤
  const q = query.toLowerCase();
  const t = title.toLowerCase();
  const s = (snippet || '').toLowerCase();
  let score = 0;

  // 1) 提取 query 中的 CJK 双/三字片段
  const cjkTokens: string[] = [];
  for (let i = 0; i < q.length; i++) {
    if (/[\u4e00-\u9fff]/.test(q[i])) {
      if (i + 1 < q.length && /[\u4e00-\u9fff]/.test(q[i + 1])) {
        cjkTokens.push(q.slice(i, i + 2));
        if (i + 2 < q.length && /[\u4e00-\u9fff]/.test(q[i + 2])) {
          cjkTokens.push(q.slice(i, i + 3));
        }
      }
    }
  }
  // 去重
  const uniqueCJK = [...new Set(cjkTokens)];

  // 2) 提取英文单词（≥2 个字符）
  const enWords = q.match(/[a-z]{2,}/g) || [];

  // 3) 标题匹配计分
  for (const token of uniqueCJK) {
    if (t.includes(token)) { score += 25; break; } // 命中一个 CJK 片段即可
  }
  for (const word of enWords) {
    if (t.includes(word)) score += 15;
  }
  // 摘要匹配加成
  for (const token of uniqueCJK.slice(0, 3)) {
    if (s.includes(token)) score += 5;
  }
  for (const word of enWords.slice(0, 3)) {
    if (s.includes(word)) score += 3;
  }

  return Math.min(100, score);
}

async function applyAutoFetch(result: ToolResult, fetchTop: number, fetchMode: 'sequential' | 'random' = 'sequential'): Promise<ToolResult> {
  const results = (result as any).results as Array<{ url: string; title: string; snippet: string }> | undefined;
  if (!results || results.length === 0) return result;

  const count = Math.min(fetchTop, results.length, MAX_AUTO_FETCH);

  // ── 相关性过滤：只抓取标题与搜索词至少有部分匹配的结果 ──
  // 从搜索结果中反向获取原始 query（若有）作为过滤依据
  const searchQuery = (result as any).query as string || '';
  const scoredResults = results.map((r, idx) => {
    const relevance = computeRelevance(searchQuery, r.title, r.snippet);
    return { ...r, _idx: idx, _relevance: relevance };
  });
  // 按相关性降序排列（相关性高的优先抓取）
  scoredResults.sort((a, b) => b._relevance - a._relevance);
  // 过滤掉明显无关的结果（相关性为 0）
  const relevantResults = scoredResults.filter(r => r._relevance > 0);
  const skippedCount = results.length - relevantResults.length;
  if (skippedCount > 0) {
    sendLog('info', `🔍 相关性过滤: ${skippedCount} 条无关结果已跳过`, 
      results.filter((_, i) => !relevantResults.some(rr => rr._idx === i)).map(r => r.title.slice(0, 30)).join(', '));
  }
  const effectiveResults = relevantResults.length > 0 ? relevantResults : scoredResults; // fallback: 全部无关时仍抓取

  // ── 构建抓取列表 ──
  let fetchList: Array<{ url: string; title: string; originalIndex: number }>;
  if (fetchMode === 'random') {
    // Fisher-Yates 洗牌索引，取前 count 个
    const indices = effectiveResults.slice(0, Math.min(count * 2, effectiveResults.length)).map((_, i) => i);
    for (let i = indices.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [indices[i], indices[j]] = [indices[j], indices[i]];
    }
    fetchList = indices.slice(0, count).map(idx => ({
      url: effectiveResults[idx].url,
      title: effectiveResults[idx].title,
      originalIndex: effectiveResults[idx]._idx,
    }));
  } else {
    fetchList = effectiveResults.slice(0, count).map((r) => ({
      url: r.url,
      title: r.title,
      originalIndex: r._idx,
    }));
  }

  const modeLabel = fetchMode === 'random' ? '随机' : '顺序';
  sendLog('info', `⬇️ 自动抓取 ${fetchList.length} 条网页 (${modeLabel})`, fetchList.map(r => r.title.slice(0, 30)).join(', '));

  const fetched: Array<{ url: string; title: string; content: string }> = [];
  const fetchedUrls = new Set<string>();
  const failedUrls = new Set<string>();

  /** 尝试抓取单条 URL，成功则加入 fetched */
  const tryFetchOne = async (url: string, title: string): Promise<boolean> => {
    if (fetchedUrls.has(url)) return false;
    try {
      const fetchResult = await handleWebFetch({ url, retry: false });
      if (fetchResult.success && fetchResult.content) {
        fetched.push({ url, title, content: String(fetchResult.content) });
        fetchedUrls.add(url);
        sendLog('debug', `  ✅ ${title.slice(0, 40)} (${String(fetchResult.content).length} 字)`);
        return true;
      } else {
        sendLog('warn', `  ❌ ${title.slice(0, 50)} — ${fetchResult.error || '无内容'}`);
      }
    } catch (e) {
      sendLog('warn', `  ❌ ${title.slice(0, 50)} — ${(e as Error).message}`);
    }
    return false;
  };

  for (const item of fetchList) {
    const ok = await tryFetchOne(item.url, item.title);
    if (!ok) {
      failedUrls.add(item.url);
      // ── 失败重试：从剩余未抓取结果中随机选 1 条 ──
      const unfetched = results.filter((r, idx) =>
        !fetchedUrls.has(r.url) && !failedUrls.has(r.url)
      );
      if (unfetched.length > 0) {
        const pick = unfetched[Math.floor(Math.random() * unfetched.length)];
        sendLog('info', `🔄 ${item.title.slice(0, 30)} 抓取失败，随机重试: ${pick.title.slice(0, 40)}`);
        const retryOk = await tryFetchOne(pick.url, pick.title);
        if (!retryOk) {
          failedUrls.add(pick.url);
        }
      }
    }
  }

  sendLog('success', `⬇️ 自动抓取完成`, `${fetched.length} 条成功 / ${failedUrls.size} 条失败`);
  (result as any)._fetched = fetched;
  (result as any)._fetched_count = fetched.length;
  return result;
}

/** 构建搜索响应（格式化文本 + 结构化 JSON） */
function buildSearchResponse(
  results: Array<{ title: string; url: string; snippet: string; engine: string; weight?: number; reachable?: boolean; _score?: number; _enhanced?: boolean }>,
  maxResults: number,
  fromCache: boolean,
  engineStats?: Record<string, string>,
  query?: string,
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
    query: query || '',
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

/** 解析搜狗 HTML 搜索结果 */
function parseSogouResults(html: string, maxResults: number): Array<{ title: string; url: string; snippet: string }> {
  const results: Array<{ title: string; url: string; snippet: string }> = [];

  // 搜狗结果块：<div class="vrwrap"> 或 <div class="rb">
  const blockRegex = /<div[^>]*class="[^"]*(?:vrwrap|rb)[^"]*"[^>]*>([\s\S]*?)(?=<div[^>]*class="[^"]*(?:vrwrap|rb)[^"]*"|<div[^>]*id="pagebar)/gi;
  let blockMatch;

  while ((blockMatch = blockRegex.exec(html)) !== null && results.length < maxResults) {
    const block = blockMatch[1];

    // 提取标题和 URL：<a href="..." ...>标题</a>
    const linkMatch = block.match(/<a[^>]*href="(https?:\/\/[^"]*)"[^>]*>([\s\S]*?)<\/a>/i);
    if (!linkMatch) continue;

    const url = decodeHTML(linkMatch[1].trim());
    const title = decodeHTML(linkMatch[2].replace(/<[^>]+>/g, '').trim());

    // 跳过搜狗自身链接
    if (url.includes('sogou.com') || url.includes('sogo.com')) continue;

    // 提取摘要：<p class="star-wiki"> 或 <div class="space-txt"> 或 <p class="str_info">
    const snippetMatch =
      block.match(/<p[^>]*class="[^"]*star-wiki[^"]*"[^>]*>([\s\S]*?)<\/p>/i) ||
      block.match(/<div[^>]*class="[^"]*space-txt[^"]*"[^>]*>([\s\S]*?)<\/div>/i) ||
      block.match(/<p[^>]*class="[^"]*str_info[^"]*"[^>]*>([\s\S]*?)<\/p>/i);
    const snippet = snippetMatch ? decodeHTML(snippetMatch[1].replace(/<[^>]+>/g, '').trim()) : '';

    if (title && url.startsWith('http')) {
      results.push({ title, url, snippet });
    }
  }

  return results;
}

/** 解析 360 搜索 HTML 搜索结果 */
function parse360Results(html: string, maxResults: number): Array<{ title: string; url: string; snippet: string }> {
  const results: Array<{ title: string; url: string; snippet: string }> = [];

  // 360 结果块：<li class="res-list"> 或 <div class="result">
  const blockRegex = /<(?:li[^>]*class="[^"]*res-list[^"]*"|div[^>]*class="[^"]*result[^"]*")[^>]*>([\s\S]*?)(?=<(?:li[^>]*class="[^"]*res-list|div[^>]*class="[^"]*result)|<\/ul>|<\/div>\s*<\/div>\s*$)/gi;
  let blockMatch;

  while ((blockMatch = blockRegex.exec(html)) !== null && results.length < maxResults) {
    const block = blockMatch[1];

    // 提取标题和 URL
    const linkMatch = block.match(/<a[^>]*href="(https?:\/\/[^"]*)"[^>]*>([\s\S]*?)<\/a>/i);
    if (!linkMatch) continue;

    const url = decodeHTML(linkMatch[1].trim());
    const title = decodeHTML(linkMatch[2].replace(/<[^>]+>/g, '').trim());

    // 跳过 360 自身链接
    if (url.includes('so.com') && !url.includes('www.so.com/link')) continue;

    // 提取摘要：<p class="res-desc"> 或 <div class="res-rich"> 或 <p class="res-summary">
    const snippetMatch =
      block.match(/<p[^>]*class="[^"]*res-desc[^"]*"[^>]*>([\s\S]*?)<\/p>/i) ||
      block.match(/<div[^>]*class="[^"]*res-rich[^"]*"[^>]*>([\s\S]*?)<\/div>/i) ||
      block.match(/<p[^>]*class="[^"]*res-summary[^"]*"[^>]*>([\s\S]*?)<\/p>/i) ||
      block.match(/<dd[^>]*>([\s\S]*?)<\/dd>/i);
    const snippet = snippetMatch ? decodeHTML(snippetMatch[1].replace(/<[^>]+>/g, '').trim()) : '';

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

    // 带超时和 UA 的下载，支持重试
    const MAX_RETRIES = 3;
    const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';
    let resp: Response | null = null;
    let lastError: string = '';

    for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), 60_000);
      try {
        resp = await fetch(params.url, {
          signal: controller.signal,
          headers: {
            'User-Agent': UA,
            'Accept': '*/*',
            'Accept-Encoding': 'gzip, deflate, br',
          },
          redirect: 'follow',
        });
        clearTimeout(timeoutId);
        if (resp.ok) break; // 成功
        lastError = `HTTP ${resp.status}: ${resp.statusText}`;
        // 4xx 不重试
        if (resp.status >= 400 && resp.status < 500) break;
      } catch (err) {
        clearTimeout(timeoutId);
        lastError = (err as Error).message;
        if (lastError.includes('abort')) lastError = '下载超时 (60s)';
      }
      if (attempt < MAX_RETRIES) {
        await new Promise(r => setTimeout(r, 1000 * attempt)); // 指数退避
        sendLog('warn', `⬇️ download_file 重试`, `第 ${attempt + 1} 次: ${params.url}`);
      }
    }

    if (!resp || !resp.ok) return { success: false, error: lastError || '下载失败' };

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
    const isWin = process.platform === 'win32';

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
        let child;
        const srcName = path.basename(srcPath);
        const cwd = path.dirname(srcPath);

        if (format === 'zip') {
          if (isWin) {
            // PowerShell 转义单引号：' → ''
            const safeSrc = srcName.replace(/'/g, "''");
            const safeDest = destPath.replace(/'/g, "''");
            child = spawn('powershell', [
              '-NoProfile', '-Command',
              `Compress-Archive -Path '${safeSrc}' -DestinationPath '${safeDest}' -Force`
            ], { cwd, stdio: ['pipe', 'pipe', 'pipe'] });
          } else {
            child = spawn('zip', ['-r', destPath, srcName], { cwd, stdio: ['pipe', 'pipe', 'pipe'] });
          }
        } else {
          // tar.gz: Windows 10+ has tar, Unix has tar
          child = spawn('tar', ['czf', destPath, srcName], { cwd, stdio: ['pipe', 'pipe', 'pipe'] });
        }

        let stderr = '';
        child.stderr.on('data', (d: Buffer) => { stderr += d.toString(); });
        child.on('close', (code) => {
          if (code === 0) {
            fs.stat(destPath).then(s => {
              resolve({ success: true, action: 'create', archive: destPath, size: s.size });
            }).catch(() => resolve({ success: true, action: 'create', archive: destPath }));
          } else {
            resolve({ success: false, error: stderr || `压缩失败 (exit ${code})` });
          }
        });
        child.on('error', (err) => resolve({ success: false, error: err.message }));
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
        let child;
        const isZip = archivePath.endsWith('.zip');

        if (isZip) {
          if (isWin) {
            const safeArchive = archivePath.replace(/'/g, "''");
            const safeDest = destDir.replace(/'/g, "''");
            child = spawn('powershell', [
              '-NoProfile', '-Command',
              `Expand-Archive -Path '${safeArchive}' -DestinationPath '${safeDest}' -Force`
            ], { stdio: ['pipe', 'pipe', 'pipe'] });
          } else {
            child = spawn('unzip', ['-o', archivePath, '-d', destDir], { stdio: ['pipe', 'pipe', 'pipe'] });
          }
        } else {
          child = spawn('tar', ['xzf', archivePath, '-C', destDir], { stdio: ['pipe', 'pipe', 'pipe'] });
        }

        let stderr = '';
        child.stderr.on('data', (d: Buffer) => { stderr += d.toString(); });
        child.on('close', (code) => {
          resolve(code === 0
            ? { success: true, action: 'extract', destination: destDir }
            : { success: false, error: stderr || `解压失败 (exit ${code})` }
          );
        });
        child.on('error', (err) => resolve({ success: false, error: err.message }));
      });
    }
  } catch (err) {
    return { success: false, error: (err as Error).message };
  }
}

// ── datetime: 获取系统精确时间 ──
export function handleDateTime(params: { format?: string; timezone?: string }): ToolResult {
  try {
    const now = new Date();
    const tz = params.timezone || Intl.DateTimeFormat().resolvedOptions().timeZone;
    const fmt = params.format || 'full';

    const iso = now.toISOString();
    const unixSec = Math.floor(now.getTime() / 1000);
    const unixMs = now.getTime();

    // 中文日期（无前导零月份）
    const y = now.getFullYear();
    const m = now.getMonth() + 1;
    const d = now.getDate();
    const weekdays = ['日', '一', '二', '三', '四', '五', '六'];
    const weekday = `星期${weekdays[now.getDay()]}`;
    const dateStr = `${y}年${m}月${d}日 ${weekday}`;

    // 24小时制时间
    const h = now.getHours();
    const min = now.getMinutes();
    const sec = now.getSeconds();
    const time24 = `${String(h).padStart(2, '0')}:${String(min).padStart(2, '0')}:${String(sec).padStart(2, '0')}`;

    // 时段
    const period = h < 6 ? '凌晨' : h < 12 ? '上午' : h < 14 ? '中午' : h < 18 ? '下午' : '晚上';

    // 人性化时间（12小时制 + 时段）
    const h12 = h === 0 ? 12 : h > 12 ? h - 12 : h;
    const timeFriendly = `${period} ${h12}:${String(min).padStart(2, '0')}`;

    // 完整人性化字符串
    const friendly = `${y}年${m}月${d}日 ${weekday} ${timeFriendly}`;

    let result: Record<string, unknown>;

    switch (fmt) {
      case 'iso':
        result = { iso, timezone: tz };
        break;
      case 'unix':
        result = { unix_seconds: unixSec, unix_milliseconds: unixMs, timezone: tz };
        break;
      case 'date':
        result = { date: dateStr, weekday, timezone: tz };
        break;
      case 'time':
        result = { time_24h: time24, period, time_friendly: timeFriendly, timezone: tz };
        break;
      default: // full
        result = {
          iso,
          unix_seconds: unixSec,
          unix_milliseconds: unixMs,
          date: dateStr,
          weekday,
          time_24h: time24,
          period,
          time_friendly: timeFriendly,
          friendly,
          timezone: tz,
          year: y,
          month: m,
          day: d,
          hour: h,
          minute: min,
          second: sec,
          millisecond: now.getMilliseconds(),
          day_of_week: now.getDay(),
        };
    }

    return { success: true, ...result };
  } catch (err) {
    return { success: false, error: (err as Error).message };
  }
}

// ── calculator: 安全数学计算器（纯 JS 递归下降解析，无 eval） ──
export function handleCalculator(params: { expression: string }): ToolResult {
  try {
    const expr = params.expression;
    if (!expr || expr.length > 500) {
      return { success: false, error: '表达式为空或过长（最大500字符）' };
    }
    const result = safeCalc(expr);
    return { success: true, expression: expr, result };
  } catch (err) {
    return { success: false, error: (err as Error).message, expression: params.expression };
  }
}

function safeCalc(expr: string): number {
  expr = expr.replace(/\s+/g, '');
  if (!/^[\d+\-*/().%^]+$/.test(expr)) {
    throw new Error('表达式包含非法字符');
  }
  let pos = 0;

  function parseExpression(): number {
    let left = parseTerm();
    while (pos < expr.length) {
      if (expr[pos] === '+') { pos++; left += parseTerm(); }
      else if (expr[pos] === '-') { pos++; left -= parseTerm(); }
      else break;
    }
    return left;
  }

  function parseTerm(): number {
    let left = parsePower();
    while (pos < expr.length) {
      if (expr[pos] === '*') { pos++; left *= parsePower(); }
      else if (expr[pos] === '/') { pos++; const d = parsePower(); if (d === 0) throw new Error('除数不能为零'); left /= d; }
      else if (expr[pos] === '%') { pos++; left %= parsePower(); }
      else break;
    }
    return left;
  }

  function parsePower(): number {
    let left = parseUnary();
    while (pos < expr.length && expr[pos] === '*' && pos + 1 < expr.length && expr[pos + 1] === '*') {
      pos += 2;
      left = Math.pow(left, parseUnary());
    }
    return left;
  }

  function parseUnary(): number {
    if (expr[pos] === '-') { pos++; return -parseAtom(); }
    if (expr[pos] === '+') { pos++; return parseAtom(); }
    return parseAtom();
  }

  function parseAtom(): number {
    if (expr[pos] === '(') {
      pos++;
      const val = parseExpression();
      if (pos >= expr.length || expr[pos] !== ')') throw new Error('缺少右括号');
      pos++;
      return val;
    }
    const start = pos;
    while (pos < expr.length && /[\d.]/.test(expr[pos])) pos++;
    if (start === pos) throw new Error(`意外字符: ${expr[pos] || 'EOF'}`);
    const num = parseFloat(expr.slice(start, pos));
    if (isNaN(num)) throw new Error(`无效数字: ${expr.slice(start, pos)}`);
    return num;
  }

  const result = parseExpression();
  if (pos < expr.length) throw new Error(`表达式末尾有意外字符: ${expr.slice(pos)}`);
  if (!isFinite(result)) throw new Error('计算结果为无穷大');
  return result;
}

// ── random: 随机数生成 ──
export function handleRandom(params: { type?: string; min?: number; max?: number; count?: number; items?: string[]; length?: number }): ToolResult {
  try {
    const type = params.type || 'int';

    switch (type) {
      case 'int': {
        const min = params.min ?? 0;
        const max = params.max ?? 100;
        if (min > max) return { success: false, error: 'min 不能大于 max' };
        const count = Math.min(params.count ?? 1, 100);
        if (count === 1) {
          return { success: true, type: 'int', result: Math.floor(Math.random() * (max - min + 1)) + min, range: [min, max] };
        }
        const results: number[] = [];
        for (let i = 0; i < count; i++) results.push(Math.floor(Math.random() * (max - min + 1)) + min);
        return { success: true, type: 'int', results, count, range: [min, max] };
      }
      case 'float': {
        const min = params.min ?? 0;
        const max = params.max ?? 1;
        if (min > max) return { success: false, error: 'min 不能大于 max' };
        const count = Math.min(params.count ?? 1, 100);
        if (count === 1) {
          return { success: true, type: 'float', result: Number((Math.random() * (max - min) + min).toFixed(6)), range: [min, max] };
        }
        const results: number[] = [];
        for (let i = 0; i < count; i++) results.push(Number((Math.random() * (max - min) + min).toFixed(6)));
        return { success: true, type: 'float', results, count, range: [min, max] };
      }
      case 'pick': {
        const items = params.items;
        if (!items || items.length === 0) return { success: false, error: 'pick 类型需要提供 items 数组' };
        const count = Math.min(params.count ?? 1, items.length);
        // Fisher-Yates 部分洗牌
        const pool = [...items];
        const picked: string[] = [];
        for (let i = 0; i < count; i++) {
          const idx = Math.floor(Math.random() * pool.length);
          picked.push(pool[idx]);
          pool.splice(idx, 1);
        }
        return { success: true, type: 'pick', result: count === 1 ? picked[0] : picked, from: items.length, count };
      }
      case 'string': {
        const length = Math.min(params.length ?? 8, 256);
        const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
        // 使用 crypto 增强随机性
        const buf = crypto.randomBytes(length);
        let result = '';
        for (let i = 0; i < length; i++) {
          result += chars.charAt(buf[i] % chars.length);
        }
        return { success: true, type: 'string', result, length, charset: 'alphanumeric' };
      }
      default:
        return { success: false, error: `未知类型: ${type}。支持: int / float / pick / string` };
    }
  } catch (err) {
    return { success: false, error: (err as Error).message };
  }
}

// ── uuid: 生成 UUID v4 ──
export function handleUUID(params: { count?: number }): ToolResult {
  try {
    const crypto = require('crypto');
    const count = Math.min(params.count ?? 1, 20);
    if (count === 1) {
      return { success: true, result: crypto.randomUUID() };
    }
    const results: string[] = [];
    for (let i = 0; i < count; i++) results.push(crypto.randomUUID());
    return { success: true, results, count };
  } catch (err) {
    return { success: false, error: (err as Error).message };
  }
}

// ── json_format: JSON 格式化 + 验证 ──
export function handleJsonFormat(params: { json: string; indent?: number; sort_keys?: boolean }): ToolResult {
  try {
    const parsed = JSON.parse(params.json);
    const indent = params.indent ?? 2;
    let formatted: string;
    if (params.sort_keys) {
      formatted = JSON.stringify(sortObjectKeys(parsed), null, indent);
    } else {
      formatted = JSON.stringify(parsed, null, indent);
    }
    const size = Buffer.byteLength(formatted, 'utf-8');
    return { success: true, formatted, original_size: params.json.length, formatted_size: size, keys: Object.keys(parsed).length };
  } catch (err) {
    return { success: false, error: `JSON 解析失败: ${(err as Error).message}`, input_preview: params.json.slice(0, 200) };
  }

  function sortObjectKeys(obj: any): any {
    if (Array.isArray(obj)) return obj.map(sortObjectKeys);
    if (obj !== null && typeof obj === 'object') {
      const sorted: Record<string, any> = {};
      for (const k of Object.keys(obj).sort()) sorted[k] = sortObjectKeys(obj[k]);
      return sorted;
    }
    return obj;
  }
}

// ── hash: 哈希计算 ──
export function handleHash(params: { text: string; algorithm?: string }): ToolResult {
  try {
    const crypto = require('crypto');
    const algo = (params.algorithm || 'sha256').toLowerCase().replace('-', '');
    const validAlgos = ['md5', 'sha1', 'sha256', 'sha384', 'sha512'];
    if (!validAlgos.includes(algo)) {
      return { success: false, error: `不支持的算法: ${algo}。支持: ${validAlgos.join(', ')}` };
    }
    const hash = crypto.createHash(algo).update(params.text, 'utf-8').digest('hex');
    return { success: true, algorithm: algo, hash, input_length: params.text.length };
  } catch (err) {
    return { success: false, error: (err as Error).message };
  }
}
