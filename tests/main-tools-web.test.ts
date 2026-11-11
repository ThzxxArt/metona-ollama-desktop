import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

const h = vi.hoisted(() => {
  const settings = new Map<string, unknown>();
  return {
    settings,
    getSetting: vi.fn((key: string, fallback: unknown) => (settings.has(key) ? settings.get(key) : fallback)),
    netCheck: vi.fn(async () => ({ ok: true }) as { ok: boolean; reason?: string }),
    browserOpen: vi.fn(async () => ({ success: true }) as { success: boolean; error?: string }),
    browserExtract: vi.fn(async () => ({ success: true, text: '' }) as { success: boolean; text?: string }),
    browserClose: vi.fn(async () => undefined),
    sendLog: vi.fn(),
  };
});

vi.mock('../src/main/tool-security.js', () => ({
  checkPathAllowed: () => ({ ok: true }),
  checkCommandAllowed: () => ({ ok: true }),
}));
vi.mock('../src/main/window-state.js', () => ({
  mainWindow: { webContents: { send: vi.fn() } },
}));
vi.mock('../src/main/tool-handlers-shared.js', () => ({
  sendLog: h.sendLog,
  resolvePath: (p: string) => p,
}));
vi.mock('../src/main/workspace.js', () => ({ getWorkspaceDir: () => '/tmp/ws' }));
vi.mock('../src/main/db/sqlite.js', () => ({ getSetting: h.getSetting }));
vi.mock('../src/main/browser.js', () => ({
  browserOpen: h.browserOpen,
  browserExtract: h.browserExtract,
  browserClose: h.browserClose,
}));
vi.mock('../src/main/net-guard.js', () => ({ checkPublicHttpUrl: h.netCheck }));

import { handleWebFetch, handleWebSearch, setHTTPTimeout, getHTTPTimeout } from '../src/main/tools/web.js';

type RespOpts = {
  status?: number;
  statusText?: string;
  contentType?: string | null;
  contentLength?: string;
  body?: unknown;
  arrayBuffer?: ArrayBuffer;
};

function makeResponse(body: string, opts: RespOpts = {}): Response {
  const status = opts.status ?? 200;
  const headers = new Headers();
  if (opts.contentType !== null) headers.set('content-type', opts.contentType ?? 'text/html; charset=utf-8');
  if (opts.contentLength !== undefined) headers.set('content-length', opts.contentLength);
  return {
    ok: status >= 200 && status < 300,
    status,
    statusText: opts.statusText ?? (status === 200 ? 'OK' : 'ERR'),
    headers,
    text: async () => body,
    json: async () => JSON.parse(body),
    body: opts.body ?? null,
    arrayBuffer: async () => opts.arrayBuffer ?? new TextEncoder().encode(body).buffer,
  } as unknown as Response;
}

function makeJsonResponse(data: unknown, status = 200): Response {
  const headers = new Headers({ 'content-type': 'application/json' });
  return {
    ok: status >= 200 && status < 300,
    status,
    statusText: status === 200 ? 'OK' : 'ERR',
    headers,
    text: async () => JSON.stringify(data),
    json: async () => data,
    body: null,
  } as unknown as Response;
}

const fetchMock = vi.fn();

/** 在 fake timers 下反复推进时间，直到目标 Promise 落定（处理嵌套计时器） */
async function advanceUntilSettled<T>(p: Promise<T>, step = 1000, maxSteps = 60): Promise<T> {
  let result: T | undefined;
  let error: unknown;
  let settled = false;
  p.then(
    (v) => {
      result = v;
      settled = true;
    },
    (e) => {
      error = e;
      settled = true;
    },
  );
  for (let i = 0; i < maxSteps && !settled; i++) {
    await vi.advanceTimersByTimeAsync(step);
  }
  if (!settled) throw new Error('promise did not settle with fake timers');
  if (error) throw error;
  return result as T;
}

beforeEach(() => {
  vi.useRealTimers();
  h.settings.clear();
  h.getSetting.mockClear();
  h.netCheck.mockReset();
  h.netCheck.mockResolvedValue({ ok: true });
  h.browserOpen.mockReset();
  h.browserOpen.mockResolvedValue({ success: true });
  h.browserExtract.mockReset();
  h.browserExtract.mockResolvedValue({ success: true, text: '' });
  h.browserClose.mockReset();
  h.browserClose.mockResolvedValue(undefined);
  h.sendLog.mockReset();
  fetchMock.mockReset();
  vi.stubGlobal('fetch', fetchMock);
  setHTTPTimeout(900_000);
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe('web_fetch 协议与 SSRF', () => {
  it('拒绝非 http/https URL', async () => {
    const r = await handleWebFetch({ url: 'ftp://example.com/x' });
    expect(r.success).toBe(false);
    expect(String(r.error)).toContain('http/https');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('SSRF 拦截时不发起请求', async () => {
    h.netCheck.mockResolvedValueOnce({ ok: false, reason: '禁止访问本机地址 localhost' });
    const r = await handleWebFetch({ url: 'http://localhost:11434/api/tags' });
    expect(r.success).toBe(false);
    expect(String(r.error)).toContain('安全拦截');
    expect(String(r.error)).toContain('localhost');
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe('web_fetch HTTP 内容处理', () => {
  it('HTML 默认转为纯文本并返回元数据', async () => {
    fetchMock.mockResolvedValueOnce(
      makeResponse(`<html><body><h1>标题</h1><p>${'正文'.repeat(120)}</p></body></html>`),
    );
    const r = await handleWebFetch({ url: 'https://example.com/a' });
    expect(r.success).toBe(true);
    expect(r.content_type).toContain('text/html');
    expect(r.status).toBe(200);
    expect(String(r.content)).toContain('标题');
    expect(String(r.content)).not.toContain('<h1>');
    expect(r.method).toBe('fetch (UA#0)');
    expect(r.truncated).toBe(false);
  });

  it('extract_mode=markdown 保留结构化格式', async () => {
    const html = `<html><body><h1>大标题</h1><a href="https://example.com/x">链接</a><p>${'y'.repeat(300)}</p></body></html>`;
    fetchMock.mockResolvedValueOnce(makeResponse(html));
    const r = await handleWebFetch({ url: 'https://example.com/md', extract_mode: 'markdown' });
    expect(r.success).toBe(true);
    expect(String(r.content)).toContain('# 大标题');
    expect(String(r.content)).toContain('[链接](https://example.com/x)');
  });

  it('非文本内容类型被拒绝', async () => {
    fetchMock.mockResolvedValueOnce(makeResponse('PDFDATA', { contentType: 'application/pdf' }));
    const r = await handleWebFetch({ url: 'https://example.com/file.pdf' });
    expect(r.success).toBe(false);
    expect(String(r.error)).toContain('不支持的内容类型');
    expect(String(r.error)).toContain('download_file');
  });

  it('content-length 超过 10MB 直接拒绝', async () => {
    fetchMock.mockResolvedValueOnce(makeResponse('x', { contentLength: String(11 * 1024 * 1024) }));
    const r = await handleWebFetch({ url: 'https://example.com/big' });
    expect(r.success).toBe(false);
    expect(String(r.error)).toContain('页面过大');
    expect(String(r.error)).toContain('11.0MB');
  });

  it('无 content-length 时流式读取超过 10MB 中止', async () => {
    const chunks = [new Uint8Array(6 * 1024 * 1024), new Uint8Array(5 * 1024 * 1024)];
    let i = 0;
    const cancel = vi.fn(async () => undefined);
    const body = {
      getReader: () => ({
        read: async () => (i < chunks.length ? { done: false, value: chunks[i++] } : { done: true, value: undefined }),
        cancel,
      }),
    };
    fetchMock.mockResolvedValueOnce(makeResponse('', { body }));
    const r = await handleWebFetch({ url: 'https://example.com/stream-big' });
    expect(r.success).toBe(false);
    expect(String(r.error)).toContain('超过 10MB');
    expect(cancel).toHaveBeenCalled();
  });

  it('无 content-length 且无 body 时按文本长度限制', async () => {
    fetchMock.mockResolvedValueOnce(makeResponse('z'.repeat(10 * 1024 * 1024 + 1), { contentType: 'text/plain' }));
    const r = await handleWebFetch({ url: 'https://example.com/no-body-big' });
    expect(r.success).toBe(false);
    expect(String(r.error)).toContain('页面过大');
  });

  it('max_chars 截断内容', async () => {
    fetchMock.mockResolvedValueOnce(makeResponse(`<html><body><p>${'A'.repeat(1000)}</p></body></html>`));
    const r = await handleWebFetch({ url: 'https://example.com/truncate', max_chars: 100 });
    expect(r.success).toBe(true);
    expect(r.truncated).toBe(true);
    expect(r.length).toBe(100);
    expect(String(r.content)).toHaveLength(100);
  });

  it('mobile_ua 使用移动端 UA', async () => {
    fetchMock.mockResolvedValueOnce(makeResponse('plain text body long enough', { contentType: 'text/plain' }));
    await handleWebFetch({ url: 'https://example.com/mobile', mobile_ua: true });
    const init = fetchMock.mock.calls[0][1] as { headers: Record<string, string> };
    expect(init.headers['User-Agent']).toContain('iPhone');
  });

  it('无 content-length 的普通流式响应正常读取', async () => {
    const chunks = [Buffer.from('hello '), Buffer.from('world')];
    let i = 0;
    const body = {
      getReader: () => ({
        read: async () => (i < chunks.length ? { done: false, value: chunks[i++] } : { done: true, value: undefined }),
        cancel: vi.fn(async () => undefined),
      }),
    };
    fetchMock.mockResolvedValueOnce(makeResponse('', { contentType: 'text/plain', body }));
    const r = await handleWebFetch({ url: 'https://example.com/stream-ok' });
    expect(r.success).toBe(true);
    expect(r.content).toBe('hello world');
  });
});

describe('web_fetch 重试与浏览器回退', () => {
  it('5xx 重试后成功，并轮换 UA', async () => {
    vi.useFakeTimers();
    fetchMock
      .mockResolvedValueOnce(makeResponse('oops', { status: 500, contentType: 'text/plain' }))
      .mockResolvedValueOnce(makeResponse(`<html><body><p>${'ok'.repeat(200)}</p></body></html>`));
    const r = await advanceUntilSettled(handleWebFetch({ url: 'https://example.com/retry' }));
    expect(r.success).toBe(true);
    expect(r.retries).toBe(1);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    const ua0 = (fetchMock.mock.calls[0][1] as { headers: Record<string, string> }).headers['User-Agent'];
    const ua1 = (fetchMock.mock.calls[1][1] as { headers: Record<string, string> }).headers['User-Agent'];
    expect(ua0).not.toBe(ua1);
  });

  it('5xx 最后一次仍失败返回 HTTP 错误', async () => {
    vi.useFakeTimers();
    fetchMock.mockResolvedValue(makeResponse('err', { status: 500, contentType: 'text/plain' }));
    const r = await advanceUntilSettled(handleWebFetch({ url: 'https://example.com/always-500' }));
    expect(r.success).toBe(false);
    expect(String(r.error)).toContain('HTTP 500');
    expect(fetchMock).toHaveBeenCalledTimes(4);
  });

  it('retry=false 时 500 不重试', async () => {
    fetchMock.mockResolvedValueOnce(makeResponse('err', { status: 500, contentType: 'text/plain' }));
    const r = await handleWebFetch({ url: 'https://example.com/no-retry-500', retry: false });
    expect(r.success).toBe(false);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(String(r.error)).toContain('HTTP 500');
  });

  it('网络错误重试后成功', async () => {
    vi.useFakeTimers();
    fetchMock
      .mockRejectedValueOnce(new Error('ECONNRESET'))
      .mockResolvedValueOnce(makeResponse('ok body', { contentType: 'text/plain' }));
    const r = await advanceUntilSettled(handleWebFetch({ url: 'https://example.com/net-retry' }));
    expect(r.success).toBe(true);
    expect(r.retries).toBe(1);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('超时后重试成功', async () => {
    vi.useFakeTimers();
    fetchMock
      .mockRejectedValueOnce(new Error('The operation was aborted'))
      .mockResolvedValueOnce(makeResponse('ok after timeout', { contentType: 'text/plain' }));
    const r = await advanceUntilSettled(handleWebFetch({ url: 'https://example.com/timeout-retry' }));
    expect(r.success).toBe(true);
    expect(r.retries).toBe(1);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it.each([403, 429, 502, 503])('HTTP %s 触发浏览器回退', async (status) => {
    vi.useFakeTimers();
    fetchMock.mockResolvedValueOnce(makeResponse('blocked', { status, contentType: 'text/html' }));
    h.browserExtract.mockResolvedValueOnce({ success: true, text: 'browser rendered content '.repeat(20) });
    const r = await advanceUntilSettled(handleWebFetch({ url: `https://example.com/fallback-${status}` }));
    expect(r.success).toBe(true);
    expect(r.method).toBe('browser(fallback)');
    expect(r.status).toBe(200);
    expect(String(r.content)).toContain('browser rendered');
    expect(h.browserOpen).toHaveBeenCalledTimes(1);
    expect(h.browserClose).toHaveBeenCalled();
  });

  it('拦截页自动回退浏览器', async () => {
    vi.useFakeTimers();
    const html = `<html><body>challenge-platform ${'x'.repeat(100)}</body></html>`;
    fetchMock.mockResolvedValueOnce(makeResponse(html));
    h.browserExtract.mockResolvedValueOnce({ success: true, text: 'cloudflare bypassed '.repeat(20) });
    const r = await advanceUntilSettled(handleWebFetch({ url: 'https://example.com/blocked' }));
    expect(r.success).toBe(true);
    expect(r.method).toBe('browser(blocked)');
    expect(String(r.content)).toContain('cloudflare bypassed');
  });

  it('拦截页浏览器失败后继续使用原始内容', async () => {
    vi.useFakeTimers();
    const html = `<html><body>challenge-platform ${'x'.repeat(100)}</body></html>`;
    fetchMock.mockResolvedValueOnce(makeResponse(html));
    h.browserOpen.mockResolvedValue({ success: false });
    const r = await advanceUntilSettled(handleWebFetch({ url: 'https://example.com/blocked-fail' }));
    expect(r.success).toBe(true);
    expect(r.method).toBe('fetch (UA#0)');
    expect(String(r.content)).toContain('xxxx');
  });

  it('短内容自动升级到浏览器渲染', async () => {
    vi.useFakeTimers();
    fetchMock.mockResolvedValueOnce(makeResponse(`<html><body><p>${'s'.repeat(100)}</p></body></html>`));
    h.browserExtract.mockResolvedValueOnce({ success: true, text: 'R'.repeat(500) });
    const r = await advanceUntilSettled(handleWebFetch({ url: 'https://example.com/spa', max_chars: 100 }));
    expect(r.success).toBe(true);
    expect(r.method).toBe('browser');
    expect(r.length).toBe(100);
    expect(r.truncated).toBe(true);
  });

  it('短内容浏览器失败后返回原始短内容', async () => {
    vi.useFakeTimers();
    fetchMock.mockResolvedValueOnce(makeResponse(`<html><body><p>${'s'.repeat(100)}</p></body></html>`));
    h.browserOpen.mockResolvedValue({ success: false });
    const r = await advanceUntilSettled(handleWebFetch({ url: 'https://example.com/spa-fail' }));
    expect(r.success).toBe(true);
    expect(r.method).toBe('fetch (UA#0)');
    expect(r.content).toBe('s'.repeat(100));
  });

  it('超时后回退浏览器', async () => {
    vi.useFakeTimers();
    setHTTPTimeout(5000);
    fetchMock.mockImplementation(
      (_url: string, init: { signal: AbortSignal }) =>
        new Promise((_resolve, reject) => {
          init.signal.addEventListener('abort', () => reject(new Error('The operation was aborted')));
        }),
    );
    h.browserExtract.mockResolvedValueOnce({ success: true, text: 'timeout fallback '.repeat(20) });
    const r = await advanceUntilSettled(handleWebFetch({ url: 'https://example.com/timeout', retry: false }));
    expect(r.success).toBe(true);
    expect(r.method).toBe('browser(fallback)');
  });

  it('所有 fetch 失败且浏览器失败返回组合错误', async () => {
    fetchMock.mockRejectedValue(new Error('ECONNREFUSED'));
    h.browserOpen.mockResolvedValue({ success: false });
    const r = await handleWebFetch({ url: 'https://example.com/all-fail', retry: false });
    expect(r.success).toBe(false);
    expect(String(r.error)).toContain('fetch 和浏览器渲染均失败');
  });

  it('网络错误在最后一次尝试后回退浏览器', async () => {
    fetchMock.mockRejectedValue(new Error('ECONNREFUSED'));
    h.browserExtract.mockResolvedValueOnce({ success: true, text: 'fallback text '.repeat(20) });
    vi.useFakeTimers();
    const r = await advanceUntilSettled(handleWebFetch({ url: 'https://example.com/net-fallback', retry: false }));
    expect(r.success).toBe(true);
    expect(r.method).toBe('browser(fallback)');
    expect(r.retries).toBe(1);
  });

  it('浏览器打开抛异常时安全关闭并返回错误', async () => {
    vi.useFakeTimers();
    fetchMock.mockResolvedValueOnce(makeResponse('x', { status: 403, contentType: 'text/html' }));
    h.browserOpen.mockRejectedValueOnce(new Error('browser crash'));
    const r = await advanceUntilSettled(handleWebFetch({ url: 'https://example.com/browser-crash' }));
    expect(r.success).toBe(false);
    expect(h.browserClose).toHaveBeenCalled();
  });

  it('浏览器提取为空时不缓存并返回失败', async () => {
    vi.useFakeTimers();
    fetchMock.mockResolvedValueOnce(makeResponse('x', { status: 403, contentType: 'text/html' }));
    h.browserExtract.mockResolvedValueOnce({ success: true, text: '' });
    const r = await advanceUntilSettled(handleWebFetch({ url: 'https://example.com/browser-empty' }));
    expect(r.success).toBe(false);
  });

  it('浏览器回退结果命中缓存', async () => {
    vi.useFakeTimers();
    const url = 'https://example.com/browser-cache';
    fetchMock.mockResolvedValue(makeResponse('x', { status: 403, contentType: 'text/html' }));
    h.browserExtract.mockResolvedValueOnce({ success: true, text: 'cached browser text '.repeat(20) });
    const r1 = await advanceUntilSettled(handleWebFetch({ url }));
    expect(r1.method).toBe('browser(fallback)');
    const openCalls = h.browserOpen.mock.calls.length;
    const extractCalls = h.browserExtract.mock.calls.length;

    const r2 = await handleWebFetch({ url, max_chars: 10 });
    expect(r2.success).toBe(true);
    expect(r2.length).toBe(10);
    expect(h.browserOpen.mock.calls.length).toBe(openCalls);
    expect(h.browserExtract.mock.calls.length).toBe(extractCalls);
    expect(h.sendLog.mock.calls.some((c) => String(c[1]).includes('缓存命中'))).toBe(true);
  });

  it('HTTP_TIMEOUT setter 限制最小值且 0 表示禁用', () => {
    setHTTPTimeout(0);
    expect(getHTTPTimeout()).toBe(0);
    setHTTPTimeout(100);
    expect(getHTTPTimeout()).toBe(5000);
    setHTTPTimeout(12_345);
    expect(getHTTPTimeout()).toBe(12_345);
    setHTTPTimeout(900_000);
  });

  it('禁用超时时直接 fetch', async () => {
    setHTTPTimeout(0);
    fetchMock.mockResolvedValueOnce(makeResponse('body', { contentType: 'text/plain' }));
    const r = await handleWebFetch({ url: 'https://example.com/no-timeout' });
    expect(r.success).toBe(true);
    expect(r.content).toBe('body');
  });
});

describe('web_search SearXNG', () => {
  beforeEach(() => {
    h.settings.set('searxng_enabled', true);
    h.settings.set('searxng_url', 'https://searx.example/');
    h.settings.set('searxng_format', 'json');
    h.settings.set('fetch_count', 3);
  });

  it('未配置地址时返回错误', async () => {
    h.settings.set('searxng_url', '');
    const r = await handleWebSearch({ query: 'q' });
    expect(r.success).toBe(false);
    expect(String(r.error)).toContain('SearXNG API 地址未配置');
  });

  it('JSON 模式返回结构化结果并带引擎统计', async () => {
    fetchMock.mockImplementation(async (url: string) => {
      if (url.includes('searx.example/search')) {
        return makeJsonResponse({
          query: 'metona',
          results: [
            {
              title: '<b>Metona</b> 官网',
              url: 'https://metona.test/a',
              content: '  Metona   <i>AI</i>  ',
              engine: 'google',
            },
            { title: '第二结果', url: 'https://metona.test/b#frag', content: 'second snippet', engine: 'bing' },
          ],
          unresponsive_engines: [['duckduckgo', 'timeout']],
        });
      }
      return makeResponse('full page content '.repeat(30), { contentType: 'text/plain' });
    });
    const r = await handleWebSearch({ query: 'metona', enhance_snippets: false });
    expect(r.success).toBe(true);
    expect(r._mode).toBe('searxng');
    expect(r.total).toBe(2);
    const results = r.results as Array<{ title: string; snippet: string; engine: string; url: string }>;
    expect(results[0].title).toBe('Metona 官网');
    expect(results[0].snippet).toBe('Metona AI');
    expect(results[0].engine).toBe('searxng:google');
    expect(String(r.engine_stats && JSON.stringify(r.engine_stats))).toContain('duckduckgo');
    expect(String(r.formatted)).toContain('Metona 官网');
    const searchUrl = String((fetchMock.mock.calls[0] as unknown[])[0]);
    expect(searchUrl).toContain('format=json');
    expect(searchUrl).toContain('q=metona');
  });

  it('分页去重并在无新结果时早退', async () => {
    const page = (items: Array<{ title: string; url: string; content: string; engine: string }>) =>
      makeJsonResponse({ query: 'page', results: items });
    const mk = (i: number) => ({
      title: `R${i}`,
      url: `https://page.test/${i}`,
      content: `snippet ${i}`,
      engine: 'google',
    });
    fetchMock.mockImplementation(async (url: string) => {
      if (!url.includes('searx.example/search')) {
        return makeResponse('page body '.repeat(20), { contentType: 'text/plain' });
      }
      const pageno = new URL(url).searchParams.get('pageno') || '1';
      if (pageno === '1') return page([1, 2, 3, 4, 5].map(mk));
      if (pageno === '2') return page([mk(1), mk(6), mk(7), mk(8), mk(9)]);
      return page([mk(1), mk(2), mk(3), mk(4), mk(5)]);
    });
    const r = await handleWebSearch({ query: 'page', enhance_snippets: false, max_results: 30 });
    expect(r.success).toBe(true);
    expect(r.total).toBe(9);
    const urls = (r.results as Array<{ url: string }>).map((x) => x.url);
    expect(new Set(urls).size).toBe(9);
    const searchCalls = fetchMock.mock.calls.filter((c) => String(c[0]).includes('searx.example/search'));
    expect(searchCalls.length).toBe(3);
  });

  it('后续页失败时保留已有结果', async () => {
    const mk = (i: number) => ({ title: `R${i}`, url: `https://later.test/${i}`, content: `s${i}`, engine: 'google' });
    let pageNo = 0;
    fetchMock.mockImplementation(async (url: string) => {
      if (!url.includes('searx.example/search')) {
        return makeResponse('body '.repeat(30), { contentType: 'text/plain' });
      }
      pageNo++;
      if (pageNo === 1) {
        return makeJsonResponse({ query: 'later', results: [1, 2, 3, 4, 5].map(mk) });
      }
      return makeJsonResponse({ error: 'boom' }, 500);
    });
    const r = await handleWebSearch({ query: 'later', enhance_snippets: false });
    expect(r.success).toBe(true);
    expect(r.total).toBe(5);
    expect(h.sendLog.mock.calls.some((c) => String(c[1]).includes('翻页失败'))).toBe(true);
  });

  it('空结果显示错误', async () => {
    fetchMock.mockResolvedValue(makeJsonResponse({ query: 'empty', results: [] }));
    const r = await handleWebSearch({ query: 'empty' });
    expect(r.success).toBe(false);
    expect(String(r.error)).toContain('未返回任何结果');
  });

  it('首页 HTTP 失败返回 SearXNG 错误', async () => {
    fetchMock.mockResolvedValueOnce(makeJsonResponse({}, 502));
    const r = await handleWebSearch({ query: 'fail' });
    expect(r.success).toBe(false);
    expect(String(r.error)).toContain('HTTP 502');
    expect(String(r._searxng_url)).toContain('searx.example');
  });

  it('首页超时返回 timeout 错误', async () => {
    fetchMock.mockRejectedValueOnce(new Error('timeout'));
    const r = await handleWebSearch({ query: 'timeout' });
    expect(r.success).toBe(false);
    expect(String(r.error)).toContain('timeout');
  });

  it('HTML 模式单页返回纯文本', async () => {
    h.settings.set('searxng_format', 'html');
    fetchMock.mockResolvedValueOnce(makeResponse('<html><body><h1>结果页</h1><p>搜索内容</p></body></html>'));
    const r = await handleWebSearch({ query: 'html-mode' });
    expect(r.success).toBe(true);
    expect(r.format).toBe('html');
    expect(r.content_type).toBe('text/html');
    expect(String(r.content)).toContain('结果页');
    const url = String(fetchMock.mock.calls[0][0]);
    expect(url).not.toContain('format=json');
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('HTML 模式 HTTP 失败返回错误', async () => {
    h.settings.set('searxng_format', 'html');
    fetchMock.mockResolvedValueOnce(makeResponse('bad', { status: 500 }));
    const r = await handleWebSearch({ query: 'html-fail' });
    expect(r.success).toBe(false);
    expect(String(r.error)).toContain('HTTP 500');
  });

  it('携带认证头与搜索参数', async () => {
    h.settings.set('searxng_auth_key', 'secret');
    h.settings.set('searxng_auth_type', 'basic');
    h.settings.set('searxng_engines', 'google,bing');
    h.settings.set('searxng_language', 'en-US');
    h.settings.set('searxng_safesearch', 2);
    h.settings.set('searxng_time_range', 'month');
    fetchMock.mockImplementation(async (url: string) => {
      if (url.includes('searx.example/search')) {
        return makeJsonResponse({
          results: [{ title: 'auth result', url: 'https://auth.test/1', content: 'x', engine: 'google' }],
        });
      }
      return makeResponse('body '.repeat(20), { contentType: 'text/plain' });
    });
    const r = await handleWebSearch({ query: 'auth', enhance_snippets: false, time_range: 'week' });
    expect(r.success).toBe(true);
    const [url, init] = fetchMock.mock.calls[0] as [string, { headers: Record<string, string> }];
    const parsed = new URL(url);
    expect(parsed.searchParams.get('engines')).toBe('google,bing');
    expect(parsed.searchParams.get('language')).toBe('en-US');
    expect(parsed.searchParams.get('safesearch')).toBe('2');
    expect(parsed.searchParams.get('time_range')).toBe('week');
    expect(init.headers.Authorization).toBe('Basic ' + Buffer.from('secret').toString('base64'));
  });

  it('Bearer 认证头', async () => {
    h.settings.set('searxng_auth_key', 'token-1');
    fetchMock.mockImplementation(async (url: string) => {
      if (url.includes('searx.example/search')) {
        return makeJsonResponse({
          results: [{ title: 'bearer', url: 'https://bearer.test/1', content: 'x', engine: 'google' }],
        });
      }
      return makeResponse('body '.repeat(20), { contentType: 'text/plain' });
    });
    await handleWebSearch({ query: 'bearer', enhance_snippets: false });
    const init = fetchMock.mock.calls[0][1] as { headers: Record<string, string> };
    expect(init.headers.Authorization).toBe('Bearer token-1');
  });

  it('JSON 解析异常被捕获', async () => {
    fetchMock.mockResolvedValueOnce(makeResponse('not json', { contentType: 'application/json' }));
    const r = await handleWebSearch({ query: 'bad-json' });
    expect(r.success).toBe(false);
    expect(String(r.error)).toContain('SearXNG 搜索异常');
  });

  it('达到 max_results 后停止翻页', async () => {
    fetchMock.mockImplementation(async (url: string) => {
      if (url.includes('searx.example/search')) {
        return makeJsonResponse({
          results: [1, 2, 3, 4, 5].map((i) => ({
            title: `R${i}`,
            url: `https://early.test/${i}`,
            content: `s${i}`,
            engine: 'google',
          })),
        });
      }
      return makeResponse('body '.repeat(20), { contentType: 'text/plain' });
    });
    const r = await handleWebSearch({ query: 'early-exit', max_results: 2, enhance_snippets: false });
    expect(r.success).toBe(true);
    expect(r.total).toBe(2);
    const searchCalls = fetchMock.mock.calls.filter((c) => String(c[0]).includes('searx.example/search'));
    expect(searchCalls).toHaveLength(1);
  });

  it('HTTP_TIMEOUT=0 时 SearXNG 请求不设置超时', async () => {
    setHTTPTimeout(0);
    fetchMock.mockImplementation(async (url: string) => {
      if (url.includes('searx.example/search')) {
        return makeJsonResponse({
          results: [{ title: 'no timeout', url: 'https://notimeout.test/1', content: 'x', engine: 'google' }],
        });
      }
      return makeResponse('body '.repeat(20), { contentType: 'text/plain' });
    });
    const r = await handleWebSearch({ query: 'no-timeout-search', enhance_snippets: false });
    expect(r.success).toBe(true);
    setHTTPTimeout(900_000);
  });

  it('设置读取异常被外层 catch 捕获', async () => {
    h.getSetting.mockImplementationOnce(() => {
      throw new Error('db down');
    });
    const r = await handleWebSearch({ query: 'db-down' });
    expect(r.success).toBe(false);
    expect(r.error).toBe('db down');
  });

  it('随机抓取模式按 fetch_count 抓取结果', async () => {
    h.settings.set('fetch_mode', 'random');
    h.settings.set('fetch_count', 3);
    fetchMock.mockImplementation(async (url: string) => {
      if (url.includes('searx.example/search')) {
        return makeJsonResponse({
          results: [1, 2, 3, 4].map((i) => ({
            title: `随机结果 ${i}`,
            url: `https://random.test/${i}`,
            content: `snippet ${i}`,
            engine: 'google',
          })),
        });
      }
      return makeResponse('random page body '.repeat(20), { contentType: 'text/plain' });
    });
    const r = await handleWebSearch({ query: '随机', enhance_snippets: false, fetch_top: 3 });
    expect(r.success).toBe(true);
    expect(r._fetched_count).toBe(3);
  });
});

describe('web_search 内置引擎', () => {
  const engineHtml: Record<string, string> = {
    bing: `<li class="b_algo"><h2><a href="https://bing-result.test/1">Bing 结果</a></h2><p>Bing 摘要内容</p></li>`,
    baidu: `<div class="result"><h3 class="t"><a href="https://baidu-result.test/1">百度结果</a></h3><div class="c-abstract">百度摘要内容</div></div>`,
    sogou: `<div class="vrwrap"><h3><a href="https://sogou-result.test/1">搜狗结果</a></h3><p class="star-wiki">搜狗摘要内容</p></div><div id="pagebar"></div>`,
    so360: `<ul><li class="res-list"><h3><a href="https://so-result.test/1">360结果</a></h3><p class="res-desc">360摘要内容</p></li></ul>`,
  };

  function routeEngines(overrides: Partial<Record<keyof typeof engineHtml, string>> = {}) {
    const map: Record<string, string> = { ...engineHtml, ...overrides };
    fetchMock.mockImplementation(async (url: string, init?: { headers?: Record<string, string> }) => {
      if (url.includes('bing.com')) return makeResponse(map.bing);
      if (url.includes('baidu.com')) return makeResponse(map.baidu);
      if (url.includes('sogou.com')) return makeResponse(map.sogou);
      if (url.includes('so.com')) return makeResponse(map.so360);
      if (init?.headers?.Range) return makeResponse('', { contentType: 'text/html' });
      return makeResponse('full page body '.repeat(40), { contentType: 'text/plain' });
    });
  }

  it('四引擎并行解析、合并去重并返回统计', async () => {
    routeEngines();
    const r = await handleWebSearch({ query: '结果', enhance_snippets: false });
    expect(r.success).toBe(true);
    expect(r._mode).toBe('builtin');
    expect(r.total).toBe(4);
    const results = r.results as Array<{ engine: string; url: string; reachable: boolean }>;
    expect(new Set(results.map((x) => x.engine))).toEqual(new Set(['bing', 'baidu', 'sogou', '360搜索']));
    expect(results.every((x) => x.reachable === true)).toBe(true);
    expect(Object.keys(r.engine_stats as Record<string, string>).sort()).toEqual(
      ['360搜索', 'baidu', 'bing', 'sogou'].sort(),
    );
  });

  it('空查询直接报错', async () => {
    const r = await handleWebSearch({ query: '   ' });
    expect(r.success).toBe(false);
    expect(String(r.error)).toContain('不能为空');
  });

  it('所有引擎失败返回错误', async () => {
    fetchMock.mockRejectedValue(new Error('offline'));
    const r = await handleWebSearch({ query: 'offline', enhance_snippets: false });
    expect(r.success).toBe(false);
    expect(String(r.error)).toContain('所有搜索引擎均未返回结果');
  });

  it('单引擎失败时其他引擎结果仍可用', async () => {
    routeEngines({ baidu: '', sogou: '', so360: '' });
    fetchMock.mockImplementation(async (url: string, init?: { headers?: Record<string, string> }) => {
      if (url.includes('bing.com')) return makeResponse(engineHtml.bing);
      if (url.includes('baidu.com')) throw new Error('百度挂了');
      if (url.includes('sogou.com')) return makeResponse('');
      if (url.includes('so.com')) return makeResponse('');
      if (init?.headers?.Range) return makeResponse('');
      return makeResponse('body '.repeat(30), { contentType: 'text/plain' });
    });
    const r = await handleWebSearch({ query: '单引擎结果', enhance_snippets: false });
    expect(r.success).toBe(true);
    expect(r.total).toBe(1);
    expect(String((r.engine_stats as Record<string, string>).baidu)).toContain('失败');
  });

  it('缓存命中第二次不再请求引擎', async () => {
    routeEngines();
    const q = 'cache-query-unique';
    const r1 = await handleWebSearch({ query: q, enhance_snippets: false });
    expect(r1.success).toBe(true);
    expect(r1.from_cache).toBe(false);
    const engineCalls = fetchMock.mock.calls.filter((c) =>
      /bing\.com|baidu\.com|sogou\.com|so\.com/.test(String(c[0])),
    ).length;
    const r2 = await handleWebSearch({ query: q, enhance_snippets: false });
    expect(r2.success).toBe(true);
    expect(r2.from_cache).toBe(true);
    expect(String(r2.formatted)).toContain('[缓存]');
    const engineCalls2 = fetchMock.mock.calls.filter((c) =>
      /bing\.com|baidu\.com|sogou\.com|so\.com/.test(String(c[0])),
    ).length;
    expect(engineCalls2).toBe(engineCalls);
  });

  it.each([
    ['week', 'Week'],
    ['day', 'Day'],
    ['month', 'Month'],
    ['1d', 'Day'],
    ['一周', 'Week'],
    ['一月', 'Month'],
  ])('时间范围 %s 映射到 Bing freshness=%s', async (range, expected) => {
    routeEngines({ baidu: '', sogou: '', so360: '' });
    await handleWebSearch({ query: `time-${range}`, time_range: range, enhance_snippets: false });
    const bingUrl = String(fetchMock.mock.calls.find((c) => String(c[0]).includes('bing.com'))?.[0]);
    expect(bingUrl).toContain(`freshness=${expected}`);
  });

  it('可达性预检影响排序与标记', async () => {
    fetchMock.mockImplementation(async (url: string, init?: { headers?: Record<string, string> }) => {
      if (url.includes('bing.com')) {
        return makeResponse(`<li class="b_algo"><a href="https://reachable.test/a">reachable</a><p>short</p></li>`);
      }
      if (url.includes('baidu.com')) {
        return makeResponse(
          `<div class="result"><h3 class="t"><a href="https://dead.test/b">dead</a></h3><div class="c-abstract">${'长摘要'.repeat(30)}</div></div>`,
        );
      }
      if (url.includes('sogou.com') || url.includes('so.com')) return makeResponse('');
      if (init?.headers?.Range) {
        if (url.includes('dead.test')) throw new Error('unreachable');
        return makeResponse('');
      }
      if (url.includes('dead.test')) throw new Error('unreachable');
      return makeResponse('page '.repeat(30), { contentType: 'text/plain' });
    });
    const r = await handleWebSearch({ query: 'reachable', enhance_snippets: false });
    expect(r.success).toBe(true);
    const results = r.results as Array<{ url: string; reachable: boolean; _score: number }>;
    expect(results[0].url).toContain('reachable.test');
    expect(results[0].reachable).toBe(true);
    expect(results.some((x) => x.url.includes('dead.test') && x.reachable === false)).toBe(true);
    expect(results[0]._score).toBeGreaterThan(results.find((x) => x.url.includes('dead.test'))!._score);
  });

  it('摘要过短时自动用 web_fetch 增强', async () => {
    fetchMock.mockImplementation(async (url: string, init?: { headers?: Record<string, string> }) => {
      if (url.includes('bing.com')) {
        return makeResponse(`<li class="b_algo"><a href="https://enhance.test/a">enhance</a><p>x</p></li>`);
      }
      if (url.includes('baidu.com') || url.includes('sogou.com') || url.includes('so.com')) return makeResponse('');
      if (init?.headers?.Range) return makeResponse('');
      return makeResponse('增强后的完整摘要内容 '.repeat(20), { contentType: 'text/plain' });
    });
    const r = await handleWebSearch({ query: 'enhance' });
    expect(r.success).toBe(true);
    const results = r.results as Array<{ snippet: string; _enhanced?: boolean }>;
    expect(results[0].snippet.length).toBeGreaterThan(30);
    expect(results[0]._enhanced).toBe(true);
    expect((r.structured as Array<{ enhanced_snippet?: boolean }>)[0].enhanced_snippet).toBe(true);
    expect(h.sendLog.mock.calls.some((c) => String(c[1]).includes('摘要增强完成'))).toBe(true);
  });

  it('自动抓取前 N 条完整内容', async () => {
    routeEngines({ baidu: '', sogou: '', so360: '' });
    const r = await handleWebSearch({ query: '结果', enhance_snippets: false, fetch_top: 3 });
    expect(r.success).toBe(true);
    expect(r._fetched_count).toBeGreaterThanOrEqual(1);
    const fetched = r._fetched as Array<{ url: string; content: string }>;
    expect(fetched[0].content).toContain('full page body');
  });

  it('抓取失败后随机补抓其他结果', async () => {
    fetchMock.mockImplementation(async (url: string, init?: { headers?: Record<string, string> }) => {
      if (url.includes('bing.com')) {
        return makeResponse(
          `<li class="b_algo"><a href="https://first-fail.test/1">fail first</a><p>first snippet</p></li>
           <li class="b_algo"><a href="https://second-ok.test/2">ok second</a><p>second snippet</p></li>`,
        );
      }
      if (url.includes('baidu.com') || url.includes('sogou.com') || url.includes('so.com')) return makeResponse('');
      if (url.includes('first-fail.test')) {
        if (init?.headers?.Range) return makeResponse('');
        throw new Error('fetch failed');
      }
      if (init?.headers?.Range) return makeResponse('');
      return makeResponse('second page content '.repeat(20), { contentType: 'text/plain' });
    });
    h.browserOpen.mockResolvedValue({ success: false });
    const r = await handleWebSearch({ query: 'fail', enhance_snippets: false, fetch_top: 3 });
    expect(r.success).toBe(true);
    expect(r._fetched_count).toBe(1);
    const fetched = r._fetched as Array<{ url: string }>;
    expect(fetched[0].url).toContain('second-ok.test');
    expect(h.sendLog.mock.calls.some((c) => String(c[1]).includes('随机重试'))).toBe(true);
  });

  it('相关性过滤会跳过无关结果', async () => {
    fetchMock.mockImplementation(async (url: string, init?: { headers?: Record<string, string> }) => {
      if (url.includes('bing.com')) {
        return makeResponse(
          `<li class="b_algo"><a href="https://unrelated.test/1">完全无关标题</a><p>nothing here</p></li>
           <li class="b_algo"><a href="https://metona.test/2">Metona 官网</a><p>metona snippet</p></li>`,
        );
      }
      if (url.includes('baidu.com') || url.includes('sogou.com') || url.includes('so.com')) return makeResponse('');
      if (init?.headers?.Range) return makeResponse('');
      return makeResponse('page body '.repeat(20), { contentType: 'text/plain' });
    });
    const r = await handleWebSearch({ query: 'metona', enhance_snippets: false, fetch_top: 3 });
    expect(r.success).toBe(true);
    expect(h.sendLog.mock.calls.some((c) => String(c[1]).includes('无关结果已跳过'))).toBe(true);
  });
});

describe('内置搜索引擎 HTML 解析边界', () => {
  function onlyEngine(name: 'bing' | 'baidu' | 'sogou' | '360', html: string, maxResults = 30, query = 'test') {
    fetchMock.mockImplementation(async (url: string, init?: { headers?: Record<string, string> }) => {
      if (name === 'bing' && url.includes('bing.com')) return makeResponse(html);
      if (name === 'baidu' && url.includes('baidu.com')) return makeResponse(html);
      if (name === 'sogou' && url.includes('sogou.com')) return makeResponse(html);
      if (name === '360' && url.includes('so.com')) return makeResponse(html);
      if (/bing\.com|baidu\.com|sogou\.com|so\.com/.test(url)) return makeResponse('');
      if (init?.headers?.Range) return makeResponse('');
      return makeResponse('body '.repeat(30), { contentType: 'text/plain' });
    });
    // 短页面会触发浏览器升级，这里直接让浏览器不可用，避免真实等待渲染
    h.browserOpen.mockResolvedValue({ success: false });
    return handleWebSearch({ query, enhance_snippets: false, max_results: maxResults });
  }

  it('Bing 跳过无链接/非 http/空标题并解码实体', async () => {
    const html = `
      <li class="b_algo"><h2>没有链接</h2></li>
      <li class="b_algo"><a href="/relative">相对链接</a></li>
      <li class="b_algo"><a href="https://ok.test/1">   </a><p>empty title</p></li>
      <li class="b_algo"><a href="https://ok.test/2">A &amp; B</a><p>snip &lt;tag&gt;</p></li>`;
    const r = await onlyEngine('bing', html, 30, 'bing-boundary');
    expect(r.success).toBe(true);
    const results = r.results as Array<{ title: string; url: string; snippet: string }>;
    expect(results).toHaveLength(1);
    expect(results[0].title).toBe('A & B');
    expect(results[0].snippet).toBe('snip');
  });

  it('Bing maxResults 限制结果数', async () => {
    const html = Array.from(
      { length: 5 },
      (_, i) => `<li class="b_algo"><a href="https://limit.test/${i}">T${i}</a><p>S${i}</p></li>`,
    ).join('');
    const r = await onlyEngine('bing', html, 2, 'bing-limit');
    expect(r.success).toBe(true);
    expect((r.results as unknown[]).length).toBe(2);
  });

  it('百度使用 data-url 回退与相对链接拼接', async () => {
    const html = `
      <div class="result"><h3 class="t"><a href="/link?url=abc">相对结果</a></h3><div class="c-abstract">摘要一</div></div>
      <div class="result"><h3 class="t"><a href="/link?url=def" data-url="https://real.test/2">真实结果</a></h3><span class="content-right_x">摘要二</span></div>
      <div class="result"><h3 class="t">无链接</h3></div>`;
    const r = await onlyEngine('baidu', html, 30, 'baidu-boundary');
    expect(r.success).toBe(true);
    const results = r.results as Array<{ url: string; title: string; snippet: string }>;
    expect(results).toHaveLength(2);
    expect(results[0].url).toBe('https://www.baidu.com/link?url=abc');
    expect(results[1].url).toBe('https://real.test/2');
    expect(results[1].snippet).toBe('摘要二');
  });

  it('搜狗跳过自身链接并解析多种摘要容器', async () => {
    const html = `
      <div class="vrwrap"><a href="https://www.sogou.com/self">自身</a><p class="star-wiki">忽略</p></div>
      <div class="vrwrap"><a href="https://sogou-ok.test/1">外部一</a><p class="star-wiki">摘要一</p></div>
      <div class="rb"><a href="https://sogou-ok.test/2">外部二</a><div class="space-txt">摘要二</div></div>
      <div class="rb"><a href="https://sogou-ok.test/3">外部三</a><p class="str_info">摘要三</p></div>
      <div class="rb"><a href="https://sogou-ok.test/4">无摘要</a></div>
      <div id="pagebar"></div>`;
    const r = await onlyEngine('sogou', html, 30, 'sogou-boundary');
    expect(r.success).toBe(true);
    const results = r.results as Array<{ url: string; snippet: string }>;
    expect(results).toHaveLength(4);
    expect(results.map((x) => x.url)).not.toContain('https://www.sogou.com/self');
    expect(results[0].snippet).toBe('摘要一');
    expect(results[1].snippet).toBe('摘要二');
    expect(results[2].snippet).toBe('摘要三');
    expect(results[3].snippet).toBe('');
  });

  it('360 跳过自身链接但保留 link 跳转并解析 dd 摘要', async () => {
    const html = `<ul>
      <li class="res-list"><a href="https://www.so.com/self">自身</a><p class="res-desc">忽略</p></li>
      <li class="res-list"><a href="https://www.so.com/link?url=x">跳转</a><dd>dd 摘要</dd></li>
      <li class="res-list"><a href="https://so-ok.test/2">外部</a><p class="res-summary">summary 摘要</p></li>
      <li class="res-list"><a href="https://so-ok.test/3">外部3</a><div class="res-rich">rich 摘要</div></li>
    </ul>`;
    const r = await onlyEngine('360', html, 30, '360-boundary');
    expect(r.success).toBe(true);
    const results = r.results as Array<{ url: string; snippet: string }>;
    expect(results).toHaveLength(3);
    const byUrl = new Map(results.map((x) => [x.url, x.snippet]));
    expect(byUrl.get('https://www.so.com/link?url=x')).toBe('dd 摘要');
    expect(byUrl.get('https://so-ok.test/2')).toBe('summary 摘要');
    expect(byUrl.get('https://so-ok.test/3')).toBe('rich 摘要');
  });
});
