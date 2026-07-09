/**
 * ToolsModal - 工具面板模态框
 * 展示所有可用工具的详细信息。Tool Calling 始终开启，不可关闭。
 * 支持三档开关（auto/confirm/disabled）的工具统一管理。
 */

import { state, KEYS } from '../state/state.js';
import { setToolMode, getToolMode, type ToolMode } from '../services/tool-registry.js';
import { showToast } from './toast.js';
import { logInfo } from '../services/log-service.js';
import type { ChatDB } from '../db/chat-db.js';

let modalEl: HTMLElement;

const MODE_NAMES: Record<ToolMode, string> = {
  auto: '自动执行',
  confirm: '需确认',
  disabled: '已禁用',
};

const BADGE_MAP: Record<ToolMode, { text: string; cls: string }> = {
  auto: { text: '自动', cls: 'auto' },
  confirm: { text: '需确认', cls: 'confirm' },
  disabled: { text: '禁用', cls: 'disabled' },
};

function updateToolBadge(toolName: string, mode: ToolMode): void {
  const badge = modalEl.querySelector(`#badge_${toolName}`) as HTMLElement;
  if (!badge) return;
  const info = BADGE_MAP[mode];
  badge.textContent = info.text;
  badge.className = `tool-card-badge ${info.cls}`;
}

export function initToolsModal(): void {
  modalEl = document.querySelector('#toolsModal')!;

  // Header 按钮
  document.querySelector('#btnTools')!.addEventListener('click', openToolsModal);
  document.querySelector('#btnCloseTools')!.addEventListener('click', closeToolsModal);
  modalEl.addEventListener('click', (e) => {
    if (e.target === modalEl) closeToolsModal();
  });

  // 所有带 .tool-mode-select 的下拉框统一绑定 change 事件
  const selects = modalEl.querySelectorAll<HTMLSelectElement>('.tool-mode-select');
  selects.forEach(selectEl => {
    selectEl.addEventListener('change', async () => {
      const toolName = selectEl.dataset.tool;
      if (!toolName) return;
      const mode = selectEl.value as ToolMode;
      const db = state.get<ChatDB | null>(KEYS.DB);

      // 更新运行时模式
      setToolMode(toolName, mode);
      updateToolBadge(toolName, mode);

      // 持久化到数据库（所有工具模式合并存储为 JSON）
      const allModes = state.get<Record<string, ToolMode>>('toolModes', {});
      allModes[toolName] = mode;
      state.set('toolModes', allModes);
      if (db) await db.saveSetting('toolModes', allModes);

      showToast(`${toolName}：${MODE_NAMES[mode]}`, 'info');
      logInfo(`工具模式切换: ${toolName} → ${mode}`);
    });
  });
}

export function openToolsModal(): void {
  // 从 state 读取所有工具模式，同步 UI
  const allModes = state.get<Record<string, ToolMode>>('toolModes', {});
  const selects = modalEl.querySelectorAll<HTMLSelectElement>('.tool-mode-select');
  selects.forEach(selectEl => {
    const toolName = selectEl.dataset.tool;
    if (!toolName) return;
    const mode = allModes[toolName] || getToolMode(toolName);
    selectEl.value = mode;
    updateToolBadge(toolName, mode);
  });

  modalEl.style.display = '';
}

export function closeToolsModal(): void {
  modalEl.style.display = 'none';
}
