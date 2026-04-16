/**
 * ToolsModal - 工具面板模态框
 * 展示所有可用工具的详细信息，管理 Tool Calling 开关
 */

import { state, KEYS } from '../state/state.js';
import { setToolEnabled } from '../services/tool-registry.js';
import { showToast } from './toast.js';
import { logInfo, logWarn } from '../services/log-service.js';
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

  // Tool Calling 主开关
  const toggleToolCalling = modalEl.querySelector('#toggleToolCalling') as HTMLInputElement;
  if (toggleToolCalling) {
    toggleToolCalling.addEventListener('change', async () => {
      const db = state.get<ChatDB | null>(KEYS.DB);
      state.set('toolCallingEnabled', toggleToolCalling.checked);
      if (db) await db.saveSetting('toolCallingEnabled', toggleToolCalling.checked);
      if (toggleToolCalling.checked) {
        const modelSupportsTools = state.get<boolean>('modelSupportsTools', false);
        if (!modelSupportsTools) {
          showToast('⚠️ 当前模型可能不支持 Tool Calling，建议使用 Qwen3、Llama 3.1+ 等模型', 'warning', 5000);
          logWarn('Tool Calling 已开启（模型不支持）');
        } else {
          showToast('工具调用已开启', 'info');
          logInfo('Tool Calling 已开启');
        }
      } else {
        showToast('工具调用已关闭', 'info');
        logInfo('Tool Calling 已关闭');
      }
    });
  }

  // run_command 开关
  const toggle2 = modalEl.querySelector('#toggleRunCommand2') as HTMLInputElement;
  if (toggle2) {
    toggle2.addEventListener('change', async () => {
      const db = state.get<ChatDB | null>(KEYS.DB);
      state.set('runCommandEnabled', toggle2.checked);
      if (db) await db.saveSetting('runCommandEnabled', toggle2.checked);
      setToolEnabled('run_command', toggle2.checked);
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
  // 同步开关状态
  const toolCallingEnabled = state.get<boolean>('toolCallingEnabled', false);
  const toggleTC = modalEl.querySelector('#toggleToolCalling') as HTMLInputElement;
  if (toggleTC) toggleTC.checked = toolCallingEnabled;

  const runCmdEnabled = state.get<boolean>('runCommandEnabled', true);
  const toggle2 = modalEl.querySelector('#toggleRunCommand2') as HTMLInputElement;
  if (toggle2) toggle2.checked = runCmdEnabled;

  modalEl.style.display = '';
}

export function closeToolsModal(): void {
  modalEl.style.display = 'none';
}
