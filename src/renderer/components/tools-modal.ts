/**
 * ToolsModal - 工具面板模态框
 * 展示所有可用工具的详细信息，管理 Tool Calling 开关
 */

import { state, KEYS } from '../state/state.js';
import { setToolEnabled, setRunCommandMode } from '../services/tool-registry.js';
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

  // run_command 模式下拉框
  const selectMode = modalEl.querySelector('#selectRunCommandMode') as HTMLSelectElement;
  if (selectMode) {
    selectMode.addEventListener('change', async () => {
      const db = state.get<ChatDB | null>(KEYS.DB);
      const mode = selectMode.value as 'auto' | 'confirm' | 'disabled';
      state.set('runCommandMode', mode);
      if (db) await db.saveSetting('runCommandMode', mode);
      setRunCommandMode(mode);
      updateRunCommandBadge(mode);

      const modeNames: Record<string, string> = { auto: '自动执行', confirm: '需确认', disabled: '已禁用' };
      showToast(`命令执行模式：${modeNames[mode]}`, 'info');
      logInfo(`命令执行模式已切换: ${mode}`);
    });
  }
}

function updateRunCommandBadge(mode: string): void {
  const badge = modalEl.querySelector('#runCommandBadge') as HTMLElement;
  if (!badge) return;
  const map: Record<string, { text: string; cls: string }> = {
    auto: { text: '自动', cls: 'auto' },
    confirm: { text: '需确认', cls: 'confirm' },
    disabled: { text: '禁用', cls: 'disabled' }
  };
  const info = map[mode] || map.confirm;
  badge.textContent = info.text;
  badge.className = `tool-card-badge ${info.cls}`;
}

export function openToolsModal(): void {
  // 同步开关状态
  const toolCallingEnabled = state.get<boolean>('toolCallingEnabled', false);
  const toggleTC = modalEl.querySelector('#toggleToolCalling') as HTMLInputElement;
  if (toggleTC) toggleTC.checked = toolCallingEnabled;

  const runCommandMode = state.get<string>('runCommandMode', 'confirm');
  const selectMode = modalEl.querySelector('#selectRunCommandMode') as HTMLSelectElement;
  if (selectMode) selectMode.value = runCommandMode;
  updateRunCommandBadge(runCommandMode);

  modalEl.style.display = '';
}

export function closeToolsModal(): void {
  modalEl.style.display = 'none';
}
