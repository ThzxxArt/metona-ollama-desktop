/**
 * ToolsModal - 工具面板模态框
 * 展示所有可用工具的详细信息。Tool Calling 始终开启，不可关闭。
 * 全局执行模式统一管理所有工具的确认行为。
 */

import { state, KEYS } from '../state/state.js';
import { setToolMode, type ToolMode } from '../services/tool-registry.js';
import { showToast } from './toast.js';
import { logInfo } from '../services/log-service.js';
import type { ChatDB } from '../db/chat-db.js';

let modalEl: HTMLElement;

const MODE_NAMES: Record<string, string> = {
  auto: '自动执行',
  confirm: '需确认',
};

// 需要全局模式管理的工具列表（与 tool-registry.ts MODE_TOOLS 一致）
const MANAGED_TOOLS = [
  'run_command',
  'write_file', 'create_directory', 'delete_file',
  'edit_file', 'move_file', 'copy_file',
  'download_file', 'compress',
];

function updateAllBadges(mode: string): void {
  const badgeText = mode === 'auto' ? '自动' : '需确认';
  const badgeCls = mode === 'auto' ? 'auto' : 'confirm';
  // 更新所有被管理工具的 badge
  const badges = modalEl.querySelectorAll<HTMLElement>('.tool-card-badge');
  badges.forEach(badge => {
    // 只更新被管理工具的 badge（通过 tool-card-name 文本匹配）
    const nameEl = badge.closest('.tool-card')?.querySelector('.tool-card-name');
    if (nameEl && MANAGED_TOOLS.includes(nameEl.textContent || '')) {
      badge.textContent = badgeText;
      badge.className = `tool-card-badge ${badgeCls}`;
    }
  });
}

function updatePlanBadge(autoConfirm: boolean): void {
  const badge = modalEl.querySelector('#badge_plan_track') as HTMLElement;
  if (!badge) return;
  if (autoConfirm) {
    badge.textContent = '自动确认';
    badge.className = 'tool-card-badge auto';
  } else {
    badge.textContent = '需确认';
    badge.className = 'tool-card-badge confirm';
  }
}

export function initToolsModal(): void {
  modalEl = document.querySelector('#toolsModal')!;

  document.querySelector('#btnTools')!.addEventListener('click', openToolsModal);
  document.querySelector('#btnCloseTools')!.addEventListener('click', closeToolsModal);
  modalEl.addEventListener('click', (e) => {
    if (e.target === modalEl) closeToolsModal();
  });

  // 全局工具执行模式
  const globalSelect = modalEl.querySelector<HTMLSelectElement>('#select_global_tool_mode');
  if (globalSelect) {
    globalSelect.addEventListener('change', async () => {
      const mode = globalSelect.value as ToolMode;
      const db = state.get<ChatDB | null>(KEYS.DB);

      // 更新所有被管理工具的运行时模式
      for (const toolName of MANAGED_TOOLS) {
        setToolMode(toolName, mode);
      }

      // 持久化全局模式
      state.set('globalToolMode', mode);
      if (db) await db.saveSetting('globalToolMode', mode);

      updateAllBadges(mode);
      showToast(`工具执行模式：${MODE_NAMES[mode]}`, 'info');
      logInfo(`全局工具模式切换: → ${mode}`);
    });
  }

  // Plan 确认模式下拉框
  const planSelect = modalEl.querySelector<HTMLSelectElement>('#select_plan_confirm');
  if (planSelect) {
    planSelect.addEventListener('change', async () => {
      const autoConfirm = planSelect.value === 'auto';
      const db = state.get<ChatDB | null>(KEYS.DB);

      state.set('planAutoConfirm', autoConfirm);
      if (db) await db.saveSetting('planAutoConfirm', autoConfirm);
      updatePlanBadge(autoConfirm);

      showToast(`计划确认：${autoConfirm ? '自动确认' : '需确认'}`, 'info');
      logInfo(`计划确认模式切换: → ${autoConfirm ? 'auto' : 'confirm'}`);
    });
  }
}

export function openToolsModal(): void {
  // 同步全局工具执行模式
  const globalMode = state.get<string>('globalToolMode', 'confirm');
  const globalSelect = modalEl.querySelector<HTMLSelectElement>('#select_global_tool_mode');
  if (globalSelect) {
    globalSelect.value = globalMode;
    updateAllBadges(globalMode);
  }

  // 同步 Plan 确认模式
  const planSelect = modalEl.querySelector<HTMLSelectElement>('#select_plan_confirm');
  if (planSelect) {
    const autoConfirm = state.get<boolean>('planAutoConfirm', false);
    planSelect.value = autoConfirm ? 'auto' : 'confirm';
    updatePlanBadge(autoConfirm);
  }

  modalEl.style.display = '';
}

export function closeToolsModal(): void {
  modalEl.style.display = 'none';
}
