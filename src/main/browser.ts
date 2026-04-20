/**
 * Browser - Agent 浏览器控制 (v5.0)
 * 通过隐藏 BrowserWindow 实现网页加载、截图、JS 执行
 */

import { BrowserWindow } from 'electron';
import { mainWindow } from './main.js';

function sendLog(level: 'info' | 'success' | 'warn' | 'error', message: string, detail?: string): void {
  mainWindow?.webContents.send('main:log', { level, message, detail });
}

let agentBrowser: BrowserWindow | null = null;

/** 浏览器是否已打开且可用 */
export function isBrowserOpen(): boolean {
  return agentBrowser !== null && !agentBrowser.isDestroyed();
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
      webSecurity: false,
    }
  });

  agentBrowser.on('closed', () => { agentBrowser = null; });
  return agentBrowser;
}

/**
 * 在 webContents 上执行 JS，带超时保护。
 * renderer 冻结时 executeJavaScript 会无限挂起，必须加超时。
 */
function executeJsWithTimeout(webContents: Electron.WebContents, js: string, timeoutMs = 15000): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error('浏览器 JS 执行超时（renderer 无响应）'));
    }, timeoutMs);

    webContents.executeJavaScript(js, true).then(
      result => { clearTimeout(timer); resolve(result); },
      err => { clearTimeout(timer); reject(err); }
    );
  });
}

/** 打开 URL */
export async function browserOpen(url: string): Promise<{ success: boolean; title?: string; url?: string; error?: string }> {
  try {
    const win = getAgentBrowser();
    sendLog('info', `🌐 browser 打开`, url.slice(0, 100));
    await win.loadURL(url);
    await new Promise(r => setTimeout(r, 1000));
    const title = win.webContents.getTitle();
    sendLog('success', `🌐 browser 已加载`, title);
    return { success: true, title, url: win.webContents.getURL() };
  } catch (err) {
    sendLog('error', `🌐 browser 打开失败`, (err as Error).message);
    return { success: false, error: (err as Error).message };
  }
}

/** 截图 */
export async function browserScreenshot(): Promise<{ success: boolean; png?: string; error?: string }> {
  try {
    if (!isBrowserOpen()) {
      return { success: false, error: '浏览器未打开，请先使用 browser_open 加载页面' };
    }
    const win = agentBrowser!;
    if (win.webContents.getURL() === 'about:blank') {
      return { success: false, error: '浏览器未加载任何页面' };
    }
    const image = await win.webContents.capturePage();
    const buffer = image.toPNG();
    sendLog('info', `🌐 browser 截图`, `${buffer.length} bytes`);
    return { success: true, png: buffer.toString('base64') };
  } catch (err) {
    sendLog('error', `🌐 browser 截图失败`, (err as Error).message);
    return { success: false, error: (err as Error).message };
  }
}

/** 执行 JavaScript */
export async function browserEvaluate(js: string): Promise<{ success: boolean; result?: string; error?: string }> {
  try {
    if (!isBrowserOpen()) {
      return { success: false, error: '浏览器未打开，请先使用 browser_open 加载页面' };
    }
    const win = agentBrowser!; // isBrowserOpen 已确认非 null
    if (win.webContents.getURL() === 'about:blank') {
      return { success: false, error: '浏览器未加载任何页面，请先使用 browser_open 加载页面' };
    }
    sendLog('info', `🌐 browser 执行 JS`, js.slice(0, 100));
    const result = await executeJsWithTimeout(win.webContents, js, 15000);
    const resultStr = typeof result === 'string' ? result : JSON.stringify(result, null, 2);
    sendLog('success', `🌐 browser JS 完成`, resultStr?.slice(0, 100));
    return { success: true, result: resultStr };
  } catch (err) {
    sendLog('error', `🌐 browser JS 失败`, (err as Error).message);
    return { success: false, error: (err as Error).message };
  }
}

/** 提取页面文本和链接 */
export async function browserExtract(): Promise<{ success: boolean; title?: string; text?: string; links?: Array<{text: string; href: string}>; error?: string }> {
  try {
    if (!isBrowserOpen()) {
      return { success: false, error: '浏览器未打开，请先使用 browser_open 加载页面' };
    }
    const win = agentBrowser!;
    if (win.webContents.getURL() === 'about:blank') {
      return { success: false, error: '浏览器未加载任何页面' };
    }

    const result = await executeJsWithTimeout(win.webContents, `
      (() => {
        const title = document.title;
        const getText = (el) => {
          if (!el) return '';
          const clone = el.cloneNode(true);
          clone.querySelectorAll('script,style,noscript,iframe').forEach(e => e.remove());
          return clone.innerText?.trim() || '';
        };
        const body = getText(document.body);
        const text = body.length > 15000 ? body.slice(0, 15000) + '\\n... (已截断)' : body;
        const links = [];
        document.querySelectorAll('a[href]').forEach(a => {
          const href = a.href;
          const text = a.textContent?.trim();
          if (href && text && href.startsWith('http')) {
            links.push({ text: text.slice(0, 100), href });
          }
        });
        return { title, text, links: links.slice(0, 50) };
      })()
    `, 15000);

    sendLog('success', `🌐 browser 提取完成`, `标题: ${result.title}, 文本: ${result.text?.length || 0}字, 链接: ${result.links?.length || 0}个`);
    return { success: true, ...result };
  } catch (err) {
    sendLog('error', `🌐 browser 提取失败`, (err as Error).message);
    return { success: false, error: (err as Error).message };
  }
}

/** 点击元素 */
export async function browserClick(selector: string): Promise<{ success: boolean; error?: string }> {
  try {
    if (!isBrowserOpen()) {
      return { success: false, error: '浏览器未打开，请先使用 browser_open 加载页面' };
    }
    const win = agentBrowser!;
    sendLog('info', `🌐 browser 点击`, selector);
    await executeJsWithTimeout(win.webContents, `document.querySelector('${selector.replace(/'/g, "\\'")}').click()`, 10000);
    await new Promise(r => setTimeout(r, 500));
    sendLog('success', `🌐 browser 点击完成`, selector);
    return { success: true };
  } catch (err) {
    sendLog('error', `🌐 browser 点击失败`, `${selector}: ${(err as Error).message}`);
    return { success: false, error: (err as Error).message };
  }
}

/** 输入文本 */
export async function browserType(selector: string, text: string): Promise<{ success: boolean; error?: string }> {
  try {
    if (!isBrowserOpen()) {
      return { success: false, error: '浏览器未打开，请先使用 browser_open 加载页面' };
    }
    const win = agentBrowser!;
    const escapedSelector = selector.replace(/'/g, "\\'");
    const escapedText = text.replace(/'/g, "\\'").replace(/\n/g, "\\n");
    sendLog('info', `🌐 browser 输入`, `${selector}: ${text.slice(0, 50)}`);
    await executeJsWithTimeout(win.webContents, `
      (() => {
        const el = document.querySelector('${escapedSelector}');
        if (!el) throw new Error('元素未找到: ${escapedSelector}');
        el.focus();
        el.value = '${escapedText}';
        el.dispatchEvent(new Event('input', { bubbles: true }));
        el.dispatchEvent(new Event('change', { bubbles: true }));
      })()
    `, 10000);
    sendLog('success', `🌐 browser 输入完成`, selector);
    return { success: true };
  } catch (err) {
    sendLog('error', `🌐 browser 输入失败`, `${selector}: ${(err as Error).message}`);
    return { success: false, error: (err as Error).message };
  }
}

/** 滚动页面 */
export async function browserScroll(direction: 'down' | 'up' | 'top' | 'bottom'): Promise<{ success: boolean; error?: string }> {
  try {
    if (!isBrowserOpen()) {
      return { success: false, error: '浏览器未打开，请先使用 browser_open 加载页面' };
    }
    const win = agentBrowser!;
    const js = direction === 'down' ? 'window.scrollBy(0, 500)'
      : direction === 'up' ? 'window.scrollBy(0, -500)'
      : direction === 'top' ? 'window.scrollTo(0, 0)'
      : 'window.scrollTo(0, document.body.scrollHeight)';
    await executeJsWithTimeout(win.webContents, js, 10000);
    await new Promise(r => setTimeout(r, 300));
    sendLog('info', `🌐 browser 滚动`, direction);
    return { success: true };
  } catch (err) {
    sendLog('error', `🌐 browser 滚动失败`, (err as Error).message);
    return { success: false, error: (err as Error).message };
  }
}

/** 关闭浏览器 */
export function browserClose(): void {
  if (agentBrowser && !agentBrowser.isDestroyed()) {
    agentBrowser.close();
    sendLog('info', '🌐 browser 已关闭');
  }
  agentBrowser = null;
}
