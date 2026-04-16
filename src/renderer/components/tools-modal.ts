/**
 * ToolsModal - 工具面板模态框
 * 展示所有可用工具的详细信息
 */

import { state, KEYS } from '../state/state.js';
import { setToolEnabled } from '../services/tool-registry.js';
import { showToast } from './toast.js';
import { logInfo } from '../services/log-service.js';
import type { ChatDB } from '../types.js';

let modalEl: HTMLElement;

export function initToolsModal(): void {
  modalEl = document.querySelector('#toolsModal')!;

  // Header 按钮
  document.querySelector('#btnTools')!.addEventListener('click', openToolsModal);
  document.querySelector('#btnCloseTools')!.addEventListener('click', closeToolsModal);
  modalEl.addEventListener('click', (e) => {
    if (e.target === modalEl) closeToolsModal();
  });

  // 设置中"查看全部工具"按钮
  document.querySelector('#btnOpenToolsFromSettings')?.addEventListener('click', () => {
    (document.querySelector('#settingsModal') as HTMLElement).style.display = 'none';
    openToolsModal();
  });

  // run_command 开关（模态框中）
  const toggle2 = document.querySelector('#toggleRunCommand2') as HTMLInputElement;
  if (toggle2) {
    toggle2.addEventListener('change', async () => {
      const db = state.get<ChatDB | null>(KEYS.DB);
      state.set('runCommandEnabled', toggle2.checked);
      if (db) await db.saveSetting('runCommandEnabled', toggle2.checked);
      setToolEnabled('run_command', toggle2.checked);

      // 同步设置面板的开关
      const toggle1 = document.querySelector('#toggleRunCommand') as HTMLInputElement;
      if (toggle1) toggle1.checked = toggle2.checked;

      if (toggle2.checked) {
        showToast('命令执行已开启（每次执行需确认）', 'info');
        logInfo('命令执行已开启');
      } else {
        showToast('命令执行已关闭', 'info');
        logInfo('命令执行已关闭');
      }
    });
  }
}

export function openToolsModal(): void {
  // 同步 run_command 开关状态
  const runCmdEnabled = state.get<boolean>('runCommandEnabled', true);
  const toggle2 = document.querySelector('#toggleRunCommand2') as HTMLInputElement;
  if (toggle2) toggle2.checked = runCmdEnabled;

  modalEl.style.display = '';
}

export function closeToolsModal(): void {
  modalEl.style.display = 'none';
}
