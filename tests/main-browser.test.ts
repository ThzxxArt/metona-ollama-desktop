import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

type AnyFn = (...args: any[]) => any;

const hoisted = vi.hoisted(() => {
  const instances: any[] = [];
  const classes: Record<string, any> = {};
  const mainWindow = { webContents: { send: vi.fn() } };
  const checkUrl = vi.fn(async (_url: string) => ({ ok: true }));
  const fromPartition = vi.fn(() => ({
    clearCache: vi.fn(async () => undefined),
    clearStorageData: vi.fn(async () => undefined),
  }));
  return { instances, classes, mainWindow, checkUrl, fromPartition };
});

vi.mock('electron', () => {
  class FakeBrowserWindow {
    static instances = hoisted.instances;
    static getAllWindows = vi.fn(() => hoisted.instances.filter((w) => !w.destroyed));

    options: any;
    destroyed = false;
    handlers = new Map<string, AnyFn[]>();
    onceHandlers = new Map<string, AnyFn>();
    webContents: any;
    loadURL: AnyFn;
    close = vi.fn(() => {
      this.destroyed = true;
      this.emit('closed');
    });
    isDestroyed = vi.fn(() => this.destroyed);

    constructor(options: any) {
      this.options = options;
      this.webContents = {
        setUserAgent: vi.fn(),
        getURL: vi.fn(() => 'about:blank'),
        getTitle: vi.fn(() => 'Page Title'),
        executeJavaScript: vi.fn(async () => true),
        capturePage: vi.fn(async () => ({
          toPNG: () => Buffer.from('png'),
          getSize: () => ({ width: 640, height: 480 }),
        })),
        once: vi.fn((event: string, cb: AnyFn) => {
          this.onceHandlers.set(event, cb);
        }),
        removeListener: vi.fn((event: string, cb: AnyFn) => {
          if (this.onceHandlers.get(event) === cb) this.onceHandlers.delete(event);
        }),
        send: vi.fn(),
      };
      this.loadURL = vi.fn(async (url: string) => {
        this.webContents.getURL.mockReturnValue(url);
        const cb = this.onceHandlers.get('did-finish-load');
        if (cb) {
          this.onceHandlers.delete('did-finish-load');
          cb();
        }
      });
      hoisted.instances.push(this);
    }

    on(event: string, cb: AnyFn) {
      const list = this.handlers.get(event) || [];
      list.push(cb);
      this.handlers.set(event, list);
      return this;
    }

    emit(event: string, ...args: any[]) {
      for (const cb of this.handlers.get(event) || []) cb(...args);
    }
  }

  hoisted.classes.BrowserWindow = FakeBrowserWindow;
  return {
    BrowserWindow: FakeBrowserWindow,
    session: { fromPartition: hoisted.fromPartition },
  };
});

vi.mock('../src/main/window-state.js', () => ({ mainWindow: hoisted.mainWindow }));
vi.mock('../src/main/net-guard.js', () => ({ checkPublicHttpUrl: hoisted.checkUrl }));

let browser: any;

async function loadBrowser(): Promise<any> {
  vi.resetModules();
  return import('../src/main/browser.js');
}

function image(buffer = Buffer.from('png'), size = { width: 640, height: 480 }) {
  return { toPNG: () => buffer, getSize: () => size };
}

async function flushMicrotasks(times = 10): Promise<void> {
  for (let i = 0; i < times; i++) await Promise.resolve();
}

async function openReady(url = 'https://example.com'): Promise<any> {
  const result = await browser.browserOpen(url);
  expect(result.success).toBe(true);
  return hoisted.instances[hoisted.instances.length - 1];
}

beforeEach(async () => {
  vi.useFakeTimers();
  hoisted.instances.length = 0;
  hoisted.mainWindow.webContents.send.mockClear();
  hoisted.checkUrl.mockReset();
  hoisted.checkUrl.mockResolvedValue({ ok: true });
  hoisted.fromPartition.mockClear();
  browser = await loadBrowser();
});

afterEach(() => {
  vi.useRealTimers();
});

describe('browser: open', () => {
  it('拒绝非 http/https 协议且不创建窗口', async () => {
    const result = await browser.browserOpen('file:///etc/passwd');
    expect(result).toMatchObject({ success: false });
    expect(result.error).toContain('仅支持 http/https');
    expect(hoisted.checkUrl).not.toHaveBeenCalled();
    expect(hoisted.instances).toHaveLength(0);
  });

  it('SSRF 拦截时记录日志并返回错误', async () => {
    hoisted.checkUrl.mockResolvedValueOnce({ ok: false, reason: '禁止访问内网/环回地址' });
    const result = await browser.browserOpen('http://127.0.0.1:11434');
    expect(result).toEqual({ success: false, error: '安全拦截: 禁止访问内网/环回地址' });
    expect(hoisted.mainWindow.webContents.send).toHaveBeenCalledWith(
      'main:log',
      expect.objectContaining({ level: 'warn' }),
    );
    expect(hoisted.instances).toHaveLength(0);
  });

  it('成功加载页面并创建隐藏窗口与独立 session', async () => {
    const result = await browser.browserOpen('https://example.com');
    expect(result).toEqual({
      success: true,
      title: 'Page Title',
      url: 'https://example.com',
      waited: false,
    });
    const win = hoisted.instances[0];
    expect(win.options).toMatchObject({
      width: 1280,
      height: 800,
      show: false,
      webPreferences: {
        nodeIntegration: false,
        contextIsolation: true,
        sandbox: true,
        webSecurity: true,
        partition: 'memory:agent',
      },
    });
    expect(win.webContents.setUserAgent).toHaveBeenCalledWith(expect.stringContaining('Chrome/130'));
    expect(win.loadURL).toHaveBeenCalledWith('https://example.com');
  });

  it('加载失败返回错误并记录日志', async () => {
    hoisted.checkUrl.mockResolvedValue({ ok: true });
    // 先创建窗口，再让下一次加载失败
    const first = await openReady('https://example.com');
    first.webContents.getURL.mockReturnValue('about:blank');
    first.loadURL.mockRejectedValueOnce(new Error('net error'));
    const result = await browser.browserOpen('https://bad.example');
    expect(result).toEqual({ success: false, error: 'net error' });
    expect(hoisted.mainWindow.webContents.send).toHaveBeenCalledWith(
      'main:log',
      expect.objectContaining({ level: 'error' }),
    );
  });

  it('加载超时返回错误', async () => {
    hoisted.checkUrl.mockResolvedValue({ ok: true });
    const win = await openReady('https://slow.example');
    win.loadURL.mockImplementationOnce(() => new Promise(() => {}));
    const pending = browser.browserOpen('https://slow.example');
    await flushMicrotasks();
    await vi.advanceTimersByTimeAsync(30_000);
    const result = await pending;
    expect(result).toMatchObject({ success: false });
    expect(result.error).toContain('页面加载超时');
  });

  it('切换到不同 URL 时关闭旧窗口，相同 URL 复用', async () => {
    const first = await openReady('https://example.com/a');
    await browser.browserOpen('https://example.com/a');
    expect(hoisted.instances).toHaveLength(1);

    await browser.browserOpen('https://example.com/b');
    expect(first.close).toHaveBeenCalled();
    expect(hoisted.instances).toHaveLength(2);
    expect(hoisted.mainWindow.webContents.send).toHaveBeenCalledWith(
      'main:log',
      expect.objectContaining({ message: '🌐 browser 切换页面' }),
    );
  });

  it('waitSelector 成功时 waited=true', async () => {
    hoisted.checkUrl.mockResolvedValue({ ok: true });
    const win = await openReady('https://example.com');
    win.webContents.executeJavaScript.mockResolvedValue(true);
    const result = await browser.browserOpen('https://example.com', '#app');
    expect(result.waited).toBe(true);
    expect(hoisted.mainWindow.webContents.send).toHaveBeenCalledWith(
      'main:log',
      expect.objectContaining({ message: '🌐 browser 等待元素' }),
    );
  });

  it('waitSelector 超时时 waited=false 并告警', async () => {
    hoisted.checkUrl.mockResolvedValue({ ok: true });
    const win = await openReady('https://example.com');
    win.webContents.executeJavaScript.mockResolvedValue(false);
    const pending = browser.browserOpen('https://example.com', '#never');
    await flushMicrotasks();
    await vi.advanceTimersByTimeAsync(10_500);
    const result = await pending;
    expect(result.waited).toBe(false);
    expect(hoisted.mainWindow.webContents.send).toHaveBeenCalledWith(
      'main:log',
      expect.objectContaining({ message: '🌐 browser 等待超时' }),
    );
  });
});

describe('browser: screenshot', () => {
  it('未打开或未加载页面时返回错误', async () => {
    expect(await browser.browserScreenshot()).toMatchObject({ success: false });
    expect((await browser.browserScreenshot()).error).toContain('浏览器未打开');

    const win = await openReady('https://example.com');
    win.webContents.getURL.mockReturnValue('about:blank');
    const result = await browser.browserScreenshot();
    expect(result.success).toBe(false);
    expect(result.error).toContain('未加载任何页面');
  });

  it('元素截图成功并四舍五入区域', async () => {
    const win = await openReady();
    win.webContents.executeJavaScript.mockResolvedValue({ x: 1.4, y: 2.6, width: 10.4, height: 20.6 });
    const buffer = Buffer.from('element-png');
    win.webContents.capturePage.mockResolvedValue(image(buffer));

    const result = await browser.browserScreenshot({ selector: '#el' });
    expect(win.webContents.capturePage).toHaveBeenCalledWith({ x: 1, y: 3, width: 10, height: 21 });
    expect(result).toEqual({
      success: true,
      png: buffer.toString('base64'),
      width: 10,
      height: 21,
    });
  });

  it('元素不存在或不可见时返回错误', async () => {
    const win = await openReady();
    win.webContents.executeJavaScript.mockResolvedValueOnce(null);
    expect(await browser.browserScreenshot({ selector: '#missing' })).toMatchObject({
      success: false,
      error: expect.stringContaining('未找到元素'),
    });

    win.webContents.executeJavaScript.mockResolvedValueOnce({ x: 0, y: 0, width: 0, height: 10 });
    expect(await browser.browserScreenshot({ selector: '#zero' })).toMatchObject({ success: false });
  });

  it('全页截图使用页面尺寸', async () => {
    const win = await openReady();
    win.webContents.executeJavaScript.mockResolvedValue({ width: 1200, height: 2400 });
    win.webContents.capturePage.mockResolvedValue(image(Buffer.from('full'), { width: 1200, height: 2400 }));

    const result = await browser.browserScreenshot({ full_page: true });
    expect(win.webContents.capturePage).toHaveBeenCalledWith({ x: 0, y: 0, width: 1200, height: 2400 });
    expect(result).toMatchObject({ success: true, width: 1200, height: 2400 });
  });

  it('默认视口截图', async () => {
    const win = await openReady();
    win.webContents.capturePage.mockResolvedValue(image(Buffer.from('viewport'), { width: 800, height: 600 }));
    const result = await browser.browserScreenshot();
    expect(win.webContents.capturePage).toHaveBeenCalledWith();
    expect(result).toMatchObject({ success: true, width: 800, height: 600 });
  });

  it('截图异常时返回错误', async () => {
    const win = await openReady();
    win.webContents.capturePage.mockRejectedValueOnce(new Error('capture failed'));
    const result = await browser.browserScreenshot();
    expect(result).toEqual({ success: false, error: 'capture failed' });
    expect(hoisted.mainWindow.webContents.send).toHaveBeenCalledWith(
      'main:log',
      expect.objectContaining({ level: 'error' }),
    );
  });
});

describe('browser: evaluate / extract', () => {
  it('evaluate 返回字符串或 JSON 字符串', async () => {
    const win = await openReady();
    win.webContents.executeJavaScript.mockResolvedValueOnce('hello');
    await expect(browser.browserEvaluate('1+1')).resolves.toEqual({ success: true, result: 'hello' });

    win.webContents.executeJavaScript.mockResolvedValueOnce({ a: 1 });
    const result = await browser.browserEvaluate('({a:1})');
    expect(result.success).toBe(true);
    expect(JSON.parse(result.result!)).toEqual({ a: 1 });
  });

  it('evaluate 未就绪与执行失败', async () => {
    expect(await browser.browserEvaluate('1')).toMatchObject({ success: false });
    const win = await openReady();
    win.webContents.executeJavaScript.mockRejectedValueOnce(new Error('js error'));
    expect(await browser.browserEvaluate('throw')).toEqual({ success: false, error: 'js error' });
  });

  it('extract 全文与选择器模式', async () => {
    const win = await openReady();
    win.webContents.executeJavaScript.mockResolvedValue({
      title: 'T',
      text: 'body text',
      links: [{ text: 'a', href: 'https://a' }],
    });
    const full = await browser.browserExtract({ max_chars: 100 });
    expect(full).toEqual({
      success: true,
      title: 'T',
      text: 'body text',
      links: [{ text: 'a', href: 'https://a' }],
    });
    const js = win.webContents.executeJavaScript.mock.calls[0][0] as string;
    expect(js).toContain('const maxC = 100');
    expect(js).not.toContain('querySelector("#main")');

    win.webContents.executeJavaScript.mockResolvedValueOnce({ title: 'S', text: 'sel', links: [] });
    const selected = await browser.browserExtract({ selector: '#main' });
    expect(selected).toMatchObject({ success: true, text: 'sel' });
    const selJs = win.webContents.executeJavaScript.mock.calls[1][0] as string;
    expect(selJs).toContain('querySelector("#main")');
  });

  it('extract 未就绪与执行失败', async () => {
    expect(await browser.browserExtract()).toMatchObject({ success: false });
    const win = await openReady();
    win.webContents.executeJavaScript.mockRejectedValueOnce(new Error('extract error'));
    expect(await browser.browserExtract()).toEqual({ success: false, error: 'extract error' });
  });
});

describe('browser: click / type / scroll / wait', () => {
  it('click 未就绪、等待超时、成功与执行失败', async () => {
    expect(await browser.browserClick('#a')).toMatchObject({ success: false });

    const win = await openReady();
    win.webContents.executeJavaScript.mockResolvedValue(false);
    const waitPromise = browser.browserClick('#a', true);
    await flushMicrotasks();
    await vi.advanceTimersByTimeAsync(10_500);
    expect(await waitPromise).toMatchObject({ success: false, error: expect.stringContaining('等待超时') });

    win.webContents.executeJavaScript.mockResolvedValue(undefined);
    const clickPromise = browser.browserClick('#a');
    await vi.advanceTimersByTimeAsync(500);
    await expect(clickPromise).resolves.toEqual({ success: true });

    win.webContents.executeJavaScript.mockRejectedValueOnce(new Error('click error'));
    expect(await browser.browserClick('#a')).toEqual({ success: false, error: 'click error' });
  });

  it('type 支持覆盖/追加与提交，并处理失败', async () => {
    const win = await openReady();

    const clearPromise = browser.browserType('#i', 'hello', true, false);
    await vi.advanceTimersByTimeAsync(300);
    await expect(clearPromise).resolves.toEqual({ success: true });
    const clearJs = win.webContents.executeJavaScript.mock.calls[0][0] as string;
    expect(clearJs).toContain('el.value = val;');
    expect(clearJs).not.toContain('form.dispatchEvent');

    const appendPromise = browser.browserType('#i', ' world', false, true);
    await vi.advanceTimersByTimeAsync(1000);
    await expect(appendPromise).resolves.toEqual({ success: true });
    const appendJs = win.webContents.executeJavaScript.mock.calls[1][0] as string;
    expect(appendJs).toContain('el.value += val;');
    expect(appendJs).toContain('form.dispatchEvent');

    win.webContents.executeJavaScript.mockRejectedValueOnce(new Error('type error'));
    expect(await browser.browserType('#i', 'x')).toEqual({ success: false, error: 'type error' });
  });

  it('scroll 支持元素与四个方向，未就绪/元素缺失/异常', async () => {
    expect(await browser.browserScroll()).toMatchObject({ success: false });

    const win = await openReady();
    win.webContents.executeJavaScript.mockResolvedValueOnce(false);
    expect(await browser.browserScroll({ selector: '#missing' })).toMatchObject({
      success: false,
      error: '未找到元素: #missing',
    });

    win.webContents.executeJavaScript.mockResolvedValueOnce(true);
    const elementPromise = browser.browserScroll({ selector: '#el' });
    await vi.advanceTimersByTimeAsync(500);
    await expect(elementPromise).resolves.toEqual({ success: true });

    for (const direction of ['down', 'up', 'top', 'bottom']) {
      const p = browser.browserScroll({ direction });
      await vi.advanceTimersByTimeAsync(300);
      await expect(p).resolves.toEqual({ success: true });
    }
    const calls = win.webContents.executeJavaScript.mock.calls.map((c: any[]) => c[0]);
    expect(calls).toContain('window.scrollBy(0, 500)');
    expect(calls).toContain('window.scrollBy(0, -500)');
    expect(calls).toContain('window.scrollTo(0, 0)');
    expect(calls).toContain('window.scrollTo(0, document.body.scrollHeight)');

    win.webContents.executeJavaScript.mockRejectedValueOnce(new Error('scroll error'));
    expect(await browser.browserScroll()).toEqual({ success: false, error: 'scroll error' });
  });

  it('wait 支持选择器、指定时长与默认时长', async () => {
    expect(await browser.browserWait({})).toMatchObject({ success: false });

    const win = await openReady();
    win.webContents.executeJavaScript.mockResolvedValueOnce(true);
    await expect(browser.browserWait({ selector: '#a', time_ms: 100 })).resolves.toEqual({
      success: true,
      found: true,
    });

    win.webContents.executeJavaScript.mockResolvedValueOnce(false);
    const notFound = browser.browserWait({ selector: '#b', time_ms: 300 });
    await vi.advanceTimersByTimeAsync(300);
    await expect(notFound).resolves.toEqual({ success: true, found: false });

    const timed = browser.browserWait({ time_ms: 50 });
    await vi.advanceTimersByTimeAsync(50);
    await expect(timed).resolves.toEqual({ success: true });

    const fallback = browser.browserWait({});
    await vi.advanceTimersByTimeAsync(1000);
    await expect(fallback).resolves.toEqual({ success: true });
  });
});

describe('browser: close / state', () => {
  it('isBrowserOpen 反映窗口状态', async () => {
    expect(browser.isBrowserOpen()).toBe(false);
    const win = await openReady();
    expect(browser.isBrowserOpen()).toBe(true);
    await browser.browserClose();
    expect(browser.isBrowserOpen()).toBe(false);
    expect(win.close).toHaveBeenCalled();
  });

  it('关闭时清理 agent session，清理失败不阻塞', async () => {
    const win = await openReady();
    const agentSession = {
      clearCache: vi.fn(async () => undefined),
      clearStorageData: vi.fn(async () => undefined),
    };
    hoisted.fromPartition.mockReturnValueOnce(agentSession);
    await browser.browserClose();
    expect(hoisted.fromPartition).toHaveBeenCalledWith('memory:agent');
    expect(agentSession.clearCache).toHaveBeenCalled();
    expect(agentSession.clearStorageData).toHaveBeenCalledWith({
      storages: ['cookies', 'localstorage', 'indexdb', 'shadercache', 'serviceworkers', 'cachestorage'],
    });
    expect(win.close).toHaveBeenCalled();
    expect(hoisted.mainWindow.webContents.send).toHaveBeenCalledWith(
      'main:log',
      expect.objectContaining({ message: '🌐 browser 已关闭，session 已清理' }),
    );
  });

  it('session 清理抛错时仍完成关闭', async () => {
    await openReady();
    hoisted.fromPartition.mockReturnValueOnce({
      clearCache: vi.fn(async () => {
        throw new Error('cache');
      }),
      clearStorageData: vi.fn(async () => undefined),
    });
    await expect(browser.browserClose()).resolves.toBeUndefined();
    expect(browser.isBrowserOpen()).toBe(false);
  });

  it('未打开时 close 安全返回', async () => {
    await expect(browser.browserClose()).resolves.toBeUndefined();
    expect(browser.isBrowserOpen()).toBe(false);
  });

  it('窗口已销毁时重新创建', async () => {
    const first = await openReady('https://example.com/a');
    first.destroyed = true;
    await browser.browserOpen('https://example.com/b');
    expect(hoisted.instances).toHaveLength(2);
  });
});
