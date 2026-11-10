/**
 * Browser - Agent 浏览器控制 (v5.1 增强版)
 * 通过隐藏 BrowserWindow 实现网页加载、截图、JS 执行
 */

import { BrowserWindow, session } from 'electron';
import { mainWindow } from './main.js';
import { checkPublicHttpUrl } from './net-guard.js';

function sendLog(level: 'info' | 'success' | 'warn' | 'error', message: string, detail?: string): void {
  mainWindow?.webContents.send('main:log', { level, message, detail });
}

let agentBrowser: BrowserWindow | null = null;

/**
 * Agent 浏览器使用的独立 session partition。
 * `memory:` 前缀 = 内存隔离，应用退出后 cookie/storage/缓存全部清空。
 */
const AGENT_PARTITION = 'memory:agent';

/** 伪装的 User-Agent — 移除 Electron 字样，使用常见 Chrome UA */
const AGENT_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36';

/** 浏览器是否已打开且可用 */
export function isBrowserOpen(): boolean {
  return agentBrowser !== null && !agentBrowser.isDestroyed();
}

/** 获取浏览器状态：确保浏览器已打开并加载了页面 */
function ensureBrowserReady(): { ok: boolean; error?: string; win?: BrowserWindow } {
  if (!isBrowserOpen()) {
    return { ok: false, error: '浏览器未打开，请先使用 browser action="open" 加载页面' };
  }
  const win = agentBrowser!;
  if (win.webContents.getURL() === 'about:blank') {
    return { ok: false, error: '浏览器未加载任何页面，请先使用 browser action="open" 加载页面' };
  }
  return { ok: true, win };
}

/** 获取或创建 Agent 浏览器窗口 */
function getAgentBrowser(): BrowserWindow {
  if (agentBrowser && !agentBrowser.isDestroyed()) return agentBrowser;

  agentBrowser = new BrowserWindow({
    width: 1280,
    height: 800,
    show: false,
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: true,
      webSecurity: true,       // 开启同源策略（防跨域攻击）
      partition: AGENT_PARTITION, // 独立 session：与主窗口隔离 cookie/storage/缓存
    }
  });

  // 设置伪装 User-Agent
  agentBrowser.webContents.setUserAgent(AGENT_UA);

  agentBrowser.on('closed', () => { agentBrowser = null; });
  return agentBrowser;
}

/** 页面加载超时（毫秒） */
const PAGE_LOAD_TIMEOUT = 30_000;

/** 等待 CSS 选择器出现在页面中（最多 waitMs 毫秒） */
async function waitForSelector(win: BrowserWindow, selector: string, waitMs = 10_000): Promise<boolean> {
  const start = Date.now();
  while (Date.now() - start < waitMs) {
    try {
      const found = await win.webContents.executeJavaScript(`
        (() => { const el = document.querySelector(${JSON.stringify(selector)}); return el !== null; })()
      `, true);
      if (found) return true;
    } catch { /* retry */ }
    await new Promise(r => setTimeout(r, 300));
  }
  return false;
}

/** 打开 URL */
export async function browserOpen(url: string, waitSelector?: string): Promise<{ success: boolean; title?: string; url?: string; waited?: boolean; error?: string }> {
  try {
    // 协议白名单：仅 http/https（阻止 file:// 读取本地文件绕过路径安全层）
    if (!/^https?:\/\//i.test(url)) {
      return { success: false, error: `browser action="open" 仅支持 http/https 协议，收到: ${url.slice(0, 60)}` };
    }
    // SSRF 防护：阻止访问环回/内网地址
    const netCheck = await checkPublicHttpUrl(url);
    if (!netCheck.ok) {
      sendLog('warn', `🌐 browser open 安全拦截`, netCheck.reason || '');
      return { success: false, error: `安全拦截: ${netCheck.reason}` };
    }

    // 如果已有 BrowserWindow 且加载了不同 URL，先关闭重建
    if (agentBrowser && !agentBrowser.isDestroyed()) {
      const currentUrl = agentBrowser.webContents.getURL();
      if (currentUrl !== 'about:blank' && currentUrl !== url) {
        sendLog('info', `🌐 browser 切换页面`, `${currentUrl} → ${url}`);
        agentBrowser.close();
        agentBrowser = null;
      }
    }

    const win = getAgentBrowser();
    sendLog('info', `🌐 browser 打开`, url.slice(0, 100));

    const loadPromise = new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => {
        win.webContents.removeListener('did-finish-load', onFinish);
        reject(new Error(`页面加载超时 (${PAGE_LOAD_TIMEOUT / 1000}s)`));
      }, PAGE_LOAD_TIMEOUT);

      const onFinish = () => {
        clearTimeout(timeout);
        resolve();
      };
      win.webContents.once('did-finish-load', onFinish);
      win.loadURL(url).catch((err) => {
        clearTimeout(timeout);
        win.webContents.removeListener('did-finish-load', onFinish);
        reject(err);
      });
    });

    await loadPromise;

    let waited = false;
    // 等待特定元素出现（用于 SPA 页面）
    if (waitSelector) {
      sendLog('info', `🌐 browser 等待元素`, waitSelector);
      waited = await waitForSelector(win, waitSelector);
      if (!waited) sendLog('warn', `🌐 browser 等待超时`, `未找到: ${waitSelector}`);
    }

    const title = win.webContents.getTitle();
    sendLog('success', `🌐 browser 已加载`, title + (waited ? ' [等待元素完成]' : ''));
    return { success: true, title, url: win.webContents.getURL(), waited };
  } catch (err) {
    sendLog('error', `🌐 browser 打开失败`, (err as Error).message);
    return { success: false, error: (err as Error).message };
  }
}

/** 截图 */
export async function browserScreenshot(params: { full_page?: boolean; selector?: string } = {}): Promise<{ success: boolean; png?: string; width?: number; height?: number; error?: string }> {
  try {
    const ready = ensureBrowserReady();
    if (!ready.ok) return { success: false, error: ready.error };
    const win = ready.win!;

    if (params.selector) {
      // 截取特定元素的截图
      const rect = await win.webContents.executeJavaScript(`
        (() => {
          const el = document.querySelector(${JSON.stringify(params.selector)});
          if (!el) return null;
          const r = el.getBoundingClientRect();
          return { x: r.x, y: r.y, width: r.width, height: r.height };
        })()
      `, true) as { x: number; y: number; width: number; height: number } | null;

      if (!rect || rect.width === 0 || rect.height === 0) {
        return { success: false, error: `未找到元素或元素不可见: ${params.selector}` };
      }

      const image = await win.webContents.capturePage({ x: Math.round(rect.x), y: Math.round(rect.y), width: Math.round(rect.width), height: Math.round(rect.height) });
      const buffer = image.toPNG();
      sendLog('info', `🌐 browser 截图(元素)`, `${params.selector} → ${buffer.length} bytes, ${rect.width}x${rect.height}`);
      return { success: true, png: buffer.toString('base64'), width: Math.round(rect.width), height: Math.round(rect.height) };
    }

    if (params.full_page) {
      // 全页面截图：一次性捕获整个页面矩形区域
      const pageSize = await win.webContents.executeJavaScript(`
        (() => {
          const w = Math.max(document.documentElement.scrollWidth, document.body.scrollWidth, window.innerWidth);
          const h = Math.max(document.documentElement.scrollHeight, document.body.scrollHeight, window.innerHeight);
          return { width: w, height: h };
        })()
      `, true) as { width: number; height: number };

      const image = await win.webContents.capturePage({
        x: 0, y: 0,
        width: pageSize.width,
        height: pageSize.height
      });
      const buffer = image.toPNG();
      sendLog('success', `🌐 browser 截图(全页)`, `${pageSize.width}x${pageSize.height}, ${buffer.length} bytes`);
      return { success: true, png: buffer.toString('base64'), width: pageSize.width, height: pageSize.height };
    }

    // 视口截图（默认）
    const image = await win.webContents.capturePage();
    const buffer = image.toPNG();
    const size = image.getSize();
    sendLog('info', `🌐 browser 截图(视口)`, `${buffer.length} bytes, ${size.width}x${size.height}`);
    return { success: true, png: buffer.toString('base64'), width: size.width, height: size.height };
  } catch (err) {
    sendLog('error', `🌐 browser 截图失败`, (err as Error).message);
    return { success: false, error: (err as Error).message };
  }
}

/** 执行 JavaScript */
export async function browserEvaluate(js: string): Promise<{ success: boolean; result?: string; error?: string }> {
  try {
    const ready = ensureBrowserReady();
    if (!ready.ok) return { success: false, error: ready.error };
    const win = ready.win!;
    sendLog('info', `🌐 browser 执行 JS`, js.slice(0, 100));
    const result = await win.webContents.executeJavaScript(js, true);
    const resultStr = typeof result === 'string' ? result : JSON.stringify(result, null, 2);
    sendLog('success', `🌐 browser JS 完成`, resultStr?.slice(0, 100));
    return { success: true, result: resultStr };
  } catch (err) {
    sendLog('error', `🌐 browser JS 失败`, (err as Error).message);
    return { success: false, error: (err as Error).message };
  }
}

/** 提取页面内容 */
export async function browserExtract(params: { selector?: string; max_chars?: number } = {}): Promise<{ success: boolean; title?: string; text?: string; links?: Array<{text: string; href: string}>; error?: string }> {
  try {
    const ready = ensureBrowserReady();
    if (!ready.ok) return { success: false, error: ready.error };
    const win = ready.win!;
    const maxChars = params.max_chars || 0; // 0 = 不截断

    const result = await win.webContents.executeJavaScript(`
      (() => {
        const title = document.title;
        const getText = (el) => {
          if (!el) return '';
          const clone = el.cloneNode(true);
          clone.querySelectorAll('script,style,noscript,iframe,svg').forEach(e => e.remove());
          return clone.innerText?.trim() || '';
        };

        let root = document.body;
        ${params.selector ? `
        const selEl = document.querySelector(${JSON.stringify(params.selector)});
        if (selEl) root = selEl;
        ` : ''}

        const body = getText(root);
        const maxC = ${maxChars};
        const text = maxC > 0 && body.length > maxC ? body.slice(0, maxC) + '\\\\n... (已截断)' : body;

        const links = [];
        root.querySelectorAll('a[href]').forEach(a => {
          const href = a.href;
          const t = a.textContent?.trim();
          if (href && t && href.startsWith('http')) {
            links.push({ text: t.slice(0, 100), href });
          }
        });

        return { title, text, links: links.slice(0, 50) };
      })()
    `, true);

    const extractType = params.selector ? `selector:${params.selector}` : '全文';
    sendLog('success', `🌐 browser 提取完成(${extractType})`, `标题: ${result.title}, 文本: ${result.text?.length || 0}字, 链接: ${result.links?.length || 0}个`);
    return { success: true, ...result };
  } catch (err) {
    sendLog('error', `🌐 browser 提取失败`, (err as Error).message);
    return { success: false, error: (err as Error).message };
  }
}

/** 点击元素 */
export async function browserClick(selector: string, wait = false): Promise<{ success: boolean; error?: string }> {
  try {
    const ready = ensureBrowserReady();
    if (!ready.ok) return { success: false, error: ready.error };
    const win = ready.win!;

    if (wait) {
      const found = await waitForSelector(win, selector);
      if (!found) return { success: false, error: `等待超时: 未找到元素 ${selector}` };
      sendLog('info', `🌐 browser 等待完成`, selector);
    }

    sendLog('info', `🌐 browser 点击`, selector);
    await win.webContents.executeJavaScript(`
      (() => {
        const sel = ${JSON.stringify(selector)};
        const el = document.querySelector(sel);
        if (!el) throw new Error('元素未找到: ' + sel);
        el.scrollIntoView({ behavior: 'smooth', block: 'center' });
        el.click();
      })()
    `, true);
    await new Promise(r => setTimeout(r, 500));
    sendLog('success', `🌐 browser 点击完成`, selector);
    return { success: true };
  } catch (err) {
    sendLog('error', `🌐 browser 点击失败`, `${selector}: ${(err as Error).message}`);
    return { success: false, error: (err as Error).message };
  }
}

/** 输入文本 */
export async function browserType(selector: string, text: string, clear = true, submit = false): Promise<{ success: boolean; error?: string }> {
  try {
    const ready = ensureBrowserReady();
    if (!ready.ok) return { success: false, error: ready.error };
    const win = ready.win!;
    sendLog('info', `🌐 browser 输入`, `${selector}: ${text.slice(0, 50)}`);
    await win.webContents.executeJavaScript(`
      (() => {
        const sel = ${JSON.stringify(selector)};
        const val = ${JSON.stringify(text)};
        const el = document.querySelector(sel);
        if (!el) throw new Error('元素未找到: ' + sel);
        el.focus();
        ${clear ? `el.value = val;` : `el.value += val;`}
        el.dispatchEvent(new Event('input', { bubbles: true }));
        el.dispatchEvent(new Event('change', { bubbles: true }));
        ${submit ? `
        const form = el.closest('form');
        if (form) {
          form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
        } else {
          el.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', code: 'Enter', keyCode: 13, bubbles: true }));
        }
        ` : ''}
      })()
    `, true);
    await new Promise(r => setTimeout(r, submit ? 1000 : 300));
    sendLog('success', `🌐 browser 输入完成`, selector + (submit ? ' [已提交]' : ''));
    return { success: true };
  } catch (err) {
    sendLog('error', `🌐 browser 输入失败`, `${selector}: ${(err as Error).message}`);
    return { success: false, error: (err as Error).message };
  }
}

/** 滚动页面 */
export async function browserScroll(params: { direction?: string; selector?: string } = {}): Promise<{ success: boolean; error?: string }> {
  try {
    const ready = ensureBrowserReady();
    if (!ready.ok) return { success: false, error: ready.error };
    const win = ready.win!;
    const direction = params.direction || 'down';

    if (params.selector) {
      // 滚动到特定元素
      const found = await win.webContents.executeJavaScript(`
        (() => {
          const el = document.querySelector(${JSON.stringify(params.selector)});
          if (!el) return false;
          el.scrollIntoView({ behavior: 'smooth', block: 'center' });
          return true;
        })()
      `, true);
      if (!found) return { success: false, error: `未找到元素: ${params.selector}` };
      await new Promise(r => setTimeout(r, 500));
      sendLog('info', `🌐 browser 滚动到元素`, params.selector);
      return { success: true };
    }

    const js = direction === 'down' ? 'window.scrollBy(0, 500)'
      : direction === 'up' ? 'window.scrollBy(0, -500)'
      : direction === 'top' ? 'window.scrollTo(0, 0)'
      : 'window.scrollTo(0, document.body.scrollHeight)';
    await win.webContents.executeJavaScript(js, true);
    await new Promise(r => setTimeout(r, 300));
    sendLog('info', `🌐 browser 滚动`, direction);
    return { success: true };
  } catch (err) {
    sendLog('error', `🌐 browser 滚动失败`, (err as Error).message);
    return { success: false, error: (err as Error).message };
  }
}

/** 等待条件 */
export async function browserWait(params: { selector?: string; time_ms?: number }): Promise<{ success: boolean; found?: boolean; error?: string }> {
  try {
    const ready = ensureBrowserReady();
    if (!ready.ok) return { success: false, error: ready.error };
    const win = ready.win!;

    if (params.selector) {
      sendLog('info', `🌐 browser 等待元素`, params.selector);
      const found = await waitForSelector(win, params.selector, params.time_ms || 10_000);
      if (found) {
        sendLog('success', `🌐 browser 元素已出现`, params.selector);
      } else {
        sendLog('warn', `🌐 browser 等待超时`, params.selector);
      }
      return { success: true, found };
    }

    if (params.time_ms) {
      sendLog('info', `🌐 browser 等待`, `${params.time_ms}ms`);
      await new Promise(r => setTimeout(r, params.time_ms));
      return { success: true };
    }

    // 默认等待 1 秒
    await new Promise(r => setTimeout(r, 1000));
    return { success: true };
  } catch (err) {
    return { success: false, error: (err as Error).message };
  }
}

/** 关闭浏览器并清理 session 资源 */
export async function browserClose(): Promise<void> {
  if (agentBrowser && !agentBrowser.isDestroyed()) {
    agentBrowser.close();
    agentBrowser = null;
    // 清理 Agent session 的缓存和存储数据（内存 partition 关闭后自动清空，这里做显式清理确保彻底）
    try {
      const agentSession = session.fromPartition(AGENT_PARTITION);
      await Promise.all([
        agentSession.clearCache(),
        agentSession.clearStorageData({ storages: ['cookies', 'localstorage', 'indexdb', 'shadercache', 'serviceworkers', 'cachestorage'] }),
      ]);
    } catch { /* 清理失败不阻塞 */ }
    sendLog('info', '🌐 browser 已关闭，session 已清理');
  } else {
    agentBrowser = null;
  }
}
