/**
 * Metona Ollama Desktop - 主进程工具函数
 */

import { Notification } from 'electron';
import * as path from 'path';

const ICON_PATH = path.join(__dirname, '..', '..', 'assets', 'icons', 'llama.png');

export function showNotification(title: string, body: string): void {
  if (Notification.isSupported()) {
    new Notification({ title, body, icon: ICON_PATH }).show();
  }
}
