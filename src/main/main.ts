/**
 * Metona Ollama Desktop - 主进程入口
 */

import { app, BrowserWindow } from 'electron';
import * as path from 'path';
import * as fs from 'fs';
import { setupIPC } from './ipc.js';
import { createTray } from './tray.js';
import { createMenu } from './menu.js';
import { showNotification } from './utils.js';

const APP_NAME = 'Metona Ollama';
const ICON_PATH = path.join(__dirname, '..', '..', 'assets', 'icons', 'llama.png');
const ICO_PATH = path.join(__dirname, '..', '..', 'assets', 'icons', 'llama.ico');
const IS_DEV = !app.isPackaged;

export let mainWindow: BrowserWindow | null = null;
export let isQuitting = false;

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
    backgroundColor: '#202020',
    show: false,
    autoHideMenuBar: true,
    menuBarVisible: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
      webSecurity: false,
      allowRunningInsecureContent: false
    }
  });

  mainWindow.loadFile(path.join(__dirname, '..', '..', 'index.html'));
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

app.whenReady().then(() => {
  setupIPC();
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
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    // keep running with tray
  }
});

app.on('before-quit', () => {
  isQuitting = true;
});
