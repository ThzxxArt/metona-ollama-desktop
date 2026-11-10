/**
 * IPC 注册辅助：发送方校验、zod 入参校验、错误归一化、日志脱敏。
 */

import { ipcMain, type IpcMainInvokeEvent } from 'electron';
import type { ZodType } from 'zod';
import { mainWindow } from '../main.js';

/** 日志脱敏：Authorization / key / token / password */
export function redactLog(input: unknown): string {
  let text: string;
  try {
    text = typeof input === 'string' ? input : JSON.stringify(input);
  } catch {
    text = String(input);
  }
  return text
    .replace(/(Bearer\s+)[A-Za-z0-9._~+/=-]+/gi, '$1***')
    .replace(/("?(?:api[_-]?key|token|password|authorization)"?\s*[:=]\s*")[^"]*(")/gi, '$1***$2');
}

export function isTrustedSender(event: IpcMainInvokeEvent | Electron.IpcMainEvent): boolean {
  const sender = event.sender;
  if (!mainWindow || mainWindow.isDestroyed()) return false;
  if (sender.id !== mainWindow.webContents.id) return false;
  const url = event.senderFrame?.url ?? '';
  return url.startsWith('file://') || url.startsWith('http://localhost:') || url.startsWith('http://127.0.0.1:');
}

export class IpcValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'IpcValidationError';
  }
}

export function parseArgs<T>(schema: ZodType<T>, value: unknown): T {
  const result = schema.safeParse(value);
  if (!result.success) {
    const detail = result.error.issues.map((i) => `${i.path.join('.') || '参数'}: ${i.message}`).join('; ');
    throw new IpcValidationError(`参数校验失败: ${detail}`);
  }
  return result.data;
}

/** 注册受信任的 invoke handler */
export function handleTrusted<Args extends unknown[], Result>(
  channel: string,
  handler: (event: IpcMainInvokeEvent, ...args: Args) => Result | Promise<Result>,
): void {
  ipcMain.handle(channel, async (event, ...args) => {
    if (!isTrustedSender(event)) {
      throw new Error('非法 IPC 调用来源');
    }
    return handler(event, ...(args as Args));
  });
}
