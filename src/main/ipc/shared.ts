/** IPC 共享日志桥。 */

import { mainWindow } from '../main.js';

export function sendLog(
  level: 'info' | 'success' | 'warn' | 'error' | 'debug',
  message: string,
  detail?: string,
): void {
  mainWindow?.webContents.send('main:log', { level, message, detail });
}
