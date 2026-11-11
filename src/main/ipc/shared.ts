/** IPC 共享日志桥。日志在离开主进程前统一脱敏。 */

import { mainWindow } from '../window-state.js';

function redact(text: string): string {
  return text
    .replace(/(Bearer\s+)[A-Za-z0-9._~+/=-]+/gi, '$1***')
    .replace(/([?&](?:api[_-]?key|token|password|auth)=)[^&\s]+/gi, '$1***')
    .replace(/("?(?:api[_-]?key|token|password|authorization)"?\s*[:=]\s*")[^"]*(")/gi, '$1***$2');
}

export function sendLog(
  level: 'info' | 'success' | 'warn' | 'error' | 'debug',
  message: string,
  detail?: string,
): void {
  mainWindow?.webContents.send('main:log', {
    level,
    message: redact(String(message)),
    detail: detail === undefined ? undefined : redact(String(detail)),
  });
}
