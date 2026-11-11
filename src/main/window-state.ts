/**
 * 主窗口 / 退出状态 / 图标路径。
 *
 * 独立模块，避免 main.ts ↔ ipc / menu / tray / browser 的循环依赖。
 * main.ts 负责创建窗口并调用 setMainWindow；其他模块只读 mainWindow。
 */

import { app, type BrowserWindow } from 'electron';
import * as path from 'path';

export let mainWindow: BrowserWindow | null = null;
export let isQuitting = false;

export function setMainWindow(win: BrowserWindow | null): void {
  mainWindow = win;
}

export function setQuitting(): void {
  isQuitting = true;
}

export function getIconPath(): string {
  const icon = process.platform === 'win32' ? 'llama.ico' : 'llama.png';
  return path.join(app.getAppPath(), 'assets', 'icons', icon);
}
