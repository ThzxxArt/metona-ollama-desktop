/**
 * Metona Ollama Desktop - 主进程入口
 */

import { app, BrowserWindow, dialog, session, shell } from 'electron';
import * as path from 'path';
import * as fs from 'fs';
import { setupIPC } from './ipc.js';
import { createTray } from './tray.js';
import { createMenu } from './menu.js';
import { showNotification } from './utils.js';
import { ensureWorkspaceDir, killAllProcesses } from './workspace.js';
import { browserClose } from './browser.js';
import { stopAllServers } from './mcp-manager.js';
import { flushDatabase } from './db/sqlite.js';
import { unloadModelsOnExit } from './ollama/client.js';
import { getOllamaSecretStore } from './ollama/secret-store.js';
import { abortAllOllamaStreams } from './ipc/ollama.js';

// ── 全局错误处理：写入文件 + 弹窗提示 ──
const ERROR_LOG = path.join(app.getPath('userData'), 'startup-error.log');

function logStartupError(phase: string, err: unknown): void {
  const msg = `[${new Date().toISOString()}] ${phase}: ${err instanceof Error ? err.stack || err.message : String(err)}\n`;
  try { fs.appendFileSync(ERROR_LOG, msg); } catch { /* ignore */ }
  // 豁免：进程启动阶段的未捕获错误发生在渲染进程与日志面板就绪之前，只能落到 stderr
  console.error(msg);
}

process.on('uncaughtException', (err) => {
  logStartupError('uncaughtException', err);
});

process.on('unhandledRejection', (err) => {
  logStartupError('unhandledRejection', err);
});

const APP_NAME = 'Metona Ollama';
const ICON_PATH = path.join(app.getAppPath(), 'assets', 'icons', 'llama.png');
const ICO_PATH = path.join(app.getAppPath(), 'assets', 'icons', 'llama.ico');

// mainWindow / isQuitting 由 window-state 统一持有，避免 main.ts 与 ipc/menu/tray 循环依赖。
import { mainWindow, isQuitting, setMainWindow, setQuitting } from './window-state.js';

export { setQuitting, getIconPath } from './window-state.js';

// ═══════════════════════════════════════════════════════════════
// 安全响应头：CSP + 禁止嵌入。Ollama 请求已在主进程完成，
// 渲染进程不再需要任何跨域放行（0.18.0 删除 CORS 白名单）。
// ═══════════════════════════════════════════════════════════════

const CSP = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: blob:",
  "font-src 'self' data:",
  "connect-src 'self'",
  "media-src 'self' data: blob:",
  "object-src 'none'",
  "base-uri 'none'",
  "frame-ancestors 'none'",
].join('; ');

function installSecurityHeaders(): void {
  session.defaultSession.webRequest.onHeadersReceived((details, callback) => {
    const headers = { ...(details.responseHeaders ?? {}) };
    headers['Content-Security-Policy'] = [CSP];
    headers['X-Content-Type-Options'] = ['nosniff'];
    callback({ responseHeaders: headers });
  });
}

function createMainWindow(): BrowserWindow {
  const userDataPath = app.getPath('userData');
  const configPath = path.join(userDataPath, 'window-state.json');
  let windowState = {
    width: 1200,
    height: 800,
    x: undefined as number | undefined,
    y: undefined as number | undefined,
    maximized: false,
  };

  try {
    if (fs.existsSync(configPath)) {
      windowState = JSON.parse(fs.readFileSync(configPath, 'utf-8'));
    }
  } catch {
    /* use defaults */
  }

  const win = new BrowserWindow({
    width: windowState.width || 1200,
    height: windowState.height || 800,
    x: windowState.x,
    y: windowState.y,
    minWidth: 800,
    minHeight: 600,
    icon: process.platform === 'win32' ? ICO_PATH : ICON_PATH,
    title: APP_NAME,
    backgroundColor: '#FAF7F2',
    show: false,
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webSecurity: true,
      allowRunningInsecureContent: false,
    },
  });
  setMainWindow(win);

  // 渲染进程始终加载构建产物 dist/renderer；开发时由 Vite watch 持续输出。
  // 如需连接 Vite dev server，可设置 METONA_DEV_URL。
  const devUrl = process.env.METONA_DEV_URL;
  if (devUrl) {
    void win.loadURL(devUrl);
  } else {
    win.loadFile(path.join(__dirname, '..', 'renderer', 'index.html'));
  }
  win.setMenuBarVisibility(false);

  win.once('ready-to-show', () => {
    if (windowState.maximized) win.maximize();
    win.show();
  });

  const saveWindowState = (): void => {
    if (!win || win.isMaximized() || win.isMinimized()) return;
    const bounds = win.getBounds();
    try {
      fs.writeFileSync(configPath, JSON.stringify(bounds));
    } catch {
      /* ignore */
    }
  };

  win.on('resize', saveWindowState);
  win.on('move', saveWindowState);

  win.on('maximize', () => {
    try {
      const state = JSON.parse(fs.readFileSync(configPath, 'utf-8'));
      state.maximized = true;
      fs.writeFileSync(configPath, JSON.stringify(state));
    } catch {
      /* ignore */
    }
  });

  win.on('unmaximize', () => {
    try {
      const state = JSON.parse(fs.readFileSync(configPath, 'utf-8'));
      state.maximized = false;
      fs.writeFileSync(configPath, JSON.stringify(state));
    } catch {
      /* ignore */
    }
  });

  win.on('close', (e) => {
    if (!isQuitting) {
      e.preventDefault();
      win.hide();
      if (!(global as Record<string, unknown>)._trayHintShown) {
        (global as Record<string, unknown>)._trayHintShown = true;
        showNotification('Metona 已最小化到系统托盘', '点击托盘图标可重新打开');
      }
    }
  });

  win.on('closed', () => {
    setMainWindow(null);
  });

  win.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith('http://') || url.startsWith('https://')) {
      shell.openExternal(url);
    }
    // 非 http/https 一律拒绝
    return { action: 'deny' as const };
  });

  return win;
}

// ── 单实例锁 ──
let quitCleanupStarted = false;
let quitReady = false;
const gotTheLock = app.requestSingleInstanceLock();
if (!gotTheLock) {
  // 第二个实例直接退出，不执行主实例的退出清理（否则会误卸载模型/刷盘）
  quitReady = true;
  app.quit();
} else {
  app.on('second-instance', () => {
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.focus();
    }
  });
}

app.whenReady().then(async () => {
  installSecurityHeaders();
  ensureWorkspaceDir();
  await getOllamaSecretStore().init();
  await setupIPC();
  createMainWindow();
  createTray();
  createMenu();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createMainWindow();
    } else if (mainWindow) {
      mainWindow.show();
    }
  });
}).catch((err) => {
  logStartupError('app.whenReady', err);
  // 弹出错误对话框，让用户知道发生了什么
  try {
    dialog.showErrorBox('Metona Ollama 启动失败',
      `应用初始化出错，请检查以下信息：\n\n${err instanceof Error ? err.message : String(err)}\n\n错误日志：${ERROR_LOG}`);
  } catch {
    // dialog 也可能失败（app 未完全初始化）
  }
  app.quit();
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    // keep running with tray
  }
});

app.on('before-quit', (event) => {
  if (quitReady) return;
  // before-quit 的 async handler 不会被 Electron 等待；必须 preventDefault，
  // 完成刷盘 / 中止流 / 5s 超时卸载后再主动 quit，否则退出卸载会被进程直接截断。
  // 清理期间用户再次退出也必须继续拦截，避免第二次 before-quit 直接放行。
  event.preventDefault();
  if (quitCleanupStarted) return;
  quitCleanupStarted = true;
  setQuitting();

  void (async () => {
    try {
      try {
        flushDatabase();
      } catch {
        /* 刷盘失败不阻塞退出 */
      }
      try {
        abortAllOllamaStreams();
      } catch {
        /* ignore */
      }
      browserClose().catch(() => {});
      try {
        stopAllServers();
      } catch {
        /* ignore */
      }
      try {
        killAllProcesses();
      } catch {
        /* ignore */
      }
      try {
        mainWindow?.webContents.send('app-quit');
      } catch {
        /* 窗口已销毁 */
      }
      try {
        await unloadModelsOnExit(5_000);
      } catch {
        /* 释放显存失败不影响退出 */
      }
    } finally {
      quitReady = true;
      app.quit();
    }
  })();
});
