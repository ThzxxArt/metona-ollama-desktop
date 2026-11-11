/**
 * Tool Handlers - 系统与网络操作
 */

import * as fs from 'fs/promises';
import * as path from 'path';
import { spawn } from 'child_process';
import { checkPathAllowed, checkCommandAllowed } from '../tool-security.js';
import { mainWindow } from '../window-state.js';
import { sendLog, resolvePath, type ToolResult } from '../tool-handlers-shared.js';
import { getWorkspaceDir } from '../workspace.js';
import { getSetting } from '../db/sqlite.js';
import { browserOpen, browserExtract, browserClose } from '../browser.js';
import { checkPublicHttpUrl } from '../net-guard.js';
// 纯 HTML 工具函数已抽取至独立模块（无 electron/fs 依赖，便于单元测试）
import { decodeHTMLEntities, htmlToText, htmlToMarkdown, isBlockedPage, computeRelevance } from '../html-utils.js';

// run_command / killToolProcess 已迁移至 tools/command.ts

interface SearchResult {
  title: string;
  url: string;
  snippet: string;
  engine: string;
  weight?: number;
  reachable?: boolean;
  _score?: number;
  _enhanced?: boolean;
}
type SearchToolResult = ToolResult & {
  results?: SearchResult[];
  query?: string;
  _fetched?: Array<{ url: string; title: string; content: string }>;
  _fetched_count?: number;
};

/** HTTP 请求超时（毫秒），默认 900s，可通过 IPC 设置 */
let HTTP_TIMEOUT = 900_000;

/** 设置 HTTP 请求超时（毫秒），0=禁用超时 */
export function setHTTPTimeout(ms: number): void {
  HTTP_TIMEOUT = ms === 0 ? 0 : Math.max(5000, ms);
}

export function getHTTPTimeout(): number {
  return HTTP_TIMEOUT;
}

// ── LRU 搜索缓存 ──────────────────────────────────
interface CacheEntry {
  results: Array<{ title: string; url: string; snippet: string; engine: string; reachable?: boolean }>;
  time: number;
}
const _searchCache = new Map<string, CacheEntry>();
const CACHE_MAX = 200;
const CACHE_TTL = 5 * 60 * 1000; // 5 分钟

function cacheGet(query: string): CacheEntry | null {
  const entry = _searchCache.get(query);
  if (!entry) return null;
  if (Date.now() - entry.time > CACHE_TTL) {
    _searchCache.delete(query);
    return null;
  }
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
interface BrowserCacheEntry {
  text: string;
  time: number;
}
const _browserFetchCache = new Map<string, BrowserCacheEntry>();
const BROWSER_CACHE_MAX = 100;
const BROWSER_CACHE_TTL = 10 * 60 * 1000; // 10 分钟

function browserCacheGet(url: string): string | null {
  const entry = _browserFetchCache.get(url);
  if (!entry) return null;
  if (Date.now() - entry.time > BROWSER_CACHE_TTL) {
    _browserFetchCache.delete(url);
    return null;
  }
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

function jitter(ms: number): number {
  return ms + Math.floor(Math.random() * ms * 0.6);
}

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
  } catch {
    /* ignore */
  }
  return {
    'User-Agent': ua,
    Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8',
    'Accept-Language': lang,
    'Accept-Encoding': 'gzip, deflate, br',
    'Cache-Control': 'no-cache',
    DNT: '1',
    Connection: 'keep-alive',
    'Upgrade-Insecure-Requests': '1',
    'Sec-Fetch-Dest': 'document',
    'Sec-Fetch-Mode': 'navigate',
    'Sec-Fetch-Site': 'none',
    'Sec-Fetch-User': '?1',
    Pragma: 'no-cache',
    Referer: referer,
  };
}

/** 带超时的 fetch 封装，timeout=0 表示不超时 */
async function fetchWithTimeout(
  url: string,
  timeout = HTTP_TIMEOUT,
  headers?: Record<string, string>,
  attemptIndex = 0,
): Promise<Response | null> {
  const _headers = headers || buildFetchHeaders(url, attemptIndex);

  if (timeout <= 0) {
    // 0 = 禁用超时
    try {
      return await fetch(url, { headers: _headers, redirect: 'follow' });
    } catch {
      return null;
    }
  }

  const controller = new AbortController();
  const tid = setTimeout(() => controller.abort(), timeout);
  try {
    const resp = await fetch(url, { headers: _headers, signal: controller.signal, redirect: 'follow' });
    clearTimeout(tid);
    return resp;
  } catch {
    clearTimeout(tid);
    return null;
  }
}

// ──────────────────────────────────────────────────
// web_fetch 重试配置
// ──────────────────────────────────────────────────
const FETCH_MAX_RETRIES = 3; // fetch 阶段最多重试 3 次
const FETCH_RETRY_DELAYS = [2000, 4000, 6000]; // 指数退避 (ms)，由 jitter() 随机化
/** 自动抓取最大条数硬上限 — 防止上下文爆炸 */
const MAX_AUTO_FETCH = 8;
/** 自动抓取单页内容字符上限 — 整页全文进结果会造成内存/上下文尖峰，
 *  最终仅靠 truncateToolResult 的 100k 兜底太晚；搜索场景 8k 字符足够 */
const AUTO_FETCH_MAX_CHARS = 8000;
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
    await new Promise((r) => setTimeout(r, 2500)); // 等待 JS 渲染
    const extractResult = await browserExtract();
    await browserClose();
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
    try {
      await browserClose();
    } catch {
      /* */
    }
    return null;
  }
}

export async function handleWebFetch(params: {
  url: string;
  max_chars?: number;
  extract_mode?: string;
  mobile_ua?: boolean;
  retry?: boolean;
}): Promise<ToolResult> {
  const url = params.url;
  if (!url.startsWith('http://') && !url.startsWith('https://')) {
    return { success: false, error: '仅支持 http/https 协议' };
  }

  // SSRF 防护：阻止访问环回/内网/链路本地地址（含域名解析后的真实 IP）
  const netCheck = await checkPublicHttpUrl(url);
  if (!netCheck.ok) {
    sendLog('warn', `🌐 web_fetch 安全拦截`, netCheck.reason || '');
    return {
      success: false,
      error: `安全拦截: ${netCheck.reason}（内网/本机地址访问已被禁用，防止提示注入探测本地服务）`,
    };
  }

  const maxChars = params.max_chars || 0; // 0 = 不截断
  const useMobileUA = params.mobile_ua === true;
  const shouldRetry = params.retry !== false; // 默认开启重试

  sendLog(
    'info',
    `🌐 web_fetch`,
    `${url} (${maxChars > 0 ? maxChars + ' chars' : '完整内容'}${useMobileUA ? ', 移动端UA' : ''})`,
  );

  // ── Phase 1 & 2: HTTP fetch with UA rotation + 反爬增强 ──
  let lastError = '';
  const maxAttempts = shouldRetry ? FETCH_MAX_RETRIES + 1 : 1;

  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    if (attempt > 0) {
      const baseDelay = FETCH_RETRY_DELAYS[attempt - 1] || 5000;
      const delay = jitter(baseDelay);
      sendLog(
        'warn',
        `🌐 web_fetch 重试`,
        `第 ${attempt + 1}/${maxAttempts} 次, 等待 ${delay}ms, UA#${attempt % UA_POOL.length}`,
      );
      await new Promise((r) => setTimeout(r, delay));
    }

    const headers = buildFetchHeaders(url, attempt, useMobileUA);

    try {
      let resp: Response;
      if (HTTP_TIMEOUT > 0) {
        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), HTTP_TIMEOUT);
        try {
          resp = await fetch(url, { headers, signal: controller.signal, redirect: 'follow' });
        } finally {
          clearTimeout(timeoutId);
        }
      } else {
        // 0 = 禁用超时
        resp = await fetch(url, { headers, redirect: 'follow' });
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
        return {
          success: false,
          error: `HTTP ${resp.status}: ${resp.statusText}。可尝试用 browser action="open" 直接打开页面。`,
        };
      }

      const contentType = resp.headers.get('content-type') || '';
      if (
        !contentType.includes('text') &&
        !contentType.includes('html') &&
        !contentType.includes('json') &&
        !contentType.includes('xml')
      ) {
        return {
          success: false,
          error: `不支持的内容类型: ${contentType}。如果是二进制文件，请用 download_file 工具。`,
        };
      }

      const MAX_BODY_SIZE = 10 * 1024 * 1024; // 10MB
      const contentLength = resp.headers.get('content-length');
      const declaredLength = contentLength ? Number.parseInt(contentLength, 10) : NaN;
      if (Number.isFinite(declaredLength) && declaredLength > MAX_BODY_SIZE) {
        return {
          success: false,
          error: `页面过大 (${(declaredLength / 1024 / 1024).toFixed(1)}MB)，超过 10MB 限制`,
        };
      }

      // 始终优先流式读取并限制实际体积。不能信任 Content-Length：
      // 恶意/错误服务器可以声明一个很小的长度却返回超大响应。
      let text: string;
      if (resp.body) {
        const reader = resp.body.getReader();
        const chunks: Uint8Array[] = [];
        let totalSize = 0;
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          totalSize += value.length;
          if (totalSize > MAX_BODY_SIZE) {
            await reader.cancel().catch(() => {});
            return { success: false, error: `页面过大 (超过 10MB)，已中止下载` };
          }
          chunks.push(value);
        }
        const decoder = new TextDecoder();
        text = decoder.decode(Buffer.concat(chunks));
      } else {
        text = await resp.text();
        if (text.length > MAX_BODY_SIZE) {
          return { success: false, error: `页面过大 (${(text.length / 1024 / 1024).toFixed(1)}MB)，超过 10MB 限制` };
        }
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
              success: true,
              url,
              content: browserResult.text,
              content_type: 'text/html (browser)',
              status: resp.status,
              truncated: maxChars > 0 && browserResult.text.length >= maxChars,
              length: browserResult.text.length,
              retries: attempt,
              method: 'browser(blocked)',
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
            success: true,
            url,
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

      sendLog(
        'success',
        `🌐 web_fetch 完成`,
        `HTTP ${resp.status} | ${text.length} chars${truncated ? ' (已截断)' : ''}${attempt > 0 ? ` | 重试${attempt}次后成功` : ''}`,
      );
      return {
        success: true,
        url,
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
        lastError = `请求超时 (${HTTP_TIMEOUT > 0 ? HTTP_TIMEOUT / 1000 : '∞'}s)（将重试）`; // 900s 默认，大页面/慢服务器需要更长时间
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
      return { success: false, error: `fetch 失败: ${errMsg}。可尝试用 browser action="open" 直接打开页面。` };
    }
  }

  // ── Phase 3: 浏览器回退（fetch 全部失败后的最后手段）──
  if (BROWSER_FALLBACK_ENABLED) {
    sendLog('info', `🌐 web_fetch 回退到浏览器渲染`, url);
    const browserResult = await browserFallback(url, maxChars);
    if (browserResult) {
      sendLog('success', `🌐 web_fetch 浏览器渲染完成`, `${browserResult.text.length} 字符`);
      return {
        success: true,
        url,
        content: browserResult.text,
        content_type: 'text/html (browser)',
        status: 200,
        truncated: maxChars > 0 && browserResult.text.length >= maxChars,
        length: browserResult.text.length,
        retries: maxAttempts,
        method: 'browser(fallback)',
      };
    }
    return {
      success: false,
      error: `fetch 和浏览器渲染均失败。${lastError ? '最后错误: ' + lastError : '请检查 URL 是否可访问。'}`,
    };
  }

  return { success: false, error: lastError || '所有重试均失败' };
}

/**
 * SearXNG 元搜索引擎 — JSON API 搜索
 * 支持 70+ 引擎聚合、隐私保护、无广告
 * v2: pageno 分页 + URL 去重 + 早退，准确满足 max_results
 */
async function handleWebSearchSearxng(
  query: string,
  maxResults: number,
  timeRange: string,
  _enhanceSnippets: boolean,
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

  const authKey = getSetting<string>('searxng_auth_key', '');
  const authType = getSetting<string>('searxng_auth_type', 'bearer');

  const baseUrl = url.replace(/\/+$/, '');
  sendLog('info', `🔍 SearXNG 搜索`, `"${query}" → ${baseUrl} (${format}) 期望=${effectiveMax}条`);

  // 构建请求头
  const buildHeaders = (apiUrl: string) => {
    const headers = buildFetchHeaders(apiUrl, 0);
    if (authKey) {
      if (authType === 'basic') {
        headers['Authorization'] = 'Basic ' + Buffer.from(authKey).toString('base64');
      } else {
        headers['Authorization'] = `Bearer ${authKey}`;
      }
    }
    return headers;
  };

  // 构建单页请求 URL
  const buildPageUrl = (pageno: number) => {
    const params = new URLSearchParams({ q: query });
    if (!isHtml) params.set('format', 'json');
    if (engines) params.set('engines', engines);
    if (language) params.set('language', language);
    if (safesearch > 0) params.set('safesearch', String(safesearch));
    if (effectiveTimeRange) params.set('time_range', effectiveTimeRange);
    if (pageno > 1) params.set('pageno', String(pageno));
    return `${baseUrl}/search?${params.toString()}`;
  };

  try {
    // ── HTML 模式：单页返回原始网页文本，让 AI 自行分析（不分页）──
    if (isHtml) {
      const apiUrl = buildPageUrl(1);
      const headers = buildHeaders(apiUrl);
      const resp = await fetchWithTimeout(apiUrl, HTTP_TIMEOUT, headers);
      if (!resp || !resp.ok) {
        return {
          success: false,
          error: `SearXNG 搜索失败 (HTTP ${resp?.status || 'timeout'})。请检查 SearXNG 实例是否运行正常：${url}。`,
          _searxng_url: apiUrl,
        };
      }
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
        _hint: '这是 SearXNG 搜索结果页面的纯文本提取。请从中提取有用的搜索结果信息来回答用户问题。',
      };
    }

    // ── JSON 模式：分页请求 + URL 去重 + 早退 ──
    const MAX_PAGES = 5; // 最大翻页数，防滥用
    const seenUrls = new Set<string>(); // URL 归一化去重
    const allResults: Array<{ title: string; url: string; content: string; engine: string }> = [];
    const allEngineNames = new Set<string>();
    const allUnresponsive: Array<[string, string]> = [];
    let pagesFetched = 0;

    for (let pageno = 1; pageno <= MAX_PAGES; pageno++) {
      // 已够，早退
      if (allResults.length >= effectiveMax) break;

      const apiUrl = buildPageUrl(pageno);
      const headers = buildHeaders(apiUrl);
      const resp = await fetchWithTimeout(apiUrl, HTTP_TIMEOUT, headers);
      if (!resp || !resp.ok) {
        if (pageno === 1) {
          return {
            success: false,
            error: `SearXNG 搜索失败 (HTTP ${resp?.status || 'timeout'})。请检查 SearXNG 实例是否运行正常：${url}。`,
            _searxng_url: apiUrl,
          };
        }
        // 后续页失败，用已有结果
        sendLog(
          'warn',
          `🔍 SearXNG 翻页失败`,
          `pageno=${pageno} HTTP ${resp?.status || 'timeout'}, 使用已有 ${allResults.length} 条结果`,
        );
        break;
      }

      const data = (await resp.json()) as {
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

      pagesFetched++;
      const pageResults = data.results || [];
      if (data.unresponsive_engines) allUnresponsive.push(...data.unresponsive_engines);

      let newCount = 0;
      for (const r of pageResults) {
        // URL 归一化去重：去除 fragment → 小写 → 去除尾部斜杠
        const normalizedUrl = (r.url || '').split('#')[0].toLowerCase().replace(/\/+$/, '');
        if (!normalizedUrl || seenUrls.has(normalizedUrl)) continue;
        seenUrls.add(normalizedUrl);
        if (r.engine) allEngineNames.add(r.engine);
        allResults.push({
          title: (r.title || '').replace(/<[^>]+>/g, '').trim(),
          url: r.url,
          content: (r.content || '')
            .replace(/<[^>]+>/g, '')
            .replace(/\s+/g, ' ')
            .trim(),
          engine: r.engine || 'searxng',
        });
        newCount++;
        if (allResults.length >= effectiveMax) break;
      }

      sendLog(
        'info',
        `🔍 SearXNG 翻页`,
        `pageno=${pageno} → ${pageResults.length}条, 去重后${newCount}条新 (累计${allResults.length})`,
      );

      // 本页没有新结果 → 没有更多了，早退
      if (newCount === 0) {
        sendLog('info', `🔍 SearXNG 早退`, `pageno=${pageno} 无新结果，停止翻页`);
        break;
      }
      // 本页返回的原始结果数 < 预期（通常是引擎已耗尽），也停止
      if (pageResults.length < 5 && allResults.length < effectiveMax) {
        sendLog('info', `🔍 SearXNG 早退`, `pageno=${pageno} 仅${pageResults.length}条，引擎可能已耗尽`);
        break;
      }
    }

    if (allResults.length === 0) {
      return { success: false, error: 'SearXNG 未返回任何结果，请尝试其他关键词或调整搜索引擎配置' };
    }

    // 最终裁剪到 effectiveMax
    const finalResults = allResults.slice(0, effectiveMax);

    // 构建引擎统计
    const engineStats: Record<string, string> = {};
    for (const engine of allEngineNames) {
      engineStats[engine] = `${finalResults.filter((r) => r.engine === engine).length} 条`;
    }
    for (const [eng, reason] of allUnresponsive) {
      engineStats[eng] = `⚠️ ${reason}`;
    }

    sendLog(
      'success',
      `🔍 SearXNG 完成`,
      `${finalResults.length} 条结果 (${pagesFetched}页), 引擎: ${[...allEngineNames].join(', ')}`,
    );

    const result = buildSearchResponse(
      finalResults.map((r) => ({
        title: r.title,
        url: r.url,
        snippet: r.content,
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
export async function handleWebSearch(params: {
  query: string;
  max_results?: number;
  time_range?: string;
  enhance_snippets?: boolean;
  fetch_top?: number;
}): Promise<ToolResult> {
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
      sendLog(
        'info',
        `🔍 web_search → SearXNG 模式`,
        `"${query}" | 抓取=${fetchTop}条 ${fetchMode === 'random' ? '随机' : '顺序'}`,
      );
      result = await handleWebSearchSearxng(query, maxResults, timeRange, enhanceSnippets);
    } else {
      sendLog('info', `🔍 web_search → 内置引擎`, `"${query}" | 抓取=${fetchTop}条 顺序`);
      result = await (async () => {
        const cacheKey = `${query}|${maxResults}|${timeRange}`;

        // ── 时间范围 → URL 参数映射 ──
        let bingFreshness = '';
        if (timeRange) {
          const tr = timeRange.toLowerCase();
          if (tr === 'day' || tr === '1d' || tr === '一天') {
            bingFreshness = 'Day';
          } else if (tr === 'week' || tr === '1w' || tr === '一周') {
            bingFreshness = 'Week';
          } else if (tr === 'month' || tr === '1m' || tr === '一月') {
            bingFreshness = 'Month';
          }
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
        const engines: Array<{
          name: string;
          weight: number;
          fetcher: () => Promise<Array<{ title: string; url: string; snippet: string }>>;
        }> = [
          {
            name: 'bing',
            weight: 90,
            fetcher: async () => {
              const bingUrl = `https://www.bing.com/search?q=${encodeURIComponent(query)}&count=${maxResults}${bingFreshness ? '&freshness=' + bingFreshness : ''}`;
              const resp = await fetchWithTimeout(bingUrl, HTTP_TIMEOUT, undefined, 0);
              if (!resp?.ok) throw new Error(`Bing ${resp?.status}`);
              return parseBingResults(await resp.text(), maxResults);
            },
          },
          {
            name: 'baidu',
            weight: 80,
            fetcher: async () => {
              const resp = await fetchWithTimeout(
                `https://www.baidu.com/s?wd=${encodeURIComponent(query)}&rn=${maxResults}`,
              );
              if (!resp?.ok) throw new Error(`百度 ${resp?.status}`);
              return parseBaiduResults(await resp.text(), maxResults);
            },
          },
          {
            name: 'sogou',
            weight: 75,
            fetcher: async () => {
              const resp = await fetchWithTimeout(`https://www.sogou.com/web?query=${encodeURIComponent(query)}`);
              if (!resp?.ok) throw new Error(`搜狗 ${resp?.status}`);
              return parseSogouResults(await resp.text(), maxResults);
            },
          },
          {
            name: '360搜索',
            weight: 75,
            fetcher: async () => {
              const resp = await fetchWithTimeout(`https://www.so.com/s?q=${encodeURIComponent(query)}`);
              if (!resp?.ok) throw new Error(`360 ${resp?.status}`);
              return parse360Results(await resp.text(), maxResults);
            },
          },
        ];

        // 所有引擎并行执行，收集结果
        const settled = await Promise.allSettled(
          engines.map((e) => e.fetcher().then((results) => ({ engine: e.name, results }))),
        );

        // 汇总各引擎结果，合并去重（保留引擎和权重信息）
        const engineWeights = new Map(engines.map((e) => [e.name, e.weight]));
        const allResults: Array<{
          title: string;
          url: string;
          snippet: string;
          engine: string;
          weight: number;
          reachable?: boolean;
          _enhanced?: boolean;
        }> = [];
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
          r.title = r.title
            .replace(/<[^>]+>/g, '')
            .replace(/\s+/g, ' ')
            .trim();
          r.snippet = r.snippet
            .replace(/<[^>]+>/g, '')
            .replace(/\s+/g, ' ')
            .trim();
        }

        // ── 4. URL 可达性预检（只取响应头，立即取消 body 下载）+ 质量评分 ──
        const topResults = allResults.slice(0, Math.min(maxResults * 2, allResults.length)); // 多检查一些用于排序
        const CONCURRENCY = 5;
        for (let i = 0; i < topResults.length; i += CONCURRENCY) {
          const batch = topResults.slice(i, i + CONCURRENCY);
          const checks = batch.map(async (r) => {
            try {
              const resp = await fetchWithTimeout(r.url, 3000, {
                'User-Agent': UA_POOL[0],
                Accept: 'text/html,*/*',
                Range: 'bytes=0-0',
              });
              r.reachable = resp?.ok === true;
              // 立即取消 body 下载，避免为可达性检查传输完整页面
              if (resp?.body) {
                try {
                  await resp.body.cancel();
                } catch {
                  /* 已完成 */
                }
              }
            } catch {
              r.reachable = false;
            }
          });
          await Promise.allSettled(checks);
        }

        // ── 5. 智能排序：可达优先 + 引擎权重 + 摘要质量 ──
        const scored = topResults.map((r) => {
          let score = (r.weight / 100) * 50; // 引擎权重贡献 50%
          if (r.reachable === true)
            score += 30; // 可达 +30
          else if (r.reachable === false) score -= 20; // 不可达 -20
          // 摘要质量：越长越好（上限100字符），有内容的加分
          const snippetLen = Math.min(r.snippet.length, 100);
          score += (snippetLen / 100) * 20; // 摘要质量贡献 20%
          return { ...r, _score: Math.round(score * 10) / 10 };
        });

        scored.sort((a, b) => b._score - a._score);

        // ── 5.5 摘要自动增强：snippet 太短/为空时，用 web_fetch 补充 top 3 ──
        if (enhanceSnippets) {
          const needEnhance = scored
            .slice(0, Math.min(5, maxResults))
            .filter((r) => r.snippet.length < 30 && r.reachable !== false);
          if (needEnhance.length > 0) {
            sendLog('info', `🔍 自动补充摘要`, `${needEnhance.length} 个结果摘要过短，尝试 web_fetch`);
            const enhanced = await Promise.allSettled(
              needEnhance.slice(0, 3).map(async (r) => {
                try {
                  const fetchResult = await handleWebFetch({ url: r.url, max_chars: 500, retry: false });
                  if (fetchResult.success && fetchResult.content) {
                    const text = String(fetchResult.content).replace(/\s+/g, ' ').trim();
                    r.snippet = text.length > 200 ? text.slice(0, 200) + '…' : text;
                    r._enhanced = true;
                  }
                } catch {
                  /* enhancement is optional */
                }
              }),
            );
            const enhancedCount = enhanced.filter((e) => e.status === 'fulfilled').length;
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
    if (fetchTop > 0 && result.success && (result as SearchToolResult).results) {
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

async function applyAutoFetch(
  result: ToolResult,
  fetchTop: number,
  fetchMode: 'sequential' | 'random' = 'sequential',
): Promise<ToolResult> {
  const searchResult = result as SearchToolResult;
  const results = searchResult.results;
  if (!results || results.length === 0) return result;

  const count = Math.min(fetchTop, results.length, MAX_AUTO_FETCH);

  // ── 相关性过滤：只抓取标题与搜索词至少有部分匹配的结果 ──
  // 从搜索结果中反向获取原始 query（若有）作为过滤依据
  const searchQuery = searchResult.query || '';
  const scoredResults = results.map((r, idx) => {
    const relevance = computeRelevance(searchQuery, r.title, r.snippet);
    return { ...r, _idx: idx, _relevance: relevance };
  });
  // 按相关性降序排列（相关性高的优先抓取）
  scoredResults.sort((a, b) => b._relevance - a._relevance);
  // 过滤掉明显无关的结果（相关性为 0）
  const relevantResults = scoredResults.filter((r) => r._relevance > 0);
  const skippedCount = results.length - relevantResults.length;
  if (skippedCount > 0) {
    sendLog(
      'info',
      `🔍 相关性过滤: ${skippedCount} 条无关结果已跳过`,
      results
        .filter((_, i) => !relevantResults.some((rr) => rr._idx === i))
        .map((r) => r.title.slice(0, 30))
        .join(', '),
    );
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
    fetchList = indices.slice(0, count).map((idx) => ({
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
  sendLog(
    'info',
    `⬇️ 自动抓取 ${fetchList.length} 条网页 (${modeLabel})`,
    fetchList.map((r) => r.title.slice(0, 30)).join(', '),
  );

  const fetched: Array<{ url: string; title: string; content: string }> = [];
  const fetchedUrls = new Set<string>();
  const failedUrls = new Set<string>();

  /** 尝试抓取单条 URL，成功则加入 fetched */
  const tryFetchOne = async (url: string, title: string): Promise<boolean> => {
    // 已成功抓取过就视为成功，不能计入失败数。
    if (fetchedUrls.has(url)) return true;
    try {
      const fetchResult = await handleWebFetch({ url, retry: false, max_chars: AUTO_FETCH_MAX_CHARS });
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
    if (fetchedUrls.has(item.url)) continue;
    const ok = await tryFetchOne(item.url, item.title);
    if (!ok) {
      failedUrls.add(item.url);
      // ── 失败重试：从剩余未抓取结果中随机选 1 条 ──
      const unfetched = results.filter((r, idx) => !fetchedUrls.has(r.url) && !failedUrls.has(r.url));
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
  searchResult._fetched = fetched;
  searchResult._fetched_count = fetched.length;
  return result;
}

/** 构建搜索响应（格式化文本 + 结构化 JSON） */
function buildSearchResponse(
  results: Array<{
    title: string;
    url: string;
    snippet: string;
    engine: string;
    weight?: number;
    reachable?: boolean;
    _score?: number;
    _enhanced?: boolean;
  }>,
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
    const statsStr = Object.entries(engineStats)
      .map(([k, v]) => `${k}: ${v}`)
      .join(' | ');
    formatted += `[引擎状态: ${statsStr}]\n\n`;
  }

  formatted += sliced
    .map((r, i) => {
      const marks: string[] = [];
      if (r.reachable === false) marks.push('⚠️可能不可达');
      if (r._score !== undefined) marks.push(`${r._score}分`);
      if (r._enhanced) marks.push('📝增强摘要');
      const markStr = marks.length > 0 ? ` [${marks.join(' ')}]` : '';
      return `[${i + 1}] ${r.title}${markStr}\n    URL: ${r.url}\n    ${r.snippet}`;
    })
    .join('\n\n');

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
    const titleMatch = block.match(
      /<h3[^>]*class="[^"]*t[^"]*"[^>]*>[\s\S]*?<a[^>]*href="([^"]*)"[^>]*>([\s\S]*?)<\/a>/,
    );
    if (!titleMatch) continue;

    let url = titleMatch[1].trim();
    const title = decodeHTML(titleMatch[2].replace(/<[^>]+>/g, '').trim());

    // 百度有时使用 data-url 属性
    if (!url.startsWith('http')) {
      const dataUrlMatch = block.match(/data-url="(https?:\/\/[^"]*)"/);
      if (dataUrlMatch) url = dataUrlMatch[1];
    }

    // 提取摘要
    const snippetMatch =
      block.match(/<div class="c-abstract"[^>]*>([\s\S]*?)<\/div>/) ||
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
  const blockRegex =
    /<div[^>]*class="[^"]*(?:vrwrap|rb)[^"]*"[^>]*>([\s\S]*?)(?=<div[^>]*class="[^"]*(?:vrwrap|rb)[^"]*"|<div[^>]*id="pagebar)/gi;
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
  const blockRegex =
    /<(?:li[^>]*class="[^"]*res-list[^"]*"|div[^>]*class="[^"]*result[^"]*")[^>]*>([\s\S]*?)(?=<(?:li[^>]*class="[^"]*res-list|div[^>]*class="[^"]*result)|<\/ul>|<\/div>\s*<\/div>\s*$)/gi;
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
    const snippetMatch =
      block.match(/<p[^>]*>([\s\S]*?)<\/p>/) || block.match(/<div class="b_caption"[^>]*>([\s\S]*?)<\/div>/);

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

// download_file / compress 已迁移至 tools/system.ts

// 0.18.0 内置工具说明请见 src/renderer/services/tool-registry.ts
