1|/**
2| * Tool Handlers - 系统与网络操作
3| */
4|
5|import * as fs from 'fs/promises';
6|import * as path from 'path';
7|import { spawn } from 'child_process';
8|import { checkPathAllowed, checkCommandAllowed } from './tool-security.js';
9|import { mainWindow } from './main.js';
10|import { sendLog, resolvePath, type ToolResult } from './tool-handlers-shared.js';
11|import { getWorkspaceDir } from './workspace.js';
12|import { getSetting } from './db/sqlite.js';
13|
14|/** 当前工具命令进程（用于用户手动终止） */
15|let _toolProc: ReturnType<typeof spawn> | null = null;
16|
17|export async function handleRunCommand(params: { command: string; cwd?: string; timeout?: number }): Promise<ToolResult> {
18|  try {
19|    const cmdCheck = checkCommandAllowed(params.command);
20|    if (!cmdCheck.ok) {
21|      sendLog('warn', `🔧 run_command 被拦截`, `${params.command.slice(0, 100)} | ${cmdCheck.reason}`);
22|      return { success: false, error: cmdCheck.reason };
23|    }
24|
25|    const cwd = params.cwd ? path.resolve(params.cwd) : getWorkspaceDir();
26|    const dirCheck = checkPathAllowed(cwd, 'read');
27|    if (!dirCheck.ok) {
28|      sendLog('warn', `🔧 run_command 目录被拦截`, `${cwd} | ${dirCheck.reason}`);
29|      return { success: false, error: dirCheck.reason };
30|    }
31|
32|    sendLog('info', `🔧 run_command 执行`, `${params.command.slice(0, 200)} | cwd: ${cwd}`);
33|
34|    return new Promise((resolve) => {
35|      const isWin = process.platform === 'win32';
36|      const shell = isWin ? 'cmd.exe' : 'bash';
37|      const actualCmd = isWin ? `chcp 65001 >nul && ${params.command}` : params.command;
38|      const shellArgs = isWin ? ['/c', actualCmd] : ['-c', actualCmd];
39|      const startTime = Date.now();
40|
41|      _toolProc = spawn(shell, shellArgs, {
42|        cwd,
43|        env: {
44|          ...process.env,
45|          ...(isWin ? {} : { TERM: 'xterm-256color' }),
46|          LANG: 'en_US.UTF-8',
47|          LC_ALL: 'en_US.UTF-8',
48|          PYTHONIOENCODING: 'utf-8'
49|        },
50|        stdio: ['pipe', 'pipe', 'pipe']
51|      });
52|
53|      let stdout = '';
54|      let stderr = '';
55|
56|      // 实时推送到工作空间终端
57|      _toolProc.stdout?.on('data', (data: Buffer) => {
58|        const str = data.toString('utf-8');
59|        stdout += str;
60|        mainWindow?.webContents.send('cmd:output', { command: params.command, type: 'stdout', data: str });
61|      });
62|
63|      _toolProc.stderr?.on('data', (data: Buffer) => {
64|        const str = data.toString('utf-8');
65|        stderr += str;
66|        mainWindow?.webContents.send('cmd:output', { command: params.command, type: 'stderr', data: str });
67|      });
68|
69|      _toolProc.on('close', (code) => {
70|        _toolProc = null;
71|        const duration = Date.now() - startTime;
72|        sendLog(
73|          code === 0 ? 'success' : 'warn',
74|          `🔧 run_command 完成`,
75|          `exitCode: ${code} | ${duration}ms | stdout: ${stdout.length}B | stderr: ${stderr.length}B`
76|        );
77|        mainWindow?.webContents.send('cmd:done', { command: params.command, exitCode: code });
78|        resolve({
79|          success: code === 0,
80|          stdout,
81|          stderr,
82|          exitCode: code,
83|          duration,
84|          cwd,
85|          command: params.command,
86|        });
87|      });
88|
89|      _toolProc.on('error', (err) => {
90|        _toolProc = null;
91|        const duration = Date.now() - startTime;
92|        sendLog('error', `🔧 run_command 失败`, `${err.message} | ${duration}ms`);
93|        mainWindow?.webContents.send('cmd:done', { command: params.command, exitCode: 1 });
94|        resolve({
95|          success: false,
96|          stdout,
97|          stderr: stderr + (stderr ? '\n' : '') + err.message,
98|          exitCode: 1,
99|          error: err.message,
100|          duration,
101|          cwd,
102|          command: params.command,
103|        });
104|      });
105|    });
106|  } catch (err) {
107|    sendLog('error', `🔧 run_command 异常`, (err as Error).message);
108|    return { success: false, stdout: '', stderr: (err as Error).message, exitCode: 1, error: (err as Error).message };
109|  }
110|}
111|
112|/** 终止当前工具命令进程 */
113|export function killToolProcess(): boolean {
114|  if (!_toolProc) {
115|    sendLog('warn', `🔧 cmd:kill`, '无正在运行的工具命令');
116|    return false;
117|  }
118|  try { _toolProc.kill('SIGTERM'); } catch { /* ignore */ }
119|  _toolProc = null;
120|  sendLog('info', `🔧 cmd:kill`, '工具命令已终止');
121|  return true;
122|}
123|
124|
125|
126|/** HTTP 请求超时（毫秒），默认 30s，可通过 IPC 设置 */
127|let HTTP_TIMEOUT = 30_000;
128|
129|/** 设置 HTTP 请求超时（毫秒） */
130|export function setHTTPTimeout(ms: number): void {
131|  HTTP_TIMEOUT = Math.max(5000, Math.min(300_000, ms)); // 5s ~ 300s
132|}
133|
134|// ── LRU 搜索缓存 ──────────────────────────────────
135|interface CacheEntry { results: Array<{ title: string; url: string; snippet: string; engine: string; reachable?: boolean }>; time: number; }
136|const _searchCache = new Map<string, CacheEntry>();
137|const CACHE_MAX = 200;
138|const CACHE_TTL = 5 * 60 * 1000; // 5 分钟
139|
140|function cacheGet(query: string): CacheEntry | null {
141|  const entry = _searchCache.get(query);
142|  if (!entry) return null;
143|  if (Date.now() - entry.time > CACHE_TTL) { _searchCache.delete(query); return null; }
144|  return entry;
145|}
146|function cacheSet(query: string, entry: CacheEntry): void {
147|  if (_searchCache.size >= CACHE_MAX) {
148|    const firstKey = _searchCache.keys().next().value;
149|    if (firstKey !== undefined) _searchCache.delete(firstKey);
150|  }
151|  _searchCache.set(query, entry);
152|}
153|
154|// ── 反爬请求头 ────────────────────────────────────
155|const DESKTOP_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';
156|const MOBILE_UA = 'Mozilla/5.0 (Linux; Android 14; Pixel 8 Pro) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Mobile Safari/537.36';
157|
158|/** 构建 fetch 请求头，根据 UA 类型动态设置 */
159|function buildFetchHeaders(url: string, useMobileUA: boolean): Record<string, string> {
160|  const ua = useMobileUA ? MOBILE_UA : DESKTOP_UA;
161|  let referer = 'https://www.google.com/';
162|  try {
163|    const u = new URL(url);
164|    referer = `${u.protocol}//${u.hostname}/`;
165|  } catch { /* ignore */ }
166|  return {
167|    'User-Agent': ua,
168|    'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8',
169|    'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8',
170|    'Accept-Encoding': 'gzip, deflate, br',
171|    'Cache-Control': 'no-cache',
172|    'DNT': '1',
173|    'Connection': 'keep-alive',
174|    'Upgrade-Insecure-Requests': '1',
175|    'Sec-Fetch-Dest': 'document',
176|    'Sec-Fetch-Mode': 'navigate',
177|    'Sec-Fetch-Site': 'none',
178|    'Sec-Fetch-User': '?1',
179|    'Pragma': 'no-cache',
180|    'Referer': referer,
181|  };
182|}
183|
184|/** 带超时的 fetch 封装 */
185|async function fetchWithTimeout(url: string, timeout = HTTP_TIMEOUT, headers?: Record<string,string>): Promise<Response | null> {
186|  const _headers = headers || buildFetchHeaders(url, false);
187|
188|  const controller = new AbortController();
189|  const tid = setTimeout(() => controller.abort(), timeout);
190|  try {
191|    const resp = await fetch(url, { headers: _headers, signal: controller.signal, redirect: 'follow' });
192|    clearTimeout(tid); return resp;
193|  } catch { clearTimeout(tid); return null; }
194|}
195|
196|/** 完整 HTML 实体映射（常见实体） */
197|const HTML_ENTITIES: Record<string, string> = {
198|  '&nbsp;': ' ', '&lt;': '<', '&gt;': '>', '&amp;': '&', '&quot;': '"',
199|  '&#39;': "'", '&apos;': "'", '&ensp;': ' ', '&emsp;': ' ',
200|  '&copy;': '\u00A9', '&reg;': '\u00AE', '&trade;': '\u2122', '&euro;': '\u20AC',
201|  '&pound;': '\u00A3', '&yen;': '\u00A5', '&deg;': '\u00B0', '&middot;': '\u00B7',
202|  '&hellip;': '\u2026', '&mdash;': '\u2014', '&ndash;': '\u2013',
203|  '&lsquo;': '\u2018', '&rsquo;': '\u2019', '&ldquo;': '\u201C', '&rdquo;': '\u201D',
204|  '&bull;': '\u2022',
205|  '&times;': '\u00D7', '&divide;': '\u00F7', '&plusmn;': '\u00B1', '&micro;': '\u00B5',
206|  '&para;': '\u00B6', '&sect;': '\u00A7', '&laquo;': '\u00AB', '&raquo;': '\u00BB',
207|  '&iexcl;': '\u00A1', '&iquest;': '\u00BF', '&not;': '\u00AC', '&shy;': '\u00AD',
208|  '&macr;': '\u00AF', '&acute;': '\u00B4', '&cedil;': '\u00B8',
209|  '&OElig;': '\u0152', '&oelig;': '\u0153', '&Scaron;': '\u0160', '&scaron;': '\u0161',
210|  '&Yuml;': '\u0178', '&circ;': '\u02C6', '&tilde;': '\u02DC',
211|};
212|
213|/** 解码 HTML 实体 */
214|function decodeHTMLEntities(text: string): string {
215|  let result = text;
216|  for (const [entity, char] of Object.entries(HTML_ENTITIES)) {
217|    result = result.replaceAll(entity, char);
218|  }
219|  // 数字实体: &#123; 和 &#x1F;
220|  result = result.replace(/&#x([0-9a-fA-F]+);/g, (_, hex) => String.fromCharCode(parseInt(hex, 16)));
221|  result = result.replace(/&#(\d+);/g, (_, dec) => String.fromCharCode(parseInt(dec, 10)));
222|  return result;
223|}
224|
225|/** 将 HTML 转换为可读文本（保留结构） */
226|function htmlToText(html: string): string {
227|  let text = html;
228|  // 移除 script/style/nav/header/footer 等噪音标签及其内容
229|  text = text.replace(/<script[\s\S]*?<\/script>/gi, '');
230|  text = text.replace(/<style[\s\S]*?<\/style>/gi, '');
231|  text = text.replace(/<noscript[\s\S]*?<\/noscript>/gi, '');
232|  text = text.replace(/<nav[\s\S]*?<\/nav>/gi, '');
233|  text = text.replace(/<header[\s\S]*?<\/header>/gi, '');
234|  text = text.replace(/<footer[\s\S]*?<\/footer>/gi, '');
235|  text = text.replace(/<aside[\s\S]*?<\/aside>/gi, '');
236|  text = text.replace(/<iframe[\s\S]*?<\/iframe>/gi, '');
237|  text = text.replace(/<svg[\s\S]*?<\/svg>/gi, '');
238|  // 移除 HTML 注释
239|  text = text.replace(/<!--[\s\S]*?-->/g, '');
240|  // 块级标签转为换行
241|  text = text.replace(/<\/(p|div|h[1-6]|li|tr|blockquote|section|article|pre|br|hr)[^>]*>/gi, '\n');
242|  text = text.replace(/<(br|hr)[^>]*\/?>/gi, '\n');
243|  // 表格单元用制表符分隔
244|  text = text.replace(/<\/(td|th)[^>]*>/gi, '\t');
245|  // 移除剩余标签
246|  text = text.replace(/<[^>]+>/g, '');
247|  // 解码 HTML 实体
248|  text = decodeHTMLEntities(text);
249|  // 清理多余空白（保留换行结构）
250|  text = text.replace(/[ \t]+/g, ' ');
251|  text = text.replace(/\n\s*\n\s*\n+/g, '\n\n');
252|  text = text.split('\n').map(l => l.trim()).join('\n');
253|  return text.trim();
254|}
255|
256|import { browserOpen, browserExtract, browserClose } from './browser.js';
257|
258|// ──────────────────────────────────────────────────
259|// web_fetch 重试配置
260|// ──────────────────────────────────────────────────
261|const FETCH_MAX_RETRIES = 2;          // fetch 阶段最多重试 2 次
262|const FETCH_RETRY_DELAYS = [1500, 3000]; // 指数退避 (ms)
263|/** fetch 全部失败后自动回退到浏览器渲染 */
264|const BROWSER_FALLBACK_ENABLED = true;
265|/** 内容过短阈值：小于此字符数且是 HTML 时，自动升级到浏览器渲染 */
266|const SHORT_CONTENT_THRESHOLD = 200;
267|/** 需要回退浏览器的 HTTP 状态码（反爬/拦截信号） */
268|const BROWSER_FALLBACK_STATUSES = new Set([403, 503, 429, 502]);
269|
270|/** 浏览器回退：打开 URL → 等待渲染 → 提取内容 */
271|async function browserFallback(url: string, maxChars: number): Promise<{ text: string; method: string } | null> {
272|  try {
273|    const openResult = await browserOpen(url);
274|    if (!openResult.success) return null;
275|    await new Promise(r => setTimeout(r, 2500)); // 等待 JS 渲染
276|    const extractResult = await browserExtract();
277|    browserClose();
278|    if (extractResult.success && extractResult.text && extractResult.text.length > 0) {
279|      let text = extractResult.text;
280|      if (maxChars > 0 && text.length > maxChars) text = text.slice(0, maxChars);
281|      return { text, method: 'browser' };
282|    }
283|    return null;
284|  } catch {
285|    try { browserClose(); } catch { /* */ }
286|    return null;
287|  }
288|}
289|
290|export async function handleWebFetch(params: { url: string; max_chars?: number; extract_mode?: string; mobile_ua?: boolean; retry?: boolean }): Promise<ToolResult> {
291|  const url = params.url;
292|  if (!url.startsWith('http://') && !url.startsWith('https://')) {
293|    return { success: false, error: '仅支持 http/https 协议' };
294|  }
295|
296|  const maxChars = params.max_chars || 0; // 0 = 不截断
297|  const useMobileUA = params.mobile_ua === true;
298|  const shouldRetry = params.retry !== false; // 默认开启重试
299|
300|  sendLog('info', `🌐 web_fetch`, `${url} (${maxChars > 0 ? maxChars + ' chars' : '完整内容'}${useMobileUA ? ', 移动端UA' : ''})`);
301|
302|  // ── Phase 1 & 2: HTTP fetch with UA switching ──
303|  let lastError = '';
304|  const maxAttempts = shouldRetry ? FETCH_MAX_RETRIES + 1 : 1;
305|
306|  for (let attempt = 0; attempt < maxAttempts; attempt++) {
307|    if (attempt > 0) {
308|      const delay = FETCH_RETRY_DELAYS[attempt - 1] || 3000;
309|      sendLog('warn', `🌐 web_fetch 重试`, `第 ${attempt + 1}/${maxAttempts} 次, 等待 ${delay}ms`);
310|      await new Promise(r => setTimeout(r, delay));
311|    }
312|
313|    // 重试时切换 UA：首次用指定 UA，第二次换另一种，第三次用移动端
314|    const useMobile = attempt >= 2 ? true : (attempt === 1 ? !useMobileUA : useMobileUA);
315|    const headers = buildFetchHeaders(url, useMobile);
316|
317|    try {
318|      const controller = new AbortController();
319|      const timeoutId = setTimeout(() => controller.abort(), HTTP_TIMEOUT);
320|      let resp: Response;
321|      try {
322|        resp = await fetch(url, { headers, signal: controller.signal, redirect: 'follow' });
323|      } finally {
324|        clearTimeout(timeoutId);
325|      }
326|
327|      if (!resp.ok) {
328|        // 反爬信号（403/503/429）→ 跳过后续 fetch，直接走浏览器回退
329|        if (BROWSER_FALLBACK_STATUSES.has(resp.status) && BROWSER_FALLBACK_ENABLED) {
330|          sendLog('warn', `🌐 web_fetch HTTP ${resp.status}，触发浏览器回退`, url);
331|          break; // 跳出 fetch 循环，走浏览器回退
332|        }
333|        // 5xx 服务器错误可重试
334|        if (resp.status >= 500 && attempt < maxAttempts - 1) {
335|          lastError = `HTTP ${resp.status}: ${resp.statusText}（将重试）`;
336|          continue;
337|        }
338|        return { success: false, error: `HTTP ${resp.status}: ${resp.statusText}。可尝试用 browser_open 直接打开页面。` };
339|      }
340|
341|      const contentType = resp.headers.get('content-type') || '';
342|      if (!contentType.includes('text') && !contentType.includes('html') && !contentType.includes('json') && !contentType.includes('xml')) {
343|        return { success: false, error: `不支持的内容类型: ${contentType}。如果是二进制文件，请用 download_file 工具。` };
344|      }
345|
346|      const contentLength = resp.headers.get('content-length');
347|      if (contentLength && parseInt(contentLength, 10) > 10 * 1024 * 1024) {
348|        return { success: false, error: `页面过大 (${(parseInt(contentLength, 10) / 1024 / 1024).toFixed(1)}MB)，超过 10MB 限制` };
349|      }
350|
351|      let text = await resp.text();
352|      const isHTML = contentType.includes('html');
353|      if (isHTML) {
354|        text = htmlToText(text);
355|      }
356|
357|      // ── SPA/短内容自动升级到浏览器渲染 ──
358|      if (isHTML && text.length < SHORT_CONTENT_THRESHOLD && BROWSER_FALLBACK_ENABLED) {
359|        sendLog('info', `🌐 web_fetch 内容过短(${text.length}字符)`, `自动升级到浏览器渲染: ${url}`);
360|        const browserResult = await browserFallback(url, maxChars);
361|        if (browserResult) {
362|          sendLog('success', `🌐 web_fetch 浏览器渲染完成`, `${browserResult.text.length} 字符`);
363|          return {
364|            success: true, url,
365|            content: browserResult.text,
366|            content_type: 'text/html (browser)',
367|            status: resp.status,
368|            truncated: maxChars > 0 && browserResult.text.length >= maxChars,
369|            length: browserResult.text.length,
370|            retries: attempt,
371|            method: 'browser',
372|          };
373|        }
374|        sendLog('warn', `🌐 web_fetch 浏览器渲染失败，使用原始内容`);
375|      }
376|
377|      const truncated = maxChars > 0 && text.length > maxChars;
378|      if (truncated) text = text.slice(0, maxChars);
379|
380|      sendLog('success', `🌐 web_fetch 完成`, `HTTP ${resp.status} | ${text.length} chars${truncated ? ' (已截断)' : ''}${attempt > 0 ? ` | 重试${attempt}次后成功` : ''}`);
381|      return {
382|        success: true, url,
383|        content: text,
384|        content_type: contentType,
385|        status: resp.status,
386|        truncated,
387|        length: text.length,
388|        retries: attempt,
389|        method: useMobile ? 'fetch(mobile)' : 'fetch(desktop)',
390|      };
391|    } catch (err) {
392|      const errMsg = (err as Error).message;
393|      if (errMsg.includes('abort') && attempt < maxAttempts - 1) {
394|        lastError = `请求超时 (${HTTP_TIMEOUT / 1000}s)（将重试）`;
395|        continue;
396|      }
397|      if (errMsg.includes('abort')) {
398|        // 超时 → 浏览器回退
399|        sendLog('warn', `🌐 web_fetch 超时，触发浏览器回退`, url);
400|        break;
401|      }
402|      // 网络错误可重试
403|      if (attempt < maxAttempts - 1) {
404|        lastError = errMsg + '（将重试）';
405|        continue;
406|      }
407|      // 最后一次也失败了 → 浏览器回退
408|      if (BROWSER_FALLBACK_ENABLED) {
409|        sendLog('warn', `🌐 web_fetch 所有 fetch 均失败(${errMsg})，触发浏览器回退`, url);
410|        break;
411|      }
412|      return { success: false, error: `fetch 失败: ${errMsg}。可尝试用 browser_open 直接打开页面。` };
413|    }
414|  }
415|
416|  // ── Phase 3: 浏览器回退（fetch 全部失败后的最后手段）──
417|  if (BROWSER_FALLBACK_ENABLED) {
418|    sendLog('info', `🌐 web_fetch 回退到浏览器渲染`, url);
419|    const browserResult = await browserFallback(url, maxChars);
420|    if (browserResult) {
421|      sendLog('success', `🌐 web_fetch 浏览器渲染完成`, `${browserResult.text.length} 字符`);
422|      return {
423|        success: true, url,
424|        content: browserResult.text,
425|        content_type: 'text/html (browser)',
426|        status: 200,
427|        truncated: maxChars > 0 && browserResult.text.length >= maxChars,
428|        length: browserResult.text.length,
429|        retries: maxAttempts,
430|        method: 'browser(fallback)',
431|      };
432|    }
433|    return { success: false, error: `fetch 和浏览器渲染均失败。${lastError ? '最后错误: ' + lastError : '请检查 URL 是否可访问。'}` };
434|  }
435|
436|  return { success: false, error: lastError || '所有重试均失败' };
437|}
438|
439|/**
440| * SearXNG 元搜索引擎 — JSON API 搜索
441| * 支持 70+ 引擎聚合、隐私保护、无广告
442| */
443|async function handleWebSearchSearxng(
444|  query: string,
445|  maxResults: number,
446|  timeRange: string,
447|  _enhanceSnippets: boolean
448|): Promise<ToolResult> {
449|  const url = getSetting<string>('searxng_url', '');
450|  if (!url) {
451|    return { success: false, error: 'SearXNG API 地址未配置。请在 SearXNG 设置中填写 API 地址。' };
452|  }
453|  const engines = getSetting<string>('searxng_engines', '');
454|  const language = getSetting<string>('searxng_language', 'zh-CN');
455|  const safesearch = getSetting<number>('searxng_safesearch', 1);
456|  const cfgTimeRange = getSetting<string>('searxng_time_range', '');
457|  const effectiveTimeRange = timeRange || cfgTimeRange;
458|  const cfgMaxResults = getSetting<number>('searxng_max_results', 0);
459|  const effectiveMax = cfgMaxResults > 0 ? cfgMaxResults : maxResults;
460|
461|  const format = getSetting<string>('searxng_format', 'json');
462|  const isHtml = format === 'html';
463|
464|  const params = new URLSearchParams({ q: query });
465|  if (!isHtml) params.set('format', 'json');
466|  if (engines) params.set('engines', engines);
467|  if (language) params.set('language', language);
468|  if (safesearch > 0) params.set('safesearch', String(safesearch));
469|  if (effectiveTimeRange) params.set('time_range', effectiveTimeRange);
470|
471|  const authKey = getSetting<string>('searxng_auth_key', '');
472|
473|  const apiUrl = `${url.replace(/\/+$/, '')}/search?${params.toString()}`;
474|  sendLog('info', `🔍 SearXNG 搜索`, `${query} → ${url} (${format})`);
475|
476|  try {
477|    const headers = buildFetchHeaders(apiUrl, false);
478|    if (authKey) headers['Authorization'] = `Bearer ${authKey}`;
479|    const resp = await fetchWithTimeout(apiUrl, HTTP_TIMEOUT, headers);
480|    if (!resp || !resp.ok) {
481|      return {
482|        success: false,
483|        error: `SearXNG 搜索失败 (HTTP ${resp?.status || 'timeout'})。请检查 SearXNG 实例是否运行正常：${url}。`,
484|        _searxng_url: apiUrl
485|      };
486|    }
487|
488|    // ── HTML 模式：返回原始网页文本，让 AI 自行分析 ──
489|    if (isHtml) {
490|      const html = await resp.text();
491|      const text = htmlToText(html);
492|      const truncated = effectiveMax > 0 && text.length > effectiveMax * 500;
493|      const content = truncated ? text.slice(0, effectiveMax * 500) + '\n...（已截断）' : text;
494|      sendLog('success', `🔍 SearXNG HTML 完成`, `${text.length} 字符`);
495|      return {
496|        success: true,
497|        _mode: 'searxng',
498|        url: apiUrl,
499|        content,
500|        content_type: 'text/html',
501|        length: content.length,
502|        truncated,
503|        format: 'html',
504|        _hint: '这是 SearXNG 搜索结果页面的纯文本提取。请从中提取有用的搜索结果信息来回答用户问题。'
505|      };
506|    }
507|
508|    const data = await resp.json() as {
509|      query: string;
510|      number_of_results?: number;
511|      results?: Array<{
512|        title: string;
513|        url: string;
514|        content: string;
515|        engine: string;
516|        score?: number;
517|        category?: string;
518|      }>;
519|      unresponsive_engines?: Array<[string, string]>;
520|    };
521|
522|    const rawResults = (data.results || []).slice(0, effectiveMax);
523|    if (rawResults.length === 0) {
524|      return { success: false, error: 'SearXNG 未返回任何结果，请尝试其他关键词或调整搜索引擎配置' };
525|    }
526|
527|    // 转换为兼容格式
528|    const results = rawResults.map(r => ({
529|      title: (r.title || '').replace(/<[^>]+>/g, '').trim(),
530|      url: r.url,
531|      snippet: (r.content || '').replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim(),
532|      engine: r.engine || 'searxng',
533|      weight: 80,
534|      reachable: true,
535|    }));
536|
537|    const engineNames = [...new Set(rawResults.map(r => r.engine))].filter(Boolean);
538|    const unresponsive = data.unresponsive_engines || [];
539|    const engineStats: Record<string, string> = {};
540|    for (const engine of engineNames) {
541|      engineStats[engine] = `${rawResults.filter(r => r.engine === engine).length} 条`;
542|    }
543|    for (const [eng, reason] of unresponsive) {
544|      engineStats[eng] = `⚠️ ${reason}`;
545|    }
546|
547|    sendLog('success', `🔍 SearXNG 完成`, `${results.length} 条结果, 引擎: ${engineNames.join(', ')}`);
548|
549|    const result = buildSearchResponse(
550|      results.map(r => ({
551|        title: r.title,
552|        url: r.url,
553|        snippet: r.snippet,
554|        engine: `searxng:${r.engine}`,
555|        weight: 80,
556|        reachable: true,
557|      })),
558|      effectiveMax,
559|      false,
560|      engineStats
561|    );
562|    result._mode = 'searxng';
563|    return result;
564|  } catch (err) {
565|    sendLog('error', `🔍 SearXNG 异常`, (err as Error).message);
566|    return { success: false, error: `SearXNG 搜索异常: ${(err as Error).message}` };
567|  }
568|}
569|
570|/**
571| * Web Search — 联网搜索（并行多引擎 + LRU 缓存 + 智能排序 + 时间过滤 + 摘要增强）
572| * 同时请求 Bing / 百度 / 搜狗 / 360搜索，智能排序后返回
573| * 如果启用了 SearXNG，则使用 SearXNG JSON API 替代
574| */
575|export async function handleWebSearch(params: { query: string; max_results?: number; time_range?: string; enhance_snippets?: boolean; fetch_top?: number }): Promise<ToolResult> {
576|  try {
577|    const query = params.query;
578|    if (!query || query.trim().length === 0) {
579|      return { success: false, error: '搜索关键词不能为空' };
580|    }
581|
582|    const maxResults = Math.min(params.max_results || 30, 30);
583|    const timeRange = params.time_range || '';
584|    const enhanceSnippets = params.enhance_snippets !== false;
585|    const fetchTop = Math.max(3, Math.min(params.fetch_top || 3, 10));
586|
587|    let result: ToolResult;
588|
589|    // ── SearXNG 模式 ──
590|    const searxngEnabled = getSetting<boolean>('searxng_enabled', false);
591|    if (searxngEnabled) {
592|      sendLog('info', `🔍 web_search → SearXNG 模式`, `\"${query}\"`);
593|      result = await handleWebSearchSearxng(query, maxResults, timeRange, enhanceSnippets);
594|    } else {
595|      sendLog('info', `🔍 web_search → 内置引擎`, `\"${query}\"`);
596|      result = await doBuiltinSearch(query, maxResults, timeRange);
597|    }
598|
599|    // ── 自动抓取：如果 fetch_top > 0，对前 N 条结果自动抓取完整内容 ──
600|    if (fetchTop > 0 && result.success && (result as any).results) {
601|      result = await applyAutoFetch(result, fetchTop);
602|    }
603|
604|    return result;
605|  } catch (err) {
606|    return { success: false, error: (err as Error).message };
607|  }
608|}
609|
610|/** 内置四引擎搜索逻辑（从 handleWebSearch 中提取） */
611|async function doBuiltinSearch(query: string, maxResults: number, timeRange: string): Promise<ToolResult> {
612|  const cacheKey = `${query}|${maxResults}|${timeRange}`;
613|
614|    // ── 时间范围 → URL 参数映射 ──
615|    let bingFreshness = '';
616|    if (timeRange) {
617|      const tr = timeRange.toLowerCase();
618|      if (tr === 'day' || tr === '1d' || tr === '一天') { bingFreshness = 'Day'; }
619|      else if (tr === 'week' || tr === '1w' || tr === '一周') { bingFreshness = 'Week'; }
620|      else if (tr === 'month' || tr === '1m' || tr === '一月') { bingFreshness = 'Month'; }
621|    }
622|
623|    // ── 1. 检查缓存 ──
624|    const cached = cacheGet(cacheKey);
625|    if (cached) {
626|      sendLog('success', `🔍 web_search 缓存命中`, `"${query}" → ${cached.results.length} 条`);
627|      const cachedResult = buildSearchResponse(cached.results, maxResults, true);
628|      cachedResult._mode = 'builtin';
629|      return cachedResult;
630|    }
631|
632|    sendLog('info', `🔍 web_search`, `"${query}" (${maxResults} 条) [并行]`);
633|
634|    // ── 2. 并行请求所有搜索引擎 ──
635|    const engines: Array<{ name: string; weight: number; fetcher: () => Promise<Array<{title:string;url:string;snippet:string}>> }> = [
636|      {
637|        name: 'bing', weight: 90,
638|        fetcher: async () => {
639|          const bingUrl = `https://www.bing.com/search?q=${encodeURIComponent(query)}&count=${maxResults}${bingFreshness ? '&freshness=' + bingFreshness : ''}`;
640|          const resp = await fetchWithTimeout(bingUrl);
641|          if (!resp?.ok) throw new Error(`Bing ${resp?.status}`);
642|          return parseBingResults(await resp.text(), maxResults);
643|        }
644|      },
645|      {
646|        name: 'baidu', weight: 80,
647|        fetcher: async () => {
648|          const resp = await fetchWithTimeout(
649|            `https://www.baidu.com/s?wd=${encodeURIComponent(query)}&rn=${maxResults}`
650|          );
651|          if (!resp?.ok) throw new Error(`百度 ${resp?.status}`);
652|          return parseBaiduResults(await resp.text(), maxResults);
653|        }
654|      },
655|      {
656|        name: 'sogou', weight: 75,
657|        fetcher: async () => {
658|          const resp = await fetchWithTimeout(
659|            `https://www.sogou.com/web?query=${encodeURIComponent(query)}`
660|          );
661|          if (!resp?.ok) throw new Error(`搜狗 ${resp?.status}`);
662|          return parseSogouResults(await resp.text(), maxResults);
663|        }
664|      },
665|      {
666|        name: '360搜索', weight: 75,
667|        fetcher: async () => {
668|          const resp = await fetchWithTimeout(
669|            `https://www.so.com/s?q=${encodeURIComponent(query)}`
670|          );
671|          if (!resp?.ok) throw new Error(`360 ${resp?.status}`);
672|          return parse360Results(await resp.text(), maxResults);
673|        }
674|      },
675|    ];
676|
677|    // 所有引擎并行执行，收集结果
678|    const settled = await Promise.allSettled(engines.map(e =>
679|      e.fetcher().then(results => ({ engine: e.name, results }))
680|    ));
681|
682|    // 汇总各引擎结果，合并去重（保留引擎和权重信息）
683|    const engineWeights = new Map(engines.map(e => [e.name, e.weight]));
684|    const allResults: Array<{ title: string; url: string; snippet: string; engine: string; weight: number; reachable?: boolean }> = [];
685|    const seenUrls = new Set<string>();
686|    const engineStats: Record<string, string> = {};
687|
688|    for (let i = 0; i < settled.length; i++) {
689|      const s = settled[i];
690|      const engineName = engines[i].name;
691|      if (s.status === 'fulfilled') {
692|        const r = s.value;
693|        engineStats[engineName] = `${r.results.length} 条`;
694|        for (const item of r.results) {
695|          const normalized = item.url.replace(/\/+$/, '').toLowerCase();
696|          if (!seenUrls.has(normalized)) {
697|            seenUrls.add(normalized);
698|            allResults.push({ ...item, engine: engineName, weight: engineWeights.get(engineName) || 50 });
699|          }
700|        }
701|      } else {
702|        engineStats[engineName] = `失败: ${(s.reason as Error)?.message || 'timeout'}`;
703|        sendLog('warn', `🔍 ${engineName} 搜索失败`, (s.reason as Error)?.message || '未知');
704|      }
705|    }
706|
707|    if (allResults.length === 0) {
708|      return { success: false, error: '所有搜索引擎均未返回结果，请尝试其他关键词' };
709|    }
710|
711|    // ── 3. 清理摘要 ──
712|    for (const r of allResults) {
713|      r.title = r.title.replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim();
714|      r.snippet = r.snippet.replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim();
715|    }
716|
717|    // ── 4. URL 可达性预检 + 质量评分 ──
718|    const topResults = allResults.slice(0, Math.min(maxResults * 2, allResults.length)); // 多检查一些用于排序
719|    const CONCURRENCY = 5;
720|    for (let i = 0; i < topResults.length; i += CONCURRENCY) {
721|      const batch = topResults.slice(i, i + CONCURRENCY);
722|      const checks = batch.map(async r => {
723|        try {
724|          const resp = await fetchWithTimeout(r.url, 3000, {
725|            'User-Agent': DESKTOP_UA,
726|            'Accept': 'text/html,*/*',
727|          });
728|          r.reachable = resp?.ok === true;
729|        } catch {
730|          r.reachable = false;
731|        }
732|      });
733|      await Promise.allSettled(checks);
734|    }
735|
736|    // ── 5. 智能排序：可达优先 + 引擎权重 + 摘要质量 ──
737|    const scored = topResults.map(r => {
738|      let score = (r.weight / 100) * 50; // 引擎权重贡献 50%
739|      if (r.reachable === true) score += 30; // 可达 +30
740|      else if (r.reachable === false) score -= 20; // 不可达 -20
741|      // 摘要质量：越长越好（上限100字符），有内容的加分
742|      const snippetLen = Math.min(r.snippet.length, 100);
743|      score += (snippetLen / 100) * 20; // 摘要质量贡献 20%
744|      return { ...r, _score: Math.round(score * 10) / 10 };
745|    });
746|
747|    scored.sort((a, b) => b._score - a._score);
748|
749|    // ── 5.5 摘要自动增强：snippet 太短/为空时，用 web_fetch 补充 top 3 ──
750|    if (enhanceSnippets) {
751|      const needEnhance = scored.slice(0, Math.min(5, maxResults)).filter(r => r.snippet.length < 30 && r.reachable !== false);
752|      if (needEnhance.length > 0) {
753|        sendLog('info', `🔍 自动补充摘要`, `${needEnhance.length} 个结果摘要过短，尝试 web_fetch`);
754|        const enhanced = await Promise.allSettled(needEnhance.slice(0, 3).map(async (r) => {
755|          try {
756|            const fetchResult = await handleWebFetch({ url: r.url, max_chars: 500, retry: false });
757|            if (fetchResult.success && fetchResult.content) {
758|              const text = String(fetchResult.content).replace(/\s+/g, ' ').trim();
759|              r.snippet = text.length > 200 ? text.slice(0, 200) + '…' : text;
760|              (r as any)._enhanced = true;
761|            }
762|          } catch { /* enhancement is optional */ }
763|        }));
764|        const enhancedCount = enhanced.filter(e => e.status === 'fulfilled').length;
765|        if (enhancedCount > 0) sendLog('success', `🔍 摘要增强完成`, `${enhancedCount} 个`);
766|      }
767|    }
768|
769|    // 截取最终结果
770|    const finalResults = scored.slice(0, maxResults);
771|
772|    // ── 6. 缓存结果 ──
773|    cacheSet(cacheKey, { results: finalResults, time: Date.now() });
774|
775|    const finalResult = buildSearchResponse(finalResults, maxResults, false, engineStats);
776|    finalResult._mode = 'builtin';
777|    return finalResult;
778|  } catch (err) {
779|    return { success: false, error: (err as Error).message };
780|  }\n}\n\n/** 对搜索结果的前 fetchTop 条自动调用 web_fetch 获取完整内容 */\nasync function applyAutoFetch(result: ToolResult, fetchTop: number): Promise<ToolResult> {\n  const results = (result as any).results as Array<{ url: string; title: string; snippet: string }> | undefined;\n  if (!results || results.length === 0) return result;\n\n  const toFetch = results.slice(0, fetchTop);\n  sendLog('info', `⬇️ 自动抓取 ${toFetch.length} 条网页`, toFetch.map(r => r.title.slice(0, 30)).join(', '));\n\n  const fetched: Array<{ url: string; title: string; content: string }> = [];\n  for (const r of toFetch) {\n    try {\n      const fetchResult = await handleWebFetch({ url: r.url, max_chars: 5000, retry: false });\n      if (fetchResult.success && fetchResult.content) {\n        fetched.push({ url: r.url, title: r.title, content: String(fetchResult.content).slice(0, 5000) });\n      }\n    } catch { /* skip failed fetch */ }\n  }\n\n  sendLog('success', `⬇️ 自动抓取完成`, `${fetched.length}/${toFetch.length} 条成功`);\n  (result as any)._fetched = fetched;\n  (result as any)._fetched_count = fetched.length;\n  return result;\n}\n\n/** 构建搜索响应（格式化文本 + 结构化 JSON） */
781|function buildSearchResponse(
782|  results: Array<{ title: string; url: string; snippet: string; engine: string; weight?: number; reachable?: boolean; _score?: number; _enhanced?: boolean }>,
783|  maxResults: number,
784|  fromCache: boolean,
785|  engineStats?: Record<string, string>,
786|): ToolResult {
787|  const sliced = results.slice(0, maxResults);
788|
789|  // 格式化文本（保持向后兼容）
790|  const now = new Date();
791|  const dateStr = `${now.getFullYear()}年${now.getMonth() + 1}月${now.getDate()}日`;
792|  let formatted = `[当前日期: ${dateStr}（搜索时的实时日期）]`;
793|  if (fromCache) formatted += ` [缓存]`;
794|  formatted += `\n\n`;
795|
796|  if (engineStats) {
797|    const statsStr = Object.entries(engineStats).map(([k, v]) => `${k}: ${v}`).join(' | ');
798|    formatted += `[引擎状态: ${statsStr}]\n\n`;
799|  }
800|
801|  formatted += sliced.map((r, i) => {
802|    const marks: string[] = [];
803|    if (r.reachable === false) marks.push('⚠️可能不可达');
804|    if (r._score !== undefined) marks.push(`${r._score}分`);
805|    if (r._enhanced) marks.push('📝增强摘要');
806|    const markStr = marks.length > 0 ? ` [${marks.join(' ')}]` : '';
807|    return `[${i + 1}] ${r.title}${markStr}\n    URL: ${r.url}\n    ${r.snippet}`;
808|  }).join('\n\n');
809|
810|  // 结构化 JSON（新增）
811|  const structured = sliced.map((r, i) => ({
812|    index: i + 1,
813|    title: r.title,
814|    url: r.url,
815|    snippet: r.snippet,
816|    engine: r.engine,
817|    reachable: r.reachable,
818|    ...(r._score !== undefined && { score: r._score }),
819|    ...(r._enhanced && { enhanced_snippet: true }),
820|  }));
821|
822|  return {
823|    success: true,
824|    query: '',
825|    results: sliced,
826|    total: sliced.length,
827|    formatted,
828|    structured,
829|    from_cache: fromCache,
830|    engine_stats: engineStats || {},
831|  };
832|}
833|
834|/** 解析百度 HTML 搜索结果 */
835|function parseBaiduResults(html: string, maxResults: number): Array<{ title: string; url: string; snippet: string }> {
836|  const results: Array<{ title: string; url: string; snippet: string }> = [];
837|
838|  // 百度结果块：<div class="result" ...> 或 <div class="result-op" ...>
839|  // 标题：<h3 class="t"> 内的 <a href="...">title</a>
840|  // 摘要：<div class="c-abstract">...</div>
841|  const blockRegex = /<div class="result[^"]*"[^>]*>([\s\S]*?)(?=<div class="result|<div id="content_right|$)/gi;
842|  let blockMatch;
843|
844|  while ((blockMatch = blockRegex.exec(html)) !== null && results.length < maxResults) {
845|    const block = blockMatch[1];
846|
847|    // 提取标题和 URL
848|    const titleMatch = block.match(/<h3[^>]*class="[^"]*t[^"]*"[^>]*>[\s\S]*?<a[^>]*href="([^"]*)"[^>]*>([\s\S]*?)<\/a>/);
849|    if (!titleMatch) continue;
850|
851|    let url = titleMatch[1].trim();
852|    const title = decodeHTML(titleMatch[2].replace(/<[^>]+>/g, '').trim());
853|
854|    // 百度有时使用 data-url 属性
855|    if (!url.startsWith('http')) {
856|      const dataUrlMatch = block.match(/data-url="(https?:\/\/[^"]*)"/);
857|      if (dataUrlMatch) url = dataUrlMatch[1];
858|    }
859|
860|    // 提取摘要
861|    const snippetMatch = block.match(/<div class="c-abstract"[^>]*>([\s\S]*?)<\/div>/) ||
862|      block.match(/<span class="content-right_[^"]*"[^>]*>([\s\S]*?)<\/span>/);
863|    const snippet = snippetMatch ? decodeHTML(snippetMatch[1].replace(/<[^>]+>/g, '').trim()) : '';
864|
865|    if (title) {
866|      results.push({ title, url: url.startsWith('http') ? url : `https://www.baidu.com${url}`, snippet });
867|    }
868|  }
869|
870|  return results;
871|}
872|
873|/** 解析搜狗 HTML 搜索结果 */
874|function parseSogouResults(html: string, maxResults: number): Array<{ title: string; url: string; snippet: string }> {
875|  const results: Array<{ title: string; url: string; snippet: string }> = [];
876|
877|  // 搜狗结果块：<div class="vrwrap"> 或 <div class="rb">
878|  const blockRegex = /<div[^>]*class="[^"]*(?:vrwrap|rb)[^"]*"[^>]*>([\s\S]*?)(?=<div[^>]*class="[^"]*(?:vrwrap|rb)[^"]*"|<div[^>]*id="pagebar)/gi;
879|  let blockMatch;
880|
881|  while ((blockMatch = blockRegex.exec(html)) !== null && results.length < maxResults) {
882|    const block = blockMatch[1];
883|
884|    // 提取标题和 URL：<a href="..." ...>标题</a>
885|    const linkMatch = block.match(/<a[^>]*href="(https?:\/\/[^"]*)"[^>]*>([\s\S]*?)<\/a>/i);
886|    if (!linkMatch) continue;
887|
888|    const url = decodeHTML(linkMatch[1].trim());
889|    const title = decodeHTML(linkMatch[2].replace(/<[^>]+>/g, '').trim());
890|
891|    // 跳过搜狗自身链接
892|    if (url.includes('sogou.com') || url.includes('sogo.com')) continue;
893|
894|    // 提取摘要：<p class="star-wiki"> 或 <div class="space-txt"> 或 <p class="str_info">
895|    const snippetMatch =
896|      block.match(/<p[^>]*class="[^"]*star-wiki[^"]*"[^>]*>([\s\S]*?)<\/p>/i) ||
897|      block.match(/<div[^>]*class="[^"]*space-txt[^"]*"[^>]*>([\s\S]*?)<\/div>/i) ||
898|      block.match(/<p[^>]*class="[^"]*str_info[^"]*"[^>]*>([\s\S]*?)<\/p>/i);
899|    const snippet = snippetMatch ? decodeHTML(snippetMatch[1].replace(/<[^>]+>/g, '').trim()) : '';
900|
901|    if (title && url.startsWith('http')) {
902|      results.push({ title, url, snippet });
903|    }
904|  }
905|
906|  return results;
907|}
908|
909|/** 解析 360 搜索 HTML 搜索结果 */
910|function parse360Results(html: string, maxResults: number): Array<{ title: string; url: string; snippet: string }> {
911|  const results: Array<{ title: string; url: string; snippet: string }> = [];
912|
913|  // 360 结果块：<li class="res-list"> 或 <div class="result">
914|  const blockRegex = /<(?:li[^>]*class="[^"]*res-list[^"]*"|div[^>]*class="[^"]*result[^"]*")[^>]*>([\s\S]*?)(?=<(?:li[^>]*class="[^"]*res-list|div[^>]*class="[^"]*result)|<\/ul>|<\/div>\s*<\/div>\s*$)/gi;
915|  let blockMatch;
916|
917|  while ((blockMatch = blockRegex.exec(html)) !== null && results.length < maxResults) {
918|    const block = blockMatch[1];
919|
920|    // 提取标题和 URL
921|    const linkMatch = block.match(/<a[^>]*href="(https?:\/\/[^"]*)"[^>]*>([\s\S]*?)<\/a>/i);
922|    if (!linkMatch) continue;
923|
924|    const url = decodeHTML(linkMatch[1].trim());
925|    const title = decodeHTML(linkMatch[2].replace(/<[^>]+>/g, '').trim());
926|
927|    // 跳过 360 自身链接
928|    if (url.includes('so.com') && !url.includes('www.so.com/link')) continue;
929|
930|    // 提取摘要：<p class="res-desc"> 或 <div class="res-rich"> 或 <p class="res-summary">
931|    const snippetMatch =
932|      block.match(/<p[^>]*class="[^"]*res-desc[^"]*"[^>]*>([\s\S]*?)<\/p>/i) ||
933|      block.match(/<div[^>]*class="[^"]*res-rich[^"]*"[^>]*>([\s\S]*?)<\/div>/i) ||
934|      block.match(/<p[^>]*class="[^"]*res-summary[^"]*"[^>]*>([\s\S]*?)<\/p>/i) ||
935|      block.match(/<dd[^>]*>([\s\S]*?)<\/dd>/i);
936|    const snippet = snippetMatch ? decodeHTML(snippetMatch[1].replace(/<[^>]+>/g, '').trim()) : '';
937|
938|    if (title && url.startsWith('http')) {
939|      results.push({ title, url, snippet });
940|    }
941|  }
942|
943|  return results;
944|}
945|
946|/** 解析 Bing HTML 搜索结果 */
947|function parseBingResults(html: string, maxResults: number): Array<{ title: string; url: string; snippet: string }> {
948|  const results: Array<{ title: string; url: string; snippet: string }> = [];
949|
950|  // 匹配 <li class="b_algo"> 块
951|  const blockRegex = /<li class="b_algo"[^>]*>([\s\S]*?)<\/li>/gi;
952|  let blockMatch;
953|
954|  while ((blockMatch = blockRegex.exec(html)) !== null && results.length < maxResults) {
955|    const block = blockMatch[1];
956|
957|    const titleMatch = block.match(/<a[^>]*href="(https?:\/\/[^"]*)"[^>]*>([\s\S]*?)<\/a>/);
958|    const snippetMatch = block.match(/<p[^>]*>([\s\S]*?)<\/p>/) || block.match(/<div class="b_caption"[^>]*>([\s\S]*?)<\/div>/);
959|
960|    if (titleMatch) {
961|      const url = titleMatch[1].trim();
962|      const title = decodeHTML(titleMatch[2].replace(/<[^>]+>/g, '').trim());
963|      const snippet = snippetMatch ? decodeHTML(snippetMatch[1].replace(/<[^>]+>/g, '').trim()) : '';
964|
965|      if (title && url.startsWith('http')) {
966|        results.push({ title, url, snippet });
967|      }
968|    }
969|  }
970|
971|  return results;
972|}
973|
974|/** 简单 HTML 实体解码（用于搜索结果解析） */
975|function decodeHTML(text: string): string {
976|  return decodeHTMLEntities(text);
977|}
978|
979|export async function handleDownloadFile(params: { url: string; destination: string }): Promise<ToolResult> {
980|  try {
981|    const destPath = resolvePath(params.destination);
982|    const allowed = checkPathAllowed(destPath, 'write');
983|    if (!allowed.ok) return { success: false, error: allowed.reason };
984|
985|    if (!params.url.startsWith('http://') && !params.url.startsWith('https://')) {
986|      return { success: false, error: '仅支持 http/https 协议' };
987|    }
988|
989|    sendLog('info', `⬇️ download_file`, `${params.url} → ${destPath}`);
990|
991|    // 带超时的下载（大文件给更长超时）
992|    const controller = new AbortController();
993|    const timeoutId = setTimeout(() => controller.abort(), 60_000);
994|    let resp: Response;
995|    try {
996|      resp = await fetch(params.url, { signal: controller.signal });
997|    } finally {
998|      clearTimeout(timeoutId);
999|    }
1000|
1001|    if (!resp.ok) return { success: false, error: `HTTP ${resp.status}: ${resp.statusText}` };
1002|
1003|    const buf = Buffer.from(await resp.arrayBuffer());
1004|    if (buf.length > 50 * 1024 * 1024) {
1005|      return { success: false, error: '文件超过 50MB 限制' };
1006|    }
1007|
1008|    const destDir = path.dirname(destPath);
1009|    await fs.mkdir(destDir, { recursive: true });
1010|    await fs.writeFile(destPath, buf);
1011|
1012|    sendLog('success', `⬇️ download_file 完成`, `${buf.length} bytes`);
1013|    return {
1014|      success: true,
1015|      url: params.url,
1016|      destination: destPath,
1017|      size: buf.length,
1018|      content_type: resp.headers.get('content-type') || 'unknown'
1019|    };
1020|  } catch (err) {
1021|    const errMsg = (err as Error).message;
1022|    if (errMsg.includes('abort')) {
1023|      return { success: false, error: '下载超时 (60s)' };
1024|    }
1025|    return { success: false, error: errMsg };
1026|  }
1027|}
1028|
1029|export async function handleCompress(params: { action: string; path: string; destination?: string; format?: string }): Promise<ToolResult> {
1030|  try {
1031|    const format = params.format || 'tar.gz';
1032|
1033|    if (params.action === 'create') {
1034|      const srcPath = resolvePath(params.path);
1035|      const check = checkPathAllowed(srcPath, 'read');
1036|      if (!check.ok) return { success: false, error: check.reason };
1037|
1038|      const destPath = params.destination
1039|        ? resolvePath(params.destination)
1040|        : srcPath + (format === 'zip' ? '.zip' : '.tar.gz');
1041|      const destCheck = checkPathAllowed(destPath, 'write');
1042|      if (!destCheck.ok) return { success: false, error: destCheck.reason };
1043|
1044|      return new Promise((resolve) => {
1045|        const cmd = format === 'zip'
1046|          ? `zip -r "${destPath}" "${path.basename(srcPath)}"`
1047|          : `tar czf "${destPath}" "${path.basename(srcPath)}"`;
1048|        const proc = spawn('bash', ['-c', cmd], { cwd: path.dirname(srcPath), stdio: ['pipe', 'pipe', 'pipe'] });
1049|        let stderr = '';
1050|        proc.stderr.on('data', (d: Buffer) => { stderr += d.toString(); });
1051|        proc.on('close', (code) => {
1052|          if (code === 0) {
1053|            fs.stat(destPath).then(s => {
1054|              resolve({ success: true, action: 'create', archive: destPath, size: s.size });
1055|            }).catch(() => resolve({ success: true, action: 'create', archive: destPath }));
1056|          } else {
1057|            resolve({ success: false, error: stderr || `压缩失败 (exit ${code})` });
1058|          }
1059|        });
1060|        proc.on('error', (err) => resolve({ success: false, error: err.message }));
1061|      });
1062|    } else {
1063|      // extract
1064|      const archivePath = resolvePath(params.path);
1065|      const check = checkPathAllowed(archivePath, 'read');
1066|      if (!check.ok) return { success: false, error: check.reason };
1067|
1068|      const destDir = params.destination ? resolvePath(params.destination) : path.dirname(archivePath);
1069|      const destCheck = checkPathAllowed(destDir, 'write');
1070|      if (!destCheck.ok) return { success: false, error: destCheck.reason };
1071|
1072|      await fs.mkdir(destDir, { recursive: true });
1073|
1074|      return new Promise((resolve) => {
1075|        const isZip = archivePath.endsWith('.zip');
1076|        const cmd = isZip
1077|          ? `unzip -o "${archivePath}" -d "${destDir}"`
1078|          : `tar xzf "${archivePath}" -C "${destDir}"`;
1079|        const proc = spawn('bash', ['-c', cmd], { stdio: ['pipe', 'pipe', 'pipe'] });
1080|        let stderr = '';
1081|        proc.stderr.on('data', (d: Buffer) => { stderr += d.toString(); });
1082|        proc.on('close', (code) => {
1083|          resolve(code === 0
1084|            ? { success: true, action: 'extract', destination: destDir }
1085|            : { success: false, error: stderr || `解压失败 (exit ${code})` }
1086|          );
1087|        });
1088|        proc.on('error', (err) => resolve({ success: false, error: err.message }));
1089|      });
1090|    }
1091|  } catch (err) {
1092|    return { success: false, error: (err as Error).message };
1093|  }
1094|}
1095|
1096|// ── datetime: 获取系统精确时间 ──
1097|export function handleDateTime(params: { format?: string; timezone?: string }): ToolResult {
1098|  try {
1099|    const now = new Date();
1100|    const tz = params.timezone || Intl.DateTimeFormat().resolvedOptions().timeZone;
1101|    const fmt = params.format || 'full';
1102|
1103|    const iso = now.toISOString();
1104|    const unixSec = Math.floor(now.getTime() / 1000);
1105|    const unixMs = now.getTime();
1106|
1107|    // 中文日期（无前导零月份）
1108|    const y = now.getFullYear();
1109|    const m = now.getMonth() + 1;
1110|    const d = now.getDate();
1111|    const weekdays = ['日', '一', '二', '三', '四', '五', '六'];
1112|    const weekday = `星期${weekdays[now.getDay()]}`;
1113|    const dateStr = `${y}年${m}月${d}日 ${weekday}`;
1114|
1115|    // 24小时制时间
1116|    const h = now.getHours();
1117|    const min = now.getMinutes();
1118|    const sec = now.getSeconds();
1119|    const time24 = `${String(h).padStart(2, '0')}:${String(min).padStart(2, '0')}:${String(sec).padStart(2, '0')}`;
1120|
1121|    // 时段
1122|    const period = h < 6 ? '凌晨' : h < 12 ? '上午' : h < 14 ? '中午' : h < 18 ? '下午' : '晚上';
1123|
1124|    // 人性化时间（12小时制 + 时段）
1125|    const h12 = h === 0 ? 12 : h > 12 ? h - 12 : h;
1126|    const timeFriendly = `${period} ${h12}:${String(min).padStart(2, '0')}`;
1127|
1128|    // 完整人性化字符串
1129|    const friendly = `${y}年${m}月${d}日 ${weekday} ${timeFriendly}`;
1130|
1131|    let result: Record<string, unknown>;
1132|
1133|    switch (fmt) {
1134|      case 'iso':
1135|        result = { iso, timezone: tz };
1136|        break;
1137|      case 'unix':
1138|        result = { unix_seconds: unixSec, unix_milliseconds: unixMs, timezone: tz };
1139|        break;
1140|      case 'date':
1141|        result = { date: dateStr, weekday, timezone: tz };
1142|        break;
1143|      case 'time':
1144|        result = { time_24h: time24, period, time_friendly: timeFriendly, timezone: tz };
1145|        break;
1146|      default: // full
1147|        result = {
1148|          iso,
1149|          unix_seconds: unixSec,
1150|          unix_milliseconds: unixMs,
1151|          date: dateStr,
1152|          weekday,
1153|          time_24h: time24,
1154|          period,
1155|          time_friendly: timeFriendly,
1156|          friendly,
1157|          timezone: tz,
1158|          year: y,
1159|          month: m,
1160|          day: d,
1161|          hour: h,
1162|          minute: min,
1163|          second: sec,
1164|          millisecond: now.getMilliseconds(),
1165|          day_of_week: now.getDay(),
1166|        };
1167|    }
1168|
1169|    return { success: true, ...result };
1170|  } catch (err) {
1171|    return { success: false, error: (err as Error).message };
1172|  }
1173|}
1174|
1175|// ── calculator: 安全数学计算器（纯 JS 递归下降解析，无 eval） ──
1176|export function handleCalculator(params: { expression: string }): ToolResult {
1177|  try {
1178|    const expr = params.expression;
1179|    if (!expr || expr.length > 500) {
1180|      return { success: false, error: '表达式为空或过长（最大500字符）' };
1181|    }
1182|    const result = safeCalc(expr);
1183|    return { success: true, expression: expr, result };
1184|  } catch (err) {
1185|    return { success: false, error: (err as Error).message, expression: params.expression };
1186|  }
1187|}
1188|
1189|function safeCalc(expr: string): number {
1190|  expr = expr.replace(/\s+/g, '');
1191|  if (!/^[\d+\-*/().%^]+$/.test(expr)) {
1192|    throw new Error('表达式包含非法字符');
1193|  }
1194|  let pos = 0;
1195|
1196|  function parseExpression(): number {
1197|    let left = parseTerm();
1198|    while (pos < expr.length) {
1199|      if (expr[pos] === '+') { pos++; left += parseTerm(); }
1200|      else if (expr[pos] === '-') { pos++; left -= parseTerm(); }
1201|      else break;
1202|    }
1203|    return left;
1204|  }
1205|
1206|  function parseTerm(): number {
1207|    let left = parsePower();
1208|    while (pos < expr.length) {
1209|      if (expr[pos] === '*') { pos++; left *= parsePower(); }
1210|      else if (expr[pos] === '/') { pos++; const d = parsePower(); if (d === 0) throw new Error('除数不能为零'); left /= d; }
1211|      else if (expr[pos] === '%') { pos++; left %= parsePower(); }
1212|      else break;
1213|    }
1214|    return left;
1215|  }
1216|
1217|  function parsePower(): number {
1218|    let left = parseUnary();
1219|    while (pos < expr.length && expr[pos] === '*' && pos + 1 < expr.length && expr[pos + 1] === '*') {
1220|      pos += 2;
1221|      left = Math.pow(left, parseUnary());
1222|    }
1223|    return left;
1224|  }
1225|
1226|  function parseUnary(): number {
1227|    if (expr[pos] === '-') { pos++; return -parseAtom(); }
1228|    if (expr[pos] === '+') { pos++; return parseAtom(); }
1229|    return parseAtom();
1230|  }
1231|
1232|  function parseAtom(): number {
1233|    if (expr[pos] === '(') {
1234|      pos++;
1235|      const val = parseExpression();
1236|      if (pos >= expr.length || expr[pos] !== ')') throw new Error('缺少右括号');
1237|      pos++;
1238|      return val;
1239|    }
1240|    const start = pos;
1241|    while (pos < expr.length && /[\d.]/.test(expr[pos])) pos++;
1242|    if (start === pos) throw new Error(`意外字符: ${expr[pos] || 'EOF'}`);
1243|    const num = parseFloat(expr.slice(start, pos));
1244|    if (isNaN(num)) throw new Error(`无效数字: ${expr.slice(start, pos)}`);
1245|    return num;
1246|  }
1247|
1248|  const result = parseExpression();
1249|  if (pos < expr.length) throw new Error(`表达式末尾有意外字符: ${expr.slice(pos)}`);
1250|  if (!isFinite(result)) throw new Error('计算结果为无穷大');
1251|  return result;
1252|}
1253|
1254|// ── random: 随机数生成 ──
1255|export function handleRandom(params: { type?: string; min?: number; max?: number; count?: number; items?: string[]; length?: number }): ToolResult {
1256|  try {
1257|    const type = params.type || 'int';
1258|
1259|    switch (type) {
1260|      case 'int': {
1261|        const min = params.min ?? 0;
1262|        const max = params.max ?? 100;
1263|        if (min > max) return { success: false, error: 'min 不能大于 max' };
1264|        const count = Math.min(params.count ?? 1, 100);
1265|        if (count === 1) {
1266|          return { success: true, type: 'int', result: Math.floor(Math.random() * (max - min + 1)) + min, range: [min, max] };
1267|        }
1268|        const results: number[] = [];
1269|        for (let i = 0; i < count; i++) results.push(Math.floor(Math.random() * (max - min + 1)) + min);
1270|        return { success: true, type: 'int', results, count, range: [min, max] };
1271|      }
1272|      case 'float': {
1273|        const min = params.min ?? 0;
1274|        const max = params.max ?? 1;
1275|        if (min > max) return { success: false, error: 'min 不能大于 max' };
1276|        const count = Math.min(params.count ?? 1, 100);
1277|        if (count === 1) {
1278|          return { success: true, type: 'float', result: Number((Math.random() * (max - min) + min).toFixed(6)), range: [min, max] };
1279|        }
1280|        const results: number[] = [];
1281|        for (let i = 0; i < count; i++) results.push(Number((Math.random() * (max - min) + min).toFixed(6)));
1282|        return { success: true, type: 'float', results, count, range: [min, max] };
1283|      }
1284|      case 'pick': {
1285|        const items = params.items;
1286|        if (!items || items.length === 0) return { success: false, error: 'pick 类型需要提供 items 数组' };
1287|        const count = Math.min(params.count ?? 1, items.length);
1288|        // Fisher-Yates 部分洗牌
1289|        const pool = [...items];
1290|        const picked: string[] = [];
1291|        for (let i = 0; i < count; i++) {
1292|          const idx = Math.floor(Math.random() * pool.length);
1293|          picked.push(pool[idx]);
1294|          pool.splice(idx, 1);
1295|        }
1296|        return { success: true, type: 'pick', result: count === 1 ? picked[0] : picked, from: items.length, count };
1297|      }
1298|      case 'string': {
1299|        const length = Math.min(params.length ?? 8, 256);
1300|        const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
1301|        let s = '';
1302|        for (let i = 0; i < length; i++) s += chars.charAt(Math.floor(Math.random() * chars.length));
1303|        // 使用 crypto 增强随机性
1304|        const buf = require('crypto').randomBytes(Math.ceil(length * 0.75));
1305|        let bIdx = 0;
1306|        let result = '';
1307|        for (let i = 0; i < length; i++) {
1308|          const r = buf[bIdx++] || Math.floor(Math.random() * 256);
1309|          if (bIdx >= buf.length) bIdx = 0;
1310|          result += chars.charAt(r % chars.length);
1311|        }
1312|        return { success: true, type: 'string', result, length, charset: 'alphanumeric' };
1313|      }
1314|      default:
1315|        return { success: false, error: `未知类型: ${type}。支持: int / float / pick / string` };
1316|    }
1317|  } catch (err) {
1318|    return { success: false, error: (err as Error).message };
1319|  }
1320|}
1321|
1322|// ── uuid: 生成 UUID v4 ──
1323|export function handleUUID(params: { count?: number }): ToolResult {
1324|  try {
1325|    const crypto = require('crypto');
1326|    const count = Math.min(params.count ?? 1, 20);
1327|    if (count === 1) {
1328|      return { success: true, result: crypto.randomUUID() };
1329|    }
1330|    const results: string[] = [];
1331|    for (let i = 0; i < count; i++) results.push(crypto.randomUUID());
1332|    return { success: true, results, count };
1333|  } catch (err) {
1334|    return { success: false, error: (err as Error).message };
1335|  }
1336|}
1337|
1338|// ── json_format: JSON 格式化 + 验证 ──
1339|export function handleJsonFormat(params: { json: string; indent?: number; sort_keys?: boolean }): ToolResult {
1340|  try {
1341|    const parsed = JSON.parse(params.json);
1342|    const indent = params.indent ?? 2;
1343|    let formatted: string;
1344|    if (params.sort_keys) {
1345|      formatted = JSON.stringify(sortObjectKeys(parsed), null, indent);
1346|    } else {
1347|      formatted = JSON.stringify(parsed, null, indent);
1348|    }
1349|    const size = Buffer.byteLength(formatted, 'utf-8');
1350|    return { success: true, formatted, original_size: params.json.length, formatted_size: size, keys: Object.keys(parsed).length };
1351|  } catch (err) {
1352|    return { success: false, error: `JSON 解析失败: ${(err as Error).message}`, input_preview: params.json.slice(0, 200) };
1353|  }
1354|
1355|  function sortObjectKeys(obj: any): any {
1356|    if (Array.isArray(obj)) return obj.map(sortObjectKeys);
1357|    if (obj !== null && typeof obj === 'object') {
1358|      const sorted: Record<string, any> = {};
1359|      for (const k of Object.keys(obj).sort()) sorted[k] = sortObjectKeys(obj[k]);
1360|      return sorted;
1361|    }
1362|    return obj;
1363|  }
1364|}
1365|
1366|// ── hash: 哈希计算 ──
1367|export function handleHash(params: { text: string; algorithm?: string }): ToolResult {
1368|  try {
1369|    const crypto = require('crypto');
1370|    const algo = (params.algorithm || 'sha256').toLowerCase().replace('-', '');
1371|    const validAlgos = ['md5', 'sha1', 'sha256', 'sha384', 'sha512'];
1372|    if (!validAlgos.includes(algo)) {
1373|      return { success: false, error: `不支持的算法: ${algo}。支持: ${validAlgos.join(', ')}` };
1374|    }
1375|    const hash = crypto.createHash(algo).update(params.text, 'utf-8').digest('hex');
1376|    return { success: true, algorithm: algo, hash, input_length: params.text.length };
1377|  } catch (err) {
1378|    return { success: false, error: (err as Error).message };
1379|  }
1380|}
1381|