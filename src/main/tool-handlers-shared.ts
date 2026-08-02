/**
 * Tool Handlers Shared - 共享工具函数和类型
 */

import * as path from 'path';
import { mainWindow } from './main.js';
import { getWorkspaceDir } from './workspace.js';

/** 发送日志到渲染进程日志面板 */
export function sendLog(level: 'info' | 'success' | 'warn' | 'error' | 'debug', message: string, detail?: string): void {
  mainWindow?.webContents.send('main:log', { level, message, detail });
}

/** 检测字符串是否为 URL（http:// 或 https://） */
export function isUrl(str: string): boolean {
  if (typeof str !== 'string' || str.length < 8) return false;
  const lower = str.toLowerCase().trim();
  return lower.startsWith('http://') || lower.startsWith('https://');
}

/** 解析路径：相对路径基于工作空间目录 */
export function resolvePath(inputPath: string): string {
  if (path.isAbsolute(inputPath)) return path.resolve(inputPath);
  return path.resolve(getWorkspaceDir(), inputPath);
}

export interface ToolResult {
  success: boolean;
  [key: string]: unknown;
}
