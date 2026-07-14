/**
 * Metona Ollama Desktop - 主进程入口
 */

import { app, BrowserWindow, dialog } from 'electron';
import * as path from 'path';
import * as fs from 'fs';
import { setupIPC } from './ipc.js';
import { createTray } from './tray.js';
import { createMenu } from './menu.js';
import { showNotification } from './utils.js';
import { ensureWorkspaceDir, killAllProcesses } from './workspace.js';
import { browserClose } from './browser.js';
import { stopAllServers } from './mcp-manager.js';

// ── 全局错误处理：写入文件 + 弹窗提示 ──
const ERROR_LOG = path.join(app.getPath('userData'), 'startup-error.log');

function logStartupError(phase: string, err: unknown): void {
  const msg = `[${new Date().toISOString()}] ${phase}: ${err instanceof Error ? err.stack || err.message : String(err)}\n`;
  try { fs.appendFileSync(ERROR_LOG, msg); } catch { /* ignore */ }
  console.error(msg);
}

process.on('uncaughtException', (err) => {
  logStartupError('uncaughtException', err);
});

process.on('unhandledRejection', (err) => {
  logStartupError('unhandledRejection', err);
});

const APP_NAME = 'Metona Ollama';
const ICON_PATH = path.join(__dirname, '..', '..', 'assets', 'icons', 'llama.png');
const ICO_PATH = path.join(__dirname, '..', '..', 'assets', 'icons', 'llama.ico');
const IS_DEV = !app.isPackaged;

export let mainWindow: BrowserWindow | null = null;
export let isQuitting = false;

export function setQuitting(): void {
  isQuitting = true;
}

export function getIconPath(): string {
  return process.platform === 'win32' ? ICO_PATH : ICON_PATH;
}

function createMainWindow(): BrowserWindow {
  const userDataPath = app.getPath('userData');
  const configPath = path.join(userDataPath, 'window-state.json');
  let windowState = { width: 1200, height: 800, x: undefined as number | undefined, y: undefined as number | undefined, maximized: false };

  try {
    if (fs.existsSync(configPath)) {
      windowState = JSON.parse(fs.readFileSync(configPath, 'utf-8'));
    }
  } catch { /* use defaults */ }

  mainWindow = new BrowserWindow({
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
      sandbox: false,
      webSecurity: false,
      allowRunningInsecureContent: false
    }
  });

  // 开发模式：从 src/renderer/ 加载；生产模式：从 dist/renderer/ 加载
  const isDev = !app.isPackaged;
  if (isDev) {
    mainWindow.loadFile(path.join(__dirname, '..', '..', 'src', 'renderer', 'index.html'));
  } else {
    mainWindow.loadFile(path.join(__dirname, '..', 'renderer', 'index.html'));
  }
  mainWindow.setMenuBarVisibility(false);

  mainWindow.once('ready-to-show', () => {
    if (windowState.maximized) {
      mainWindow!.maximize();
    }
    mainWindow!.show();
  });

  const saveWindowState = (): void => {
    if (!mainWindow || mainWindow.isMaximized() || mainWindow.isMinimized()) return;
    const bounds = mainWindow.getBounds();
    try {
      fs.writeFileSync(configPath, JSON.stringify(bounds));
    } catch { /* ignore */ }
  };

  mainWindow.on('resize', saveWindowState);
  mainWindow.on('move', saveWindowState);

  mainWindow.on('maximize', () => {
    try {
      const state = JSON.parse(fs.readFileSync(configPath, 'utf-8'));
      state.maximized = true;
      fs.writeFileSync(configPath, JSON.stringify(state));
    } catch { /* ignore */ }
  });

  mainWindow.on('unmaximize', () => {
    try {
      const state = JSON.parse(fs.readFileSync(configPath, 'utf-8'));
      state.maximized = false;
      fs.writeFileSync(configPath, JSON.stringify(state));
    } catch { /* ignore */ }
  });

  mainWindow.on('close', (e) => {
    if (!isQuitting) {
      e.preventDefault();
      mainWindow!.hide();
      if (!(global as Record<string, unknown>)._trayHintShown) {
        (global as Record<string, unknown>)._trayHintShown = true;
        showNotification('Metona 已最小化到系统托盘', '点击托盘图标可重新打开');
      }
    }
  });

  mainWindow.on('closed', () => {
    mainWindow = null;
  });

  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith('http://') || url.startsWith('https://')) {
      const { shell } = require('electron');
      shell.openExternal(url);
      return { action: 'deny' as const };
    }
    return { action: 'allow' as const };
  });

  return mainWindow;
}

// ── 单实例锁 ──
const gotTheLock = app.requestSingleInstanceLock();
if (!gotTheLock) {
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
  ensureWorkspaceDir();
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

app.on('before-quit', async () => {
  isQuitting = true;
  // 清理浏览器
  browserClose().catch(() => {});
  // 清理 MCP 服务器
  stopAllServers();
  // 清理所有工作空间进程
  killAllProcesses();
  // 通知渲染进程释放显存
  mainWindow?.webContents.send('app-quit');
  // 主进程直接调用 Ollama API 释放显存（更可靠，不依赖渲染进程）
  try {
    const OLlama_URL = 'http://127.0.0.1:11434';
    const psResp = await fetch(`${OLlama_URL}/api/ps`);
    if (psResp.ok) {
      const psData = await psResp.json() as { models?: Array<{ name: string }> };
      const models = psData.models || [];
      for (const m of models) {
        try {
          await fetch(`${OLlama_URL}/api/generate`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ model: m.name, keep_alive: 0 }),
          });
        } catch { /* 忽略单个模型释放失败 */ }
      }
      if (models.length > 0) {
        console.log(`[before-quit] 已释放 ${models.length} 个模型显存`);
      }
    }
  } catch { /* 释放显存失败不影响退出 */ }
});
