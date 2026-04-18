/**
 * Browser - Agent 浏览器控制 (v5.0)
 * 通过隐藏 BrowserWindow 实现网页加载、截图、JS 执行
 */

import { BrowserWindow } from 'electron';
import * as path from 'path';

let agentBrowser: BrowserWindow | null = null;

/** 获取或创建 Agent 浏览器窗口 */
function getAgentBrowser(): BrowserWindow {
  if (agentBrowser && !agentBrowser.isDestroyed()) return agentBrowser;

  agentBrowser = new BrowserWindow({
    width: 1280,
    height: 800,
    show: false, // 隐藏窗口
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: true,
      webSecurity: false, // 允许跨域（Agent 需要）
    }
  });

  agentBrowser.on('closed', () => { agentBrowser = null; });
  return agentBrowser;
}

/** 打开 URL */
export async function browserOpen(url: string): Promise<{ success: boolean; title?: string; url?: string; error?: string }> {
  try {
    const win = getAgentBrowser();
    await win.loadURL(url, { timeout: 15000 });
    await new Promise(r => setTimeout(r, 1000)); // 等待页面渲染
    return {
      success: true,
      title: win.webContents.getTitle(),
      url: win.webContents.getURL()
    };
  } catch (err) {
    return { success: false, error: (err as Error).message };
  }
}

/** 截图 */
export async function browserScreenshot(): Promise<{ success: boolean; png?: string; error?: string }> {
  try {
    const win = getAgentBrowser();
    if (win.webContents.getURL() === 'about:blank') {
      return { success: false, error: '浏览器未加载任何页面' };
    }
    const image = await win.webContents.capturePage();
    const buffer = image.toPNG();
    return { success: true, png: buffer.toString('base64') };
  } catch (err) {
    return { success: false, error: (err as Error).message };
  }
}

/** 执行 JavaScript */
export async function browserEvaluate(js: string): Promise<{ success: boolean; result?: string; error?: string }> {
  try {
    const win = getAgentBrowser();
    if (win.webContents.getURL() === 'about:blank') {
      return { success: false, error: '浏览器未加载任何页面' };
    }
    const result = await win.webContents.executeJavaScript(js, true);
    return {
      success: true,
      result: typeof result === 'string' ? result : JSON.stringify(result, null, 2)
    };
  } catch (err) {
    return { success: false, error: (err as Error).message };
  }
}

/** 提取页面文本和链接 */
export async function browserExtract(): Promise<{ success: boolean; title?: string; text?: string; links?: Array<{text: string; href: string}>; error?: string }> {
  try {
    const win = getAgentBrowser();
    if (win.webContents.getURL() === 'about:blank') {
      return { success: false, error: '浏览器未加载任何页面' };
    }

    const result = await win.webContents.executeJavaScript(`
      (() => {
        const title = document.title;
        // 提取正文文本
        const getText = (el) => {
          if (!el) return '';
          const clone = el.cloneNode(true);
          clone.querySelectorAll('script,style,noscript,iframe').forEach(e => e.remove());
          return clone.innerText?.trim() || '';
        };
        const body = getText(document.body);
        const text = body.length > 15000 ? body.slice(0, 15000) + '\\n... (已截断)' : body;

        // 提取链接
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
    `, true);

    return { success: true, ...result };
  } catch (err) {
    return { success: false, error: (err as Error).message };
  }
}

/** 点击元素 */
export async function browserClick(selector: string): Promise<{ success: boolean; error?: string }> {
  try {
    const win = getAgentBrowser();
    await win.webContents.executeJavaScript(`document.querySelector('${selector.replace(/'/g, "\\'")}').click()`, true);
    await new Promise(r => setTimeout(r, 500));
    return { success: true };
  } catch (err) {
    return { success: false, error: (err as Error).message };
  }
}

/** 输入文本 */
export async function browserType(selector: string, text: string): Promise<{ success: boolean; error?: string }> {
  try {
    const win = getAgentBrowser();
    const escapedSelector = selector.replace(/'/g, "\\'");
    const escapedText = text.replace(/'/g, "\\'").replace(/\n/g, "\\n");
    await win.webContents.executeJavaScript(`
      (() => {
        const el = document.querySelector('${escapedSelector}');
        if (!el) throw new Error('元素未找到: ${escapedSelector}');
        el.focus();
        el.value = '${escapedText}';
        el.dispatchEvent(new Event('input', { bubbles: true }));
        el.dispatchEvent(new Event('change', { bubbles: true }));
      })()
    `, true);
    return { success: true };
  } catch (err) {
    return { success: false, error: (err as Error).message };
  }
}

/** 滚动页面 */
export async function browserScroll(direction: 'down' | 'up' | 'top' | 'bottom'): Promise<{ success: boolean; error?: string }> {
  try {
    const win = getAgentBrowser();
    const js = direction === 'down' ? 'window.scrollBy(0, 500)'
      : direction === 'up' ? 'window.scrollBy(0, -500)'
      : direction === 'top' ? 'window.scrollTo(0, 0)'
      : 'window.scrollTo(0, document.body.scrollHeight)';
    await win.webContents.executeJavaScript(js, true);
    await new Promise(r => setTimeout(r, 300));
    return { success: true };
  } catch (err) {
    return { success: false, error: (err as Error).message };
  }
}

/** 关闭浏览器 */
export function browserClose(): void {
  if (agentBrowser && !agentBrowser.isDestroyed()) {
    agentBrowser.close();
  }
  agentBrowser = null;
}
